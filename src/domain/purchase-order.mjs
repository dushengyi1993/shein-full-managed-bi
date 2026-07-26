export class PurchaseOrderDomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PurchaseOrderDomainError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new PurchaseOrderDomainError(code, message, details);
}

function record(value, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_FIELD', `${location} must be an object`, { location });
  }
  return value;
}

function optionalText(value, location) {
  if (value === undefined || value === null || value === '') return null;
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    fail('INVALID_FIELD', `${location} must be scalar text`, { location, value });
  }
  return String(value).trim() || null;
}

function requiredText(value, location) {
  const result = optionalText(value, location);
  if (!result) fail('MISSING_FIELD', `${location} is required`, { location });
  return result;
}

function quantity(value, location, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    fail('MISSING_FIELD', `${location} is required`, { location });
  }
  const normalized = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    fail('INVALID_QUANTITY', `${location} must be a non-negative safe integer`, {
      location,
      value,
    });
  }
  return normalized;
}

function sourceDate(value, location) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    fail('INVALID_DATE', `${location} must be a date-time string`, { location, value });
  }
  // SHEIN uses 1970-01-01 sentinels for events that have not happened.
  if (/^1970-01-01(?:\s|T)/.test(value)) return null;
  const localMatch = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  const zonedMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const match = localMatch ?? zonedMatch;
  if (!match) fail('INVALID_DATE', `${location} must be an official date-time value`);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() + 1 !== month
    || calendar.getUTCDate() !== day
    || calendar.getUTCHours() !== hour
    || calendar.getUTCMinutes() !== minute
    || calendar.getUTCSeconds() !== second
  ) {
    fail('INVALID_DATE', `${location} is not a valid calendar date-time`, {
      location,
      value,
    });
  }
  const withZone = localMatch ? `${value.replace(' ', 'T')}+08:00` : value;
  const date = new Date(withZone);
  if (Number.isNaN(date.valueOf())) {
    fail('INVALID_DATE', `${location} is not a valid date-time`, { location, value });
  }
  return date.toISOString();
}

function mapLine(value, location) {
  const row = record(value, location);
  const skuCode = optionalText(row.skuCode, `${location}.skuCode`);
  const skc = optionalText(row.skc, `${location}.skc`);
  const supplierCode = optionalText(row.supplierCode, `${location}.supplierCode`);
  if (!skuCode && !skc && !supplierCode) {
    fail(
      'MISSING_LINE_IDENTITY',
      `${location} requires skuCode, skc or supplierCode`,
      { location },
    );
  }
  return Object.freeze({
    skuCode,
    skc,
    supplierCode,
    supplierSku: optionalText(row.supplierSku, `${location}.supplierSku`),
    variantName: optionalText(row.suffixZh, `${location}.suffixZh`),
    needQuantity: quantity(row.needQuantity, `${location}.needQuantity`, { optional: true }),
    orderQuantity: quantity(row.orderQuantity, `${location}.orderQuantity`, { optional: true }),
    deliveryQuantity: quantity(
      row.deliveryQuantity,
      `${location}.deliveryQuantity`,
      { optional: true },
    ),
    receiptQuantity: quantity(
      row.receiptQuantity,
      `${location}.receiptQuantity`,
      { optional: true },
    ),
    storageQuantity: quantity(
      row.storageQuantity,
      `${location}.storageQuantity`,
      { optional: true },
    ),
    defectiveQuantity: quantity(
      row.defectiveQuantity,
      `${location}.defectiveQuantity`,
      { optional: true },
    ),
    requestDeliveryQuantity: quantity(
      row.requestDeliveryQuantity,
      `${location}.requestDeliveryQuantity`,
      { optional: true },
    ),
    noRequestDeliveryQuantity: quantity(
      row.noRequestDeliveryQuantity,
      `${location}.noRequestDeliveryQuantity`,
      { optional: true },
    ),
    alreadyDeliveryQuantity: quantity(
      row.alreadyDeliveryQuantity,
      `${location}.alreadyDeliveryQuantity`,
      { optional: true },
    ),
  });
}

function normalizeFetchedAt(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (
    (typeof value !== 'string' && !(value instanceof Date))
    || Number.isNaN(date.valueOf())
  ) {
    fail('INVALID_FETCHED_AT', 'fetchedAt must be a valid date-time');
  }
  return date.toISOString();
}

function relationRows(row, orderNo) {
  const mother = optionalText(
    row.jitMotherOrderNo ?? row.motherOrderNo ?? row.parentOrderNo,
    'purchaseOrder.jitMotherOrderNo',
  );
  const children = row.jitChildOrderNos ?? row.childOrderNos ?? [];
  if (children !== null && children !== undefined && !Array.isArray(children)) {
    fail('INVALID_FIELD', 'purchaseOrder.jitChildOrderNos must be an array');
  }
  const relations = [];
  if (mother && mother !== orderNo) {
    relations.push(Object.freeze({ motherOrderNo: mother, childOrderNo: orderNo }));
  }
  for (const child of children ?? []) {
    const childOrderNo = requiredText(child, 'purchaseOrder.jitChildOrderNos[]');
    if (childOrderNo !== orderNo) {
      relations.push(Object.freeze({ motherOrderNo: orderNo, childOrderNo }));
    }
  }
  return relations;
}

