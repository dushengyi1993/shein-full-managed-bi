DO $$
DECLARE
    expected_table text;
    expected_tables constant text[] := ARRAY[
        'dim.canonical_product',
        'dim.canonical_variant',
        'raw.identifier_observation',
        'ops.product_match_candidate',
        'ops.product_identity_decision',
        'dim.full_sku_canonical_assignment',
        'ops.employee_principal',
        'ops.employee_store_assignment'
    ];
BEGIN
    FOREACH expected_table IN ARRAY expected_tables LOOP
        IF to_regclass(expected_table) IS NULL THEN
            RAISE EXCEPTION 'Missing required relation: %', expected_table;
        END IF;
    END LOOP;

    IF to_regclass('dim.uq_dim_full_sku_canonical_assignment_current') IS NULL THEN
        RAISE EXCEPTION 'Missing one-current-confirmed-assignment guard';
    END IF;

    IF to_regclass('ops.uq_ops_employee_store_assignment_current_primary') IS NULL THEN
        RAISE EXCEPTION 'Missing one-current-primary-owner guard';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'dim'
           AND table_name IN ('canonical_product', 'canonical_variant')
           AND column_name = 'store_id'
    ) THEN
        RAISE EXCEPTION 'Canonical product and variant identities must be global, not store-scoped';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'uq_dim_canonical_product_key'
           AND conrelid = 'dim.canonical_product'::regclass
    ) THEN
        RAISE EXCEPTION 'Canonical product key is not globally unique';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'uq_dim_canonical_variant_product_key'
           AND conrelid = 'dim.canonical_variant'::regclass
    ) THEN
        RAISE EXCEPTION 'Canonical variant key is not unique within its canonical product';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_raw_identifier_observation_append_only'
          AND tgrelid = 'raw.identifier_observation'::regclass
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'Identifier observations are not protected as append-only';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_ops_product_match_candidate_auto_confirm'
          AND conrelid = 'ops.product_match_candidate'::regclass
    ) THEN
        RAISE EXCEPTION 'Missing automatic product-match confirmation gate';
    END IF;
END;
$$;

SELECT 'product identity and employee-store access contract OK' AS result;
