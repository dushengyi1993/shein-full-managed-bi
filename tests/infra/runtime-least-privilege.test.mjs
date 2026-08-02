import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), 'utf8');
}

function unitUser(unit) {
  return unit.match(/^User=(.+)$/m)?.[1] ?? null;
}

test('portal serves only the promoted dashboard JSON and has no warehouse or OpenAPI environment', async () => {
  const portal = await text('infra/systemd/shein-fm-portal.service');
  assert.equal(unitUser(portal), 'sheinfm-portal');
  assert.match(portal, /SupplementaryGroups=sheinfm-dashboard/);
  assert.match(
    portal,
    /FULL_BI_DATA_FILE=\/srv\/shein-fm\/runtime\/dashboard\/dashboard\.json/,
  );
  assert.match(portal, /ConditionPathExists=\/srv\/shein-fm\/runtime\/portal\.enabled/);
  assert.match(portal, /ReadOnlyPaths=.*dashboard\.json/);
  assert.doesNotMatch(portal, /DATABASE_URL|database\.env|warehouse\.env/i);
  assert.doesNotMatch(portal, /OPENAPI|openapi\.json/i);
  assert.doesNotMatch(portal, /materialize_full_managed_dashboard|ExecStartPre/);
  assert.doesNotMatch(portal, /ReadWritePaths/);
  assert.doesNotMatch(portal, /shein-fm-db(?:-migrate)?\.service/);
});

test('materializer is a separate gated read-only runtime with atomic promotion', async () => {
  const service = await text(
    'infra/systemd/shein-fm-dashboard-materialize.service',
  );
  const timer = await text(
    'infra/systemd/shein-fm-dashboard-materialize.timer',
  );
  assert.equal(unitUser(service), 'sheinfm-materializer');
  assert.match(service, /SupplementaryGroups=sheinfm-dashboard/);
  assert.match(service, /secrets\/materializer\/database\.env/);
  assert.match(service, /dashboard\/dashboard\.next\.json/);
  assert.match(service, /chgrp sheinfm-dashboard/);
  assert.match(service, /chmod 0640/);
  assert.match(
    service,
    /mv -f .*dashboard\.next\.json .*dashboard\.json/,
  );
  assert.match(
    service,
    /ConditionPathExists=\/srv\/shein-fm\/runtime\/materializer\.enabled/,
  );
  assert.doesNotMatch(
    service,
    /FULL_BI_OPENAPI_CONFIG|openapi\.json|warehouse\.env/i,
  );
  assert.match(timer, /OnUnitInactiveSec=5m/);
  assert.match(
    timer,
    /ConditionPathExists=\/srv\/shein-fm\/runtime\/materializer\.enabled/,
  );
});

test('sales, supply, ingress and worker use distinct users and private credentials', async () => {
  const units = {
    portal: await text('infra/systemd/shein-fm-portal.service'),
    materializer: await text(
      'infra/systemd/shein-fm-dashboard-materialize.service',
    ),
    sales: await text('infra/systemd/shein-fm-sales-sync.service'),
    supply: await text('infra/systemd/shein-fm-supply-sync.service'),
    ingress: await text('infra/systemd/shein-fm-webhook-receiver.service'),
    worker: await text('infra/systemd/shein-fm-webhook-worker.service'),
  };
  const users = Object.values(units).map(unitUser);
  assert.deepEqual(users, [
    'sheinfm-portal',
    'sheinfm-materializer',
    'sheinfm-sales',
    'sheinfm-supply',
    'sheinfm-webhook-ingress',
    'sheinfm-webhook-worker',
  ]);
  assert.equal(new Set(users).size, users.length);

  assert.match(units.sales, /secrets\/sales\/database\.env/);
  assert.match(units.sales, /secrets\/sales\/openapi\.json/);
  assert.match(units.supply, /secrets\/supply\/database\.env/);
  assert.match(units.supply, /secrets\/supply\/openapi\.json/);
  assert.match(units.ingress, /secrets\/webhook-ingress\/database\.env/);
  assert.match(
    units.ingress,
    /secrets\/webhook-ingress\/application\.secret\.json/,
  );
  assert.match(units.worker, /secrets\/webhook-worker\/database\.env/);
  assert.match(
    units.worker,
    /secrets\/webhook-worker\/application\.secret\.json/,
  );
  for (const [name, unit] of Object.entries(units)) {
    assert.doesNotMatch(unit, /secrets\/warehouse\.env/, `${name} shares warehouse.env`);
    assert.doesNotMatch(
      unit,
      /secrets\/openapi\.json/,
      `${name} shares a root OpenAPI credential`,
    );
  }
});

