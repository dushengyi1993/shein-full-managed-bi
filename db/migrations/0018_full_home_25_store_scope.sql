BEGIN;

-- NM7418 is a fifth store of the existing NM legal entity. Extend only the
-- store-code allow-lists; source, quality, uniqueness and append-only
-- constraints remain unchanged.

ALTER TABLE raw.webapi_home_fetch_audit
    DROP CONSTRAINT IF EXISTS ck_raw_webapi_home_fetch_store,
    ADD CONSTRAINT ck_raw_webapi_home_fetch_store CHECK (store_code IN (
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397', 'LQ7173',
        'TS8263', 'DL5477', 'FY4021', 'GJ8989', 'QH8028', 'JY8060',
        'ZL3133', 'MZ2406', 'YJ8177', 'RH0099', 'WY9025', 'RH2848',
        'CX2816', 'YJ4042', 'NM4977', 'NM8787', 'NM8831', 'NM7418',
        'DX2420'
    ));

ALTER TABLE fact.full_home_store_daily
    DROP CONSTRAINT IF EXISTS ck_fact_full_home_store_daily_store,
    ADD CONSTRAINT ck_fact_full_home_store_daily_store CHECK (store_code IN (
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397', 'LQ7173',
        'TS8263', 'DL5477', 'FY4021', 'GJ8989', 'QH8028', 'JY8060',
        'ZL3133', 'MZ2406', 'YJ8177', 'RH0099', 'WY9025', 'RH2848',
        'CX2816', 'YJ4042', 'NM4977', 'NM8787', 'NM8831', 'NM7418',
        'DX2420'
    ));

ALTER TABLE fact.full_home_region_daily
    DROP CONSTRAINT IF EXISTS ck_fact_full_home_region_store,
    ADD CONSTRAINT ck_fact_full_home_region_store CHECK (store_code IN (
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397', 'LQ7173',
        'TS8263', 'DL5477', 'FY4021', 'GJ8989', 'QH8028', 'JY8060',
        'ZL3133', 'MZ2406', 'YJ8177', 'RH0099', 'WY9025', 'RH2848',
        'CX2816', 'YJ4042', 'NM4977', 'NM8787', 'NM8831', 'NM7418',
        'DX2420'
    ));

ALTER TABLE fact.full_home_product_daily
    DROP CONSTRAINT IF EXISTS ck_fact_full_home_product_store,
    ADD CONSTRAINT ck_fact_full_home_product_store CHECK (store_code IN (
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397', 'LQ7173',
        'TS8263', 'DL5477', 'FY4021', 'GJ8989', 'QH8028', 'JY8060',
        'ZL3133', 'MZ2406', 'YJ8177', 'RH0099', 'WY9025', 'RH2848',
        'CX2816', 'YJ4042', 'NM4977', 'NM8787', 'NM8831', 'NM7418',
        'DX2420'
    ));

ALTER TABLE fact.full_product_price_observation
    DROP CONSTRAINT IF EXISTS ck_fact_full_product_price_store,
    ADD CONSTRAINT ck_fact_full_product_price_store CHECK (store_code IN (
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397', 'LQ7173',
        'TS8263', 'DL5477', 'FY4021', 'GJ8989', 'QH8028', 'JY8060',
        'ZL3133', 'MZ2406', 'YJ8177', 'RH0099', 'WY9025', 'RH2848',
        'CX2816', 'YJ4042', 'NM4977', 'NM8787', 'NM8831', 'NM7418',
        'DX2420'
    ));

ALTER TABLE fact.full_home_finance_daily
    DROP CONSTRAINT IF EXISTS ck_fact_full_home_finance_store,
    ADD CONSTRAINT ck_fact_full_home_finance_store CHECK (store_code IN (
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397', 'LQ7173',
        'TS8263', 'DL5477', 'FY4021', 'GJ8989', 'QH8028', 'JY8060',
        'ZL3133', 'MZ2406', 'YJ8177', 'RH0099', 'WY9025', 'RH2848',
        'CX2816', 'YJ4042', 'NM4977', 'NM8787', 'NM8831', 'NM7418',
        'DX2420'
    ));

ALTER TABLE fact.full_home_product_finance_daily
    DROP CONSTRAINT IF EXISTS ck_fact_full_home_product_finance_store,
    ADD CONSTRAINT ck_fact_full_home_product_finance_store CHECK (store_code IN (
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397', 'LQ7173',
        'TS8263', 'DL5477', 'FY4021', 'GJ8989', 'QH8028', 'JY8060',
        'ZL3133', 'MZ2406', 'YJ8177', 'RH0099', 'WY9025', 'RH2848',
        'CX2816', 'YJ4042', 'NM4977', 'NM8787', 'NM8831', 'NM7418',
        'DX2420'
    ));

ALTER TABLE ops.full_home_finance_sync_window
    DROP CONSTRAINT IF EXISTS ck_ops_full_home_finance_sync_store,
    ADD CONSTRAINT ck_ops_full_home_finance_sync_store CHECK (store_code IN (
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397', 'LQ7173',
        'TS8263', 'DL5477', 'FY4021', 'GJ8989', 'QH8028', 'JY8060',
        'ZL3133', 'MZ2406', 'YJ8177', 'RH0099', 'WY9025', 'RH2848',
        'CX2816', 'YJ4042', 'NM4977', 'NM8787', 'NM8831', 'NM7418',
        'DX2420'
    ));

ALTER TABLE fact.full_home_finance_detail_observation
    DROP CONSTRAINT IF EXISTS ck_full_home_finance_detail_store,
    ADD CONSTRAINT ck_full_home_finance_detail_store CHECK (store_code IN (
        'CX4412', 'XL2801', 'QY8886', 'DX0571', 'NM7397', 'LQ7173',
        'TS8263', 'DL5477', 'FY4021', 'GJ8989', 'QH8028', 'JY8060',
        'ZL3133', 'MZ2406', 'YJ8177', 'RH0099', 'WY9025', 'RH2848',
        'CX2816', 'YJ4042', 'NM4977', 'NM8787', 'NM8831', 'NM7418',
        'DX2420'
    ));

COMMIT;
