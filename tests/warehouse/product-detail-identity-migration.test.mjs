import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../db/migrations/0008_product_detail_identity_evidence.sql',
  import.meta.url,
);
const verifyUrl = new URL(
  '../../db/verify/0008_product_detail_identity_evidence.sql',
  import.meta.url,
);

test('product-detail identity migration stores evidence without retaining image URLs', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const column of [
    'category_id',
    'category_name',
    'product_type_id',
    'brand_code',
    'main_image_url_hash',
    'dimension_length',
    'dimension_width',
    'dimension_height',
    'dimension_weight',
    'stop_purchase_code',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(sql, /main_image_url_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /URL itself is deliberately not persisted/i);
  assert.match(sql, /never image-content or strong identity evidence/i);
  assert.doesNotMatch(sql, /ADD COLUMN IF NOT EXISTS main_image_url\b/);
  assert.doesNotMatch(sql, /\bDROP TABLE\b|\bTRUNCATE\b/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
});

test('product-detail identity verification rejects raw image URL persistence', async () => {
  const sql = await readFile(verifyUrl, 'utf8');
  assert.match(sql, /column_name = 'main_image_url'/);
  assert.match(sql, /ck_dim_full_sku_main_image_url_hash/);
  assert.match(sql, /^BEGIN;[\s\S]*ROLLBACK;\s*$/);
});
