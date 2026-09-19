import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRequestHandler } from '../../src/server/app.mjs';

function productIndexPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    storeCode: 'DL',
    capturedAt: '2026-09-20T00:00:00.000Z',
    shelfStatusCounts: { ALL: 253, ON_SHELF: 87, WAIT_SHELF: 85, OUT_SHELF: 66, SOLD_OUT: 15 },
    levelGroupCounts: { NEW: 1, STOCK_A: 1, total: 2 },
    productCount: 1,
    skcCount: 2,
    siteCoverageCount: 1,
    products: [],
    skcs: [
      { skc: 'sv1', supplierCode: 'MZ-1', shelfDays: 10, goodsLevelGroup: 'STOCK_A', goodsLevelName: '备货款A', labels: ['中东高销款'], skus: [{ skuCode: 'I1', price: 52 }] },
      { skc: 'sv2', supplierCode: 'MZ-2', shelfDays: 3, goodsLevelGroup: 'NEW', goodsLevelName: '新款', labels: [], skus: [{ skuCode: 'I2', price: null }] },
    ],
    siteCoverage: {
      sv1: {
        skc: 'sv1',
        siteCount: 58,
        sites: {
          'shein-de': { siteCode: 'shein-de', shelfStatus: 0, shelfStatusLabel: 'NOT_ON_SALE', sellBanStatus: 1, sellBanStatusLabel: 'BANNED' },
          'shein-sa': { siteCode: 'shein-sa', shelfStatus: 1, shelfStatusLabel: 'ON_SALE', sellBanStatus: 1, sellBanStatusLabel: 'BANNED' },
        },
        priority: {},
      },
    },
    ...overrides,
  };
}

async function withServer(payload, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fm-product-index-'));
  const file = path.join(dir, 'product-index.json');
  if (payload !== null) await writeFile(file, JSON.stringify(payload), 'utf8');
  const handler = createRequestHandler({
    runtimeEnvironment: 'development',
    dataFile: path.join(dir, 'dashboard.json'),
    productIndexFile: payload === null ? path.join(dir, 'missing.json') : file,
    // A stub auth service keeps this test on route behaviour; the real auth
    // contract is covered by tests/server/auth.test.mjs.
    authService: {
      enabled: true,
      authenticateRequest: () => ({ username: 'operator', role: 'admin' }),
      refreshCookieForRequest: () => null,
      maxBodyBytes: 4096,
    },
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function getJson(base, pathname) {
  const response = await fetch(base + pathname);
  return { status: response.status, json: await response.json() };
}

test('the product index endpoint serves the filtered page', async () => {
  await withServer(productIndexPayload(), async (base) => {
    const all = await getJson(base, '/api/product-index');
    assert.equal(all.status, 200);
    assert.equal(all.json.total, 2);
    assert.equal(all.json.shelfStatusCounts.ALL, 253);
    assert.equal(all.json.levelCounts.STOCK_A, 1);
    assert.deepEqual([...all.json.prioritySiteCodes], ['shein-de', 'shein-sa', 'shein-jp']);
    const filtered = await getJson(base, '/api/product-index?levelGroup=NEW');
    assert.equal(filtered.json.total, 1);
    assert.equal(filtered.json.rows[0].skc, 'sv2');
    const bySite = await getJson(base, '/api/product-index?site=shein-sa');
    assert.equal(bySite.json.total, 1);
    assert.equal(bySite.json.rows[0].skc, 'sv1');
    assert.equal(bySite.json.siteCoverage.sv1.priority['shein-sa'].onSale, true);
    const byDe = await getJson(base, '/api/product-index?site=shein-de');
    assert.equal(byDe.json.total, 0, 'a not-on-sale site filters everything out');
  });
});

test('an invalid selector is a 400, a missing capture is a 503', async () => {
  await withServer(productIndexPayload(), async (base) => {
    const bad = await getJson(base, '/api/product-index?shelfStatus=NOPE');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'QUERY_PARAMETER_INVALID');
    const dup = await getJson(base, '/api/product-index?shelfStatus=ALL&shelfStatus=ON_SHELF');
    assert.equal(dup.status, 400);
    assert.equal(dup.json.error.code, 'QUERY_PARAMETER_DUPLICATED');
  });
  await withServer(null, async (base) => {
    const gone = await getJson(base, '/api/product-index');
    assert.equal(gone.status, 503);
    assert.equal(gone.json.error.code, 'PRODUCT_INDEX_FILE_MISSING');
  });
});

test('a non-GET method is rejected without touching the index', async () => {
  await withServer(productIndexPayload(), async (base) => {
    // The same-origin guard runs before the method check, so a write has to
    // present a trusted Origin to reach the read-only rejection.
    const crossOrigin = await fetch(base + '/api/product-index', { method: 'POST' });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).error.code, 'CROSS_ORIGIN_REJECTED');
    const response = await fetch(base + '/api/product-index', {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  });
});

test('the order-management route is untouched by the product route', async () => {
  await withServer(productIndexPayload(), async (base) => {
    const orders = await getJson(base, '/api/orders?page=stock-records');
    assert.equal(orders.status, 503, 'orders reports its own data error, not the product one');
    assert.equal(orders.json.error.code, 'ORDER_MANAGEMENT_PAGE_UNAVAILABLE');
    assert.equal(JSON.stringify(orders.json).includes('PRODUCT_INDEX'), false);
  });
});
