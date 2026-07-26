BEGIN;

DO $$
DECLARE
    missing_columns text[];
BEGIN
    SELECT array_agg(expected.column_name ORDER BY expected.column_name)
      INTO missing_columns
      FROM (
          VALUES
              ('category_id'),
              ('category_name'),
              ('product_type_id'),
              ('brand_code'),
              ('main_image_url_hash'),
              ('dimension_length'),
              ('dimension_width'),
              ('dimension_height'),
              ('dimension_weight'),
              ('stop_purchase_code')
      ) AS expected(column_name)
     WHERE NOT EXISTS (
         SELECT 1
           FROM information_schema.columns AS actual
          WHERE actual.table_schema = 'dim'
            AND actual.table_name = 'full_sku'
            AND actual.column_name = expected.column_name
     );

    IF missing_columns IS NOT NULL THEN
        RAISE EXCEPTION
            'dim.full_sku product-detail identity columns are missing: %',
            missing_columns;
    END IF;

    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'dim'
           AND table_name = 'full_sku'
           AND column_name = 'main_image_url'
    ) THEN
        RAISE EXCEPTION
            'raw product image URLs must not be persisted in dim.full_sku';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'ck_dim_full_sku_product_detail_identity_text'
           AND conrelid = 'dim.full_sku'::regclass
    ) OR NOT EXISTS (
        SELECT 1
          FROM pg_constraint
        WHERE conname = 'ck_dim_full_sku_main_image_url_hash'
           AND conrelid = 'dim.full_sku'::regclass
    ) THEN
        RAISE EXCEPTION
            'dim.full_sku product-detail identity constraints are missing';
    END IF;
END;
$$;

ROLLBACK;
