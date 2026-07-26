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
    skuNames: new Map([['DL\u001fSKU-1', 'Red']]),
    salesTrend: [
      { storeCode: 'DL', date: '2026-07-19', unitsSold: 2 },
      { storeCode: 'DL', date: '2026-07-20', unitsSold: 0 },
    ],
    storeHealth: [
      {
        storeCode: 'DL', permissionStatus: 'granted', hasFacts: true,
        businessDate: '2026-07-20', watermarkDate: '2026-07-20',
        dateAnchorStatus: 'ANCHORED', qualityStatus: 'VALID',
      },
      { storeCode: 'DX', permissionStatus: 'pending', hasFacts: false },
    ],
    owners: [{ key: 'owner-dl', name: '负责人A', storeCodes: ['DL'] }],
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
  assert.deepEqual(
    dashboard.salesTrend.at(-1),
    { date: '2026-07-20', unitsSold: 0, coveredStores: 1 },
  );
  assert.equal(dashboard.businessDate, '2026-07-20');
  assert.equal(dashboard.storeSkuRanking[0].storeCode, 'DL');
  assert.equal(dashboard.productRanking[0].identityLevel, 'STORE_LOCAL_UNVERIFIED');
  assert.equal(dashboard.storeRanking.find(({ code }) => code === 'DL').ownerKey, 'owner-dl');
  assert.deepEqual(dashboard.owners, [
    { key: 'owner-dl', name: '负责人A', storeCodes: ['DL'] },
  ]);
  assert.equal(dashboard.readiness.find(({ key }) => key === 'fact_load').completed, 1);
});

test('never merges the same bare SKU across stores and only totals one unified business date', () => {
  const input = {
    storePermissions: [
      { storeCode: 'AA', storeName: 'AA', permissionStatus: 'granted' },
      { storeCode: 'BB', storeName: 'BB', permissionStatus: 'granted' },
    ],
    snapshots: [
      {
        storeCode: 'AA', skuCode: 'SAME-SKU', productKey: 'SKC:SAME',
        salesToday: 1, salesYesterday: 1, sales7Days: 7, sales30Days: 30,
        statisticsDate: '2026-07-20', fetchedAt: '2026-07-20T04:00:00Z',
      },
      {
        storeCode: 'BB', skuCode: 'SAME-SKU', productKey: 'SKC:SAME',
        salesToday: 99, salesYesterday: 99, sales7Days: 99, sales30Days: 99,
        statisticsDate: '2026-07-19', fetchedAt: '2026-07-20T04:00:00Z',
      },
    ],
    skuNames: new Map(),
    salesTrend: [],
    storeHealth: [
      {
        storeCode: 'AA', permissionStatus: 'granted', hasFacts: true,
        watermarkDate: '2026-07-20', qualityStatus: 'VALID',
      },
      {
        storeCode: 'BB', permissionStatus: 'granted', hasFacts: true,
        watermarkDate: '2026-07-19', qualityStatus: 'VALID',
      },
    ],
  };

  const dashboard = buildDashboardFromProjectionInput(input);

  assert.equal(dashboard.businessDate, '2026-07-20');
  assert.equal(dashboard.unitsSold.today, 1);
  assert.equal(dashboard.storeSkuRanking.length, 1);
  assert.equal(dashboard.storeSkuRanking[0].storeCode, 'AA');
  assert.equal(dashboard.storeRanking.find(({ code }) => code === 'BB').unitsSold.today, null);
  assert.equal(dashboard.storeRanking.find(({ code }) => code === 'BB').qualityStatus, 'stale');
  assert.equal(dashboard.salesCoverage.status, 'partial');
});

test('trend rejects stores outside the current active full-managed catalog', () => {
  const input = projectionInput();
  input.salesTrend.push({
    storeCode: 'LEGACY',
    date: '2026-07-20',
    unitsSold: 999,
  });
  const dashboard = buildDashboardFromProjectionInput(input);
  assert.deepEqual(dashboard.salesTrend.at(-1), {
    date: '2026-07-20',
    unitsSold: 0,
    coveredStores: 1,
  });
  assert.equal(
    dashboard.salesTrendByStore.some(({ storeCode }) => storeCode === 'LEGACY'),
    false,
  );
});

test('represents a complete zero response without dt as live legal zero rather than an error', () => {
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: [{ storeCode: 'DL', storeName: 'DL', permissionStatus: 'granted' }],
    snapshots: [],
    skuNames: new Map(),
    salesTrend: [],
    storeHealth: [{
      storeCode: 'DL',
      permissionStatus: 'granted',
      hasFacts: false,
      runStatus: 'SUCCEEDED',
      qualityStatus: 'LEGAL_ZERO_UNANCHORED',
      dateAnchorStatus: 'UNANCHORED_ZERO',
      responseSkuCount: 12,
      unitsSold: { today: 0, yesterday: 0, last7Days: 0, last30Days: 0 },
      fetchedAt: '2026-07-20T04:00:00.000Z',
    }],
  });

  assert.equal(dashboard.datasetStatus, 'live');
  assert.equal(dashboard.businessDate, null);
  assert.deepEqual(dashboard.unitsSold, {
    today: 0, yesterday: 0, last7Days: 0, last30Days: 0,
  });
  assert.equal(dashboard.salesCoverage.status, 'legal_zero');
  assert.equal(dashboard.quality.status, 'legal_zero');
  assert.equal(dashboard.storeRanking[0].unitsSold.today, 0);
  assert.equal(dashboard.readiness.find(({ key }) => key === 'fact_load').completed, 1);
});

