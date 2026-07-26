BEGIN;

-- A resolution plan must select one explicit evidence run.  The run id is
-- stored on the immutable observation envelope; it is never reconstructed by
-- parsing raw.openapi_fetch_batch.idempotency_key.
ALTER TABLE raw.product_identity_observation_set
    ADD COLUMN IF NOT EXISTS observation_run_id text;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM raw.product_identity_observation_set
         WHERE observation_run_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'product identity observation sets without observation_run_id must be resolved before migration; batch keys are not parsed'
            USING ERRCODE = '23502';
    END IF;
END;
$$;

ALTER TABLE raw.product_identity_observation_set
    ALTER COLUMN observation_run_id SET NOT NULL;

ALTER TABLE raw.product_identity_observation_set
    DROP CONSTRAINT IF EXISTS ck_raw_product_identity_observation_set_run;
ALTER TABLE raw.product_identity_observation_set
    ADD CONSTRAINT ck_raw_product_identity_observation_set_run
    CHECK (
        observation_run_id ~ '^[A-Za-z0-9._:-]{8,120}$'
    );

ALTER TABLE raw.product_identity_observation_set
    DROP CONSTRAINT IF EXISTS ck_raw_product_identity_observation_set_lifecycle;
ALTER TABLE raw.product_identity_observation_set
    ADD CONSTRAINT ck_raw_product_identity_observation_set_lifecycle
    CHECK (
        (
            status = 'BUILDING'
            AND member_count = 0
            AND sealed_at IS NULL
        )
        OR (
            status = 'SEALED'
            AND member_count > 0
            AND sealed_at IS NOT NULL
            AND sealed_at >= source_fetched_at
        )
    );

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'uq_raw_product_identity_set_resolution_ref'
           AND conrelid = 'raw.product_identity_observation_set'::regclass
    ) THEN
        ALTER TABLE raw.product_identity_observation_set
            ADD CONSTRAINT uq_raw_product_identity_set_resolution_ref
            UNIQUE (
                identity_observation_set_id,
                store_id,
                full_sku_id,
                source_fetch_batch_id,
                observation_run_id,
                status
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'uq_raw_identifier_observation_set_member'
           AND conrelid = 'raw.identifier_observation'::regclass
    ) THEN
        ALTER TABLE raw.identifier_observation
            ADD CONSTRAINT uq_raw_identifier_observation_set_member
            UNIQUE (
                identifier_observation_id,
                identity_observation_set_id
            );
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS ix_raw_product_identity_set_run
    ON raw.product_identity_observation_set (
        observation_run_id,
        store_id,
        source_fetch_batch_id,
        full_sku_id
    )
    WHERE status = 'SEALED';

COMMENT ON COLUMN raw.product_identity_observation_set.observation_run_id IS
    'Explicit caller-owned evidence run id. Candidate planning must select this field directly and must never parse a fetch-batch idempotency key.';

ALTER TABLE dim.canonical_product
    ADD COLUMN IF NOT EXISTS identity_scope text,
    ADD COLUMN IF NOT EXISTS identity_component_key character(64),
    ADD COLUMN IF NOT EXISTS evidence_policy_version text,
    ADD COLUMN IF NOT EXISTS provenance_fingerprint character(64);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM dim.canonical_product
         WHERE identity_scope IS NULL
            OR identity_component_key IS NULL
            OR evidence_policy_version IS NULL
            OR provenance_fingerprint IS NULL
    ) THEN
        RAISE EXCEPTION
            'legacy canonical products require an explicit reviewed resolution migration'
            USING ERRCODE = '23502';
    END IF;
END;
$$;

ALTER TABLE dim.canonical_product
    ALTER COLUMN identity_scope SET NOT NULL,
    ALTER COLUMN identity_component_key SET NOT NULL,
    ALTER COLUMN evidence_policy_version SET NOT NULL,
    ALTER COLUMN provenance_fingerprint SET NOT NULL;

ALTER TABLE dim.canonical_product
    DROP CONSTRAINT IF EXISTS ck_dim_canonical_product_identity_scope;
ALTER TABLE dim.canonical_product
    ADD CONSTRAINT ck_dim_canonical_product_identity_scope
    CHECK (identity_scope IN ('GLOBAL', 'LOCAL_SINGLETON'));

