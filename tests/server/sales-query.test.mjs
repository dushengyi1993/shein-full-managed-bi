import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SalesQueryError,
  querySalesDashboard,
} from '../../src/server/sales-query.mjs';

function units(today, last7Days, last30Days, yesterday = null) {
  return { today, yesterday, last7Days, last30Days };
}

function dashboard() {
  return {
    updatedAt: '2026-07-29T01:00:00.000Z',
    businessDate: '2026-07-28',
    dataset: { status: 'live' },
    salesCoverage: { status: 'partial', coveredStores: 2, totalStores: 2 },
    quality: { status: 'partial', label: '部分覆盖' },
    owners: [
      { key: 'alice', name: 'Alice', storeCodes: ['DL5477'] },
      { key: 'bob', name: 'Bob', storeCodes: ['MZ2406'] },
    ],
    storeRanking: [
      { code: 'DL5477', name: 'DL', unitsSold: units(5, 70, 100) },
      { code: 'MZ2406', name: 'MZ', unitsSold: units(null, 7, 30) },
    ],
    storeSkuRanking: [
      {
        storeCode: 'DL5477',
        sku: 'SKU-A',
        name: 'A',
        mappingStatus: 'CONFIRMED',
        canonicalProductId: 'P-A',
        standardProductCode: 'STD-A',
        unitsSold: units(3, 70, 100),
      },
      {
        storeCode: 'DL5477',
        sku: 'SKU-B',
        name: 'B',
        mappingStatus: 'UNMAPPED',
        unitsSold: units(1, 7, 30),
      },
      {
        storeCode: 'MZ2406',
        sku: 'SKU-C',
        name: 'C',
        mappingStatus: 'UNMAPPED',
        unitsSold: units(null, null, null),
      },
    ],
    productRanking: [
      {
        canonicalProductId: 'P-A',
        standardProductCode: 'STD-A',
        identityLevel: 'CANONICAL_CONFIRMED',
        mappingStatus: 'CONFIRMED',
        name: 'Standard A',
        storeCodes: ['DL5477'],
        unitsSold: units(3, 70, 100),
      },
    ],
    rankingMeta: {
      store: { returnedCount: 2, totalCount: 2, truncated: false },
      storeSku: { returnedCount: 3, totalCount: 20, truncated: true },
      product: { returnedCount: 1, totalCount: 1, truncated: false },
    },
  };
}

test('sales query applies owner, identity, momentum, sort and pagination', () => {
  const result = querySalesDashboard(
    dashboard(),
    new URLSearchParams({
      owner: 'alice',
      identity: 'CANONICAL',
      momentum: 'GROWING',
      sort: 'MOMENTUM_DESC',
      productPage: '1',
      standardPage: '1',
      pageSize: '1',
    }),
  );
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.stores.rows.map((row) => row.code), ['DL5477']);
  assert.deepEqual(result.products.rows.map((row) => row.sku), ['SKU-A']);
  assert.deepEqual(
    result.standardProducts.rows.map((row) => row.standardProductCode),
    ['STD-A'],
  );
  assert.equal(result.products.pagination.matchedMaterializedRows, 1);
  assert.equal(result.products.rows[0].momentum.direction, 'GROWING');
});

test('null sales stay null and source truncation remains explicit', () => {
  const result = querySalesDashboard(
    dashboard(),
    new URLSearchParams({
      store: 'MZ2406',
      momentum: 'UNCOMPARABLE',
      pageSize: '10',
    }),
  );
  assert.equal(result.products.rows.length, 1);
  assert.equal(result.products.rows[0].unitsSold.today, null);
  assert.equal(result.products.rows[0].momentum.comparable, false);
  assert.equal(result.source.materializedRankings.storeSku.returned, 3);
  assert.equal(result.source.materializedRankings.storeSku.total, 20);
  assert.equal(result.source.materializedRankings.storeSku.truncated, true);
  assert.equal(result.summary.matchedMaterializedProductCount, 1);
});

test('text search is server-side and preserves an honest empty result', () => {
  const found = querySalesDashboard(
    dashboard(),
    new URLSearchParams({ q: 'std-a', pageSize: '10' }),
  );
  assert.equal(found.products.rows.length, 1);
  assert.equal(found.standardProducts.rows.length, 1);

  const empty = querySalesDashboard(
    dashboard(),
    new URLSearchParams({ q: '不存在', pageSize: '10' }),
  );
  assert.equal(empty.summary.matchedMaterializedStoreCount, 0);
  assert.equal(empty.summary.matchedMaterializedProductCount, 0);
  assert.equal(empty.products.pagination.pageCount, 0);

  const unmapped = querySalesDashboard(
    dashboard(),
    new URLSearchParams({ identity: 'UNMAPPED', pageSize: '10' }),
  );
  assert.equal(unmapped.products.rows.length, 2);
  assert.equal(unmapped.standardProducts.rows.length, 0);
});

test('duplicates, bounds and unknown owner fail closed', () => {
  for (const params of [
    new URLSearchParams('pageSize=101'),
    new URLSearchParams('sort=NOPE'),
    new URLSearchParams('owner=unknown'),
    new URLSearchParams('q=a&q=b'),
  ]) {
    assert.throws(
      () => querySalesDashboard(dashboard(), params),
      SalesQueryError,
    );
  }
});
