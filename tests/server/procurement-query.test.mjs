import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProcurementQueryError,
  queryProcurementDashboard,
} from '../../src/server/procurement-query.mjs';

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
          succeededStores: 2,
          totalStores: 24,
          latestFetchedAt: '2026-07-29T00:00:00.000Z',
        },
      },
    },
    attentionMeta: {
      purchaseOrders: { available: true, total: 260, returned: 4, truncated: true },
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
    ],
    purchaseOrderAttention: [
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        orderNo: 'PO-003',
        statusCode: 'WAIT_DELIVERY',
        statusName: '待交付',
        attentionCode: 'PENDING_DELIVERY',
        attentionLabel: '待交付',
        severity: 'high',
        requestedDeliveryAt: '2026-07-27T00:00:00.000Z',
        latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        orderNo: 'PO-001',
        statusCode: 'WAIT_DELIVERY',
        statusName: '待交付',
        attentionCode: 'OVERDUE_PENDING_DELIVERY',
        attentionLabel: '逾期待交付',
        severity: 'critical',
        requestedDeliveryAt: '2026-07-26T00:00:00.000Z',
        latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        orderNo: 'PO-002',
        statusCode: 'WAIT_DELIVERY',
        statusName: '待交付',
        attentionCode: 'PENDING_DELIVERY',
        attentionLabel: '待交付',
        severity: 'medium',
        requestedDeliveryAt: null,
        latestSourceFetchedAt: '2026-07-28T22:00:00.000Z',
      },
      {
        storeCode: 'MZ2406',
        storeName: 'MZ2406',
        orderNo: 'MZ-001',
        statusCode: 'WAIT_DELIVERY',
        statusName: '待交付',
        attentionCode: 'PENDING_DELIVERY',
        attentionLabel: '待交付',
        severity: 'high',
        requestedDeliveryAt: '2026-07-25T00:00:00.000Z',
        latestSourceFetchedAt: '2026-07-28T23:00:00.000Z',
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
      pageSize: '2',
      sort: 'PRIORITY',
    }),
  );
  assert.equal(result.readOnly, true);
  assert.equal(result.summary.orderCount, 8);
  assert.equal(result.summary.matchedMaterializedAttentionCount, 3);
  assert.equal(result.attention.pagination.pageCount, 2);
  assert.equal(result.attention.pagination.hasNext, true);
  assert.deepEqual(
    result.attention.rows.map((row) => row.orderNo),
    ['PO-001', 'PO-003'],
  );
  assert.deepEqual(result.source.materializedAttention, {
    available: true,
    total: 260,
    returned: 4,
    truncated: true,
  });
});

test('unknown quantities stay null and materialized counts never impersonate source total', () => {
  const result = queryProcurementDashboard(
    DASHBOARD,
    new URLSearchParams({ store: 'MZ2406' }),
  );
  assert.equal(result.summary.orderCount, null);
  assert.equal(result.summary.matchedMaterializedAttentionCount, 1);
  assert.equal(result.source.materializedAttention.total, 260);
  assert.equal(result.source.materializedAttention.truncated, true);
  assert.equal(result.attention.pagination.matchedMaterializedRows, 1);
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
});

test('query parameters are bounded and duplicate or unknown owner input fails closed', () => {
  for (const params of [
    new URLSearchParams('page=0'),
    new URLSearchParams('pageSize=101'),
    new URLSearchParams('quick=NOPE'),
    new URLSearchParams('owner=unknown'),
    new URLSearchParams('q=a&q=b'),
    new URLSearchParams({ q: 'x'.repeat(81) }),
  ]) {
    assert.throws(
      () => queryProcurementDashboard(DASHBOARD, params),
      ProcurementQueryError,
    );
  }
});
