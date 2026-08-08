const STORE_PATTERN = /^[A-Z0-9]{2,12}$/;
const OWNER_PATTERN = /^[\p{L}\p{N}._:-]{1,64}$/u;
const CODE_PATTERN = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>"'`\\]{1,120}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER_PATTERN = /^[1-9][0-9]*$/;

const PAGE_SIZES = Object.freeze([25, 50, 100]);
const ORDER_TYPES = Object.freeze(['ALL', 'URGENT', 'STOCK_UP']);
const QUICK_FILTERS = Object.freeze([
  'ALL',
  'PENDING_OR_RETURNED',
  'DUE_TODAY',
  'OVERDUE',
  'DEFECTIVE',
  'PENDING_RECEIPT',
]);
const TIME_FIELDS = Object.freeze([
  'CREATED',
  'REQUESTED_DELIVERY',
  'DELIVERED',
  'RECEIVED',
  'STORED',
  'UPDATED',
]);
const SORTS = Object.freeze(['LATEST', 'ORDERED_DESC', 'DELIVERY_DEADLINE']);
const DEFECTIVE_FILTERS = Object.freeze(['ALL', 'YES', 'NO']);

const STATUS_META = Object.freeze([
  ['ALL', '全部'],
  ['PENDING_SHIPMENT', '待发货'],
  ['SHIPPED', '已送货'],
  ['RECEIVED', '已收货'],
  ['RETURNED', '已退货'],
  ['COMPLETED', '已完成'],
  ['SHELVED', '已上架'],
  ['VOIDED', '已作废'],
]);

export class ShippingOrdersQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ShippingOrdersQueryError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new ShippingOrdersQueryError(code, message);
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function textParam(params, name, { maximum, pattern, fallback = '' } = {}) {
  const values = params.getAll(name);
  if (values.length > 1) fail('QUERY_PARAMETER_DUPLICATED', `参数 ${name} 不能重复`);
  if (!values.length) return fallback;
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

function pageParam(params) {
  const value = textParam(params, 'page', { maximum: 8, fallback: '1' });
  if (!INTEGER_PATTERN.test(value)) fail('QUERY_PARAMETER_INVALID', '参数 page 必须是整数');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 10_000) fail('QUERY_PARAMETER_OUT_OF_RANGE', '参数 page 超出范围');
  return parsed;
}

function pageSizeParam(params) {
  const value = textParam(params, 'pageSize', { maximum: 8, fallback: '50' });
  if (!INTEGER_PATTERN.test(value) || !PAGE_SIZES.includes(Number(value))) {
    fail('QUERY_PARAMETER_OUT_OF_RANGE', '参数 pageSize 只能是 25、50 或 100');
  }
  return Number(value);
}

function canonicalStatus(order) {
  const raw = `${order.statusName ?? ''} ${order.statusCode ?? ''}`;
  if (/作废/.test(raw)) return 'VOIDED';
  if (/上架/.test(raw)) return 'SHELVED';
  if (/完成/.test(raw)) return 'COMPLETED';
  if (/退货/.test(raw)) return 'RETURNED';
  if (/收货/.test(raw)) return 'RECEIVED';
  if (/送货|发货/.test(raw)) return 'SHIPPED';
  if (/下单|待发货/.test(raw)) return 'PENDING_SHIPMENT';
  return `RAW:${String(order.statusCode ?? order.statusName ?? 'UNKNOWN')}`;
}

function canonicalOrderType(order) {
  const raw = `${order.orderTypeName ?? ''} ${order.orderTypeCode ?? ''}`;
  return /急采|(^|\s)1($|\s)/.test(raw) ? 'URGENT' : 'STOCK_UP';
}