test('domain sync units never materialize and trigger the independent projection after success', async () => {
  for (const path of [
    'infra/systemd/shein-fm-sales-sync.service',
    'infra/systemd/shein-fm-supply-sync.service',
  ]) {
    const unit = await text(path);
    assert.doesNotMatch(unit, /FULL_BI_DATA_FILE/);
    assert.doesNotMatch(unit, /materialize_full_managed_dashboard/);
    assert.match(unit, /OnSuccess=shein-fm-dashboard-materialize\.service/);
  }
});

test('profile cache pruning can write only its runtime lock and guarded Profile root', async () => {
  const service = await text(
    'infra/systemd/shein-fm-profile-cache-prune.service',
  );
  assert.equal(unitUser(service), 'root');
  assert.match(
    service,
    /^ReadWritePaths=\/srv\/shein-fm\/runtime \/srv\/shein-fm\/webapi\/profiles$/m,
  );
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /ProtectHome=true/);
  assert.doesNotMatch(service, /ReadWritePaths=.*(?:backups|releases|secrets)/);
});

test('all mutable application runtimes and timers are fail-closed behind explicit gates', async () => {
  const expectations = new Map([
    ['infra/systemd/shein-fm-authorization.service', 'authorization.enabled'],
    ['infra/systemd/shein-fm-portal.service', 'portal.enabled'],
    ['infra/systemd/shein-fm-dashboard-materialize.service', 'materializer.enabled'],
    ['infra/systemd/shein-fm-dashboard-materialize.timer', 'materializer.enabled'],
    ['infra/systemd/shein-fm-sales-sync.service', 'sales-sync.enabled'],
    ['infra/systemd/shein-fm-sales-sync.timer', 'sales-sync.enabled'],
    ['infra/systemd/shein-fm-supply-sync.service', 'supply-sync.enabled'],
    ['infra/systemd/shein-fm-supply-sync.timer', 'supply-sync.enabled'],
    ['infra/systemd/shein-fm-webhook-receiver.service', 'webhook-ingress.enabled'],
    ['infra/systemd/shein-fm-webhook-worker.service', 'webhook-worker.enabled'],
  ]);
  for (const [path, gate] of expectations) {
    assert.match(
      await text(path),
      new RegExp(`ConditionPathExists=.*${gate.replace('.', '\\.')}`),
      `${path} is not fail-closed`,
    );
  }
});

test('9999 preflight tracks every runtime table and project function through 0011', async () => {
  const reconcile = await text('db/migrations/9999_runtime_role_reconcile.sql');
  const migrations = await Promise.all(
    ['0001_full_managed_bi.sql', '0002_runtime_role.sql', '0003_sales_trust.sql',
      '0004_product_identity_and_access.sql', '0005_webhook_runtime.sql',
      '0006_supply_domains.sql', '0010_product_identity_observation_sets.sql',
      '0011_product_identity_resolution.sql',
      '0012_backfill_and_webapi_experiment.sql']
      .map((name) => text(`db/migrations/${name}`)),
  );
  const allSql = migrations.join('\n');
  const tables = [
    ...allSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+\.[a-z_]+)/g),
  ].map((match) => match[1]);
  assert.ok(tables.length > 30);
  for (const table of new Set(tables)) {
    assert.match(
      reconcile,
      new RegExp(`'${table.replace('.', '\\.')}'`),
      `9999 preflight omits ${table}`,
    );
  }
  const functions = [
    ...allSql.matchAll(/CREATE OR REPLACE FUNCTION\s+([a-z_]+\.[a-z_]+)/g),
  ].map((match) => match[1]);
  for (const functionName of new Set(functions)) {
    assert.match(
      reconcile,
      new RegExp(`'${functionName.replace('.', '\\.')}`),
      `9999 preflight omits ${functionName}`,
    );
  }
  assert.match(reconcile, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES/);
  assert.match(reconcile, /class\.relkind = 'S'/);
  assert.match(reconcile, /ALTER DEFAULT PRIVILEGES[\s\S]*ON TABLES FROM PUBLIC/);
  assert.match(reconcile, /ALTER DEFAULT PRIVILEGES[\s\S]*ON SEQUENCES FROM PUBLIC/);
  assert.match(reconcile, /ALTER DEFAULT PRIVILEGES[\s\S]*ON FUNCTIONS FROM PUBLIC/);
});

