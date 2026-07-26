BEGIN;

DO $$
DECLARE
    expected_relation text;
    required_column text;
    constraint_definition text;
BEGIN
    FOREACH expected_relation IN ARRAY ARRAY[
        'ops.canonical_product_observation_set',
        'ops.product_match_candidate_evidence'
    ]
    LOOP
        IF to_regclass(expected_relation) IS NULL THEN
            RAISE EXCEPTION 'Missing product identity resolution relation: %',
                expected_relation;
        END IF;
    END LOOP;

    FOREACH required_column IN ARRAY ARRAY[
        'observation_run_id'
    ]
    LOOP
        IF NOT EXISTS (
            SELECT 1
              FROM pg_attribute
             WHERE attrelid =
                    'raw.product_identity_observation_set'::regclass
               AND attname = required_column
               AND attnum > 0
               AND NOT attisdropped
               AND attnotnull
        ) THEN
            RAISE EXCEPTION
                'Observation set column % is missing or nullable',
                required_column;
        END IF;
    END LOOP;

    FOREACH required_column IN ARRAY ARRAY[
        'identity_scope',
        'identity_component_key',
        'evidence_policy_version',
        'provenance_fingerprint'
    ]
    LOOP
        IF NOT EXISTS (
            SELECT 1
              FROM pg_attribute
             WHERE attrelid = 'dim.canonical_product'::regclass
               AND attname = required_column
               AND attnum > 0
               AND NOT attisdropped
               AND attnotnull
        ) THEN
            RAISE EXCEPTION
                'Canonical product resolution column % is missing or nullable',
                required_column;
        END IF;
    END LOOP;

    FOREACH required_column IN ARRAY ARRAY[
        'source_identity_observation_set_id',
        'target_identity_observation_set_id',
        'matcher_version',
        'evidence_policy_version',
        'evidence_set_fingerprint',
        'plan_hash',
        'component_product_node_count',
        'expected_relation_count'
    ]
    LOOP
        IF NOT EXISTS (
            SELECT 1
              FROM pg_attribute
             WHERE attrelid = 'ops.product_match_candidate'::regclass
               AND attname = required_column
               AND attnum > 0
               AND NOT attisdropped
               AND attnotnull
        ) THEN
            RAISE EXCEPTION
                'Product match candidate resolution column % is missing or nullable',
                required_column;
        END IF;
    END LOOP;

    SELECT pg_get_constraintdef(oid)
      INTO constraint_definition
      FROM pg_constraint
     WHERE conname = 'ck_raw_product_identity_observation_set_lifecycle'
       AND conrelid =
            'raw.product_identity_observation_set'::regclass;
    IF constraint_definition IS NULL
       OR constraint_definition NOT LIKE '%member_count > 0%' THEN
        RAISE EXCEPTION
            'SEALED observation sets are not required to contain members';
    END IF;

    SELECT pg_get_constraintdef(oid)
      INTO constraint_definition
      FROM pg_constraint
     WHERE conname = 'ck_dim_canonical_product_identity_scope'
       AND conrelid = 'dim.canonical_product'::regclass;
    IF constraint_definition IS NULL
       OR constraint_definition NOT LIKE '%GLOBAL%'
       OR constraint_definition NOT LIKE '%LOCAL_SINGLETON%' THEN
        RAISE EXCEPTION
            'Canonical product identity scope is incomplete';
    END IF;

    SELECT pg_get_constraintdef(oid)
      INTO constraint_definition
      FROM pg_constraint
     WHERE conname =
            'ck_ops_product_match_candidate_strong_evidence_types'
       AND conrelid = 'ops.product_match_candidate'::regclass;
    IF constraint_definition IS NULL
       OR constraint_definition NOT LIKE '%CURATED_ATTRIBUTES%' THEN
        RAISE EXCEPTION
            'Candidate strong evidence does not allow curated attributes';
    END IF;

    FOREACH expected_relation IN ARRAY ARRAY[
        'uq_raw_product_identity_set_resolution_ref',
        'uq_raw_identifier_observation_set_member',
        'uq_dim_canonical_product_resolution_ref',
        'fk_ops_canonical_product_observation_sealed_set',
        'uq_ops_canonical_product_observation_resolution_ref',
        'uq_ops_canonical_product_observation_assignment_ref',
        'fk_ops_product_match_candidate_source_provenance',
        'fk_ops_product_match_candidate_target_provenance',
        'uq_ops_product_match_candidate_decision_ref',
        'uq_ops_product_match_candidate_evidence_ref',
        'fk_ops_product_match_evidence_source_observation',
        'fk_ops_product_match_evidence_target_observation',
        'fk_ops_product_identity_decision_candidate_resolution',
        'uq_ops_product_identity_decision_assignment_ref',
        'fk_dim_full_sku_assignment_decision_resolution',
        'fk_dim_full_sku_assignment_canonical_provenance'
    ]
    LOOP
        IF NOT EXISTS (
            SELECT 1
              FROM pg_constraint
             WHERE conname = expected_relation
        ) THEN
            RAISE EXCEPTION
                'Missing product identity resolution constraint: %',
                expected_relation;
        END IF;
    END LOOP;

    FOREACH expected_relation IN ARRAY ARRAY[
        'ops.uq_ops_canonical_product_node_representative',
        'ops.uq_ops_canonical_product_global_store_rep',
        'ops.ix_ops_product_match_evidence_candidate_relation',
        'dim.ix_dim_full_sku_assignment_plan_scope'
    ]
    LOOP
        IF to_regclass(expected_relation) IS NULL THEN
            RAISE EXCEPTION
                'Missing product identity resolution index: %',
                expected_relation;
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgname =
                'trg_ops_canonical_product_observation_append_only'
           AND tgrelid =
                'ops.canonical_product_observation_set'::regclass
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION
            'Canonical product observation provenance is not append-only';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_trigger
         WHERE tgname =
                'trg_ops_product_match_candidate_evidence_append_only'
           AND tgrelid =
                'ops.product_match_candidate_evidence'::regclass
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION
            'Product match candidate evidence is not append-only';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM ops.product_match_candidate
         WHERE identity_scope = 'GLOBAL'
           AND (
               store_id = target_store_id
               OR source_identity_observation_set_id =
                    target_identity_observation_set_id
           )
    ) THEN
        RAISE EXCEPTION
            'A GLOBAL candidate does not cross store observation sets';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM ops.product_match_candidate AS candidate
          LEFT JOIN ops.product_match_candidate_evidence AS evidence
            ON evidence.product_match_candidate_id =
                candidate.product_match_candidate_id
           AND evidence.canonical_product_id =
                candidate.canonical_product_id
           AND evidence.identity_component_key =
                candidate.identity_component_key
           AND evidence.plan_hash = candidate.plan_hash
         GROUP BY
             candidate.product_match_candidate_id,
             candidate.expected_relation_count
        HAVING count(DISTINCT evidence.relation_key)
                <> candidate.expected_relation_count
    ) THEN
        RAISE EXCEPTION
            'Candidate relation evidence does not form its declared complete component';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM dim.canonical_product AS product
          LEFT JOIN ops.canonical_product_observation_set AS provenance
            ON provenance.canonical_product_id =
                product.canonical_product_id
           AND provenance.identity_scope = 'GLOBAL'
           AND provenance.is_match_representative
         WHERE product.identity_scope = 'GLOBAL'
           AND product.status = 'ACTIVE'
         GROUP BY product.canonical_product_id
        HAVING count(DISTINCT provenance.store_id) < 2
    ) THEN
        RAISE EXCEPTION
            'An active GLOBAL canonical product has fewer than two source stores';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM dim.full_sku_canonical_assignment AS assignment
          LEFT JOIN ops.product_identity_decision AS decision
            ON decision.product_identity_decision_id =
                assignment.product_identity_decision_id
           AND decision.store_id = assignment.store_id
           AND decision.product_match_candidate_id =
                assignment.product_match_candidate_id
           AND decision.full_sku_id = assignment.full_sku_id
           AND decision.canonical_product_id =
                assignment.canonical_product_id
           AND decision.identity_scope = assignment.identity_scope
           AND decision.identity_component_key =
                assignment.identity_component_key
           AND decision.source_identity_observation_set_id =
                assignment.identity_observation_set_id
           AND decision.observation_run_id =
                assignment.observation_run_id
           AND decision.plan_hash = assignment.plan_hash
           AND decision.decision_outcome =
                assignment.decision_outcome
         WHERE decision.product_identity_decision_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'A canonical assignment is inconsistent with its decision';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM dim.full_sku_canonical_assignment AS assignment
          LEFT JOIN ops.canonical_product_observation_set AS provenance
            ON provenance.canonical_product_id =
                assignment.canonical_product_id
           AND provenance.identity_scope = assignment.identity_scope
           AND provenance.identity_component_key =
                assignment.identity_component_key
           AND provenance.identity_observation_set_id =
                assignment.identity_observation_set_id
           AND provenance.store_id = assignment.store_id
           AND provenance.full_sku_id = assignment.full_sku_id
           AND provenance.observation_run_id =
                assignment.observation_run_id
         WHERE provenance.canonical_product_observation_set_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'A canonical assignment has no matching SEALED provenance';
    END IF;
END;
$$;

SELECT 'product identity resolution contract OK' AS result;

ROLLBACK;
