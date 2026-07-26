BEGIN;

CREATE TABLE IF NOT EXISTS raw.openapi_fetch_page (
    openapi_fetch_page_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    endpoint_code text NOT NULL,
    page_number integer NOT NULL,
    page_size integer NOT NULL,
    response_record_count integer NOT NULL,
    request_fingerprint character(64) NOT NULL,
    response_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    sanitized_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_raw_openapi_fetch_page_source
        UNIQUE (store_id, source_fetch_batch_id, endpoint_code, page_number),
    CONSTRAINT ck_raw_openapi_fetch_page_endpoint CHECK (endpoint_code <> ''),
    CONSTRAINT ck_raw_openapi_fetch_page_page CHECK (page_number >= 1 AND page_size >= 1),
    CONSTRAINT ck_raw_openapi_fetch_page_record_count
        CHECK (response_record_count >= 0 AND response_record_count <= page_size),
    CONSTRAINT ck_raw_openapi_fetch_page_request_fingerprint
        CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_raw_openapi_fetch_page_response_fingerprint
        CHECK (response_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_raw_openapi_fetch_page_metadata
        CHECK (jsonb_typeof(sanitized_metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS ix_raw_openapi_fetch_page_store_endpoint_time
    ON raw.openapi_fetch_page (store_id, endpoint_code, source_fetched_at DESC);

COMMENT ON TABLE raw.openapi_fetch_page IS
    'Sanitized page evidence only. Headers, tokens, signatures, contacts, phone numbers and addresses are forbidden.';

CREATE TABLE IF NOT EXISTS ops.supply_sync_attempt (
    supply_sync_attempt_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    attempt_id text NOT NULL,
    domain_code text NOT NULL,
    subtype_code text NOT NULL,
    mode_code text NOT NULL,
    freshness_scope_code text NOT NULL,
    window_start_at timestamptz,
    window_end_at timestamptz,
    requested_count bigint,
    observed_count bigint,
    status_code text NOT NULL,
    error_code text,
    error_reason text,
    source_fetch_batch_id bigint
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    request_fingerprint character(64) NOT NULL,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_supply_sync_attempt_event
        UNIQUE (
            store_id, domain_code, subtype_code, attempt_id, status_code
        ),
    CONSTRAINT ck_ops_supply_sync_attempt_codes
        CHECK (
            attempt_id <> ''
            AND domain_code <> ''
            AND subtype_code <> ''
            AND mode_code <> ''
            AND freshness_scope_code IN ('LIVE', 'BACKFILL')
            AND status_code IN ('STARTED', 'SUCCEEDED', 'PARTIAL', 'FAILED')
        ),
    CONSTRAINT ck_ops_supply_sync_attempt_window
        CHECK (
            (window_start_at IS NULL) = (window_end_at IS NULL)
            AND (window_end_at IS NULL OR window_end_at >= window_start_at)
        ),
    CONSTRAINT ck_ops_supply_sync_attempt_counts
        CHECK (
            (requested_count IS NULL OR requested_count >= 0)
            AND (observed_count IS NULL OR observed_count >= 0)
            AND (
                requested_count IS NULL
                OR observed_count IS NULL
                OR observed_count <= requested_count
            )
            AND (
                status_code <> 'SUCCEEDED'
                OR requested_count IS NULL
                OR observed_count IS NULL
                OR observed_count = requested_count
            )
        ),
    CONSTRAINT ck_ops_supply_sync_attempt_status
        CHECK (
            (
                status_code = 'STARTED'
                AND completed_at IS NULL
                AND error_code IS NULL
                AND error_reason IS NULL
            )
            OR (
                status_code = 'SUCCEEDED'
                AND completed_at IS NOT NULL
                AND completed_at >= started_at
                AND error_code IS NULL
                AND error_reason IS NULL
            )
            OR (
                status_code IN ('PARTIAL', 'FAILED')
                AND completed_at IS NOT NULL
                AND completed_at >= started_at
                AND error_code IS NOT NULL
                AND error_reason IS NOT NULL
            )
        ),
    CONSTRAINT ck_ops_supply_sync_attempt_fingerprint
        CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_supply_sync_attempt_terminal
    ON ops.supply_sync_attempt (
        store_id, domain_code, subtype_code, attempt_id
    )
    WHERE status_code IN ('SUCCEEDED', 'PARTIAL', 'FAILED');

CREATE INDEX IF NOT EXISTS ix_ops_supply_sync_attempt_latest_health
    ON ops.supply_sync_attempt (
        store_id, domain_code, subtype_code, freshness_scope_code,
        COALESCE(completed_at, started_at) DESC,
        supply_sync_attempt_event_id DESC
    );

COMMENT ON TABLE ops.supply_sync_attempt IS
    'Append-only sync attempt event ledger. LIVE and BACKFILL are separate freshness scopes; raw success alone is not health evidence.';

CREATE TABLE IF NOT EXISTS fact.supply_projection_batch (
    supply_projection_batch_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    domain_code text NOT NULL,
    subtype_code text NOT NULL,
    coverage_status_code text NOT NULL,
    requested_count bigint,
    observed_count bigint NOT NULL,
    member_count bigint NOT NULL,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_fact_supply_projection_batch_source
        UNIQUE (store_id, domain_code, subtype_code, source_fetch_batch_id),
    CONSTRAINT uq_fact_supply_projection_batch_observation
        UNIQUE (store_id, domain_code, subtype_code, source_fetched_at),
    CONSTRAINT uq_fact_supply_projection_batch_store_id
        UNIQUE (store_id, supply_projection_batch_id),
    CONSTRAINT ck_fact_supply_projection_batch_codes
        CHECK (
            domain_code IN ('INVENTORY', 'STOCK_ADVICE')
            AND subtype_code <> ''
            AND coverage_status_code IN ('COMPLETE', 'PARTIAL')
        ),
    CONSTRAINT ck_fact_supply_projection_batch_counts
        CHECK (
            observed_count >= 0
            AND member_count >= 0
            AND (requested_count IS NULL OR requested_count >= observed_count)
            AND (
                coverage_status_code <> 'PARTIAL'
                OR requested_count IS NOT NULL
            )
        ),
    CONSTRAINT ck_fact_supply_projection_batch_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS ix_fact_supply_projection_batch_latest
    ON fact.supply_projection_batch (
        store_id, domain_code, subtype_code, source_fetched_at DESC,
        supply_projection_batch_id DESC
    );

COMMENT ON TABLE fact.supply_projection_batch IS
    'Trusted batch membership for current inventory/advice projections. COMPLETE empty batches clear current state; PARTIAL batches never fall back to older SKU facts.';

CREATE TABLE IF NOT EXISTS fact.supply_projection_member (
    supply_projection_member_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    supply_projection_batch_id bigint NOT NULL,
    sku_code text NOT NULL,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_fact_supply_projection_member_batch
        FOREIGN KEY (store_id, supply_projection_batch_id)
        REFERENCES fact.supply_projection_batch (
            store_id, supply_projection_batch_id
        )
        ON DELETE RESTRICT,
    CONSTRAINT uq_fact_supply_projection_member_sku
        UNIQUE (store_id, supply_projection_batch_id, sku_code),
    CONSTRAINT ck_fact_supply_projection_member_code CHECK (sku_code <> ''),
    CONSTRAINT ck_fact_supply_projection_member_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS ix_fact_supply_projection_member_sku
    ON fact.supply_projection_member (store_id, sku_code, source_fetched_at DESC);

COMMENT ON TABLE fact.supply_projection_member IS
    'SKU membership frozen at projection time; later catalog activation cannot resurrect an older fact row.';

CREATE OR REPLACE FUNCTION ops.reject_supply_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_supply_sync_attempt_append_only
    ON ops.supply_sync_attempt;
CREATE TRIGGER trg_ops_supply_sync_attempt_append_only
BEFORE UPDATE OR DELETE ON ops.supply_sync_attempt
FOR EACH ROW EXECUTE FUNCTION ops.reject_supply_append_only_mutation();

DROP TRIGGER IF EXISTS trg_raw_openapi_fetch_page_append_only
    ON raw.openapi_fetch_page;
CREATE TRIGGER trg_raw_openapi_fetch_page_append_only
BEFORE UPDATE OR DELETE ON raw.openapi_fetch_page
FOR EACH ROW EXECUTE FUNCTION ops.reject_supply_append_only_mutation();

DROP TRIGGER IF EXISTS trg_fact_supply_projection_batch_append_only
    ON fact.supply_projection_batch;
CREATE TRIGGER trg_fact_supply_projection_batch_append_only
BEFORE UPDATE OR DELETE ON fact.supply_projection_batch
FOR EACH ROW EXECUTE FUNCTION ops.reject_supply_append_only_mutation();

DROP TRIGGER IF EXISTS trg_fact_supply_projection_member_append_only
    ON fact.supply_projection_member;
CREATE TRIGGER trg_fact_supply_projection_member_append_only
BEFORE UPDATE OR DELETE ON fact.supply_projection_member
FOR EACH ROW EXECUTE FUNCTION ops.reject_supply_append_only_mutation();

ALTER TABLE dim.full_sku
    ADD COLUMN IF NOT EXISTS supply_catalog_source_fetch_batch_id bigint
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS supply_catalog_source_fetched_at timestamptz,
    ADD COLUMN IF NOT EXISTS detail_source_fetch_batch_id bigint
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS detail_source_fetched_at timestamptz;

COMMENT ON COLUMN dim.full_sku.supply_catalog_source_fetched_at IS
    'Latest stable supply-catalog enrichment time. The sales number-list sweep remains the sole owner of membership fields.';

COMMENT ON COLUMN dim.full_sku.detail_source_fetched_at IS
    'Latest product-detail observation time. Product detail never changes catalog membership or is_active.';

CREATE TABLE IF NOT EXISTS dim.full_warehouse (
    full_warehouse_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    warehouse_code text NOT NULL,
    warehouse_type_code text NOT NULL,
    warehouse_name text,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    first_seen_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_dim_full_warehouse_store_natural
        UNIQUE (store_id, warehouse_code, warehouse_type_code),
    CONSTRAINT uq_dim_full_warehouse_store_id
        UNIQUE (store_id, full_warehouse_id),
    CONSTRAINT ck_dim_full_warehouse_code CHECK (warehouse_code <> ''),
    CONSTRAINT ck_dim_full_warehouse_type CHECK (warehouse_type_code <> ''),
    CONSTRAINT ck_dim_full_warehouse_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_dim_full_warehouse_seen_order CHECK (last_seen_at >= first_seen_at)
);

COMMENT ON TABLE dim.full_warehouse IS
    'Store-scoped SHEIN warehouse identity. warehouse_type_code is intentionally open-ended so unknown platform codes are preserved.';

CREATE TABLE IF NOT EXISTS fact.purchase_order (
    purchase_order_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    order_no text NOT NULL,
    order_type_code text,
    order_type_name text,
    status_code text,
    status_name text,
    prepare_type_code text,
    prepare_type_name text,
    category_code text,
    category_name text,
    currency_code text,
    warehouse_code text,
    warehouse_name text,
    jit_role_code text,
    platform_created_at timestamptz,
    platform_updated_at timestamptz,
    requested_delivery_at timestamptz,
    requested_receipt_at timestamptz,
    delivered_at timestamptz,
    received_at timestamptz,
    stored_at timestamptz,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_fact_purchase_order_store_no UNIQUE (store_id, order_no),
    CONSTRAINT uq_fact_purchase_order_store_id UNIQUE (store_id, purchase_order_id),
    CONSTRAINT ck_fact_purchase_order_no CHECK (order_no <> ''),
    CONSTRAINT ck_fact_purchase_order_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE fact.purchase_order IS
    'Latest source-observed purchase order state. Unknown type/status/JIT codes are retained verbatim; operator and contact fields are not stored.';

CREATE TABLE IF NOT EXISTS fact.purchase_order_line (
    purchase_order_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    purchase_order_id bigint NOT NULL,
    source_line_key text NOT NULL,
    sku_code text,
    skc_name text,
    supplier_code text,
    supplier_sku text,
    variant_name text,
    need_quantity bigint,
    order_quantity bigint,
    delivery_quantity bigint,
    receipt_quantity bigint,
    storage_quantity bigint,
    defective_quantity bigint,
    request_delivery_quantity bigint,
    no_request_delivery_quantity bigint,
    already_delivery_quantity bigint,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    is_current boolean NOT NULL DEFAULT true,
    retired_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_fact_purchase_order_line_store_order
        FOREIGN KEY (store_id, purchase_order_id)
        REFERENCES fact.purchase_order (store_id, purchase_order_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_fact_purchase_order_line_source
        UNIQUE (
            store_id, source_fetch_batch_id, purchase_order_id, source_line_key
        ),
    CONSTRAINT uq_fact_purchase_order_line_observation
        UNIQUE (
            store_id, purchase_order_id, source_line_key, source_fetched_at
        ),
    CONSTRAINT ck_fact_purchase_order_line_key CHECK (source_line_key <> ''),
    CONSTRAINT ck_fact_purchase_order_line_identity
        CHECK (sku_code IS NOT NULL OR skc_name IS NOT NULL OR supplier_code IS NOT NULL),
    CONSTRAINT ck_fact_purchase_order_line_quantities
        CHECK (
            (need_quantity IS NULL OR need_quantity >= 0)
            AND (order_quantity IS NULL OR order_quantity >= 0)
            AND (delivery_quantity IS NULL OR delivery_quantity >= 0)
            AND (receipt_quantity IS NULL OR receipt_quantity >= 0)
            AND (storage_quantity IS NULL OR storage_quantity >= 0)
            AND (defective_quantity IS NULL OR defective_quantity >= 0)
            AND (request_delivery_quantity IS NULL OR request_delivery_quantity >= 0)
            AND (no_request_delivery_quantity IS NULL OR no_request_delivery_quantity >= 0)
            AND (already_delivery_quantity IS NULL OR already_delivery_quantity >= 0)
        ),
    CONSTRAINT ck_fact_purchase_order_line_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_fact_purchase_order_line_current
        CHECK (
            (is_current AND retired_at IS NULL)
            OR (
                NOT is_current
                AND retired_at IS NOT NULL
                AND retired_at >= source_fetched_at
            )
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fact_purchase_order_line_current
    ON fact.purchase_order_line (store_id, purchase_order_id, source_line_key)
    WHERE is_current;

CREATE INDEX IF NOT EXISTS ix_fact_purchase_order_line_sku
    ON fact.purchase_order_line (store_id, sku_code, source_fetched_at DESC)
    WHERE sku_code IS NOT NULL AND is_current;

CREATE TABLE IF NOT EXISTS fact.purchase_order_jit_relation (
    purchase_order_jit_relation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    mother_order_no text NOT NULL,
    child_order_no text NOT NULL,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    is_current boolean NOT NULL DEFAULT true,
    retired_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_fact_purchase_order_jit_relation_source
        UNIQUE (
            store_id, source_fetch_batch_id,
            mother_order_no, child_order_no
        ),
    CONSTRAINT uq_fact_purchase_order_jit_relation_observation
        UNIQUE (
            store_id, mother_order_no, child_order_no, source_fetched_at
        ),
    CONSTRAINT ck_fact_purchase_order_jit_relation_codes
        CHECK (
            mother_order_no <> ''
            AND child_order_no <> ''
            AND mother_order_no <> child_order_no
        ),
    CONSTRAINT ck_fact_purchase_order_jit_relation_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_fact_purchase_order_jit_relation_current
        CHECK (
            (is_current AND retired_at IS NULL)
            OR (
                NOT is_current
                AND retired_at IS NOT NULL
                AND retired_at >= source_fetched_at
            )
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fact_purchase_order_jit_relation_current
    ON fact.purchase_order_jit_relation (
        store_id, mother_order_no, child_order_no
    )
    WHERE is_current;

CREATE TABLE IF NOT EXISTS fact.delivery (
    delivery_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    delivery_code text NOT NULL,
    delivery_type_code text,
    delivery_type_name text,
    logistics_label_print_flag_code text,
    express_code text,
    express_company_code text,
    express_company_name text,
    package_count integer,
    package_weight numeric(18,6),
    warehouse_code text,
    warehouse_name text,
    platform_created_at timestamptz,
    reserved_parcel_at timestamptz,
    taken_at timestamptz,
    expected_receipt_at timestamptz,
    received_at timestamptz,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_fact_delivery_store_code UNIQUE (store_id, delivery_code),
    CONSTRAINT uq_fact_delivery_store_id UNIQUE (store_id, delivery_id),
    CONSTRAINT ck_fact_delivery_code CHECK (delivery_code <> ''),
    CONSTRAINT ck_fact_delivery_counts
        CHECK (
            (package_count IS NULL OR package_count >= 0)
            AND (package_weight IS NULL OR package_weight >= 0)
        ),
    CONSTRAINT ck_fact_delivery_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE fact.delivery IS
    'Latest source-observed delivery state. Consolidation address, recipient and phone are intentionally excluded.';

CREATE TABLE IF NOT EXISTS fact.delivery_line (
    delivery_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    delivery_id bigint NOT NULL,
    source_line_key text NOT NULL,
    order_no text,
    skc_name text NOT NULL,
    sku_code text,
    delivery_quantity bigint,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    is_current boolean NOT NULL DEFAULT true,
    retired_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_fact_delivery_line_store_delivery
        FOREIGN KEY (store_id, delivery_id)
        REFERENCES fact.delivery (store_id, delivery_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_fact_delivery_line_source
        UNIQUE (store_id, source_fetch_batch_id, delivery_id, source_line_key),
    CONSTRAINT uq_fact_delivery_line_observation
        UNIQUE (store_id, delivery_id, source_line_key, source_fetched_at),
    CONSTRAINT ck_fact_delivery_line_key CHECK (source_line_key <> ''),
    CONSTRAINT ck_fact_delivery_line_codes
        CHECK ((order_no IS NULL OR order_no <> '') AND skc_name <> ''),
    CONSTRAINT ck_fact_delivery_line_quantity
        CHECK (delivery_quantity IS NULL OR delivery_quantity >= 0),
    CONSTRAINT ck_fact_delivery_line_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_fact_delivery_line_current
        CHECK (
            (is_current AND retired_at IS NULL)
            OR (
                NOT is_current
                AND retired_at IS NOT NULL
                AND retired_at >= source_fetched_at
            )
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fact_delivery_line_current
    ON fact.delivery_line (store_id, delivery_id, source_line_key)
    WHERE is_current;

CREATE INDEX IF NOT EXISTS ix_fact_delivery_line_order
    ON fact.delivery_line (store_id, order_no, source_fetched_at DESC)
    WHERE is_current;

CREATE TABLE IF NOT EXISTS fact.inventory_snapshot (
    inventory_snapshot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    sku_code text NOT NULL,
    skc_name text,
    spu_name text,
    inventory_type_code text NOT NULL,
    total_inventory_quantity bigint NOT NULL,
    total_locked_quantity bigint NOT NULL,
    total_temp_lock_quantity bigint NOT NULL,
    total_usable_inventory bigint NOT NULL,
    total_out_of_stock_quantity bigint,
    total_transit_quantity bigint,
    reconciliation_status text NOT NULL,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    source_row_key text NOT NULL,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_fact_inventory_snapshot_source
        UNIQUE (store_id, source_fetch_batch_id, source_row_key),
    CONSTRAINT uq_fact_inventory_snapshot_grain
        UNIQUE (store_id, sku_code, inventory_type_code, source_fetched_at),
    CONSTRAINT uq_fact_inventory_snapshot_store_id
        UNIQUE (store_id, inventory_snapshot_id),
    CONSTRAINT ck_fact_inventory_snapshot_codes
        CHECK (sku_code <> '' AND inventory_type_code <> '' AND source_row_key <> ''),
    CONSTRAINT ck_fact_inventory_snapshot_quantities
        CHECK (
            total_inventory_quantity >= 0
            AND total_locked_quantity >= 0
            AND total_temp_lock_quantity >= 0
            AND total_usable_inventory >= 0
            AND (
                total_out_of_stock_quantity IS NULL
                OR total_out_of_stock_quantity >= 0
            )
            AND (total_transit_quantity IS NULL OR total_transit_quantity >= 0)
        ),
    CONSTRAINT ck_fact_inventory_snapshot_reconciliation
        CHECK (
            reconciliation_status IN (
                'RECONCILED', 'TOTAL_ONLY', 'PARTIAL_DETAIL', 'MISMATCH'
            )
        ),
    CONSTRAINT ck_fact_inventory_snapshot_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS ix_fact_inventory_snapshot_latest
    ON fact.inventory_snapshot (
        store_id, inventory_type_code, sku_code, source_fetched_at DESC
    );

CREATE TABLE IF NOT EXISTS fact.warehouse_inventory_snapshot (
    warehouse_inventory_snapshot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    inventory_snapshot_id bigint NOT NULL,
    full_warehouse_id bigint NOT NULL,
    inventory_quantity bigint NOT NULL,
    locked_quantity bigint NOT NULL,
    temp_lock_quantity bigint NOT NULL,
    usable_inventory bigint NOT NULL,
    out_of_stock_quantity bigint,
    transit_quantity bigint,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_fact_warehouse_inventory_store_snapshot
        FOREIGN KEY (store_id, inventory_snapshot_id)
        REFERENCES fact.inventory_snapshot (store_id, inventory_snapshot_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_fact_warehouse_inventory_store_warehouse
        FOREIGN KEY (store_id, full_warehouse_id)
        REFERENCES dim.full_warehouse (store_id, full_warehouse_id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_fact_warehouse_inventory_grain
        UNIQUE (store_id, inventory_snapshot_id, full_warehouse_id),
    CONSTRAINT ck_fact_warehouse_inventory_quantities
        CHECK (
            inventory_quantity >= 0
            AND locked_quantity >= 0
            AND temp_lock_quantity >= 0
            AND usable_inventory >= 0
            AND (out_of_stock_quantity IS NULL OR out_of_stock_quantity >= 0)
            AND (transit_quantity IS NULL OR transit_quantity >= 0)
        ),
    CONSTRAINT ck_fact_warehouse_inventory_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS fact.stock_advice_snapshot (
    stock_advice_snapshot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    sku_code text NOT NULL,
    skc_name text NOT NULL,
    spu_name text NOT NULL,
    supplier_code text,
    predicted_daily_sales bigint,
    pending_order_quantity bigint,
    pending_delivery_quantity bigint,
    pending_shelf_quantity bigint,
    transit_quantity bigint,
    stock_quantity bigint,
    advised_order_quantity bigint,
    placed_order_quantity bigint,
    planned_urgent_quantity bigint,
    supply_status_code text,
    shelf_status_code text,
    stock_warning_status_code text,
    stock_warning_observed boolean NOT NULL,
    stock_warning_is_warning boolean,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    source_row_key text NOT NULL,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_fact_stock_advice_snapshot_source
        UNIQUE (store_id, source_fetch_batch_id, source_row_key),
    CONSTRAINT uq_fact_stock_advice_snapshot_grain
        UNIQUE (store_id, sku_code, source_fetched_at),
    CONSTRAINT ck_fact_stock_advice_snapshot_codes
        CHECK (sku_code <> '' AND skc_name <> '' AND spu_name <> '' AND source_row_key <> ''),
    CONSTRAINT ck_fact_stock_advice_snapshot_quantities
        CHECK (
            (predicted_daily_sales IS NULL OR predicted_daily_sales >= 0)
            AND (pending_order_quantity IS NULL OR pending_order_quantity >= 0)
            AND (pending_delivery_quantity IS NULL OR pending_delivery_quantity >= 0)
            AND (pending_shelf_quantity IS NULL OR pending_shelf_quantity >= 0)
            AND (transit_quantity IS NULL OR transit_quantity >= 0)
            AND (stock_quantity IS NULL OR stock_quantity >= 0)
            AND (advised_order_quantity IS NULL OR advised_order_quantity >= 0)
            AND (placed_order_quantity IS NULL OR placed_order_quantity >= 0)
            AND (planned_urgent_quantity IS NULL OR planned_urgent_quantity >= 0)
        ),
    CONSTRAINT ck_fact_stock_advice_snapshot_warning_observation
        CHECK (
            stock_warning_observed = (stock_warning_is_warning IS NOT NULL)
        ),
    CONSTRAINT ck_fact_stock_advice_snapshot_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS ix_fact_stock_advice_snapshot_latest
    ON fact.stock_advice_snapshot (store_id, sku_code, source_fetched_at DESC);

CREATE TABLE IF NOT EXISTS fact.shortage_event (
    shortage_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    event_key character(64) NOT NULL,
    sku_code text NOT NULL,
    inventory_type_code text NOT NULL,
    shortage_quantity bigint NOT NULL,
    event_status_code text NOT NULL,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_fact_shortage_event_store_key UNIQUE (store_id, event_key),
    CONSTRAINT ck_fact_shortage_event_key CHECK (event_key ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_fact_shortage_event_codes
        CHECK (sku_code <> '' AND inventory_type_code <> '' AND event_status_code <> ''),
    CONSTRAINT ck_fact_shortage_event_quantity CHECK (shortage_quantity >= 0),
    CONSTRAINT ck_fact_shortage_event_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS ix_fact_shortage_event_latest
    ON fact.shortage_event (store_id, source_fetched_at DESC, sku_code);

CREATE TABLE IF NOT EXISTS ops.reconciliation_result (
    reconciliation_result_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id bigint NOT NULL REFERENCES dim.store (store_id) ON DELETE RESTRICT,
    reconciliation_key character(64) NOT NULL,
    domain_code text NOT NULL,
    entity_key text NOT NULL,
    metric_code text NOT NULL,
    status_code text NOT NULL,
    aggregate_quantity bigint,
    detail_quantity bigint,
    difference_quantity bigint,
    explanation text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_fetch_batch_id bigint NOT NULL
        REFERENCES raw.openapi_fetch_batch (fetch_batch_id) ON DELETE RESTRICT,
    payload_fingerprint character(64) NOT NULL,
    source_fetched_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_ops_reconciliation_result_store_key
        UNIQUE (store_id, reconciliation_key),
    CONSTRAINT ck_ops_reconciliation_result_key
        CHECK (reconciliation_key ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ops_reconciliation_result_codes
        CHECK (
            domain_code <> ''
            AND entity_key <> ''
            AND metric_code <> ''
            AND status_code <> ''
            AND explanation <> ''
        ),
    CONSTRAINT ck_ops_reconciliation_result_quantities
        CHECK (
            (aggregate_quantity IS NULL OR aggregate_quantity >= 0)
            AND (detail_quantity IS NULL OR detail_quantity >= 0)
        ),
    CONSTRAINT ck_ops_reconciliation_result_details
        CHECK (jsonb_typeof(details) = 'object'),
    CONSTRAINT ck_ops_reconciliation_result_fingerprint
        CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS ix_ops_reconciliation_result_attention
    ON ops.reconciliation_result (store_id, domain_code, source_fetched_at DESC)
    WHERE status_code NOT IN ('MATCH', 'NOT_EXPOSED');

DROP TRIGGER IF EXISTS trg_dim_full_warehouse_touch_updated_at ON dim.full_warehouse;
CREATE TRIGGER trg_dim_full_warehouse_touch_updated_at
BEFORE UPDATE ON dim.full_warehouse
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_fact_purchase_order_touch_updated_at ON fact.purchase_order;
CREATE TRIGGER trg_fact_purchase_order_touch_updated_at
BEFORE UPDATE ON fact.purchase_order
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_fact_purchase_order_line_touch_updated_at ON fact.purchase_order_line;
CREATE TRIGGER trg_fact_purchase_order_line_touch_updated_at
BEFORE UPDATE ON fact.purchase_order_line
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_fact_purchase_order_jit_relation_touch_updated_at
    ON fact.purchase_order_jit_relation;
CREATE TRIGGER trg_fact_purchase_order_jit_relation_touch_updated_at
BEFORE UPDATE ON fact.purchase_order_jit_relation
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_fact_delivery_touch_updated_at ON fact.delivery;
CREATE TRIGGER trg_fact_delivery_touch_updated_at
BEFORE UPDATE ON fact.delivery
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_fact_delivery_line_touch_updated_at ON fact.delivery_line;
CREATE TRIGGER trg_fact_delivery_line_touch_updated_at
BEFORE UPDATE ON fact.delivery_line
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_fact_inventory_snapshot_touch_updated_at ON fact.inventory_snapshot;
CREATE TRIGGER trg_fact_inventory_snapshot_touch_updated_at
BEFORE UPDATE ON fact.inventory_snapshot
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_fact_warehouse_inventory_snapshot_touch_updated_at
    ON fact.warehouse_inventory_snapshot;
CREATE TRIGGER trg_fact_warehouse_inventory_snapshot_touch_updated_at
BEFORE UPDATE ON fact.warehouse_inventory_snapshot
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_fact_stock_advice_snapshot_touch_updated_at
    ON fact.stock_advice_snapshot;
CREATE TRIGGER trg_fact_stock_advice_snapshot_touch_updated_at
BEFORE UPDATE ON fact.stock_advice_snapshot
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_fact_shortage_event_touch_updated_at ON fact.shortage_event;
CREATE TRIGGER trg_fact_shortage_event_touch_updated_at
BEFORE UPDATE ON fact.shortage_event
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_ops_reconciliation_result_touch_updated_at
    ON ops.reconciliation_result;
CREATE TRIGGER trg_ops_reconciliation_result_touch_updated_at
BEFORE UPDATE ON ops.reconciliation_result
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_app') THEN
        GRANT SELECT, INSERT ON raw.openapi_fetch_page TO sheinfm_app;
        GRANT SELECT, INSERT
            ON ops.supply_sync_attempt,
               fact.supply_projection_batch,
               fact.supply_projection_member
            TO sheinfm_app;
        REVOKE UPDATE, DELETE
            ON raw.openapi_fetch_page,
               ops.supply_sync_attempt,
               fact.supply_projection_batch,
               fact.supply_projection_member
            FROM sheinfm_app;
        GRANT SELECT, INSERT, UPDATE
            ON dim.full_warehouse,
               fact.purchase_order,
               fact.purchase_order_line,
               fact.purchase_order_jit_relation,
               fact.delivery,
               fact.delivery_line,
               fact.inventory_snapshot,
               fact.warehouse_inventory_snapshot,
               fact.stock_advice_snapshot,
               fact.shortage_event,
               ops.reconciliation_result
            TO sheinfm_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA raw TO sheinfm_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dim TO sheinfm_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA fact TO sheinfm_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO sheinfm_app;
    END IF;
END;
$$;

COMMIT;
