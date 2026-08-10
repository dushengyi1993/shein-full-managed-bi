import crypto from 'node:crypto';

/**
 * Shared order-management index contract.
 *
 * The index file `order-management.json` is the single observable boundary
 * for the read-only order-management workspace.  Every page id is fixed, every
 * row carries the same shape, and metrics/facts/details may only contain
 * allowlisted text or numbers.  Field reads are pinned by SHA-256 hashes of
 * the canonical field names so that no unverified field can ever enter the
 * index.
 */

export const ORDER_MANAGEMENT_INDEX_VERSION = 1;
export const ORDER_MANAGEMENT_EXPECTED_STORE_COUNT = 25;

export const ORDER_MANAGEMENT_PAGE_IDS = Object.freeze([
  'delivery-notes',
  'stock-records',
  'waybills',
  'return-applications',
  'return-orders',
  'exceptions',
  'value-added-services',
  'quality-reports',
]);

export const ORDER_MANAGEMENT_PAGE_STATUSES = Object.freeze([
  'AVAILABLE',
  'PARTIAL',
  'UNAVAILABLE',
]);

export const ORDER_MANAGEMENT_COVERAGE_STATUSES = Object.freeze([
  'COMPLETE',
  'PARTIAL',
  'UNAVAILABLE',
]);

export const ORDER_MANAGEMENT_ROW_KEYS = Object.freeze([
  'id',
  'storeCode',
  'statusCode',
  'statusName',
  'createdAt',
  'updatedAt',
  'primary',
  'secondary',
  'tags',
  'metrics',
  'facts',
  'details',
]);

const DENIED_KEY_PATTERN =
  /address|phone|tel\b|mobile|contact|receiver|sender|consignee|recipient|postcode|postal|zip\b/i;
const PHONE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const LONG_DIGITS_PATTERN = /\d{11,}/;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const LANDLINE_PATTERN = /(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)/;
const SENSITIVE_TEXT_PATTERN = /联系人|联系电话|收件人|收货人|手机(?:号)?|电话|邮箱|电子邮件|详细地址|门牌|街道|contact|recipient|receiver|consignee|phone|mobile|e-?mail|address/i;

/**
 * Fail-closed PII checks.  The allowlist is the primary control; these
 * patterns are the second line of defence for free-form values.
 */
export function isDeniedKeyName(name) {
  return DENIED_KEY_PATTERN.test(String(name ?? ''));
}

export function containsNumericPii(value) {
  const text = String(value ?? '');
  return PHONE_PATTERN.test(text) || LONG_DIGITS_PATTERN.test(text);
}

export function containsSensitiveText(value) {
  const text = String(value ?? '');
  return PHONE_PATTERN.test(text)
    || LANDLINE_PATTERN.test(text)
    || EMAIL_PATTERN.test(text)
    || SENSITIVE_TEXT_PATTERN.test(text);
}

export function scrubPiiText(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return containsNumericPii(text) || containsSensitiveText(text) ? null : text;
}

export function fieldHash(name) {
  const normalized = String(name ?? '').trim();
  if (!normalized) throw new TypeError('ORDER_MANAGEMENT_FIELD_NAME_EMPTY');
  return crypto.createHash('sha256')
    .update(`order-management.v1.field:${normalized}`)
    .digest('hex');
}

/**
 * Verified field-name allowlists per page.  Only names present in the
 * research evidence (DOM/API captures of 2026-08-08) may be read or emitted.
 * Pages without a verified contract keep an empty allowlist: nothing can be
 * read for them and they must stay UNAVAILABLE.
 */