ALTER TABLE dim.canonical_product
    DROP CONSTRAINT IF EXISTS ck_dim_canonical_product_resolution_metadata;
ALTER TABLE dim.canonical_product
    ADD CONSTRAINT ck_dim_canonical_product_resolution_metadata
    CHECK (
        identity_component_key ~ '^[0-9a-f]{64}$'
        AND evidence_policy_version <> ''
        AND provenance_fingerprint ~ '^[0-9a-f]{64}$'
    );

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'uq_dim_canonical_product_resolution_ref'
           AND conrelid = 'dim.canonical_product'::regclass
    ) THEN
        ALTER TABLE dim.canonical_product
            ADD CONSTRAINT uq_dim_canonical_product_resolution_ref
            UNIQUE (
                canonical_product_id,
                identity_scope,
                identity_component_key
            );
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS ix_dim_canonical_product_scope_status
    ON dim.canonical_product (
        identity_scope,
        status,
        canonical_product_key
    );

COMMENT ON COLUMN dim.canonical_product.identity_scope IS
    'GLOBAL identities may aggregate across stores. LOCAL_SINGLETON identities remain store-local and must not enter the global standard-product ranking.';

CREATE TABLE IF NOT EXISTS ops.canonical_product_observation_set (
    canonical_product_observation_set_id bigint
        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    canonical_product_id bigint NOT NULL,
    identity_scope text NOT NULL,
    identity_component_key character(64) NOT NULL,
    identity_observation_set_id bigint NOT NULL,
    store_id bigint NOT NULL,
    full_sku_id bigint NOT NULL,
    source_fetch_batch_id bigint NOT NULL,
    observation_run_id text NOT NULL,
    set_status text NOT NULL DEFAULT 'SEALED',
    product_node_key character(64) NOT NULL,
    is_match_representative boolean NOT NULL DEFAULT false,
    provenance_role text NOT NULL,
    payload_fingerprint character(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_ops_canonical_product_observation_product
        FOREIGN KEY (
            canonical_product_id,
            identity_scope,
            identity_component_key
        )
        REFERENCES dim.canonical_product (
            canonical_product_id,
            identity_scope,
            identity_component_key
        )
        ON DELETE RESTRICT,
    CONSTRAINT fk_ops_canonical_product_observation_sealed_set
        FOREIGN KEY (
            identity_observation_set_id,
            store_id,
            full_sku_id,
            source_fetch_batch_id,
            observation_run_id,
            set_status
        )
        REFERENCES raw.product_identity_observation_set (
            identity_observation_set_id,
            store_id,
            full_sku_id,
            source_fetch_batch_id,
            observation_run_id,
            status
        )
        ON DELETE RESTRICT,
    CONSTRAINT uq_ops_canonical_product_observation_set
        UNIQUE (
            canonical_product_id,
            identity_observation_set_id
        ),
    CONSTRAINT uq_ops_canonical_product_observation_resolution_ref
        UNIQUE (
            canonical_product_id,
            identity_scope,
            identity_component_key,
            identity_observation_set_id,
            store_id,
            full_sku_id,
            source_fetch_batch_id,
            observation_run_id,
            set_status
        ),
    CONSTRAINT uq_ops_canonical_product_observation_assignment_ref
        UNIQUE (
            canonical_product_id,
            identity_scope,
            identity_component_key,
            identity_observation_set_id,
            store_id,
            full_sku_id,
            observation_run_id
        ),
    CONSTRAINT ck_ops_canonical_product_observation_scope
        CHECK (identity_scope IN ('GLOBAL', 'LOCAL_SINGLETON')),
    CONSTRAINT ck_ops_canonical_product_observation_sealed
        CHECK (set_status = 'SEALED'),
    CONSTRAINT ck_ops_canonical_product_observation_role
        CHECK (provenance_role IN ('ANCHOR', 'MEMBER')),
    CONSTRAINT ck_ops_canonical_product_observation_fingerprints
        CHECK (
            identity_component_key ~ '^[0-9a-f]{64}$'
            AND product_node_key ~ '^[0-9a-f]{64}$'
            AND payload_fingerprint ~ '^[0-9a-f]{64}$'
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_canonical_product_node_representative
    ON ops.canonical_product_observation_set (
        canonical_product_id,
        product_node_key
    )
    WHERE is_match_representative;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_canonical_product_global_store_rep
    ON ops.canonical_product_observation_set (
        canonical_product_id,
        store_id
    )
    WHERE identity_scope = 'GLOBAL' AND is_match_representative;

CREATE INDEX IF NOT EXISTS ix_ops_canonical_product_observation_set_lookup
    ON ops.canonical_product_observation_set (
        identity_observation_set_id,
        canonical_product_id
    );

COMMENT ON TABLE ops.canonical_product_observation_set IS
    'Immutable SEALED observation-set provenance for a canonical product. Product matching operates on one deterministic representative per store/batch/SPU product node, while every source SKU set remains linked.';

DROP TRIGGER IF EXISTS trg_ops_canonical_product_observation_append_only
    ON ops.canonical_product_observation_set;
CREATE TRIGGER trg_ops_canonical_product_observation_append_only
BEFORE UPDATE OR DELETE ON ops.canonical_product_observation_set
FOR EACH ROW EXECUTE FUNCTION ops.reject_append_only_identity_mutation();

ALTER TABLE ops.product_match_candidate
    ADD COLUMN IF NOT EXISTS identity_scope text,
    ADD COLUMN IF NOT EXISTS identity_component_key character(64),
    ADD COLUMN IF NOT EXISTS observation_run_id text,
    ADD COLUMN IF NOT EXISTS source_identity_observation_set_id bigint,
    ADD COLUMN IF NOT EXISTS source_fetch_batch_id bigint,
    ADD COLUMN IF NOT EXISTS source_set_status text,
    ADD COLUMN IF NOT EXISTS target_identity_observation_set_id bigint,
    ADD COLUMN IF NOT EXISTS target_store_id bigint,
    ADD COLUMN IF NOT EXISTS target_full_sku_id bigint,
    ADD COLUMN IF NOT EXISTS target_source_fetch_batch_id bigint,
    ADD COLUMN IF NOT EXISTS target_set_status text,
    ADD COLUMN IF NOT EXISTS matcher_version text,
    ADD COLUMN IF NOT EXISTS evidence_policy_version text,
    ADD COLUMN IF NOT EXISTS evidence_set_fingerprint character(64),
    ADD COLUMN IF NOT EXISTS plan_hash character(64),
    ADD COLUMN IF NOT EXISTS component_product_node_count integer,
    ADD COLUMN IF NOT EXISTS expected_relation_count integer;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM ops.product_match_candidate
         WHERE identity_scope IS NULL
            OR identity_component_key IS NULL
            OR observation_run_id IS NULL
            OR source_identity_observation_set_id IS NULL
            OR source_fetch_batch_id IS NULL
            OR source_set_status IS NULL
            OR target_identity_observation_set_id IS NULL
            OR target_store_id IS NULL
            OR target_full_sku_id IS NULL
            OR target_source_fetch_batch_id IS NULL
            OR target_set_status IS NULL
            OR matcher_version IS NULL
            OR evidence_policy_version IS NULL
            OR evidence_set_fingerprint IS NULL
            OR plan_hash IS NULL
            OR component_product_node_count IS NULL
            OR expected_relation_count IS NULL
    ) THEN
        RAISE EXCEPTION
            'legacy product match candidates require an explicit reviewed resolution migration'
            USING ERRCODE = '23502';
    END IF;
END;
$$;

ALTER TABLE ops.product_match_candidate
    ALTER COLUMN identity_scope SET NOT NULL,
    ALTER COLUMN identity_component_key SET NOT NULL,
    ALTER COLUMN observation_run_id SET NOT NULL,
    ALTER COLUMN source_identity_observation_set_id SET NOT NULL,
    ALTER COLUMN source_fetch_batch_id SET NOT NULL,
    ALTER COLUMN source_set_status SET NOT NULL,
    ALTER COLUMN target_identity_observation_set_id SET NOT NULL,
    ALTER COLUMN target_store_id SET NOT NULL,
    ALTER COLUMN target_full_sku_id SET NOT NULL,
    ALTER COLUMN target_source_fetch_batch_id SET NOT NULL,
    ALTER COLUMN target_set_status SET NOT NULL,
    ALTER COLUMN matcher_version SET NOT NULL,
    ALTER COLUMN evidence_policy_version SET NOT NULL,
    ALTER COLUMN evidence_set_fingerprint SET NOT NULL,
    ALTER COLUMN plan_hash SET NOT NULL,
    ALTER COLUMN component_product_node_count SET NOT NULL,
    ALTER COLUMN expected_relation_count SET NOT NULL;

ALTER TABLE ops.product_match_candidate
    DROP CONSTRAINT IF EXISTS ck_ops_product_match_candidate_strong_evidence_types;
ALTER TABLE ops.product_match_candidate
    ADD CONSTRAINT ck_ops_product_match_candidate_strong_evidence_types
    CHECK (
        strong_evidence_types <@
            ARRAY[
                'BARCODE',
                'MODEL',
                'BRAND_CATEGORY',
                'CURATED_ATTRIBUTES'
            ]::text[]
    );

ALTER TABLE ops.product_match_candidate
    DROP CONSTRAINT IF EXISTS ck_ops_product_match_candidate_resolution_metadata;
ALTER TABLE ops.product_match_candidate
    ADD CONSTRAINT ck_ops_product_match_candidate_resolution_metadata
    CHECK (
        identity_scope IN ('GLOBAL', 'LOCAL_SINGLETON')
        AND identity_component_key ~ '^[0-9a-f]{64}$'
        AND observation_run_id ~ '^[A-Za-z0-9._:-]{8,120}$'
        AND source_set_status = 'SEALED'
        AND target_set_status = 'SEALED'
        AND matcher_version <> ''
        AND evidence_policy_version <> ''
        AND evidence_set_fingerprint ~ '^[0-9a-f]{64}$'
        AND plan_hash ~ '^[0-9a-f]{64}$'
    );

ALTER TABLE ops.product_match_candidate
    DROP CONSTRAINT IF EXISTS ck_ops_product_match_candidate_component_shape;
ALTER TABLE ops.product_match_candidate
    ADD CONSTRAINT ck_ops_product_match_candidate_component_shape
    CHECK (
        (
            identity_scope = 'GLOBAL'
            AND component_product_node_count >= 2
            AND expected_relation_count =
                (
                    component_product_node_count::bigint
                    * (component_product_node_count - 1)
                    / 2
                )
            AND source_identity_observation_set_id
                <> target_identity_observation_set_id
            AND store_id <> target_store_id
        )
        OR (
            identity_scope = 'LOCAL_SINGLETON'
            AND component_product_node_count = 1
            AND expected_relation_count = 0
            AND source_identity_observation_set_id
                = target_identity_observation_set_id
            AND store_id = target_store_id
            AND full_sku_id = target_full_sku_id
        )
    );

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_ops_product_match_candidate_product_scope'
           AND conrelid = 'ops.product_match_candidate'::regclass
    ) THEN
        ALTER TABLE ops.product_match_candidate
            ADD CONSTRAINT fk_ops_product_match_candidate_product_scope
            FOREIGN KEY (
                canonical_product_id,
                identity_scope,
                identity_component_key
            )
            REFERENCES dim.canonical_product (
                canonical_product_id,
                identity_scope,
                identity_component_key
            )
            ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_ops_product_match_candidate_source_provenance'
           AND conrelid = 'ops.product_match_candidate'::regclass
    ) THEN
        ALTER TABLE ops.product_match_candidate
            ADD CONSTRAINT fk_ops_product_match_candidate_source_provenance
            FOREIGN KEY (
                canonical_product_id,
                identity_scope,
                identity_component_key,
                source_identity_observation_set_id,
                store_id,
                full_sku_id,
                source_fetch_batch_id,
                observation_run_id,
                source_set_status
            )
            REFERENCES ops.canonical_product_observation_set (
                canonical_product_id,
                identity_scope,
                identity_component_key,
                identity_observation_set_id,
                store_id,
                full_sku_id,
                source_fetch_batch_id,
                observation_run_id,
                set_status
            )
            ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_ops_product_match_candidate_target_provenance'
           AND conrelid = 'ops.product_match_candidate'::regclass
    ) THEN
        ALTER TABLE ops.product_match_candidate
            ADD CONSTRAINT fk_ops_product_match_candidate_target_provenance
            FOREIGN KEY (
                canonical_product_id,
                identity_scope,
                identity_component_key,
                target_identity_observation_set_id,
                target_store_id,
                target_full_sku_id,
                target_source_fetch_batch_id,
                observation_run_id,
                target_set_status
            )
            REFERENCES ops.canonical_product_observation_set (
                canonical_product_id,
                identity_scope,
                identity_component_key,
                identity_observation_set_id,
                store_id,
                full_sku_id,
                source_fetch_batch_id,
                observation_run_id,
                set_status
            )
            ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'uq_ops_product_match_candidate_decision_ref'
           AND conrelid = 'ops.product_match_candidate'::regclass
    ) THEN
        ALTER TABLE ops.product_match_candidate
            ADD CONSTRAINT uq_ops_product_match_candidate_decision_ref
            UNIQUE (
                product_match_candidate_id,
                store_id,
                full_sku_id,
                canonical_product_id,
                identity_scope,
                identity_component_key,
                source_identity_observation_set_id,
                observation_run_id,
                plan_hash
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'uq_ops_product_match_candidate_evidence_ref'
           AND conrelid = 'ops.product_match_candidate'::regclass
    ) THEN
        ALTER TABLE ops.product_match_candidate
            ADD CONSTRAINT uq_ops_product_match_candidate_evidence_ref
            UNIQUE (
                product_match_candidate_id,
                canonical_product_id,
                identity_scope,
                identity_component_key,
                observation_run_id,
                plan_hash
            );
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS ix_ops_product_match_candidate_plan
    ON ops.product_match_candidate (
        plan_hash,
        identity_scope,
        recommendation,
        product_match_candidate_id
    );

