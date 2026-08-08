#!/usr/bin/env node

import process from 'node:process';

import {
  FULL_MANAGED_STORE_CODES,
  normalizeFullManagedStoreCode,
} from '../src/config/full-managed-stores.mjs';
import {
  assertAllowlistedFieldName,
  pickFieldsByAllowlist,
  scrubPiiText,
  validateOrderManagementRow,
} from '../src/order-management/order-management-contract.mjs';
import { createEncryptedWebApiSessionStoreFromEnvironment } from '../src/webapi-session/encrypted-session-store.mjs';
import {
  ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS,
  ORDER_MANAGEMENT_ENDPOINTS,
  ORDER_MANAGEMENT_MAX_PAGES,
  ORDER_MANAGEMENT_ONCE_ONLY_PAGES,
  ORDER_MANAGEMENT_SESSION_PAGES,
  ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
  orderManagementRequestBody,
  orderManagementWindow,
} from '../src/webapi-history/order-management-contracts.mjs';
import {
  createOrderManagementHttpTransport,
  openOrderManagementHttpSession,
  orderManagementResponseReader,
} from '../src/webapi-session/order-management-http.mjs';
import { atomicWriteJson } from '../src/warehouse/dashboard-materializer.mjs';

const ROSTER = new Set(FULL_MANAGED_STORE_CODES);

/**
 * Strict YYYY-MM-DD calendar-date parse.  Returns the normalized text or
 * null so callers can fail closed with their own error codes.
 */
export function parseStrictIsoDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) return null;
  return text;
}

/**
 * The calendar date (YYYY-MM-DD) in Asia/Shanghai for an instant.  The
 * "future window" gate is defined against this calendar so it stays stable
 * no matter which timezone the host runs in.
 */
export function shanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).formatToParts(now);
  const field = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

export function parseArgs(argv, { now = new Date() } = {}) {
  const result = {
    stores: [],
    output: process.env.FULL_BI_ORDER_MANAGEMENT_SESSION_SNAPSHOT ?? null,
    windowDays: ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
    startDate: null,
    endDate: null,
    execute: false,
  };
  let windowDaysProvided = false;
  for (const token of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) throw new Error('ORDER_MANAGEMENT_SYNC_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'execute' && value === undefined) result.execute = true;
    else if (name === 'stores' && value) {
      result.stores = [...new Set(value.split(',').map((item) => item.trim().toUpperCase()))];
    } else if (name === 'output' && value) result.output = value;
    else if (name === 'start-date' && value) result.startDate = value;
    else if (name === 'end-date' && value) result.endDate = value;
    else if (name === 'window-days' && /^[1-9]$|^[12][0-9]$|^30$/.test(value ?? '')) {
      result.windowDays = Number(value);
      windowDaysProvided = true;
    } else throw new Error('ORDER_MANAGEMENT_SYNC_ARGUMENT_INVALID');
  }
  if (
    result.stores.length === 0
    || result.stores.some((store) => !normalizeFullManagedStoreCode(store))
  ) {
    throw new Error('ORDER_MANAGEMENT_SYNC_STORE_SCOPE_REQUIRED');
  }
  const rosterCovered = FULL_MANAGED_STORE_CODES.every((store) => result.stores.includes(store))
    && result.stores.every((store) => ROSTER.has(store));
  if (!rosterCovered) {
    throw new Error('ORDER_MANAGEMENT_SYNC_STORE_SCOPE_REQUIRED');
  }
  const hasStart = result.startDate !== null;
  const hasEnd = result.endDate !== null;
  if (hasStart !== hasEnd) throw new Error('ORDER_MANAGEMENT_SYNC_WINDOW_PAIR_REQUIRED');
  if (hasStart && windowDaysProvided) throw new Error('ORDER_MANAGEMENT_SYNC_WINDOW_CONFLICT');
  if (hasStart) {
    const start = parseStrictIsoDate(result.startDate);
    const end = parseStrictIsoDate(result.endDate);
    if (!start || !end || start > end) throw new Error('ORDER_MANAGEMENT_SYNC_WINDOW_INVALID');
    try {
      orderManagementWindow({
        startDate: start,
        endDate: end,
        maximumDays: ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
      });
    } catch {
      throw new Error('ORDER_MANAGEMENT_SYNC_WINDOW_INVALID');
    }
    if (end > shanghaiDate(now)) throw new Error('ORDER_MANAGEMENT_SYNC_WINDOW_FUTURE');
    result.startDate = start;
    result.endDate = end;
  }
  return result;
}