function searchable(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function matchesQuery(order, query) {
  if (!query) return true;
  const lineText = rows(order.lines).flatMap((line) => [
    line.standardGoodsCode,
    line.standardGoodsName,
    line.skuCode,
    line.skc,
    line.supplierCode,
    line.supplierSku,
    line.variantName,
  ]);
  const deliveryText = rows(order.deliveries).flatMap((delivery) => [
    delivery.deliveryCode,
    delivery.expressCode,
    delivery.expressCompanyName,
  ]);
  return [
    order.storeCode,
    order.storeName,
    order.orderNo,
    order.statusName,
    order.orderTypeName,
    order.warehouseName,
    ...lineText,
    ...deliveryText,
  ].some((value) => searchable(value).includes(query));
}

function ownerStoreSet(dashboard, ownerKey) {
  if (ownerKey === 'ALL') return null;
  const owner = rows(dashboard?.owners).find((candidate) => candidate.key === ownerKey);
  if (!owner) fail('QUERY_OWNER_UNKNOWN', '负责人不在当前数据范围内');
  return new Set(rows(owner.storeCodes).map((code) => String(code).toUpperCase()));
}

function instant(order, timeField) {
  const value = {
    CREATED: order.createdAt,
    REQUESTED_DELIVERY: order.requestedDeliveryAt,
    DELIVERED: order.deliveredAt,
    RECEIVED: order.receivedAt,
    STORED: order.storedAt,
    UPDATED: order.updatedAt ?? order.latestSourceFetchedAt,
  }[timeField];
  const parsed = value ? new Date(value).valueOf() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function dateRange(params) {
  const start = textParam(params, 'start', { maximum: 10, pattern: DATE_PATTERN, fallback: '' });
  const end = textParam(params, 'end', { maximum: 10, pattern: DATE_PATTERN, fallback: '' });
  if (!start && !end) return { start, end, startMs: null, endExclusiveMs: null };
  if (!start || !end || start > end) fail('QUERY_DATE_RANGE_INVALID', '日期范围无效');
  return {
    start,
    end,
    startMs: new Date(`${start}T00:00:00+08:00`).valueOf(),
    endExclusiveMs: new Date(`${end}T00:00:00+08:00`).valueOf() + 86_400_000,
  };
}

function isOpen(order) {
  return !['COMPLETED', 'SHELVED', 'VOIDED'].includes(canonicalStatus(order));
}

function isDefective(order) {
  return rows(order.lines).some((line) => Number.isSafeInteger(line.defectiveQuantity) && line.defectiveQuantity > 0);
}

function shanghaiDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function quickMatches(order, quick, today, nowMs) {
  const status = canonicalStatus(order);
  if (quick === 'ALL') return true;
  if (quick === 'PENDING_OR_RETURNED') return ['PENDING_SHIPMENT', 'RETURNED'].includes(status);
  if (quick === 'DUE_TODAY') return isOpen(order) && shanghaiDate(order.requestedDeliveryAt) === today;
  if (quick === 'OVERDUE') {
    const deadline = order.requestedDeliveryAt ? new Date(order.requestedDeliveryAt).valueOf() : Number.NaN;
    return isOpen(order) && Number.isFinite(deadline) && deadline < nowMs;
  }
  if (quick === 'DEFECTIVE') return isDefective(order);
  if (quick === 'PENDING_RECEIPT') return Boolean(order.deliveredAt) && !order.receivedAt;
  return true;
}

function nullableSum(input, selector) {
  const values = input.map(selector);
  if (!values.length || values.some((value) => !Number.isSafeInteger(value))) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function compareOrders(sort) {
  const time = (value, fallback) => {
    const parsed = value ? new Date(value).valueOf() : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return (left, right) => {
    if (sort === 'DELIVERY_DEADLINE') {
      const compared = time(left.requestedDeliveryAt, Number.POSITIVE_INFINITY)
        - time(right.requestedDeliveryAt, Number.POSITIVE_INFINITY);
      if (Number.isFinite(compared) && compared !== 0) return compared;
    } else if (sort === 'ORDERED_DESC') {
      const compared = time(right.createdAt, Number.NEGATIVE_INFINITY)
        - time(left.createdAt, Number.NEGATIVE_INFINITY);
      if (Number.isFinite(compared) && compared !== 0) return compared;
    } else {
      const compared = time(right.latestSourceFetchedAt, Number.NEGATIVE_INFINITY)
        - time(left.latestSourceFetchedAt, Number.NEGATIVE_INFINITY);
      if (Number.isFinite(compared) && compared !== 0) return compared;
    }
    return String(left.storeCode).localeCompare(String(right.storeCode))
      || String(left.orderNo).localeCompare(String(right.orderNo));
  };
}

function countBy(input, key) {
  const counts = new Map();
  for (const row of input) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return counts;
}

export function queryShippingOrders(
  dashboard,
  shippingData,
  paramsValue = new URLSearchParams(),
  { now = new Date() } = {},
) {
  const params = paramsValue instanceof URLSearchParams
    ? paramsValue
    : new URLSearchParams(paramsValue);
  const owner = textParam(params, 'owner', { maximum: 64, pattern: OWNER_PATTERN, fallback: 'ALL' }) || 'ALL';
  const store = (textParam(params, 'store', { maximum: 12, pattern: STORE_PATTERN, fallback: 'ALL' }) || 'ALL').toUpperCase();
  const q = textParam(params, 'q', { maximum: 120, fallback: '' });
  const orderType = enumParam(params, 'orderType', ORDER_TYPES, 'STOCK_UP');
  const status = textParam(params, 'status', { maximum: 120, pattern: CODE_PATTERN, fallback: 'ALL' }).toUpperCase() || 'ALL';
  const quick = enumParam(params, 'quick', QUICK_FILTERS, 'ALL');
  const timeField = enumParam(params, 'timeField', TIME_FIELDS, 'CREATED');
  const warehouse = textParam(params, 'warehouse', { maximum: 120, pattern: CODE_PATTERN, fallback: 'ALL' });
  const defective = enumParam(params, 'defective', DEFECTIVE_FILTERS, 'ALL');
  const sort = enumParam(params, 'sort', SORTS, 'LATEST');
  const page = pageParam(params);
  const pageSize = pageSizeParam(params);
  const range = dateRange(params);
  const ownerStores = ownerStoreSet(dashboard, owner);
  const query = searchable(q);
  const today = shanghaiDate(now.toISOString());
  const nowMs = now.valueOf();

  const scoped = rows(shippingData?.orders).filter((order) => {
    const code = String(order.storeCode ?? '').toUpperCase();
    if (store !== 'ALL' && code !== store) return false;
    if (ownerStores && !ownerStores.has(code)) return false;
    if (orderType !== 'ALL' && canonicalOrderType(order) !== orderType) return false;
    if (warehouse !== 'ALL' && String(order.warehouseName ?? order.warehouseCode ?? '') !== warehouse) return false;
    if (defective === 'YES' && !isDefective(order)) return false;
    if (defective === 'NO' && isDefective(order)) return false;
    if (!matchesQuery(order, query)) return false;
    const orderInstant = instant(order, timeField);
    if (range.startMs !== null && (orderInstant === null || orderInstant < range.startMs || orderInstant >= range.endExclusiveMs)) return false;
    return true;
  });
  const statusCounts = countBy(scoped, canonicalStatus);
  const statusFiltered = status === 'ALL'
    ? scoped
    : scoped.filter((order) => canonicalStatus(order) === status);
  const quickCounts = new Map(QUICK_FILTERS.map((key) => [
    key,
    statusFiltered.filter((order) => quickMatches(order, key, today, nowMs)).length,
  ]));
  const matched = statusFiltered
    .filter((order) => quickMatches(order, quick, today, nowMs))
    .sort(compareOrders(sort));
  const offset = (page - 1) * pageSize;
  const pageRows = matched.slice(offset, offset + pageSize);
  const pageCount = matched.length === 0 ? 0 : Math.ceil(matched.length / pageSize);
  const stores = [...new Map(rows(shippingData?.orders).map((order) => [
    order.storeCode,
    { code: order.storeCode, name: order.storeName || order.storeCode },
  ])).values()].sort((left, right) => left.code.localeCompare(right.code));
  const warehouses = [...new Set(rows(shippingData?.orders)
    .map((order) => order.warehouseName || order.warehouseCode)
    .filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const totalLineCount = matched.reduce((sum, order) => sum + rows(order.lines).length, 0);
  const totalSkcCount = new Set(matched.flatMap((order) => rows(order.lines).map((line) => (
    `${order.storeCode}\u001f${line.skc ?? line.skuCode ?? line.supplierCode ?? line.lineKey}`
  )))).size;

  return Object.freeze({
    schemaVersion: 1,
    readOnly: true,
    source: Object.freeze({
      updatedAt: shippingData?.updatedAt ?? null,
      latestSourceFetchedAt: record(shippingData?.source).latestSourceFetchedAt ?? null,
      basis: record(shippingData?.source).basis ?? null,
      storeCount: record(shippingData?.source).storeCount ?? null,
      orderCount: record(shippingData?.source).orderCount ?? null,
      lineCount: record(shippingData?.source).lineCount ?? null,
      capabilities: record(shippingData?.capabilities),
    }),
    query: Object.freeze({
      owner, store, q, orderType, status, quick, timeField,
      start: range.start, end: range.end, warehouse, defective, sort, page, pageSize,
    }),
    summary: Object.freeze({
      orderCount: matched.length,
      lineCount: totalLineCount,
      skcCount: totalSkcCount,
      orderQuantity: nullableSum(matched, (order) => order.totals?.orderQuantity),
      deliveryQuantity: nullableSum(matched, (order) => order.totals?.deliveryQuantity),
      defectiveQuantity: nullableSum(matched, (order) => order.totals?.defectiveQuantity),
      overdueCount: matched.filter((order) => quickMatches(order, 'OVERDUE', today, nowMs)).length,
      dueTodayCount: matched.filter((order) => quickMatches(order, 'DUE_TODAY', today, nowMs)).length,
    }),
    filters: Object.freeze({
      owners: Object.freeze(rows(dashboard?.owners)),
      stores: Object.freeze(stores),
      statuses: Object.freeze(STATUS_META.map(([code, label]) => ({
        code,
        label,
        count: code === 'ALL' ? scoped.length : statusCounts.get(code) ?? 0,
      }))),
      quick: Object.freeze(QUICK_FILTERS.map((code) => ({ code, count: quickCounts.get(code) ?? 0 }))),
      orderTypes: ORDER_TYPES,
      timeFields: TIME_FIELDS,
      warehouses: Object.freeze(warehouses),
      defective: DEFECTIVE_FILTERS,
      sorts: SORTS,
      pageSizes: PAGE_SIZES,
    }),
    orders: Object.freeze({
      rows: Object.freeze(pageRows),
      pagination: Object.freeze({
        page,
        pageSize,
        pageCount,
        matchedRows: matched.length,
        hasPrevious: page > 1,
        hasNext: page < pageCount,
      }),
    }),
  });
}

export const SHIPPING_ORDER_STATUS_META = STATUS_META;
export const SHIPPING_ORDER_QUICK_FILTERS = QUICK_FILTERS;
