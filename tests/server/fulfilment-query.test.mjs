import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FulfilmentQueryError,
  queryFulfilmentDashboard,
} from '../../src/server/fulfilment-query.mjs';

/**
 * Milestone and attention codes below are the exact values
 * `src/warehouse/supply-repository.mjs` emits: milestones RECEIVED, IN_TRANSIT,
 * PICKUP_RESERVED and CREATED; attention codes RECEIPT_OVERDUE,
 * IN_TRANSIT_PENDING_RECEIPT, PICKUP_RESERVED_PENDING and
 * DELIVERY_CREATED_PENDING. Quantities mirror the production snapshot.
 */
const DASHBOARD = Object.freeze({
  updatedAt: '2026-07-29T01:00:00.000Z',
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
        deliveries: {
          status: 'partial',
          succeededStores: 23,
          totalStores: 25,
          inProgressStores: 1,
          inProgressStoreCodes: ['FY4021'],
          failedStores: 0,
          missingStores: 0,
          staleStores: 0,
          watermarkStart: '2026-07-26T22:47:08.000Z',
          watermarkEnd: '2026-07-29T00:45:19.000Z',
          latestFetchedAt: '2026-07-29T00:45:19.000Z',
        },
      },
    },
    attentionMeta: {
      deliveries: { available: true, total: 113, returned: 113, truncated: false },
    },
    deliveryMilestones: [
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        milestoneCode: 'RECEIVED',
        deliveryCount: 7962,
        deliveryQuantity: 118_606,
        latestSourceFetchedAt: '2026-07-29T00:45:19.000Z',
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        milestoneCode: 'IN_TRANSIT',
        deliveryCount: 80,
        deliveryQuantity: 1498,
        latestSourceFetchedAt: '2026-07-29T00:45:19.000Z',
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        milestoneCode: 'PICKUP_RESERVED',
        deliveryCount: 32,
        deliveryQuantity: 472,
        latestSourceFetchedAt: '2026-07-29T00:45:19.000Z',
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        milestoneCode: 'CREATED',
        deliveryCount: 1,
        deliveryQuantity: 10,
        latestSourceFetchedAt: '2026-07-29T00:45:19.000Z',
      },
      {
        // An unknown quantity keeps the scoped quantity total unknown.
        storeCode: 'MZ2406',
        storeName: 'MZ2406',
        milestoneCode: 'IN_TRANSIT',
        deliveryCount: 4,
        deliveryQuantity: null,
        latestSourceFetchedAt: '2026-07-28T23:00:00.000Z',
      },
    ],
    deliveryAttention: [
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        deliveryCode: 'DN-TRANSIT',
        milestoneCode: 'IN_TRANSIT',
        attentionCode: 'IN_TRANSIT_PENDING_RECEIPT',
        attentionLabel: '运输中待收货',
        severity: 'medium',
        warehouseName: '广州仓',
        expressCode: 'SF-001',
        expressCompanyName: '顺丰',
        reservedParcelAt: '2026-07-27T02:00:00.000Z',
        takenAt: '2026-07-27T06:00:00.000Z',
        expectedReceiptAt: null,
        receivedAt: null,
        lineCount: 3,
        deliveryQuantity: 40,
        latestSourceFetchedAt: '2026-07-29T00:45:19.000Z',
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        deliveryCode: 'DN-OVERDUE',
        milestoneCode: 'IN_TRANSIT',
        attentionCode: 'RECEIPT_OVERDUE',
        attentionLabel: '逾期待收货',
        severity: 'critical',
        warehouseName: '广州仓',
        expressCode: 'SF-002',
        expressCompanyName: '顺丰',
        reservedParcelAt: '2026-07-25T02:00:00.000Z',
        takenAt: '2026-07-25T06:00:00.000Z',
        expectedReceiptAt: '2026-07-27T00:00:00.000Z',
        receivedAt: null,
        lineCount: 2,
        deliveryQuantity: 25,
        latestSourceFetchedAt: '2026-07-29T00:45:19.000Z',
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        deliveryCode: 'DN-PICKUP',
        milestoneCode: 'PICKUP_RESERVED',
        attentionCode: 'PICKUP_RESERVED_PENDING',
        attentionLabel: '已预约待揽收',
        severity: 'medium',
        warehouseName: '广州仓',
        expressCode: null,
        expressCompanyName: null,
        reservedParcelAt: '2026-07-28T02:00:00.000Z',
        takenAt: null,
        expectedReceiptAt: null,
        receivedAt: null,
        lineCount: 1,
        deliveryQuantity: null,
        latestSourceFetchedAt: '2026-07-29T00:45:19.000Z',
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL5477',
        deliveryCode: 'DN-CREATED',
        milestoneCode: 'CREATED',
        attentionCode: 'DELIVERY_CREATED_PENDING',
        attentionLabel: '已创建待预约',
        severity: 'low',
        warehouseName: null,
        expressCode: null,
        expressCompanyName: null,
        reservedParcelAt: null,
        takenAt: null,
        expectedReceiptAt: null,
        receivedAt: null,
        lineCount: 1,
        deliveryQuantity: 10,
        latestSourceFetchedAt: '2026-07-29T00:45:19.000Z',
      },
      {
        storeCode: 'MZ2406',
        storeName: 'MZ2406',
        deliveryCode: 'MZ-TRANSIT',
        milestoneCode: 'IN_TRANSIT',
        attentionCode: 'IN_TRANSIT_PENDING_RECEIPT',
        attentionLabel: '运输中待收货',
        severity: 'high',
        warehouseName: '佛山仓',
        expressCode: 'YT-100',
        expressCompanyName: '圆通',
        reservedParcelAt: '2026-07-26T02:00:00.000Z',
        takenAt: '2026-07-26T06:00:00.000Z',
        expectedReceiptAt: null,
        receivedAt: null,
        lineCount: 5,
        deliveryQuantity: 60,
        latestSourceFetchedAt: '2026-07-28T23:00:00.000Z',
      },
    ],
  },
});

