BEGIN;

CREATE TABLE IF NOT EXISTS fact.full_home_finance_detail_observation (
    observation_key character(64) PRIMARY KEY,
    store_code text NOT NULL,
    report_order_no_hash character(64) NOT NULL,
    detail_row_key_hash character(64) NOT NULL,
    report_generated_date date NOT NULL,
    business_date date NOT NULL,
    currency character(3) NOT NULL,
    direction text NOT NULL,
    amount numeric(20, 4) NOT NULL,
    goods_count bigint NOT NULL,
    product_key text,
    platform_sku_id text,
    platform_skc_id text,
    supplier_sku text,
    unit_price numeric(20, 6),
    source_business_at timestamptz NOT NULL,
    observed_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_full_home_finance_detail_source
        UNIQUE (store_code, report_order_no_hash, detail_row_key_hash),
    CONSTRAINT ck_full_home_finance_detail_store
        CHECK (store_code IN ('DL5477', 'MZ2406')),
    CONSTRAINT ck_full_home_finance_detail_hashes
        CHECK (
            observation_key ~ '^[0-9a-f]{64}$'
            AND report_order_no_hash ~ '^[0-9a-f]{64}$'
            AND detail_row_key_hash ~ '^[0-9a-f]{64}$'
        ),
    CONSTRAINT ck_full_home_finance_detail_currency
        CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_full_home_finance_detail_direction
        CHECK (direction IN ('IN', 'OUT')),
    CONSTRAINT ck_full_home_finance_detail_values
        CHECK (
            amount >= 0
            AND goods_count >= 0
            AND (unit_price IS NULL OR unit_price >= 0)
        ),
    CONSTRAINT ck_full_home_finance_detail_product_key
        CHECK (
            product_key IS NULL
            OR length(btrim(product_key)) BETWEEN 1 AND 160
        )
);

CREATE INDEX IF NOT EXISTS ix_full_home_finance_detail_report
    ON fact.full_home_finance_detail_observation (
        store_code,
        report_order_no_hash,
        report_generated_date
    );

CREATE INDEX IF NOT EXISTS ix_full_home_finance_detail_business
    ON fact.full_home_finance_detail_observation (
        store_code,
        business_date,
        currency
    );

COMMENT ON TABLE fact.full_home_finance_detail_observation IS
    'Hashed finance report-detail facts. Report generation windows may overlap detail business dates; daily homepage facts are rebuilt from this deduplicated source.';

COMMIT;
