BEGIN;

DO $verify$
BEGIN
    IF to_regclass('fact.full_home_finance_daily') IS NULL
       OR to_regclass('fact.full_home_product_finance_daily') IS NULL
       OR to_regclass('ops.full_home_finance_sync_window') IS NULL THEN
        RAISE EXCEPTION 'full-managed finance homepage relations are missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'ops.full_home_finance_sync_window'::regclass
          AND conname = 'ck_ops_full_home_finance_sync_window'
    ) THEN
        RAISE EXCEPTION 'finance sync window bound is missing';
    END IF;
END
$verify$;

ROLLBACK;
