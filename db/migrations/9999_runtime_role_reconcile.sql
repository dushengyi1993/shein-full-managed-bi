\getenv sheinfm_materializer_password SHEIN_FM_MATERIALIZER_DB_PASSWORD
\getenv sheinfm_sales_password SHEIN_FM_SALES_DB_PASSWORD
\getenv sheinfm_supply_password SHEIN_FM_SUPPLY_DB_PASSWORD
\getenv sheinfm_webhook_ingress_password SHEIN_FM_WEBHOOK_INGRESS_DB_PASSWORD
\getenv sheinfm_webhook_worker_password SHEIN_FM_WEBHOOK_WORKER_DB_PASSWORD
\getenv sheinfm_webapi_login_password SHEIN_FM_WEBAPI_LOGIN_DB_PASSWORD

BEGIN;

-- Missing or placeholder runtime passwords fail before any privilege change.
SELECT 1 / CASE WHEN length(:'sheinfm_materializer_password') >= 24 THEN 1 ELSE 0 END;
SELECT 1 / CASE WHEN length(:'sheinfm_sales_password') >= 24 THEN 1 ELSE 0 END;
SELECT 1 / CASE WHEN length(:'sheinfm_supply_password') >= 24 THEN 1 ELSE 0 END;
SELECT 1 / CASE WHEN length(:'sheinfm_webhook_ingress_password') >= 24 THEN 1 ELSE 0 END;
SELECT 1 / CASE WHEN length(:'sheinfm_webhook_worker_password') >= 24 THEN 1 ELSE 0 END;
SELECT 1 / CASE WHEN length(:'sheinfm_webapi_login_password') >= 24 THEN 1 ELSE 0 END;

DO $$
DECLARE
    relation_name text;
    function_name text;
BEGIN
    FOREACH relation_name IN ARRAY ARRAY[
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
        'ops.reconciliation_result',
        'ops.backfill_run',
        'ops.backfill_window',
        'ops.backfill_checkpoint',
        'raw.webapi_fetch_batch',
        'raw.webapi_metric_observation',
        'dim.webapi_metric_definition',
        'ops.webapi_session_health',
        'raw.webapi_home_fetch_audit',
        'fact.full_home_store_daily',
        'fact.full_home_region_daily',
        'fact.full_home_product_daily',
        'fact.full_product_price_observation',
        'fact.full_home_finance_daily',
        'fact.full_home_product_finance_daily',
        'fact.full_home_finance_detail_observation',
        'fact.full_home_finance_report_observation',
        'fact.full_home_finance_adjustment_observation',
        'fact.full_home_bill_daily',
        'fact.full_home_ledger_daily',
        'ops.full_home_finance_sync_window'
    ]
    LOOP
        IF to_regclass(relation_name) IS NULL THEN
            RAISE EXCEPTION 'runtime privilege reconciliation requires relation %', relation_name;
        END IF;
    END LOOP;

    FOREACH function_name IN ARRAY ARRAY[
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
        'ops.reject_supply_append_only_mutation()',
        'ops.reject_webapi_evidence_mutation()',
        'ops.guard_backfill_checkpoint_progress()'
    ]
    LOOP
        IF to_regprocedure(function_name) IS NULL THEN
            RAISE EXCEPTION 'runtime privilege reconciliation requires function %', function_name;
        END IF;
    END LOOP;
END;
$$;

-- NOLOGIN roles are the auditable capability groups. LOGIN roles contain only
-- one password and inherit exactly one capability group.
SELECT 'CREATE ROLE sheinfm_materializer_ro NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_materializer_ro')
\gexec
SELECT 'CREATE ROLE sheinfm_sales_loader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_sales_loader')
\gexec
SELECT 'CREATE ROLE sheinfm_supply_loader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_supply_loader')
\gexec
SELECT 'CREATE ROLE sheinfm_webhook_ingress NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_webhook_ingress')
\gexec
SELECT 'CREATE ROLE sheinfm_webhook_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_webhook_worker')
\gexec
-- Isolated WebAPI experiment capability group. It owns only the experiment
-- evidence layer and must never gain OpenAPI sales/supply or Webhook access.
SELECT 'CREATE ROLE sheinfm_webapi_loader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_webapi_loader')
\gexec

SELECT 'CREATE ROLE sheinfm_materializer_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_materializer_login')
\gexec
SELECT 'CREATE ROLE sheinfm_sales_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_sales_login')
\gexec
SELECT 'CREATE ROLE sheinfm_supply_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_supply_login')
\gexec
SELECT 'CREATE ROLE sheinfm_webhook_ingress_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_webhook_ingress_login')
\gexec
SELECT 'CREATE ROLE sheinfm_webhook_worker_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_webhook_worker_login')
\gexec
-- The WebAPI login is NOINHERIT: it holds no privilege until it explicitly
-- executes SET ROLE sheinfm_webapi_loader, so an accidental connection cannot
-- read or write anything at all.
SELECT 'CREATE ROLE sheinfm_webapi_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_webapi_login')
\gexec

ALTER ROLE sheinfm_materializer_ro PASSWORD NULL NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE sheinfm_webapi_loader PASSWORD NULL NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE sheinfm_sales_loader PASSWORD NULL NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE sheinfm_supply_loader PASSWORD NULL NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE sheinfm_webhook_ingress PASSWORD NULL NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE sheinfm_webhook_worker PASSWORD NULL NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

