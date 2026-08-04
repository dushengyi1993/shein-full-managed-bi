BEGIN;

-- The dashboard derives an end-of-day pending-settlement position from the
-- merchant bill lifecycle. The materializer needs only the dates, amounts and
-- store/currency grouping columns used by that projection; the hashed report
-- identity and loader-only status fields remain outside its read boundary.
DO $grant$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'sheinfm_materializer_ro'
    ) THEN
        GRANT SELECT (
            store_code,
            report_generated_date,
            currency,
            expected_settlement_amount,
            completed_pay_at,
            estimated_pay_at,
            observed_at
        )
        ON fact.full_home_finance_report_observation
        TO sheinfm_materializer_ro;
    END IF;
END
$grant$;

COMMIT;
