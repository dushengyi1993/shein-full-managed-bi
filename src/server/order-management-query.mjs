import { ORDER_MANAGEMENT_PAGE_IDS } from './order-management-data.mjs';

const STORE_PATTERN = /^[A-Z0-9]{2,12}$/;
const CODE_PATTERN = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>"'`\\]{1,120}$/u;
const INTEGER_PATTERN = /^[1-9][0-9]*$/;

const PAGE_SIZES = Object.freeze([25, 50, 100]);
const SORTS = Object.freeze(['LATEST', 'UPDATED_DESC', 'STATUS', 'STORE']);
const ALLOWED_PARAMETERS = Object.freeze([
  'page', 'store', 'status', 'q', 'sort', 'pageNumber', 'pageSize',
]);

export class OrderManagementQueryError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'OrderManagementQueryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode = 400) {
  throw new OrderManagementQueryError(code, message, statusCode);
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function textParam(params, name, { maximum, pattern, fallback = '', required = false } = {}) {
  const values = params.getAll(name);
  if (values.length > 1) fail('QUERY_PARAMETER_DUPLICATED', `参数 ${name} 不能重复`);
  if (!values.length) {
    if (required) fail('QUERY_PARAMETER_MISSING', `参数 ${name} 必填`);
    return fallback;
  }
  const value = values[0].normalize('NFKC').trim();
  if (value.length > maximum) fail('QUERY_PARAMETER_TOO_LONG', `参数 ${name} 过长`);
  if (pattern && value && !pattern.test(value)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  return value;
}

function enumParam(params, name, allowed, fallback) {
  const value = textParam(params, name, { maximum: 120, fallback }).toUpperCase();
  if (!allowed.includes(value)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  return value;
}

function pageNumberParam(params) {
  const value = textParam(params, 'pageNumber', { maximum: 8, fallback: '1' });
  if (!INTEGER_PATTERN.test(value)) fail('QUERY_PARAMETER_INVALID', '参数 pageNumber 必须是整数');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 10_000) fail('QUERY_PARAMETER_OUT_OF_RANGE', '参数 pageNumber 超出范围');
  return parsed;
}

function pageSizeParam(params) {
  const value = textParam(params, 'pageSize', { maximum: 8, fallback: '50' });
  if (!INTEGER_PATTERN.test(value) || !PAGE_SIZES.includes(Number(value))) {
    fail('QUERY_PARAMETER_OUT_OF_RANGE', '参数 pageSize 只能是 25、50 或 100');
  }
  return Number(value);
}

function searchable(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return searchable(value.value);
  }
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function matchesQuery(row, query) {
  if (!query) return true;
  return [
    row.id,
    row.storeCode,
    row.statusCode,
    row.statusName,
    row.primary,
    row.secondary,
    ...rows(row.tags),
    ...rows(row.facts),
    ...rows(row.details),
  ].some((value) => searchable(value).includes(query));
}

function statusCodeOf(row) {
  return typeof row.statusCode === 'string' && row.statusCode !== '' ? row.statusCode : null;
}

function instant(row, field) {
  const value = row[field];
  const parsed = value ? new Date(value).valueOf() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareRows(sort) {
  return (left, right) => {
    if (sort === 'UPDATED_DESC') {
      return instant(right, 'updatedAt') - instant(left, 'updatedAt')
        || instant(right, 'createdAt') - instant(left, 'createdAt')
        || String(left.id).localeCompare(String(right.id));
    }
    if (sort === 'STATUS') {
      return String(statusCodeOf(left) ?? '\uffff').localeCompare(String(statusCodeOf(right) ?? '\uffff'))
        || instant(right, 'createdAt') - instant(left, 'createdAt')
        || String(left.id).localeCompare(String(right.id));
    }
    if (sort === 'STORE') {
      return String(left.storeCode).localeCompare(String(right.storeCode))
        || instant(right, 'createdAt') - instant(left, 'createdAt')
        || String(left.id).localeCompare(String(right.id));
    }
    return instant(right, 'createdAt') - instant(left, 'createdAt')
      || instant(right, 'updatedAt') - instant(left, 'updatedAt')
      || String(left.id).localeCompare(String(right.id));
  };
}

function countBy(input, key) {
  const counts = new Map();
  for (const row of input) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return counts;
}

export function queryOrderManagement(data, paramsValue = new URLSearchParams()) {
  const params = paramsValue instanceof URLSearchParams
    ? paramsValue
    : new URLSearchParams(paramsValue);
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMETERS.includes(key)) fail('QUERY_PARAMETER_UNKNOWN', `参数 ${key} 不受支持`);
  }
  const pageId = textParam(params, 'page', { maximum: 40, required: true });
  if (!ORDER_MANAGEMENT_PAGE_IDS.includes(pageId)) {
    fail('QUERY_PARAMETER_INVALID', '参数 page 必须是固定的页面标识');
  }
  const store = (textParam(params, 'store', { maximum: 12, pattern: STORE_PATTERN, fallback: 'ALL' }) || 'ALL').toUpperCase();
  const status = (textParam(params, 'status', { maximum: 120, pattern: CODE_PATTERN, fallback: 'ALL' }) || 'ALL').toUpperCase();
  const q = textParam(params, 'q', { maximum: 120, fallback: '' });
  const sort = enumParam(params, 'sort', SORTS, 'LATEST');
  const pageNumber = pageNumberParam(params);
  const pageSize = pageSizeParam(params);

  const index = record(data);
  const coverage = record(index.coverage);
  const pages = record(index.pages);
  const page = record(pages[pageId]);
  if (!pages[pageId] || page.status === 'UNAVAILABLE') {
    fail(
      'ORDER_MANAGEMENT_PAGE_UNAVAILABLE',
      typeof page.reason === 'string' && page.reason.trim() !== ''
        ? page.reason
        : '该页面数据暂不可用',
      503,
    );
  }
  const pageRows = rows(page.rows);
  const universeStores = [...new Set(pageRows.map((row) => String(row.storeCode)))];
  if (store !== 'ALL' && !universeStores.some((code) => code.toUpperCase() === store)) {
    fail('QUERY_STORE_UNKNOWN', '店铺不在当前数据范围内');
  }
  const universeStatuses = [...new Set(pageRows.map(statusCodeOf).filter(Boolean))];
  if (status !== 'ALL' && !universeStatuses.some((code) => code.toUpperCase() === status)) {
    fail('QUERY_PARAMETER_INVALID', '参数 status 无效');
  }
  const query = searchable(q);
  const scopedByStore = pageRows.filter((row) => (
    (store === 'ALL' || String(row.storeCode).toUpperCase() === store) && matchesQuery(row, query)
  ));
  const scopedByStatus = pageRows.filter((row) => (
    (status === 'ALL' || statusCodeOf(row)?.toUpperCase() === status) && matchesQuery(row, query)
  ));
  const matched = scopedByStore
    .filter((row) => status === 'ALL' || statusCodeOf(row)?.toUpperCase() === status)
    .sort(compareRows(sort));
  const offset = (pageNumber - 1) * pageSize;
  const pageRowsOut = matched.slice(offset, offset + pageSize);
  const pageCount = matched.length === 0 ? 0 : Math.ceil(matched.length / pageSize);
  const storeCounts = countBy(scopedByStatus, (row) => String(row.storeCode));
  const statusCounts = countBy(scopedByStore, statusCodeOf);
  const stores = [...universeStores]
    .sort((left, right) => left.localeCompare(right))
    .map((code) => ({ code, count: storeCounts.get(code) ?? 0 }));
  const statuses = [...universeStatuses]
    .sort((left, right) => left.localeCompare(right))
    .map((code) => ({ code, count: statusCounts.get(code) ?? 0 }));

  return Object.freeze({
    schemaVersion: 1,
    readOnly: true,
    pageId,
    page: Object.freeze({
      pageId,
      status: page.status,
      source: page.source,
      latestSourceFetchedAt: page.latestSourceFetchedAt ?? null,
      reason: page.reason ?? null,
    }),
    updatedAt: index.updatedAt ?? null,
    complete: page.status === 'AVAILABLE' && coverage.status === 'COMPLETE',
    coverage: Object.freeze({
      status: coverage.status ?? 'UNAVAILABLE',
      expectedStoreCount: coverage.expectedStoreCount ?? null,
      completedStoreCount: coverage.completedStoreCount ?? 0,
      storeCodes: Object.freeze(rows(coverage.storeCodes)),
      reason: coverage.reason ?? null,
    }),
    source: Object.freeze({
      updatedAt: index.updatedAt ?? null,
      latestSourceFetchedAt: page.latestSourceFetchedAt ?? null,
      storeCount: Number.isSafeInteger(coverage.completedStoreCount) ? coverage.completedStoreCount : null,
      expectedStoreCount: coverage.expectedStoreCount ?? null,
    }),
    query: Object.freeze({
      page: pageId,
      store,
      status,
      q,
      sort,
      pageNumber,
      pageSize,
    }),
    facets: Object.freeze({
      stores: Object.freeze(stores),
      statuses: Object.freeze(statuses),
      sorts: SORTS,
      pageSizes: PAGE_SIZES,
    }),
    pagination: Object.freeze({
      page: pageNumber,
      pageSize,
      pageCount,
      matchedRows: matched.length,
      hasPrevious: pageNumber > 1,
      hasNext: pageNumber < pageCount,
    }),
    rows: Object.freeze(pageRowsOut),
  });
}

export const ORDER_MANAGEMENT_SORTS = SORTS;
