DO $$
BEGIN
    IF to_regclass('ops.sales_sync_run') IS NULL
       OR to_regclass('ops.sales_quality_event') IS NULL
       OR to_regclass('ops.sales_business_watermark') IS NULL THEN
        RAISE EXCEPTION 'sales trust tables are missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'ops.sales_sync_run'::regclass
          AND conname = 'uq_ops_sales_sync_run_store_key'
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'ops.sales_sync_run'::regclass
          AND conname = 'ck_ops_sales_sync_run_counts'
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'ops.sales_sync_run'::regclass
          AND conname = 'ck_ops_sales_sync_run_business_date'
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'ops.sales_quality_event'::regclass
          AND conname = 'uq_ops_sales_quality_event_run_code'
    ) THEN
        RAISE EXCEPTION 'sales trust constraints are incomplete';
    END IF;

    IF to_regclass('ops.ix_ops_sales_sync_run_store_latest') IS NULL
       OR to_regclass('ops.ix_ops_sales_quality_event_store_latest') IS NULL THEN
        RAISE EXCEPTION 'sales trust indexes are missing';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM ops.sales_business_watermark
        WHERE business_date IS NULL
           OR source_fetched_at IS NULL
           OR coverage_status NOT IN ('COMPLETE', 'PARTIAL')
    ) THEN
        RAISE EXCEPTION 'sales business watermark contains invalid rows';
    END IF;

    IF NOT has_table_privilege(
        'sheinfm_sales_login',
        'ops.sales_sync_run',
        'SELECT,INSERT,UPDATE'
    ) OR NOT has_table_privilege(
        'sheinfm_sales_login',
        'ops.sales_business_watermark',
        'SELECT,INSERT,UPDATE'
    ) OR has_table_privilege(
        'sheinfm_sales_login',
        'ops.sales_sync_run',
        'DELETE'
    ) OR has_table_privilege(
        'sheinfm_sales_login',
        'ops.sales_quality_event',
        'DELETE'
    ) OR has_table_privilege(
        'sheinfm_app',
        'ops.sales_sync_run',
        'INSERT,UPDATE,DELETE,TRUNCATE'
    ) THEN
        RAISE EXCEPTION 'dedicated sales-loader or legacy read-only privileges are invalid';
    END IF;
END;
$$;
