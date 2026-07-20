import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadDashboardData,
  normalizeDashboardData,
} from '../../src/server/dashboard-data.mjs';

test('normalizes dashboard data through an explicit read-only whitelist', () => {
  const dashboard = normalizeDashboardData({
    datasetStatus: 'live',
    updatedAt: '2026-07-20T08:30:00.000Z',
    permission: {
      status: 'granted',
      authorizedStores: 18,
      totalStores: 18,
      secretNote: 'must not be returned',
    },
    unitsSold: {
      today: 10,
      yesterday: 11,
      last7Days: 70,
      last30Days: 300,
      revenue: 999999,
    },
    profit: 12345,
    orderCount: 88,
    storeRanking: [
      {
        code: 'LOW',
        name: 'Low',
        unitsSold: { today: 1, last7Days: 7, last30Days: 20 },
        revenue: 200,
      },
      {
        code: 'HIGH',
        name: 'High',
        unitsSold: { today: 2, last7Days: 8, last30Days: 40 },
        profit: 10,
      },
    ],
    skuRanking: [],
  });

  assert.equal(dashboard.readOnly, true);
  assert.equal(dashboard.dataset.status, 'live');
  assert.equal(dashboard.unitsSold.today, 10);
  assert.equal(dashboard.storeRanking[0].code, 'HIGH');

  const serialized = JSON.stringify(dashboard);
  assert.doesNotMatch(serialized, /revenue|profit|orderCount|secretNote/i);
});

test('keeps unavailable volume values missing instead of turning them into zero', () => {
  const dashboard = normalizeDashboardData({
    datasetStatus: 'live',
    updatedAt: '2026-07-20T08:30:00.000Z',
    permission: { status: 'denied', authorizedStores: 0, totalStores: 1 },
    unitsSold: {},
    storeRanking: [
      {
        code: 'NO-DATA',
        name: 'No data',
        permissionStatus: 'denied',
        unitsSold: {},
      },
    ],
    skuRanking: [],
  });

  assert.deepEqual(dashboard.unitsSold, {
    today: null,
    yesterday: null,
    last7Days: null,
    last30Days: null,
  });
  assert.deepEqual(dashboard.storeRanking[0].unitsSold, {
    today: null,
    last7Days: null,
    last30Days: null,
  });
});

test('uses FULL_BI_DATA_FILE when no function argument is supplied', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'full-bi-data-'));
  const dataFile = join(directory, 'dashboard.json');
  const previousValue = process.env.FULL_BI_DATA_FILE;

  try {
    await writeFile(
      dataFile,
      JSON.stringify({
        datasetStatus: 'live',
        updatedAt: '2026-07-20T09:00:00.000Z',
        permission: { status: 'partial', authorizedStores: 9, totalStores: 18 },
        unitsSold: { today: 21, yesterday: 18, last7Days: 120, last30Days: 510 },
        storeRanking: [],
        skuRanking: [],
      }),
      'utf8',
    );
    process.env.FULL_BI_DATA_FILE = dataFile;

    const dashboard = await loadDashboardData();
    assert.equal(dashboard.dataset.status, 'live');
    assert.equal(dashboard.permission.authorizedStores, 9);
    assert.equal(dashboard.unitsSold.today, 21);
  } finally {
    if (previousValue === undefined) delete process.env.FULL_BI_DATA_FILE;
    else process.env.FULL_BI_DATA_FILE = previousValue;
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects data without a valid update timestamp', () => {
  assert.throws(
    () => normalizeDashboardData({ updatedAt: 'not-a-date' }),
    /valid updatedAt timestamp/,
  );
});

test('accepts an explicit empty dataset without inventing an update time', () => {
  const dashboard = normalizeDashboardData({
    datasetStatus: 'empty',
    updatedAt: null,
    permission: { status: 'pending', authorizedStores: 0, totalStores: 18 },
    unitsSold: {},
    storeRanking: [],
    skuRanking: [],
  });

  assert.equal(dashboard.dataset.status, 'empty');
  assert.equal(dashboard.dataset.label, '暂无销量快照');
  assert.equal(dashboard.updatedAt, null);
});
