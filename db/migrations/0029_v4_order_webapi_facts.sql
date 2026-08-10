BEGIN;

-- ---------------------------------------------------------------------------
-- Full-managed v4 order WebAPI typed fact observations.
--
-- Seven typed append-only observation tables, one per verified
-- order-management page of the 2026-08-08 session captures
-- (sso.geiwohuo.com). There is no generic JSONB business row: every page maps
-- to explicit typed columns.
--
-- Every table carries the shared evidence spine:
--   store_code, entity_key_hash, source_version_token, source_attempt_id,
--   source_page_evidence_id, observed_at, source_updated_at, payload_hash
-- and the replay primary key (source_attempt_id, entity_key_hash,
-- source_version_token): an exact replay of the same attempt x entity x
-- version must reproduce the identical row, and any drift rolls back.
--
-- Original document/waybill/case numbers are stored as hashes only (entity
-- identity in entity_key_hash plus explicit *_hash columns for secondary
-- numbers). Addresses, contacts, phones, buyer identifiers, free text and
-- image/attachment URLs are never stored. The loader role rejects sensitive
-- keys and values before any row reaches these tables.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fact.full_webapi_stock_record_observation (
    full_webapi_stock_record_observation_id bigint GENERATED ALWAYS AS IDENTITY,
    store_code text NOT NULL,
    entity_key_hash character(64) NOT NULL,
    source_version_token text NOT NULL,
    source_attempt_id bigint NOT NULL,
    source_page_evidence_id bigint NOT NULL,
    observed_at timestamptz NOT NULL,
    source_updated_at timestamptz,
    payload_hash character(64) NOT NULL,
    order_no_hash character(64),
    supplier_code text,
    skc text,
    order_mode integer,
    order_mode_value text,
    apply_status integer,
    stock_type integer,
    order_sign text,
    add_time timestamptz,
    timezone text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_fact_full_webapi_stock_record_observation
        PRIMARY KEY (source_attempt_id, entity_key_hash, source_version_token),
    CONSTRAINT uq_fact_full_webapi_stock_record_observation_id
        UNIQUE (full_webapi_stock_record_observation_id),
    CONSTRAINT fk_fact_full_webapi_stock_record_attempt
        FOREIGN KEY (source_attempt_id)
        REFERENCES ops.v4_collection_attempt (collection_attempt_id)
        ON DELETE RESTRICT,
    -- Composite pin: the page evidence row must belong to the same attempt
    -- that the fact row cites, enforced by the database.
    CONSTRAINT fk_fact_full_webapi_stock_record_page
        FOREIGN KEY (source_attempt_id, source_page_evidence_id)
        REFERENCES ops.v4_page_evidence (collection_attempt_id, page_evidence_id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_fact_full_webapi_stock_record_store
        CHECK (store_code ~ '^[A-Z]{2}[0-9]{4}$'),
    CONSTRAINT ck_fact_full_webapi_stock_record_hashes
        CHECK (
            entity_key_hash ~ '^[0-9a-f]{64}$'
            AND payload_hash ~ '^[0-9a-f]{64}$'
            AND (order_no_hash IS NULL OR order_no_hash ~ '^[0-9a-f]{64}$')
        ),
    CONSTRAINT ck_fact_full_webapi_stock_record_version
        CHECK (source_version_token ~ '^[A-Za-z0-9._:-]{1,120}$'),
    CONSTRAINT ck_fact_full_webapi_stock_record_texts
        CHECK (
            (supplier_code IS NULL OR length(btrim(supplier_code)) BETWEEN 1 AND 64)
            AND (skc IS NULL OR length(btrim(skc)) BETWEEN 1 AND 64)
            AND (order_mode_value IS NULL OR length(btrim(order_mode_value)) BETWEEN 1 AND 120)
            AND (order_sign IS NULL OR length(btrim(order_sign)) BETWEEN 1 AND 120)
            AND (timezone IS NULL OR length(btrim(timezone)) BETWEEN 1 AND 32)
        ),
    CONSTRAINT ck_fact_full_webapi_stock_record_values
        CHECK (
            (order_mode IS NULL OR order_mode >= 0)
            AND (apply_status IS NULL OR apply_status >= 0)
            AND (stock_type IS NULL OR stock_type >= 0)
        )
);

CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_stock_record_store
    ON fact.full_webapi_stock_record_observation (store_code, observed_at DESC);
CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_stock_record_page
    ON fact.full_webapi_stock_record_observation (source_page_evidence_id);

COMMENT ON TABLE fact.full_webapi_stock_record_observation IS
    'Typed append-only stock-record observations (STOCK_RECORDS_LIST). orderNo is retained as a hash; supplier/skc identifiers and bounded order mode/status codes are typed; no address, contact, phone or free text is stored.';

DROP TRIGGER IF EXISTS trg_fact_full_webapi_stock_record_append_only
    ON fact.full_webapi_stock_record_observation;
CREATE TRIGGER trg_fact_full_webapi_stock_record_append_only
BEFORE UPDATE OR DELETE ON fact.full_webapi_stock_record_observation
FOR EACH ROW EXECUTE FUNCTION ops.reject_v4_evidence_mutation();

CREATE TABLE IF NOT EXISTS fact.full_webapi_waybill_observation (
    full_webapi_waybill_observation_id bigint GENERATED ALWAYS AS IDENTITY,
    store_code text NOT NULL,
    entity_key_hash character(64) NOT NULL,
    source_version_token text NOT NULL,
    source_attempt_id bigint NOT NULL,
    source_page_evidence_id bigint NOT NULL,
    observed_at timestamptz NOT NULL,
    source_updated_at timestamptz,
    payload_hash character(64) NOT NULL,
    logistics_company_code text,
    logistics_company_name text,
    waybill_type integer,
    waybill_type_seller_name text,
    order_type integer,
    order_type_name text,
    service_mode_code integer,
    service_mode_code_name text,
    add_time timestamptz,
    pickup_time timestamptz,
    sign_time timestamptz,
    appointment_pickup_time timestamptz,
    pack_quantity integer,
    send_goods_quantity integer,
    actual_weight numeric(20, 6),
    volume_weight numeric(20, 6),
    estimated_weight numeric(20, 6),
    final_settlement_weight numeric(20, 6),
    converted_final_apportionment numeric(20, 6),
    exemption_amount numeric(20, 4),
    actual_deduction_amount numeric(20, 4),
    changed_estimated_apportionment numeric(20, 4),
    difference_deducted_amount numeric(20, 4),
    supplier_currency_id integer,
    supplier_currency_name text,
    is_free integer,
    is_free_name text,
    sy_status integer,
    sy_status_name text,
    rights_result_type integer,
    rights_result_type_name text,
    order_system integer,
    apportionment_state integer,
    collect_batch_no_hash character(64),
    estimate_combine_no_hash character(64),
    estimated_apportionment_bill_no_hash character(64),
    combine_number_hash character(64),
    apportionment_bill_no_hash character(64),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_fact_full_webapi_waybill_observation
        PRIMARY KEY (source_attempt_id, entity_key_hash, source_version_token),
    CONSTRAINT uq_fact_full_webapi_waybill_observation_id
        UNIQUE (full_webapi_waybill_observation_id),
    CONSTRAINT fk_fact_full_webapi_waybill_attempt
        FOREIGN KEY (source_attempt_id)
        REFERENCES ops.v4_collection_attempt (collection_attempt_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_fact_full_webapi_waybill_page
        FOREIGN KEY (source_attempt_id, source_page_evidence_id)
        REFERENCES ops.v4_page_evidence (collection_attempt_id, page_evidence_id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_fact_full_webapi_waybill_store
        CHECK (store_code ~ '^[A-Z]{2}[0-9]{4}$'),
    CONSTRAINT ck_fact_full_webapi_waybill_hashes
        CHECK (
            entity_key_hash ~ '^[0-9a-f]{64}$'
            AND payload_hash ~ '^[0-9a-f]{64}$'
            AND (
                collect_batch_no_hash IS NULL
                OR collect_batch_no_hash ~ '^[0-9a-f]{64}$'
            )
            AND (
                estimate_combine_no_hash IS NULL
                OR estimate_combine_no_hash ~ '^[0-9a-f]{64}$'
            )
            AND (
                estimated_apportionment_bill_no_hash IS NULL
                OR estimated_apportionment_bill_no_hash ~ '^[0-9a-f]{64}$'
            )
            AND (
                combine_number_hash IS NULL
                OR combine_number_hash ~ '^[0-9a-f]{64}$'
            )
            AND (
                apportionment_bill_no_hash IS NULL
                OR apportionment_bill_no_hash ~ '^[0-9a-f]{64}$'
            )
        ),
    CONSTRAINT ck_fact_full_webapi_waybill_version
        CHECK (source_version_token ~ '^[A-Za-z0-9._:-]{1,120}$'),
    CONSTRAINT ck_fact_full_webapi_waybill_texts
        CHECK (
            (logistics_company_code IS NULL OR length(btrim(logistics_company_code)) BETWEEN 1 AND 64)
            AND (logistics_company_name IS NULL OR length(btrim(logistics_company_name)) BETWEEN 1 AND 160)
            AND (waybill_type_seller_name IS NULL OR length(btrim(waybill_type_seller_name)) BETWEEN 1 AND 120)
            AND (order_type_name IS NULL OR length(btrim(order_type_name)) BETWEEN 1 AND 120)
            AND (service_mode_code_name IS NULL OR length(btrim(service_mode_code_name)) BETWEEN 1 AND 120)
            AND (supplier_currency_name IS NULL OR length(btrim(supplier_currency_name)) BETWEEN 1 AND 64)
            AND (is_free_name IS NULL OR length(btrim(is_free_name)) BETWEEN 1 AND 120)
            AND (sy_status_name IS NULL OR length(btrim(sy_status_name)) BETWEEN 1 AND 120)
            AND (rights_result_type_name IS NULL OR length(btrim(rights_result_type_name)) BETWEEN 1 AND 120)
        ),
    CONSTRAINT ck_fact_full_webapi_waybill_flags
        CHECK (is_free IS NULL OR is_free IN (0, 1)),
    CONSTRAINT ck_fact_full_webapi_waybill_values
        CHECK (
            (waybill_type IS NULL OR waybill_type >= 0)
            AND (order_type IS NULL OR order_type >= 0)
            AND (service_mode_code IS NULL OR service_mode_code >= 0)
            AND (pack_quantity IS NULL OR pack_quantity >= 0)
            AND (send_goods_quantity IS NULL OR send_goods_quantity >= 0)
            AND (actual_weight IS NULL OR actual_weight >= 0)
            AND (volume_weight IS NULL OR volume_weight >= 0)
            AND (estimated_weight IS NULL OR estimated_weight >= 0)
            AND (final_settlement_weight IS NULL OR final_settlement_weight >= 0)
            AND (converted_final_apportionment IS NULL OR converted_final_apportionment >= 0)
            AND (exemption_amount IS NULL OR exemption_amount >= 0)
            AND (actual_deduction_amount IS NULL OR actual_deduction_amount >= 0)
            AND (changed_estimated_apportionment IS NULL OR changed_estimated_apportionment >= 0)
            AND (difference_deducted_amount IS NULL OR difference_deducted_amount >= 0)
            AND (supplier_currency_id IS NULL OR supplier_currency_id >= 0)
            AND (sy_status IS NULL OR sy_status >= 0)
            AND (rights_result_type IS NULL OR rights_result_type >= 0)
            AND (order_system IS NULL OR order_system >= 0)
            AND (apportionment_state IS NULL OR apportionment_state >= 0)
        )
);

CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_waybill_store
    ON fact.full_webapi_waybill_observation (store_code, observed_at DESC);
CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_waybill_page
    ON fact.full_webapi_waybill_observation (source_page_evidence_id);

COMMENT ON TABLE fact.full_webapi_waybill_observation IS
    'Typed append-only waybill observations (WAYBILLS_PAGE). trackingNumber is the hashed entity key; settlement bill numbers and collect batch numbers are retained as hashes; weights, amounts, quantities and bounded carrier/service codes are typed. finalFormula and supplier free text are never stored.';

DROP TRIGGER IF EXISTS trg_fact_full_webapi_waybill_append_only
    ON fact.full_webapi_waybill_observation;
CREATE TRIGGER trg_fact_full_webapi_waybill_append_only
BEFORE UPDATE OR DELETE ON fact.full_webapi_waybill_observation
FOR EACH ROW EXECUTE FUNCTION ops.reject_v4_evidence_mutation();

CREATE TABLE IF NOT EXISTS fact.full_webapi_return_application_observation (
    full_webapi_return_application_observation_id bigint GENERATED ALWAYS AS IDENTITY,
    store_code text NOT NULL,
    entity_key_hash character(64) NOT NULL,
    source_version_token text NOT NULL,
    source_attempt_id bigint NOT NULL,
    source_page_evidence_id bigint NOT NULL,
    observed_at timestamptz NOT NULL,
    source_updated_at timestamptz,
    payload_hash character(64) NOT NULL,
    return_plan_no_hash character(64),
    origin_no_hash character(64),
    return_time timestamptz,
    add_time timestamptz,
    last_update_time timestamptz,
    state integer,
    state_name text,
    return_reason_type integer,
    return_reason_name text,
    return_dimensions integer,
    return_dimensions_name text,
    return_quantity integer,
    return_total_amount numeric(20, 4),
    pricing_currency_id integer,
    currency_code character(3),
    bill_currency_id integer,
    bill_currency_code character(3),
    return_deal_type integer,
    return_deal_type_name text,
    return_mode integer,
    return_mode_name text,
    return_generate_quantity integer,
    return_scrapped_quantity integer,
    return_vss_quantity integer,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_fact_full_webapi_return_application_observation
        PRIMARY KEY (source_attempt_id, entity_key_hash, source_version_token),
    CONSTRAINT uq_fact_full_webapi_return_application_observation_id
        UNIQUE (full_webapi_return_application_observation_id),
    CONSTRAINT fk_fact_full_webapi_return_application_attempt
        FOREIGN KEY (source_attempt_id)
        REFERENCES ops.v4_collection_attempt (collection_attempt_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_fact_full_webapi_return_application_page
        FOREIGN KEY (source_attempt_id, source_page_evidence_id)
        REFERENCES ops.v4_page_evidence (collection_attempt_id, page_evidence_id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_fact_full_webapi_return_application_store
        CHECK (store_code ~ '^[A-Z]{2}[0-9]{4}$'),
    CONSTRAINT ck_fact_full_webapi_return_application_hashes
        CHECK (
            entity_key_hash ~ '^[0-9a-f]{64}$'
            AND payload_hash ~ '^[0-9a-f]{64}$'
            AND (return_plan_no_hash IS NULL OR return_plan_no_hash ~ '^[0-9a-f]{64}$')
            AND (origin_no_hash IS NULL OR origin_no_hash ~ '^[0-9a-f]{64}$')
        ),
    CONSTRAINT ck_fact_full_webapi_return_application_version
        CHECK (source_version_token ~ '^[A-Za-z0-9._:-]{1,120}$'),
    CONSTRAINT ck_fact_full_webapi_return_application_texts
        CHECK (
            (state_name IS NULL OR length(btrim(state_name)) BETWEEN 1 AND 120)
            AND (return_reason_name IS NULL OR length(btrim(return_reason_name)) BETWEEN 1 AND 160)
            AND (return_dimensions_name IS NULL OR length(btrim(return_dimensions_name)) BETWEEN 1 AND 120)
            AND (return_deal_type_name IS NULL OR length(btrim(return_deal_type_name)) BETWEEN 1 AND 120)
            AND (return_mode_name IS NULL OR length(btrim(return_mode_name)) BETWEEN 1 AND 120)
        ),
    CONSTRAINT ck_fact_full_webapi_return_application_currencies
        CHECK (
            (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$')
            AND (bill_currency_code IS NULL OR bill_currency_code ~ '^[A-Z]{3}$')
        ),
    CONSTRAINT ck_fact_full_webapi_return_application_values
        CHECK (
            (state IS NULL OR state >= 0)
            AND (return_reason_type IS NULL OR return_reason_type >= 0)
            AND (return_dimensions IS NULL OR return_dimensions >= 0)
            AND (return_quantity IS NULL OR return_quantity >= 0)
            AND (return_total_amount IS NULL OR return_total_amount >= 0)
            AND (pricing_currency_id IS NULL OR pricing_currency_id >= 0)
            AND (bill_currency_id IS NULL OR bill_currency_id >= 0)
            AND (return_deal_type IS NULL OR return_deal_type >= 0)
            AND (return_mode IS NULL OR return_mode >= 0)
            AND (return_generate_quantity IS NULL OR return_generate_quantity >= 0)
            AND (return_scrapped_quantity IS NULL OR return_scrapped_quantity >= 0)
            AND (return_vss_quantity IS NULL OR return_vss_quantity >= 0)
        )
);

CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_return_application_store
    ON fact.full_webapi_return_application_observation (store_code, observed_at DESC);
CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_return_application_page
    ON fact.full_webapi_return_application_observation (source_page_evidence_id);

COMMENT ON TABLE fact.full_webapi_return_application_observation IS
    'Typed append-only return-application observations (RETURN_APPLICATIONS_LIST). returnPlanNo and originNo are retained as hashes; quantities, amounts, currency ids and bounded reason/deal/mode codes are typed. sellerAddress and contact/phone keys are excluded by the verified allowlist.';

DROP TRIGGER IF EXISTS trg_fact_full_webapi_return_application_append_only
    ON fact.full_webapi_return_application_observation;
CREATE TRIGGER trg_fact_full_webapi_return_application_append_only
BEFORE UPDATE OR DELETE ON fact.full_webapi_return_application_observation
FOR EACH ROW EXECUTE FUNCTION ops.reject_v4_evidence_mutation();

CREATE TABLE IF NOT EXISTS fact.full_webapi_return_order_observation (
    full_webapi_return_order_observation_id bigint GENERATED ALWAYS AS IDENTITY,
    store_code text NOT NULL,
    entity_key_hash character(64) NOT NULL,
    source_version_token text NOT NULL,
    source_attempt_id bigint NOT NULL,
    source_page_evidence_id bigint NOT NULL,
    observed_at timestamptz NOT NULL,
    source_updated_at timestamptz,
    payload_hash character(64) NOT NULL,
    return_plan_no_hash character(64),
    seller_order_no_hash character(64),
    seller_delivery_no_hash character(64),
    return_way_type integer,
    change_return_way_type integer,
    return_way_type_name text,
    return_express_company_code text,
    return_express_company_name text,
    warehouse_id integer,
    warehouse_name text,
    sub_warehouse_id integer,
    sub_warehouse_name text,
    return_order_type integer,
    return_order_type_name text,
    return_order_status integer,
    return_order_status_name text,
    add_time timestamptz,
    sign_time timestamptz,
    complete_time timestamptz,
    waybill_pickup_time timestamptz,
    waybill_sign_time timestamptz,
    update_time timestamptz,
    wait_return_quantity integer,
    return_quantity integer,
    return_box_num integer,
    skc_num integer,
    return_reason_type integer,
    return_reason_name text,
    return_scrap_type integer,
    return_scrap_type_name text,
    return_dimensions integer,
    is_sign integer,
    can_apply_reconsider integer,
    return_amount numeric(20, 4),
    currency_code character(3),
    bill_currency_code character(3),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_fact_full_webapi_return_order_observation
        PRIMARY KEY (source_attempt_id, entity_key_hash, source_version_token),
    CONSTRAINT uq_fact_full_webapi_return_order_observation_id
        UNIQUE (full_webapi_return_order_observation_id),
    CONSTRAINT fk_fact_full_webapi_return_order_attempt
        FOREIGN KEY (source_attempt_id)
        REFERENCES ops.v4_collection_attempt (collection_attempt_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_fact_full_webapi_return_order_page
        FOREIGN KEY (source_attempt_id, source_page_evidence_id)
        REFERENCES ops.v4_page_evidence (collection_attempt_id, page_evidence_id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_fact_full_webapi_return_order_store
        CHECK (store_code ~ '^[A-Z]{2}[0-9]{4}$'),
    CONSTRAINT ck_fact_full_webapi_return_order_hashes
        CHECK (
            entity_key_hash ~ '^[0-9a-f]{64}$'
            AND payload_hash ~ '^[0-9a-f]{64}$'
            AND (return_plan_no_hash IS NULL OR return_plan_no_hash ~ '^[0-9a-f]{64}$')
            AND (seller_order_no_hash IS NULL OR seller_order_no_hash ~ '^[0-9a-f]{64}$')
            AND (seller_delivery_no_hash IS NULL OR seller_delivery_no_hash ~ '^[0-9a-f]{64}$')
        ),
    CONSTRAINT ck_fact_full_webapi_return_order_version
        CHECK (source_version_token ~ '^[A-Za-z0-9._:-]{1,120}$'),
    CONSTRAINT ck_fact_full_webapi_return_order_texts
        CHECK (
            (return_way_type_name IS NULL OR length(btrim(return_way_type_name)) BETWEEN 1 AND 120)
            AND (return_express_company_code IS NULL OR length(btrim(return_express_company_code)) BETWEEN 1 AND 64)
            AND (return_express_company_name IS NULL OR length(btrim(return_express_company_name)) BETWEEN 1 AND 160)
            AND (warehouse_name IS NULL OR length(btrim(warehouse_name)) BETWEEN 1 AND 160)
            AND (sub_warehouse_name IS NULL OR length(btrim(sub_warehouse_name)) BETWEEN 1 AND 160)
            AND (return_order_type_name IS NULL OR length(btrim(return_order_type_name)) BETWEEN 1 AND 120)
            AND (return_order_status_name IS NULL OR length(btrim(return_order_status_name)) BETWEEN 1 AND 120)
            AND (return_reason_name IS NULL OR length(btrim(return_reason_name)) BETWEEN 1 AND 160)
            AND (return_scrap_type_name IS NULL OR length(btrim(return_scrap_type_name)) BETWEEN 1 AND 120)
        ),
    CONSTRAINT ck_fact_full_webapi_return_order_currencies
        CHECK (
            (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$')
            AND (bill_currency_code IS NULL OR bill_currency_code ~ '^[A-Z]{3}$')
        ),
    CONSTRAINT ck_fact_full_webapi_return_order_flags
        CHECK (
            (is_sign IS NULL OR is_sign IN (0, 1))
            AND (can_apply_reconsider IS NULL OR can_apply_reconsider IN (0, 1))
        ),
    CONSTRAINT ck_fact_full_webapi_return_order_values
        CHECK (
            (return_way_type IS NULL OR return_way_type >= 0)
            AND (change_return_way_type IS NULL OR change_return_way_type >= 0)
            AND (warehouse_id IS NULL OR warehouse_id >= 0)
            AND (sub_warehouse_id IS NULL OR sub_warehouse_id >= 0)
            AND (return_order_type IS NULL OR return_order_type >= 0)
            AND (return_order_status IS NULL OR return_order_status >= 0)
            AND (wait_return_quantity IS NULL OR wait_return_quantity >= 0)
            AND (return_quantity IS NULL OR return_quantity >= 0)
            AND (return_box_num IS NULL OR return_box_num >= 0)
            AND (skc_num IS NULL OR skc_num >= 0)
            AND (return_reason_type IS NULL OR return_reason_type >= 0)
            AND (return_scrap_type IS NULL OR return_scrap_type >= 0)
            AND (return_dimensions IS NULL OR return_dimensions >= 0)
            AND (return_amount IS NULL OR return_amount >= 0)
        )
);

CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_return_order_store
    ON fact.full_webapi_return_order_observation (store_code, observed_at DESC);
CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_return_order_page
    ON fact.full_webapi_return_order_observation (source_page_evidence_id);

COMMENT ON TABLE fact.full_webapi_return_order_observation IS
    'Typed append-only return-order observations (RETURN_ORDERS_PAGE). returnOrderNo is the hashed entity key; returnPlanNo and seller order/delivery numbers are retained as hashes; quantities, amounts, warehouse ids and bounded status codes are typed. returnAddress, warehouse contact, phone, driverName, thumb and url keys are excluded by the verified allowlist.';

DROP TRIGGER IF EXISTS trg_fact_full_webapi_return_order_append_only
    ON fact.full_webapi_return_order_observation;
CREATE TRIGGER trg_fact_full_webapi_return_order_append_only
BEFORE UPDATE OR DELETE ON fact.full_webapi_return_order_observation
FOR EACH ROW EXECUTE FUNCTION ops.reject_v4_evidence_mutation();

CREATE TABLE IF NOT EXISTS fact.full_webapi_exception_observation (
    full_webapi_exception_observation_id bigint GENERATED ALWAYS AS IDENTITY,
    store_code text NOT NULL,
    entity_key_hash character(64) NOT NULL,
    source_version_token text NOT NULL,
    source_attempt_id bigint NOT NULL,
    source_page_evidence_id bigint NOT NULL,
    observed_at timestamptz NOT NULL,
    source_updated_at timestamptz,
    payload_hash character(64) NOT NULL,
    external_no_hash character(64),
    category_id integer,
    category_code text,
    category_name text,
    first_category_code text,
    first_category_name text,
    apply_type integer,
    apply_type_name text,
    scene_type integer,
    scene_type_name text,
    status_value integer,
    status_name text,
    create_time timestamptz,
    external_system text,
    workorder_type integer,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_fact_full_webapi_exception_observation
        PRIMARY KEY (source_attempt_id, entity_key_hash, source_version_token),
    CONSTRAINT uq_fact_full_webapi_exception_observation_id
        UNIQUE (full_webapi_exception_observation_id),
    CONSTRAINT fk_fact_full_webapi_exception_attempt
        FOREIGN KEY (source_attempt_id)
        REFERENCES ops.v4_collection_attempt (collection_attempt_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_fact_full_webapi_exception_page
        FOREIGN KEY (source_attempt_id, source_page_evidence_id)
        REFERENCES ops.v4_page_evidence (collection_attempt_id, page_evidence_id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_fact_full_webapi_exception_store
        CHECK (store_code ~ '^[A-Z]{2}[0-9]{4}$'),
    CONSTRAINT ck_fact_full_webapi_exception_hashes
        CHECK (
            entity_key_hash ~ '^[0-9a-f]{64}$'
            AND payload_hash ~ '^[0-9a-f]{64}$'
            AND (external_no_hash IS NULL OR external_no_hash ~ '^[0-9a-f]{64}$')
        ),
    CONSTRAINT ck_fact_full_webapi_exception_version
        CHECK (source_version_token ~ '^[A-Za-z0-9._:-]{1,120}$'),
    CONSTRAINT ck_fact_full_webapi_exception_texts
        CHECK (
            (category_code IS NULL OR length(btrim(category_code)) BETWEEN 1 AND 64)
            AND (category_name IS NULL OR length(btrim(category_name)) BETWEEN 1 AND 160)
            AND (first_category_code IS NULL OR length(btrim(first_category_code)) BETWEEN 1 AND 64)
            AND (first_category_name IS NULL OR length(btrim(first_category_name)) BETWEEN 1 AND 160)
            AND (apply_type_name IS NULL OR length(btrim(apply_type_name)) BETWEEN 1 AND 160)
            AND (scene_type_name IS NULL OR length(btrim(scene_type_name)) BETWEEN 1 AND 160)
            AND (status_name IS NULL OR length(btrim(status_name)) BETWEEN 1 AND 160)
            AND (external_system IS NULL OR length(btrim(external_system)) BETWEEN 1 AND 64)
        ),
    CONSTRAINT ck_fact_full_webapi_exception_values
        CHECK (
            (category_id IS NULL OR category_id >= 0)
            AND (apply_type IS NULL OR apply_type >= 0)
            AND (scene_type IS NULL OR scene_type >= 0)
            AND (status_value IS NULL OR status_value >= 0)
            AND (workorder_type IS NULL OR workorder_type >= 0)
        )
);

CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_exception_store
    ON fact.full_webapi_exception_observation (store_code, observed_at DESC);
CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_exception_page
    ON fact.full_webapi_exception_observation (source_page_evidence_id);

COMMENT ON TABLE fact.full_webapi_exception_observation IS
    'Typed append-only exception-workorder observations (EXCEPTIONS_PAGE). workorderNo is the hashed entity key and externalNo is retained as a hash; category/scene/status codes and create time are typed. sellerTitle, creator, problemDesc, resultReply and attachmentUrl keys are excluded by the verified allowlist.';

DROP TRIGGER IF EXISTS trg_fact_full_webapi_exception_append_only
    ON fact.full_webapi_exception_observation;
CREATE TRIGGER trg_fact_full_webapi_exception_append_only
BEFORE UPDATE OR DELETE ON fact.full_webapi_exception_observation
FOR EACH ROW EXECUTE FUNCTION ops.reject_v4_evidence_mutation();

CREATE TABLE IF NOT EXISTS fact.full_webapi_quality_report_observation (
    full_webapi_quality_report_observation_id bigint GENERATED ALWAYS AS IDENTITY,
    store_code text NOT NULL,
    entity_key_hash character(64) NOT NULL,
    source_version_token text NOT NULL,
    source_attempt_id bigint NOT NULL,
    source_page_evidence_id bigint NOT NULL,
    observed_at timestamptz NOT NULL,
    source_updated_at timestamptz,
    payload_hash character(64) NOT NULL,
    purchase_code_hash character(64),
    skc text,
    has_defective_total integer,
    has_defective_total_name text,
    inspection_time timestamptz,
    defective_total_qty integer,
    qc_type integer,
    qc_type_name text,
    order_defective_total_qty integer,
    order_qc_result integer,
    order_qc_result_name text,
    inspection_result integer,
    inspection_result_name text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_fact_full_webapi_quality_report_observation
        PRIMARY KEY (source_attempt_id, entity_key_hash, source_version_token),
    CONSTRAINT uq_fact_full_webapi_quality_report_observation_id
        UNIQUE (full_webapi_quality_report_observation_id),
    CONSTRAINT fk_fact_full_webapi_quality_report_attempt
        FOREIGN KEY (source_attempt_id)
        REFERENCES ops.v4_collection_attempt (collection_attempt_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_fact_full_webapi_quality_report_page
        FOREIGN KEY (source_attempt_id, source_page_evidence_id)
        REFERENCES ops.v4_page_evidence (collection_attempt_id, page_evidence_id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_fact_full_webapi_quality_report_store
        CHECK (store_code ~ '^[A-Z]{2}[0-9]{4}$'),
    CONSTRAINT ck_fact_full_webapi_quality_report_hashes
        CHECK (
            entity_key_hash ~ '^[0-9a-f]{64}$'
            AND payload_hash ~ '^[0-9a-f]{64}$'
            AND (purchase_code_hash IS NULL OR purchase_code_hash ~ '^[0-9a-f]{64}$')
        ),
    CONSTRAINT ck_fact_full_webapi_quality_report_version
        CHECK (source_version_token ~ '^[A-Za-z0-9._:-]{1,120}$'),
    CONSTRAINT ck_fact_full_webapi_quality_report_texts
        CHECK (
            (skc IS NULL OR length(btrim(skc)) BETWEEN 1 AND 64)
            AND (has_defective_total_name IS NULL OR length(btrim(has_defective_total_name)) BETWEEN 1 AND 120)
            AND (qc_type_name IS NULL OR length(btrim(qc_type_name)) BETWEEN 1 AND 120)
            AND (order_qc_result_name IS NULL OR length(btrim(order_qc_result_name)) BETWEEN 1 AND 120)
            AND (inspection_result_name IS NULL OR length(btrim(inspection_result_name)) BETWEEN 1 AND 120)
        ),
    CONSTRAINT ck_fact_full_webapi_quality_report_flags
        CHECK (has_defective_total IS NULL OR has_defective_total IN (0, 1)),
    CONSTRAINT ck_fact_full_webapi_quality_report_values
        CHECK (
            (defective_total_qty IS NULL OR defective_total_qty >= 0)
            AND (qc_type IS NULL OR qc_type >= 0)
            AND (order_defective_total_qty IS NULL OR order_defective_total_qty >= 0)
            AND (order_qc_result IS NULL OR order_qc_result >= 0)
            AND (inspection_result IS NULL OR inspection_result >= 0)
        )
);

CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_quality_report_store
    ON fact.full_webapi_quality_report_observation (store_code, observed_at DESC);
CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_quality_report_page
    ON fact.full_webapi_quality_report_observation (source_page_evidence_id);

COMMENT ON TABLE fact.full_webapi_quality_report_observation IS
    'Typed append-only quality-report observations (QUALITY_REPORTS_PAGE). qcInspectionNo is the hashed entity key and purchaseCode is retained as a hash; defect quantities, qc type and result codes are typed. img and report URL keys are excluded by the verified allowlist.';

DROP TRIGGER IF EXISTS trg_fact_full_webapi_quality_report_append_only
    ON fact.full_webapi_quality_report_observation;
CREATE TRIGGER trg_fact_full_webapi_quality_report_append_only
BEFORE UPDATE OR DELETE ON fact.full_webapi_quality_report_observation
FOR EACH ROW EXECUTE FUNCTION ops.reject_v4_evidence_mutation();

CREATE TABLE IF NOT EXISTS fact.full_webapi_value_added_service_observation (
    full_webapi_value_added_service_observation_id bigint GENERATED ALWAYS AS IDENTITY,
    store_code text NOT NULL,
    entity_key_hash character(64) NOT NULL,
    source_version_token text NOT NULL,
    source_attempt_id bigint NOT NULL,
    source_page_evidence_id bigint NOT NULL,
    observed_at timestamptz NOT NULL,
    source_updated_at timestamptz,
    payload_hash character(64) NOT NULL,
    order_no_hash character(64),
    sub_order_no_hash character(64),
    purchase_no_hash character(64),
    new_purchase_no_hash character(64),
    qc_inspection_no_hash character(64),
    return_no_hash character(64),
    delivery_no_hash character(64),
    service_site_id integer,
    service_site_name text,
    skc text,
    multi_part_flag integer,
    supplier_product_number text,
    skc_num integer,
    total_flag integer,
    total_flag_name text,
    order_state integer,
    order_state_name text,
    low_value_flag integer,
    value_added_result integer,
    defective_quantity integer,
    order_scene integer,
    return_flag integer,
    vendor_replenish_state integer,
    vendor_replenish_state_name text,
    show_fee_tag integer,
    supplier_source integer,
    supplier_source_name text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_fact_full_webapi_value_added_service_observation
        PRIMARY KEY (source_attempt_id, entity_key_hash, source_version_token),
    CONSTRAINT uq_fact_full_webapi_value_added_service_observation_id
        UNIQUE (full_webapi_value_added_service_observation_id),
    CONSTRAINT fk_fact_full_webapi_value_added_service_attempt
        FOREIGN KEY (source_attempt_id)
        REFERENCES ops.v4_collection_attempt (collection_attempt_id)
        ON DELETE RESTRICT,
    -- Composite pin: the page evidence row must belong to the same attempt
    -- that the fact row cites, enforced by the database.
    CONSTRAINT fk_fact_full_webapi_value_added_service_page
        FOREIGN KEY (source_attempt_id, source_page_evidence_id)
        REFERENCES ops.v4_page_evidence (collection_attempt_id, page_evidence_id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_fact_full_webapi_value_added_service_store
        CHECK (store_code ~ '^[A-Z]{2}[0-9]{4}$'),
    CONSTRAINT ck_fact_full_webapi_value_added_service_hashes
        CHECK (
            entity_key_hash ~ '^[0-9a-f]{64}$'
            AND payload_hash ~ '^[0-9a-f]{64}$'
            AND (order_no_hash IS NULL OR order_no_hash ~ '^[0-9a-f]{64}$')
            AND (sub_order_no_hash IS NULL OR sub_order_no_hash ~ '^[0-9a-f]{64}$')
            AND (purchase_no_hash IS NULL OR purchase_no_hash ~ '^[0-9a-f]{64}$')
            AND (new_purchase_no_hash IS NULL OR new_purchase_no_hash ~ '^[0-9a-f]{64}$')
            AND (qc_inspection_no_hash IS NULL OR qc_inspection_no_hash ~ '^[0-9a-f]{64}$')
            AND (return_no_hash IS NULL OR return_no_hash ~ '^[0-9a-f]{64}$')
            AND (delivery_no_hash IS NULL OR delivery_no_hash ~ '^[0-9a-f]{64}$')
        ),
    CONSTRAINT ck_fact_full_webapi_value_added_service_version
        CHECK (source_version_token ~ '^[A-Za-z0-9._:-]{1,120}$'),
    CONSTRAINT ck_fact_full_webapi_value_added_service_texts
        CHECK (
            (service_site_name IS NULL OR length(btrim(service_site_name)) BETWEEN 1 AND 160)
            AND (skc IS NULL OR length(btrim(skc)) BETWEEN 1 AND 64)
            AND (supplier_product_number IS NULL OR length(btrim(supplier_product_number)) BETWEEN 1 AND 64)
            AND (total_flag_name IS NULL OR length(btrim(total_flag_name)) BETWEEN 1 AND 120)
            AND (order_state_name IS NULL OR length(btrim(order_state_name)) BETWEEN 1 AND 120)
            AND (vendor_replenish_state_name IS NULL OR length(btrim(vendor_replenish_state_name)) BETWEEN 1 AND 120)
            AND (supplier_source_name IS NULL OR length(btrim(supplier_source_name)) BETWEEN 1 AND 120)
        ),
    CONSTRAINT ck_fact_full_webapi_value_added_service_flags
        CHECK (
            (multi_part_flag IS NULL OR multi_part_flag IN (0, 1))
            AND (total_flag IS NULL OR total_flag IN (0, 1))
            AND (low_value_flag IS NULL OR low_value_flag IN (0, 1))
            AND (return_flag IS NULL OR return_flag IN (0, 1))
            AND (show_fee_tag IS NULL OR show_fee_tag IN (0, 1))
        ),
    CONSTRAINT ck_fact_full_webapi_value_added_service_values
        CHECK (
            (service_site_id IS NULL OR service_site_id >= 0)
            AND (skc_num IS NULL OR skc_num >= 0)
            AND (order_state IS NULL OR order_state >= 0)
            AND (value_added_result IS NULL OR value_added_result >= 0)
            AND (defective_quantity IS NULL OR defective_quantity >= 0)
            AND (order_scene IS NULL OR order_scene >= 0)
            AND (vendor_replenish_state IS NULL OR vendor_replenish_state >= 0)
            AND (supplier_source IS NULL OR supplier_source >= 0)
        )
);

CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_value_added_service_store
    ON fact.full_webapi_value_added_service_observation (store_code, observed_at DESC);
CREATE INDEX IF NOT EXISTS ix_fact_full_webapi_value_added_service_page
    ON fact.full_webapi_value_added_service_observation (source_page_evidence_id);

COMMENT ON TABLE fact.full_webapi_value_added_service_observation IS
    'Typed append-only value-added-service observations (VALUE_ADDED_SERVICES_PAGE). id is the hashed entity key; orderNo/subOrderNo/purchaseNo/newPurchaseNo/qcInspectionNo/returnNo/deliveryNo are retained as hashes; service site, skc/product identifiers, counts, status codes, flags and supplier source are typed. actualTotalAmount and estimateIncrementAmount are never stored because the contract carries no currency; img/remark/user/serviceDesc keys are excluded by the verified allowlist.';

DROP TRIGGER IF EXISTS trg_fact_full_webapi_value_added_service_append_only
    ON fact.full_webapi_value_added_service_observation;
CREATE TRIGGER trg_fact_full_webapi_value_added_service_append_only
BEFORE UPDATE OR DELETE ON fact.full_webapi_value_added_service_observation
FOR EACH ROW EXECUTE FUNCTION ops.reject_v4_evidence_mutation();

-- ---------------------------------------------------------------------------
-- Database-enforced fact x attempt binding. Every typed fact row must match
-- the store_code of the attempt it cites, and the attempt must be the exact
-- endpoint the table records. The loader INSERT path cannot bypass this: the
-- guard fires before any row lands, so a direct INSERT with a mismatched
-- store or a VAS row under a STOCK_RECORDS_LIST attempt fails closed in the
-- database itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.guard_v4_fact_attempt_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    attempt_store text;
    attempt_endpoint text;
    expected_endpoint text;
BEGIN
    SELECT store_code, endpoint_code
      INTO attempt_store, attempt_endpoint
      FROM ops.v4_collection_attempt
     WHERE collection_attempt_id = NEW.source_attempt_id;
    IF attempt_store IS NULL THEN
        RAISE EXCEPTION
            'v4 fact row cites a missing source attempt'
            USING ERRCODE = '23503';
    END IF;
    IF NEW.store_code <> attempt_store THEN
        RAISE EXCEPTION
            'v4 fact store_code % does not match source attempt store %',
            NEW.store_code, attempt_store
            USING ERRCODE = '23514';
    END IF;
    -- Each typed fact table records exactly one reviewed endpoint; the CASE
    -- maps the table name so a trigger can never be attached to the wrong
    -- fact domain without failing closed.
    expected_endpoint := CASE TG_TABLE_NAME
        WHEN 'full_webapi_stock_record_observation' THEN 'STOCK_RECORDS_LIST'
        WHEN 'full_webapi_waybill_observation' THEN 'WAYBILLS_PAGE'
        WHEN 'full_webapi_return_application_observation'
            THEN 'RETURN_APPLICATIONS_LIST'
        WHEN 'full_webapi_return_order_observation' THEN 'RETURN_ORDERS_PAGE'
        WHEN 'full_webapi_exception_observation' THEN 'EXCEPTIONS_PAGE'
        WHEN 'full_webapi_quality_report_observation'
            THEN 'QUALITY_REPORTS_PAGE'
        WHEN 'full_webapi_value_added_service_observation'
            THEN 'VALUE_ADDED_SERVICES_PAGE'
        ELSE NULL
    END;
    IF expected_endpoint IS NULL THEN
        RAISE EXCEPTION
            'v4 fact binding guard is attached to an unexpected table %',
            TG_TABLE_NAME
            USING ERRCODE = '22023';
    END IF;
    IF attempt_endpoint <> expected_endpoint THEN
        RAISE EXCEPTION
            'v4 % fact row requires a % source attempt, not %',
            TG_TABLE_NAME, expected_endpoint, attempt_endpoint
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ops.guard_v4_fact_attempt_binding() IS
    'Full-managed v4 fact guard: every typed fact INSERT must match its source attempt store_code and exact endpoint code. Direct loader INSERTs cannot bypass the binding.';

DROP TRIGGER IF EXISTS trg_fact_full_webapi_stock_record_attempt_binding
    ON fact.full_webapi_stock_record_observation;
CREATE TRIGGER trg_fact_full_webapi_stock_record_attempt_binding
BEFORE INSERT ON fact.full_webapi_stock_record_observation
FOR EACH ROW EXECUTE FUNCTION ops.guard_v4_fact_attempt_binding();

DROP TRIGGER IF EXISTS trg_fact_full_webapi_waybill_attempt_binding
    ON fact.full_webapi_waybill_observation;
CREATE TRIGGER trg_fact_full_webapi_waybill_attempt_binding
BEFORE INSERT ON fact.full_webapi_waybill_observation
FOR EACH ROW EXECUTE FUNCTION ops.guard_v4_fact_attempt_binding();

DROP TRIGGER IF EXISTS trg_fact_full_webapi_return_application_attempt_binding
    ON fact.full_webapi_return_application_observation;
CREATE TRIGGER trg_fact_full_webapi_return_application_attempt_binding
BEFORE INSERT ON fact.full_webapi_return_application_observation
FOR EACH ROW EXECUTE FUNCTION ops.guard_v4_fact_attempt_binding();

DROP TRIGGER IF EXISTS trg_fact_full_webapi_return_order_attempt_binding
    ON fact.full_webapi_return_order_observation;
CREATE TRIGGER trg_fact_full_webapi_return_order_attempt_binding
BEFORE INSERT ON fact.full_webapi_return_order_observation
FOR EACH ROW EXECUTE FUNCTION ops.guard_v4_fact_attempt_binding();

DROP TRIGGER IF EXISTS trg_fact_full_webapi_exception_attempt_binding
    ON fact.full_webapi_exception_observation;
CREATE TRIGGER trg_fact_full_webapi_exception_attempt_binding
BEFORE INSERT ON fact.full_webapi_exception_observation
FOR EACH ROW EXECUTE FUNCTION ops.guard_v4_fact_attempt_binding();

DROP TRIGGER IF EXISTS trg_fact_full_webapi_quality_report_attempt_binding
    ON fact.full_webapi_quality_report_observation;
CREATE TRIGGER trg_fact_full_webapi_quality_report_attempt_binding
BEFORE INSERT ON fact.full_webapi_quality_report_observation
FOR EACH ROW EXECUTE FUNCTION ops.guard_v4_fact_attempt_binding();

DROP TRIGGER IF EXISTS trg_fact_full_webapi_value_added_service_attempt_binding
    ON fact.full_webapi_value_added_service_observation;
CREATE TRIGGER trg_fact_full_webapi_value_added_service_attempt_binding
BEFORE INSERT ON fact.full_webapi_value_added_service_observation
FOR EACH ROW EXECUTE FUNCTION ops.guard_v4_fact_attempt_binding();

-- ---------------------------------------------------------------------------
-- Least privilege: the WebAPI loader may append typed facts (SELECT, INSERT)
-- but never update, delete or truncate them; sheinfm_app is a pure read model.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    sequence_row record;
    sequence_name regclass;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_webapi_loader') THEN
        GRANT SELECT, INSERT ON
            fact.full_webapi_stock_record_observation,
            fact.full_webapi_waybill_observation,
            fact.full_webapi_return_application_observation,
            fact.full_webapi_return_order_observation,
            fact.full_webapi_exception_observation,
            fact.full_webapi_quality_report_observation,
            fact.full_webapi_value_added_service_observation
        TO sheinfm_webapi_loader;
        -- PostgreSQL shortens generated identity-sequence names while keeping
        -- a suffix; spelling the pre-truncation identifier resolves to a
        -- different 63-byte name. Resolve every real sequence from its owning
        -- table/column instead of guessing the generated identifier.
        FOR sequence_row IN
            SELECT *
            FROM (VALUES
                ('fact.full_webapi_stock_record_observation', 'full_webapi_stock_record_observation_id'),
                ('fact.full_webapi_waybill_observation', 'full_webapi_waybill_observation_id'),
                ('fact.full_webapi_return_application_observation', 'full_webapi_return_application_observation_id'),
                ('fact.full_webapi_return_order_observation', 'full_webapi_return_order_observation_id'),
                ('fact.full_webapi_exception_observation', 'full_webapi_exception_observation_id'),
                ('fact.full_webapi_quality_report_observation', 'full_webapi_quality_report_observation_id'),
                ('fact.full_webapi_value_added_service_observation', 'full_webapi_value_added_service_observation_id')
            ) AS expected(table_name, column_name)
        LOOP
            sequence_name := pg_get_serial_sequence(
                sequence_row.table_name,
                sequence_row.column_name
            )::regclass;
            IF sequence_name IS NULL THEN
                RAISE EXCEPTION 'identity sequence is missing for %.%',
                    sequence_row.table_name, sequence_row.column_name;
            END IF;
            EXECUTE format(
                'GRANT USAGE ON SEQUENCE %s TO sheinfm_webapi_loader',
                sequence_name
            );
        END LOOP;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_app') THEN
        GRANT SELECT ON
            fact.full_webapi_stock_record_observation,
            fact.full_webapi_waybill_observation,
            fact.full_webapi_return_application_observation,
            fact.full_webapi_return_order_observation,
            fact.full_webapi_exception_observation,
            fact.full_webapi_quality_report_observation,
            fact.full_webapi_value_added_service_observation
        TO sheinfm_app;
    END IF;
END;
$$;

COMMIT;
