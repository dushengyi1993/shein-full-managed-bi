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
    readiness: [
      {
        key: 'applications',
        label: '全托应用审核',
        status: 'complete',
        completed: 18,
        total: 18,
        note: '可展示说明',
        secret: 'must not be returned',
      },
    ],
    salesTrend: [
      { date: '2026-07-19', unitsSold: 11, revenue: 800 },
      { date: 'invalid', unitsSold: 12 },
      { date: '2026-07-20', unitsSold: 10 },
    ],
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
  assert.equal(dashboard.schemaVersion, 4);
  assert.equal(dashboard.dataset.status, 'live');
  assert.equal(dashboard.unitsSold.today, 10);
  assert.equal(dashboard.storeRanking[0].code, 'HIGH');
  assert.deepEqual(dashboard.salesTrend, [
    { date: '2026-07-19', unitsSold: 11, coveredStores: null },
    { date: '2026-07-20', unitsSold: 10, coveredStores: null },
  ]);
  assert.deepEqual(dashboard.readiness[0], {
    key: 'applications',
    label: '全托应用审核',
    status: 'complete',
    statusLabel: '已完成',
    completed: 18,
    total: 18,
    note: '可展示说明',
  });

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
    yesterday: null,
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
        permission: { status: 'partial', authorizedStores: 9, totalStores: 24 },
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

test('production never falls back to the bundled sample fixture', async () => {
  await assert.rejects(
    () => loadDashboardData(undefined, { runtimeEnvironment: 'production' }),
    /FULL_BI_DATA_FILE is required in production/,
  );
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
    permission: { status: 'pending', authorizedStores: 0, totalStores: 24 },
    unitsSold: {},
    storeRanking: [],
    skuRanking: [],
  });

  assert.equal(dashboard.dataset.status, 'empty');
  assert.equal(dashboard.dataset.label, '暂无销量快照');
  assert.equal(dashboard.updatedAt, null);
  assert.deepEqual(dashboard.readiness, []);
  assert.deepEqual(dashboard.salesTrend, []);
});

test('keeps unknown readiness counts and trend values missing instead of inventing zero', () => {
  const dashboard = normalizeDashboardData({
    datasetStatus: 'live',
    updatedAt: '2026-07-20T08:30:00.000Z',
    permission: { status: 'unknown', authorizedStores: 0, totalStores: 24 },
    readiness: [
      { key: 'probe', label: '接口探针', status: 'unexpected', note: '待核验' },
    ],
    salesTrend: [
      { date: '2026-07-20', unitsSold: null },
      { date: '2026-02-30', unitsSold: 9 },
    ],
  });

  assert.equal(dashboard.readiness[0].status, 'unknown');
  assert.equal(dashboard.readiness[0].completed, null);
  assert.equal(dashboard.readiness[0].total, null);
  assert.deepEqual(dashboard.salesTrend, [
    { date: '2026-07-20', unitsSold: null, coveredStores: null },
  ]);
});

