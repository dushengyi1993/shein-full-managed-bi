BEGIN;

-- Bounded reconciliation history governance.
--
-- ops.reconciliation_result was intended to hold current state, one row per
-- (store_id, domain_code, entity_key, metric_code). The writer folded
-- source_fetched_at into reconciliation_key, so every sync minted a new key and
-- the upsert degenerated into an append: 3,007,452 rows / ~1.78GB for only
-- 93,702 real grains, all MATCH or NOT_EXPOSED.
--
-- This migration:
--   1. adds the stable grain uniqueness the writer now conflicts on,
--   2. compacts current state by rebuild-and-swap so the heap is actually
--      returned rather than left allocated by a large DELETE,
--   3. adds bounded per-day detail (partitioned, 14-day retention) plus
--      long-term daily summary and anomaly-only tables.
--
-- The whole file is rerunnable: the migration runner replays every migration on
-- every deployment, so each step is guarded and converges.

-- ---------------------------------------------------------------------------
-- 1. Bounded per-day detail, partitioned by observed_on (UTC date).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ops.reconciliation_daily_detail (
    store_id bigint NOT NULL,
    observed_on date NOT NULL,
    domain_code text NOT NULL,
    entity_key text NOT NULL,
    metric_code text NOT NULL,
    status_code text NOT NULL,
    aggregate_quantity bigint,
    detail_quantity bigint,
    difference_quantity bigint,
    explanation text NOT NULL,
    -- Provenance is kept as plain columns rather than foreign keys: raw fetch
    -- batches are pruned on their own schedule, and a partition drop must not be
    -- blocked by a reference to a raw row that has already aged out.
    source_fetch_batch_id bigint,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_ops_reconciliation_daily_detail
        PRIMARY KEY (observed_on, store_id, domain_code, entity_key, metric_code),
    CONSTRAINT ck_ops_reconciliation_daily_detail_codes
        CHECK (
            domain_code <> ''
            AND entity_key <> ''
            AND metric_code <> ''
            AND status_code <> ''
            AND explanation <> ''
        ),
    CONSTRAINT ck_ops_reconciliation_daily_detail_quantities
        CHECK (
            (aggregate_quantity IS NULL OR aggregate_quantity >= 0)
            AND (detail_quantity IS NULL OR detail_quantity >= 0)
        ),
    CONSTRAINT ck_ops_reconciliation_daily_detail_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
) PARTITION BY RANGE (observed_on);

COMMENT ON TABLE ops.reconciliation_daily_detail IS
    'Latest reconciliation observation per stable grain per UTC day. One row per grain per day, never one row per sync. Detail partitions are dropped after 14 days; long-term evidence lives in the summary and anomaly tables.';

/**
 * Create the daily partitions a write needs, fail closed if it cannot.
 *
 * A missing partition makes an insert fail rather than silently routing data
 * elsewhere, so maintenance always calls this before loading a new day.
 */