test('fulfilment query is read-only and scopes both lists by owner', () => {
  const result = queryFulfilmentDashboard(
    DASHBOARD,
    new URLSearchParams({ owner: 'alice', pageSize: '25' }),
  );
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.readOnly, true);
  assert.deepEqual(
    result.attention.rows.map((row) => row.deliveryCode),
    ['DN-OVERDUE', 'DN-TRANSIT', 'DN-PICKUP', 'DN-CREATED'],
  );
  assert.deepEqual(
    result.milestoneOverview.map((row) => row.milestoneCode),
    ['RECEIVED', 'IN_TRANSIT', 'PICKUP_RESERVED', 'CREATED'],
  );
  assert.equal(result.summary.storeCount, 1);
  assert.deepEqual(result.summary.attentionByStore, [{
    storeCode: 'DL5477',
    storeName: 'DL5477',
    attentionCount: 4,
    createdCount: 1,
    pickupReservedCount: 1,
    inTransitCount: 2,
    receiptOverdueCount: 1,
    deliveryQuantity: {
      knownSum: 75,
      total: null,
      knownCount: 3,
      unknownCount: 1,
      rowCount: 4,
    },
    oldestInTransitTakenAt: '2026-07-25T06:00:00.000Z',
    latestSourceFetchedAt: '2026-07-29T00:45:19.000Z',
  }]);

  const scopedByStore = queryFulfilmentDashboard(
    DASHBOARD,
    new URLSearchParams({ store: 'MZ2406' }),
  );
  assert.deepEqual(
    scopedByStore.attention.rows.map((row) => row.deliveryCode),
    ['MZ-TRANSIT'],
  );
  assert.equal(scopedByStore.summary.matchedMaterializedAttentionCount, 1);
});

