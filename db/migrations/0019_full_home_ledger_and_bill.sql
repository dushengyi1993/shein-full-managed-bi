BEGIN;

-- The full-managed ledger is an inventory reconciliation contract. Keep every
-- published daily subtotal so the homepage can distinguish customer shipment
-- quantity from total inventory outbound quantity without scraping detail rows.
CREATE TABLE IF NOT EXISTS fact.full_home_ledger_daily (
    store_code text NOT NULL,
    business_date date NOT NULL,
    currency character(3),
    begin_balance_count bigint,
    inbound_count bigint,
    outbound_count bigint,
    end_balance_count bigint,
    urgent_order_entry_count bigint,
    prepare_order_entry_count bigint,
    inbound_gain_count bigint,
    inbound_return_count bigint,
    supply_change_in_count bigint,
    adjustment_in_count bigint,
    customer_outbound_count bigint,
    direct_customer_outbound_count bigint,
    platform_customer_outbound_count bigint,
    outbound_loss_count bigint,
    supplier_outbound_count bigint,
    inventory_clear_count bigint,
    report_clear_count bigint,
    scrap_count bigint,
    supply_change_out_count bigint,
    adjustment_out_count bigint,
    customer_loss_count bigint,
    begin_balance_amount numeric(20, 4),
    inbound_amount numeric(20, 4),
    outbound_amount numeric(20, 4),
    end_balance_amount numeric(20, 4),
    urgent_order_entry_amount numeric(20, 4),
    prepare_order_entry_amount numeric(20, 4),
    inbound_gain_amount numeric(20, 4),
    inbound_return_amount numeric(20, 4),
    supply_change_in_amount numeric(20, 4),
    adjustment_in_amount numeric(20, 4),
    customer_outbound_amount numeric(20, 4),
    direct_customer_outbound_amount numeric(20, 4),
    platform_customer_outbound_amount numeric(20, 4),
    outbound_loss_amount numeric(20, 4),
    supplier_outbound_amount numeric(20, 4),
    inventory_clear_amount numeric(20, 4),
    report_clear_amount numeric(20, 4),
    scrap_amount numeric(20, 4),
    supply_change_out_amount numeric(20, 4),
    adjustment_out_amount numeric(20, 4),
    customer_loss_amount numeric(20, 4),
    observed_at timestamptz NOT NULL,
    source_contract_version smallint NOT NULL DEFAULT 1,
    quality_status text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_code, business_date),
    CONSTRAINT ck_full_home_ledger_store CHECK (store_code IN (
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397', 'LQ7173',
        'TS8263', 'DL5477', 'FY4021', 'GJ8989', 'QH8028', 'JY8060',
        'ZL3133', 'MZ2406', 'YJ8177', 'RH0099', 'WY9025', 'RH2848',
        'CX2816', 'YJ4042', 'NM4977', 'NM8787', 'NM8831', 'NM7418',
        'DX2420'
    )),
    CONSTRAINT ck_full_home_ledger_currency CHECK (
        currency IS NULL OR currency ~ '^[A-Z]{3}$'
    ),
    CONSTRAINT ck_full_home_ledger_counts CHECK (
        (begin_balance_count IS NULL OR begin_balance_count >= 0)
        AND (inbound_count IS NULL OR inbound_count >= 0)
        AND (outbound_count IS NULL OR outbound_count >= 0)
        AND (end_balance_count IS NULL OR end_balance_count >= 0)
        AND (urgent_order_entry_count IS NULL OR urgent_order_entry_count >= 0)
        AND (prepare_order_entry_count IS NULL OR prepare_order_entry_count >= 0)
        AND (inbound_gain_count IS NULL OR inbound_gain_count >= 0)
        AND (inbound_return_count IS NULL OR inbound_return_count >= 0)
        AND (supply_change_in_count IS NULL OR supply_change_in_count >= 0)
        AND (adjustment_in_count IS NULL OR adjustment_in_count >= 0)
        AND (customer_outbound_count IS NULL OR customer_outbound_count >= 0)
        AND (
            direct_customer_outbound_count IS NULL
            OR direct_customer_outbound_count >= 0
        )
        AND (
            platform_customer_outbound_count IS NULL
            OR platform_customer_outbound_count >= 0
        )
        AND (outbound_loss_count IS NULL OR outbound_loss_count >= 0)
        AND (supplier_outbound_count IS NULL OR supplier_outbound_count >= 0)
        AND (inventory_clear_count IS NULL OR inventory_clear_count >= 0)
        AND (report_clear_count IS NULL OR report_clear_count >= 0)
        AND (scrap_count IS NULL OR scrap_count >= 0)
        AND (supply_change_out_count IS NULL OR supply_change_out_count >= 0)
        AND (adjustment_out_count IS NULL OR adjustment_out_count >= 0)
        AND (customer_loss_count IS NULL OR customer_loss_count >= 0)
    ),
    CONSTRAINT ck_full_home_ledger_amounts CHECK (
        (begin_balance_amount IS NULL OR begin_balance_amount >= 0)
        AND (inbound_amount IS NULL OR inbound_amount >= 0)
        AND (outbound_amount IS NULL OR outbound_amount >= 0)
        AND (end_balance_amount IS NULL OR end_balance_amount >= 0)
        AND (
            urgent_order_entry_amount IS NULL
            OR urgent_order_entry_amount >= 0
        )
        AND (
            prepare_order_entry_amount IS NULL
            OR prepare_order_entry_amount >= 0
        )
        AND (inbound_gain_amount IS NULL OR inbound_gain_amount >= 0)
        AND (inbound_return_amount IS NULL OR inbound_return_amount >= 0)
        AND (supply_change_in_amount IS NULL OR supply_change_in_amount >= 0)
        AND (adjustment_in_amount IS NULL OR adjustment_in_amount >= 0)
        AND (customer_outbound_amount IS NULL OR customer_outbound_amount >= 0)
        AND (
            direct_customer_outbound_amount IS NULL
            OR direct_customer_outbound_amount >= 0
        )
        AND (
            platform_customer_outbound_amount IS NULL
            OR platform_customer_outbound_amount >= 0
        )
        AND (outbound_loss_amount IS NULL OR outbound_loss_amount >= 0)
        AND (supplier_outbound_amount IS NULL OR supplier_outbound_amount >= 0)
        AND (inventory_clear_amount IS NULL OR inventory_clear_amount >= 0)
        AND (report_clear_amount IS NULL OR report_clear_amount >= 0)
        AND (scrap_amount IS NULL OR scrap_amount >= 0)
        AND (supply_change_out_amount IS NULL OR supply_change_out_amount >= 0)
        AND (adjustment_out_amount IS NULL OR adjustment_out_amount >= 0)
        AND (customer_loss_amount IS NULL OR customer_loss_amount >= 0)
    ),
    CONSTRAINT ck_full_home_ledger_quality CHECK (
        quality_status IN ('COMPLETE', 'LEGAL_ZERO', 'PARTIAL')
    ),
    CONSTRAINT ck_full_home_ledger_contract CHECK (
        source_contract_version >= 1
    )
);