CREATE TABLE IF NOT EXISTS ops.product_match_candidate_evidence (
    product_match_candidate_evidence_id bigint
        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_match_candidate_id bigint NOT NULL,
    canonical_product_id bigint NOT NULL,
    identity_scope text NOT NULL,
    identity_component_key character(64) NOT NULL,
    observation_run_id text NOT NULL,
    plan_hash character(64) NOT NULL,
    relation_key character(64) NOT NULL,
    relation_source_set_id bigint NOT NULL,
    relation_source_store_id bigint NOT NULL,
    relation_source_full_sku_id bigint NOT NULL,
    relation_source_fetch_batch_id bigint NOT NULL,
    relation_source_set_status text NOT NULL DEFAULT 'SEALED',
    relation_target_set_id bigint NOT NULL,
    relation_target_store_id bigint NOT NULL,
    relation_target_full_sku_id bigint NOT NULL,
    relation_target_fetch_batch_id bigint NOT NULL,
    relation_target_set_status text NOT NULL DEFAULT 'SEALED',
    source_identifier_observation_id bigint NOT NULL,
    target_identifier_observation_id bigint NOT NULL,
    evidence_kind text NOT NULL,
    evidence_type text NOT NULL,
    component text NOT NULL,
    is_strong boolean NOT NULL,
    weight numeric(6,5) NOT NULL,
    normalized_value_fingerprint character(64) NOT NULL,
    payload_fingerprint character(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_ops_product_match_evidence_candidate
        FOREIGN KEY (
            product_match_candidate_id,
            canonical_product_id,
            identity_scope,
            identity_component_key,
            observation_run_id,
            plan_hash
        )
        REFERENCES ops.product_match_candidate (
            product_match_candidate_id,
            canonical_product_id,
            identity_scope,
            identity_component_key,
            observation_run_id,
            plan_hash
        )
        ON DELETE RESTRICT,
    CONSTRAINT fk_ops_product_match_evidence_source_provenance
        FOREIGN KEY (
            canonical_product_id,
            identity_scope,
            identity_component_key,
            relation_source_set_id,
            relation_source_store_id,
            relation_source_full_sku_id,
            relation_source_fetch_batch_id,
            observation_run_id,
            relation_source_set_status
        )
        REFERENCES ops.canonical_product_observation_set (
            canonical_product_id,
            identity_scope,
            identity_component_key,
            identity_observation_set_id,
            store_id,
            full_sku_id,
            source_fetch_batch_id,
            observation_run_id,
            set_status
        )
        ON DELETE RESTRICT,
    CONSTRAINT fk_ops_product_match_evidence_target_provenance
        FOREIGN KEY (
            canonical_product_id,
            identity_scope,
            identity_component_key,
            relation_target_set_id,
            relation_target_store_id,
            relation_target_full_sku_id,
            relation_target_fetch_batch_id,
            observation_run_id,
            relation_target_set_status
        )
        REFERENCES ops.canonical_product_observation_set (
            canonical_product_id,
            identity_scope,
            identity_component_key,
            identity_observation_set_id,
            store_id,
            full_sku_id,
            source_fetch_batch_id,
            observation_run_id,
            set_status
        )
        ON DELETE RESTRICT,
    CONSTRAINT fk_ops_product_match_evidence_source_observation
        FOREIGN KEY (
            source_identifier_observation_id,
            relation_source_set_id
        )
        REFERENCES raw.identifier_observation (
            identifier_observation_id,
            identity_observation_set_id
        )
        ON DELETE RESTRICT,
    CONSTRAINT fk_ops_product_match_evidence_target_observation
        FOREIGN KEY (
            target_identifier_observation_id,
            relation_target_set_id
        )
        REFERENCES raw.identifier_observation (
            identifier_observation_id,
            identity_observation_set_id
        )
        ON DELETE RESTRICT,
    CONSTRAINT uq_ops_product_match_candidate_evidence_key
        UNIQUE (
            product_match_candidate_id,
            relation_key,
            source_identifier_observation_id,
            target_identifier_observation_id,
            component
        ),
    CONSTRAINT ck_ops_product_match_evidence_scope
        CHECK (identity_scope IN ('GLOBAL', 'LOCAL_SINGLETON')),
    CONSTRAINT ck_ops_product_match_evidence_relation
        CHECK (
            relation_source_set_status = 'SEALED'
            AND relation_target_set_status = 'SEALED'
            AND relation_source_set_id < relation_target_set_id
            AND (
                identity_scope <> 'GLOBAL'
                OR relation_source_store_id <> relation_target_store_id
            )
        ),
    CONSTRAINT ck_ops_product_match_evidence_kind
        CHECK (evidence_kind IN ('MATCH', 'HARD_CONFLICT')),
    CONSTRAINT ck_ops_product_match_evidence_type
        CHECK (
            evidence_type IN (
                'BARCODE',
                'MODEL',
                'BRAND_CATEGORY',
                'SUPPLIER_CODE',
                'CURATED_ATTRIBUTES',
                'CORE_ATTRIBUTES',
                'HARD_CONFLICT'
            )
        ),
    CONSTRAINT ck_ops_product_match_evidence_strong
        CHECK (
            NOT is_strong
            OR (
                evidence_kind = 'MATCH'
                AND evidence_type IN (
                    'BARCODE',
                    'MODEL',
                    'BRAND_CATEGORY',
                    'CURATED_ATTRIBUTES'
                )
            )
        ),
    CONSTRAINT ck_ops_product_match_evidence_weight
        CHECK (weight >= 0 AND weight <= 1),
    CONSTRAINT ck_ops_product_match_evidence_metadata
        CHECK (
            identity_component_key ~ '^[0-9a-f]{64}$'
            AND observation_run_id ~ '^[A-Za-z0-9._:-]{8,120}$'
            AND plan_hash ~ '^[0-9a-f]{64}$'
            AND relation_key ~ '^[0-9a-f]{64}$'
            AND component <> ''
            AND normalized_value_fingerprint ~ '^[0-9a-f]{64}$'
            AND payload_fingerprint ~ '^[0-9a-f]{64}$'
        )
);

CREATE INDEX IF NOT EXISTS ix_ops_product_match_evidence_candidate_relation
    ON ops.product_match_candidate_evidence (
        product_match_candidate_id,
        relation_key
    );

CREATE INDEX IF NOT EXISTS ix_ops_product_match_evidence_component_relation
    ON ops.product_match_candidate_evidence (
        canonical_product_id,
        relation_key
    );

COMMENT ON TABLE ops.product_match_candidate_evidence IS
    'Append-only relational match evidence. Every row cites the exact source and target identifier observations inside SEALED sets; normalized values are represented only by fingerprints.';

DROP TRIGGER IF EXISTS trg_ops_product_match_candidate_evidence_append_only
    ON ops.product_match_candidate_evidence;
CREATE TRIGGER trg_ops_product_match_candidate_evidence_append_only
BEFORE UPDATE OR DELETE ON ops.product_match_candidate_evidence
FOR EACH ROW EXECUTE FUNCTION ops.reject_append_only_identity_mutation();

ALTER TABLE ops.product_identity_decision
    ADD COLUMN IF NOT EXISTS full_sku_id bigint,
    ADD COLUMN IF NOT EXISTS canonical_product_id bigint,
    ADD COLUMN IF NOT EXISTS identity_scope text,
    ADD COLUMN IF NOT EXISTS identity_component_key character(64),
    ADD COLUMN IF NOT EXISTS source_identity_observation_set_id bigint,
    ADD COLUMN IF NOT EXISTS observation_run_id text,
    ADD COLUMN IF NOT EXISTS plan_hash character(64);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM ops.product_identity_decision
         WHERE full_sku_id IS NULL
            OR canonical_product_id IS NULL
            OR identity_scope IS NULL
            OR identity_component_key IS NULL
            OR source_identity_observation_set_id IS NULL
            OR observation_run_id IS NULL
            OR plan_hash IS NULL
    ) THEN
        RAISE EXCEPTION
            'legacy product identity decisions require an explicit reviewed resolution migration'
            USING ERRCODE = '23502';
    END IF;
