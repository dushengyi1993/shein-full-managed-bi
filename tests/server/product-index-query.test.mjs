import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRODUCT_QUERY_DEFAULT_PAGE_SIZE,
  PRODUCT_QUERY_SORTS,
  ProductIndexQueryError,
  parseProductQuery,
  queryProductIndex,
} from '../../src/server/product-index-query.mjs';
import {
  ProductIndexDataError,
  normalizeProductIndex,
} from '../../src/server/product-index-data.mjs';

function skc(overrides = {}) {
  return {
    skc: 'sv1',
    spu: 'v1',
    supplierCode: 'MZ-1',
    categoryName: '厨房',
    shelfDays: 10,
    shelfDate: '2026-09-10',
    goodsLevelName: '备货款A',
    goodsLevelGroup: 'STOCK_A',
    labels: ['中东高销款'],
    skus: [{ skuCode: 'I1', price: 52, c7dSaleCnt: 40, c30dSaleCnt: 240, predictDaySales: 9.1, stock: 17 }],
    ...overrides,
  };
}

function index(overrides = {}) {
  return {
    schemaVersion: 1,
    storeCode: 'DL',
    capturedAt: '2026-09-20T00:00:00.000Z',
    shelfStatusCounts: { ALL: 253, ON_SHELF: 87, WAIT_SHELF: 85, OUT_SHELF: 66, SOLD_OUT: 15 },
    levelGroupCounts: { NEW: 1, STOCK_A: 1, total: 2 },
    productCount: 1,
    skcCount: 2,
    siteCoverageCount: 1,
    products: [{
      spu: 'v1',
      spuName: 'spu-1',
      productName: '电热饭盒',
      shelfStatus: 'ON_SHELF',
      skcs: [{ skcName: 'sv1', supplierCode: 'MZ-1', skuCodes: ['I1'] }],
    }],
    skcs: [
      skc(),
      skc({ skc: 'sv2', supplierCode: 'MZ-2', shelfDays: 3, goodsLevelGroup: 'NEW', goodsLevelName: '新款', labels: [], skus: [{ skuCode: 'I2', price: null, c30dSaleCnt: 5, stock: 0 }] }),
    ],
    siteCoverage: {
      sv1: {
        skc: 'sv1',
        siteCount: 58,
        sites: {
          'shein-de': { siteCode: 'shein-de', shelfStatus: 0, shelfStatusLabel: 'NOT_ON_SALE', sellBanStatus: 1, sellBanStatusLabel: 'BANNED' },
          'shein-sa': { siteCode: 'shein-sa', shelfStatus: 1, shelfStatusLabel: 'ON_SALE', sellBanStatus: 1, sellBanStatusLabel: 'BANNED' },
          'shein-jp': { siteCode: 'shein-jp', shelfStatus: 1, shelfStatusLabel: 'ON_SALE', sellBanStatus: 1, sellBanStatusLabel: 'BANNED' },
        },
        priority: {},
      },
    },
    ...overrides,
  };
}

function q(params) {
  return queryProductIndex(index(), new URLSearchParams(params));
}

test('query parsing rejects unknown enums and clamps paging', () => {
  const parsed = parseProductQuery(new URLSearchParams());
  assert.equal(parsed.shelfStatus, 'ALL');
  assert.equal(parsed.levelGroup, 'ALL');
  assert.equal(parsed.sort, 'SHELF_DAYS_DESC');
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pageSize, PRODUCT_QUERY_DEFAULT_PAGE_SIZE);
  assert.throws(() => parseProductQuery(new URLSearchParams('shelfStatus=NOPE')), ProductIndexQueryError);
  assert.throws(() => parseProductQuery(new URLSearchParams('levelGroup=NOPE')), ProductIndexQueryError);
  assert.throws(() => parseProductQuery(new URLSearchParams('sort=NOPE')), ProductIndexQueryError);
  assert.throws(() => parseProductQuery(new URLSearchParams('page=0')), ProductIndexQueryError);
  assert.throws(() => parseProductQuery(new URLSearchParams('pageSize=999')), ProductIndexQueryError);
  assert.throws(() => parseProductQuery(new URLSearchParams('site=BAD SITE')), ProductIndexQueryError);
  assert.throws(() => parseProductQuery(new URLSearchParams('shelfStatus=ALL&shelfStatus=ON_SHELF')), ProductIndexQueryError);
  assert.throws(() => parseProductQuery(new URLSearchParams('hasPrice=maybe')), ProductIndexQueryError);
  for (const sort of PRODUCT_QUERY_SORTS) {
    assert.equal(parseProductQuery(new URLSearchParams(`sort=${sort}`)).sort, sort);
  }
});

test('level and label filters select the matching SKCs and recount', () => {
  const byLevel = q({ levelGroup: 'STOCK_A' });
  assert.equal(byLevel.total, 1);
  assert.equal(byLevel.rows[0].skc, 'sv1');
  assert.equal(byLevel.levelCounts.STOCK_A, 1);
  assert.equal(byLevel.levelCounts.NEW, 0, 'counters reflect the filtered set');
  const byNew = q({ levelGroup: 'NEW' });
  assert.equal(byNew.rows[0].skc, 'sv2');
  const byLabel = q({ label: '中东高销款' });
  assert.equal(byLabel.total, 1);
  assert.equal(byLabel.rows[0].skc, 'sv1');
  assert.equal(q({ label: '不存在标签' }).total, 0);
});

