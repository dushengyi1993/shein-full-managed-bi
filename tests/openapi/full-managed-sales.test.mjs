import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifySalesProbeError,
  fetchFullManagedSkuInventory,
  fetchFullManagedSkuSales,
  probeFullManagedSalesPermission,
} from '../../src/openapi/full-managed-sales.mjs';
import { SheinOpenApiError } from '../../src/openapi/shein-client.mjs';

function numberItem(index, skc = `SKC-${Math.floor(index / 2)}`) {
  return {
    skc,
    sku_code: `SKU-${String(index).padStart(3, '0')}`,
    supplier_sku: `SUP-${index}`,
    design_code: '',
    attribute: `Size ${index}`,
  };
}

test('paginates type=1 by advertised SKC count while retaining every expanded SKU row', async () => {
  const pageRows = new Map([
    [1, [numberItem(1, 'SKC-A'), numberItem(2, 'SKC-A'), numberItem(3, 'SKC-A')]],
    [2, [numberItem(4, 'SKC-B'), numberItem(5, 'SKC-B')]],
    [3, []],
  ]);
  const calls = [];
  const client = {
    async request(path, options) {
      calls.push({ path, options });
      const page = options.query.page;
      return {
        data: {
          code: 0,
          info: { page, per_page: 1, count: 2, list: pageRows.get(page) ?? [] },
          traceId: `trace-${page}`,
        },
      };
    },
  };
  const result = await fetchFullManagedSkuInventory(client, { pageSize: 1 });
  assert.equal(result.items.length, 5);
  assert.equal(result.pages.length, 4);
  assert.equal(result.advertisedCount, 2);
  assert.equal(result.sweepCount, 2);
  assert.deepEqual(calls.map(({ options }) => options.query.page), [1, 2, 3, 4, 1, 2, 3, 4]);
  assert.ok(calls.every(({ options }) => options.method === 'GET' && options.query.per_page === 1));
});

test('rejects an empty sentinel before every advertised SKC was observed', async () => {
  const client = {
    async request(_path, { query }) {
      return {
        data: {
          code: 0,
          info: {
            page: query.page,
            per_page: 1,
            count: 2,
            list: query.page === 1 ? [numberItem(1, 'SKC-A')] : [],
          },
        },
      };
    },
  };
  await assert.rejects(
    () => fetchFullManagedSkuInventory(client, { pageSize: 1 }),
    (error) => error.code === 'PAGINATION_COUNT_MISMATCH',
  );
});

test('rejects one SKC repeated across number-list pages', async () => {
  const client = {
    async request(_path, { query }) {
      const rows = query.page === 1
        ? [numberItem(1, 'SKC-A')]
        : query.page === 2
          ? [numberItem(2, 'SKC-A')]
          : [];
      return {
        data: {
          code: 0,
          info: { page: query.page, per_page: 1, count: 1, list: rows },
        },
      };
    },
  };
  await assert.rejects(
    () => fetchFullManagedSkuInventory(client, { pageSize: 1 }),
    (error) => error.code === 'PAGINATION_SKC_OVERLAP',
  );
});

test('rejects data that resumes after an empty number-list page', async () => {
  const client = {
    async request(_path, { query }) {
      const rows = query.page === 1
        ? [numberItem(1, 'SKC-A')]
        : query.page === 3
          ? [numberItem(2, 'SKC-B')]
          : [];
      return {
        data: {
          code: 0,
          info: { page: query.page, per_page: 1, count: 2, list: rows },
        },
      };
    },
  };
  await assert.rejects(
    () => fetchFullManagedSkuInventory(client, { pageSize: 1 }),
    (error) => error.code === 'PAGINATION_EMPTY_GAP',
  );
});

test('requires two consecutive stable complete inventory sweeps', async () => {
  let sweep = 0;
  const client = {
    async request(_path, { query }) {
      if (query.page === 1) sweep += 1;
      const skuIndex = sweep === 1 ? 1 : 2;
      return {
        data: {
          code: 0,
          info: {
            page: query.page,
            per_page: 1,
            count: 1,
            list: query.page === 1 ? [numberItem(skuIndex, 'SKC-A')] : [],
          },
        },
      };
    },
  };
  const result = await fetchFullManagedSkuInventory(client, {
    pageSize: 1,
    maxSweeps: 3,
  });
  assert.equal(result.sweepCount, 3);
  assert.deepEqual(result.items.map(({ skuCode }) => skuCode), ['SKU-002']);
});