CREATE OR REPLACE FUNCTION ops.ensure_reconciliation_partitions(
    days_ahead integer DEFAULT 90,
    days_behind integer DEFAULT 2
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    target_day date;
    partition_name text;
    created_count integer := 0;
BEGIN
    IF days_ahead < 1 OR days_ahead > 400 THEN
        RAISE EXCEPTION 'days_ahead % is out of the supported range', days_ahead
            USING ERRCODE = '22023';
    END IF;
    IF days_behind < 0 OR days_behind > 400 THEN
        RAISE EXCEPTION 'days_behind % is out of the supported range', days_behind
            USING ERRCODE = '22023';
    END IF;
    -- True UTC day. `current_date` is the server's local date, so on an
    -- Asia/Shanghai host it is already tomorrow for eight hours of every UTC
    -- day: partitions would be created one day off and a write near the
    -- boundary would fail closed for a partition that was never made.
    FOR target_day IN
        SELECT generate_series(
            ((clock_timestamp() AT TIME ZONE 'UTC')::date) - days_behind,
            ((clock_timestamp() AT TIME ZONE 'UTC')::date) + days_ahead,
            interval '1 day'
        )::date
    LOOP
        partition_name := format(
            'reconciliation_daily_detail_%s',
            to_char(target_day, 'YYYYMMDD')
        );
        IF to_regclass(format('ops.%I', partition_name)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE ops.%I PARTITION OF ops.reconciliation_daily_detail '
                'FOR VALUES FROM (%L) TO (%L)',
                partition_name,
                target_day,
                target_day + 1
            );
            created_count := created_count + 1;
        END IF;
    END LOOP;
    RETURN created_count;
END;
$$;

COMMENT ON FUNCTION ops.ensure_reconciliation_partitions(integer, integer) IS
    'Idempotently create daily reconciliation detail partitions. Writers fail closed when a partition is missing, so maintenance must call this before loading.';

-- Pre-create a wide forward window so a missed maintenance run cannot stall
-- writes, plus 14 days behind so the retained window can be seeded from the
-- existing table below before it is dropped.
SELECT ops.ensure_reconciliation_partitions(120, 14);

-- ---------------------------------------------------------------------------
-- 2. Long-term daily summary and anomaly-only evidence.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ops.reconciliation_daily_summary (
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    observed_on date NOT NULL,
    domain_code text NOT NULL,
    status_code text NOT NULL,
    grain_count bigint NOT NULL,
    anomaly_count bigint NOT NULL,
    max_abs_difference bigint,
    latest_source_fetched_at timestamptz NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_ops_reconciliation_daily_summary
        PRIMARY KEY (observed_on, store_id, domain_code, status_code),
    CONSTRAINT ck_ops_reconciliation_daily_summary_counts
        CHECK (grain_count >= 0 AND anomaly_count >= 0 AND anomaly_count <= grain_count)
);

COMMENT ON TABLE ops.reconciliation_daily_summary IS
    'Recomputable long-term daily reconciliation counts. Retained after detail partitions are dropped; safe to recompute for any day whose detail still exists.';

CREATE TABLE IF NOT EXISTS ops.reconciliation_anomaly (
    reconciliation_anomaly_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    observed_on date NOT NULL,
    domain_code text NOT NULL,
    entity_key text NOT NULL,
    metric_code text NOT NULL,
    status_code text NOT NULL,
    aggregate_quantity bigint,
    detail_quantity bigint,
    difference_quantity bigint,
    explanation text NOT NULL,
    source_fetch_batch_id bigint,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_reconciliation_anomaly_grain
        UNIQUE (observed_on, store_id, domain_code, entity_key, metric_code),
    -- Only real anomalies may be stored here. MATCH and NOT_EXPOSED are normal
    -- outcomes, so this table can never be padded with fabricated findings.
    CONSTRAINT ck_ops_reconciliation_anomaly_status
        CHECK (status_code NOT IN ('MATCH', 'NOT_EXPOSED')),
    CONSTRAINT ck_ops_reconciliation_anomaly_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE ops.reconciliation_anomaly IS
    'Long-term anomaly-only reconciliation evidence. A CHECK constraint forbids MATCH and NOT_EXPOSED rows, so an empty table truthfully means no anomaly was observed.';

/** Recompute one day of summary and anomaly rows from surviving detail. */
CREATE OR REPLACE FUNCTION ops.refresh_reconciliation_daily(target_day date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    summary_rows integer := 0;
BEGIN
    DELETE FROM ops.reconciliation_daily_summary WHERE observed_on = target_day;
    INSERT INTO ops.reconciliation_daily_summary (
        store_id, observed_on, domain_code, status_code,
        grain_count, anomaly_count, max_abs_difference, latest_source_fetched_at
    )
    SELECT detail.store_id,
           detail.observed_on,
           detail.domain_code,
           detail.status_code,
           count(*)::bigint,
           count(*) FILTER (
               WHERE detail.status_code NOT IN ('MATCH', 'NOT_EXPOSED')
           )::bigint,
           max(abs(detail.difference_quantity)),
           max(detail.source_fetched_at)
    FROM ops.reconciliation_daily_detail AS detail
    WHERE detail.observed_on = target_day
    GROUP BY detail.store_id, detail.observed_on, detail.domain_code, detail.status_code;
    GET DIAGNOSTICS summary_rows = ROW_COUNT;

    /* Remove the day's previous anomaly rows first. An upsert alone would leave
       a stale anomaly behind once a grain recovers to MATCH: the recovered grain
       no longer appears in the INSERT's source set, so its old row would survive
       forever and the table would claim an anomaly that no longer exists. */
    DELETE FROM ops.reconciliation_anomaly WHERE observed_on = target_day;

    -- Anomaly evidence is inserted from detail; nothing is invented.
    INSERT INTO ops.reconciliation_anomaly (
        store_id, observed_on, domain_code, entity_key, metric_code, status_code,
        aggregate_quantity, detail_quantity, difference_quantity, explanation,
        source_fetch_batch_id, payload_fingerprint, source_fetched_at
    )
    SELECT detail.store_id, detail.observed_on, detail.domain_code, detail.entity_key,
           detail.metric_code, detail.status_code, detail.aggregate_quantity,
           detail.detail_quantity, detail.difference_quantity, detail.explanation,
           detail.source_fetch_batch_id, detail.payload_fingerprint,
           detail.source_fetched_at
    FROM ops.reconciliation_daily_detail AS detail
    WHERE detail.observed_on = target_day
      AND detail.status_code NOT IN ('MATCH', 'NOT_EXPOSED')
    ON CONFLICT (observed_on, store_id, domain_code, entity_key, metric_code)
    DO UPDATE SET
        status_code = EXCLUDED.status_code,
        aggregate_quantity = EXCLUDED.aggregate_quantity,
        detail_quantity = EXCLUDED.detail_quantity,
        difference_quantity = EXCLUDED.difference_quantity,
        explanation = EXCLUDED.explanation,
        source_fetch_batch_id = EXCLUDED.source_fetch_batch_id,
        payload_fingerprint = EXCLUDED.payload_fingerprint,
        source_fetched_at = EXCLUDED.source_fetched_at
    WHERE EXCLUDED.source_fetched_at >= ops.reconciliation_anomaly.source_fetched_at;

    RETURN summary_rows;
END;
$$;

COMMENT ON FUNCTION ops.refresh_reconciliation_daily(date) IS
    'Idempotently recompute one day of reconciliation summary and anomaly rows from the surviving detail partition.';

-- ---------------------------------------------------------------------------
-- 3. Stable current-state grain and compaction.
-- ---------------------------------------------------------------------------

-- The writer now conflicts on the stable grain, so this uniqueness is required
-- before the new upsert can run. Adding it also proves the compaction worked.
DO $$
DECLARE
    duplicate_grains bigint;
    total_rows bigint;
    seeded_detail_rows bigint;
    seeded_day date;
BEGIN
    IF to_regclass('ops.reconciliation_result') IS NULL THEN
        RETURN;
    END IF;

    SELECT count(*) INTO total_rows FROM ops.reconciliation_result;
    SELECT count(*) INTO duplicate_grains
      FROM (
        SELECT 1
          FROM ops.reconciliation_result
         GROUP BY store_id, domain_code, entity_key, metric_code
        HAVING count(*) > 1
      ) AS duplicates;

    IF duplicate_grains = 0 THEN
        RAISE NOTICE 'reconciliation_result already compact (% rows)', total_rows;
    ELSE
        RAISE NOTICE 'compacting reconciliation_result: % rows, % duplicated grains',
            total_rows, duplicate_grains;

        -- Rebuild and swap. A DELETE of ~2.9M rows would leave the heap
        -- allocated and still require an exclusive VACUUM FULL, so the compact
        -- table is built fresh and the bloated heap is dropped outright.
        DROP TABLE IF EXISTS ops.reconciliation_result_compact;
        CREATE TABLE ops.reconciliation_result_compact (
            LIKE ops.reconciliation_result
            INCLUDING DEFAULTS
            INCLUDING CONSTRAINTS
            INCLUDING COMMENTS
        );

        -- Keep the newest observation per stable grain.
        INSERT INTO ops.reconciliation_result_compact
        SELECT DISTINCT ON (store_id, domain_code, entity_key, metric_code) *
          FROM ops.reconciliation_result
         ORDER BY store_id, domain_code, entity_key, metric_code,
                  source_fetched_at DESC, reconciliation_result_id DESC;

        -- `LIKE` does not copy identity, foreign keys or triggers, so they are
        -- restored explicitly below.
        -- Identity is added after the copy, so the original GENERATED ALWAYS
        -- contract is preserved without needing OVERRIDING SYSTEM VALUE above.
        ALTER TABLE ops.reconciliation_result_compact
            ALTER COLUMN reconciliation_result_id
            ADD GENERATED ALWAYS AS IDENTITY;
        PERFORM setval(
            pg_get_serial_sequence(
                'ops.reconciliation_result_compact', 'reconciliation_result_id'
            ),
            GREATEST(
                (SELECT coalesce(max(reconciliation_result_id), 1)
                   FROM ops.reconciliation_result_compact),
                1
            )
        );

        /* Seed the retained daily detail window from the table we are about to
           drop. Without this the 3M historical rows would be discarded outright
           and the last 14 days of per-day evidence would be lost forever: the
           only surviving copy is the pre-migration dump. One row per stable grain
           per UTC day, newest observation wins. */
        INSERT INTO ops.reconciliation_daily_detail (
            store_id, observed_on, domain_code, entity_key, metric_code,
            status_code, aggregate_quantity, detail_quantity, difference_quantity,
            explanation, source_fetch_batch_id, payload_fingerprint, source_fetched_at
        )
        SELECT DISTINCT ON (
                   (source.source_fetched_at AT TIME ZONE 'UTC')::date,
                   source.store_id, source.domain_code,
                   source.entity_key, source.metric_code
               )
               source.store_id,
               (source.source_fetched_at AT TIME ZONE 'UTC')::date,
               source.domain_code, source.entity_key, source.metric_code,
               source.status_code, source.aggregate_quantity, source.detail_quantity,
               source.difference_quantity, source.explanation,
               source.source_fetch_batch_id, source.payload_fingerprint,
               source.source_fetched_at
          FROM ops.reconciliation_result AS source
         WHERE (source.source_fetched_at AT TIME ZONE 'UTC')::date
               > ((clock_timestamp() AT TIME ZONE 'UTC')::date) - 14
         ORDER BY (source.source_fetched_at AT TIME ZONE 'UTC')::date,
                  source.store_id, source.domain_code,
                  source.entity_key, source.metric_code,
                  source.source_fetched_at DESC, source.reconciliation_result_id DESC
        ON CONFLICT (observed_on, store_id, domain_code, entity_key, metric_code)
        DO NOTHING;

        SELECT count(*) INTO seeded_detail_rows
          FROM ops.reconciliation_daily_detail;
        RAISE NOTICE 'seeded % reconciliation daily detail rows before compaction',
            seeded_detail_rows;

        -- Long-term summary and anomaly rows for the seeded days, so the
        -- evidence survives the later partition drops.
        FOR seeded_day IN
            SELECT DISTINCT observed_on
              FROM ops.reconciliation_daily_detail
             ORDER BY observed_on
        LOOP
            PERFORM ops.refresh_reconciliation_daily(seeded_day);
        END LOOP;

        DROP TABLE ops.reconciliation_result;
        ALTER TABLE ops.reconciliation_result_compact
            RENAME TO reconciliation_result;
    END IF;

    /* Restore the full contract, whether or not a swap just happened. Every
       statement below is idempotent and, importantly, conditional: the previous
       version dropped the primary key unconditionally and then re-added it, so
       every migration replay took an ACCESS EXCLUSIVE lock and rebuilt the index
       for no reason. */
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'ops.reconciliation_result'::regclass
           AND contype = 'p'
    ) THEN
        ALTER TABLE ops.reconciliation_result
            ADD CONSTRAINT pk_ops_reconciliation_result
            PRIMARY KEY (reconciliation_result_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'uq_ops_reconciliation_result_grain'
           AND conrelid = 'ops.reconciliation_result'::regclass
    ) THEN
        ALTER TABLE ops.reconciliation_result
            ADD CONSTRAINT uq_ops_reconciliation_result_grain
            UNIQUE (store_id, domain_code, entity_key, metric_code);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'uq_ops_reconciliation_result_store_key'
           AND conrelid = 'ops.reconciliation_result'::regclass
    ) THEN
        ALTER TABLE ops.reconciliation_result
            ADD CONSTRAINT uq_ops_reconciliation_result_store_key
            UNIQUE (store_id, reconciliation_key);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'fk_ops_reconciliation_result_store'
           AND conrelid = 'ops.reconciliation_result'::regclass
    ) THEN
        ALTER TABLE ops.reconciliation_result
            ADD CONSTRAINT fk_ops_reconciliation_result_store
            FOREIGN KEY (store_id) REFERENCES dim.store (store_id) ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'fk_ops_reconciliation_result_batch'
           AND conrelid = 'ops.reconciliation_result'::regclass
    ) THEN
        ALTER TABLE ops.reconciliation_result
            ADD CONSTRAINT fk_ops_reconciliation_result_batch
            FOREIGN KEY (source_fetch_batch_id)
            REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT;
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS ix_ops_reconciliation_result_attention
    ON ops.reconciliation_result (store_id, domain_code, source_fetched_at DESC)
    WHERE status_code NOT IN ('MATCH', 'NOT_EXPOSED');

DROP TRIGGER IF EXISTS trg_ops_reconciliation_result_touch_updated_at
    ON ops.reconciliation_result;
CREATE TRIGGER trg_ops_reconciliation_result_touch_updated_at
BEFORE UPDATE ON ops.reconciliation_result
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_ops_reconciliation_daily_detail_touch_updated_at
    ON ops.reconciliation_daily_detail;
CREATE TRIGGER trg_ops_reconciliation_daily_detail_touch_updated_at
BEFORE UPDATE ON ops.reconciliation_daily_detail
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

COMMENT ON CONSTRAINT uq_ops_reconciliation_result_grain
    ON ops.reconciliation_result IS
    'Stable current-state grain. The writer conflicts on this, never on a time-derived key, so a resync updates the existing row instead of appending a new one.';

-- Grants are reconciled centrally by 9999_runtime_role_reconcile.sql, which runs
-- after every migration; the new tables are added to that policy there.

COMMIT;
