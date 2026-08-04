import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

test('pending-settlement projection grants only the materializer source columns', async () => {
  const [migration, verification, reconcile, reconcileVerification] = await Promise.all([
    readFile(
      new URL(
        'db/migrations/0023_full_home_pending_settlement_projection.sql',
        projectRoot,
      ),
      'utf8',
    ),
    readFile(
      new URL(
        'db/verify/0023_full_home_pending_settlement_projection.sql',
        projectRoot,
      ),
      'utf8',
    ),
    readFile(
      new URL('db/migrations/9999_runtime_role_reconcile.sql', projectRoot),
      'utf8',
    ),
    readFile(
      new URL('db/verify/9999_runtime_role_reconcile.sql', projectRoot),
      'utf8',
    ),
  ]);

  for (const sql of [migration, reconcile]) {
    const grant = sql.match(
      /GRANT SELECT \([\s\S]*?\)\s+ON fact\.full_home_finance_report_observation[\s\S]*?TO sheinfm_materializer_ro;/,
    )?.[0] || '';
    assert.match(grant, /store_code/);
    assert.match(grant, /report_generated_date/);
    assert.match(grant, /expected_settlement_amount/);
    assert.match(grant, /completed_pay_at/);
    assert.match(grant, /estimated_pay_at/);
    assert.match(grant, /observed_at/);
    assert.doesNotMatch(grant, /report_order_no_hash|settlement_status|updated_at/);
  }

  for (const sql of [verification, reconcileVerification]) {
    assert.match(sql, /has_column_privilege\(/);
    assert.match(sql, /report_order_no_hash/);
    assert.match(sql, /materializer/);
  }
});
