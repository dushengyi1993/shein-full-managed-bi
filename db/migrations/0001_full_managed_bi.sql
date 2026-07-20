BEGIN;

CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS dim;
CREATE SCHEMA IF NOT EXISTS fact;
CREATE SCHEMA IF NOT EXISTS mart;
CREATE SCHEMA IF NOT EXISTS ops;

COMMENT ON SCHEMA raw IS 'Sanitized OpenAPI ingestion evidence and fetch lifecycle.';
COMMENT ON SCHEMA dim IS 'Stable full-managed business identities.';
COMMENT ON SCHEMA fact IS 'Append-oriented, source-traceable business measurements.';
COMMENT ON SCHEMA mart IS 'BI-facing latest-state aggregates derived from fact data.';
COMMENT ON SCHEMA ops IS 'Operational probes, controls, and warehouse support functions.';

CREATE OR REPLACE FUNCTION ops.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS dim.store (
    store_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_code text NOT NULL,
    store_name text NOT NULL,
    legal_entity_name text,
    platform_shop_id text,
    cooperation_mode text NOT NULL DEFAULT 'FULL_MANAGED',
    timezone_name text NOT NULL DEFAULT 'Asia/Shanghai',
    is_active boolean NOT NULL DEFAULT true,
    first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_dim_store_store_code UNIQUE (store_code),
    CONSTRAINT ck_dim_store_store_code
        CHECK (store_code = upper(store_code) AND store_code ~ '^[A-Z0-9_-]+$'),
    CONSTRAINT ck_dim_store_cooperation_mode
        CHECK (cooperation_mode = 'FULL_MANAGED'),
    CONSTRAINT ck_dim_store_seen_order
        CHECK (last_seen_at >= first_seen_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dim_store_platform_shop_id
    ON dim.store (platform_shop_id)
    WHERE platform_shop_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_dim_store_active_code
    ON dim.store (is_active, store_code);

COMMENT ON TABLE dim.store IS
    'One row per full-managed store. Semi-managed stores must not be inserted into this dimension.';
COMMENT ON COLUMN dim.store.platform_shop_id IS
    'Stable SHEIN shop identifier when exposed by the authorized API; never an application id or credential.';

CREATE TABLE IF NOT EXISTS raw.openapi_fetch_batch (
    fetch_batch_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    capability_code text NOT NULL,
    endpoint_code text NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint character(64) NOT NULL,
    metric_window_start timestamptz,
    metric_window_end timestamptz,
    status text NOT NULL DEFAULT 'CREATED',
    http_status integer,
    response_record_count integer,
    request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    response_payload jsonb,
    error_code text,
    error_message text,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_raw_openapi_fetch_batch_idempotency
        UNIQUE (store_id, idempotency_key),
    CONSTRAINT ck_raw_openapi_fetch_batch_fingerprint
        CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_raw_openapi_fetch_batch_window
        CHECK (
            (metric_window_start IS NULL AND metric_window_end IS NULL)
            OR (
                metric_window_start IS NOT NULL
                AND metric_window_end IS NOT NULL
                AND metric_window_end > metric_window_start
            )
        ),
    CONSTRAINT ck_raw_openapi_fetch_batch_status
        CHECK (status IN ('CREATED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
    CONSTRAINT ck_raw_openapi_fetch_batch_http_status
        CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
    CONSTRAINT ck_raw_openapi_fetch_batch_record_count
        CHECK (response_record_count IS NULL OR response_record_count >= 0),
    CONSTRAINT ck_raw_openapi_fetch_batch_request_payload
        CHECK (jsonb_typeof(request_payload) = 'object'),
    CONSTRAINT ck_raw_openapi_fetch_batch_completed_order
        CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS ix_raw_openapi_fetch_batch_store_capability_started
    ON raw.openapi_fetch_batch (store_id, capability_code, started_at DESC);

CREATE INDEX IF NOT EXISTS ix_raw_openapi_fetch_batch_unfinished
    ON raw.openapi_fetch_batch (started_at)
    WHERE status IN ('CREATED', 'RUNNING');

COMMENT ON TABLE raw.openapi_fetch_batch IS
    'One row per logical OpenAPI request batch, including sanitized request/response evidence. Tokens, signatures, cookies, and credentials are forbidden.';
COMMENT ON COLUMN raw.openapi_fetch_batch.idempotency_key IS
    'Caller-generated stable key for store + endpoint + normalized request window + pagination scope.';
COMMENT ON COLUMN raw.openapi_fetch_batch.response_payload IS
    'Sanitized source evidence only; ingestion must remove credentials and sensitive transport headers before persistence.';

CREATE TABLE IF NOT EXISTS dim.full_sku (
    full_sku_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    platform_sku_id text NOT NULL,
    platform_skc_id text,
    platform_spu_id text,
    product_key text GENERATED ALWAYS AS (
        CASE
            WHEN platform_spu_id IS NOT NULL AND platform_spu_id <> ''
                THEN 'SPU:' || platform_spu_id
            WHEN platform_skc_id IS NOT NULL AND platform_skc_id <> ''
                THEN 'SKC:' || platform_skc_id
            ELSE 'SKU:' || platform_sku_id
        END
    ) STORED,
    supplier_sku text,
    supplier_code text,
    sku_name text,
    product_name text,
    lifecycle_status text,
    source_fetch_batch_id bigint REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_dim_full_sku_store_platform_sku
        UNIQUE (store_id, platform_sku_id),
    CONSTRAINT uq_dim_full_sku_store_internal
        UNIQUE (store_id, full_sku_id),
    CONSTRAINT ck_dim_full_sku_platform_sku
        CHECK (platform_sku_id <> ''),
    CONSTRAINT ck_dim_full_sku_seen_order
        CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX IF NOT EXISTS ix_dim_full_sku_store_product_key
    ON dim.full_sku (store_id, product_key);

CREATE INDEX IF NOT EXISTS ix_dim_full_sku_supplier_code
    ON dim.full_sku (store_id, supplier_code)
    WHERE supplier_code IS NOT NULL;

COMMENT ON TABLE dim.full_sku IS
    'One current identity row per full-managed store and platform SKU.';
COMMENT ON COLUMN dim.full_sku.product_key IS
    'Stable product aggregation key using SPU, then SKC, then SKU as the documented fallback order.';

CREATE TABLE IF NOT EXISTS fact.full_sku_sales_snapshot (
    sales_snapshot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL,
    full_sku_id bigint NOT NULL,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    source_row_key text NOT NULL,
    payload_fingerprint character(64) NOT NULL,
    metric_window_start timestamptz NOT NULL,
    metric_window_end timestamptz NOT NULL,
    snapshot_at timestamptz NOT NULL,
    sales_quantity bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_fact_full_sku_sales_snapshot_store_sku
        FOREIGN KEY (store_id, full_sku_id)
        REFERENCES dim.full_sku (store_id, full_sku_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_fact_full_sku_sales_snapshot_source_row
        UNIQUE (source_fetch_batch_id, source_row_key),
    CONSTRAINT uq_fact_full_sku_sales_snapshot_business_grain
        UNIQUE (
            store_id,
            full_sku_id,
            metric_window_start,
            metric_window_end,
            snapshot_at
        ),
    CONSTRAINT ck_fact_full_sku_sales_snapshot_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_fact_full_sku_sales_snapshot_window
        CHECK (metric_window_end > metric_window_start),
    CONSTRAINT ck_fact_full_sku_sales_snapshot_quantity
        CHECK (sales_quantity >= 0),
    CONSTRAINT ck_fact_full_sku_sales_snapshot_snapshot_time
        CHECK (snapshot_at >= metric_window_start)
);

CREATE INDEX IF NOT EXISTS ix_fact_full_sku_sales_snapshot_store_latest
    ON fact.full_sku_sales_snapshot (
        store_id,
        metric_window_start,
        metric_window_end,
        snapshot_at DESC
    );

CREATE INDEX IF NOT EXISTS ix_fact_full_sku_sales_snapshot_sku_latest
    ON fact.full_sku_sales_snapshot (full_sku_id, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS ix_fact_full_sku_sales_snapshot_batch
    ON fact.full_sku_sales_snapshot (source_fetch_batch_id);

COMMENT ON TABLE fact.full_sku_sales_snapshot IS
    'SKU sales quantity snapshots only. Revenue, order count/detail, cost, margin, and profit are intentionally absent.';
COMMENT ON COLUMN fact.full_sku_sales_snapshot.metric_window_start IS
    'Inclusive beginning of the measured API window.';
COMMENT ON COLUMN fact.full_sku_sales_snapshot.metric_window_end IS
    'Exclusive end of the measured API window.';
COMMENT ON COLUMN fact.full_sku_sales_snapshot.snapshot_at IS
    'Source observation time, not warehouse ingestion time.';

CREATE TABLE IF NOT EXISTS mart.full_store_sales_latest (
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    metric_window_start timestamptz NOT NULL,
    metric_window_end timestamptz NOT NULL,
    latest_snapshot_at timestamptz NOT NULL,
    sales_quantity bigint NOT NULL,
    sku_count integer NOT NULL,
    product_count integer NOT NULL,
    source_fact_count integer NOT NULL,
    source_max_fact_updated_at timestamptz NOT NULL,
    refreshed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_mart_full_store_sales_latest
        PRIMARY KEY (store_id, metric_window_start, metric_window_end),
    CONSTRAINT ck_mart_full_store_sales_latest_window
        CHECK (metric_window_end > metric_window_start),
    CONSTRAINT ck_mart_full_store_sales_latest_quantity
        CHECK (sales_quantity >= 0),
    CONSTRAINT ck_mart_full_store_sales_latest_counts
        CHECK (
            sku_count >= 0
            AND product_count >= 0
            AND source_fact_count >= 0
        )
);

CREATE INDEX IF NOT EXISTS ix_mart_full_store_sales_latest_snapshot
    ON mart.full_store_sales_latest (latest_snapshot_at DESC, store_id);

COMMENT ON TABLE mart.full_store_sales_latest IS
    'BI-facing latest quantity aggregate per full-managed store and measurement window.';

CREATE TABLE IF NOT EXISTS mart.full_product_sales_latest (
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    product_key text NOT NULL,
    platform_spu_id text,
    platform_skc_id text,
    product_name text,
    metric_window_start timestamptz NOT NULL,
    metric_window_end timestamptz NOT NULL,
    latest_snapshot_at timestamptz NOT NULL,
    sales_quantity bigint NOT NULL,
    sku_count integer NOT NULL,
    source_fact_count integer NOT NULL,
    source_max_fact_updated_at timestamptz NOT NULL,
    refreshed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_mart_full_product_sales_latest
        PRIMARY KEY (
            store_id,
            product_key,
            metric_window_start,
            metric_window_end
        ),
    CONSTRAINT ck_mart_full_product_sales_latest_product_key
        CHECK (product_key <> ''),
    CONSTRAINT ck_mart_full_product_sales_latest_window
        CHECK (metric_window_end > metric_window_start),
    CONSTRAINT ck_mart_full_product_sales_latest_quantity
        CHECK (sales_quantity >= 0),
    CONSTRAINT ck_mart_full_product_sales_latest_counts
        CHECK (sku_count >= 0 AND source_fact_count >= 0)
);

CREATE INDEX IF NOT EXISTS ix_mart_full_product_sales_latest_snapshot
    ON mart.full_product_sales_latest (latest_snapshot_at DESC, store_id);

CREATE INDEX IF NOT EXISTS ix_mart_full_product_sales_latest_product
    ON mart.full_product_sales_latest (store_id, product_key);

COMMENT ON TABLE mart.full_product_sales_latest IS
    'BI-facing latest quantity aggregate per product key, store, and measurement window.';

CREATE TABLE IF NOT EXISTS ops.permission_probe (
    permission_probe_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    capability_code text NOT NULL,
    permission_package_code text NOT NULL,
    endpoint_code text NOT NULL,
    idempotency_key text NOT NULL,
    outcome text NOT NULL,
    http_status integer,
    platform_error_code text,
    platform_message text,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    probed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_permission_probe_idempotency
        UNIQUE (store_id, idempotency_key),
    CONSTRAINT ck_ops_permission_probe_outcome
        CHECK (outcome IN ('GRANTED', 'PENDING', 'DENIED', 'ERROR')),
    CONSTRAINT ck_ops_permission_probe_http_status
        CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
    CONSTRAINT ck_ops_permission_probe_evidence
        CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE INDEX IF NOT EXISTS ix_ops_permission_probe_latest
    ON ops.permission_probe (store_id, capability_code, probed_at DESC);

CREATE INDEX IF NOT EXISTS ix_ops_permission_probe_not_granted
    ON ops.permission_probe (probed_at DESC, store_id)
    WHERE outcome <> 'GRANTED';

COMMENT ON TABLE ops.permission_probe IS
    'Append-oriented history of read-only permission probes. Application approval and package application are not treated as proof of API access.';
COMMENT ON COLUMN ops.permission_probe.evidence IS
    'Sanitized response metadata only. Tokens, cookies, signatures, and request headers are forbidden.';

DROP TRIGGER IF EXISTS trg_dim_store_touch_updated_at ON dim.store;
CREATE TRIGGER trg_dim_store_touch_updated_at
BEFORE UPDATE ON dim.store
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_raw_openapi_fetch_batch_touch_updated_at ON raw.openapi_fetch_batch;
CREATE TRIGGER trg_raw_openapi_fetch_batch_touch_updated_at
BEFORE UPDATE ON raw.openapi_fetch_batch
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_dim_full_sku_touch_updated_at ON dim.full_sku;
CREATE TRIGGER trg_dim_full_sku_touch_updated_at
BEFORE UPDATE ON dim.full_sku
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_fact_full_sku_sales_snapshot_touch_updated_at ON fact.full_sku_sales_snapshot;
CREATE TRIGGER trg_fact_full_sku_sales_snapshot_touch_updated_at
BEFORE UPDATE ON fact.full_sku_sales_snapshot
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_mart_full_store_sales_latest_touch_updated_at ON mart.full_store_sales_latest;
CREATE TRIGGER trg_mart_full_store_sales_latest_touch_updated_at
BEFORE UPDATE ON mart.full_store_sales_latest
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_mart_full_product_sales_latest_touch_updated_at ON mart.full_product_sales_latest;
CREATE TRIGGER trg_mart_full_product_sales_latest_touch_updated_at
BEFORE UPDATE ON mart.full_product_sales_latest
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_ops_permission_probe_touch_updated_at ON ops.permission_probe;
CREATE TRIGGER trg_ops_permission_probe_touch_updated_at
BEFORE UPDATE ON ops.permission_probe
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

COMMIT;
