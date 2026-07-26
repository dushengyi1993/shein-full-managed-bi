import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../db/migrations/0010_product_identity_observation_sets.sql',
  import.meta.url,
);
const verifyUrl = new URL(
  '../../db/verify/0010_product_identity_observation_sets.sql',
  import.meta.url,
);

test('identity observation-set migration enforces sealed append-only envelopes', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS raw\.product_identity_observation_set/);
  assert.match(sql, /observation_run_id text NOT NULL/);
  assert.match(
    sql,
    /CHECK \(observation_run_id ~ '\^\[A-Za-z0-9\._:-\]\{8,120\}\$'\)/,
  );
  assert.match(
    sql,
    /UNIQUE \(store_id, observation_run_id, full_sku_id\)/,
  );
  assert.match(
    sql,
    /ix_raw_product_identity_set_run[\s\S]*observation_run_id,[\s\S]*WHERE status = 'SEALED'/,
  );
  assert.match(sql, /document_version integer NOT NULL DEFAULT 27/);
  assert.match(sql, /CHECK \(document_version = 27\)/);
  assert.match(sql, /status IN \('BUILDING', 'SEALED'\)/);
  assert.match(
    sql,
    /status = 'SEALED'[\s\S]*member_count > 0[\s\S]*sealed_at IS NOT NULL/,
  );
  assert.match(sql, /source_response_fingerprint character\(64\)/);
  assert.match(sql, /set_payload_fingerprint character\(64\)/);
  assert.match(sql, /UNIQUE \(store_id, source_fetch_batch_id, full_sku_id\)/);
  assert.match(sql, /FOREIGN KEY \(store_id, source_fetch_batch_id\)/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE/);
  assert.match(sql, /allow only one BUILDING to SEALED transition/);
  assert.match(sql, /NEW\.member_count <= 0/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /declared_count <= 0/);
  assert.match(sql, /declared_count <> actual_count/);
  assert.match(sql, /must be SEALED with member_count/);
  assert.match(
    sql,
    /REVOKE INSERT, UPDATE, DELETE, TRUNCATE[\s\S]*FROM sheinfm_app/,
  );
  assert.match(
    sql,
    /GRANT SELECT ON raw\.product_identity_observation_set TO sheinfm_app/,
  );
  assert.match(
    sql,
    /GRANT UPDATE \(status, member_count, sealed_at\)[\s\S]*TO sheinfm_supply_loader/,
  );
  assert.match(
    sql,
    /pg_get_serial_sequence\(\s*'raw\.product_identity_observation_set',\s*'identity_observation_set_id'\s*\)::regclass/,
  );
  assert.match(
    sql,
    /pg_get_serial_sequence\(\s*'raw\.identifier_observation',\s*'identifier_observation_id'\s*\)::regclass/,
  );
  assert.match(
    sql,
    /EXECUTE format\(\s*'REVOKE USAGE, UPDATE ON SEQUENCE %s FROM sheinfm_app'/,
  );
  assert.match(
    sql,
    /EXECUTE format\(\s*'GRANT USAGE, SELECT ON SEQUENCE %s TO sheinfm_supply_loader'/,
  );
  assert.doesNotMatch(
    sql,
    /product_identity_observation_set_identity_observation_set_id_seq/,
  );
  assert.doesNotMatch(
    sql,
    /identifier_observation_identifier_observation_id_seq/,
  );
  assert.doesNotMatch(sql, /\bTRUNCATE\s+(?:TABLE\s+)?raw\.|\bDROP TABLE\b/);
  assert.doesNotMatch(
    sql,
    /\bsplit_part\s*\(|\bsubstring\s*\(\s*idempotency_key/i,
  );
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
});

test('new identifier members require a composite set binding and variant barcodes', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const column of [
    'identity_observation_set_id',
    'identity_scope',
    'scope_key',
    'source_value_key',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(sql, /identity_scope IN \('PRODUCT', 'VARIANT'\)/);
  assert.match(sql, /identifier_type <> 'BARCODE'[\s\S]*identity_scope = 'VARIANT'/);
  assert.match(sql, /'PRODUCT_TYPE'/);
  assert.match(sql, /'IMAGE_REFERENCE'/);
  assert.doesNotMatch(sql, /'IMAGE_URL'|'IMAGE_HASH'/);
  assert.match(
    sql,
    /FOREIGN KEY \(\s*identity_observation_set_id,\s*store_id,\s*full_sku_id,\s*source_fetch_batch_id/s,
  );
  assert.match(sql, /identifier members may be inserted only while their observation set is BUILDING/);
  assert.match(sql, /Null only for legacy ungrouped observations/);
});

test('identity observation-set verification checks triggers and rejects URL identity types', async () => {
  const sql = await readFile(verifyUrl, 'utf8');

  assert.match(sql, /fk_raw_identifier_observation_set_composite/);
  assert.match(sql, /ck_raw_identifier_observation_barcode_scope/);
  assert.match(sql, /ck_raw_product_identity_observation_set_run/);
  assert.match(sql, /uq_raw_product_identity_observation_set_run_sku/);
  assert.match(sql, /ix_raw_product_identity_set_run/);
  assert.match(
    sql,
    /non-null text observation_run_id/,
  );
  assert.match(
    sql,
    /observation_run_id safe-format constraint is missing/,
  );
  assert.match(sql, /tgdeferrable/);
  assert.match(sql, /tginitdeferred/);
  assert.match(sql, /member_count > 0/);
  assert.match(
    sql,
    /SEALED product identity observation sets must have positive member_count/,
  );
  assert.match(sql, /PRODUCT_TYPE identifier evidence is missing/);
  assert.match(sql, /IMAGE_URL/);
  assert.match(sql, /IMAGE_HASH/);
  assert.match(sql, /^BEGIN;[\s\S]*ROLLBACK;\s*$/);
});
