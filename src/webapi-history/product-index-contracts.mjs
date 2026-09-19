/**
 * Verified read-only Session HTTP contracts for the full-managed product index.
 *
 * Every endpoint below was captured on 2026-09-20 from the logged-in supplier
 * backoffice (sso.geiwohuo.com) with a frozen request body and an observed
 * response shape. Only fields named here may enter the product index; the
 * allowlists are asserted against the shared PII deny-list at module load, so a
 * denied key can never be read even if a capture later adds it.
 *
 * The product index answers questions the OpenAPI surface cannot: goods level,
 * platform labels, price/supply price, shelf status and time, and per-site
 * shelf coverage. Identity, inventory and sales stay on OpenAPI (see the
 * hybrid boundary documented in docs/product-management-redesign-20260920.md).
 */

import { isDeniedKeyName } from '../order-management/order-management-contract.mjs';

export const PRODUCT_INDEX_WEBAPI_ORIGIN = 'https://sso.geiwohuo.com';
export const PRODUCT_INDEX_API_PREFIX = '/spmp-api-prefix/spmp';
export const PRODUCT_INDEX_MAX_PAGES = 200;
export const PRODUCT_INDEX_MAX_SITE_CODES = 200;
export const PRODUCT_INDEX_TRANSPORT_LIMITS = Object.freeze({
  requestTimeoutMs: 60_000,
  maxResponseBytes: 16 * 1024 * 1024,
});

export class ProductIndexContractError extends Error {
  constructor(code) {
    super(`product-index contract refused: ${code}`);
    this.name = 'ProductIndexContractError';
    this.code = code;
  }
}

function fail(code) {
  throw new ProductIndexContractError(code);
}

function assertNoDeniedKeys(names, endpointCode) {
  for (const name of names) {
    if (isDeniedKeyName(name)) fail(`PRODUCT_INDEX_FIELD_DENIED:${endpointCode}:${name}`);
  }
}

/** Shelf status values returned by product/list meta.customObj. */
export const PRODUCT_SHELF_STATUSES = Object.freeze([
  'ALL',
  'ON_SHELF',
  'WAIT_SHELF',
  'OUT_SHELF',
  'SOLD_OUT',
]);

/**
 * Product levels are a fixed platform taxonomy.  The 20 platform entries are
 * folded into five stocking groups so the page can count the levels the
 * operator named; every platform value stays visible through `assigned`.
 */
export const PRODUCT_LEVEL_GROUPS = Object.freeze({
  NEW: Object.freeze(['新款', '新款A', '新款未上架', '加码']),
  STOCK_A: Object.freeze(['备货款A', '转款完成']),
  STOCK_B: Object.freeze(['备货款B', '备货款C', '备货款C1', '秋冬款', '转款中']),
  GUARANTEED: Object.freeze(['保证在售款', '回流款', '回流待上架', '过渡款']),
  CLEARANCE: Object.freeze([
    '售完下架', '清仓款', '退供款', '重复款', '自主下架', '自主停产',
    '淘汰过渡款', '物料下架', '淘汰款', '供应商淘汰', '回收站款', '废弃款', 'Flat款', '特价处理款',
  ]),
  BLOCKED: Object.freeze([
    '问题款', '暂不下架', '待处理议价', '议价失败款', 'QQK', 'QQQCK', 'QQSSK', 'QQXHK', 'DTQQK',
    '授权过期', '热销断码款', '春夏款', '停产停供', '无货下架', '全站下架款',
  ]),
});

/**
 * Field allowlists.  Each name is read by exact key from the platform row and
 * copied verbatim; nothing outside this list is ever projected.
 */
