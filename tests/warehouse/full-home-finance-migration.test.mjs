import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

test('finance homepage migration keeps ledger facts explicit, bounded and traceable', async () => {
  const sql = await readFile(
    new URL('db/migrations/0015_full_home_finance_history.sql', projectRoot),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fact\.full_home_finance_daily/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fact\.full_home_product_finance_daily/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ops\.full_home_finance_sync_window/);
  assert.match(sql, /end_date - start_date <= 6/);
  assert.match(sql, /settlement ledger date, not a consumer order date or GMV/);
  assert.match(sql, /goods_count is a finance-detail quantity/);
  assert.doesNotMatch(sql, /report_order_no\s+text|detail_row_id\s+text/);
});

test('runtime roles isolate finance writes from WebAPI and expose read-only facts to materializer', async () => {
  const [migration, verify] = await Promise.all([
    readFile(new URL('db/migrations/9999_runtime_role_reconcile.sql', projectRoot), 'utf8'),
    readFile(new URL('db/verify/9999_runtime_role_reconcile.sql', projectRoot), 'utf8'),
  ]);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON\s+fact\.full_home_finance_daily,/s);
  assert.match(migration, /fact\.full_home_product_finance_daily,[\s\S]*fact\.full_home_finance_detail_observation,[\s\S]*fact\.full_home_bill_daily\s+TO sheinfm_sales_loader/s);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON ops\.full_home_finance_sync_window/);
  assert.match(migration, /fact\.full_home_finance_daily,[\s\S]*fact\.full_home_product_finance_daily,[\s\S]*TO sheinfm_materializer_ro, sheinfm_app/);
  assert.match(migration, /fact\.full_home_ledger_daily,[\s\S]*fact\.full_home_bill_daily/);
  assert.match(verify, /WebAPI experiment loader retained % on %/);
  assert.match(verify, /'fact\.full_home_finance_daily'/);
  assert.match(verify, /'ops\.full_home_finance_sync_window'/);
});

test('finance detail migration deduplicates overlapping report windows without storing raw ids', async () => {
  const sql = await readFile(
    new URL('db/migrations/0016_full_home_finance_detail_observation.sql', projectRoot),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fact\.full_home_finance_detail_observation/);
  assert.match(sql, /UNIQUE \(store_code, report_order_no_hash, detail_row_key_hash\)/);
  assert.match(sql, /report_generated_date date NOT NULL/);
  assert.match(sql, /business_date date NOT NULL/);
  assert.match(sql, /daily homepage facts are rebuilt from this deduplicated source/);
  assert.doesNotMatch(sql, /\breport_order_no text\b|\bdetail_row_id text\b/);
});