test('9999 grants one group per login and proves cross-domain negative privileges', async () => {
  const migration = await text('db/migrations/9999_runtime_role_reconcile.sql');
  const verify = await text('db/verify/9999_runtime_role_reconcile.sql');
  const materializerGrant = migration.match(
    /GRANT SELECT ON[\s\S]*?TO sheinfm_materializer_ro, sheinfm_app;/,
  )?.[0] || '';
  for (const pair of [
    ['sheinfm_materializer_ro', 'sheinfm_materializer_login'],
    ['sheinfm_sales_loader', 'sheinfm_sales_login'],
    ['sheinfm_supply_loader', 'sheinfm_supply_login'],
    ['sheinfm_webhook_ingress', 'sheinfm_webhook_ingress_login'],
    ['sheinfm_webhook_worker', 'sheinfm_webhook_worker_login'],
  ]) {
    assert.match(migration, new RegExp(`GRANT ${pair[0]} TO ${pair[1]}`));
  }
  assert.match(migration, /GRANT SELECT, INSERT ON ops\.permission_probe/);
  assert.match(migration, /GRANT SELECT, INSERT ON ops\.sales_quality_event/);
  assert.match(
    migration,
    /GRANT SELECT ON[\s\S]*ops\.sales_quality_event,[\s\S]*TO sheinfm_materializer_ro, sheinfm_app/,
  );
  assert.match(materializerGrant, /fact\.purchase_order_line/);
  assert.match(
    verify,
    /'fact\.purchase_order',[\s\S]*'fact\.purchase_order_line',[\s\S]*'fact\.delivery'/,
  );
  assert.match(migration, /GRANT SELECT ON ops\.sales_sync_run\s+TO sheinfm_supply_loader/);
  assert.match(
    migration,
    /GRANT SELECT, INSERT ON[\s\S]*raw\.product_identity_observation_set,[\s\S]*raw\.identifier_observation,[\s\S]*TO sheinfm_supply_loader/,
  );
  assert.match(
    migration,
    /GRANT UPDATE \(status, member_count, sealed_at\)\s+ON raw\.product_identity_observation_set\s+TO sheinfm_supply_loader/,
  );
  assert.match(migration, /fact\.supply_projection_member/);
  assert.match(migration, /ops\.webhook_runtime_heartbeat/);
  assert.match(migration, /store_id, store_code, is_active/);
  assert.match(verify, /^BEGIN;[\s\S]*ROLLBACK;\s*$/);
  assert.match(verify, /sales loader privilege boundary is invalid/);
  assert.match(verify, /supply loader domain boundary is invalid/);
  assert.match(verify, /webhook ingress receipt\/job boundary is invalid/);
  assert.match(verify, /webhook worker privilege boundary is invalid/);
  assert.match(verify, /materializer retained % on %/);
  assert.match(verify, /unsafe warehouse default privilege remains/);
  assert.match(verify, /ciphertext/);
});

