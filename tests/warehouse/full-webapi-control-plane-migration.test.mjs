import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

async function migration() {
  return readFile(
    new URL('db/migrations/0028_v4_collection_control_plane.sql', projectRoot),
    'utf8',
  );
}

async function verification() {
  return readFile(
    new URL('db/verify/0028_v4_collection_control_plane.sql', projectRoot),
    'utf8',
  );
}

test('v4 control plane creates contract, run, attempt, page evidence, coverage and capability objects', async () => {
  const sql = await migration();

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ops\.v4_collection_contract/);
  assert.match(sql, /contract_version integer NOT NULL/);
  assert.match(sql, /INSERT INTO ops\.v4_collection_contract[\s\S]*ON CONFLICT \(contract_version\) DO NOTHING/);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ops\.v4_collection_run/);
  assert.match(sql, /run_key character\(64\) NOT NULL/);
  assert.match(sql, /plan_hash character\(64\) NOT NULL/);
  assert.match(sql, /expected_store_count integer NOT NULL/);
  assert.match(sql, /expected_endpoint_count integer NOT NULL/);
  assert.match(sql, /store_codes text\[\] NOT NULL/);
  assert.match(sql, /endpoint_codes text\[\] NOT NULL/);
  assert.match(sql, /CONSTRAINT ck_ops_v4_collection_run_retry\s*CHECK \(retry_policy = 'NONE'\)/);
  assert.match(sql, /CONSTRAINT ck_ops_v4_collection_run_hashes\s*CHECK \(\s*run_key ~ '\^\[0-9a-f\]\{64\}\$'[\s\S]*plan_hash ~ '\^\[0-9a-f\]\{64\}\$'/);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ops\.v4_collection_attempt/);
  assert.match(sql, /attempt_key character\(64\) NOT NULL/);
  assert.match(sql, /request_schema_hash character\(64\) NOT NULL/);
  assert.match(sql, /CONSTRAINT uq_ops_v4_collection_attempt_grain\s*UNIQUE \(collection_run_id, store_code, endpoint_code\)/);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ops\.v4_page_evidence/);
  assert.match(sql, /page_key character\(64\) NOT NULL/);
  assert.match(sql, /response_schema_hash character\(64\) NOT NULL/);
  assert.match(sql, /payload_hash character\(64\) NOT NULL/);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ops\.v4_collection_coverage/);
  assert.match(sql, /completed_store_count integer NOT NULL/);
  assert.match(sql, /partial_store_count integer NOT NULL/);
  assert.match(sql, /unknown_store_count integer NOT NULL/);
  assert.match(sql, /paging_verified boolean NOT NULL/);
  assert.match(sql, /dedupe_verified boolean NOT NULL/);
  assert.match(sql, /row_count bigint NOT NULL DEFAULT 0/);
  assert.match(sql, /reason_code text/);
  assert.match(sql, /as_of timestamptz NOT NULL/);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS ops\.v4_capability_observation/);
  assert.match(sql, /business_materialized boolean NOT NULL DEFAULT false/);
  assert.match(sql, /CONSTRAINT ck_ops_v4_capability_observation_materialized\s*CHECK \(business_materialized = false\)/);
});