END;
$$;

ALTER TABLE ops.product_identity_decision
    ALTER COLUMN full_sku_id SET NOT NULL,
    ALTER COLUMN canonical_product_id SET NOT NULL,
    ALTER COLUMN identity_scope SET NOT NULL,
    ALTER COLUMN identity_component_key SET NOT NULL,
    ALTER COLUMN source_identity_observation_set_id SET NOT NULL,
    ALTER COLUMN observation_run_id SET NOT NULL,
    ALTER COLUMN plan_hash SET NOT NULL;

ALTER TABLE ops.product_identity_decision
    DROP CONSTRAINT IF EXISTS ck_ops_product_identity_decision_resolution;
ALTER TABLE ops.product_identity_decision
    ADD CONSTRAINT ck_ops_product_identity_decision_resolution
    CHECK (
        identity_scope IN ('GLOBAL', 'LOCAL_SINGLETON')
        AND identity_component_key ~ '^[0-9a-f]{64}$'
        AND observation_run_id ~ '^[A-Za-z0-9._:-]{8,120}$'
        AND plan_hash ~ '^[0-9a-f]{64}$'
    );

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_ops_product_identity_decision_candidate_resolution'
           AND conrelid = 'ops.product_identity_decision'::regclass
    ) THEN
        ALTER TABLE ops.product_identity_decision
            ADD CONSTRAINT fk_ops_product_identity_decision_candidate_resolution
            FOREIGN KEY (
                product_match_candidate_id,
                store_id,
                full_sku_id,
                canonical_product_id,
                identity_scope,
                identity_component_key,
                source_identity_observation_set_id,
                observation_run_id,
                plan_hash
            )
            REFERENCES ops.product_match_candidate (
                product_match_candidate_id,
                store_id,
                full_sku_id,
                canonical_product_id,
                identity_scope,
                identity_component_key,
                source_identity_observation_set_id,
                observation_run_id,
                plan_hash
            )
            ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'uq_ops_product_identity_decision_assignment_ref'
           AND conrelid = 'ops.product_identity_decision'::regclass
    ) THEN
        ALTER TABLE ops.product_identity_decision
            ADD CONSTRAINT uq_ops_product_identity_decision_assignment_ref
            UNIQUE (
                product_identity_decision_id,
                store_id,
                product_match_candidate_id,
                full_sku_id,
                canonical_product_id,
                identity_scope,
                identity_component_key,
                source_identity_observation_set_id,
                observation_run_id,
                plan_hash,
                decision_outcome
            );
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS ix_ops_product_identity_decision_plan
    ON ops.product_identity_decision (
        plan_hash,
        store_id,
        full_sku_id,
        decided_at DESC
    );