test('the materializer reads identity pipeline aggregates but never raw identity evidence', async () => {
  const migration = await text('db/migrations/9999_runtime_role_reconcile.sql');
  const verify = await text('db/verify/9999_runtime_role_reconcile.sql');
  const materializer = await text('src/warehouse/dashboard-materializer.mjs');
  const materializerGrant = migration.match(
    /GRANT SELECT ON[\s\S]*?TO sheinfm_materializer_ro, sheinfm_app;/,
  )?.[0] || '';
  assert.notEqual(materializerGrant, '');
  // Only granted relations count: a comment naming a denied relation must not
  // satisfy an allow assertion, nor break a deny assertion.
  const grantedRelations = materializerGrant
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  // The four relations the aggregate query actually reads, plus the two that
  // were already granted. Without these the schema probe reports the pipeline
  // unavailable, because information_schema.columns hides unreadable columns.
  for (const relation of [
    'raw\\.product_identity_observation_set',
    'ops\\.product_match_candidate',
    'ops\\.product_identity_decision',
    'dim\\.canonical_variant',
    'dim\\.canonical_product',
    'dim\\.full_sku_canonical_assignment',
  ]) {
    assert.match(grantedRelations, new RegExp(`\\s${relation},`), relation);
    assert.match(verify, new RegExp(`'${relation}',`), relation);
  }

  // Raw identifier rows and per-relation candidate evidence stay unreadable:
  // the dashboard projects counts only.
  for (const denied of [
    'raw\\.identifier_observation',
    'ops\\.product_match_candidate_evidence',
  ]) {
    assert.doesNotMatch(grantedRelations, new RegExp(`\\s${denied},`), denied);
    assert.doesNotMatch(grantedRelations, new RegExp(`\\s${denied}\\s*$`), denied);
  }
  assert.match(
    verify,
    /FOREACH required_name IN ARRAY ARRAY\[\s*'raw\.identifier_observation',\s*'ops\.product_match_candidate_evidence'\s*\][\s\S]*?materializer must not read raw identity evidence/,
  );
  assert.match(
    verify,
    /IF has_table_privilege\(\s*'sheinfm_materializer_login',\s*required_name,\s*'SELECT'\s*\) THEN\s*RAISE EXCEPTION 'materializer must not read raw identity evidence %'/,
  );

  // The grant is SELECT only: no mutation, sequence or function capability.
  assert.doesNotMatch(materializerGrant, /INSERT|UPDATE|DELETE|TRUNCATE/);
  assert.doesNotMatch(
    migration,
    /GRANT[^;]*ON SEQUENCE[^;]*TO[^;]*sheinfm_materializer_ro/,
  );
  assert.doesNotMatch(
    migration,
    /GRANT EXECUTE[^;]*TO[^;]*sheinfm_materializer_ro/,
  );

  // The readiness probe must not depend on an ungranted relation. Only real
  // code counts, so explanatory comments are stripped first.
  const pipelineStart = materializer.indexOf(
    'export async function readProductIdentityPipeline',
  );
  assert.notEqual(pipelineStart, -1);
  const pipelineEnd = materializer.indexOf(
    '\nexport async function readDashboardProjectionInput',
    pipelineStart,
  );
  assert.notEqual(pipelineEnd, -1);
  const probe = materializer
    .slice(pipelineStart, pipelineEnd)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
  const schemaProbe = probe.slice(0, probe.indexOf('const schema ='));

  assert.match(schemaProbe, /to_regclass\('raw\.product_identity_observation_set'\)/);
  assert.match(schemaProbe, /to_regclass\('ops\.product_match_candidate'\)/);
  assert.match(schemaProbe, /to_regclass\('ops\.product_identity_decision'\)/);
  assert.match(schemaProbe, /to_regclass\('dim\.full_sku_canonical_assignment'\)/);
  assert.match(schemaProbe, /to_regclass\('dim\.canonical_product'\)/);
  assert.match(schemaProbe, /to_regclass\('dim\.canonical_variant'\)/);
  assert.doesNotMatch(probe, /has_identifier_observation/);
  // The aggregate itself never touches raw identifier or candidate evidence.
  assert.doesNotMatch(probe, /raw\.identifier_observation/);
  assert.doesNotMatch(probe, /product_match_candidate_evidence/);
});

