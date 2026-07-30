import crypto from 'node:crypto';
import { normalizeFullManagedStoreCode } from '../config/full-managed-stores.mjs';

export const HOME_WEBAPI_ORIGIN = 'https://sso.geiwohuo.com';
export const HOME_HISTORY_EARLIEST_DATE = '2023-06-07';
export const HOME_HISTORY_MAX_WINDOW_DAYS = 90;
export const HOME_HISTORY_CONTRACT_VERSION = 1;

export const HOME_ENDPOINTS = Object.freeze({
  STORE_DAILY_HISTORY: Object.freeze({
    method: 'POST',
    path: '/sbn/index/get_critical_indicator_curve_chart',
  }),
  STORE_REALTIME: Object.freeze({
    method: 'POST',
    path: '/sbn/index/getRealTimeIndicatorCurveChart',
  }),
  TRADE_OVERVIEW: Object.freeze({
    method: 'POST',
    path: '/sbn/trade/overview',
  }),
  REGION_RANK: Object.freeze({
    method: 'POST',
    path: '/sbn/trade/rank_top',
  }),
  ANALYSE_MODEL: Object.freeze({
    method: 'POST',
    path: '/sbn/analyse/model_dimension',
  }),
  ANALYSE_SEARCH: Object.freeze({
    method: 'POST',
    path: '/sbn/analyse/search',
  }),
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_HOUR_PATTERN = /^\d{10}$/;

export class FullHomeContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FullHomeContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new FullHomeContractError(code, message);
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isoDate(value, location) {
  const normalized = String(value ?? '').trim();
  if (!DATE_PATTERN.test(normalized)) fail('HOME_DATE_INVALID', `${location} is invalid`);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== normalized) {
    fail('HOME_DATE_INVALID', `${location} is invalid`);
  }
  return normalized;
}

function dateDistanceDays(start, end) {
  return Math.round(
    (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`))
      / 86_400_000,
  );
}

function canonicalStore(value) {
  const storeCode = String(value ?? '').trim().toUpperCase();
  const canonical = normalizeFullManagedStoreCode(storeCode);
  if (!canonical) fail('HOME_STORE_NOT_ALLOWED', 'store is outside the configured roster');
  return canonical;
}

function optionalDecimal(value) {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const text = String(value).replaceAll(',', '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function optionalCount(value) {
  const number = optionalDecimal(value);
  return Number.isSafeInteger(number) ? number : null;
}

function optionalRate(value) {
  const number = optionalDecimal(value);
  if (number === null) return null;
  if (number >= 0 && number <= 1) return number;
  if (number > 1 && number <= 100) return number / 100;
  return null;
}

function dateFromRow(row) {
  const candidate = row.dataDate ?? row.reportDate ?? row.date ?? row.dt;
  if (candidate === null || candidate === undefined) return null;
  const text = String(candidate).trim();
  if (/^\d{8}$/.test(text)) {
    return isoDate(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`, 'row date');
  }
  try {
    return isoDate(text.slice(0, 10), 'row date');
  } catch {
    return null;
  }
}

function responseData(body) {
  if (Array.isArray(body)) return body;
  const source = record(body);
  if (Array.isArray(source.info)) return source.info;
  if (Array.isArray(source.data)) return source.data;
  const data = record(source.data);
  if (Array.isArray(data.info)) return data.info;
  for (const key of ['list', 'records', 'rows', 'result']) {
    if (Array.isArray(data[key])) return data[key];
  }
  const info = record(source.info);
  for (const key of ['list', 'records', 'rows', 'result', 'data']) {
    if (Array.isArray(info[key])) return info[key];
  }
  for (const key of ['list', 'records', 'rows', 'result']) {
    if (Array.isArray(source[key])) return source[key];
  }
  return [];
}

function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Json(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

export function endpointUrl(endpointCode) {
  const endpoint = HOME_ENDPOINTS[String(endpointCode ?? '')];
  if (!endpoint) fail('HOME_ENDPOINT_NOT_ALLOWED', 'endpoint is not in the fixed contract');
  return `${HOME_WEBAPI_ORIGIN}${endpoint.path}`;
}

export function historyWindows({
  startDate = HOME_HISTORY_EARLIEST_DATE,
  endDate,
  maximumDays = HOME_HISTORY_MAX_WINDOW_DAYS,
} = {}) {
  const start = isoDate(startDate, 'startDate');
  const end = isoDate(endDate, 'endDate');
  if (start > end) fail('HOME_DATE_RANGE_INVALID', 'startDate is after endDate');
  if (!Number.isSafeInteger(maximumDays) || maximumDays < 1 || maximumDays > 90) {
    fail('HOME_WINDOW_INVALID', 'maximumDays must be between 1 and 90');
  }
  const windows = [];
  let cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= last) {
    const windowStart = cursor.toISOString().slice(0, 10);
    const windowEndDate = new Date(cursor);
    windowEndDate.setUTCDate(windowEndDate.getUTCDate() + maximumDays - 1);
    const windowEnd = new Date(Math.min(windowEndDate.valueOf(), last.valueOf()))
      .toISOString().slice(0, 10);
    windows.push(Object.freeze({ startDate: windowStart, endDate: windowEnd }));
    cursor = new Date(`${windowEnd}T00:00:00.000Z`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Object.freeze(windows);
}

function commonRequest({ startDate, endDate, observedDate }) {
  const start = isoDate(startDate, 'startDate');
  const end = isoDate(endDate, 'endDate');
  if (start > end || dateDistanceDays(start, end) > HOME_HISTORY_MAX_WINDOW_DAYS) {
    fail('HOME_DATE_RANGE_INVALID', 'history window exceeds the official 90-day limit');
  }
  const anchor = isoDate(observedDate ?? end, 'observedDate').replaceAll('-', '');
  return {
    areaCd: 'cn',
    dt: anchor,
    countrySite: ['shein-all'],
    startDate: start,
    endDate: end,
  };
}

export function buildStoreDailyHistoryRequest(input = {}) {
  return Object.freeze({
    ...commonRequest(input),
    queryType: 1,
    pageNum: 1,
    pageSize: 1000,
  });
}

export function buildTradeOverviewRequest(input = {}) {
  return Object.freeze({
    ...commonRequest(input),
    queryType: 1,
  });
}

export function buildRegionRankRequest(input = {}) {
  return Object.freeze({
    ...commonRequest(input),
    queryType: 1,
  });
}

export function buildRealtimeRequest({ startHour, endHour, observedDate } = {}) {
  const start = String(startHour ?? '');
  const end = String(endHour ?? '');
  if (!DATE_TIME_HOUR_PATTERN.test(start) || !DATE_TIME_HOUR_PATTERN.test(end) || start > end) {
    fail('HOME_REALTIME_RANGE_INVALID', 'realtime hour range is invalid');
  }
  const dt = isoDate(observedDate ?? `${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}`, 'observedDate')
    .replaceAll('-', '');
  return Object.freeze({
    areaCd: 'cn',
    dt,
    countrySite: ['shein-all'],
    scene: '1',
    startDt: start,
    endDt: end,
  });
}

export function buildProductDailyRequest({
  startDate,
  endDate,
  grain = 'SPU',
} = {}) {
  const start = isoDate(startDate, 'startDate');
  const end = isoDate(endDate, 'endDate');
  if (start > end || dateDistanceDays(start, end) > HOME_HISTORY_MAX_WINDOW_DAYS) {
    fail('HOME_DATE_RANGE_INVALID', 'product window exceeds the official 90-day limit');
  }
  const normalizedGrain = String(grain).toUpperCase();
  if (!['SPU', 'SKC'].includes(normalizedGrain)) {
    fail('HOME_PRODUCT_GRAIN_INVALID', 'product grain must be SPU or SKC');
  }
  return Object.freeze({
    dimension: { dimensionType: 'product', dimensionSub: normalizedGrain },
    range: {
      brandIdList: [],
      countrySiteList: ['shein-all'],
      skuCate1Id: [],
      skuCate2Id: [],
      skuCate3Id: [],
      skuCate4Id: [],
    },
    time: {
      timeInterval: 'day',
      timeSummary: 'all',
      startDate: start,
      endDate: end,
    },
  });
}

export function buildShopDailyRequest({ startDate, endDate } = {}) {
  const start = isoDate(startDate, 'startDate');
  const end = isoDate(endDate, 'endDate');
  if (start > end || dateDistanceDays(start, end) > HOME_HISTORY_MAX_WINDOW_DAYS) {
    fail('HOME_DATE_RANGE_INVALID', 'shop window exceeds the official 90-day limit');
  }
  return Object.freeze({
    dimension: { dimensionType: 'shop' },
    range: {
      brandIdList: [],
      countrySiteList: ['shein-all'],
    },
    time: {
      timeInterval: 'day',
      timeSummary: 'all',
      startDate: start,
      endDate: end,
    },
  });
}

export function buildAnalyseSearchRequest({ pageNum = 1, pageSize = 200 } = {}) {
  if (!Number.isSafeInteger(pageNum) || pageNum < 1 || pageNum > 100_000) {
    fail('HOME_PAGE_INVALID', 'pageNum is invalid');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    fail('HOME_PAGE_SIZE_INVALID', 'pageSize is invalid');
  }
  return Object.freeze({ pageNum, pageSize });
}

export function parseStoreDailyHistory(body, {
  storeCode,
  observedAt = new Date().toISOString(),
  realtimeDate = null,
} = {}) {
  const store = canonicalStore(storeCode);
  const rows = responseData(body);
  const result = [];
  for (const input of rows) {
    const row = record(input);
    const businessDate = realtimeDate
      ? isoDate(realtimeDate, 'realtimeDate')
      : dateFromRow(row);
    if (!businessDate) continue;
    const realtime = realtimeDate !== null;
    result.push(Object.freeze({
      storeCode: store,
      businessDate,
      currency: typeof row.currency === 'string' && /^[A-Za-z]{3}$/.test(row.currency)
        ? row.currency.toUpperCase()
        : null,
      dealAmount: optionalDecimal(row[realtime ? 'dealAmtH' : 'dealAmt1d']),
      netDealAmount: optionalDecimal(row[realtime ? 'netDealAmtH' : 'netDealAmt1d']),
      salesQuantity: optionalCount(row[realtime ? 'saleCntH' : 'saleCnt1d']),
      buyerCount: optionalCount(
        row[realtime ? 'buyerCntH' : 'idxBuyerCnt1d'] ?? row.buyerCnt1d,
      ),
      goodsDetailVisitors: optionalCount(
        row[realtime ? 'shopGoodsUvH' : 'idxShopGoodsUv1d'],
      ),
      stockingOrderCount: optionalCount(row[realtime ? 'bhOrdCntH' : 'bhOrdCnt1d']),
      urgentPurchaseOrderCount: optionalCount(row[realtime ? 'jcOrdCntH' : 'jcOrdCnt1d']),
      sourceUpdatedAt: row.updateTime ?? row.dataUpdateTime ?? null,
      observedAt,
      sourceCode: realtime ? 'WEBAPI_REALTIME' : 'WEBAPI_INDEX',
    }));
  }
  return Object.freeze(result);
}

function flattenAnalysisRow(input) {
  const row = record(input);
  return {
    ...record(row.goods),
    ...record(row.trade),
    ...record(row.flow),
    ...row,
  };
}

function analyseRows(body) {
  const source = record(body);
  const payload = record(source.info ?? source.data ?? source);
  const result = record(payload.analyseResult);
  return Array.isArray(result.data) ? result.data : responseData(body);
}

export function parseShopAnalysisRows(body, {
  storeCode,
  observedAt = new Date().toISOString(),
} = {}) {
  const store = canonicalStore(storeCode);
  const byDate = new Map();
  for (const input of analyseRows(body)) {
    const row = flattenAnalysisRow(input);
    const businessDate = dateFromRow(row);
    if (!businessDate) continue;
    const current = byDate.get(businessDate) ?? {
      storeCode: store,
      businessDate,
      exposureUsers: 0,
      exposureKnown: false,
      paymentOrderCount: 0,
      paymentOrdersKnown: false,
      salesQuantity: 0,
      salesKnown: false,
      observedAt,
      sourceCode: 'WEBAPI_ANALYSE',
    };
    const exposure = optionalCount(row.exposeUv);
    const paymentOrders = optionalCount(row.payOrderCnt);
    const sales = optionalCount(row.saleCnt);
    if (exposure !== null) {
      current.exposureUsers += exposure;
      current.exposureKnown = true;
    }
    if (paymentOrders !== null) {
      current.paymentOrderCount += paymentOrders;
      current.paymentOrdersKnown = true;
    }
    if (sales !== null) {
      current.salesQuantity += sales;
      current.salesKnown = true;
    }
    byDate.set(businessDate, current);
  }
  return Object.freeze([...byDate.values()].map((row) => Object.freeze({
    storeCode: row.storeCode,
    businessDate: row.businessDate,
    exposureUsers: row.exposureKnown ? row.exposureUsers : null,
    exposureBasis: row.exposureKnown ? 'BRAND_SUMMED' : 'UNAVAILABLE',
    paymentOrderCount: row.paymentOrdersKnown ? row.paymentOrderCount : null,
    salesQuantity: row.salesKnown ? row.salesQuantity : null,
    observedAt: row.observedAt,
    sourceCode: row.sourceCode,
  })));
}

export function parseProductDailyRows(body, {
  storeCode,
  grain = 'SPU',
  observedAt = new Date().toISOString(),
} = {}) {
  const store = canonicalStore(storeCode);
  const normalizedGrain = String(grain).toUpperCase();
  if (!['SPU', 'SKC'].includes(normalizedGrain)) {
    fail('HOME_PRODUCT_GRAIN_INVALID', 'product grain must be SPU or SKC');
  }
  const result = [];
  for (const input of analyseRows(body)) {
    const row = flattenAnalysisRow(input);
    const businessDate = dateFromRow(row);
    const productKey = String(
      normalizedGrain === 'SPU'
        ? row.spu ?? row.spuCode ?? row.goodsSpu
        : row.goodsSn ?? row.skc ?? row.skcCode,
    ).trim();
    if (!businessDate || !productKey || productKey === 'undefined') continue;
    result.push(Object.freeze({
      storeCode: store,
      businessDate,
      productGrain: normalizedGrain,
      productKey: productKey.slice(0, 160),
      platformSpuId: String(row.spu ?? row.spuCode ?? '').trim() || null,
      platformSkcId: String(row.goodsSn ?? row.skc ?? row.skcCode ?? '').trim() || null,
      supplierCode: String(row.supplierCode ?? row.supplierGoodsSn ?? '').trim() || null,
      supplierSku: String(row.supplierSku ?? '').trim() || null,
      displayName: String(row.goodsName ?? row.spuName ?? row.skcName ?? '').trim() || null,
      salesQuantity: optionalCount(row.saleCnt),
      observedAt,
      sourceUpdatedAt: row.updateTime ?? null,
    }));
  }
  return Object.freeze(result);
}

export function parseTradeOverview(body, {
  storeCode,
  businessDate,
  observedAt = new Date().toISOString(),
} = {}) {
  const store = canonicalStore(storeCode);
  const date = isoDate(businessDate, 'businessDate');
  const envelope = record(body);
  const source = record(envelope.info ?? envelope.data ?? envelope);
  const sales = record(source.sales);
  const payOrder = record(source.payOrder);
  return Object.freeze({
    storeCode: store,
    businessDate: date,
    newCustomerSalesQuantity: optionalCount(sales.newUser),
    newCustomerPaymentOrderCount: optionalCount(payOrder.newUser),
    paymentOrderCount: optionalCount(payOrder.cnt),
    observedAt,
    sourceCode: 'WEBAPI_TRADE',
  });
}

export function parseRegionRows(body, {
  storeCode,
  businessDate,
  observedAt = new Date().toISOString(),
} = {}) {
  const store = canonicalStore(storeCode);
  const date = isoDate(businessDate, 'businessDate');
  const envelope = record(body);
  const source = record(envelope.info ?? envelope.data ?? envelope);
  const rows = Array.isArray(source.countryTrade)
    ? source.countryTrade
    : responseData(source.countryTrade);
  return Object.freeze(rows.map((input) => {
    const row = record(input);
    const key = String(row.key ?? row.countryCode ?? row.countryName ?? '').trim();
    const name = String(row.name ?? row.countryName ?? row.key ?? '').trim();
    if (!key || !name) return null;
    return Object.freeze({
      storeCode: store,
      businessDate: date,
      regionKey: key.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80),
      regionName: name.slice(0, 160),
      salesQuantity: optionalCount(row.saleCnt),
      salesShare: optionalRate(row.saleRate),
      newCustomerSalesQuantity: optionalCount(row.newSaleCnt),
      newCustomerSalesShare: optionalRate(row.newSaleCntRate),
      observedAt,
      sourceUpdatedAt: row.updateTime ?? null,
    });
  }).filter(Boolean));
}
