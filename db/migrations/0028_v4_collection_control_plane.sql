BEGIN;

-- ---------------------------------------------------------------------------
-- Full-managed v4 WebAPI collection control plane.
--
-- The control plane is generic: it owns collection runs, per-store/per-endpoint
-- attempts, page evidence metadata, the per-run coverage envelope and
-- capability observations. It never stores a business fact: every fact domain
-- writes through its own typed append-only observation table (0029).
--
-- Run statuses are PLANNED / PREFLIGHT_PASSED / RUNNING / SUCCEEDED / PARTIAL /
-- FAILED / ABORTED. Attempt statuses add the terminal preflight outcomes
-- BLOCKED and UNKNOWN. Fixed retry is NONE: one attempt row per
-- run x store x endpoint, forever.
--
-- Contract v1 is deliberately narrow: exactly the canonical 25-store roster
-- and exactly 13 one-window work items (7 paged business endpoints plus the 6
-- WAYBILLS_STATISTICS variants). Both ordered arrays are enforced below, so a
-- caller cannot shrink the plan to one store/endpoint and still obtain a
-- database-valid SUCCEEDED run. The database never invents a zero or success.
-- ---------------------------------------------------------------------------

-- Reviewed contract version registry. Runs pin the contract version that
-- defined their plan so an old run can never be replayed under a newer
-- contract silently.
CREATE TABLE IF NOT EXISTS ops.v4_collection_contract (
    contract_version integer NOT NULL,
    contract_name text NOT NULL,
    contract_status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_ops_v4_collection_contract
        PRIMARY KEY (contract_version),
    CONSTRAINT ck_ops_v4_collection_contract_version
        CHECK (contract_version >= 1),
    CONSTRAINT ck_ops_v4_collection_contract_name
        CHECK (
            contract_name ~ '^[a-z][a-z0-9-]{2,63}$'
        ),
    CONSTRAINT ck_ops_v4_collection_contract_status
        CHECK (contract_status IN ('ACTIVE', 'SUPERSEDED'))
);

COMMENT ON TABLE ops.v4_collection_contract IS
    'Version registry for the full-managed v4 collection contract. A run pins the contract version that defined its plan.';

INSERT INTO ops.v4_collection_contract (contract_version, contract_name)
VALUES (1, 'full-managed-v4-collection')
ON CONFLICT (contract_version) DO NOTHING;

CREATE TABLE IF NOT EXISTS ops.v4_collection_run (
    collection_run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    contract_version integer NOT NULL,
    -- Caller-owned idempotency key. A replay must present the same run_key with
    -- a byte-identical plan or the transaction fails closed.
    run_key character(64) NOT NULL,
    plan_hash character(64) NOT NULL,
    run_status text NOT NULL DEFAULT 'PLANNED',
    retry_policy text NOT NULL DEFAULT 'NONE',
    expected_store_count integer NOT NULL,
    expected_endpoint_count integer NOT NULL,
    -- Frozen contract-v1 roster/work-item manifest. Runtime loader writes must
    -- match the exact reviewed arrays; success closes against these rows.
    store_codes text[] NOT NULL,
    endpoint_codes text[] NOT NULL,
    -- Collection window for windowed endpoints. Once-only endpoints ignore it,
    -- so the pair is nullable but must stay internally consistent.
    window_start date,
    window_end date,
    started_at timestamptz,
    completed_at timestamptz,
    sanitized_error_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_ops_v4_collection_run_contract
        FOREIGN KEY (contract_version)
        REFERENCES ops.v4_collection_contract (contract_version)
        ON DELETE RESTRICT,
    CONSTRAINT uq_ops_v4_collection_run_key
        UNIQUE (run_key),
    CONSTRAINT ck_ops_v4_collection_run_hashes
        CHECK (
            run_key ~ '^[0-9a-f]{64}$'
            AND plan_hash ~ '^[0-9a-f]{64}$'
        ),
    CONSTRAINT ck_ops_v4_collection_run_status
        CHECK (
            run_status IN (
                'PLANNED', 'PREFLIGHT_PASSED', 'RUNNING',
                'SUCCEEDED', 'PARTIAL', 'FAILED', 'ABORTED'
            )
        ),
    -- Fixed retry NONE: a replay continues the same run instead of spawning a
    -- second attempt row for the same store x endpoint.
    CONSTRAINT ck_ops_v4_collection_run_retry
        CHECK (retry_policy = 'NONE'),
    CONSTRAINT ck_ops_v4_collection_run_expected_counts
        CHECK (
            expected_store_count BETWEEN 1 AND 200
            AND expected_endpoint_count BETWEEN 1 AND 200
        ),
    CONSTRAINT ck_ops_v4_collection_run_window
        CHECK (
            (window_start IS NULL AND window_end IS NULL)
            OR (
                window_start IS NOT NULL
                AND window_end IS NOT NULL
                AND window_start <= window_end
                AND window_end - window_start <= 30
            )
        ),
    CONSTRAINT ck_ops_v4_collection_run_error_code
        CHECK (
            sanitized_error_code IS NULL
            OR sanitized_error_code ~ '^[A-Z][A-Z0-9_]{2,80}$'
        ),
    CONSTRAINT ck_ops_v4_collection_run_timeline
        CHECK (
            (started_at IS NULL OR started_at >= created_at)
            AND (
                completed_at IS NULL
                OR (started_at IS NOT NULL AND completed_at >= started_at)
            )
        )
);

