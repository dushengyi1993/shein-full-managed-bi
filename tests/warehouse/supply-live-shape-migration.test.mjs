import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../db/migrations/0007_supply_live_shape_alignment.sql',
  import.meta.url,
);
const verifyUrl = new URL(
  '../../db/verify/0007_supply_live_shape_alignment.sql',
  import.meta.url,
);

test('live stock-advice forecast migration preserves decimal platform rates', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(
    sql,
    /ALTER COLUMN predicted_daily_sales TYPE numeric[\s\S]*USING predicted_daily_sales::numeric/,
  );
  assert.match(sql, /not an actual unit count/i);
  assert.doesNotMatch(sql, /\bDROP TABLE\b|\bTRUNCATE\b/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
});

test('live stock-advice forecast verification checks type and non-negative guard', async () => {
  const sql = await readFile(verifyUrl, 'utf8');
  assert.match(sql, /data_type/);
  assert.match(sql, /'numeric'/);
  assert.match(sql, /ck_fact_stock_advice_snapshot_quantities/);
  assert.match(sql, /^BEGIN;[\s\S]*ROLLBACK;\s*$/);
});
