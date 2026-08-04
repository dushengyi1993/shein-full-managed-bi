BEGIN;

-- The official management-analysis page exposes daily unique visitors and
-- buyers through a separate realtime summary endpoint. Hourly curve values
-- cannot be added without double-counting, so retain this read as a distinct
-- audited contract while keeping the response body credential-free.
ALTER TABLE raw.webapi_home_fetch_audit
    DROP CONSTRAINT IF EXISTS ck_raw_webapi_home_fetch_endpoint,
    ADD CONSTRAINT ck_raw_webapi_home_fetch_endpoint
        CHECK (endpoint_code IN (
            'UPDATE_TIME',
            'STORE_DAILY_HISTORY',
            'STORE_REALTIME',
            'STORE_REALTIME_SUMMARY',
            'TRADE_OVERVIEW',
            'REGION_RANK',
            'PRODUCT_DAILY',
            'PRODUCT_DIAGNOSE_LIST',
            'ANALYSE_MODEL',
            'ANALYSE_SEARCH',
            'LEDGER_DAILY'
        ));

COMMIT;
