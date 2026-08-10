import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProcurementQueryError,
  queryProcurementDashboard,
} from '../../src/server/procurement-query.mjs';

/**
 * Attention codes below are the exact values `src/warehouse/supply-repository.mjs`
 * emits: DELIVERY_OVERDUE, RECEIPT_OVERDUE, DEFECTIVE_QUANTITY,
 * RECEIVED_PENDING_STORAGE, DELIVERED_PENDING_RECEIPT and OPEN_PURCHASE_ORDER.
 * The previous fixture invented codes that only matched by substring.
 */
const DASHBOARD = Object.freeze({
  updatedAt: '2026-07-29T00:00:00.000Z',
  businessDate: '2026-07-28',
  dataset: { status: 'live' },
  owners: [
    { key: 'alice', name: 'Alice', storeCodes: ['DL5477'] },
    { key: 'bob', name: 'Bob', storeCodes: ['MZ2406'] },
  ],
  supply: {
    status: 'available',
    coverage: {
      domains: {
        purchaseOrders: {
          status: 'partial',
          succeededStores: 23,
          succeededStoreCodes: ['DL5477'],
          totalStores: 25,
          inProgressStores: 1,
          inProgressStoreCodes: ['FY4021'],
          failedStores: 0,
          missingStores: 0,
          staleStores: 0,
          watermarkStart: '2026-07-26T22:47:08.000Z',
          watermarkEnd: '2026-07-29T00:45:19.000Z',
          latestFetchedAt: '2026-07-29T00:00:00.000Z',
        },
      },
    },
    attentionMeta: {
      purchaseOrders: { available: true, total: 352, returned: 352, truncated: false },
    },
    purchaseOrderStatus: [
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        statusCode: 'WAIT_DELIVERY',
        statusName: '待交付',
        orderCount: 8,
        latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
      },
      {
        storeCode: 'MZ2406',
        storeName: 'MZ2406',
        statusCode: 'WAIT_DELIVERY',
        statusName: '待交付',
        orderCount: null,
        latestSourceFetchedAt: '2026-07-28T23:00:00.000Z',
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        statusCode: 'COMPLETED',
        statusName: '已完成',
        orderCount: 40,
        latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
      },
    ],
    purchaseOrderAttention: [
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        orderNo: 'PO-003',
        statusCode: 'WAIT_DELIVERY',
        statusName: '待交付',
        attentionCode: 'OPEN_PURCHASE_ORDER',
        attentionLabel: '采购单待交付',
        severity: 'high',
        requestedDeliveryAt: '2026-07-27T00:00:00.000Z',
        latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
        orderQuantity: 100,
        deliveryQuantity: 40,
        receiptQuantity: 10,
        storageQuantity: 0,
        defectiveQuantity: 0,
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        orderNo: 'PO-001',
        statusCode: 'WAIT_DELIVERY',
        statusName: '待交付',
        attentionCode: 'DELIVERY_OVERDUE',
        attentionLabel: '逾期待交付',
        severity: 'critical',
        requestedDeliveryAt: '2026-07-26T00:00:00.000Z',
        latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
        orderQuantity: 60,
        deliveryQuantity: 0,
        receiptQuantity: 0,
        storageQuantity: 0,
        defectiveQuantity: 0,
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        orderNo: 'PO-002',
        statusCode: 'WAIT_DELIVERY',
        statusName: '待交付',
        attentionCode: 'OPEN_PURCHASE_ORDER',
        attentionLabel: '采购单待交付',
        severity: 'medium',
        requestedDeliveryAt: null,
        latestSourceFetchedAt: '2026-07-28T22:00:00.000Z',
        orderQuantity: null,
        deliveryQuantity: 5,
        receiptQuantity: null,
        storageQuantity: 0,
        defectiveQuantity: 0,
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        orderNo: 'PO-STORAGE',
        statusCode: 'RECEIVED',
        statusName: '已收货',
        attentionCode: 'RECEIVED_PENDING_STORAGE',
        attentionLabel: '已收货待入库',
        severity: 'medium',
        requestedDeliveryAt: '2026-07-24T00:00:00.000Z',
        latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
        orderQuantity: 30,
        deliveryQuantity: 30,
        receiptQuantity: 30,
        storageQuantity: 0,
        defectiveQuantity: 0,
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        orderNo: 'PO-RECEIPT',
        statusCode: 'DELIVERED',
        statusName: '已交付',
        attentionCode: 'DELIVERED_PENDING_RECEIPT',
        attentionLabel: '已交付待收货',
        severity: 'medium',
        requestedDeliveryAt: '2026-07-23T00:00:00.000Z',
        latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
        orderQuantity: 20,
        deliveryQuantity: 20,
        receiptQuantity: 0,
        storageQuantity: 0,
        defectiveQuantity: 0,
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        orderNo: 'PO-RECEIPT-LATE',
        statusCode: 'DELIVERED',
        statusName: '已交付',
        attentionCode: 'RECEIPT_OVERDUE',
        attentionLabel: '逾期待收货',
        severity: 'critical',
        requestedDeliveryAt: '2026-07-22T00:00:00.000Z',
        latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
        orderQuantity: 15,
        deliveryQuantity: 15,
        receiptQuantity: 0,
        storageQuantity: 0,
        defectiveQuantity: 0,
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        orderNo: 'PO-DEFECT',
        statusCode: 'RECEIVED',
        statusName: '已收货',
        attentionCode: 'DEFECTIVE_QUANTITY',
        attentionLabel: '存在残次数量',
        severity: 'high',
        requestedDeliveryAt: '2026-07-21T00:00:00.000Z',
        latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
        orderQuantity: 50,
        deliveryQuantity: 50,
        receiptQuantity: 50,
        storageQuantity: 45,
        defectiveQuantity: 5,
      },
      {
        // A defective quantity recorded under a higher-priority attention code
        // still belongs to the DEFECTIVE quick filter.
        storeCode: 'DL5477',
        storeName: 'DL5477',
        orderNo: 'PO-DEFECT-OVERDUE',
        statusCode: 'WAIT_DELIVERY',
        statusName: '待交付',
        attentionCode: 'DELIVERY_OVERDUE',
        attentionLabel: '逾期待交付',
        severity: 'critical',
        requestedDeliveryAt: '2026-07-20T00:00:00.000Z',
        latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
        orderQuantity: 70,
        deliveryQuantity: 10,
        receiptQuantity: 0,
        storageQuantity: 0,
        defectiveQuantity: 3,
      },
      {
        storeCode: 'MZ2406',
        storeName: 'MZ2406',
        orderNo: 'MZ-001',
        statusCode: 'WAIT_DELIVERY',
        statusName: '待交付',
        attentionCode: 'OPEN_PURCHASE_ORDER',
        attentionLabel: '采购单待交付',
        severity: 'high',
        requestedDeliveryAt: '2026-07-25T00:00:00.000Z',
        latestSourceFetchedAt: '2026-07-28T23:00:00.000Z',
        orderQuantity: 90,
        deliveryQuantity: 0,
        receiptQuantity: 0,
        storageQuantity: 0,
        defectiveQuantity: 0,
      },
    ],
  },
});

