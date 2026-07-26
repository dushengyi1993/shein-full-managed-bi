BEGIN;

DO $$
DECLARE
    column_type text;
BEGIN
    SELECT data_type
      INTO column_type
      FROM information_schema.columns
     WHERE table_schema = 'fact'
       AND table_name = 'stock_advice_snapshot'
       AND column_name = 'predicted_daily_sales';

    IF column_type IS DISTINCT FROM 'numeric' THEN
        RAISE EXCEPTION
            'fact.stock_advice_snapshot.predicted_daily_sales must preserve decimal forecasts';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'ck_fact_stock_advice_snapshot_quantities'
           AND conrelid = 'fact.stock_advice_snapshot'::regclass
    ) THEN
        RAISE EXCEPTION
            'stock advice non-negative quantity constraint is missing';
    END IF;
END;
$$;

ROLLBACK;
