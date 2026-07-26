DO $$
DECLARE
    expected_table text;
    expected_tables constant text[] := ARRAY[
        'raw.openapi_fetch_page',
        'ops.supply_sync_attempt',
        'fact.supply_projection_batch',
        'fact.supply_projection_member',
        'dim.full_warehouse',
        'fact.purchase_order',
        'fact.purchase_order_line',
        'fact.purchase_order_jit_relation',
        'fact.delivery',
        'fact.delivery_line',
        'fact.inventory_snapshot',
        'fact.warehouse_inventory_snapshot',
        'fact.stock_advice_snapshot',
        'fact.shortage_event',
        'ops.reconciliation_result'
    ];
BEGIN
    FOREACH expected_table IN ARRAY expected_tables LOOP
        IF to_regclass(expected_table) IS NULL THEN
            RAISE EXCEPTION 'Missing required relation: %', expected_table;
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'uq_fact_purchase_order_store_no'
          AND conrelid = 'fact.purchase_order'::regclass
    ) THEN
        RAISE EXCEPTION 'Missing store-scoped purchase-order natural key';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'uq_fact_delivery_store_code'
          AND conrelid = 'fact.delivery'::regclass
    ) THEN
        RAISE EXCEPTION 'Missing store-scoped delivery natural key';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema IN ('raw', 'dim', 'fact', 'ops')
          AND table_name IN (
              'openapi_fetch_page', 'full_warehouse', 'purchase_order',
              'purchase_order_line', 'purchase_order_jit_relation',
              'delivery', 'delivery_line', 'inventory_snapshot',
              'warehouse_inventory_snapshot', 'stock_advice_snapshot',
              'shortage_event', 'reconciliation_result'
          )
          AND column_name IN (
              'person', 'contact', 'contact_name', 'phone', 'mobile',
              'address', 'recipient', 'receiver'
          )
    ) THEN
        RAISE EXCEPTION 'Supply-domain warehouse contains a prohibited contact/address column';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_fact_inventory_snapshot_quantities'
          AND conrelid = 'fact.inventory_snapshot'::regclass
    ) THEN
        RAISE EXCEPTION 'Missing non-negative aggregate inventory guard';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_fact_purchase_order_line_store_order'
          AND conrelid = 'fact.purchase_order_line'::regclass
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_fact_delivery_line_store_delivery'
          AND conrelid = 'fact.delivery_line'::regclass
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_fact_warehouse_inventory_store_snapshot'
          AND conrelid = 'fact.warehouse_inventory_snapshot'::regclass
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_fact_supply_projection_member_batch'
          AND conrelid = 'fact.supply_projection_member'::regclass
    ) THEN
        RAISE EXCEPTION 'Missing store-scoped supply child foreign key';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'uq_fact_purchase_order_line_observation'
          AND conrelid = 'fact.purchase_order_line'::regclass
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'uq_fact_delivery_line_observation'
          AND conrelid = 'fact.delivery_line'::regclass
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'uq_fact_purchase_order_jit_relation_observation'
          AND conrelid = 'fact.purchase_order_jit_relation'::regclass
    ) THEN
        RAISE EXCEPTION 'Missing immutable child-line observation grain';
    END IF;

    IF to_regclass('fact.uq_fact_purchase_order_line_current') IS NULL
       OR to_regclass('fact.uq_fact_delivery_line_current') IS NULL
       OR to_regclass('fact.uq_fact_purchase_order_jit_relation_current') IS NULL
       OR to_regclass('fact.ix_fact_inventory_snapshot_latest') IS NULL
       OR to_regclass('fact.ix_fact_stock_advice_snapshot_latest') IS NULL
       OR to_regclass('fact.ix_fact_supply_projection_batch_latest') IS NULL
       OR to_regclass('fact.ix_fact_supply_projection_member_sku') IS NULL
       OR to_regclass('ops.ix_ops_supply_sync_attempt_latest_health') IS NULL THEN
        RAISE EXCEPTION 'Missing current/latest supply indexes';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_fact_stock_advice_snapshot_warning_observation'
          AND conrelid = 'fact.stock_advice_snapshot'::regclass
    ) THEN
        RAISE EXCEPTION 'Missing stock-warning known/unknown guard';
    END IF;

    IF (
        SELECT count(*)
        FROM information_schema.columns
        WHERE table_schema = 'dim'
          AND table_name = 'full_sku'
          AND column_name IN (
              'supply_catalog_source_fetch_batch_id',
              'supply_catalog_source_fetched_at',
              'detail_source_fetch_batch_id',
              'detail_source_fetched_at'
          )
    ) <> 4 THEN
        RAISE EXCEPTION 'Missing supply-only SKU enrichment provenance';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'fact'
          AND (
              (
                  table_name = 'purchase_order_line'
                  AND column_name IN (
                      'need_quantity', 'order_quantity', 'delivery_quantity',
                      'receipt_quantity', 'storage_quantity',
                      'defective_quantity', 'request_delivery_quantity',
                      'no_request_delivery_quantity',
                      'already_delivery_quantity', 'retired_at'
                  )
              )
              OR (
                  table_name = 'delivery_line'
                  AND column_name IN ('order_no', 'sku_code', 'delivery_quantity', 'retired_at')
              )
              OR (
                  table_name = 'inventory_snapshot'
                  AND column_name IN (
                      'total_out_of_stock_quantity', 'total_transit_quantity'
                  )
              )
              OR (
                  table_name = 'warehouse_inventory_snapshot'
                  AND column_name IN ('out_of_stock_quantity', 'transit_quantity')
              )
          )
          AND is_nullable <> 'YES'
    ) THEN
        RAISE EXCEPTION 'Unknown supply quantities/identifiers must remain nullable';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_app') THEN
        IF NOT has_table_privilege(
            'sheinfm_app', 'raw.openapi_fetch_page', 'SELECT'
        ) OR has_table_privilege(
            'sheinfm_app', 'raw.openapi_fetch_page', 'INSERT,UPDATE,DELETE,TRUNCATE'
        ) OR NOT has_table_privilege(
            'sheinfm_app', 'ops.supply_sync_attempt', 'SELECT'
        ) OR has_table_privilege(
            'sheinfm_app', 'ops.supply_sync_attempt', 'INSERT,UPDATE,DELETE,TRUNCATE'
        ) OR NOT has_table_privilege(
            'sheinfm_app', 'fact.supply_projection_batch', 'SELECT'
        ) OR has_table_privilege(
            'sheinfm_app', 'fact.supply_projection_batch', 'INSERT,UPDATE,DELETE,TRUNCATE'
        ) OR NOT has_table_privilege(
            'sheinfm_app', 'fact.supply_projection_member', 'SELECT'
        ) OR has_table_privilege(
            'sheinfm_app', 'fact.supply_projection_member', 'INSERT,UPDATE,DELETE,TRUNCATE'
        ) OR NOT has_table_privilege(
            'sheinfm_supply_login', 'raw.openapi_fetch_page', 'SELECT,INSERT'
        ) OR NOT has_table_privilege(
            'sheinfm_supply_login', 'ops.supply_sync_attempt', 'SELECT,INSERT'
        ) OR has_table_privilege(
            'sheinfm_supply_login', 'ops.supply_sync_attempt', 'UPDATE,DELETE'
        ) OR NOT has_table_privilege(
            'sheinfm_supply_login', 'fact.supply_projection_batch', 'SELECT,INSERT'
        ) OR has_table_privilege(
            'sheinfm_supply_login', 'fact.supply_projection_batch', 'UPDATE,DELETE'
        ) OR NOT has_table_privilege(
            'sheinfm_supply_login', 'fact.supply_projection_member', 'SELECT,INSERT'
        ) OR has_table_privilege(
            'sheinfm_supply_login', 'fact.supply_projection_member', 'UPDATE,DELETE'
        ) THEN
            RAISE EXCEPTION 'Append-only supply evidence permissions are incorrect';
        END IF;
    END IF;
END;
$$;

SELECT 'full-managed supply-domain contract OK' AS result;
