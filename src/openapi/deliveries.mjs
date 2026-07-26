import { mapDeliveryResponse } from '../domain/delivery.mjs';
import {
  fetchPageSequence,
  payloadFingerprint,
  requirePositiveInteger,
} from './paginated-fetch.mjs';

export const DELIVERY_QUERY_PATH = '/open-api/shipping/delivery';
export const MAX_DELIVERY_PAGE_SIZE = 200;

function normalizeDateTime(value, name) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must use a valid YYYY-MM-DD HH:mm:ss value`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new TypeError(`${name} must use a valid YYYY-MM-DD HH:mm:ss value`);
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
  return value;
}

function normalizeFetchedAt(value) {
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
 * Fetch delivery rows. The official endpoint filters only by creation time,
 * not update time, so callers must repeatedly look back over a creation window
 * and rely on repository idempotency to capture late status changes.
 */
export async function fetchFullManagedDeliveries(client, {
  deliveryCode,
  startTime,
  endTime,
  pageSize = 200,
  maxPages = 10_000,
  maxItems = 1_000_000,
  fetchedAt = new Date(),
} = {}) {
  requirePositiveInteger(pageSize, 'pageSize', MAX_DELIVERY_PAGE_SIZE);
  const normalizedDeliveryCode = deliveryCode === undefined
    || deliveryCode === null
    || deliveryCode === ''
    ? null
    : String(deliveryCode).trim();
  const hasStart = startTime !== undefined && startTime !== null && startTime !== '';
  const hasEnd = endTime !== undefined && endTime !== null && endTime !== '';
  if (hasStart !== hasEnd) {
    throw new TypeError('startTime and endTime must be supplied together');
  }
  if (!normalizedDeliveryCode && !hasStart) {
    throw new TypeError(
      'shipping/delivery requires deliveryCode or a bounded creation-time window',
    );
  }
  const creationWindow = hasStart
    ? Object.freeze({
        start: normalizeDateTime(startTime, 'startTime'),
        end: normalizeDateTime(endTime, 'endTime'),
      })
    : null;
  if (
    creationWindow
    && new Date(`${creationWindow.end.replace(' ', 'T')}+08:00`)
      < new Date(`${creationWindow.start.replace(' ', 'T')}+08:00`)
  ) {
    throw new TypeError('endTime must not be before startTime');
  }
  const baseQuery = {
    ...(normalizedDeliveryCode ? { deliveryCode: normalizedDeliveryCode } : {}),
    ...(creationWindow
      ? { startTime: creationWindow.start, endTime: creationWindow.end }
      : {}),
  };
  const observationTime = normalizeFetchedAt(fetchedAt);
  const result = await fetchPageSequence({
    pageSize,
    maxPages,
    maxItems,
    async fetchPage({ page }) {
      const response = await client.request(DELIVERY_QUERY_PATH, {
        method: 'GET',
        query: { ...baseQuery, page, perPage: pageSize },
      });
      return mapDeliveryResponse(response.data, { fetchedAt: observationTime });
    },
    getItems: ({ deliveries }) => deliveries,
    getAdvertisedCount: ({ count }) => count,
    fingerprintItem: ({ deliveryCode: code, createdAt, receivedAt, lines }) => ({
      deliveryCode: code,
      createdAt,
      receivedAt,
      lines: lines.map(({ orderNo, skuCode, skc, deliveryQuantity }) => ({
        orderNo,
        skuCode,
        skc,
        deliveryQuantity,
      })),
    }),
  });
  return Object.freeze({
    deliveries: result.items,
    pages: result.pages,
    terminalReason: result.terminalReason,
    requestFingerprint: payloadFingerprint(baseQuery),
    incrementalStrategy: Object.freeze({
      mode: normalizedDeliveryCode
        ? 'POINT_LOOKUP'
        : 'ROLLING_CREATION_TIME_LOOKBACK_REQUIRED',
      filterField: 'addTime',
      supportsUpdateTimeFilter: false,
      callerMustOverlap: normalizedDeliveryCode === null,
      explanation: normalizedDeliveryCode
        ? 'A delivery-code point lookup was used.'
        : 'The endpoint exposes only creation-time filtering; repeat an overlapped creation window and upsert newer source observations.',
    }),
  });
}