function relationScopes(row) {
  const hasMotherField = [
    'jitMotherOrderNo',
    'motherOrderNo',
    'parentOrderNo',
  ].some((field) => Object.hasOwn(row, field));
  const hasChildrenField = [
    'jitChildOrderNos',
    'childOrderNos',
  ].some((field) => Object.hasOwn(row, field));
  return Object.freeze([
    ...(hasMotherField ? ['AS_CHILD'] : []),
    ...(hasChildrenField ? ['AS_MOTHER'] : []),
  ]);
}

/**
 * Map one full-managed purchase order without retaining operator/contact data.
 * Unknown platform type/status codes are kept verbatim as strings.
 */
export function mapPurchaseOrder(value, { fetchedAt = new Date() } = {}) {
  const row = record(value, 'purchaseOrder');
  const orderNo = requiredText(row.orderNo, 'purchaseOrder.orderNo');
  const lineRows = row.orderExtends ?? [];
  if (!Array.isArray(lineRows)) {
    fail('INVALID_FIELD', 'purchaseOrder.orderExtends must be an array');
  }
  const jitRelations = relationRows(row, orderNo);
  const jitRelationScopes = relationScopes(row);
  return Object.freeze({
    orderNo,
    orderTypeCode: optionalText(row.type, 'purchaseOrder.type'),
    orderTypeName: optionalText(row.typeName, 'purchaseOrder.typeName'),
    statusCode: optionalText(row.status, 'purchaseOrder.status'),
    statusName: optionalText(row.statusName, 'purchaseOrder.statusName'),
    prepareTypeCode: optionalText(row.prepareTypeId, 'purchaseOrder.prepareTypeId'),
    prepareTypeName: optionalText(row.prepareTypeName, 'purchaseOrder.prepareTypeName'),
    categoryCode: optionalText(row.category, 'purchaseOrder.category'),
    categoryName: optionalText(row.categoryName, 'purchaseOrder.categoryName'),
    currencyCode: optionalText(row.currency, 'purchaseOrder.currency'),
    warehouseCode: optionalText(
      row.storageId ?? row.recommendedSubWarehouseId,
      'purchaseOrder.storageId',
    ),
    warehouseName: optionalText(row.warehouseName, 'purchaseOrder.warehouseName'),
    jitRoleCode: optionalText(
      row.isJitMother ?? row.isJitMotherName,
      'purchaseOrder.isJitMotherName',
    ),
    createdAt: sourceDate(row.addTime, 'purchaseOrder.addTime'),
    allocatedAt: sourceDate(row.allocateTime, 'purchaseOrder.allocateTime'),
    requestedDeliveryAt: sourceDate(
      row.requestDeliveryTime,
      'purchaseOrder.requestDeliveryTime',
    ),
    requestedReceiptAt: sourceDate(
      row.requestReceiptTime,
      'purchaseOrder.requestReceiptTime',
    ),
    deliveredAt: sourceDate(row.deliveryTime, 'purchaseOrder.deliveryTime'),
    receivedAt: sourceDate(row.receiptTime, 'purchaseOrder.receiptTime'),
    storedAt: sourceDate(row.storageTime, 'purchaseOrder.storageTime'),
    sourceUpdatedAt: sourceDate(row.updateTime, 'purchaseOrder.updateTime'),
    fetchedAt: normalizeFetchedAt(fetchedAt),
    lines: lineRows.map((line, index) => (
      mapLine(line, `purchaseOrder.orderExtends[${index}]`)
    )),
    linesComplete: true,
    jitRelations,
    jitRelationScopes,
    jitRelationsComplete: jitRelationScopes.length > 0,
  });
}

export function mapPurchaseOrderResponse(response, { fetchedAt = new Date() } = {}) {
  const body = record(response, 'response');
  if (String(body.code) !== '0') {
    fail(
      'OPENAPI_RESPONSE_ERROR',
      `purchase-order-infos failed with code ${String(body.code)}`,
      {
        platformCode: body.code === undefined ? null : String(body.code),
        platformMessage: optionalText(body.msg, 'response.msg'),
        traceId: optionalText(body.traceId, 'response.traceId'),
      },
    );
  }
  const info = record(body.info, 'response.info');
  if (!Array.isArray(info.list)) {
    fail('INVALID_FIELD', 'response.info.list must be an array');
  }
  const count = Number(info.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    fail('INVALID_FIELD', 'response.info.count must be a non-negative integer');
  }
  return Object.freeze({
    count,
    page: Number(info.pageNo ?? 1),
    pageSize: Number(info.pageSize ?? info.list.length),
    orders: info.list.map((order) => mapPurchaseOrder(order, { fetchedAt })),
    traceId: optionalText(body.traceId, 'response.traceId')?.slice(0, 128) ?? null,
  });
}