test('query-sku-sales never sends more than 100 SKUs and maps complete results', async () => {
  const skuCodes = Array.from({ length: 201 }, (_, index) => `SKU-${index + 1}`);
  const sizes = [];
  const client = {
    async request(_path, { body }) {
      sizes.push(body.skuCodeList.length);
      return {
        data: {
          code: '0', msg: 'OK', traceId: 'trace',
          info: {
            dataList: body.skuCodeList.map((skuCode) => ({
              skuCode, realTimeSaleCnt: 0, cydSaleCnt: 1, c7dSaleCnt: 7, c30dSaleCnt: 30, dt: '20260720',
            })),
          },
        },
      };
    },
  };
  const result = await fetchFullManagedSkuSales(client, {
    storeCode: 'DL', skuCodes, fetchedAt: '2026-07-20T04:00:00Z',
  });
  assert.deepEqual(sizes, [100, 100, 1]);
  assert.equal(result.snapshots.length, 201);
  assert.equal(result.snapshots[0].salesToday, 0);
});

test('probe treats successful zero sales as granted and no inventory as pending', async () => {
  const zeroSalesClient = {
    async request(path) {
      if (path.endsWith('number-list')) {
        return { data: { code: 0, info: { page: 1, per_page: 1, count: 1, list: [numberItem(1)] } } };
      }
      return { data: { code: '0', info: { dataList: [{
        skuCode: 'SKU-001', realTimeSaleCnt: 0, cydSaleCnt: 0, c7dSaleCnt: 0, c30dSaleCnt: 0, dt: '20260720',
      }] } } };
    },
  };
  assert.equal((await probeFullManagedSalesPermission(zeroSalesClient, { storeCode: 'DL' })).outcome, 'GRANTED');

  const emptyClient = {
    async request() {
      return { data: { code: 0, info: { page: 1, per_page: 1, count: 0, list: [] } } };
    },
  };
  assert.equal((await probeFullManagedSalesPermission(emptyClient, { storeCode: 'DL' })).outcome, 'PENDING');
});

test('probe treats a complete zero response with empty dt as a loadable legal zero', async () => {
  const client = {
    async request(path) {
      if (path.endsWith('number-list')) {
        return { data: { code: 0, info: { page: 1, per_page: 1, count: 1, list: [numberItem(1)] } } };
      }
      return { data: { code: '0', info: { dataList: [{
        skuCode: 'SKU-001',
        realTimeSaleCnt: 0,
        cydSaleCnt: 0,
        c7dSaleCnt: 0,
        c30dSaleCnt: 0,
        dt: '',
      }] } } };
    },
  };

  const probe = await probeFullManagedSalesPermission(client, { storeCode: 'DL' });
  assert.equal(probe.outcome, 'GRANTED');
  assert.match(probe.platformMessage, /legal zero/);
  assert.deepEqual(probe.evidence, {
    storeCode: 'DL',
    endpointReached: '/open-api/goods/query-sku-sales',
    salesEndpointExercised: true,
    statisticsDateAvailable: false,
    dataLoadable: true,
    dataQualityStatus: 'DEGRADED',
    dataQualityReason: 'LEGAL_ZERO_UNANCHORED',
  });
});

test('probe grants permission but blocks a non-zero row without dt', async () => {
  const client = {
    async request(path) {
      if (path.endsWith('number-list')) {
        return { data: { code: 0, info: { page: 1, per_page: 1, count: 1, list: [numberItem(1)] } } };
      }
      return { data: { code: '0', info: { dataList: [{
        skuCode: 'SKU-001',
        realTimeSaleCnt: 1,
        cydSaleCnt: 0,
        c7dSaleCnt: 1,
        c30dSaleCnt: 1,
        dt: '',
      }] } } };
    },
  };

  const probe = await probeFullManagedSalesPermission(client, { storeCode: 'DL' });
  assert.equal(probe.outcome, 'GRANTED');
  assert.equal(probe.evidence.dataLoadable, false);
  assert.equal(probe.evidence.dataQualityStatus, 'BLOCKED');
  assert.equal(probe.evidence.dataQualityReason, 'UNANCHORED_NONZERO');
});

test('permission review failures map to pending rather than a zero dataset', () => {
  const pending = new SheinOpenApiError('PLATFORM_ERROR', 'platform error', {
    platformCode: '4001', platformMessage: 'permission package is pending',
  });
  assert.equal(classifySalesProbeError(pending), 'PENDING');
  assert.equal(classifySalesProbeError(new Error('connection reset')), 'ERROR');
  const databasePermissionError = Object.assign(
    new Error('permission denied for table sales_quality_event'),
    { code: '42501' },
  );
  assert.equal(classifySalesProbeError(databasePermissionError), 'ERROR');
});