test('v4 control plane state machines, retry NONE and guards are explicit', async () => {
  const sql = await migration();

  assert.match(
    sql,
    /'PLANNED', 'PREFLIGHT_PASSED', 'RUNNING',\s*'SUCCEEDED', 'PARTIAL', 'FAILED', 'ABORTED'/,
  );
  assert.match(
    sql,
    /'PLANNED', 'RUNNING', 'SUCCEEDED',\s*'PARTIAL', 'FAILED', 'BLOCKED', 'UNKNOWN'/,
  );
  assert.match(sql, /CREATE OR REPLACE FUNCTION ops\.guard_v4_collection_run_state\(\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION ops\.guard_v4_collection_attempt_terminal\(\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION ops\.guard_v4_collection_coverage\(\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION ops\.reject_v4_evidence_mutation\(\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION ops\.guard_v4_page_evidence_mutation\(\)/);
  assert.match(sql, /until every roster store x endpoint attempt is SUCCEEDED/);
  assert.match(sql, /v4 collection run % requires every created attempt terminal/);
  assert.match(sql, /BLOCKED and UNKNOWN are terminal preflight outcomes with no fabricated[\s\S]*counts/);
  assert.match(sql, /FOREACH roster_store IN ARRAY NEW\.store_codes/);
  assert.match(sql, /NEW\.store_code = ANY \(run\.store_codes\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_v4_page_evidence_attempt_ref\s*ON ops\.v4_page_evidence \(collection_attempt_id, page_evidence_id\)/);
});

test('v4 control plane stores no raw body and pins the exact runtime roster and work manifest', async () => {
  const sql = await migration();

  // Scan only column definitions: comments legitimately name the excluded
  // keys, but no column may be shaped like one.
  const columns = sql.split('\n')
    .filter((line) => /^\s{4}[a-z][a-z0-9_]* (character\(|text|integer|bigint|numeric\(|timestamptz|boolean)/.test(line))
    .join('\n');
  assert.doesNotMatch(columns, /response_body|raw_payload|cookie|authorization|password|credential|csrf|api_key/i);
  assert.match(sql, /current_user = 'sheinfm_webapi_loader'[\s\S]*canonical 25-store roster/);
  assert.match(sql, /NEW\.expected_store_count <> 25/);
  assert.match(sql, /NEW\.expected_endpoint_count <> 13/);
  for (const code of [
    'STOCK_RECORDS_LIST',
    'WAYBILLS_PAGE',
    'RETURN_APPLICATIONS_LIST',
    'RETURN_ORDERS_PAGE',
    'EXCEPTIONS_PAGE',
    'VALUE_ADDED_SERVICES_PAGE',
    'QUALITY_REPORTS_PAGE',
    ...Array.from({ length: 6 }, (_, index) => `WAYBILLS_STATISTICS_${index + 1}`),
  ]) {
    assert.match(sql, new RegExp(`'${code}'`));
  }
  assert.doesNotMatch(sql, /\bDROP TABLE\b|\bTRUNCATE\b/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
});

test('v4 control plane grants follow the loader-drives, app-reads boundary', async () => {
  const sql = await migration();

  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE\s*ON ops\.v4_collection_run, ops\.v4_collection_attempt,\s*ops\.v4_collection_coverage\s*TO sheinfm_webapi_loader/,
  );
  assert.match(sql, /GRANT SELECT, INSERT\s*ON ops\.v4_page_evidence, ops\.v4_capability_observation\s*TO sheinfm_webapi_loader/);
  assert.match(
    sql,
    /GRANT SELECT\s*ON ops\.v4_collection_contract, ops\.v4_collection_run,\s*ops\.v4_collection_attempt, ops\.v4_page_evidence,\s*ops\.v4_collection_coverage, ops\.v4_capability_observation\s*TO sheinfm_app/,
  );
  assert.doesNotMatch(sql, /GRANT DELETE[\s\S]*ops\.v4_collection_run/);
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'sheinfm_webapi_loader'\)/);
});

test('v4 control plane verification covers relations, guards, grants and fail-closed negatives', async () => {
  const verify = await verification();

  assert.match(verify, /Missing v4 collection control-plane relation/);
  assert.match(verify, /v4 collection control-plane guard functions are missing/);
  assert.match(verify, /v4 page evidence attempt-pinned referencable key is missing/);
  assert.match(verify, /v4 control-plane relation % exposes forbidden column %/);
  assert.match(verify, /'sheinfm_webapi_loader', 'ops\.v4_collection_run', 'SELECT,INSERT,UPDATE'/);
  assert.match(verify, /'sheinfm_app', relation_name, 'SELECT'/);
  assert.match(verify, /a run without attempts was allowed to be SUCCEEDED/);
  assert.match(verify, /a PARTIAL run was allowed to conclude with an open attempt/);
  assert.match(verify, /a FAILED run was allowed to conclude with an open attempt/);
  assert.match(verify, /a FAILED attempt was allowed to fabricate zero counts/);
  assert.match(verify, /coverage accepted zero-filled completion for a partial run/);
  assert.match(verify, /capability observations are not append-only/);
  assert.match(verify, /attempt_key was mutable/);
  assert.match(verify, /a non-NONE retry policy was accepted/);
  assert.match(verify, /an attempt outside the frozen roster was accepted/);
  assert.match(verify, /SET ROLE sheinfm_webapi_loader/);
  assert.match(verify, /a minimal runtime manifest was accepted/);
  assert.match(verify, /a runtime manifest outside the canonical roster was accepted/);
  assert.match(verify, /a canonical-size runtime manifest with a shortened endpoint roster was accepted/);
  assert.match(verify, /the exact canonical runtime manifest was rejected/);
  assert.match(verify, /^BEGIN;[\s\S]*ROLLBACK;\s*$/);
});
