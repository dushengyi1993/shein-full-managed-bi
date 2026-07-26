/**
 * Domain rules for SHEIN's full-managed SKU sales endpoint.
 *
 * Official source: API detail 3001305, `/open-api/goods/query-sku-sales`.
 * This module deliberately models quantities only. Amounts, orders and profit
 * do not belong to this snapshot.
 */

export const MAX_SKUS_PER_SALES_QUERY = 100;

export class SkuSalesDomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SkuSalesDomainError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SkuSalesDomainError(code, message, details);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireRecord(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_FIELD', `${path} must be an object`, { path, value });
  }

  return value;
}

function requireNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('INVALID_FIELD', `${path} must be a non-empty string`, { path, value });
  }

  return value.trim();
}

function requireField(record, field, path) {
  if (!hasOwn(record, field) || record[field] === undefined || record[field] === null) {
    fail('MISSING_FIELD', `${path}.${field} is required`, {
      path: `${path}.${field}`,
    });
  }

  return record[field];
}

function requireNonNegativeInteger(record, field, path, skuCode) {
  const fieldPath = `${path}.${field}`;
  const value = requireField(record, field, path);

  if (!Number.isSafeInteger(value)) {
    fail('INVALID_SALES_COUNT', `${fieldPath} must be a safe integer`, {
      path: fieldPath,
      skuCode,
      value,
    });
  }

  if (value < 0) {
    fail('NEGATIVE_SALES_COUNT', `${fieldPath} cannot be negative`, {
      path: fieldPath,
      skuCode,
      value,
    });
  }

  return value;
}