test('preserves only the trusted sales date, coverage, quality, scoped trend, and product identity fields', () => {
  const dashboard = normalizeDashboardData({
    datasetStatus: 'live',
    updatedAt: '2026-07-20T08:30:00.000Z',
    businessDate: '2026-07-20',
    permission: { status: 'granted', authorizedStores: 2, totalStores: 2 },
    salesCoverage: {
      businessDate: '2026-07-20',
      coveredStores: 2,
      legalZeroStores: 0,
      totalStores: 2,
      status: 'complete',
      label: '同日覆盖完整',
      reason: '两店同日',
      partialStores: 0,
      quarantinedRows: 0,
      datedRows: 4,
      totalRows: 4,
      secret: 'drop-me',
    },
    quality: {
      status: 'healthy',
      label: '可信',
      reason: '同日',
      impact: '可用',
      nextStep: null,
      internalStack: 'drop-me',
    },
    salesTrend: [{ date: '2026-07-20', unitsSold: 3, coveredStores: 2 }],
    salesTrendByStore: [
      { storeCode: 'AA', date: '2026-07-20', unitsSold: 1, revenue: 999 },
      { storeCode: 'BB', date: '2026-07-20', unitsSold: 2 },
    ],
    storeSkuRanking: [
      {
        storeCode: 'AA',
        sku: 'SKU-1',
        name: '商品1',
        mappingStatus: 'CONFIRMED',
        canonicalProductId: '42',
        standardProductCode: 'STD-42',
        businessDate: '2026-07-20',
        unitsSold: { today: 1, yesterday: 0, last7Days: 1, last30Days: 1 },
      },
      {
        storeCode: 'BB',
        sku: 'SKU-2',
        name: '商品2',
        mappingStatus: 'MISSING_SPU_ID',
        unitsSold: { today: 2, yesterday: 0, last7Days: 2, last30Days: 2 },
      },
    ],
    productRanking: [{
      canonicalProductId: '42',
      standardProductCode: 'STD-42',
      name: '标准商品',
      identityLevel: 'CANONICAL_CONFIRMED',
      mappingStatus: 'CONFIRMED',
      storeCount: 2,
      storeBreakdown: [
        { storeCode: 'AA', unitsSold: { today: 1, yesterday: 0, last7Days: 1, last30Days: 1 } },
        { storeCode: 'BB', unitsSold: { today: 2, yesterday: 0, last7Days: 2, last30Days: 2 } },
      ],
      unitsSold: { today: 3, yesterday: 0, last7Days: 3, last30Days: 3 },
    }],
  });

  assert.equal(dashboard.businessDate, '2026-07-20');
  assert.equal(dashboard.salesCoverage.status, 'complete');
  assert.equal(dashboard.salesCoverage.partialStores, 0);
  assert.equal(dashboard.salesCoverage.quarantinedRows, 0);
  assert.equal(dashboard.quality.status, 'healthy');
  assert.equal(dashboard.salesTrend[0].coveredStores, 2);
  assert.equal(dashboard.salesTrendByStore.length, 2);
  assert.equal(dashboard.productRanking[0].storeBreakdown.length, 2);
  assert.equal(dashboard.productIdentityCoverage.confirmedSkus, 1);
  assert.equal(dashboard.productIdentityCoverage.totalSkus, 2);
  assert.equal(dashboard.productIdentityCoverage.missingSpuSkus, 1);
  assert.match(dashboard.productIdentityCoverage.note, /1 个缺少平台SPU/);
  assert.equal(
    dashboard.storeSkuRanking.find(({ storeCode }) => storeCode === 'BB').mappingStatus,
    'MISSING_SPU_ID',
  );
  assert.doesNotMatch(JSON.stringify(dashboard), /secret|internalStack|revenue/i);
});

