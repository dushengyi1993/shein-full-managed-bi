DO $$
DECLARE
    expected_table text;
    expected_tables constant text[] := ARRAY[
        'ops.reconciliation_result',
        'ops.reconciliation_daily_detail',
        'ops.reconciliation_daily_summary',
        'ops.reconciliation_anomaly'
    ];
    duplicate_grains bigint;
    partition_count integer;
    detail_duplicate bigint;
    anomaly_violations bigint;
    eligible_current_rows bigint;
    seeded_detail_rows bigint;
    summary_rows bigint;
    store_key_indexes integer;
BEGIN
    FOREACH expected_table IN ARRAY expected_tables LOOP
        IF to_regclass(expected_table) IS NULL THEN
            RAISE EXCEPTION 'Missing required relation: %', expected_table;
        END IF;
    END LOOP;

    -- The stable current grain must be unique, otherwise the writer's upsert
    -- would silently append again.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'uq_ops_reconciliation_result_grain'
           AND conrelid = 'ops.reconciliation_result'::regclass
           AND contype = 'u'
    ) THEN
        RAISE EXCEPTION 'ops.reconciliation_result is missing the stable grain constraint';
    END IF;

    SELECT count(*) INTO duplicate_grains
      FROM (
        SELECT 1
          FROM ops.reconciliation_result
         GROUP BY store_id, domain_code, entity_key, metric_code
        HAVING count(*) > 1
      ) AS duplicates;
    IF duplicate_grains > 0 THEN
        RAISE EXCEPTION 'ops.reconciliation_result still holds % duplicated current grains',
            duplicate_grains;
    END IF;

    -- Outbound provenance foreign keys and the identity contract must survive
    -- the compaction rebuild/swap.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'ops.reconciliation_result'::regclass
           AND contype = 'f'
           AND confrelid = 'dim.store'::regclass
    ) THEN
        RAISE EXCEPTION 'ops.reconciliation_result lost its dim.store foreign key';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'ops.reconciliation_result'::regclass
           AND contype = 'f'
           AND confrelid = 'raw.openapi_fetch_batch'::regclass
    ) THEN
        RAISE EXCEPTION 'ops.reconciliation_result lost its fetch-batch foreign key';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'ops.reconciliation_result'::regclass AND contype = 'p'
    ) THEN
        RAISE EXCEPTION 'ops.reconciliation_result lost its primary key';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = 'ops.reconciliation_result'::regclass
           AND attname = 'reconciliation_result_id'
           AND attidentity = 'a'
    ) THEN
        RAISE EXCEPTION 'ops.reconciliation_result identity is not GENERATED ALWAYS';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'ops.reconciliation_result'::regclass
           AND tgname = 'trg_ops_reconciliation_result_touch_updated_at'
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'ops.reconciliation_result lost its updated_at trigger';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_class
         WHERE relname = 'ix_ops_reconciliation_result_attention'
           AND relkind = 'i'
    ) THEN
        RAISE EXCEPTION 'ops.reconciliation_result lost its attention index';
    END IF;

    -- Detail must be partitioned with a usable forward window, because writers
    -- fail closed when a partition is missing.
    IF NOT EXISTS (
        SELECT 1 FROM pg_class
         WHERE oid = 'ops.reconciliation_daily_detail'::regclass
           AND relkind = 'p'
    ) THEN
        RAISE EXCEPTION 'ops.reconciliation_daily_detail is not partitioned';
    END IF;
    SELECT count(*) INTO partition_count
      FROM pg_inherits
     WHERE inhparent = 'ops.reconciliation_daily_detail'::regclass;
    IF partition_count < 90 THEN
        RAISE EXCEPTION
            'ops.reconciliation_daily_detail has only % partitions; at least 90 required',
            partition_count;
    END IF;
    IF to_regprocedure('ops.ensure_reconciliation_partitions(integer,integer)') IS NULL THEN
        RAISE EXCEPTION 'ops.ensure_reconciliation_partitions is missing';
    END IF;
    IF to_regprocedure('ops.refresh_reconciliation_daily(date)') IS NULL THEN
        RAISE EXCEPTION 'ops.refresh_reconciliation_daily is missing';
    END IF;

    -- One detail row per grain per day, never one per sync.
    SELECT count(*) INTO detail_duplicate
      FROM (
        SELECT 1
          FROM ops.reconciliation_daily_detail
         GROUP BY observed_on, store_id, domain_code, entity_key, metric_code
        HAVING count(*) > 1
      ) AS duplicates;
    IF detail_duplicate > 0 THEN
        RAISE EXCEPTION 'ops.reconciliation_daily_detail holds % duplicated day grains',
            detail_duplicate;
    END IF;

    -- The anomaly table must be incapable of holding a normal outcome, so an
    -- empty table truthfully means no anomaly was observed.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_ops_reconciliation_anomaly_status'
           AND conrelid = 'ops.reconciliation_anomaly'::regclass
    ) THEN
        RAISE EXCEPTION 'ops.reconciliation_anomaly is missing its status CHECK';
    END IF;
    SELECT count(*) INTO anomaly_violations
      FROM ops.reconciliation_anomaly
     WHERE status_code IN ('MATCH', 'NOT_EXPOSED');
    IF anomaly_violations > 0 THEN
        RAISE EXCEPTION 'ops.reconciliation_anomaly holds % fabricated rows',
            anomaly_violations;
    END IF;

    -- The bloated shadow table must not be left behind after a swap.
    IF to_regclass('ops.reconciliation_result_compact') IS NOT NULL THEN
        RAISE EXCEPTION 'ops.reconciliation_result_compact was left behind';
    END IF;

    /* Seeded retained detail. If the current table still holds rows inside the
       retention window, the migration must have seeded the matching per-day
       detail before dropping the old heap; otherwise the last 14 days of
       evidence were discarded and only the pre-migration dump has them. */
    SELECT count(*) INTO eligible_current_rows
      FROM ops.reconciliation_result
     WHERE (source_fetched_at AT TIME ZONE 'UTC')::date
           > ((clock_timestamp() AT TIME ZONE 'UTC')::date) - 14;
    IF eligible_current_rows > 0 THEN
        SELECT count(*) INTO seeded_detail_rows
          FROM ops.reconciliation_daily_detail
         WHERE observed_on
               > ((clock_timestamp() AT TIME ZONE 'UTC')::date) - 14;
        IF seeded_detail_rows = 0 THEN
            RAISE EXCEPTION
                'ops.reconciliation_daily_detail was not seeded although % current rows are in the retained window',
                eligible_current_rows;
        END IF;
        -- Long-term summary must exist for the seeded days too.
        SELECT count(*) INTO summary_rows
          FROM ops.reconciliation_daily_summary
         WHERE observed_on
               > ((clock_timestamp() AT TIME ZONE 'UTC')::date) - 14;
        IF summary_rows = 0 THEN
            RAISE EXCEPTION
                'ops.reconciliation_daily_summary was not refreshed for the seeded days';
        END IF;
    END IF;

    /* No redundant duplicate index. `LIKE ... INCLUDING INDEXES` used to copy the
       store-key unique index, and re-adding the constraint then produced two
       identical indexes on the same columns. */
    SELECT count(*) INTO store_key_indexes
      FROM pg_index AS index_entry
      JOIN pg_class AS index_class ON index_class.oid = index_entry.indexrelid
     WHERE index_entry.indrelid = 'ops.reconciliation_result'::regclass
       AND index_entry.indisunique
       AND (
         SELECT array_agg(attname::text ORDER BY attname::text)
           FROM pg_attribute
          WHERE attrelid = 'ops.reconciliation_result'::regclass
            AND attnum = ANY (index_entry.indkey)
       ) = ARRAY['reconciliation_key', 'store_id'];
    IF store_key_indexes <> 1 THEN
        RAISE EXCEPTION
            'expected exactly one (store_id, reconciliation_key) unique index, found %',
            store_key_indexes;
    END IF;

    -- Partition creation must use a true UTC day, not the server local date.
    IF EXISTS (
        SELECT 1 FROM pg_proc
         WHERE oid = 'ops.ensure_reconciliation_partitions(integer,integer)'::regprocedure
           AND prosrc LIKE '%current_date AT TIME ZONE%'
    ) THEN
        RAISE EXCEPTION
            'ops.ensure_reconciliation_partitions still derives days from current_date';
    END IF;
END;
$$;

SELECT 'full-managed reconciliation history governance OK' AS result;
