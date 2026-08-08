/**
 * Verified read-only Session HTTP contracts for the order-management index.
 *
 * Only endpoints below are callable.  Every entry was captured in the
 * research sessions of 2026-08-08 (sso.geiwohuo.com) with a frozen request
 * body and a verified response shape.  Endpoints that were observed but whose
 * request/response contract is not sufficient to safely freeze are listed in
 * ORDER_MANAGEMENT_RESEARCHED_ENDPOINTS and are deliberately NOT callable.
 */

import {
  fieldHash,
  isDeniedKeyName,
} from '../order-management/order-management-contract.mjs';

export const ORDER_MANAGEMENT_WEBAPI_ORIGIN = 'https://sso.geiwohuo.com';
export const ORDER_MANAGEMENT_WINDOW_MAX_DAYS = 30;
export const ORDER_MANAGEMENT_MAX_PAGES = 10;
export const ORDER_MANAGEMENT_TRANSPORT_LIMITS = Object.freeze({
  requestTimeoutMs: 60_000,
  maxResponseBytes: 8 * 1024 * 1024,
});

export class OrderManagementContractError extends Error {
  constructor(code) {
    super(`order-management contract refused: ${code}`);
    this.name = 'OrderManagementContractError';
    this.code = code;
  }
}

function fail(code) {
  throw new OrderManagementContractError(code);
}

function isoDate(value, location) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${location}_INVALID`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) {
    fail(`${location}_INVALID`);
  }
  return text;
}

/**
 * Bounded request windows.  The platform pages were verified with 30-day
 * windows; no window wider than ORDER_MANAGEMENT_WINDOW_MAX_DAYS is allowed.
 */
export function orderManagementWindow({
  startDate,
  endDate,
  maximumDays = ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
} = {}) {
  const start = isoDate(startDate, 'ORDER_MANAGEMENT_WINDOW_START');
  const end = isoDate(endDate, 'ORDER_MANAGEMENT_WINDOW_END');
  if (start > end) fail('ORDER_MANAGEMENT_WINDOW_INVALID');
  if (!Number.isSafeInteger(maximumDays) || maximumDays < 1 || maximumDays > 30) {
    fail('ORDER_MANAGEMENT_WINDOW_INVALID');
  }
  const distance = Math.round(
    (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`))
      / 86_400_000,
  );
  if (distance > maximumDays) fail('ORDER_MANAGEMENT_WINDOW_TOO_WIDE');
  return Object.freeze({ startDate: start, endDate: end });
}

function verifiedFields(pageId, names) {
  return Object.freeze(names.map((name) => Object.freeze({
    name,
    hash: fieldHash(name),
  })));
}

/**
 * Raw response-key allowlists for callable endpoints, verified against the
 * captured record keys of 2026-08-08.  Address-like keys (sender/receiver
 * provinces and cities), free-form notes and unverified nested structures are
 * intentionally excluded; numeric PII and address/contact keys are refused.
 */
export const ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS = Object.freeze({
  STOCK_RECORDS_LIST: verifiedFields('stock-records', [
    'id',
    'supplierCode',
    'skc',
    'orderMode',
    'orderModeValue',
    'applyStatus',
    'stockType',
    'orderSign',
    'orderNo',
    'addTime',
    'timezone',
  ]),
  WAYBILLS_PAGE: verifiedFields('waybills', [
    'id',
    'trackingNumber',
    'logisticsCompanyCode',
    'logisticsCompanyName',
    'waybillType',
    'waybillTypeSellerName',
    'orderType',
    'orderTypeName',
    'serviceModeCode',
    'serviceModeCodeName',
    'addTime',
    'pickupTime',
    'signTime',
    'packQuantity',
    'sendGoodsQuantity',
    'actualWeight',
    'volumeWeight',
    'estimatedWeight',
    'finalSettlementWeight',
    'convertedFinalApportionment',
    'exemptionAmount',
    'actualDeductionAmount',
    'changedEstimatedApportionment',
    'differenceDeductedAmount',
    'supplierCurrencyId',
    'supplierCurrencyName',
    'estimateCombineNo',
    'estimatedApportionmentBillNo',
    'combineNumber',
    'apportionmentBillNoOrHedgeBillNo',
    'supplierTitle',
    'isFree',
    'isFreeName',
    'syStatus',
    'syStatusName',
    'rightsResultType',
    'rightsResultTypeName',
    'orderSystem',
    'collectBatchNo',
    'appointmentPickupTime',
    'apportionmentState',
    'finalFormula',
  ]),
});

function assertEndpointFields(endpointCode, names) {
  for (const name of names) {
    if (isDeniedKeyName(name)) fail('ORDER_MANAGEMENT_FIELD_DENIED_PII');
  }
}

/**
 * Callable endpoints.  All are POST to sso.geiwohuo.com fixed paths with a
 * frozen body template.  Each endpoint must expose a verified total and a
 * rows path so the paging/total/dedupe gates can be enforced.
 */
