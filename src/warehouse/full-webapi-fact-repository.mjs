import crypto from 'node:crypto';

import {
  containsNumericPii,
  containsSensitiveText,
  isDeniedKeyName,
  scrubPiiText,
} from '../order-management/order-management-contract.mjs';
import {
  ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS,
} from '../webapi-history/order-management-contracts.mjs';
import { FULL_MANAGED_STORE_CODES } from '../config/full-managed-stores.mjs';

/**
 * Full-managed v4 WebAPI fact repository.
 *
 * Owns the control plane (collection runs, attempts, page evidence, coverage,
 * capability observations) and the seven typed order WebAPI fact observation
 * tables. Every write transaction:
 *   1. BEGIN + SET LOCAL ROLE sheinfm_webapi_loader (least privilege),
 *   2. reuses existing rows only when they are byte-identical exact replays,
 *      otherwise fails closed (V4_*_REPLAY_DRIFT),
 *   3. rejects sensitive keys and values before any SQL is built, echoing only
 *      sanitized error codes,
 *   4. performs an exact count + payload-hash readback after writing.
 *
 * This module never reads or writes the semi-managed schemas, never touches
 * timers, schedulers or package scripts, and never stores a raw identifier,
 * address, contact, phone, buyer, free text or attachment URL.
 */

export const V4_CONTRACT_VERSION = 1;
export const V4_RETRY_POLICY = 'NONE';

export const V4_RUN_STATUSES = Object.freeze([
  'PLANNED',
  'PREFLIGHT_PASSED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'ABORTED',
]);

export const V4_TERMINAL_RUN_STATUSES = Object.freeze([
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'ABORTED',
]);

export const V4_ATTEMPT_STATUSES = Object.freeze([
  'PLANNED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'BLOCKED',
  'UNKNOWN',
]);

export const V4_CAPABILITY_STATUSES = Object.freeze([
  'VERIFIED',
  'UNVERIFIED',
  'UNSUPPORTED',
  'BLOCKED',
  'UNAVAILABLE',
  'UNKNOWN',
]);

/**
 * Frozen one-window work-item manifest: the 7 ORDER_MANAGEMENT_SESSION_PAGES
 * endpoint codes in canonical contract order, then the six distinct
 * WAYBILLS_STATISTICS_<type> codes.  Exactly 13 unique codes; the order is
 * contractual and must match the database roster enforced in 0028 and the
 * runner plan (v4-collection-plan.mjs).  Do not sort or rename.
 */
export const V4_REQUIRED_WORK_ITEM_CODES = Object.freeze([
  'STOCK_RECORDS_LIST',
  'WAYBILLS_PAGE',
  'RETURN_APPLICATIONS_LIST',
  'RETURN_ORDERS_PAGE',
  'EXCEPTIONS_PAGE',
  'VALUE_ADDED_SERVICES_PAGE',
  'QUALITY_REPORTS_PAGE',
  'WAYBILLS_STATISTICS_1',
  'WAYBILLS_STATISTICS_2',
  'WAYBILLS_STATISTICS_3',
  'WAYBILLS_STATISTICS_4',
  'WAYBILLS_STATISTICS_5',
  'WAYBILLS_STATISTICS_6',
]);

if (V4_REQUIRED_WORK_ITEM_CODES.length !== 13
  || new Set(V4_REQUIRED_WORK_ITEM_CODES).size !== V4_REQUIRED_WORK_ITEM_CODES.length) {
  throw new Error('V4_REQUIRED_WORK_ITEM_CODES must contain exactly 13 unique codes');
}

/**
 * Application-layer sensitive-key deny list on top of the shared
 * order-management deny list: credential-shaped keys and buyer/address/driver
 * identifiers are refused before any payload is built.
 */
const V4_KEY_DENIED_PATTERN =
  /cookie|token|secret|password|authorization|credential|\bcsrf\b|api[\s_-]*key|buyername|returnaddress|drivername/i;

const STORE_CODE_PATTERN = /^[A-Z]{2}[0-9]{4}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const ENDPOINT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,60}$/;
const CAPABILITY_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,60}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,80}$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

const HASH_DOMAINS = Object.freeze({
  entity: 'full-managed.v4.entity:',
  version: 'full-managed.v4.version:',
  payload: 'full-managed.v4.payload:',
  attempt: 'full-managed.v4.attempt:',
  page: 'full-managed.v4.page:',
  capability: 'full-managed.v4.capability:',
  pagePayload: 'full-managed.v4.page-payload:',
});

export class V4CollectionError extends Error {
  constructor(code, message = '') {
    super(message || `full-webapi fact repository refused: ${code}`);
    this.name = 'V4CollectionError';
    this.code = code;
  }
}

function fail(code, message = '') {
  throw new V4CollectionError(code, message);
}

