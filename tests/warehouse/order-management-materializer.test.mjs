import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORDER_MANAGEMENT_PAGE_IDS,
  validateOrderManagementIndex,
} from '../../src/order-management/order-management-contract.mjs';
import {
  materializeOrderManagement,
  materializeOrderManagementDatabasePages,
  mergeOrderManagementSessionSnapshot,
} from '../../src/warehouse/order-management-materializer.mjs';

const TWO_STORE_DELIVERIES = [
  {
    delivery_id: 1, store_id: 7, store_code: 'DL5477',
    delivery_code: 'FH-1', delivery_type_code: '1', delivery_type_name: '大货发货',
    express_code: 'SF-1001', express_company_code: 'shunfeng', express_company_name: '顺丰',
    package_count: 2, package_weight: 3.5, warehouse_code: 'W1', warehouse_name: '总仓',
    platform_created_at: '2026-08-08T01:00:00.000Z', reserved_parcel_at: '2026-08-08T02:00:00.000Z',
    taken_at: '2026-08-08T03:00:00.000Z', expected_receipt_at: null, received_at: '2026-08-08T04:00:00.000Z',
    source_fetched_at: '2026-08-08T05:00:00.000Z',
  },
  {
    delivery_id: 2, store_id: 7, store_code: 'DL5477',
    delivery_code: 'FH-2', delivery_type_code: '2', delivery_type_name: '增值发货',
    express_code: null, express_company_code: null, express_company_name: null,
    package_count: 1, package_weight: 1.2, warehouse_code: 'W1', warehouse_name: '总仓',
    platform_created_at: '2026-08-08T01:10:00.000Z', reserved_parcel_at: null,
    taken_at: '2026-08-08T03:10:00.000Z', expected_receipt_at: null, received_at: null,
    source_fetched_at: '2026-08-08T05:10:00.000Z',
  },
  {
    delivery_id: 3, store_id: 8, store_code: 'MZ2406',
    delivery_code: 'FH-3', delivery_type_code: '1', delivery_type_name: '大货发货',
    express_code: 'SF-1003', express_company_code: 'shunfeng', express_company_name: '顺丰',
    package_count: 3, package_weight: 5.0, warehouse_code: 'W2', warehouse_name: '华东2仓',
    platform_created_at: '2026-08-08T01:20:00.000Z', reserved_parcel_at: '2026-08-08T02:20:00.000Z',
    taken_at: null, expected_receipt_at: null, received_at: null,
    source_fetched_at: '2026-08-08T05:20:00.000Z',
  },
];

const LINES = [
  {
    store_id: 7, delivery_id: 1, order_no: 'PB-1', skc_name: 'SKC-A', sku_code: 'SKU-A1',
    delivery_quantity: 40, source_fetched_at: '2026-08-08T05:00:00.000Z',
  },
  {
    store_id: 7, delivery_id: 1, order_no: 'PB-1', skc_name: 'SKC-A', sku_code: 'SKU-A2',
    delivery_quantity: 60, source_fetched_at: '2026-08-08T05:00:00.000Z',
  },
  {
    store_id: 7, delivery_id: 2, order_no: 'PB-2', skc_name: 'SKC-B', sku_code: 'SKU-B1',
    delivery_quantity: 10, source_fetched_at: '2026-08-08T05:10:00.000Z',
  },
  {
    store_id: 8, delivery_id: 3, order_no: 'PB-3', skc_name: 'SKC-C', sku_code: 'SKU-C1',
    delivery_quantity: 80, source_fetched_at: '2026-08-08T05:20:00.000Z',
  },
];

const ORDERS = [
  {
    store_id: 7, order_no: 'PB-1', order_type_code: '2', order_type_name: '备货',
    status_code: '1', status_name: '已下单', prepare_type_code: null, prepare_type_name: null,
  },
  {
    store_id: 7, order_no: 'PB-2', order_type_code: '1', order_type_name: '急采',
    status_code: '1', status_name: '已下单', prepare_type_code: null, prepare_type_name: null,
  },
  {
    store_id: 8, order_no: 'PB-3', order_type_code: '2', order_type_name: '备货',
    status_code: '1', status_name: '已下单', prepare_type_code: null, prepare_type_name: null,
  },
];

