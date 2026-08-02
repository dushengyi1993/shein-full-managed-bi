import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

test('homepage audit contract records both realtime and inventory-ledger reads', async () => {
  const [migration, verify] = await Promise.all([
    readFile(
      new URL('db/migrations/0020_full_home_webapi_audit_contract.sql', projectRoot),
      'utf8',
    ),
    readFile(
      new URL('db/verify/0020_full_home_webapi_audit_contract.sql', projectRoot),
      'utf8',
    ),
  ]);

  assert.match(migration, /ck_raw_webapi_home_fetch_endpoint/);
  assert.match(migration, /'STORE_REALTIME'/);
  assert.match(migration, /'LEDGER_DAILY'/);
  assert.match(verify, /homepage WebAPI audit endpoint contract is incomplete/);
});