export const ORDER_MANAGEMENT_ENDPOINTS = Object.freeze({
  STOCK_RECORDS_LIST: Object.freeze({
    method: 'POST',
    path: '/idms/order-apply/list',
    pageId: 'stock-records',
    pageKey: 'pageNumber',
    pageSizeKey: 'pageSize',
    defaultPageSize: 100,
    totalPath: Object.freeze(['info', 'count']),
    rowsPath: Object.freeze(['info', 'list']),
    bodyTemplate: Object.freeze({
      supplierCodes: '',
      skcs: '',
      orderNoStr: '',
      applyStatus: '',
      orderModes: [],
      orderAccount: '',
    }),
    windowFields: Object.freeze({ start: 'addTimeBegin', end: 'addTimeEnd' }),
    evidence: '2026-08-08 capture: POST /idms/order-apply/list {"pageNumber":1,"pageSize":100,...,"addTimeBegin","addTimeEnd"} HTTP 200 info.count=206, 100 first-page rows, 17 verified record keys.',
  }),
  WAYBILLS_PAGE: Object.freeze({
    method: 'POST',
    path: '/clms/waybill/page',
    pageId: 'waybills',
    pageKey: 'pageNumber',
    pageSizeKey: 'pageSize',
    defaultPageSize: 50,
    totalPath: Object.freeze(['info', 'meta', 'count']),
    rowsPath: Object.freeze(['info', 'data']),
    windowFields: Object.freeze({ start: 'addTimeStart', end: 'addTimeEnd' }),
    evidence: '2026-08-08 capture: POST /clms/waybill/page {"addTimeStart","addTimeEnd","pageNumber":1,"pageSize":50} HTTP 200 info.meta.count=376, 50 first-page rows.',
  }),
  WAYBILLS_STATISTICS: Object.freeze({
    method: 'POST',
    path: '/clms/waybill/statistics',
    pageId: 'waybills',
    statisticsTypes: Object.freeze([1, 2, 3, 4, 5, 6]),
    windowFields: Object.freeze({ start: 'addTimeStart', end: 'addTimeEnd' }),
    evidence: '2026-08-08 capture: POST /clms/waybill/statistics with statisticsType 1-6 returns page-level totals (waybills, parcels, freight amounts).',
  }),
});

assertEndpointFields('STOCK_RECORDS_LIST', ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.STOCK_RECORDS_LIST.map((f) => f.name));
assertEndpointFields('WAYBILLS_PAGE', ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.WAYBILLS_PAGE.map((f) => f.name));

/**
 * Observed-but-not-callable endpoints.  Keeping them here (with reasons)
 * documents the research boundary: no code path may ever call them.
 */
export const ORDER_MANAGEMENT_RESEARCHED_ENDPOINTS = Object.freeze({
  DELIVERY_LIST: Object.freeze({
    method: 'POST',
    path: '/pfmp/delivery/list',
    reason: 'Verified capture exists, but the page is materialized from the OpenAPI fact database instead; raw responses also contain address/phone keys that must never enter the index.',
  }),
  DELIVERY_DESK_ORDERS: Object.freeze({
    method: 'POST',
    path: '/pfmp/delivery/shippingOrderList',
    reason: 'Verified capture {"page":1,"perPage":50} returns info.data only; the response has no total field, so the paging/total gate cannot be satisfied.',
  }),
  DELIVERY_DESK_GROUPS: Object.freeze({
    method: 'POST',
    path: '/pfmp/delivery/getIntelligentUnpackingResult',
    reason: 'Verified capture {"isDeliveryShipping":1} returns info.groups/undeliverableOrders without a total; the delivery-desk page cannot satisfy the total gate.',
  }),
  EXCEPTION_PROBLEMS: Object.freeze({
    method: 'POST',
    path: '/pfmp/order/exceptionProblems',
    reason: 'Only the URL was observed (fetch list and an ApiEmptyDataResponse trace); no request body and no response shape were captured, so the request cannot be safely frozen.',
  }),
  RETURN_PLAN_LIST: Object.freeze({
    method: null,
    path: null,
    reason: 'No API evidence captured for #/pfmp/return-management/return-plan-list; DOM only.',
  }),
  RETURN_ORDER_LIST: Object.freeze({
    method: null,
    path: null,
    reason: 'No API evidence captured for #/pfmp/return-management/return-order-list; DOM only.',
  }),
  VALUE_ADDED_SERVICES: Object.freeze({
    method: null,
    path: null,
    reason: 'No API evidence captured for #/vssv/order-management; DOM only.',
  }),
  INSPECTION_REPORT: Object.freeze({
    method: null,
    path: null,
    reason: 'No API evidence captured for #/gmp-unity/inspection-report; DOM only.',
  }),
});

export function orderManagementEndpointUrl(endpointCode) {
  const endpoint = ORDER_MANAGEMENT_ENDPOINTS[String(endpointCode ?? '')];
  if (!endpoint) fail('ORDER_MANAGEMENT_ENDPOINT_NOT_ALLOWED');
  if (!endpoint.path || !endpoint.path.startsWith('/')) fail('ORDER_MANAGEMENT_ENDPOINT_NOT_ALLOWED');
  return `${ORDER_MANAGEMENT_WEBAPI_ORIGIN}${endpoint.path}`;
}

/**
 * Frozen request body for a callable endpoint and window.
 */
export function orderManagementRequestBody(endpointCode, { window } = {}) {
  const endpoint = ORDER_MANAGEMENT_ENDPOINTS[String(endpointCode ?? '')];
  if (!endpoint) fail('ORDER_MANAGEMENT_ENDPOINT_NOT_ALLOWED');
  if (endpoint.method !== 'POST') fail('ORDER_MANAGEMENT_METHOD_NOT_ALLOWED');
  const body = {
    ...(endpoint.bodyTemplate ?? {}),
  };
  if (endpoint.windowFields && window) {
    const bounded = orderManagementWindow({
      startDate: window.startDate,
      endDate: window.endDate,
    });
    body[endpoint.windowFields.start] = `${bounded.startDate} 00:00:00`;
    body[endpoint.windowFields.end] = `${bounded.endDate} 23:59:59`;
  }
  return Object.freeze(body);
}