SELECT format(
    'ALTER ROLE sheinfm_materializer_login PASSWORD %L LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3',
    :'sheinfm_materializer_password'
)
\gexec
SELECT format(
    'ALTER ROLE sheinfm_sales_login PASSWORD %L LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4',
    :'sheinfm_sales_password'
)
\gexec
SELECT format(
    'ALTER ROLE sheinfm_supply_login PASSWORD %L LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4',
    :'sheinfm_supply_password'
)
\gexec
SELECT format(
    'ALTER ROLE sheinfm_webhook_ingress_login PASSWORD %L LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6',
    :'sheinfm_webhook_ingress_password'
)
\gexec
SELECT format(
    'ALTER ROLE sheinfm_webhook_worker_login PASSWORD %L LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6',
    :'sheinfm_webhook_worker_password'
)
\gexec
SELECT format(
    'ALTER ROLE sheinfm_webapi_login PASSWORD %L LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2',
    :'sheinfm_webapi_login_password'
)
\gexec

ALTER ROLE sheinfm_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- Remove every pre-existing membership from runtime logins before assigning
-- their one auditable capability group. This also strips legacy or accidental
-- memberships that are not part of this migration's known role set.
DO $$
DECLARE
    membership_row record;
BEGIN
    FOR membership_row IN
        SELECT member.rolname AS member_name, granted.rolname AS granted_name
        FROM pg_auth_members AS membership
        JOIN pg_roles AS member ON member.oid = membership.member
        JOIN pg_roles AS granted ON granted.oid = membership.roleid
        WHERE member.rolname = ANY (ARRAY[
            'sheinfm_materializer_login',
            'sheinfm_sales_login',
            'sheinfm_supply_login',
            'sheinfm_webhook_ingress_login',
            'sheinfm_webhook_worker_login',
            'sheinfm_webapi_login',
            'sheinfm_app'
        ])
    LOOP
        EXECUTE format(
            'REVOKE %I FROM %I',
            membership_row.granted_name,
            membership_row.member_name
        );
    END LOOP;
END;
$$;

GRANT sheinfm_materializer_ro TO sheinfm_materializer_login;
GRANT sheinfm_sales_loader TO sheinfm_sales_login;
GRANT sheinfm_supply_loader TO sheinfm_supply_login;
GRANT sheinfm_webhook_ingress TO sheinfm_webhook_ingress_login;
GRANT sheinfm_webhook_worker TO sheinfm_webhook_worker_login;
GRANT sheinfm_webapi_loader TO sheinfm_webapi_login;

SELECT current_database() AS sheinfm_runtime_database
\gset

REVOKE ALL PRIVILEGES ON DATABASE :"sheinfm_runtime_database" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE :"sheinfm_runtime_database"
FROM sheinfm_app,
     sheinfm_materializer_ro, sheinfm_sales_loader, sheinfm_supply_loader,
     sheinfm_webhook_ingress, sheinfm_webhook_worker, sheinfm_webapi_loader,
     sheinfm_materializer_login, sheinfm_sales_login, sheinfm_supply_login,
     sheinfm_webhook_ingress_login, sheinfm_webhook_worker_login,
     sheinfm_webapi_login;

REVOKE ALL PRIVILEGES ON SCHEMA raw, dim, fact, mart, ops FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA raw, dim, fact, mart, ops
FROM sheinfm_app,
     sheinfm_materializer_ro, sheinfm_sales_loader, sheinfm_supply_loader,
     sheinfm_webhook_ingress, sheinfm_webhook_worker, sheinfm_webapi_loader,
     sheinfm_materializer_login, sheinfm_sales_login, sheinfm_supply_login,
     sheinfm_webhook_ingress_login, sheinfm_webhook_worker_login,
     sheinfm_webapi_login;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA raw, dim, fact, mart, ops FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA raw, dim, fact, mart, ops FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA raw, dim, fact, mart, ops FROM PUBLIC;

DO $$
DECLARE
    principal_name text;
    relation_row record;
    column_row record;
    sequence_row record;
    function_row record;
    runtime_principals constant text[] := ARRAY[
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
    ];
BEGIN
    FOREACH principal_name IN ARRAY runtime_principals
    LOOP
        FOR relation_row IN
            SELECT namespace.nspname AS schema_name, class.relname AS relation_name
            FROM pg_class AS class
            JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
            WHERE namespace.nspname = ANY (ARRAY['raw', 'dim', 'fact', 'mart', 'ops'])
              AND class.relkind IN ('r', 'p', 'v', 'm')
        LOOP
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
                relation_row.schema_name,
                relation_row.relation_name,
                principal_name
            );
            FOR column_row IN
                SELECT attribute.attname AS column_name
                FROM pg_attribute AS attribute
                JOIN pg_class AS class ON class.oid = attribute.attrelid
                JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
                WHERE namespace.nspname = relation_row.schema_name
                  AND class.relname = relation_row.relation_name
                  AND attribute.attnum > 0
                  AND NOT attribute.attisdropped
            LOOP
                EXECUTE format(
                    'REVOKE SELECT (%1$I), INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON TABLE %2$I.%3$I FROM %4$I',
                    column_row.column_name,
                    relation_row.schema_name,
                    relation_row.relation_name,
                    principal_name
                );
            END LOOP;
        END LOOP;

        FOR sequence_row IN
            SELECT class.oid::regclass AS sequence_name
            FROM pg_class AS class
            JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
            WHERE namespace.nspname = ANY (ARRAY['raw', 'dim', 'fact', 'mart', 'ops'])
              AND class.relkind = 'S'
        LOOP
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM %I',
                sequence_row.sequence_name,
                principal_name
            );
        END LOOP;

        FOR function_row IN
            SELECT procedure.oid::regprocedure AS function_name
            FROM pg_proc AS procedure
            JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
            WHERE namespace.nspname = ANY (ARRAY['raw', 'dim', 'fact', 'mart', 'ops'])
        LOOP
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
                function_row.function_name,
                principal_name
            );
        END LOOP;
    END LOOP;
END;
$$;

ALTER DEFAULT PRIVILEGES IN SCHEMA raw, dim, fact, mart, ops
    REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC,
        sheinfm_app,
        sheinfm_materializer_ro, sheinfm_sales_loader, sheinfm_supply_loader,
        sheinfm_webhook_ingress, sheinfm_webhook_worker,
        sheinfm_materializer_login, sheinfm_sales_login, sheinfm_supply_login,
        sheinfm_webhook_ingress_login, sheinfm_webhook_worker_login;
