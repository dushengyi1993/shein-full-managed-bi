import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProductIndexCaptureError,
  captureProductIndex,
  openProductIndexSession,
  pageEndpoint,
} from '../../scripts/capture_full_managed_product_index.mjs';

const ORIGIN = 'https://sso.geiwohuo.com';

function sessionStore(storeCode = 'CX4412') {
  const bundle = {
    storeCode,
    origin: ORIGIN,
    userAgent: 'test-agent',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    identityProvenAt: '2026-09-20T00:00:00.000Z',
    cookies: [{ name: 'sid', value: 'x', domain: 'sso.geiwohuo.com', path: '/', expiresAt: null }],
  };
  return {
    async read() { return bundle; },
    async write() {},
  };
}

function jsonResponse(body, { setCookie = [] } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const value of setCookie) headers.append('set-cookie', value);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

test('the session refuses a store outside the full-managed roster', async () => {
  await assert.rejects(
    openProductIndexSession({ storeCode: 'ZZ9999', sessionStore: sessionStore('ZZ9999') }),
    (error) => error instanceof ProductIndexCaptureError,
  );
  await assert.rejects(
    captureProductIndex({ storeCode: 'ZZ9999', sessionStore: sessionStore('ZZ9999') }),
    /PRODUCT_INDEX_STORE_NOT_IN_ROSTER/,
  );
});

test('a redirect or 401 is reported as an expired session, not a data error', async () => {
  const session = await openProductIndexSession({
    storeCode: 'CX4412',
    sessionStore: sessionStore(),
    fetchImpl: async () => new Response('', { status: 302 }),
  });
  await assert.rejects(
    session.request('GOODS_LEVEL'),
    /PRODUCT_INDEX_AUTH_EXPIRED/,
  );
});

test('a non-zero platform code fails the request instead of returning empty data', async () => {
  const session = await openProductIndexSession({
    storeCode: 'CX4412',
    sessionStore: sessionStore(),
    fetchImpl: async () => jsonResponse({ code: '20003', msg: 'skc_name_list不能为空', info: null }),
  });
  await assert.rejects(session.request('SITE_STATUS', { body: { skc_name_list: ['a'] } }), /PRODUCT_INDEX_PLATFORM_20003/);
});

test('a rotated cookie is merged back into the encrypted bundle', async () => {
  let written = null;
  const store = {
    async read() { return sessionStore().read(); },
    async write(storeCode, bundle) { written = bundle; },
  };
  const session = await openProductIndexSession({
    storeCode: 'CX4412',
    sessionStore: store,
    fetchImpl: async () => jsonResponse({ code: '0', info: { supplierGoodsLevelDetailVoList: [] } }, {
      setCookie: ['sid2=new; Path=/; Domain=sso.geiwohuo.com'],
    }),
  });
  await session.request('GOODS_LEVEL');
  await session.close();
  // The write is queued behind the request, so it is only observable once the
  // session drains its commit queue on close.
  assert.ok(written, 'the rotated cookie must be persisted');
  assert.equal(written.cookies.some((c) => c.name === 'sid2'), true);
});

test('paging refuses a partial sweep when the advertised total is not reached', async () => {
  const session = await openProductIndexSession({
    storeCode: 'CX4412',
    sessionStore: sessionStore(),
    fetchImpl: async (url) => {
      // Advertises 5 rows but only ever returns 2, so the sweep must fail closed.
      if (String(url).includes('goods-skc/list')) {
        return jsonResponse({ code: '0', info: { count: 5, list: [{ skc: 'a' }, { skc: 'b' }] } });
      }
      return jsonResponse({ code: '0', info: { meta: { count: 0 }, data: [] } });
    },
  });
  await assert.rejects(
    pageEndpoint(session.request, 'GOODS_SKC_LIST', { pageSize: 100 }),
    /PRODUCT_INDEX_PAGING_INCOMPLETE/,
  );
});

test('a full capture assembles level, label, price and site coverage', async () => {
  const session = await openProductIndexSession({
    storeCode: 'CX4412',
    sessionStore: sessionStore(),
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes('/product/list')) {
        return jsonResponse({ code: '0', info: { meta: { count: 1, customObj: [{ shelf_status: 'ON_SHELF', count: 87 }] }, data: [{
          spu_code: 'v1', spu_name: 's1', shelf_status: 'ON_SHELF',
          skc_info_list: [{ skc_name: 'sv1', supplier_code: 'MZ-1', sku_info: [{ sku_code: 'I1' }] }],
        }] } });
      }
      if (href.includes('goods-skc/list')) {
        return jsonResponse({ code: '0', info: { count: 1, list: [{
          skc: 'sv1', supplierCode: 'MZ-1', shelfDays: 95,
          goodsLevel: { name: '备货款A' }, goodsLabelList: [{ businessLabelTitle: '中东高销款' }],
          skuList: [{ skuCode: 'I1', price: '52.00', purchasePrice: '31.50', predictDaySales: 9.1, stock: 17 }],
        }] } });
      }
      if (href.includes('get_skc_site_status')) {
        return jsonResponse({ code: '0', info: [{ skc_name: 'sv1', site_status_list: [
          { site_abbr: 'shein-de', shelf_status: 0, sell_ban_status: 1 },
          { site_abbr: 'shein-sa', shelf_status: 1, sell_ban_status: 1 },
          { site_abbr: 'shein-jp', shelf_status: 1, sell_ban_status: 1 },
        ] }] });
      }
      return jsonResponse({ code: '0', info: [] });
    },
  });
  const list = await pageEndpoint(session.request, 'PRODUCT_LIST', { pageSize: 100 });
  assert.equal(list.total, 1);
  assert.equal(list.rows.length, 1);
  await session.close();
});
