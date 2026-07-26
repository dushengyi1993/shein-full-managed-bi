import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../../db/migrations/0006_supply_domains.sql', import.meta.url);
const verifyUrl = new URL('../../db/verify/0006_supply_domains.sql', import.meta.url);

test('supply migration creates the required store-scoped, source-traceable domains', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const table of [
    'raw.openapi_fetch_page',
    'ops.supply_sync_attempt',
    'fact.supply_projection_batch',
    'fact.supply_projection_member',
    'dim.full_warehouse',
    'fact.purchase_order',
    'fact.purchase_order_line',
    'fact.purchase_order_jit_relation',
    'fact.delivery',
    'fact.delivery_line',
    'fact.inventory_snapshot',
    'fact.warehouse_inventory_snapshot',
    'fact.stock_advice_snapshot',
    'fact.shortage_event',
    'ops.reconciliation_result',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')}`));
  }
  assert.match(sql, /payload_fingerprint character\(64\) NOT NULL/g);
  assert.match(sql, /source_fetch_batch_id bigint NOT NULL/g);
  assert.match(sql, /source_fetched_at timestamptz NOT NULL/g);
  assert.match(sql, /CHECK \([\s\S]*quantity[\s\S]*>= 0/);
  assert.match(sql, /Unknown type\/status\/JIT codes are retained verbatim/);
  assert.match(sql, /Consolidation address, recipient and phone are intentionally excluded/);
  assert.match(sql, /stock_warning_observed boolean NOT NULL/);
  assert.match(sql, /stock_warning_is_warning boolean/);
  assert.match(sql, /supply_catalog_source_fetch_batch_id bigint/);
  assert.match(sql, /detail_source_fetch_batch_id bigint/);
  assert.match(sql, /uq_fact_purchase_order_line_observation/);
  assert.match(sql, /uq_fact_delivery_line_observation/);
  assert.match(sql, /uq_fact_purchase_order_jit_relation_observation/);
  assert.match(sql, /uq_fact_purchase_order_line_current[\s\S]*WHERE is_current/);
  assert.match(sql, /uq_fact_delivery_line_current[\s\S]*WHERE is_current/);
  assert.match(sql, /uq_fact_purchase_order_jit_relation_current[\s\S]*WHERE is_current/);
  assert.match(sql, /trg_ops_supply_sync_attempt_append_only/);
  assert.match(sql, /trg_fact_supply_projection_batch_append_only/);
  assert.match(sql, /trg_fact_supply_projection_member_append_only/);
  assert.match(sql, /freshness_scope_code IN \('LIVE', 'BACKFILL'\)/);
  assert.match(sql, /status_code IN \('STARTED', 'SUCCEEDED', 'PARTIAL', 'FAILED'\)/);
  assert.match(sql, /REVOKE UPDATE, DELETE[\s\S]*ops\.supply_sync_attempt/);
  assert.doesNotMatch(sql, /\bDROP TABLE\b|\bTRUNCATE\b/);
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
});

test('supply verification checks tables, natural keys, quantities and prohibited PII columns', async () => {
  const sql = await readFile(verifyUrl, 'utf8');
  assert.match(sql, /uq_fact_purchase_order_store_no/);
  assert.match(sql, /uq_fact_delivery_store_code/);
  assert.match(sql, /ck_fact_inventory_snapshot_quantities/);
  assert.match(sql, /fk_fact_purchase_order_line_store_order/);
  assert.match(sql, /fk_fact_delivery_line_store_delivery/);
  assert.match(sql, /ix_fact_supply_projection_batch_latest/);
  assert.match(sql, /fk_fact_supply_projection_member_batch/);
  assert.match(sql, /ix_ops_supply_sync_attempt_latest_health/);
  assert.match(sql, /supply_catalog_source_fetch_batch_id/);
  assert.match(sql, /Append-only supply evidence permissions are incorrect/);
  assert.match(sql, /column_name IN \([\s\S]*'phone'[\s\S]*'address'/);
});
