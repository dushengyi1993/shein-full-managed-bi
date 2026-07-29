import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProductQueryError,
  queryProductDashboard,
} from '../../src/server/product-query.mjs';

function units(today, yesterday, last7Days, last30Days) {
  return { today, yesterday, last7Days, last30Days };
}

const DASHBOARD = Object.freeze({
  updatedAt: '2026-07-29T02:00:00.000Z',
  businessDate: '2026-07-28',
  dataset: { status: 'live' },
  owners: [
    { key: 'alice', name: 'Alice', storeCodes: ['DL5477'] },
    { key: 'bob', name: 'Bob', storeCodes: ['MZ2406'] },
  ],
  storeRanking: [
    { code: 'DL5477', name: 'DL' },
    { code: 'MZ2406', name: 'MZ' },
  ],
  productIdentityCoverage: {
    basis: 'active_catalog',
    confirmedSkus: 482,
    totalSkus: 10_079,
    unconfirmedSkus: 9_597,
    missingSpuSkus: 38,
    coverageRate: 0.0478,
    status: 'partial',
  },
  productIdentityPipeline: {
    status: 'available',
    evidence: {
      sealedSetCount: 10_012,
      observedStoreCount: 24,
      identifierMemberCount: 364_545,
      latestSealedAt: '2026-07-29T01:00:00.000Z',
    },
    candidates: { total: 482, confirmed: 482 },
    decisions: { confirmedCount: 482 },
    assignments: { currentConfirmedCount: 482 },
    canonical: { globalActiveProductCount: 66, activeVariantCount: 66 },
  },
  storeSkuRanking: [
    {
      storeCode: 'DL5477',
      sku: 'SKU-PENDING-A',
      skc: 'SKC-A',
      supplierCode: 'SUP-A',
      supplierSku: 'MERCHANT-A',
      productKey: 'KEY-A',
      name: '待归并商品 A',
      mappingStatus: 'UNMAPPED',
      unitsSold: units(9, 4, 40, 100),
    },
    {
      storeCode: 'DL5477',
      sku: 'SKU-PENDING-B',
      skc: 'SKC-B',
      supplierCode: 'SUP-B',
      name: '待归并商品 B',
      mappingStatus: 'MISSING_SPU_ID',
      unitsSold: units(0, 1, 3, null),
    },
    {
      storeCode: 'DL5477',
      sku: 'SKU-CONFIRMED',
      skc: 'SKC-C',
      supplierCode: 'SUP-C',
      name: '已归并商品',
      mappingStatus: 'CONFIRMED',
      canonicalProductId: 'CP-1',
      standardProductCode: 'STD-1',
      unitsSold: units(5, 5, 35, 150),
    },
    {
      storeCode: 'MZ2406',
      sku: 'SKU-PENDING-MZ',
      skc: 'SKC-MZ',
      supplierCode: 'SUP-MZ',
      name: '待归并商品 MZ',
      mappingStatus: 'UNMAPPED',
      unitsSold: units(3, null, 20, 60),
    },
  ],
  productRanking: [
    {
      canonicalProductId: 'CP-1',
      standardProductCode: 'STD-1',
      name: '标准商品一号',
      identityLevel: 'CANONICAL_CONFIRMED',
      mappingStatus: 'CONFIRMED',
      storeCodes: ['DL5477', 'MZ2406'],
      storeCount: 2,
      storeBreakdown: [
        { storeCode: 'DL5477', unitsSold: units(5, 5, 35, 150) },
        { storeCode: 'MZ2406', unitsSold: units(7, null, 21, 90) },
      ],
      unitsSold: units(12, null, 56, 240),
    },
    {
      canonicalProductId: 'CP-2',
      standardProductCode: 'STD-2',
      name: '标准商品二号',
      identityLevel: 'CANONICAL_CONFIRMED',
      mappingStatus: 'CONFIRMED',
      storeCodes: ['MZ2406'],
      storeCount: 1,
      storeBreakdown: [
        { storeCode: 'MZ2406', unitsSold: units(0, 0, 4, 12) },
      ],
      unitsSold: units(0, 0, 4, 12),
    },
    {
      storeCode: 'DL5477',
      name: '店内未验证商品',
      identityLevel: 'STORE_LOCAL_UNVERIFIED',
      mappingStatus: 'UNVERIFIED',
      storeCodes: ['DL5477'],
      storeCount: 1,
      storeBreakdown: [],
      unitsSold: units(4, 4, 12, 30),
    },
  ],
  rankingMeta: {
    storeSku: { returnedCount: 4, totalCount: 1_500, truncated: true },
    product: { returnedCount: 3, totalCount: 759, truncated: true },
  },
});

