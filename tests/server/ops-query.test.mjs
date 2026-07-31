import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OpsQueryError,
  queryOpsDashboard,
} from '../../src/server/ops-query.mjs';

const DASHBOARD = Object.freeze({
  updatedAt: '2026-08-01T01:00:00.000Z',
  businessDate: '2026-07-31',
  owners: [
    { key: 'owner-a', storeCodes: ['DL5477', 'MZ2406'] },
    { key: 'owner-b', storeCodes: ['JY8060'] },
  ],
  quality: {
    status: 'partial',
    label: '覆盖不完整',
    reason: '一个窗口缺少统计日期',
    impact: '缺失值不补零',
    nextStep: '检查同步水位',
  },
  productIdentityCoverage: {
    confirmedSkus: 40,
    totalSkus: 100,
    unconfirmedSkus: 60,
    note: '40/100 已确认',
  },
  productIdentityPipeline: {
    updatedAt: '2026-08-01T00:50:00.000Z',
  },
  supply: {
    status: 'available',
    attentionMeta: {
      purchaseOrders: { total: 2, returned: 2, truncated: false },
      deliveries: { total: 1, returned: 1, truncated: false },
      inventoryRisks: { total: 1, returned: 1, truncated: false },
      stockAdviceRisks: { total: 1, returned: 1, truncated: false },
    },
    purchaseOrderAttention: [{
      storeCode: 'DL5477',
      storeName: 'DL5477',
      orderNo: 'PO-OVERDUE',
      statusName: '待交付',
      orderQuantity: 20,
      deliveryQuantity: 0,
      requestedDeliveryAt: '2026-07-30T08:00:00.000Z',
      latestSourceFetchedAt: '2026-08-01T00:59:00.000Z',
      attentionCode: 'DELIVERY_OVERDUE',
      attentionLabel: '采购单逾期',
      severity: 'critical',
    }, {
      storeCode: 'MZ2406',
      storeName: 'MZ2406',
      orderNo: 'PO-RECEIPT',
      statusName: '待收货',
      orderQuantity: 10,
      deliveryQuantity: 10,
      receiptQuantity: 0,
      latestSourceFetchedAt: '2026-08-01T00:58:00.000Z',
      attentionCode: 'DELIVERED_PENDING_RECEIPT',
      attentionLabel: '待收货',
      severity: 'medium',
    }],
    deliveryAttention: [{
      storeCode: 'DL5477',
      storeName: 'DL5477',
      deliveryCode: 'DN-1',
      milestoneCode: 'IN_TRANSIT',
      deliveryQuantity: 10,
      takenAt: '2026-07-31T10:00:00.000Z',
      expectedReceiptAt: '2026-08-02T10:00:00.000Z',
      latestSourceFetchedAt: '2026-08-01T00:57:00.000Z',
      attentionCode: 'IN_TRANSIT_PENDING_RECEIPT',
      attentionLabel: '运输中 / 待收货',
      severity: 'high',
    }],
    inventoryRisks: [{
      storeCode: 'MZ2406',
      storeName: 'MZ2406',
      skuCode: 'SKU-SHORT',
      skcName: '短缺商品',
      usableInventory: 0,
      transitQuantity: 2,
      shortageQuantity: 5,
      latestSourceFetchedAt: '2026-08-01T00:56:00.000Z',
      severity: 'high',
    }],
    stockAdviceRisks: [{
      storeCode: 'JY8060',
      storeName: 'JY8060',
      skuCode: 'SKU-URGENT',
      skcName: '急采商品',
      predictedDailySales: 3,
      plannedUrgentQuantity: 8,
      advisedOrderQuantity: 10,
      stockQuantity: 0,
      transitQuantity: 0,
      latestSourceFetchedAt: '2026-08-01T00:55:00.000Z',
      severity: 'critical',
    }],
  },
  actionPool: {
    mode: 'observe_only',
    writeEnabled: false,
    meta: { total: 3, returned: 2, truncated: true },
    candidates: [{
      storeCode: 'MZ2406',
      type: 'SKU_SHORTAGE_REVIEW',
      severity: 'critical',
      entityCode: 'SKU-SHORT',
      reason: '重复的缺货候选',
      evidenceAt: '2026-08-01T00:56:00.000Z',
    }, {
      storeCode: 'JY8060',
      type: 'SUPPLY_SYNC_FAILURE_REVIEW',
      severity: 'high',
      entityCode: 'SUPPLY-SYNC',
      reason: '同步失败',
      evidenceAt: '2026-08-01T00:54:00.000Z',
    }],
  },
  platform: {
    health: {
      ok: true,
      evaluatedAt: '2026-08-01T00:53:00.000Z',
    },
    queue: {
      deadLetter: 2,
      expiredLeases: 0,
      hydrationPending: 1,
      lastProcessedAt: '2026-08-01T00:52:00.000Z',
    },
  },
});