export function buildWindow({ days = ORDER_MANAGEMENT_WINDOW_MAX_DAYS, now = new Date() } = {}) {
  const end = new Date(now.getTime());
  const start = new Date(now.getTime());
  start.setDate(start.getDate() - (days - 1));
  const isoDate = (date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  return orderManagementWindow({
    startDate: isoDate(start),
    endDate: isoDate(end),
    maximumDays: days,
  });
}

function parseShanghaiDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return null;
  const date = new Date(`${text.replace(' ', 'T')}+08:00`);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

/**
 * Accepts the platform's two observed timestamp spellings: Shanghai
 * "YYYY-MM-DD HH:mm:ss" and ISO-8601 instants.  Returns null for anything
 * that is not a valid instant so the row stays honest about unknown times.
 */
function parseInstant(value) {
  const shanghai = parseShanghaiDateTime(value);
  if (shanghai !== null) return shanghai;
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

/**
 * Join a scalar or scalar-array platform value with a pipe.  Arrays with
 * non-scalar members are dropped item by item; the result is null when
 * nothing usable remains.  The PII scrub still applies to the joined text.
 */
function joinList(value) {
  if (value === null || value === undefined || value === '') return null;
  const items = (Array.isArray(value) ? value : [value])
    .map((item) => (typeof item === 'string' || typeof item === 'number' ? String(item).trim() : ''))
    .filter(Boolean);
  return items.length > 0 ? items.join('|') : null;
}

function toNumber(value, { nonNegative = true } = {}) {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (nonNegative && parsed < 0) return null;
  return parsed;
}

function metricEntry(pageId, name, value, options) {
  assertAllowlistedFieldName(pageId, name);
  return Object.freeze({ name, value: toNumber(value, options) });
}

function factEntry(pageId, name, value) {
  assertAllowlistedFieldName(pageId, name);
  const text = scrubPiiText(value);
  if (text === null) return null;
  return Object.freeze({ name, value: text.slice(0, 512) });
}

function deriveWaybillStatus(waybill) {
  if (waybill.signTime) return Object.freeze({ code: 'SIGNED', name: '已签收' });
  if (waybill.pickupTime) return Object.freeze({ code: 'IN_TRANSIT', name: '运输中' });
  return Object.freeze({ code: 'PENDING_PICKUP', name: '待取件' });
}

function buildStockRecordRow(record, storeCode, fetchedAt) {
  const orderNo = String(record.orderNo ?? '').trim();
  if (!orderNo) return null;
  return Object.freeze({
    id: orderNo,
    storeCode,
    statusCode: String(record.applyStatus ?? '').trim() || null,
    statusName: null,
    createdAt: parseShanghaiDateTime(record.addTime),
    updatedAt: fetchedAt,
    primary: orderNo,
    secondary: String(record.orderModeValue ?? record.orderMode ?? '').trim() || null,
    tags: Object.freeze(['备货记录', record.stockType, record.orderSign].filter(Boolean)),
    metrics: Object.freeze([]),
    facts: Object.freeze([
      factEntry('stock-records', 'supplierCode', record.supplierCode),
      factEntry('stock-records', 'skc', record.skc),
      factEntry('stock-records', 'orderMode', record.orderMode),
      factEntry('stock-records', 'orderModeValue', record.orderModeValue),
      factEntry('stock-records', 'applyStatus', record.applyStatus),
      factEntry('stock-records', 'stockType', record.stockType),
      factEntry('stock-records', 'orderSign', record.orderSign),
      factEntry('stock-records', 'timezone', record.timezone),
      factEntry('stock-records', 'addTime', record.addTime),
    ].filter(Boolean)),
    details: Object.freeze([]),
  });
}

function buildWaybillRow(record, storeCode, fetchedAt) {
  const trackingNumber = String(record.trackingNumber ?? '').trim();
  if (!trackingNumber) return null;
  const status = deriveWaybillStatus(record);
  return Object.freeze({
    id: trackingNumber,
    storeCode,
    statusCode: status.code,
    statusName: status.name,
    createdAt: parseShanghaiDateTime(record.addTime),
    updatedAt: fetchedAt,
    primary: trackingNumber,
    secondary: String(record.combineNumber ?? '').trim() || null,
    tags: Object.freeze(['运单', record.waybillTypeSellerName, record.orderSystem, record.isFreeName].filter(Boolean)),
    metrics: Object.freeze([
      metricEntry('waybills', 'packQuantity', record.packQuantity),
      metricEntry('waybills', 'sendGoodsQuantity', record.sendGoodsQuantity),
      metricEntry('waybills', 'actualWeight', record.actualWeight),
      metricEntry('waybills', 'volumeWeight', record.volumeWeight),
      metricEntry('waybills', 'estimatedWeight', record.estimatedWeight),
      metricEntry('waybills', 'finalSettlementWeight', record.finalSettlementWeight),
      metricEntry('waybills', 'convertedFinalApportionment', record.convertedFinalApportionment),
      metricEntry('waybills', 'exemptionAmount', record.exemptionAmount),
      metricEntry('waybills', 'actualDeductionAmount', record.actualDeductionAmount),
      metricEntry('waybills', 'changedEstimatedApportionment', record.changedEstimatedApportionment),
      metricEntry('waybills', 'differenceDeductedAmount', record.differenceDeductedAmount),
    ].filter((entry) => entry.value !== null)),
    facts: Object.freeze([
      factEntry('waybills', 'logisticsCompanyName', record.logisticsCompanyName),
      factEntry('waybills', 'waybillTypeSellerName', record.waybillTypeSellerName),
      factEntry('waybills', 'orderTypeName', record.orderTypeName),
      factEntry('waybills', 'serviceModeCodeName', record.serviceModeCodeName),
      factEntry('waybills', 'supplierCurrencyName', record.supplierCurrencyName),
      factEntry('waybills', 'collectBatchNo', record.collectBatchNo),
      factEntry('waybills', 'apportionmentState', record.apportionmentState),
      factEntry('waybills', 'supplierTitle', record.supplierTitle),
      factEntry('waybills', 'rightsResultTypeName', record.rightsResultTypeName),
      factEntry('waybills', 'syStatusName', record.syStatusName),
    ].filter(Boolean)),
    details: Object.freeze([]),
  });
}

function buildReturnApplicationRow(record, storeCode, fetchedAt) {
  const returnPlanNo = String(record.returnPlanNo ?? '').trim();
  if (!returnPlanNo) return null;
  return Object.freeze({
    id: returnPlanNo,
    storeCode,
    statusCode: String(record.state ?? '').trim() || null,
    statusName: String(record.stateName ?? '').trim() || null,
    createdAt: parseInstant(record.returnTime) ?? parseInstant(record.addTime),
    updatedAt: fetchedAt,
    primary: returnPlanNo,
    secondary: String(record.originNo ?? record.returnReasonName ?? '').trim() || null,
    tags: Object.freeze(['退货申请', record.returnDealTypeName, record.returnModeName].filter(Boolean)),
    metrics: Object.freeze([
      metricEntry('return-applications', 'returnQuantity', record.returnQuantity),
      metricEntry('return-applications', 'returnGenerateQuantity', record.returnGenerateQuantity),
      metricEntry('return-applications', 'returnScrappedQuantity', record.returnScrappedQuantity),
      metricEntry('return-applications', 'returnVssQuantity', record.returnVssQuantity),
      metricEntry('return-applications', 'returnTotalAmount', record.returnTotalAmount),
    ].filter((entry) => entry.value !== null)),
    facts: Object.freeze([
      factEntry('return-applications', 'returnPlanNo', record.returnPlanNo),
      factEntry('return-applications', 'returnReasonType', record.returnReasonType),
      factEntry('return-applications', 'returnReasonName', record.returnReasonName),
      factEntry('return-applications', 'returnDimensions', record.returnDimensions),
      factEntry('return-applications', 'returnDimensionsName', record.returnDimensionsName),
      factEntry('return-applications', 'originNo', record.originNo),
      factEntry('return-applications', 'state', record.state),
      factEntry('return-applications', 'stateName', record.stateName),
      factEntry('return-applications', 'returnDealType', record.returnDealType),
      factEntry('return-applications', 'returnDealTypeName', record.returnDealTypeName),
      factEntry('return-applications', 'returnMode', record.returnMode),
      factEntry('return-applications', 'returnModeName', record.returnModeName),
      factEntry('return-applications', 'pricingCurrencyId', record.pricingCurrencyId),
      factEntry('return-applications', 'currencyCode', record.currencyCode),
      factEntry('return-applications', 'billCurrencyId', record.billCurrencyId),
      factEntry('return-applications', 'billCurrencyCode', record.billCurrencyCode),
      factEntry('return-applications', 'warehouseIds', joinList(record.warehouseIds)),
      factEntry('return-applications', 'returnTime', record.returnTime),
      factEntry('return-applications', 'addTime', record.addTime),
      factEntry('return-applications', 'lastUpdateTime', record.lastUpdateTime),
    ].filter(Boolean)),
    details: Object.freeze([]),
  });
}

function buildReturnOrderRow(record, storeCode, fetchedAt) {
  const returnOrderNo = String(record.returnOrderNo ?? '').trim();
  if (!returnOrderNo) return null;
  return Object.freeze({
    id: returnOrderNo,
    storeCode,
    statusCode: String(record.returnOrderStatus ?? '').trim() || null,
    statusName: String(record.returnOrderStatusName ?? '').trim() || null,
    createdAt: parseInstant(record.addTime),
    updatedAt: fetchedAt,
    primary: returnOrderNo,
    secondary: String(record.returnPlanNo ?? '').trim() || null,
    tags: Object.freeze(['退货单', record.returnOrderTypeName, record.returnWayTypeName].filter(Boolean)),
    metrics: Object.freeze([
      metricEntry('return-orders', 'waitReturnQuantity', record.waitReturnQuantity),
      metricEntry('return-orders', 'returnQuantity', record.returnQuantity),
      metricEntry('return-orders', 'returnAmount', record.returnAmount),
      metricEntry('return-orders', 'returnBoxNum', record.returnBoxNum),
      metricEntry('return-orders', 'skcNum', record.skcNum),
    ].filter((entry) => entry.value !== null)),
    facts: Object.freeze([
      factEntry('return-orders', 'returnPlanNo', record.returnPlanNo),
      factEntry('return-orders', 'returnOrderType', record.returnOrderType),
      factEntry('return-orders', 'returnOrderTypeName', record.returnOrderTypeName),
      factEntry('return-orders', 'returnOrderStatus', record.returnOrderStatus),
      factEntry('return-orders', 'returnOrderStatusName', record.returnOrderStatusName),
      factEntry('return-orders', 'returnWayType', record.returnWayType),
      factEntry('return-orders', 'changeReturnWayType', record.changeReturnWayType),
      factEntry('return-orders', 'returnWayTypeName', record.returnWayTypeName),
      factEntry('return-orders', 'returnExpressCompanyCode', record.returnExpressCompanyCode),
      factEntry('return-orders', 'returnExpressCompanyName', record.returnExpressCompanyName),
      factEntry('return-orders', 'expressNoList', joinList(record.expressNoList)),
      factEntry('return-orders', 'warehouseId', record.warehouseId),
      factEntry('return-orders', 'warehouseName', record.warehouseName),
      factEntry('return-orders', 'subWarehouseId', record.subWarehouseId),
      factEntry('return-orders', 'subWarehouseName', record.subWarehouseName),
      factEntry('return-orders', 'skcNameList', joinList(record.skcNameList)),
      factEntry('return-orders', 'supplierCodeList', joinList(record.supplierCodeList)),
      factEntry('return-orders', 'returnReasonType', record.returnReasonType),
      factEntry('return-orders', 'returnReasonName', record.returnReasonName),
      factEntry('return-orders', 'returnScrapType', record.returnScrapType),
      factEntry('return-orders', 'returnScrapTypeName', record.returnScrapTypeName),
      factEntry('return-orders', 'returnDimensions', record.returnDimensions),
      factEntry('return-orders', 'isSign', record.isSign),
      factEntry('return-orders', 'sellerOrderNo', joinList(record.sellerOrderNo)),
      factEntry('return-orders', 'sellerOrderNoList', joinList(record.sellerOrderNoList)),
      factEntry('return-orders', 'sellerDeliveryNo', joinList(record.sellerDeliveryNo)),
      factEntry('return-orders', 'sellerDeliveryNoList', joinList(record.sellerDeliveryNoList)),
      factEntry('return-orders', 'currencyCode', record.currencyCode),
      factEntry('return-orders', 'billCurrencyCode', record.billCurrencyCode),
      factEntry('return-orders', 'canApplyReconsider', record.canApplyReconsider),
      factEntry('return-orders', 'signTime', record.signTime),
      factEntry('return-orders', 'completeTime', record.completeTime),
      factEntry('return-orders', 'waybillPickupTime', record.waybillPickupTime),
      factEntry('return-orders', 'waybillSignTime', record.waybillSignTime),
      factEntry('return-orders', 'updateTime', record.updateTime),
      factEntry('return-orders', 'addTime', record.addTime),
    ].filter(Boolean)),
    details: Object.freeze([]),
  });
}

function buildExceptionRow(record, storeCode, fetchedAt) {
  const workorderNo = String(record.workorderNo ?? '').trim();
  if (!workorderNo) return null;
  return Object.freeze({
    id: workorderNo,
    storeCode,
    statusCode: String(record.statusValue ?? '').trim() || null,
    statusName: String(record.statusName ?? '').trim() || null,
    createdAt: parseInstant(record.createTime),
    updatedAt: fetchedAt,
    primary: workorderNo,
    secondary: String(record.externalNo ?? record.categoryName ?? '').trim() || null,
    tags: Object.freeze(['收货/退货异常', record.categoryName, record.sceneTypeName].filter(Boolean)),
    metrics: Object.freeze([]),
    facts: Object.freeze([
      factEntry('exceptions', 'categoryId', record.categoryId),
      factEntry('exceptions', 'categoryCode', record.categoryCode),
      factEntry('exceptions', 'categoryName', record.categoryName),
      factEntry('exceptions', 'firstCategoryCode', record.firstCategoryCode),
      factEntry('exceptions', 'firstCategoryName', record.firstCategoryName),
      factEntry('exceptions', 'applyType', record.applyType),
      factEntry('exceptions', 'applyTypeName', record.applyTypeName),
      factEntry('exceptions', 'sceneType', record.sceneType),
      factEntry('exceptions', 'sceneTypeName', record.sceneTypeName),
      factEntry('exceptions', 'statusValue', record.statusValue),
      factEntry('exceptions', 'statusName', record.statusName),
      factEntry('exceptions', 'externalSystem', record.externalSystem),
      factEntry('exceptions', 'externalNo', record.externalNo),
      factEntry('exceptions', 'workorderType', record.workorderType),
      factEntry('exceptions', 'createTime', record.createTime),
    ].filter(Boolean)),
    details: Object.freeze([]),
  });
}

function buildValueAddedServiceRow(record, storeCode, fetchedAt) {
  const orderNo = String(record.orderNo ?? '').trim();
  if (!orderNo) return null;
  const rowId = String(record.id ?? record.subOrderNo ?? orderNo).trim();
  if (!rowId) return null;
  return Object.freeze({
    id: rowId,
    storeCode,
    statusCode: String(record.orderState ?? '').trim() || null,
    statusName: String(record.orderStateName ?? '').trim() || null,
    createdAt: null,
    updatedAt: fetchedAt,
    primary: orderNo,
    secondary: String(record.subOrderNo ?? record.purchaseNo ?? '').trim() || null,
    tags: Object.freeze(['增值服务', record.totalFlagName, record.vendorReplenishStateName].filter(Boolean)),
    metrics: Object.freeze([
      metricEntry('value-added-services', 'actualTotalAmount', record.actualTotalAmount),
      metricEntry('value-added-services', 'estimateIncrementAmount', record.estimateIncrementAmount),
      metricEntry('value-added-services', 'defectiveQuantity', record.defectiveQuantity),
      metricEntry('value-added-services', 'skcNum', record.skcNum),
    ].filter((entry) => entry.value !== null)),
    facts: Object.freeze([
      factEntry('value-added-services', 'subOrderNo', record.subOrderNo),
      factEntry('value-added-services', 'serviceSiteId', record.serviceSiteId),
      factEntry('value-added-services', 'serviceSiteName', record.serviceSiteName),
      factEntry('value-added-services', 'purchaseNo', record.purchaseNo),
      factEntry('value-added-services', 'newPurchaseNo', record.newPurchaseNo),
      factEntry('value-added-services', 'skc', record.skc),
      factEntry('value-added-services', 'multiPartFlag', record.multiPartFlag),
      factEntry('value-added-services', 'supplierProductNumber', record.supplierProductNumber),
      factEntry('value-added-services', 'totalFlag', record.totalFlag),
      factEntry('value-added-services', 'totalFlagName', record.totalFlagName),
      factEntry('value-added-services', 'orderState', record.orderState),
      factEntry('value-added-services', 'orderStateName', record.orderStateName),
      factEntry('value-added-services', 'lowValueFlag', record.lowValueFlag),
      factEntry('value-added-services', 'valueAddedResult', record.valueAddedResult),
      factEntry('value-added-services', 'qcInspectionNo', record.qcInspectionNo),
      factEntry('value-added-services', 'orderScene', record.orderScene),
      factEntry('value-added-services', 'returnFlag', record.returnFlag),
      factEntry('value-added-services', 'returnNo', record.returnNo),
      factEntry('value-added-services', 'deliveryNo', record.deliveryNo),
      factEntry('value-added-services', 'vendorReplenishState', record.vendorReplenishState),
      factEntry('value-added-services', 'vendorReplenishStateName', record.vendorReplenishStateName),
      factEntry('value-added-services', 'showFeeTag', record.showFeeTag),
      factEntry('value-added-services', 'supplierSource', record.supplierSource),
      factEntry('value-added-services', 'supplierSourceName', record.supplierSourceName),
    ].filter(Boolean)),
    details: Object.freeze([]),
  });
}

function buildQualityReportRow(record, storeCode, fetchedAt) {
  const qcInspectionNo = String(record.qcInspectionNo ?? '').trim();
  if (!qcInspectionNo) return null;
  return Object.freeze({
    id: qcInspectionNo,
    storeCode,
    statusCode: String(record.inspectionResult ?? '').trim() || null,
    statusName: String(record.inspectionResultName ?? '').trim() || null,
    createdAt: parseInstant(record.inspectionTime),
    updatedAt: fetchedAt,
    primary: qcInspectionNo,
    secondary: String(record.purchaseCode ?? '').trim() || null,
    tags: Object.freeze(['质检报告', record.qcTypeName, record.hasDefectiveTotalName].filter(Boolean)),
    metrics: Object.freeze([
      metricEntry('quality-reports', 'defectiveTotalQty', record.defectiveTotalQty),
      metricEntry('quality-reports', 'orderDefectiveTotalQty', record.orderDefectiveTotalQty),
    ].filter((entry) => entry.value !== null)),
    facts: Object.freeze([
      factEntry('quality-reports', 'purchaseCode', record.purchaseCode),
      factEntry('quality-reports', 'skc', record.skc),
      factEntry('quality-reports', 'qcType', record.qcType),
      factEntry('quality-reports', 'qcTypeName', record.qcTypeName),
      factEntry('quality-reports', 'orderQcResult', record.orderQcResult),
      factEntry('quality-reports', 'orderQcResultName', record.orderQcResultName),
      factEntry('quality-reports', 'inspectionResult', record.inspectionResult),
      factEntry('quality-reports', 'inspectionResultName', record.inspectionResultName),
      factEntry('quality-reports', 'hasDefectiveTotal', record.hasDefectiveTotal),
      factEntry('quality-reports', 'hasDefectiveTotalName', record.hasDefectiveTotalName),
      factEntry('quality-reports', 'inspectionTime', record.inspectionTime),
    ].filter(Boolean)),
    details: Object.freeze([]),
  });
}

const PAGE_ROW_BUILDERS = Object.freeze({
  'stock-records': buildStockRecordRow,
  waybills: buildWaybillRow,
  'return-applications': buildReturnApplicationRow,
  'return-orders': buildReturnOrderRow,
  exceptions: buildExceptionRow,
  'value-added-services': buildValueAddedServiceRow,
  'quality-reports': buildQualityReportRow,
});

async function fetchPageRows(transport, endpointCode, { window, maxPages }) {
  const endpoint = ORDER_MANAGEMENT_ENDPOINTS[endpointCode];
  if (endpoint.windowFields && !window) {
    throw new TypeError(`ORDER_MANAGEMENT_WINDOW_REQUIRED: ${endpointCode}`);
  }
  const failures = [];
  const rows = [];
  let total = null;
  let pagesFetched = 0;
  let lastPageLength = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const body = Object.freeze({
      ...orderManagementRequestBody(endpointCode, { window }),
      [endpoint.pageKey]: page,
      [endpoint.pageSizeKey]: endpoint.pageSizeValue ?? endpoint.defaultPageSize,
    });
    let response;
    try {
      response = await transport.fetch(endpointCode, body);
    } catch (error) {
      failures.push(`PAGE_${page}_FETCH_FAILED:${String(error?.code ?? error?.message ?? 'UNKNOWN')}`);
      break;
    }
    const reader = orderManagementResponseReader(endpointCode, response);
    if (reader.total === null) {
      failures.push(`PAGE_${page}_TOTAL_MISSING`);
      break;
    }
    if (!Array.isArray(reader.rows)) {
      failures.push(`PAGE_${page}_ROWS_PATH_MISSING`);
      break;
    }
    if (total === null) total = reader.total;
    else {
      // PFMP return pages expose the full total on page 1 but may expose the
      // remaining count (or current-page count) on later pages. Page 1 stays
      // authoritative and the final exact rows===total gate proves coverage.
      const offset = (page - 1) * endpoint.defaultPageSize;
      const remaining = Math.max(total - offset, 0);
      const acceptedTotals = new Set([total, remaining, reader.rows.length]);
      if (!acceptedTotals.has(reader.total)) {
        failures.push(`PAGE_${page}_TOTAL_DRIFT`);
        break;
      }
    }
    rows.push(...reader.rows);
    pagesFetched += 1;
    lastPageLength = reader.rows.length;
    if (reader.rows.length < endpoint.defaultPageSize) break;
  }
  const reachedTotal = total !== null && rows.length >= total;
  const naturalEnd = pagesFetched > 0 && lastPageLength < endpoint.defaultPageSize;
  if (pagesFetched === 0 || (!naturalEnd && !reachedTotal)) {
    failures.push('PAGING_INCOMPLETE');
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    total,
    pagesFetched,
    failures: Object.freeze(failures),
  });
}

