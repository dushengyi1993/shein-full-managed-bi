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
// A busy store can exceed 500 quality/return rows in a 30-day window. Keep a
// finite ceiling, but high enough that the safety bound does not become an
// artificial data-loss limit; reaching it still fails PAGING_INCOMPLETE.
export const ORDER_MANAGEMENT_MAX_PAGES = 100;
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
  if (distance + 1 > maximumDays) fail('ORDER_MANAGEMENT_WINDOW_TOO_WIDE');
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
  RETURN_APPLICATIONS_LIST: verifiedFields('return-applications', [
    'id',
    'returnTime',
    'addTime',
    'lastUpdateTime',
    'returnPlanNo',
    'state',
    'stateName',
    'returnReasonType',
    'returnReasonName',
    'returnDimensions',
    'returnDimensionsName',
    'originNo',
    'returnQuantity',
    'returnTotalAmount',
    'pricingCurrencyId',
    'currencyCode',
    'billCurrencyId',
    'billCurrencyCode',
    'returnDealType',
    'returnDealTypeName',
    'returnMode',
    'returnModeName',
    'returnGenerateQuantity',
    'returnScrappedQuantity',
    'returnVssQuantity',
    'warehouseIds',
  ]),
  RETURN_ORDERS_PAGE: verifiedFields('return-orders', [
    'id',
    'returnOrderNo',
    'returnWayType',
    'changeReturnWayType',
    'returnWayTypeName',
    'returnExpressCompanyCode',
    'returnExpressCompanyName',
    'expressNoList',
    'warehouseId',
    'warehouseName',
    'subWarehouseId',
    'subWarehouseName',
    'returnPlanNo',
    'returnOrderType',
    'returnOrderTypeName',
    'returnOrderStatus',
    'returnOrderStatusName',
    'addTime',
    'skcNameList',
    'supplierCodeList',
    'waitReturnQuantity',
    'returnQuantity',
    'returnReasonType',
    'returnReasonName',
    'returnScrapType',
    'returnScrapTypeName',
    'returnDimensions',
    'isSign',
    'signTime',
    'completeTime',
    'sellerOrderNo',
    'sellerOrderNoList',
    'sellerDeliveryNo',
    'sellerDeliveryNoList',
    'returnAmount',
    'currencyCode',
    'billCurrencyCode',
    'returnBoxNum',
    'waybillPickupTime',
    'waybillSignTime',
    'updateTime',
    'skcNum',
    'canApplyReconsider',
  ]),
  EXCEPTIONS_PAGE: verifiedFields('exceptions', [
    'id',
    'workorderNo',
    'categoryId',
    'categoryCode',
    'categoryName',
    'firstCategoryCode',
    'firstCategoryName',
    'applyType',
    'applyTypeName',
    'sceneType',
    'sceneTypeName',
    'statusValue',
    'statusName',
    'createTime',
    'externalSystem',
    'externalNo',
    'workorderType',
  ]),
  VALUE_ADDED_SERVICES_PAGE: verifiedFields('value-added-services', [
    'id',
    'orderNo',
    'subOrderNo',
    'serviceSiteId',
    'serviceSiteName',
    'purchaseNo',
    'newPurchaseNo',
    'skc',
    'multiPartFlag',
    'supplierProductNumber',
    'skcNum',
    'totalFlag',
    'totalFlagName',
    'orderState',
    'orderStateName',
    'actualTotalAmount',
    'lowValueFlag',
    'valueAddedResult',
    'defectiveQuantity',
    'qcInspectionNo',
    'orderScene',
    'returnFlag',
    'returnNo',
    'deliveryNo',
    'vendorReplenishState',
    'vendorReplenishStateName',
    'estimateIncrementAmount',
    'showFeeTag',
    'supplierSource',
    'supplierSourceName',
  ]),
  QUALITY_REPORTS_PAGE: verifiedFields('quality-reports', [
    'purchaseCode',
    'qcInspectionNo',
    'skc',
    'hasDefectiveTotal',
    'hasDefectiveTotalName',
    'inspectionTime',
    'defectiveTotalQty',
    'qcType',
    'qcTypeName',
    'orderDefectiveTotalQty',
    'orderQcResult',
    'orderQcResultName',
    'inspectionResult',
    'inspectionResultName',
  ]),
});

/**
 * Fixed page-id -> endpoint mapping for the session-backed order-management
 * pages.  Only these page ids can be fetched by the session sync / backfill.
 */
