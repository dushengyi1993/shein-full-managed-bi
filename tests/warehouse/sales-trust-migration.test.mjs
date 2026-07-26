import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../../db/migrations/0003_sales_trust.sql', import.meta.url);

test('sales trust migration is additive and creates catalog, run, quality and watermark state', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /ALTER TABLE dim\.full_sku[\s\S]*ADD COLUMN IF NOT EXISTS is_active/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS catalog_run_key/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ops\.sales_sync_run/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ops\.sales_quality_event/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ops\.sales_business_watermark/);
  assert.match(sql, /LEGAL_ZERO_UNANCHORED/);
  assert.match(sql, /UNANCHORED_NONZERO/);
  assert.match(sql, /INSERT INTO ops\.sales_business_watermark[\s\S]*FROM fact\.full_sku_sales_snapshot/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON ops\.sales_sync_run TO sheinfm_app/);
  assert.doesNotMatch(sql, /\bDROP TABLE\b|\bTRUNCATE\b/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
});
