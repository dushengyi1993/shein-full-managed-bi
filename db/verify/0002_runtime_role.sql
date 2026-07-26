DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = 'sheinfm_app'
          AND rolsuper = false
          AND rolcreatedb = false
          AND rolcreaterole = false
          AND rolreplication = false
          AND rolbypassrls = false
    ) THEN
        RAISE EXCEPTION 'sheinfm_app must exist as a non-privileged login role';
    END IF;

    -- Migration 9999 intentionally converts this legacy login to broad
    -- read-only compatibility. Domain writers use dedicated loader roles.
    IF NOT has_schema_privilege('sheinfm_app', 'fact', 'USAGE')
       OR NOT has_table_privilege('sheinfm_app', 'raw.openapi_fetch_batch', 'SELECT')
       OR NOT has_table_privilege('sheinfm_app', 'dim.store', 'SELECT')
       OR NOT has_table_privilege('sheinfm_app', 'fact.full_sku_sales_snapshot', 'SELECT')
       OR NOT has_table_privilege('sheinfm_app', 'ops.permission_probe', 'SELECT')
       OR NOT has_table_privilege('sheinfm_app', 'mart.full_store_sales_latest', 'SELECT')
       OR has_table_privilege('sheinfm_app', 'raw.openapi_fetch_batch', 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('sheinfm_app', 'fact.full_sku_sales_snapshot', 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('sheinfm_app', 'ops.permission_probe', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
        RAISE EXCEPTION 'sheinfm_app is not read-only after final privilege reconciliation';
    END IF;
END;
$$;
