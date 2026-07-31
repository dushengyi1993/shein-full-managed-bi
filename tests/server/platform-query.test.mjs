import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PlatformQueryError,
  queryPlatformDashboard,
} from '../../src/server/platform-query.mjs';

const DASHBOARD = Object.freeze({
  updatedAt: '2026-07-31T16:30:00.000Z',
  businessDate: '2026-07-30',
  owners: [
    { key: 'owner-a', storeCodes: ['DL5477', 'MZ2406'] },
    { key: 'owner-b', storeCodes: ['JY8060'] },
  ],
  platform: {
    status: 'available',
    health: {
      ok: true,
      evaluatedAt: '2026-07-31T16:30:00.000Z',
      receiver: {
        status: 'RUNNING',
        fresh: true,
        lastSeenAt: '2026-07-31T16:29:30.000Z',
      },
      worker: {
        status: 'RUNNING',
        fresh: true,
        lastSeenAt: '2026-07-31T16:29:20.000Z',
      },
    },
    queue: {
      queued: 1,
      running: 0,
      retry: 1,
      deadLetter: 0,
      expiredLeases: 0,
      hydrationPending: 2,
      blockedStores: 1,
    },
    eventMeta: {
      returned: 5,
      limit: 100,
      truncated: false,
    },
    subscriptions: [{
      appFingerprint: 'abc123',
      eventCode: '3001435',
      desiredState: 'ENABLED',
      observedState: 'ENABLED',
      callbackValidated: true,
      checkedAt: '2026-07-31T15:00:00.000Z',
    }, {
      appFingerprint: 'abc123',
      eventCode: '3001441',
      desiredState: 'ENABLED',
      observedState: 'DISABLED',
      callbackValidated: false,
      checkedAt: '2026-07-31T15:10:00.000Z',
    }],
    events: [{
      eventCode: '3001435',
      eventPath: '/purchase_order_notice',
      eventFamily: 'purchase_order',
      businessType: 'PURCHASE_ORDER',
      businessKey: 'PO-1',
      storeCode: 'DL5477',
      deliveryScope: 'STORE',
      severity: 'P0',
      status: 'FAILED',
      action: 'purchase_order',
      occurredAt: '2026-07-31T16:00:00.000Z',
      safeProjection: { eventLabel: '采购单', identifiers: { document: 'PO-1' } },
      createdAt: '2026-07-31T16:01:00.000Z',
    }, {
      eventCode: '3001441',
      eventPath: '/delivery_modify_notice',
      eventFamily: 'delivery',
      businessType: 'DELIVERY',
      businessKey: 'DN-1',
      storeCode: 'MZ2406',
      deliveryScope: 'STORE',
      severity: 'P2',
      status: 'IN_TRANSIT',
      action: 'delivery',
      occurredAt: '2026-07-31T15:00:00.000Z',
      safeProjection: { eventLabel: '发货单变更', identifiers: { document: 'DN-1' } },
      createdAt: '2026-07-31T15:01:00.000Z',
    }, {
      eventCode: '3001048',
      eventPath: '/out_of_stock_notice',
      eventFamily: 'shortage',
      businessType: 'SHORTAGE',
      businessKey: 'SKU-1',
      storeCode: 'JY8060',
      deliveryScope: 'STORE',
      severity: 'high',
      status: 'OPEN',
      action: 'shortage',
      occurredAt: '2026-07-30T12:00:00.000Z',
      safeProjection: { eventLabel: '缺货需求', identifiers: { sku: 'SKU-1' } },
      createdAt: '2026-07-30T12:01:00.000Z',
    }, {
      eventCode: '3000910',
      eventPath: '/product_document_receive_status_notice',
      eventFamily: 'product_receive',
      businessType: 'PRODUCT',
      businessKey: 'SPU-1',
      storeCode: 'DL5477',
      deliveryScope: 'STORE',
      severity: 'P3',
      status: 'SUCCEEDED',
      action: 'product_receive',
      occurredAt: '2026-07-31T14:00:00.000Z',
      safeProjection: { eventLabel: '商品接收', identifiers: { spu: 'SPU-1' } },
      createdAt: '2026-07-31T14:01:00.000Z',
    }, {
      eventCode: '3001450',
      eventPath: '/product_document_audit_status_notice',
      eventFamily: 'product_audit',
      businessType: 'PRODUCT',
      businessKey: null,
      storeCode: null,
      deliveryScope: 'APP_ONLY',
      severity: 'P3',
      status: 'SUCCEEDED',
      action: 'validation',
      occurredAt: null,
      safeProjection: {
        eventLabel: '商品审核',
        appScopedOnly: true,
        receivedAt: '2026-07-31T13:00:00.000Z',
        identifiers: {},
      },
      createdAt: '2026-07-31T13:00:00.000Z',
    }],
  },
});