test('9999 preserves only append permissions needed by the identity evidence and resolution pipeline', async () => {
  const migration = await text('db/migrations/9999_runtime_role_reconcile.sql');
  const verify = await text('db/verify/9999_runtime_role_reconcile.sql');
  const evidenceCountFunction =
    'ops.distinct_identity_evidence_count(text[])';

  for (const relation of [
    'raw.product_identity_observation_set',
    'raw.identifier_observation',
    'ops.canonical_product_observation_set',
    'ops.product_match_candidate_evidence',
  ]) {
    assert.match(
      migration,
      new RegExp(`'${relation.replace('.', '\\.')}'`),
      `9999 preflight omits ${relation}`,
    );
  }
  for (const functionName of [
    'ops.guard_product_identity_observation_set_mutation()',
    'ops.require_building_product_identity_observation_set()',
    'ops.verify_product_identity_observation_set_sealed()',
  ]) {
    assert.ok(
      migration.includes(`'${functionName}'`),
      `9999 preflight omits ${functionName}`,
    );
    assert.ok(
      verify.includes(`'${functionName}'`),
      `9999 verification omits ${functionName}`,
    );
  }
  assert.match(
    migration,
    /\('sheinfm_supply_loader', 'raw\.product_identity_observation_set', 'identity_observation_set_id'\)/,
  );
  assert.match(
    migration,
    /\('sheinfm_supply_loader', 'raw\.identifier_observation', 'identifier_observation_id'\)/,
  );
  for (const [relation, sequenceColumn] of [
    ['dim.canonical_product', 'canonical_product_id'],
    [
      'ops.canonical_product_observation_set',
      'canonical_product_observation_set_id',
    ],
    ['ops.product_match_candidate', 'product_match_candidate_id'],
    [
      'ops.product_match_candidate_evidence',
      'product_match_candidate_evidence_id',
    ],
    ['ops.product_identity_decision', 'product_identity_decision_id'],
    [
      'dim.full_sku_canonical_assignment',
      'full_sku_canonical_assignment_id',
    ],
  ]) {
    assert.match(
      migration,
      new RegExp(
        `\\('sheinfm_supply_loader', '${relation.replace('.', '\\.')}', '${sequenceColumn}'\\)`,
      ),
    );
    assert.match(
      verify,
      new RegExp(
        `\\('sheinfm_supply_login', '${relation.replace('.', '\\.')}', '${sequenceColumn}'\\)`,
      ),
    );
  }
  const resolutionGrant = migration.match(
    /GRANT SELECT, INSERT ON\s+dim\.canonical_product,[\s\S]*?dim\.full_sku_canonical_assignment\s+TO sheinfm_supply_loader/,
  )?.[0] ?? '';
  assert.notEqual(resolutionGrant, '');
  assert.doesNotMatch(resolutionGrant, /\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/);
  assert.match(
    verify,
    /supply product identity resolution boundary is invalid for %/,
  );
  assert.match(
    verify,
    /supply identity observation-set table boundary is invalid/,
  );
  assert.match(
    verify,
    /supply identity observation-set immutable column % is updatable/,
  );
  assert.match(verify, /supply identifier-observation boundary is invalid/);
  assert.match(
    verify,
    /\('sheinfm_supply_login', 'raw\.product_identity_observation_set', 'identity_observation_set_id'\)/,
  );
  assert.match(
    verify,
    /\('sheinfm_supply_login', 'raw\.identifier_observation', 'identifier_observation_id'\)/,
  );
  assert.doesNotMatch(
    migration,
    /GRANT SELECT, INSERT, UPDATE ON\s+raw\.product_identity_observation_set/,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION ops\.distinct_identity_evidence_count\(text\[\]\)\s+TO sheinfm_supply_loader;/,
  );
  const runtimeFunctionGrants = [
    ...migration.matchAll(
      /GRANT EXECUTE ON FUNCTION\s+([a-z_]+\.[a-z_]+\([^;]+\))\s+TO\s+([^;]+);/g,
    ),
  ].map((match) => ({
    functionName: match[1].replace(/\s+/g, ' '),
    grantee: match[2].trim(),
  }));
  assert.deepEqual(runtimeFunctionGrants, [{
    functionName: evidenceCountFunction,
    grantee: 'sheinfm_supply_loader',
  }]);
  assert.match(
    verify,
    /'sheinfm_supply_loader',\s*'ops\.distinct_identity_evidence_count\(text\[\]\)',\s*'EXECUTE'/,
  );
  assert.match(
    verify,
    /'sheinfm_supply_login',\s*'ops\.distinct_identity_evidence_count\(text\[\]\)',\s*'EXECUTE'/,
  );
  assert.match(
    verify,
    /runtime principal % can execute supply-only function %/,
  );
  assert.match(
    verify,
    /identity evidence count function is not immutable SQL invoker code/,
  );
  assert.match(
    verify,
    /supply runtime can execute another warehouse project function/,
  );
  for (const functionName of [
    'ops.touch_updated_at()',
    'ops.reject_append_only_identity_mutation()',
    'ops.guard_product_identity_observation_set_mutation()',
    'ops.require_building_product_identity_observation_set()',
    'ops.verify_product_identity_observation_set_sealed()',
    'ops.guard_webhook_receipt_immutable()',
    'ops.reject_webhook_runtime_heartbeat_mutation()',
    'ops.guard_webhook_store_gate_recovery()',
    'ops.reopen_webhook_authorization_gate_after_probe(text,bigint)',
    'ops.reject_supply_append_only_mutation()',
  ]) {
    assert.ok(
      verify.includes(`'${functionName}'`),
      `9999 verification omits negative EXECUTE check for ${functionName}`,
    );
  }
});

