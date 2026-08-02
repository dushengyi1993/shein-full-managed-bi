BEGIN;

DO $verify$
DECLARE
    relation_name text;
BEGIN
    FOREACH relation_name IN ARRAY ARRAY[
        'fact.full_home_ledger_daily',
        'fact.full_home_finance_report_observation',
        'fact.full_home_finance_adjustment_observation',
        'fact.full_home_bill_daily'
    ]
    LOOP
        IF to_regclass(relation_name) IS NULL THEN
            RAISE EXCEPTION 'full homepage ledger/bill relation is missing: %',
                relation_name;
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'fact'
          AND table_name = 'full_home_ledger_daily'
          AND column_name = 'customer_outbound_count'
    ) OR NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'fact'
          AND table_name = 'full_home_ledger_daily'
          AND column_name = 'outbound_count'
    ) THEN
        RAISE EXCEPTION 'ledger customer shipment and total outbound must remain separate';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'fact'
          AND table_name = 'full_home_bill_daily'
          AND column_name = 'reported_settlement_amount'
    ) OR NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'fact'
          AND table_name = 'full_home_bill_daily'
          AND column_name = 'calculated_settlement_amount'
    ) THEN
        RAISE EXCEPTION 'bill reconciliation amounts are missing';
    END IF;
END
$verify$;

ROLLBACK;
