import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, projectRoot), 'utf8');
}

/** Slice one function declaration out of the repository module. */
function functionBody(source, functionName) {
  const start = source.indexOf(`async function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const nextFunction = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, nextFunction === -1 ? source.length : nextFunction);
}

/**
 * Contract tests for the reconciliation current-state fix and the bounded
 * history governance added by migration 0013.
 *
 * These are source and SQL contract assertions. They cannot execute PostgreSQL,
 * so migration behaviour is proven structurally here and must still be verified
 * against a real database by db/verify/0013 during the maintenance window.
 */

test('the reconciliation key is stable and excludes the observation time', async () => {
  const repository = await read('src/warehouse/supply-repository.mjs');
  const body = functionBody(repository, 'insertReconciliation');

  // The key input carries only the grain: domain, SKU, inventory type, metric.
  const keyInput = body.slice(body.indexOf('const keyInput = {'), body.indexOf('const key ='));
  assert.match(keyInput, /domain: 'INVENTORY'/);
  assert.match(keyInput, /skuCode,/);
  assert.match(keyInput, /inventoryType,/);
  assert.match(keyInput, /metric: check\.metric,/);
  // This is the whole bug: a time in the key made every sync mint a new row.
  assert.doesNotMatch(keyInput, /sourceFetchedAt/);
  assert.match(body, /const key = payloadFingerprint\(keyInput\)/);

  // Provenance is preserved: the fingerprint still varies with the observation.
  assert.match(
    body,
    /const fingerprint = payloadFingerprint\(\{ \.\.\.keyInput, sourceFetchedAt, \.\.\.check \}\)/,
  );
});

test('the current-state upsert conflicts on the stable grain', async () => {
  const repository = await read('src/warehouse/supply-repository.mjs');
  const body = functionBody(repository, 'insertReconciliation');

  // Conflicting on reconciliation_key would miss rows that survived compaction
  // with a legacy time-derived key and then violate the new grain constraint.
  assert.match(
    body,
    /ON CONFLICT \(store_id, domain_code, entity_key, metric_code\) DO UPDATE SET/,
  );
  assert.doesNotMatch(body, /ON CONFLICT \(store_id, reconciliation_key\)/);
  // Surviving legacy rows migrate to the stable key on first resync.
  assert.match(body, /reconciliation_key = EXCLUDED\.reconciliation_key/);
  // Newer-source guard is retained so a late replay cannot regress state.
  assert.match(
    body,
    /WHERE EXCLUDED\.source_fetched_at >= ops\.reconciliation_result\.source_fetched_at/,
  );
});

test('each sync upserts one bounded daily detail row per grain', async () => {
  const repository = await read('src/warehouse/supply-repository.mjs');
  const body = functionBody(repository, 'insertReconciliation');

  assert.match(body, /INSERT INTO ops\.reconciliation_daily_detail/);
  // observed_on is derived in UTC, matching the partition boundaries.
  assert.match(body, /\(\$2::timestamptz AT TIME ZONE 'UTC'\)::date/);
  // One row per grain per day, not one row per sync.
  assert.match(
    body,
    /ON CONFLICT \(observed_on, store_id, domain_code, entity_key, metric_code\)/,
  );
  assert.match(
    body,
    /WHERE EXCLUDED\.source_fetched_at\s*>= ops\.reconciliation_daily_detail\.source_fetched_at/,
  );
});

test('migration 0013 compacts by rebuild and swap rather than a large delete', async () => {
  const migration = await read('db/migrations/0013_reconciliation_history_governance.sql');

  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);

  // A DELETE of ~2.9M rows would leave the heap allocated and still need an
  // exclusive VACUUM FULL, so the table is rebuilt and the bloated heap dropped.
  assert.match(migration, /CREATE TABLE ops\.reconciliation_result_compact/);
  assert.match(migration, /DROP TABLE ops\.reconciliation_result;/);
  assert.match(migration, /RENAME TO reconciliation_result/);
  assert.doesNotMatch(migration, /DELETE FROM ops\.reconciliation_result/);

  // Only the newest observation per stable grain survives.
  assert.match(
    migration,
    /SELECT DISTINCT ON \(store_id, domain_code, entity_key, metric_code\) \*/,
  );
  assert.match(
    migration,
    /ORDER BY store_id, domain_code, entity_key, metric_code,\s*\n\s*source_fetched_at DESC, reconciliation_result_id DESC/,
  );

  // The full contract is restored: identity, primary key, both uniques, both
  // outbound foreign keys, the attention index and the updated_at trigger.
  assert.match(migration, /ADD GENERATED ALWAYS AS IDENTITY/);
  assert.match(migration, /ADD CONSTRAINT pk_ops_reconciliation_result/);
  assert.match(migration, /ADD CONSTRAINT uq_ops_reconciliation_result_grain/);
  assert.match(migration, /ADD CONSTRAINT uq_ops_reconciliation_result_store_key/);
  assert.match(migration, /REFERENCES dim\.store \(store_id\) ON DELETE RESTRICT/);
  assert.match(migration, /REFERENCES raw\.openapi_fetch_batch \(fetch_batch_id\)/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS ix_ops_reconciliation_result_attention/);
  assert.match(migration, /CREATE TRIGGER trg_ops_reconciliation_result_touch_updated_at/);
});

test('migration 0013 is rerunnable because the runner replays every migration', async () => {
  const migration = await read('db/migrations/0013_reconciliation_history_governance.sql');

  // Every create is guarded, and the compaction only runs when duplicate grains
  // still exist, so a second replay is a no-op rather than a second rebuild.
  assert.match(migration, /IF duplicate_grains = 0 THEN/);
  assert.match(migration, /already compact/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ops\.reconciliation_daily_detail/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ops\.reconciliation_daily_summary/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ops\.reconciliation_anomaly/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION ops\.ensure_reconciliation_partitions/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION ops\.refresh_reconciliation_daily/);
  // Constraint additions are all existence guarded.
  const unguarded = migration.match(/ADD CONSTRAINT/g) ?? [];
  const guards = migration.match(/IF NOT EXISTS \(\s*\n\s*SELECT 1 FROM pg_constraint/g) ?? [];
  assert.ok(guards.length >= unguarded.length - 1, 'constraint additions must be guarded');
});

test('daily detail is partitioned with a fail-closed forward window', async () => {
  const migration = await read('db/migrations/0013_reconciliation_history_governance.sql');

  assert.match(migration, /\) PARTITION BY RANGE \(observed_on\)/);
  // One row per grain per day is enforced by the primary key.
  assert.match(
    migration,
    /PRIMARY KEY \(observed_on, store_id, domain_code, entity_key, metric_code\)/,
  );
  // At least 90 days are pre-created so a missed maintenance run cannot stall
  // writes; the migration asks for a wider 120-day window.
  // 14 days behind, so the retained window can be seeded from the existing
  // table before it is dropped.
  assert.match(migration, /SELECT ops\.ensure_reconciliation_partitions\(120, 14\)/);
  assert.match(migration, /days_ahead < 1 OR days_ahead > 400/);
  assert.match(migration, /RAISE EXCEPTION/);

  // Long-term provenance is kept as plain columns: a partition drop must not be
  // blocked by a foreign key to a raw batch that has already aged out.
  const detail = migration.slice(
    migration.indexOf('CREATE TABLE IF NOT EXISTS ops.reconciliation_daily_detail'),
    migration.indexOf('PARTITION BY RANGE (observed_on)'),
  );
  assert.match(detail, /source_fetch_batch_id bigint,/);
  assert.match(detail, /payload_fingerprint character\(64\) NOT NULL/);
  assert.doesNotMatch(detail, /REFERENCES raw\.openapi_fetch_batch/);
});

test('every day expression is a true UTC day, not the server local date', async () => {
  const migration = await read('db/migrations/0013_reconciliation_history_governance.sql');

  /* `current_date` is the server's local date. On an Asia/Shanghai host it is
     already tomorrow for eight hours of every UTC day, so partitions would be
     created one day off and a write near the boundary would fail closed against
     a partition that was never made.

     Assert on executable SQL only: the comment explaining this defect names
     `current_date` legitimately, and matching it would be a false positive. */
  const executable = migration
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert.doesNotMatch(executable, /current_date/);
  assert.match(executable, /\(\(clock_timestamp\(\) AT TIME ZONE 'UTC'\)::date\)/);
  // The seeding window and the partition window use the same expression.
  assert.ok(
    (migration.match(/clock_timestamp\(\) AT TIME ZONE 'UTC'/g) ?? []).length >= 3,
  );
});

test('the retained detail window is seeded before the large table is dropped', async () => {
  const migration = await read('db/migrations/0013_reconciliation_history_governance.sql');

  const seedIndex = migration.indexOf('INSERT INTO ops.reconciliation_daily_detail');
  const dropIndex = migration.indexOf('DROP TABLE ops.reconciliation_result;');
  assert.notEqual(seedIndex, -1, 'the migration must seed daily detail');
  assert.notEqual(dropIndex, -1);
  // Ordering is the whole point: seeding after the drop would read nothing.
  assert.ok(seedIndex < dropIndex, 'seeding must happen before the drop');

  // One row per stable grain per UTC day, newest observation wins.
  assert.match(
    migration,
    /SELECT DISTINCT ON \(\s*\n\s*\(source\.source_fetched_at AT TIME ZONE 'UTC'\)::date,/,
  );
  assert.match(migration, /source\.source_fetched_at DESC, source\.reconciliation_result_id DESC/);
  assert.match(migration, /ON CONFLICT \(observed_on, store_id, domain_code, entity_key, metric_code\)\s*\n\s*DO NOTHING/);

  // Summary and anomaly rows are refreshed for the seeded days, so the evidence
  // outlives the later partition drops.
  const refreshIndex = migration.indexOf('PERFORM ops.refresh_reconciliation_daily(seeded_day)');
  assert.notEqual(refreshIndex, -1);
  assert.ok(refreshIndex < dropIndex, 'summaries must be refreshed before the drop');
});

test('a recovered grain does not leave a stale anomaly row behind', async () => {
  const migration = await read('db/migrations/0013_reconciliation_history_governance.sql');

  /* An upsert alone would leave a stale anomaly once a grain recovers to MATCH:
     the recovered grain no longer appears in the INSERT's source set, so its old
     row would survive forever. The day must be cleared first. */
  const deleteIndex = migration.indexOf(
    'DELETE FROM ops.reconciliation_anomaly WHERE observed_on = target_day',
  );
  const insertIndex = migration.indexOf('INSERT INTO ops.reconciliation_anomaly (');
  assert.notEqual(deleteIndex, -1, 'the refresh must clear the day first');
  assert.ok(deleteIndex < insertIndex, 'the delete must precede the insert');
});

test('the compact rebuild does not duplicate indexes and does not churn the PK', async () => {
  const migration = await read('db/migrations/0013_reconciliation_history_governance.sql');

  /* `INCLUDING INDEXES` copied the store-key unique index, and re-adding the
     constraint then produced two identical indexes on the same columns. */
  assert.doesNotMatch(migration, /INCLUDING INDEXES/);
  assert.match(migration, /INCLUDING DEFAULTS/);
  assert.match(migration, /INCLUDING CONSTRAINTS/);
  assert.match(migration, /INCLUDING COMMENTS/);

  // The PK is added only when absent. Dropping it unconditionally took an
  // ACCESS EXCLUSIVE lock and rebuilt the index on every migration replay.
  assert.doesNotMatch(migration, /DROP CONSTRAINT IF EXISTS pk_ops_reconciliation_result/);
  assert.match(migration, /ADD CONSTRAINT pk_ops_reconciliation_result/);

  // Every index the old table had must be restored explicitly.
  assert.match(migration, /CREATE INDEX IF NOT EXISTS ix_ops_reconciliation_result_attention/);
});

test('verify 0013 proves seeding, index uniqueness and the UTC day source', async () => {
  const verify = await read('db/verify/0013_reconciliation_history_governance.sql');

  // Seeded detail is required whenever eligible source rows exist.
  assert.match(verify, /eligible_current_rows/);
  assert.match(verify, /was not seeded although % current rows are in the retained window/);
  assert.match(verify, /was not refreshed for the seeded days/);
  // Exactly one (store_id, reconciliation_key) unique index, never two.
  assert.match(verify, /ARRAY\['reconciliation_key', 'store_id'\]/);
  assert.match(verify, /expected exactly one \(store_id, reconciliation_key\) unique index/);
  // The partition helper must not derive days from the server local date.
  assert.match(verify, /still derives days from current_date/);
});

test('long-term anomaly evidence cannot be fabricated', async () => {
  const migration = await read('db/migrations/0013_reconciliation_history_governance.sql');

  // MATCH and NOT_EXPOSED are normal outcomes, so a CHECK forbids them. An empty
  // anomaly table therefore truthfully means no anomaly was observed.
  assert.match(
    migration,
    /CONSTRAINT ck_ops_reconciliation_anomaly_status\s*\n\s*CHECK \(status_code NOT IN \('MATCH', 'NOT_EXPOSED'\)\)/,
  );
  // The summary is recomputable: a refresh deletes the day before reinserting.
  assert.match(
    migration,
    /DELETE FROM ops\.reconciliation_daily_summary WHERE observed_on = target_day/,
  );
  // Anomalies are upserted from real detail rows, never invented.
  assert.match(
    migration,
    /FROM ops\.reconciliation_daily_detail AS detail\s*\n\s*WHERE detail\.observed_on = target_day\s*\n\s*AND detail\.status_code NOT IN \('MATCH', 'NOT_EXPOSED'\)/,
  );
  assert.match(migration, /anomaly_count <= grain_count/);
});

test('verify 0013 proves compaction, partitioning and honest anomalies', async () => {
  const verify = await read('db/verify/0013_reconciliation_history_governance.sql');

  for (const relation of [
    'ops.reconciliation_result',
    'ops.reconciliation_daily_detail',
    'ops.reconciliation_daily_summary',
    'ops.reconciliation_anomaly',
  ]) {
    assert.ok(verify.includes(`'${relation}'`), relation);
  }
  // Duplicate current grains must be impossible after the migration.
  assert.match(verify, /still holds % duplicated current grains/);
  assert.match(verify, /uq_ops_reconciliation_result_grain/);
  // The rebuilt table must keep its full contract.
  assert.match(verify, /lost its dim\.store foreign key/);
  assert.match(verify, /lost its fetch-batch foreign key/);
  assert.match(verify, /identity is not GENERATED ALWAYS/);
  assert.match(verify, /lost its updated_at trigger/);
  assert.match(verify, /lost its attention index/);
  // A forward partition window is required, and one row per grain per day.
  assert.match(verify, /at least 90 required/);
  assert.match(verify, /duplicated day grains/);
  // No fabricated anomalies and no 1.7GB shadow table left behind.
  assert.match(verify, /holds % fabricated rows/);
  assert.match(verify, /reconciliation_result_compact was left behind/);
  assert.match(verify, /SELECT 'full-managed reconciliation history governance OK' AS result;/);
});

test('the new history tables are granted least privilege', async () => {
  const reconcile = await read('db/migrations/9999_runtime_role_reconcile.sql');

  // The supply loader upserts detail only; it never writes long-term evidence.
  assert.match(
    reconcile,
    /GRANT SELECT, INSERT, UPDATE ON ops\.reconciliation_daily_detail\s*\nTO sheinfm_supply_loader;/,
  );
  assert.doesNotMatch(
    reconcile,
    /GRANT[^;]*INSERT[^;]*ops\.reconciliation_daily_summary[^;]*TO sheinfm_supply_loader/,
  );
  assert.doesNotMatch(
    reconcile,
    /GRANT[^;]*INSERT[^;]*ops\.reconciliation_anomaly[^;]*TO sheinfm_supply_loader/,
  );
  // The read-only materializer may read all three, and nothing more.
  const materializerGrant = reconcile.slice(
    reconcile.indexOf('GRANT SELECT ON\n    ops.reconciliation_daily_detail'),
  ).split(';')[0];
  assert.match(materializerGrant, /ops\.reconciliation_daily_summary/);
  assert.match(materializerGrant, /ops\.reconciliation_anomaly/);
  assert.match(materializerGrant, /TO sheinfm_materializer_ro/);
  assert.doesNotMatch(materializerGrant, /INSERT|UPDATE|DELETE|TRUNCATE/);
});