test('procurement query applies owner, quick filter, deterministic sort and pagination', () => {
  const result = queryProcurementDashboard(
    DASHBOARD,
    new URLSearchParams({
      owner: 'alice',
      quick: 'PENDING_DELIVERY',
      page: '1',
      pageSize: '25',
      sort: 'PRIORITY',
    }),
  );
  assert.equal(result.readOnly, true);
  assert.equal(result.summary.orderCount, 48);
  assert.equal(result.summary.coverageComplete, true);
  // PENDING_DELIVERY = OPEN_PURCHASE_ORDER or DELIVERY_OVERDUE, alice-scoped.
  assert.equal(result.summary.matchedMaterializedAttentionCount, 4);
  assert.equal(result.attention.pagination.pageCount, 1);
  assert.equal(result.attention.pagination.hasNext, false);
  // Critical first, then by requested delivery deadline, unknown deadline last.
  assert.deepEqual(
    result.attention.rows.map((row) => row.orderNo),
    ['PO-DEFECT-OVERDUE', 'PO-001', 'PO-003', 'PO-002'],
  );
  assert.deepEqual(result.source.materializedAttention, {
    available: true,
    total: 352,
    returned: 352,
    truncated: false,
  });
  assert.deepEqual(result.summary.attentionByStore, [{
    storeCode: 'DL5477',
    storeName: 'DL5477',
    attentionCount: 4,
    overdueCount: 2,
    pendingDeliveryCount: 4,
    pendingReceiptCount: 0,
    pendingStorageCount: 0,
    defectiveCount: 1,
    pendingDeliveryQuantity: {
      rowCount: 4,
      knownCount: 3,
      unknownCount: 1,
      knownSum: 180,
      total: null,
    },
    pendingReceiptQuantity: {
      rowCount: 0,
      knownCount: 0,
      unknownCount: 0,
      knownSum: null,
      total: null,
    },
    pendingStorageQuantity: {
      rowCount: 0,
      knownCount: 0,
      unknownCount: 0,
      knownSum: null,
      total: null,
    },
    latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
  }]);

  // Bounded paging keeps its own page window without inventing rows.
  const secondPage = queryProcurementDashboard(
    DASHBOARD,
    new URLSearchParams({
      owner: 'alice', quick: 'PENDING_DELIVERY', page: '2', pageSize: '25',
    }),
  );
  assert.deepEqual(secondPage.attention.rows, []);
  assert.equal(secondPage.attention.pagination.hasPrevious, true);
  assert.equal(secondPage.attention.pagination.matchedMaterializedRows, 4);
});

