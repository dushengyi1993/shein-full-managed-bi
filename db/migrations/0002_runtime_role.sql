\getenv sheinfm_app_password SHEIN_FM_APP_DB_PASSWORD

BEGIN;

SELECT 'CREATE ROLE sheinfm_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_app')
\gexec

SELECT format(
    'ALTER ROLE sheinfm_app PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
    :'sheinfm_app_password'
)
\gexec

SELECT current_database() AS sheinfm_database
\gset

GRANT CONNECT ON DATABASE :"sheinfm_database" TO sheinfm_app;
GRANT USAGE ON SCHEMA raw, dim, fact, mart, ops TO sheinfm_app;

REVOKE ALL ON ALL TABLES IN SCHEMA raw, dim, fact, mart, ops FROM sheinfm_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA raw, dim, fact, mart, ops FROM sheinfm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA raw, dim, fact, mart, ops
    REVOKE ALL ON TABLES FROM sheinfm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA raw, dim, fact, mart, ops
    REVOKE ALL ON SEQUENCES FROM sheinfm_app;

GRANT SELECT, INSERT, UPDATE ON raw.openapi_fetch_batch TO sheinfm_app;
GRANT SELECT, INSERT, UPDATE ON dim.store, dim.full_sku TO sheinfm_app;
GRANT SELECT, INSERT ON fact.full_sku_sales_snapshot TO sheinfm_app;
GRANT SELECT, INSERT, DELETE ON mart.full_store_sales_latest, mart.full_product_sales_latest TO sheinfm_app;
GRANT SELECT, INSERT ON ops.permission_probe TO sheinfm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA raw, dim, fact, mart, ops TO sheinfm_app;

COMMIT;
