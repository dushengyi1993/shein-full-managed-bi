BEGIN;

-- ---------------------------------------------------------------------------
-- Historical backfill control plane.
--
-- The control plane owns plans, windows and checkpoints. It never stores a
-- business fact: every domain keeps writing through its own existing verified
-- loader. Canonical store codes are stored as text so a plan can exist before a
-- dimension row does, and so the isolated WebAPI runtime never needs SELECT on
-- dim.store.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ops.backfill_run (
    backfill_run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plan_hash character(64) NOT NULL,
    mode text NOT NULL,
    status text NOT NULL DEFAULT 'PLANNED',
    requested_domains text[] NOT NULL,
    requested_store_codes text[] NOT NULL,
    requested_from date NOT NULL,
    requested_to date NOT NULL,
    window_span_days integer NOT NULL,
    planned_window_count integer NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    started_at timestamptz,
    completed_at timestamptz,
    sanitized_error_code text,
    CONSTRAINT ck_ops_backfill_run_mode
        CHECK (mode IN ('DRY_RUN', 'EXECUTE')),
    CONSTRAINT ck_ops_backfill_run_status
        CHECK (status IN ('PLANNED', 'RUNNING', 'PARTIAL', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    CONSTRAINT ck_ops_backfill_run_plan_hash
        CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ops_backfill_run_created_by
        CHECK (created_by ~ '^[A-Za-z0-9._:-]{3,80}$'),
    CONSTRAINT ck_ops_backfill_run_bounds
        CHECK (
            requested_from <= requested_to
            AND requested_to - requested_from < 400
            AND window_span_days BETWEEN 1 AND 31
            AND planned_window_count BETWEEN 0 AND 2000
        ),
    CONSTRAINT ck_ops_backfill_run_scope
        CHECK (
            array_length(requested_domains, 1) BETWEEN 1 AND 12
            AND array_length(requested_store_codes, 1) BETWEEN 1 AND 24
        ),
    CONSTRAINT ck_ops_backfill_run_error_code
        CHECK (
            sanitized_error_code IS NULL
            OR sanitized_error_code ~ '^[A-Z][A-Z0-9_]{2,60}$'
        ),
    CONSTRAINT ck_ops_backfill_run_timeline
        CHECK (
            (started_at IS NULL OR started_at >= created_at)
            AND (
                completed_at IS NULL
                OR (started_at IS NOT NULL AND completed_at >= started_at)
            )
        ),
    CONSTRAINT uq_ops_backfill_run_mode_ref
        UNIQUE (backfill_run_id, mode)
);

-- One EXECUTE run per approved plan hash: a replay continues the same run
-- instead of duplicating evidence.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_backfill_run_execute_plan
    ON ops.backfill_run (plan_hash)
    WHERE mode = 'EXECUTE';

CREATE INDEX IF NOT EXISTS ix_ops_backfill_run_status
    ON ops.backfill_run (status, created_at DESC);

COMMENT ON TABLE ops.backfill_run IS
    'Bounded backfill plan execution ledger. plan_hash covers the requested scope and planner bounds only, so a reviewed dry-run hash can authorise exactly one EXECUTE run.';

CREATE TABLE IF NOT EXISTS ops.backfill_window (
    backfill_window_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    backfill_run_id bigint NOT NULL,
    store_code text NOT NULL,
    domain text NOT NULL,
    adapter_key text NOT NULL,
    window_start date NOT NULL,
    window_end date NOT NULL,
    window_key character(64) NOT NULL,
    capability_status text NOT NULL,
    execution_status text NOT NULL DEFAULT 'PLANNED',
    quality_status text NOT NULL DEFAULT 'UNKNOWN',
    attempt_count integer NOT NULL DEFAULT 0,
    accepted_row_count integer,
    rejected_row_count integer,
    expected_page_count integer,
    observed_page_count integer,
    source_business_watermark date,
    schema_fingerprint character(64),
    next_retry_at timestamptz,
    sanitized_error_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_ops_backfill_window_run
        FOREIGN KEY (backfill_run_id)
        REFERENCES ops.backfill_run (backfill_run_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_ops_backfill_window_grain
        UNIQUE (backfill_run_id, store_code, domain, adapter_key, window_start, window_end),
    CONSTRAINT ck_ops_backfill_window_store_code
        CHECK (store_code ~ '^[A-Z]{2}[0-9]{4}$'),
    CONSTRAINT ck_ops_backfill_window_domain
        CHECK (domain ~ '^[a-z][a-z0-9-]{2,40}$'),
    CONSTRAINT ck_ops_backfill_window_adapter_key
        CHECK (adapter_key ~ '^[a-z][a-z0-9.-]{4,60}$'),
    CONSTRAINT ck_ops_backfill_window_range
        CHECK (window_start < window_end AND window_end - window_start <= 31),
    CONSTRAINT ck_ops_backfill_window_key
        CHECK (window_key ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ops_backfill_window_capability
        CHECK (
            capability_status IN ('VERIFIED', 'UNVERIFIED', 'UNSUPPORTED', 'EXPERIMENT_ONLY')
        ),
    CONSTRAINT ck_ops_backfill_window_execution
        CHECK (
            execution_status IN (
                'PLANNED', 'BLOCKED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'SKIPPED'
            )
        ),
    CONSTRAINT ck_ops_backfill_window_quality
        CHECK (
            quality_status IN (
                'UNKNOWN', 'PASSED', 'MISSING_PAGE', 'SCHEMA_DRIFT',
                'MIXED_BUSINESS_DATE', 'ILLEGAL_DECIMAL', 'UNKNOWN_METRIC',
                'REJECTED_ROWS', 'COVERAGE_GAP', 'ADAPTER_ERROR'
            )
        ),
    -- An unverified, unsupported or experiment-only capability can never reach a
    -- running or successful state, so it can never touch a checkpoint.
    CONSTRAINT ck_ops_backfill_window_unproven_capability
        CHECK (
            capability_status = 'VERIFIED'
            OR execution_status IN ('PLANNED', 'BLOCKED', 'SKIPPED')
        ),
    -- PASSED requires exact page coverage, zero rejects, a schema fingerprint and
    -- a successful execution. Everything else stays diagnostic.
    CONSTRAINT ck_ops_backfill_window_passed_requires_proof
        CHECK (
            quality_status <> 'PASSED'
            OR (
                execution_status IN ('SUCCEEDED', 'SKIPPED')
                AND capability_status = 'VERIFIED'
                AND schema_fingerprint IS NOT NULL
                AND (
                    execution_status = 'SKIPPED'
                    OR (
                        accepted_row_count IS NOT NULL
                        AND rejected_row_count = 0
                        AND expected_page_count IS NOT NULL
                        AND observed_page_count = expected_page_count
                    )
                )
            )
        ),
    CONSTRAINT ck_ops_backfill_window_counts
        CHECK (
            attempt_count >= 0
            AND (accepted_row_count IS NULL OR accepted_row_count >= 0)
            AND (rejected_row_count IS NULL OR rejected_row_count >= 0)
            AND (expected_page_count IS NULL OR expected_page_count >= 0)
            AND (observed_page_count IS NULL OR observed_page_count >= 0)
        ),
    CONSTRAINT ck_ops_backfill_window_fingerprint
        CHECK (schema_fingerprint IS NULL OR schema_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ops_backfill_window_error_code
        CHECK (
            sanitized_error_code IS NULL
            OR sanitized_error_code ~ '^[A-Z][A-Z0-9_]{2,60}$'
        ),
    -- Referenced by ops.backfill_checkpoint so a checkpoint can only cite a
    -- window that is SUCCEEDED + PASSED + VERIFIED at reference time.
    CONSTRAINT uq_ops_backfill_window_checkpoint_ref
        UNIQUE (
            backfill_window_id,
            backfill_run_id,
            store_code,
            domain,
            adapter_key,
            execution_status,
            quality_status,
            capability_status,
            source_business_watermark,
            schema_fingerprint
        ),
    -- A proven watermark must belong to this half-open window, so a checkpoint
    -- can never inherit a business date from outside the window it cites.
    CONSTRAINT ck_ops_backfill_window_watermark_in_range
        CHECK (
            source_business_watermark IS NULL
            OR (
                source_business_watermark >= window_start
                AND source_business_watermark < window_end
            )
        )
);

CREATE INDEX IF NOT EXISTS ix_ops_backfill_window_resume
    ON ops.backfill_window (
        backfill_run_id,
        execution_status,
        quality_status,
        window_start DESC
    );

CREATE INDEX IF NOT EXISTS ix_ops_backfill_window_key
    ON ops.backfill_window (window_key);

COMMENT ON TABLE ops.backfill_window IS
    'Backfill grain: run x store x domain x adapter x [window_start, window_end). window_end is exclusive so adjacent windows never overlap and a late fact replays exactly one business-date range.';

DROP TRIGGER IF EXISTS trg_ops_backfill_window_touch ON ops.backfill_window;
CREATE TRIGGER trg_ops_backfill_window_touch
BEFORE UPDATE ON ops.backfill_window
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

CREATE TABLE IF NOT EXISTS ops.backfill_checkpoint (
    backfill_checkpoint_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_code text NOT NULL,
    domain text NOT NULL,
    adapter_key text NOT NULL,
    last_completed_business_date date NOT NULL,
    last_source_cursor text,
    last_successful_run_id bigint NOT NULL,
    -- Pinned so the foreign key can prove the source run was an EXECUTE run.
    last_successful_run_mode text NOT NULL DEFAULT 'EXECUTE',
    last_successful_window_id bigint NOT NULL,
    -- Pinned so the foreign key proves the cited window really succeeded with
    -- PASSED quality under a VERIFIED capability.
    last_successful_window_execution_status text NOT NULL DEFAULT 'SUCCEEDED',
    schema_fingerprint character(64) NOT NULL,
    quality_status text NOT NULL,
    capability_status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_backfill_checkpoint_grain
        UNIQUE (store_code, domain, adapter_key),
    CONSTRAINT ck_ops_backfill_checkpoint_run_mode
        CHECK (last_successful_run_mode = 'EXECUTE'),
    CONSTRAINT fk_ops_backfill_checkpoint_run
        FOREIGN KEY (last_successful_run_id, last_successful_run_mode)
        REFERENCES ops.backfill_run (backfill_run_id, mode)
        ON DELETE RESTRICT,
    -- The run, window, watermark, fingerprint and all three statuses must come
    -- from one single successful window row. Mixing evidence from two different
    -- successful windows cannot satisfy this key.
    CONSTRAINT fk_ops_backfill_checkpoint_window
        FOREIGN KEY (
            last_successful_window_id,
            last_successful_run_id,
            store_code,
            domain,
            adapter_key,
            last_successful_window_execution_status,
            quality_status,
            capability_status,
            last_completed_business_date,
            schema_fingerprint
        )
        REFERENCES ops.backfill_window (
            backfill_window_id,
            backfill_run_id,
            store_code,
            domain,
            adapter_key,
            execution_status,
            quality_status,
            capability_status,
            source_business_watermark,
            schema_fingerprint
        )
        ON DELETE RESTRICT,
    -- A checkpoint row can only exist for a proven, passed, verified window.
    CONSTRAINT ck_ops_backfill_checkpoint_quality
        CHECK (quality_status = 'PASSED'),
    CONSTRAINT ck_ops_backfill_checkpoint_capability
        CHECK (capability_status = 'VERIFIED'),
    CONSTRAINT ck_ops_backfill_checkpoint_window_execution
        CHECK (last_successful_window_execution_status = 'SUCCEEDED'),
    CONSTRAINT ck_ops_backfill_checkpoint_store_code
        CHECK (store_code ~ '^[A-Z]{2}[0-9]{4}$'),
    CONSTRAINT ck_ops_backfill_checkpoint_fingerprint
        CHECK (schema_fingerprint ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE ops.backfill_checkpoint IS
    'Checkpoint grain: store x domain x adapter_key. A row can only exist with PASSED quality and VERIFIED capability, referencing one proven window, so failure, missing pages, mixed business dates or schema drift can never advance it.';

-- A checkpoint may only ever move forward, and never change grain or identity.
CREATE OR REPLACE FUNCTION ops.guard_backfill_checkpoint_progress()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.store_code <> OLD.store_code
       OR NEW.domain <> OLD.domain
       OR NEW.adapter_key <> OLD.adapter_key THEN
        RAISE EXCEPTION
            'backfill checkpoint grain is immutable'
            USING ERRCODE = '42501';
    END IF;
    IF NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION
            'backfill checkpoint created_at is immutable'
            USING ERRCODE = '42501';
    END IF;
    IF NEW.last_completed_business_date <= OLD.last_completed_business_date THEN
        RAISE EXCEPTION
            'backfill checkpoint business date must move strictly forward'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ops.guard_backfill_checkpoint_progress() IS
    'Backfill checkpoints are forward-only. The grain and created_at are immutable and the business watermark must advance strictly.';

DROP TRIGGER IF EXISTS trg_ops_backfill_checkpoint_touch ON ops.backfill_checkpoint;
CREATE TRIGGER trg_ops_backfill_checkpoint_touch
BEFORE UPDATE ON ops.backfill_checkpoint
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_ops_backfill_checkpoint_progress ON ops.backfill_checkpoint;
CREATE TRIGGER trg_ops_backfill_checkpoint_progress
BEFORE UPDATE ON ops.backfill_checkpoint
FOR EACH ROW EXECUTE FUNCTION ops.guard_backfill_checkpoint_progress();

-- ---------------------------------------------------------------------------
-- Isolated WebAPI read-only experiment evidence.
--
-- This layer is EXPERIMENT_ONLY. It never overwrites, feeds or masquerades as an
-- OpenAPI fact, and it stores no Cookie, Authorization header, token, password,
-- full request header or un-redacted PII.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ops.reject_webapi_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'WebAPI experiment evidence is append-only: % on %.% is rejected',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

COMMENT ON FUNCTION ops.reject_webapi_evidence_mutation() IS
    'Append-only guard for the isolated WebAPI experiment evidence layer.';

CREATE TABLE IF NOT EXISTS dim.webapi_metric_definition (
    webapi_metric_definition_id bigint GENERATED ALWAYS AS IDENTITY,
    meta_index_id integer NOT NULL,
    metric_code text NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    mapping_status text NOT NULL DEFAULT 'UNMAPPED',
    canonical_metric_key text,
    page_label_zh text,
    unit_code text,
    currency character(3),
    is_monetary boolean NOT NULL DEFAULT false,
    metric_domain text,
    comparable_window text,
    evidence_reference text,
    verified_by text,
    verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_dim_webapi_metric_definition
        PRIMARY KEY (meta_index_id, metric_code, effective_from),
    CONSTRAINT uq_dim_webapi_metric_definition_id
        UNIQUE (webapi_metric_definition_id),
    -- Referenced by raw.webapi_metric_observation so a VERIFIED observation must
    -- cite a definition version that is itself VERIFIED.
    CONSTRAINT uq_dim_webapi_metric_definition_status_ref
        UNIQUE (meta_index_id, metric_code, effective_from, mapping_status),
    CONSTRAINT ck_dim_webapi_metric_definition_meta_index
        CHECK (meta_index_id > 0 AND meta_index_id <= 1000000),
    CONSTRAINT ck_dim_webapi_metric_definition_metric_code
        CHECK (metric_code ~ '^[A-Z]{2,8}[0-9]{4,10}$'),
    CONSTRAINT ck_dim_webapi_metric_definition_status
        CHECK (mapping_status IN ('UNMAPPED', 'VERIFIED', 'REJECTED')),
    CONSTRAINT ck_dim_webapi_metric_definition_window
        CHECK (effective_to IS NULL OR effective_to > effective_from),
    -- VERIFIED demands a reviewed Chinese page label, unit, comparable window and
    -- named human evidence. No label or meaning may be invented.
    CONSTRAINT ck_dim_webapi_metric_definition_verified
        CHECK (
            mapping_status <> 'VERIFIED'
            OR (
                canonical_metric_key IS NOT NULL
                AND page_label_zh IS NOT NULL
                AND unit_code IS NOT NULL
                AND comparable_window IS NOT NULL
                AND evidence_reference IS NOT NULL
                AND verified_by IS NOT NULL
                AND verified_at IS NOT NULL
                AND (NOT is_monetary OR currency IS NOT NULL)
            )
        )
);

COMMENT ON TABLE dim.webapi_metric_definition IS
    'Versioned by meta_index_id x metric_code x effective_from. An unmapped platform metric id stays UNMAPPED and may only appear on the system diagnostics page.';

DROP TRIGGER IF EXISTS trg_dim_webapi_metric_definition_touch
    ON dim.webapi_metric_definition;
CREATE TRIGGER trg_dim_webapi_metric_definition_touch
BEFORE UPDATE ON dim.webapi_metric_definition
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

CREATE TABLE IF NOT EXISTS raw.webapi_fetch_batch (
    webapi_fetch_batch_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Deterministic caller-owned idempotency key. A replay must present the same
    -- key with byte-identical safe metadata or the transaction fails closed.
    batch_key character(64) NOT NULL,
    store_code text NOT NULL,
    profile_key text NOT NULL,
    endpoint_code text NOT NULL,
    http_method text NOT NULL,
    request_schema_hash character(64) NOT NULL,
    request_fingerprint character(64) NOT NULL,
    response_schema_hash character(64),
    payload_fingerprint character(64),
    requested_at timestamptz NOT NULL,
    completed_at timestamptz,
    http_status integer,
    result_status text NOT NULL,
    observation_count integer NOT NULL DEFAULT 0,
    rejected_count integer NOT NULL DEFAULT 0,
    sanitized_error_code text,
    experiment_gate text NOT NULL DEFAULT 'EXPERIMENT_ONLY',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_raw_webapi_fetch_batch_key
        UNIQUE (batch_key),
    -- Referenced by raw.webapi_metric_observation so an observation's store must
    -- equal its batch's store.
    CONSTRAINT uq_raw_webapi_fetch_batch_store_ref
        UNIQUE (webapi_fetch_batch_id, store_code),
    CONSTRAINT uq_raw_webapi_fetch_batch_idempotency
        UNIQUE (store_code, endpoint_code, requested_at, request_fingerprint),
    -- Canonical store and Profile keys only: a bare DL or MZ cannot be stored.
    CONSTRAINT ck_raw_webapi_fetch_batch_store_code
        CHECK (store_code IN ('DL5477', 'MZ2406')),
    CONSTRAINT ck_raw_webapi_fetch_batch_profile_key
        CHECK (profile_key = 'persistent-' || lower(store_code) || '-profile'),
    CONSTRAINT ck_raw_webapi_fetch_batch_endpoint
        CHECK (
            endpoint_code IN (
                'HOME_DATA_OVERVIEW_LIST',
                'HOME_TEMPLATE_LIST',
                'HOME_DATA_OVERVIEW_DETAIL',
                'HOME_V4_DETAIL',
                'HOME_KEY_INDICATOR_TRENDS'
            )
        ),
    CONSTRAINT ck_raw_webapi_fetch_batch_method
        CHECK (http_method IN ('GET', 'POST')),
    CONSTRAINT ck_raw_webapi_fetch_batch_result
        CHECK (result_status IN ('SCHEMA_ONLY', 'FAILED', 'BLOCKED')),
    CONSTRAINT ck_raw_webapi_fetch_batch_gate
        CHECK (experiment_gate = 'EXPERIMENT_ONLY'),
    CONSTRAINT ck_raw_webapi_fetch_batch_hashes
        CHECK (
            batch_key ~ '^[0-9a-f]{64}$'
            AND request_schema_hash ~ '^[0-9a-f]{64}$'
            AND request_fingerprint ~ '^[0-9a-f]{64}$'
            AND (response_schema_hash IS NULL OR response_schema_hash ~ '^[0-9a-f]{64}$')
            AND (payload_fingerprint IS NULL OR payload_fingerprint ~ '^[0-9a-f]{64}$')
        ),
    CONSTRAINT ck_raw_webapi_fetch_batch_http_status
        CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
    CONSTRAINT ck_raw_webapi_fetch_batch_counts
        CHECK (observation_count >= 0 AND rejected_count >= 0),
    CONSTRAINT ck_raw_webapi_fetch_batch_error_code
        CHECK (
            sanitized_error_code IS NULL
            OR sanitized_error_code ~ '^[A-Z][A-Z0-9_]{2,60}$'
        ),
    CONSTRAINT ck_raw_webapi_fetch_batch_timeline
        CHECK (completed_at IS NULL OR completed_at >= requested_at),
    -- Only a schema-only success may carry observations.
    CONSTRAINT ck_raw_webapi_fetch_batch_success_shape
        CHECK (
            result_status = 'SCHEMA_ONLY'
            OR (observation_count = 0 AND rejected_count = 0)
        )
);

CREATE INDEX IF NOT EXISTS ix_raw_webapi_fetch_batch_store_endpoint
    ON raw.webapi_fetch_batch (store_code, endpoint_code, requested_at DESC);

COMMENT ON TABLE raw.webapi_fetch_batch IS
    'Safe WebAPI experiment request metadata only: canonical store/profile key, endpoint code, schema hashes, payload fingerprint, timing, HTTP status and sanitized error code. No Cookie, Authorization, token, password, full header or PII column exists.';

DROP TRIGGER IF EXISTS trg_raw_webapi_fetch_batch_append_only ON raw.webapi_fetch_batch;
CREATE TRIGGER trg_raw_webapi_fetch_batch_append_only
BEFORE UPDATE OR DELETE ON raw.webapi_fetch_batch
FOR EACH ROW EXECUTE FUNCTION ops.reject_webapi_evidence_mutation();

CREATE TABLE IF NOT EXISTS raw.webapi_metric_observation (
    webapi_metric_observation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Deterministic per-row key so an accepted and a rejected observation for the
    -- same platform metric can coexist without either overwriting the other.
    observation_key character(64) NOT NULL,
    webapi_fetch_batch_id bigint NOT NULL,
    store_code text NOT NULL,
    -- Nullable only so a REJECTED row can record an unusable platform identifier.
    -- Accepted rows are forced to carry and validate both fields below.
    meta_index_id integer,
    metric_code text,
    -- Exact platform text plus an exact numeric mirror. Never floating point.
    raw_value_text text,
    raw_decimal_value numeric(38, 10),
    currency character(3),
    source_update_time timestamptz,
    observed_at timestamptz NOT NULL,
    business_date date,
    semantic_status text NOT NULL DEFAULT 'UNMAPPED',
    sanitized_reject_code text,
    definition_meta_index_id integer,
    definition_metric_code text,
    definition_effective_from date,
    -- Pinned so the definition foreign key proves the cited definition version is
    -- itself VERIFIED, rather than merely that some definition row exists.
    definition_mapping_status text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- A DL observation cannot be filed under an MZ batch, or the reverse.
    CONSTRAINT fk_raw_webapi_metric_observation_batch
        FOREIGN KEY (webapi_fetch_batch_id, store_code)
        REFERENCES raw.webapi_fetch_batch (webapi_fetch_batch_id, store_code)
        ON DELETE RESTRICT,
    CONSTRAINT fk_raw_webapi_metric_observation_definition
        FOREIGN KEY (
            definition_meta_index_id,
            definition_metric_code,
            definition_effective_from,
            definition_mapping_status
        )
        REFERENCES dim.webapi_metric_definition (
            meta_index_id,
            metric_code,
            effective_from,
            mapping_status
        )
        ON DELETE RESTRICT,
    CONSTRAINT uq_raw_webapi_metric_observation_grain
        UNIQUE (webapi_fetch_batch_id, observation_key),
    CONSTRAINT ck_raw_webapi_metric_observation_key
        CHECK (observation_key ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_raw_webapi_metric_observation_store_code
        CHECK (store_code IN ('DL5477', 'MZ2406')),
    -- Accepted rows always carry a valid platform identifier pair.
    CONSTRAINT ck_raw_webapi_metric_observation_accepted_identity
        CHECK (
            semantic_status = 'REJECTED'
            OR (meta_index_id IS NOT NULL AND metric_code IS NOT NULL)
        ),
    CONSTRAINT ck_raw_webapi_metric_observation_meta_index
        CHECK (
            meta_index_id IS NULL
            OR (meta_index_id > 0 AND meta_index_id <= 1000000)
        ),
    CONSTRAINT ck_raw_webapi_metric_observation_metric_code
        CHECK (
            metric_code IS NULL
            OR metric_code ~ '^[A-Z]{2,8}[0-9]{4,10}$'
        ),
    CONSTRAINT ck_raw_webapi_metric_observation_semantic
        CHECK (semantic_status IN ('UNMAPPED', 'VERIFIED', 'REJECTED')),
    CONSTRAINT ck_raw_webapi_metric_observation_currency
        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    -- Accepted rows carry a canonical decimal string; rejected rows never keep
    -- the raw payload, only a sanitized reason.
    CONSTRAINT ck_raw_webapi_metric_observation_decimal
        CHECK (
            semantic_status = 'REJECTED'
            OR (
                raw_value_text IS NOT NULL
                AND raw_value_text ~ '^-?(0|[1-9][0-9]{0,27})(\.[0-9]{1,10})?$'
                AND raw_decimal_value IS NOT NULL
                AND raw_decimal_value = raw_value_text::numeric
            )
        ),
    CONSTRAINT ck_raw_webapi_metric_observation_rejected
        CHECK (
            semantic_status <> 'REJECTED'
            OR (
                raw_value_text IS NULL
                AND raw_decimal_value IS NULL
                AND sanitized_reject_code IS NOT NULL
            )
        ),
    CONSTRAINT ck_raw_webapi_metric_observation_reject_code
        CHECK (
            sanitized_reject_code IS NULL
            OR sanitized_reject_code ~ '^[A-Z][A-Z0-9_]{2,60}$'
        ),
    -- VERIFIED is impossible without a matching versioned definition whose own
    -- mapping status is VERIFIED.
    CONSTRAINT ck_raw_webapi_metric_observation_verified_needs_definition
        CHECK (
            semantic_status <> 'VERIFIED'
            OR (
                definition_meta_index_id = meta_index_id
                AND definition_metric_code = metric_code
                AND definition_effective_from IS NOT NULL
                AND definition_mapping_status = 'VERIFIED'
            )
        ),
    -- A cited definition is always fully specified, so a partially filled
    -- reference cannot bypass the VERIFIED proof above.
    CONSTRAINT ck_raw_webapi_metric_observation_definition_shape
        CHECK (
            (
                definition_meta_index_id IS NULL
                AND definition_metric_code IS NULL
                AND definition_effective_from IS NULL
                AND definition_mapping_status IS NULL
            )
            OR (
                definition_meta_index_id IS NOT NULL
                AND definition_metric_code IS NOT NULL
                AND definition_effective_from IS NOT NULL
                AND definition_mapping_status IS NOT NULL
            )
        )
);

CREATE INDEX IF NOT EXISTS ix_raw_webapi_metric_observation_store_metric
    ON raw.webapi_metric_observation (
        store_code,
        meta_index_id,
        metric_code,
        observed_at DESC
    );

CREATE INDEX IF NOT EXISTS ix_raw_webapi_metric_observation_semantic
    ON raw.webapi_metric_observation (semantic_status, observed_at DESC);

COMMENT ON TABLE raw.webapi_metric_observation IS
    'Isolated WebAPI metric observations. Values stay exact decimal strings with an exact numeric mirror; nothing is projected into a formal fact, mart or dashboard while semantic_status is UNMAPPED.';

DROP TRIGGER IF EXISTS trg_raw_webapi_metric_observation_append_only
    ON raw.webapi_metric_observation;
CREATE TRIGGER trg_raw_webapi_metric_observation_append_only
BEFORE UPDATE OR DELETE ON raw.webapi_metric_observation
FOR EACH ROW EXECUTE FUNCTION ops.reject_webapi_evidence_mutation();

CREATE TABLE IF NOT EXISTS ops.webapi_session_health (
    webapi_session_health_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_code text NOT NULL,
    profile_key text NOT NULL,
    observed_at timestamptz NOT NULL,
    session_state text NOT NULL,
    last_success_at timestamptz,
    response_schema_hash character(64),
    latency_ms integer,
    consecutive_failure_count integer NOT NULL DEFAULT 0,
    sanitized_error_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_ops_webapi_session_health_store_code
        CHECK (store_code IN ('DL5477', 'MZ2406')),
    CONSTRAINT ck_ops_webapi_session_health_profile_key
        CHECK (profile_key = 'persistent-' || lower(store_code) || '-profile'),
    CONSTRAINT ck_ops_webapi_session_health_state
        CHECK (session_state IN ('ACTIVE', 'STALE', 'EXPIRED', 'BLOCKED', 'UNKNOWN')),
    CONSTRAINT ck_ops_webapi_session_health_hash
        CHECK (response_schema_hash IS NULL OR response_schema_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ops_webapi_session_health_latency
        CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 600000),
    CONSTRAINT ck_ops_webapi_session_health_failures
        CHECK (consecutive_failure_count >= 0),
    CONSTRAINT ck_ops_webapi_session_health_error_code
        CHECK (
            sanitized_error_code IS NULL
            OR sanitized_error_code ~ '^[A-Z][A-Z0-9_]{2,60}$'
        )
);

CREATE INDEX IF NOT EXISTS ix_ops_webapi_session_health_store
    ON ops.webapi_session_health (store_code, observed_at DESC);

COMMENT ON TABLE ops.webapi_session_health IS
    'Login-state diagnostics per canonical store and Profile key. It records state, timing, schema hash and sanitized errors only; it never reads or echoes a secret value.';

DROP TRIGGER IF EXISTS trg_ops_webapi_session_health_append_only
    ON ops.webapi_session_health;
CREATE TRIGGER trg_ops_webapi_session_health_append_only
BEFORE UPDATE OR DELETE ON ops.webapi_session_health
FOR EACH ROW EXECUTE FUNCTION ops.reject_webapi_evidence_mutation();

COMMIT;