test('the isolated WebAPI experiment role is least-privilege in 9999 and verify', async () => {
  const migration = await text('db/migrations/9999_runtime_role_reconcile.sql');
  const verify = await text('db/verify/9999_runtime_role_reconcile.sql');

  // NOLOGIN capability group plus a NOINHERIT login that must SET ROLE.
  assert.match(
    migration,
    /CREATE ROLE sheinfm_webapi_loader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/,
  );
  assert.match(
    migration,
    /CREATE ROLE sheinfm_webapi_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/,
  );
  assert.match(migration, /GRANT sheinfm_webapi_loader TO sheinfm_webapi_login/);
  assert.match(migration, /SHEIN_FM_WEBAPI_LOGIN_DB_PASSWORD/);
  assert.match(migration, /sheinfm_webapi_login must be NOINHERIT/);
  assert.match(verify, /sheinfm_webapi_login is not a safe NOINHERIT login/);

  // Positive: its isolated evidence layer, reviewed definitions and the three
  // bounded homepage facts.
  const evidenceGrant = migration.match(
    /GRANT SELECT, INSERT ON\s+raw\.webapi_fetch_batch,[\s\S]*?TO sheinfm_webapi_loader;/,
  )?.[0] ?? '';
  assert.notEqual(evidenceGrant, '');
  assert.match(evidenceGrant, /raw\.webapi_metric_observation/);
  assert.match(evidenceGrant, /ops\.webapi_session_health/);
  assert.doesNotMatch(evidenceGrant, /\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/);
  assert.match(
    migration,
    /GRANT SELECT ON dim\.webapi_metric_definition\s+TO sheinfm_webapi_loader;/,
  );
  assert.match(migration, /GRANT USAGE ON SCHEMA raw, dim, fact, ops\s+TO sheinfm_webapi_loader;/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON\s+fact\.full_home_store_daily,[\s\S]*?fact\.full_home_product_daily\s+TO sheinfm_webapi_loader;/);

  // Negative: no unrelated facts, mart, OpenAPI, webhook, employee or backfill access.
  for (const boundary of [
    'WebAPI experiment evidence boundary is invalid for %',
    'WebAPI metric definition must stay human-reviewed and read-only',
    'WebAPI experiment loader must not hold % on %',
    'WebAPI experiment loader must not read the store dimension',
    'runtime principal % gained % on WebAPI relation %',
  ]) {
    assert.ok(migration.includes(boundary), `9999 omits: ${boundary}`);
  }
  for (const boundary of [
    'WebAPI experiment loader retained % on %',
    'WebAPI loader must reach only bounded fact relations, never mart',
    'runtime principal % gained % on WebAPI relation %',
  ]) {
    assert.ok(verify.includes(boundary), `verify omits: ${boundary}`);
  }
  assert.match(verify, /'sheinfm_webapi_loader', 'raw\.webapi_fetch_batch', 'webapi_fetch_batch_id'/);

  // The experiment role must never be given backfill control-plane write access.
  const backfillGrant = migration.match(
    /GRANT SELECT, INSERT ON ops\.backfill_run, ops\.backfill_window\s+TO ([^;]+);/,
  )?.[1] ?? '';
  assert.equal(backfillGrant.trim(), 'sheinfm_sales_loader, sheinfm_supply_loader');
  assert.match(verify, /backfill control-plane boundary is invalid for %/);
  assert.match(verify, /backfill window identity column % is updatable by %/);
  assert.match(verify, /materializer backfill projection must stay read-only/);
  assert.match(verify, /webhook runtimes must not touch the backfill control plane/);
});

