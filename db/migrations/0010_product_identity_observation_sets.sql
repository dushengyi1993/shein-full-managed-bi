BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'uq_raw_openapi_fetch_batch_store_id'
           AND conrelid = 'raw.openapi_fetch_batch'::regclass
    ) THEN
        ALTER TABLE raw.openapi_fetch_batch
            ADD CONSTRAINT uq_raw_openapi_fetch_batch_store_id
            UNIQUE (store_id, fetch_batch_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'uq_dim_full_sku_store_id_platform_sku'
           AND conrelid = 'dim.full_sku'::regclass
    ) THEN
        ALTER TABLE dim.full_sku
            ADD CONSTRAINT uq_dim_full_sku_store_id_platform_sku
            UNIQUE (store_id, full_sku_id, platform_sku_id);
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS raw.product_identity_observation_set (
    identity_observation_set_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL,
    full_sku_id bigint NOT NULL,
    source_fetch_batch_id bigint NOT NULL,
    observation_run_id text NOT NULL,
    observation_set_key character(64) NOT NULL,
    platform_spu_id text NOT NULL,
    platform_skc_id text NOT NULL,
    platform_sku_id text NOT NULL,
    document_version integer NOT NULL DEFAULT 27,
    mapper_version text NOT NULL,
    status text NOT NULL DEFAULT 'BUILDING',
    member_count integer NOT NULL DEFAULT 0,
    source_response_fingerprint character(64) NOT NULL,
    set_payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    sealed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_raw_product_identity_observation_set_store_sku
        FOREIGN KEY (store_id, full_sku_id, platform_sku_id)
        REFERENCES dim.full_sku (store_id, full_sku_id, platform_sku_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_raw_product_identity_observation_set_store_batch
        FOREIGN KEY (store_id, source_fetch_batch_id)
        REFERENCES raw.openapi_fetch_batch (store_id, fetch_batch_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_raw_product_identity_observation_set_store_key
        UNIQUE (store_id, observation_set_key),
    CONSTRAINT uq_raw_product_identity_observation_set_batch_sku
        UNIQUE (store_id, source_fetch_batch_id, full_sku_id),
    CONSTRAINT uq_raw_product_identity_observation_set_run_sku
        UNIQUE (store_id, observation_run_id, full_sku_id),
    CONSTRAINT uq_raw_product_identity_observation_set_composite
        UNIQUE (
            identity_observation_set_id,
            store_id,
            full_sku_id,
            source_fetch_batch_id
        ),
    CONSTRAINT ck_raw_product_identity_observation_set_key
        CHECK (observation_set_key ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_raw_product_identity_observation_set_run
        CHECK (observation_run_id ~ '^[A-Za-z0-9._:-]{8,120}$'),
    CONSTRAINT ck_raw_product_identity_observation_set_platform_ids
        CHECK (
            platform_spu_id <> ''
            AND platform_skc_id <> ''
            AND platform_sku_id <> ''
        ),
    CONSTRAINT ck_raw_product_identity_observation_set_document
        CHECK (document_version = 27),
    CONSTRAINT ck_raw_product_identity_observation_set_mapper
        CHECK (mapper_version <> ''),
    CONSTRAINT ck_raw_product_identity_observation_set_status
        CHECK (status IN ('BUILDING', 'SEALED')),
    CONSTRAINT ck_raw_product_identity_observation_set_member_count
        CHECK (member_count >= 0),
    CONSTRAINT ck_raw_product_identity_observation_set_fingerprints
        CHECK (
            source_response_fingerprint ~ '^[0-9a-f]{64}$'
            AND set_payload_fingerprint ~ '^[0-9a-f]{64}$'
        ),
    CONSTRAINT ck_raw_product_identity_observation_set_lifecycle
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
        )
);

CREATE INDEX IF NOT EXISTS ix_raw_product_identity_observation_set_sku_observed
    ON raw.product_identity_observation_set (
        store_id, full_sku_id, source_fetched_at DESC
    )
    WHERE status = 'SEALED';

CREATE INDEX IF NOT EXISTS ix_raw_product_identity_observation_set_spu_observed
    ON raw.product_identity_observation_set (
        store_id, platform_spu_id, source_fetched_at DESC
    )
    WHERE status = 'SEALED';

CREATE INDEX IF NOT EXISTS ix_raw_product_identity_observation_set_batch
    ON raw.product_identity_observation_set (
        source_fetch_batch_id, identity_observation_set_id
    );

CREATE INDEX IF NOT EXISTS ix_raw_product_identity_set_run
    ON raw.product_identity_observation_set (
        observation_run_id,
        store_id,
        source_fetch_batch_id,
        full_sku_id
    )
    WHERE status = 'SEALED';

COMMENT ON TABLE raw.product_identity_observation_set IS
    'Append-only sealed evidence envelope for one real store SKU returned by one official goods/spu-info fetch batch.';
COMMENT ON COLUMN raw.product_identity_observation_set.observation_run_id IS
    'Explicit caller-owned evidence run id. Consumers must select this field directly and must never parse a fetch-batch idempotency key.';
COMMENT ON COLUMN raw.product_identity_observation_set.observation_set_key IS
    'Stable logical replay key derived from store, run, SPU and SKU; payload drift is checked separately by set_payload_fingerprint.';
COMMENT ON COLUMN raw.product_identity_observation_set.document_version IS
    'Official goods/spu-info document version. This mapper contract is pinned to version 27.';
COMMENT ON COLUMN raw.product_identity_observation_set.set_payload_fingerprint IS
    'Stable fingerprint of the sanitized set metadata and all ordered member payloads.';

ALTER TABLE raw.identifier_observation
    ADD COLUMN IF NOT EXISTS identity_observation_set_id bigint,
    ADD COLUMN IF NOT EXISTS identity_scope text,
    ADD COLUMN IF NOT EXISTS scope_key text,
    ADD COLUMN IF NOT EXISTS source_value_key text;

ALTER TABLE raw.identifier_observation
    DROP CONSTRAINT IF EXISTS ck_raw_identifier_observation_type;
ALTER TABLE raw.identifier_observation
    ADD CONSTRAINT ck_raw_identifier_observation_type
    CHECK (
        identifier_type IN (
            'PLATFORM_SKU', 'PLATFORM_SKC', 'PLATFORM_SPU',
            'SUPPLIER_SKU', 'SUPPLIER_CODE', 'BARCODE', 'MODEL',
            'BRAND', 'CATEGORY', 'PRODUCT_TYPE',
            'VOLTAGE', 'PLUG', 'CAPACITY', 'DIMENSIONS',
            'CORE_ATTRIBUTE', 'IMAGE_REFERENCE'
        )
    );

ALTER TABLE raw.identifier_observation
    DROP CONSTRAINT IF EXISTS ck_raw_identifier_observation_set_binding;
ALTER TABLE raw.identifier_observation
    ADD CONSTRAINT ck_raw_identifier_observation_set_binding
    CHECK (
        (
            identity_observation_set_id IS NULL
            AND identity_scope IS NULL
            AND scope_key IS NULL
            AND source_value_key IS NULL
        )
        OR (
            identity_observation_set_id IS NOT NULL
            AND source_fetch_batch_id IS NOT NULL
            AND identity_scope IN ('PRODUCT', 'VARIANT')
            AND scope_key IS NOT NULL
            AND scope_key <> ''
            AND source_value_key IS NOT NULL
            AND source_value_key <> ''
        )
    );

ALTER TABLE raw.identifier_observation
    DROP CONSTRAINT IF EXISTS ck_raw_identifier_observation_barcode_scope;
ALTER TABLE raw.identifier_observation
    ADD CONSTRAINT ck_raw_identifier_observation_barcode_scope
    CHECK (
        identifier_type <> 'BARCODE'
        OR identity_observation_set_id IS NULL
        OR identity_scope = 'VARIANT'
    );

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_raw_identifier_observation_set_composite'
           AND conrelid = 'raw.identifier_observation'::regclass
    ) THEN
        ALTER TABLE raw.identifier_observation
            ADD CONSTRAINT fk_raw_identifier_observation_set_composite
            FOREIGN KEY (
                identity_observation_set_id,
                store_id,
                full_sku_id,
                source_fetch_batch_id
            )
            REFERENCES raw.product_identity_observation_set (
                identity_observation_set_id,
                store_id,
                full_sku_id,
                source_fetch_batch_id
            )
            ON DELETE RESTRICT;
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_identifier_observation_set_source_value
    ON raw.identifier_observation (
        identity_observation_set_id, source_value_key
    )
    WHERE identity_observation_set_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_raw_identifier_observation_set_scope
    ON raw.identifier_observation (
        identity_observation_set_id,
        identity_scope,
        identifier_type,
        source_value_key
    )
    WHERE identity_observation_set_id IS NOT NULL;

COMMENT ON COLUMN raw.identifier_observation.identity_observation_set_id IS
    'Null only for legacy ungrouped observations. New goods/spu-info evidence must belong to a sealed observation set.';
COMMENT ON COLUMN raw.identifier_observation.identity_scope IS
    'PRODUCT or VARIANT scope from the official SPU/SKC/SKU hierarchy; a barcode is always VARIANT.';
COMMENT ON COLUMN raw.identifier_observation.source_value_key IS
    'Stable mapper-owned source member key within one observation set.';

CREATE OR REPLACE FUNCTION ops.guard_product_identity_observation_set_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'raw.product_identity_observation_set is append-only'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'BUILDING'
           OR NEW.member_count <> 0
           OR NEW.sealed_at IS NOT NULL THEN
            RAISE EXCEPTION
                'product identity observation sets must be inserted in BUILDING state'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status <> 'BUILDING'
       OR NEW.status <> 'SEALED'
       OR NEW.member_count <= 0
       OR NEW.sealed_at IS NULL THEN
        RAISE EXCEPTION
            'product identity observation sets allow only one BUILDING to SEALED transition'
            USING ERRCODE = '55000';
    END IF;

    IF (
        to_jsonb(NEW) - ARRAY['status', 'member_count', 'sealed_at']
    ) IS DISTINCT FROM (
        to_jsonb(OLD) - ARRAY['status', 'member_count', 'sealed_at']
    ) THEN
        RAISE EXCEPTION
            'product identity observation set evidence is immutable'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ops.require_building_product_identity_observation_set()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status text;
BEGIN
    IF NEW.identity_observation_set_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT status
      INTO parent_status
      FROM raw.product_identity_observation_set
     WHERE identity_observation_set_id = NEW.identity_observation_set_id
       AND store_id = NEW.store_id
       AND full_sku_id = NEW.full_sku_id
       AND source_fetch_batch_id = NEW.source_fetch_batch_id
     FOR KEY SHARE;

    IF parent_status IS DISTINCT FROM 'BUILDING' THEN
        RAISE EXCEPTION
            'identifier members may be inserted only while their observation set is BUILDING'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ops.verify_product_identity_observation_set_sealed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_status text;
    declared_count integer;
    actual_count bigint;
BEGIN
    SELECT status, member_count
      INTO current_status, declared_count
      FROM raw.product_identity_observation_set
     WHERE identity_observation_set_id = NEW.identity_observation_set_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'product identity observation set disappeared before commit'
            USING ERRCODE = '23514';
    END IF;

    SELECT count(*)
      INTO actual_count
      FROM raw.identifier_observation
     WHERE identity_observation_set_id = NEW.identity_observation_set_id;

    IF current_status <> 'SEALED'
       OR declared_count <= 0
       OR declared_count <> actual_count THEN
        RAISE EXCEPTION
            'product identity observation set % must be SEALED with member_count %, found status % and % members',
            NEW.identity_observation_set_id,
            declared_count,
            current_status,
            actual_count
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_raw_product_identity_observation_set_guard
    ON raw.product_identity_observation_set;
CREATE TRIGGER trg_raw_product_identity_observation_set_guard
BEFORE INSERT OR UPDATE OR DELETE ON raw.product_identity_observation_set
FOR EACH ROW EXECUTE FUNCTION ops.guard_product_identity_observation_set_mutation();

DROP TRIGGER IF EXISTS trg_raw_identifier_observation_require_building_set
    ON raw.identifier_observation;
CREATE TRIGGER trg_raw_identifier_observation_require_building_set
BEFORE INSERT ON raw.identifier_observation
FOR EACH ROW EXECUTE FUNCTION ops.require_building_product_identity_observation_set();

DROP TRIGGER IF EXISTS trg_raw_product_identity_observation_set_sealed
    ON raw.product_identity_observation_set;
CREATE CONSTRAINT TRIGGER trg_raw_product_identity_observation_set_sealed
AFTER INSERT OR UPDATE ON raw.product_identity_observation_set
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ops.verify_product_identity_observation_set_sealed();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_app') THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE
            ON raw.product_identity_observation_set
            FROM sheinfm_app;
        REVOKE USAGE, UPDATE
            ON SEQUENCE raw.product_identity_observation_set_identity_observation_set_id_seq
            FROM sheinfm_app;
        GRANT SELECT ON raw.product_identity_observation_set TO sheinfm_app;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_supply_loader') THEN
        GRANT SELECT, INSERT
            ON raw.product_identity_observation_set
            TO sheinfm_supply_loader;
        GRANT UPDATE (status, member_count, sealed_at)
            ON raw.product_identity_observation_set
            TO sheinfm_supply_loader;
        GRANT SELECT, INSERT
            ON raw.identifier_observation
            TO sheinfm_supply_loader;
        GRANT USAGE, SELECT
            ON SEQUENCE raw.product_identity_observation_set_identity_observation_set_id_seq
            TO sheinfm_supply_loader;
        GRANT USAGE, SELECT
            ON SEQUENCE raw.identifier_observation_identifier_observation_id_seq
            TO sheinfm_supply_loader;
    END IF;
END;
$$;

COMMIT;
