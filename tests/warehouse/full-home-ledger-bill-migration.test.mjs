import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

test('ledger and bill migration preserves distinct inventory and settlement truths', async () => {
  const sql = await readFile(
    new URL('db/migrations/0019_full_home_ledger_and_bill.sql', projectRoot),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fact\.full_home_ledger_daily/);
  assert.match(sql, /customer_outbound_count bigint/);
  assert.match(sql, /outbound_count bigint/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fact\.full_home_bill_daily/);
  assert.match(sql, /calculated_settlement_amount/);
  assert.match(sql, /reported_settlement_amount/);
  assert.match(sql, /direction IN \('SUPPLEMENT', 'DEDUCTION'\)/);
  assert.doesNotMatch(sql, /\breport_order_no text\b|\breplenish_no text\b/);
});