export const ORDER_MANAGEMENT_SESSION_PAGES = Object.freeze({
  'stock-records': 'STOCK_RECORDS_LIST',
  waybills: 'WAYBILLS_PAGE',
  'return-applications': 'RETURN_APPLICATIONS_LIST',
  'return-orders': 'RETURN_ORDERS_PAGE',
  exceptions: 'EXCEPTIONS_PAGE',
  'value-added-services': 'VALUE_ADDED_SERVICES_PAGE',
  'quality-reports': 'QUALITY_REPORTS_PAGE',
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
  RETURN_APPLICATIONS_LIST: Object.freeze({
    method: 'POST',
    path: '/pfmp/returnPlan/list',
    pageId: 'return-applications',
    pageKey: 'page',
    pageSizeKey: 'perPage',
    defaultPageSize: 50,
    totalPath: Object.freeze(['info', 'meta', 'count']),
    rowsPath: Object.freeze(['info', 'data']),
    bodyTemplate: Object.freeze({}),
    windowFields: Object.freeze({ start: 'returnTimeStart', end: 'returnTimeEnd' }),
    evidence: '2026-08-08 capture (QTMZdsy3688, read-only): POST /pfmp/returnPlan/list {"returnTimeStart","returnTimeEnd","page":1,"perPage":50} HTTP 200 info.meta.count=55, 50 first-page rows; sellerAddress/address/phone/contract keys excluded by the field allowlist.',
  }),
  RETURN_ORDERS_PAGE: Object.freeze({
    method: 'POST',
    path: '/pfmp/returnOrder/page',
    pageId: 'return-orders',
    pageKey: 'page',
    pageSizeKey: 'perPage',
    defaultPageSize: 50,
    totalPath: Object.freeze(['info', 'meta', 'count']),
    rowsPath: Object.freeze(['info', 'data']),
    bodyTemplate: Object.freeze({}),
    windowFields: Object.freeze({ start: 'addTimeStart', end: 'addTimeEnd' }),
    evidence: '2026-08-08 capture (QTMZdsy3688, read-only): POST /pfmp/returnOrder/page {"addTimeStart","addTimeEnd","page":1,"perPage":50} HTTP 200 info.meta.count=60, 50 first-page rows; returnAddress/warehouse contact/phone/driverName/thumb/url keys excluded by the field allowlist.',
  }),
  EXCEPTIONS_PAGE: Object.freeze({
    method: 'POST',
    path: '/pfmp/exceptionWorkorder/order/page',
    pageId: 'exceptions',
    pageKey: 'page',
    pageSizeKey: 'perPage',
    defaultPageSize: 50,
    totalPath: Object.freeze(['info', 'meta', 'count']),
    rowsPath: Object.freeze(['info', 'data']),
    bodyTemplate: Object.freeze({}),
    windowFields: null,
    evidence: '2026-08-08 capture (QTMZdsy3688, read-only): POST /pfmp/exceptionWorkorder/order/page {"page":1,"perPage":50} HTTP 200 info.meta.count=3; no date filter, full pagination once per run; sellerTitle/creator/problemDesc/resultReply/attachmentUrlList/goodsThumb keys excluded by the field allowlist.',
  }),
  VALUE_ADDED_SERVICES_PAGE: Object.freeze({
    method: 'POST',
    path: '/vssv/order/page',
    pageId: 'value-added-services',
    pageKey: 'pageNumber',
    pageSizeKey: 'pageSize',
    defaultPageSize: 50,
    totalPath: Object.freeze(['info', 'count']),
    rowsPath: Object.freeze(['info', 'list']),
    bodyTemplate: Object.freeze({}),
    windowFields: null,
    evidence: '2026-08-08 capture (QTMZdsy3688, read-only): POST /vssv/order/page {"pageNumber":1,"pageSize":50} HTTP 200 info.count=11; no date filter, full pagination once per run; img/remark/user/serviceDesc keys excluded by the field allowlist.',
  }),
  QUALITY_REPORTS_PAGE: Object.freeze({
    method: 'POST',
    path: '/gmpj/quality/qcReportNew',
    pageId: 'quality-reports',
    pageKey: 'page',
    pageSizeKey: 'perPage',
    defaultPageSize: 50,
    pageSizeValue: '50',
    totalPath: Object.freeze(['info', 'totalCount']),
    rowsPath: Object.freeze(['info', 'list']),
    bodyTemplate: Object.freeze({
      reportUrl: 1,
    }),
    windowFields: Object.freeze({ start: 'inspectionTimeStart', end: 'inspectionTimeEnd' }),
    evidence: '2026-08-08 capture (QTMZdsy3688, read-only): POST /gmpj/quality/qcReportNew {"inspectionTimeStart","inspectionTimeEnd","reportUrl":1,"page":1,"perPage":"50"} HTTP 200 info.totalCount=387, 50 first-page rows; perPage is sent as the string "50" matching the verified capture; img/report URL keys excluded by the field allowlist.',
  }),
});

/**
 * Pages whose endpoints carry no date filter.  They are captured once in
 * full per run (never once per history window) to avoid duplicate refetching.
 */
export const ORDER_MANAGEMENT_ONCE_ONLY_PAGES = Object.freeze(
  Object.entries(ORDER_MANAGEMENT_SESSION_PAGES)
    .filter(([, endpointCode]) => !ORDER_MANAGEMENT_ENDPOINTS[endpointCode]?.windowFields)
    .map(([pageId]) => pageId),
);

