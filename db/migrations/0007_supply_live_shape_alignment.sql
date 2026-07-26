BEGIN;

-- SHEIN's production full-managed stock-goods-list response exposes
-- predictDaySales as a decimal rate even though the current official schema
-- still describes it as an integer. Preserve the observed forecast without
-- rounding; all actual unit-count fields remain bigint.
ALTER TABLE fact.stock_advice_snapshot
    ALTER COLUMN predicted_daily_sales TYPE numeric
    USING predicted_daily_sales::numeric;

COMMENT ON COLUMN fact.stock_advice_snapshot.predicted_daily_sales IS
    'Non-negative platform forecast rate. Production may return decimals; this is not an actual unit count.';

COMMIT;