function storePageGates(fetched, built) {
  const ids = built.rows
    .map((row) => row.id)
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value));
  const dedupeVerified = new Set(ids).size === ids.length;
  const totalVerified = fetched.total !== null
    && fetched.rows.length === fetched.total
    && built.rows.length === fetched.total;
  const pagingVerified = fetched.pagesFetched > 0 && fetched.failures.length === 0;
  // Every fetched raw record must produce a row (the allowlist must carry the
  // row id key) and a positive total must yield at least one row.  This keeps
  // a drifted allowlist or an empty capture from publishing an empty page.
  const contentVerified = built.dropped === 0
    && (fetched.total === 0 || built.rows.length > 0);
  const ok = totalVerified && pagingVerified && dedupeVerified && contentVerified;
  return Object.freeze({
    ok,
    totalVerified,
    pagingVerified,
    dedupeVerified,
    contentVerified,
  });
}

function buildRowsForPage(pageId, records, storeCode, fetchedAt) {
  const allowlist = endpointAllowlistFor(pageId);
  const builder = PAGE_ROW_BUILDERS[pageId];
  const rows = [];
  let dropped = 0;
  for (const record of records) {
    const picked = pickFieldsByAllowlist(allowlist, record);
    const row = builder(picked, storeCode, fetchedAt);
    if (row === null) {
      dropped += 1;
      continue;
    }
    const check = validateOrderManagementRow(row, { pageId });
    if (!check.ok) {
      throw new TypeError(`ORDER_MANAGEMENT_SYNC_ROW_INVALID ${storeCode}: ${check.errors[0]}`);
    }
    rows.push(row);
  }
  return Object.freeze({ rows: Object.freeze(rows), dropped });
}

