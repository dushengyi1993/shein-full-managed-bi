import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MAX_SKUS_PER_SALES_QUERY,
  SkuSalesDomainError,
  createSkuSalesQueryBatches,
  deduplicateSkuCodes,
  mapSkuSalesResponseToSnapshots,
} from '../../src/domain/sku-sales-snapshot.mjs';

const successFixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/openapi/query-sku-sales.success.json', import.meta.url),
    'utf8',
  ),
);

function clone(value) {
  return structuredClone(value);
}

function assertDomainError(fn, expectedCode) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof SkuSalesDomainError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

function mapFixture(overrides = {}) {
  return mapSkuSalesResponseToSnapshots({
    storeCode: 'DL',
    requestedSkuCodes: ['SKU-001', 'SKU-002'],
    fetchedAt: '2026-07-20T03:04:05.000Z',
    response: clone(successFixture),
    ...overrides,
  });
}

test('deduplicateSkuCodes trims codes, preserves first-seen order and leaves input untouched', () => {
  const input = [' SKU-002 ', 'SKU-001', 'SKU-002', 'SKU-003', 'SKU-001'];
  const original = [...input];

  assert.deepEqual(deduplicateSkuCodes(input), ['SKU-002', 'SKU-001', 'SKU-003']);
  assert.deepEqual(input, original);
});

test('createSkuSalesQueryBatches deduplicates and never puts more than 100 SKUs in a request', () => {
  const uniqueCodes = Array.from({ length: 205 }, (_, index) => `SKU-${String(index + 1).padStart(3, '0')}`);
  const input = [...uniqueCodes.slice(0, 100), ...uniqueCodes, 'SKU-205'];

  const batches = createSkuSalesQueryBatches(input);

  assert.equal(MAX_SKUS_PER_SALES_QUERY, 100);
  assert.deepEqual(batches.map(({ skuCodeList }) => skuCodeList.length), [100, 100, 5]);
  assert.deepEqual(batches.flatMap(({ skuCodeList }) => skuCodeList), uniqueCodes);
});

test('createSkuSalesQueryBatches returns no requests for an empty inventory', () => {
  assert.deepEqual(createSkuSalesQueryBatches([]), []);
});

test('SKU inputs reject blank or non-string values instead of silently dropping them', () => {
  assertDomainError(() => deduplicateSkuCodes(['SKU-001', '  ']), 'INVALID_SKU_CODE');
  assertDomainError(() => deduplicateSkuCodes(['SKU-001', 2]), 'INVALID_SKU_CODE');
  assertDomainError(() => deduplicateSkuCodes('SKU-001'), 'INVALID_SKU_LIST');
});

test('maps the official response to complete quantity-only snapshots in requested order', () => {
  assert.deepEqual(mapFixture(), [
    {
      storeCode: 'DL',
      skuCode: 'SKU-001',
      salesToday: 3,
      salesYesterday: 2,
      sales7Days: 14,
      sales30Days: 55,
      statisticsDate: '2026-07-20',
      fetchedAt: '2026-07-20T03:04:05.000Z',
    },
    {
      storeCode: 'DL',
      skuCode: 'SKU-002',
      salesToday: 0,
      salesYesterday: 1,
      sales7Days: 7,
      sales30Days: 28,
      statisticsDate: '2026-07-20',
      fetchedAt: '2026-07-20T03:04:05.000Z',
    },
  ]);
});

test('accepts a Date fetchedAt and normalizes it to an ISO instant', () => {
  const [snapshot] = mapSkuSalesResponseToSnapshots({
    storeCode: 'DL',
    requestedSkuCodes: ['SKU-001'],
    fetchedAt: new Date('2026-07-20T11:04:05+08:00'),
    response: {
      ...clone(successFixture),
      info: { dataList: [clone(successFixture.info.dataList[1])] },
    },
  });

  assert.equal(snapshot.fetchedAt, '2026-07-20T03:04:05.000Z');
});