function mockPool(rows, { expectedStoreCount = 2 } = {}) {
  const commands = [];
  const client = {
    async query(sql) {
      commands.push(sql);
      if (sql === ORDER_MANAGEMENT_SQL.deliveries) return { rows };
      if (sql === ORDER_MANAGEMENT_SQL.lines) return { rows: LINES };
      if (sql === ORDER_MANAGEMENT_SQL.orders) return { rows: ORDERS };
      return { rows: [] };
    },
    release() { commands.push('RELEASE'); },
  };
  return {
    pool: { async connect() { return client; } },
    commands,
  };
}

import { ORDER_MANAGEMENT_SQL } from '../../src/warehouse/order-management-materializer.mjs';

test('materializes delivery-note and waybill cores from fact.delivery with the shared row shape', async () => {
  const { pool, commands } = mockPool(TWO_STORE_DELIVERIES);
  const result = await materializeOrderManagementDatabasePages(pool, {
    now: new Date('2026-08-08T06:00:00.000Z'),
    expectedStoreCount: 2,
  });

  const notes = result.pages['delivery-notes'];
  assert.equal(notes.status, 'AVAILABLE');
  assert.equal(notes.source, 'OPENAPI_FACT_DATABASE');
  assert.equal(notes.rows.length, 3);
  const first = notes.rows[0];
  assert.equal(first.id, 'FH-1');
  assert.equal(first.storeCode, 'DL5477');
  assert.equal(first.statusCode, 'RECEIVED');
  assert.equal(first.statusName, '已收货');
  assert.equal(first.primary, 'FH-1');
  assert.ok(first.metrics.some((entry) => entry.name === 'packageCount' && entry.value === 2));
  assert.ok(first.metrics.some((entry) => entry.name === 'deliveryQuantity' && entry.value === 100));
  assert.ok(first.facts.some((entry) => entry.name === 'expressCompanyName' && entry.value === '顺丰'));
  assert.ok(first.facts.some((entry) => entry.name === 'orderTypeName' && entry.value === '备货'));
  assert.ok(first.facts.some((entry) => (
    entry.name === 'reservedParcelAt' && entry.value === '2026-08-08T02:00:00.000Z'
  )));
  assert.ok(first.facts.some((entry) => (
    entry.name === 'takenAt' && entry.value === '2026-08-08T03:00:00.000Z'
  )));
  assert.ok(first.facts.some((entry) => (
    entry.name === 'receivedAt' && entry.value === '2026-08-08T04:00:00.000Z'
  )));
  assert.ok(first.details.some((entry) => entry.name === 'orderNo' && entry.value === 'PB-1'));
  assert.ok(first.tags.includes('发货单'));
  assert.equal(notes.rows[1].statusCode, 'TAKEN');

  const waybills = result.pages.waybills;
  assert.equal(waybills.status, 'AVAILABLE');
  assert.equal(waybills.rows.length, 2);
  assert.equal(waybills.rows[0].id, 'SF-1001');
  assert.equal(waybills.rows[0].statusCode, 'SIGNED');
  assert.ok(waybills.rows[0].facts.some((entry) => (
    entry.name === 'reservedParcelAt' && entry.value === '2026-08-08T02:00:00.000Z'
  )));
  assert.ok(waybills.rows[0].facts.some((entry) => (
    entry.name === 'takenAt' && entry.value === '2026-08-08T03:00:00.000Z'
  )));
  assert.ok(waybills.rows[0].facts.some((entry) => (
    entry.name === 'receivedAt' && entry.value === '2026-08-08T04:00:00.000Z'
  )));
  assert.equal(waybills.rows[1].id, 'SF-1003');
  assert.equal(waybills.rows[1].statusCode, 'RESERVED');
  assert.ok(waybills.rows.every((row) => !row.id.includes('FH-2')));

  assert.equal(result.evidence['delivery-notes'].gates.dedupeVerified, true);
  assert.equal(result.evidence['delivery-notes'].storeCodes.length, 2);
  assert.ok(commands.includes('COMMIT'));
  assert.equal(commands.at(-1), 'RELEASE');
});