async function syncOneStore(transport, storeCode, {
  window,
  maxPages,
  pageIds,
  includeStatistics = true,
  fetchedAt,
}) {
  const pages = {};
  for (const pageId of pageIds) {
    const endpointCode = ORDER_MANAGEMENT_SESSION_PAGES[pageId];
    const endpoint = ORDER_MANAGEMENT_ENDPOINTS[endpointCode];
    const pageWindow = endpoint.windowFields ? window : null;
    const fetched = await fetchPageRows(transport, endpointCode, { window: pageWindow, maxPages });
    const built = buildRowsForPage(pageId, fetched.rows, storeCode, fetchedAt);
    pages[pageId] = Object.freeze({
      rows: built.rows,
      dropped: built.dropped,
      total: fetched.total,
      pagesFetched: fetched.pagesFetched,
      failures: fetched.failures,
      gates: storePageGates(fetched, built),
    });
  }
  const statistics = [];
  if (includeStatistics && pageIds.includes('waybills')) {
    for (const statisticsType of ORDER_MANAGEMENT_ENDPOINTS.WAYBILLS_STATISTICS.statisticsTypes) {
      const body = Object.freeze({
        ...orderManagementRequestBody('WAYBILLS_STATISTICS', { window }),
        statisticsType,
      });
      try {
        const response = await transport.fetch('WAYBILLS_STATISTICS', body);
        const value = response?.body?.info;
        statistics.push(Object.freeze({
          statisticsType,
          value: typeof value === 'string' || typeof value === 'number' ? value : null,
        }));
      } catch (error) {
        statistics.push(Object.freeze({
          statisticsType,
          value: null,
          errorCode: String(error?.code ?? error?.message ?? 'STATISTICS_FETCH_FAILED'),
        }));
      }
    }
  }
  return Object.freeze({
    pages: Object.freeze(pages),
    statistics: Object.freeze(statistics),
  });
}

