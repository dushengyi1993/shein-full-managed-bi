import crypto from 'node:crypto';

import { SheinOpenApiError } from './shein-client.mjs';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function payloadFingerprint(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

export function requirePositiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function requireItems(value, page) {
  if (!Array.isArray(value)) {
    throw new SheinOpenApiError(
      'INVALID_RESPONSE_SHAPE',
      `page ${page} did not return an item array`,
      { page },
    );
  }
  return value;
}

/**
 * Fetch a page-number sequence without trusting an advertised total.
 *
 * A short or empty page is the terminal proof. A full page always causes one
 * more request, so an exact multiple is closed by an explicit empty page.
 * Repeating a non-empty page fingerprint fails closed instead of silently
 * producing an infinite or duplicated catalog.
 */
export async function fetchPageSequence({
  fetchPage,
  getItems,
  getAdvertisedCount = () => null,
  pageSize,
  startPage = 1,
  maxPages = 10_000,
  maxItems = 1_000_000,
  fingerprintItem = (item) => item,
} = {}) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function');
  if (typeof getItems !== 'function') throw new TypeError('getItems must be a function');
  if (typeof getAdvertisedCount !== 'function') {
    throw new TypeError('getAdvertisedCount must be a function');
  }
  requirePositiveInteger(pageSize, 'pageSize');
  requirePositiveInteger(startPage, 'startPage');
  requirePositiveInteger(maxPages, 'maxPages');
  requirePositiveInteger(maxItems, 'maxItems');

  const items = [];
  const pages = [];
  const seenPageFingerprints = new Map();
  let advertisedCount = null;

  for (let offset = 0; offset < maxPages; offset += 1) {
    const page = startPage + offset;
    const response = await fetchPage({ page, pageSize });
    const pageItems = requireItems(getItems(response, page), page);
    if (pageItems.length > pageSize) {
      throw new SheinOpenApiError(
        'PAGINATION_PAGE_OVERFLOW',
        `page ${page} returned more than the requested page size`,
        { page, pageSize, recordCount: pageItems.length },
      );
    }

    const observedCount = getAdvertisedCount(response, page);
    if (observedCount !== null && observedCount !== undefined) {
      if (!Number.isSafeInteger(observedCount) || observedCount < 0) {
        throw new SheinOpenApiError(
          'INVALID_RESPONSE_SHAPE',
          `page ${page} returned an invalid advertised count`,
          { page, advertisedCount: observedCount },
        );
      }
      if (advertisedCount !== null && advertisedCount !== observedCount) {
        throw new SheinOpenApiError(
          'PAGINATION_COUNT_DRIFT',
          'advertised count changed during pagination',
          { page, advertisedCount, observedCount },
        );
      }
      advertisedCount = observedCount;
    }

    const fingerprint = payloadFingerprint(pageItems.map(fingerprintItem));
    if (pageItems.length > 0) {
      const repeatedFrom = seenPageFingerprints.get(fingerprint);
      if (repeatedFrom !== undefined) {
        throw new SheinOpenApiError(
          'PAGINATION_REPEATED_PAGE',
          `page ${page} repeated the payload from page ${repeatedFrom}`,
          { page, repeatedFrom, fingerprint },
        );
      }
      seenPageFingerprints.set(fingerprint, page);
    }

    pages.push(Object.freeze({
      page,
      pageSize,
      recordCount: pageItems.length,
      responseFingerprint: fingerprint,
    }));
    items.push(...pageItems);
    if (items.length > maxItems) {
      throw new SheinOpenApiError(
        'PAGINATION_ITEM_LIMIT',
        'pagination exceeded the configured item safety limit',
        { page, maxItems },
      );
    }

    if (pageItems.length < pageSize) {
      if (advertisedCount !== null && items.length < advertisedCount) {
        throw new SheinOpenApiError(
          'PAGINATION_COUNT_MISMATCH',
          'a terminal page arrived before the advertised record count was reached',
          { page, advertisedCount, observedItems: items.length },
        );
      }
      return Object.freeze({
        items,
        pages,
        advertisedCount,
        terminalPage: page,
        terminalReason: pageItems.length === 0 ? 'EMPTY_PAGE' : 'SHORT_PAGE',
      });
    }
  }

  throw new SheinOpenApiError(
    'PAGINATION_LIMIT',
    'pagination did not reach a short or empty terminal page',
    { startPage, maxPages, pageSize },
  );
}
