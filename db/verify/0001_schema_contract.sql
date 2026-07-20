DO $$
DECLARE
    expected_table text;
    expected_tables constant text[] := ARRAY[
        'raw.openapi_fetch_batch',
        'dim.store',
        'dim.full_sku',
        'fact.full_sku_sales_snapshot',
        'mart.full_store_sales_latest',
        'mart.full_product_sales_latest',
        'ops.permission_probe'
    ];
BEGIN
    FOREACH expected_table IN ARRAY expected_tables LOOP
        IF to_regclass(expected_table) IS NULL THEN
            RAISE EXCEPTION 'Missing required relation: %', expected_table;
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'fact'
          AND table_name = 'full_sku_sales_snapshot'
          AND column_name = 'sales_quantity'
          AND data_type = 'bigint'
    ) THEN
        RAISE EXCEPTION 'fact.full_sku_sales_snapshot.sales_quantity must be bigint';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'fact'
          AND table_name = 'full_sku_sales_snapshot'
          AND column_name IN (
              'amount', 'sales_amount', 'revenue', 'gmv', 'order_count',
              'cost', 'margin', 'profit'
          )
    ) THEN
        RAISE EXCEPTION 'Unsupported amount/order/profit measure leaked into the sales snapshot fact';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'uq_fact_full_sku_sales_snapshot_business_grain'
          AND conrelid = 'fact.full_sku_sales_snapshot'::regclass
    ) THEN
        RAISE EXCEPTION 'Missing business-grain idempotency constraint on sales snapshots';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'uq_ops_permission_probe_idempotency'
          AND conrelid = 'ops.permission_probe'::regclass
    ) THEN
        RAISE EXCEPTION 'Missing permission-probe idempotency constraint';
    END IF;
END;
$$;

SELECT 'full-managed BI schema contract OK' AS result;
