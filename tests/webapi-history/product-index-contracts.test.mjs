import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRODUCT_INDEX_ENDPOINTS,
  PRODUCT_INDEX_FIELD_ALLOWLISTS,
  PRODUCT_INDEX_WEBAPI_ORIGIN,
  PRODUCT_LEVEL_GROUPS,
  PRODUCT_SHELF_STATUSES,
  pickProductFields,
  productIndexEndpointUrl,
  productIndexRequestBody,
  productIndexRequestQuery,
  productIndexRows,
  productIndexSiteStatusBody,
  productIndexTotal,
  readPath,
} from '../../src/webapi-history/product-index-contracts.mjs';
import { isDeniedKeyName } from '../../src/order-management/order-management-contract.mjs';

test('every product endpoint is a fixed sso.geiwohuo.com path', () => {
  for (const [code, endpoint] of Object.entries(PRODUCT_INDEX_ENDPOINTS)) {
    assert.ok(endpoint.path.startsWith('/'), `${code} path must be absolute`);
    const url = productIndexEndpointUrl(code);
    assert.ok(url.startsWith(PRODUCT_INDEX_WEBAPI_ORIGIN + '/'), `${code} url must stay on the supplier origin`);
    assert.equal(url.includes('..'), false, `${code} url must not traverse`);
  }
  assert.throws(() => productIndexEndpointUrl('NOT_A_REAL_ENDPOINT'), /PRODUCT_INDEX_ENDPOINT_NOT_ALLOWED/);
  assert.throws(() => productIndexEndpointUrl(''), /PRODUCT_INDEX_ENDPOINT_NOT_ALLOWED/);
});

test('no allowlisted field can be a denied PII key', () => {
  for (const [endpointCode, names] of Object.entries(PRODUCT_INDEX_FIELD_ALLOWLISTS)) {
    for (const name of names) {
      assert.equal(isDeniedKeyName(name), false, `${endpointCode}.${name} must not be denied`);
    }
  }
});

test('paged requests clamp to the captured page size and never widen it', () => {
  const body = productIndexRequestBody('PRODUCT_LIST', { page: 2, pageSize: 100 });
  assert.deepEqual(body, { pageNum: 2, pageSize: 100 });
  const query = productIndexRequestQuery('PRODUCT_LIST', { page: 2, pageSize: 100 });
  assert.equal(query, 'page_num=2&page_size=100');
  for (const bad of [0, -1, 201, 10_000, Number.NaN, 'x', null]) {
    const clamped = productIndexRequestBody('PRODUCT_LIST', { page: 1, pageSize: bad });
    assert.equal(clamped.pageSize, 100, `pageSize ${String(bad)} must fall back`);
  }
  const pageFloor = productIndexRequestBody('PRODUCT_LIST', { page: 0, pageSize: 50 });
  assert.equal(pageFloor.pageNum, 1);
  assert.equal(productIndexRequestQuery('SITE_STATUS', { page: 1 }), '');
});

test('the goods-skc endpoint pages through body keys, not a query string', () => {
  assert.equal(PRODUCT_INDEX_ENDPOINTS.GOODS_SKC_LIST.query, undefined);
  assert.equal(productIndexRequestQuery('GOODS_SKC_LIST', { page: 3, pageSize: 50 }), '');
  assert.deepEqual(
    productIndexRequestBody('GOODS_SKC_LIST', { page: 3, pageSize: 50 }),
    { pageNum: 3, pageSize: 50 },
  );
});