ALTER DEFAULT PRIVILEGES IN SCHEMA raw, dim, fact, mart, ops
    REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC,
        sheinfm_app,
        sheinfm_materializer_ro, sheinfm_sales_loader, sheinfm_supply_loader,
        sheinfm_webhook_ingress, sheinfm_webhook_worker,
        sheinfm_materializer_login, sheinfm_sales_login, sheinfm_supply_login,
        sheinfm_webhook_ingress_login, sheinfm_webhook_worker_login;
ALTER DEFAULT PRIVILEGES IN SCHEMA raw, dim, fact, mart, ops
    REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC,
        sheinfm_app,
        sheinfm_materializer_ro, sheinfm_sales_loader, sheinfm_supply_loader,
        sheinfm_webhook_ingress, sheinfm_webhook_worker,
        sheinfm_materializer_login, sheinfm_sales_login, sheinfm_supply_login,
        sheinfm_webhook_ingress_login, sheinfm_webhook_worker_login;

GRANT CONNECT ON DATABASE :"sheinfm_runtime_database"
TO sheinfm_app,
   sheinfm_materializer_ro, sheinfm_sales_loader, sheinfm_supply_loader,
   sheinfm_webhook_ingress, sheinfm_webhook_worker, sheinfm_webapi_loader;
-- NOINHERIT: the login itself needs CONNECT, since SET ROLE happens after the
-- connection is already established.
GRANT CONNECT ON DATABASE :"sheinfm_runtime_database"
TO sheinfm_webapi_login;

GRANT USAGE ON SCHEMA raw, dim, fact, mart, ops
TO sheinfm_materializer_ro, sheinfm_app;
GRANT USAGE ON SCHEMA raw, dim, fact, mart, ops
TO sheinfm_sales_loader;
GRANT USAGE ON SCHEMA raw, dim, fact, ops
TO sheinfm_supply_loader;
GRANT USAGE ON SCHEMA raw, dim, ops
TO sheinfm_webhook_ingress, sheinfm_webhook_worker;
-- The WebAPI login also owns the reviewed homepage history loader. It receives
-- fact usage only for the three explicit homepage facts below; mart remains
-- unreachable.
GRANT USAGE ON SCHEMA raw, dim, fact, ops
TO sheinfm_webapi_loader;

GRANT EXECUTE ON FUNCTION ops.distinct_identity_evidence_count(text[])
TO sheinfm_supply_loader;

-- Materializer and legacy sheinfm_app are read-only. The raw webhook grant is
-- column-scoped so neither role can read encrypted payloads.
GRANT SELECT ON
    dim.store,
    dim.full_sku,
    dim.canonical_product,
    dim.canonical_variant,
    dim.full_sku_canonical_assignment,
    dim.reporting_goods,
    dim.full_sku_reporting_goods_assignment,
    fact.full_sku_sales_snapshot,
    fact.purchase_order,
    fact.purchase_order_line,
    fact.delivery,
    fact.delivery_line,
    fact.inventory_snapshot,
    fact.stock_advice_snapshot,
    fact.supply_projection_batch,
    fact.supply_projection_member,
    fact.full_home_store_daily,
    fact.full_home_region_daily,
    fact.full_home_product_daily,
    fact.full_product_price_observation,
    fact.full_home_finance_daily,
    fact.full_home_product_finance_daily,
    fact.full_home_ledger_daily,
    fact.full_home_bill_daily,
    raw.openapi_fetch_batch,
    -- Identity pipeline aggregates only. The dashboard counts sealed evidence
    -- sets, candidates and decisions; it never reads raw.identifier_observation
    -- or ops.product_match_candidate_evidence, so those stay denied.
    raw.product_identity_observation_set,
    ops.product_match_candidate,
    ops.product_identity_decision,
    ops.permission_probe,
    ops.sales_sync_run,
    ops.sales_quality_event,
    ops.sales_business_watermark,
    ops.employee_principal,
    ops.employee_store_assignment,
    ops.supply_sync_attempt,
    ops.webhook_runtime_heartbeat,
    ops.webhook_job,
    ops.operational_event,
    ops.webhook_hydration_directive,
    ops.webhook_subscription_state,
    ops.webhook_store_gate
TO sheinfm_materializer_ro, sheinfm_app;
GRANT SELECT (received_at) ON raw.webhook_receipt
TO sheinfm_materializer_ro;
GRANT SELECT (
    store_code,
    report_generated_date,
    currency,
    expected_settlement_amount,
    completed_pay_at,
    estimated_pay_at,
    observed_at
) ON fact.full_home_finance_report_observation
TO sheinfm_materializer_ro;
GRANT SELECT (
    webapi_home_fetch_audit_id,
    store_code,
    endpoint_code,
    result_status,
    sanitized_error_code,
    observed_at
) ON raw.webapi_home_fetch_audit
TO sheinfm_materializer_ro;

-- The former monolithic runtime login remains available only for read-only
-- compatibility. It can inspect every current warehouse relation except the
-- encrypted webhook receipt, where only the operational timestamp is exposed.
GRANT SELECT ON ALL TABLES IN SCHEMA raw, dim, fact, mart, ops
TO sheinfm_app;
REVOKE SELECT ON raw.webhook_receipt FROM sheinfm_app;
GRANT SELECT (received_at) ON raw.webhook_receipt TO sheinfm_app;

