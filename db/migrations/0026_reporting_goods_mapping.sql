BEGIN;

CREATE TABLE IF NOT EXISTS dim.reporting_goods (
    reporting_goods_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    standard_goods_code text NOT NULL,
    display_name text NOT NULL,
    model_normalized text,
    naming_rule text NOT NULL,
    source_plan_hash character(64) NOT NULL,
    source_group_fingerprint character(64) NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_dim_reporting_goods_code UNIQUE (standard_goods_code),
    CONSTRAINT ck_dim_reporting_goods_code
        CHECK (length(btrim(standard_goods_code)) BETWEEN 2 AND 160),
    CONSTRAINT ck_dim_reporting_goods_display
        CHECK (length(btrim(display_name)) BETWEEN 2 AND 200),
    CONSTRAINT ck_dim_reporting_goods_rule
        CHECK (naming_rule IN ('MODEL_PLUS_SHEIN_LEAF', 'PURE_CHINESE')),
    CONSTRAINT ck_dim_reporting_goods_hashes
        CHECK (
            source_plan_hash ~ '^[0-9a-f]{64}$'
            AND source_group_fingerprint ~ '^[0-9a-f]{64}$'
        ),
    CONSTRAINT ck_dim_reporting_goods_status
        CHECK (status IN ('ACTIVE', 'RETIRED'))
);

COMMENT ON TABLE dim.reporting_goods IS
    'Owner-confirmed reporting labels for BI aggregation. This table is separate from strict cross-store canonical product identity and never edits SHEIN products.';

CREATE TABLE IF NOT EXISTS ops.reporting_goods_import_run (
    plan_hash character(64) PRIMARY KEY,
    manifest_version integer NOT NULL,
    approval_actor text NOT NULL,
    approval_text text NOT NULL,
    source_generated_at timestamptz NOT NULL,
    approved_at timestamptz NOT NULL,
    group_count integer NOT NULL,
    assignment_count integer NOT NULL,
    excluded_sku_count integer NOT NULL,
    result_status text NOT NULL,
    applied_at timestamptz,
    rolled_back_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_ops_reporting_goods_import_hash
        CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ops_reporting_goods_import_version
        CHECK (manifest_version >= 1),
    CONSTRAINT ck_ops_reporting_goods_import_actor
        CHECK (length(btrim(approval_actor)) BETWEEN 2 AND 80),
    CONSTRAINT ck_ops_reporting_goods_import_approval
        CHECK (length(btrim(approval_text)) BETWEEN 4 AND 500),
    CONSTRAINT ck_ops_reporting_goods_import_counts
        CHECK (group_count >= 0 AND assignment_count >= 0 AND excluded_sku_count >= 0),
    CONSTRAINT ck_ops_reporting_goods_import_status
        CHECK (result_status IN ('APPLIED', 'ROLLED_BACK')),
    CONSTRAINT ck_ops_reporting_goods_import_times
        CHECK (
            (result_status = 'APPLIED' AND applied_at IS NOT NULL AND rolled_back_at IS NULL)
            OR (result_status = 'ROLLED_BACK' AND applied_at IS NOT NULL AND rolled_back_at IS NOT NULL)
        )
);

COMMENT ON TABLE ops.reporting_goods_import_run IS
    'Immutable plan-level audit for owner-confirmed BI reporting-goods imports and safe rollback.';

CREATE TABLE IF NOT EXISTS dim.full_sku_reporting_goods_assignment (
    full_sku_reporting_goods_assignment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    full_sku_id bigint NOT NULL,
    reporting_goods_id bigint NOT NULL
        REFERENCES dim.reporting_goods (reporting_goods_id) ON DELETE RESTRICT,
    assignment_key character(64) NOT NULL,
    assignment_status text NOT NULL,
    confidence_band text NOT NULL,
    source_plan_hash character(64) NOT NULL
        REFERENCES ops.reporting_goods_import_run (plan_hash) ON DELETE RESTRICT,
    superseded_by_plan_hash character(64)
        REFERENCES ops.reporting_goods_import_run (plan_hash) ON DELETE RESTRICT,
    source_group_fingerprint character(64) NOT NULL,
    approval_actor text NOT NULL,
    approval_text text NOT NULL,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    valid_from timestamptz NOT NULL,
    valid_to timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_dim_full_sku_reporting_store_sku
        FOREIGN KEY (store_id, full_sku_id)
        REFERENCES dim.full_sku (store_id, full_sku_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_dim_full_sku_reporting_assignment_key UNIQUE (assignment_key),
    CONSTRAINT ck_dim_full_sku_reporting_assignment_key
        CHECK (assignment_key ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_dim_full_sku_reporting_assignment_status
        CHECK (assignment_status IN ('CONFIRMED', 'SUPERSEDED', 'REVOKED')),
    CONSTRAINT ck_dim_full_sku_reporting_confidence
        CHECK (confidence_band IN ('HIGH', 'MEDIUM', 'LOW')),
    CONSTRAINT ck_dim_full_sku_reporting_group_hash
        CHECK (source_group_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_dim_full_sku_reporting_approval
        CHECK (
            length(btrim(approval_actor)) BETWEEN 2 AND 80
            AND length(btrim(approval_text)) BETWEEN 4 AND 500
        ),
    CONSTRAINT ck_dim_full_sku_reporting_evidence
        CHECK (jsonb_typeof(evidence) = 'object'),
    CONSTRAINT ck_dim_full_sku_reporting_validity
        CHECK (
            (
                assignment_status = 'CONFIRMED'
                AND valid_to IS NULL
                AND superseded_by_plan_hash IS NULL
            )
            OR (
                assignment_status = 'SUPERSEDED'
                AND valid_to IS NOT NULL
                AND valid_to >= valid_from
                AND superseded_by_plan_hash IS NOT NULL
            )
            OR (
                assignment_status = 'REVOKED'
                AND valid_to IS NOT NULL
                AND valid_to >= valid_from
                AND superseded_by_plan_hash IS NULL
            )
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dim_full_sku_reporting_current
    ON dim.full_sku_reporting_goods_assignment (store_id, full_sku_id)
    WHERE assignment_status = 'CONFIRMED' AND valid_to IS NULL;

CREATE INDEX IF NOT EXISTS ix_dim_full_sku_reporting_goods
    ON dim.full_sku_reporting_goods_assignment (
        reporting_goods_id, assignment_status, store_id, full_sku_id
    );

CREATE INDEX IF NOT EXISTS ix_dim_full_sku_reporting_plan
    ON dim.full_sku_reporting_goods_assignment (
        source_plan_hash, assignment_status, store_id, full_sku_id
    );

CREATE INDEX IF NOT EXISTS ix_dim_full_sku_reporting_superseded_by
    ON dim.full_sku_reporting_goods_assignment (
        superseded_by_plan_hash, assignment_status, store_id, full_sku_id
    )
    WHERE superseded_by_plan_hash IS NOT NULL;

COMMENT ON TABLE dim.full_sku_reporting_goods_assignment IS
    'Temporal owner-confirmed BI reporting assignments. They aggregate dashboard rankings but remain independent from strict canonical product identity.';

COMMIT;
