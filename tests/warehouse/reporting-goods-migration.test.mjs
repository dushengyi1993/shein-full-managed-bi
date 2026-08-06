import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

test('reporting-goods migration is additive, temporal and separate from canonical identity', async () => {
  const [migration, verify, reconcile, privilegeVerify] = await Promise.all([
    readFile(new URL('db/migrations/0026_reporting_goods_mapping.sql', root), 'utf8'),
    readFile(new URL('db/verify/0026_reporting_goods_mapping.sql', root), 'utf8'),
    readFile(new URL('db/migrations/9999_runtime_role_reconcile.sql', root), 'utf8'),
    readFile(new URL('db/verify/9999_runtime_role_reconcile.sql', root), 'utf8'),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS dim\.reporting_goods/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ops\.reporting_goods_import_run/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS dim\.full_sku_reporting_goods_assignment/);
  assert.match(migration, /WHERE assignment_status = 'CONFIRMED' AND valid_to IS NULL/);
  assert.match(migration, /superseded_by_plan_hash/);
  assert.match(migration, /BI aggregation/);
  assert.doesNotMatch(migration, /UPDATE\s+dim\.full_sku_canonical_assignment/i);
  assert.doesNotMatch(migration, /UPDATE\s+dim\.canonical_product/i);
  assert.match(verify, /reporting goods mapping contract OK/);

  for (const relation of [
    'dim.reporting_goods',
    'dim.full_sku_reporting_goods_assignment',
    'ops.reporting_goods_import_run',
  ]) {
    assert.ok(reconcile.includes(relation), relation);
    assert.ok(privilegeVerify.includes(relation), relation);
  }
  assert.match(reconcile, /GRANT UPDATE \(assignment_status, superseded_by_plan_hash, valid_to, updated_at\)/);
  assert.match(reconcile, /GRANT UPDATE \(result_status, rolled_back_at\)/);
  assert.match(privilegeVerify, /supply reporting-goods boundary is invalid/);
});
