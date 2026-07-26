BEGIN;

DO $verify$
DECLARE
    required_name text;
    role_row record;
    membership_row record;
    relation_row record;
    privilege_name text;
    sequence_row record;
    sequence_name regclass;
    expected_group text;
BEGIN
    FOREACH required_name IN ARRAY ARRAY[
        'dim.store',
        'raw.openapi_fetch_batch',
        'dim.full_sku',
        'fact.full_sku_sales_snapshot',
        'mart.full_store_sales_latest',
        'mart.full_product_sales_latest',
        'ops.permission_probe',
        'ops.sales_sync_run',
        'ops.sales_quality_event',
        'ops.sales_business_watermark',
        'dim.canonical_product',
        'dim.canonical_variant',
        'raw.product_identity_observation_set',
        'raw.identifier_observation',
        'ops.canonical_product_observation_set',
        'ops.product_match_candidate',
        'ops.product_match_candidate_evidence',
        'ops.product_identity_decision',
        'dim.full_sku_canonical_assignment',
        'ops.employee_principal',
        'ops.employee_store_assignment',
        'raw.webhook_receipt',
        'ops.webhook_runtime_heartbeat',
        'ops.webhook_job',
        'ops.operational_event',
        'ops.webhook_hydration_directive',
        'ops.webhook_subscription_state',
        'ops.webhook_store_gate',
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
    ]
    LOOP
        IF to_regclass(required_name) IS NULL THEN
            RAISE EXCEPTION 'runtime verification requires relation %', required_name;
        END IF;
    END LOOP;

    FOREACH required_name IN ARRAY ARRAY[
        'ops.touch_updated_at()',
        'ops.distinct_identity_evidence_count(text[])',
        'ops.reject_append_only_identity_mutation()',
        'ops.guard_product_identity_observation_set_mutation()',
        'ops.require_building_product_identity_observation_set()',
        'ops.verify_product_identity_observation_set_sealed()',
        'ops.guard_webhook_receipt_immutable()',
        'ops.reject_webhook_runtime_heartbeat_mutation()',
        'ops.guard_webhook_store_gate_recovery()',
        'ops.reopen_webhook_authorization_gate_after_probe(text,bigint)',
        'ops.reject_supply_append_only_mutation()'
    ]
    LOOP
        IF to_regprocedure(required_name) IS NULL THEN
            RAISE EXCEPTION 'runtime verification requires function %', required_name;
        END IF;
    END LOOP;

    IF (
        SELECT count(*)
        FROM pg_roles
        WHERE rolname = ANY (ARRAY[
            'sheinfm_materializer_ro',
            'sheinfm_sales_loader',
            'sheinfm_supply_loader',
            'sheinfm_webhook_ingress',
            'sheinfm_webhook_worker'
        ])
    ) <> 5 THEN
        RAISE EXCEPTION 'runtime capability role set is incomplete';
    END IF;
    FOR role_row IN
        SELECT role_view.*, role_secret.rolpassword AS actual_password
        FROM pg_roles AS role_view
        JOIN pg_authid AS role_secret ON role_secret.oid = role_view.oid
        WHERE role_view.rolname = ANY (ARRAY[
            'sheinfm_materializer_ro',
            'sheinfm_sales_loader',
            'sheinfm_supply_loader',
            'sheinfm_webhook_ingress',
            'sheinfm_webhook_worker'
        ])
    LOOP
        IF role_row.rolcanlogin
           OR role_row.rolinherit
           OR role_row.rolsuper
           OR role_row.rolcreatedb
           OR role_row.rolcreaterole
           OR role_row.rolreplication
           OR role_row.rolbypassrls
           OR role_row.actual_password IS NOT NULL THEN
            RAISE EXCEPTION 'unsafe NOLOGIN capability role %', role_row.rolname;
        END IF;
    END LOOP;

    IF (
        SELECT count(*)
        FROM pg_roles
        WHERE rolname = ANY (ARRAY[
            'sheinfm_materializer_login',
            'sheinfm_sales_login',
            'sheinfm_supply_login',
            'sheinfm_webhook_ingress_login',
            'sheinfm_webhook_worker_login'
        ])
    ) <> 5 THEN
        RAISE EXCEPTION 'runtime LOGIN role set is incomplete';
    END IF;
    FOR role_row IN
        SELECT role_view.*, role_secret.rolpassword AS actual_password
        FROM pg_roles AS role_view
        JOIN pg_authid AS role_secret ON role_secret.oid = role_view.oid
        WHERE role_view.rolname = ANY (ARRAY[
            'sheinfm_materializer_login',
            'sheinfm_sales_login',
            'sheinfm_supply_login',
            'sheinfm_webhook_ingress_login',
            'sheinfm_webhook_worker_login'
        ])
    LOOP
        IF NOT role_row.rolcanlogin
           OR NOT role_row.rolinherit
           OR role_row.rolsuper
           OR role_row.rolcreatedb
           OR role_row.rolcreaterole
           OR role_row.rolreplication
           OR role_row.rolbypassrls
           OR role_row.actual_password IS NULL
           OR role_row.actual_password NOT LIKE 'SCRAM-SHA-256$%' THEN
            RAISE EXCEPTION 'unsafe runtime LOGIN role %', role_row.rolname;
        END IF;
    END LOOP;

    SELECT *
    INTO role_row
    FROM pg_roles
    WHERE rolname = 'sheinfm_app';
    IF NOT FOUND
       OR NOT role_row.rolcanlogin
       OR role_row.rolinherit
       OR role_row.rolsuper
       OR role_row.rolcreatedb
       OR role_row.rolcreaterole
       OR role_row.rolreplication
       OR role_row.rolbypassrls THEN
        RAISE EXCEPTION 'legacy sheinfm_app is not a safe read-only login';
    END IF;

    FOR membership_row IN
        SELECT *
        FROM (VALUES
            ('sheinfm_materializer_login', 'sheinfm_materializer_ro'),
            ('sheinfm_sales_login', 'sheinfm_sales_loader'),
            ('sheinfm_supply_login', 'sheinfm_supply_loader'),
            ('sheinfm_webhook_ingress_login', 'sheinfm_webhook_ingress'),
            ('sheinfm_webhook_worker_login', 'sheinfm_webhook_worker')
        ) AS expected(member_name, group_name)
    LOOP
        IF NOT pg_has_role(
            membership_row.member_name,
            membership_row.group_name,
            'MEMBER'
        ) THEN
            RAISE EXCEPTION 'runtime login % lacks group %',
                membership_row.member_name,
                membership_row.group_name;
        END IF;
    END LOOP;
    SELECT member.rolname AS member_name, granted.rolname AS group_name
    INTO membership_row
    FROM pg_auth_members AS membership
    JOIN pg_roles AS member ON member.oid = membership.member
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    WHERE member.rolname = ANY (ARRAY[
        'sheinfm_materializer_login',
        'sheinfm_sales_login',
        'sheinfm_supply_login',
        'sheinfm_webhook_ingress_login',
        'sheinfm_webhook_worker_login',
        'sheinfm_app'
    ])
      AND (member.rolname, granted.rolname) NOT IN (
        ('sheinfm_materializer_login', 'sheinfm_materializer_ro'),
        ('sheinfm_sales_login', 'sheinfm_sales_loader'),
        ('sheinfm_supply_login', 'sheinfm_supply_loader'),
        ('sheinfm_webhook_ingress_login', 'sheinfm_webhook_ingress'),
        ('sheinfm_webhook_worker_login', 'sheinfm_webhook_worker')
      )
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'unexpected membership: % -> %',
            membership_row.member_name,
            membership_row.group_name;
    END IF;

    FOREACH required_name IN ARRAY ARRAY[
        'sheinfm_materializer_login',
        'sheinfm_sales_login',
        'sheinfm_supply_login',
        'sheinfm_webhook_ingress_login',
        'sheinfm_webhook_worker_login',
        'sheinfm_app'
    ]
    LOOP
        IF NOT has_database_privilege(required_name, current_database(), 'CONNECT') THEN
            RAISE EXCEPTION 'runtime login % cannot connect', required_name;
        END IF;
    END LOOP;

    -- PUBLIC cannot enter the database, schemas, relations, sequences, or
    -- project functions. NULL ACLs are expanded to their object defaults.
    IF EXISTS (
        SELECT 1
        FROM pg_database AS database
        CROSS JOIN LATERAL aclexplode(
            COALESCE(database.datacl, acldefault('d', database.datdba))
        ) AS privilege
        WHERE database.datname = current_database()
          AND privilege.grantee = 0
    ) THEN
        RAISE EXCEPTION 'PUBLIC retains a database privilege';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_namespace AS namespace
        CROSS JOIN LATERAL aclexplode(
            COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
        ) AS privilege
        WHERE namespace.nspname = ANY (ARRAY['raw', 'dim', 'fact', 'mart', 'ops'])
          AND privilege.grantee = 0
    ) THEN
        RAISE EXCEPTION 'PUBLIC retains a warehouse schema privilege';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_class AS class
        JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
        CROSS JOIN LATERAL aclexplode(
            COALESCE(
                class.relacl,
                acldefault(
                    CASE WHEN class.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
                    class.relowner
                )
            )
        ) AS privilege
        WHERE namespace.nspname = ANY (ARRAY['raw', 'dim', 'fact', 'mart', 'ops'])
          AND class.relkind IN ('r', 'p', 'v', 'm', 'S')
          AND privilege.grantee = 0
    ) THEN
        RAISE EXCEPTION 'PUBLIC retains a warehouse relation or sequence privilege';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_proc AS procedure
        JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        CROSS JOIN LATERAL aclexplode(
            COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
        ) AS privilege
        WHERE namespace.nspname = ANY (ARRAY['raw', 'dim', 'fact', 'mart', 'ops'])
          AND privilege.grantee = 0
    ) THEN
        RAISE EXCEPTION 'PUBLIC retains EXECUTE on a warehouse function';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_default_acl AS default_acl
        JOIN pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
        CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS privilege
        WHERE namespace.nspname = ANY (ARRAY['raw', 'dim', 'fact', 'mart', 'ops'])
          AND default_acl.defaclobjtype IN ('r', 'S', 'f')
          AND (
              privilege.grantee = 0
              OR privilege.grantee IN (
                  SELECT oid
                  FROM pg_roles
                  WHERE rolname = ANY (ARRAY[
                      'sheinfm_app',
                      'sheinfm_materializer_ro',
                      'sheinfm_sales_loader',
                      'sheinfm_supply_loader',
                      'sheinfm_webhook_ingress',
                      'sheinfm_webhook_worker',
                      'sheinfm_materializer_login',
                      'sheinfm_sales_login',
                      'sheinfm_supply_login',
                      'sheinfm_webhook_ingress_login',
                      'sheinfm_webhook_worker_login'
                  ])
              )
          )
    ) THEN
        RAISE EXCEPTION 'unsafe warehouse default privilege remains';
    END IF;

    -- sheinfm_app is a current-object read-only compatibility login. Encrypted
    -- webhook payloads remain unavailable even to this compatibility role.
    FOR relation_row IN
        SELECT class.oid,
               format('%I.%I', namespace.nspname, class.relname) AS relation_name
        FROM pg_class AS class
        JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = ANY (ARRAY['raw', 'dim', 'fact', 'mart', 'ops'])
          AND class.relkind IN ('r', 'p', 'v', 'm')
    LOOP
        IF relation_row.relation_name <> 'raw.webhook_receipt'
           AND NOT has_table_privilege(
               'sheinfm_app',
               relation_row.oid,
               'SELECT'
           ) THEN
            RAISE EXCEPTION 'sheinfm_app cannot read %', relation_row.relation_name;
        END IF;
        FOREACH privilege_name IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']
        LOOP
            IF has_table_privilege('sheinfm_app', relation_row.oid, privilege_name) THEN
                RAISE EXCEPTION 'sheinfm_app retained % on %',
                    privilege_name,
                    relation_row.relation_name;
            END IF;
            IF has_table_privilege(
                'sheinfm_materializer_login',
                relation_row.oid,
                privilege_name
            ) THEN
                RAISE EXCEPTION 'materializer retained % on %',
                    privilege_name,
                    relation_row.relation_name;
            END IF;
        END LOOP;
    END LOOP;
    IF NOT has_column_privilege(
        'sheinfm_app', 'raw.webhook_receipt', 'received_at', 'SELECT'
    ) OR has_column_privilege(
        'sheinfm_app', 'raw.webhook_receipt', 'ciphertext', 'SELECT'
    ) THEN
        RAISE EXCEPTION 'sheinfm_app webhook receipt projection is unsafe';
    END IF;

    -- Materializer can read all cross-domain projections it executes, but it
    -- has no table mutation, sequence, or project-function capability.
    FOREACH required_name IN ARRAY ARRAY[
        'dim.store',
        'dim.full_sku',
        'dim.canonical_product',
        'dim.full_sku_canonical_assignment',
        'fact.full_sku_sales_snapshot',
        'fact.purchase_order',
        'fact.delivery',
        'fact.delivery_line',
        'fact.inventory_snapshot',
        'fact.stock_advice_snapshot',
        'fact.supply_projection_batch',
        'fact.supply_projection_member',
        'raw.openapi_fetch_batch',
        'ops.permission_probe',
        'ops.sales_sync_run',
        'ops.sales_quality_event',
        'ops.sales_business_watermark',
        'ops.employee_principal',
        'ops.employee_store_assignment',
        'ops.supply_sync_attempt',
        'ops.webhook_runtime_heartbeat',
        'ops.webhook_job',
        'ops.operational_event',
        'ops.webhook_hydration_directive',
        'ops.webhook_subscription_state',
        'ops.webhook_store_gate'
    ]
    LOOP
        IF NOT has_table_privilege(
            'sheinfm_materializer_login',
            required_name,
            'SELECT'
        ) THEN
            RAISE EXCEPTION 'materializer lacks SELECT on %', required_name;
        END IF;
    END LOOP;
    IF NOT has_column_privilege(
        'sheinfm_materializer_login',
        'raw.webhook_receipt',
        'received_at',
        'SELECT'
    ) OR has_column_privilege(
        'sheinfm_materializer_login',
        'raw.webhook_receipt',
        'ciphertext',
        'SELECT'
    ) THEN
        RAISE EXCEPTION 'materializer webhook receipt projection is unsafe';
    END IF;

    -- Sales loader writes only sales/catalog membership and its own trust
    -- ledgers. Permission-probe readback is required for idempotency.
    IF NOT has_table_privilege(
        'sheinfm_sales_login', 'fact.full_sku_sales_snapshot', 'INSERT'
    ) OR NOT has_table_privilege(
        'sheinfm_sales_login', 'ops.permission_probe', 'SELECT'
    ) OR NOT has_table_privilege(
        'sheinfm_sales_login', 'ops.permission_probe', 'INSERT'
    ) OR NOT has_table_privilege(
        'sheinfm_sales_login', 'ops.sales_quality_event', 'SELECT'
    ) OR NOT has_table_privilege(
        'sheinfm_sales_login', 'ops.sales_quality_event', 'INSERT'
    ) OR has_table_privilege(
        'sheinfm_sales_login', 'ops.permission_probe', 'UPDATE'
    ) OR has_table_privilege(
        'sheinfm_sales_login', 'ops.sales_quality_event', 'UPDATE'
    ) OR has_table_privilege(
        'sheinfm_sales_login', 'fact.inventory_snapshot', 'INSERT'
    ) OR has_table_privilege(
        'sheinfm_sales_login', 'ops.webhook_job', 'UPDATE'
    ) THEN
        RAISE EXCEPTION 'sales loader privilege boundary is invalid';
    END IF;

    -- Supply loader can read the latest sales membership run but cannot write
    -- sales facts. Its run/projection evidence is append-only.
    IF NOT has_table_privilege(
        'sheinfm_supply_login', 'ops.sales_sync_run', 'SELECT'
    ) OR NOT has_table_privilege(
        'sheinfm_supply_login', 'fact.inventory_snapshot', 'INSERT'
    ) OR has_table_privilege(
        'sheinfm_supply_login', 'fact.full_sku_sales_snapshot', 'INSERT'
    ) THEN
        RAISE EXCEPTION 'supply loader domain boundary is invalid';
    END IF;
    FOREACH required_name IN ARRAY ARRAY[
        'raw.openapi_fetch_page',
        'ops.supply_sync_attempt',
        'fact.supply_projection_batch',
        'fact.supply_projection_member'
    ]
    LOOP
        IF NOT has_table_privilege(
            'sheinfm_supply_login', required_name, 'SELECT'
        ) OR NOT has_table_privilege(
            'sheinfm_supply_login', required_name, 'INSERT'
        ) OR has_table_privilege(
            'sheinfm_supply_login', required_name, 'UPDATE'
        ) OR has_table_privilege(
            'sheinfm_supply_login', required_name, 'DELETE'
        ) THEN
            RAISE EXCEPTION 'supply append-only boundary is invalid for %', required_name;
        END IF;
    END LOOP;
    IF NOT has_table_privilege(
        'sheinfm_supply_login',
        'raw.product_identity_observation_set',
        'SELECT'
    ) OR NOT has_table_privilege(
        'sheinfm_supply_login',
        'raw.product_identity_observation_set',
        'INSERT'
    ) OR has_table_privilege(
        'sheinfm_supply_login',
        'raw.product_identity_observation_set',
        'UPDATE'
    ) OR has_table_privilege(
        'sheinfm_supply_login',
        'raw.product_identity_observation_set',
        'DELETE'
    ) OR has_table_privilege(
        'sheinfm_supply_login',
        'raw.product_identity_observation_set',
        'TRUNCATE'
    ) THEN
        RAISE EXCEPTION 'supply identity observation-set table boundary is invalid';
    END IF;
    FOREACH required_name IN ARRAY ARRAY['status', 'member_count', 'sealed_at']
    LOOP
        IF NOT has_column_privilege(
            'sheinfm_supply_login',
            'raw.product_identity_observation_set',
            required_name,
            'UPDATE'
        ) THEN
            RAISE EXCEPTION
                'supply identity observation-set seal column % is not updatable',
                required_name;
        END IF;
    END LOOP;
    SELECT column_name
      INTO required_name
      FROM information_schema.columns
     WHERE table_schema = 'raw'
       AND table_name = 'product_identity_observation_set'
       AND column_name <> ALL (ARRAY['status', 'member_count', 'sealed_at'])
       AND has_column_privilege(
           'sheinfm_supply_login',
           'raw.product_identity_observation_set',
           column_name,
           'UPDATE'
       )
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION
            'supply identity observation-set immutable column % is updatable',
            required_name;
    END IF;
    IF NOT has_table_privilege(
        'sheinfm_supply_login',
        'raw.identifier_observation',
        'SELECT'
    ) OR NOT has_table_privilege(
        'sheinfm_supply_login',
        'raw.identifier_observation',
        'INSERT'
    ) OR has_table_privilege(
        'sheinfm_supply_login',
        'raw.identifier_observation',
        'UPDATE'
    ) OR has_table_privilege(
        'sheinfm_supply_login',
        'raw.identifier_observation',
        'DELETE'
    ) OR has_table_privilege(
        'sheinfm_supply_login',
        'raw.identifier_observation',
        'TRUNCATE'
    ) THEN
        RAISE EXCEPTION 'supply identifier-observation boundary is invalid';
    END IF;
    FOREACH required_name IN ARRAY ARRAY[
        'dim.canonical_product',
        'ops.canonical_product_observation_set',
        'ops.product_match_candidate',
        'ops.product_match_candidate_evidence',
        'ops.product_identity_decision',
        'dim.full_sku_canonical_assignment'
    ]
    LOOP
        IF NOT has_table_privilege(
            'sheinfm_supply_login', required_name, 'SELECT'
        ) OR NOT has_table_privilege(
            'sheinfm_supply_login', required_name, 'INSERT'
        ) OR has_table_privilege(
            'sheinfm_supply_login', required_name, 'UPDATE'
        ) OR has_table_privilege(
            'sheinfm_supply_login', required_name, 'DELETE'
        ) OR has_table_privilege(
            'sheinfm_supply_login', required_name, 'TRUNCATE'
        ) THEN
            RAISE EXCEPTION
                'supply product identity resolution boundary is invalid for %',
                required_name;
        END IF;
    END LOOP;

    -- Ingress sees only routing/idempotency columns, can append heartbeat
    -- evidence, and cannot lease a job or read encrypted receipt content.
    FOREACH required_name IN ARRAY ARRAY['store_id', 'store_code', 'is_active']
    LOOP
        IF NOT has_column_privilege(
            'sheinfm_webhook_ingress_login',
            'dim.store',
            required_name,
            'SELECT'
        ) THEN
            RAISE EXCEPTION 'webhook ingress lacks dim.store.%', required_name;
        END IF;
    END LOOP;
    IF has_column_privilege(
        'sheinfm_webhook_ingress_login',
        'dim.store',
        'store_name',
        'SELECT'
    ) OR has_column_privilege(
        'sheinfm_webhook_ingress_login',
        'raw.webhook_receipt',
        'ciphertext',
        'SELECT'
    ) OR NOT has_table_privilege(
        'sheinfm_webhook_ingress_login',
        'raw.webhook_receipt',
        'INSERT'
    ) OR NOT has_column_privilege(
        'sheinfm_webhook_ingress_login',
        'raw.webhook_receipt',
        'duplicate_count',
        'UPDATE'
    ) OR NOT has_table_privilege(
        'sheinfm_webhook_ingress_login',
        'ops.webhook_job',
        'INSERT'
    ) OR has_table_privilege(
        'sheinfm_webhook_ingress_login',
        'ops.webhook_job',
        'UPDATE'
    ) THEN
        RAISE EXCEPTION 'webhook ingress receipt/job boundary is invalid';
    END IF;
    IF NOT has_table_privilege(
        'sheinfm_webhook_ingress_login',
        'ops.webhook_runtime_heartbeat',
        'SELECT'
    ) OR NOT has_table_privilege(
        'sheinfm_webhook_ingress_login',
        'ops.webhook_runtime_heartbeat',
        'INSERT'
    ) OR has_table_privilege(
        'sheinfm_webhook_ingress_login',
        'ops.webhook_runtime_heartbeat',
        'UPDATE'
    ) OR has_table_privilege(
        'sheinfm_webhook_ingress_login',
        'ops.webhook_runtime_heartbeat',
        'DELETE'
    ) THEN
        RAISE EXCEPTION 'webhook ingress heartbeat boundary is invalid';
    END IF;

    -- Worker can decrypt leased receipts and write only normalized webhook
    -- state. It cannot insert a receipt or mutate sales/supply facts.
    IF NOT has_table_privilege(
        'sheinfm_webhook_worker_login', 'raw.webhook_receipt', 'SELECT'
    ) OR has_table_privilege(
        'sheinfm_webhook_worker_login', 'raw.webhook_receipt', 'INSERT'
    ) OR NOT has_table_privilege(
        'sheinfm_webhook_worker_login', 'ops.webhook_job', 'UPDATE'
    ) OR NOT has_table_privilege(
        'sheinfm_webhook_worker_login', 'ops.operational_event', 'INSERT'
    ) OR NOT has_table_privilege(
        'sheinfm_webhook_worker_login', 'ops.webhook_runtime_heartbeat', 'INSERT'
    ) OR has_table_privilege(
        'sheinfm_webhook_worker_login', 'fact.inventory_snapshot', 'INSERT'
    ) OR has_table_privilege(
        'sheinfm_webhook_worker_login', 'fact.full_sku_sales_snapshot', 'INSERT'
    ) THEN
        RAISE EXCEPTION 'webhook worker privilege boundary is invalid';
    END IF;

    -- Every identity writer has exactly the sequence capability needed for
    -- nextval. This list covers all 0001-0006 runtime-write identities.
    FOR sequence_row IN
        SELECT *
        FROM (VALUES
            ('sheinfm_sales_login', 'dim.store', 'store_id'),
            ('sheinfm_sales_login', 'raw.openapi_fetch_batch', 'fetch_batch_id'),
            ('sheinfm_sales_login', 'dim.full_sku', 'full_sku_id'),
            ('sheinfm_sales_login', 'fact.full_sku_sales_snapshot', 'sales_snapshot_id'),
            ('sheinfm_sales_login', 'ops.permission_probe', 'permission_probe_id'),
            ('sheinfm_sales_login', 'ops.sales_sync_run', 'sales_sync_run_id'),
            ('sheinfm_sales_login', 'ops.sales_quality_event', 'sales_quality_event_id'),
            ('sheinfm_supply_login', 'dim.store', 'store_id'),
            ('sheinfm_supply_login', 'raw.openapi_fetch_batch', 'fetch_batch_id'),
            ('sheinfm_supply_login', 'raw.openapi_fetch_page', 'openapi_fetch_page_id'),
            ('sheinfm_supply_login', 'raw.product_identity_observation_set', 'identity_observation_set_id'),
            ('sheinfm_supply_login', 'raw.identifier_observation', 'identifier_observation_id'),
            ('sheinfm_supply_login', 'dim.canonical_product', 'canonical_product_id'),
            ('sheinfm_supply_login', 'ops.canonical_product_observation_set', 'canonical_product_observation_set_id'),
            ('sheinfm_supply_login', 'ops.product_match_candidate', 'product_match_candidate_id'),
            ('sheinfm_supply_login', 'ops.product_match_candidate_evidence', 'product_match_candidate_evidence_id'),
            ('sheinfm_supply_login', 'ops.product_identity_decision', 'product_identity_decision_id'),
            ('sheinfm_supply_login', 'dim.full_sku_canonical_assignment', 'full_sku_canonical_assignment_id'),
            ('sheinfm_supply_login', 'ops.supply_sync_attempt', 'supply_sync_attempt_event_id'),
            ('sheinfm_supply_login', 'fact.supply_projection_batch', 'supply_projection_batch_id'),
            ('sheinfm_supply_login', 'fact.supply_projection_member', 'supply_projection_member_id'),
            ('sheinfm_supply_login', 'dim.full_sku', 'full_sku_id'),
            ('sheinfm_supply_login', 'dim.full_warehouse', 'full_warehouse_id'),
            ('sheinfm_supply_login', 'fact.purchase_order', 'purchase_order_id'),
            ('sheinfm_supply_login', 'fact.purchase_order_line', 'purchase_order_line_id'),
            ('sheinfm_supply_login', 'fact.purchase_order_jit_relation', 'purchase_order_jit_relation_id'),
            ('sheinfm_supply_login', 'fact.delivery', 'delivery_id'),
            ('sheinfm_supply_login', 'fact.delivery_line', 'delivery_line_id'),
            ('sheinfm_supply_login', 'fact.inventory_snapshot', 'inventory_snapshot_id'),
            ('sheinfm_supply_login', 'fact.warehouse_inventory_snapshot', 'warehouse_inventory_snapshot_id'),
            ('sheinfm_supply_login', 'fact.stock_advice_snapshot', 'stock_advice_snapshot_id'),
            ('sheinfm_supply_login', 'fact.shortage_event', 'shortage_event_id'),
            ('sheinfm_supply_login', 'ops.reconciliation_result', 'reconciliation_result_id'),
            ('sheinfm_webhook_ingress_login', 'raw.webhook_receipt', 'receipt_id'),
            ('sheinfm_webhook_ingress_login', 'ops.webhook_job', 'job_id'),
            ('sheinfm_webhook_ingress_login', 'ops.webhook_runtime_heartbeat', 'webhook_runtime_heartbeat_id'),
            ('sheinfm_webhook_worker_login', 'ops.webhook_runtime_heartbeat', 'webhook_runtime_heartbeat_id'),
            ('sheinfm_webhook_worker_login', 'ops.operational_event', 'operational_event_id'),
            ('sheinfm_webhook_worker_login', 'ops.webhook_hydration_directive', 'hydration_directive_id')
        ) AS expected(role_name, table_name, column_name)
    LOOP
        sequence_name := pg_get_serial_sequence(
            sequence_row.table_name,
            sequence_row.column_name
        )::regclass;
        IF sequence_name IS NULL OR NOT has_sequence_privilege(
            sequence_row.role_name,
            sequence_name,
            'USAGE'
        ) THEN
            RAISE EXCEPTION 'missing sequence USAGE for %.%.%',
                sequence_row.role_name,
                sequence_row.table_name,
                sequence_row.column_name;
        END IF;
    END LOOP;
    FOR relation_row IN
        SELECT class.oid, class.oid::regclass AS sequence_name
        FROM pg_class AS class
        JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = ANY (ARRAY['raw', 'dim', 'fact', 'mart', 'ops'])
          AND class.relkind = 'S'
    LOOP
        IF has_sequence_privilege(
            'sheinfm_materializer_login', relation_row.oid, 'USAGE'
        ) OR has_sequence_privilege(
            'sheinfm_app', relation_row.oid, 'USAGE'
        ) THEN
            RAISE EXCEPTION 'read-only role retained sequence USAGE on %',
                relation_row.sequence_name;
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc AS procedure
        JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        JOIN pg_language AS language ON language.oid = procedure.prolang
        WHERE procedure.oid =
              'ops.distinct_identity_evidence_count(text[])'::regprocedure
          AND procedure.provolatile = 'i'
          AND procedure.prosecdef = false
          AND language.lanname = 'sql'
    ) THEN
        RAISE EXCEPTION
            'identity evidence count function is not immutable SQL invoker code';
    END IF;
    IF NOT has_function_privilege(
        'sheinfm_supply_loader',
        'ops.distinct_identity_evidence_count(text[])',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'sheinfm_supply_login',
        'ops.distinct_identity_evidence_count(text[])',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION
            'supply identity evidence count function privilege is missing';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_proc AS procedure
        JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = ANY (ARRAY['raw', 'dim', 'fact', 'mart', 'ops'])
          AND procedure.oid <>
              'ops.distinct_identity_evidence_count(text[])'::regprocedure
          AND (
              has_function_privilege(
                  'sheinfm_supply_loader', procedure.oid, 'EXECUTE'
              )
              OR has_function_privilege(
                  'sheinfm_supply_login', procedure.oid, 'EXECUTE'
              )
          )
    ) THEN
        RAISE EXCEPTION
            'supply runtime can execute another warehouse project function';
    END IF;
    FOREACH expected_group IN ARRAY ARRAY[
        'sheinfm_app',
        'sheinfm_materializer_ro',
        'sheinfm_materializer_login',
        'sheinfm_sales_loader',
        'sheinfm_sales_login',
        'sheinfm_webhook_ingress',
        'sheinfm_webhook_ingress_login',
        'sheinfm_webhook_worker',
        'sheinfm_webhook_worker_login'
    ]
    LOOP
        IF has_function_privilege(
            expected_group,
            'ops.distinct_identity_evidence_count(text[])',
            'EXECUTE'
        ) THEN
            RAISE EXCEPTION 'runtime principal % can execute supply-only function %',
                expected_group,
                'ops.distinct_identity_evidence_count(text[])';
        END IF;
    END LOOP;

    FOREACH required_name IN ARRAY ARRAY[
        'ops.touch_updated_at()',
        'ops.reject_append_only_identity_mutation()',
        'ops.guard_product_identity_observation_set_mutation()',
        'ops.require_building_product_identity_observation_set()',
        'ops.verify_product_identity_observation_set_sealed()',
        'ops.guard_webhook_receipt_immutable()',
        'ops.reject_webhook_runtime_heartbeat_mutation()',
        'ops.guard_webhook_store_gate_recovery()',
        'ops.reopen_webhook_authorization_gate_after_probe(text,bigint)',
        'ops.reject_supply_append_only_mutation()'
    ]
    LOOP
        FOREACH expected_group IN ARRAY ARRAY[
            'sheinfm_materializer_ro',
            'sheinfm_materializer_login',
            'sheinfm_sales_loader',
            'sheinfm_sales_login',
            'sheinfm_supply_loader',
            'sheinfm_supply_login',
            'sheinfm_webhook_ingress',
            'sheinfm_webhook_ingress_login',
            'sheinfm_webhook_worker',
            'sheinfm_webhook_worker_login',
            'sheinfm_app'
        ]
        LOOP
            IF has_function_privilege(expected_group, required_name, 'EXECUTE') THEN
                RAISE EXCEPTION 'runtime principal % can execute %',
                    expected_group,
                    required_name;
            END IF;
        END LOOP;
    END LOOP;
END;
$verify$;

SELECT 'full-managed runtime roles are reconciled and least-privileged' AS result;

ROLLBACK;
