import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DashboardProjectionError,
  projectDashboardData,
  selectLatestSkuSalesSnapshots,
} from '../../src/domain/dashboard-projection.mjs';

const STORE_CODES = [
  'DL', 'DX', 'FY', 'LQ', 'NM', 'JY', 'ZL', 'TS', 'MZ',
  'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC',
];

function permissions(overrides = {}) {
  return STORE_CODES.map((storeCode) => ({
    storeCode,
    storeName: `${storeCode} 全托店`,
    permissionStatus: overrides[storeCode] ?? 'pending',
  }));
}

function snapshot({
  storeCode = 'DL',
  skuCode = 'SKU-A',
  salesToday = 1,
  salesYesterday = 2,
  sales7Days = 7,
  sales30Days = 30,
  statisticsDate = '2026-07-20',
  fetchedAt = '2026-07-20T03:00:00.000Z',
} = {}) {
  return {
    storeCode,
    skuCode,
    salesToday,
    salesYesterday,
    sales7Days,
    sales30Days,
    statisticsDate,
    fetchedAt,
  };
}

function assertProjectionError(fn, expectedCode) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DashboardProjectionError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

test('selects the newest statistics date, then newest fetch, for each store and SKU', () => {
  const selected = selectLatestSkuSalesSnapshots(
    [
      snapshot({ salesToday: 100, statisticsDate: '2026-07-19', fetchedAt: '2026-07-20T10:00:00Z' }),
      snapshot({ salesToday: 10, fetchedAt: '2026-07-20T02:00:00Z' }),
      snapshot({ salesToday: 11, fetchedAt: '2026-07-20T03:00:00Z' }),
      snapshot({ storeCode: 'DX', salesToday: 5 }),
    ],
    permissions(),
  );

  assert.equal(selected.length, 2);
  assert.equal(selected.find(({ storeCode }) => storeCode === 'DL').salesToday, 11);
  assert.equal(selected.find(({ storeCode }) => storeCode === 'DX').salesToday, 5);
});

test('projects latest snapshots into live dashboard totals and rankings without double counting history', () => {
  const projected = projectDashboardData({
    storePermissions: permissions({ DL: 'granted', DX: 'granted' }),
    snapshots: [
      snapshot({ salesToday: 100, salesYesterday: 100, sales7Days: 700, sales30Days: 3000, statisticsDate: '2026-07-19' }),
      snapshot({ salesToday: 10, salesYesterday: 9, sales7Days: 70, sales30Days: 300, fetchedAt: '2026-07-20T02:00:00Z' }),
      snapshot({ salesToday: 11, salesYesterday: 10, sales7Days: 71, sales30Days: 301, fetchedAt: '2026-07-20T03:00:00Z' }),
      snapshot({ skuCode: 'SKU-B', salesToday: 3, salesYesterday: 4, sales7Days: 20, sales30Days: 80, fetchedAt: '2026-07-20T04:00:00Z' }),
      snapshot({ storeCode: 'DX', salesToday: 5, salesYesterday: 6, sales7Days: 25, sales30Days: 90, fetchedAt: '2026-07-20T05:00:00Z' }),
    ],
  });

  assert.equal(projected.datasetStatus, 'live');
  assert.equal(projected.updatedAt, '2026-07-20T05:00:00.000Z');
  assert.deepEqual(projected.permission, {
    status: 'partial',
    authorizedStores: 2,
    totalStores: 18,
  });
  assert.deepEqual(projected.unitsSold, {
    today: 19,
    yesterday: 20,
    last7Days: 116,
    last30Days: 471,
  });

  assert.deepEqual(projected.storeRanking.slice(0, 2), [
    {
      code: 'DL',
      name: 'DL 全托店',
      permissionStatus: 'granted',
      unitsSold: { today: 14, last7Days: 91, last30Days: 381 },
    },
    {
      code: 'DX',
      name: 'DX 全托店',
      permissionStatus: 'granted',
      unitsSold: { today: 5, last7Days: 25, last30Days: 90 },
    },
  ]);
  assert.deepEqual(projected.skuRanking, [
    {
      sku: 'SKU-A',
      unitsSold: { today: 16, last7Days: 96, last30Days: 391 },
    },
    {
      sku: 'SKU-B',
      unitsSold: { today: 3, last7Days: 20, last30Days: 80 },
    },
  ]);

  const serialized = JSON.stringify(projected);
  for (const forbiddenField of ['amount', 'revenue', 'order', 'profit']) {
    assert.equal(serialized.toLowerCase().includes(forbiddenField), false);
  }
});