function normalizeStatisticsDate(value, path, skuCode) {
  if (typeof value === 'string' && value.trim() === '') {
    fail(
      'STATISTICS_DATE_UNAVAILABLE',
      `${path} is empty; permission may be granted but this response cannot be loaded as dated sales facts`,
      { path, skuCode },
    );
  }
  const compactDate = requireNonEmptyString(value, path);
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(compactDate);

  if (!match) {
    fail('INVALID_STATISTICS_DATE', `${path} must use yyyyMMdd format`, {
      path,
      skuCode,
      value,
    });
  }

  const [, year, month, day] = match;
  const normalized = `${year}-${month}-${day}`;
  const date = new Date(`${normalized}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    fail('INVALID_STATISTICS_DATE', `${path} is not a valid calendar date`, {
      path,
      skuCode,
      value,
    });
  }

  return normalized;
}

function normalizeStatisticsDateForMode(
  value,
  path,
  skuCode,
  { allowEmptyStatisticsDate = false } = {},
) {
  if (
    allowEmptyStatisticsDate
    && typeof value === 'string'
    && value.trim() === ''
  ) {
    return null;
  }
  return normalizeStatisticsDate(value, path, skuCode);
}

function normalizeFetchedAt(value) {
  if (!(value instanceof Date) && typeof value !== 'string') {
    fail('INVALID_FETCHED_AT', 'fetchedAt must be a Date or ISO date-time string', {
      path: 'fetchedAt',
      value,
    });
  }

  if (typeof value === 'string' && value.trim() === '') {
    fail('INVALID_FETCHED_AT', 'fetchedAt must not be empty', {
      path: 'fetchedAt',
      value,
    });
  }

  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    fail('INVALID_FETCHED_AT', 'fetchedAt must be a valid date-time', {
      path: 'fetchedAt',
      value,
    });
  }

  return date.toISOString();
}

/**
 * Trim and deduplicate SKU codes while retaining first-seen order.
 *
 * @param {unknown} skuCodes
 * @returns {string[]}
 */
export function deduplicateSkuCodes(skuCodes) {
  if (!Array.isArray(skuCodes)) {
    fail('INVALID_SKU_LIST', 'skuCodes must be an array', { value: skuCodes });
  }

  const seen = new Set();
  const uniqueSkuCodes = [];

  skuCodes.forEach((rawSkuCode, index) => {
    if (typeof rawSkuCode !== 'string' || rawSkuCode.trim() === '') {
      fail('INVALID_SKU_CODE', `skuCodes[${index}] must be a non-empty string`, {
        index,
        value: rawSkuCode,
      });
    }

    const skuCode = rawSkuCode.trim();
    if (!seen.has(skuCode)) {
      seen.add(skuCode);
      uniqueSkuCodes.push(skuCode);
    }
  });

  return uniqueSkuCodes;
}

/**
 * Build endpoint request bodies after deduplication. Every request body obeys
 * the official maximum of 100 SKU codes.
 *
 * @param {unknown} skuCodes
 * @returns {{skuCodeList: string[]}[]}
 */
export function createSkuSalesQueryBatches(skuCodes) {
  const uniqueSkuCodes = deduplicateSkuCodes(skuCodes);
  const batches = [];

  for (let offset = 0; offset < uniqueSkuCodes.length; offset += MAX_SKUS_PER_SALES_QUERY) {
    batches.push({
      skuCodeList: uniqueSkuCodes.slice(offset, offset + MAX_SKUS_PER_SALES_QUERY),
    });
  }

  return batches;
}

function normalizeSkuSalesResponseRows({
  requestedSkuCodes,
  response,
  allowEmptyStatisticsDate = false,
} = {}) {
  const requested = deduplicateSkuCodes(requestedSkuCodes);

  if (requested.length === 0) {
    fail('EMPTY_REQUESTED_SKU_LIST', 'requestedSkuCodes must contain at least one SKU');
  }

  if (requested.length > MAX_SKUS_PER_SALES_QUERY) {
    fail(
      'TOO_MANY_REQUESTED_SKUS',
      `one response can cover at most ${MAX_SKUS_PER_SALES_QUERY} requested SKUs`,
      { count: requested.length, maximum: MAX_SKUS_PER_SALES_QUERY },
    );
  }

  const responseRecord = requireRecord(response, 'response');
  const code = requireField(responseRecord, 'code', 'response');
  if (code !== '0') {
    fail('OPENAPI_RESPONSE_ERROR', `SHEIN SKU sales query failed with code ${String(code)}`, {
      code,
      message: responseRecord.msg,
      traceId: responseRecord.traceId,
    });
  }

  const info = requireRecord(requireField(responseRecord, 'info', 'response'), 'response.info');
  const dataList = requireField(info, 'dataList', 'response.info');
  if (!Array.isArray(dataList)) {
    fail('INVALID_FIELD', 'response.info.dataList must be an array', {
      path: 'response.info.dataList',
      value: dataList,
    });
  }

  const requestedSet = new Set(requested);
  const rowsBySku = new Map();

  dataList.forEach((rawItem, index) => {
    const itemPath = `response.info.dataList[${index}]`;
    const item = requireRecord(rawItem, itemPath);
    const skuCode = requireNonEmptyString(
      requireField(item, 'skuCode', itemPath),
      `${itemPath}.skuCode`,
    );

    if (!requestedSet.has(skuCode)) {
      fail('UNEXPECTED_RESPONSE_SKU', `response contains unrequested SKU ${skuCode}`, {
        skuCode,
        path: `${itemPath}.skuCode`,
      });
    }

    if (rowsBySku.has(skuCode)) {
      fail('DUPLICATE_RESPONSE_SKU', `response contains duplicate SKU ${skuCode}`, {
        skuCode,
        path: `${itemPath}.skuCode`,
      });
    }

    rowsBySku.set(skuCode, {
      skuCode,
      salesToday: requireNonNegativeInteger(item, 'realTimeSaleCnt', itemPath, skuCode),
      salesYesterday: requireNonNegativeInteger(item, 'cydSaleCnt', itemPath, skuCode),
      sales7Days: requireNonNegativeInteger(item, 'c7dSaleCnt', itemPath, skuCode),
      sales30Days: requireNonNegativeInteger(item, 'c30dSaleCnt', itemPath, skuCode),
      statisticsDate: normalizeStatisticsDateForMode(
        requireField(item, 'dt', itemPath),
        `${itemPath}.dt`,
        skuCode,
        { allowEmptyStatisticsDate },
      ),
    });
  });

  const missingSkuCodes = requested.filter((skuCode) => !rowsBySku.has(skuCode));
  if (missingSkuCodes.length > 0) {
    fail(
      'MISSING_REQUESTED_SKU',
      `response omitted ${missingSkuCodes.length} requested SKU(s): ${missingSkuCodes.join(', ')}`,
      { missingSkuCodes },
    );
  }

  return requested.map((skuCode) => rowsBySku.get(skuCode));
}

/**
 * Validate that a successful response proves the sales endpoint can be used.
 *
 * SHEIN's current official example and live response can return an explicit
 * empty `dt`. Permission probing accepts only that exact degraded shape while
 * preserving the strict mapper for any warehouse-bound sales snapshot.
 */
export function inspectSkuSalesResponseForPermissionProbe({
  requestedSkuCodes,
  response,
} = {}) {
  const rows = normalizeSkuSalesResponseRows({
    requestedSkuCodes,
    response,
    allowEmptyStatisticsDate: true,
  });
  const missingStatisticsDateCount = rows.filter(
    ({ statisticsDate }) => statisticsDate === null,
  ).length;
  return {
    recordCount: rows.length,
    statisticsDateAvailable: missingStatisticsDateCount === 0,
    missingStatisticsDateCount,
  };
}

/**
 * Convert one successful official response into complete sales snapshots.
 *
 * `requestedSkuCodes` is mandatory so an omitted response item is observable;
 * a missing SKU is an error and is never materialized as zero sales.
 *
 * @param {object} input
 * @param {string} input.storeCode
 * @param {unknown} input.requestedSkuCodes
 * @param {Date|string} input.fetchedAt
 * @param {unknown} input.response
 * @returns {{storeCode: string, skuCode: string, salesToday: number,
 *   salesYesterday: number, sales7Days: number, sales30Days: number,
 *   statisticsDate: string, fetchedAt: string}[]}
 */
export function mapSkuSalesResponseToSnapshots({
  storeCode,
  requestedSkuCodes,
  fetchedAt,
  response,
} = {}) {
  const normalizedStoreCode = requireNonEmptyString(storeCode, 'storeCode');
  const normalizedFetchedAt = normalizeFetchedAt(fetchedAt);
  return normalizeSkuSalesResponseRows({ requestedSkuCodes, response }).map((row) => ({
    storeCode: normalizedStoreCode,
    ...row,
    fetchedAt: normalizedFetchedAt,
  }));
}