ALTER TABLE dim.full_sku_canonical_assignment
    ADD COLUMN IF NOT EXISTS product_match_candidate_id bigint,
    ADD COLUMN IF NOT EXISTS identity_observation_set_id bigint,
    ADD COLUMN IF NOT EXISTS identity_scope text,
    ADD COLUMN IF NOT EXISTS identity_component_key character(64),
    ADD COLUMN IF NOT EXISTS observation_run_id text,
    ADD COLUMN IF NOT EXISTS plan_hash character(64),
    ADD COLUMN IF NOT EXISTS decision_outcome text;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM dim.full_sku_canonical_assignment
         WHERE product_match_candidate_id IS NULL
            OR identity_observation_set_id IS NULL
            OR identity_scope IS NULL
            OR identity_component_key IS NULL
            OR observation_run_id IS NULL
            OR plan_hash IS NULL
            OR decision_outcome IS NULL
    ) THEN
        RAISE EXCEPTION
            'legacy canonical assignments require an explicit reviewed resolution migration'
            USING ERRCODE = '23502';
    END IF;
END;
$$;

ALTER TABLE dim.full_sku_canonical_assignment
    ALTER COLUMN product_match_candidate_id SET NOT NULL,
    ALTER COLUMN identity_observation_set_id SET NOT NULL,
    ALTER COLUMN identity_scope SET NOT NULL,
    ALTER COLUMN identity_component_key SET NOT NULL,
    ALTER COLUMN observation_run_id SET NOT NULL,
    ALTER COLUMN plan_hash SET NOT NULL,
    ALTER COLUMN decision_outcome SET NOT NULL;