test('a latest quality-blocked run cannot leak an older accepted watermark into the dashboard', () => {
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: [{ storeCode: 'DL', storeName: 'DL', permissionStatus: 'granted' }],
    snapshots: [{
      storeCode: 'DL',
      skuCode: 'SKU-OLD',
      salesToday: 9,
      salesYesterday: 8,
      sales7Days: 70,
      sales30Days: 300,
      statisticsDate: '2026-07-20',
      fetchedAt: '2026-07-20T04:00:00.000Z',
    }],
    skuNames: new Map([['DL\u001fSKU-OLD', 'Old accepted row']]),
    salesTrend: [{
      storeCode: 'DL',
      date: '2026-07-20',
      unitsSold: 9,
    }],
    storeHealth: [{
      storeCode: 'DL',
      permissionStatus: 'granted',
      hasFacts: true,
      runStatus: 'QUALITY_BLOCKED',
      qualityStatus: 'UNANCHORED_NONZERO',
      dateAnchorStatus: 'BLOCKED',
      watermarkDate: '2026-07-20',
      fetchedAt: '2026-07-20T05:00:00.000Z',
    }],
  });

  assert.equal(dashboard.datasetStatus, 'empty');
  assert.equal(dashboard.quality.status, 'error');
  assert.deepEqual(dashboard.unitsSold, {
    today: null,
    yesterday: null,
    last7Days: null,
    last30Days: null,
  });
  assert.equal(dashboard.storeRanking[0].qualityStatus, 'error');
  assert.equal(dashboard.storeRanking[0].unitsSold.today, null);
  assert.deepEqual(dashboard.storeSkuRanking, []);
  assert.deepEqual(dashboard.productRanking, []);
  assert.deepEqual(dashboard.salesTrendByStore, [{
    storeCode: 'DL',
    date: '2026-07-20',
    unitsSold: 9,
  }]);
  assert.deepEqual(dashboard.salesTrend, [{
    date: '2026-07-20',
    unitsSold: 9,
    coveredStores: 1,
  }]);
});

test('dated rows remain visible as partial coverage when a small unanchored non-zero subset is quarantined', () => {
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: [{ storeCode: 'DL', storeName: 'DL', permissionStatus: 'granted' }],
    snapshots: [{
      storeCode: 'DL',
      skuCode: 'SKU-DATED',
      salesToday: 3,
      salesYesterday: 4,
      sales7Days: 14,
      sales30Days: 60,
      statisticsDate: '2026-07-20',
      fetchedAt: '2026-07-20T04:00:00.000Z',
    }],
    skuNames: new Map([['DL\u001fSKU-DATED', 'Accepted dated row']]),
    salesTrend: [{ storeCode: 'DL', date: '2026-07-20', unitsSold: 3 }],
    storeHealth: [{
      storeCode: 'DL',
      permissionStatus: 'granted',
      hasFacts: true,
      runStatus: 'SUCCEEDED',
      qualityStatus: 'PARTIAL',
      dateAnchorStatus: 'PARTIAL',
      businessDate: '2026-07-20',
      watermarkDate: '2026-07-20',
      requestedSkuCount: 2,
      responseSkuCount: 2,
      datedSkuCount: 1,
      unanchoredZeroSkuCount: 0,
      quarantinedSkuCount: 1,
      fetchedAt: '2026-07-20T04:00:00.000Z',
    }],
  });

  assert.equal(dashboard.datasetStatus, 'live');
  assert.equal(dashboard.businessDate, '2026-07-20');
  assert.equal(dashboard.salesCoverage.status, 'partial');
  assert.deepEqual(dashboard.unitsSold, {
    today: 3, yesterday: 4, last7Days: 14, last30Days: 60,
  });
  assert.equal(dashboard.storeRanking[0].qualityStatus, 'partial');
  assert.equal(
    dashboard.storeRanking[0].qualityReason,
    '1 个非零SKU缺少统计日期，已隔离',
  );
});