test('the site filter selects only SKCs on sale on that site', () => {
  assert.equal(q({ site: 'shein-sa' }).total, 1);
  assert.equal(q({ site: 'shein-jp' }).total, 1);
  assert.equal(q({ site: 'shein-de' }).total, 0, 'a not-on-sale site must not match');
  assert.equal(q({ site: 'shein-xx' }).total, 0, 'an uncaptured site must not match');
});

test('hasPrice distinguishes a real price from an unknown one', () => {
  assert.equal(q({ hasPrice: true }).total, 1);
  assert.equal(q({ hasPrice: true }).rows[0].skc, 'sv1');
  assert.equal(q({ hasPrice: false }).total, 1);
  assert.equal(q({ hasPrice: false }).rows[0].skc, 'sv2');
  assert.equal(q({}).total, 2);
});

test('free-text query matches skc, spu, code and category', () => {
  assert.equal(q({ query: 'sv2' }).total, 1);
  assert.equal(q({ query: 'mz-2' }).total, 1);
  assert.equal(q({ query: '厨房' }).total, 2);
  assert.equal(q({ query: 'nothing' }).total, 0);
});

test('sorting puts a missing metric last in both directions', () => {
  const desc = q({ sort: 'SALES_30D_DESC' });
  assert.deepEqual(desc.rows.map((r) => r.skc), ['sv1', 'sv2']);
  assert.equal(desc.rows[0].skus[0].c30dSaleCnt, 240);
  const asc = q({ sort: 'STOCK_ASC' });
  assert.equal(asc.rows[0].skc, 'sv2', 'the zero-stock SKC sorts first ascending');
  assert.equal(asc.rows[1].skc, 'sv1');
  const shelfAsc = q({ sort: 'SHELF_DAYS_ASC' });
  assert.deepEqual(shelfAsc.rows.map((r) => r.skc), ['sv2', 'sv1']);
  const shelfDesc = q({ sort: 'SHELF_DAYS_DESC' });
  assert.deepEqual(shelfDesc.rows.map((r) => r.skc), ['sv1', 'sv2']);
  const unknownSales = queryProductIndex(index({
    skcs: [skc({ skc: 'sv1', skus: [{ skuCode: 'I1', c30dSaleCnt: null }] }), skc({ skc: 'sv2', skus: [{ skuCode: 'I2', c30dSaleCnt: 5 }] })],
  }), new URLSearchParams('sort=SALES_30D_DESC'));
  assert.equal(unknownSales.rows[0].skc, 'sv2', 'a known value outranks an unknown one');
  assert.equal(unknownSales.rows[1].skc, 'sv1');
});

test('paging reports exact totals and never drops rows silently', () => {
  const many = index({
    skcs: Array.from({ length: 7 }, (_, i) => skc({ skc: `sv${i}`, shelfDays: i })),
  });
  const page1 = queryProductIndex(many, new URLSearchParams('pageSize=3&page=1'));
  assert.equal(page1.total, 7);
  assert.equal(page1.rows.length, 3);
  assert.equal(page1.pagination.pageCount, 3);
  assert.equal(page1.pagination.hasPrevious, false);
  assert.equal(page1.pagination.hasNext, true);
  const page3 = queryProductIndex(many, new URLSearchParams('pageSize=3&page=3'));
  assert.equal(page3.rows.length, 1);
  assert.equal(page3.pagination.hasNext, false);
  assert.equal(page3.pagination.hasPrevious, true);
  const empty = queryProductIndex(index({ skcs: [] }), new URLSearchParams());
  assert.equal(empty.total, 0);
  assert.equal(empty.pagination.pageCount, 0);
});

test('priority site coverage travels with the returned page only', () => {
  const result = q({ pageSize: 1 });
  const coverage = result.siteCoverage.sv1;
  assert.equal(coverage.priority['shein-de'].onSale, false);
  assert.equal(coverage.priority['shein-sa'].onSale, true);
  assert.equal(coverage.priority['shein-jp'].onSale, true);
  assert.equal(coverage.siteCount, 58);
  assert.deepEqual([...result.prioritySiteCodes], ['shein-de', 'shein-sa', 'shein-jp']);
  assert.equal(Object.prototype.hasOwnProperty.call(result.siteCoverage, 'sv2'), false);
});

test('the store matrix lists standard codes from the product identities', () => {
  const result = q({});
  assert.deepEqual([...result.storeColumns], ['MZ-1']);
  assert.equal(result.storeCode, 'DL');
  assert.equal(result.shelfStatusCounts.ALL, 253);
  assert.equal(result.shelfStatusCounts.ON_SHELF, 87);
});

test('the loader refuses an unsupported schema and a missing file', async () => {
  assert.throws(() => normalizeProductIndex({}), ProductIndexDataError);
  assert.throws(() => normalizeProductIndex({ schemaVersion: 99 }), ProductIndexDataError);
  const normalized = normalizeProductIndex(index());
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.skcs.length, 2);
  assert.equal(normalized.shelfStatusCounts.ALL, 253);
  const { loadProductIndexData } = await import('../../src/server/product-index-data.mjs');
  await assert.rejects(loadProductIndexData(undefined), /PRODUCT_INDEX_FILE_MISSING/);
  await assert.rejects(loadProductIndexData('/nonexistent/product-index.json'), /PRODUCT_INDEX_FILE_MISSING/);
});

