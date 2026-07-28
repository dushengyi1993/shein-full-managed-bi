const STORE_PATTERN = /^[A-Z0-9]{2,12}$/;
const OWNER_PATTERN = /^[\p{L}\p{N}._:-]{1,64}$/u;
const STATUS_PATTERN = /^[\p{L}\p{N}._:-]{1,80}$/u;
const INTEGER_PATTERN = /^[1-9][0-9]*$/;

const QUICK_FILTERS = Object.freeze([
  'ALL',
  'HIGH',
  'OVERDUE',
  'PENDING_DELIVERY',
  'PENDING_RECEIPT',
  'PENDING_STORAGE',
]);

const SORTS = Object.freeze([
  'PRIORITY',
  'LATEST',
  'DELIVERY_DEADLINE',
]);

const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const SEVERITY_RANK = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
});

export class ProcurementQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProcurementQueryError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new ProcurementQueryError(code, message);
}

function textParam(params, name, { maximum, pattern, fallback = '' } = {}) {
  const values = params.getAll(name);
  if (values.length > 1) fail('QUERY_PARAMETER_DUPLICATED', `参数 ${name} 不能重复`);
  if (values.length === 0) return fallback;
  const value = values[0].trim();
  if (value.length > maximum) fail('QUERY_PARAMETER_TOO_LONG', `参数 ${name} 过长`);
  if (pattern && value !== '' && !pattern.test(value)) {
    fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  }
  return value;
}

