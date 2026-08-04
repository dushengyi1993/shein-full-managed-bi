BEGIN;

DO $verify$
DECLARE
    column_name text;
BEGIN
    FOREACH column_name IN ARRAY ARRAY[
        'store_code',
        'report_generated_date',
        'currency',
        'expected_settlement_amount',
        'completed_pay_at',
        'estimated_pay_at',
        'observed_at'
    ]
    LOOP
        IF NOT has_column_privilege(
            'sheinfm_materializer_login',
            'fact.full_home_finance_report_observation',
            column_name,
            'SELECT'
        ) THEN
            RAISE EXCEPTION
                'materializer lacks pending-settlement source column %',
                column_name;
        END IF;
    END LOOP;

    IF has_column_privilege(
        'sheinfm_materializer_login',
        'fact.full_home_finance_report_observation',
        'report_order_no_hash',
        'SELECT'
    ) OR has_table_privilege(
        'sheinfm_materializer_login',
        'fact.full_home_finance_report_observation',
        'INSERT,UPDATE,DELETE,TRUNCATE'
    ) THEN
        RAISE EXCEPTION
            'materializer pending-settlement source privilege is too broad';
    END IF;
END
$verify$;

ROLLBACK;
