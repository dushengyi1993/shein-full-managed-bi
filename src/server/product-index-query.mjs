/**
 * Query layer for the read-only product-management page.
 *
 * The page asks four questions: which products match my filters, how are the
 * stocking levels distributed, how does one standard product cover the stores,
 * and which sites is it listed on.  Every selector is an allowlisted enum, and
 * a missing value stays null through filtering and sorting so an unknown price
 * or an uncaptured site is never ranked as if it were zero.
 */

import {
  PRODUCT_PRIORITY_SITE_CODES,
} from '../webapi-history/product-index.mjs';
import { PRODUCT_LEVEL_GROUPS } from '../webapi-history/product-index-contracts.mjs';

export const PRODUCT_QUERY_SORTS = Object.freeze([
  'SHELF_DAYS_DESC',
  'SHELF_DAYS_ASC',
  'SALES_30D_DESC',
  'SALES_7D_DESC',
  'PREDICT_DAILY_DESC',
  'STOCK_ASC',
  'SKC_ASC',
  'SUPPLIER_CODE_ASC',
]);

export const PRODUCT_QUERY_PAGE_SIZES = Object.freeze([25, 50, 100]);
export const PRODUCT_QUERY_DEFAULT_PAGE_SIZE = 50;
export const PRODUCT_QUERY_MAX_PAGE = 10_000;

/** Filter keys accepted by the page. */
export const PRODUCT_FILTER_KEYS = Object.freeze([
  'shelfStatus',
  'levelGroup',
  'label',
  'site',
  'storeCode',
  'query',
  'hasPrice',
]);

const SHELF_STATUS_PATTERN = /^[A-Z_]{2,24}$/;
const LABEL_MAX = 40;
const QUERY_MAX = 80;
const SITE_PATTERN = /^[a-z0-9-]{2,32}$/;

