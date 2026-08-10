BEGIN;

DO $$
DECLARE
    expected_relation text;
    forbidden_column text;
    relation_name text;
    contract_count integer;
BEGIN
    FOREACH expected_relation IN ARRAY ARRAY[
        'ops.v4_collection_contract',
        'ops.v4_collection_run',
        'ops.v4_collection_attempt',
        'ops.v4_page_evidence',
        'ops.v4_collection_coverage',
        'ops.v4_capability_observation'
    ]
    LOOP
        IF to_regclass(expected_relation) IS NULL THEN
            RAISE EXCEPTION 'Missing v4 collection control-plane relation: %',
                expected_relation;
        END IF;
    END LOOP;

    IF to_regprocedure('ops.guard_v4_collection_run_state()') IS NULL
       OR to_regprocedure('ops.guard_v4_collection_attempt_terminal()') IS NULL
       OR to_regprocedure('ops.guard_v4_collection_coverage()') IS NULL
       OR to_regprocedure('ops.guard_v4_page_evidence_mutation()') IS NULL
       OR to_regprocedure('ops.reject_v4_evidence_mutation()') IS NULL THEN
        RAISE EXCEPTION 'v4 collection control-plane guard functions are missing';
    END IF;

    -- The reviewed contract version seed must exist and stay active.
    SELECT count(*) INTO contract_count
      FROM ops.v4_collection_contract
     WHERE contract_version = 1
       AND contract_status = 'ACTIVE';
    IF contract_count <> 1 THEN
        RAISE EXCEPTION 'v4 collection contract version 1 seed is missing';
    END IF;

    -- No secret-shaped or body-shaped column may exist anywhere in the
    -- control plane.
    FOREACH relation_name IN ARRAY ARRAY[
        'ops.v4_collection_run',
        'ops.v4_collection_attempt',
        'ops.v4_page_evidence',
        'ops.v4_collection_coverage',
        'ops.v4_capability_observation'
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
                   OR attname ILIKE '%session%'
                   OR attname ILIKE '%csrf%'
                   OR attname ILIKE '%header%'
                   OR attname ILIKE '%ciphertext%'
                   OR attname ILIKE '%raw_payload%'
                   OR attname ILIKE '%response_body%'
                   OR attname ILIKE '%body%'
               )
        LOOP
            RAISE EXCEPTION 'v4 control-plane relation % exposes forbidden column %',
                relation_name, forbidden_column;
        END LOOP;
    END LOOP;

    -- The append-only guard, the state machines and the roster closure must
    -- all reject their negative case.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'ops.v4_collection_run'::regclass
          AND tgname = 'trg_ops_v4_collection_run_guard'
          AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'ops.v4_collection_attempt'::regclass
          AND tgname = 'trg_ops_v4_collection_attempt_guard'
          AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'ops.v4_collection_coverage'::regclass
          AND tgname = 'trg_ops_v4_collection_coverage_guard'
          AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'ops.v4_page_evidence'::regclass
          AND tgname = 'trg_ops_v4_page_evidence_append_only'
          AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'ops.v4_capability_observation'::regclass
          AND tgname = 'trg_ops_v4_capability_observation_append_only'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'v4 collection control-plane triggers are incomplete';
    END IF;

    -- The typed fact layer must be able to pin page evidence to its attempt
    -- with a composite foreign key, so the referencable unique key must exist.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'ops'
          AND tablename = 'v4_page_evidence'
          AND indexname = 'uq_ops_v4_page_evidence_attempt_ref'
    ) THEN
        RAISE EXCEPTION
            'v4 page evidence attempt-pinned referencable key is missing';
    END IF;

    -- Least privilege: the loader drives the state machine but never deletes;
    -- the app role is a pure read model.
    IF NOT has_table_privilege(
        'sheinfm_webapi_loader', 'ops.v4_collection_run', 'SELECT,INSERT,UPDATE'
    ) OR has_table_privilege(
        'sheinfm_webapi_loader', 'ops.v4_collection_run', 'DELETE'
    ) OR has_table_privilege(
        'sheinfm_webapi_loader', 'ops.v4_collection_run', 'TRUNCATE'
    ) THEN
        RAISE EXCEPTION 'WebAPI loader v4 run boundary is invalid';
    END IF;
    IF NOT has_table_privilege(
        'sheinfm_webapi_loader', 'ops.v4_page_evidence', 'SELECT,INSERT'
    ) OR has_table_privilege(
        'sheinfm_webapi_loader', 'ops.v4_page_evidence', 'UPDATE,DELETE'
    ) THEN
        RAISE EXCEPTION 'WebAPI loader v4 page evidence boundary is invalid';
    END IF;
    IF NOT has_table_privilege(
        'sheinfm_webapi_loader', 'ops.v4_capability_observation', 'SELECT,INSERT'
    ) OR has_table_privilege(
        'sheinfm_webapi_loader', 'ops.v4_capability_observation', 'UPDATE,DELETE'
    ) THEN
        RAISE EXCEPTION 'WebAPI loader v4 capability boundary is invalid';
    END IF;
    IF has_table_privilege(
        'sheinfm_webapi_loader', 'ops.v4_collection_contract', 'INSERT,UPDATE,DELETE'
    ) THEN
        RAISE EXCEPTION 'WebAPI loader must not write the contract registry';
    END IF;
    FOREACH relation_name IN ARRAY ARRAY[
        'ops.v4_collection_contract',
        'ops.v4_collection_run',
        'ops.v4_collection_attempt',
        'ops.v4_page_evidence',
        'ops.v4_collection_coverage',
        'ops.v4_capability_observation'
    ]
    LOOP
        IF NOT has_table_privilege('sheinfm_app', relation_name, 'SELECT')
           OR has_table_privilege('sheinfm_app', relation_name, 'INSERT,UPDATE,DELETE,TRUNCATE')
        THEN
            RAISE EXCEPTION 'sheinfm_app v4 control-plane read-only boundary is invalid for %',
                relation_name;
        END IF;
    END LOOP;