test('stores without observations stay visible with null sales instead of fabricated zeros', () => {
  const projected = projectDashboardData({
    snapshots: [snapshot()],
    storePermissions: permissions({ DL: 'granted', FY: 'granted' }),
  });

  const missingStore = projected.storeRanking.find(({ code }) => code === 'FY');
  assert.deepEqual(missingStore.unitsSold, {
    today: null,
    last7Days: null,
    last30Days: null,
  });
});

test('an entirely missing sales dataset remains null and has no invented update time', () => {
  const projected = projectDashboardData({
    snapshots: [],
    storePermissions: permissions(),
  });

  assert.equal(projected.datasetStatus, 'empty');
  assert.equal(projected.updatedAt, null);
  assert.deepEqual(projected.unitsSold, {
    today: null,
    yesterday: null,
    last7Days: null,
    last30Days: null,
  });
  assert.equal(projected.storeRanking.length, 18);
  assert.ok(projected.storeRanking.every(({ unitsSold }) => Object.values(unitsSold).every((value) => value === null)));
  assert.deepEqual(projected.skuRanking, []);
});

test('identical historical rows do not get summed twice', () => {
  const row = snapshot({ salesToday: 8, salesYesterday: 7, sales7Days: 40, sales30Days: 150 });
  const projected = projectDashboardData({
    snapshots: [row, structuredClone(row)],
    storePermissions: permissions(),
  });

  assert.deepEqual(projected.unitsSold, {
    today: 8,
    yesterday: 7,
    last7Days: 40,
    last30Days: 150,
  });
});

test('derives granted, pending, denied and unknown aggregate permission states', () => {
  assert.equal(
    projectDashboardData({ snapshots: [], storePermissions: permissions(Object.fromEntries(STORE_CODES.map((code) => [code, 'granted']))) }).permission.status,
    'granted',
  );
  assert.equal(projectDashboardData({ snapshots: [], storePermissions: permissions() }).permission.status, 'pending');
  assert.equal(
    projectDashboardData({ snapshots: [], storePermissions: permissions(Object.fromEntries(STORE_CODES.map((code) => [code, 'denied']))) }).permission.status,
    'denied',
  );
  assert.equal(
    projectDashboardData({ snapshots: [], storePermissions: permissions(Object.fromEntries(STORE_CODES.map((code) => [code, 'unknown']))) }).permission.status,
    'unknown',
  );
});

test('rejects permission ambiguity and snapshots from stores outside the permission set', () => {
  const duplicatePermissions = permissions();
  duplicatePermissions.push({ ...duplicatePermissions[0] });
  assertProjectionError(
    () => projectDashboardData({ snapshots: [], storePermissions: duplicatePermissions }),
    'DUPLICATE_STORE_PERMISSION',
  );

  assertProjectionError(
    () => projectDashboardData({ snapshots: [snapshot({ storeCode: 'HL' })], storePermissions: permissions() }),
    'UNKNOWN_SNAPSHOT_STORE',
  );
});

test('rejects missing, negative and invalid sales values rather than coercing them', () => {
  const missing = snapshot();
  delete missing.salesYesterday;
  assertProjectionError(
    () => projectDashboardData({ snapshots: [missing], storePermissions: permissions() }),
    'INVALID_SALES_COUNT',
  );

  assertProjectionError(
    () => projectDashboardData({ snapshots: [snapshot({ sales30Days: -1 })], storePermissions: permissions() }),
    'NEGATIVE_SALES_COUNT',
  );

  assertProjectionError(
    () => projectDashboardData({ snapshots: [snapshot({ sales7Days: '7' })], storePermissions: permissions() }),
    'INVALID_SALES_COUNT',
  );
});
