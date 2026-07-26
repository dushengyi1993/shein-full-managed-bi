import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../db/migrations/0011_product_identity_resolution.sql',
  import.meta.url,
);
const verifyUrl = new URL(
  '../../db/verify/0011_product_identity_resolution.sql',
  import.meta.url,
);

test('resolution migration selects an explicit immutable observation run', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(
    sql,
    /ADD COLUMN IF NOT EXISTS observation_run_id text/,
  );
  assert.match(sql, /ALTER COLUMN observation_run_id SET NOT NULL/);
  assert.match(
    sql,
    /observation sets without observation_run_id[\s\S]*batch keys are not parsed/,
  );
  assert.match(
    sql,
    /status = 'SEALED'[\s\S]*member_count > 0[\s\S]*sealed_at IS NOT NULL/,
  );
  assert.match(
    sql,
    /UNIQUE \(\s*identity_observation_set_id,\s*store_id,\s*full_sku_id,\s*source_fetch_batch_id,\s*observation_run_id,\s*status/s,
  );
  assert.match(
    sql,
    /UNIQUE \(\s*identifier_observation_id,\s*identity_observation_set_id/s,
  );
  assert.doesNotMatch(sql, /\bsplit_part\s*\(|\bsubstring\s*\(\s*idempotency_key/i);
});

test('canonical products distinguish global identity from local singleton provenance', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const column of [
    'identity_scope',
    'identity_component_key',
    'evidence_policy_version',
    'provenance_fingerprint',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(sql, /identity_scope IN \('GLOBAL', 'LOCAL_SINGLETON'\)/);
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS ops\.canonical_product_observation_set/,
  );
  assert.match(
    sql,
    /fk_ops_canonical_product_observation_sealed_set[\s\S]*observation_run_id,[\s\S]*set_status/s,
  );
  assert.match(
    sql,
    /WHERE identity_scope = 'GLOBAL' AND is_match_representative/,
  );
  assert.match(
    sql,
    /trg_ops_canonical_product_observation_append_only[\s\S]*BEFORE UPDATE OR DELETE/s,
  );
});

test('candidates cite sealed sets, deterministic versions, and exact relational evidence', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const column of [
    'source_identity_observation_set_id',
    'target_identity_observation_set_id',
    'matcher_version',
    'evidence_policy_version',
    'evidence_set_fingerprint',
    'plan_hash',
    'component_product_node_count',
    'expected_relation_count',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(
    sql,
    /'BARCODE',\s*'MODEL',\s*'BRAND_CATEGORY',\s*'CURATED_ATTRIBUTES'/s,
  );
  assert.match(
    sql,
    /identity_scope = 'GLOBAL'[\s\S]*source_identity_observation_set_id[\s\S]*<> target_identity_observation_set_id[\s\S]*store_id <> target_store_id/s,
  );
  assert.match(
    sql,
    /expected_relation_count =\s*\(\s*component_product_node_count::bigint[\s\S]*\/ 2/s,
  );
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS ops\.product_match_candidate_evidence/,
  );
  assert.match(
    sql,
    /fk_ops_product_match_evidence_source_observation[\s\S]*identifier_observation_id,\s*identity_observation_set_id/s,
  );
  assert.match(
    sql,
    /fk_ops_product_match_evidence_target_observation[\s\S]*identifier_observation_id,\s*identity_observation_set_id/s,
  );
  assert.match(sql, /relation_source_set_id < relation_target_set_id/);
  assert.match(
    sql,
    /trg_ops_product_match_candidate_evidence_append_only[\s\S]*BEFORE UPDATE OR DELETE/s,
  );
});

test('decision and assignment references preserve candidate sku and canonical provenance', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(
    sql,
    /fk_ops_product_identity_decision_candidate_resolution[\s\S]*product_match_candidate_id,\s*store_id,\s*full_sku_id,\s*canonical_product_id,\s*identity_scope,\s*identity_component_key,\s*source_identity_observation_set_id,\s*observation_run_id,\s*plan_hash/s,
  );
  assert.match(
    sql,
    /fk_dim_full_sku_assignment_decision_resolution[\s\S]*product_identity_decision_id,\s*store_id,\s*product_match_candidate_id,\s*full_sku_id,\s*canonical_product_id/s,
  );
  assert.match(
    sql,
    /fk_dim_full_sku_assignment_canonical_provenance[\s\S]*identity_observation_set_id,\s*store_id,\s*full_sku_id,\s*observation_run_id/s,
  );
  assert.match(sql, /decision_outcome = 'CONFIRMED'/);
  assert.match(
    sql,
    /Only current CONFIRMED GLOBAL assignments may enter cross-store standard-product aggregation/,
  );
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
  assert.doesNotMatch(sql, /\bTRUNCATE\b|\bDROP TABLE\b/);
});

test('resolution verification checks complete relations and composite readback', async () => {
  const sql = await readFile(verifyUrl, 'utf8');

  assert.match(sql, /member_count > 0/);
  assert.match(sql, /CURATED_ATTRIBUTES/);
  assert.match(sql, /count\(DISTINCT evidence\.relation_key\)/);
  assert.match(sql, /fewer than two source stores/);
  assert.match(sql, /inconsistent with its decision/);
  assert.match(sql, /no matching SEALED provenance/);
  assert.match(sql, /^BEGIN;[\s\S]*ROLLBACK;\s*$/);
});
