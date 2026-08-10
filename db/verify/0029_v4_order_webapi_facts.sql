BEGIN;

DO $$
DECLARE
    expected_relation text;
    forbidden_column text;
    relation_name text;
    required_column text;
BEGIN
    FOREACH expected_relation IN ARRAY ARRAY[
        'fact.full_webapi_stock_record_observation',
        'fact.full_webapi_waybill_observation',
        'fact.full_webapi_return_application_observation',
        'fact.full_webapi_return_order_observation',
        'fact.full_webapi_exception_observation',
        'fact.full_webapi_quality_report_observation',
        'fact.full_webapi_value_added_service_observation'
    ]
    LOOP
        IF to_regclass(expected_relation) IS NULL THEN
            RAISE EXCEPTION 'Missing v4 order WebAPI fact relation: %',
                expected_relation;
        END IF;
    END LOOP;

    -- Every typed fact table must carry the full evidence spine and the
    -- exact-replay primary key.
    FOREACH relation_name IN ARRAY ARRAY[
        'fact.full_webapi_stock_record_observation',
        'fact.full_webapi_waybill_observation',
        'fact.full_webapi_return_application_observation',
        'fact.full_webapi_return_order_observation',
        'fact.full_webapi_exception_observation',
        'fact.full_webapi_quality_report_observation',
        'fact.full_webapi_value_added_service_observation'
    ]
    LOOP
        FOREACH required_column IN ARRAY ARRAY[
            'store_code',
            'entity_key_hash',
            'source_version_token',
            'source_attempt_id',
            'source_page_evidence_id',
            'observed_at',
            'source_updated_at',
            'payload_hash'
        ]
        LOOP
            IF NOT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = split_part(relation_name, '.', 1)
                  AND table_name = split_part(relation_name, '.', 2)
                  AND column_name = required_column
            ) THEN
                RAISE EXCEPTION 'v4 fact relation % is missing column %',
                    relation_name, required_column;
            END IF;
        END LOOP;
        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint AS constraint_record
            WHERE constraint_record.conrelid = relation_name::regclass
              AND constraint_record.contype = 'p'
              AND constraint_record.conkey = ARRAY[
                  (SELECT attnum
                     FROM pg_attribute
                    WHERE attrelid = relation_name::regclass
                      AND attname = 'source_attempt_id'),
                  (SELECT attnum
                     FROM pg_attribute
                    WHERE attrelid = relation_name::regclass
                      AND attname = 'entity_key_hash'),
                  (SELECT attnum
                     FROM pg_attribute
                    WHERE attrelid = relation_name::regclass
                      AND attname = 'source_version_token')
              ]
        ) THEN
            RAISE EXCEPTION
                'v4 fact relation % lacks the exact-replay primary key',
                relation_name;
        END IF;
        -- The page evidence pin must be a composite foreign key: the cited
        -- page evidence row must belong to the cited attempt, enforced by the
        -- database, not only by the repository.
        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint AS constraint_record
            WHERE constraint_record.conrelid = relation_name::regclass
              AND constraint_record.contype = 'f'
              AND constraint_record.confrelid = 'ops.v4_page_evidence'::regclass
              AND constraint_record.conkey = ARRAY[
                  (SELECT attnum
                     FROM pg_attribute
                    WHERE attrelid = relation_name::regclass
                      AND attname = 'source_attempt_id'),
                  (SELECT attnum
                     FROM pg_attribute
                    WHERE attrelid = relation_name::regclass
                      AND attname = 'source_page_evidence_id')
              ]::smallint[]
              AND constraint_record.confkey = ARRAY[
                  (SELECT attnum
                     FROM pg_attribute
                    WHERE attrelid = 'ops.v4_page_evidence'::regclass
                      AND attname = 'collection_attempt_id'),
                  (SELECT attnum
                     FROM pg_attribute
                    WHERE attrelid = 'ops.v4_page_evidence'::regclass
                      AND attname = 'page_evidence_id')
              ]::smallint[]
        ) THEN
            RAISE EXCEPTION
                'v4 fact relation % lacks the attempt-pinned page evidence foreign key',
                relation_name;
        END IF;
    END LOOP;

    -- No float, money or generic JSONB payload column may exist anywhere in
    -- the typed fact layer.
    FOREACH relation_name IN ARRAY ARRAY[
        'fact.full_webapi_stock_record_observation',
        'fact.full_webapi_waybill_observation',
        'fact.full_webapi_return_application_observation',
        'fact.full_webapi_return_order_observation',
        'fact.full_webapi_exception_observation',
        'fact.full_webapi_quality_report_observation',
        'fact.full_webapi_value_added_service_observation'
    ]
    LOOP
        IF EXISTS (
            SELECT 1
            FROM pg_attribute AS attribute
            JOIN pg_type AS data_type ON data_type.oid = attribute.atttypid
            WHERE attribute.attrelid = relation_name::regclass
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND data_type.typname IN ('float4', 'float8', 'money', 'json', 'jsonb')
        ) THEN
            RAISE EXCEPTION
                'v4 fact relation % must be typed without float, money or JSONB columns',
                relation_name;
        END IF;
        -- PII-shaped and secret-shaped columns are forbidden: no address,
        -- contact, phone, buyer, image/attachment URL or credential column.
        -- source_version_token is the bounded replay-version field defined by
        -- this schema, not an authentication/session token.
        FOR forbidden_column IN
            SELECT attname
              FROM pg_attribute
             WHERE attrelid = relation_name::regclass
               AND attnum > 0
               AND NOT attisdropped
               AND (
                   attname ILIKE '%address%'
                   OR attname ILIKE '%phone%'
                   OR attname ILIKE '%tel%'
                   OR attname ILIKE '%mobile%'
                   OR attname ILIKE '%contact%'
                   OR attname ILIKE '%receiver%'
                   OR attname ILIKE '%sender%'
                   OR attname ILIKE '%consignee%'
                   OR attname ILIKE '%recipient%'
                   OR attname ILIKE '%postal%'
                   OR attname ILIKE '%zip%'
                   OR attname ILIKE '%buyer%'
                   OR attname ILIKE '%driver%'
                   OR attname ILIKE '%cookie%'
                   OR (
                       attname ILIKE '%token%'
                       AND attname <> 'source_version_token'
                   )
                   OR attname ILIKE '%secret%'
                   OR attname ILIKE '%password%'
                   OR attname ILIKE '%authorization%'
                   OR attname ILIKE '%credential%'
                   OR attname ILIKE '%session%'
                   OR attname ILIKE '%csrf%'
                   OR attname ILIKE '%header%'
                   OR attname ILIKE '%body%'
                   OR attname ILIKE '%url%'
                   OR attname ILIKE '%image%'
                   OR attname ILIKE '%thumb%'
                   OR attname ILIKE '%attachment%'
               )
        LOOP
            RAISE EXCEPTION 'v4 fact relation % exposes forbidden column %',
                relation_name, forbidden_column;
        END LOOP;
    END LOOP;

    -- The value-added-service contract carries no currency, so the amount
    -- fields of the verified allowlist must never become columns.
    IF EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'fact.full_webapi_value_added_service_observation'::regclass
          AND attnum > 0
          AND NOT attisdropped
          AND attname ILIKE '%amount%'
    ) THEN
        RAISE EXCEPTION
            'value-added-service fact columns must never carry currency-less amounts';
    END IF;

    -- Append-only triggers must exist on every typed fact table.
    FOREACH relation_name IN ARRAY ARRAY[
        'fact.full_webapi_stock_record_observation',
        'fact.full_webapi_waybill_observation',
        'fact.full_webapi_return_application_observation',
        'fact.full_webapi_return_order_observation',
        'fact.full_webapi_exception_observation',
        'fact.full_webapi_quality_report_observation',
        'fact.full_webapi_value_added_service_observation'
    ]
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM pg_trigger
            WHERE tgrelid = relation_name::regclass
              AND tgname LIKE 'trg_fact_full_webapi_%_append_only'
              AND NOT tgisinternal
        ) THEN
            RAISE EXCEPTION 'v4 fact relation % lacks its append-only trigger',
                relation_name;
        END IF;
    END LOOP;

    -- The database-enforced attempt binding guard and its per-table triggers
    -- must exist on every typed fact table: a direct loader INSERT must never
    -- bypass the store x endpoint match against the referenced attempt.
    IF to_regprocedure('ops.guard_v4_fact_attempt_binding()') IS NULL THEN
        RAISE EXCEPTION 'v4 fact attempt binding guard function is missing';
    END IF;
    FOREACH relation_name IN ARRAY ARRAY[
        'fact.full_webapi_stock_record_observation',
        'fact.full_webapi_waybill_observation',
        'fact.full_webapi_return_application_observation',
        'fact.full_webapi_return_order_observation',
        'fact.full_webapi_exception_observation',
        'fact.full_webapi_quality_report_observation',
        'fact.full_webapi_value_added_service_observation'
    ]
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM pg_trigger
            WHERE tgrelid = relation_name::regclass
              AND tgname LIKE 'trg_fact_full_webapi_%_attempt_binding'
              AND NOT tgisinternal
        ) THEN
            RAISE EXCEPTION 'v4 fact relation % lacks its attempt binding trigger',
                relation_name;
        END IF;
    END LOOP;

    -- Least privilege: loader appends only; app reads only.
    FOREACH relation_name IN ARRAY ARRAY[
        'fact.full_webapi_stock_record_observation',
        'fact.full_webapi_waybill_observation',
        'fact.full_webapi_return_application_observation',
        'fact.full_webapi_return_order_observation',
        'fact.full_webapi_exception_observation',
        'fact.full_webapi_quality_report_observation',
        'fact.full_webapi_value_added_service_observation'
    ]
    LOOP
        IF NOT has_table_privilege(
            'sheinfm_webapi_loader', relation_name, 'SELECT,INSERT'
        ) OR has_table_privilege(
            'sheinfm_webapi_loader', relation_name, 'UPDATE,DELETE,TRUNCATE'
        ) THEN
            RAISE EXCEPTION 'WebAPI loader fact boundary is invalid for %',
                relation_name;
        END IF;
        IF NOT has_table_privilege('sheinfm_app', relation_name, 'SELECT')
           OR has_table_privilege(
               'sheinfm_app', relation_name, 'INSERT,UPDATE,DELETE,TRUNCATE'
           ) THEN
            RAISE EXCEPTION 'sheinfm_app fact read-only boundary is invalid for %',
                relation_name;
        END IF;
    END LOOP;
