import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

async function migration() {
  return readFile(
    new URL('db/migrations/0029_v4_order_webapi_facts.sql', projectRoot),
    'utf8',
  );
}

async function verification() {
  return readFile(
    new URL('db/verify/0029_v4_order_webapi_facts.sql', projectRoot),
    'utf8',
  );
}

const FACT_TABLES = Object.freeze([
  'full_webapi_stock_record_observation',
  'full_webapi_waybill_observation',
  'full_webapi_return_application_observation',
  'full_webapi_return_order_observation',
  'full_webapi_exception_observation',
  'full_webapi_quality_report_observation',
  'full_webapi_value_added_service_observation',
]);

test('v4 order facts create seven typed observation tables with the shared evidence spine', async () => {
  const sql = await migration();

  for (const table of FACT_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS fact\\.${table}`));
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS fact\\.${table}[\\s\\S]*?entity_key_hash character\\(64\\) NOT NULL`),
    );
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS fact\\.${table}[\\s\\S]*?source_version_token text NOT NULL`),
    );
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS fact\\.${table}[\\s\\S]*?source_attempt_id bigint NOT NULL`),
    );
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS fact\\.${table}[\\s\\S]*?source_page_evidence_id bigint NOT NULL`),
    );
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS fact\\.${table}[\\s\\S]*?observed_at timestamptz NOT NULL`),
    );
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS fact\\.${table}[\\s\\S]*?source_updated_at timestamptz`),
    );
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS fact\\.${table}[\\s\\S]*?payload_hash character\\(64\\) NOT NULL`),
    );
    assert.match(
      sql,
      new RegExp(
        `CREATE TABLE IF NOT EXISTS fact\\.${table}[\\s\\S]*?PRIMARY KEY \\(source_attempt_id, entity_key_hash, source_version_token\\)`,
      ),
    );
    assert.match(
      sql,
      new RegExp(
        `CREATE TABLE IF NOT EXISTS fact\\.${table}[\\s\\S]*?REFERENCES ops\\.v4_collection_attempt \\(collection_attempt_id\\)`,
      ),
    );
    assert.match(
      sql,
      new RegExp(
        `CREATE TABLE IF NOT EXISTS fact\\.${table}[\\s\\S]*?FOREIGN KEY \\(source_attempt_id, source_page_evidence_id\\)[\\s\\S]*?REFERENCES ops\\.v4_page_evidence \\(collection_attempt_id, page_evidence_id\\)`,
      ),
    );
    assert.match(
      sql,
      new RegExp(`trg_fact_${table.replace(/_observation$/, '')}_append_only`),
    );
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS fact\\.${table}[\\s\\S]*?store_code ~ '\\^\\[A-Z\\]\\{2\\}\\[0-9\\]\\{4\\}\\$'`),
    );
  }

  // The database-enforced fact x attempt binding guard and one trigger per
  // typed table: a direct loader INSERT can never bypass the store_code and
  // exact endpoint match against the referenced attempt.
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION ops\.guard_v4_fact_attempt_binding\(\)/,
  );
  assert.match(sql, /NEW\.store_code <> attempt_store/);
  assert.match(sql, /attempt_endpoint <> expected_endpoint/);
  assert.match(
    sql,
    /WHEN 'full_webapi_stock_record_observation' THEN 'STOCK_RECORDS_LIST'/,
  );
  assert.match(
    sql,
    /WHEN 'full_webapi_waybill_observation' THEN 'WAYBILLS_PAGE'/,
  );
  assert.match(
    sql,
    /WHEN 'full_webapi_return_application_observation'[\s\S]*THEN 'RETURN_APPLICATIONS_LIST'/,
  );
  assert.match(
    sql,
    /WHEN 'full_webapi_return_order_observation' THEN 'RETURN_ORDERS_PAGE'/,
  );
  assert.match(
    sql,
    /WHEN 'full_webapi_exception_observation' THEN 'EXCEPTIONS_PAGE'/,
  );
  assert.match(
    sql,
    /WHEN 'full_webapi_quality_report_observation'[\s\S]*THEN 'QUALITY_REPORTS_PAGE'/,
  );
  assert.match(
    sql,
    /WHEN 'full_webapi_value_added_service_observation'[\s\S]*THEN 'VALUE_ADDED_SERVICES_PAGE'/,
  );
  for (const table of FACT_TABLES) {
    assert.match(
      sql,
      new RegExp(
        `trg_fact_${table.replace(/_observation$/, '')}_attempt_binding\\b`,
      ),
      `${table} lacks its attempt binding trigger`,
    );
  }
});

test('v4 order facts keep only typed page fields and hash every original number', async () => {
  const sql = await migration();

  assert.match(sql, /order_no_hash character\(64\)/);
  assert.match(sql, /supplier_code text/);
  assert.match(sql, /order_mode integer/);

  assert.match(sql, /collect_batch_no_hash character\(64\)/);
  assert.match(sql, /estimate_combine_no_hash character\(64\)/);
  assert.match(sql, /apportionment_bill_no_hash character\(64\)/);
  assert.match(sql, /actual_weight numeric\(20, 6\)/);
  assert.match(sql, /pack_quantity integer/);

  assert.match(sql, /return_plan_no_hash character\(64\)/);
  assert.match(sql, /origin_no_hash character\(64\)/);
  assert.match(sql, /return_total_amount numeric\(20, 4\)/);

  assert.match(sql, /seller_order_no_hash character\(64\)/);
  assert.match(sql, /seller_delivery_no_hash character\(64\)/);
  assert.match(sql, /return_order_status integer/);
  assert.match(sql, /warehouse_id integer/);

  assert.match(sql, /external_no_hash character\(64\)/);
  assert.match(sql, /workorder_type integer/);
  assert.match(sql, /category_id integer/);

  assert.match(sql, /purchase_code_hash character\(64\)/);
  assert.match(sql, /defective_total_qty integer/);

  assert.match(sql, /order_no_hash character\(64\)/);
  assert.match(sql, /sub_order_no_hash character\(64\)/);
  assert.match(sql, /purchase_no_hash character\(64\)/);
  assert.match(sql, /new_purchase_no_hash character\(64\)/);
  assert.match(sql, /qc_inspection_no_hash character\(64\)/);
  assert.match(sql, /return_no_hash character\(64\)/);
  assert.match(sql, /delivery_no_hash character\(64\)/);
  assert.match(sql, /service_site_id integer/);
  assert.match(sql, /service_site_name text/);
  assert.match(sql, /multi_part_flag integer/);
  assert.match(sql, /supplier_product_number text/);
  assert.match(sql, /skc_num integer/);
  assert.match(sql, /total_flag integer/);
  assert.match(sql, /order_state integer/);
  assert.match(sql, /low_value_flag integer/);
  assert.match(sql, /value_added_result integer/);
  assert.match(sql, /defective_quantity integer/);
  assert.match(sql, /order_scene integer/);
  assert.match(sql, /return_flag integer/);
  assert.match(sql, /vendor_replenish_state integer/);
  assert.match(sql, /show_fee_tag integer/);
  assert.match(sql, /supplier_source integer/);

  assert.doesNotMatch(sql, /\border_no text\b|\btracking_number text\b|\breturn_plan_no text\b|\breturn_order_no text\b|\bworkorder_no text\b|\bqc_inspection_no text\b|\bexternal_no text\b/);
  assert.doesNotMatch(sql, /\bfinal_formula\b|\bskc_name_list\b|\bseller_order_no_list\b|\bexpress_no_list\b|\bwarehouse_ids\b/);
  // The value-added-service contract carries no currency: neither amount
  // field of the verified allowlist may become a column.
  assert.doesNotMatch(sql, /\bactual_total_amount\b|\bestimate_increment_amount\b/);
});

test('v4 order facts store no JSONB payload, no PII columns and no float types', async () => {
  const sql = await migration();

  assert.doesNotMatch(sql, /sanitized_payload jsonb|jsonb NOT NULL|jsonb,/);
  assert.doesNotMatch(sql, /float4|float8|double precision|\bmoney\b/);
  // Scan only column definitions: comments legitimately name the excluded
  // keys, but no column may be shaped like one.
  const columns = sql.split('\n')
    .filter((line) => /^\s{4}[a-z][a-z0-9_]* (character\(|text|integer|bigint|numeric\(|timestamptz|boolean)/.test(line))
    .join('\n');
  assert.doesNotMatch(
    columns,
    /address|phone|mobile|contact|receiver|sender|consignee|recipient|postal|\bzip\b|buyer|driver|cookie|\btoken\b|secret|password|authorization|credential|csrf|url|image|thumb|attachment|response_body|raw_payload/i,
  );
  assert.doesNotMatch(sql, /'DL5477', 'MZ2406'/);
  assert.doesNotMatch(sql, /\bDROP TABLE\b|\bTRUNCATE\b/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
});

test('v4 order facts grant only append access to the loader and read access to the app', async () => {
  const sql = await migration();

  assert.match(
    sql,
    /GRANT SELECT, INSERT ON\s*fact\.full_webapi_stock_record_observation,\s*fact\.full_webapi_waybill_observation,\s*fact\.full_webapi_return_application_observation,\s*fact\.full_webapi_return_order_observation,\s*fact\.full_webapi_exception_observation,\s*fact\.full_webapi_quality_report_observation,\s*fact\.full_webapi_value_added_service_observation\s*TO sheinfm_webapi_loader/,
  );
  assert.match(
    sql,
    /GRANT SELECT ON\s*fact\.full_webapi_stock_record_observation,\s*fact\.full_webapi_waybill_observation,\s*fact\.full_webapi_return_application_observation,\s*fact\.full_webapi_return_order_observation,\s*fact\.full_webapi_exception_observation,\s*fact\.full_webapi_quality_report_observation,\s*fact\.full_webapi_value_added_service_observation\s*TO sheinfm_app/,
  );
  assert.match(
    sql,
    /pg_get_serial_sequence\([\s\S]*sequence_row\.table_name,[\s\S]*sequence_row\.column_name[\s\S]*GRANT USAGE ON SEQUENCE %s TO sheinfm_webapi_loader/,
  );
  assert.doesNotMatch(sql, /full_webapi_value_added_service_observation_id_seq/);
  assert.doesNotMatch(sql, /GRANT UPDATE, DELETE[\s\S]*full_webapi_/);
  assert.doesNotMatch(sql, /GRANT[\s\S]*full_webapi_[\s\S]*UPDATE/);
});

test('v4 order facts verification covers relations, spine, PII scan, replay key, append-only and grants', async () => {
  const verify = await verification();

  assert.match(verify, /Missing v4 order WebAPI fact relation/);
  assert.match(verify, /lacks the exact-replay primary key/);
  assert.match(verify, /must be typed without float, money or JSONB columns/);
  assert.match(verify, /v4 fact relation % exposes forbidden column %/);
  assert.match(
    verify,
    /attname ILIKE '%token%'[\s\S]*?attname <> 'source_version_token'/,
  );
  assert.match(verify, /lacks its append-only trigger/);
  assert.match(verify, /v4 fact attempt binding guard function is missing/);
  assert.match(verify, /lacks its attempt binding trigger/);
  assert.match(
    verify,
    /INSERT INTO ops\.v4_page_evidence AS inserted_page[\s\S]*?RETURNING inserted_page\.page_evidence_id INTO page_evidence_id/,
  );
  assert.match(verify, /WebAPI loader fact boundary is invalid/);
  assert.match(verify, /sheinfm_app fact read-only boundary is invalid/);
  assert.match(verify, /a non-hex entity_key_hash was accepted/);
  assert.match(verify, /lacks the attempt-pinned page evidence foreign key/);
  assert.match(verify, /an exact-replay duplicate fact row was accepted/);
  assert.match(verify, /a changed source version must append, not replace/);
  assert.match(verify, /typed fact rows are not append-only/);
  assert.match(
    verify,
    /DELETE FROM fact\.full_webapi_stock_record_observation\s+WHERE source_attempt_id = attempt_id/,
  );
  assert.match(verify, /a fact row cited page evidence from another attempt/);
  assert.match(verify, /fact\.full_webapi_value_added_service_observation/);
  assert.match(verify, /value-added-service fact columns must never carry currency-less amounts/);
  assert.match(verify, /a value-added-service flag outside 0\/1 was accepted/);
  assert.match(verify, /a negative value-added-service count was accepted/);
  assert.match(verify, /a non-hex value-added-service number hash was accepted/);
  assert.match(
    verify,
    /full_webapi_quality_report_observation[\s\S]*?'DL5477', repeat\('a', 64\), 'v1',[\s\S]*?repeat\('b', 64\), 'SKC-Q'/,
  );
  assert.match(
    verify,
    /a value-added-service fact was accepted under a STOCK_RECORDS_LIST attempt/,
  );
  assert.match(
    verify,
    /a fact row with a store_code different from its source attempt was accepted/,
  );
  assert.match(
    verify,
    /a stock-record fact was accepted under an EXCEPTIONS_PAGE attempt/,
  );
  assert.match(verify, /Valid positive fixture per verified endpoint/);
  assert.match(
    verify,
    /full_webapi_waybill_observation[\s\S]*waybill_attempt_id, waybill_page_id/,
  );
  assert.match(
    verify,
    /full_webapi_quality_report_observation[\s\S]*quality_report_attempt_id, quality_report_page_id/,
  );
  assert.match(verify, /an exact-replay duplicate value-added-service row was accepted/);
  assert.match(verify, /value-added-service fact rows are not append-only/);
  assert.match(verify, /^BEGIN;[\s\S]*ROLLBACK;\s*$/);
});
