BEGIN;

DO $verify$
BEGIN
    IF to_regclass('fact.full_home_finance_detail_observation') IS NULL THEN
        RAISE EXCEPTION 'full-managed finance detail observation is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'fact.full_home_finance_detail_observation'::regclass
          AND conname = 'uq_full_home_finance_detail_source'
    ) THEN
        RAISE EXCEPTION 'finance detail source identity is not unique';
    END IF;
END
$verify$;

ROLLBACK;