test('the orchestrator exposes all eight fixed pages and blocks promotion while session pages are absent', async () => {
  const { pool } = mockPool(TWO_STORE_DELIVERIES);
  const index = await materializeOrderManagement({
    pool,
    now: new Date('2026-08-08T06:00:00.000Z'),
    expectedStoreCount: 2,
  });
  assert.deepEqual(Object.keys(index.pages).sort(), [...ORDER_MANAGEMENT_PAGE_IDS].sort());
  assert.equal(index.coverage.status, 'PARTIAL');
  assert.equal(index.coverage.completedStoreCount, 2);
  assert.deepEqual(index.coverage.storeCodes, ['DL5477', 'MZ2406']);
  assert.equal(index.promotable, false);
  assert.match(index.coverage.reason, /PAGE_UNAVAILABLE/);
  assert.equal(validateOrderManagementIndex(index).ok, true);
  for (const pageId of [
    'return-applications',
    'return-orders',
    'exceptions',
    'value-added-services',
    'quality-reports',
  ]) {
    assert.equal(index.pages[pageId].status, 'UNAVAILABLE');
    assert.match(index.pages[pageId].reason, /SESSION_SNAPSHOT_ABSENT/);
  }
  assert.equal(index.pages['delivery-desk'], undefined);
  assert.equal(index.pages['stock-records'].status, 'UNAVAILABLE');
  assert.match(index.pages['stock-records'].reason, /SESSION_SNAPSHOT_ABSENT/);
});

test('incomplete database store coverage keeps the index un-promotable', async () => {
  const { pool } = mockPool(TWO_STORE_DELIVERIES.filter((row) => row.store_id === 7));
  const index = await materializeOrderManagement({
    pool,
    now: new Date('2026-08-08T06:00:00.000Z'),
    expectedStoreCount: 2,
  });
  assert.equal(index.pages['delivery-notes'].status, 'PARTIAL');
  assert.equal(index.coverage.status, 'PARTIAL');
  assert.equal(index.promotable, false);
  assert.match(index.coverage.reason, /STORE_COVERAGE_INCOMPLETE|PAGE_GATE_FAILED/);
});

const STOCK_SNAPSHOT_ROW = {
  id: 'PB-S1',
  storeCode: 'DL5477',
  statusCode: '1',
  statusName: null,
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-08T06:00:00.000Z',
  primary: 'PB-S1',
  secondary: '系统下单',
  tags: ['备货记录'],
  metrics: [],
  facts: [
    { name: 'supplierCode', value: 'MODEL-A' },
    { name: 'skc', value: 'sv-skc-1' },
    { name: 'orderModeValue', value: '系统自动下单' },
    { name: 'applyStatus', value: '1' },
    { name: 'addTime', value: '2026-08-07 10:00:00' },
  ],
  details: [],
};

const WAYBILL_SNAPSHOT_ROW = {
  id: 'SF-9001',
  storeCode: 'DL5477',
  statusCode: 'IN_TRANSIT',
  statusName: '运输中',
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-08T06:00:00.000Z',
  primary: 'SF-9001',
  secondary: 'FH-9',
  tags: ['运单', '发货运单'],
  metrics: [{ name: 'packQuantity', value: 1 }, { name: 'sendGoodsQuantity', value: 20 }],
  facts: [{ name: 'logisticsCompanyName', value: '顺丰' }],
  details: [],
};

const RETURN_APPLICATION_SNAPSHOT_ROW = {
  id: 'RA-9001',
  storeCode: 'DL5477',
  statusCode: '1',
  statusName: '待商家确认',
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-08T06:00:00.000Z',
  primary: 'RA-9001',
  secondary: null,
  tags: ['退货申请'],
  metrics: [{ name: 'returnQuantity', value: 10 }],
  facts: [{ name: 'returnReasonName', value: '滞销退' }],
  details: [],
};

const RETURN_ORDER_SNAPSHOT_ROW = {
  id: 'RO-9001',
  storeCode: 'DL5477',
  statusCode: '2',
  statusName: '待退货',
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-08T06:00:00.000Z',
  primary: 'RO-9001',
  secondary: null,
  tags: ['退货单'],
  metrics: [{ name: 'returnQuantity', value: 5 }],
  facts: [{ name: 'warehouseName', value: '总仓' }],
  details: [],
};

