BEGIN;

CREATE TABLE IF NOT EXISTS fact.full_home_finance_daily (
    store_code text NOT NULL,
    business_date date NOT NULL,
    currency character(3) NOT NULL,
    income_amount numeric(20, 4) NOT NULL DEFAULT 0,
    expense_amount numeric(20, 4) NOT NULL DEFAULT 0,
    net_amount numeric(20, 4) NOT NULL DEFAULT 0,
    goods_count bigint NOT NULL DEFAULT 0,
    report_count bigint NOT NULL DEFAULT 0,
    observed_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_code, business_date, currency),
    CONSTRAINT ck_fact_full_home_finance_store
        CHECK (store_code IN ('DL5477', 'MZ2406')),
    CONSTRAINT ck_fact_full_home_finance_currency
        CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_fact_full_home_finance_values
        CHECK (
            income_amount >= 0
            AND expense_amount >= 0
            AND goods_count >= 0
            AND report_count >= 0
        )
);

CREATE INDEX IF NOT EXISTS ix_fact_full_home_finance_daily_date
    ON fact.full_home_finance_daily (business_date DESC, store_code, currency);

COMMENT ON TABLE fact.full_home_finance_daily IS
    'Financial-ledger income and expense by report-detail addTime date. This is a settlement ledger date, not a consumer order date or GMV.';

CREATE TABLE IF NOT EXISTS fact.full_home_product_finance_daily (
    store_code text NOT NULL,
    business_date date NOT NULL,
    currency character(3) NOT NULL,
    product_key text NOT NULL,
    platform_sku_id text,
    platform_skc_id text,
    supplier_sku text,
    income_amount numeric(20, 4) NOT NULL DEFAULT 0,
    expense_amount numeric(20, 4) NOT NULL DEFAULT 0,
    net_amount numeric(20, 4) NOT NULL DEFAULT 0,
    goods_count bigint NOT NULL DEFAULT 0,
    latest_unit_price numeric(20, 6),
    price_observed_at timestamptz,
    observed_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_code, business_date, currency, product_key),
    CONSTRAINT ck_fact_full_home_product_finance_store
        CHECK (store_code IN ('DL5477', 'MZ2406')),
    CONSTRAINT ck_fact_full_home_product_finance_currency
        CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_fact_full_home_product_finance_key
        CHECK (length(btrim(product_key)) BETWEEN 1 AND 160),
    CONSTRAINT ck_fact_full_home_product_finance_values
        CHECK (
            income_amount >= 0
            AND expense_amount >= 0
            AND goods_count >= 0
            AND (latest_unit_price IS NULL OR latest_unit_price >= 0)
        ),
    CONSTRAINT ck_fact_full_home_product_finance_price
        CHECK (
            (latest_unit_price IS NULL AND price_observed_at IS NULL)
            OR (latest_unit_price IS NOT NULL AND price_observed_at IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS ix_fact_full_home_product_finance_rank
    ON fact.full_home_product_finance_daily (
        business_date DESC,
        store_code,
        currency,
        income_amount DESC
    );

COMMENT ON TABLE fact.full_home_product_finance_daily IS
    'Product-level report sales detail by ledger generation date. goods_count is a finance-detail quantity, not silently relabeled as consumer-day sales.';

CREATE TABLE IF NOT EXISTS ops.full_home_finance_sync_window (
    store_code text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    result_status text NOT NULL,
    report_count integer NOT NULL DEFAULT 0,
    detail_count integer NOT NULL DEFAULT 0,
    observed_at timestamptz NOT NULL,
    completed_at timestamptz NOT NULL,
    sanitized_error_code text,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_code, start_date, end_date),
    CONSTRAINT ck_ops_full_home_finance_sync_store
        CHECK (store_code IN ('DL5477', 'MZ2406')),
    CONSTRAINT ck_ops_full_home_finance_sync_window
        CHECK (start_date <= end_date AND end_date - start_date <= 6),
    CONSTRAINT ck_ops_full_home_finance_sync_status
        CHECK (result_status IN ('SUCCEEDED', 'FAILED')),
    CONSTRAINT ck_ops_full_home_finance_sync_counts
        CHECK (report_count >= 0 AND detail_count >= 0),
    CONSTRAINT ck_ops_full_home_finance_sync_error
        CHECK (
            sanitized_error_code IS NULL
            OR sanitized_error_code ~ '^[A-Z][A-Z0-9_]{2,80}$'
        ),
    CONSTRAINT ck_ops_full_home_finance_sync_time
        CHECK (completed_at >= observed_at)
);

COMMIT;
