BEGIN;

CREATE TABLE IF NOT EXISTS dim.canonical_product (
    canonical_product_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    canonical_product_key text NOT NULL,
    display_name text NOT NULL,
    brand_normalized text,
    category_normalized text,
    model_normalized text,
    barcode_normalized text,
    core_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_payload_fingerprint character(64) NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_dim_canonical_product_key
        UNIQUE (canonical_product_key),
    CONSTRAINT ck_dim_canonical_product_key
        CHECK (canonical_product_key <> ''),
    CONSTRAINT ck_dim_canonical_product_attributes
        CHECK (jsonb_typeof(core_attributes) = 'object'),
    CONSTRAINT ck_dim_canonical_product_fingerprint
        CHECK (source_payload_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_dim_canonical_product_status
        CHECK (status IN ('ACTIVE', 'RETIRED'))
);

CREATE INDEX IF NOT EXISTS ix_dim_canonical_product_status
    ON dim.canonical_product (status, canonical_product_key);

COMMENT ON TABLE dim.canonical_product IS
    'Global canonical product identities shared by store-scoped SKU assignments. Platform SKU, SKC and SPU identifiers are never treated as cross-store identities.';
COMMENT ON COLUMN dim.canonical_product.source_payload_fingerprint IS
    'Stable hash used to fail closed when an idempotent create is retried with drifted canonical source data.';

CREATE TABLE IF NOT EXISTS dim.canonical_variant (
    canonical_variant_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    canonical_product_id bigint NOT NULL
        REFERENCES dim.canonical_product (canonical_product_id) ON DELETE RESTRICT,
    canonical_variant_key text NOT NULL,
    display_name text NOT NULL,
    variant_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
    voltage_normalized text,
    plug_normalized text,
    capacity_normalized text,
    dimensions_normalized text,
    source_payload_fingerprint character(64) NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_dim_canonical_variant_product_key
        UNIQUE (canonical_product_id, canonical_variant_key),
    CONSTRAINT uq_dim_canonical_variant_product_id
        UNIQUE (canonical_product_id, canonical_variant_id),
    CONSTRAINT ck_dim_canonical_variant_key
        CHECK (canonical_variant_key <> ''),
    CONSTRAINT ck_dim_canonical_variant_attributes
        CHECK (jsonb_typeof(variant_attributes) = 'object'),
    CONSTRAINT ck_dim_canonical_variant_fingerprint
        CHECK (source_payload_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_dim_canonical_variant_status
        CHECK (status IN ('ACTIVE', 'RETIRED'))
);

CREATE INDEX IF NOT EXISTS ix_dim_canonical_variant_product
    ON dim.canonical_variant (canonical_product_id, status, canonical_variant_key);

COMMENT ON TABLE dim.canonical_variant IS
    'Global canonical variants under a canonical product. Voltage, plug, capacity and dimensions remain explicit hard-separation fields.';

CREATE TABLE IF NOT EXISTS raw.identifier_observation (
    identifier_observation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    full_sku_id bigint NOT NULL,
    observation_key text NOT NULL,
    identifier_type text NOT NULL,
    raw_value text NOT NULL,
    normalized_value text,
    source_system text NOT NULL,
    source_field text NOT NULL,
    source_fetch_batch_id bigint
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    payload_fingerprint character(64) NOT NULL,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    observed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_raw_identifier_observation_store_sku
        FOREIGN KEY (store_id, full_sku_id)
        REFERENCES dim.full_sku (store_id, full_sku_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_raw_identifier_observation_store_key
        UNIQUE (store_id, observation_key),
    CONSTRAINT ck_raw_identifier_observation_key
        CHECK (observation_key <> ''),
    CONSTRAINT ck_raw_identifier_observation_type
        CHECK (
            identifier_type IN (
                'PLATFORM_SKU', 'PLATFORM_SKC', 'PLATFORM_SPU',
                'SUPPLIER_SKU', 'SUPPLIER_CODE', 'BARCODE', 'MODEL',
                'BRAND', 'CATEGORY', 'VOLTAGE', 'PLUG', 'CAPACITY',
                'DIMENSIONS', 'CORE_ATTRIBUTE'
            )
        ),
    CONSTRAINT ck_raw_identifier_observation_raw_value
        CHECK (raw_value <> ''),
    CONSTRAINT ck_raw_identifier_observation_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_raw_identifier_observation_evidence
        CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE INDEX IF NOT EXISTS ix_raw_identifier_observation_lookup
    ON raw.identifier_observation (
        store_id, identifier_type, normalized_value, observed_at DESC
    );

COMMENT ON TABLE raw.identifier_observation IS
    'Append-only source identifier evidence. Raw values can be added but never overwritten or deleted.';
COMMENT ON COLUMN raw.identifier_observation.normalized_value IS
    'Comparison aid only. It never replaces raw_value as the source evidence.';

CREATE OR REPLACE FUNCTION ops.distinct_identity_evidence_count(values_to_count text[])
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT count(DISTINCT evidence_type)::integer
      FROM unnest(values_to_count) AS evidence_type
     WHERE evidence_type <> ''
$$;

CREATE TABLE IF NOT EXISTS ops.product_match_candidate (
    product_match_candidate_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    full_sku_id bigint NOT NULL,
    canonical_product_id bigint NOT NULL,
    canonical_variant_id bigint,
    candidate_key text NOT NULL,
    score numeric(6,5) NOT NULL,
    recommendation text NOT NULL,
    strong_evidence_types text[] NOT NULL DEFAULT ARRAY[]::text[],
    matched_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    hard_conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
    payload_fingerprint character(64) NOT NULL,
    evaluated_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_ops_product_match_candidate_store_sku
        FOREIGN KEY (store_id, full_sku_id)
        REFERENCES dim.full_sku (store_id, full_sku_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_ops_product_match_candidate_product
        FOREIGN KEY (canonical_product_id)
        REFERENCES dim.canonical_product (canonical_product_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_ops_product_match_candidate_variant
        FOREIGN KEY (canonical_product_id, canonical_variant_id)
        REFERENCES dim.canonical_variant (
            canonical_product_id, canonical_variant_id
        )
        ON DELETE RESTRICT,
    CONSTRAINT uq_ops_product_match_candidate_store_key
        UNIQUE (store_id, candidate_key),
    CONSTRAINT uq_ops_product_match_candidate_store_id
        UNIQUE (store_id, product_match_candidate_id),
    CONSTRAINT ck_ops_product_match_candidate_key
        CHECK (candidate_key <> ''),
    CONSTRAINT ck_ops_product_match_candidate_score
        CHECK (score >= 0 AND score <= 1),
    CONSTRAINT ck_ops_product_match_candidate_recommendation
        CHECK (recommendation IN ('CONFIRMED', 'PROPOSED', 'REVIEW_REQUIRED', 'BLOCKED')),
    CONSTRAINT ck_ops_product_match_candidate_strong_evidence_types
        CHECK (
            strong_evidence_types <@
                ARRAY['BARCODE', 'MODEL', 'BRAND_CATEGORY', 'CORE_ATTRIBUTES']::text[]
        ),
    CONSTRAINT ck_ops_product_match_candidate_evidence
        CHECK (
            jsonb_typeof(matched_evidence) = 'array'
            AND jsonb_typeof(hard_conflicts) = 'array'
        ),
    CONSTRAINT ck_ops_product_match_candidate_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ops_product_match_candidate_auto_confirm
        CHECK (
            recommendation <> 'CONFIRMED'
            OR (
                score >= 0.95
                AND ops.distinct_identity_evidence_count(strong_evidence_types) >= 2
                AND jsonb_array_length(hard_conflicts) = 0
            )
        ),
    CONSTRAINT ck_ops_product_match_candidate_proposal_band
        CHECK (
            recommendation <> 'PROPOSED'
            OR (
                score >= 0.75
                AND score < 0.95
                AND jsonb_array_length(hard_conflicts) = 0
            )
        ),
    CONSTRAINT ck_ops_product_match_candidate_blocked
        CHECK (
            recommendation <> 'BLOCKED'
            OR jsonb_array_length(hard_conflicts) > 0
        )
);

CREATE INDEX IF NOT EXISTS ix_ops_product_match_candidate_review
    ON ops.product_match_candidate (store_id, recommendation, evaluated_at DESC);

COMMENT ON TABLE ops.product_match_candidate IS
    'Append-only, store-scoped match evaluations. A candidate is not an assignment until a decision is recorded.';

CREATE TABLE IF NOT EXISTS ops.product_identity_decision (
    product_identity_decision_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    product_match_candidate_id bigint NOT NULL,
    decision_key text NOT NULL,
    decision_outcome text NOT NULL,
    decision_source text NOT NULL,
    actor_key text NOT NULL,
    rationale text NOT NULL,
    payload_fingerprint character(64) NOT NULL,
    decided_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_ops_product_identity_decision_store_candidate
        FOREIGN KEY (store_id, product_match_candidate_id)
        REFERENCES ops.product_match_candidate (store_id, product_match_candidate_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_ops_product_identity_decision_store_key
        UNIQUE (store_id, decision_key),
    CONSTRAINT uq_ops_product_identity_decision_store_id
        UNIQUE (store_id, product_identity_decision_id),
    CONSTRAINT ck_ops_product_identity_decision_key
        CHECK (decision_key <> ''),
    CONSTRAINT ck_ops_product_identity_decision_outcome
        CHECK (decision_outcome IN ('CONFIRMED', 'REJECTED', 'DEFERRED', 'UNASSIGNED')),
    CONSTRAINT ck_ops_product_identity_decision_source
        CHECK (decision_source IN ('AUTO', 'HUMAN', 'SYSTEM')),
    CONSTRAINT ck_ops_product_identity_decision_actor
        CHECK (actor_key <> ''),
    CONSTRAINT ck_ops_product_identity_decision_rationale
        CHECK (rationale <> ''),
    CONSTRAINT ck_ops_product_identity_decision_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS ix_ops_product_identity_decision_candidate
    ON ops.product_identity_decision (
        store_id, product_match_candidate_id, decided_at DESC
    );

COMMENT ON TABLE ops.product_identity_decision IS
    'Append-only audit of automatic and human identity decisions.';

CREATE TABLE IF NOT EXISTS dim.full_sku_canonical_assignment (
    full_sku_canonical_assignment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    full_sku_id bigint NOT NULL,
    canonical_product_id bigint NOT NULL,
    canonical_variant_id bigint,
    product_identity_decision_id bigint NOT NULL,
    assignment_key text NOT NULL,
    assignment_status text NOT NULL,
    confidence numeric(6,5) NOT NULL,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    valid_from timestamptz NOT NULL,
    valid_to timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_dim_full_sku_canonical_assignment_store_sku
        FOREIGN KEY (store_id, full_sku_id)
        REFERENCES dim.full_sku (store_id, full_sku_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_dim_full_sku_canonical_assignment_product
        FOREIGN KEY (canonical_product_id)
        REFERENCES dim.canonical_product (canonical_product_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_dim_full_sku_canonical_assignment_variant
        FOREIGN KEY (canonical_product_id, canonical_variant_id)
        REFERENCES dim.canonical_variant (
            canonical_product_id, canonical_variant_id
        )
        ON DELETE RESTRICT,
    CONSTRAINT fk_dim_full_sku_canonical_assignment_store_decision
        FOREIGN KEY (store_id, product_identity_decision_id)
        REFERENCES ops.product_identity_decision (store_id, product_identity_decision_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_dim_full_sku_canonical_assignment_store_key
        UNIQUE (store_id, assignment_key),
    CONSTRAINT ck_dim_full_sku_canonical_assignment_key
        CHECK (assignment_key <> ''),
    CONSTRAINT ck_dim_full_sku_canonical_assignment_status
        CHECK (assignment_status IN ('CONFIRMED', 'SUPERSEDED', 'REVOKED')),
    CONSTRAINT ck_dim_full_sku_canonical_assignment_confidence
        CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT ck_dim_full_sku_canonical_assignment_evidence
        CHECK (jsonb_typeof(evidence) = 'object'),
    CONSTRAINT ck_dim_full_sku_canonical_assignment_validity
        CHECK (
            (
                assignment_status = 'CONFIRMED'
                AND valid_to IS NULL
            )
            OR (
                assignment_status IN ('SUPERSEDED', 'REVOKED')
                AND valid_to IS NOT NULL
                AND valid_to >= valid_from
            )
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dim_full_sku_canonical_assignment_current
    ON dim.full_sku_canonical_assignment (store_id, full_sku_id)
    WHERE assignment_status = 'CONFIRMED' AND valid_to IS NULL;

CREATE INDEX IF NOT EXISTS ix_dim_full_sku_canonical_assignment_product
    ON dim.full_sku_canonical_assignment (
        store_id, canonical_product_id, assignment_status
    );

COMMENT ON TABLE dim.full_sku_canonical_assignment IS
    'Audited temporal assignments. A store SKU can have at most one current confirmed canonical identity.';

CREATE TABLE IF NOT EXISTS ops.employee_principal (
    employee_principal_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    principal_key text NOT NULL,
    employee_code text,
    username text NOT NULL,
    display_name text NOT NULL,
    system_role text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_employee_principal_key UNIQUE (principal_key),
    CONSTRAINT uq_ops_employee_principal_username UNIQUE (username),
    CONSTRAINT uq_ops_employee_principal_employee_code UNIQUE (employee_code),
    CONSTRAINT ck_ops_employee_principal_key CHECK (principal_key <> ''),
    CONSTRAINT ck_ops_employee_principal_username CHECK (username <> ''),
    CONSTRAINT ck_ops_employee_principal_role
        CHECK (system_role IN ('ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER')),
    CONSTRAINT ck_ops_employee_principal_status
        CHECK (status IN ('ACTIVE', 'DISABLED'))
);

COMMENT ON TABLE ops.employee_principal IS
    'Global employee/login identity. All employees may read the BI; employee_store_assignment is evidence for future store-scoped write authorization.';

CREATE TABLE IF NOT EXISTS ops.employee_store_assignment (
    employee_store_assignment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    employee_principal_id bigint NOT NULL
        REFERENCES ops.employee_principal (employee_principal_id) ON DELETE RESTRICT,
    assignment_key text NOT NULL,
    assignment_role text NOT NULL,
    assignment_status text NOT NULL DEFAULT 'ACTIVE',
    assigned_by_principal_id bigint
        REFERENCES ops.employee_principal (employee_principal_id) ON DELETE RESTRICT,
    ended_by_principal_id bigint
        REFERENCES ops.employee_principal (employee_principal_id) ON DELETE RESTRICT,
    reason text NOT NULL,
    ended_reason text,
    payload_fingerprint character(64) NOT NULL,
    valid_from timestamptz NOT NULL,
    valid_to timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_employee_store_assignment_store_key
        UNIQUE (store_id, assignment_key),
    CONSTRAINT ck_ops_employee_store_assignment_key
        CHECK (assignment_key <> ''),
    CONSTRAINT ck_ops_employee_store_assignment_role
        CHECK (assignment_role IN ('PRIMARY', 'SUPPORT', 'VIEWER')),
    CONSTRAINT ck_ops_employee_store_assignment_status
        CHECK (assignment_status IN ('ACTIVE', 'ENDED')),
    CONSTRAINT ck_ops_employee_store_assignment_reason
        CHECK (
            reason <> ''
            AND (ended_reason IS NULL OR ended_reason <> '')
        ),
    CONSTRAINT ck_ops_employee_store_assignment_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ops_employee_store_assignment_validity
        CHECK (
            (
                assignment_status = 'ACTIVE'
                AND valid_to IS NULL
                AND ended_by_principal_id IS NULL
                AND ended_reason IS NULL
            )
            OR (
                assignment_status = 'ENDED'
                AND valid_to IS NOT NULL
                AND valid_to >= valid_from
                AND ended_reason IS NOT NULL
            )
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_employee_store_assignment_current_employee
    ON ops.employee_store_assignment (store_id, employee_principal_id)
    WHERE assignment_status = 'ACTIVE' AND valid_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_employee_store_assignment_current_primary
    ON ops.employee_store_assignment (store_id)
    WHERE (
        assignment_role = 'PRIMARY'
        AND assignment_status = 'ACTIVE'
        AND valid_to IS NULL
    );

CREATE INDEX IF NOT EXISTS ix_ops_employee_store_assignment_principal
    ON ops.employee_store_assignment (
        employee_principal_id, assignment_status, store_id
    );

COMMENT ON TABLE ops.employee_store_assignment IS
    'Temporal employee-to-store scope. Each store has at most one current PRIMARY owner.';

CREATE OR REPLACE FUNCTION ops.reject_append_only_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_raw_identifier_observation_append_only
    ON raw.identifier_observation;
CREATE TRIGGER trg_raw_identifier_observation_append_only
BEFORE UPDATE OR DELETE ON raw.identifier_observation
FOR EACH ROW EXECUTE FUNCTION ops.reject_append_only_identity_mutation();

DROP TRIGGER IF EXISTS trg_ops_product_match_candidate_append_only
    ON ops.product_match_candidate;
CREATE TRIGGER trg_ops_product_match_candidate_append_only
BEFORE UPDATE OR DELETE ON ops.product_match_candidate
FOR EACH ROW EXECUTE FUNCTION ops.reject_append_only_identity_mutation();

DROP TRIGGER IF EXISTS trg_ops_product_identity_decision_append_only
    ON ops.product_identity_decision;
CREATE TRIGGER trg_ops_product_identity_decision_append_only
BEFORE UPDATE OR DELETE ON ops.product_identity_decision
FOR EACH ROW EXECUTE FUNCTION ops.reject_append_only_identity_mutation();

DROP TRIGGER IF EXISTS trg_dim_canonical_product_touch_updated_at
    ON dim.canonical_product;
CREATE TRIGGER trg_dim_canonical_product_touch_updated_at
BEFORE UPDATE ON dim.canonical_product
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_dim_canonical_variant_touch_updated_at
    ON dim.canonical_variant;
CREATE TRIGGER trg_dim_canonical_variant_touch_updated_at
BEFORE UPDATE ON dim.canonical_variant
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_dim_full_sku_canonical_assignment_touch_updated_at
    ON dim.full_sku_canonical_assignment;
CREATE TRIGGER trg_dim_full_sku_canonical_assignment_touch_updated_at
BEFORE UPDATE ON dim.full_sku_canonical_assignment
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_ops_employee_principal_touch_updated_at
    ON ops.employee_principal;
CREATE TRIGGER trg_ops_employee_principal_touch_updated_at
BEFORE UPDATE ON ops.employee_principal
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_ops_employee_store_assignment_touch_updated_at
    ON ops.employee_store_assignment;
CREATE TRIGGER trg_ops_employee_store_assignment_touch_updated_at
BEFORE UPDATE ON ops.employee_store_assignment
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_app') THEN
        GRANT SELECT, INSERT, UPDATE
            ON dim.canonical_product, dim.canonical_variant,
               dim.full_sku_canonical_assignment
            TO sheinfm_app;
        GRANT SELECT, INSERT
            ON raw.identifier_observation,
               ops.product_match_candidate, ops.product_identity_decision
            TO sheinfm_app;
        GRANT SELECT, INSERT, UPDATE
            ON ops.employee_principal, ops.employee_store_assignment
            TO sheinfm_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dim TO sheinfm_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA raw TO sheinfm_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO sheinfm_app;
    END IF;
END;
$$;

COMMIT;