test('throws when a requested SKU is absent and never invents a zero-sales snapshot', () => {
  const response = clone(successFixture);
  response.info.dataList = response.info.dataList.filter(({ skuCode }) => skuCode !== 'SKU-002');

  assert.throws(
    () => mapFixture({ response }),
    (error) => {
      assert.ok(error instanceof SkuSalesDomainError);
      assert.equal(error.code, 'MISSING_REQUESTED_SKU');
      assert.deepEqual(error.details.missingSkuCodes, ['SKU-002']);
      return true;
    },
  );
});

for (const field of [
  'skuCode',
  'realTimeSaleCnt',
  'cydSaleCnt',
  'c7dSaleCnt',
  'c30dSaleCnt',
  'dt',
]) {
  test(`throws an explicit MISSING_FIELD error when response item omits ${field}`, () => {
    const response = clone(successFixture);
    delete response.info.dataList[0][field];

    assertDomainError(() => mapFixture({ response }), 'MISSING_FIELD');
  });
}

for (const field of ['realTimeSaleCnt', 'cydSaleCnt', 'c7dSaleCnt', 'c30dSaleCnt']) {
  test(`rejects a negative ${field}`, () => {
    const response = clone(successFixture);
    response.info.dataList[0][field] = -1;

    assertDomainError(() => mapFixture({ response }), 'NEGATIVE_SALES_COUNT');
  });
}

test('rejects non-integer sales counts', () => {
  const response = clone(successFixture);
  response.info.dataList[0].c7dSaleCnt = '7';

  assertDomainError(() => mapFixture({ response }), 'INVALID_SALES_COUNT');
});

test('rejects an invalid statistics date', () => {
  const response = clone(successFixture);
  response.info.dataList[0].dt = '20260230';

  assertDomainError(() => mapFixture({ response }), 'INVALID_STATISTICS_DATE');
});

test('rejects unsuccessful OpenAPI responses before reading data', () => {
  assertDomainError(
    () => mapFixture({ response: { code: '400100', msg: 'no permission', traceId: 'trace-x' } }),
    'OPENAPI_RESPONSE_ERROR',
  );
});

for (const mutate of [
  {
    name: 'top-level code',
    apply(response) {
      delete response.code;
    },
  },
  {
    name: 'info',
    apply(response) {
      delete response.info;
    },
  },
  {
    name: 'dataList',
    apply(response) {
      delete response.info.dataList;
    },
  },
]) {
  test(`throws an explicit MISSING_FIELD error when response omits ${mutate.name}`, () => {
    const response = clone(successFixture);
    mutate.apply(response);
    assertDomainError(() => mapFixture({ response }), 'MISSING_FIELD');
  });
}

test('rejects duplicate and unexpected response SKUs', () => {
  const duplicateResponse = clone(successFixture);
  duplicateResponse.info.dataList[1].skuCode = 'SKU-002';
  assertDomainError(() => mapFixture({ response: duplicateResponse }), 'DUPLICATE_RESPONSE_SKU');

  const unexpectedResponse = clone(successFixture);
  unexpectedResponse.info.dataList[1].skuCode = 'SKU-999';
  assertDomainError(() => mapFixture({ response: unexpectedResponse }), 'UNEXPECTED_RESPONSE_SKU');
});

test('requires store, fetch time and requested SKU context', () => {
  assertDomainError(() => mapFixture({ storeCode: '' }), 'INVALID_FIELD');
  assertDomainError(() => mapFixture({ fetchedAt: 'not-a-date' }), 'INVALID_FETCHED_AT');
  assertDomainError(() => mapFixture({ requestedSkuCodes: [] }), 'EMPTY_REQUESTED_SKU_LIST');
});

test('a single response cannot be mapped against more than the official 100-SKU limit', () => {
  const requestedSkuCodes = Array.from({ length: 101 }, (_, index) => `SKU-${index + 1}`);
  assertDomainError(
    () => mapFixture({ requestedSkuCodes }),
    'TOO_MANY_REQUESTED_SKUS',
  );
});