ALTER TABLE dim.full_sku_canonical_assignment
    DROP CONSTRAINT IF EXISTS ck_dim_full_sku_canonical_assignment_resolution;
ALTER TABLE dim.full_sku_canonical_assignment
    ADD CONSTRAINT ck_dim_full_sku_canonical_assignment_resolution
    CHECK (
        identity_scope IN ('GLOBAL', 'LOCAL_SINGLETON')
        AND identity_component_key ~ '^[0-9a-f]{64}$'
        AND observation_run_id ~ '^[A-Za-z0-9._:-]{8,120}$'
        AND plan_hash ~ '^[0-9a-f]{64}$'
        AND decision_outcome = 'CONFIRMED'
    );

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_dim_full_sku_assignment_decision_resolution'
           AND conrelid = 'dim.full_sku_canonical_assignment'::regclass
    ) THEN
        ALTER TABLE dim.full_sku_canonical_assignment
            ADD CONSTRAINT fk_dim_full_sku_assignment_decision_resolution
            FOREIGN KEY (
                product_identity_decision_id,
                store_id,
                product_match_candidate_id,
                full_sku_id,
                canonical_product_id,
                identity_scope,
                identity_component_key,
                identity_observation_set_id,
                observation_run_id,
                plan_hash,
                decision_outcome
            )
            REFERENCES ops.product_identity_decision (
                product_identity_decision_id,
                store_id,
                product_match_candidate_id,
                full_sku_id,
                canonical_product_id,
                identity_scope,
                identity_component_key,
                source_identity_observation_set_id,
                observation_run_id,
                plan_hash,
                decision_outcome
            )
            ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_dim_full_sku_assignment_canonical_provenance'
           AND conrelid = 'dim.full_sku_canonical_assignment'::regclass
    ) THEN
        ALTER TABLE dim.full_sku_canonical_assignment
            ADD CONSTRAINT fk_dim_full_sku_assignment_canonical_provenance
            FOREIGN KEY (
                canonical_product_id,
                identity_scope,
                identity_component_key,
                identity_observation_set_id,
                store_id,
                full_sku_id,
                observation_run_id
            )
            REFERENCES ops.canonical_product_observation_set (
                canonical_product_id,
                identity_scope,
                identity_component_key,
                identity_observation_set_id,
                store_id,
                full_sku_id,
                observation_run_id
            )
            ON DELETE RESTRICT;
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS ix_dim_full_sku_assignment_plan_scope
    ON dim.full_sku_canonical_assignment (
        plan_hash,
        identity_scope,
        assignment_status,
        store_id,
        full_sku_id
    );

COMMENT ON COLUMN dim.full_sku_canonical_assignment.identity_scope IS
    'Only current CONFIRMED GLOBAL assignments may enter cross-store standard-product aggregation.';

COMMIT;
