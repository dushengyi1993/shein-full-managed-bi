BEGIN;

-- Merchant-bill facts belong to the platform's completed payment date. The
-- report generation date remains ingestion/freshness metadata and must not
-- become a settlement trend axis.
DELETE FROM fact.full_home_bill_daily;

WITH report_sales AS (
    SELECT
        store_code,
        report_order_no_hash,
        currency,
        SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END)
            AS sales_amount
    FROM fact.full_home_finance_detail_observation
    GROUP BY store_code, report_order_no_hash, currency
),
report_adjustments AS (
    SELECT
        store_code,
        report_order_no_hash,
        currency,
        SUM(CASE WHEN direction = 'SUPPLEMENT' THEN amount ELSE 0 END)
            AS supplement_amount,
        SUM(CASE WHEN direction = 'DEDUCTION' THEN amount ELSE 0 END)
            AS deduction_amount
    FROM fact.full_home_finance_adjustment_observation
    GROUP BY store_code, report_order_no_hash, currency
),
report_rows AS (
    SELECT
        report.store_code,
        (report.completed_pay_at AT TIME ZONE 'Asia/Shanghai')::date
            AS business_date,
        report.currency,
        COALESCE(sales.sales_amount, 0) AS sales_amount,
        COALESCE(adjustment.supplement_amount, 0) AS supplement_amount,
        COALESCE(adjustment.deduction_amount, 0) AS deduction_amount,
        report.expected_settlement_amount,
        report.observed_at
    FROM fact.full_home_finance_report_observation AS report
    LEFT JOIN report_sales AS sales
      ON sales.store_code = report.store_code
     AND sales.report_order_no_hash = report.report_order_no_hash
     AND sales.currency = report.currency
    LEFT JOIN report_adjustments AS adjustment
      ON adjustment.store_code = report.store_code
     AND adjustment.report_order_no_hash = report.report_order_no_hash
     AND adjustment.currency = report.currency
    WHERE report.settlement_status = 3
      AND report.completed_pay_at IS NOT NULL
),
daily AS (
    SELECT
        store_code,
        business_date,
        currency,
        SUM(sales_amount) AS sales_amount,
        SUM(supplement_amount) AS supplement_amount,
        SUM(deduction_amount) AS deduction_amount,
        SUM(sales_amount + supplement_amount - deduction_amount)
            AS calculated_settlement_amount,
        CASE
          WHEN COUNT(expected_settlement_amount) = COUNT(*)
            THEN SUM(expected_settlement_amount)
          ELSE NULL
        END AS reported_settlement_amount,
        COUNT(*) AS report_count,
        MAX(observed_at) AS observed_at
    FROM report_rows
    GROUP BY store_code, business_date, currency
)
INSERT INTO fact.full_home_bill_daily (
    store_code,
    business_date,
    currency,
    sales_amount,
    supplement_amount,
    deduction_amount,
    calculated_settlement_amount,
    reported_settlement_amount,
    report_count,
    settled_report_count,
    pending_report_count,
    reconciliation_status,
    observed_at,
    updated_at
)
SELECT
    store_code,
    business_date,
    currency,
    sales_amount,
    supplement_amount,
    deduction_amount,
    calculated_settlement_amount,
    reported_settlement_amount,
    report_count,
    report_count,
    0,
    CASE
      WHEN reported_settlement_amount IS NULL THEN 'UNAVAILABLE'
      WHEN ABS(calculated_settlement_amount - reported_settlement_amount) <= 0.01
        THEN 'MATCHED'
      ELSE 'MISMATCH'
    END,
    observed_at,
    clock_timestamp()
FROM daily;

COMMENT ON TABLE fact.full_home_bill_daily IS
    'Settled merchant bill by actual completed payment date. Report generation time is freshness metadata only. calculated settlement is sales plus supplements minus deductions; reported settlement is retained independently for reconciliation.';

COMMIT;