test('quick filters map to explicit attention codes, never substrings', () => {
  const codesFor = (quick) => queryProcurementDashboard(
    DASHBOARD,
    new URLSearchParams({ quick, pageSize: '100' }),
  ).attention.rows.map((row) => row.attentionCode);

  assert.deepEqual([...new Set(codesFor('OVERDUE'))].sort(), [
    'DELIVERY_OVERDUE', 'RECEIPT_OVERDUE',
  ]);
  assert.deepEqual([...new Set(codesFor('PENDING_DELIVERY'))].sort(), [
    'DELIVERY_OVERDUE', 'OPEN_PURCHASE_ORDER',
  ]);
  assert.deepEqual([...new Set(codesFor('PENDING_RECEIPT'))].sort(), [
    'DELIVERED_PENDING_RECEIPT', 'RECEIPT_OVERDUE',
  ]);
  // The old substring match leaked RECEIVED_PENDING_STORAGE into PENDING_RECEIPT.
  assert.ok(!codesFor('PENDING_RECEIPT').includes('RECEIVED_PENDING_STORAGE'));
  assert.deepEqual([...new Set(codesFor('PENDING_STORAGE'))], ['RECEIVED_PENDING_STORAGE']);
  // PENDING_STORAGE must not absorb the plain DELIVERED_PENDING_RECEIPT rows.
  assert.ok(!codesFor('PENDING_STORAGE').includes('DELIVERED_PENDING_RECEIPT'));

  // DEFECTIVE matches the code or a positive defective quantity on any row.
  assert.deepEqual(
    queryProcurementDashboard(
      DASHBOARD,
      new URLSearchParams({ quick: 'DEFECTIVE', pageSize: '100' }),
    ).attention.rows.map((row) => row.orderNo).sort(),
    ['PO-DEFECT', 'PO-DEFECT-OVERDUE'],
  );

  // HIGH is severity based and independent of the attention code.
  const high = queryProcurementDashboard(
    DASHBOARD,
    new URLSearchParams({ quick: 'HIGH', pageSize: '100' }),
  );
  assert.ok(high.attention.rows.every((row) => ['critical', 'high'].includes(row.severity)));
  assert.equal(high.attention.rows.length, 6);

  const all = queryProcurementDashboard(DASHBOARD, new URLSearchParams({ pageSize: '100' }));
  assert.equal(all.attention.rows.length, 9);
});

