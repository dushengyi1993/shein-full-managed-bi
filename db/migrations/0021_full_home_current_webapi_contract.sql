BEGIN;

-- The current first-party homepage reads its data-version date before querying
-- history, and the current merchandise details page exposes the paginated SPU
-- list. Keep both read-only contracts in the same closed append-only audit
-- vocabulary as every other reviewed homepage endpoint.
ALTER TABLE raw.webapi_home_fetch_audit
    DROP CONSTRAINT IF EXISTS ck_raw_webapi_home_fetch_endpoint,
    ADD CONSTRAINT ck_raw_webapi_home_fetch_endpoint
        CHECK (endpoint_code IN (
            'UPDATE_TIME',
            'STORE_DAILY_HISTORY',
            'STORE_REALTIME',
            'TRADE_OVERVIEW',
            'REGION_RANK',
            'PRODUCT_DAILY',
            'PRODUCT_DIAGNOSE_LIST',
            'ANALYSE_MODEL',
            'ANALYSE_SEARCH',
            'LEDGER_DAILY'
        ));

COMMIT;
