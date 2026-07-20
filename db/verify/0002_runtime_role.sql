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

    IF NOT has_schema_privilege('sheinfm_app', 'fact', 'USAGE')
       OR NOT has_table_privilege('sheinfm_app', 'raw.openapi_fetch_batch', 'SELECT,INSERT,UPDATE')
       OR NOT has_table_privilege('sheinfm_app', 'dim.store', 'SELECT,INSERT,UPDATE')
       OR NOT has_table_privilege('sheinfm_app', 'fact.full_sku_sales_snapshot', 'SELECT,INSERT')
       OR NOT has_table_privilege('sheinfm_app', 'ops.permission_probe', 'SELECT,INSERT')
       OR NOT has_table_privilege('sheinfm_app', 'mart.full_store_sales_latest', 'SELECT,INSERT,DELETE')
       OR has_table_privilege('sheinfm_app', 'raw.openapi_fetch_batch', 'DELETE,TRUNCATE')
       OR has_table_privilege('sheinfm_app', 'fact.full_sku_sales_snapshot', 'UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('sheinfm_app', 'ops.permission_probe', 'UPDATE,DELETE,TRUNCATE') THEN
        RAISE EXCEPTION 'sheinfm_app warehouse grants do not match the runtime contract';
    END IF;
END;
$$;
