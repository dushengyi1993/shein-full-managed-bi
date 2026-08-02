import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

test('current homepage WebAPI migration audits update-time and paginated product reads', async () => {
  const [migration, verify] = await Promise.all([
    readFile(
      new URL('db/migrations/0021_full_home_current_webapi_contract.sql', projectRoot),
      'utf8',
    ),
    readFile(
      new URL('db/verify/0021_full_home_current_webapi_contract.sql', projectRoot),
      'utf8',
    ),
  ]);
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS ck_raw_webapi_home_fetch_endpoint/);
  assert.match(migration, /'UPDATE_TIME'/);
  assert.match(migration, /'PRODUCT_DIAGNOSE_LIST'/);
  assert.match(migration, /'STORE_REALTIME'/);
  assert.match(migration, /'LEDGER_DAILY'/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(verify, /UPDATE_TIME/);
  assert.match(verify, /PRODUCT_DIAGNOSE_LIST/);
  assert.match(verify, /ROLLBACK;/);
});