test('stage quantities describe the materialized attention scope, not a funnel', () => {
  const result = queryProcurementDashboard(
    DASHBOARD,
    new URLSearchParams({ quick: 'PENDING_STORAGE', pageSize: '25' }),
  );
  const stages = result.summary.quantityStages;
  assert.equal(stages.order.total, 30);
  assert.equal(stages.delivery.total, 30);
  assert.equal(stages.receipt.total, 30);
  assert.equal(stages.storage.total, 0);
  assert.equal(stages.defective.total, 0);
  assert.match(result.summary.attentionScopeLabel, /不是转化漏斗/);
  // No ratio or percentage is ever derived from the stage quantities.
  assert.doesNotMatch(JSON.stringify(result.summary), /rate|percent|conversion|funnel/i);

  // One unknown quantity keeps the stage total unknown while the known part
  // stays visible.
  const withUnknown = queryProcurementDashboard(
    DASHBOARD,
    new URLSearchParams({ owner: 'alice', quick: 'PENDING_DELIVERY', pageSize: '25' }),
  );
  assert.equal(withUnknown.summary.quantityStages.order.total, null);
  assert.equal(withUnknown.summary.quantityStages.order.knownSum, 230);
  assert.equal(withUnknown.summary.quantityStages.order.unknownCount, 1);
  assert.equal(withUnknown.summary.quantityStages.order.knownCount, 3);
  assert.equal(withUnknown.summary.quantityStages.receipt.unknownCount, 1);
  // Order count comes from the status snapshot and stays a separate scope.
  assert.equal(withUnknown.summary.orderCount, 48);
  assert.notEqual(
    withUnknown.summary.orderCount,
    withUnknown.summary.quantityStages.order.knownSum,
  );
});

test('the scoped status overview is aggregated per status, never one row per store', () => {
  const result = queryProcurementDashboard(DASHBOARD, new URLSearchParams({ pageSize: '25' }));
  assert.equal(result.summary.coverageComplete, false);
  assert.equal(result.summary.orderCount, null);
  assert.deepEqual(result.statusOverview, [
    { statusCode: 'COMPLETED', statusName: '已完成', storeCount: 1, orderCount: 40 },
    // MZ2406 has an unknown order count, so the WAIT_DELIVERY total is unknown.
    { statusCode: 'WAIT_DELIVERY', statusName: '待交付', storeCount: 2, orderCount: null },
  ]);
  assert.ok(result.statusOverview.length < result.statusRows.length);

  const scoped = queryProcurementDashboard(
    DASHBOARD,
    new URLSearchParams({ owner: 'alice', pageSize: '25' }),
  );
  assert.deepEqual(
    scoped.statusOverview.map((row) => [row.statusCode, row.orderCount]),
    [['COMPLETED', 40], ['WAIT_DELIVERY', 8]],
  );
  assert.deepEqual(
    result.summary.attentionCodes.find((row) => row.code === 'OPEN_PURCHASE_ORDER'),
    { code: 'OPEN_PURCHASE_ORDER', count: 3 },
  );
});