-- Sales loader: catalog membership, sales facts, permission evidence, accepted
-- watermarks and the two derived marts only.
GRANT SELECT, INSERT, UPDATE ON dim.store, dim.full_sku
TO sheinfm_sales_loader;
GRANT SELECT, INSERT ON raw.openapi_fetch_batch, fact.full_sku_sales_snapshot
TO sheinfm_sales_loader;
GRANT INSERT, DELETE ON mart.full_store_sales_latest, mart.full_product_sales_latest
TO sheinfm_sales_loader;
GRANT SELECT, INSERT ON ops.permission_probe
TO sheinfm_sales_loader;
GRANT SELECT, INSERT ON ops.sales_quality_event
TO sheinfm_sales_loader;
GRANT SELECT, INSERT ON ops.sales_sync_run
TO sheinfm_sales_loader;
GRANT SELECT, INSERT, UPDATE ON ops.sales_business_watermark
TO sheinfm_sales_loader;
-- Finance report rows are immutable price observations used only to estimate
-- homepage product amount. The sales loader can append/read evidence but can
-- never alter or delete it.
GRANT SELECT, INSERT ON fact.full_product_price_observation
TO sheinfm_sales_loader;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    fact.full_home_finance_daily,
    fact.full_home_product_finance_daily,
    fact.full_home_finance_detail_observation,
    fact.full_home_finance_report_observation,
    fact.full_home_finance_adjustment_observation,
    fact.full_home_bill_daily
TO sheinfm_sales_loader;
GRANT SELECT, INSERT, UPDATE ON ops.full_home_finance_sync_window
TO sheinfm_sales_loader;
GRANT SELECT ON fact.full_home_product_daily
TO sheinfm_sales_loader;
GRANT UPDATE (
    estimated_deal_amount,
    estimation_currency,
    unit_price_evidence,
    estimation_basis,
    price_observed_at,
    updated_at
) ON fact.full_home_product_daily
TO sheinfm_sales_loader;

-- Supply loader: supply-only raw evidence, dimensions and facts. The attempt
-- and projection ledgers are append-only by both grants and triggers. Product
-- identity observation envelopes can only make their one guarded seal update.
GRANT SELECT, INSERT ON
    raw.openapi_fetch_batch,
    raw.openapi_fetch_page,
    raw.product_identity_observation_set,
    raw.identifier_observation,
    ops.supply_sync_attempt,
    fact.supply_projection_batch,
    fact.supply_projection_member
TO sheinfm_supply_loader;
GRANT UPDATE (status, member_count, sealed_at)
ON raw.product_identity_observation_set
TO sheinfm_supply_loader;
-- The identity resolver is an internal warehouse pipeline. It may append
-- deterministic products, provenance, candidates, relational evidence,
-- decisions and first-current assignments, but it cannot mutate or delete any
-- resolved identity row. A conflicting current assignment is a fail-closed
-- planner outcome, not an UPDATE permission.
GRANT SELECT, INSERT ON
    dim.canonical_product,
    ops.canonical_product_observation_set,
    ops.product_match_candidate,
    ops.product_match_candidate_evidence,
    ops.product_identity_decision,
    dim.full_sku_canonical_assignment
TO sheinfm_supply_loader;
-- Owner-confirmed reporting labels are deliberately separate from strict
-- canonical identity. The supply loader can append plans and temporal
-- assignments, then only close a current assignment or roll a plan back.
GRANT SELECT, INSERT ON
    dim.reporting_goods,
    dim.full_sku_reporting_goods_assignment,
    ops.reporting_goods_import_run
TO sheinfm_supply_loader;
GRANT UPDATE (assignment_status, superseded_by_plan_hash, valid_to, updated_at)
ON dim.full_sku_reporting_goods_assignment
TO sheinfm_supply_loader;
GRANT UPDATE (result_status, rolled_back_at)
ON ops.reporting_goods_import_run
TO sheinfm_supply_loader;
GRANT SELECT ON ops.sales_sync_run
TO sheinfm_supply_loader;
GRANT SELECT, INSERT, UPDATE ON
    dim.store,
    dim.full_sku,
    dim.full_warehouse,
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
TO sheinfm_supply_loader;
-- Bounded reconciliation history (0013). The supply loader upserts the latest
-- observation per grain per UTC day; it never writes the long-term summary or
-- anomaly tables, which are recomputed by owner-run maintenance.
GRANT SELECT, INSERT, UPDATE ON ops.reconciliation_daily_detail
TO sheinfm_supply_loader;
GRANT SELECT, UPDATE ON ops.webhook_hydration_directive
TO sheinfm_supply_loader;
GRANT SELECT ON
    ops.reconciliation_daily_detail,
    ops.reconciliation_daily_summary,
    ops.reconciliation_anomaly
TO sheinfm_materializer_ro;

-- Ingress can resolve a store, persist an immutable receipt, bump duplicate
-- counters, and enqueue one job. It cannot lease, process or project jobs.
GRANT SELECT (store_id, store_code, is_active) ON dim.store
TO sheinfm_webhook_ingress;
GRANT INSERT ON raw.webhook_receipt
TO sheinfm_webhook_ingress;
GRANT SELECT (
    receipt_id,
    idempotency_key,
    app_key_hash,
    open_key_hash,
    event_code,
    event_path,
    store_id,
    delivery_scope,
    cipher_sha256,
    duplicate_count
) ON raw.webhook_receipt
TO sheinfm_webhook_ingress;
GRANT UPDATE (duplicate_count, last_duplicate_at) ON raw.webhook_receipt
TO sheinfm_webhook_ingress;
GRANT INSERT ON ops.webhook_job
TO sheinfm_webhook_ingress;
GRANT SELECT (job_id) ON ops.webhook_job
TO sheinfm_webhook_ingress;
GRANT SELECT, INSERT ON ops.webhook_runtime_heartbeat
TO sheinfm_webhook_ingress;

