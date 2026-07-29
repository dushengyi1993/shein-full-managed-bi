BEGIN;

CREATE TABLE IF NOT EXISTS raw.webapi_home_fetch_audit (
    webapi_home_fetch_audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fetch_key character(64) NOT NULL UNIQUE,
    store_code text NOT NULL,
    endpoint_code text NOT NULL,
    requested_start_date date,
    requested_end_date date,
    request_sha256 character(64) NOT NULL,
    response_schema_sha256 character(64),
    response_body_sha256 character(64),
    http_status integer,
    result_status text NOT NULL,
    accepted_row_count integer NOT NULL DEFAULT 0,
    rejected_row_count integer NOT NULL DEFAULT 0,
    observed_at timestamptz NOT NULL,
    completed_at timestamptz NOT NULL,
    sanitized_error_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_raw_webapi_home_fetch_store
        CHECK (store_code IN ('DL5477', 'MZ2406')),
    CONSTRAINT ck_raw_webapi_home_fetch_endpoint
        CHECK (endpoint_code IN (
            'STORE_DAILY_HISTORY',
            'STORE_REALTIME',
            'TRADE_OVERVIEW',
            'REGION_RANK',
            'PRODUCT_DAILY',
            'ANALYSE_MODEL',
            'ANALYSE_SEARCH'
        )),
    CONSTRAINT ck_raw_webapi_home_fetch_date_range
        CHECK (
            (requested_start_date IS NULL AND requested_end_date IS NULL)
            OR (
                requested_start_date IS NOT NULL
                AND requested_end_date IS NOT NULL
                AND requested_start_date <= requested_end_date
                AND requested_end_date - requested_start_date <= 90
            )
        ),
    CONSTRAINT ck_raw_webapi_home_fetch_hashes
        CHECK (
            fetch_key ~ '^[0-9a-f]{64}$'
            AND request_sha256 ~ '^[0-9a-f]{64}$'
            AND (
                response_schema_sha256 IS NULL
                OR response_schema_sha256 ~ '^[0-9a-f]{64}$'
            )
            AND (
                response_body_sha256 IS NULL
                OR response_body_sha256 ~ '^[0-9a-f]{64}$'
            )
        ),
    CONSTRAINT ck_raw_webapi_home_fetch_status
        CHECK (result_status IN ('SUCCEEDED', 'PARTIAL', 'REJECTED', 'FAILED')),
    CONSTRAINT ck_raw_webapi_home_fetch_counts
        CHECK (accepted_row_count >= 0 AND rejected_row_count >= 0),
    CONSTRAINT ck_raw_webapi_home_fetch_http
        CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
    CONSTRAINT ck_raw_webapi_home_fetch_error
        CHECK (
            sanitized_error_code IS NULL
            OR sanitized_error_code ~ '^[A-Z][A-Z0-9_]{2,80}$'
        ),
    CONSTRAINT ck_raw_webapi_home_fetch_time
        CHECK (completed_at >= observed_at)
);

CREATE INDEX IF NOT EXISTS ix_raw_webapi_home_fetch_store_time
    ON raw.webapi_home_fetch_audit (store_code, observed_at DESC);

COMMENT ON TABLE raw.webapi_home_fetch_audit IS
    'Append-only, credential-free audit metadata for the fixed full-managed homepage WebAPI contracts. It stores hashes and bounded counts, never cookies, headers or response bodies.';

DROP TRIGGER IF EXISTS trg_raw_webapi_home_fetch_append_only
    ON raw.webapi_home_fetch_audit;
CREATE TRIGGER trg_raw_webapi_home_fetch_append_only
BEFORE UPDATE OR DELETE ON raw.webapi_home_fetch_audit
FOR EACH ROW EXECUTE FUNCTION ops.reject_webapi_evidence_mutation();