test('legal zero never turns blocked or missing stores into a global zero', () => {
  const legalZeroHealth = {
    storeCode: 'AA',
    permissionStatus: 'granted',
    hasFacts: false,
    runStatus: 'SUCCEEDED',
    qualityStatus: 'LEGAL_ZERO_UNANCHORED',
    dateAnchorStatus: 'UNANCHORED_ZERO',
    unitsSold: { today: 0, yesterday: 0, last7Days: 0, last30Days: 0 },
  };
  const blocked = buildDashboardFromProjectionInput({
    storePermissions: [
      { storeCode: 'AA', storeName: 'AA', permissionStatus: 'granted' },
      { storeCode: 'BB', storeName: 'BB', permissionStatus: 'granted' },
    ],
    snapshots: [],
    salesTrend: [],
    skuNames: new Map(),
    storeHealth: [
      legalZeroHealth,
      {
        storeCode: 'BB',
        permissionStatus: 'granted',
        runStatus: 'QUALITY_BLOCKED',
        qualityStatus: 'UNANCHORED_NONZERO',
        dateAnchorStatus: 'BLOCKED',
      },
    ],
  });
  assert.equal(blocked.salesCoverage.status, 'blocked');
  assert.deepEqual(blocked.unitsSold, {
    today: null,
    yesterday: null,
    last7Days: null,
    last30Days: null,
  });

  const partial = buildDashboardFromProjectionInput({
    storePermissions: [
      { storeCode: 'AA', storeName: 'AA', permissionStatus: 'granted' },
      { storeCode: 'BB', storeName: 'BB', permissionStatus: 'pending' },
    ],
    snapshots: [],
    salesTrend: [],
    skuNames: new Map(),
    storeHealth: [legalZeroHealth],
  });
  assert.equal(partial.salesCoverage.status, 'partial');
  assert.deepEqual(partial.unitsSold, {
    today: null,
    yesterday: null,
    last7Days: null,
    last30Days: null,
  });
});

test('a latest legal-zero observation keeps previously accepted dated trend history', () => {
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: [{ storeCode: 'DL', storeName: 'DL', permissionStatus: 'granted' }],
    snapshots: [{
      storeCode: 'DL',
      skuCode: 'SKU-HISTORY',
      statisticsDate: '2026-07-19',
      fetchedAt: '2026-07-19T04:00:00.000Z',
      salesToday: 7,
      salesYesterday: 6,
      sales7Days: 30,
      sales30Days: 90,
    }],
    salesTrend: [{
      storeCode: 'DL',
      date: '2026-07-19',
      unitsSold: 7,
    }],
    skuNames: new Map(),
    storeHealth: [{
      storeCode: 'DL',
      permissionStatus: 'granted',
      runStatus: 'SUCCEEDED',
      qualityStatus: 'LEGAL_ZERO_UNANCHORED',
      dateAnchorStatus: 'UNANCHORED_ZERO',
      watermarkDate: '2026-07-19',
      unitsSold: { today: 0, yesterday: 0, last7Days: 0, last30Days: 0 },
    }],
  });
  assert.equal(dashboard.salesCoverage.status, 'legal_zero');
  assert.equal(dashboard.unitsSold.today, 0);
  assert.deepEqual(dashboard.salesTrend, [{
    date: '2026-07-19',
    unitsSold: 7,
    coveredStores: 1,
  }]);
});

test('confirmed canonical assignments aggregate across stores with an RBAC-safe store breakdown', () => {
  const assignment = {
    canonicalProductId: '42',
    standardProductCode: 'STD-42',
    standardProductName: 'Standard kettle',
  };
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: [
      { storeCode: 'AA', storeName: 'AA', permissionStatus: 'granted' },
      { storeCode: 'BB', storeName: 'BB', permissionStatus: 'granted' },
    ],
    snapshots: ['AA', 'BB'].map((storeCode, index) => ({
      storeCode,
      skuCode: `SKU-${index}`,
      productKey: `SKC:${index}`,
      canonicalAssignment: assignment,
      salesToday: index + 1,
      salesYesterday: 0,
      sales7Days: index + 1,
      sales30Days: index + 1,
      statisticsDate: '2026-07-20',
      fetchedAt: '2026-07-20T04:00:00Z',
    })),
    skuNames: new Map(),
    salesTrend: [],
    storeHealth: ['AA', 'BB'].map((storeCode) => ({
      storeCode, permissionStatus: 'granted', hasFacts: true,
      watermarkDate: '2026-07-20', qualityStatus: 'VALID',
    })),
  });

  assert.equal(dashboard.productRanking.length, 1);
  assert.equal(dashboard.productRanking[0].identityLevel, 'CANONICAL_CONFIRMED');
  assert.equal(dashboard.productRanking[0].unitsSold.today, 3);
  assert.deepEqual(
    dashboard.productRanking[0].storeBreakdown.map(({ storeCode }) => storeCode),
    ['AA', 'BB'],
  );
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
        business_date: '2026-07-20', display_name: 'Red', product_key: 'SKC:1',
        sales_today: '0', sales_yesterday: '2',
        sales_7_days: '7', sales_30_days: '30', window_count: '4',
      }] };
      if (sql.includes('FROM dim.store s')) return { rows: [{
        store_code: 'DL', store_name: 'DL', outcome: 'GRANTED', probed_at: new Date('2026-07-20T04:00:00Z'), has_facts: true,
      }] };
      if (sql.includes('display_name')) return { rows: [{
        store_code: 'DL', platform_sku_id: 'SKU-1', display_name: 'Red',
      }] };
      if (sql.includes('daily_candidates')) return { rows: [{
        store_code: 'DL', sales_date: '2026-07-20', units_sold: '0',
      }] };
      if (sql.includes("to_regclass('dim.canonical_product')")) return { rows: [{
        has_canonical_product: false, has_canonical_assignment: false,
      }] };
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