export const PRODUCT_INDEX_FIELD_ALLOWLISTS = Object.freeze({
  PRODUCT_LIST: Object.freeze([
    'spu_name', 'spu_code', 'product_name_ch', 'product_name_en',
    'category_id', 'brand_code', 'brand_name',
    'shelf_status', 'create_time', 'publish_time', 'first_shelf_time', 'expect_shelf_time',
    'commodity_type', 'source_system', 'scroll_id',
  ]),
  PRODUCT_LIST_SKC: Object.freeze([
    'skc_name', 'skc_code', 'sale_name', 'supplier_code',
    'main_image_thumbnail_url', 'business_model', 'supplier_id',
    'mall_sell_status', 'abandoned', 'category_misplace', 'has_activity',
    'bundle_product', 'has_original_image', 'shelf_fail_reason',
  ]),
  PRODUCT_LIST_SKU: Object.freeze(['sku_code']),
  GOODS_SKC_LIST: Object.freeze([
    'id', 'picUrl', 'supplierCode', 'skc', 'spu', 'categoryName',
    'shelfDays', 'shelfDate', 'groupFlag', 'productTag', 'multicolored',
    'goodsLevelCanOrderFlag', 'isDirectedAppeal', 'purchaseOrderCntNeed',
    'appealOrderCnt', 'currencySymbol', 'c7dSaleCntSum', 'sheinSaleByInventory',
    'showStopSale',
  ]),
  GOODS_SKC_LIST_SKU: Object.freeze([
    'skuCode', 'attr', 'supplierSku', 'purchaseStatus',
    'predictDaySales', 'totalSaleVolume', 'c7dSaleCnt', 'c30dSaleCnt',
    'stayDeliver', 'stayShelf', 'transit', 'stock', 'transitSale',
    'preemptionNum', 'waitWarehousingNum', 'supplierStock', 'saleableStock',
    'stockSaleDays', 'saleDays', 'stockDays', 'jitSaleDays',
    'orderCount', 'systemOrderCount', 'userOrderCount', 'availableOrderCount',
    'planUrgentCount', 'price', 'finalPrice', 'purchasePrice',
    'virtualSign', 'skuReturnsMark',
  ]),
  GOODS_SKC_LIST_LEVEL: Object.freeze([
    'type', 'name', 'value', 'goodsLevelName', 'goodsLevel', 'note',
  ]),
  SITE_STATUS: Object.freeze([
    'skc_name', 'site_abbr', 'shelf_status', 'sell_ban_status',
  ]),
});

for (const [endpointCode, names] of Object.entries(PRODUCT_INDEX_FIELD_ALLOWLISTS)) {
  assertNoDeniedKeys(names, endpointCode);
}

export const PRODUCT_INDEX_ENDPOINTS = Object.freeze({
  PRODUCT_LIST: Object.freeze({
    method: 'POST',
    path: `${PRODUCT_INDEX_API_PREFIX}/product/list`,
    query: Object.freeze({ pageKey: 'page_num', pageSizeKey: 'page_size' }),
    pageKey: 'pageNum',
    pageSizeKey: 'pageSize',
    defaultPageSize: 100,
    totalPath: Object.freeze(['info', 'meta', 'count']),
    rowsPath: Object.freeze(['info', 'data']),
    statusCountsPath: Object.freeze(['info', 'meta', 'customObj']),
    bodyTemplate: Object.freeze({}),
    evidence: '2026-09-20 capture: POST /spmp-api-prefix/spmp/product/list?page_num=1&page_size=N {} -> info.meta.count=253, info.meta.customObj carries ON_SHELF/WAIT_SHELF/OUT_SHELF/SOLD_OUT/ALL counts.',
  }),
  GOODS_SKC_LIST: Object.freeze({
    method: 'POST',
    path: '/idms/goods-skc/list',
    // Verified 2026-09-20: this endpoint silently ignores pageNum/page/offset
    // and returns page 1 every time; only pageNumber advances the page.
    pageKey: 'pageNumber',
    pageSizeKey: 'pageSize',
    defaultPageSize: 100,
    totalPath: Object.freeze(['info', 'count']),
    rowsPath: Object.freeze(['info', 'list']),
    bodyTemplate: Object.freeze({}),
    evidence: '2026-09-20 capture: POST /idms/goods-skc/list {} -> info.count=400, info.list[].skuList[] carries price/purchasePrice/predictDaySales/c7dSaleCnt/c30dSaleCnt/stock and the SKC carries shelfDays/shelfDate/goodsLevel/goodsLabelList.',
  }),
  SITE_STATUS: Object.freeze({
    method: 'POST',
    path: `${PRODUCT_INDEX_API_PREFIX}/shelf/get_skc_site_status`,
    idListKey: 'skc_name_list',
    rowsPath: Object.freeze(['info']),
    evidence: '2026-09-20 capture: POST /spmp-api-prefix/spmp/shelf/get_skc_site_status {skc_name_list:[...]} -> info[].site_status_list[] with 58 site_abbr entries including shein-de/shein-sa/shein-jp, each {site_abbr,shelf_status,sell_ban_status}.',
  }),
  SITE_LIST: Object.freeze({
    method: 'POST',
    path: `${PRODUCT_INDEX_API_PREFIX}/supplier/query_site_list`,
    bodyTemplate: Object.freeze({}),
    rowsPath: Object.freeze(['info', 'data']),
    evidence: '2026-09-20 capture: POST /spmp-api-prefix/spmp/supplier/query_site_list {} -> info.data[].sub_site_list[] with {site_name,site_abbr,site_status,store_type,currency}.',
  }),
  GOODS_LEVEL: Object.freeze({
    method: 'GET',
    path: '/idms/common/goodsLevel',
    rowsPath: Object.freeze(['info', 'supplierGoodsLevelDetailVoList']),
    evidence: '2026-09-20 capture: GET /idms/common/goodsLevel -> info.supplierGoodsLevelDetailVoList[] with {id,name,note,sort,assignedGoodsLevelList}.',
  }),
  GOODS_LABEL: Object.freeze({
    method: 'GET',
    path: '/idms/goods-skc/get-goods-label-list',
    rowsPath: Object.freeze(['info']),
    evidence: '2026-09-20 capture: GET /idms/goods-skc/get-goods-label-list -> info[] with {id,tspIdList,businessLabelTitle} (14 labels).',
  }),
});

