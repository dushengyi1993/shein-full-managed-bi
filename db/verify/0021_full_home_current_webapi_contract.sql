BEGIN;

DO $verify$
DECLARE
    endpoint_constraint text;
BEGIN
    SELECT pg_get_constraintdef(oid)
    INTO endpoint_constraint
    FROM pg_constraint
    WHERE conrelid = 'raw.webapi_home_fetch_audit'::regclass
      AND conname = 'ck_raw_webapi_home_fetch_endpoint';

    IF endpoint_constraint IS NULL
       OR endpoint_constraint NOT LIKE '%UPDATE_TIME%'
       OR endpoint_constraint NOT LIKE '%PRODUCT_DIAGNOSE_LIST%'
       OR endpoint_constraint NOT LIKE '%STORE_REALTIME%'
       OR endpoint_constraint NOT LIKE '%LEDGER_DAILY%' THEN
        RAISE EXCEPTION
            'current homepage WebAPI audit endpoint contract is incomplete';
    END IF;
END
$verify$;

ROLLBACK;