test('the WebAPI experiment migration secret is a separate root-private value', async () => {
  const manifest = await text(
    'infra/systemd/shein-fm-db-migrate-secrets.env.example',
  );
  const runner = await text('scripts/migrate_full_managed_db.sh');
  assert.match(manifest, /^SHEIN_FM_WEBAPI_LOGIN_DB_PASSWORD=$/m);
  assert.match(manifest, /sixth independent secret/);
  assert.match(manifest, /never be shared with a sales, supply, webhook or materializer role/);
  assert.match(runner, /\bSHEIN_FM_WEBAPI_LOGIN_DB_PASSWORD\b/);
  // Values still travel by name only, never in docker argv.
  assert.match(runner, /docker_secret_env_args\+=\(--env "\$secret_name"\)/);
});

test('migration passwords come from one root-private manifest and values never enter docker argv', async () => {
  const service = await text('infra/systemd/shein-fm-db-migrate.service');
  const runner = await text('scripts/migrate_full_managed_db.sh');
  const manifest = await text(
    'infra/systemd/shein-fm-db-migrate-secrets.env.example',
  );
  const secretPath = '/srv/shein-fm/secrets/db-migrate/runtime-role-passwords.env';
  assert.match(
    service,
    new RegExp(`EnvironmentFile=${secretPath.replaceAll('/', '\\/')}`),
  );
  assert.match(
    service,
    new RegExp(`ReadOnlyPaths=${secretPath.replaceAll('/', '\\/')}`),
  );
  assert.match(manifest, /root:root 0600/);
  const names = [
    'SHEIN_FM_APP_DB_PASSWORD',
    'SHEIN_FM_MATERIALIZER_DB_PASSWORD',
    'SHEIN_FM_SALES_DB_PASSWORD',
    'SHEIN_FM_SUPPLY_DB_PASSWORD',
    'SHEIN_FM_WEBHOOK_INGRESS_DB_PASSWORD',
    'SHEIN_FM_WEBHOOK_WORKER_DB_PASSWORD',
    'SHEIN_FM_WEBAPI_LOGIN_DB_PASSWORD',
  ];
  for (const name of names) {
    assert.match(manifest, new RegExp(`^${name}=$`, 'm'));
    assert.match(runner, new RegExp(`\\b${name}\\b`));
  }
  assert.match(runner, /docker_secret_env_args\+=\(--env "\$secret_name"\)/);
  assert.match(
    runner,
    /docker exec -i "\$\{docker_secret_env_args\[@\]\}" "\$container_name"/,
  );
  assert.doesNotMatch(runner, /--env\s+["']?\$\{?!secret_name\}[^"'=\s]*=/);
  assert.doesNotMatch(runner, /set -x|printf[^\n]*secret_value|echo[^\n]*PASSWORD/);
  assert.match(
    manifest,
    /SHEIN_FM_APP_DB_PASSWORD must be the exact current production value/,
  );
  assert.match(manifest, /Generate six new, mutually[\s\S]*independent/);
  assert.doesNotMatch(manifest, /Generate seven independent/i);
});
