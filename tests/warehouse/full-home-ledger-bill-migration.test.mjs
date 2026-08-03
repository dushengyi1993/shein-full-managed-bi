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

test('merchant bill daily grain follows actual completed settlement, not report generation', async () => {
  const [migration, verification] = await Promise.all([
    readFile(
      new URL(
        'db/migrations/0022_full_home_bill_actual_settlement_date.sql',
        projectRoot,
      ),
      'utf8',
    ),
    readFile(
      new URL(
        'db/verify/0022_full_home_bill_actual_settlement_date.sql',
        projectRoot,
      ),
      'utf8',
    ),
  ]);
  assert.match(
    migration,
    /\(report\.completed_pay_at AT TIME ZONE 'Asia\/Shanghai'\)::date/,
  );
  assert.match(migration, /report\.settlement_status = 3/);
  assert.match(migration, /pending_report_count[\s\S]*0/);
  assert.doesNotMatch(migration, /report_generated_date AS business_date/);
  assert.match(verification, /actual settlement/);
});