CREATE INDEX IF NOT EXISTS ix_full_home_ledger_daily_date
    ON fact.full_home_ledger_daily (business_date DESC, store_code);

COMMENT ON TABLE fact.full_home_ledger_daily IS
    'Official full-managed inventory-ledger daily subtotal. customer_outbound_count is the customer-shipment subset; outbound_count is the wider inventory movement and must not be relabelled as sales.';

-- Report-level observations preserve the official bill status and expected
-- settlement amount. Report identifiers remain hashed at rest.
CREATE TABLE IF NOT EXISTS fact.full_home_finance_report_observation (
    store_code text NOT NULL,
    report_order_no_hash character(64) NOT NULL,
    report_generated_date date NOT NULL,
    report_generated_at timestamptz NOT NULL,
    currency character(3) NOT NULL,
    expected_settlement_amount numeric(20, 4),
    settlement_status smallint,
    completed_pay_at timestamptz,
    estimated_pay_at timestamptz,
    observed_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_code, report_order_no_hash),
    CONSTRAINT ck_full_home_finance_report_store CHECK (store_code IN (
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397', 'LQ7173',
        'TS8263', 'DL5477', 'FY4021', 'GJ8989', 'QH8028', 'JY8060',
        'ZL3133', 'MZ2406', 'YJ8177', 'RH0099', 'WY9025', 'RH2848',
        'CX2816', 'YJ4042', 'NM4977', 'NM8787', 'NM8831', 'NM7418',
        'DX2420'
    )),
    CONSTRAINT ck_full_home_finance_report_hash CHECK (
        report_order_no_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT ck_full_home_finance_report_currency CHECK (
        currency ~ '^[A-Z]{3}$'
    ),
    CONSTRAINT ck_full_home_finance_report_status CHECK (
        settlement_status IS NULL OR settlement_status IN (1, 2, 3)
    )
);

CREATE INDEX IF NOT EXISTS ix_full_home_finance_report_date
    ON fact.full_home_finance_report_observation (
        report_generated_date DESC,
        store_code,
        currency
    );