export function productIndexEndpointUrl(endpointCode) {
  const endpoint = PRODUCT_INDEX_ENDPOINTS[String(endpointCode ?? '')];
  if (!endpoint) fail('PRODUCT_INDEX_ENDPOINT_NOT_ALLOWED');
  if (!endpoint.path || !endpoint.path.startsWith('/')) fail('PRODUCT_INDEX_ENDPOINT_NOT_ALLOWED');
  return `${PRODUCT_INDEX_WEBAPI_ORIGIN}${endpoint.path}`;
}

export function readPath(value, pathSegments) {
  let current = value;
  for (const segment of pathSegments) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

function boundedPageSize(value, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) return fallback;
  return parsed;
}

/** Frozen request body for a paged POST endpoint. */
export function productIndexRequestBody(endpointCode, { page, pageSize } = {}) {
  const endpoint = PRODUCT_INDEX_ENDPOINTS[String(endpointCode ?? '')];
  if (!endpoint) fail('PRODUCT_INDEX_ENDPOINT_NOT_ALLOWED');
  if (endpoint.method !== 'POST') fail('PRODUCT_INDEX_METHOD_NOT_ALLOWED');
  if (!endpoint.pageKey) fail('PRODUCT_INDEX_ENDPOINT_NOT_PAGED');
  const resolvedPage = Number.isSafeInteger(Number(page)) && Number(page) >= 1 ? Number(page) : 1;
  const resolvedSize = boundedPageSize(pageSize, endpoint.defaultPageSize);
  const body = { ...(endpoint.bodyTemplate ?? {}) };
  body[endpoint.pageKey] = resolvedPage;
  body[endpoint.pageSizeKey] = resolvedSize;
  return Object.freeze(body);
}

/** Query string for a paged POST endpoint whose page keys travel in the URL. */
export function productIndexRequestQuery(endpointCode, { page, pageSize } = {}) {
  const endpoint = PRODUCT_INDEX_ENDPOINTS[String(endpointCode ?? '')];
  if (!endpoint) fail('PRODUCT_INDEX_ENDPOINT_NOT_ALLOWED');
  if (!endpoint.query) return '';
  const resolvedPage = Number.isSafeInteger(Number(page)) && Number(page) >= 1 ? Number(page) : 1;
  const resolvedSize = boundedPageSize(pageSize, endpoint.defaultPageSize);
  const params = new URLSearchParams();
  params.set(endpoint.query.pageKey, String(resolvedPage));
  params.set(endpoint.query.pageSizeKey, String(resolvedSize));
  return params.toString();
}

/** Frozen request body for the SKC-id list endpoint. */
export function productIndexSiteStatusBody(skcNames) {
  const endpoint = PRODUCT_INDEX_ENDPOINTS.SITE_STATUS;
  if (!Array.isArray(skcNames)) fail('PRODUCT_INDEX_ID_LIST_INVALID');
  const unique = [];
  const seen = new Set();
  for (const raw of skcNames) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    if (name.length > 128) fail('PRODUCT_INDEX_ID_TOO_LONG');
    if (seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }
  if (unique.length === 0) fail('PRODUCT_INDEX_ID_LIST_EMPTY');
  if (unique.length > PRODUCT_INDEX_MAX_SITE_CODES) fail('PRODUCT_INDEX_ID_LIST_TOO_LARGE');
  return Object.freeze({ [endpoint.idListKey]: unique });
}

export function productIndexTotal(endpointCode, payload) {
  const endpoint = PRODUCT_INDEX_ENDPOINTS[String(endpointCode ?? '')];
  if (!endpoint) fail('PRODUCT_INDEX_ENDPOINT_NOT_ALLOWED');
  if (!endpoint.totalPath) return null;
  const total = Number(readPath(payload, endpoint.totalPath));
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

export function productIndexRows(endpointCode, payload) {
  const endpoint = PRODUCT_INDEX_ENDPOINTS[String(endpointCode ?? '')];
  if (!endpoint) fail('PRODUCT_INDEX_ENDPOINT_NOT_ALLOWED');
  const rows = readPath(payload, endpoint.rowsPath);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Copies only allowlisted keys from a platform row.  A key that is absent stays
 * absent so the caller can distinguish 'platform did not send it' from 'zero'.
 */
export function pickProductFields(row, allowlist) {
  const source = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
  const result = {};
  for (const name of allowlist) {
    if (!Object.prototype.hasOwnProperty.call(source, name)) continue;
    const value = source[name];
    if (value === undefined) continue;
    result[name] = value;
  }
  return result;
}
