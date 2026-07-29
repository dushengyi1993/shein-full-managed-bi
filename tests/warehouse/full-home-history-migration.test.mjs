import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

test('homepage history migration separates append-only audit from nullable daily facts', async () => {
  const sql = await readFile(
    new URL('db/migrations/0014_full_home_history.sql', projectRoot),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS raw\.webapi_home_fetch_audit/);
  assert.match(sql, /trg_raw_webapi_home_fetch_append_only/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fact\.full_home_store_daily/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fact\.full_home_region_daily/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fact\.full_home_product_daily/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fact\.full_product_price_observation/);
  assert.match(sql, /exposure_basis IN \('STORE_DEDUP', 'BRAND_SUMMED', 'UNAVAILABLE'\)/);
  assert.match(sql, /LATEST_FINANCE_UNIT_PRICE/);
  assert.match(sql, /estimated_deal_amount IS NULL/);
  for (const metric of [
    'deal_amount',
    'net_deal_amount',
    'sales_quantity',
    'buyer_count',
    'goods_detail_visitors',
    'exposure_users',
    'estimated_deal_amount',
  ]) {
    assert.doesNotMatch(sql, new RegExp(`${metric}[^,\\n]*DEFAULT 0`));
  }
});

test('runtime reconciliation grants only the bounded homepage facts to WebAPI', async () => {
  const sql = await readFile(
    new URL('db/migrations/9999_runtime_role_reconcile.sql', projectRoot),
    'utf8',
  );
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON\s+fact\.full_home_store_daily,/s);
  assert.match(sql, /fact\.full_home_region_daily,/);
  assert.match(sql, /fact\.full_home_product_daily\s+TO sheinfm_webapi_loader/s);
  assert.match(sql, /WebAPI loader must not access OpenAPI finance price evidence/);
  assert.match(sql, /GRANT SELECT, INSERT ON fact\.full_product_price_observation\s+TO sheinfm_sales_loader/s);
});