test('platform query defaults to operator attention with honest health and subscription evidence', () => {
  const result = queryPlatformDashboard(DASHBOARD);

  assert.equal(result.readOnly, true);
  assert.equal(result.query.view, 'ATTENTION');
  assert.equal(result.summary.scopedEventCount, 5);
  assert.equal(result.summary.attentionEventCount, 3);
  assert.equal(result.summary.last24hAttentionCount, 2);
  assert.equal(result.summary.highPriorityCount, 2);
  assert.equal(result.summary.failureEventCount, 1);
  assert.equal(result.summary.businessEventCount, 4);
  assert.equal(result.summary.technicalEventCount, 1);
  assert.equal(result.summary.impactedStoreCount, 3);
  assert.deepEqual(
    result.events.rows.map(({ eventCode }) => eventCode),
    ['3001435', '3001048', '3001441'],
  );
  assert.equal(result.events.pagination.matchedMaterializedRows, 3);
  assert.deepEqual(result.summary.attentionByStore.map(({ key, count }) => ({
    key,
    count,
  })), [
    { key: 'DL5477', count: 1 },
    { key: 'MZ2406', count: 1 },
    { key: 'JY8060', count: 1 },
  ]);
  assert.deepEqual(result.subscription, {
    readbackCount: 2,
    mismatchedCount: 1,
    callbackFailedCount: 1,
    callbackUnknownCount: 0,
    latestCheckedAt: '2026-07-31T15:10:00.000Z',
    rows: DASHBOARD.platform.subscriptions,
  });
  assert.deepEqual(result.source.eventMaterialization, {
    returned: 5,
    limit: 100,
    truncated: false,
  });
});

test('store and owner scope exclude app-only events and never narrow read permission', () => {
  const owner = queryPlatformDashboard(
    DASHBOARD,
    new URLSearchParams('owner=owner-a&view=ALL&pageSize=25'),
  );
  assert.equal(owner.summary.scopedEventCount, 3);
  assert.deepEqual(
    owner.events.rows.map(({ storeCode }) => storeCode).sort(),
    ['DL5477', 'DL5477', 'MZ2406'],
  );

  const store = queryPlatformDashboard(
    DASHBOARD,
    new URLSearchParams('store=DL5477&view=ALL&pageSize=25'),
  );
  assert.equal(store.summary.scopedEventCount, 2);
  assert.equal(store.events.rows.every(({ storeCode }) => storeCode === 'DL5477'), true);
});

test('family, severity, status, search and paging are server-side and bounded', () => {
  const result = queryPlatformDashboard(
    DASHBOARD,
    new URLSearchParams([
      ['view', 'ALL'],
      ['severity', 'P2'],
      ['family', 'delivery'],
      ['status', 'IN_TRANSIT'],
      ['q', 'DN-1'],
      ['sort', 'LATEST'],
      ['page', '1'],
      ['pageSize', '25'],
    ]),
  );
  assert.equal(result.events.pagination.matchedMaterializedRows, 1);
  assert.equal(result.events.rows[0].businessKey, 'DN-1');
  assert.equal(result.query.family, 'DELIVERY');
  assert.equal(result.query.status, 'IN_TRANSIT');
  assert.equal(result.query.severity, 'P2');
  assert.equal(result.query.sort, 'LATEST');
});

test('business view excludes technical validation callbacks while all view keeps them', () => {
  const business = queryPlatformDashboard(
    DASHBOARD,
    new URLSearchParams('view=BUSINESS&pageSize=25'),
  );
  assert.equal(business.events.pagination.matchedMaterializedRows, 4);
  assert.equal(business.events.rows.some(({ deliveryScope }) => deliveryScope === 'APP_ONLY'), false);

  const all = queryPlatformDashboard(
    DASHBOARD,
    new URLSearchParams('view=ALL&pageSize=25'),
  );
  assert.equal(all.events.pagination.matchedMaterializedRows, 5);
  assert.equal(all.events.rows.some(({ deliveryScope }) => deliveryScope === 'APP_ONLY'), true);
});

test('platform query rejects unknown, duplicate and unbounded parameters', () => {
  for (const params of [
    new URLSearchParams('unknown=1'),
    new URLSearchParams('view=ALL&view=ATTENTION'),
    new URLSearchParams('view=EVERYTHING'),
    new URLSearchParams('pageSize=500'),
    new URLSearchParams('family=%3Cscript%3E'),
    new URLSearchParams('owner=missing'),
  ]) {
    assert.throws(
      () => queryPlatformDashboard(DASHBOARD, params),
      PlatformQueryError,
    );
  }
});