CREATE TABLE IF NOT EXISTS fact.full_home_store_daily (
    store_code text NOT NULL,
    business_date date NOT NULL,
    currency character(3),
    deal_amount numeric(20, 4),
    net_deal_amount numeric(20, 4),
    sales_quantity bigint,
    buyer_count bigint,
    goods_detail_visitors bigint,
    exposure_users bigint,
    exposure_basis text NOT NULL DEFAULT 'UNAVAILABLE',
    stocking_order_count bigint,
    urgent_purchase_order_count bigint,
    payment_order_count bigint,
    new_customer_sales_quantity bigint,
    new_customer_payment_order_count bigint,
    source_updated_at timestamptz,
    observed_at timestamptz NOT NULL,
    source_contract_version smallint NOT NULL DEFAULT 1,
    quality_status text NOT NULL DEFAULT 'PARTIAL',
    source_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_code, business_date),
    CONSTRAINT ck_fact_full_home_store_daily_store
        CHECK (store_code IN ('DL5477', 'MZ2406')),
    CONSTRAINT ck_fact_full_home_store_daily_currency
        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_fact_full_home_store_daily_nonnegative
        CHECK (
            (deal_amount IS NULL OR deal_amount >= 0)
            AND (net_deal_amount IS NULL OR net_deal_amount >= 0)
            AND (sales_quantity IS NULL OR sales_quantity >= 0)
            AND (buyer_count IS NULL OR buyer_count >= 0)
            AND (goods_detail_visitors IS NULL OR goods_detail_visitors >= 0)
            AND (exposure_users IS NULL OR exposure_users >= 0)
            AND (stocking_order_count IS NULL OR stocking_order_count >= 0)
            AND (urgent_purchase_order_count IS NULL OR urgent_purchase_order_count >= 0)
            AND (payment_order_count IS NULL OR payment_order_count >= 0)
            AND (
                new_customer_sales_quantity IS NULL
                OR new_customer_sales_quantity >= 0
            )
            AND (
                new_customer_payment_order_count IS NULL
                OR new_customer_payment_order_count >= 0
            )
        ),
    CONSTRAINT ck_fact_full_home_store_daily_exposure_basis
        CHECK (exposure_basis IN ('STORE_DEDUP', 'BRAND_SUMMED', 'UNAVAILABLE')),
    CONSTRAINT ck_fact_full_home_store_daily_exposure_shape
        CHECK (
            (exposure_users IS NULL AND exposure_basis = 'UNAVAILABLE')
            OR (exposure_users IS NOT NULL AND exposure_basis <> 'UNAVAILABLE')
        ),
    CONSTRAINT ck_fact_full_home_store_daily_quality
        CHECK (quality_status IN ('COMPLETE', 'PARTIAL', 'LEGAL_ZERO', 'REJECTED')),
    CONSTRAINT ck_fact_full_home_store_daily_sources
        CHECK (
            cardinality(source_codes) BETWEEN 1 AND 8
            AND source_codes <@ ARRAY[
                'WEBAPI_INDEX',
                'WEBAPI_REALTIME',
                'WEBAPI_TRADE',
                'WEBAPI_ANALYSE'
            ]::text[]
        ),
    CONSTRAINT ck_fact_full_home_store_daily_contract
        CHECK (source_contract_version > 0),
    CONSTRAINT ck_fact_full_home_store_daily_time
        CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS ix_fact_full_home_store_daily_date
    ON fact.full_home_store_daily (business_date DESC, store_code);

COMMENT ON TABLE fact.full_home_store_daily IS
    'One truthful homepage metric row per store and business date. Nullable means unavailable; it must never be converted to zero by the loader.';

CREATE TABLE IF NOT EXISTS fact.full_home_region_daily (
    store_code text NOT NULL,
    business_date date NOT NULL,
    region_key text NOT NULL,
    region_name text NOT NULL,
    sales_quantity bigint,
    sales_share numeric(12, 8),
    new_customer_sales_quantity bigint,
    new_customer_sales_share numeric(12, 8),
    source_updated_at timestamptz,
    observed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_code, business_date, region_key),
    CONSTRAINT ck_fact_full_home_region_store
        CHECK (store_code IN ('DL5477', 'MZ2406')),
    CONSTRAINT ck_fact_full_home_region_key
        CHECK (region_key ~ '^[A-Za-z0-9._:-]{1,80}$'),
    CONSTRAINT ck_fact_full_home_region_name
        CHECK (length(btrim(region_name)) BETWEEN 1 AND 160),
    CONSTRAINT ck_fact_full_home_region_values
        CHECK (
            (sales_quantity IS NULL OR sales_quantity >= 0)
            AND (sales_share IS NULL OR sales_share BETWEEN 0 AND 1)
            AND (
                new_customer_sales_quantity IS NULL
                OR new_customer_sales_quantity >= 0
            )
            AND (
                new_customer_sales_share IS NULL
                OR new_customer_sales_share BETWEEN 0 AND 1
            )
        ),
    CONSTRAINT ck_fact_full_home_region_time
        CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS ix_fact_full_home_region_rank
    ON fact.full_home_region_daily (
        business_date DESC,
        store_code,
        sales_quantity DESC NULLS LAST
    );