test('preserves strict operational whitelists without exposing secrets or enabling writes', () => {
  const dashboard = normalizeDashboardData({
    datasetStatus: 'live',
    updatedAt: '2026-07-26T08:30:00.000Z',
    permission: { status: 'granted', authorizedStores: 1, totalStores: 1 },
    supply: {
      status: 'available',
      secretKey: 'drop-me',
      purchaseOrderStatus: [{
        storeCode: 'DL5477',
        storeName: 'DL5477',
        statusCode: 'OPEN',
        statusName: '待交付',
        orderCount: 0,
        latestSourceFetchedAt: '2026-07-26T08:00:00.000Z',
        consumerAddress: 'drop-me',
      }],
      deliveryMilestones: [{
        storeCode: 'DL5477',
        storeName: 'DL5477',
        milestoneCode: 'IN_TRANSIT',
        deliveryCount: 1,
        deliveryQuantity: null,
        deliveryQuantityCoverage: { knownLineCount: 0, totalLineCount: 1 },
      }],
      inventory: [{
        storeCode: 'DL5477',
        storeName: 'DL5477',
        inventoryTypeCode: 'PI',
        skuCount: 1,
        inventoryQuantity: 0,
        usableInventory: 0,
        transitQuantity: null,
        transitCoverage: { knownSkuCount: 0, totalSkuCount: 1 },
        shortageSkuCount: null,
        shortageQuantity: null,
        shortageCoverage: { knownSkuCount: 0, totalSkuCount: 1 },
        reconciliationMismatchCount: 0,
      }],
      stockAdvice: [{
        storeCode: 'DL5477',
        storeName: 'DL5477',
        totalSkuCount: 1,
        advisedSkuCount: null,
        advisedOrderQuantity: null,
        advisedOrderCoverage: { knownSkuCount: 0, totalSkuCount: 1 },
        plannedUrgentQuantity: 0,
        plannedUrgentCoverage: { knownSkuCount: 1, totalSkuCount: 1 },
        warningSkuCount: null,
        warningCoverage: { knownSkuCount: 0, totalSkuCount: 1 },
      }],
    },
    platform: {
      status: 'available',
      health: { ok: true, databaseUrl: 'drop-me' },
      queue: {
        queued: 0,
        running: 0,
        retry: 0,
        deadLetter: 0,
        expiredLeases: 0,
        hydrationPending: 0,
        blockedStores: 0,
      },
      subscriptions: [{
        appFingerprint: 'abc123',
        eventCode: '3001435',
        desiredState: 'ENABLED',
        observedState: 'ENABLED',
        callbackValidated: true,
        checkedAt: '2026-07-26T08:00:00.000Z',
        appSecretKey: 'drop-me',
      }],
      events: [{
        eventCode: '3001435',
        eventPath: '/purchase-order',
        eventFamily: 'purchase_order',
        businessType: 'PURCHASE_ORDER',
        businessKey: 'PO-1',
        storeCode: 'DL5477',
        deliveryScope: 'STORE',
        safeProjection: {
          eventLabel: '采购单变化',
          identifiers: { sku: 'SKU-1', token: 'drop-me' },
          metrics: { availableQuota: 3, revenue: 999 },
          secretKey: 'drop-me',
        },
        createdAt: '2026-07-26T08:00:00.000Z',
      }],
    },
    actionPool: {
      mode: 'execute',
      writeEnabled: true,
      candidates: [{
        candidateKey: 'candidate-1',
        storeCode: 'DL5477',
        type: 'RESTOCK_ADVICE_REVIEW',
        severity: 'high',
        title: '复核建议',
        reason: '有平台事实',
        evidenceAt: '2026-07-26T08:00:00.000Z',
        payload: { secret: 'drop-me' },
      }],
    },
    system: {
      writeActionsEnabled: true,
      schemaReadiness: {
        supplyReady: true,
        webhookReady: true,
        productIdentityReady: true,
        employeeAccessReady: true,
      },
      environment: 'drop-me',
    },
  });

  assert.equal(dashboard.supply.status, 'available');
  assert.equal(dashboard.supply.purchaseOrderStatus[0].orderCount, 0);
  assert.equal(dashboard.supply.deliveryMilestones[0].deliveryQuantity, null);
  assert.equal(dashboard.supply.inventory[0].inventoryQuantity, 0);
  assert.equal(dashboard.platform.health.ok, true);
  assert.equal(dashboard.platform.health.warehouseReady, null);
  assert.equal(dashboard.platform.health.receiver, null);
  assert.equal(dashboard.platform.health.worker, null);
  assert.equal(dashboard.platform.queue.queued, 0);
  assert.deepEqual(
    dashboard.platform.events[0].safeProjection.identifiers,
    { sku: 'SKU-1' },
  );
  assert.deepEqual(
    dashboard.platform.events[0].safeProjection.metrics,
    { availableQuota: 3 },
  );
  assert.equal(dashboard.actionPool.mode, 'observe_only');
  assert.equal(dashboard.actionPool.writeEnabled, false);
  assert.equal(dashboard.system.writeActionsEnabled, false);
  assert.doesNotMatch(
    JSON.stringify(dashboard),
    /secretKey|appSecretKey|consumerAddress|databaseUrl|drop-me|revenue/i,
  );
});