END;
$$;

-- Negative and replay contract: a valid attempt + page evidence is created,
-- then the typed tables must enforce hashes, formats, values, the exact-replay
-- primary key and append-only behavior.
DO $$
DECLARE
    run_id bigint;
    attempt_id bigint;
    waybill_attempt_id bigint;
    return_application_attempt_id bigint;
    return_order_attempt_id bigint;
    exception_attempt_id bigint;
    quality_report_attempt_id bigint;
    vas_attempt_id bigint;
    page_evidence_id bigint;
    waybill_page_id bigint;
    return_application_page_id bigint;
    return_order_page_id bigint;
    exception_page_id bigint;
    quality_report_page_id bigint;
    vas_page_id bigint;
    rejected boolean;
    attempt_count integer;
BEGIN
    INSERT INTO ops.v4_collection_run (
        contract_version, run_key, plan_hash,
        expected_store_count, expected_endpoint_count,
        store_codes, endpoint_codes
    )
    VALUES (
        1, repeat('9', 64), repeat('1', 64),
        1, 7, ARRAY['DL5477'],
        ARRAY[
            'STOCK_RECORDS_LIST', 'WAYBILLS_PAGE',
            'RETURN_APPLICATIONS_LIST', 'RETURN_ORDERS_PAGE',
            'EXCEPTIONS_PAGE', 'QUALITY_REPORTS_PAGE',
            'VALUE_ADDED_SERVICES_PAGE'
        ]
    )
    RETURNING collection_run_id INTO run_id;
    UPDATE ops.v4_collection_run
       SET run_status = 'PREFLIGHT_PASSED'
     WHERE collection_run_id = run_id;
    UPDATE ops.v4_collection_run
       SET run_status = 'RUNNING', started_at = clock_timestamp()
     WHERE collection_run_id = run_id;
    INSERT INTO ops.v4_collection_attempt (
        collection_run_id, store_code, endpoint_code, attempt_key,
        request_schema_hash, request_fingerprint
    )
    VALUES (
        run_id, 'DL5477', 'STOCK_RECORDS_LIST', repeat('2', 64),
        repeat('3', 64), repeat('4', 64)
    )
    RETURNING collection_attempt_id INTO attempt_id;
    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'RUNNING', started_at = clock_timestamp()
     WHERE collection_attempt_id = attempt_id;
    INSERT INTO ops.v4_page_evidence AS inserted_page (
        collection_attempt_id, page_key, page_number, page_size,
        page_request_fingerprint, response_schema_hash, payload_hash,
        row_count, rejected_row_count, http_status, fetch_status,
        observed_at
    )
    VALUES (
        attempt_id, repeat('5', 64), 1, 100,
        repeat('4', 64), repeat('6', 64), repeat('7', 64),
        1, 0, 200, 'SUCCEEDED', clock_timestamp()
    )
    RETURNING inserted_page.page_evidence_id INTO page_evidence_id;

    INSERT INTO ops.v4_collection_attempt (
        collection_run_id, store_code, endpoint_code, attempt_key,
        request_schema_hash, request_fingerprint
    )
    VALUES (
        run_id, 'DL5477', 'WAYBILLS_PAGE', repeat('3', 64),
        repeat('5', 64), repeat('6', 64)
    )
    RETURNING collection_attempt_id INTO waybill_attempt_id;
    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'RUNNING', started_at = clock_timestamp()
     WHERE collection_attempt_id = waybill_attempt_id;
    INSERT INTO ops.v4_page_evidence AS inserted_page (
        collection_attempt_id, page_key, page_number, page_size,
        page_request_fingerprint, response_schema_hash, payload_hash,
        row_count, rejected_row_count, http_status, fetch_status,
        observed_at
    )
    VALUES (
        waybill_attempt_id, repeat('6', 64), 1, 100,
        repeat('6', 64), repeat('8', 64), repeat('9', 64),
        1, 0, 200, 'SUCCEEDED', clock_timestamp()
    )
    RETURNING inserted_page.page_evidence_id INTO waybill_page_id;

    INSERT INTO ops.v4_collection_attempt (
        collection_run_id, store_code, endpoint_code, attempt_key,
        request_schema_hash, request_fingerprint
    )
    VALUES (
        run_id, 'DL5477', 'RETURN_APPLICATIONS_LIST', repeat('4', 64),
        repeat('6', 64), repeat('7', 64)
    )
    RETURNING collection_attempt_id INTO return_application_attempt_id;
    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'RUNNING', started_at = clock_timestamp()
     WHERE collection_attempt_id = return_application_attempt_id;
    INSERT INTO ops.v4_page_evidence AS inserted_page (
        collection_attempt_id, page_key, page_number, page_size,
        page_request_fingerprint, response_schema_hash, payload_hash,
        row_count, rejected_row_count, http_status, fetch_status,
        observed_at
    )
    VALUES (
        return_application_attempt_id, repeat('7', 64), 1, 100,
        repeat('7', 64), repeat('9', 64), repeat('0', 64),
        1, 0, 200, 'SUCCEEDED', clock_timestamp()
    )
    RETURNING inserted_page.page_evidence_id INTO return_application_page_id;

    INSERT INTO ops.v4_collection_attempt (
        collection_run_id, store_code, endpoint_code, attempt_key,
        request_schema_hash, request_fingerprint
    )
    VALUES (
        run_id, 'DL5477', 'RETURN_ORDERS_PAGE', repeat('5', 64),
        repeat('7', 64), repeat('8', 64)
    )
    RETURNING collection_attempt_id INTO return_order_attempt_id;
    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'RUNNING', started_at = clock_timestamp()
     WHERE collection_attempt_id = return_order_attempt_id;
    INSERT INTO ops.v4_page_evidence AS inserted_page (
        collection_attempt_id, page_key, page_number, page_size,
        page_request_fingerprint, response_schema_hash, payload_hash,
        row_count, rejected_row_count, http_status, fetch_status,
        observed_at
    )
    VALUES (
        return_order_attempt_id, repeat('8', 64), 1, 100,
        repeat('8', 64), repeat('0', 64), repeat('1', 64),
        1, 0, 200, 'SUCCEEDED', clock_timestamp()
    )
    RETURNING inserted_page.page_evidence_id INTO return_order_page_id;

    INSERT INTO ops.v4_collection_attempt (
        collection_run_id, store_code, endpoint_code, attempt_key,
        request_schema_hash, request_fingerprint
    )
    VALUES (
        run_id, 'DL5477', 'EXCEPTIONS_PAGE', repeat('6', 64),
        repeat('8', 64), repeat('9', 64)
    )
    RETURNING collection_attempt_id INTO exception_attempt_id;
    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'RUNNING', started_at = clock_timestamp()
     WHERE collection_attempt_id = exception_attempt_id;
    INSERT INTO ops.v4_page_evidence AS inserted_page (
        collection_attempt_id, page_key, page_number, page_size,
        page_request_fingerprint, response_schema_hash, payload_hash,
        row_count, rejected_row_count, http_status, fetch_status,
        observed_at
    )
    VALUES (
        exception_attempt_id, repeat('9', 64), 1, 100,
        repeat('9', 64), repeat('1', 64), repeat('2', 64),
        1, 0, 200, 'SUCCEEDED', clock_timestamp()
    )
    RETURNING inserted_page.page_evidence_id INTO exception_page_id;

    INSERT INTO ops.v4_collection_attempt (
        collection_run_id, store_code, endpoint_code, attempt_key,
        request_schema_hash, request_fingerprint
    )
    VALUES (
        run_id, 'DL5477', 'QUALITY_REPORTS_PAGE', repeat('7', 64),
        repeat('9', 64), repeat('0', 64)
    )
    RETURNING collection_attempt_id INTO quality_report_attempt_id;
    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'RUNNING', started_at = clock_timestamp()
     WHERE collection_attempt_id = quality_report_attempt_id;
    INSERT INTO ops.v4_page_evidence AS inserted_page (
        collection_attempt_id, page_key, page_number, page_size,
        page_request_fingerprint, response_schema_hash, payload_hash,
        row_count, rejected_row_count, http_status, fetch_status,
        observed_at
    )
    VALUES (
        quality_report_attempt_id, repeat('0', 64), 1, 100,
        repeat('0', 64), repeat('2', 64), repeat('3', 64),
        1, 0, 200, 'SUCCEEDED', clock_timestamp()
    )
    RETURNING inserted_page.page_evidence_id INTO quality_report_page_id;

    INSERT INTO ops.v4_collection_attempt (
        collection_run_id, store_code, endpoint_code, attempt_key,
        request_schema_hash, request_fingerprint
    )
    VALUES (
        run_id, 'DL5477', 'VALUE_ADDED_SERVICES_PAGE', repeat('8', 64),
        repeat('0', 64), repeat('1', 64)
    )
    RETURNING collection_attempt_id INTO vas_attempt_id;
    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'RUNNING', started_at = clock_timestamp()
     WHERE collection_attempt_id = vas_attempt_id;
    INSERT INTO ops.v4_page_evidence AS inserted_page (
        collection_attempt_id, page_key, page_number, page_size,
        page_request_fingerprint, response_schema_hash, payload_hash,
        row_count, rejected_row_count, http_status, fetch_status,
        observed_at
    )
    VALUES (
        vas_attempt_id, repeat('1', 64), 1, 100,
        repeat('1', 64), repeat('3', 64), repeat('4', 64),
        1, 0, 200, 'SUCCEEDED', clock_timestamp()
    )
    RETURNING inserted_page.page_evidence_id INTO vas_page_id;

    -- Valid positive fixture per verified endpoint: every typed table accepts
    -- a row under an attempt of its own exact endpoint.
    INSERT INTO fact.full_webapi_stock_record_observation (
        store_code, entity_key_hash, source_version_token,
        source_attempt_id, source_page_evidence_id,
        observed_at, payload_hash, supplier_code, skc
    )
    VALUES (
        'DL5477', repeat('a', 64), 'v1',
        attempt_id, page_evidence_id,
        clock_timestamp(), repeat('b', 64), 'SUP-1', 'SKC-1'
    );
    INSERT INTO fact.full_webapi_waybill_observation (
        store_code, entity_key_hash, source_version_token,
        source_attempt_id, source_page_evidence_id,
        observed_at, payload_hash, logistics_company_code, pack_quantity
    )
    VALUES (
        'DL5477', repeat('b', 64), 'v1',
        waybill_attempt_id, waybill_page_id,
        clock_timestamp(), repeat('c', 64), 'LOG-1', 2
    );
    INSERT INTO fact.full_webapi_return_application_observation (
        store_code, entity_key_hash, source_version_token,
        source_attempt_id, source_page_evidence_id,
        observed_at, payload_hash, return_quantity
    )
    VALUES (
        'DL5477', repeat('c', 64), 'v1',
        return_application_attempt_id, return_application_page_id,
        clock_timestamp(), repeat('d', 64), 1
    );
    INSERT INTO fact.full_webapi_return_order_observation (
        store_code, entity_key_hash, source_version_token,
        source_attempt_id, source_page_evidence_id,
        observed_at, payload_hash, return_order_status
    )
    VALUES (
        'DL5477', repeat('d', 64), 'v1',
        return_order_attempt_id, return_order_page_id,
        clock_timestamp(), repeat('e', 64), 1
    );
    INSERT INTO fact.full_webapi_exception_observation (
        store_code, entity_key_hash, source_version_token,
        source_attempt_id, source_page_evidence_id,
        observed_at, payload_hash, category_code
    )
    VALUES (
        'DL5477', repeat('e', 64), 'v1',
        exception_attempt_id, exception_page_id,
        clock_timestamp(), repeat('f', 64), 'CAT-1'
    );
    INSERT INTO fact.full_webapi_quality_report_observation (
        store_code, entity_key_hash, source_version_token,
        source_attempt_id, source_page_evidence_id,
        observed_at, payload_hash, skc
    )
    VALUES (
        'DL5477', repeat('a', 64), 'v1',
        quality_report_attempt_id, quality_report_page_id,
        clock_timestamp(), repeat('b', 64), 'SKC-Q'
    );
    INSERT INTO fact.full_webapi_value_added_service_observation (
        store_code, entity_key_hash, source_version_token,
        source_attempt_id, source_page_evidence_id,
        observed_at, payload_hash, order_no_hash, skc_num
    )
    VALUES (
        'DL5477', repeat('f', 64), 'v1',
        vas_attempt_id, vas_page_id,
        clock_timestamp(), repeat('b', 64), repeat('c', 64), 2
    );

    -- A non-hex entity_key_hash must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO fact.full_webapi_stock_record_observation (
            store_code, entity_key_hash, source_version_token,
            source_attempt_id, source_page_evidence_id,
            observed_at, payload_hash, supplier_code, skc
        )
        VALUES (
            'DL5477', repeat('z', 64), 'v1',
            attempt_id, page_evidence_id,
            clock_timestamp(), repeat('8', 64), 'SUP-1', 'SKC-1'
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a non-hex entity_key_hash was accepted';
    END IF;

    -- A non-canonical store code must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO fact.full_webapi_stock_record_observation (
            store_code, entity_key_hash, source_version_token,
            source_attempt_id, source_page_evidence_id,
            observed_at, payload_hash
        )
        VALUES (
            'DL', repeat('8', 64), 'v1',
            attempt_id, page_evidence_id,
            clock_timestamp(), repeat('8', 64)
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a non-canonical store code was accepted';
    END IF;

    -- A bogus attempt id must be rejected by the foreign key.
    rejected := false;
    BEGIN
        INSERT INTO fact.full_webapi_stock_record_observation (
            store_code, entity_key_hash, source_version_token,
            source_attempt_id, source_page_evidence_id,
            observed_at, payload_hash
        )
        VALUES (
            'DL5477', repeat('8', 64), 'v1',
            999999, page_evidence_id,
            clock_timestamp(), repeat('8', 64)
        );
    EXCEPTION WHEN foreign_key_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a fact row with a bogus attempt id was accepted';
    END IF;

    -- Negative typed values must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO fact.full_webapi_return_application_observation (
            store_code, entity_key_hash, source_version_token,
            source_attempt_id, source_page_evidence_id,
            observed_at, payload_hash, return_quantity
        )
        VALUES (
            'DL5477', repeat('8', 64), 'v1',
            return_application_attempt_id, return_application_page_id,
            clock_timestamp(), repeat('8', 64), -1
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a negative return_quantity was accepted';
    END IF;

    -- A waybill flag outside 0/1 must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO fact.full_webapi_waybill_observation (
            store_code, entity_key_hash, source_version_token,
            source_attempt_id, source_page_evidence_id,
            observed_at, payload_hash, is_free
        )
        VALUES (
            'DL5477', repeat('8', 64), 'v1',
            waybill_attempt_id, waybill_page_id,
            clock_timestamp(), repeat('8', 64), 2
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a waybill flag outside 0/1 was accepted';
    END IF;

    -- A value-added-service flag outside 0/1 must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO fact.full_webapi_value_added_service_observation (
            store_code, entity_key_hash, source_version_token,
            source_attempt_id, source_page_evidence_id,
            observed_at, payload_hash, multi_part_flag
        )
        VALUES (
            'DL5477', repeat('8', 64), 'v1',
            vas_attempt_id, vas_page_id,
            clock_timestamp(), repeat('8', 64), 2
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a value-added-service flag outside 0/1 was accepted';
    END IF;

    -- A negative value-added-service count must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO fact.full_webapi_value_added_service_observation (
            store_code, entity_key_hash, source_version_token,
            source_attempt_id, source_page_evidence_id,
            observed_at, payload_hash, defective_quantity
        )
        VALUES (
            'DL5477', repeat('8', 64), 'v1',
            vas_attempt_id, vas_page_id,
            clock_timestamp(), repeat('8', 64), -1
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a negative value-added-service count was accepted';
    END IF;

    -- A non-hex value-added-service secondary number hash must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO fact.full_webapi_value_added_service_observation (
            store_code, entity_key_hash, source_version_token,
            source_attempt_id, source_page_evidence_id,
            observed_at, payload_hash, qc_inspection_no_hash
        )
        VALUES (
            'DL5477', repeat('8', 64), 'v1',
            vas_attempt_id, vas_page_id,
            clock_timestamp(), repeat('8', 64), repeat('z', 64)
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a non-hex value-added-service number hash was accepted';
    END IF;

    -- The database-enforced binding guard: a value-added-service fact may
    -- never cite a STOCK_RECORDS_LIST attempt, even with a matching store.
    rejected := false;
    BEGIN
        INSERT INTO fact.full_webapi_value_added_service_observation (
            store_code, entity_key_hash, source_version_token,
            source_attempt_id, source_page_evidence_id,
            observed_at, payload_hash
        )
        VALUES (
            'DL5477', repeat('1', 64), 'v1',
            attempt_id, page_evidence_id,
            clock_timestamp(), repeat('2', 64)
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a value-added-service fact was accepted under a STOCK_RECORDS_LIST attempt';
    END IF;

    -- A fact row whose store_code differs from its source attempt store must
    -- be rejected by the database, not only by the repository.
    rejected := false;
    BEGIN
        INSERT INTO fact.full_webapi_stock_record_observation (
            store_code, entity_key_hash, source_version_token,
            source_attempt_id, source_page_evidence_id,
            observed_at, payload_hash
        )
        VALUES (
            'MZ2406', repeat('1', 64), 'v1',
            attempt_id, page_evidence_id,
            clock_timestamp(), repeat('2', 64)
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a fact row with a store_code different from its source attempt was accepted';
    END IF;

    -- The endpoint binding also holds within one run: a stock-record fact may
    -- never cite an EXCEPTIONS_PAGE attempt of the same run.
    rejected := false;
    BEGIN
        INSERT INTO fact.full_webapi_stock_record_observation (
            store_code, entity_key_hash, source_version_token,
            source_attempt_id, source_page_evidence_id,
            observed_at, payload_hash
        )
        VALUES (
            'DL5477', repeat('2', 64), 'v1',
            exception_attempt_id, exception_page_id,
            clock_timestamp(), repeat('3', 64)
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a stock-record fact was accepted under an EXCEPTIONS_PAGE attempt';
    END IF;

    -- Exact replay: the same attempt x entity x version token cannot be
    -- duplicated, and a changed version token appends instead of overwriting.
    rejected := false;
    BEGIN
        INSERT INTO fact.full_webapi_stock_record_observation (
            store_code, entity_key_hash, source_version_token,
            source_attempt_id, source_page_evidence_id,
            observed_at, payload_hash, supplier_code, skc
        )
        VALUES (
            'DL5477', repeat('a', 64), 'v1',
            attempt_id, page_evidence_id,
            clock_timestamp(), repeat('b', 64), 'SUP-1', 'SKC-1'
        );
    EXCEPTION WHEN unique_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'an exact-replay duplicate fact row was accepted';
    END IF;
    INSERT INTO fact.full_webapi_stock_record_observation (
        store_code, entity_key_hash, source_version_token,
        source_attempt_id, source_page_evidence_id,
        observed_at, payload_hash, supplier_code, skc
    )
    VALUES (
        'DL5477', repeat('a', 64), 'v2',
        attempt_id, page_evidence_id,
        clock_timestamp(), repeat('c', 64), 'SUP-1', 'SKC-1'
    );
    SELECT count(*) INTO attempt_count
      FROM fact.full_webapi_stock_record_observation
     WHERE source_attempt_id = attempt_id
       AND entity_key_hash = repeat('a', 64);
    IF attempt_count <> 2 THEN
        RAISE EXCEPTION 'a changed source version must append, not replace';
    END IF;

    -- The value-added-service table enforces the same exact-replay contract.
    rejected := false;
    BEGIN
        INSERT INTO fact.full_webapi_value_added_service_observation (
            store_code, entity_key_hash, source_version_token,
            source_attempt_id, source_page_evidence_id,
            observed_at, payload_hash, order_no_hash, skc_num
        )
        VALUES (
            'DL5477', repeat('f', 64), 'v1',
            vas_attempt_id, vas_page_id,
            clock_timestamp(), repeat('b', 64), repeat('c', 64), 2
        );
    EXCEPTION WHEN unique_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'an exact-replay duplicate value-added-service row was accepted';
    END IF;

    -- Append-only: UPDATE and DELETE must be rejected by the trigger.
    rejected := false;
    BEGIN
        UPDATE fact.full_webapi_stock_record_observation
           SET supplier_code = 'SUP-2'
         WHERE source_attempt_id = attempt_id;
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'typed fact rows are not append-only';
    END IF;
    rejected := false;
    BEGIN
        DELETE FROM fact.full_webapi_stock_record_observation
         WHERE source_attempt_id = attempt_id;
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'typed fact rows accepted DELETE';
    END IF;
    rejected := false;
    BEGIN
        UPDATE fact.full_webapi_value_added_service_observation
           SET skc_num = 99
         WHERE source_attempt_id = vas_attempt_id;
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'value-added-service fact rows are not append-only';
    END IF;

    -- The page evidence pin is composite and database-enforced: a fact row
    -- must never cite page evidence produced by a different attempt, even
    -- when store and endpoint match.
    DECLARE
        other_run_id bigint;
        other_attempt_id bigint;
    BEGIN
        INSERT INTO ops.v4_collection_run (
            contract_version, run_key, plan_hash,
            expected_store_count, expected_endpoint_count,
            store_codes, endpoint_codes
        )
        VALUES (
            1, repeat('0', 64), repeat('3', 64),
            1, 1, ARRAY['DL5477'], ARRAY['STOCK_RECORDS_LIST']
        )
        RETURNING collection_run_id INTO other_run_id;
        UPDATE ops.v4_collection_run
           SET run_status = 'PREFLIGHT_PASSED'
         WHERE collection_run_id = other_run_id;
        UPDATE ops.v4_collection_run
           SET run_status = 'RUNNING', started_at = clock_timestamp()
         WHERE collection_run_id = other_run_id;
        INSERT INTO ops.v4_collection_attempt (
            collection_run_id, store_code, endpoint_code, attempt_key,
            request_schema_hash, request_fingerprint
        )
        VALUES (
            other_run_id, 'DL5477', 'STOCK_RECORDS_LIST', repeat('a', 64),
            repeat('b', 64), repeat('c', 64)
        )
        RETURNING collection_attempt_id INTO other_attempt_id;
        rejected := false;
        BEGIN
            INSERT INTO fact.full_webapi_stock_record_observation (
                store_code, entity_key_hash, source_version_token,
                source_attempt_id, source_page_evidence_id,
                observed_at, payload_hash
            )
            VALUES (
                'DL5477', repeat('d', 64), 'v1',
                other_attempt_id, page_evidence_id,
                clock_timestamp(), repeat('e', 64)
            );
        EXCEPTION WHEN foreign_key_violation THEN
            rejected := true;
        END;
        IF NOT rejected THEN
            RAISE EXCEPTION
                'a fact row cited page evidence from another attempt';
        END IF;
    END;
END;
$$;

ROLLBACK;