export class ProductIndexQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductIndexQueryError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new ProductIndexQueryError(code, message);
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function singleParam(params, name, { maximum, pattern, fallback = '' } = {}) {
  const values = params.getAll(name);
  if (values.length > 1) fail('QUERY_PARAMETER_DUPLICATED', `参数 ${name} 不能重复`);
  if (values.length === 0) return fallback;
  const value = String(values[0]).trim();
  if (value === '') return fallback;
  if (maximum && value.length > maximum) fail('QUERY_PARAMETER_TOO_LONG', `参数 ${name} 过长`);
  if (pattern && !pattern.test(value)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  return value;
}

function enumParam(params, name, allowed, fallback) {
  const value = singleParam(params, name, { maximum: 40, fallback });
  if (value === fallback) return fallback;
  const normalized = value.toUpperCase();
  if (!allowed.includes(normalized)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  return normalized;
}

function integerParam(params, name, { fallback, minimum, maximum }) {
  const value = singleParam(params, name, { maximum: 12, fallback: '' });
  if (value === '') return fallback;
  if (!/^[0-9]+$/.test(value)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('QUERY_PARAMETER_INVALID', `参数 ${name} 超出范围`);
  }
  return parsed;
}

function booleanParam(params, name) {
  const value = singleParam(params, name, { maximum: 8, fallback: '' });
  if (value === '') return null;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
}

export function parseProductQuery(paramsValue = new URLSearchParams()) {
  const params = paramsValue instanceof URLSearchParams ? paramsValue : new URLSearchParams();
  return Object.freeze({
    shelfStatus: enumParam(params, 'shelfStatus', ['ALL', 'ON_SHELF', 'WAIT_SHELF', 'OUT_SHELF', 'SOLD_OUT'], 'ALL'),
    levelGroup: enumParam(params, 'levelGroup', ['ALL', ...Object.keys(PRODUCT_LEVEL_GROUPS), 'UNCLASSIFIED'], 'ALL'),
    label: singleParam(params, 'label', { maximum: LABEL_MAX }),
    site: singleParam(params, 'site', { maximum: 32, pattern: SITE_PATTERN }),
    storeCode: singleParam(params, 'storeCode', { maximum: 12, pattern: /^[A-Za-z0-9]{2,12}$/ }).toUpperCase(),
    query: singleParam(params, 'query', { maximum: QUERY_MAX }),
    hasPrice: booleanParam(params, 'hasPrice'),
    sort: enumParam(params, 'sort', PRODUCT_QUERY_SORTS, 'SHELF_DAYS_DESC'),
    page: integerParam(params, 'page', { fallback: 1, minimum: 1, maximum: PRODUCT_QUERY_MAX_PAGE }),
    pageSize: integerParam(params, 'pageSize', {
      fallback: PRODUCT_QUERY_DEFAULT_PAGE_SIZE,
      minimum: 1,
      maximum: 200,
    }),
  });
}

function skuAggregate(skc) {
  const skus = rows(skc.skus);
  let c7d = null;
  let c30d = null;
  let predictDaily = null;
  let stock = null;
  let price = null;
  for (const sku of skus) {
    if (Number.isFinite(sku.c7dSaleCnt)) c7d = (c7d ?? 0) + sku.c7dSaleCnt;
    if (Number.isFinite(sku.c30dSaleCnt)) c30d = (c30d ?? 0) + sku.c30dSaleCnt;
    if (Number.isFinite(sku.predictDaySales)) predictDaily = (predictDaily ?? 0) + sku.predictDaySales;
    if (Number.isFinite(sku.stock)) stock = (stock ?? 0) + sku.stock;
    if (price === null && Number.isFinite(sku.price)) price = sku.price;
  }
  return Object.freeze({ c7d, c30d, predictDaily, stock, price });
}

function skcMatches(skc, query, siteCoverage, filters) {
  if (filters.levelGroup !== 'ALL' && skc.goodsLevelGroup !== filters.levelGroup) return false;
  if (filters.label && !rows(skc.labels).includes(filters.label)) return false;
  if (filters.hasPrice !== null) {
    const hasPrice = Number.isFinite(skuAggregate(skc).price);
    if (hasPrice !== filters.hasPrice) return false;
  }
  if (filters.site) {
    const coverage = siteCoverage[skc.skc];
    const entry = coverage ? coverage.sites[filters.site] : null;
    if (!entry || entry.shelfStatus !== 1) return false;
  }
  if (query) {
    const needle = query.toLowerCase();
    const haystack = [skc.skc, skc.spu, skc.supplierCode, skc.categoryName]
      .map((value) => String(value ?? '').toLowerCase());
    if (!haystack.some((value) => value.includes(needle))) return false;
  }
  return true;
}

function sortValue(skc, sort) {
  const aggregate = skuAggregate(skc);
  switch (sort) {
    case 'SHELF_DAYS_DESC': return skc.shelfDays;
    case 'SHELF_DAYS_ASC': return skc.shelfDays;
    case 'SALES_30D_DESC': return aggregate.c30d;
    case 'SALES_7D_DESC': return aggregate.c7d;
    case 'PREDICT_DAILY_DESC': return aggregate.predictDaily;
    case 'STOCK_ASC': return aggregate.stock;
    case 'SKC_ASC': return skc.skc;
    case 'SUPPLIER_CODE_ASC': return skc.supplierCode;
    default: return skc.shelfDays;
  }
}

const ASC_SORTS = new Set(['SHELF_DAYS_ASC', 'STOCK_ASC', 'SKC_ASC', 'SUPPLIER_CODE_ASC']);

function compareSkcs(left, right, sort) {
  const a = sortValue(left, sort);
  const b = sortValue(right, sort);
  const ascending = ASC_SORTS.has(sort);
  // A missing metric always sorts last, in both directions, so an unknown price
  // or an uncaptured shelf age can never occupy the top of the list.
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';
  if (aMissing && bMissing) return String(left.skc ?? '').localeCompare(String(right.skc ?? ''));
  if (aMissing) return 1;
  if (bMissing) return -1;
  let result;
  if (typeof a === 'string' || typeof b === 'string') {
    result = String(a).localeCompare(String(b));
  } else {
    result = a - b;
  }
  if (result === 0) return String(left.skc ?? '').localeCompare(String(right.skc ?? ''));
  return ascending ? result : -result;
}

function buildStoreMatrix(products) {
  const storeSet = new Set();
  for (const product of products) {
    for (const skc of rows(product.skcs)) {
      const code = String(skc.supplierCode ?? '').trim();
      if (code) storeSet.add(code);
    }
  }
  return Object.freeze([...storeSet].sort());
}

function siteCoverageForSkc(skcName, siteCoverage) {
  const coverage = siteCoverage[skcName];
  if (!coverage) return null;
  const priority = {};
  for (const code of PRODUCT_PRIORITY_SITE_CODES) {
    const entry = coverage.sites[code];
    priority[code] = entry
      ? { siteCode: code, onSale: entry.shelfStatus === 1, shelfStatus: entry.shelfStatus }
      : { siteCode: code, onSale: null, shelfStatus: null };
  }
  return Object.freeze({
    skc: skcName,
    siteCount: coverage.siteCount,
    priority: Object.freeze(priority),
    sites: coverage.sites,
  });
}

/**
 * Runs the page query.  Returns the filtered SKC rows, the level/status counters
 * computed over the filtered set, the store x standard-code matrix columns and
 * the priority site coverage for the returned page.
 */
export function queryProductIndex(indexValue, paramsValue = new URLSearchParams()) {
  const index = record(indexValue);
  const filters = parseProductQuery(paramsValue);
  const allSkcs = rows(index.skcs);
  const products = rows(index.products);
  const siteCoverage = record(index.siteCoverage);

  const filtered = allSkcs.filter((skc) => skcMatches(skc, filters.query, siteCoverage, filters));

  const levelCounts = {};
  for (const group of Object.keys(PRODUCT_LEVEL_GROUPS)) levelCounts[group] = 0;
  levelCounts.UNCLASSIFIED = 0;
  for (const skc of filtered) {
    const group = skc.goodsLevelGroup;
    if (group && Object.prototype.hasOwnProperty.call(levelCounts, group)) levelCounts[group] += 1;
  }

  const sorted = [...filtered].sort((left, right) => compareSkcs(left, right, filters.sort));
  const count = sorted.length;
  const pageCount = count === 0 ? 0 : Math.ceil(count / filters.pageSize);
  const offset = (filters.page - 1) * filters.pageSize;
  const pageRows = sorted.slice(offset, offset + filters.pageSize);

  const pageSites = {};
  for (const skc of pageRows) {
    const coverage = siteCoverageForSkc(skc.skc, siteCoverage);
    if (coverage) pageSites[skc.skc] = coverage;
  }

  const shelfStatus = record(index.shelfStatusCounts);
  return Object.freeze({
    filters,
    total: count,
    pagination: Object.freeze({
      page: filters.page,
      pageSize: filters.pageSize,
      pageCount,
      hasPrevious: filters.page > 1,
      hasNext: filters.page < pageCount,
    }),
    shelfStatusCounts: Object.freeze({
      ALL: Number.isSafeInteger(shelfStatus.ALL) ? shelfStatus.ALL : null,
      ON_SHELF: Number.isSafeInteger(shelfStatus.ON_SHELF) ? shelfStatus.ON_SHELF : null,
      WAIT_SHELF: Number.isSafeInteger(shelfStatus.WAIT_SHELF) ? shelfStatus.WAIT_SHELF : null,
      OUT_SHELF: Number.isSafeInteger(shelfStatus.OUT_SHELF) ? shelfStatus.OUT_SHELF : null,
      SOLD_OUT: Number.isSafeInteger(shelfStatus.SOLD_OUT) ? shelfStatus.SOLD_OUT : null,
    }),
    levelCounts: Object.freeze(levelCounts),
    prioritySiteCodes: PRODUCT_PRIORITY_SITE_CODES,
    storeColumns: buildStoreMatrix(products),
    capturedAt: index.capturedAt ?? null,
    storeCode: index.storeCode ?? null,
    rows: Object.freeze(pageRows),
    siteCoverage: Object.freeze(pageSites),
  });
}