test('site status accepts a bounded unique id list and rejects empty input', () => {
  const body = productIndexSiteStatusBody(['a', 'b', 'a', '  ']);
  assert.deepEqual(body, { skc_name_list: ['a', 'b'] });
  assert.throws(() => productIndexSiteStatusBody([]), /PRODUCT_INDEX_ID_LIST_EMPTY/);
  assert.throws(() => productIndexSiteStatusBody(['', ' ']), /PRODUCT_INDEX_ID_LIST_EMPTY/);
  assert.throws(() => productIndexSiteStatusBody(['x'.repeat(129)]), /PRODUCT_INDEX_ID_TOO_LONG/);
  assert.throws(() => productIndexSiteStatusBody(null), /PRODUCT_INDEX_ID_LIST_INVALID/);
  assert.throws(
    () => productIndexSiteStatusBody(Array.from({ length: 201 }, (_, i) => `skc-${i}`)),
    /PRODUCT_INDEX_ID_LIST_TOO_LARGE/,
  );
});

test('totals and rows read the verified paths and fail soft to null/empty', () => {
  const listPayload = { info: { meta: { count: 253, customObj: [{ shelf_status: 'ON_SHELF', count: 87 }] }, data: [{ spu_name: 'x' }] } };
  assert.equal(productIndexTotal('PRODUCT_LIST', listPayload), 253);
  assert.equal(productIndexRows('PRODUCT_LIST', listPayload).length, 1);
  assert.equal(productIndexTotal('PRODUCT_LIST', {}), null);
  assert.deepEqual(productIndexRows('PRODUCT_LIST', {}), []);
  assert.deepEqual(productIndexRows('PRODUCT_LIST', { info: { data: 'nope' } }), []);
  assert.equal(productIndexTotal('SITE_STATUS', {}), null);
  assert.equal(productIndexTotal('GOODS_LEVEL', {}), null);
  assert.deepEqual(productIndexRows('GOODS_SKC_LIST', { info: { list: [{ skc: 'a' }] } }), [{ skc: 'a' }]);
  assert.deepEqual(productIndexRows('GOODS_LABEL', { info: [{ id: 1 }] }), [{ id: 1 }]);
  assert.equal(readPath({ a: { b: { c: 7 } } }, ['a', 'b', 'c']), 7);
  assert.equal(readPath({ a: null }, ['a', 'b']), undefined);
});

test('field projection copies only allowlisted keys and keeps absence distinguishable', () => {
  const row = { skc: 'sv1', supplierCode: 'MZ-1', price: '52.00', secretToken: 'x', contactPhone: '123' };
  const picked = pickProductFields(row, PRODUCT_INDEX_FIELD_ALLOWLISTS.GOODS_SKC_LIST);
  assert.deepEqual(Object.keys(picked).sort(), ['skc', 'supplierCode']);
  const zero = pickProductFields({ c7dSaleCnt: 0 }, PRODUCT_INDEX_FIELD_ALLOWLISTS.GOODS_SKC_LIST_SKU);
  assert.equal(Object.prototype.hasOwnProperty.call(zero, 'c7dSaleCnt'), true);
  assert.equal(zero.c7dSaleCnt, 0);
  const missing = pickProductFields({}, PRODUCT_INDEX_FIELD_ALLOWLISTS.GOODS_SKC_LIST_SKU);
  assert.equal(Object.prototype.hasOwnProperty.call(missing, 'c7dSaleCnt'), false);
  assert.deepEqual(pickProductFields(null, ['a']), {});
  assert.deepEqual(pickProductFields([1, 2], ['a']), {});
});

test('shelf statuses and level groups are the captured platform taxonomy', () => {
  assert.deepEqual([...PRODUCT_SHELF_STATUSES], ['ALL', 'ON_SHELF', 'WAIT_SHELF', 'OUT_SHELF', 'SOLD_OUT']);
  const grouped = new Set(Object.values(PRODUCT_LEVEL_GROUPS).flat());
  for (const named of ['新款', '新款A', '备货款A', '保证在售款', '备货款B']) {
    assert.equal(grouped.has(named), true, `${named} must be reachable through a group`);
  }
  const all = Object.values(PRODUCT_LEVEL_GROUPS).flat();
  assert.equal(new Set(all).size, all.length, 'level groups must not overlap');
});

