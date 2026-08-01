import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';

test('the homepage scope migration covers the canonical roster on every history table', async () => {
  const sql = await readFile(
    new URL('../../db/migrations/0018_full_home_25_store_scope.sql', import.meta.url),
    'utf8',
  );
  const constraints = [
    'ck_raw_webapi_home_fetch_store',
    'ck_fact_full_home_store_daily_store',
    'ck_fact_full_home_region_store',
    'ck_fact_full_home_product_store',
    'ck_fact_full_product_price_store',
    'ck_fact_full_home_finance_store',
    'ck_fact_full_home_product_finance_store',
    'ck_ops_full_home_finance_sync_store',
    'ck_full_home_finance_detail_store',
  ];
  for (const constraint of constraints) {
    assert.match(sql, new RegExp(`DROP CONSTRAINT IF EXISTS ${constraint}`));
    assert.match(sql, new RegExp(`ADD CONSTRAINT ${constraint}`));
  }
  for (const storeCode of FULL_MANAGED_STORE_CODES) {
    assert.equal((sql.match(new RegExp(`'${storeCode}'`, 'g')) || []).length, constraints.length);
  }
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /^COMMIT;/m);
});
