BEGIN;

DO $$
DECLARE
    identifier_type_constraint text;
    observation_set_lifecycle_constraint text;
BEGIN
    IF to_regclass('raw.product_identity_observation_set') IS NULL THEN
        RAISE EXCEPTION 'raw.product_identity_observation_set is missing';
    END IF;

    IF (
        SELECT count(*)
          FROM information_schema.columns
         WHERE table_schema = 'raw'
           AND table_name = 'identifier_observation'
           AND column_name IN (
               'identity_observation_set_id',
               'identity_scope',
               'scope_key',
               'source_value_key'
           )
    ) <> 4 THEN
        RAISE EXCEPTION 'identifier observation set-binding columns are missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_raw_identifier_observation_set_composite'
           AND conrelid = 'raw.identifier_observation'::regclass
    ) THEN
        RAISE EXCEPTION 'composite observation-set member foreign key is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'ck_raw_identifier_observation_barcode_scope'
           AND conrelid = 'raw.identifier_observation'::regclass
    ) THEN
        RAISE EXCEPTION 'barcode variant-scope constraint is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgname = 'trg_raw_product_identity_observation_set_sealed'
           AND tgrelid = 'raw.product_identity_observation_set'::regclass
           AND tgconstraint <> 0
           AND tgdeferrable
           AND tginitdeferred
    ) THEN
        RAISE EXCEPTION 'deferred observation-set sealing trigger is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgname = 'trg_raw_product_identity_observation_set_guard'
           AND tgrelid = 'raw.product_identity_observation_set'::regclass
    ) THEN
        RAISE EXCEPTION 'observation-set append-only lifecycle trigger is missing';
    END IF;

    SELECT pg_get_constraintdef(oid)
      INTO observation_set_lifecycle_constraint
      FROM pg_constraint
     WHERE conname = 'ck_raw_product_identity_observation_set_lifecycle'
       AND conrelid = 'raw.product_identity_observation_set'::regclass;

    IF observation_set_lifecycle_constraint IS NULL
       OR observation_set_lifecycle_constraint NOT LIKE '%member_count > 0%' THEN
        RAISE EXCEPTION
            'SEALED product identity observation sets must have positive member_count';
    END IF;

    SELECT pg_get_constraintdef(oid)
      INTO identifier_type_constraint
      FROM pg_constraint
     WHERE conname = 'ck_raw_identifier_observation_type'
       AND conrelid = 'raw.identifier_observation'::regclass;

    IF identifier_type_constraint NOT LIKE '%PRODUCT_TYPE%' THEN
        RAISE EXCEPTION 'PRODUCT_TYPE identifier evidence is missing';
    END IF;

    IF identifier_type_constraint LIKE '%IMAGE_URL%'
       OR identifier_type_constraint LIKE '%IMAGE_HASH%' THEN
        RAISE EXCEPTION
            'image URLs and URL hashes must not become identity evidence types';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_app')
       AND (
           has_table_privilege(
               'sheinfm_app',
               'raw.product_identity_observation_set',
               'INSERT'
           )
           OR has_table_privilege(
               'sheinfm_app',
               'raw.product_identity_observation_set',
               'UPDATE'
           )
       ) THEN
        RAISE EXCEPTION
            'sheinfm_app must remain read-only on product identity observation sets';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_supply_loader')
       AND NOT (
           has_table_privilege(
               'sheinfm_supply_loader',
               'raw.product_identity_observation_set',
               'SELECT'
           )
           AND has_table_privilege(
               'sheinfm_supply_loader',
               'raw.product_identity_observation_set',
               'INSERT'
           )
           AND has_column_privilege(
               'sheinfm_supply_loader',
               'raw.product_identity_observation_set',
               'status',
               'UPDATE'
           )
           AND has_column_privilege(
               'sheinfm_supply_loader',
               'raw.product_identity_observation_set',
               'member_count',
               'UPDATE'
           )
           AND has_column_privilege(
               'sheinfm_supply_loader',
               'raw.product_identity_observation_set',
               'sealed_at',
               'UPDATE'
           )
       ) THEN
        RAISE EXCEPTION
            'sheinfm_supply_loader is missing the minimum observation-set lifecycle privileges';
    END IF;
END;
$$;

ROLLBACK;