-- Worker can read immutable receipts, lease/update jobs and write only the
-- normalized webhook domain. It cannot ingest receipts or write sales/supply.
GRANT SELECT (store_id, store_code) ON dim.store
TO sheinfm_webhook_worker;
GRANT SELECT ON raw.webhook_receipt
TO sheinfm_webhook_worker;
GRANT SELECT, UPDATE ON ops.webhook_job
TO sheinfm_webhook_worker;
GRANT SELECT, INSERT, UPDATE ON ops.operational_event, ops.webhook_store_gate
TO sheinfm_webhook_worker;
GRANT INSERT ON ops.webhook_hydration_directive
TO sheinfm_webhook_worker;
GRANT SELECT, INSERT ON ops.webhook_runtime_heartbeat
TO sheinfm_webhook_worker;

-- WebAPI experiment loader: only its own isolated evidence layer. It appends
-- batches, observations and session health, reads back its own rows for the
-- idempotent replay check, and reads reviewed metric definitions. It never gains
-- SELECT or INSERT on OpenAPI sales/supply facts, webhook private objects, marts
-- or any other schema.
GRANT SELECT, INSERT ON
    raw.webapi_fetch_batch,
    raw.webapi_metric_observation,
    ops.webapi_session_health,
    raw.webapi_home_fetch_audit
TO sheinfm_webapi_loader;
GRANT SELECT ON dim.webapi_metric_definition
TO sheinfm_webapi_loader;
GRANT SELECT, INSERT, UPDATE ON
    fact.full_home_store_daily,
    fact.full_home_region_daily,
    fact.full_home_product_daily
TO sheinfm_webapi_loader;
-- The inventory ledger is a separate reviewed WebAPI contract. Keep its grant
-- explicit so adding ledger ingestion cannot silently widen the older homepage
-- fact boundary.
GRANT SELECT, INSERT, UPDATE ON fact.full_home_ledger_daily
TO sheinfm_webapi_loader;

-- Backfill control plane. Only the two OpenAPI domain loaders may open runs and
-- record windows/checkpoints, because only they own a verified adapter contract.
-- The WebAPI experiment loader is deliberately absent here.
GRANT SELECT, INSERT ON ops.backfill_run, ops.backfill_window
TO sheinfm_sales_loader, sheinfm_supply_loader;
GRANT UPDATE (status, completed_at, sanitized_error_code) ON ops.backfill_run
TO sheinfm_sales_loader, sheinfm_supply_loader;
GRANT UPDATE (
    execution_status,
    quality_status,
    attempt_count,
    accepted_row_count,
    rejected_row_count,
    expected_page_count,
    observed_page_count,
    source_business_watermark,
    schema_fingerprint,
    next_retry_at,
    sanitized_error_code,
    updated_at
) ON ops.backfill_window
TO sheinfm_sales_loader, sheinfm_supply_loader;
GRANT SELECT, INSERT, UPDATE ON ops.backfill_checkpoint
TO sheinfm_sales_loader, sheinfm_supply_loader;
GRANT SELECT ON ops.backfill_run, ops.backfill_window, ops.backfill_checkpoint
TO sheinfm_materializer_ro;

DO $$
DECLARE
    grant_row record;
    sequence_name regclass;