test('ops query defaults to a paged priority worklist with honest source evidence', () => {
  const result = queryOpsDashboard(DASHBOARD);

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.readOnly, true);
  assert.equal(result.query.view, 'PRIORITY');
  assert.equal(result.summary.scopedCount, 9);
  assert.equal(result.summary.priorityCount, 8);
  assert.equal(result.summary.criticalCount, 2);
  assert.equal(result.summary.highPriorityCount, 5);
  assert.equal(result.summary.highOrAboveCount, 7);
  assert.equal(result.summary.overdueCount, 1);
  assert.equal(result.summary.shortageCount, 1);
  assert.equal(result.summary.urgentCount, 1);
  assert.equal(result.summary.impactedStoreCount, 3);
  assert.equal(result.worklist.pagination.matchedRows, 8);
  assert.equal(result.worklist.rows[0].objectCode, 'PO-OVERDUE');
  assert.equal(result.automation.mode, 'observe_only');
  assert.equal(result.automation.writeEnabled, false);
  assert.equal(result.source.businessWindowTruncated, false);
  assert.equal(result.source.candidateWindow.truncated, true);
  assert.deepEqual(result.source.businessWindows.purchaseOrders, {
    returned: 2,
    total: 2,
    truncated: false,
  });
});

test('owner and store scope are server-side and exclude cross-store aggregates', () => {
  const owner = queryOpsDashboard(
    DASHBOARD,
    new URLSearchParams('owner=owner-a&pageSize=25'),
  );
  assert.equal(owner.summary.scopedCount, 4);
  assert.equal(owner.worklist.pagination.matchedRows, 3);
  assert.equal(owner.worklist.rows.every(({ storeCode }) => (
    ['DL5477', 'MZ2406'].includes(storeCode)
  )), true);

  const store = queryOpsDashboard(
    DASHBOARD,
    new URLSearchParams('store=JY8060&view=ALL&pageSize=25'),
  );
  assert.equal(store.summary.scopedCount, 2);
  assert.equal(store.worklist.rows.every(({ storeCode }) => storeCode === 'JY8060'), true);
});

test('domain, quick, severity, search, sorting and paging are bounded', () => {
  const shortage = queryOpsDashboard(
    DASHBOARD,
    new URLSearchParams([
      ['view', 'ALL'],
      ['domain', 'INVENTORY'],
      ['quick', 'SHORTAGE'],
      ['severity', 'HIGH'],
      ['q', 'SKU-SHORT'],
      ['sort', 'LATEST'],
      ['page', '1'],
      ['pageSize', '25'],
    ]),
  );
  assert.equal(shortage.worklist.pagination.matchedRows, 1);
  assert.equal(shortage.worklist.rows[0].objectCode, 'SKU-SHORT');
  assert.equal(shortage.query.domain, 'INVENTORY');
  assert.equal(shortage.query.quick, 'SHORTAGE');
  assert.equal(shortage.query.severity, 'HIGH');
  assert.equal(shortage.query.sort, 'LATEST');

  const all = queryOpsDashboard(
    DASHBOARD,
    new URLSearchParams('view=ALL&sort=STORE&page=1&pageSize=25'),
  );
  assert.equal(all.worklist.pagination.matchedRows, 9);
  assert.equal(all.worklist.rows.length, 9);
});

test('candidate types are suppressed only when their independent detail source has evidence', () => {
  const dashboard = structuredClone(DASHBOARD);
  dashboard.quality = { status: 'healthy' };
  dashboard.productIdentityCoverage = {
    confirmedSkus: 100,
    totalSkus: 100,
    unconfirmedSkus: 0,
  };
  dashboard.supply = {
    status: 'pending',
    attentionMeta: {},
    purchaseOrderAttention: [],
    deliveryAttention: [],
    inventoryRisks: [],
    stockAdviceRisks: [],
  };
  dashboard.platform = { health: { ok: true }, queue: { deadLetter: 0 } };
  dashboard.actionPool = {
    mode: 'observe_only',
    writeEnabled: false,
    meta: { total: 1, returned: 1, truncated: false },
    candidates: [{
      storeCode: 'MZ2406',
      type: 'SKU_SHORTAGE_REVIEW',
      severity: 'critical',
      entityCode: 'SKU-CANDIDATE',
      reason: '独立库存风险源尚未接入',
      evidenceAt: '2026-08-01T00:56:00.000Z',
    }],
  };

  const result = queryOpsDashboard(
    dashboard,
    new URLSearchParams('view=ALL&pageSize=25'),
  );
  assert.equal(result.summary.scopedCount, 1);
  assert.equal(result.worklist.rows[0].objectCode, 'SKU-CANDIDATE');
  assert.equal(result.worklist.rows[0].domain, 'INVENTORY');
});

test('ops query rejects unknown, duplicate and unbounded parameters', () => {
  for (const params of [
    new URLSearchParams('unknown=1'),
    new URLSearchParams('view=ALL&view=PRIORITY'),
    new URLSearchParams('view=EVERYTHING'),
    new URLSearchParams('pageSize=500'),
    new URLSearchParams('quick=DELETE'),
    new URLSearchParams('owner=missing'),
  ]) {
    assert.throws(
      () => queryOpsDashboard(DASHBOARD, params),
      OpsQueryError,
    );
  }
});