const EXCEPTION_SNAPSHOT_ROW = {
  id: 'WO-9001',
  storeCode: 'DL5477',
  statusCode: '1',
  statusName: '处理中',
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-08T06:00:00.000Z',
  primary: 'WO-9001',
  secondary: null,
  tags: ['收货/退货异常'],
  metrics: [],
  facts: [{ name: 'categoryName', value: '收货异常' }],
  details: [],
};

const VALUE_ADDED_SNAPSHOT_ROW = {
  id: 'VA-9001',
  storeCode: 'DL5477',
  statusCode: '1',
  statusName: '服务中',
  createdAt: null,
  updatedAt: '2026-08-08T06:00:00.000Z',
  primary: 'VA-9001',
  secondary: null,
  tags: ['增值服务'],
  metrics: [{ name: 'actualTotalAmount', value: 12.5 }],
  facts: [{ name: 'serviceSiteName', value: '华东仓' }],
  details: [],
};

const QUALITY_REPORT_SNAPSHOT_ROW = {
  id: 'QC-9001',
  storeCode: 'DL5477',
  statusCode: '1',
  statusName: '合格',
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-08T06:00:00.000Z',
  primary: 'QC-9001',
  secondary: null,
  tags: ['质检报告'],
  metrics: [{ name: 'defectiveTotalQty', value: 0 }],
  facts: [{ name: 'qcTypeName', value: '出库质检' }],
  details: [],
};

function snapshotWith({ stockStatus = 'AVAILABLE', stockStoreCount = 2, waybillStatus = 'AVAILABLE' } = {}) {
  const page = (pageId, rows, status = 'AVAILABLE', storeCount = 2) => Object.freeze({
    status,
    source: 'SESSION_HTTP',
    latestSourceFetchedAt: '2026-08-08T06:00:00.000Z',
    reason: status === 'AVAILABLE' ? null : 'SESSION_GATE_FAILED: test',
    storeCodes: ['DL5477', 'MZ2406'],
    gates: {
      totalVerified: true,
      pagingVerified: true,
      dedupeVerified: true,
      contentVerified: true,
      storeCount,
    },
    rows: status === 'AVAILABLE' ? rows : [],
  });
  return {
    schemaVersion: 1,
    updatedAt: '2026-08-08T06:00:00.000Z',
    pages: {
      'stock-records': page('stock-records', [STOCK_SNAPSHOT_ROW], stockStatus, stockStoreCount),
      waybills: page('waybills', [WAYBILL_SNAPSHOT_ROW], waybillStatus, 2),
      'return-applications': page('return-applications', [RETURN_APPLICATION_SNAPSHOT_ROW]),
      'return-orders': page('return-orders', [RETURN_ORDER_SNAPSHOT_ROW]),
      exceptions: page('exceptions', [EXCEPTION_SNAPSHOT_ROW]),
      'value-added-services': page('value-added-services', [VALUE_ADDED_SNAPSHOT_ROW]),
      'quality-reports': page('quality-reports', [QUALITY_REPORT_SNAPSHOT_ROW]),
    },
  };
}

test('a passing session snapshot merges all seven session pages into the index', async () => {
  const { pool } = mockPool(TWO_STORE_DELIVERIES);
  const index = await materializeOrderManagement({
    pool,
    sessionSnapshot: snapshotWith(),
    now: new Date('2026-08-08T06:00:00.000Z'),
    expectedStoreCount: 2,
  });
  assert.equal(index.pages['stock-records'].status, 'AVAILABLE');
  assert.equal(index.pages['stock-records'].rows.length, 1);
  assert.equal(index.pages['stock-records'].rows[0].id, 'PB-S1');
  assert.equal(index.pages.waybills.source, 'OPENAPI_FACT_DATABASE_SESSION_MERGED');
  assert.equal(index.pages.waybills.rows.length, 3);
  assert.ok(index.pages.waybills.rows.some((row) => row.id === 'SF-9001'));
  assert.ok(index.pages.waybills.rows.some((row) => row.id === 'SF-1001'));
  for (const [pageId, rowId] of [
    ['return-applications', 'RA-9001'],
    ['return-orders', 'RO-9001'],
    ['exceptions', 'WO-9001'],
    ['value-added-services', 'VA-9001'],
    ['quality-reports', 'QC-9001'],
  ]) {
    assert.equal(index.pages[pageId].status, 'AVAILABLE');
    assert.equal(index.pages[pageId].source, 'SESSION_HTTP');
    assert.equal(index.pages[pageId].rows[0].id, rowId);
    assert.equal(index.evidence.pages[pageId].gates.contentVerified, true);
  }
  assert.equal(index.coverage.status, 'COMPLETE');
  assert.equal(index.promotable, true);
  for (const evidence of Object.values(index.evidence.pages)) {
    assert.equal(typeof evidence.sessionSnapshotUsed === 'undefined'
      ? true
      : evidence.sessionSnapshotUsed, true);
  }
  assert.equal(validateOrderManagementIndex(index).ok, true);
});

