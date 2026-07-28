BEGIN;

DO $$
DECLARE
    expected_relation text;
    forbidden_column text;
    relation_name text;
BEGIN
    FOREACH expected_relation IN ARRAY ARRAY[
        'ops.backfill_run',
        'ops.backfill_window',
        'ops.backfill_checkpoint',
        'raw.webapi_fetch_batch',
        'raw.webapi_metric_observation',
        'dim.webapi_metric_definition',
        'ops.webapi_session_health'
    ]
    LOOP
        IF to_regclass(expected_relation) IS NULL THEN
            RAISE EXCEPTION 'Missing backfill/WebAPI relation: %', expected_relation;
        END IF;
    END LOOP;

    IF to_regprocedure('ops.reject_webapi_evidence_mutation()') IS NULL THEN
        RAISE EXCEPTION 'Missing WebAPI append-only guard function';
    END IF;

    -- Batch 2 must not create the formal realtime metric fact.
    IF to_regclass('fact.full_store_realtime_metric_snapshot') IS NOT NULL THEN
        RAISE EXCEPTION
            'fact.full_store_realtime_metric_snapshot must not exist before verified metric definitions';
    END IF;

    -- No secret-shaped column may exist anywhere in the WebAPI experiment layer.
    FOREACH relation_name IN ARRAY ARRAY[
        'raw.webapi_fetch_batch',
        'raw.webapi_metric_observation',
        'ops.webapi_session_health'
    ]
    LOOP
        FOR forbidden_column IN
            SELECT attname
              FROM pg_attribute
             WHERE attrelid = relation_name::regclass
               AND attnum > 0
               AND NOT attisdropped
               AND (
                   attname ILIKE '%cookie%'
                   OR attname ILIKE '%authorization%'
                   OR attname ILIKE '%token%'
                   OR attname ILIKE '%password%'
                   OR attname ILIKE '%secret%'
                   OR attname ILIKE '%credential%'
                   OR attname ILIKE '%header%'
                   OR attname ILIKE '%ciphertext%'
                   OR attname ILIKE '%raw_payload%'
                   OR attname ILIKE '%response_body%'
               )
        LOOP
            RAISE EXCEPTION 'WebAPI experiment relation % exposes secret-shaped column %',
                relation_name, forbidden_column;
        END LOOP;
    END LOOP;

    -- Monetary and metric values must never live in floating point.
    IF EXISTS (
        SELECT 1
          FROM pg_attribute AS attribute
          JOIN pg_type AS data_type ON data_type.oid = attribute.atttypid
         WHERE attribute.attrelid = 'raw.webapi_metric_observation'::regclass
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND data_type.typname IN ('float4', 'float8', 'money')
    ) THEN
        RAISE EXCEPTION 'WebAPI metric observation must not use floating point or money types';
    END IF;
END;
$$;

-- The append-only guard, the capability gate and the checkpoint proof gate must
-- all reject their negative case.
DO $$
DECLARE
    run_id bigint;
    other_run_id bigint;
    dry_run_id bigint;
    window_id bigint;
    partial_window_id bigint;
    batch_id bigint;
    rejected boolean;