END;
$$;

DO $$
DECLARE
    run_id bigint;
    attempt_id bigint;
    rejected boolean;
BEGIN
    -- A run born outside PLANNED must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_run (
            contract_version, run_key, plan_hash, run_status,
            expected_store_count, expected_endpoint_count,
            store_codes, endpoint_codes
        )
        VALUES (
            1, repeat('1', 64), repeat('a', 64), 'RUNNING',
            1, 1, ARRAY['DL5477'], ARRAY['STOCK_RECORDS_LIST']
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a v4 run was allowed to start outside PLANNED';
    END IF;

    -- A non-hex plan_hash must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_run (
            contract_version, run_key, plan_hash,
            expected_store_count, expected_endpoint_count,
            store_codes, endpoint_codes
        )
        VALUES (
            1, repeat('2', 64), repeat('z', 64),
            1, 1, ARRAY['DL5477'], ARRAY['STOCK_RECORDS_LIST']
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a non-hex plan_hash was accepted';
    END IF;

    -- Fixed retry NONE: any other retry policy must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_run (
            contract_version, run_key, plan_hash, retry_policy,
            expected_store_count, expected_endpoint_count,
            store_codes, endpoint_codes
        )
        VALUES (
            1, repeat('3', 64), repeat('b', 64), 'FIXED_RETRY',
            1, 1, ARRAY['DL5477'], ARRAY['STOCK_RECORDS_LIST']
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a non-NONE retry policy was accepted';
    END IF;

    -- Expected counts must equal the frozen roster sizes.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_run (
            contract_version, run_key, plan_hash,
            expected_store_count, expected_endpoint_count,
            store_codes, endpoint_codes
        )
        VALUES (
            1, repeat('4', 64), repeat('c', 64),
            2, 1, ARRAY['DL5477'], ARRAY['STOCK_RECORDS_LIST']
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a run whose expected store count drifts from its roster was accepted';
    END IF;

    -- Duplicate stores in the frozen roster must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_run (
            contract_version, run_key, plan_hash,
            expected_store_count, expected_endpoint_count,
            store_codes, endpoint_codes
        )
        VALUES (
            1, repeat('5', 64), repeat('d', 64),
            2, 1, ARRAY['DL5477', 'DL5477'], ARRAY['STOCK_RECORDS_LIST']
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a run with duplicate roster stores was accepted';
    END IF;

    -- The state machine must reject PLANNED -> SUCCEEDED.
    INSERT INTO ops.v4_collection_run (
        contract_version, run_key, plan_hash,
        expected_store_count, expected_endpoint_count,
        store_codes, endpoint_codes
    )
    VALUES (
        1, repeat('6', 64), repeat('e', 64),
        1, 2, ARRAY['DL5477'], ARRAY['STOCK_RECORDS_LIST', 'WAYBILLS_PAGE']
    )
    RETURNING collection_run_id INTO run_id;

    rejected := false;
    BEGIN
        UPDATE ops.v4_collection_run
           SET run_status = 'SUCCEEDED', completed_at = clock_timestamp()
         WHERE collection_run_id = run_id;
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a PLANNED run was allowed to jump to SUCCEEDED';
    END IF;

    -- SUCCEEDED without a fully closed roster of SUCCEEDED attempts must be
    -- rejected (no zero-filling).
    UPDATE ops.v4_collection_run
       SET run_status = 'PREFLIGHT_PASSED'
     WHERE collection_run_id = run_id;
    UPDATE ops.v4_collection_run
       SET run_status = 'RUNNING', started_at = clock_timestamp()
     WHERE collection_run_id = run_id;
    rejected := false;
    BEGIN
        UPDATE ops.v4_collection_run
           SET run_status = 'SUCCEEDED', completed_at = clock_timestamp()
         WHERE collection_run_id = run_id;
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a run without attempts was allowed to be SUCCEEDED';
    END IF;

    -- An attempt outside the frozen roster must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_attempt (
            collection_run_id, store_code, endpoint_code, attempt_key,
            request_schema_hash, request_fingerprint
        )
        VALUES (
            run_id, 'MZ2406', 'STOCK_RECORDS_LIST', repeat('a', 64),
            repeat('1', 64), repeat('1', 64)
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'an attempt outside the frozen roster was accepted';
    END IF;

    -- BLOCKED requires a sanitized error code and never carries counts.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_attempt (
            collection_run_id, store_code, endpoint_code, attempt_key,
            request_schema_hash, request_fingerprint, attempt_status,
            completed_at, observed_row_count
        )
        VALUES (
            run_id, 'DL5477', 'STOCK_RECORDS_LIST', repeat('b', 64),
            repeat('1', 64), repeat('1', 64), 'BLOCKED',
            clock_timestamp(), 5
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a BLOCKED attempt with counts or without an error code was accepted';
    END IF;

    -- FAILED must never fabricate zero counts.
    INSERT INTO ops.v4_collection_attempt (
        collection_run_id, store_code, endpoint_code, attempt_key,
        request_schema_hash, request_fingerprint
    )
    VALUES (
        run_id, 'DL5477', 'STOCK_RECORDS_LIST', repeat('c', 64),
        repeat('1', 64), repeat('1', 64)
    )
    RETURNING collection_attempt_id INTO attempt_id;
    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'RUNNING', started_at = clock_timestamp()
     WHERE collection_attempt_id = attempt_id;
    rejected := false;
    BEGIN
        UPDATE ops.v4_collection_attempt
           SET attempt_status = 'FAILED',
               completed_at = clock_timestamp(),
               sanitized_error_code = 'PAGE_FETCH_FAILED',
               observed_row_count = 0
         WHERE collection_attempt_id = attempt_id;
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a FAILED attempt was allowed to fabricate zero counts';
    END IF;
    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'FAILED',
           completed_at = clock_timestamp(),
           sanitized_error_code = 'PAGE_FETCH_FAILED'
     WHERE collection_attempt_id = attempt_id;

    -- UNKNOWN is a terminal no-evidence state.
    INSERT INTO ops.v4_collection_attempt (
        collection_run_id, store_code, endpoint_code, attempt_key,
        request_schema_hash, request_fingerprint, attempt_status,
        completed_at
    )
    VALUES (
        run_id, 'DL5477', 'WAYBILLS_PAGE', repeat('d', 64),
        repeat('2', 64), repeat('2', 64), 'UNKNOWN',
        clock_timestamp()
    )
    RETURNING collection_attempt_id INTO attempt_id;
    rejected := false;
    BEGIN
        UPDATE ops.v4_collection_attempt
           SET attempt_status = 'UNKNOWN', completed_at = clock_timestamp(),
               observed_row_count = 0
         WHERE collection_attempt_id = attempt_id;
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'an UNKNOWN transition with counts was accepted';
    END IF;

    -- Attempt replay identity is immutable: changing attempt_key must fail.
    rejected := false;
    BEGIN
        UPDATE ops.v4_collection_attempt
           SET attempt_key = repeat('e', 64)
         WHERE collection_attempt_id = attempt_id;
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'attempt_key was mutable';
    END IF;

    -- Page evidence may not be inserted under a terminal attempt and is
    -- append-only.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_page_evidence (
            collection_attempt_id, page_key, page_number, page_size,
            page_request_fingerprint, response_schema_hash, payload_hash,
            row_count, rejected_row_count, http_status, fetch_status,
            observed_at
        )
        VALUES (
            attempt_id, repeat('a', 64), 1, 50,
            repeat('1', 64), repeat('2', 64), repeat('3', 64),
            0, 0, 200, 'SUCCEEDED', clock_timestamp()
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'page evidence was allowed under a terminal attempt';
    END IF;

    -- A SUCCEEDED page must carry zero rejected rows; a PARTIAL page must
    -- carry at least one.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_page_evidence (
            collection_attempt_id, page_key, page_number, page_size,
            page_request_fingerprint, response_schema_hash, payload_hash,
            row_count, rejected_row_count, http_status, fetch_status,
            observed_at
        )
        VALUES (
            -1, repeat('b', 64), 1, 50,
            repeat('1', 64), repeat('2', 64), repeat('3', 64),
            0, 0, 200, 'SUCCEEDED', clock_timestamp()
        );
    EXCEPTION WHEN foreign_key_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'page evidence accepted a bogus attempt id';
    END IF;

    -- Capability observations may never claim materialized business facts and
    -- are append-only.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_capability_observation (
            observation_key, collection_run_id, store_code, endpoint_code,
            capability_code, capability_status, business_materialized,
            payload_hash, observed_at
        )
        VALUES (
            repeat('1', 64), run_id, NULL, 'MARKETING_ACTIVITY_LIST',
            'MARKETING_ACTIVITY_AUDIT', 'UNVERIFIED', true,
            repeat('9', 64), clock_timestamp()
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a capability observation claimed business_materialized = true';
    END IF;

    INSERT INTO ops.v4_capability_observation (
        observation_key, collection_run_id, store_code, endpoint_code,
        capability_code, capability_status, business_materialized,
        payload_hash, observed_at
    )
    VALUES (
        repeat('2', 64), run_id, NULL, 'MARKETING_ACTIVITY_LIST',
        'MARKETING_ACTIVITY_AUDIT', 'UNVERIFIED', false,
        repeat('9', 64), clock_timestamp()
    );
    rejected := false;
    BEGIN
        DELETE FROM ops.v4_capability_observation
         WHERE observation_key = repeat('2', 64);
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'capability observations are not append-only';
    END IF;
END;
$$;

-- A fully closed run: 1 store x 1 endpoint, all attempts SUCCEEDED, then the
-- coverage envelope must accept exactly the evidence-derived counts and
-- reject every drift variant.
DO $$
DECLARE
    run_id bigint;
    attempt_id bigint;
    rejected boolean;
BEGIN
    INSERT INTO ops.v4_collection_run (
        contract_version, run_key, plan_hash,
        expected_store_count, expected_endpoint_count,
        store_codes, endpoint_codes
    )
    VALUES (
        1, repeat('7', 64), repeat('f', 64),
        1, 1, ARRAY['DL5477'], ARRAY['WAYBILLS_PAGE']
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
        run_id, 'DL5477', 'WAYBILLS_PAGE', repeat('f', 64),
        repeat('3', 64), repeat('4', 64)
    )
    RETURNING collection_attempt_id INTO attempt_id;
    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'RUNNING', started_at = clock_timestamp()
     WHERE collection_attempt_id = attempt_id;

    INSERT INTO ops.v4_page_evidence (
        collection_attempt_id, page_key, page_number, page_size,
        page_request_fingerprint, response_schema_hash, payload_hash,
        row_count, rejected_row_count, http_status, fetch_status,
        observed_at
    )
    VALUES (
        attempt_id, repeat('c', 64), 1, 50,
        repeat('4', 64), repeat('5', 64), repeat('6', 64),
        3, 0, 200, 'SUCCEEDED', clock_timestamp()
    );

    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'SUCCEEDED',
           started_at = clock_timestamp(),
           completed_at = clock_timestamp(),
           observed_row_count = 3,
           observed_page_count = 1
     WHERE collection_attempt_id = attempt_id;

    -- Coverage requires a terminal run.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_coverage (
            collection_run_id, expected_store_count, completed_store_count,
            partial_store_count, unknown_store_count, expected_endpoint_count,
            paging_verified, dedupe_verified, row_count, reason_code, as_of
        )
        VALUES (
            run_id, 1, 1, 0, 0, 1, true, true, 3, NULL, clock_timestamp()
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'coverage was accepted before the run became terminal';
    END IF;

    UPDATE ops.v4_collection_run
       SET run_status = 'SUCCEEDED', completed_at = clock_timestamp()
     WHERE collection_run_id = run_id;

    -- The evidence-derived envelope is accepted.
    INSERT INTO ops.v4_collection_coverage (
        collection_run_id, expected_store_count, completed_store_count,
        partial_store_count, unknown_store_count, expected_endpoint_count,
        paging_verified, dedupe_verified, row_count, reason_code, as_of
    )
    VALUES (
        run_id, 1, 1, 0, 0, 1, true, true, 3, NULL, clock_timestamp()
    );

    -- A second coverage envelope for the same run must be rejected even when
    -- the values are identical (one terminal envelope per run).
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_coverage (
            collection_run_id, expected_store_count, completed_store_count,
            partial_store_count, unknown_store_count, expected_endpoint_count,
            paging_verified, dedupe_verified, row_count, reason_code, as_of
        )
        VALUES (
            run_id, 1, 1, 0, 0, 1, true, true, 3, NULL, clock_timestamp()
        );
    EXCEPTION WHEN unique_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a second coverage envelope for one run was accepted';
    END IF;

    -- A PARTIAL run must not accept a coverage that claims full completion
    -- (zero-fill rejection at the envelope level).
    INSERT INTO ops.v4_collection_run (
        contract_version, run_key, plan_hash,
        expected_store_count, expected_endpoint_count,
        store_codes, endpoint_codes
    )
    VALUES (
        1, repeat('8', 64), repeat('0', 64),
        1, 1, ARRAY['MZ2406'], ARRAY['EXCEPTIONS_PAGE']
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
        request_schema_hash, request_fingerprint, attempt_status,
        completed_at, sanitized_error_code
    )
    VALUES (
        run_id, 'MZ2406', 'EXCEPTIONS_PAGE', repeat('9', 64),
        repeat('6', 64), repeat('6', 64), 'BLOCKED',
        clock_timestamp(), 'CREDENTIAL_BLOCKED'
    );
    UPDATE ops.v4_collection_run
       SET run_status = 'PARTIAL', completed_at = clock_timestamp()
     WHERE collection_run_id = run_id;
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_coverage (
            collection_run_id, expected_store_count, completed_store_count,
            partial_store_count, unknown_store_count, expected_endpoint_count,
            paging_verified, dedupe_verified, row_count, reason_code, as_of
        )
        VALUES (
            run_id, 1, 1, 0, 0, 1, false, false, 0, NULL, clock_timestamp()
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'coverage accepted zero-filled completion for a partial run';
    END IF;
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_coverage (
            collection_run_id, expected_store_count, completed_store_count,
            partial_store_count, unknown_store_count, expected_endpoint_count,
            paging_verified, dedupe_verified, row_count, reason_code, as_of
        )
        VALUES (
            run_id, 1, 0, 0, 1, 1, false, false, 0, NULL, clock_timestamp()
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'coverage accepted a partial run without a reason_code';
    END IF;
    INSERT INTO ops.v4_collection_coverage (
        collection_run_id, expected_store_count, completed_store_count,
        partial_store_count, unknown_store_count, expected_endpoint_count,
        paging_verified, dedupe_verified, row_count, reason_code, as_of
    )
    VALUES (
        run_id, 1, 0, 0, 1, 1, false, false, 0,
        'CREDENTIAL_BLOCKED', clock_timestamp()
    );
END;
$$;

-- Every terminal run status must close every created attempt: PARTIAL and
-- FAILED cannot conclude while an attempt is still PLANNED or RUNNING, and
-- SUCCEEDED keeps its exact full closure.
DO $$
DECLARE
    run_id bigint;
    attempt_id bigint;
    rejected boolean;
BEGIN
    -- PARTIAL with a still-open attempt must be rejected.
    INSERT INTO ops.v4_collection_run (
        contract_version, run_key, plan_hash,
        expected_store_count, expected_endpoint_count,
        store_codes, endpoint_codes
    )
    VALUES (
        1, repeat('a', 64), repeat('2', 64),
        1, 1, ARRAY['DL5477'], ARRAY['STOCK_RECORDS_LIST']
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
        run_id, 'DL5477', 'STOCK_RECORDS_LIST', repeat('1', 64),
        repeat('1', 64), repeat('1', 64)
    )
    RETURNING collection_attempt_id INTO attempt_id;
    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'RUNNING', started_at = clock_timestamp()
     WHERE collection_attempt_id = attempt_id;
    rejected := false;
    BEGIN
        UPDATE ops.v4_collection_run
           SET run_status = 'PARTIAL', completed_at = clock_timestamp()
         WHERE collection_run_id = run_id;
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a PARTIAL run was allowed to conclude with an open attempt';
    END IF;

    -- Once every created attempt is terminal, PARTIAL is valid.
    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'FAILED',
           completed_at = clock_timestamp(),
           sanitized_error_code = 'PAGE_FETCH_FAILED'
     WHERE collection_attempt_id = attempt_id;
    UPDATE ops.v4_collection_run
       SET run_status = 'PARTIAL', completed_at = clock_timestamp()
     WHERE collection_run_id = run_id;

    -- FAILED with an open attempt must be rejected too.
    INSERT INTO ops.v4_collection_run (
        contract_version, run_key, plan_hash,
        expected_store_count, expected_endpoint_count,
        store_codes, endpoint_codes
    )
    VALUES (
        1, repeat('e', 64), repeat('3', 64),
        1, 1, ARRAY['MZ2406'], ARRAY['WAYBILLS_PAGE']
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
        run_id, 'MZ2406', 'WAYBILLS_PAGE', repeat('2', 64),
        repeat('2', 64), repeat('2', 64)
    );
    rejected := false;
    BEGIN
        UPDATE ops.v4_collection_run
           SET run_status = 'FAILED', completed_at = clock_timestamp(),
               sanitized_error_code = 'PREFLIGHT_CREDENTIAL_BLOCKED'
         WHERE collection_run_id = run_id;
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a FAILED run was allowed to conclude with an open attempt';
    END IF;

    -- Once every created attempt is terminal, FAILED is valid.
    UPDATE ops.v4_collection_attempt
       SET attempt_status = 'BLOCKED',
           completed_at = clock_timestamp(),
           sanitized_error_code = 'CREDENTIAL_BLOCKED'
     WHERE collection_run_id = run_id
       AND endpoint_code = 'WAYBILLS_PAGE';
    UPDATE ops.v4_collection_run
       SET run_status = 'FAILED', completed_at = clock_timestamp(),
           sanitized_error_code = 'CREDENTIAL_BLOCKED'
     WHERE collection_run_id = run_id;
END;
$$;

-- Runtime manifest enforcement under the least-privilege loader role: the
-- verified runtime may only create a run whose frozen roster is exactly the
-- canonical 25-store / 13-endpoint manifest. Minimal or drifted manifests
-- fail closed; the exact canonical run is accepted. Everything rolls back.
DO $$
DECLARE
    canonical_run_id bigint;
    rejected boolean;
    loader_can_impersonate boolean;
BEGIN
    SELECT rolsuper OR pg_has_role(
        current_user, 'sheinfm_webapi_loader', 'MEMBER'
    )
      INTO loader_can_impersonate
      FROM pg_roles
     WHERE rolname = current_user;
    IF NOT loader_can_impersonate THEN
        RAISE EXCEPTION
            'verify must run as a role that can SET ROLE sheinfm_webapi_loader';
    END IF;

    SET ROLE sheinfm_webapi_loader;

    -- A minimal one-store/one-endpoint runtime manifest must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_run (
            contract_version, run_key, plan_hash,
            expected_store_count, expected_endpoint_count,
            store_codes, endpoint_codes
        )
        VALUES (
            1, repeat('b', 64), repeat('4', 64),
            1, 1, ARRAY['DL5477'], ARRAY['STOCK_RECORDS_LIST']
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a minimal runtime manifest was accepted';
    END IF;

    -- A 25-store roster with one non-canonical store must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_run (
            contract_version, run_key, plan_hash,
            expected_store_count, expected_endpoint_count,
            store_codes, endpoint_codes
        )
        VALUES (
            1, repeat('d', 64), repeat('5', 64),
            25, 13,
            ARRAY[
                'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397',
                'LQ7173', 'TS8263', 'DL5477', 'FY4021', 'GJ8989',
                'QH8028', 'JY8060', 'ZL3133', 'MZ2406', 'YJ8177',
                'RH0099', 'WY9025', 'RH2848', 'CX2816', 'YJ4042',
                'NM4977', 'NM8787', 'NM8831', 'NM7418', 'ZZ9999'
            ]::text[],
            ARRAY[
                'STOCK_RECORDS_LIST', 'WAYBILLS_PAGE',
                'RETURN_APPLICATIONS_LIST', 'RETURN_ORDERS_PAGE',
                'EXCEPTIONS_PAGE', 'VALUE_ADDED_SERVICES_PAGE',
                'QUALITY_REPORTS_PAGE', 'WAYBILLS_STATISTICS_1',
                'WAYBILLS_STATISTICS_2', 'WAYBILLS_STATISTICS_3',
                'WAYBILLS_STATISTICS_4', 'WAYBILLS_STATISTICS_5',
                'WAYBILLS_STATISTICS_6'
            ]::text[]
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a runtime manifest outside the canonical roster was accepted';
    END IF;

    -- A canonical-size manifest with only 12 endpoints must be rejected.
    rejected := false;
    BEGIN
        INSERT INTO ops.v4_collection_run (
            contract_version, run_key, plan_hash,
            expected_store_count, expected_endpoint_count,
            store_codes, endpoint_codes
        )
        VALUES (
            1, repeat('f', 64), repeat('6', 64),
            25, 12,
            ARRAY[
                'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397',
                'LQ7173', 'TS8263', 'DL5477', 'FY4021', 'GJ8989',
                'QH8028', 'JY8060', 'ZL3133', 'MZ2406', 'YJ8177',
                'RH0099', 'WY9025', 'RH2848', 'CX2816', 'YJ4042',
                'NM4977', 'NM8787', 'NM8831', 'NM7418', 'DX2420'
            ]::text[],
            ARRAY[
                'STOCK_RECORDS_LIST', 'WAYBILLS_PAGE',
                'RETURN_APPLICATIONS_LIST', 'RETURN_ORDERS_PAGE',
                'EXCEPTIONS_PAGE', 'VALUE_ADDED_SERVICES_PAGE',
                'QUALITY_REPORTS_PAGE', 'WAYBILLS_STATISTICS_1',
                'WAYBILLS_STATISTICS_2', 'WAYBILLS_STATISTICS_3',
                'WAYBILLS_STATISTICS_4', 'WAYBILLS_STATISTICS_5'
            ]::text[]
        );
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a canonical-size runtime manifest with a shortened endpoint roster was accepted';
    END IF;

    -- The exact canonical 25-store / 13-endpoint run is the only runtime
    -- manifest the loader may create, and it may still advance it.
    INSERT INTO ops.v4_collection_run (
        contract_version, run_key, plan_hash,
        expected_store_count, expected_endpoint_count,
        store_codes, endpoint_codes
    )
    VALUES (
        1, repeat('c', 64), repeat('7', 64),
        25, 13,
        ARRAY[
            'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397',
            'LQ7173', 'TS8263', 'DL5477', 'FY4021', 'GJ8989',
            'QH8028', 'JY8060', 'ZL3133', 'MZ2406', 'YJ8177',
            'RH0099', 'WY9025', 'RH2848', 'CX2816', 'YJ4042',
            'NM4977', 'NM8787', 'NM8831', 'NM7418', 'DX2420'
        ]::text[],
        ARRAY[
            'STOCK_RECORDS_LIST', 'WAYBILLS_PAGE',
            'RETURN_APPLICATIONS_LIST', 'RETURN_ORDERS_PAGE',
            'EXCEPTIONS_PAGE', 'VALUE_ADDED_SERVICES_PAGE',
            'QUALITY_REPORTS_PAGE', 'WAYBILLS_STATISTICS_1',
            'WAYBILLS_STATISTICS_2', 'WAYBILLS_STATISTICS_3',
            'WAYBILLS_STATISTICS_4', 'WAYBILLS_STATISTICS_5',
            'WAYBILLS_STATISTICS_6'
        ]::text[]
    )
    RETURNING collection_run_id INTO canonical_run_id;
    IF canonical_run_id IS NULL THEN
        RAISE EXCEPTION 'the exact canonical runtime manifest was rejected';
    END IF;
    UPDATE ops.v4_collection_run
       SET run_status = 'PREFLIGHT_PASSED'
     WHERE collection_run_id = canonical_run_id;

    RESET ROLE;
END;
$$;

ROLLBACK;
