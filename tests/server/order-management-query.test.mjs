import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OrderManagementQueryError,
  queryOrderManagement,
} from '../../src/server/order-management-query.mjs';

function row(id, storeCode, statusCode, statusName, createdAt, updatedAt, primary, secondary, tags, metrics, facts, details) {
  return Object.freeze({
    id,
    storeCode,
    statusCode,
    statusName,
    createdAt,
    updatedAt,
    primary,
    secondary,
    tags,
    metrics,
    facts,
    details,
  });
}

const INDEX = Object.freeze({
  schemaVersion: 1,
  updatedAt: '2026-08-08T08:00:00.000Z',
  coverage: Object.freeze({
    status: 'COMPLETE',
    expectedStoreCount: 2,
    completedStoreCount: 2,
    storeCodes: Object.freeze(['DL5477', 'MZ2406']),
    reason: null,
  }),
  pages: Object.freeze({
    'delivery-notes': Object.freeze({
      status: 'AVAILABLE',
      source: 'OPENAPI_DELIVERY_NOTES',
      latestSourceFetchedAt: '2026-08-08T07:59:00.000Z',
      reason: null,
      rows: Object.freeze([
        row(
          'DN-1001', 'DL5477', 'SHIPPED', '已发货',
          '2026-08-08T01:00:00.000Z', '2026-08-08T07:00:00.000Z',
          '送货单 1001', '顺丰', ['华南仓'],
          [{ name: 'packageCount', value: 2 }, { name: 'packageWeight', value: 12.5 }],
          [{ name: 'warehouseName', value: '华南仓' }],
          [{ name: 'expressCompanyName', value: '顺丰' }],
        ),
        row(
          'DN-1002', 'DL5477', 'PENDING', '待发货',
          '2026-08-07T02:00:00.000Z', '2026-08-08T06:00:00.000Z',
          '送货单 1002', '', [], [1], [{ name: 'warehouseName', value: '华南仓' }], [],
        ),
        row(
          'DN-1003', 'MZ2406', 'SHIPPED', '已发货',
          '2026-08-06T03:00:00.000Z', '2026-08-07T05:00:00.000Z',
          '送货单 1003', '中通', ['华东仓'],
          [{ name: 'packageCount', value: 3 }],
          [{ name: 'warehouseName', value: '华东仓' }], [],
        ),
      ]),
    }),
    exceptions: Object.freeze({
      status: 'PARTIAL',
      source: 'OPENAPI_EXCEPTIONS',
      latestSourceFetchedAt: '2026-08-08T07:50:00.000Z',
      reason: 'ROWS_REJECTED_SCHEMA:1',
      rows: Object.freeze([
        row(
          'EX-1001', 'DL5477', 'OPEN', '待处理',
          '2026-08-08T01:00:00.000Z', '2026-08-08T07:00:00.000Z',
          '异常单 1001', '', [], [], [], ['缺货'],
        ),
      ]),
    }),
    'stock-records': Object.freeze({
      status: 'UNAVAILABLE',
      source: 'OPENAPI_STOCK_RECORDS',
      latestSourceFetchedAt: null,
      reason: 'STOCK_RECORDS_FETCH_FAILED',
      rows: Object.freeze([]),
    }),
  }),
});

const PARTIAL_COVERAGE = Object.freeze({
  ...INDEX,
  coverage: Object.freeze({
    status: 'PARTIAL',
    expectedStoreCount: 2,
    completedStoreCount: 1,
    storeCodes: Object.freeze(['DL5477']),
    reason: 'MZ2406 未完成采集',
  }),
});