test('quick filters map to explicit delivery attention codes', () => {
  const codesFor = (quick) => queryFulfilmentDashboard(
    DASHBOARD,
    new URLSearchParams({ quick, pageSize: '100' }),
  ).attention.rows.map((row) => row.attentionCode);

  // The materializer emits DELIVERY_CREATED_PENDING, not CREATED_PENDING.
  assert.deepEqual([...new Set(codesFor('CREATED'))], ['DELIVERY_CREATED_PENDING']);
  assert.deepEqual([...new Set(codesFor('PICKUP_RESERVED'))], ['PICKUP_RESERVED_PENDING']);
  // An overdue receipt is still in transit, so IN_TRANSIT covers both codes.
  assert.deepEqual([...new Set(codesFor('IN_TRANSIT'))].sort(), [
    'IN_TRANSIT_PENDING_RECEIPT', 'RECEIPT_OVERDUE',
  ]);
  // Every attention row is unreceived, so PENDING_RECEIPT spans all four codes.
  assert.deepEqual([...new Set(codesFor('PENDING_RECEIPT'))].sort(), [
    'DELIVERY_CREATED_PENDING',
    'IN_TRANSIT_PENDING_RECEIPT',
    'PICKUP_RESERVED_PENDING',
    'RECEIPT_OVERDUE',
  ]);
  assert.equal(codesFor('PENDING_RECEIPT').length, 5);

  // CREATED must not absorb the reserved or in-transit rows.
  assert.ok(!codesFor('CREATED').includes('PICKUP_RESERVED_PENDING'));
  assert.ok(!codesFor('CREATED').includes('IN_TRANSIT_PENDING_RECEIPT'));

  const high = queryFulfilmentDashboard(
    DASHBOARD,
    new URLSearchParams({ quick: 'HIGH', pageSize: '100' }),
  );
  assert.deepEqual(
    high.attention.rows.map((row) => row.deliveryCode),
    ['DN-OVERDUE', 'MZ-TRANSIT'],
  );
  assert.equal(
    queryFulfilmentDashboard(DASHBOARD, new URLSearchParams({ pageSize: '100' }))
      .attention.rows.length,
    5,
  );
});

test('delivery count and quantity stay separate and never invent a total', () => {
  const result = queryFulfilmentDashboard(DASHBOARD, new URLSearchParams({ pageSize: '25' }));
  // Snapshot counts are complete across every scoped milestone row.
  assert.equal(result.summary.snapshotDeliveryCount.total, 8079);
  // One store reports an unknown quantity, so the quantity total stays unknown
  // while the known part remains visible.
  assert.equal(result.summary.snapshotDeliveryQuantity.total, null);
  assert.equal(result.summary.snapshotDeliveryQuantity.knownSum, 120_586);
  assert.equal(result.summary.snapshotDeliveryQuantity.unknownCount, 1);
  assert.notEqual(
    result.summary.snapshotDeliveryCount.total,
    result.summary.snapshotDeliveryQuantity.knownSum,
  );
  assert.match(result.summary.attentionScopeLabel, /单位不同不可相加/);
  assert.doesNotMatch(JSON.stringify(result.summary), /rate|percent|conversion|funnel/i);

  // The attention scope is its own quantity scope, separate from the snapshot.
  assert.equal(result.summary.attentionDeliveryQuantity.total, null);
  assert.equal(result.summary.attentionDeliveryQuantity.knownSum, 135);
  assert.equal(result.summary.attentionLineCount.total, 12);

  const alice = queryFulfilmentDashboard(
    DASHBOARD,
    new URLSearchParams({ owner: 'alice', pageSize: '25' }),
  );
  assert.equal(alice.summary.snapshotDeliveryQuantity.total, 120_586);
  assert.equal(alice.summary.snapshotDeliveryCount.total, 8075);
});

