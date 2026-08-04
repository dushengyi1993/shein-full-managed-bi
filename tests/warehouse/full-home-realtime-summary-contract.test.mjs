import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

test('realtime summary endpoint remains inside the closed homepage audit vocabulary', async () => {
  const [migration, verify] = await Promise.all([
    readFile(
      new URL('db/migrations/0024_full_home_realtime_summary_contract.sql', projectRoot),
      'utf8',
    ),
    readFile(
      new URL('db/verify/0024_full_home_realtime_summary_contract.sql', projectRoot),
      'utf8',
    ),
  ]);
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS ck_raw_webapi_home_fetch_endpoint/);
  assert.match(migration, /'STORE_REALTIME_SUMMARY'/);
  assert.match(migration, /'UPDATE_TIME'/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(verify, /STORE_REALTIME_SUMMARY/);
  assert.match(verify, /ROLLBACK;/);
});
