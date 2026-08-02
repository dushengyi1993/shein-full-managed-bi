BEGIN;

-- 0014 introduced a closed endpoint vocabulary for append-only WebAPI audit
-- evidence. The official inventory-ledger contract was added later in 0019;
-- widen only that vocabulary so every accepted ledger window can retain its
-- request/response hashes and bounded row counts.
ALTER TABLE raw.webapi_home_fetch_audit
    DROP CONSTRAINT IF EXISTS ck_raw_webapi_home_fetch_endpoint,
    ADD CONSTRAINT ck_raw_webapi_home_fetch_endpoint
        CHECK (endpoint_code IN (
            'STORE_DAILY_HISTORY',
            'STORE_REALTIME',
            'TRADE_OVERVIEW',
            'REGION_RANK',
            'PRODUCT_DAILY',
            'ANALYSE_MODEL',
            'ANALYSE_SEARCH',
            'LEDGER_DAILY'
        ));

COMMIT;
