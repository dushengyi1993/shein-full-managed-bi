BEGIN;

DO $$
DECLARE
    relation_name text;
BEGIN
    FOREACH relation_name IN ARRAY ARRAY[
        'raw.webapi_home_fetch_audit',
        'fact.full_home_store_daily',
        'fact.full_home_region_daily',
        'fact.full_home_product_daily',
        'fact.full_product_price_observation'
    ]
    LOOP
        IF to_regclass(relation_name) IS NULL THEN
            RAISE EXCEPTION 'full homepage history relation missing: %', relation_name;
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'raw.webapi_home_fetch_audit'::regclass
          AND tgname = 'trg_raw_webapi_home_fetch_append_only'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'full homepage fetch audit append-only trigger missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'fact.full_product_price_observation'::regclass
          AND tgname = 'trg_fact_full_product_price_append_only'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'full product price append-only trigger missing';
    END IF;
END;
$$;

ROLLBACK;