test('product query is read-only and separates the pending queue from standard products', () => {
  const result = queryProductDashboard(DASHBOARD, new URLSearchParams({ pageSize: '25' }));
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.readOnly, true);

  // Pending holds only unconfirmed store-local rows, with identity intact.
  assert.deepEqual(
    result.pending.rows.map((row) => row.sku),
    ['SKU-PENDING-A', 'SKU-PENDING-MZ', 'SKU-PENDING-B'],
  );
  assert.ok(result.pending.rows.every((row) => row.mappingStatus !== 'CONFIRMED'));
  const [first] = result.pending.rows;
  assert.equal(first.storeCode, 'DL5477');
  assert.equal(first.supplierCode, 'SUP-A');
  assert.equal(first.skc, 'SKC-A');
  assert.equal(first.sku, 'SKU-PENDING-A');

  // Canonical holds only GLOBAL/CONFIRMED materialized rows.
  assert.deepEqual(
    result.canonical.rows.map((row) => row.standardProductCode),
    ['STD-1', 'STD-2'],
  );
  assert.ok(result.canonical.rows.every((row) => row.identityLevel === 'CANONICAL_CONFIRMED'));
  assert.equal(result.summary.matchedMaterializedPendingRows, 3);
  assert.equal(result.summary.matchedMaterializedCanonicalRows, 2);
  assert.equal(result.summary.confirmedStoreSkuRows, 1);
  assert.equal(result.summary.missingSpuStoreSkuRows, 1);
  assert.equal(result.summary.pendingStoreCount, 2);
});

test('owner and store scope recompute canonical quantities from storeBreakdown', () => {
  const global = queryProductDashboard(DASHBOARD, new URLSearchParams());
  const globalRow = global.canonical.rows.find((row) => row.standardProductCode === 'STD-1');
  assert.equal(global.scope.canonicalQuantitiesRecomputed, false);
  assert.equal(globalRow.scopeRecomputed, false);
  assert.equal(globalRow.scopedStoreCount, 2);
  assert.equal(globalRow.unitsSold.today, 12);

  const scoped = queryProductDashboard(DASHBOARD, new URLSearchParams({ owner: 'alice' }));
  assert.equal(scoped.scope.canonicalQuantitiesRecomputed, true);
  assert.deepEqual(scoped.scope.scopedStoreCodes, ['DL5477']);
  // STD-2 has no in-scope store and is dropped rather than shown at zero.
  assert.deepEqual(scoped.canonical.rows.map((row) => row.standardProductCode), ['STD-1']);
  const scopedRow = scoped.canonical.rows[0];
  assert.equal(scopedRow.scopeRecomputed, true);
  assert.equal(scopedRow.scopedStoreCount, 1);
  // The global store count stays visible so the UI never presents it as scoped.
  assert.equal(scopedRow.totalStoreCount, 2);
  assert.deepEqual(scopedRow.storeCodes, ['DL5477']);
  assert.deepEqual(scopedRow.unitsSold, {
    today: 5, yesterday: 5, last7Days: 35, last30Days: 150,
  });
  assert.deepEqual(scoped.pending.rows.map((row) => row.storeCode), ['DL5477', 'DL5477']);

  const byStore = queryProductDashboard(DASHBOARD, new URLSearchParams({ store: 'MZ2406' }));
  const storeRow = byStore.canonical.rows.find((row) => row.standardProductCode === 'STD-1');
  assert.equal(storeRow.scopedStoreCount, 1);
  assert.equal(storeRow.totalStoreCount, 2);
  assert.equal(storeRow.unitsSold.today, 7);
  // One unknown constituent window keeps the recomputed window unknown.
  assert.equal(storeRow.unitsSold.yesterday, null);
});