BEGIN
    INSERT INTO ops.backfill_run (
        plan_hash, mode, status, requested_domains, requested_store_codes,
        requested_from, requested_to, window_span_days, planned_window_count,
        created_by, created_at, started_at
    )
    VALUES (
        repeat('a', 64), 'EXECUTE', 'RUNNING', ARRAY['deliveries'], ARRAY['DL5477'],
        DATE '2026-07-01', DATE '2026-07-02', 1, 1, 'verify.contract',
        statement_timestamp(), statement_timestamp()
    )
    RETURNING backfill_run_id INTO run_id;

    -- An unverified capability may not run or succeed.
    rejected := false;
    BEGIN
        INSERT INTO ops.backfill_window (
            backfill_run_id, store_code, domain, adapter_key,
            window_start, window_end, window_key, capability_status,
            execution_status, quality_status
        )
        VALUES (
            run_id, 'DL5477', 'financial-settlement', 'openapi.financial-settlement.v0',
            DATE '2026-07-01', DATE '2026-07-02', repeat('b', 64), 'UNVERIFIED',
            'SUCCEEDED', 'PASSED'
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'unverified capability window was allowed to succeed';
    END IF;

    -- PASSED without exact page coverage and zero rejects must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO ops.backfill_window (
            backfill_run_id, store_code, domain, adapter_key,
            window_start, window_end, window_key, capability_status,
            execution_status, quality_status, accepted_row_count,
            rejected_row_count, expected_page_count, observed_page_count,
            schema_fingerprint
        )
        VALUES (
            run_id, 'DL5477', 'deliveries', 'openapi.deliveries.v1',
            DATE '2026-07-01', DATE '2026-07-02', repeat('c', 64), 'VERIFIED',
            'SUCCEEDED', 'PASSED', 10, 2, 3, 2, repeat('d', 64)
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'incomplete window was allowed to pass the quality gate';
    END IF;

    -- A partial window exists but must never be citable by a checkpoint.
    INSERT INTO ops.backfill_window (
        backfill_run_id, store_code, domain, adapter_key,
        window_start, window_end, window_key, capability_status,
        execution_status, quality_status, accepted_row_count,
        rejected_row_count, expected_page_count, observed_page_count,
        source_business_watermark, schema_fingerprint
    )
    VALUES (
        run_id, 'MZ2406', 'deliveries', 'openapi.deliveries.v1',
        DATE '2026-07-01', DATE '2026-07-02', repeat('9', 64), 'VERIFIED',
        'PARTIAL', 'MISSING_PAGE', 5, 0, 3, 2, DATE '2026-07-01', repeat('8', 64)
    )
    RETURNING backfill_window_id INTO partial_window_id;

    rejected := false;
    BEGIN
        INSERT INTO ops.backfill_checkpoint (
            store_code, domain, adapter_key, last_completed_business_date,
            last_successful_run_id, last_successful_window_id,
            schema_fingerprint, quality_status, capability_status
        )
        VALUES (
            'MZ2406', 'deliveries', 'openapi.deliveries.v1', DATE '2026-07-01',
            run_id, partial_window_id, repeat('8', 64), 'PASSED', 'VERIFIED'
        );
    EXCEPTION WHEN foreign_key_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'checkpoint cited a partial window';
    END IF;

    INSERT INTO ops.backfill_window (
        backfill_run_id, store_code, domain, adapter_key,
        window_start, window_end, window_key, capability_status,
        execution_status, quality_status, accepted_row_count,
        rejected_row_count, expected_page_count, observed_page_count,
        source_business_watermark, schema_fingerprint
    )
    VALUES (
        run_id, 'DL5477', 'deliveries', 'openapi.deliveries.v1',
        DATE '2026-07-01', DATE '2026-07-02', repeat('e', 64), 'VERIFIED',
        'SUCCEEDED', 'PASSED', 5, 0, 2, 2, DATE '2026-07-01', repeat('f', 64)
    )
    RETURNING backfill_window_id INTO window_id;

    -- A checkpoint may not exist with a failed quality status.
    rejected := false;
    BEGIN
        INSERT INTO ops.backfill_checkpoint (
            store_code, domain, adapter_key, last_completed_business_date,
            last_successful_run_id, last_successful_window_id,
            schema_fingerprint, quality_status, capability_status
        )
        VALUES (
            'DL5477', 'deliveries', 'openapi.deliveries.v1', DATE '2026-07-01',
            run_id, window_id, repeat('f', 64), 'SCHEMA_DRIFT', 'VERIFIED'
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'checkpoint accepted a non-passed quality status';
    END IF;

    -- A DRY_RUN run may never own a checkpoint.
    INSERT INTO ops.backfill_run (
        plan_hash, mode, status, requested_domains, requested_store_codes,
        requested_from, requested_to, window_span_days, planned_window_count,
        created_by, created_at, started_at
    )
    VALUES (
        repeat('7', 64), 'DRY_RUN', 'PLANNED', ARRAY['deliveries'], ARRAY['DL5477'],
        DATE '2026-07-01', DATE '2026-07-02', 1, 1, 'verify.contract',
        statement_timestamp(), statement_timestamp()
    )
    RETURNING backfill_run_id INTO dry_run_id;

    rejected := false;
    BEGIN
        INSERT INTO ops.backfill_checkpoint (
            store_code, domain, adapter_key, last_completed_business_date,
            last_successful_run_id, last_successful_window_id,
            schema_fingerprint, quality_status, capability_status
        )
        VALUES (
            'DL5477', 'deliveries', 'openapi.deliveries.v1', DATE '2026-07-01',
            dry_run_id, window_id, repeat('f', 64), 'PASSED', 'VERIFIED'
        );
    EXCEPTION WHEN foreign_key_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'checkpoint cited a dry-run run';
    END IF;

    -- Mixed evidence: the watermark must come from the cited window.
    rejected := false;
    BEGIN
        INSERT INTO ops.backfill_checkpoint (
            store_code, domain, adapter_key, last_completed_business_date,
            last_successful_run_id, last_successful_window_id,
            schema_fingerprint, quality_status, capability_status
        )
        VALUES (
            'DL5477', 'deliveries', 'openapi.deliveries.v1', DATE '2026-06-30',
            run_id, window_id, repeat('f', 64), 'PASSED', 'VERIFIED'
        );
    EXCEPTION WHEN foreign_key_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'checkpoint accepted a watermark from another window';
    END IF;

    -- Mixed evidence: the fingerprint must come from the cited window.
    rejected := false;
    BEGIN
        INSERT INTO ops.backfill_checkpoint (
            store_code, domain, adapter_key, last_completed_business_date,
            last_successful_run_id, last_successful_window_id,
            schema_fingerprint, quality_status, capability_status
        )
        VALUES (
            'DL5477', 'deliveries', 'openapi.deliveries.v1', DATE '2026-07-01',
            run_id, window_id, repeat('8', 64), 'PASSED', 'VERIFIED'
        );
    EXCEPTION WHEN foreign_key_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'checkpoint accepted a fingerprint from another window';
    END IF;

    -- Mixed evidence: the run id must be the run that produced the window.
    INSERT INTO ops.backfill_run (
        plan_hash, mode, status, requested_domains, requested_store_codes,
        requested_from, requested_to, window_span_days, planned_window_count,
        created_by, created_at, started_at
    )
    VALUES (
        repeat('6', 64), 'EXECUTE', 'RUNNING', ARRAY['deliveries'], ARRAY['DL5477'],
        DATE '2026-07-01', DATE '2026-07-02', 1, 1, 'verify.contract',
        clock_timestamp(), clock_timestamp()
    )
    RETURNING backfill_run_id INTO other_run_id;

    rejected := false;
    BEGIN
        INSERT INTO ops.backfill_checkpoint (
            store_code, domain, adapter_key, last_completed_business_date,
            last_successful_run_id, last_successful_window_id,
            schema_fingerprint, quality_status, capability_status
        )
        VALUES (
            'DL5477', 'deliveries', 'openapi.deliveries.v1', DATE '2026-07-01',
            other_run_id, window_id, repeat('f', 64), 'PASSED', 'VERIFIED'
        );
    EXCEPTION WHEN foreign_key_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'checkpoint mixed a run id from another run';
    END IF;

    -- A watermark outside its own half-open window is impossible.
    rejected := false;
    BEGIN
        INSERT INTO ops.backfill_window (
            backfill_run_id, store_code, domain, adapter_key,
            window_start, window_end, window_key, capability_status,
            execution_status, quality_status, accepted_row_count,
            rejected_row_count, expected_page_count, observed_page_count,
            source_business_watermark, schema_fingerprint
        )
        VALUES (
            run_id, 'DL5477', 'deliveries', 'openapi.deliveries.v1',
            DATE '2026-07-05', DATE '2026-07-06', repeat('5', 64), 'VERIFIED',
            'SUCCEEDED', 'PASSED', 1, 0, 1, 1, DATE '2026-07-06', repeat('4', 64)
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'window accepted a watermark outside its half-open range';
    END IF;

    INSERT INTO ops.backfill_checkpoint (
        store_code, domain, adapter_key, last_completed_business_date,
        last_successful_run_id, last_successful_window_id,
        schema_fingerprint, quality_status, capability_status
    )
    VALUES (
        'DL5477', 'deliveries', 'openapi.deliveries.v1', DATE '2026-07-01',
        run_id, window_id, repeat('f', 64), 'PASSED', 'VERIFIED'
    );

    -- The progress trigger keeps the grain and created_at immutable and forces
    -- the business date strictly forward.
    rejected := false;
    BEGIN
        UPDATE ops.backfill_checkpoint
           SET last_completed_business_date = DATE '2026-07-01'
         WHERE store_code = 'DL5477'
           AND domain = 'deliveries';
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'checkpoint business date did not have to move forward';
    END IF;

    rejected := false;
    BEGIN
        UPDATE ops.backfill_checkpoint
           SET domain = 'purchase-orders'
         WHERE store_code = 'DL5477'
           AND domain = 'deliveries';
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'checkpoint grain was mutable';
    END IF;

    rejected := false;
    BEGIN
        UPDATE ops.backfill_checkpoint
           SET created_at = clock_timestamp()
         WHERE store_code = 'DL5477'
           AND domain = 'deliveries';
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'checkpoint created_at was mutable';
    END IF;

    -- WebAPI evidence is append-only and canonical-key bound.
    rejected := false;
    BEGIN
        INSERT INTO raw.webapi_fetch_batch (
            batch_key, store_code, profile_key, endpoint_code, http_method,
            request_schema_hash, request_fingerprint, requested_at, result_status
        )
        VALUES (
            repeat('a', 64), 'DL5477', 'persistent-dl-profile', 'HOME_V4_DETAIL',
            'POST', repeat('1', 64), repeat('1', 64), clock_timestamp(), 'SCHEMA_ONLY'
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a non-canonical Profile key was accepted';
    END IF;

    rejected := false;
    BEGIN
        INSERT INTO raw.webapi_fetch_batch (
            batch_key, store_code, profile_key, endpoint_code, http_method,
            request_schema_hash, request_fingerprint, requested_at, result_status
        )
        VALUES (
            repeat('b', 64), 'DL5477', 'persistent-dl5477-profile',
            'HOME_TREND_HISTORY', 'POST', repeat('1', 64), repeat('1', 64),
            clock_timestamp(), 'SCHEMA_ONLY'
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'an endpoint outside the evidenced allow-list was accepted';
    END IF;

    INSERT INTO raw.webapi_fetch_batch (
        batch_key, store_code, profile_key, endpoint_code, http_method,
        request_schema_hash, request_fingerprint, response_schema_hash,
        payload_fingerprint, requested_at, completed_at, http_status,
        result_status, observation_count, rejected_count
    )
    VALUES (
        repeat('c', 64), 'MZ2406', 'persistent-mz2406-profile',
        'HOME_DATA_OVERVIEW_DETAIL', 'POST',
        repeat('2', 64), repeat('5', 64), repeat('3', 64), repeat('4', 64),
        clock_timestamp(), clock_timestamp(), 200, 'SCHEMA_ONLY', 1, 0
    )
    RETURNING webapi_fetch_batch_id INTO batch_id;

    rejected := false;
    BEGIN
        UPDATE raw.webapi_fetch_batch
           SET http_status = 500
         WHERE webapi_fetch_batch_id = batch_id;
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'WebAPI fetch batch is not append-only';
    END IF;

    -- An illegal decimal string must never be persisted as an accepted value.
    rejected := false;
    BEGIN
        INSERT INTO raw.webapi_metric_observation (
            observation_key, webapi_fetch_batch_id, store_code, meta_index_id,
            metric_code, raw_value_text, raw_decimal_value, observed_at,
            semantic_status
        )
        VALUES (
            repeat('1', 64), batch_id, 'MZ2406', 70, 'GSP000016', '1.2e3', 1200,
            clock_timestamp(), 'UNMAPPED'
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'an illegal decimal string was accepted';
    END IF;

    -- VERIFIED without a versioned definition must be impossible.
    rejected := false;
    BEGIN
        INSERT INTO raw.webapi_metric_observation (
            observation_key, webapi_fetch_batch_id, store_code, meta_index_id,
            metric_code, raw_value_text, raw_decimal_value, observed_at,
            semantic_status
        )
        VALUES (
            repeat('2', 64), batch_id, 'MZ2406', 70, 'GSP000017', '12.34', 12.34,
            clock_timestamp(), 'VERIFIED'
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a VERIFIED observation was accepted without a definition';
    END IF;

    INSERT INTO raw.webapi_metric_observation (
        observation_key, webapi_fetch_batch_id, store_code, meta_index_id,
        metric_code, raw_value_text, raw_decimal_value, currency, observed_at,
        semantic_status
    )
    VALUES (
        repeat('3', 64), batch_id, 'MZ2406', 70, 'GSP000016', '12.34', 12.34,
        'CNY', clock_timestamp(), 'UNMAPPED'
    );

    -- A rejected row for the same platform metric must coexist with the accepted
    -- one instead of silently overwriting it.
    INSERT INTO raw.webapi_metric_observation (
        observation_key, webapi_fetch_batch_id, store_code, meta_index_id,
        metric_code, raw_value_text, raw_decimal_value, observed_at,
        semantic_status, sanitized_reject_code
    )
    VALUES (
        repeat('4', 64), batch_id, 'MZ2406', 70, 'GSP000016', NULL, NULL,
        clock_timestamp(), 'REJECTED', 'DECIMAL_NON_CANONICAL'
    );

    -- A VERIFIED definition demands reviewed human evidence.
    rejected := false;
    BEGIN
        INSERT INTO dim.webapi_metric_definition (
            meta_index_id, metric_code, effective_from, mapping_status
        )
        VALUES (70, 'GSP000016', DATE '2026-07-28', 'VERIFIED');
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a VERIFIED metric definition was accepted without evidence';
    END IF;

    INSERT INTO ops.webapi_session_health (
        store_code, profile_key, observed_at, session_state
    )
    VALUES ('DL5477', 'persistent-dl5477-profile', clock_timestamp(), 'ACTIVE');

    rejected := false;
    BEGIN
        DELETE FROM ops.webapi_session_health;
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'WebAPI session health is not append-only';
    END IF;
END;
$$;

ROLLBACK;
