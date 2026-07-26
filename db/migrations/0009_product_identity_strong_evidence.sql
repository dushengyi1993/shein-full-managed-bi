BEGIN;

ALTER TABLE dim.canonical_product
    ADD COLUMN IF NOT EXISTS supplier_code_normalized text;

ALTER TABLE dim.canonical_product
    DROP CONSTRAINT IF EXISTS ck_dim_canonical_product_supplier_code;
ALTER TABLE dim.canonical_product
    ADD CONSTRAINT ck_dim_canonical_product_supplier_code
    CHECK (
        supplier_code_normalized IS NULL
        OR supplier_code_normalized <> ''
    );

COMMENT ON COLUMN dim.canonical_product.supplier_code_normalized IS
    'Normalized supplier product number used only as supporting candidate evidence; it is not a strong identity type and never confirms a cross-store match by itself.';
COMMIT;