test('an unknown constituent window keeps the cross-store total null', () => {
  const result = queryProductDashboard(DASHBOARD, new URLSearchParams());
  const row = result.canonical.rows.find((item) => item.standardProductCode === 'STD-1');
  assert.equal(row.unitsSold.yesterday, null);
  assert.equal(row.unitsSold.today, 12);

  const pending = result.pending.rows.find((item) => item.sku === 'SKU-PENDING-B');
  assert.equal(pending.unitsSold.last30Days, null);
  assert.equal(pending.unitsSold.today, 0);

  // Every today value is known, so a legal zero contributes and the total holds.
  assert.equal(result.summary.pendingImpact.total, 12);
  assert.equal(result.summary.pendingImpact.unknownCount, 0);
  assert.equal(result.summary.pendingImpact.knownSum, 12);

  // One unknown row keeps the total unknown while the known part stays visible.
  const last30 = queryProductDashboard(DASHBOARD, new URLSearchParams({ range: 'last30Days' }));
  assert.equal(last30.summary.pendingImpact.total, null);
  assert.equal(last30.summary.pendingImpact.unknownCount, 1);
  assert.equal(last30.summary.pendingImpact.knownCount, 2);
  assert.equal(last30.summary.pendingImpact.knownSum, 160);
  assert.equal(last30.summary.canonicalImpact.total, 252);
});

test('text search, quick filters and sort run server-side per list', () => {
  const searched = queryProductDashboard(DASHBOARD, new URLSearchParams({ q: 'sup-a' }));
  assert.deepEqual(searched.pending.rows.map((row) => row.sku), ['SKU-PENDING-A']);
  assert.deepEqual(searched.canonical.rows, []);
  assert.equal(searched.canonical.pagination.pageCount, 0);

  const byStandardCode = queryProductDashboard(DASHBOARD, new URLSearchParams({ q: 'std-2' }));
  assert.deepEqual(byStandardCode.canonical.rows.map((row) => row.standardProductCode), ['STD-2']);
  assert.deepEqual(byStandardCode.pending.rows, []);

  // MISSING_SPU narrows the pending queue only; canonical keeps an honest count.
  const missingSpu = queryProductDashboard(DASHBOARD, new URLSearchParams({ quick: 'MISSING_SPU' }));
  assert.deepEqual(missingSpu.pending.rows.map((row) => row.sku), ['SKU-PENDING-B']);
  assert.equal(missingSpu.scope.quickAppliesToPending, true);
  assert.equal(missingSpu.scope.quickAppliesToCanonical, false);
  assert.equal(missingSpu.canonical.pagination.matchedMaterializedRows, 2);

  // UNMAPPED means "waiting for evidence" and excludes missing-SPU rows.
  const unmapped = queryProductDashboard(DASHBOARD, new URLSearchParams({ quick: 'UNMAPPED' }));
  assert.deepEqual(
    unmapped.pending.rows.map((row) => row.sku),
    ['SKU-PENDING-A', 'SKU-PENDING-MZ'],
  );

  // CANONICAL narrows the standard list only.
  const canonicalOnly = queryProductDashboard(DASHBOARD, new URLSearchParams({ quick: 'CANONICAL' }));
  assert.equal(canonicalOnly.scope.quickAppliesToPending, false);
  assert.equal(canonicalOnly.scope.quickAppliesToCanonical, true);
  assert.equal(canonicalOnly.pending.pagination.matchedMaterializedRows, 3);
  assert.equal(canonicalOnly.canonical.pagination.matchedMaterializedRows, 2);

  // WITH_SALES respects the selected range on both lists.
  const withSalesToday = queryProductDashboard(
    DASHBOARD,
    new URLSearchParams({ quick: 'WITH_SALES', range: 'today' }),
  );
  assert.deepEqual(
    withSalesToday.pending.rows.map((row) => row.sku),
    ['SKU-PENDING-A', 'SKU-PENDING-MZ'],
  );
  assert.deepEqual(withSalesToday.canonical.rows.map((row) => row.standardProductCode), ['STD-1']);

  const withSalesLast30 = queryProductDashboard(
    DASHBOARD,
    new URLSearchParams({ quick: 'WITH_SALES', range: 'last30Days' }),
  );
  assert.deepEqual(
    withSalesLast30.canonical.rows.map((row) => row.standardProductCode),
    ['STD-1', 'STD-2'],
  );

  const byStore = queryProductDashboard(DASHBOARD, new URLSearchParams({ sort: 'STORE_ASC' }));
  assert.deepEqual(
    byStore.pending.rows.map((row) => row.storeCode),
    ['DL5477', 'DL5477', 'MZ2406'],
  );

  const byLast30 = queryProductDashboard(DASHBOARD, new URLSearchParams({ sort: 'LAST30_DESC' }));
  assert.deepEqual(
    byLast30.pending.rows.map((row) => row.sku),
    ['SKU-PENDING-A', 'SKU-PENDING-MZ', 'SKU-PENDING-B'],
  );
  assert.equal(byLast30.query.sort, 'LAST30_DESC');
});