test('a missing expectedReceiptAt stays unknown and sorts last', () => {
  const result = queryFulfilmentDashboard(
    DASHBOARD,
    new URLSearchParams({ sort: 'EXPECTED_RECEIPT', pageSize: '100' }),
  );
  // Only DN-OVERDUE carries an expectation; it leads, unknowns follow.
  assert.equal(result.attention.rows[0].deliveryCode, 'DN-OVERDUE');
  assert.equal(result.summary.expectedReceiptKnownCount, 1);
  for (const row of result.attention.rows.slice(1)) {
    assert.equal(row.expectedReceiptAt, null);
  }
  // An absent expectation is never backfilled from another timestamp.
  const created = result.attention.rows.find((row) => row.deliveryCode === 'DN-CREATED');
  assert.equal(created.expectedReceiptAt, null);
  assert.equal(created.receivedAt, null);
});

test('the milestone overview is aggregated per milestone with independent nulls', () => {
  const result = queryFulfilmentDashboard(DASHBOARD, new URLSearchParams({ pageSize: '25' }));
  const inTransit = result.milestoneOverview.find((row) => row.milestoneCode === 'IN_TRANSIT');
  assert.deepEqual(inTransit, {
    milestoneCode: 'IN_TRANSIT',
    storeCount: 2,
    // The count is known for both stores; the quantity is not.
    deliveryCount: 84,
    deliveryQuantity: null,
  });
  assert.ok(result.milestoneOverview.length < result.summary.matchedMilestoneRowCount + 1);
  assert.deepEqual(
    result.milestoneOverview.find((row) => row.milestoneCode === 'RECEIVED'),
    {
      milestoneCode: 'RECEIVED',
      storeCount: 1,
      deliveryCount: 7962,
      deliveryQuantity: 118_606,
    },
  );

  const filtered = queryFulfilmentDashboard(
    DASHBOARD,
    new URLSearchParams({ milestone: 'CREATED', pageSize: '25' }),
  );
  assert.deepEqual(filtered.milestoneOverview.map((row) => row.milestoneCode), ['CREATED']);
  assert.deepEqual(filtered.attention.rows.map((row) => row.deliveryCode), ['DN-CREATED']);
});

test('evidence coverage, watermarks and truncation are reported exactly', () => {
  const result = queryFulfilmentDashboard(DASHBOARD, new URLSearchParams({ pageSize: '25' }));
  assert.deepEqual(result.attention.source, {
    available: true,
    total: 113,
    returned: 113,
    truncated: false,
  });
  assert.equal(result.source.coverage.succeededStores, 23);
  assert.equal(result.source.coverage.totalStores, 25);
  assert.equal(result.source.coverage.failedStores, 0);
  assert.equal(result.source.coverage.staleStores, 0);
  assert.deepEqual(result.source.coverage.inProgressStoreCodes, ['FY4021']);
  assert.equal(result.source.coverage.watermarkStart, '2026-07-26T22:47:08.000Z');
  assert.equal(result.source.coverage.watermarkEnd, '2026-07-29T00:45:19.000Z');
  assert.equal(result.source.businessDate, '2026-07-28');

  const truncated = queryFulfilmentDashboard(
    {
      ...DASHBOARD,
      supply: {
        ...DASHBOARD.supply,
        attentionMeta: {
          deliveries: { available: true, total: 900, returned: 500, truncated: true },
        },
      },
    },
    new URLSearchParams({ pageSize: '25' }),
  );
  assert.equal(truncated.attention.source.truncated, true);
  assert.equal(truncated.attention.source.total, 900);
  // The matched count is scope-local and never inherits the source total.
  assert.equal(truncated.attention.pagination.matchedMaterializedRows, 5);

  const missing = queryFulfilmentDashboard({}, new URLSearchParams());
  assert.deepEqual(missing.attention.rows, []);
  assert.deepEqual(missing.milestoneOverview, []);
  assert.equal(missing.summary.snapshotDeliveryCount.total, null);
  assert.equal(missing.summary.snapshotDeliveryCount.knownSum, null);
  assert.equal(missing.attention.source.available, false);
});

