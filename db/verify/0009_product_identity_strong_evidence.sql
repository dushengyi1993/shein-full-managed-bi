BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'dim'
           AND table_name = 'canonical_product'
           AND column_name = 'supplier_code_normalized'
    ) THEN
        RAISE EXCEPTION
            'canonical product strong-evidence columns are missing';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'ck_ops_product_match_candidate_strong_evidence_types'
           AND conrelid = 'ops.product_match_candidate'::regclass
           AND pg_get_constraintdef(oid) LIKE '%SUPPLIER_CODE%'
    ) THEN
        RAISE EXCEPTION
            'supplier product numbers must not be accepted as a strong identity type';
    END IF;
END;
$$;

ROLLBACK;
