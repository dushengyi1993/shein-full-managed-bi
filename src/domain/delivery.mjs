export class DeliveryDomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DeliveryDomainError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new DeliveryDomainError(code, message, details);
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
  const normalized = optionalText(value, location);
  if (!normalized) fail('MISSING_FIELD', `${location} is required`, { location });
  return normalized;
}

function quantity(value, location, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    fail('MISSING_FIELD', `${location} is required`);
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

function optionalNonNegativeNumber(value, location) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    fail('INVALID_NUMBER', `${location} must be a non-negative number`, {
      location,
      value,
    });
  }
  return normalized;
}

function sourceDate(value, location) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('INVALID_DATE', `${location} must be a date-time string`);
  if (/^1970-01-01(?:\s|T)/.test(value)) return null;
  const localMatch = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  const zonedMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const match = localMatch ?? zonedMatch;
  if (!match) fail('INVALID_DATE', `${location} must be an official date-time value`);
  const [, year, month, day, hour, minute, rawSecond] = match;
  const second = Number(rawSecond ?? 0);
  const parts = [year, month, day, hour, minute].map(Number);
  const calendar = new Date(Date.UTC(
    parts[0],
    parts[1] - 1,
    parts[2],
    parts[3],
    parts[4],
    second,
  ));
  if (
    calendar.getUTCFullYear() !== parts[0]
    || calendar.getUTCMonth() + 1 !== parts[1]
    || calendar.getUTCDate() !== parts[2]
    || calendar.getUTCHours() !== parts[3]
    || calendar.getUTCMinutes() !== parts[4]
    || calendar.getUTCSeconds() !== second
  ) {
    fail('INVALID_DATE', `${location} is not a valid calendar date-time`, {
      location,
      value,
    });
  }
  const normalizedLocal = localMatch && rawSecond === undefined ? `${value}:00` : value;
  const withZone = localMatch
    ? `${normalizedLocal.replace(' ', 'T')}+08:00`
    : value;
  const date = new Date(withZone);
  if (Number.isNaN(date.valueOf())) fail('INVALID_DATE', `${location} is invalid`);
  return date.toISOString();
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

function mapLine(value, location) {
  const row = record(value, location);
  return Object.freeze({
    orderNo: optionalText(row.orderNo, `${location}.orderNo`),
    skc: requiredText(row.skc, `${location}.skc`),
    skuCode: optionalText(row.skuCode, `${location}.skuCode`),
    deliveryQuantity: quantity(
      row.deliveryQuantity,
      `${location}.deliveryQuantity`,
      { optional: true },
    ),
  });
}

function safeConsolidation(value) {
  if (value === undefined || value === null) return null;
  const row = record(value, 'delivery.consolidationInfo');
  // Deliberately exclude address, person and phone from the domain object.
  return Object.freeze({
    carrierName: optionalText(row.carrierName, 'delivery.consolidationInfo.carrierName'),
    deliveryTypeCode: optionalText(
      row.deliveryType,
      'delivery.consolidationInfo.deliveryType',
    ),
    expressCode: optionalText(row.expressCode, 'delivery.consolidationInfo.expressCode'),
    expressId: optionalText(row.expressId, 'delivery.consolidationInfo.expressId'),
    thirdPartyChannelCode: optionalText(
      row.thirdPartyChannel,
      'delivery.consolidationInfo.thirdPartyChannel',
    ),
    thirdPartyOrderMethodCode: optionalText(
      row.thirdPartyOrderMethod,
      'delivery.consolidationInfo.thirdPartyOrderMethod',
    ),
    warehouseCode: optionalText(
      row.warehouseId,
      'delivery.consolidationInfo.warehouseId',
    ),
    warehouseName: optionalText(
      row.warehouseName,
      'delivery.consolidationInfo.warehouseName',
    ),
  });
}

export function mapDelivery(value, { fetchedAt = new Date() } = {}) {
  const row = record(value, 'delivery');
  const lineRows = row.deliveryOrderDataList ?? [];
  if (!Array.isArray(lineRows)) {
    fail('INVALID_FIELD', 'delivery.deliveryOrderDataList must be an array');
  }
  return Object.freeze({
    deliveryCode: requiredText(row.deliveryCode, 'delivery.deliveryCode'),
    deliveryTypeCode: optionalText(row.deliveryType, 'delivery.deliveryType'),
    deliveryTypeName: optionalText(row.deliveryTypeName, 'delivery.deliveryTypeName'),
    logisticsLabelPrintFlagCode: optionalText(
      row.logisticsLabelPrintFlag,
      'delivery.logisticsLabelPrintFlag',
    ),
    expressCode: optionalText(row.expressCode, 'delivery.expressCode'),
    expressCompanyCode: optionalText(row.expressId, 'delivery.expressId'),
    expressCompanyName: optionalText(
      row.expressCompanyName,
      'delivery.expressCompanyName',
    ),
    packageCount: row.sendPackage === null || row.sendPackage === undefined
      ? null
      : quantity(row.sendPackage, 'delivery.sendPackage'),
    packageWeight: optionalNonNegativeNumber(row.packageWeight, 'delivery.packageWeight'),
    warehouseCode: optionalText(row.supplierWarehouseId, 'delivery.supplierWarehouseId'),
    warehouseName: optionalText(
      row.supplierWarehouseName,
      'delivery.supplierWarehouseName',
    ),
    createdAt: sourceDate(row.addTime, 'delivery.addTime'),
    reservedParcelAt: sourceDate(row.reserveParcelTime, 'delivery.reserveParcelTime'),
    takenAt: sourceDate(row.takeParcelTime, 'delivery.takeParcelTime'),
    expectedReceiptAt: sourceDate(row.preReceiptTime, 'delivery.preReceiptTime'),
    receivedAt: sourceDate(row.receiptTime, 'delivery.receiptTime'),
    fetchedAt: normalizeFetchedAt(fetchedAt),
    consolidation: safeConsolidation(row.consolidationInfo),
    lines: lineRows.map((line, index) => (
      mapLine(line, `delivery.deliveryOrderDataList[${index}]`)
    )),
    linesComplete: true,
  });
}

export function mapDeliveryResponse(response, { fetchedAt = new Date() } = {}) {
  const body = record(response, 'response');
  if (String(body.code) !== '0') {
    fail('OPENAPI_RESPONSE_ERROR', `shipping/delivery failed with code ${String(body.code)}`, {
      platformCode: body.code === undefined ? null : String(body.code),
      platformMessage: optionalText(body.msg, 'response.msg'),
      traceId: optionalText(body.traceId, 'response.traceId'),
    });
  }
  const info = record(body.info, 'response.info');
  if (!Array.isArray(info.list)) fail('INVALID_FIELD', 'response.info.list must be an array');
  const count = Number(info.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    fail('INVALID_FIELD', 'response.info.count must be a non-negative integer');
  }
  return Object.freeze({
    count,
    deliveries: info.list.map((delivery) => mapDelivery(delivery, { fetchedAt })),
    traceId: optionalText(body.traceId, 'response.traceId')?.slice(0, 128) ?? null,
  });
}
