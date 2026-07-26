import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifySalesProbeError,
  fetchFullManagedSkuInventory,
  fetchFullManagedSkuSales,
  probeFullManagedSalesPermission,
} from '../../src/openapi/full-managed-sales.mjs';
import { SheinOpenApiError } from '../../src/openapi/shein-client.mjs';

function numberItem(index) {
  return {
    skc: `SKC-${Math.floor(index / 2)}`,
    sku_code: `SKU-${String(index).padStart(3, '0')}`,
    supplier_sku: `SUP-${index}`,
    design_code: '',
    attribute: `Size ${index}`,
  };
}

test('paginates number-list GET up to 100 per page and validates advertised count', async () => {
  const rows = Array.from({ length: 205 }, (_, index) => numberItem(index + 1));
  const calls = [];
  const client = {
    async request(path, options) {
      calls.push({ path, options });
      const page = options.query.page;
      const pageRows = rows.slice((page - 1) * 100, page * 100);
      return {
        data: {
          code: 0,
          info: { page, per_page: 100, count: rows.length, list: pageRows },
          traceId: `trace-${page}`,
        },
      };
    },
  };
  const result = await fetchFullManagedSkuInventory(client);
  assert.equal(result.items.length, 205);
  assert.equal(result.pages.length, 3);
  assert.deepEqual(calls.map(({ options }) => options.query.page), [1, 2, 3]);
  assert.ok(calls.every(({ options }) => options.method === 'GET' && options.query.per_page === 100));
});

test('detects truncated or drifting pagination instead of accepting a partial inventory', async () => {
  const client = {
    async request() {
      return { data: { code: 0, info: { page: 1, per_page: 100, count: 200, list: [numberItem(1)] } } };
    },
  };
  await assert.rejects(
    () => fetchFullManagedSkuInventory(client),
    (error) => error.code === 'PAGINATION_TRUNCATED',
  );
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

test('probe grants permission but blocks fact loading when SHEIN returns an explicit empty dt', async () => {
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
  assert.match(probe.platformMessage, /dt was empty/);
  assert.deepEqual(probe.evidence, {
    storeCode: 'DL',
    endpointReached: '/open-api/goods/query-sku-sales',
    salesEndpointExercised: true,
    statisticsDateAvailable: false,
    dataLoadable: false,
    dataQualityStatus: 'DEGRADED',
    dataQualityReason: 'MISSING_STATISTICS_DATE',
  });
});

test('permission review failures map to pending rather than a zero dataset', () => {
  const pending = new SheinOpenApiError('PLATFORM_ERROR', 'platform error', {
    platformCode: '4001', platformMessage: 'permission package is pending',
  });
  assert.equal(classifySalesProbeError(pending), 'PENDING');
  assert.equal(classifySalesProbeError(new Error('connection reset')), 'ERROR');
});
