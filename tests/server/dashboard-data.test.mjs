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
  assert.equal(dashboard.schemaVersion, 5);
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

test('whitelists full-managed homepage history while preserving unavailable metrics', () => {
  const dashboard = normalizeDashboardData({
    datasetStatus: 'live',
    updatedAt: '2026-07-29T08:30:00.000Z',
    home: {
      status: 'available',
      coverage: {
        earliestDate: '2026-07-01',
        latestDate: '2026-07-29',
        latestObservedAt: '2026-07-29T08:29:00.000Z',
      },
      storeDaily: [{
        storeCode: 'dl5477',
        date: '2026-07-29',
        currency: 'SAR',
        dealAmount: '123.45',
        netDealAmount: null,
        salesQuantity: 8,
        exposureUsers: 99,
        exposureBasis: 'BRAND_SUMMED',
        qualityStatus: 'PARTIAL',
        sourceCodes: ['WEBAPI_INDEX', 'WEBAPI_ANALYSE'],
        secret: 'drop-me',
      }],
      productDaily: [{
        storeCode: 'DL5477',
        date: '2026-07-29',
        productGrain: 'SPU',
        productKey: 'SPU-1',
        salesQuantity: 3,
        estimatedDealAmount: null,
        estimationBasis: 'UNAVAILABLE',
      }],
      financeDaily: [{
        storeCode: 'dl5477',
        date: '2026-07-29',
        currency: 'sar',
        incomeAmount: '88.25',
        expenseAmount: '100.00',
        netAmount: '-11.75',
        goodsCount: 4,
        reportCount: 1,
        basis: 'FINANCE_DETAIL_BUSINESS_DATE',
        reportOrderNo: 'must-not-leak',
      }],
      ledgerDaily: [{
        storeCode: 'dl5477',
        date: '2026-07-29',
        currency: 'sar',
        beginBalanceCount: 700,
        inboundCount: 20,
        outboundCount: 15,
        endBalanceCount: 705,
        customerOutboundCount: 12,
        beginBalanceAmount: '8000.50',
        outboundAmount: '450.25',
        qualityStatus: 'COMPLETE',
        basis: 'OFFICIAL_INVENTORY_LEDGER',
        rawResponse: 'must-not-leak',
      }],
      billDaily: [{
        storeCode: 'dl5477',
        date: '2026-07-29',
        currency: 'sar',
        salesAmount: '16631.27',
        supplementAmount: '20.00',
        deductionAmount: '207.09',
        calculatedSettlementAmount: '16444.18',
        reportedSettlementAmount: '16444.18',
        reportCount: 3,
        settledReportCount: 3,
        pendingReportCount: 0,
        reconciliationStatus: 'MATCHED',
        basis: 'ACTUAL_SETTLEMENT_DATE',
        reportOrderNoHash: 'must-not-leak',
      }],
      settlementPositionDaily: [{
        storeCode: 'dl5477',
        date: '2026-07-29',
        currency: 'sar',
        pendingSettlementAmount: '2400.50',
        pendingReportCount: 3,
        overdueReportCount: 1,
        earliestEstimatedPayDate: '2026-07-30',
        latestEstimatedPayDate: '2026-08-10',
        observedAt: '2026-07-29T08:28:00.000Z',
        basis: 'END_OF_PERIOD_PENDING_POSITION',
        reportOrderNoHash: 'must-not-leak',
      }],
    },
  });

  assert.equal(dashboard.home.storeDaily[0].storeCode, 'DL5477');
  assert.equal(dashboard.home.storeDaily[0].dealAmount, 123.45);
  assert.equal(dashboard.home.storeDaily[0].netDealAmount, null);
  assert.equal(dashboard.home.storeDaily[0].exposureBasis, 'BRAND_SUMMED');
  assert.equal(dashboard.home.productDaily[0].estimatedDealAmount, null);
  assert.equal(dashboard.home.financeDaily[0].currency, 'SAR');
  assert.equal(dashboard.home.financeDaily[0].netAmount, -11.75);
  assert.equal(dashboard.home.financeDaily[0].basis, 'FINANCE_DETAIL_BUSINESS_DATE');
  assert.equal(dashboard.home.ledgerDaily[0].customerOutboundCount, 12);
  assert.equal(dashboard.home.ledgerDaily[0].outboundAmount, 450.25);
  assert.equal(
    dashboard.home.ledgerDaily[0].basis,
    'OFFICIAL_INVENTORY_LEDGER',
  );
  assert.equal(dashboard.home.billDaily[0].salesAmount, 16631.27);
  assert.equal(dashboard.home.billDaily[0].reconciliationStatus, 'MATCHED');
  assert.equal(
    dashboard.home.settlementPositionDaily[0].pendingSettlementAmount,
    2400.5,
  );
  assert.equal(dashboard.home.settlementPositionDaily[0].overdueReportCount, 1);
  assert.equal(
    dashboard.home.settlementPositionDaily[0].basis,
    'END_OF_PERIOD_PENDING_POSITION',
  );
  assert.equal(dashboard.home.coverage.storeDailyRows, 1);
  assert.equal(dashboard.home.coverage.ledgerDailyRows, 1);
  assert.equal(dashboard.home.coverage.billDailyRows, 1);
  assert.equal(dashboard.home.coverage.settlementPositionDailyRows, 1);
  assert.doesNotMatch(
    JSON.stringify(dashboard.home),
    /secret|drop-me|reportOrderNo|rawResponse/,
  );
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
      mixedStatisticsDateStores: 0,
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
  assert.equal(dashboard.salesCoverage.mixedStatisticsDateStores, 0);
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
      eventMeta: {
        returned: 1,
        limit: 100,
        truncated: false,
        secret: 'drop-me',
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
  assert.deepEqual(dashboard.platform.eventMeta, {
    returned: 1,
    limit: 100,
    truncated: false,
  });
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
  assert.deepEqual(dashboard.actionPool.meta, {
    total: 1,
    returned: 1,
    truncated: false,
  });
  assert.equal(dashboard.system.writeActionsEnabled, false);
  assert.doesNotMatch(
    JSON.stringify(dashboard),
    /secretKey|appSecretKey|consumerAddress|databaseUrl|drop-me|revenue/i,
  );
});

test('normalizes detailed supply attention without inventing unknown values or dropping decimals', () => {
  const dashboard = normalizeDashboardData({
    datasetStatus: 'live',
    updatedAt: '2026-07-26T08:30:00.000Z',
    supply: {
      status: 'available',
      purchaseOrderAttention: [{
        storeCode: 'dl5477',
        storeName: 'DL5477',
        orderNo: 'PO-1',
        statusCode: null,
        statusName: null,
        orderTypeName: '首单',
        warehouseName: null,
        requestedDeliveryAt: '2026-07-25T00:00:00.000Z',
        requestedReceiptAt: null,
        deliveredAt: null,
        receivedAt: null,
        storedAt: null,
        lineCount: 2,
        orderQuantity: null,
        deliveryQuantity: 0,
        receiptQuantity: null,
        storageQuantity: null,
        defectiveQuantity: null,
        attentionCode: 'DELIVERY_OVERDUE',
        attentionLabel: '采购单已超过要求交付时间',
        severity: 'critical',
        latestSourceFetchedAt: '2026-07-26T08:00:00.000Z',
        contactPerson: 'drop-me',
      }],
      deliveryAttention: [{
        storeCode: 'DL5477',
        storeName: 'DL5477',
        deliveryCode: 'DELIVERY-1',
        milestoneCode: 'IN_TRANSIT',
        warehouseName: '华南仓',
        expressCode: null,
        expressCompanyName: null,
        reservedParcelAt: null,
        takenAt: '2026-07-24T08:00:00.000Z',
        expectedReceiptAt: '2026-07-25T00:00:00.000Z',
        receivedAt: null,
        lineCount: 1,
        deliveryQuantity: null,
        attentionCode: 'RECEIPT_OVERDUE',
        attentionLabel: '送货单已超过预计收货时间',
        severity: 'critical',
      }],
      inventoryRisks: [{
        storeCode: 'DL5477',
        storeName: 'DL5477',
        skuCode: 'SKU-1',
        skcName: null,
        spuName: 'SPU-1',
        inventoryTypeCode: 'PI',
        totalInventory: 8,
        usableInventory: 3,
        transitQuantity: null,
        shortageQuantity: 5,
        reconciliationStatus: 'MISMATCH',
        severity: 'critical',
      }],
      stockAdviceRisks: [{
        storeCode: 'DL5477',
        storeName: 'DL5477',
        skuCode: 'SKU-1',
        skcName: 'SKC-1',
        spuName: 'SPU-1',
        supplierCode: 'SUPPLIER-1',
        predictedDailySales: '1.25',
        pendingOrderQuantity: null,
        pendingDeliveryQuantity: 0,
        pendingShelfQuantity: 2,
        transitQuantity: null,
        stockQuantity: 3,
        advisedOrderQuantity: 4,
        placedOrderQuantity: null,
        plannedUrgentQuantity: 2,
        supplyStatusCode: null,
        shelfStatusCode: 'ON_SHELF',
        stockWarningStatusCode: 'WARN',
        stockWarningIsWarning: true,
        severity: 'critical',
      }],
      attentionMeta: {
        purchaseOrders: { total: 250, returned: 1, truncated: true },
        deliveries: { total: 1, returned: 1, truncated: false },
        inventoryRisks: { total: 1, returned: 1, truncated: false },
        stockAdviceRisks: { total: 1, returned: 1, truncated: false },
      },
    },
    actionPool: {
      candidates: Array.from({ length: 101 }, (_, index) => ({
        candidateKey: `candidate-${index}`,
        storeCode: 'DL5477',
        type: 'SKU_SHORTAGE_REVIEW',
        severity: 'critical',
        title: '处理SKU缺货',
        reason: '平台缺货',
      })),
    },
  });

  assert.equal(dashboard.supply.purchaseOrderAttention[0].statusCode, null);
  assert.equal(dashboard.supply.purchaseOrderAttention[0].orderQuantity, null);
  assert.equal(dashboard.supply.purchaseOrderAttention[0].deliveryQuantity, 0);
  assert.equal(dashboard.supply.deliveryAttention[0].deliveryQuantity, null);
  assert.equal(dashboard.supply.inventoryRisks[0].skuCode, 'SKU-1');
  assert.equal(dashboard.supply.inventoryRisks[0].transitQuantity, null);
  assert.equal(dashboard.supply.stockAdviceRisks[0].predictedDailySales, 1.25);
  assert.equal(dashboard.supply.stockAdviceRisks[0].pendingOrderQuantity, null);
  assert.equal(dashboard.supply.stockAdviceRisks[0].pendingDeliveryQuantity, 0);
  assert.equal(dashboard.supply.stockAdviceRisks[0].stockWarningIsWarning, true);
  assert.deepEqual(dashboard.supply.attentionMeta.purchaseOrders, {
    available: true,
    total: 250,
    returned: 1,
    truncated: true,
  });
  assert.equal(dashboard.actionPool.candidates.length, 100);
  assert.deepEqual(dashboard.actionPool.meta, {
    total: 101,
    returned: 100,
    truncated: true,
  });
  assert.doesNotMatch(JSON.stringify(dashboard), /contactPerson|drop-me/i);
});

test('distinguishes an unavailable attention contract from an available empty result', () => {
  const legacy = normalizeDashboardData({
    supply: {
      status: 'available',
      purchaseOrderStatus: [],
    },
  });
  assert.deepEqual(legacy.supply.attentionMeta.purchaseOrders, {
    available: false,
    total: 0,
    returned: 0,
    truncated: false,
  });

  const empty = normalizeDashboardData({
    supply: {
      status: 'available',
      purchaseOrderAttention: [],
      attentionMeta: {
        deliveries: { total: 0, returned: 0, truncated: false },
      },
    },
  });
  assert.equal(empty.supply.attentionMeta.purchaseOrders.available, true);
  assert.equal(empty.supply.attentionMeta.deliveries.available, true);
  assert.equal(empty.supply.attentionMeta.inventoryRisks.available, false);
  assert.equal(empty.supply.attentionMeta.stockAdviceRisks.available, false);
});

test('preserves legal upstream ranking coverage and rejects inconsistent counts', () => {
  const dashboard = normalizeDashboardData({
    datasetStatus: 'live',
    updatedAt: '2026-07-27T08:30:00.000Z',
    storeRanking: [{
      code: 'DL5477',
      unitsSold: { today: 1, yesterday: 0, last7Days: 1, last30Days: 1 },
    }],
    storeSkuRanking: [{
      storeCode: 'DL5477',
      sku: 'SKU-1',
      unitsSold: { today: 1, yesterday: 0, last7Days: 1, last30Days: 1 },
    }],
    productRanking: [{
      storeCode: 'DL5477',
      productKey: 'DL5477:SKU-1',
      unitsSold: { today: 1, yesterday: 0, last7Days: 1, last30Days: 1 },
    }],
    rankingMeta: {
      store: { returned: 1, total: 1, truncated: true },
      sku: { returnedCount: 1, totalCount: 800, truncated: false },
      product: { returned: 0, total: 9, truncated: true },
    },
  });

  assert.deepEqual(dashboard.rankingMeta.store, {
    returnedCount: 1,
    totalCount: 1,
    truncated: true,
  });
  assert.deepEqual(dashboard.rankingMeta.storeSku, {
    returnedCount: 1,
    totalCount: 800,
    truncated: true,
  });
  assert.deepEqual(dashboard.rankingMeta.product, {
    returnedCount: 1,
    totalCount: 1,
    truncated: false,
  });
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
  assert.equal(dashboard.salesCoverage.mixedStatisticsDateStores, null);
  assert.equal(dashboard.salesCoverage.quarantinedRows, null);
  assert.equal(dashboard.salesCoverage.datedRows, null);
  assert.equal(dashboard.salesCoverage.totalRows, null);
});

test('mixed statistics date store count is bounded by the trusted store total', () => {
  const dashboard = normalizeDashboardData({
    datasetStatus: 'live',
    permission: { status: 'granted', authorizedStores: 25, totalStores: 25 },
    salesCoverage: {
      status: 'partial',
      totalStores: 999,
      mixedStatisticsDateStores: 999,
    },
  });

  assert.equal(dashboard.salesCoverage.totalStores, 25);
  assert.equal(dashboard.salesCoverage.mixedStatisticsDateStores, 25);
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

test('active-catalog identity coverage is independent from dated sales ranking rows', () => {
  const dashboard = normalizeDashboardData({
    datasetStatus: 'live',
    updatedAt: '2026-07-27T08:30:00.000Z',
    storeSkuRanking: [{
      storeCode: 'DL',
      sku: 'SKU-WITH-SALES',
      mappingStatus: 'CONFIRMED',
      unitsSold: { today: 1, yesterday: 0, last7Days: 1, last30Days: 1 },
    }],
    productIdentityCoverage: {
      basis: 'active_catalog',
      confirmedSkus: 262,
      totalSkus: 10_050,
      missingSpuSkus: 38,
      coverageRate: 1,
      note: 'untrusted source note',
    },
  });

  assert.deepEqual(dashboard.productIdentityCoverage, {
    basis: 'active_catalog',
    confirmedSkus: 262,
    totalSkus: 10_050,
    unconfirmedSkus: 9_788,
    missingSpuSkus: 38,
    coverageRate: 0.0261,
    status: 'partial',
    note: '全量活跃商品目录 262/10050 个SKU已确认；38 个缺少平台SPU；覆盖口径不依赖销量业务日',
  });
  assert.equal(dashboard.storeSkuRanking.length, 1);

  const malformed = normalizeDashboardData({
    storeSkuRanking: [{
      storeCode: 'DL',
      sku: 'SKU-WITH-SALES',
      mappingStatus: 'CONFIRMED',
      unitsSold: { today: 1, yesterday: 0, last7Days: 1, last30Days: 1 },
    }],
    productIdentityCoverage: {
      basis: 'active_catalog',
      confirmedSkus: 2,
      totalSkus: 3,
      missingSpuSkus: 2,
    },
  });
  assert.equal(malformed.productIdentityCoverage.basis, 'sales_ranking');
  assert.equal(malformed.productIdentityCoverage.totalSkus, 1);
});

test('the identity pipeline whitelist keeps aggregate counts and drops raw evidence', () => {
  const dashboard = normalizeDashboardData({
    updatedAt: '2026-07-29T02:00:00.000Z',
    productIdentityPipeline: {
      status: 'available',
      basis: 'identity_resolution_schema',
      note: '计数来自最新一次密封证据run',
      evidence: {
        sealedSetCount: 10_012,
        observedStoreCount: 24,
        identifierMemberCount: 364_545,
        latestSealedAt: '2026-07-29T01:00:00.000Z',
        // Values that must never survive the whitelist.
        observationRunId: 'RUN-SECRET',
        setPayloadFingerprint: 'a'.repeat(64),
        rawValue: 'GTIN-0000000000000',
      },
      candidates: {
        total: 482,
        confirmed: 482,
        proposed: 0,
        reviewRequired: 0,
        blocked: 0,
        globalScope: 482,
        localSingletonScope: 0,
        latestEvaluatedAt: '2026-07-29T01:10:00.000Z',
        matchedEvidence: [{ type: 'BARCODE', value: '0000000000000' }],
      },
      decisions: {
        confirmedCount: 482,
        latestDecidedAt: '2026-07-29T01:20:00.000Z',
        actorKey: 'auto-matcher',
        rationale: 'must not be returned',
      },
      assignments: {
        currentConfirmedCount: 482,
        latestAssignedAt: '2026-07-29T01:30:00.000Z',
      },
      canonical: { globalActiveProductCount: 66, activeVariantCount: 66 },
      updatedAt: '2026-07-29T01:30:00.000Z',
      credentials: { appSecret: 'must not be returned' },
      dataFile: '/srv/full-bi/private/dashboard.json',
    },
  });
  const pipeline = dashboard.productIdentityPipeline;

  assert.equal(pipeline.status, 'available');
  assert.equal(pipeline.basis, 'identity_resolution_schema');
  assert.deepEqual(Object.keys(pipeline).sort(), [
    'assignments', 'basis', 'candidates', 'canonical',
    'decisions', 'evidence', 'note', 'status', 'updatedAt',
  ]);
  assert.deepEqual(pipeline.evidence, {
    sealedSetCount: 10_012,
    observedStoreCount: 24,
    identifierMemberCount: 364_545,
    latestSealedAt: '2026-07-29T01:00:00.000Z',
  });
  assert.deepEqual(pipeline.candidates, {
    total: 482,
    confirmed: 482,
    proposed: 0,
    reviewRequired: 0,
    blocked: 0,
    globalScope: 482,
    localSingletonScope: 0,
    latestEvaluatedAt: '2026-07-29T01:10:00.000Z',
  });
  assert.deepEqual(pipeline.decisions, {
    confirmedCount: 482,
    latestDecidedAt: '2026-07-29T01:20:00.000Z',
  });
  assert.deepEqual(pipeline.canonical, {
    globalActiveProductCount: 66,
    activeVariantCount: 66,
  });
  assert.equal(pipeline.updatedAt, '2026-07-29T01:30:00.000Z');

  const serialized = JSON.stringify(dashboard);
  assert.doesNotMatch(serialized, /RUN-SECRET/);
  assert.doesNotMatch(serialized, /a{64}/);
  assert.doesNotMatch(serialized, /GTIN-0000000000000/);
  assert.doesNotMatch(serialized, /appSecret|must not be returned/);
  assert.doesNotMatch(serialized, /srv\/full-bi\/private/);
  assert.doesNotMatch(serialized, /auto-matcher|matchedEvidence|rationale/);
});

test('an unavailable identity pipeline stays unknown instead of reporting zero', () => {
  const missing = normalizeDashboardData({ updatedAt: '2026-07-29T02:00:00.000Z' });
  const pipeline = missing.productIdentityPipeline;
  assert.equal(pipeline.status, 'unavailable');
  assert.equal(pipeline.basis, 'schema_unavailable');
  assert.match(pipeline.note, /未知/);
  assert.equal(pipeline.evidence.sealedSetCount, null);
  assert.equal(pipeline.evidence.latestSealedAt, null);
  assert.equal(pipeline.candidates.total, null);
  assert.equal(pipeline.decisions.confirmedCount, null);
  assert.equal(pipeline.assignments.currentConfirmedCount, null);
  assert.equal(pipeline.canonical.globalActiveProductCount, null);
  assert.equal(pipeline.updatedAt, null);

  // A payload that claims unavailable can never smuggle counts back in.
  const claimed = normalizeDashboardData({
    updatedAt: '2026-07-29T02:00:00.000Z',
    productIdentityPipeline: {
      status: 'unavailable',
      basis: 'identity_resolution_schema',
      evidence: { sealedSetCount: 10_012, latestSealedAt: '2026-07-29T01:00:00.000Z' },
      canonical: { globalActiveProductCount: 66 },
      updatedAt: '2026-07-29T01:30:00.000Z',
    },
  });
  assert.equal(claimed.productIdentityPipeline.status, 'unavailable');
  assert.equal(claimed.productIdentityPipeline.basis, 'schema_unavailable');
  assert.equal(claimed.productIdentityPipeline.evidence.sealedSetCount, null);
  assert.equal(claimed.productIdentityPipeline.canonical.globalActiveProductCount, null);
  assert.equal(claimed.productIdentityPipeline.updatedAt, null);
});

test('malformed pipeline relationships degrade to null and partial, never invented zero', () => {
  const dashboard = normalizeDashboardData({
    updatedAt: '2026-07-29T02:00:00.000Z',
    productIdentityPipeline: {
      status: 'available',
      evidence: {
        // A sealed set always carries at least one member, so 3 members under
        // 10 sets is inconsistent evidence rather than a smaller real number.
        sealedSetCount: 10,
        identifierMemberCount: 3,
        observedStoreCount: -2,
        latestSealedAt: 'not-a-date',
      },
      candidates: {
        total: 5,
        // A recommendation bucket cannot exceed its own total.
        confirmed: 9,
        proposed: 2,
        blocked: 'many',
      },
      // A current confirmed assignment always has a confirmed decision behind it.
      decisions: { confirmedCount: 1 },
      assignments: { currentConfirmedCount: 7 },
      canonical: { globalActiveProductCount: 4, activeVariantCount: 1 },
    },
  });
  const pipeline = dashboard.productIdentityPipeline;

  assert.equal(pipeline.evidence.sealedSetCount, 10);
  assert.equal(pipeline.evidence.identifierMemberCount, null);
  assert.equal(pipeline.evidence.observedStoreCount, null);
  assert.equal(pipeline.evidence.latestSealedAt, null);
  assert.equal(pipeline.candidates.total, 5);
  assert.equal(pipeline.candidates.confirmed, null);
  assert.equal(pipeline.candidates.proposed, 2);
  assert.equal(pipeline.candidates.blocked, null);
  assert.equal(pipeline.assignments.currentConfirmedCount, null);
  // A canonical product may legitimately have fewer variants than products.
  assert.equal(pipeline.canonical.activeVariantCount, 1);
  // A stage that lost its count downgrades the whole aggregate to partial.
  assert.equal(pipeline.status, 'partial');
});

test('purchase attention normalization matches the 500-row materialization cap', () => {
  const attentionRow = (index) => ({
    storeCode: 'DL5477',
    storeName: 'DL5477',
    orderNo: `PO-${String(index).padStart(4, '0')}`,
    attentionCode: 'OPEN_PURCHASE_ORDER',
    attentionLabel: '采购单待交付',
    severity: 'medium',
    orderQuantity: 1,
  });
  const dashboard = normalizeDashboardData({
    updatedAt: '2026-07-29T00:00:00.000Z',
    supply: {
      status: 'available',
      purchaseOrderAttention: Array.from({ length: 620 }, (unused, index) => attentionRow(index)),
      attentionMeta: {
        purchaseOrders: { available: true, total: 620, returned: 500, truncated: true },
      },
    },
  });

  // Production currently materializes 352 attention rows. A 200-row normalizer
  // cap would silently re-truncate the snapshot after the materializer already
  // wrote the full set, so the whole 500-row cap increase would have no effect.
  assert.equal(dashboard.supply.purchaseOrderAttention.length, 500);
  assert.ok(dashboard.supply.purchaseOrderAttention.length > 352);
  // Above the cap the truncation stays honest rather than claiming completeness.
  assert.equal(dashboard.supply.attentionMeta.purchaseOrders.truncated, true);
  assert.equal(dashboard.supply.attentionMeta.purchaseOrders.total, 620);

  // The full current attention set survives normalization untouched.
  const exact = normalizeDashboardData({
    updatedAt: '2026-07-29T00:00:00.000Z',
    supply: {
      status: 'available',
      purchaseOrderAttention: Array.from({ length: 352 }, (unused, index) => attentionRow(index)),
      attentionMeta: {
        purchaseOrders: { available: true, total: 352, returned: 352, truncated: false },
      },
    },
  });
  assert.equal(exact.supply.purchaseOrderAttention.length, 352);
  assert.equal(exact.supply.attentionMeta.purchaseOrders.truncated, false);
});