test('serves one fixed page with coverage, facets, pagination and validated rows', () => {
  const result = queryOrderManagement(INDEX, new URLSearchParams('page=delivery-notes'));
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.readOnly, true);
  assert.equal(result.pageId, 'delivery-notes');
  assert.equal(result.page.pageId, 'delivery-notes');
  assert.equal(result.page.status, 'AVAILABLE');
  assert.equal(result.updatedAt, '2026-08-08T08:00:00.000Z');
  assert.equal(result.complete, true);
  assert.equal(result.coverage.status, 'COMPLETE');
  assert.deepEqual(result.coverage.storeCodes, ['DL5477', 'MZ2406']);
  assert.equal(result.source.updatedAt, '2026-08-08T08:00:00.000Z');
  assert.equal(result.source.latestSourceFetchedAt, '2026-08-08T07:59:00.000Z');
  assert.deepEqual(result.facets.stores, [
    { code: 'DL5477', count: 2 },
    { code: 'MZ2406', count: 1 },
  ]);
  assert.deepEqual(result.facets.statuses, [
    { code: 'PENDING', count: 1 },
    { code: 'SHIPPED', count: 2 },
  ]);
  assert.deepEqual(result.facets.sorts, ['LATEST', 'UPDATED_DESC', 'STATUS', 'STORE']);
  assert.deepEqual(result.facets.pageSizes, [25, 50, 100]);
  assert.equal(result.pagination.page, 1);
  assert.equal(result.pagination.pageSize, 50);
  assert.equal(result.pagination.pageCount, 1);
  assert.equal(result.pagination.matchedRows, 3);
  assert.equal(result.pagination.hasNext, false);
  assert.equal(result.rows.length, 3);
});

test('filters by store, status and text, sorts and paginates server-side', () => {
  const storeResult = queryOrderManagement(
    INDEX,
    new URLSearchParams('page=delivery-notes&store=DL5477&status=SHIPPED&sort=STATUS&pageSize=25'),
  );
  assert.deepEqual(storeResult.rows.map((entry) => entry.id), ['DN-1001']);
  assert.equal(storeResult.pagination.matchedRows, 1);
  assert.deepEqual(storeResult.facets.stores, [
    { code: 'DL5477', count: 1 },
    { code: 'MZ2406', count: 1 },
  ]);

  const searchResult = queryOrderManagement(
    INDEX,
    new URLSearchParams('page=delivery-notes&q=华南'),
  );
  assert.deepEqual(searchResult.rows.map((entry) => entry.id), ['DN-1001', 'DN-1002']);

  const manyRows = Array.from({ length: 30 }, (_, index) => row(
    `DN-${String(2000 + index)}`, index % 2 === 0 ? 'DL5477' : 'MZ2406', 'PENDING', '待发货',
    `2026-08-0${1 + Math.floor(index / 10)}T00:00:00.000Z`,
    `2026-08-0${1 + Math.floor(index / 10)}T00:00:00.000Z`,
    `送货单 ${2000 + index}`, '', [], [index], [], [],
  ));
  const manyPagesIndex = {
    ...INDEX,
    pages: { ...INDEX.pages, 'delivery-notes': { ...INDEX.pages['delivery-notes'], rows: manyRows } },
  };
  const paginated = queryOrderManagement(
    manyPagesIndex,
    new URLSearchParams('page=delivery-notes&sort=UPDATED_DESC&pageNumber=2&pageSize=25'),
  );
  assert.equal(paginated.pagination.matchedRows, 30);
  assert.equal(paginated.pagination.pageCount, 2);
  assert.equal(paginated.rows.length, 5);
  assert.deepEqual(paginated.rows.map((entry) => entry.id), [
    'DN-2005', 'DN-2006', 'DN-2007', 'DN-2008', 'DN-2009',
  ]);
  assert.equal(paginated.pagination.hasPrevious, true);
  assert.equal(paginated.pagination.hasNext, false);

  const storeSorted = queryOrderManagement(
    INDEX,
    new URLSearchParams('page=delivery-notes&sort=STORE'),
  );
  assert.deepEqual(storeSorted.rows.map((entry) => entry.id), ['DN-1001', 'DN-1002', 'DN-1003']);
});

test('treats null status fields as filterable but never invents facet labels', () => {
  const nullableIndex = {
    ...INDEX,
    pages: {
      ...INDEX.pages,
      'delivery-notes': {
        ...INDEX.pages['delivery-notes'],
        rows: [
          ...INDEX.pages['delivery-notes'].rows,
          row(
            'DN-1004', 'MZ2406', null, null,
            null, null,
            '送货单 1004', '', [], [], [], [],
          ),
        ],
      },
    },
  };
  const result = queryOrderManagement(nullableIndex, new URLSearchParams('page=delivery-notes'));
  assert.deepEqual(result.facets.statuses, [
    { code: 'PENDING', count: 1 },
    { code: 'SHIPPED', count: 2 },
  ]);
  assert.equal(result.pagination.matchedRows, 4);
  assert.doesNotMatch(JSON.stringify(result.facets), /null/);

  const filtered = queryOrderManagement(
    nullableIndex,
    new URLSearchParams('page=delivery-notes&status=SHIPPED'),
  );
  assert.deepEqual(filtered.rows.map((entry) => entry.id), ['DN-1001', 'DN-1003']);
});