test('keeps a missing webhook quota unknown and rejects overflowing canonical totals', () => {
  const dashboard = normalizeDashboardData({
    datasetStatus: 'live',
    updatedAt: '2026-07-20T08:30:00.000Z',
    productRanking: [{
      identityLevel: 'CANONICAL_CONFIRMED',
      canonicalProductId: 'canonical-overflow',
      standardProductCode: 'STD-OVERFLOW',
      storeBreakdown: [
        {
          storeCode: 'AA0001',
          unitsSold: {
            today: Number.MAX_SAFE_INTEGER,
            yesterday: 0,
            last7Days: Number.MAX_SAFE_INTEGER,
            last30Days: Number.MAX_SAFE_INTEGER,
          },
        },
        {
          storeCode: 'BB0002',
          unitsSold: {
            today: 1,
            yesterday: 0,
            last7Days: 1,
            last30Days: 1,
          },
        },
      ],
    }],
    platform: {
      status: 'available',
      events: [{
        eventCode: 'OPENAPI_QUOTA',
        safeProjection: { metrics: { availableQuota: null } },
      }],
    },
  });

  assert.deepEqual(dashboard.platform.events[0].safeProjection.metrics, {});
  assert.equal(dashboard.productRanking[0].unitsSold.today, null);
  assert.equal(dashboard.productRanking[0].unitsSold.yesterday, 0);
  assert.equal(dashboard.productRanking[0].unitsSold.last7Days, null);
  assert.equal(dashboard.productRanking[0].unitsSold.last30Days, null);
});

test('missing permission and coverage counts remain unknown instead of becoming zero', () => {
  const dashboard = normalizeDashboardData({
    datasetStatus: 'empty',
    updatedAt: null,
    permission: { status: 'unknown' },
    salesCoverage: { status: 'unknown' },
  });
  assert.equal(dashboard.permission.authorizedStores, null);
  assert.equal(dashboard.permission.totalStores, null);
  assert.equal(dashboard.salesCoverage.coveredStores, null);
  assert.equal(dashboard.salesCoverage.legalZeroStores, null);
  assert.equal(dashboard.salesCoverage.totalStores, null);
  assert.equal(dashboard.salesCoverage.partialStores, null);
  assert.equal(dashboard.salesCoverage.quarantinedRows, null);
  assert.equal(dashboard.salesCoverage.datedRows, null);
  assert.equal(dashboard.salesCoverage.totalRows, null);
});

test('product identity coverage uses the complete ranking and rejects malformed canonical rows', () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    storeCode: `S${String(index).padStart(3, '0')}`,
    sku: `SKU-${index}`,
    name: `Product ${index}`,
    mappingStatus: index < 100 ? 'CONFIRMED' : 'UNMAPPED',
    canonicalProductId: index < 100 ? `CP-${index}` : null,
    standardProductCode: index < 100 ? `STD-${index}` : null,
    unitsSold: { today: 0, yesterday: 0, last7Days: 0, last30Days: index },
  }));
  const dashboard = normalizeDashboardData({
    datasetStatus: 'live',
    updatedAt: '2026-07-26T08:30:00.000Z',
    permission: { status: 'granted', authorizedStores: 1, totalStores: 1 },
    storeSkuRanking: rows,
    productRanking: [{
      identityLevel: 'CANONICAL_CONFIRMED',
      name: 'Malformed canonical',
      unitsSold: { today: 999, last30Days: 999 },
    }],
  });
  assert.equal(dashboard.storeSkuRanking.length, 101);
  assert.equal(dashboard.productIdentityCoverage.confirmedSkus, 100);
  assert.equal(dashboard.productIdentityCoverage.totalSkus, 101);
  assert.equal(dashboard.productIdentityCoverage.missingSpuSkus, 0);
  assert.equal(dashboard.productIdentityCoverage.status, 'partial');
  assert.deepEqual(dashboard.productRanking, []);
  assert.equal(dashboard.rankingMeta.storeSku.truncated, false);
});