test('a session page with a false content gate blocks promotion', async () => {
  const { pool } = mockPool(TWO_STORE_DELIVERIES);
  const snapshot = snapshotWith();
  snapshot.pages['quality-reports'].gates.contentVerified = false;
  const index = await materializeOrderManagement({
    pool,
    sessionSnapshot: snapshot,
    now: new Date('2026-08-08T06:00:00.000Z'),
    expectedStoreCount: 2,
  });
  assert.equal(index.pages['quality-reports'].status, 'PARTIAL');
  assert.equal(index.coverage.status, 'PARTIAL');
  assert.equal(index.promotable, false);
});

test('an unavailable session page stays unavailable and cannot become an HTTP-200 partial page', async () => {
  const { pool } = mockPool(TWO_STORE_DELIVERIES);
  const snapshot = snapshotWith();
  snapshot.pages['quality-reports'] = {
    ...snapshot.pages['quality-reports'],
    status: 'UNAVAILABLE',
    reason: 'SESSION_GATE_FAILED: NO_STORE_SUCCEEDED',
    storeCodes: [],
    gates: {
      totalVerified: false,
      pagingVerified: false,
      dedupeVerified: false,
      contentVerified: false,
      storeCount: 0,
    },
    rows: [],
  };
  const index = await materializeOrderManagement({
    pool,
    sessionSnapshot: snapshot,
    now: new Date('2026-08-08T06:00:00.000Z'),
    expectedStoreCount: 2,
  });
  assert.equal(index.pages['quality-reports'].status, 'UNAVAILABLE');
  assert.equal(index.pages['quality-reports'].rows.length, 0);
  assert.equal(index.coverage.status, 'PARTIAL');
  assert.equal(index.promotable, false);
});

test('a failing snapshot gate blocks promotion of the whole index', async () => {
  const { pool } = mockPool(TWO_STORE_DELIVERIES);
  const index = await materializeOrderManagement({
    pool,
    sessionSnapshot: snapshotWith({ stockStoreCount: 1 }),
    now: new Date('2026-08-08T06:00:00.000Z'),
    expectedStoreCount: 2,
  });
  assert.equal(index.pages['stock-records'].status, 'PARTIAL');
  assert.equal(index.coverage.status, 'PARTIAL');
  assert.equal(index.promotable, false);
  assert.match(index.coverage.reason, /PAGE_GATE_FAILED/);
});

test('mergeOrderManagementSessionSnapshot deduplicates session waybills against the core', () => {
  const snapshot = snapshotWith();
  const merged = mergeOrderManagementSessionSnapshot(snapshot, {
    now: new Date('2026-08-08T06:00:00.000Z'),
    expectedStoreCount: 2,
    waybillCoreRows: [
      {
        ...WAYBILL_SNAPSHOT_ROW,
        id: 'SF-1001',
        storeCode: 'DL5477',
        tags: ['发货运单核心'],
      },
      WAYBILL_SNAPSHOT_ROW,
    ],
  });
  const ids = merged.pages.waybills.rows.map((row) => `${row.storeCode}:${row.id}`);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(merged.pages.waybills.rows.length, 2);
  assert.equal(merged.evidence.waybills.skippedDuplicates, 1);
});