test('discloses PARTIAL page and coverage states without claiming COMPLETE', () => {
  const partialPage = queryOrderManagement(INDEX, new URLSearchParams('page=exceptions'));
  assert.equal(partialPage.page.status, 'PARTIAL');
  assert.equal(partialPage.page.reason, 'ROWS_REJECTED_SCHEMA:1');
  assert.equal(partialPage.complete, false);
  assert.equal(partialPage.coverage.status, 'COMPLETE');
  assert.equal(partialPage.rows.length, 1);

  const partialCoverage = queryOrderManagement(
    PARTIAL_COVERAGE,
    new URLSearchParams('page=delivery-notes'),
  );
  assert.equal(partialCoverage.page.status, 'AVAILABLE');
  assert.equal(partialCoverage.coverage.status, 'PARTIAL');
  assert.equal(partialCoverage.complete, false);
});

test('fails closed for missing or UNAVAILABLE pages', () => {
  for (const pageId of ['waybills', 'delivery-desk', 'return-applications', 'return-orders', 'value-added-services', 'quality-reports']) {
    assert.throws(
      () => queryOrderManagement(INDEX, new URLSearchParams(`page=${pageId}`)),
      (error) => error instanceof OrderManagementQueryError
        && error.code === 'ORDER_MANAGEMENT_PAGE_UNAVAILABLE'
        && error.statusCode === 503,
    );
  }
  assert.throws(
    () => queryOrderManagement(INDEX, new URLSearchParams('page=stock-records')),
    (error) => error instanceof OrderManagementQueryError
      && error.code === 'ORDER_MANAGEMENT_PAGE_UNAVAILABLE'
      && error.statusCode === 503,
  );
});

test('rejects unknown, duplicated, missing and out-of-range parameters', () => {
  assert.throws(
    () => queryOrderManagement(INDEX, new URLSearchParams('page=delivery-notes&raw=1')),
    (error) => error instanceof OrderManagementQueryError && error.code === 'QUERY_PARAMETER_UNKNOWN',
  );
  assert.throws(
    () => queryOrderManagement(INDEX, new URLSearchParams('page=delivery-notes&page=delivery-notes')),
    (error) => error instanceof OrderManagementQueryError && error.code === 'QUERY_PARAMETER_DUPLICATED',
  );
  assert.throws(
    () => queryOrderManagement(INDEX, new URLSearchParams('')),
    (error) => error instanceof OrderManagementQueryError && error.code === 'QUERY_PARAMETER_MISSING',
  );
  assert.throws(
    () => queryOrderManagement(INDEX, new URLSearchParams('page=not-a-page')),
    (error) => error instanceof OrderManagementQueryError && error.code === 'QUERY_PARAMETER_INVALID',
  );
  assert.throws(
    () => queryOrderManagement(INDEX, new URLSearchParams('page=delivery-notes&pageSize=30')),
    (error) => error instanceof OrderManagementQueryError && error.code === 'QUERY_PARAMETER_OUT_OF_RANGE',
  );
  assert.throws(
    () => queryOrderManagement(INDEX, new URLSearchParams('page=delivery-notes&pageNumber=0')),
    (error) => error instanceof OrderManagementQueryError && error.code === 'QUERY_PARAMETER_INVALID',
  );
  assert.throws(
    () => queryOrderManagement(INDEX, new URLSearchParams('page=delivery-notes&pageNumber=10001')),
    (error) => error instanceof OrderManagementQueryError && error.code === 'QUERY_PARAMETER_OUT_OF_RANGE',
  );
  assert.throws(
    () => queryOrderManagement(INDEX, new URLSearchParams('page=delivery-notes&store=ZZ9999')),
    (error) => error instanceof OrderManagementQueryError && error.code === 'QUERY_STORE_UNKNOWN',
  );
  assert.throws(
    () => queryOrderManagement(INDEX, new URLSearchParams('page=delivery-notes&status=DROP')),
    (error) => error instanceof OrderManagementQueryError && error.code === 'QUERY_PARAMETER_INVALID',
  );
});