assertEndpointFields('STOCK_RECORDS_LIST', ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.STOCK_RECORDS_LIST.map((f) => f.name));
assertEndpointFields('WAYBILLS_PAGE', ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.WAYBILLS_PAGE.map((f) => f.name));
assertEndpointFields('RETURN_APPLICATIONS_LIST', ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.RETURN_APPLICATIONS_LIST.map((f) => f.name));
assertEndpointFields('RETURN_ORDERS_PAGE', ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.RETURN_ORDERS_PAGE.map((f) => f.name));
assertEndpointFields('EXCEPTIONS_PAGE', ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.EXCEPTIONS_PAGE.map((f) => f.name));
assertEndpointFields('VALUE_ADDED_SERVICES_PAGE', ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.VALUE_ADDED_SERVICES_PAGE.map((f) => f.name));
assertEndpointFields('QUALITY_REPORTS_PAGE', ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.QUALITY_REPORTS_PAGE.map((f) => f.name));

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
    reason: 'Verified capture {"page":1,"perPage":50} returns info.data only; the response has no total field, so the paging/total gate cannot be satisfied. The delivery-desk page is removed (realtime todo without a total contract) and this evidence stays for the research boundary only.',
  }),
  DELIVERY_DESK_GROUPS: Object.freeze({
    method: 'POST',
    path: '/pfmp/delivery/getIntelligentUnpackingResult',
    reason: 'Verified capture {"isDeliveryShipping":1} returns info.groups/undeliverableOrders without a total; the delivery-desk page is removed and cannot satisfy the total gate.',
  }),
  EXCEPTION_PROBLEMS: Object.freeze({
    method: 'POST',
    path: '/pfmp/order/exceptionProblems',
    reason: 'Only the URL was observed (fetch list and an ApiEmptyDataResponse trace); no request body and no response shape were captured, so the request cannot be safely frozen.',
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
  if (endpoint.windowFields && !window) {
    fail('ORDER_MANAGEMENT_WINDOW_REQUIRED');
  }
  if (endpoint.windowFields) {
    const bounded = orderManagementWindow({
      startDate: window.startDate,
      endDate: window.endDate,
    });
    body[endpoint.windowFields.start] = `${bounded.startDate} 00:00:00`;
    body[endpoint.windowFields.end] = `${bounded.endDate} 23:59:59`;
  }
  return Object.freeze(body);
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Final transport seal: callers may choose only the fixed endpoint code and
 * the exact generated filter/pagination body. Unknown keys, widened page
 * sizes, missing windows and statistics values outside the captured set are
 * rejected before fetch.
 */
export function assertOrderManagementTransportRequest(endpointCode, body) {
  const endpoint = ORDER_MANAGEMENT_ENDPOINTS[String(endpointCode ?? '')];
  if (!endpoint) fail('ORDER_MANAGEMENT_ENDPOINT_NOT_ALLOWED');
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('ORDER_MANAGEMENT_REQUEST_BODY_INVALID');
  }
  let window;
  if (endpoint.windowFields) {
    const startValue = body[endpoint.windowFields.start];
    const endValue = body[endpoint.windowFields.end];
    if (!/^\d{4}-\d{2}-\d{2} 00:00:00$/.test(String(startValue ?? ''))
      || !/^\d{4}-\d{2}-\d{2} 23:59:59$/.test(String(endValue ?? ''))) {
      fail('ORDER_MANAGEMENT_REQUEST_WINDOW_INVALID');
    }
    window = orderManagementWindow({
      startDate: String(startValue).slice(0, 10),
      endDate: String(endValue).slice(0, 10),
    });
  }
  const base = orderManagementRequestBody(endpointCode, { window });
  const allowedKeys = new Set(Object.keys(base));
  for (const [key, value] of Object.entries(base)) {
    if (!Object.prototype.hasOwnProperty.call(body, key) || !sameJsonValue(body[key], value)) {
      fail('ORDER_MANAGEMENT_REQUEST_BODY_INVALID');
    }
  }
  if (endpoint.pageKey) {
    allowedKeys.add(endpoint.pageKey);
    allowedKeys.add(endpoint.pageSizeKey);
    const page = body[endpoint.pageKey];
    const expectedPageSize = endpoint.pageSizeValue ?? endpoint.defaultPageSize;
    if (!Number.isSafeInteger(page) || page < 1 || page > ORDER_MANAGEMENT_MAX_PAGES
      || !sameJsonValue(body[endpoint.pageSizeKey], expectedPageSize)) {
      fail('ORDER_MANAGEMENT_REQUEST_PAGING_INVALID');
    }
  } else if (endpoint.statisticsTypes) {
    allowedKeys.add('statisticsType');
    if (!endpoint.statisticsTypes.includes(body.statisticsType)) {
      fail('ORDER_MANAGEMENT_REQUEST_STATISTICS_INVALID');
    }
  }
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    fail('ORDER_MANAGEMENT_REQUEST_BODY_INVALID');
  }
  return true;
}
