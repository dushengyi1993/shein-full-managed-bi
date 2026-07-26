import { mapPurchaseOrderResponse } from '../domain/purchase-order.mjs';
import { SheinOpenApiError } from './shein-client.mjs';
import {
  fetchPageSequence,
  payloadFingerprint,
  requirePositiveInteger,
} from './paginated-fetch.mjs';

export const PURCHASE_ORDER_INFOS_PATH = '/open-api/order/purchase-order-infos';
export const MAX_PURCHASE_ORDER_PAGE_SIZE = 200;
export const MAX_PURCHASE_ORDER_WINDOW_DAYS = 60;

function normalizeList(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return [];
  const input = Array.isArray(value) ? value : String(value).split(',');
  const result = [];
  const seen = new Set();
  for (let index = 0; index < input.length; index += 1) {
    if (typeof input[index] !== 'string' || input[index].trim() === '') {
      throw new TypeError(`${name}[${index}] must be a non-empty string`);
    }
    const normalized = input[index].trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  if (result.length > maximum) {
    throw new TypeError(`${name} cannot contain more than ${maximum} values`);
  }
  return result;
}

function parseShanghaiDateTime(value, name) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must use YYYY-MM-DD HH:mm:ss`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new TypeError(`${name} must use YYYY-MM-DD HH:mm:ss`);
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
    throw new TypeError(`${name} is not a valid Asia/Shanghai calendar date-time`);
  }
  const date = new Date(`${value.replace(' ', 'T')}+08:00`);
  return date;
}

function validateWindow(startValue, endValue, prefix) {
  const hasStart = startValue !== undefined && startValue !== null && startValue !== '';
  const hasEnd = endValue !== undefined && endValue !== null && endValue !== '';
  if (hasStart !== hasEnd) {
    throw new TypeError(`${prefix}Start and ${prefix}End must be supplied together`);
  }
  if (!hasStart) return null;
  const start = parseShanghaiDateTime(startValue, `${prefix}Start`);
  const end = parseShanghaiDateTime(endValue, `${prefix}End`);
  if (end < start) throw new TypeError(`${prefix}End must not be before ${prefix}Start`);
  if (end.getTime() - start.getTime() > MAX_PURCHASE_ORDER_WINDOW_DAYS * 86_400_000) {
    throw new TypeError(`${prefix} window cannot exceed ${MAX_PURCHASE_ORDER_WINDOW_DAYS} days`);
  }
  return Object.freeze({ start: startValue, end: endValue });
}

function normalizedFetchedAt(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (
    (typeof value !== 'string' && !(value instanceof Date))
    || Number.isNaN(date.valueOf())
  ) {
    throw new TypeError('fetchedAt must be a valid date-time');
  }
  return date.toISOString();
}

/**
 * Fetch purchase orders by a bounded official query. Incremental callers must
 * provide their own overlapped update-time watermark; this module never moves
 * or narrows that watermark implicitly.
 */
export async function fetchFullManagedPurchaseOrders(client, {
  orderNos,
  skcs,
  supplierCodes,
  type,
  combineTimeStart,
  combineTimeEnd,
  updateTimeStart,
  updateTimeEnd,
  selectJitMother = 1,
  pageSize = 200,
  maxPages = 10_000,
  maxItems = 1_000_000,
  fetchedAt = new Date(),
} = {}) {
  requirePositiveInteger(pageSize, 'pageSize', MAX_PURCHASE_ORDER_PAGE_SIZE);
  const normalizedOrderNos = normalizeList(orderNos, 'orderNos', 200);
  const normalizedSkcs = normalizeList(skcs, 'skcs');
  const normalizedSupplierCodes = normalizeList(supplierCodes, 'supplierCodes');
  const combineWindow = validateWindow(combineTimeStart, combineTimeEnd, 'combineTime');
  const updateWindow = validateWindow(updateTimeStart, updateTimeEnd, 'updateTime');
  if (
    normalizedOrderNos.length === 0
    && normalizedSkcs.length === 0
    && normalizedSupplierCodes.length === 0
    && combineWindow === null
    && updateWindow === null
  ) {
    throw new TypeError(
      'purchase-order-infos requires an identifier filter or a bounded combine/update time window',
    );
  }
  if (type !== undefined && type !== null && ![1, 2].includes(Number(type))) {
    throw new TypeError('type must be 1 (urgent) or 2 (stock-up)');
  }
  if (![1, 2].includes(Number(selectJitMother))) {
    throw new TypeError('selectJitMother must be 1 or 2');
  }
  const observationTime = normalizedFetchedAt(fetchedAt);
  const baseQuery = {
    ...(normalizedOrderNos.length === 0 ? {} : { orderNos: normalizedOrderNos.join(',') }),
    ...(normalizedSkcs.length === 0 ? {} : { skcs: normalizedSkcs.join(',') }),
    ...(normalizedSupplierCodes.length === 0
      ? {}
      : { supplierCodes: normalizedSupplierCodes.join(',') }),
    ...(type === undefined || type === null ? {} : { type: Number(type) }),
    ...(combineWindow === null
      ? {}
      : {
          combineTimeStart: combineWindow.start,
          combineTimeEnd: combineWindow.end,
        }),
    ...(updateWindow === null
      ? {}
      : {
          updateTimeStart: updateWindow.start,
          updateTimeEnd: updateWindow.end,
        }),
    selectJitMother: Number(selectJitMother),
  };

  const result = await fetchPageSequence({
    pageSize,
    maxPages,
    maxItems,
    async fetchPage({ page }) {
      const response = await client.request(PURCHASE_ORDER_INFOS_PATH, {
        method: 'GET',
        query: { ...baseQuery, pageNumber: page, pageSize },
      });
      const mapped = mapPurchaseOrderResponse(response.data, { fetchedAt: observationTime });
      if (!Number.isSafeInteger(mapped.page) || mapped.page !== page) {
        throw new SheinOpenApiError(
          'PAGINATION_MISMATCH',
          'purchase-order-infos returned an unexpected page number',
          { requestedPage: page, responsePage: mapped.page },
        );
      }
      // The production endpoint resets info.count to 0 on the explicit empty
      // sentinel after an exact-multiple final page. Ignore only that empty
      // page count; fetchPageSequence retains the prior advertised total and
      // still rejects an early sentinel when accumulated rows are incomplete.
      if (mapped.orders.length === 0 && mapped.count === 0) {
        return Object.freeze({ ...mapped, count: null });
      }
      return mapped;
    },
    getItems: ({ orders }) => orders,
    getAdvertisedCount: ({ count }) => count,
    fingerprintItem: ({ orderNo, sourceUpdatedAt, statusCode, lines }) => ({
      orderNo,
      sourceUpdatedAt,
      statusCode,
      lines: lines.map(({ skuCode, skc, orderQuantity, storageQuantity }) => ({
        skuCode,
        skc,
        orderQuantity,
        storageQuantity,
      })),
    }),
  });

  return Object.freeze({
    orders: result.items,
    pages: result.pages,
    terminalReason: result.terminalReason,
    requestFingerprint: payloadFingerprint(baseQuery),
    incrementalStrategy: Object.freeze({
      watermarkField: 'updateTime',
      overlapAppliedByModule: false,
      callerSuppliedOverlap: updateWindow !== null,
      explanation: updateWindow === null
        ? 'This was not an update-watermark query.'
        : 'The exact caller-supplied update-time window was used; callers must overlap and deduplicate retries.',
    }),
  });
}