CREATE INDEX IF NOT EXISTS ix_ops_v4_collection_run_status
    ON ops.v4_collection_run (run_status, created_at DESC);

COMMENT ON TABLE ops.v4_collection_run IS
    'One exact plan per run. plan_hash covers the frozen roster, endpoint set, window and contract version; run_key is the caller-owned idempotency key. The state machine and roster closure are enforced by ops.guard_v4_collection_run_state().';

-- ---------------------------------------------------------------------------
-- Run state machine, roster guard and immutable-plan guard.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.guard_v4_collection_run_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    roster_store text;
    roster_endpoint text;
    total_attempts integer;
    non_succeeded_attempts integer;
BEGIN
    -- Frozen roster and window are immutable for the whole run lifecycle.
    IF TG_OP = 'UPDATE' THEN
        IF NEW.run_key <> OLD.run_key
           OR NEW.plan_hash <> OLD.plan_hash
           OR NEW.contract_version <> OLD.contract_version
           OR NEW.retry_policy <> OLD.retry_policy
           OR NEW.expected_store_count <> OLD.expected_store_count
           OR NEW.expected_endpoint_count <> OLD.expected_endpoint_count
           OR NEW.store_codes <> OLD.store_codes
           OR NEW.endpoint_codes <> OLD.endpoint_codes
           OR NEW.window_start IS DISTINCT FROM OLD.window_start
           OR NEW.window_end IS DISTINCT FROM OLD.window_end
           OR NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION
                'v4 collection run plan is immutable'
                USING ERRCODE = '42501';
        END IF;

        -- Strict one-way state machine.
        IF NOT (
            (OLD.run_status = 'PLANNED' AND NEW.run_status IN (
                'PREFLIGHT_PASSED', 'FAILED', 'ABORTED'
            ))
            OR (OLD.run_status = 'PREFLIGHT_PASSED' AND NEW.run_status IN (
                'RUNNING', 'FAILED', 'ABORTED'
            ))
            OR (OLD.run_status = 'RUNNING' AND NEW.run_status IN (
                'SUCCEEDED', 'PARTIAL', 'FAILED', 'ABORTED'
            ))
        ) THEN
            RAISE EXCEPTION
                'invalid v4 collection run transition % -> %',
                OLD.run_status, NEW.run_status
                USING ERRCODE = '23514';
        END IF;
    ELSE
        -- A run is born PLANNED only; every later state is a reviewed step.
        IF NEW.run_status <> 'PLANNED' THEN
            RAISE EXCEPTION
                'v4 collection run must start as PLANNED'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
            RAISE EXCEPTION
                'v4 collection run timeline starts empty'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    -- Roster closure: arrays must be internally consistent and exactly equal
    -- the reviewed contract-v1 store/work-item manifest.
    IF NEW.expected_store_count <> cardinality(NEW.store_codes)
       OR NEW.expected_endpoint_count <> cardinality(NEW.endpoint_codes) THEN
        RAISE EXCEPTION
            'v4 collection run expected counts must equal the frozen roster sizes'
            USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(DISTINCT code) FROM unnest(NEW.store_codes) AS code)
       <> cardinality(NEW.store_codes) THEN
        RAISE EXCEPTION
            'v4 collection run store roster contains duplicates'
            USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(DISTINCT code) FROM unnest(NEW.endpoint_codes) AS code)
       <> cardinality(NEW.endpoint_codes) THEN
        RAISE EXCEPTION
            'v4 collection run endpoint roster contains duplicates'
            USING ERRCODE = '23514';
    END IF;
    -- Runtime writes always SET LOCAL ROLE sheinfm_webapi_loader. Enforce the
    -- exact production manifest for that least-privilege principal; the
    -- trusted migration superuser may still use minimal fixtures in the
    -- transaction-rolled-back verify script to exercise the state machine.
    IF current_user = 'sheinfm_webapi_loader'
       AND (NEW.store_codes <> ARRAY[
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397',
        'LQ7173', 'TS8263', 'DL5477', 'FY4021', 'GJ8989',
        'QH8028', 'JY8060', 'ZL3133', 'MZ2406', 'YJ8177',
        'RH0099', 'WY9025', 'RH2848', 'CX2816', 'YJ4042',
        'NM4977', 'NM8787', 'NM8831', 'NM7418', 'DX2420'
    ]::text[]
       OR NEW.expected_store_count <> 25) THEN
        RAISE EXCEPTION
            'v4 collection run must use the canonical 25-store roster'
            USING ERRCODE = '23514';
    END IF;
    IF current_user = 'sheinfm_webapi_loader'
       AND (NEW.endpoint_codes <> ARRAY[
        'STOCK_RECORDS_LIST',
        'WAYBILLS_PAGE',
        'RETURN_APPLICATIONS_LIST',
        'RETURN_ORDERS_PAGE',
        'EXCEPTIONS_PAGE',
        'VALUE_ADDED_SERVICES_PAGE',
        'QUALITY_REPORTS_PAGE',
        'WAYBILLS_STATISTICS_1',
        'WAYBILLS_STATISTICS_2',
        'WAYBILLS_STATISTICS_3',
        'WAYBILLS_STATISTICS_4',
        'WAYBILLS_STATISTICS_5',
        'WAYBILLS_STATISTICS_6'
    ]::text[]
       OR NEW.expected_endpoint_count <> 13) THEN
        RAISE EXCEPTION
            'v4 collection run must use the 13-item contract manifest'
            USING ERRCODE = '23514';
    END IF;
    FOREACH roster_store IN ARRAY NEW.store_codes LOOP
        IF roster_store !~ '^[A-Z]{2}[0-9]{4}$' THEN
            RAISE EXCEPTION
                'v4 collection run store code has invalid format'
                USING ERRCODE = '23514';
        END IF;
    END LOOP;
    FOREACH roster_endpoint IN ARRAY NEW.endpoint_codes LOOP
        IF roster_endpoint !~ '^[A-Z][A-Z0-9_]{2,60}$' THEN
            RAISE EXCEPTION
                'v4 collection run endpoint code has invalid format'
                USING ERRCODE = '23514';
        END IF;
    END LOOP;

    -- Timeline shape for the requested status.
    IF NEW.run_status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL') THEN
        IF NEW.started_at IS NULL THEN
            RAISE EXCEPTION
                'v4 collection run % requires started_at', NEW.run_status
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.run_status IN ('SUCCEEDED', 'PARTIAL', 'FAILED', 'ABORTED') THEN
        IF NEW.completed_at IS NULL THEN
            RAISE EXCEPTION
                'v4 collection run % requires completed_at', NEW.run_status
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.run_status = 'FAILED' AND NEW.sanitized_error_code IS NULL THEN
        RAISE EXCEPTION
            'v4 collection run FAILED requires a sanitized error code'
            USING ERRCODE = '23514';
    END IF;

    -- Every terminal outcome except preflight ABORT must close every created
    -- attempt: a run may never conclude as SUCCEEDED, PARTIAL or FAILED while
    -- an attempt is still PLANNED or RUNNING, otherwise a late attempt write
    -- could mutate evidence after the run ended. SUCCEEDED additionally
    -- requires the exact full closure below; ABORTED remains a preflight-only
    -- outcome that may conclude a run that never created attempts.
    IF NEW.run_status IN ('SUCCEEDED', 'PARTIAL', 'FAILED') THEN
        IF EXISTS (
            SELECT 1
            FROM ops.v4_collection_attempt
            WHERE collection_run_id = NEW.collection_run_id
              AND attempt_status IN ('PLANNED', 'RUNNING')
        ) THEN
            RAISE EXCEPTION
                'v4 collection run % requires every created attempt terminal',
                NEW.run_status
                USING ERRCODE = '23514';
        END IF;
    END IF;

    -- SUCCEEDED is provable only when the frozen 25 x 13 manifest is closed by
    -- SUCCEEDED attempts. Missing or non-succeeded attempts keep the run from
    -- ever claiming success; the database never fills a zero here.
    IF NEW.run_status = 'SUCCEEDED' THEN
        SELECT count(*), count(*) FILTER (
            WHERE attempt_status <> 'SUCCEEDED'
        )
        INTO total_attempts, non_succeeded_attempts
        FROM ops.v4_collection_attempt
        WHERE collection_run_id = NEW.collection_run_id;
        IF total_attempts <> NEW.expected_store_count * NEW.expected_endpoint_count
           OR non_succeeded_attempts <> 0 THEN
            RAISE EXCEPTION
                'v4 collection run cannot be SUCCEEDED until every roster store x endpoint attempt is SUCCEEDED'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.run_status = 'PARTIAL' AND NOT EXISTS (
        SELECT 1
        FROM ops.v4_collection_attempt
        WHERE collection_run_id = NEW.collection_run_id
    ) THEN
        RAISE EXCEPTION
            'v4 collection run PARTIAL requires at least one attempt'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ops.guard_v4_collection_run_state() IS
    'Full-managed v4 run guard: immutable plan, one-way state machine, roster-consistent counts, terminal-attempt closure for every concluded outcome and a SUCCEEDED closure proven by SUCCEEDED attempts only.';

