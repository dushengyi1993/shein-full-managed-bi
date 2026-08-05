BEGIN;

-- The dashboard explains why an analysis metric is unavailable, but it must
-- not inherit access to request hashes or response fingerprints from the raw
-- fetch audit. PostgreSQL column privileges expose only the bounded operational
-- status needed by the materializer.
DO $grant$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'sheinfm_materializer_ro'
    ) THEN
        GRANT SELECT (
            webapi_home_fetch_audit_id,
            store_code,
            endpoint_code,
            result_status,
            sanitized_error_code,
            observed_at
        )
        ON raw.webapi_home_fetch_audit
        TO sheinfm_materializer_ro;
    END IF;
END
$grant$;

COMMIT;
