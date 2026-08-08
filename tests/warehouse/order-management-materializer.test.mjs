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
  assert.ok(first.details.some((entry) => entry.name === 'orderNo' && entry.value === 'PB-1'));
  assert.ok(first.tags.includes('发货单'));
  assert.equal(notes.rows[1].statusCode, 'TAKEN');

  const waybills = result.pages.waybills;
  assert.equal(waybills.status, 'AVAILABLE');
  assert.equal(waybills.rows.length, 2);
  assert.equal(waybills.rows[0].id, 'SF-1001');
  assert.equal(waybills.rows[0].statusCode, 'SIGNED');
  assert.equal(waybills.rows[1].id, 'SF-1003');
  assert.equal(waybills.rows[1].statusCode, 'RESERVED');
  assert.ok(waybills.rows.every((row) => !row.id.includes('FH-2')));

  assert.equal(result.evidence['delivery-notes'].gates.dedupeVerified, true);
  assert.equal(result.evidence['delivery-notes'].storeCodes.length, 2);
  assert.ok(commands.includes('COMMIT'));
  assert.equal(commands.at(-1), 'RELEASE');
});

test('the orchestrator exposes all nine fixed pages and gates promotion on coverage', async () => {
  const { pool } = mockPool(TWO_STORE_DELIVERIES);
  const index = await materializeOrderManagement({
    pool,
    now: new Date('2026-08-08T06:00:00.000Z'),
    expectedStoreCount: 2,
  });
  assert.deepEqual(Object.keys(index.pages).sort(), [...ORDER_MANAGEMENT_PAGE_IDS].sort());
  assert.equal(index.coverage.status, 'COMPLETE');
  assert.equal(index.coverage.completedStoreCount, 2);
  assert.deepEqual(index.coverage.storeCodes, ['DL5477', 'MZ2406']);
  assert.equal(index.promotable, true);
  assert.equal(validateOrderManagementIndex(index).ok, true);
  for (const pageId of [
    'delivery-desk',
    'return-applications',
    'return-orders',
    'exceptions',
    'value-added-services',
    'quality-reports',
  ]) {
    assert.equal(index.pages[pageId].status, 'UNAVAILABLE');
    assert.ok(index.pages[pageId].reason, `${pageId} needs an explicit reason`);
  }
  assert.match(index.pages['delivery-desk'].reason, /total/);
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

function snapshotWith({ stockStatus = 'AVAILABLE', stockStoreCount = 2, waybillStatus = 'AVAILABLE' } = {}) {
  return {
    schemaVersion: 1,
    updatedAt: '2026-08-08T06:00:00.000Z',
    pages: {
      'stock-records': {
        status: stockStatus,
        source: 'SESSION_HTTP',
        latestSourceFetchedAt: '2026-08-08T06:00:00.000Z',
        reason: stockStatus === 'AVAILABLE' ? null : 'SESSION_GATE_FAILED: test',
        storeCodes: ['DL5477', 'MZ2406'],
        gates: {
          totalVerified: true,
          pagingVerified: true,
          dedupeVerified: true,
          storeCount: stockStoreCount,
        },
        rows: stockStatus === 'AVAILABLE' ? [STOCK_SNAPSHOT_ROW] : [],
      },
      waybills: {
        status: waybillStatus,
        source: 'SESSION_HTTP',
        latestSourceFetchedAt: '2026-08-08T06:00:00.000Z',
        reason: waybillStatus === 'AVAILABLE' ? null : 'SESSION_GATE_FAILED: test',
        storeCodes: ['DL5477', 'MZ2406'],
        gates: {
          totalVerified: true,
          pagingVerified: true,
          dedupeVerified: true,
          storeCount: 2,
        },
        rows: waybillStatus === 'AVAILABLE' ? [WAYBILL_SNAPSHOT_ROW] : [],
      },
    },
  };
}

test('a passing session snapshot merges stock records and waybills into the index', async () => {
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
  assert.equal(index.coverage.status, 'COMPLETE');
  assert.equal(index.promotable, true);
  assert.equal(validateOrderManagementIndex(index).ok, true);
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
