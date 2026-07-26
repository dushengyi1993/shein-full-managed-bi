import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildReadOnlyActionPool,
  readOperationsDashboard,
  readSupplyCoverage,
} from '../../src/warehouse/operations-dashboard.mjs';

test('missing operational migrations remain pending without invented zero facts', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rows: [] };
      if (sql.includes("to_regclass('fact.purchase_order')")) {
        return {
          rows: [{
            purchase_order_ready: false,
            delivery_ready: false,
            inventory_ready: false,
            stock_advice_ready: false,
            webhook_receipt_ready: false,
            webhook_job_ready: false,
            operational_event_ready: false,
            subscription_state_ready: false,
            product_identity_ready: false,
            employee_access_ready: false,
          }],
        };
      }
      throw new Error('unexpected query');
    },
    release() {
      queries.push('RELEASE');
    },
  };
  const dashboard = await readOperationsDashboard({
    async connect() {
      return client;
    },
  });
  assert.equal(dashboard.supply.status, 'pending');
  assert.equal(dashboard.supply.coverage.totalStores, null);
  assert.deepEqual(dashboard.supply.inventory, []);
  assert.equal(dashboard.platform.status, 'pending');
  assert.equal(dashboard.platform.health, null);
  assert.equal(dashboard.platform.queue, null);
  assert.equal(dashboard.actionPool.writeEnabled, false);
  assert.deepEqual(dashboard.actionPool.candidates, []);
  const readinessSql = queries.find((sql) => (
    sql.includes("to_regclass('fact.purchase_order')")
  ));
  assert.match(
    readinessSql,
    /to_regclass\('ops\.canonical_product_observation_set'\)/,
  );
  assert.match(
    readinessSql,
    /to_regclass\('ops\.product_match_candidate_evidence'\)/,
  );
  assert.match(
    readinessSql,
    /table_name = 'canonical_product'[\s\S]*column_name = 'identity_scope'/,
  );
  assert.match(
    readinessSql,
    /table_name = 'full_sku_canonical_assignment'[\s\S]*column_name = 'identity_scope'/,
  );
  assert.equal(queries.at(-1), 'RELEASE');
});

test('supply coverage distinguishes successful, failed and missing stores', async () => {
  const coverage = await readSupplyCoverage({
    async query(sql) {
      if (sql.includes("cooperation_mode = 'FULL_MANAGED'")) {
        return {
          rows: [
            { store_id: '1', store_code: 'AA1000' },
            { store_id: '2', store_code: 'BB2000' },
            { store_id: '3', store_code: 'CC3000' },
          ],
        };
      }
      assert.match(sql, /FROM ops\.supply_sync_attempt/);
      const attempt = (storeId, storeCode, subtypeCode, statusCode, overrides = {}) => ({
        store_id: String(storeId),
        store_code: storeCode,
        store_name: storeCode,
        attempt_id: `${storeCode}-${subtypeCode}-20260726`,
        domain_code: 'INVENTORY',
        subtype_code: subtypeCode,
        mode_code: 'INCREMENTAL',
        freshness_scope_code: 'LIVE',
        window_start_at: '2026-07-25T00:00:00.000Z',
        window_end_at: '2026-07-26T00:00:00.000Z',
        requested_count: '5',
        observed_count: statusCode === 'SUCCEEDED' ? '5' : '3',
        status_code: statusCode,
        error_code: statusCode === 'SUCCEEDED' ? null : 'UPSTREAM_PARTIAL',
        error_reason: statusCode === 'SUCCEEDED' ? null : 'Sanitized partial response.',
        started_at: '2026-07-26T07:55:00.000Z',
        completed_at: '2026-07-26T08:00:00.000Z',
        ...overrides,
      });
      return {
        rows: [
          attempt(1, 'AA1000', 'PI', 'SUCCEEDED'),
          attempt(1, 'AA1000', 'JI', 'SUCCEEDED'),
          attempt(2, 'BB2000', 'PI', 'FAILED', {
            completed_at: '2026-07-26T08:10:00.000Z',
          }),
          attempt(2, 'BB2000', 'JI', 'SUCCEEDED'),
        ],
      };
    },
  }, { evaluatedAt: '2026-07-26T09:00:00.000Z' });
  assert.equal(coverage.totalStores, 3);
  assert.deepEqual(coverage.domains.inventory, {
    status: 'partial',
    totalStores: 3,
    observedStores: 2,
    succeededStores: 1,
    failedStores: 1,
    missingStores: 1,
    inProgressStores: 0,
    staleStores: 0,
    succeededStoreCodes: ['AA1000'],
    failedStoreCodes: ['BB2000'],
    missingStoreCodes: ['CC3000'],
    staleStoreCodes: [],
    inProgressStoreCodes: [],
    latestFetchedAt: '2026-07-26T08:10:00.000Z',
    watermarkStart: '2026-07-25T00:00:00.000Z',
    watermarkEnd: '2026-07-26T00:00:00.000Z',
    evaluatedAt: '2026-07-26T09:00:00.000Z',
    freshnessMaxAgeSeconds: 18_000,
    mode: 'INCREMENTAL',
    reason: '1/3 家店成功，1 家失败或过期，1 家缺少必需子域，0 家同步中',
  });
});

test('read-only action pool surfaces data gaps but never enables writes', () => {
  const pool = buildReadOnlyActionPool({
    coverage: {
      domains: {
        inventory: {
          failedStoreCodes: ['BB2000'],
          missingStoreCodes: ['CC3000'],
          latestFetchedAt: '2026-07-26T08:00:00.000Z',
        },
      },
    },
    inventory: [],
    stockAdvice: [],
  }, {
    queue: null,
  });
  assert.equal(pool.mode, 'observe_only');
  assert.equal(pool.writeEnabled, false);
  assert.deepEqual(
    pool.candidates.map(({ storeCode, type }) => ({ storeCode, type })),
    [
      { storeCode: 'BB2000', type: 'SUPPLY_SYNC_FAILURE_REVIEW' },
      { storeCode: 'CC3000', type: 'SUPPLY_COVERAGE_REVIEW' },
    ],
  );
});
