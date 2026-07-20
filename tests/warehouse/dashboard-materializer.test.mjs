import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  atomicWriteJson,
  buildDashboardFromProjectionInput,
  readDashboardProjectionInput,
} from '../../src/warehouse/dashboard-materializer.mjs';

function projectionInput() {
  return {
    storePermissions: [
      { storeCode: 'DL', storeName: 'DL', permissionStatus: 'granted' },
      { storeCode: 'DX', storeName: 'DX', permissionStatus: 'pending' },
    ],
    snapshots: [{
      storeCode: 'DL', skuCode: 'SKU-1', salesToday: 0, salesYesterday: 2,
      sales7Days: 7, sales30Days: 30, statisticsDate: '2026-07-20', fetchedAt: '2026-07-20T04:00:00Z',
    }],
    skuNames: new Map([['SKU-1', 'Red']]),
    salesTrend: [{ date: '2026-07-19', unitsSold: 2 }, { date: '2026-07-20', unitsSold: 0 }],
    storeHealth: [
      { storeCode: 'DL', permissionStatus: 'granted', hasFacts: true },
      { storeCode: 'DX', permissionStatus: 'pending', hasFacts: false },
    ],
  };
}

test('builds a live dashboard with real readiness and preserves pending stores as null', () => {
  const dashboard = buildDashboardFromProjectionInput(projectionInput(), {
    storeCatalog: [
      { storeCode: 'DL', applicationStatus: 'approved', authorizationStatus: 'authorized' },
      { storeCode: 'DX', applicationStatus: 'approved', authorizationStatus: 'pending' },
    ],
  });
  assert.equal(dashboard.datasetStatus, 'live');
  assert.equal(dashboard.unitsSold.today, 0);
  assert.equal(dashboard.permission.status, 'partial');
  assert.equal(dashboard.storeRanking.find(({ code }) => code === 'DX').unitsSold.today, null);
  assert.equal(dashboard.skuRanking[0].name, 'Red');
  assert.deepEqual(dashboard.salesTrend.at(-1), { date: '2026-07-20', unitsSold: 0 });
  assert.equal(dashboard.readiness.find(({ key }) => key === 'fact_load').completed, 1);
});

test('empty production database emits no sample or invented zero metrics', () => {
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: [], snapshots: [], skuNames: new Map(), salesTrend: [], storeHealth: [],
  }, {
    storeCatalog: [{ storeCode: 'DL', storeName: 'DL', applicationStatus: 'approved' }],
  });
  assert.equal(dashboard.datasetStatus, 'empty');
  assert.equal(dashboard.permission.status, 'pending');
  assert.equal(dashboard.updatedAt, null);
  assert.deepEqual(dashboard.unitsSold, {
    today: null, yesterday: null, last7Days: null, last30Days: null,
  });
  assert.deepEqual(dashboard.skuRanking, []);
  assert.equal(JSON.stringify(dashboard).includes('sample'), false);
});

test('reads only complete four-window snapshots and latest probe state from PostgreSQL rows', async () => {
  const transactionQueries = [];
  const client = {
    released: false,
    async query(sql) {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') {
        transactionQueries.push(sql);
        return { rows: [] };
      }
      if (sql.includes("HAVING count(DISTINCT")) return { rows: [{
        store_code: 'DL', platform_sku_id: 'SKU-1', fetched_at: new Date('2026-07-20T04:00:00Z'),
        metric_window_end: new Date('2026-07-20T16:00:00Z'), sales_today: '0', sales_yesterday: '2',
        sales_7_days: '7', sales_30_days: '30', window_count: '4',
      }] };
      if (sql.includes('FROM dim.store s')) return { rows: [{
        store_code: 'DL', store_name: 'DL', outcome: 'GRANTED', probed_at: new Date('2026-07-20T04:00:00Z'), has_facts: true,
      }] };
      if (sql.includes('display_name')) return { rows: [{ platform_sku_id: 'SKU-1', display_name: 'Red' }] };
      if (sql.includes('daily_candidates')) return { rows: [{ sales_date: '2026-07-20', units_sold: '0' }] };
      throw new Error('Unexpected query');
    },
    release() { this.released = true; },
  };
  const input = await readDashboardProjectionInput({ async connect() { return client; } });
  assert.equal(input.snapshots[0].statisticsDate, '2026-07-20');
  assert.equal(input.snapshots[0].salesToday, 0);
  assert.equal(input.storePermissions[0].permissionStatus, 'granted');
  assert.deepEqual(transactionQueries, [
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'COMMIT',
  ]);
  assert.equal(client.released, true);
});

test('rolls back the repeatable-read snapshot if dashboard projection fails', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') return { rows: [] };
      throw new Error('synthetic read failure');
    },
    release() { queries.push('RELEASE'); },
  };
  await assert.rejects(
    () => readDashboardProjectionInput({ async connect() { return client; } }),
    /synthetic read failure/,
  );
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.ok(queries.includes('ROLLBACK'));
  assert.equal(queries.at(-1), 'RELEASE');
});

test('atomically writes dashboard JSON with a trailing newline', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fm-dashboard-'));
  try {
    const file = path.join(directory, 'dashboard.json');
    await atomicWriteJson(file, { datasetStatus: 'empty' });
    assert.equal(await readFile(file, 'utf8'), '{\n  "datasetStatus": "empty"\n}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