DROP TRIGGER IF EXISTS trg_ops_v4_collection_run_guard ON ops.v4_collection_run;
CREATE TRIGGER trg_ops_v4_collection_run_guard
BEFORE INSERT OR UPDATE ON ops.v4_collection_run
FOR EACH ROW EXECUTE FUNCTION ops.guard_v4_collection_run_state();

DROP TRIGGER IF EXISTS trg_ops_v4_collection_run_touch ON ops.v4_collection_run;
CREATE TRIGGER trg_ops_v4_collection_run_touch
BEFORE UPDATE ON ops.v4_collection_run
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Store x endpoint attempt ledger. One row per run x store x endpoint; fixed
-- retry NONE means a replay reuses the row and must reproduce it exactly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.v4_collection_attempt (
    collection_attempt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    collection_run_id bigint NOT NULL,
    store_code text NOT NULL,
    endpoint_code text NOT NULL,
    -- Deterministic replay guard: hash of run_key x store x endpoint x request
    -- schema hash x window. A replay that changes any of these produces a
    -- different key and fails closed instead of drifting.
    attempt_key character(64) NOT NULL,
    request_schema_hash character(64) NOT NULL,
    request_fingerprint character(64) NOT NULL,
    window_start date,
    window_end date,
    attempt_status text NOT NULL DEFAULT 'PLANNED',
    expected_row_count integer,
    observed_row_count integer,
    observed_page_count integer,
    started_at timestamptz,
    completed_at timestamptz,
    sanitized_error_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_ops_v4_collection_attempt_run
        FOREIGN KEY (collection_run_id)
        REFERENCES ops.v4_collection_run (collection_run_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_ops_v4_collection_attempt_key
        UNIQUE (attempt_key),
    -- Fixed retry NONE: one attempt per run x store x endpoint, forever.
    CONSTRAINT uq_ops_v4_collection_attempt_grain
        UNIQUE (collection_run_id, store_code, endpoint_code),
    CONSTRAINT ck_ops_v4_collection_attempt_hashes
        CHECK (
            attempt_key ~ '^[0-9a-f]{64}$'
            AND request_schema_hash ~ '^[0-9a-f]{64}$'
            AND request_fingerprint ~ '^[0-9a-f]{64}$'
        ),
    CONSTRAINT ck_ops_v4_collection_attempt_store
        CHECK (store_code ~ '^[A-Z]{2}[0-9]{4}$'),
    CONSTRAINT ck_ops_v4_collection_attempt_endpoint
        CHECK (endpoint_code ~ '^[A-Z][A-Z0-9_]{2,60}$'),
    CONSTRAINT ck_ops_v4_collection_attempt_window
        CHECK (
            (window_start IS NULL AND window_end IS NULL)
            OR (
                window_start IS NOT NULL
                AND window_end IS NOT NULL
                AND window_start <= window_end
                AND window_end - window_start <= 30
            )
        ),
    CONSTRAINT ck_ops_v4_collection_attempt_status
        CHECK (
            attempt_status IN (
                'PLANNED', 'RUNNING', 'SUCCEEDED',
                'PARTIAL', 'FAILED', 'BLOCKED', 'UNKNOWN'
            )
        ),
    CONSTRAINT ck_ops_v4_collection_attempt_counts
        CHECK (
            (expected_row_count IS NULL OR expected_row_count >= 0)
            AND (observed_row_count IS NULL OR observed_row_count >= 0)
            AND (observed_page_count IS NULL OR observed_page_count >= 0)
        ),
    CONSTRAINT ck_ops_v4_collection_attempt_error_code
        CHECK (
            sanitized_error_code IS NULL
            OR sanitized_error_code ~ '^[A-Z][A-Z0-9_]{2,80}$'
        ),
    CONSTRAINT ck_ops_v4_collection_attempt_timeline
        CHECK (
            (started_at IS NULL OR started_at >= created_at)
            AND (
                completed_at IS NULL
                OR (
                    started_at IS NULL
                    OR completed_at >= started_at
                )
            )
        )
);

CREATE INDEX IF NOT EXISTS ix_ops_v4_collection_attempt_resume
    ON ops.v4_collection_attempt (
        collection_run_id,
        attempt_status,
        store_code,
        endpoint_code
    );

COMMENT ON TABLE ops.v4_collection_attempt IS
    'Per-store/per-endpoint collection attempt. attempt_key is the deterministic replay guard: the same key with byte-identical request schema, fingerprint and window is an exact replay; anything else is drift and fails closed. BLOCKED and UNKNOWN are terminal preflight outcomes.';

-- ---------------------------------------------------------------------------
-- Attempt guard: terminal state machine, evidence immutability and replay
-- drift protection.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.guard_v4_collection_attempt_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Replay identity is immutable: changing any part of the attempt key or
    -- the frozen request contract would silently rebind evidence.
    IF TG_OP = 'UPDATE' THEN
        IF NEW.collection_run_id <> OLD.collection_run_id
           OR NEW.store_code <> OLD.store_code
           OR NEW.endpoint_code <> OLD.endpoint_code
           OR NEW.attempt_key <> OLD.attempt_key
           OR NEW.request_schema_hash <> OLD.request_schema_hash
           OR NEW.request_fingerprint <> OLD.request_fingerprint
           OR NEW.window_start IS DISTINCT FROM OLD.window_start
           OR NEW.window_end IS DISTINCT FROM OLD.window_end
           OR NEW.expected_row_count IS DISTINCT FROM OLD.expected_row_count
           OR NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION
                'v4 collection attempt identity and request contract are immutable'
                USING ERRCODE = '42501';
        END IF;
        IF NOT (
            (OLD.attempt_status = 'PLANNED' AND NEW.attempt_status IN (
                'RUNNING', 'FAILED', 'BLOCKED', 'UNKNOWN'
            ))
            OR (OLD.attempt_status = 'RUNNING' AND NEW.attempt_status IN (
                'SUCCEEDED', 'PARTIAL', 'FAILED'
            ))
        ) THEN
            RAISE EXCEPTION
                'invalid v4 collection attempt transition % -> %',
                OLD.attempt_status, NEW.attempt_status
                USING ERRCODE = '23514';
        END IF;
    ELSE
        -- Attempts may be born PLANNED or as the terminal preflight outcomes
        -- BLOCKED / UNKNOWN. Evidence rows may only be created while the run
        -- is still open.
        IF NEW.attempt_status NOT IN ('PLANNED', 'BLOCKED', 'UNKNOWN') THEN
            RAISE EXCEPTION
                'v4 collection attempt must start as PLANNED, BLOCKED or UNKNOWN'
                USING ERRCODE = '23514';
        END IF;
        IF (SELECT run_status
              FROM ops.v4_collection_run
             WHERE collection_run_id = NEW.collection_run_id)
           IN ('SUCCEEDED', 'PARTIAL', 'FAILED', 'ABORTED') THEN
            RAISE EXCEPTION
                'v4 collection attempt cannot be created under a terminal run'
                USING ERRCODE = '23514';
        END IF;
        -- The attempt grain must belong to the run's frozen roster.
        IF NOT EXISTS (
            SELECT 1
            FROM ops.v4_collection_run AS run
            WHERE run.collection_run_id = NEW.collection_run_id
              AND NEW.store_code = ANY (run.store_codes)
              AND NEW.endpoint_code = ANY (run.endpoint_codes)
        ) THEN
            RAISE EXCEPTION
                'v4 collection attempt is outside the frozen run roster'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    -- BLOCKED and UNKNOWN are terminal preflight outcomes with no fabricated
    -- counts: failure or missing evidence is never converted to zero.
    IF NEW.attempt_status = 'BLOCKED' THEN
        IF NEW.started_at IS NOT NULL
           OR NEW.completed_at IS NULL
           OR NEW.sanitized_error_code IS NULL
           OR NEW.observed_row_count IS NOT NULL
           OR NEW.observed_page_count IS NOT NULL THEN
            RAISE EXCEPTION
                'v4 collection attempt BLOCKED requires completed_at, a sanitized error code and no counts'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.attempt_status = 'UNKNOWN' THEN
        IF NEW.completed_at IS NULL
           OR NEW.observed_row_count IS NOT NULL
           OR NEW.observed_page_count IS NOT NULL THEN
            RAISE EXCEPTION
                'v4 collection attempt UNKNOWN requires completed_at and no counts'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.attempt_status = 'RUNNING' THEN
        IF NEW.started_at IS NULL OR NEW.completed_at IS NOT NULL THEN
            RAISE EXCEPTION
                'v4 collection attempt RUNNING requires started_at only'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.attempt_status IN ('SUCCEEDED', 'PARTIAL') THEN
        IF NEW.started_at IS NULL
           OR NEW.completed_at IS NULL
           OR NEW.observed_row_count IS NULL THEN
            RAISE EXCEPTION
                'v4 collection attempt % requires started_at, completed_at and observed_row_count',
                NEW.attempt_status
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.attempt_status = 'FAILED' THEN
        IF NEW.completed_at IS NULL
           OR NEW.sanitized_error_code IS NULL
           OR NEW.observed_row_count IS NOT NULL
           OR NEW.observed_page_count IS NOT NULL THEN
            RAISE EXCEPTION
                'v4 collection attempt FAILED requires completed_at and a sanitized error code, never counts'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    -- SUCCEEDED is provable only with complete, accepted page evidence:
    -- every fetched page must have been recorded and fully accepted.
    IF NEW.attempt_status = 'SUCCEEDED' THEN
        IF NEW.observed_page_count IS NULL
           OR NEW.observed_page_count < 1
           OR EXISTS (
                SELECT 1
                FROM ops.v4_page_evidence AS page
                WHERE page.collection_attempt_id = NEW.collection_attempt_id
                  AND page.fetch_status <> 'SUCCEEDED'
           )
           OR (SELECT count(*)
                 FROM ops.v4_page_evidence AS page
                WHERE page.collection_attempt_id = NEW.collection_attempt_id)
              <> NEW.observed_page_count THEN
            RAISE EXCEPTION
                'v4 collection attempt SUCCEEDED requires complete accepted page evidence'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.attempt_status = 'PARTIAL' AND NOT EXISTS (
        SELECT 1
        FROM ops.v4_page_evidence AS page
        WHERE page.collection_attempt_id = NEW.collection_attempt_id
    ) THEN
        RAISE EXCEPTION
            'v4 collection attempt PARTIAL requires at least one page evidence row'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ops.guard_v4_collection_attempt_terminal() IS
    'Full-managed v4 attempt guard: immutable replay identity, strict terminal machine and fail-closed BLOCKED/UNKNOWN/FAILED states that never fabricate zero counts.';

DROP TRIGGER IF EXISTS trg_ops_v4_collection_attempt_guard
    ON ops.v4_collection_attempt;
CREATE TRIGGER trg_ops_v4_collection_attempt_guard
BEFORE INSERT OR UPDATE ON ops.v4_collection_attempt
FOR EACH ROW EXECUTE FUNCTION ops.guard_v4_collection_attempt_terminal();

DROP TRIGGER IF EXISTS trg_ops_v4_collection_attempt_touch
    ON ops.v4_collection_attempt;
CREATE TRIGGER trg_ops_v4_collection_attempt_touch
BEFORE UPDATE ON ops.v4_collection_attempt
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Page evidence: metadata only. Hashes, schema, counts and status; never the
-- raw response body.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.reject_v4_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'Full-managed v4 evidence is append-only: % on %.% is rejected',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

COMMENT ON FUNCTION ops.reject_v4_evidence_mutation() IS
    'Append-only guard for full-managed v4 evidence rows (page evidence, capability observations and typed fact observations).';

CREATE TABLE IF NOT EXISTS ops.v4_page_evidence (
    page_evidence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    collection_attempt_id bigint NOT NULL,
    -- Deterministic replay guard per page: hash of attempt_key x page number x
    -- page request fingerprint. A replay with a different request cannot reuse
    -- the same page evidence row.
    page_key character(64) NOT NULL,
    page_number integer NOT NULL,
    page_size integer NOT NULL,
    page_request_fingerprint character(64) NOT NULL,
    response_schema_hash character(64) NOT NULL,
    payload_hash character(64) NOT NULL,
    row_count integer NOT NULL DEFAULT 0,
    rejected_row_count integer NOT NULL DEFAULT 0,
    http_status integer,
    fetch_status text NOT NULL,
    observed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_ops_v4_page_evidence_attempt
        FOREIGN KEY (collection_attempt_id)
        REFERENCES ops.v4_collection_attempt (collection_attempt_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_ops_v4_page_evidence_key
        UNIQUE (page_key),
    -- One fixed page sequence per attempt; a page can never be renumbered.
    CONSTRAINT uq_ops_v4_page_evidence_number
        UNIQUE (collection_attempt_id, page_number),
    CONSTRAINT ck_ops_v4_page_evidence_hashes
        CHECK (
            page_key ~ '^[0-9a-f]{64}$'
            AND page_request_fingerprint ~ '^[0-9a-f]{64}$'
            AND response_schema_hash ~ '^[0-9a-f]{64}$'
            AND payload_hash ~ '^[0-9a-f]{64}$'
        ),
    CONSTRAINT ck_ops_v4_page_evidence_paging
        CHECK (
            page_number BETWEEN 1 AND 1000
            AND page_size BETWEEN 1 AND 1000
        ),
    CONSTRAINT ck_ops_v4_page_evidence_counts
        CHECK (row_count >= 0 AND rejected_row_count >= 0),
    CONSTRAINT ck_ops_v4_page_evidence_http
        CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
    -- PARTIAL is only for pages that had rows refused by sanitization;
    -- SUCCEEDED means every row of the page was accepted as typed evidence.
    CONSTRAINT ck_ops_v4_page_evidence_fetch
        CHECK (
            (fetch_status = 'SUCCEEDED' AND rejected_row_count = 0)
            OR (fetch_status = 'PARTIAL' AND rejected_row_count > 0)
        )
);

CREATE INDEX IF NOT EXISTS ix_ops_v4_page_evidence_attempt
    ON ops.v4_page_evidence (collection_attempt_id, page_number);

-- Referencable key so the typed fact tables can pin a page evidence row to the
-- same attempt that produced it via a composite foreign key. The database,
-- not just the repository, must prove that a fact row's source_page_evidence
-- belongs to its source_attempt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_v4_page_evidence_attempt_ref
    ON ops.v4_page_evidence (collection_attempt_id, page_evidence_id);

COMMENT ON TABLE ops.v4_page_evidence IS
    'Per-page fetch metadata: request/schema/payload hashes, bounded counts, HTTP status and fetch status. No raw response body, header, cookie or PII column exists.';

-- Page evidence is immutable and may only be recorded while the attempt is
-- still open.
CREATE OR REPLACE FUNCTION ops.guard_v4_page_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION
            'v4 page evidence is append-only'
            USING ERRCODE = '42501';
    END IF;
    IF (SELECT attempt_status
          FROM ops.v4_collection_attempt
         WHERE collection_attempt_id = NEW.collection_attempt_id)
       NOT IN ('PLANNED', 'RUNNING') THEN
        RAISE EXCEPTION
            'v4 page evidence requires a non-terminal attempt'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ops.guard_v4_page_evidence_mutation() IS
    'Full-managed v4 page evidence guard: append-only and only while the owning attempt is open.';

DROP TRIGGER IF EXISTS trg_ops_v4_page_evidence_append_only
    ON ops.v4_page_evidence;
CREATE TRIGGER trg_ops_v4_page_evidence_append_only
BEFORE UPDATE OR DELETE ON ops.v4_page_evidence
FOR EACH ROW EXECUTE FUNCTION ops.reject_v4_evidence_mutation();

DROP TRIGGER IF EXISTS trg_ops_v4_page_evidence_guard
    ON ops.v4_page_evidence;
CREATE TRIGGER trg_ops_v4_page_evidence_guard
BEFORE INSERT ON ops.v4_page_evidence
FOR EACH ROW EXECUTE FUNCTION ops.guard_v4_page_evidence_mutation();

-- ---------------------------------------------------------------------------
-- Coverage envelope: one terminal row per run. The counts are recomputed by
-- the guard from attempt and page evidence rows, so the database can never
-- accept a zero-filled or inflated coverage.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.v4_collection_coverage (
    coverage_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    collection_run_id bigint NOT NULL,
    expected_store_count integer NOT NULL,
    completed_store_count integer NOT NULL,
    partial_store_count integer NOT NULL,
    unknown_store_count integer NOT NULL,
    expected_endpoint_count integer NOT NULL,
    paging_verified boolean NOT NULL,
    dedupe_verified boolean NOT NULL,
    row_count bigint NOT NULL DEFAULT 0,
    reason_code text,
    as_of timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_ops_v4_collection_coverage_run
        FOREIGN KEY (collection_run_id)
        REFERENCES ops.v4_collection_run (collection_run_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_ops_v4_collection_coverage_run
        UNIQUE (collection_run_id),
    CONSTRAINT ck_ops_v4_collection_coverage_counts
        CHECK (
            expected_store_count >= 1
            AND completed_store_count >= 0
            AND partial_store_count >= 0
            AND unknown_store_count >= 0
            AND expected_endpoint_count >= 1
            AND row_count >= 0
        ),
    CONSTRAINT ck_ops_v4_collection_coverage_reason
        CHECK (
            reason_code IS NULL
            OR reason_code ~ '^[A-Z][A-Z0-9_]{2,80}$'
        )
);

COMMENT ON TABLE ops.v4_collection_coverage IS
    'Terminal coverage envelope for one run. completed/partial/unknown store counts are recomputed by the guard from attempts; row_count is recomputed from page evidence. paging_verified and dedupe_verified are collection-time evidence flags recorded by the loader.';

CREATE OR REPLACE FUNCTION ops.guard_v4_collection_coverage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    run_record record;
    roster_store text;
    attempt_count integer;
    succeeded_attempt_count integer;
    computed_completed integer := 0;
    computed_partial integer := 0;
    computed_unknown integer := 0;
    computed_row_count bigint;
BEGIN
    SELECT collection_run_id, run_status, expected_store_count,
           expected_endpoint_count, store_codes
      INTO run_record
      FROM ops.v4_collection_run
     WHERE collection_run_id = NEW.collection_run_id;
    IF run_record.collection_run_id IS NULL THEN
        RAISE EXCEPTION
            'v4 coverage requires an existing run'
            USING ERRCODE = '23502';
    END IF;
    IF run_record.run_status NOT IN (
        'SUCCEEDED', 'PARTIAL', 'FAILED', 'ABORTED'
    ) THEN
        RAISE EXCEPTION
            'v4 coverage requires a terminal run'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.expected_store_count <> run_record.expected_store_count
       OR NEW.expected_endpoint_count <> run_record.expected_endpoint_count THEN
        RAISE EXCEPTION
            'v4 coverage expected counts must mirror the run'
            USING ERRCODE = '23514';
    END IF;

    -- Classify every roster store from attempt evidence only. A store with no
    -- SUCCEEDED attempt is unknown; nothing is ever promoted to completed or
    -- zero-filled here.
    FOREACH roster_store IN ARRAY run_record.store_codes LOOP
        SELECT count(*), count(*) FILTER (
            WHERE attempt_status = 'SUCCEEDED'
        )
        INTO attempt_count, succeeded_attempt_count
        FROM ops.v4_collection_attempt
        WHERE collection_run_id = NEW.collection_run_id
          AND store_code = roster_store;
        IF attempt_count = run_record.expected_endpoint_count
           AND succeeded_attempt_count = attempt_count THEN
            computed_completed := computed_completed + 1;
        ELSIF succeeded_attempt_count > 0 THEN
            computed_partial := computed_partial + 1;
        ELSE
            computed_unknown := computed_unknown + 1;
        END IF;
    END LOOP;

    IF NEW.completed_store_count <> computed_completed
       OR NEW.partial_store_count <> computed_partial
       OR NEW.unknown_store_count <> computed_unknown THEN
        RAISE EXCEPTION
            'v4 coverage store counts do not match attempt evidence'
            USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(sum(page.row_count), 0)
      INTO computed_row_count
      FROM ops.v4_page_evidence AS page
      JOIN ops.v4_collection_attempt AS attempt
        ON attempt.collection_attempt_id = page.collection_attempt_id
     WHERE attempt.collection_run_id = NEW.collection_run_id;
    IF NEW.row_count <> computed_row_count THEN
        RAISE EXCEPTION
            'v4 coverage row_count does not match page evidence'
            USING ERRCODE = '23514';
    END IF;

    -- A run that is not fully completed must explain itself.
    IF NEW.completed_store_count < NEW.expected_store_count
       AND NEW.reason_code IS NULL THEN
        RAISE EXCEPTION
            'v4 coverage requires a reason_code when completion is partial'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ops.guard_v4_collection_coverage() IS
    'Full-managed v4 coverage guard: terminal run, counts recomputed from attempt and page evidence, and a mandatory reason_code for anything short of full completion.';

DROP TRIGGER IF EXISTS trg_ops_v4_collection_coverage_guard
    ON ops.v4_collection_coverage;
CREATE TRIGGER trg_ops_v4_collection_coverage_guard
BEFORE INSERT OR UPDATE ON ops.v4_collection_coverage
FOR EACH ROW EXECUTE FUNCTION ops.guard_v4_collection_coverage();

DROP TRIGGER IF EXISTS trg_ops_v4_collection_coverage_touch
    ON ops.v4_collection_coverage;
CREATE TRIGGER trg_ops_v4_collection_coverage_touch
BEFORE UPDATE ON ops.v4_collection_coverage
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Capability observations: marketing and low-frequency capabilities are
-- recorded here with business_materialized = false. They never create a
-- business fact table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.v4_capability_observation (
    capability_observation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    observation_key character(64) NOT NULL,
    collection_run_id bigint NOT NULL,
    store_code text,
    endpoint_code text NOT NULL,
    capability_code text NOT NULL,
    capability_status text NOT NULL,
    business_materialized boolean NOT NULL DEFAULT false,
    payload_hash character(64) NOT NULL,
    observed_at timestamptz NOT NULL,
    source_updated_at timestamptz,
    sanitized_error_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_ops_v4_capability_observation_run
        FOREIGN KEY (collection_run_id)
        REFERENCES ops.v4_collection_run (collection_run_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_ops_v4_capability_observation_key
        UNIQUE (observation_key),
    CONSTRAINT ck_ops_v4_capability_observation_key
        CHECK (observation_key ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ops_v4_capability_observation_store
        CHECK (
            store_code IS NULL
            OR store_code ~ '^[A-Z]{2}[0-9]{4}$'
        ),
    CONSTRAINT ck_ops_v4_capability_observation_endpoint
        CHECK (endpoint_code ~ '^[A-Z][A-Z0-9_]{2,60}$'),
    CONSTRAINT ck_ops_v4_capability_observation_capability
        CHECK (capability_code ~ '^[A-Z][A-Z0-9_]{2,60}$'),
    CONSTRAINT ck_ops_v4_capability_observation_status
        CHECK (
            capability_status IN (
                'VERIFIED', 'UNVERIFIED', 'UNSUPPORTED',
                'BLOCKED', 'UNAVAILABLE', 'UNKNOWN'
            )
        ),
    -- Marketing and low-frequency capabilities never materialize business
    -- facts in this layer: no row may claim otherwise.
    CONSTRAINT ck_ops_v4_capability_observation_materialized
        CHECK (business_materialized = false),
    CONSTRAINT ck_ops_v4_capability_observation_payload
        CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ops_v4_capability_observation_error
        CHECK (
            sanitized_error_code IS NULL
            OR sanitized_error_code ~ '^[A-Z][A-Z0-9_]{2,80}$'
        )
);

-- Exact replay grain: one capability observation per run x store x endpoint x
-- capability. NULL store_code covers platform-global capabilities.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_v4_capability_observation_grain_store
    ON ops.v4_capability_observation (
        collection_run_id, store_code, endpoint_code, capability_code
    )
    WHERE store_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_v4_capability_observation_grain_global
    ON ops.v4_capability_observation (
        collection_run_id, endpoint_code, capability_code
    )
    WHERE store_code IS NULL;

CREATE INDEX IF NOT EXISTS ix_ops_v4_capability_observation_run
    ON ops.v4_capability_observation (collection_run_id, capability_code);

COMMENT ON TABLE ops.v4_capability_observation IS
    'Capability evidence for marketing and low-frequency endpoints: status, sanitized payload hash and business_materialized=false only. No business fact is created for these capabilities.';

DROP TRIGGER IF EXISTS trg_ops_v4_capability_observation_append_only
    ON ops.v4_capability_observation;
CREATE TRIGGER trg_ops_v4_capability_observation_append_only
BEFORE UPDATE OR DELETE ON ops.v4_capability_observation
FOR EACH ROW EXECUTE FUNCTION ops.reject_v4_evidence_mutation();

-- ---------------------------------------------------------------------------
-- Least privilege: the WebAPI loader drives the control plane state machine
-- (SELECT/INSERT/UPDATE on run, attempt and coverage; SELECT only on the
-- contract registry; INSERT only on append-only evidence). sheinfm_app is a
-- pure read model. No role ever receives DELETE on the control plane.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_webapi_loader') THEN
        GRANT SELECT, INSERT, UPDATE
            ON ops.v4_collection_run, ops.v4_collection_attempt,
               ops.v4_collection_coverage
            TO sheinfm_webapi_loader;
        GRANT SELECT
            ON ops.v4_collection_contract
            TO sheinfm_webapi_loader;
        GRANT SELECT, INSERT
            ON ops.v4_page_evidence, ops.v4_capability_observation
            TO sheinfm_webapi_loader;
        GRANT USAGE ON SEQUENCE
            ops.v4_collection_run_collection_run_id_seq,
            ops.v4_collection_attempt_collection_attempt_id_seq,
            ops.v4_page_evidence_page_evidence_id_seq,
            ops.v4_collection_coverage_coverage_id_seq,
            ops.v4_capability_observation_capability_observation_id_seq
            TO sheinfm_webapi_loader;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_app') THEN
        GRANT SELECT
            ON ops.v4_collection_contract, ops.v4_collection_run,
               ops.v4_collection_attempt, ops.v4_page_evidence,
               ops.v4_collection_coverage, ops.v4_capability_observation
            TO sheinfm_app;
        GRANT USAGE, SELECT ON SEQUENCE
            ops.v4_collection_run_collection_run_id_seq,
            ops.v4_collection_attempt_collection_attempt_id_seq,
            ops.v4_page_evidence_page_evidence_id_seq,
            ops.v4_collection_coverage_coverage_id_seq,
            ops.v4_capability_observation_capability_observation_id_seq
            TO sheinfm_app;
    END IF;
END;
$$;

COMMIT;
