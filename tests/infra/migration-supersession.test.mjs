import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

test('migration runner skips only proven superseded constraint transitions', async () => {
  const runner = await readFile(
    new URL('scripts/migrate_full_managed_db.sh', projectRoot),
    'utf8',
  );

  assert.match(runner, /migration_is_superseded\(\)/);
  assert.match(runner, /0017_full_home_all_store_scope\.sql\)/);
  assert.match(runner, /pg_get_constraintdef\(oid\) LIKE '\\''%NM7418%/);
  assert.match(runner, /WHERE store_code = '\\''NM7418/);
  assert.match(runner, /0020_full_home_webapi_audit_contract\.sql\)/);
  assert.match(runner, /pg_get_constraintdef\(oid\) LIKE '\\''%UPDATE_TIME%/);
  assert.match(runner, /pg_get_constraintdef\(oid\) LIKE '\\''%PRODUCT_DIAGNOSE_LIST%/);
  assert.match(runner, /skipped superseded/);
  assert.doesNotMatch(
    runner,
    /0018_full_home_25_store_scope\.sql\)|0019_full_home_ledger_and_bill\.sql\)|0021_full_home_current_webapi_contract\.sql\)/,
  );
});