function sha256Hex(domain, value) {
  return crypto.createHash('sha256')
    .update(domain)
    .update(String(value))
    .digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function requireHex64(value, code) {
  if (typeof value !== 'string' || !HEX64_PATTERN.test(value)) fail(code);
  return value;
}

function requireStoreCode(value) {
  if (typeof value !== 'string' || !STORE_CODE_PATTERN.test(value)) {
    fail('V4_STORE_CODE_INVALID');
  }
  return value;
}

function requireEndpointCode(value) {
  if (typeof value !== 'string' || !ENDPOINT_CODE_PATTERN.test(value)) {
    fail('V4_ENDPOINT_CODE_INVALID');
  }
  return value;
}

function requireWindow(start, end) {
  if (start === null && end === null) return [null, null];
  if (typeof start !== 'string' || typeof end !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    fail('V4_WINDOW_INVALID');
  }
  if (start > end) fail('V4_WINDOW_INVALID');
  const span = Math.round(
    (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`))
      / 86_400_000,
  );
  if (span > 30) fail('V4_WINDOW_TOO_WIDE');
  return [start, end];
}

function isoInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function sameDateValue(stored, expected) {
  if (stored === null || stored === undefined) return expected === null;
  if (expected === null) return false;
  const iso = isoInstant(stored);
  return iso !== null && iso.slice(0, 10) === expected;
}

/**
 * Value-level PII rejection. Sensitive values are refused with a sanitized
 * code; the raw value is never echoed and never persisted.
 */
function rejectSensitiveValue(value) {
  const text = String(value ?? '');
  if (containsNumericPii(text) || containsSensitiveText(text)) {
    fail('V4_PII_VALUE_REJECTED');
  }
}

/**
 * Typed column specs for the seven verified pages. Only fields present in the
 * 2026-08-08 endpoint allowlists are mapped; identifiers are hashed, values
 * are typed, and everything else is refused.
 */
const PAGE_SPECS = Object.freeze({
  'stock-records': Object.freeze({
    table: 'fact.full_webapi_stock_record_observation',
    endpointCode: 'STOCK_RECORDS_LIST',
    entityField: 'id',
    sourceUpdatedField: 'addTime',
    columns: Object.freeze([
      { source: 'orderNo', column: 'order_no_hash', type: 'hash' },
      { source: 'supplierCode', column: 'supplier_code', type: 'text', max: 64 },
      { source: 'skc', column: 'skc', type: 'text', max: 64 },
      { source: 'orderMode', column: 'order_mode', type: 'int' },
      { source: 'orderModeValue', column: 'order_mode_value', type: 'text', max: 120 },
      { source: 'applyStatus', column: 'apply_status', type: 'int' },
      { source: 'stockType', column: 'stock_type', type: 'int' },
      { source: 'orderSign', column: 'order_sign', type: 'text', max: 120 },
      { source: 'addTime', column: 'add_time', type: 'instant' },
      { source: 'timezone', column: 'timezone', type: 'text', max: 32 },
    ]),
  }),
  waybills: Object.freeze({
    table: 'fact.full_webapi_waybill_observation',
    endpointCode: 'WAYBILLS_PAGE',
    entityField: 'trackingNumber',
    sourceUpdatedField: 'signTime',
    columns: Object.freeze([
      { source: 'collectBatchNo', column: 'collect_batch_no_hash', type: 'hash' },
      { source: 'estimateCombineNo', column: 'estimate_combine_no_hash', type: 'hash' },
      { source: 'estimatedApportionmentBillNo', column: 'estimated_apportionment_bill_no_hash', type: 'hash' },
      { source: 'combineNumber', column: 'combine_number_hash', type: 'hash' },
      { source: 'apportionmentBillNoOrHedgeBillNo', column: 'apportionment_bill_no_hash', type: 'hash' },
      { source: 'logisticsCompanyCode', column: 'logistics_company_code', type: 'text', max: 64 },
      { source: 'logisticsCompanyName', column: 'logistics_company_name', type: 'text', max: 160 },
      { source: 'waybillType', column: 'waybill_type', type: 'int' },
      { source: 'waybillTypeSellerName', column: 'waybill_type_seller_name', type: 'text', max: 120 },
      { source: 'orderType', column: 'order_type', type: 'int' },
      { source: 'orderTypeName', column: 'order_type_name', type: 'text', max: 120 },
      { source: 'serviceModeCode', column: 'service_mode_code', type: 'int' },
      { source: 'serviceModeCodeName', column: 'service_mode_code_name', type: 'text', max: 120 },
      { source: 'addTime', column: 'add_time', type: 'instant' },
      { source: 'pickupTime', column: 'pickup_time', type: 'instant' },
      { source: 'signTime', column: 'sign_time', type: 'instant' },
      { source: 'appointmentPickupTime', column: 'appointment_pickup_time', type: 'instant' },
      { source: 'packQuantity', column: 'pack_quantity', type: 'int' },
      { source: 'sendGoodsQuantity', column: 'send_goods_quantity', type: 'int' },
      { source: 'actualWeight', column: 'actual_weight', type: 'numeric' },
      { source: 'volumeWeight', column: 'volume_weight', type: 'numeric' },
      { source: 'estimatedWeight', column: 'estimated_weight', type: 'numeric' },
      { source: 'finalSettlementWeight', column: 'final_settlement_weight', type: 'numeric' },
      { source: 'convertedFinalApportionment', column: 'converted_final_apportionment', type: 'numeric' },
      { source: 'exemptionAmount', column: 'exemption_amount', type: 'numeric' },
      { source: 'actualDeductionAmount', column: 'actual_deduction_amount', type: 'numeric' },
      { source: 'changedEstimatedApportionment', column: 'changed_estimated_apportionment', type: 'numeric' },
      { source: 'differenceDeductedAmount', column: 'difference_deducted_amount', type: 'numeric' },
      { source: 'supplierCurrencyId', column: 'supplier_currency_id', type: 'int' },
      { source: 'supplierCurrencyName', column: 'supplier_currency_name', type: 'text', max: 64 },
      { source: 'isFree', column: 'is_free', type: 'flag' },
      { source: 'isFreeName', column: 'is_free_name', type: 'text', max: 120 },
      { source: 'syStatus', column: 'sy_status', type: 'int' },
      { source: 'syStatusName', column: 'sy_status_name', type: 'text', max: 120 },
      { source: 'rightsResultType', column: 'rights_result_type', type: 'int' },
      { source: 'rightsResultTypeName', column: 'rights_result_type_name', type: 'text', max: 120 },
      { source: 'orderSystem', column: 'order_system', type: 'int' },
      { source: 'apportionmentState', column: 'apportionment_state', type: 'int' },
    ]),
  }),
  'return-applications': Object.freeze({
    table: 'fact.full_webapi_return_application_observation',
    endpointCode: 'RETURN_APPLICATIONS_LIST',
    entityField: 'id',
    sourceUpdatedField: 'lastUpdateTime',
    columns: Object.freeze([
      { source: 'returnPlanNo', column: 'return_plan_no_hash', type: 'hash' },
      { source: 'originNo', column: 'origin_no_hash', type: 'hash' },
      { source: 'returnTime', column: 'return_time', type: 'instant' },
      { source: 'addTime', column: 'add_time', type: 'instant' },
      { source: 'lastUpdateTime', column: 'last_update_time', type: 'instant' },
      { source: 'state', column: 'state', type: 'int' },
      { source: 'stateName', column: 'state_name', type: 'text', max: 120 },
      { source: 'returnReasonType', column: 'return_reason_type', type: 'int' },
      { source: 'returnReasonName', column: 'return_reason_name', type: 'text', max: 160 },
      { source: 'returnDimensions', column: 'return_dimensions', type: 'int' },
      { source: 'returnDimensionsName', column: 'return_dimensions_name', type: 'text', max: 120 },
      { source: 'returnQuantity', column: 'return_quantity', type: 'int' },
      { source: 'returnTotalAmount', column: 'return_total_amount', type: 'numeric' },
      { source: 'pricingCurrencyId', column: 'pricing_currency_id', type: 'int' },
      { source: 'currencyCode', column: 'currency_code', type: 'char3' },
      { source: 'billCurrencyId', column: 'bill_currency_id', type: 'int' },
      { source: 'billCurrencyCode', column: 'bill_currency_code', type: 'char3' },
      { source: 'returnDealType', column: 'return_deal_type', type: 'int' },
      { source: 'returnDealTypeName', column: 'return_deal_type_name', type: 'text', max: 120 },
      { source: 'returnMode', column: 'return_mode', type: 'int' },
      { source: 'returnModeName', column: 'return_mode_name', type: 'text', max: 120 },
      { source: 'returnGenerateQuantity', column: 'return_generate_quantity', type: 'int' },
      { source: 'returnScrappedQuantity', column: 'return_scrapped_quantity', type: 'int' },
      { source: 'returnVssQuantity', column: 'return_vss_quantity', type: 'int' },
    ]),
  }),
  'return-orders': Object.freeze({
    table: 'fact.full_webapi_return_order_observation',
    endpointCode: 'RETURN_ORDERS_PAGE',
    entityField: 'returnOrderNo',
    sourceUpdatedField: 'updateTime',
    columns: Object.freeze([
      { source: 'returnPlanNo', column: 'return_plan_no_hash', type: 'hash' },
      { source: 'sellerOrderNo', column: 'seller_order_no_hash', type: 'hash' },
      { source: 'sellerDeliveryNo', column: 'seller_delivery_no_hash', type: 'hash' },
      { source: 'returnWayType', column: 'return_way_type', type: 'int' },
      { source: 'changeReturnWayType', column: 'change_return_way_type', type: 'int' },
      { source: 'returnWayTypeName', column: 'return_way_type_name', type: 'text', max: 120 },
      { source: 'returnExpressCompanyCode', column: 'return_express_company_code', type: 'text', max: 64 },
      { source: 'returnExpressCompanyName', column: 'return_express_company_name', type: 'text', max: 160 },
      { source: 'warehouseId', column: 'warehouse_id', type: 'int' },
      { source: 'warehouseName', column: 'warehouse_name', type: 'text', max: 160 },
      { source: 'subWarehouseId', column: 'sub_warehouse_id', type: 'int' },
      { source: 'subWarehouseName', column: 'sub_warehouse_name', type: 'text', max: 160 },
      { source: 'returnOrderType', column: 'return_order_type', type: 'int' },
      { source: 'returnOrderTypeName', column: 'return_order_type_name', type: 'text', max: 120 },
      { source: 'returnOrderStatus', column: 'return_order_status', type: 'int' },
      { source: 'returnOrderStatusName', column: 'return_order_status_name', type: 'text', max: 120 },
      { source: 'addTime', column: 'add_time', type: 'instant' },
      { source: 'signTime', column: 'sign_time', type: 'instant' },
      { source: 'completeTime', column: 'complete_time', type: 'instant' },
      { source: 'waybillPickupTime', column: 'waybill_pickup_time', type: 'instant' },
      { source: 'waybillSignTime', column: 'waybill_sign_time', type: 'instant' },
      { source: 'updateTime', column: 'update_time', type: 'instant' },
      { source: 'waitReturnQuantity', column: 'wait_return_quantity', type: 'int' },
      { source: 'returnQuantity', column: 'return_quantity', type: 'int' },
      { source: 'returnBoxNum', column: 'return_box_num', type: 'int' },
      { source: 'skcNum', column: 'skc_num', type: 'int' },
      { source: 'returnReasonType', column: 'return_reason_type', type: 'int' },
      { source: 'returnReasonName', column: 'return_reason_name', type: 'text', max: 160 },
      { source: 'returnScrapType', column: 'return_scrap_type', type: 'int' },
      { source: 'returnScrapTypeName', column: 'return_scrap_type_name', type: 'text', max: 120 },
      { source: 'returnDimensions', column: 'return_dimensions', type: 'int' },
      { source: 'isSign', column: 'is_sign', type: 'flag' },
      { source: 'canApplyReconsider', column: 'can_apply_reconsider', type: 'flag' },
      { source: 'returnAmount', column: 'return_amount', type: 'numeric' },
      { source: 'currencyCode', column: 'currency_code', type: 'char3' },
      { source: 'billCurrencyCode', column: 'bill_currency_code', type: 'char3' },
    ]),
  }),
  exceptions: Object.freeze({
    table: 'fact.full_webapi_exception_observation',
    endpointCode: 'EXCEPTIONS_PAGE',
    entityField: 'workorderNo',
    sourceUpdatedField: 'createTime',
    columns: Object.freeze([
      { source: 'externalNo', column: 'external_no_hash', type: 'hash' },
      { source: 'categoryId', column: 'category_id', type: 'int' },
      { source: 'categoryCode', column: 'category_code', type: 'text', max: 64 },
      { source: 'categoryName', column: 'category_name', type: 'text', max: 160 },
      { source: 'firstCategoryCode', column: 'first_category_code', type: 'text', max: 64 },
      { source: 'firstCategoryName', column: 'first_category_name', type: 'text', max: 160 },
      { source: 'applyType', column: 'apply_type', type: 'int' },
      { source: 'applyTypeName', column: 'apply_type_name', type: 'text', max: 160 },
      { source: 'sceneType', column: 'scene_type', type: 'int' },
      { source: 'sceneTypeName', column: 'scene_type_name', type: 'text', max: 160 },
      { source: 'statusValue', column: 'status_value', type: 'int' },
      { source: 'statusName', column: 'status_name', type: 'text', max: 160 },
      { source: 'createTime', column: 'create_time', type: 'instant' },
      { source: 'externalSystem', column: 'external_system', type: 'text', max: 64 },
      { source: 'workorderType', column: 'workorder_type', type: 'int' },
    ]),
  }),
  'value-added-services': Object.freeze({
    table: 'fact.full_webapi_value_added_service_observation',
    endpointCode: 'VALUE_ADDED_SERVICES_PAGE',
    entityField: 'id',
    sourceUpdatedField: null,
    columns: Object.freeze([
      { source: 'orderNo', column: 'order_no_hash', type: 'hash' },
      { source: 'subOrderNo', column: 'sub_order_no_hash', type: 'hash' },
      { source: 'purchaseNo', column: 'purchase_no_hash', type: 'hash' },
      { source: 'newPurchaseNo', column: 'new_purchase_no_hash', type: 'hash' },
      { source: 'qcInspectionNo', column: 'qc_inspection_no_hash', type: 'hash' },
      { source: 'returnNo', column: 'return_no_hash', type: 'hash' },
      { source: 'deliveryNo', column: 'delivery_no_hash', type: 'hash' },
      { source: 'serviceSiteId', column: 'service_site_id', type: 'int' },
      { source: 'serviceSiteName', column: 'service_site_name', type: 'text', max: 160 },
      { source: 'skc', column: 'skc', type: 'text', max: 64 },
      { source: 'multiPartFlag', column: 'multi_part_flag', type: 'flag' },
      { source: 'supplierProductNumber', column: 'supplier_product_number', type: 'text', max: 64 },
      { source: 'skcNum', column: 'skc_num', type: 'int' },
      { source: 'totalFlag', column: 'total_flag', type: 'flag' },
      { source: 'totalFlagName', column: 'total_flag_name', type: 'text', max: 120 },
      { source: 'orderState', column: 'order_state', type: 'int' },
      { source: 'orderStateName', column: 'order_state_name', type: 'text', max: 120 },
      { source: 'lowValueFlag', column: 'low_value_flag', type: 'flag' },
      { source: 'valueAddedResult', column: 'value_added_result', type: 'int' },
      { source: 'defectiveQuantity', column: 'defective_quantity', type: 'int' },
      { source: 'orderScene', column: 'order_scene', type: 'int' },
      { source: 'returnFlag', column: 'return_flag', type: 'flag' },
      { source: 'vendorReplenishState', column: 'vendor_replenish_state', type: 'int' },
      { source: 'vendorReplenishStateName', column: 'vendor_replenish_state_name', type: 'text', max: 120 },
      { source: 'showFeeTag', column: 'show_fee_tag', type: 'flag' },
      { source: 'supplierSource', column: 'supplier_source', type: 'int' },
      { source: 'supplierSourceName', column: 'supplier_source_name', type: 'text', max: 120 },
    ]),
  }),
  'quality-reports': Object.freeze({
    table: 'fact.full_webapi_quality_report_observation',
    endpointCode: 'QUALITY_REPORTS_PAGE',
    entityField: 'qcInspectionNo',
    sourceUpdatedField: 'inspectionTime',
    columns: Object.freeze([
      { source: 'purchaseCode', column: 'purchase_code_hash', type: 'hash' },
      { source: 'skc', column: 'skc', type: 'text', max: 64 },
      { source: 'hasDefectiveTotal', column: 'has_defective_total', type: 'flag' },
      { source: 'hasDefectiveTotalName', column: 'has_defective_total_name', type: 'text', max: 120 },
      { source: 'inspectionTime', column: 'inspection_time', type: 'instant' },
      { source: 'defectiveTotalQty', column: 'defective_total_qty', type: 'int' },
      { source: 'qcType', column: 'qc_type', type: 'int' },
      { source: 'qcTypeName', column: 'qc_type_name', type: 'text', max: 120 },
      { source: 'orderDefectiveTotalQty', column: 'order_defective_total_qty', type: 'int' },
      { source: 'orderQcResult', column: 'order_qc_result', type: 'int' },
      { source: 'orderQcResultName', column: 'order_qc_result_name', type: 'text', max: 120 },
      { source: 'inspectionResult', column: 'inspection_result', type: 'int' },
      { source: 'inspectionResultName', column: 'inspection_result_name', type: 'text', max: 120 },
    ]),
  }),
});

function pageSpec(pageId) {
  const spec = PAGE_SPECS[String(pageId ?? '')];
  if (!spec) fail('V4_PAGE_UNKNOWN');
  return spec;
}

function coerceTypedValue(spec, value) {
  switch (spec.type) {
    case 'hash': {
      if (value === null || value === undefined || value === '') return null;
      const text = String(value).trim();
      if (!text) return null;
      // These fields are frozen business identifiers (order / waybill /
      // purchase keys), not free text. Long numeric identifiers are common
      // and must not be mistaken for phone numbers before they are reduced to
      // an irreversible domain-separated hash. Sensitive semantic keys are
      // rejected separately, and the raw identifier is never sent to SQL.
      if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(text)) {
        fail('V4_TYPED_VALUE_INVALID');
      }
      return sha256Hex(HASH_DOMAINS.entity, text);
    }
    case 'text': {
      if (value === null || value === undefined) return null;
      rejectSensitiveValue(value);
      const text = scrubPiiText(value);
      if (text === null) fail('V4_PII_VALUE_REJECTED');
      const trimmed = text.trim();
      if (!trimmed) return null;
      if (trimmed.length > spec.max) fail('V4_TYPED_VALUE_INVALID');
      return trimmed;
    }
    case 'int': {
      if (value === null || value === undefined || value === '') return null;
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) fail('V4_TYPED_VALUE_INVALID');
      return parsed;
    }
    case 'flag': {
      if (value === null || value === undefined || value === '') return null;
      // The value-added-services page emits flags as JSON booleans or the
      // exact strings true/false (verified 2026-08-11 production evidence for
      // showFeeTag). Booleans and those two exact tokens coerce to 0/1;
      // arbitrary text is still refused.
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (text === 'true') return 1;
        if (text === 'false') return 0;
        if (text === '') return null;
      }
      const parsed = typeof value === 'number' ? value : Number(value);
      if (parsed !== 0 && parsed !== 1) fail('V4_TYPED_VALUE_INVALID');
      return parsed;
    }
    case 'numeric': {
      if (value === null || value === undefined || value === '') return null;
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) fail('V4_TYPED_VALUE_INVALID');
      return parsed;
    }
    case 'instant': {
      if (value === null || value === undefined || value === '') return null;
      const iso = isoInstant(value);
      if (iso === null) fail('V4_TYPED_VALUE_INVALID');
      return iso;
    }
    case 'char3': {
      if (value === null || value === undefined || value === '') return null;
      const text = String(value).trim().toUpperCase();
      if (!CURRENCY_CODE_PATTERN.test(text)) fail('V4_TYPED_VALUE_INVALID');
      return text;
    }
    default:
      fail('V4_PAGE_SPEC_INVALID');
      return null;
  }
}

/**
 * Sanitize and type one raw platform record for a verified page. Returns the
 * typed row or throws a V4CollectionError with a sanitized code only; raw
 * values are never echoed.
 */
function buildTypedRow(pageId, spec, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail('V4_ROW_NOT_OBJECT');
  }
  const allowlist = ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS[spec.endpointCode];
  if (!allowlist) fail('V4_ENDPOINT_ALLOWLIST_MISSING');
  for (const entry of allowlist) {
    if (!Object.prototype.hasOwnProperty.call(record, entry.name)) continue;
    if (isDeniedKeyName(entry.name) || V4_KEY_DENIED_PATTERN.test(entry.name)) {
      fail('V4_SENSITIVE_KEY_REJECTED');
    }
  }

  const entity = record[spec.entityField];
  if (entity === null || entity === undefined || String(entity).trim() === '') {
    fail('V4_ENTITY_KEY_MISSING');
  }
  const entityText = String(entity).trim();
  if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(entityText)) {
    fail('V4_ENTITY_KEY_INVALID');
  }

  // Defense in depth: any sensitive key anywhere in the raw record refuses the
  // whole row, even when the key is outside the verified allowlist.
  for (const key of Object.keys(record)) {
    if (isDeniedKeyName(key) || V4_KEY_DENIED_PATTERN.test(key)) {
      fail('V4_SENSITIVE_KEY_REJECTED');
    }
  }

  const picked = {};
  for (const entry of allowlist) {
    if (Object.prototype.hasOwnProperty.call(record, entry.name)) {
      picked[entry.name] = record[entry.name];
    }
  }
  const sourceVersionToken = sha256Hex(
    HASH_DOMAINS.version,
    canonicalJson(picked),
  );

  const typed = {};
  for (const columnSpec of spec.columns) {
    const value = Object.prototype.hasOwnProperty.call(record, columnSpec.source)
      ? record[columnSpec.source]
      : null;
    const coerced = coerceTypedValue(columnSpec, value);
    if (coerced !== null) typed[columnSpec.column] = coerced;
  }

  const entityKeyHash = sha256Hex(HASH_DOMAINS.entity, entityText);
  const payloadHash = sha256Hex(
    HASH_DOMAINS.payload,
    canonicalJson({
      entityKeyHash,
      sourceVersionToken,
      typed,
    }),
  );
  const sourceUpdatedAt = spec.sourceUpdatedField
    && Object.prototype.hasOwnProperty.call(record, spec.sourceUpdatedField)
    ? isoInstant(record[spec.sourceUpdatedField])
    : null;

  return {
    storeCode: null, // filled by the caller from the attempt
    entityKeyHash,
    sourceVersionToken,
    sourceUpdatedAt,
    payloadHash,
    typed,
  };
}

function canonicalTypedRow(row) {
  return canonicalJson({
    storeCode: row.storeCode,
    entityKeyHash: row.entityKeyHash,
    sourceVersionToken: row.sourceVersionToken,
    sourceUpdatedAt: row.sourceUpdatedAt === null ? null : isoInstant(row.sourceUpdatedAt),
    payloadHash: row.payloadHash,
    typed: canonicalJson(row.typed),
  });
}

/**
 * Normalize a row returned by node-postgres so a stored row can be compared
 * byte-for-byte with the row that produced it. numeric columns come back as
 * strings and timestamptz columns as Date objects.
 */
function normalizeStoredValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return value;
}

function normalizeStoredRow(row, typedColumns) {
  const normalized = {};
  for (const column of typedColumns) {
    normalized[column] = normalizeStoredValue(row[column]);
  }
  return normalized;
}

/**
 * Project a freshly built typed payload onto the full column universe so the
 * replay comparison covers missing columns as explicit nulls on both sides.
 */
function normalizeTypedForCompare(typed, spec) {
  const normalized = {};
  for (const columnSpec of spec.columns) {
    normalized[columnSpec.column] = Object.prototype.hasOwnProperty.call(
      typed,
      columnSpec.column,
    )
      ? normalizeStoredValue(typed[columnSpec.column])
      : null;
  }
  return normalized;
}

function buildInsertSql(spec, typedRow) {
  const columns = [
    'store_code',
    'entity_key_hash',
    'source_version_token',
    'source_attempt_id',
    'source_page_evidence_id',
    'observed_at',
    'source_updated_at',
    'payload_hash',
    ...spec.columns.map((columnSpec) => columnSpec.column),
  ];
  const values = [
    typedRow.storeCode,
    typedRow.entityKeyHash,
    typedRow.sourceVersionToken,
    typedRow.sourceAttemptId,
    typedRow.sourcePageEvidenceId,
    typedRow.observedAt,
    typedRow.sourceUpdatedAt,
    typedRow.payloadHash,
    ...spec.columns.map((columnSpec) => (
      Object.prototype.hasOwnProperty.call(typedRow.typed, columnSpec.column)
        ? typedRow.typed[columnSpec.column]
        : null
    )),
  ];
  return { columns, values };
}

async function withWriteTransaction(pool, work) {
  if (!pool?.connect) throw new TypeError('A PostgreSQL pool is required.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sheinfm_webapi_loader');
    await client.query("SET LOCAL lock_timeout TO '10s'");
    await client.query("SET LOCAL statement_timeout TO '120s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve root error */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Create one collection run for a frozen plan. Replaying the same run_key
 * requires the byte-identical plan; any drift rolls back. The store roster
 * must be exactly the canonical FULL_MANAGED_STORE_CODES roster and the
 * endpoint roster exactly the frozen 13-item work-item manifest, in the same
 * contractual order; no partial or single-store/single-endpoint run exists.
 */
export async function createCollectionRun(pool, {
  contractVersion = V4_CONTRACT_VERSION,
  planHash,
  runKey,
  storeCodes,
  endpointCodes,
  windowStart = null,
  windowEnd = null,
  retryPolicy = V4_RETRY_POLICY,
} = {}) {
  requireHex64(planHash, 'V4_PLAN_HASH_INVALID');
  requireHex64(runKey, 'V4_RUN_KEY_INVALID');
  if (!Array.isArray(storeCodes)
    || storeCodes.length !== FULL_MANAGED_STORE_CODES.length) {
    fail('V4_STORE_ROSTER_NOT_CANONICAL');
  }
  if (!Array.isArray(endpointCodes)
    || endpointCodes.length !== V4_REQUIRED_WORK_ITEM_CODES.length) {
    fail('V4_ENDPOINT_ROSTER_NOT_CANONICAL');
  }
  const uniqueStores = new Set(storeCodes.map(requireStoreCode));
  if (uniqueStores.size !== storeCodes.length) fail('V4_STORE_ROSTER_DUPLICATE');
  const uniqueEndpoints = new Set(endpointCodes.map(requireEndpointCode));
  if (uniqueEndpoints.size !== endpointCodes.length) fail('V4_ENDPOINT_ROSTER_DUPLICATE');
  if (!arraysEqual(storeCodes, FULL_MANAGED_STORE_CODES)) {
    fail('V4_STORE_ROSTER_NOT_CANONICAL');
  }
  if (!arraysEqual(endpointCodes, V4_REQUIRED_WORK_ITEM_CODES)) {
    fail('V4_ENDPOINT_ROSTER_NOT_CANONICAL');
  }
  if (retryPolicy !== V4_RETRY_POLICY) fail('V4_RETRY_POLICY_INVALID');
  if (!Number.isSafeInteger(contractVersion) || contractVersion < 1) {
    fail('V4_CONTRACT_VERSION_INVALID');
  }
  const [start, end] = requireWindow(windowStart, windowEnd);

  return withWriteTransaction(pool, async (client) => {
    const existing = await client.query(
      `SELECT collection_run_id, contract_version, plan_hash, run_status,
              expected_store_count, expected_endpoint_count,
              store_codes, endpoint_codes, window_start, window_end, retry_policy
         FROM ops.v4_collection_run
        WHERE run_key = $1`,
      [runKey],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      const replayExact = row.contract_version === contractVersion
        && row.plan_hash === planHash
        && row.expected_store_count === storeCodes.length
        && row.expected_endpoint_count === endpointCodes.length
        && arraysEqual(row.store_codes, storeCodes)
        && arraysEqual(row.endpoint_codes, endpointCodes)
        && row.retry_policy === retryPolicy
        && sameDateValue(row.window_start, start)
        && sameDateValue(row.window_end, end);
      if (!replayExact) fail('V4_RUN_REPLAY_DRIFT');
      return {
        collectionRunId: row.collection_run_id,
        runStatus: row.run_status,
        replayed: true,
      };
    }
    const inserted = await client.query(
      `INSERT INTO ops.v4_collection_run (
         contract_version, run_key, plan_hash, retry_policy,
         expected_store_count, expected_endpoint_count,
         store_codes, endpoint_codes, window_start, window_end
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING collection_run_id, run_status`,
      [
        contractVersion,
        runKey,
        planHash,
        retryPolicy,
        storeCodes.length,
        endpointCodes.length,
        storeCodes,
        endpointCodes,
        start,
        end,
      ],
    );
    const row = inserted.rows[0];
    const readback = await client.query(
      `SELECT collection_run_id, run_key, plan_hash, run_status,
              expected_store_count, expected_endpoint_count
         FROM ops.v4_collection_run
        WHERE collection_run_id = $1`,
      [row.collection_run_id],
    );
    const read = readback.rows[0];
    return {
      collectionRunId: read.collection_run_id,
      runStatus: read.run_status,
      planHash: read.plan_hash,
      expectedStoreCount: read.expected_store_count,
      expectedEndpointCount: read.expected_endpoint_count,
      replayed: false,
    };
  });
}

function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Advance the run state machine. The database trigger enforces the strict
 * transitions and the SUCCEEDED roster closure. State-transition timestamps
 * (started_at / completed_at) are always the database's own clock_timestamp(),
 * never a client clock, so a stale host clock can never regress the DB
 * timeline below created_at.
 */
export async function transitionRun(pool, {
  runKey,
  status,
  sanitizedErrorCode = null,
} = {}) {
  requireHex64(runKey, 'V4_RUN_KEY_INVALID');
  if (!V4_RUN_STATUSES.includes(status)) fail('V4_RUN_STATUS_INVALID');
  if (sanitizedErrorCode !== null && !ERROR_CODE_PATTERN.test(sanitizedErrorCode)) {
    fail('V4_ERROR_CODE_INVALID');
  }
  const setsStartedAt = status === 'RUNNING';
  const setsCompletedAt = V4_TERMINAL_RUN_STATUSES.includes(status);
  return withWriteTransaction(pool, async (client) => {
    const current = await client.query(
      `SELECT collection_run_id, run_status, started_at
         FROM ops.v4_collection_run
        WHERE run_key = $1`,
      [runKey],
    );
    if (current.rows.length === 0) fail('V4_RUN_UNKNOWN');
    const row = current.rows[0];
    if ((status === 'SUCCEEDED' || status === 'PARTIAL') && row.started_at === null) {
      fail('V4_RUN_NOT_STARTED');
    }
    const updated = await client.query(
      `UPDATE ops.v4_collection_run
          SET run_status = $2,
              started_at = CASE WHEN $3 THEN clock_timestamp() ELSE started_at END,
              completed_at = CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
              sanitized_error_code = $5
        WHERE run_key = $1
        RETURNING collection_run_id, run_status`,
      [
        runKey,
        status,
        setsStartedAt,
        setsCompletedAt,
        sanitizedErrorCode,
      ],
    );
    return {
      collectionRunId: updated.rows[0].collection_run_id,
      runStatus: updated.rows[0].run_status,
    };
  });
}

function attemptKey(runKey, storeCode, endpointCode, requestSchemaHash, windowStart, windowEnd) {
  return sha256Hex(
    HASH_DOMAINS.attempt,
    [runKey, storeCode, endpointCode, requestSchemaHash, windowStart ?? '', windowEnd ?? '']
      .join('\u001f'),
  );
}

/**
 * Open one store x endpoint attempt. Replaying the same grain requires the
 * byte-identical request contract and window; drift fails closed. BLOCKED and
 * UNKNOWN may be born directly as terminal preflight outcomes; their
 * completed_at is the database's own clock_timestamp(), never a client clock.
 */
export async function beginAttempt(pool, {
  runKey,
  storeCode,
  endpointCode,
  requestSchemaHash,
  requestFingerprint,
  windowStart = null,
  windowEnd = null,
  expectedRowCount = null,
  initialStatus = 'PLANNED',
  sanitizedErrorCode = null,
} = {}) {
  requireHex64(runKey, 'V4_RUN_KEY_INVALID');
  requireStoreCode(storeCode);
  requireEndpointCode(endpointCode);
  requireHex64(requestSchemaHash, 'V4_REQUEST_SCHEMA_HASH_INVALID');
  requireHex64(requestFingerprint, 'V4_REQUEST_FINGERPRINT_INVALID');
  if (!V4_ATTEMPT_STATUSES.includes(initialStatus)) fail('V4_ATTEMPT_STATUS_INVALID');
  if (initialStatus !== 'PLANNED' && initialStatus !== 'BLOCKED' && initialStatus !== 'UNKNOWN') {
    fail('V4_ATTEMPT_INITIAL_STATUS_INVALID');
  }
  if (initialStatus === 'BLOCKED' && sanitizedErrorCode === null) {
    fail('V4_ATTEMPT_BLOCKED_REQUIRES_ERROR');
  }
  if (sanitizedErrorCode !== null && !ERROR_CODE_PATTERN.test(sanitizedErrorCode)) {
    fail('V4_ERROR_CODE_INVALID');
  }
  if (expectedRowCount !== null && (!Number.isSafeInteger(expectedRowCount) || expectedRowCount < 0)) {
    fail('V4_EXPECTED_ROW_COUNT_INVALID');
  }
  const [start, end] = requireWindow(windowStart, windowEnd);
  const key = attemptKey(runKey, storeCode, endpointCode, requestSchemaHash, start, end);

  return withWriteTransaction(pool, async (client) => {
    const run = await client.query(
      `SELECT collection_run_id, run_status
         FROM ops.v4_collection_run
        WHERE run_key = $1`,
      [runKey],
    );
    if (run.rows.length === 0) fail('V4_RUN_UNKNOWN');
    if (V4_TERMINAL_RUN_STATUSES.includes(run.rows[0].run_status)) {
      fail('V4_RUN_TERMINAL');
    }
    const runId = run.rows[0].collection_run_id;

    const existing = await client.query(
      `SELECT collection_attempt_id, attempt_key, attempt_status,
              request_schema_hash, request_fingerprint,
              window_start, window_end, expected_row_count
         FROM ops.v4_collection_attempt
        WHERE collection_run_id = $1 AND store_code = $2 AND endpoint_code = $3`,
      [runId, storeCode, endpointCode],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      const replayExact = row.attempt_key === key
        && row.request_schema_hash === requestSchemaHash
        && row.request_fingerprint === requestFingerprint
        && sameDateValue(row.window_start, start)
        && sameDateValue(row.window_end, end)
        && row.expected_row_count === expectedRowCount;
      if (!replayExact) fail('V4_ATTEMPT_REPLAY_DRIFT');
      return {
        collectionAttemptId: row.collection_attempt_id,
        attemptStatus: row.attempt_status,
        attemptKey: row.attempt_key,
        replayed: true,
      };
    }

    const terminalBirth = initialStatus !== 'PLANNED';
    const inserted = await client.query(
      `INSERT INTO ops.v4_collection_attempt (
         collection_run_id, store_code, endpoint_code, attempt_key,
         request_schema_hash, request_fingerprint,
         window_start, window_end, attempt_status,
         expected_row_count, completed_at, sanitized_error_code
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         CASE WHEN $11 THEN clock_timestamp() ELSE NULL END, $12
       )
       RETURNING collection_attempt_id, attempt_status`,
      [
        runId,
        storeCode,
        endpointCode,
        key,
        requestSchemaHash,
        requestFingerprint,
        start,
        end,
        initialStatus,
        expectedRowCount,
        terminalBirth,
        sanitizedErrorCode,
      ],
    );
    const readback = await client.query(
      `SELECT collection_attempt_id, attempt_key, attempt_status
         FROM ops.v4_collection_attempt
        WHERE collection_attempt_id = $1`,
      [inserted.rows[0].collection_attempt_id],
    );
    return {
      collectionAttemptId: readback.rows[0].collection_attempt_id,
      attemptStatus: readback.rows[0].attempt_status,
      attemptKey: readback.rows[0].attempt_key,
      replayed: false,
    };
  });
}

/**
 * Transition an attempt. FAILED/BLOCKED/UNKNOWN never carry counts: missing
 * evidence is never converted to zero. State-transition timestamps
 * (started_at / completed_at) are always the database's own clock_timestamp(),
 * never a client clock.
 */
export async function transitionAttempt(pool, {
  attemptKey: key,
  status,
  observedRowCount = null,
  observedPageCount = null,
  sanitizedErrorCode = null,
} = {}) {
  requireHex64(key, 'V4_ATTEMPT_KEY_INVALID');
  if (!V4_ATTEMPT_STATUSES.includes(status)) fail('V4_ATTEMPT_STATUS_INVALID');
  if (status === 'FAILED' || status === 'BLOCKED') {
    if (sanitizedErrorCode === null || !ERROR_CODE_PATTERN.test(sanitizedErrorCode)) {
      fail('V4_ATTEMPT_TERMINAL_REQUIRES_ERROR');
    }
  }
  if (observedRowCount !== null && (!Number.isSafeInteger(observedRowCount) || observedRowCount < 0)) {
    fail('V4_OBSERVED_ROW_COUNT_INVALID');
  }
  if (observedPageCount !== null && (!Number.isSafeInteger(observedPageCount) || observedPageCount < 1)) {
    fail('V4_OBSERVED_PAGE_COUNT_INVALID');
  }
  const setsStartedAt = status === 'RUNNING';
  const setsCompletedAt = status !== 'RUNNING';
  return withWriteTransaction(pool, async (client) => {
    const current = await client.query(
      `SELECT collection_attempt_id, attempt_status, started_at
         FROM ops.v4_collection_attempt
        WHERE attempt_key = $1`,
      [key],
    );
    if (current.rows.length === 0) fail('V4_ATTEMPT_UNKNOWN');
    const row = current.rows[0];
    if ((status === 'SUCCEEDED' || status === 'PARTIAL') && row.started_at === null) {
      fail('V4_ATTEMPT_NOT_STARTED');
    }
    const updated = await client.query(
      `UPDATE ops.v4_collection_attempt
          SET attempt_status = $2,
              started_at = CASE WHEN $3 THEN clock_timestamp() ELSE started_at END,
              completed_at = CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
              observed_row_count = $5,
              observed_page_count = $6,
              sanitized_error_code = $7
        WHERE attempt_key = $1
        RETURNING collection_attempt_id, attempt_status`,
      [
        key,
        status,
        setsStartedAt,
        setsCompletedAt,
        observedRowCount,
        observedPageCount,
        sanitizedErrorCode,
      ],
    );
    return {
      collectionAttemptId: updated.rows[0].collection_attempt_id,
      attemptStatus: updated.rows[0].attempt_status,
    };
  });
}

/**
 * Record one capability observation (marketing / low-frequency). Only
 * business_materialized = false may ever be written.
 */
export async function recordCapabilityObservation(pool, {
  runKey,
  storeCode = null,
  endpointCode,
  capabilityCode,
  capabilityStatus,
  payloadHash,
  observedAt = new Date(),
  sourceUpdatedAt = null,
  sanitizedErrorCode = null,
} = {}) {
  requireHex64(runKey, 'V4_RUN_KEY_INVALID');
  if (storeCode !== null) requireStoreCode(storeCode);
  requireEndpointCode(endpointCode);
  if (!CAPABILITY_CODE_PATTERN.test(String(capabilityCode ?? ''))) {
    fail('V4_CAPABILITY_CODE_INVALID');
  }
  if (!V4_CAPABILITY_STATUSES.includes(capabilityStatus)) {
    fail('V4_CAPABILITY_STATUS_INVALID');
  }
  requireHex64(payloadHash, 'V4_PAYLOAD_HASH_INVALID');
  if (sanitizedErrorCode !== null && !ERROR_CODE_PATTERN.test(sanitizedErrorCode)) {
    fail('V4_ERROR_CODE_INVALID');
  }
  const key = sha256Hex(
    HASH_DOMAINS.capability,
    [runKey, storeCode ?? '', endpointCode, capabilityCode, payloadHash].join('\u001f'),
  );
  return withWriteTransaction(pool, async (client) => {
    const run = await client.query(
      `SELECT collection_run_id, run_status
         FROM ops.v4_collection_run
        WHERE run_key = $1`,
      [runKey],
    );
    if (run.rows.length === 0) fail('V4_RUN_UNKNOWN');
    if (V4_TERMINAL_RUN_STATUSES.includes(run.rows[0].run_status)) {
      fail('V4_RUN_TERMINAL');
    }
    const existing = await client.query(
      `SELECT capability_observation_id, store_code, endpoint_code,
              capability_code, capability_status, payload_hash,
              observed_at, source_updated_at, sanitized_error_code
         FROM ops.v4_capability_observation
        WHERE observation_key = $1`,
      [key],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      const replayExact = row.store_code === storeCode
        && row.endpoint_code === endpointCode
        && row.capability_code === capabilityCode
        && row.capability_status === capabilityStatus
        && row.payload_hash === payloadHash
        && isoInstant(row.observed_at) === isoInstant(observedAt)
        && isoInstant(row.source_updated_at) === isoInstant(sourceUpdatedAt)
        && row.sanitized_error_code === sanitizedErrorCode;
      if (!replayExact) fail('V4_CAPABILITY_REPLAY_DRIFT');
      return {
        capabilityObservationId: row.capability_observation_id,
        businessMaterialized: false,
        replayed: true,
      };
    }
    const inserted = await client.query(
      `INSERT INTO ops.v4_capability_observation (
         observation_key, collection_run_id, store_code, endpoint_code,
         capability_code, capability_status, business_materialized,
         payload_hash, observed_at, source_updated_at, sanitized_error_code
       ) VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, $10)
       RETURNING capability_observation_id`,
      [
        key,
        run.rows[0].collection_run_id,
        storeCode,
        endpointCode,
        capabilityCode,
        capabilityStatus,
        payloadHash,
        isoInstant(observedAt),
        sourceUpdatedAt ? isoInstant(sourceUpdatedAt) : null,
        sanitizedErrorCode,
      ],
    );
    return {
      capabilityObservationId: inserted.rows[0].capability_observation_id,
      businessMaterialized: false,
      replayed: false,
    };
  });
}

/**
 * Finalize the terminal coverage envelope. Store counts are computed from
 * attempt evidence (never zero-filled) and row_count from page evidence; the
 * database trigger recomputes both and rejects any drift. The as-of instant
 * is the database's own clock_timestamp(), never a client clock.
 */
export async function finalizeCoverage(pool, {
  runKey,
  pagingVerified,
  dedupeVerified,
  reasonCode = null,
} = {}) {
  requireHex64(runKey, 'V4_RUN_KEY_INVALID');
  if (typeof pagingVerified !== 'boolean' || typeof dedupeVerified !== 'boolean') {
    fail('V4_COVERAGE_VERIFIED_FLAGS_INVALID');
  }
  if (reasonCode !== null && !ERROR_CODE_PATTERN.test(reasonCode)) {
    fail('V4_ERROR_CODE_INVALID');
  }
  return withWriteTransaction(pool, async (client) => {
    const run = await client.query(
      `SELECT collection_run_id, run_status, expected_store_count,
              expected_endpoint_count, store_codes
         FROM ops.v4_collection_run
        WHERE run_key = $1`,
      [runKey],
    );
    if (run.rows.length === 0) fail('V4_RUN_UNKNOWN');
    const runRow = run.rows[0];
    if (!V4_TERMINAL_RUN_STATUSES.includes(runRow.run_status)) {
      fail('V4_RUN_NOT_TERMINAL');
    }

    const existing = await client.query(
      `SELECT coverage_id, completed_store_count, partial_store_count,
              unknown_store_count, row_count, reason_code
         FROM ops.v4_collection_coverage
        WHERE collection_run_id = $1`,
      [runRow.collection_run_id],
    );

    const attemptRows = await client.query(
      `SELECT store_code, attempt_status, count(*)::integer AS attempt_count
         FROM ops.v4_collection_attempt
        WHERE collection_run_id = $1
        GROUP BY store_code, attempt_status`,
      [runRow.collection_run_id],
    );
    const statusByStore = new Map();
    const attemptCountByStore = new Map();
    for (const row of attemptRows.rows) {
      attemptCountByStore.set(
        row.store_code,
        (attemptCountByStore.get(row.store_code) ?? 0) + row.attempt_count,
      );
      if (row.attempt_status === 'SUCCEEDED') {
        statusByStore.set(
          row.store_code,
          (statusByStore.get(row.store_code) ?? 0) + row.attempt_count,
        );
      }
    }
    let completedStoreCount = 0;
    let partialStoreCount = 0;
    let unknownStoreCount = 0;
    for (const storeCode of runRow.store_codes) {
      const attemptCount = attemptCountByStore.get(storeCode) ?? 0;
      const succeededCount = statusByStore.get(storeCode) ?? 0;
      if (attemptCount === runRow.expected_endpoint_count
        && succeededCount === attemptCount) {
        completedStoreCount += 1;
      } else if (succeededCount > 0) {
        partialStoreCount += 1;
      } else {
        unknownStoreCount += 1;
      }
    }
    const rowCountResult = await client.query(
      `SELECT COALESCE(sum(page.row_count), 0)::bigint AS row_count
         FROM ops.v4_page_evidence AS page
         JOIN ops.v4_collection_attempt AS attempt
           ON attempt.collection_attempt_id = page.collection_attempt_id
        WHERE attempt.collection_run_id = $1`,
      [runRow.collection_run_id],
    );
    const rowCount = Number(rowCountResult.rows[0].row_count);

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      const replayExact = row.completed_store_count === completedStoreCount
        && row.partial_store_count === partialStoreCount
        && row.unknown_store_count === unknownStoreCount
        && Number(row.row_count) === rowCount
        && row.reason_code === reasonCode;
      if (!replayExact) fail('V4_COVERAGE_REPLAY_DRIFT');
      return {
        coverageId: row.coverage_id,
        expectedStoreCount: runRow.expected_store_count,
        completedStoreCount,
        partialStoreCount,
        unknownStoreCount,
        rowCount,
        replayed: true,
      };
    }

    const inserted = await client.query(
      `INSERT INTO ops.v4_collection_coverage (
         collection_run_id, expected_store_count, completed_store_count,
         partial_store_count, unknown_store_count, expected_endpoint_count,
         paging_verified, dedupe_verified, row_count, reason_code, as_of
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())
       RETURNING coverage_id`,
      [
        runRow.collection_run_id,
        runRow.expected_store_count,
        completedStoreCount,
        partialStoreCount,
        unknownStoreCount,
        runRow.expected_endpoint_count,
        pagingVerified,
        dedupeVerified,
        rowCount,
        reasonCode,
      ],
    );
    const readback = await client.query(
      `SELECT coverage_id, completed_store_count, partial_store_count,
              unknown_store_count, row_count
         FROM ops.v4_collection_coverage
        WHERE collection_run_id = $1`,
      [runRow.collection_run_id],
    );
    const read = readback.rows[0];
    return {
      coverageId: read.coverage_id,
      expectedStoreCount: runRow.expected_store_count,
      completedStoreCount: read.completed_store_count,
      partialStoreCount: read.partial_store_count,
      unknownStoreCount: read.unknown_store_count,
      rowCount: Number(read.row_count),
      replayed: false,
    };
  });
}

/**
 * Record truthful page-level source evidence for an allowlisted endpoint that
 * is intentionally not materialized into a typed business table (no verified
 * page is currently unmaterialized; the function stays for callers that keep
 * page-level evidence without business rows). The payload hash is the
 * caller-computed SHA-256 of the actual transport response; no response body
 * or business value is kept.
 */
export async function recordPageEvidence(pool, {
  storeCode,
  endpointCode,
  attemptKey: key,
  pageNumber,
  pageSize,
  pageRequestFingerprint,
  responseSchemaHash,
  payloadHash,
  httpStatus = null,
  observedAt = new Date(),
  rowCount,
  rejectedRowCount = 0,
  fetchStatus = rejectedRowCount > 0 ? 'PARTIAL' : 'SUCCEEDED',
} = {}) {
  requireStoreCode(storeCode);
  requireEndpointCode(endpointCode);
  requireHex64(key, 'V4_ATTEMPT_KEY_INVALID');
  requireHex64(pageRequestFingerprint, 'V4_PAGE_REQUEST_FINGERPRINT_INVALID');
  requireHex64(responseSchemaHash, 'V4_RESPONSE_SCHEMA_HASH_INVALID');
  requireHex64(payloadHash, 'V4_PAYLOAD_HASH_INVALID');
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 1000) {
    fail('V4_PAGE_NUMBER_INVALID');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    fail('V4_PAGE_SIZE_INVALID');
  }
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    fail('V4_PAGE_ROW_COUNT_INVALID');
  }
  if (!Number.isSafeInteger(rejectedRowCount) || rejectedRowCount < 0) {
    fail('V4_PAGE_REJECTED_ROW_COUNT_INVALID');
  }
  if ((fetchStatus === 'SUCCEEDED' && rejectedRowCount !== 0)
    || (fetchStatus === 'PARTIAL' && rejectedRowCount === 0)
    || !['SUCCEEDED', 'PARTIAL'].includes(fetchStatus)) {
    fail('V4_PAGE_FETCH_STATUS_INVALID');
  }
  if (httpStatus !== null
    && (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) {
    fail('V4_HTTP_STATUS_INVALID');
  }

  const pageKey = sha256Hex(
    HASH_DOMAINS.page,
    [key, pageNumber, pageRequestFingerprint].join('\u001f'),
  );
  return withWriteTransaction(pool, async (client) => {
    const attempt = await client.query(
      `SELECT collection_attempt_id, store_code, endpoint_code, attempt_status
         FROM ops.v4_collection_attempt
        WHERE attempt_key = $1`,
      [key],
    );
    if (attempt.rows.length === 0) fail('V4_ATTEMPT_UNKNOWN');
    const attemptRow = attempt.rows[0];
    if (attemptRow.store_code !== storeCode || attemptRow.endpoint_code !== endpointCode) {
      fail('V4_ATTEMPT_GRAIN_MISMATCH');
    }
    const existing = await client.query(
      `SELECT page_evidence_id, page_number, page_size,
              page_request_fingerprint, response_schema_hash, payload_hash,
              row_count, rejected_row_count, http_status, fetch_status
         FROM ops.v4_page_evidence
        WHERE page_key = $1`,
      [pageKey],
    );
    if (existing.rows.length > 0) {
      const page = existing.rows[0];
      const replayExact = page.page_number === pageNumber
        && page.page_size === pageSize
        && page.page_request_fingerprint === pageRequestFingerprint
        && page.response_schema_hash === responseSchemaHash
        && page.payload_hash === payloadHash
        && page.row_count === rowCount
        && page.rejected_row_count === rejectedRowCount
        && page.http_status === httpStatus
        && page.fetch_status === fetchStatus;
      if (!replayExact) fail('V4_PAGE_REPLAY_DRIFT');
      return {
        pageEvidenceId: page.page_evidence_id,
        pageKey,
        payloadHash,
        rowCount,
        rejectedRowCount,
        replayed: true,
      };
    }
    if (['SUCCEEDED', 'PARTIAL', 'FAILED', 'BLOCKED', 'UNKNOWN']
      .includes(attemptRow.attempt_status)) {
      fail('V4_ATTEMPT_TERMINAL');
    }
    const inserted = await client.query(
      `INSERT INTO ops.v4_page_evidence (
         collection_attempt_id, page_key, page_number, page_size,
         page_request_fingerprint, response_schema_hash, payload_hash,
         row_count, rejected_row_count, http_status, fetch_status, observed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING page_evidence_id, page_key, payload_hash, row_count,
                 rejected_row_count`,
      [
        attemptRow.collection_attempt_id,
        pageKey,
        pageNumber,
        pageSize,
        pageRequestFingerprint,
        responseSchemaHash,
        payloadHash,
        rowCount,
        rejectedRowCount,
        httpStatus,
        fetchStatus,
        isoInstant(observedAt),
      ],
    );
    const row = inserted.rows[0];
    return {
      pageEvidenceId: row.page_evidence_id,
      pageKey: row.page_key,
      payloadHash: row.payload_hash,
      rowCount: row.row_count,
      rejectedRowCount: row.rejected_row_count,
      replayed: false,
    };
  });
}

/**
 * Sanitize, type and append one page of raw platform records into the typed
 * fact table for the page, together with its page evidence row, under one
 * transaction.
 *
 * Exact replay: the same attempt_key + page_key + rows reproduces the exact
 * rows and reuses the same page evidence; any drift rolls back. After the
 * write, the exact row count and payload hashes are read back.
 */
export async function insertTypedFacts(pool, {
  pageId,
  storeCode,
  endpointCode,
  attemptKey: key,
  pageNumber,
  pageSize,
  pageRequestFingerprint,
  responseSchemaHash,
  sourcePayloadHash = null,
  httpStatus = null,
  observedAt = new Date(),
  rows = [],
} = {}) {
  const spec = pageSpec(pageId);
  requireStoreCode(storeCode);
  requireEndpointCode(endpointCode);
  requireHex64(key, 'V4_ATTEMPT_KEY_INVALID');
  requireHex64(pageRequestFingerprint, 'V4_PAGE_REQUEST_FINGERPRINT_INVALID');
  requireHex64(responseSchemaHash, 'V4_RESPONSE_SCHEMA_HASH_INVALID');
  if (sourcePayloadHash !== null) {
    requireHex64(sourcePayloadHash, 'V4_PAYLOAD_HASH_INVALID');
  }
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 1000) {
    fail('V4_PAGE_NUMBER_INVALID');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    fail('V4_PAGE_SIZE_INVALID');
  }
  if (httpStatus !== null && (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) {
    fail('V4_HTTP_STATUS_INVALID');
  }
  if (!Array.isArray(rows)) fail('V4_ROWS_INVALID');
  if (spec.endpointCode !== endpointCode) fail('V4_PAGE_ENDPOINT_MISMATCH');

  const pageKey = sha256Hex(
    HASH_DOMAINS.page,
    [key, pageNumber, pageRequestFingerprint].join('\u001f'),
  );
  const typedRows = [];
  const rejectedCodes = [];
  let rejectedRowCount = 0;
  for (const rawRow of rows) {
    try {
      typedRows.push(buildTypedRow(pageId, spec, rawRow));
    } catch (error) {
      if (!(error instanceof V4CollectionError)) throw error;
      rejectedCodes.push(error.code);
      rejectedRowCount += 1;
    }
  }
  for (const typedRow of typedRows) {
    typedRow.storeCode = storeCode;
  }
  const typedPayloadHash = sha256Hex(
    HASH_DOMAINS.pagePayload,
    canonicalJson(typedRows.map((row) => canonicalTypedRow(row))),
  );
  const pagePayloadHash = sourcePayloadHash ?? typedPayloadHash;
  const fetchStatus = rejectedRowCount > 0 ? 'PARTIAL' : 'SUCCEEDED';

  return withWriteTransaction(pool, async (client) => {
    const attempt = await client.query(
      `SELECT collection_attempt_id, collection_run_id, store_code,
              endpoint_code, attempt_status
         FROM ops.v4_collection_attempt
        WHERE attempt_key = $1`,
      [key],
    );
    if (attempt.rows.length === 0) fail('V4_ATTEMPT_UNKNOWN');
    const attemptRow = attempt.rows[0];
    if (attemptRow.store_code !== storeCode || attemptRow.endpoint_code !== endpointCode) {
      fail('V4_ATTEMPT_GRAIN_MISMATCH');
    }
    const attemptTerminal = [
      'SUCCEEDED',
      'PARTIAL',
      'FAILED',
      'BLOCKED',
      'UNKNOWN',
    ].includes(attemptRow.attempt_status);

    const existingPage = await client.query(
      `SELECT page_evidence_id, page_number, page_size,
              page_request_fingerprint, response_schema_hash, payload_hash,
              row_count, rejected_row_count, http_status, fetch_status
         FROM ops.v4_page_evidence
        WHERE page_key = $1`,
      [pageKey],
    );
    let pageEvidenceId;
    if (existingPage.rows.length > 0) {
      const page = existingPage.rows[0];
      const pageReplayExact = page.page_number === pageNumber
        && page.page_size === pageSize
        && page.page_request_fingerprint === pageRequestFingerprint
        && page.response_schema_hash === responseSchemaHash
        && page.payload_hash === pagePayloadHash
        && page.row_count === typedRows.length
        && page.rejected_row_count === rejectedRowCount
        && page.http_status === httpStatus
        && page.fetch_status === fetchStatus;
      if (!pageReplayExact) fail('V4_PAGE_REPLAY_DRIFT');
      pageEvidenceId = page.page_evidence_id;
    } else {
      if (attemptTerminal) fail('V4_ATTEMPT_TERMINAL');
      const insertedPage = await client.query(
        `INSERT INTO ops.v4_page_evidence (
           collection_attempt_id, page_key, page_number, page_size,
           page_request_fingerprint, response_schema_hash, payload_hash,
           row_count, rejected_row_count, http_status, fetch_status,
           observed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING page_evidence_id`,
        [
          attemptRow.collection_attempt_id,
          pageKey,
          pageNumber,
          pageSize,
          pageRequestFingerprint,
          responseSchemaHash,
          pagePayloadHash,
          typedRows.length,
          rejectedRowCount,
          httpStatus,
          fetchStatus,
          isoInstant(observedAt),
        ],
      );
      pageEvidenceId = insertedPage.rows[0].page_evidence_id;
    }

    const typedColumns = spec.columns.map((columnSpec) => columnSpec.column);
    const existingRows = await client.query(
      `SELECT entity_key_hash, source_version_token, payload_hash,
              ${typedColumns.join(', ')}
         FROM ${spec.table}
        WHERE source_attempt_id = $1`,
      [attemptRow.collection_attempt_id],
    );
    const existingByKey = new Map();
    for (const row of existingRows.rows) {
      existingByKey.set(
        `${row.entity_key_hash}\u001f${row.source_version_token}`,
        {
          payloadHash: row.payload_hash,
          typed: normalizeStoredRow(row, typedColumns),
        },
      );
    }

    const valueRows = [];
    let replayedRowCount = 0;
    const insertedRows = [];
    for (const typedRow of typedRows) {
      const replayKey = `${typedRow.entityKeyHash}\u001f${typedRow.sourceVersionToken}`;
      const existing = existingByKey.get(replayKey);
      if (existing) {
        const replayExact = existing.payloadHash === typedRow.payloadHash
          && canonicalJson(existing.typed)
            === canonicalJson(normalizeTypedForCompare(typedRow.typed, spec));
        if (!replayExact) fail('V4_FACT_REPLAY_DRIFT');
        replayedRowCount += 1;
        continue;
      }
      if (attemptTerminal) fail('V4_ATTEMPT_TERMINAL');
      const prepared = buildInsertSql(spec, {
        ...typedRow,
        sourceAttemptId: attemptRow.collection_attempt_id,
        sourcePageEvidenceId: pageEvidenceId,
        observedAt: isoInstant(observedAt),
      });
      valueRows.push(prepared);
      insertedRows.push(typedRow);
    }
    if (valueRows.length > 0) {
      const columns = valueRows[0].columns.join(', ');
      const placeholders = [];
      const flatParams = [];
      let parameterIndex = 1;
      for (const valueRow of valueRows) {
        const rowPlaceholders = [];
        for (const value of valueRow.values) {
          rowPlaceholders.push(`$${parameterIndex}`);
          flatParams.push(value);
          parameterIndex += 1;
        }
        placeholders.push(`(${rowPlaceholders.join(', ')})`);
      }
      await client.query(
        `INSERT INTO ${spec.table} (${columns}) VALUES ${placeholders.join(', ')}`,
        flatParams,
      );
    }

    const readback = await client.query(
      `SELECT entity_key_hash, source_version_token, payload_hash
         FROM ${spec.table}
        WHERE source_attempt_id = $1
        ORDER BY entity_key_hash, source_version_token`,
      [attemptRow.collection_attempt_id],
    );
    const expectedHashes = new Map();
    for (const row of existingRows.rows) {
      expectedHashes.set(
        `${row.entity_key_hash}\u001f${row.source_version_token}`,
        row.payload_hash,
      );
    }
    for (const typedRow of insertedRows) {
      expectedHashes.set(
        `${typedRow.entityKeyHash}\u001f${typedRow.sourceVersionToken}`,
        typedRow.payloadHash,
      );
    }
    const expectedRowCount = expectedHashes.size;
    let payloadHashesMatch = readback.rows.length === expectedRowCount;
    if (payloadHashesMatch) {
      for (const row of readback.rows) {
        if (expectedHashes.get(`${row.entity_key_hash}\u001f${row.source_version_token}`)
          !== row.payload_hash) {
          payloadHashesMatch = false;
          break;
        }
      }
    }
    if (!payloadHashesMatch) {
      // A typed fact page may succeed only when the exact readback proves the
      // expected row count and payload hashes. Anything else is a persistence
      // integrity failure and rolls the whole page back, so no attempt can
      // ever claim success on unproven rows.
      fail('V4_COLLECTION_READBACK_MISMATCH');
    }
    return {
      pageId,
      storeCode,
      endpointCode,
      pageEvidenceId,
      pageKey,
      payloadHash: pagePayloadHash,
      acceptedRowCount: typedRows.length,
      rejectedRowCount,
      insertedRowCount: valueRows.length,
      replayedRowCount,
      rejectedCodes: [...new Set(rejectedCodes)],
      readback: {
        rowCount: readback.rows.length,
        payloadHashesMatch: true,
        expectedRowCount,
      },
    };
  });
}

export function createFullWebapiFactRepository({ pool }) {
  return Object.freeze({
    createCollectionRun: (input) => createCollectionRun(pool, input),
    transitionRun: (input) => transitionRun(pool, input),
    beginAttempt: (input) => beginAttempt(pool, input),
    transitionAttempt: (input) => transitionAttempt(pool, input),
    recordCapabilityObservation: (input) => recordCapabilityObservation(pool, input),
    recordPageEvidence: (input) => recordPageEvidence(pool, input),
    finalizeCoverage: (input) => finalizeCoverage(pool, input),
    insertTypedFacts: (input) => insertTypedFacts(pool, input),
  });
}