BEGIN
    FOR grant_row IN
        SELECT *
        FROM (VALUES
            ('sheinfm_sales_loader', 'dim.store', 'store_id'),
            ('sheinfm_sales_loader', 'raw.openapi_fetch_batch', 'fetch_batch_id'),
            ('sheinfm_sales_loader', 'dim.full_sku', 'full_sku_id'),
            ('sheinfm_sales_loader', 'fact.full_sku_sales_snapshot', 'sales_snapshot_id'),
            ('sheinfm_sales_loader', 'ops.permission_probe', 'permission_probe_id'),
            ('sheinfm_sales_loader', 'ops.sales_sync_run', 'sales_sync_run_id'),
            ('sheinfm_sales_loader', 'ops.sales_quality_event', 'sales_quality_event_id'),
            ('sheinfm_supply_loader', 'dim.store', 'store_id'),
            ('sheinfm_supply_loader', 'raw.openapi_fetch_batch', 'fetch_batch_id'),
            ('sheinfm_supply_loader', 'raw.openapi_fetch_page', 'openapi_fetch_page_id'),
            ('sheinfm_supply_loader', 'raw.product_identity_observation_set', 'identity_observation_set_id'),
            ('sheinfm_supply_loader', 'raw.identifier_observation', 'identifier_observation_id'),
            ('sheinfm_supply_loader', 'dim.canonical_product', 'canonical_product_id'),
            ('sheinfm_supply_loader', 'ops.canonical_product_observation_set', 'canonical_product_observation_set_id'),
            ('sheinfm_supply_loader', 'ops.product_match_candidate', 'product_match_candidate_id'),
            ('sheinfm_supply_loader', 'ops.product_match_candidate_evidence', 'product_match_candidate_evidence_id'),
            ('sheinfm_supply_loader', 'ops.product_identity_decision', 'product_identity_decision_id'),
            ('sheinfm_supply_loader', 'dim.full_sku_canonical_assignment', 'full_sku_canonical_assignment_id'),
            ('sheinfm_supply_loader', 'dim.reporting_goods', 'reporting_goods_id'),
            ('sheinfm_supply_loader', 'dim.full_sku_reporting_goods_assignment', 'full_sku_reporting_goods_assignment_id'),
            ('sheinfm_supply_loader', 'ops.supply_sync_attempt', 'supply_sync_attempt_event_id'),
            ('sheinfm_supply_loader', 'fact.supply_projection_batch', 'supply_projection_batch_id'),
            ('sheinfm_supply_loader', 'fact.supply_projection_member', 'supply_projection_member_id'),
            ('sheinfm_supply_loader', 'dim.full_sku', 'full_sku_id'),
            ('sheinfm_supply_loader', 'dim.full_warehouse', 'full_warehouse_id'),
            ('sheinfm_supply_loader', 'fact.purchase_order', 'purchase_order_id'),
            ('sheinfm_supply_loader', 'fact.purchase_order_line', 'purchase_order_line_id'),
            ('sheinfm_supply_loader', 'fact.purchase_order_jit_relation', 'purchase_order_jit_relation_id'),
            ('sheinfm_supply_loader', 'fact.delivery', 'delivery_id'),
            ('sheinfm_supply_loader', 'fact.delivery_line', 'delivery_line_id'),
            ('sheinfm_supply_loader', 'fact.inventory_snapshot', 'inventory_snapshot_id'),
            ('sheinfm_supply_loader', 'fact.warehouse_inventory_snapshot', 'warehouse_inventory_snapshot_id'),
            ('sheinfm_supply_loader', 'fact.stock_advice_snapshot', 'stock_advice_snapshot_id'),
            ('sheinfm_supply_loader', 'fact.shortage_event', 'shortage_event_id'),
            ('sheinfm_supply_loader', 'ops.reconciliation_result', 'reconciliation_result_id'),
            ('sheinfm_webhook_ingress', 'raw.webhook_receipt', 'receipt_id'),
            ('sheinfm_webhook_ingress', 'ops.webhook_job', 'job_id'),
            ('sheinfm_webhook_ingress', 'ops.webhook_runtime_heartbeat', 'webhook_runtime_heartbeat_id'),
            ('sheinfm_webhook_worker', 'ops.webhook_runtime_heartbeat', 'webhook_runtime_heartbeat_id'),
            ('sheinfm_webhook_worker', 'ops.operational_event', 'operational_event_id'),
            ('sheinfm_webhook_worker', 'ops.webhook_hydration_directive', 'hydration_directive_id'),
            ('sheinfm_webapi_loader', 'raw.webapi_fetch_batch', 'webapi_fetch_batch_id'),
            ('sheinfm_webapi_loader', 'raw.webapi_metric_observation', 'webapi_metric_observation_id'),
            ('sheinfm_webapi_loader', 'ops.webapi_session_health', 'webapi_session_health_id'),
            ('sheinfm_webapi_loader', 'raw.webapi_home_fetch_audit', 'webapi_home_fetch_audit_id'),
            ('sheinfm_sales_loader', 'fact.full_product_price_observation', 'full_product_price_observation_id'),
            ('sheinfm_sales_loader', 'ops.backfill_run', 'backfill_run_id'),
            ('sheinfm_sales_loader', 'ops.backfill_window', 'backfill_window_id'),
            ('sheinfm_sales_loader', 'ops.backfill_checkpoint', 'backfill_checkpoint_id'),
            ('sheinfm_supply_loader', 'ops.backfill_run', 'backfill_run_id'),
            ('sheinfm_supply_loader', 'ops.backfill_window', 'backfill_window_id'),
            ('sheinfm_supply_loader', 'ops.backfill_checkpoint', 'backfill_checkpoint_id')
        ) AS expected(role_name, table_name, column_name)
    LOOP
        sequence_name := pg_get_serial_sequence(
            grant_row.table_name,
            grant_row.column_name
        )::regclass;
        IF sequence_name IS NULL THEN
            RAISE EXCEPTION 'identity sequence is missing for %.%',
                grant_row.table_name, grant_row.column_name;
        END IF;
        EXECUTE format(
            'GRANT USAGE ON SEQUENCE %s TO %I',
            sequence_name,
            grant_row.role_name
        );
    END LOOP;
END;
$$;

DO $$
DECLARE
    role_row record;
    unexpected_membership record;
    relation_row record;
    privilege_name text;
    required_name text;
    principal_check text;