CREATE TABLE IF NOT EXISTS fact.full_home_product_daily (
    store_code text NOT NULL,
    business_date date NOT NULL,
    product_grain text NOT NULL,
    product_key text NOT NULL,
    platform_spu_id text,
    platform_skc_id text,
    supplier_code text,
    supplier_sku text,
    display_name text,
    sales_quantity bigint,
    estimated_deal_amount numeric(20, 4),
    estimation_currency character(3),
    unit_price_evidence numeric(20, 6),
    estimation_basis text NOT NULL DEFAULT 'UNAVAILABLE',
    price_observed_at timestamptz,
    source_updated_at timestamptz,
    observed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_code, business_date, product_grain, product_key),
    CONSTRAINT ck_fact_full_home_product_store
        CHECK (store_code IN ('DL5477', 'MZ2406')),
    CONSTRAINT ck_fact_full_home_product_grain
        CHECK (product_grain IN ('SPU', 'SKC')),
    CONSTRAINT ck_fact_full_home_product_key
        CHECK (length(btrim(product_key)) BETWEEN 1 AND 160),
    CONSTRAINT ck_fact_full_home_product_values
        CHECK (
            (sales_quantity IS NULL OR sales_quantity >= 0)
            AND (estimated_deal_amount IS NULL OR estimated_deal_amount >= 0)
            AND (unit_price_evidence IS NULL OR unit_price_evidence >= 0)
        ),
    CONSTRAINT ck_fact_full_home_product_currency
        CHECK (estimation_currency IS NULL OR estimation_currency ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_fact_full_home_product_estimation_basis
        CHECK (estimation_basis IN (
            'LATEST_FINANCE_UNIT_PRICE',
            'UNAVAILABLE'
        )),
    CONSTRAINT ck_fact_full_home_product_estimation_shape
        CHECK (
            (
                estimation_basis = 'UNAVAILABLE'
                AND estimated_deal_amount IS NULL
                AND unit_price_evidence IS NULL
                AND price_observed_at IS NULL
            )
            OR (
                estimation_basis = 'LATEST_FINANCE_UNIT_PRICE'
                AND estimated_deal_amount IS NOT NULL
                AND estimation_currency IS NOT NULL
                AND unit_price_evidence IS NOT NULL
                AND price_observed_at IS NOT NULL
            )
        ),
    CONSTRAINT ck_fact_full_home_product_time
        CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS ix_fact_full_home_product_rank
    ON fact.full_home_product_daily (
        business_date DESC,
        store_code,
        sales_quantity DESC NULLS LAST
    );

CREATE TABLE IF NOT EXISTS fact.full_product_price_observation (
    full_product_price_observation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    observation_key character(64) NOT NULL UNIQUE,
    store_code text NOT NULL,
    report_order_no_hash character(64) NOT NULL,
    detail_row_key_hash character(64) NOT NULL,
    platform_sku_id text,
    supplier_sku text,
    supplier_code text,
    unit_price numeric(20, 6) NOT NULL,
    amount numeric(20, 4),
    goods_count bigint,
    currency character(3) NOT NULL,
    direction text NOT NULL,
    second_order_type text,
    source_business_at timestamptz,
    observed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_fact_full_product_price_store
        CHECK (store_code IN ('DL5477', 'MZ2406')),
    CONSTRAINT ck_fact_full_product_price_hashes
        CHECK (
            observation_key ~ '^[0-9a-f]{64}$'
            AND report_order_no_hash ~ '^[0-9a-f]{64}$'
            AND detail_row_key_hash ~ '^[0-9a-f]{64}$'
        ),
    CONSTRAINT ck_fact_full_product_price_values
        CHECK (
            unit_price >= 0
            AND (amount IS NULL OR amount >= 0)
            AND (goods_count IS NULL OR goods_count >= 0)
        ),
    CONSTRAINT ck_fact_full_product_price_identity
        CHECK (
            platform_sku_id IS NOT NULL
            OR supplier_sku IS NOT NULL
            OR supplier_code IS NOT NULL
        ),
    CONSTRAINT ck_fact_full_product_price_currency
        CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_fact_full_product_price_direction
        CHECK (direction IN ('IN', 'OUT', 'UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS ix_fact_full_product_price_lookup
    ON fact.full_product_price_observation (
        store_code,
        supplier_code,
        supplier_sku,
        platform_sku_id,
        source_business_at DESC NULLS LAST,
        observed_at DESC
    );

COMMENT ON TABLE fact.full_product_price_observation IS
    'Append-only finance-report unit-price evidence. Report and detail identifiers are retained as hashes; estimated homepage amount is derived only from a matched latest valid unit price.';

DROP TRIGGER IF EXISTS trg_fact_full_product_price_append_only
    ON fact.full_product_price_observation;
CREATE TRIGGER trg_fact_full_product_price_append_only
BEFORE UPDATE OR DELETE ON fact.full_product_price_observation
FOR EACH ROW EXECUTE FUNCTION ops.reject_webapi_evidence_mutation();

COMMIT;
