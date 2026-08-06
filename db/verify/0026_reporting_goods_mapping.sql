DO $$
DECLARE
    required_relation text;
BEGIN
    FOREACH required_relation IN ARRAY ARRAY[
        'dim.reporting_goods',
        'dim.full_sku_reporting_goods_assignment',
        'ops.reporting_goods_import_run'
    ]
    LOOP
        IF to_regclass(required_relation) IS NULL THEN
            RAISE EXCEPTION 'required reporting-goods relation is missing: %', required_relation;
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'dim'
          AND indexname = 'uq_dim_full_sku_reporting_current'
    ) THEN
        RAISE EXCEPTION 'current reporting-goods assignment uniqueness index is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'dim'
          AND indexname = 'ix_dim_full_sku_reporting_superseded_by'
    ) THEN
        RAISE EXCEPTION 'reporting-goods rollback index is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'dim.full_sku_reporting_goods_assignment'::regclass
          AND conname = 'fk_dim_full_sku_reporting_store_sku'
    ) THEN
        RAISE EXCEPTION 'reporting-goods assignment store/SKU foreign key is missing';
    END IF;
END
$$;

SELECT 'reporting goods mapping contract OK' AS result;