function enumParam(params, name, allowed, fallback) {
  const value = textParam(params, name, { maximum: 80, fallback }).toUpperCase();
  if (!allowed.includes(value)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  return value;
}

function integerParam(params, name, { fallback, minimum, maximum }) {
  const value = textParam(params, name, { maximum: 8, fallback: String(fallback) });
  if (!INTEGER_PATTERN.test(value)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 必须是整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('QUERY_PARAMETER_OUT_OF_RANGE', `参数 ${name} 超出范围`);
  }
  return parsed;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function searchable(value) {
  return String(value ?? '').trim().toLocaleLowerCase('zh-CN');
}

function containsQuery(row, query) {
  if (query === '') return true;
  return [
    row.storeCode,
    row.storeName,
    row.orderNo,
    row.statusCode,
    row.statusName,
    row.orderTypeName,
    row.warehouseName,
    row.attentionCode,
    row.attentionLabel,
  ].some((value) => searchable(value).includes(query));
}

function matchesQuickFilter(row, quick) {
  if (quick === 'ALL') return true;
  const severity = String(row.severity ?? '').toLowerCase();
  const attentionCode = String(row.attentionCode ?? '').toUpperCase();
  if (quick === 'HIGH') return severity === 'critical' || severity === 'high';
  return attentionCode.includes(quick);
}

function comparableInstant(value, fallback) {
  const parsed = value ? new Date(value).valueOf() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN');
}

function compareAttention(sort) {
  return (left, right) => {
    if (sort === 'LATEST') {
      const latest = (
        comparableInstant(right.latestSourceFetchedAt, Number.NEGATIVE_INFINITY)
        - comparableInstant(left.latestSourceFetchedAt, Number.NEGATIVE_INFINITY)
      );
      if (latest !== 0) return latest;
    } else if (sort === 'DELIVERY_DEADLINE') {
      const deadline = (
        comparableInstant(left.requestedDeliveryAt, Number.POSITIVE_INFINITY)
        - comparableInstant(right.requestedDeliveryAt, Number.POSITIVE_INFINITY)
      );
      if (deadline !== 0) return deadline;
    } else {
      const priority = (
        (SEVERITY_RANK[String(right.severity ?? '').toLowerCase()] ?? 0)
        - (SEVERITY_RANK[String(left.severity ?? '').toLowerCase()] ?? 0)
      );
      if (priority !== 0) return priority;
      const deadline = (
        comparableInstant(left.requestedDeliveryAt, Number.POSITIVE_INFINITY)
        - comparableInstant(right.requestedDeliveryAt, Number.POSITIVE_INFINITY)
      );
      if (deadline !== 0) return deadline;
    }
    return (
      compareText(left.storeCode, right.storeCode)
      || compareText(left.orderNo, right.orderNo)
      || compareText(left.attentionCode, right.attentionCode)
    );
  };
}

function ownerStoreSet(dashboard, ownerKey) {
  if (ownerKey === 'ALL') return null;
  const owner = rows(dashboard.owners).find((item) => item.key === ownerKey);
  if (!owner) fail('QUERY_OWNER_UNKNOWN', '负责人不在当前数据范围内');
  return new Set(rows(owner.storeCodes));
}

function matchesScope(row, { store, ownerStores }) {
  const storeCode = String(row.storeCode ?? '').toUpperCase();
  if (store !== 'ALL' && storeCode !== store) return false;
  return ownerStores === null || ownerStores.has(storeCode);
}

function completeOrderCount(statusRows) {
  if (statusRows.length === 0) return null;
  if (statusRows.some((row) => !Number.isSafeInteger(row.orderCount) || row.orderCount < 0)) {
    return null;
  }
  return statusRows.reduce((total, row) => total + row.orderCount, 0);
}

function latestInstant(inputRows) {
  const values = inputRows
    .map((row) => comparableInstant(row.latestSourceFetchedAt, Number.NaN))
    .filter(Number.isFinite);
  return values.length === 0 ? null : new Date(Math.max(...values)).toISOString();
}

function safeMeta(value) {
  const source = record(value);
  return {
    available: source.available === true,
    total: Number.isSafeInteger(source.total) && source.total >= 0 ? source.total : null,
    returned: Number.isSafeInteger(source.returned) && source.returned >= 0
      ? source.returned
      : null,
    truncated: source.truncated === true,
  };
}

function storeOptions(dashboard, statusRows, attentionRows) {
  const names = new Map();
  for (const row of [...statusRows, ...attentionRows]) {
    const code = String(row.storeCode ?? '').toUpperCase();
    if (!STORE_PATTERN.test(code)) continue;
    if (!names.has(code)) names.set(code, row.storeName || code);
  }
  for (const owner of rows(dashboard.owners)) {
    for (const code of rows(owner.storeCodes)) {
      if (STORE_PATTERN.test(code) && !names.has(code)) names.set(code, code);
    }
  }
  return [...names].sort(([left], [right]) => left.localeCompare(right))
    .map(([code, name]) => ({ code, name }));
}

/**
 * Query only the bounded, materialized procurement evidence in dashboard.json.
 *
 * The returned totals are explicitly named `matchedMaterialized*`; they never
 * claim to represent warehouse rows hidden by the materializer's source limit.
 */
export function queryProcurementDashboard(dashboardValue, paramsValue = new URLSearchParams()) {
  const dashboard = record(dashboardValue);
  const params = paramsValue instanceof URLSearchParams
    ? paramsValue
    : new URLSearchParams(paramsValue);
  const owner = textParam(params, 'owner', {
    maximum: 64,
    pattern: OWNER_PATTERN,
    fallback: 'ALL',
  }) || 'ALL';
  const store = (textParam(params, 'store', {
    maximum: 12,
    pattern: STORE_PATTERN,
    fallback: 'ALL',
  }) || 'ALL').toUpperCase();
  const query = searchable(textParam(params, 'q', { maximum: 80, fallback: '' }));
  const status = (textParam(params, 'status', {
    maximum: 80,
    pattern: STATUS_PATTERN,
    fallback: 'ALL',
  }) || 'ALL').toUpperCase();
  const quick = enumParam(params, 'quick', QUICK_FILTERS, 'ALL');
  const sort = enumParam(params, 'sort', SORTS, 'PRIORITY');
  const page = integerParam(params, 'page', { fallback: 1, minimum: 1, maximum: 10_000 });
  const pageSize = integerParam(params, 'pageSize', { fallback: 25, minimum: 1, maximum: 100 });
  const ownerStores = ownerStoreSet(dashboard, owner);

  const supply = record(dashboard.supply);
  const allStatusRows = rows(supply.purchaseOrderStatus);
  const allAttentionRows = rows(supply.purchaseOrderAttention);
  const scopedStatusRows = allStatusRows.filter((row) => (
    matchesScope(row, { store, ownerStores })
    && (status === 'ALL' || row.statusCode === status)
    && containsQuery(row, query)
  ));
  const matchedAttentionRows = allAttentionRows
    .filter((row) => (
      matchesScope(row, { store, ownerStores })
      && (status === 'ALL' || row.statusCode === status)
      && containsQuery(row, query)
      && matchesQuickFilter(row, quick)
    ))
    .sort(compareAttention(sort));

  const offset = (page - 1) * pageSize;
  const pageRows = matchedAttentionRows.slice(offset, offset + pageSize);
  const pageCount = matchedAttentionRows.length === 0
    ? 0
    : Math.ceil(matchedAttentionRows.length / pageSize);
  const attentionMeta = safeMeta(record(supply.attentionMeta).purchaseOrders);
  const coverage = record(record(supply.coverage).domains).purchaseOrders;
  const statuses = [...new Map(
    allStatusRows
      .filter((row) => row.statusCode)
      .map((row) => [row.statusCode, {
        code: row.statusCode,
        name: row.statusName || row.statusCode,
      }]),
  ).values()].sort((left, right) => compareText(left.name, right.name));

  return Object.freeze({
    schemaVersion: 1,
    readOnly: true,
    source: Object.freeze({
      dashboardUpdatedAt: dashboard.updatedAt ?? null,
      businessDate: dashboard.businessDate ?? null,
      datasetStatus: record(dashboard.dataset).status ?? null,
      supplyStatus: supply.status ?? 'unknown',
      coverage: record(coverage),
      materializedAttention: Object.freeze(attentionMeta),
    }),
    query: Object.freeze({
      owner,
      store,
      q: textParam(params, 'q', { maximum: 80, fallback: '' }),
      status,
      quick,
      sort,
      page,
      pageSize,
    }),
    summary: Object.freeze({
      matchedMaterializedAttentionCount: matchedAttentionRows.length,
      matchedStatusRowCount: scopedStatusRows.length,
      orderCount: completeOrderCount(scopedStatusRows),
      statusCount: new Set(scopedStatusRows.map((row) => row.statusCode).filter(Boolean)).size,
      storeCount: new Set([
        ...scopedStatusRows.map((row) => row.storeCode),
        ...matchedAttentionRows.map((row) => row.storeCode),
      ].filter(Boolean)).size,
      latestSourceFetchedAt: latestInstant([...scopedStatusRows, ...matchedAttentionRows]),
    }),
    filters: Object.freeze({
      owners: Object.freeze(rows(dashboard.owners).map((item) => ({
        key: item.key,
        name: item.name,
        storeCodes: rows(item.storeCodes),
      }))),
      stores: Object.freeze(storeOptions(dashboard, allStatusRows, allAttentionRows)),
      statuses: Object.freeze(statuses),
      quick: QUICK_FILTERS,
      sorts: SORTS,
    }),
    statusRows: Object.freeze(scopedStatusRows),
    attention: Object.freeze({
      rows: Object.freeze(pageRows),
      pagination: Object.freeze({
        page,
        pageSize,
        pageCount,
        matchedMaterializedRows: matchedAttentionRows.length,
        hasPrevious: page > 1,
        hasNext: page < pageCount,
      }),
    }),
  });
}
