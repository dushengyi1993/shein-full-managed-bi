import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ShippingOrdersQueryError,
  queryShippingOrders,
} from '../../src/server/shipping-orders-query.mjs';

const DASHBOARD = Object.freeze({
  owners: [
    { key: 'owner-a', name: '甲', storeCodes: ['DL5477'] },
    { key: 'owner-b', name: '乙', storeCodes: ['MZ2406'] },
  ],
});

const SHIPPING = Object.freeze({
  schemaVersion: 1,
  updatedAt: '2026-08-08T08:00:00.000Z',
  source: {
    basis: 'OPENAPI_PURCHASE_ORDER_AND_DELIVERY',
    latestSourceFetchedAt: '2026-08-08T07:59:00.000Z',
    storeCount: 2,
    orderCount: 3,
    lineCount: 3,
  },
  capabilities: { coreOrderFacts: true, deliveryFacts: true },
  orders: [
    {
      storeCode: 'DL5477', storeName: '地利', orderNo: 'PO-DUE',
      orderTypeName: '备货', statusName: '已下单', warehouseName: '华南仓',
      createdAt: '2026-08-08T01:00:00.000Z',
      requestedDeliveryAt: '2026-08-08T10:00:00.000Z',
      latestSourceFetchedAt: '2026-08-08T07:59:00.000Z',
      totals: { orderQuantity: 6, deliveryQuantity: 0, defectiveQuantity: 0 },
      lines: [{ lineKey: '1', skc: 'SKC-A', standardGoodsCode: 'A空气炸锅', orderQuantity: 6, deliveryQuantity: 0, defectiveQuantity: 0 }],
      deliveries: [],
    },
    {
      storeCode: 'DL5477', storeName: '地利', orderNo: 'PO-RETURN',
      orderTypeName: '急采', statusName: '已退货', warehouseName: '华南仓',
      createdAt: '2026-08-07T01:00:00.000Z',
      requestedDeliveryAt: '2026-08-07T03:00:00.000Z',
      latestSourceFetchedAt: '2026-08-08T07:58:00.000Z',
      totals: { orderQuantity: 2, deliveryQuantity: 1, defectiveQuantity: 1 },
      lines: [{ lineKey: '2', skc: 'SKC-B', orderQuantity: 2, deliveryQuantity: 1, defectiveQuantity: 1 }],
      deliveries: [{ deliveryCode: 'DN-1', expressCode: 'SF-1' }],
    },
    {
      storeCode: 'MZ2406', storeName: '妙正', orderNo: 'PO-DONE',
      orderTypeName: '备货', statusName: '已完成', warehouseName: '华东仓',
      createdAt: '2026-08-08T02:00:00.000Z',
      latestSourceFetchedAt: '2026-08-08T07:57:00.000Z',
      totals: { orderQuantity: null, deliveryQuantity: null, defectiveQuantity: null },
      lines: [{ lineKey: '3', skc: 'SKC-C', orderQuantity: null, deliveryQuantity: null, defectiveQuantity: null }],
      deliveries: [],
    },
  ],
});

test('filters one complete server-side shipping-order page and returns scoped counts', () => {
  const result = queryShippingOrders(
    DASHBOARD,
    SHIPPING,
    new URLSearchParams({
      owner: 'owner-a', orderType: 'ALL', status: 'ALL', quick: 'PENDING_OR_RETURNED',
      timeField: 'CREATED', start: '2026-08-07', end: '2026-08-08',
      warehouse: '华南仓', defective: 'ALL', sort: 'LATEST', page: '1', pageSize: '25',
    }),
    { now: new Date('2026-08-08T08:30:00+08:00') },
  );

  assert.equal(result.readOnly, true);
  assert.equal(result.orders.pagination.matchedRows, 2);
  assert.deepEqual(result.orders.rows.map((row) => row.orderNo), ['PO-DUE', 'PO-RETURN']);
  assert.equal(result.summary.orderQuantity, 8);
  assert.equal(result.summary.dueTodayCount, 1);
  assert.equal(result.summary.overdueCount, 1);
  assert.equal(result.filters.statuses.find((row) => row.code === 'PENDING_SHIPMENT').count, 1);
  assert.equal(result.filters.statuses.find((row) => row.code === 'RETURNED').count, 1);
});

test('preserves unknown totals instead of filling zero and supports text search', () => {
  const result = queryShippingOrders(
    DASHBOARD,
    SHIPPING,
    new URLSearchParams({
      store: 'MZ2406', q: 'SKC-C', orderType: 'STOCK_UP',
      start: '2026-08-08', end: '2026-08-08', page: '1', pageSize: '50',
    }),
    { now: new Date('2026-08-08T08:30:00+08:00') },
  );
  assert.equal(result.orders.pagination.matchedRows, 1);
  assert.equal(result.summary.orderQuantity, null);
  assert.equal(result.summary.deliveryQuantity, null);
});

test('rejects duplicate and unsupported query parameters', () => {
  assert.throws(
    () => queryShippingOrders(DASHBOARD, SHIPPING, new URLSearchParams('quick=ALL&quick=OVERDUE')),
    (error) => error instanceof ShippingOrdersQueryError && error.code === 'QUERY_PARAMETER_DUPLICATED',
  );
  assert.throws(
    () => queryShippingOrders(DASHBOARD, SHIPPING, new URLSearchParams('orderType=UNKNOWN')),
    (error) => error instanceof ShippingOrdersQueryError && error.code === 'QUERY_PARAMETER_INVALID',
  );
});