test('unknown quantities stay null and materialized counts never impersonate source total', () => {
  const result = queryProcurementDashboard(
    DASHBOARD,
    new URLSearchParams({ store: 'MZ2406' }),
  );
  assert.equal(result.summary.orderCount, null);
  assert.equal(result.summary.matchedMaterializedAttentionCount, 1);
  assert.equal(result.source.materializedAttention.total, 352);
  assert.equal(result.attention.pagination.matchedMaterializedRows, 1);
  // Coverage and watermark evidence passes through exactly.
  assert.equal(result.source.coverage.succeededStores, 23);
  assert.equal(result.source.coverage.totalStores, 25);
  assert.deepEqual(result.source.coverage.inProgressStoreCodes, ['FY4021']);
  assert.equal(result.source.coverage.watermarkEnd, '2026-07-29T00:45:19.000Z');
});

test('stale aggregate COMPLETE cannot authorize an exact count for another store', () => {
  const dashboard = structuredClone(DASHBOARD);
  dashboard.supply.coverage.domains.purchaseOrders = {
    status: 'complete',
    succeededStores: 1,
    totalStores: 1,
    succeededStoreCodes: ['OLD111'],
  };
  dashboard.supply.purchaseOrderStatus = [{
    storeCode: 'DL5477',
    storeName: 'DL5477',
    statusCode: 'WAIT_DELIVERY',
    statusName: '待交付',
    orderCount: 0,
    latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
  }];

  const result = queryProcurementDashboard(
    dashboard,
    new URLSearchParams('store=DL5477'),
  );
  assert.equal(result.summary.coverageComplete, false);
  assert.equal(result.summary.orderCount, null);
});

test('text and status filters are server-side and preserve an honest empty result', () => {
  const found = queryProcurementDashboard(
    DASHBOARD,
    new URLSearchParams({ q: 'po-002', status: 'WAIT_DELIVERY' }),
  );
  assert.deepEqual(found.attention.rows.map((row) => row.orderNo), ['PO-002']);

  const empty = queryProcurementDashboard(
    DASHBOARD,
    new URLSearchParams({ q: 'does-not-exist' }),
  );
  assert.equal(empty.summary.orderCount, null);
  assert.equal(empty.summary.matchedMaterializedAttentionCount, 0);
  assert.deepEqual(empty.attention.rows, []);
  assert.deepEqual(empty.statusOverview, []);
  assert.equal(empty.summary.quantityStages.order.total, null);
  assert.equal(empty.summary.quantityStages.order.knownSum, null);
});

test('query parameters are bounded and duplicate or unknown input fails closed', () => {
  for (const params of [
    new URLSearchParams('page=0'),
    new URLSearchParams('page=10001'),
    new URLSearchParams('pageSize=101'),
    // Page size is a closed set: an in-range number is still rejected.
    new URLSearchParams('pageSize=2'),
    new URLSearchParams('pageSize=26'),
    new URLSearchParams('pageSize=0'),
    new URLSearchParams('quick=NOPE'),
    new URLSearchParams('sort=NOPE'),
    new URLSearchParams('owner=unknown'),
    new URLSearchParams('q=a&q=b'),
    new URLSearchParams('quick=ALL&quick=HIGH'),
    new URLSearchParams('page=1&page=2'),
    new URLSearchParams('pageSize=25&pageSize=50'),
    new URLSearchParams({ q: 'x'.repeat(81) }),
  ]) {
    assert.throws(
      () => queryProcurementDashboard(DASHBOARD, params),
      ProcurementQueryError,
      `expected rejection for ${params.toString()}`,
    );
  }

  for (const pageSize of ['25', '50', '100']) {
    assert.equal(
      queryProcurementDashboard(DASHBOARD, new URLSearchParams({ pageSize })).query.pageSize,
      Number(pageSize),
    );
  }
  assert.deepEqual(
    queryProcurementDashboard(DASHBOARD, new URLSearchParams()).filters.pageSizes,
    [25, 50, 100],
  );
  assert.deepEqual(
    queryProcurementDashboard(DASHBOARD, new URLSearchParams()).filters.quick,
    [
      'ALL', 'HIGH', 'OVERDUE', 'PENDING_DELIVERY',
      'PENDING_RECEIPT', 'PENDING_STORAGE', 'DEFECTIVE',
    ],
  );
});