test('text search and paging are server-side and bounded', () => {
  const found = queryFulfilmentDashboard(
    DASHBOARD,
    new URLSearchParams({ q: '圆通', pageSize: '25' }),
  );
  assert.deepEqual(found.attention.rows.map((row) => row.deliveryCode), ['MZ-TRANSIT']);

  const byExpress = queryFulfilmentDashboard(
    DASHBOARD,
    new URLSearchParams({ q: 'sf-002', pageSize: '25' }),
  );
  assert.deepEqual(byExpress.attention.rows.map((row) => row.deliveryCode), ['DN-OVERDUE']);

  const empty = queryFulfilmentDashboard(
    DASHBOARD,
    new URLSearchParams({ q: 'does-not-exist' }),
  );
  assert.deepEqual(empty.attention.rows, []);
  assert.equal(empty.attention.pagination.pageCount, 0);
  assert.equal(empty.summary.matchedMaterializedAttentionCount, 0);
  assert.equal(empty.summary.attentionDeliveryQuantity.knownSum, null);

  const firstPage = queryFulfilmentDashboard(
    DASHBOARD,
    new URLSearchParams({ pageSize: '25', page: '1' }),
  );
  assert.equal(firstPage.attention.pagination.pageCount, 1);
  assert.equal(firstPage.attention.pagination.hasNext, false);
  const secondPage = queryFulfilmentDashboard(
    DASHBOARD,
    new URLSearchParams({ pageSize: '25', page: '2' }),
  );
  assert.deepEqual(secondPage.attention.rows, []);
  assert.equal(secondPage.attention.pagination.hasPrevious, true);
  assert.equal(secondPage.attention.pagination.matchedMaterializedRows, 5);
});

test('query parameters are bounded and duplicate or unknown input fails closed', () => {
  for (const params of [
    new URLSearchParams('page=0'),
    new URLSearchParams('page=10001'),
    new URLSearchParams('pageSize=101'),
    new URLSearchParams('pageSize=2'),
    new URLSearchParams('pageSize=26'),
    new URLSearchParams('pageSize=0'),
    new URLSearchParams('quick=NOPE'),
    new URLSearchParams('quick=RECEIVED'),
    new URLSearchParams('sort=NOPE'),
    new URLSearchParams('owner=unknown'),
    new URLSearchParams('q=a&q=b'),
    new URLSearchParams('quick=ALL&quick=HIGH'),
    new URLSearchParams('milestone=A&milestone=B'),
    new URLSearchParams('page=1&page=2'),
    new URLSearchParams('pageSize=25&pageSize=50'),
    new URLSearchParams({ q: 'x'.repeat(81) }),
  ]) {
    assert.throws(
      () => queryFulfilmentDashboard(DASHBOARD, params),
      FulfilmentQueryError,
      `expected rejection for ${params.toString()}`,
    );
  }

  for (const pageSize of ['25', '50', '100']) {
    assert.equal(
      queryFulfilmentDashboard(DASHBOARD, new URLSearchParams({ pageSize })).query.pageSize,
      Number(pageSize),
    );
  }
  const options = queryFulfilmentDashboard(DASHBOARD, new URLSearchParams()).filters;
  assert.deepEqual(options.pageSizes, [25, 50, 100]);
  assert.deepEqual(options.quick, [
    'ALL', 'HIGH', 'CREATED', 'PICKUP_RESERVED', 'IN_TRANSIT', 'PENDING_RECEIPT',
  ]);
  assert.deepEqual(options.sorts, ['PRIORITY', 'LATEST', 'EXPECTED_RECEIPT']);
  assert.deepEqual(
    options.milestones.map((row) => row.code),
    ['CREATED', 'IN_TRANSIT', 'PICKUP_RESERVED', 'RECEIVED'],
  );
  assert.deepEqual(options.stores.map((row) => row.code), ['DL5477', 'MZ2406']);
  assert.deepEqual(Object.keys(
    queryFulfilmentDashboard(DASHBOARD, new URLSearchParams()).query,
  ), ['owner', 'store', 'q', 'milestone', 'quick', 'sort', 'page', 'pageSize']);
});