function endpointAllowlistFor(pageId) {
  const endpointCode = ORDER_MANAGEMENT_SESSION_PAGES[String(pageId ?? '')];
  const allowlist = ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS[endpointCode];
  if (!allowlist) throw new TypeError(`ORDER_MANAGEMENT_SYNC_PAGE_UNKNOWN: ${pageId}`);
  return allowlist;
}

/**
 * Deterministic page-id scope for one session sync run.  Unknown page ids,
 * duplicates and an empty scope are refused before any session opens.
 */
export function normalizeSessionPageScope(pageIds) {
  const input = Array.isArray(pageIds) ? pageIds : [pageIds];
  if (input.length === 0) throw new TypeError('ORDER_MANAGEMENT_SYNC_PAGE_SCOPE_REQUIRED');
  const known = new Set(Object.keys(ORDER_MANAGEMENT_SESSION_PAGES));
  const deduped = [...new Set(input.map((value) => String(value ?? '').trim()).filter(Boolean))];
  if (deduped.length === 0 || deduped.some((pageId) => !known.has(pageId))) {
    throw new TypeError('ORDER_MANAGEMENT_SYNC_PAGE_UNKNOWN');
  }
  return Object.freeze(deduped);
}

export async function runOrderManagementSessionSync({
  storeCodes,
  output,
  windowDays = ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
  window = undefined,
  pageIds = Object.keys(ORDER_MANAGEMENT_SESSION_PAGES),
  includeStatistics = true,
  storeConcurrency = 1,
  sessionStore,
  openSession = ({ storeCode }) => openOrderManagementHttpSession({ storeCode, sessionStore }),
  now = new Date(),
  maxPages = ORDER_MANAGEMENT_MAX_PAGES,
} = {}) {
  if (!Number.isSafeInteger(storeConcurrency) || storeConcurrency < 1 || storeConcurrency > 5) {
    throw new TypeError('ORDER_MANAGEMENT_SYNC_CONCURRENCY_INVALID');
  }
  const scopedPageIds = normalizeSessionPageScope(pageIds);
  const onceOnlyPages = new Set(ORDER_MANAGEMENT_ONCE_ONLY_PAGES);
  const hasWindowedPage = scopedPageIds.some((pageId) => !onceOnlyPages.has(pageId));
  if (window === null && hasWindowedPage) {
    throw new TypeError('ORDER_MANAGEMENT_SYNC_WINDOW_REQUIRED_FOR_WINDOWED_PAGES');
  }
  const roster = [...FULL_MANAGED_STORE_CODES];
  const boundedWindow = window === undefined
    ? buildWindow({ days: windowDays, now })
    : window === null
      ? null
      : orderManagementWindow({
          startDate: window.startDate,
          endDate: window.endDate,
          maximumDays: windowDays,
        });
  if (boundedWindow && boundedWindow.endDate > shanghaiDate(now)) {
    throw new Error('ORDER_MANAGEMENT_SYNC_WINDOW_FUTURE');
  }
  const perStore = [];
  const rawByStore = new Map();
  async function syncStore(storeCode) {
    const session = await openSession({ storeCode });
    const transport = createOrderManagementHttpTransport({ session });
    try {
      const result = await syncOneStore(transport, storeCode, {
        window: boundedWindow,
        maxPages,
        pageIds: scopedPageIds,
        includeStatistics,
        fetchedAt: now.toISOString(),
      });
      return Object.freeze({
        storeCode,
        result,
      });
    } finally {
      await transport.close();
    }
  }
  for (let offset = 0; offset < storeCodes.length; offset += storeConcurrency) {
    const batch = storeCodes.slice(offset, offset + storeConcurrency);
    const completed = await Promise.all(batch.map(syncStore));
    // Promise.all preserves the input order, so evidence stays deterministic
    // even though stores inside a bounded batch run concurrently.
    for (const { storeCode, result } of completed) {
      rawByStore.set(storeCode, result.pages);
      perStore.push(Object.freeze({
        storeCode,
        ok: scopedPageIds.every((pageId) => result.pages[pageId].gates.ok),
        pages: Object.freeze(Object.fromEntries(
          scopedPageIds.map((pageId) => [pageId, result.pages[pageId].gates]),
        )),
        statistics: result.statistics,
      }));
    }
  }

  const fetchedAt = now.toISOString();
  const pages = {};
  for (const pageId of scopedPageIds) {
    const endpointCode = ORDER_MANAGEMENT_SESSION_PAGES[pageId];
    const okStores = perStore
      .filter((entry) => entry.pages[pageId].ok)
      .map((entry) => entry.storeCode)
      .sort();
    const gates = {
      totalVerified: okStores.length === roster.length
        && okStores.every((store) => perStore.find((entry) => entry.storeCode === store).pages[pageId].totalVerified),
      pagingVerified: okStores.length === roster.length
        && okStores.every((store) => perStore.find((entry) => entry.storeCode === store).pages[pageId].pagingVerified),
      dedupeVerified: okStores.length === roster.length
        && okStores.every((store) => perStore.find((entry) => entry.storeCode === store).pages[pageId].dedupeVerified),
      contentVerified: okStores.length === roster.length
        && okStores.every((store) => perStore.find((entry) => entry.storeCode === store).pages[pageId].contentVerified),
      storeCount: okStores.length,
    };
    const failedStores = perStore
      .filter((entry) => !entry.pages[pageId].ok)
      .map((entry) => `${entry.storeCode}:GATE_FAILED`);
    const rows = okStores.flatMap((storeCode) => rawByStore.get(storeCode)[pageId].rows);
    const status = okStores.length === roster.length
      && gates.totalVerified && gates.pagingVerified && gates.dedupeVerified && gates.contentVerified
      ? 'AVAILABLE'
      : okStores.length === 0
        ? 'UNAVAILABLE'
        : 'PARTIAL';
    pages[pageId] = Object.freeze({
      status,
      source: 'SESSION_HTTP',
      latestSourceFetchedAt: fetchedAt,
      reason: status === 'AVAILABLE'
        ? null
        : `SESSION_GATE_FAILED: ${failedStores.join('; ') || 'NO_STORE_SUCCEEDED'} (endpoint ${endpointCode})`,
      storeCodes: Object.freeze(okStores),
      gates: Object.freeze(gates),
      rows: Object.freeze(rows),
    });
  }

  const snapshot = Object.freeze({
    schemaVersion: 1,
    updatedAt: fetchedAt,
    roster: Object.freeze(roster),
    window: boundedWindow ? Object.freeze(boundedWindow) : null,
    pages: Object.freeze(pages),
    evidence: Object.freeze({
      perStore: Object.freeze(perStore),
    }),
  });
  const written = await atomicWriteJson(output, snapshot);
  return Object.freeze({ snapshot, written });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.execute) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'DRY_RUN',
      stores: [...FULL_MANAGED_STORE_CODES],
      windowDays: args.windowDays,
      window: args.startDate
        ? { startDate: args.startDate, endDate: args.endDate }
        : buildWindow({ days: args.windowDays }),
      maxPages: ORDER_MANAGEMENT_MAX_PAGES,
      pageIds: Object.keys(ORDER_MANAGEMENT_SESSION_PAGES),
      endpoints: Object.keys(ORDER_MANAGEMENT_ENDPOINTS),
      output: args.output,
    }, null, 2));
    return;
  }
  if (!args.output) throw new Error('ORDER_MANAGEMENT_SYNC_OUTPUT_REQUIRED');
  const sessionStore = await createEncryptedWebApiSessionStoreFromEnvironment();
  const result = await runOrderManagementSessionSync({
    storeCodes: args.stores,
    output: args.output,
    windowDays: args.windowDays,
    window: args.startDate ? { startDate: args.startDate, endDate: args.endDate } : undefined,
    sessionStore,
  });
  console.log(JSON.stringify({
    ok: true,
    output: result.written,
    updatedAt: result.snapshot.updatedAt,
    pages: Object.fromEntries(
      Object.entries(result.snapshot.pages).map(([pageId, page]) => [
        pageId,
        { status: page.status, rows: page.rows.length, gates: page.gates, reason: page.reason },
      ]),
    ),
  }, null, 2));
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/sync_full_managed_order_management_sessions.mjs')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Order-management session sync failed.');
    process.exitCode = 1;
  });
}