BEGIN
    FOR role_row IN
        SELECT role.rolname, role.rolcanlogin, role.rolsuper, role.rolcreatedb,
               role.rolcreaterole, role.rolreplication, role.rolbypassrls
        FROM pg_roles AS role
        WHERE role.rolname = ANY (ARRAY[
            'sheinfm_materializer_ro', 'sheinfm_sales_loader',
            'sheinfm_supply_loader', 'sheinfm_webhook_ingress',
            'sheinfm_webhook_worker', 'sheinfm_webapi_loader'
        ])
    LOOP
        IF role_row.rolcanlogin
           OR role_row.rolsuper
           OR role_row.rolcreatedb
           OR role_row.rolcreaterole
           OR role_row.rolreplication
           OR role_row.rolbypassrls THEN
            RAISE EXCEPTION 'unsafe NOLOGIN capability role %', role_row.rolname;
        END IF;
    END LOOP;
    IF (SELECT count(*) FROM pg_roles WHERE rolname = ANY (ARRAY[
        'sheinfm_materializer_ro', 'sheinfm_sales_loader',
        'sheinfm_supply_loader', 'sheinfm_webhook_ingress',
        'sheinfm_webhook_worker', 'sheinfm_webapi_loader'
    ])) <> 6 THEN
        RAISE EXCEPTION 'runtime capability role set is incomplete';
    END IF;

    -- The WebAPI login must hold no inherited privilege at connection time.
    IF (
        SELECT rolinherit FROM pg_roles WHERE rolname = 'sheinfm_webapi_login'
    ) THEN
        RAISE EXCEPTION 'sheinfm_webapi_login must be NOINHERIT';
    END IF;

    SELECT member.rolname AS member_name, granted.rolname AS granted_name
    INTO unexpected_membership
    FROM pg_auth_members AS membership
    JOIN pg_roles AS member ON member.oid = membership.member
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    WHERE member.rolname = ANY (ARRAY[
        'sheinfm_materializer_login', 'sheinfm_sales_login',
        'sheinfm_supply_login', 'sheinfm_webhook_ingress_login',
        'sheinfm_webhook_worker_login', 'sheinfm_webapi_login'
    ])
      AND (member.rolname, granted.rolname) NOT IN (
        ('sheinfm_materializer_login', 'sheinfm_materializer_ro'),
        ('sheinfm_sales_login', 'sheinfm_sales_loader'),
        ('sheinfm_supply_login', 'sheinfm_supply_loader'),
        ('sheinfm_webhook_ingress_login', 'sheinfm_webhook_ingress'),
        ('sheinfm_webhook_worker_login', 'sheinfm_webhook_worker'),
        ('sheinfm_webapi_login', 'sheinfm_webapi_loader')
      )
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'runtime login % has unexpected membership %',
            unexpected_membership.member_name,
            unexpected_membership.granted_name;
    END IF;

    IF NOT has_table_privilege(
        'sheinfm_sales_login',
        'fact.full_sku_sales_snapshot',
        'INSERT'
    ) OR has_table_privilege(
        'sheinfm_sales_login',
        'fact.inventory_snapshot',
        'INSERT'
    ) THEN
        RAISE EXCEPTION 'sales loader privilege boundary is invalid';
    END IF;
    IF NOT has_table_privilege(
        'sheinfm_supply_login',
        'fact.inventory_snapshot',
        'INSERT'
    ) OR has_table_privilege(
        'sheinfm_supply_login',
        'fact.full_sku_sales_snapshot',
        'INSERT'
    ) THEN
        RAISE EXCEPTION 'supply loader privilege boundary is invalid';
    END IF;
    IF has_table_privilege(
        'sheinfm_supply_login',
        'ops.supply_sync_attempt',
        'UPDATE'
    ) OR has_table_privilege(
        'sheinfm_supply_login',
        'fact.supply_projection_batch',
        'DELETE'
    ) THEN
        RAISE EXCEPTION 'supply attempt/projection ledgers must remain append-only';
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
    IF NOT has_table_privilege(
        'sheinfm_webhook_ingress_login',
        'raw.webhook_receipt',
        'INSERT'
    ) OR has_table_privilege(
        'sheinfm_webhook_ingress_login',
        'ops.webhook_job',
        'UPDATE'
    ) THEN
        RAISE EXCEPTION 'webhook ingress privilege boundary is invalid';
    END IF;
    IF NOT has_column_privilege(
        'sheinfm_webhook_ingress_login',
        'dim.store',
        'is_active',
        'SELECT'
    ) OR has_column_privilege(
        'sheinfm_webhook_ingress_login',
        'raw.webhook_receipt',
        'ciphertext',
        'SELECT'
    ) OR NOT has_table_privilege(
        'sheinfm_webhook_ingress_login',
        'ops.webhook_runtime_heartbeat',
        'INSERT'
    ) OR has_table_privilege(
        'sheinfm_webhook_ingress_login',
        'ops.webhook_runtime_heartbeat',
        'UPDATE'
    ) THEN
        RAISE EXCEPTION 'webhook ingress column or heartbeat boundary is invalid';
    END IF;
    IF NOT has_table_privilege(
        'sheinfm_webhook_worker_login',
        'ops.operational_event',
        'INSERT'
    ) OR has_table_privilege(
        'sheinfm_webhook_worker_login',
        'raw.webhook_receipt',
        'INSERT'
    ) THEN
        RAISE EXCEPTION 'webhook worker privilege boundary is invalid';
    END IF;
    IF NOT has_table_privilege(
        'sheinfm_webhook_worker_login',
        'ops.webhook_runtime_heartbeat',
        'SELECT,INSERT'
    ) OR has_table_privilege(
        'sheinfm_webhook_worker_login',
        'ops.webhook_runtime_heartbeat',
        'UPDATE,DELETE'
    ) THEN
        RAISE EXCEPTION 'webhook worker heartbeat boundary is invalid';
    END IF;
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
    IF NOT has_table_privilege(
        'sheinfm_materializer_login',
        'ops.supply_sync_attempt',
        'SELECT'
    ) OR NOT has_table_privilege(
        'sheinfm_materializer_login',
        'fact.supply_projection_batch',
        'SELECT'
    ) OR NOT has_table_privilege(
        'sheinfm_materializer_login',
        'fact.supply_projection_member',
        'SELECT'
    ) OR NOT has_table_privilege(
        'sheinfm_materializer_login',
        'ops.webhook_runtime_heartbeat',
        'SELECT'
    ) OR has_table_privilege(
        'sheinfm_materializer_login',
        'ops.supply_sync_attempt',
        'INSERT,UPDATE,DELETE'
    ) THEN
        RAISE EXCEPTION 'materializer read-only operational projection is invalid';
    END IF;

    -- WebAPI experiment loader: positive on its own evidence layer only.
    FOREACH required_name IN ARRAY ARRAY[
        'raw.webapi_fetch_batch',
        'raw.webapi_metric_observation',
        'ops.webapi_session_health',
        'raw.webapi_home_fetch_audit'
    ]
    LOOP
        IF NOT has_table_privilege('sheinfm_webapi_loader', required_name, 'SELECT')
           OR NOT has_table_privilege('sheinfm_webapi_loader', required_name, 'INSERT')
           OR has_table_privilege('sheinfm_webapi_loader', required_name, 'UPDATE')
           OR has_table_privilege('sheinfm_webapi_loader', required_name, 'DELETE')
           OR has_table_privilege('sheinfm_webapi_loader', required_name, 'TRUNCATE') THEN
            RAISE EXCEPTION 'WebAPI experiment evidence boundary is invalid for %',
                required_name;
        END IF;
    END LOOP;
    IF NOT has_table_privilege(
        'sheinfm_webapi_loader', 'dim.webapi_metric_definition', 'SELECT'
    ) OR has_table_privilege(
        'sheinfm_webapi_loader', 'dim.webapi_metric_definition', 'INSERT,UPDATE,DELETE'
    ) THEN
        RAISE EXCEPTION 'WebAPI metric definition must stay human-reviewed and read-only';
    END IF;

    -- The reviewed homepage loader may upsert only its three formal facts.
    FOREACH required_name IN ARRAY ARRAY[
        'fact.full_home_store_daily',
        'fact.full_home_region_daily',
        'fact.full_home_product_daily',
        'fact.full_home_ledger_daily'
    ]
    LOOP
        IF NOT has_table_privilege('sheinfm_webapi_loader', required_name, 'SELECT')
           OR NOT has_table_privilege('sheinfm_webapi_loader', required_name, 'INSERT')
           OR NOT has_table_privilege('sheinfm_webapi_loader', required_name, 'UPDATE')
           OR has_table_privilege('sheinfm_webapi_loader', required_name, 'DELETE')
           OR has_table_privilege('sheinfm_webapi_loader', required_name, 'TRUNCATE') THEN
            RAISE EXCEPTION 'WebAPI homepage fact boundary is invalid for %',
                required_name;
        END IF;
    END LOOP;
    IF has_table_privilege(
        'sheinfm_webapi_loader',
        'fact.full_product_price_observation',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
    ) THEN
        RAISE EXCEPTION 'WebAPI loader must not access OpenAPI finance price evidence';
    END IF;

    -- WebAPI experiment loader: negative on every other component's objects.
    FOREACH required_name IN ARRAY ARRAY[
        'fact.full_sku_sales_snapshot',
        'fact.full_home_finance_daily',
        'fact.full_home_product_finance_daily',
        'fact.full_home_finance_detail_observation',
        'fact.full_home_finance_report_observation',
        'fact.full_home_finance_adjustment_observation',
        'fact.full_home_bill_daily',
        'fact.inventory_snapshot',
        'fact.purchase_order',
        'fact.delivery',
        'fact.stock_advice_snapshot',
        'mart.full_store_sales_latest',
        'mart.full_product_sales_latest',
        'raw.openapi_fetch_batch',
        'raw.openapi_fetch_page',
        'raw.webhook_receipt',
        'ops.webhook_job',
        'ops.operational_event',
        'ops.sales_business_watermark',
        'ops.employee_principal',
        'ops.employee_store_assignment',
        'ops.backfill_run',
        'ops.backfill_window',
        'ops.backfill_checkpoint',
        'dim.canonical_product',
        'dim.full_sku_canonical_assignment'
    ]
    LOOP
        FOREACH privilege_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']
        LOOP
            IF has_table_privilege('sheinfm_webapi_loader', required_name, privilege_name) THEN
                RAISE EXCEPTION
                    'WebAPI experiment loader must not hold % on %',
                    privilege_name, required_name;
            END IF;
        END LOOP;
    END LOOP;
    IF has_column_privilege('sheinfm_webapi_loader', 'dim.store', 'store_code', 'SELECT') THEN
        RAISE EXCEPTION 'WebAPI experiment loader must not read the store dimension';
    END IF;

    -- Existing component roles must not gain WebAPI write access.
    FOREACH required_name IN ARRAY ARRAY[
        'raw.webapi_fetch_batch',
        'raw.webapi_metric_observation',
        'ops.webapi_session_health',
        'dim.webapi_metric_definition',
        'raw.webapi_home_fetch_audit',
        'fact.full_home_store_daily',
        'fact.full_home_region_daily',
        'fact.full_home_product_daily',
        'fact.full_home_ledger_daily'
    ]
    LOOP
        FOREACH principal_check IN ARRAY ARRAY[
            'sheinfm_sales_loader',
            'sheinfm_supply_loader',
            'sheinfm_webhook_ingress',
            'sheinfm_webhook_worker',
            'sheinfm_app'
        ]
        LOOP
            FOREACH privilege_name IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']
            LOOP
                IF has_table_privilege(principal_check, required_name, privilege_name) THEN
                    RAISE EXCEPTION
                        'runtime principal % gained % on WebAPI relation %',
                        principal_check, privilege_name, required_name;
                END IF;
            END LOOP;
        END LOOP;
    END LOOP;

    -- Backfill control plane: only the two verified domain loaders may write it,
    -- and the append-only ledgers must not be deletable.
    FOREACH principal_check IN ARRAY ARRAY['sheinfm_sales_login', 'sheinfm_supply_login']
    LOOP
        IF NOT has_table_privilege(principal_check, 'ops.backfill_run', 'INSERT')
           OR NOT has_table_privilege(principal_check, 'ops.backfill_window', 'INSERT')
           OR NOT has_table_privilege(principal_check, 'ops.backfill_checkpoint', 'UPDATE')
           OR has_table_privilege(principal_check, 'ops.backfill_run', 'DELETE')
           OR has_table_privilege(principal_check, 'ops.backfill_window', 'DELETE')
           OR has_table_privilege(principal_check, 'ops.backfill_checkpoint', 'DELETE') THEN
            RAISE EXCEPTION 'backfill control-plane boundary is invalid for %',
                principal_check;
        END IF;
    END LOOP;
    IF has_column_privilege(
        'sheinfm_sales_login', 'ops.backfill_window', 'window_key', 'UPDATE'
    ) OR has_column_privilege(
        'sheinfm_supply_login', 'ops.backfill_window', 'store_code', 'UPDATE'
    ) THEN
        RAISE EXCEPTION 'backfill window identity columns must remain immutable';
    END IF;

    FOR relation_row IN
        SELECT class.oid
        FROM pg_class AS class
        JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = ANY (ARRAY['raw', 'dim', 'fact', 'mart', 'ops'])
          AND class.relkind IN ('r', 'p', 'v', 'm')
    LOOP
        FOREACH privilege_name IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']
        LOOP
            IF has_table_privilege('sheinfm_app', relation_row.oid, privilege_name) THEN
                RAISE EXCEPTION 'legacy sheinfm_app retained % on relation oid %',
                    privilege_name, relation_row.oid;
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

COMMIT;
