BEGIN;

ALTER TABLE dim.full_sku
    ADD COLUMN IF NOT EXISTS category_id text,
    ADD COLUMN IF NOT EXISTS category_name text,
    ADD COLUMN IF NOT EXISTS product_type_id text,
    ADD COLUMN IF NOT EXISTS brand_code text,
    ADD COLUMN IF NOT EXISTS main_image_url_hash character(64),
    ADD COLUMN IF NOT EXISTS dimension_length text,
    ADD COLUMN IF NOT EXISTS dimension_width text,
    ADD COLUMN IF NOT EXISTS dimension_height text,
    ADD COLUMN IF NOT EXISTS dimension_weight text,
    ADD COLUMN IF NOT EXISTS stop_purchase_code text;

ALTER TABLE dim.full_sku
    DROP CONSTRAINT IF EXISTS ck_dim_full_sku_product_detail_identity_text;
ALTER TABLE dim.full_sku
    ADD CONSTRAINT ck_dim_full_sku_product_detail_identity_text
    CHECK (
        (category_id IS NULL OR category_id <> '')
        AND (category_name IS NULL OR category_name <> '')
        AND (product_type_id IS NULL OR product_type_id <> '')
        AND (brand_code IS NULL OR brand_code <> '')
        AND (dimension_length IS NULL OR dimension_length <> '')
        AND (dimension_width IS NULL OR dimension_width <> '')
        AND (dimension_height IS NULL OR dimension_height <> '')
        AND (dimension_weight IS NULL OR dimension_weight <> '')
        AND (stop_purchase_code IS NULL OR stop_purchase_code <> '')
    );

ALTER TABLE dim.full_sku
    DROP CONSTRAINT IF EXISTS ck_dim_full_sku_main_image_url_hash;
ALTER TABLE dim.full_sku
    ADD CONSTRAINT ck_dim_full_sku_main_image_url_hash
    CHECK (
        main_image_url_hash IS NULL
        OR main_image_url_hash ~ '^[0-9a-f]{64}$'
    );

COMMENT ON COLUMN dim.full_sku.category_id IS
    'Latest product-detail category identifier projection; frozen identity evidence belongs in raw observations.';
COMMENT ON COLUMN dim.full_sku.category_name IS
    'Latest product-detail category label projection; it is never an automatic cross-store identity by itself.';
COMMENT ON COLUMN dim.full_sku.product_type_id IS
    'Latest product-detail product-type projection used only as a supporting comparison signal.';
COMMENT ON COLUMN dim.full_sku.brand_code IS
    'Latest product-detail brand-code projection used only as a supporting comparison signal.';
COMMENT ON COLUMN dim.full_sku.main_image_url_hash IS
    'SHA-256 of the normalized public main-image URL with query and fragment removed. This is only an auxiliary URL-change signal, never image-content or strong identity evidence; the URL itself is deliberately not persisted.';
COMMENT ON COLUMN dim.full_sku.dimension_length IS
    'Raw full-detail SKU length retained as comparison evidence without replacing the source SKU identity.';
COMMENT ON COLUMN dim.full_sku.dimension_width IS
    'Raw full-detail SKU width retained as comparison evidence without replacing the source SKU identity.';
COMMENT ON COLUMN dim.full_sku.dimension_height IS
    'Raw full-detail SKU height retained as comparison evidence without replacing the source SKU identity.';
COMMENT ON COLUMN dim.full_sku.dimension_weight IS
    'Raw full-detail SKU weight retained as comparison evidence without replacing the source SKU identity.';
COMMENT ON COLUMN dim.full_sku.stop_purchase_code IS
    'Raw full-detail stop-purchase state; it is operational metadata, not an identity key.';

COMMIT;