CREATE TABLE IF NOT EXISTS fact.full_home_finance_adjustment_observation (
    observation_key character(64) PRIMARY KEY,
    store_code text NOT NULL,
    report_order_no_hash character(64) NOT NULL,
    detail_row_key_hash character(64) NOT NULL,
    report_generated_date date NOT NULL,
    currency character(3) NOT NULL,
    direction text NOT NULL,
    amount numeric(20, 4) NOT NULL,
    goods_count bigint NOT NULL DEFAULT 0,
    category text,
    product_key text,
    platform_sku_id text,
    platform_skc_id text,
    supplier_sku text,
    unit_price numeric(20, 6),
    observed_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_full_home_finance_adjustment_source
        UNIQUE (store_code, report_order_no_hash, detail_row_key_hash),
    CONSTRAINT ck_full_home_finance_adjustment_store CHECK (store_code IN (
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397', 'LQ7173',
        'TS8263', 'DL5477', 'FY4021', 'GJ8989', 'QH8028', 'JY8060',
        'ZL3133', 'MZ2406', 'YJ8177', 'RH0099', 'WY9025', 'RH2848',
        'CX2816', 'YJ4042', 'NM4977', 'NM8787', 'NM8831', 'NM7418',
        'DX2420'
    )),
    CONSTRAINT ck_full_home_finance_adjustment_hashes CHECK (
        observation_key ~ '^[0-9a-f]{64}$'
        AND report_order_no_hash ~ '^[0-9a-f]{64}$'
        AND detail_row_key_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT ck_full_home_finance_adjustment_currency CHECK (
        currency ~ '^[A-Z]{3}$'
    ),
    CONSTRAINT ck_full_home_finance_adjustment_direction CHECK (
        direction IN ('SUPPLEMENT', 'DEDUCTION')
    ),
    CONSTRAINT ck_full_home_finance_adjustment_values CHECK (
        amount >= 0
        AND goods_count >= 0
        AND (unit_price IS NULL OR unit_price >= 0)
    ),
    CONSTRAINT ck_full_home_finance_adjustment_product CHECK (
        product_key IS NULL
        OR length(btrim(product_key)) BETWEEN 1 AND 160
    )
);

CREATE INDEX IF NOT EXISTS ix_full_home_finance_adjustment_report
    ON fact.full_home_finance_adjustment_observation (
        store_code,
        report_order_no_hash,
        report_generated_date
    );

-- This is the homepage bill grain. It is deliberately separate from
-- full_home_finance_daily, whose date is the sales-detail addTime.
CREATE TABLE IF NOT EXISTS fact.full_home_bill_daily (
    store_code text NOT NULL,
    business_date date NOT NULL,
    currency character(3) NOT NULL,
    sales_amount numeric(20, 4) NOT NULL DEFAULT 0,
    supplement_amount numeric(20, 4) NOT NULL DEFAULT 0,
    deduction_amount numeric(20, 4) NOT NULL DEFAULT 0,
    calculated_settlement_amount numeric(20, 4) NOT NULL DEFAULT 0,
    reported_settlement_amount numeric(20, 4),
    report_count bigint NOT NULL DEFAULT 0,
    settled_report_count bigint NOT NULL DEFAULT 0,
    pending_report_count bigint NOT NULL DEFAULT 0,
    reconciliation_status text NOT NULL,
    observed_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_code, business_date, currency),
    CONSTRAINT ck_full_home_bill_store CHECK (store_code IN (
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397', 'LQ7173',
        'TS8263', 'DL5477', 'FY4021', 'GJ8989', 'QH8028', 'JY8060',
        'ZL3133', 'MZ2406', 'YJ8177', 'RH0099', 'WY9025', 'RH2848',
        'CX2816', 'YJ4042', 'NM4977', 'NM8787', 'NM8831', 'NM7418',
        'DX2420'
    )),
    CONSTRAINT ck_full_home_bill_currency CHECK (
        currency ~ '^[A-Z]{3}$'
    ),
    CONSTRAINT ck_full_home_bill_values CHECK (
        supplement_amount >= 0
        AND deduction_amount >= 0
        AND report_count >= 0
        AND settled_report_count >= 0
        AND pending_report_count >= 0
    ),
    CONSTRAINT ck_full_home_bill_reconciliation CHECK (
        reconciliation_status IN ('MATCHED', 'MISMATCH', 'UNAVAILABLE')
    )
);

CREATE INDEX IF NOT EXISTS ix_full_home_bill_daily_date
    ON fact.full_home_bill_daily (business_date DESC, store_code, currency);

COMMENT ON TABLE fact.full_home_bill_daily IS
    'Merchant bill by report generation date. calculated settlement is sales plus supplements minus deductions; reported settlement is retained independently for reconciliation.';

ALTER TABLE ops.full_home_finance_sync_window
    ADD COLUMN IF NOT EXISTS adjustment_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS source_contract_version smallint NOT NULL DEFAULT 1;

ALTER TABLE ops.full_home_finance_sync_window
    DROP CONSTRAINT IF EXISTS ck_ops_full_home_finance_sync_counts,
    ADD CONSTRAINT ck_ops_full_home_finance_sync_counts CHECK (
        report_count >= 0
        AND detail_count >= 0
        AND adjustment_count >= 0
        AND source_contract_version >= 1
    );

COMMIT;
