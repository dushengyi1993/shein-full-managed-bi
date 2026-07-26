import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../db/migrations/0009_product_identity_strong_evidence.sql',
  import.meta.url,
);
const verifyUrl = new URL(
  '../../db/verify/0009_product_identity_strong_evidence.sql',
  import.meta.url,
);

test('identity migration stores supplier evidence without promoting it to a strong type', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS supplier_code_normalized text/);
  assert.doesNotMatch(sql, /strong_evidence_types[\s\S]*SUPPLIER_CODE/);
  assert.doesNotMatch(sql, /'IMAGE_HASH'/);
  assert.doesNotMatch(sql, /ck_ops_product_match_candidate_auto_confirm/);
  assert.match(sql, /used only as supporting candidate evidence/i);
  assert.doesNotMatch(sql, /\bDROP TABLE\b|\bTRUNCATE\b/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
});

test('identity verification rejects supplier product numbers as a strong evidence type', async () => {
  const sql = await readFile(verifyUrl, 'utf8');
  assert.match(sql, /LIKE '%SUPPLIER_CODE%'/);
  assert.doesNotMatch(sql, /LIKE '%IMAGE_HASH%'/);
  assert.match(sql, /must not be accepted as a strong identity type/i);
  assert.match(sql, /^BEGIN;[\s\S]*ROLLBACK;\s*$/);
});
