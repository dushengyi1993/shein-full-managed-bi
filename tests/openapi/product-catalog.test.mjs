import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchFullManagedProductCatalog,
  fetchFullManagedProductDetails,
  PRODUCT_FULL_DETAIL_PATH,
  PRODUCT_QUERY_PATH,
} from '../../src/openapi/product-catalog.mjs';

test('product catalog uses POST pages and closes exact multiples with an empty page', async () => {
  const calls = [];
  const client = {
    async request(path, options) {
      calls.push({ path, options });
      const page = options.body.pageNum;
      return {
        data: {
          code: '0',
          info: {
            data: page <= 2
              ? [{
                  spuName: `SPU-${page}`,
                  skcName: `SKC-${page}`,
                  skuCodeList: [`SKU-${page}`],
                }]
              : [],
          },
        },
      };
    },
  };

  const result = await fetchFullManagedProductCatalog(client, { pageSize: 1 });
  assert.deepEqual(
    calls.map(({ options }) => options.body.pageNum),
    [1, 2, 3, 1, 2, 3],
  );
  assert.ok(calls.every(({ path, options }) => (
    path === PRODUCT_QUERY_PATH && options.method === 'POST'
  )));
  assert.equal(result.stable, true);
  assert.equal(result.sweepCount, 2);
  assert.equal(result.sweeps.length, 2);
  assert.equal(result.sweeps[0].catalogFingerprint, result.sweeps[1].catalogFingerprint);
  assert.equal(result.products.length, 2);
  assert.equal(result.terminalReason, 'EMPTY_PAGE');
});

test('product full-detail splits requests into batches of at most 100', async () => {
  const calls = [];
  const client = {
    async request(path, { body }) {
      calls.push({ path, body });
      return {
        data: {
          code: '0',
          info: body.skuCodes.map((skuCode) => ({
            skuCode,
            spuName: 'SPU',
            skcName: 'SKC',
            productName: { productName: 'Product' },
            productNumber: 'MODEL',
            sellerSku: '',
            imageList: [],
            skuDimensionsInfo: {},
          })),
        },
      };
    },
  };
  const skuCodes = Array.from({ length: 201 }, (_, index) => `SKU-${index + 1}`);
  const result = await fetchFullManagedProductDetails(client, { skuCodes });

  assert.deepEqual(calls.map(({ body }) => body.skuCodes.length), [100, 100, 1]);
  assert.ok(calls.every(({ path }) => path === PRODUCT_FULL_DETAIL_PATH));
  assert.equal(result.details.length, 201);
  assert.equal(result.batches.length, 3);
});

test('product catalog rejects a repeated page payload', async () => {
  const client = {
    async request() {
      return {
        data: {
          code: '0',
          info: {
            data: [{ spuName: 'SPU', skcName: 'SKC', skuCodeList: ['SKU'] }],
          },
        },
      };
    },
  };
  await assert.rejects(
    () => fetchFullManagedProductCatalog(client, { pageSize: 1 }),
    (error) => error.code === 'PAGINATION_REPEATED_PAGE',
  );
});

test('product catalog fails closed when complete sweeps never stabilize', async () => {
  let sweep = 0;
  const client = {
    async request(_path, { body }) {
      if (body.pageNum === 1) sweep += 1;
      return {
        data: {
          code: '0',
          info: {
            data: body.pageNum === 1
              ? [{
                  spuName: `SPU-${sweep}`,
                  skcName: `SKC-${sweep}`,
                  skuCodeList: [`SKU-${sweep}`],
                }]
              : [],
          },
        },
      };
    },
  };
  await assert.rejects(
    () => fetchFullManagedProductCatalog(client, { pageSize: 1, maxSweeps: 3 }),
    (error) => error.code === 'CATALOG_SWEEP_UNSTABLE',
  );
});

test('product catalog rejects duplicate SKU membership within one sweep', async () => {
  const client = {
    async request(_path, { body }) {
      return {
        data: {
          code: '0',
          info: {
            data: body.pageNum === 1
              ? [
                  { spuName: 'SPU-1', skcName: 'SKC-1', skuCodeList: ['SKU-X'] },
                  { spuName: 'SPU-2', skcName: 'SKC-2', skuCodeList: ['SKU-X'] },
                ]
              : [],
          },
        },
      };
    },
  };
  await assert.rejects(
    () => fetchFullManagedProductCatalog(client, { pageSize: 2 }),
    (error) => error.code === 'CATALOG_PAGE_DRIFT',
  );
});

test('product catalog rejects impossible Asia/Shanghai filter dates before network', async () => {
  const client = { async request() { throw new Error('should not call'); } };
  await assert.rejects(
    () => fetchFullManagedProductCatalog(client, {
      pageSize: 1,
      updateTimeStart: '2026-02-30 00:00:00',
    }),
    /not a valid Asia\/Shanghai calendar date-time/,
  );
});