test('pending and canonical pages stay independent within allowed page sizes', () => {
  const paged = queryProductDashboard(
    DASHBOARD,
    new URLSearchParams({ pageSize: '25', pendingPage: '2', canonicalPage: '1' }),
  );
  assert.deepEqual(paged.pending.rows, []);
  assert.deepEqual(paged.pending.pagination, {
    page: 2,
    pageSize: 25,
    pageCount: 1,
    matchedMaterializedRows: 3,
    hasPrevious: true,
    hasNext: false,
  });
  // The other list keeps its own page and is unaffected.
  assert.deepEqual(paged.canonical.pagination, {
    page: 1,
    pageSize: 25,
    pageCount: 1,
    matchedMaterializedRows: 2,
    hasPrevious: false,
    hasNext: false,
  });

  for (const pageSize of ['25', '50', '100']) {
    const result = queryProductDashboard(DASHBOARD, new URLSearchParams({ pageSize }));
    assert.equal(result.query.pageSize, Number(pageSize));
    assert.equal(result.pending.pagination.pageSize, Number(pageSize));
    assert.equal(result.canonical.pagination.pageSize, Number(pageSize));
  }
  assert.deepEqual(
    queryProductDashboard(DASHBOARD, new URLSearchParams()).filters.pageSizes,
    [25, 50, 100],
  );
});

