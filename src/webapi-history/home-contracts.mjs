import crypto from 'node:crypto';
import { normalizeFullManagedStoreCode } from '../config/full-managed-stores.mjs';

export const HOME_WEBAPI_ORIGIN = 'https://sso.geiwohuo.com';
export const HOME_HISTORY_EARLIEST_DATE = '2023-06-07';
export const HOME_HISTORY_MAX_WINDOW_DAYS = 90;
export const HOME_HISTORY_CONTRACT_VERSION = 4;

export const HOME_ENDPOINTS = Object.freeze({
  UPDATE_TIME: Object.freeze({
    method: 'POST',
    path: '/sbn/common/get_update_time',
  }),
  STORE_DAILY_HISTORY: Object.freeze({
    method: 'POST',
    path: '/sbn/index/get_critical_indicator_curve_chart',
  }),
  STORE_REALTIME: Object.freeze({
    method: 'POST',
    path: '/sbn/index/getRealTimeIndicatorCurveChart',
  }),
  STORE_REALTIME_SUMMARY: Object.freeze({
    method: 'POST',
    path: '/sbn/index/getRealTimeIndicator',
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
  PRODUCT_DIAGNOSE_LIST: Object.freeze({
    method: 'POST',
    path: '/sbn/new_goods/get_diagnose_list',
  }),
  LEDGER_DAILY: Object.freeze({
    method: 'POST',
    path: '/mils/report/date/list',
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

export function buildIndexUpdateTimeRequest() {
  return Object.freeze({
    pageCode: 'Index',
    areaCd: 'cn',
  });
}

export function buildRealtimeUpdateTimeRequest() {
  return Object.freeze({
    pageCode: 'IndexRealTime',
    areaCd: 'cn',
  });
}

export function buildTradeOverviewRequest(input = {}) {
  const common = commonRequest(input);
  const startDt = common.startDate.replaceAll('-', '');
  const endDt = common.endDate.replaceAll('-', '');
  return Object.freeze({
    areaCd: common.areaCd,
    dt: common.dt,
    countrySite: common.countrySite,
    startDt,
    endDt,
    dtFlag: 1,
  });
}

export function buildRegionRankRequest(input = {}) {
  const common = commonRequest(input);
  const startDt = common.startDate.replaceAll('-', '');
  const endDt = common.endDate.replaceAll('-', '');
  return Object.freeze({
    areaCd: common.areaCd,
    dt: common.dt,
    countrySite: common.countrySite,
    startDt,
    endDt,
    statType: 2,
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

/**
 * Current first-party SPU detail contract used by
 * `/sbn/merchandise/details`.
 *
 * Unlike the retired analyse/model_dimension flow, this endpoint is paginated
 * and returns one aggregate row per SPU for the requested range. The history
 * loader deliberately requests one business day at a time so the persisted
 * grain remains store × day × SPU.
 */
export function buildProductDiagnoseListRequest({
  businessDate,
  observedDate,
  pageNum = 1,
  pageSize = 200,
} = {}) {
  const date = isoDate(businessDate, 'businessDate');
  const anchor = isoDate(observedDate ?? date, 'observedDate').replaceAll('-', '');
  if (!Number.isSafeInteger(pageNum) || pageNum < 1 || pageNum > 100_000) {
    fail('HOME_PAGE_INVALID', 'pageNum is invalid');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    fail('HOME_PAGE_SIZE_INVALID', 'pageSize is invalid');
  }
  const compactDate = date.replaceAll('-', '');
  return Object.freeze({
    areaCd: 'cn',
    dt: anchor,
    countrySite: ['shein-all'],
    startDate: compactDate,
    endDate: compactDate,
    pageNum,
    pageSize,
    groupType: 'total',
    orderList: 'c1dSaleCnt',
    orderType: 'desc',
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

export function buildLedgerDailyRequest({
  startDate,
  endDate,
  pageNumber = 1,
  pageSize = 200,
} = {}) {
  const start = isoDate(startDate, 'startDate');
  const end = isoDate(endDate, 'endDate');
  if (start > end || dateDistanceDays(start, end) > HOME_HISTORY_MAX_WINDOW_DAYS) {
    fail('HOME_LEDGER_RANGE_INVALID', 'ledger window exceeds the reviewed 90-day limit');
  }
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 100_000) {
    fail('HOME_PAGE_INVALID', 'pageNumber is invalid');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    fail('HOME_PAGE_SIZE_INVALID', 'pageSize is invalid');
  }
  return Object.freeze({
    reportDateStart: start,
    reportDateEnd: end,
    pageNumber,
    pageSize,
  });
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

export function parseIndexUpdateTime(body) {
  const envelope = record(body);
  const info = record(envelope.info ?? envelope.data ?? envelope);
  const compactDate = String(info.dt ?? '').trim();
  if (!/^\d{8}$/.test(compactDate)) {
    fail('HOME_UPDATE_TIME_INVALID', 'index update date is invalid');
  }
  const dataAnchorDate = isoDate(
    `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6)}`,
    'index update date',
  );
  if (String(info.areaCd ?? '').toLowerCase() !== 'cn') {
    fail('HOME_UPDATE_TIME_INVALID', 'index update timezone is invalid');
  }
  return Object.freeze({
    dataAnchorDate,
    sourceUpdatedAt: String(info.updateTime ?? '').trim() || null,
  });
}

export function parseRealtimeUpdateTime(body) {
  const envelope = record(body);
  const info = record(envelope.info ?? envelope.data ?? envelope);
  const compactHour = String(info.dt ?? '').trim();
  if (!/^\d{10}$/.test(compactHour)) {
    fail('HOME_REALTIME_UPDATE_TIME_INVALID', 'realtime update hour is invalid');
  }
  const businessDate = isoDate(
    `${compactHour.slice(0, 4)}-${compactHour.slice(4, 6)}-${compactHour.slice(6, 8)}`,
    'realtime update date',
  );
  const hour = Number(compactHour.slice(8, 10));
  if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23) {
    fail('HOME_REALTIME_UPDATE_TIME_INVALID', 'realtime update hour is invalid');
  }
  if (String(info.areaCd ?? '').toLowerCase() !== 'cn') {
    fail('HOME_REALTIME_UPDATE_TIME_INVALID', 'realtime update timezone is invalid');
  }
  const hourText = String(hour).padStart(2, '0');
  return Object.freeze({
    businessDate,
    startHour: `${compactHour.slice(0, 8)}00`,
    endHour: compactHour,
    // The official page labels the data-through hour (`dt`) as 更新时间.
    // Keep it distinct from the endpoint refresh timestamp (`updateTime`).
    sourceUpdatedAt: `${businessDate}T${hourText}:00:00+08:00`,
    providerRefreshedAt: String(info.updateTime ?? '').trim() || null,
  });
}

export function parseRealtimeStoreSummary(body, {
  storeCode,
  businessDate,
  sourceUpdatedAt = null,
  observedAt = new Date().toISOString(),
} = {}) {
  const store = canonicalStore(storeCode);
  const date = isoDate(businessDate, 'businessDate');
  const envelope = record(body);
  const row = record(envelope.info ?? envelope.data ?? envelope);
  return Object.freeze({
    storeCode: store,
    businessDate: date,
    currency: typeof row.currency === 'string' && /^[A-Za-z]{3}$/.test(row.currency)
      ? row.currency.toUpperCase()
      : null,
    dealAmount: optionalDecimal(row.dealAmtH),
    netDealAmount: optionalDecimal(row.netDealAmtH),
    salesQuantity: optionalCount(row.saleCntH),
    buyerCount: optionalCount(row.buyerCntH),
    goodsDetailVisitors: optionalCount(row.shopGoodsUvH),
    stockingOrderCount: optionalCount(row.bhOrdCntH),
    urgentPurchaseOrderCount: optionalCount(row.jcOrdCntH),
    sourceUpdatedAt,
    observedAt,
    sourceCode: 'WEBAPI_REALTIME',
  });
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
      displayName: String(
        row.goodsName ?? row.spuName ?? row.skcName ?? '',
      ).trim().slice(0, 240) || null,
      salesQuantity: optionalCount(row.saleCnt),
      observedAt,
      sourceUpdatedAt: row.updateTime ?? null,
    }));
  }
  return Object.freeze(result);
}

export function parseProductDiagnosePage(body, {
  storeCode,
  businessDate,
  observedAt = new Date().toISOString(),
} = {}) {
  const store = canonicalStore(storeCode);
  const date = isoDate(businessDate, 'businessDate');
  const envelope = record(body);
  const info = record(envelope.info ?? envelope.data ?? envelope);
  const sourceRows = Array.isArray(info.data) ? info.data : [];
  const count = optionalCount(record(info.meta).count);
  if (count === null || sourceRows.length > count) {
    fail('HOME_PRODUCT_RESPONSE_INVALID', 'product diagnose page count is invalid');
  }
  const orderedQuantities = sourceRows.map((input) => (
    optionalCount(record(input).c1dSaleCnt)
  ));
  if (orderedQuantities.some((value) => value === null)) {
    fail('HOME_PRODUCT_SALES_UNAVAILABLE', 'product sales quantity is unavailable');
  }
  if (orderedQuantities.some((value, index) => (
    index > 0 && orderedQuantities[index - 1] < value
  ))) {
    fail('HOME_PRODUCT_SORT_INVALID', 'product sales response is not descending');
  }
  const parsedRows = [];
  let rejectedRowCount = 0;
  for (const [index, input] of sourceRows.entries()) {
    const row = record(input);
    const productKey = String(row.spu ?? row.spuCode ?? '').trim();
    const salesQuantity = orderedQuantities[index];
    if (!productKey || productKey === 'undefined') {
      rejectedRowCount += 1;
      continue;
    }
    // The official list contains the full catalogue, including zero-sale
    // products. Persist only positive sale facts; zero-sale dates remain
    // provable through the successful fetch audit without multiplying the
    // warehouse by hundreds of catalogue rows per store and day.
    if (salesQuantity <= 0) continue;
    parsedRows.push(Object.freeze({
      storeCode: store,
      businessDate: date,
      productGrain: 'SPU',
      productKey: productKey.slice(0, 160),
      platformSpuId: productKey.slice(0, 160),
      platformSkcId: null,
      supplierCode: null,
      supplierSku: null,
      displayName: String(
        row.goodsName ?? row.goodsNameEn ?? '',
      ).trim().slice(0, 240) || null,
      salesQuantity,
      observedAt,
      sourceUpdatedAt: null,
    }));
  }
  const lastSourceRow = sourceRows.at(-1);
  return Object.freeze({
    count,
    sourceRowCount: sourceRows.length,
    rejectedRowCount,
    lastSalesQuantity: lastSourceRow ? optionalCount(lastSourceRow.c1dSaleCnt) : null,
    rows: Object.freeze(parsedRows),
  });
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

function ledgerPage(body) {
  const envelope = record(body);
  const info = record(envelope.info ?? envelope.data ?? envelope);
  const data = record(info.data);
  const list = Array.isArray(data.list) ? data.list : [];
  const count = optionalCount(data.count);
  if (count === null || list.length > count) {
    fail('HOME_LEDGER_RESPONSE_INVALID', 'ledger page count is invalid');
  }
  return { count, list, containAmount: optionalCount(info.containAmount) };
}

export function parseLedgerDailyRows(body, {
  storeCode,
  observedAt = new Date().toISOString(),
} = {}) {
  const store = canonicalStore(storeCode);
  const page = ledgerPage(body);
  const fieldMap = Object.freeze({
    beginBalanceCount: 'beginBalanceCnt',
    inboundCount: 'inCnt',
    outboundCount: 'outCnt',
    endBalanceCount: 'endBalanceCnt',
    urgentOrderEntryCount: 'urgentOrderEntryCnt',
    prepareOrderEntryCount: 'prepareOrderEntryCnt',
    inboundGainCount: 'inGainCnt',
    inboundReturnCount: 'inReturnCnt',
    supplyChangeInCount: 'supplyChangeInCnt',
    adjustmentInCount: 'adjustInCnt',
    customerOutboundCount: 'totalCustomerCnt',
    directCustomerOutboundCount: 'customerCnt',
    platformCustomerOutboundCount: 'platformCustomerCnt',
    outboundLossCount: 'outLossCnt',
    supplierOutboundCount: 'outSupplierCnt',
    inventoryClearCount: 'inventoryClearCnt',
    reportClearCount: 'reportClearCnt',
    scrapCount: 'scrapCnt',
    supplyChangeOutCount: 'supplyChangeOutCnt',
    adjustmentOutCount: 'adjustOutCnt',
    customerLossCount: 'customerLoseCnt',
  });
  const amountMap = Object.freeze({
    beginBalanceAmount: 'beginBalanceAmount',
    inboundAmount: 'inAmount',
    outboundAmount: 'outAmount',
    endBalanceAmount: 'endBalanceAmount',
    urgentOrderEntryAmount: 'urgentOrderEntryAmount',
    prepareOrderEntryAmount: 'prepareOrderEntryAmount',
    inboundGainAmount: 'inGainAmount',
    inboundReturnAmount: 'inReturnAmount',
    supplyChangeInAmount: 'inSupplyChangeAmount',
    adjustmentInAmount: 'adjustInAmount',
    customerOutboundAmount: 'totalCustomerAmount',
    directCustomerOutboundAmount: 'customerAmount',
    platformCustomerOutboundAmount: 'platformCustomerAmount',
    outboundLossAmount: 'outLossAmount',
    supplierOutboundAmount: 'outSupplierAmount',
    inventoryClearAmount: 'inventoryClearAmount',
    reportClearAmount: 'reportClearAmount',
    scrapAmount: 'scrapAmount',
    supplyChangeOutAmount: 'outSupplyChangeAmount',
    adjustmentOutAmount: 'adjustOutAmount',
    customerLossAmount: 'customerLoseAmount',
  });
  const rows = page.list.map((input) => {
    const row = record(input);
    const businessDate = dateFromRow(row);
    if (!businessDate) {
      fail('HOME_LEDGER_RESPONSE_INVALID', 'ledger reportDate is invalid');
    }
    const output = {
      storeCode: store,
      businessDate,
      currency: typeof row.currency === 'string' && /^[A-Za-z]{3}$/.test(row.currency)
        ? row.currency.toUpperCase()
        : null,
      observedAt,
      sourceCode: 'WEBAPI_LEDGER',
    };
    for (const [target, source] of Object.entries(fieldMap)) {
      output[target] = optionalCount(row[source]);
    }
    for (const [target, source] of Object.entries(amountMap)) {
      output[target] = page.containAmount === 0 ? null : optionalDecimal(row[source]);
    }
    return Object.freeze(output);
  });
  return Object.freeze({
    count: page.count,
    rows: Object.freeze(rows),
  });
}