const FIELD_NAMES = Object.freeze({
  'delivery-notes': Object.freeze([
    'deliveryCode',
    'deliveryTypeCode',
    'deliveryTypeName',
    'expressCode',
    'expressCompanyCode',
    'expressCompanyName',
    'packageCount',
    'packageWeight',
    'warehouseCode',
    'warehouseName',
    'reservedParcelAt',
    'takenAt',
    'expectedReceiptAt',
    'receivedAt',
    'platformCreatedAt',
    'sourceFetchedAt',
    'orderNo',
    'skcName',
    'skuCode',
    'deliveryQuantity',
    'orderTypeCode',
    'orderTypeName',
    'prepareTypeName',
    'lineCount',
    'skuCount',
    'orderCount',
  ]),
  waybills: Object.freeze([
    'deliveryCode',
    'deliveryTypeName',
    'expressCompanyCode',
    'expressCompanyName',
    'packageCount',
    'packageWeight',
    'reservedParcelAt',
    'takenAt',
    'expectedReceiptAt',
    'receivedAt',
    'platformCreatedAt',
    'sourceFetchedAt',
    'orderNo',
    'skcName',
    'skuCode',
    'deliveryQuantity',
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
    'lineCount',
    'skuCount',
    'orderCount',
  ]),
  'stock-records': Object.freeze([
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
  'return-applications': Object.freeze([
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
  'return-orders': Object.freeze([
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
  exceptions: Object.freeze([
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
  'value-added-services': Object.freeze([
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
  'quality-reports': Object.freeze([
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

function buildAllowlist(names) {
  return Object.freeze(names.map((name) => Object.freeze({
    name,
    hash: fieldHash(name),
  })));
}

export const PAGE_FIELD_ALLOWLISTS = Object.freeze(Object.fromEntries(
  ORDER_MANAGEMENT_PAGE_IDS.map((pageId) => [
    pageId,
    buildAllowlist(FIELD_NAMES[pageId] ?? []),
  ]),
));

export function allowlistedFieldNames(pageId) {
  const page = PAGE_FIELD_ALLOWLISTS[String(pageId ?? '')];
  if (!page) throw new TypeError(`ORDER_MANAGEMENT_PAGE_UNKNOWN: ${pageId}`);
  return page.map((entry) => entry.name);
}

/**
 * Read-only field selector pinned by field hash.  Fails closed when the
 * requested name is not part of the verified allowlist for the page.
 */
export function assertAllowlistedFieldName(pageId, name) {
  const normalized = String(name ?? '').trim();
  const page = PAGE_FIELD_ALLOWLISTS[String(pageId ?? '')];
  const entry = page?.find((item) => item.name === normalized);
  if (!entry || entry.hash !== fieldHash(normalized)) {
    throw new TypeError(`ORDER_MANAGEMENT_FIELD_NOT_ALLOWED: ${pageId}/${normalized}`);
  }
  if (isDeniedKeyName(normalized)) {
    throw new TypeError(`ORDER_MANAGEMENT_FIELD_DENIED_PII: ${pageId}/${normalized}`);
  }
  return normalized;
}

/**
 * Copy only allowlisted keys from a raw platform record.  Every copied key is
 * verified by hash; unverified keys are never touched.
 */
export function pickAllowlistedFields(pageId, record) {
  return pickFieldsByAllowlist(PAGE_FIELD_ALLOWLISTS[String(pageId ?? '')] ?? [], record);
}

/**
 * Copy only allowlisted keys from a raw platform record using an explicit
 * {name, hash} allowlist (page-level or endpoint-level).
 */
export function pickFieldsByAllowlist(allowlist, record) {
  const source = record && typeof record === 'object' && !Array.isArray(record)
    ? record
    : {};
  const result = {};
  for (const entry of allowlist) {
    if (!entry || typeof entry.name !== 'string' || entry.hash !== fieldHash(entry.name)) {
      throw new TypeError('ORDER_MANAGEMENT_ALLOWLIST_INVALID');
    }
    if (Object.prototype.hasOwnProperty.call(source, entry.name)) {
      result[entry.name] = source[entry.name];
    }
  }
  return Object.freeze(result);
}

function isScalar(value) {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

function validateEntryArray(pageId, values, kind) {
  if (!Array.isArray(values)) return [`${kind} must be an array`];
  const errors = [];
  values.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${kind}[${index}] must be an object`);
      return;
    }
    const extraKeys = Object.keys(entry).filter((key) => !['name', 'value'].includes(key));
    if (extraKeys.length > 0) {
      errors.push(`${kind}[${index}] contains unsupported keys`);
      return;
    }
    const { name, value } = entry;
    if (typeof name !== 'string' || !name) {
      errors.push(`${kind}[${index}].name is required`);
      return;
    }
    try {
      assertAllowlistedFieldName(pageId, name);
    } catch {
      errors.push(`${kind}[${index}].name is not allowlisted`);
      return;
    }
    if (!isScalar(value)) {
      errors.push(`${kind}[${index}].value must be text or number`);
      return;
    }
    if (
      value !== null
      && typeof value !== 'number'
      && (containsNumericPii(value) || containsSensitiveText(value))
    ) {
      errors.push(`${kind}[${index}].value contains sensitive text`);
    }
  });
  return errors;
}

function nullableInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function validateOrderManagementRow(row, { pageId } = {}) {
  const errors = [];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { ok: false, errors: ['row must be an object'] };
  }
  for (const key of ORDER_MANAGEMENT_ROW_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) {
      errors.push(`row.${key} is required`);
    }
  }
  const extraKeys = Object.keys(row).filter((key) => !ORDER_MANAGEMENT_ROW_KEYS.includes(key));
  if (extraKeys.length > 0) errors.push('row contains unsupported keys');
  if (typeof row.id !== 'string' || !row.id) errors.push('row.id must be a non-empty string');
  if (typeof row.storeCode !== 'string' || !row.storeCode) {
    errors.push('row.storeCode must be a non-empty string');
  }
  if (row.statusCode !== null && row.statusCode !== undefined && typeof row.statusCode !== 'string') {
    errors.push('row.statusCode must be a string or null');
  }
  if (row.statusName !== null && row.statusName !== undefined && typeof row.statusName !== 'string') {
    errors.push('row.statusName must be a string or null');
  }
  if (row.primary !== null && row.primary !== undefined && typeof row.primary !== 'string') {
    errors.push('row.primary must be a string or null');
  }
  if (row.secondary !== null && row.secondary !== undefined && typeof row.secondary !== 'string') {
    errors.push('row.secondary must be a string or null');
  }
  if (!Array.isArray(row.tags) || row.tags.some((tag) => typeof tag !== 'string')) {
    errors.push('row.tags must be an array of strings');
  }
  for (const [location, value] of [
    ['row.statusName', row.statusName],
    ['row.primary', row.primary],
    ['row.secondary', row.secondary],
  ]) {
    if (value !== null && value !== undefined && containsSensitiveText(value)) {
      errors.push(`${location} contains sensitive text`);
    }
  }
  if (Array.isArray(row.tags) && row.tags.some((tag) => containsSensitiveText(tag))) {
    errors.push('row.tags contains sensitive text');
  }
  errors.push(...validateEntryArray(pageId, row.metrics, 'row.metrics'));
  errors.push(...validateEntryArray(pageId, row.facts, 'row.facts'));
  errors.push(...validateEntryArray(pageId, row.details, 'row.details'));
  if (row.createdAt !== null && row.createdAt !== undefined && nullableInstant(row.createdAt) === null) {
    errors.push('row.createdAt is not a valid instant');
  }
  if (row.updatedAt !== null && row.updatedAt !== undefined && nullableInstant(row.updatedAt) === null) {
    errors.push('row.updatedAt is not a valid instant');
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}

function isPageId(value) {
  return ORDER_MANAGEMENT_PAGE_IDS.includes(value);
}

/**
 * Full-index validation against the shared contract.
 */
export function validateOrderManagementIndex(index) {
  const errors = [];
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    return { ok: false, errors: ['index must be an object'] };
  }
  if (index.schemaVersion !== ORDER_MANAGEMENT_INDEX_VERSION) {
    errors.push('schemaVersion must be 1');
  }
  if (typeof index.updatedAt !== 'string' || Number.isNaN(Date.parse(index.updatedAt))) {
    errors.push('updatedAt must be an ISO instant');
  }
  const coverage = index.coverage;
  if (!coverage || typeof coverage !== 'object') {
    errors.push('coverage is required');
  } else {
    if (!ORDER_MANAGEMENT_COVERAGE_STATUSES.includes(coverage.status)) {
      errors.push(`coverage.status must be one of ${ORDER_MANAGEMENT_COVERAGE_STATUSES.join(', ')}`);
    }
    if (
      coverage.expectedStoreCount !== null
      && coverage.expectedStoreCount !== undefined
      && !Number.isSafeInteger(coverage.expectedStoreCount)
    ) {
      errors.push('coverage.expectedStoreCount must be an integer or null');
    }
    if (!Number.isSafeInteger(coverage.completedStoreCount)) {
      errors.push('coverage.completedStoreCount must be an integer');
    }
    if (!Array.isArray(coverage.storeCodes) || coverage.storeCodes.some((code) => typeof code !== 'string')) {
      errors.push('coverage.storeCodes must be an array of strings');
    }
    if (coverage.reason !== null && coverage.reason !== undefined && typeof coverage.reason !== 'string') {
      errors.push('coverage.reason must be a string or null');
    }
  }
  const pages = index.pages;
  if (!pages || typeof pages !== 'object' || Array.isArray(pages)) {
    errors.push('pages is required');
  } else {
    for (const pageId of ORDER_MANAGEMENT_PAGE_IDS) {
      const page = pages[pageId];
      if (!page || typeof page !== 'object') {
        errors.push(`pages.${pageId} is required`);
        continue;
      }
      if (!ORDER_MANAGEMENT_PAGE_STATUSES.includes(page.status)) {
        errors.push(`pages.${pageId}.status is invalid`);
      }
      if (typeof page.source !== 'string' || !page.source) {
        errors.push(`pages.${pageId}.source is required`);
      }
      if (page.latestSourceFetchedAt !== null
        && page.latestSourceFetchedAt !== undefined
        && (typeof page.latestSourceFetchedAt !== 'string'
          || Number.isNaN(Date.parse(page.latestSourceFetchedAt)))) {
        errors.push(`pages.${pageId}.latestSourceFetchedAt is invalid`);
      }
      if (page.reason !== null && page.reason !== undefined && typeof page.reason !== 'string') {
        errors.push(`pages.${pageId}.reason must be a string or null`);
      }
      if (page.status === 'UNAVAILABLE' && !page.reason) {
        errors.push(`pages.${pageId}.reason is required when status is UNAVAILABLE`);
      }
      if (!Array.isArray(page.rows)) {
        errors.push(`pages.${pageId}.rows must be an array`);
      } else {
        page.rows.forEach((row, index) => {
          const rowCheck = validateOrderManagementRow(row, { pageId });
          if (!rowCheck.ok) {
            rowCheck.errors.forEach((message) => {
              errors.push(`pages.${pageId}.rows[${index}] ${message}`);
            });
          }
        });
      }
    }
    for (const pageId of Object.keys(pages)) {
      if (!isPageId(pageId)) errors.push(`pages.${pageId} is not a fixed page id`);
    }
  }
  if (typeof index.promotable !== 'boolean') {
    errors.push('promotable must be a boolean');
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}

/**
 * Promotion gate.  The whole new index must not be promoted unless every page
 * is in a terminal state (AVAILABLE or UNAVAILABLE with a reason), the
 * coverage is COMPLETE over the full store roster and no gate failure is
 * recorded.  Any PARTIAL page or missing store blocks promotion.
 */
export function isOrderManagementPromotable(index) {
  if (!index || index.schemaVersion !== ORDER_MANAGEMENT_INDEX_VERSION) return false;
  if (index.promotable !== true) return false;
  if (index.coverage?.status !== 'COMPLETE') return false;
  return ORDER_MANAGEMENT_PAGE_IDS.every((pageId) => {
    const page = index.pages?.[pageId];
    if (!page) return false;
    if (page.status !== 'AVAILABLE') return false;
    return Array.isArray(page.rows);
  });
}