test('source metadata reports materialized truncation instead of the SHEIN universe', () => {
  const result = queryProductDashboard(DASHBOARD, new URLSearchParams({ owner: 'alice' }));
  assert.deepEqual(result.pending.source, { returned: 4, total: 1_500, truncated: true });
  assert.deepEqual(result.canonical.source, { returned: 3, total: 759, truncated: true });
  assert.deepEqual(result.source.materializedRankings.storeSku, {
    returned: 4, total: 1_500, truncated: true,
  });
  // Matched counts are scope-local and never inherit the source total.
  assert.equal(result.pending.pagination.matchedMaterializedRows, 2);
  assert.notEqual(result.pending.pagination.matchedMaterializedRows, 1_500);

  // The two universes stay separate: active catalog vs sealed evidence run.
  assert.equal(result.source.activeCatalogCoverage.confirmedSkus, 482);
  assert.equal(result.source.activeCatalogCoverage.totalSkus, 10_079);
  assert.equal(result.source.activeCatalogCoverage.missingSpuSkus, 38);
  assert.equal(result.source.pipeline.evidence.sealedSetCount, 10_012);
  assert.equal(result.source.pipeline.evidence.observedStoreCount, 24);
  assert.equal(result.source.pipeline.canonical.globalActiveProductCount, 66);
  assert.equal(result.source.businessDate, '2026-07-28');

  const empty = queryProductDashboard({}, new URLSearchParams());
  assert.deepEqual(empty.pending.rows, []);
  assert.deepEqual(empty.canonical.rows, []);
  assert.equal(empty.summary.pendingImpact.total, null);
  assert.equal(empty.summary.pendingImpact.knownSum, null);
  assert.equal(empty.source.activeCatalogCoverage.totalSkus, null);
});

test('duplicate, unknown and out-of-range parameters fail closed', () => {
  for (const params of [
    new URLSearchParams('q=a&q=b'),
    new URLSearchParams('quick=ALL&quick=CANONICAL'),
    new URLSearchParams('pendingPage=1&pendingPage=2'),
    new URLSearchParams('pageSize=25&pageSize=50'),
    new URLSearchParams('quick=NOPE'),
    new URLSearchParams('sort=NOPE'),
    new URLSearchParams('range=forever'),
    new URLSearchParams('pendingPage=0'),
    new URLSearchParams('canonicalPage=0'),
    new URLSearchParams('pendingPage=10001'),
    new URLSearchParams('pageSize=10'),
    new URLSearchParams('pageSize=101'),
    new URLSearchParams('pageSize=0'),
    new URLSearchParams('owner=unknown'),
    new URLSearchParams('store=ZZ9999'),
    new URLSearchParams('store=not a store'),
    new URLSearchParams({ q: 'x'.repeat(121) }),
  ]) {
    assert.throws(
      () => queryProductDashboard(DASHBOARD, params),
      ProductQueryError,
      `expected rejection for ${params.toString()}`,
    );
  }

  assert.throws(
    () => queryProductDashboard(
      DASHBOARD,
      new URLSearchParams({ owner: 'alice', store: 'MZ2406' }),
    ),
    (error) => error instanceof ProductQueryError
      && error.code === 'QUERY_STORE_UNKNOWN'
      && error.statusCode === 400,
  );

  const duplicate = new URLSearchParams('q=a&q=b');
  assert.throws(
    () => queryProductDashboard(DASHBOARD, duplicate),
    (error) => error.code === 'QUERY_PARAMETER_DUPLICATED',
  );
  assert.throws(
    () => queryProductDashboard(DASHBOARD, new URLSearchParams('pageSize=101')),
    (error) => error.code === 'QUERY_PARAMETER_OUT_OF_RANGE',
  );
});

test('the response exposes only whitelisted query and filter options', () => {
  const result = queryProductDashboard(DASHBOARD, new URLSearchParams());
  assert.deepEqual(Object.keys(result.query), [
    'owner', 'store', 'q', 'quick', 'sort', 'range',
    'pendingPage', 'canonicalPage', 'pageSize',
  ]);
  assert.deepEqual(result.filters.quick, [
    'ALL', 'WITH_SALES', 'UNMAPPED', 'MISSING_SPU', 'CANONICAL',
  ]);
  assert.deepEqual(result.filters.sorts, [
    'IMPACT_DESC', 'LAST30_DESC', 'LAST7_DESC', 'TODAY_DESC', 'STORE_ASC',
  ]);
  assert.deepEqual(result.filters.ranges, ['today', 'yesterday', 'last7Days', 'last30Days']);
  assert.deepEqual(result.filters.stores.map((store) => store.code), ['DL5477', 'MZ2406']);
  assert.deepEqual(result.filters.owners.map((owner) => owner.key), ['alice', 'bob']);
});
