#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Pool } from 'pg';

import {
  fullManagedStoreCallBlock,
  loadFullManagedConfig,
  summarizeFullManagedConfig,
} from '../src/openapi/full-managed-config.mjs';
import { SheinOpenApiClient } from '../src/openapi/shein-client.mjs';
import {
  fetchFullManagedProductCatalog,
  fetchFullManagedProductDetails,
} from '../src/openapi/product-catalog.mjs';
import { fetchFullManagedInventory } from '../src/openapi/inventory.mjs';
import { fetchFullManagedStockAdvice } from '../src/openapi/stock-advice.mjs';
import { fetchFullManagedPurchaseOrders } from '../src/openapi/purchase-orders.mjs';
import { fetchFullManagedDeliveries } from '../src/openapi/deliveries.mjs';
import { payloadFingerprint } from '../src/openapi/paginated-fetch.mjs';
import {
  loadFullManagedSupplySnapshot,
  recordFullManagedSupplySyncAttempt,
} from '../src/warehouse/supply-repository.mjs';

export const DEFAULT_SUPPLY_DOMAINS = Object.freeze([
  'product-catalog',
  'product-details',
  'inventory:PI',
  'inventory:JI',
  'stock-advice',
  'purchase-orders',
  'deliveries',
]);

export const SUPPLY_SYNC_MODES = Object.freeze({
  INCREMENTAL: 'INCREMENTAL',
  BACKFILL: 'BACKFILL',
});

const PURCHASE_ORDER_BACKFILL_WINDOW_DAYS = 60;
const DELIVERY_BACKFILL_WINDOW_DAYS = 30;
const MAX_PENDING_DELIVERY_CODES = 10_000;

const DOMAIN_ALIASES = Object.freeze({
  all: DEFAULT_SUPPLY_DOMAINS,
  products: Object.freeze(['product-catalog', 'product-details']),
  // Full-managed stores expose SHEIN physical stock (PI) and JIT stock (JI).
  // VI is merchant-managed virtual stock and remains an explicit diagnostic
  // domain; it is not a required full-managed production grain.
  inventory: Object.freeze(['inventory:PI', 'inventory:JI']),
  'inventory-pi': Object.freeze(['inventory:PI']),
  'inventory-vi': Object.freeze(['inventory:VI']),
  'inventory-ji': Object.freeze(['inventory:JI']),
});

const PRIMARY_SNAPSHOT_FIELDS = Object.freeze({
  'product-catalog': 'productCatalog',
  'product-details': 'productDetails',
  'stock-advice': 'stockAdvice',
  'purchase-orders': 'purchaseOrders',
  deliveries: 'deliveries',
});

const ATTEMPT_DOMAIN_MAP = Object.freeze({
  'product-catalog': Object.freeze({ domain: 'productCatalog', subtype: 'ALL' }),
  'product-details': Object.freeze({ domain: 'productDetails', subtype: 'ALL' }),
  'inventory:PI': Object.freeze({ domain: 'inventory', subtype: 'PI' }),
  'inventory:VI': Object.freeze({ domain: 'inventory', subtype: 'VI' }),
  'inventory:JI': Object.freeze({ domain: 'inventory', subtype: 'JI' }),
  'stock-advice': Object.freeze({ domain: 'stockAdvice', subtype: 'ALL' }),
  'purchase-orders': Object.freeze({ domain: 'purchaseOrders', subtype: 'ALL' }),
  deliveries: Object.freeze({ domain: 'deliveries', subtype: 'ALL' }),
});

const SUPPLY_FETCH_RETRY_DELAYS_MS = Object.freeze([250, 750]);

const DEFAULT_OPERATIONS = Object.freeze({
  fetchProductCatalog: fetchFullManagedProductCatalog,
  fetchProductDetails: fetchFullManagedProductDetails,
  fetchInventory: fetchFullManagedInventory,
  fetchStockAdvice: fetchFullManagedStockAdvice,
  fetchPurchaseOrders: fetchFullManagedPurchaseOrders,
  fetchDeliveries: fetchFullManagedDeliveries,
  loadSnapshot: loadFullManagedSupplySnapshot,
  recordAttempt: recordFullManagedSupplySyncAttempt,
  readActiveSkuUniverse: readActiveFullManagedSkuUniverse,
  readPendingDeliveryCodes,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
});

function nonEmptyFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
    throw new TypeError(`${flag} requires a value`);
  }
  return value.trim();
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  const result = {};
  const supported = new Set([
    '--config',
    '--database-url',
    '--stores',
    '--domains',
    '--now',
    '--run-id',
    '--mode',
    '--backfill-start',
    '--backfill-end',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!supported.has(flag)) throw new TypeError(`Unknown argument: ${String(flag)}`);
    const key = flag.slice(2);
    if (Object.hasOwn(result, key)) throw new TypeError(`${flag} was supplied more than once`);
    result[key] = nonEmptyFlagValue(argv, index, flag);
    index += 1;
  }
  return result;
}

function uniqueCsv(value, location, normalize = (entry) => entry) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${location} must be comma-separated text`);
  const result = [];
  const seen = new Set();
  for (const raw of value.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const entry = normalize(trimmed);
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  if (result.length === 0) throw new TypeError(`${location} must contain at least one value`);
  return result;
}

export function normalizeSupplyDomains(value) {
  const requested = uniqueCsv(value, 'domains', (entry) => entry.toLowerCase())
    ?? [...DEFAULT_SUPPLY_DOMAINS];
  const expanded = [];
  const seen = new Set();
  for (const token of requested) {
    const alias = DOMAIN_ALIASES[token];
    const normalized = alias ?? (
      /^inventory:(pi|vi|ji)$/i.test(token)
        ? [`inventory:${token.slice(token.indexOf(':') + 1).toUpperCase()}`]
        : [token]
    );
    for (const domain of normalized) {
      if (!DEFAULT_SUPPLY_DOMAINS.includes(domain)) {
        throw new TypeError(`Unsupported supply domain: ${token}`);
      }
      if (!seen.has(domain)) {
        seen.add(domain);
        expanded.push(domain);
      }
    }
  }
  return expanded;
}

function normalizeNow(value = new Date()) {
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    if (!Number.isNaN(copy.valueOf())) return copy;
  }
  if (
    typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed;
  }
  throw new TypeError('now must be an ISO-8601 date-time with an explicit offset');
}

function formatShanghaiDateTime(value) {
  const shanghaiClock = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  return shanghaiClock.toISOString().slice(0, 19).replace('T', ' ');
}

export function computeSupplyWindows(now = new Date()) {
  const current = normalizeNow(now);
  const purchaseOrderStart = new Date(current.getTime() - 48 * 60 * 60 * 1000);
  const deliveryStart = new Date(current.getTime() - 14 * 24 * 60 * 60 * 1000);
  return Object.freeze({
    sourceFetchedAt: current.toISOString(),
    purchaseOrders: Object.freeze({
      mode: SUPPLY_SYNC_MODES.INCREMENTAL,
      field: 'updateTime',
      overlapHours: 48,
      start: formatShanghaiDateTime(purchaseOrderStart),
      end: formatShanghaiDateTime(current),
      timezone: 'Asia/Shanghai',
      windows: Object.freeze([Object.freeze({
        start: formatShanghaiDateTime(purchaseOrderStart),
        end: formatShanghaiDateTime(current),
      })]),
      completeRequestedRange: true,
      completeHistoricalCoverage: false,
    }),
    deliveries: Object.freeze({
      mode: SUPPLY_SYNC_MODES.INCREMENTAL,
      field: 'addTime',
      rollingLookbackDays: 14,
      start: formatShanghaiDateTime(deliveryStart),
      end: formatShanghaiDateTime(current),
      timezone: 'Asia/Shanghai',
      supportsUpdateTimeFilter: false,
      pendingPointLookup: true,
      pendingOlderThan: deliveryStart.toISOString(),
      windows: Object.freeze([Object.freeze({
        start: formatShanghaiDateTime(deliveryStart),
        end: formatShanghaiDateTime(current),
      })]),
      completeRequestedRange: true,
      completeHistoricalCoverage: false,
    }),
  });
}

function normalizeMode(value) {
  const normalized = value === undefined || value === null || value === ''
    ? SUPPLY_SYNC_MODES.INCREMENTAL
    : String(value).trim().toUpperCase();
  if (!Object.values(SUPPLY_SYNC_MODES).includes(normalized)) {
    throw new TypeError('mode must be incremental or backfill');
  }
  return normalized;
}

function splitBackfillWindows(start, end, maximumDays) {
  if (!(start instanceof Date) || !(end instanceof Date) || end <= start) {
    throw new TypeError('backfill-start must be before the backfill end');
  }
  const result = [];
  let cursor = new Date(start.getTime());
  const maximumMilliseconds = maximumDays * 24 * 60 * 60 * 1000;
  while (cursor < end) {
    const windowEnd = new Date(Math.min(
      cursor.getTime() + maximumMilliseconds,
      end.getTime(),
    ));
    result.push(Object.freeze({
      start: formatShanghaiDateTime(cursor),
      end: formatShanghaiDateTime(windowEnd),
    }));
    cursor = windowEnd;
  }
  return Object.freeze(result);
}

/**
 * Build the fetch plan.
 *
 * `now` is always the real observation instant and is the only source of
 * `sourceFetchedAt`. In BACKFILL mode `backfillStart` and `backfillEnd` define
 * the exact requested history range, which is a separate concept: replaying an
 * old range must not claim that the warehouse observed it at that old instant.
 * `backfillEnd` defaults to `now` so an existing caller keeps its behaviour.
 */
export function computeSupplyPlan({
  now = new Date(),
  mode = SUPPLY_SYNC_MODES.INCREMENTAL,
  backfillStart,
  backfillEnd,
} = {}) {
  const current = normalizeNow(now);
  const normalizedMode = normalizeMode(mode);
  const hasBackfillStart = backfillStart !== undefined
    && backfillStart !== null
    && backfillStart !== '';
  const hasBackfillEnd = backfillEnd !== undefined
    && backfillEnd !== null
    && backfillEnd !== '';
  if (normalizedMode === SUPPLY_SYNC_MODES.INCREMENTAL) {
    if (hasBackfillStart) {
      throw new TypeError('backfill-start is only valid with mode=backfill');
    }
    if (hasBackfillEnd) {
      throw new TypeError('backfill-end is only valid with mode=backfill');
    }
    return computeSupplyWindows(current);
  }
  if (!hasBackfillStart) {
    throw new TypeError('backfill-start is required with mode=backfill');
  }
  const start = normalizeNow(backfillStart);
  // Default to the observation instant: without an explicit end, the requested
  // history range runs up to now, exactly as before this flag existed.
  const end = hasBackfillEnd ? normalizeNow(backfillEnd) : current;
  if (end <= start) {
    throw new TypeError('backfill-end must be after backfill-start');
  }
  if (end > current) {
    throw new TypeError('backfill-end must not be after now');
  }
  const purchaseOrderWindows = splitBackfillWindows(
    start,
    end,
    PURCHASE_ORDER_BACKFILL_WINDOW_DAYS,
  );
  const deliveryWindows = splitBackfillWindows(
    start,
    end,
    DELIVERY_BACKFILL_WINDOW_DAYS,
  );
  return Object.freeze({
    // The real fetch instant, never the requested history boundary.
    sourceFetchedAt: current.toISOString(),
    backfillStart: formatShanghaiDateTime(start),
    backfillEnd: formatShanghaiDateTime(end),
    backfillEndExplicit: hasBackfillEnd,
    timezone: 'Asia/Shanghai',
    purchaseOrders: Object.freeze({
      mode: SUPPLY_SYNC_MODES.BACKFILL,
      field: 'updateTime',
      maximumWindowDays: PURCHASE_ORDER_BACKFILL_WINDOW_DAYS,
      start: formatShanghaiDateTime(start),
      end: formatShanghaiDateTime(end),
      timezone: 'Asia/Shanghai',
      windows: purchaseOrderWindows,
      completeRequestedRange: true,
      completeHistoricalCoverage: false,
    }),
    deliveries: Object.freeze({
      mode: SUPPLY_SYNC_MODES.BACKFILL,
      field: 'addTime',
      maximumWindowDays: DELIVERY_BACKFILL_WINDOW_DAYS,
      start: formatShanghaiDateTime(start),
      end: formatShanghaiDateTime(end),
      timezone: 'Asia/Shanghai',
      supportsUpdateTimeFilter: false,
      pendingPointLookup: false,
      pendingOlderThan: null,
      windows: deliveryWindows,
      completeRequestedRange: true,
      completeHistoricalCoverage: false,
    }),
  });
}

function defaultRunId(now) {
  return `supply-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

function normalizeBaseRunId(value, now) {
  const runId = value ?? defaultRunId(now);
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._:-]{8,70}$/.test(runId)) {
    throw new TypeError('run-id must contain 8-70 safe identifier characters');
  }
  return runId;
}

function selectStores(configStores, requestedValue) {
  const requested = uniqueCsv(
    requestedValue,
    'stores',
    (entry) => entry.toUpperCase(),
  );
  if (requested === null) {
    const eligible = configStores.filter((store) => fullManagedStoreCallBlock(store) === null);
    if (eligible.length === 0) {
      throw new Error('No enabled, approved and authorized full-managed store is eligible');
    }
    return eligible;
  }
  const byCode = new Map(configStores.map((store) => [store.storeCode, store]));
  const unknown = requested.filter((storeCode) => !byCode.has(storeCode));
  if (unknown.length > 0) throw new TypeError(`Unknown store code(s): ${unknown.join(', ')}`);
  return requested.map((storeCode) => byCode.get(storeCode));
}

function safeErrorCode(error, fallback) {
  const candidate = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  return /^[A-Z0-9_]{3,80}$/.test(candidate) ? candidate : fallback;
}

export function isRetryableSupplyFetchError(error) {
  const code = safeErrorCode(error, '');
  if (['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'PAGINATION_COUNT_DRIFT'].includes(code)) {
    return true;
  }
  if (code !== 'HTTP_ERROR') return false;
  const httpStatus = Number(error?.details?.httpStatus);
  return Number.isInteger(httpStatus)
    && (httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599));
}

export async function fetchSupplyDomainWithRetry(
  operation,
  {
    sleep = DEFAULT_OPERATIONS.sleep,
    retryDelaysMs = SUPPLY_FETCH_RETRY_DELAYS_MS,
  } = {},
) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
  if (
    !Array.isArray(retryDelaysMs)
    || retryDelaysMs.some((delayMs) => !Number.isSafeInteger(delayMs) || delayMs < 0)
  ) {
    throw new TypeError('retryDelaysMs must contain non-negative safe integers');
  }

  let attemptCount = 0;
  while (true) {
    attemptCount += 1;
    try {
      return Object.freeze({
        ok: true,
        value: await operation(),
        attemptCount,
        retryCount: attemptCount - 1,
      });
    } catch (error) {
      const retryCount = attemptCount - 1;
      if (!isRetryableSupplyFetchError(error) || attemptCount > retryDelaysMs.length) {
        return Object.freeze({
          ok: false,
          error,
          attemptCount,
          retryCount,
        });
      }
      await sleep(retryDelaysMs[retryCount]);
    }
  }
}

function attemptWindow(domain, windows) {
  const source = domain === 'purchase-orders'
    ? windows.purchaseOrders
    : domain === 'deliveries'
      ? windows.deliveries
      : null;
  if (!source?.start || !source?.end) return null;
  return Object.freeze({
    start: `${source.start.replace(' ', 'T')}+08:00`,
    end: `${source.end.replace(' ', 'T')}+08:00`,
  });
}

function attemptDescriptor(storeRunId, domain, windows) {
  const mapped = ATTEMPT_DOMAIN_MAP[domain];
  if (!mapped) throw new TypeError(`Unsupported attempt domain ${domain}`);
  return Object.freeze({
    uiDomain: domain,
    attemptId: `${storeRunId}:${domain.replace(':', '-')}`,
    domain: mapped.domain,
    subtype: mapped.subtype,
    window: attemptWindow(domain, windows),
  });
}

async function startSupplyAttempts({
  pool,
  operations,
  store,
  storeRunId,
  domains,
  windows,
  mode,
}) {
  const attempts = [];
  try {
    for (const domain of domains) {
      const descriptor = attemptDescriptor(storeRunId, domain, windows);
      await operations.recordAttempt(pool, {
        store,
        ...descriptor,
        uiDomain: undefined,
        mode,
        freshnessScope: mode === SUPPLY_SYNC_MODES.BACKFILL ? 'BACKFILL' : 'LIVE',
        status: 'STARTED',
        startedAt: windows.sourceFetchedAt,
      });
      attempts.push(descriptor);
    }
  } catch (error) {
    error.startedSupplyAttempts = attempts;
    throw error;
  }
  return attempts;
}

function terminalAttemptStatus(domainResult) {
  if (
    domainResult?.status === 'loaded'
    && domainResult.coverageStatus !== 'PARTIAL'
  ) {
    return Object.freeze({
      status: 'SUCCEEDED',
      errorCode: null,
      errorReason: null,
    });
  }
  if (
    domainResult?.status === 'not_applicable'
    && domainResult.reasonCode === 'AUTHORITATIVE_SKU_UNIVERSE_EMPTY'
  ) {
    return Object.freeze({
      status: 'SUCCEEDED',
      errorCode: null,
      errorReason: null,
    });
  }
  const partial = (
    domainResult?.coverageStatus === 'PARTIAL'
    || domainResult?.status === 'blocked_by_dependency'
  );
  const errorCode = partial
    ? domainResult?.reasonCode ?? domainResult?.errorCode ?? 'PARTIAL_COVERAGE'
    : domainResult?.errorCode ?? 'DOMAIN_SYNC_INCOMPLETE';
  return Object.freeze({
    status: partial ? 'PARTIAL' : 'FAILED',
    errorCode,
    errorReason: partial
      ? 'The read-only domain did not have complete authoritative coverage.'
      : 'The read-only domain fetch or warehouse readback did not complete.',
  });
}

async function finishSupplyAttempts({
  pool,
  operations,
  store,
  attempts,
  windows,
  mode,
  storeResult,
}) {
  for (const attempt of attempts) {
    const domainResult = storeResult.domains.find(
      ({ domain }) => domain === attempt.uiDomain,
    ) ?? null;
    const terminal = terminalAttemptStatus(domainResult);
    const requestedCount = Number.isSafeInteger(domainResult?.requestedCount)
      ? domainResult.requestedCount
      : null;
    const observedCount = Number.isSafeInteger(domainResult?.observedCount)
      ? domainResult.observedCount
      : Number.isSafeInteger(domainResult?.recordCount)
        ? domainResult.recordCount
        : null;
    await operations.recordAttempt(pool, {
      store,
      attemptId: attempt.attemptId,
      domain: attempt.domain,
      subtype: attempt.subtype,
      mode,
      freshnessScope: mode === SUPPLY_SYNC_MODES.BACKFILL ? 'BACKFILL' : 'LIVE',
      window: attempt.window,
      requestedCount,
      observedCount,
      status: terminal.status,
      errorCode: terminal.errorCode,
      errorReason: terminal.errorReason,
      startedAt: windows.sourceFetchedAt,
      completedAt: windows.sourceFetchedAt,
    });
  }
}

function makeDomainResult(domain, status, evidence = {}) {
  return {
    domain,
    status,
    ...evidence,
  };
}

function setDomainResult(storeResult, result) {
  const index = storeResult.domains.findIndex(({ domain }) => domain === result.domain);
  if (index === -1) storeResult.domains.push(result);
  else storeResult.domains[index] = result;
}

function catalogSkuCodes(catalog) {
  const result = [];
  const seen = new Set();
  for (const product of catalog.products) {
    for (const skuCode of product.skuCodes) {
      if (!seen.has(skuCode)) {
        seen.add(skuCode);
        result.push(skuCode);
      }
    }
  }
  return result;
}

function chunks(values, size) {
  const result = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

/**
 * Read the inventory request universe from the latest accepted number-list
 * membership, never from the product enrichment endpoint. The run evidence and
 * membership are observed in one repeatable-read transaction so a concurrent
 * sales refresh cannot produce a mixed universe.
 */
export async function readActiveFullManagedSkuUniverse(pool, {
  storeCode,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('pool.connect is required for the authoritative SKU universe');
  }
  if (typeof storeCode !== 'string' || !/^[A-Z0-9_-]{1,24}$/.test(storeCode)) {
    throw new TypeError('storeCode is invalid');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const runResult = await client.query(
      `SELECT
         run.sales_sync_run_id,
         run.run_key,
         run.status,
         run.quality_status,
         run.requested_sku_count,
         run.source_fetched_at
       FROM ops.sales_sync_run AS run
       JOIN dim.store AS store ON store.store_id = run.store_id
       WHERE store.store_code = $1
         AND store.cooperation_mode = 'FULL_MANAGED'
         AND store.is_active = true
       ORDER BY run.source_fetched_at DESC, run.sales_sync_run_id DESC
       LIMIT 1`,
      [storeCode],
    );
    if (!Array.isArray(runResult?.rows)) {
      throw new TypeError('sales membership evidence query returned invalid rows');
    }
    if (runResult.rows.length === 0) {
      await client.query('COMMIT');
      return Object.freeze({
        status: 'UNAVAILABLE',
        reasonCode: 'SALES_MEMBERSHIP_EVIDENCE_MISSING',
        skuCodes: Object.freeze([]),
        evidenceRunId: null,
        evidenceSourceFetchedAt: null,
      });
    }
    const evidence = runResult.rows[0];
    if (!['SUCCEEDED', 'QUALITY_BLOCKED'].includes(evidence.status)) {
      await client.query('COMMIT');
      return Object.freeze({
        status: 'UNAVAILABLE',
        reasonCode: 'LATEST_SALES_MEMBERSHIP_RUN_NOT_ACCEPTED',
        skuCodes: Object.freeze([]),
        evidenceRunId: String(evidence.run_key ?? evidence.sales_sync_run_id),
        evidenceSourceFetchedAt: new Date(evidence.source_fetched_at).toISOString(),
      });
    }
    const skuResult = await client.query(
      `SELECT sku.platform_sku_id
       FROM dim.full_sku AS sku
       JOIN dim.store AS store ON store.store_id = sku.store_id
       WHERE store.store_code = $1
         AND store.cooperation_mode = 'FULL_MANAGED'
         AND store.is_active = true
         AND sku.is_active = true
       ORDER BY sku.platform_sku_id`,
      [storeCode],
    );
    if (!Array.isArray(skuResult?.rows)) {
      throw new TypeError('active SKU membership query returned invalid rows');
    }
    const skuCodes = [];
    const seen = new Set();
    for (const row of skuResult.rows) {
      const skuCode = typeof row?.platform_sku_id === 'string'
        ? row.platform_sku_id.trim()
        : '';
      if (!skuCode || seen.has(skuCode)) {
        throw new Error('Active SKU membership contains an empty or duplicate identifier');
      }
      seen.add(skuCode);
      skuCodes.push(skuCode);
    }
    const requestedCount = Number(evidence.requested_sku_count);
    if (!Number.isSafeInteger(requestedCount) || requestedCount < 0) {
      throw new TypeError('sales membership evidence has an invalid requested SKU count');
    }
    if (requestedCount !== skuCodes.length) {
      const error = new Error(
        'Active SKU membership does not match the latest number-list evidence',
      );
      error.code = 'SALES_MEMBERSHIP_COUNT_DRIFT';
      throw error;
    }
    await client.query('COMMIT');
    return Object.freeze({
      status: 'AVAILABLE',
      reasonCode: null,
      skuCodes: Object.freeze(skuCodes),
      evidenceRunId: String(evidence.run_key ?? evidence.sales_sync_run_id),
      evidenceSourceFetchedAt: new Date(evidence.source_fetched_at).toISOString(),
      evidenceStatus: evidence.status,
      evidenceQualityStatus: evidence.quality_status,
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function readPendingDeliveryCodes(pool, {
  storeCode,
  olderThan,
  limit = MAX_PENDING_DELIVERY_CODES,
} = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('pool.query is required for pending delivery point lookups');
  }
  if (typeof storeCode !== 'string' || !/^[A-Z0-9_-]{1,24}$/.test(storeCode)) {
    throw new TypeError('storeCode is invalid');
  }
  const boundary = normalizeNow(olderThan).toISOString();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING_DELIVERY_CODES) {
    throw new TypeError(`limit must be from 1 to ${MAX_PENDING_DELIVERY_CODES}`);
  }
  const result = await pool.query(
    `SELECT delivery.delivery_code
     FROM fact.delivery AS delivery
     JOIN dim.store AS store ON store.store_id = delivery.store_id
     WHERE store.store_code = $1
       AND delivery.received_at IS NULL
       AND (
         delivery.platform_created_at IS NULL
         OR delivery.platform_created_at < $2::timestamptz
       )
     ORDER BY delivery.source_fetched_at ASC, delivery.delivery_code
     LIMIT $3`,
    [storeCode, boundary, limit + 1],
  );
  if (!Array.isArray(result?.rows)) {
    throw new TypeError('pending delivery query returned invalid rows');
  }
  if (result.rows.length > limit) {
    const error = new Error(
      `Pending delivery point lookup exceeds the safety limit of ${limit}`,
    );
    error.code = 'PENDING_DELIVERY_LIMIT';
    throw error;
  }
  const codes = [];
  const seen = new Set();
  for (const row of result.rows) {
    const code = typeof row?.delivery_code === 'string'
      ? row.delivery_code.trim()
      : '';
    if (!code) {
      const error = new Error('Pending delivery query returned an empty delivery code');
      error.code = 'INVALID_PENDING_DELIVERY_CODE';
      throw error;
    }
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  return codes;
}

function renumberPages(results) {
  const pages = [];
  for (const result of results) {
    for (const page of result.pages ?? []) {
      pages.push(Object.freeze({
        ...page,
        page: pages.length + 1,
        requestFingerprint: page.requestFingerprint ?? result.requestFingerprint,
      }));
    }
  }
  return pages;
}

function laterSourceRow(left, right, fields) {
  for (const field of fields) {
    const leftTime = left?.[field] ? new Date(left[field]).valueOf() : Number.NEGATIVE_INFINITY;
    const rightTime = right?.[field] ? new Date(right[field]).valueOf() : Number.NEGATIVE_INFINITY;
    if (rightTime > leftTime) return right;
    if (leftTime > rightTime) return left;
  }
  return right;
}

function mergePurchaseOrderResults(results, plan) {
  const byOrderNo = new Map();
  for (const result of results) {
    for (const order of result.orders) {
      const previous = byOrderNo.get(order.orderNo);
      byOrderNo.set(
        order.orderNo,
        previous
          ? laterSourceRow(previous, order, ['sourceUpdatedAt', 'fetchedAt'])
          : order,
      );
    }
  }
  const orders = [...byOrderNo.values()];
  return Object.freeze({
    orders,
    pages: renumberPages(results),
    terminalReason: 'ALL_WINDOWS_REACHED_TERMINAL_PAGE',
    requestFingerprint: payloadFingerprint({
      mode: plan.mode,
      windows: plan.windows,
      requests: results.map(({ requestFingerprint }) => requestFingerprint),
    }),
    incrementalStrategy: Object.freeze({
      mode: plan.mode,
      watermarkField: 'updateTime',
      windows: plan.windows,
      windowCount: plan.windows.length,
      completeRequestedRange: plan.completeRequestedRange,
      completeHistoricalCoverage: plan.completeHistoricalCoverage,
      callerSuppliedOverlap: plan.mode === SUPPLY_SYNC_MODES.INCREMENTAL,
      maximumWindowDays: plan.maximumWindowDays ?? null,
      explanation: plan.mode === SUPPLY_SYNC_MODES.BACKFILL
        ? 'Explicit backfill covered the requested update-time range in windows of at most 60 days.'
        : 'Incremental mode used the exact caller-computed 48-hour Asia/Shanghai overlap window.',
    }),
  });
}

function mergeDeliveryResults(results, plan, pendingDeliveryCodes) {
  const byDeliveryCode = new Map();
  for (const result of results) {
    for (const delivery of result.deliveries) {
      const previous = byDeliveryCode.get(delivery.deliveryCode);
      byDeliveryCode.set(
        delivery.deliveryCode,
        previous
          ? laterSourceRow(previous, delivery, ['fetchedAt', 'receivedAt', 'takenAt'])
          : delivery,
      );
    }
  }
  const deliveries = [...byDeliveryCode.values()];
  return Object.freeze({
    deliveries,
    pages: renumberPages(results),
    terminalReason: 'ALL_WINDOWS_AND_POINT_LOOKUPS_COMPLETED',
    requestFingerprint: payloadFingerprint({
      mode: plan.mode,
      windows: plan.windows,
      pendingPointLookupCount: pendingDeliveryCodes.length,
      requests: results.map(({ requestFingerprint }) => requestFingerprint),
    }),
    incrementalStrategy: Object.freeze({
      mode: plan.mode,
      filterField: 'addTime',
      windows: plan.windows,
      windowCount: plan.windows.length,
      completeRequestedRange: plan.completeRequestedRange,
      completeHistoricalCoverage: plan.completeHistoricalCoverage,
      supportsUpdateTimeFilter: false,
      pendingPointLookup: plan.pendingPointLookup,
      pendingOlderThan: plan.pendingOlderThan,
      pendingPointLookupCount: pendingDeliveryCodes.length,
      maximumWindowDays: plan.maximumWindowDays ?? null,
      explanation: plan.mode === SUPPLY_SYNC_MODES.BACKFILL
        ? 'Explicit backfill covered the requested creation-time range in bounded windows.'
        : 'Incremental mode combined a 14-day rolling creation window with point lookups for older deliveries still unreceived in the warehouse.',
    }),
  });
}

async function fetchPurchaseOrderPlan(client, operations, plan, {
  pageSize,
  fetchedAt,
}) {
  const results = [];
  for (const window of plan.windows) {
    results.push(await operations.fetchPurchaseOrders(client, {
      updateTimeStart: window.start,
      updateTimeEnd: window.end,
      pageSize,
      fetchedAt,
    }));
  }
  return mergePurchaseOrderResults(results, plan);
}

async function fetchDeliveryPlan(client, pool, operations, store, plan, {
  pageSize,
  fetchedAt,
}) {
  const results = [];
  for (const window of plan.windows) {
    results.push(await operations.fetchDeliveries(client, {
      startTime: window.start,
      endTime: window.end,
      pageSize,
      fetchedAt,
    }));
  }
  let pendingDeliveryCodes = [];
  if (plan.pendingPointLookup) {
    pendingDeliveryCodes = await operations.readPendingDeliveryCodes(pool, {
      storeCode: store.storeCode,
      olderThan: plan.pendingOlderThan,
      limit: MAX_PENDING_DELIVERY_CODES,
    });
    for (const deliveryCode of pendingDeliveryCodes) {
      const pointResult = await operations.fetchDeliveries(client, {
        deliveryCode,
        pageSize,
        fetchedAt,
      });
      if (pointResult.deliveries.length !== 1) {
        const error = new Error(
          `Point lookup did not resolve pending delivery ${deliveryCode}`,
        );
        error.code = 'PENDING_DELIVERY_POINT_LOOKUP_MISSING';
        throw error;
      }
      results.push(pointResult);
    }
  }
  return mergeDeliveryResults(results, plan, pendingDeliveryCodes);
}

function mergeInventoryBatches(inventoryType, requestedCodes, batches, sourceFetchedAt) {
  const items = [];
  const seenSkuCodes = new Set();
  const missingCodes = [];
  for (const batch of batches) {
    for (const item of batch.items) {
      if (seenSkuCodes.has(item.skuCode)) {
        const error = new Error(`stock-query returned duplicate SKU ${item.skuCode} across batches`);
        error.code = 'DUPLICATE_RESPONSE_SKU';
        throw error;
      }
      seenSkuCodes.add(item.skuCode);
      items.push(item);
    }
    missingCodes.push(...batch.coverage.missingCodes);
  }
  const missing = [...new Set(missingCodes)];
  return Object.freeze({
    queryDimension: 'SKU',
    requestedCodes: [...requestedCodes],
    inventoryType,
    fetchedAt: sourceFetchedAt,
    items,
    shortages: items
      .filter(({ totalOutOfStockQty }) => totalOutOfStockQty !== null && totalOutOfStockQty > 0)
      .map(({ skuCode, totalOutOfStockQty }) => Object.freeze({
        skuCode,
        shortageQuantity: totalOutOfStockQty,
      })),
    coverage: Object.freeze({
      status: missing.length === 0 ? 'COMPLETE' : 'PARTIAL',
      requestedCount: requestedCodes.length,
      observedCount: requestedCodes.length - missing.length,
      missingCodes: missing,
      explanation: missing.length === 0
        ? 'Every requested SKU was present in successful stock-query batches.'
        : 'SHEIN omitted requested SKUs; they remain unknown and were not converted to zero inventory.',
    }),
    traceIds: batches.map(({ traceId }) => traceId).filter(Boolean),
    requestFingerprint: payloadFingerprint({
      queryDimension: 'SKU',
      inventoryType,
      requestedCodes,
      batchFingerprints: batches.map(({ requestFingerprint }) => requestFingerprint),
    }),
  });
}

function countForPrimaryDomain(domain, value) {
  if (domain === 'product-catalog') return value.products.length;
  if (domain === 'product-details') return value.details.length;
  if (domain === 'stock-advice') return value.advice.length;
  if (domain === 'purchase-orders') return value.orders.length;
  if (domain === 'deliveries') return value.deliveries.length;
  return null;
}

async function loadPrimarySnapshot({
  pool,
  operations,
  store,
  storeRunId,
  sourceFetchedAt,
  snapshot,
  storeResult,
}) {
  const fields = Object.keys(snapshot);
  if (fields.length === 0) return;
  try {
    const loaded = await operations.loadSnapshot(pool, {
      store,
      runId: storeRunId,
      sourceFetchedAt,
      ...snapshot,
    });
    for (const [domain, field] of Object.entries(PRIMARY_SNAPSHOT_FIELDS)) {
      if (!Object.hasOwn(snapshot, field)) continue;
      const prior = storeResult.domains.find((entry) => entry.domain === domain);
      const { domain: _domain, status: _status, ...priorEvidence } = prior ?? {};
      setDomainResult(storeResult, makeDomainResult(domain, 'loaded', {
        ...priorEvidence,
        recordCount: prior?.recordCount ?? null,
      }));
    }
    storeResult.warehouseLoads.push({
      runId: storeRunId,
      domains: fields,
      counts: Object.fromEntries(
        Object.entries(loaded)
          .filter(([, value]) => Number.isSafeInteger(value))
          .map(([key, value]) => [key, value]),
      ),
    });
  } catch (error) {
    const errorCode = safeErrorCode(error, 'WAREHOUSE_LOAD_ERROR');
    for (const [domain, field] of Object.entries(PRIMARY_SNAPSHOT_FIELDS)) {
      if (!Object.hasOwn(snapshot, field)) continue;
      const prior = storeResult.domains.find((entry) => entry.domain === domain);
      const { domain: _domain, status: _status, ...priorEvidence } = prior ?? {};
      setDomainResult(storeResult, makeDomainResult(domain, 'load_error', {
        ...priorEvidence,
        errorCode,
      }));
    }
  }
}

async function fetchAndLoadInventory({
  client,
  pool,
  operations,
  store,
  storeRunId,
  sourceFetchedAt,
  skuCodes,
  inventoryType,
  storeResult,
}) {
  const domain = `inventory:${inventoryType}`;
  let inventory;
  try {
    const batches = [];
    for (const skuBatch of chunks(skuCodes, 100)) {
      batches.push(await operations.fetchInventory(client, {
        skuCodeList: skuBatch,
        invType: inventoryType,
        fetchedAt: sourceFetchedAt,
      }));
    }
    inventory = mergeInventoryBatches(
      inventoryType,
      skuCodes,
      batches,
      sourceFetchedAt,
    );
    setDomainResult(storeResult, makeDomainResult(domain, 'fetched', {
      reasonCode: skuCodes.length === 0
        ? 'AUTHORITATIVE_SKU_UNIVERSE_EMPTY'
        : null,
      inventoryType,
      requestedCount: inventory.coverage.requestedCount,
      observedCount: inventory.coverage.observedCount,
      missingCount: inventory.coverage.missingCodes.length,
      coverageStatus: inventory.coverage.status,
      batchCount: batches.length,
    }));
  } catch (error) {
    setDomainResult(storeResult, makeDomainResult(domain, 'fetch_error', {
      inventoryType,
      errorCode: safeErrorCode(error, 'INVENTORY_FETCH_ERROR'),
    }));
    return;
  }

  const inventoryRunId = `${storeRunId}:inventory:${inventoryType}`;
  try {
    const loaded = await operations.loadSnapshot(pool, {
      store,
      runId: inventoryRunId,
      sourceFetchedAt,
      inventory,
    });
    setDomainResult(storeResult, makeDomainResult(domain, 'loaded', {
      reasonCode: skuCodes.length === 0
        ? 'AUTHORITATIVE_SKU_UNIVERSE_EMPTY'
        : null,
      inventoryType,
      requestedCount: inventory.coverage.requestedCount,
      observedCount: inventory.coverage.observedCount,
      missingCount: inventory.coverage.missingCodes.length,
      coverageStatus: inventory.coverage.status,
      batchCount: Math.ceil(skuCodes.length / 100),
    }));
    storeResult.warehouseLoads.push({
      runId: inventoryRunId,
      domains: [`inventory:${inventoryType}`],
      counts: Object.fromEntries(
        Object.entries(loaded)
          .filter(([, value]) => Number.isSafeInteger(value))
          .map(([key, value]) => [key, value]),
      ),
    });
  } catch (error) {
    setDomainResult(storeResult, makeDomainResult(domain, 'load_error', {
      inventoryType,
      errorCode: safeErrorCode(error, 'WAREHOUSE_LOAD_ERROR'),
      requestedCount: inventory.coverage.requestedCount,
      observedCount: inventory.coverage.observedCount,
      missingCount: inventory.coverage.missingCodes.length,
      coverageStatus: inventory.coverage.status,
    }));
  }
}

async function syncStore({
  config,
  store,
  domains,
  windows,
  baseRunId,
  pool,
  clientFactory,
  operations,
}) {
  const storeRunId = `${baseRunId}:${store.storeCode}`;
  const storeResult = {
    storeCode: store.storeCode,
    runId: storeRunId,
    status: 'running',
    domains: [],
    warehouseLoads: [],
  };
  const blockReason = fullManagedStoreCallBlock(store);
  if (blockReason) {
    storeResult.status = 'skipped';
    storeResult.reasonCode = blockReason;
    return storeResult;
  }

  const client = clientFactory({
    baseUrl: config.baseUrl,
    openKeyId: store.openKeyId,
    secretKey: store.secretKey,
    timeoutMs: config.timeoutMs,
    allowFakeBaseUrl: config.allowFakeBaseUrl,
  });
  const sourceFetchedAt = windows.sourceFetchedAt;
  const selected = new Set(domains);
  const inventoryTypes = domains
    .filter((domain) => domain.startsWith('inventory:'))
    .map((domain) => domain.split(':')[1]);
  const needsCatalog = selected.has('product-catalog')
    || selected.has('product-details');
  const primarySnapshot = {};
  let catalog = null;
  let catalogSkuCodeList = [];
  let activeSkuUniverse = null;

  if (inventoryTypes.length > 0) {
    try {
      activeSkuUniverse = await operations.readActiveSkuUniverse(pool, {
        storeCode: store.storeCode,
      });
      if (
        !activeSkuUniverse
        || !['AVAILABLE', 'UNAVAILABLE'].includes(activeSkuUniverse.status)
        || !Array.isArray(activeSkuUniverse.skuCodes)
      ) {
        throw new TypeError('authoritative SKU universe result is invalid');
      }
    } catch (error) {
      activeSkuUniverse = Object.freeze({
        status: 'UNAVAILABLE',
        reasonCode: safeErrorCode(error, 'SALES_MEMBERSHIP_READ_ERROR'),
        skuCodes: Object.freeze([]),
      });
    }
  }

  if (needsCatalog) {
    try {
      catalog = await operations.fetchProductCatalog(client, {
        pageSize: config.pageSize,
      });
      catalogSkuCodeList = catalogSkuCodes(catalog);
      const activeSkuSet = new Set(activeSkuUniverse?.skuCodes ?? []);
      const catalogSkuSet = new Set(catalogSkuCodeList);
      const catalogMissingSalesMembershipSkuCount = activeSkuUniverse?.status === 'AVAILABLE'
        ? activeSkuUniverse.skuCodes.filter((skuCode) => !catalogSkuSet.has(skuCode)).length
        : null;
      const catalogOutsideSalesMembershipSkuCount = activeSkuUniverse?.status === 'AVAILABLE'
        ? catalogSkuCodeList.filter((skuCode) => !activeSkuSet.has(skuCode)).length
        : null;
      primarySnapshot.productCatalog = catalog;
      setDomainResult(storeResult, makeDomainResult('product-catalog', 'fetched', {
        recordCount: catalog.products.length,
        observedCount: catalogSkuCodeList.length,
        skuCount: catalogSkuCodeList.length,
        terminalReason: catalog.terminalReason,
        requested: selected.has('product-catalog'),
        dependency: !selected.has('product-catalog'),
        catalogMissingSalesMembershipSkuCount,
        catalogOutsideSalesMembershipSkuCount,
        // product/query is complete only after two identical, terminal-page
        // sweeps. A difference from number-list is a cross-source scope
        // reconciliation result, not evidence that either source was truncated.
        coverageStatus: 'COMPLETE',
        membershipReconciliationStatus: (
          Number.isSafeInteger(catalogMissingSalesMembershipSkuCount)
          && Number.isSafeInteger(catalogOutsideSalesMembershipSkuCount)
          && (
            catalogMissingSalesMembershipSkuCount > 0
            || catalogOutsideSalesMembershipSkuCount > 0
          )
        )
          ? 'SOURCE_SCOPE_DIFFERENCE'
          : 'MATCHED',
      }));
    } catch (error) {
      setDomainResult(storeResult, makeDomainResult('product-catalog', 'fetch_error', {
        errorCode: safeErrorCode(error, 'PRODUCT_CATALOG_FETCH_ERROR'),
      }));
    }
  }

  if (selected.has('product-details')) {
    if (catalog === null) {
      setDomainResult(storeResult, makeDomainResult(
        'product-details',
        'blocked_by_dependency',
        { reasonCode: 'PRODUCT_CATALOG_UNAVAILABLE' },
      ));
    } else {
      try {
        const details = await operations.fetchProductDetails(client, {
          skuCodes: catalogSkuCodeList,
          language: 'zh-cn',
        });
        primarySnapshot.productDetails = details;
        setDomainResult(storeResult, makeDomainResult('product-details', 'fetched', {
          recordCount: details.details.length,
          requestedCount: catalogSkuCodeList.length,
          observedCount: details.details.length,
          coverageStatus: details.details.length === catalogSkuCodeList.length
            ? 'COMPLETE'
            : 'PARTIAL',
          batchCount: details.batches.length,
        }));
      } catch (error) {
        setDomainResult(storeResult, makeDomainResult('product-details', 'fetch_error', {
          errorCode: safeErrorCode(error, 'PRODUCT_DETAILS_FETCH_ERROR'),
        }));
      }
    }
  }

  if (selected.has('stock-advice')) {
    const stockAdviceAttempt = await fetchSupplyDomainWithRetry(
      () => operations.fetchStockAdvice(client, {
        pageSize: Math.min(config.pageSize, 20),
        fetchedAt: sourceFetchedAt,
      }),
      { sleep: operations.sleep },
    );
    if (stockAdviceAttempt.ok) {
      const advice = stockAdviceAttempt.value;
      primarySnapshot.stockAdvice = advice;
      setDomainResult(storeResult, makeDomainResult('stock-advice', 'fetched', {
        recordCount: countForPrimaryDomain('stock-advice', advice),
        pageCount: advice.pages.length,
        terminalReason: advice.terminalReason,
        attemptCount: stockAdviceAttempt.attemptCount,
        retryCount: stockAdviceAttempt.retryCount,
      }));
    } else {
      setDomainResult(storeResult, makeDomainResult('stock-advice', 'fetch_error', {
        errorCode: safeErrorCode(stockAdviceAttempt.error, 'STOCK_ADVICE_FETCH_ERROR'),
        attemptCount: stockAdviceAttempt.attemptCount,
        retryCount: stockAdviceAttempt.retryCount,
      }));
    }
  }

  if (selected.has('purchase-orders')) {
    const purchaseOrderAttempt = await fetchSupplyDomainWithRetry(
      () => fetchPurchaseOrderPlan(
        client,
        operations,
        windows.purchaseOrders,
        {
          pageSize: Math.min(config.pageSize, 200),
          fetchedAt: sourceFetchedAt,
        },
      ),
      { sleep: operations.sleep },
    );
    if (purchaseOrderAttempt.ok) {
      const purchaseOrders = purchaseOrderAttempt.value;
      primarySnapshot.purchaseOrders = purchaseOrders;
      setDomainResult(storeResult, makeDomainResult('purchase-orders', 'fetched', {
        recordCount: countForPrimaryDomain('purchase-orders', purchaseOrders),
        pageCount: purchaseOrders.pages.length,
        terminalReason: purchaseOrders.terminalReason,
        mode: windows.purchaseOrders.mode,
        window: windows.purchaseOrders,
        attemptCount: purchaseOrderAttempt.attemptCount,
        retryCount: purchaseOrderAttempt.retryCount,
      }));
    } else {
      setDomainResult(storeResult, makeDomainResult('purchase-orders', 'fetch_error', {
        errorCode: safeErrorCode(purchaseOrderAttempt.error, 'PURCHASE_ORDER_FETCH_ERROR'),
        window: windows.purchaseOrders,
        attemptCount: purchaseOrderAttempt.attemptCount,
        retryCount: purchaseOrderAttempt.retryCount,
      }));
    }
  }

  if (selected.has('deliveries')) {
    try {
      const deliveries = await fetchDeliveryPlan(
        client,
        pool,
        operations,
        store,
        windows.deliveries,
        {
        pageSize: Math.min(config.pageSize, 200),
        fetchedAt: sourceFetchedAt,
        },
      );
      primarySnapshot.deliveries = deliveries;
      setDomainResult(storeResult, makeDomainResult('deliveries', 'fetched', {
        recordCount: countForPrimaryDomain('deliveries', deliveries),
        pageCount: deliveries.pages.length,
        terminalReason: deliveries.terminalReason,
        mode: windows.deliveries.mode,
        pendingPointLookupCount:
          deliveries.incrementalStrategy.pendingPointLookupCount,
        window: windows.deliveries,
      }));
    } catch (error) {
      setDomainResult(storeResult, makeDomainResult('deliveries', 'fetch_error', {
        errorCode: safeErrorCode(error, 'DELIVERY_FETCH_ERROR'),
        window: windows.deliveries,
      }));
    }
  }

  await loadPrimarySnapshot({
    pool,
    operations,
    store,
    storeRunId,
    sourceFetchedAt,
    snapshot: primarySnapshot,
    storeResult,
  });

  if (inventoryTypes.length > 0) {
    if (activeSkuUniverse?.status !== 'AVAILABLE') {
      for (const inventoryType of inventoryTypes) {
        setDomainResult(storeResult, makeDomainResult(
          `inventory:${inventoryType}`,
          'blocked_by_dependency',
          {
            inventoryType,
            reasonCode: activeSkuUniverse?.reasonCode
              ?? 'SALES_MEMBERSHIP_EVIDENCE_MISSING',
          },
        ));
      }
    } else {
      for (const inventoryType of inventoryTypes) {
        await fetchAndLoadInventory({
          client,
          pool,
          operations,
          store,
          storeRunId,
          sourceFetchedAt,
          skuCodes: activeSkuUniverse.skuCodes,
          inventoryType,
          storeResult,
        });
      }
    }
  }

  const failures = storeResult.domains.filter(({ status, coverageStatus }) => (
    ['fetch_error', 'load_error', 'blocked_by_dependency'].includes(status)
    || coverageStatus === 'PARTIAL'
  ));
  const loaded = storeResult.domains.filter(({ status }) => (
    ['loaded', 'not_applicable'].includes(status)
  ));
  storeResult.status = failures.length === 0
    ? 'loaded'
    : loaded.length > 0
      ? 'partial'
      : 'error';
  return storeResult;
}

export async function runSupplySync({
  config,
  databaseUrl,
  stores,
  domains,
  now = new Date(),
  runId,
  mode = SUPPLY_SYNC_MODES.INCREMENTAL,
  backfillStart,
  backfillEnd,
  poolFactory = (connectionString) => new Pool({ connectionString, max: 3 }),
  clientFactory = (options) => new SheinOpenApiClient(options),
  operations: operationOverrides = {},
} = {}) {
  if (!config || typeof config !== 'object') throw new TypeError('config is required');
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new TypeError('databaseUrl is required');
  }
  const current = normalizeNow(now);
  const normalizedMode = normalizeMode(mode);
  const windows = computeSupplyPlan({
    now: current,
    mode: normalizedMode,
    backfillStart,
    backfillEnd,
  });
  const normalizedDomains = normalizeSupplyDomains(domains);
  const selectedStores = selectStores(config.stores, stores);
  const baseRunId = normalizeBaseRunId(runId, current);
  const operations = { ...DEFAULT_OPERATIONS, ...operationOverrides };
  const pool = await poolFactory(databaseUrl);
  if (!pool || typeof pool.end !== 'function') {
    throw new TypeError('poolFactory must return a pool with end()');
  }

  const results = [];
  try {
    for (const store of selectedStores) {
      const storeRunId = `${baseRunId}:${store.storeCode}`;
      let attempts = [];
      let storeResult;
      try {
        if (fullManagedStoreCallBlock(store) === null) {
          attempts = await startSupplyAttempts({
            pool,
            operations,
            store,
            storeRunId,
            domains: normalizedDomains,
            windows,
            mode: normalizedMode,
          });
        }
        storeResult = await syncStore({
          config,
          store,
          domains: normalizedDomains,
          windows,
          baseRunId,
          pool,
          clientFactory,
          operations,
        });
      } catch (error) {
        if (Array.isArray(error?.startedSupplyAttempts)) {
          attempts = error.startedSupplyAttempts;
        }
        storeResult = {
          storeCode: store.storeCode,
          runId: storeRunId,
          status: 'error',
          errorCode: safeErrorCode(error, 'STORE_SYNC_ERROR'),
          domains: [],
          warehouseLoads: [],
        };
      }
      if (attempts.length > 0) {
        try {
          await finishSupplyAttempts({
            pool,
            operations,
            store,
            attempts,
            windows,
            mode: normalizedMode,
            storeResult,
          });
        } catch (error) {
          storeResult = {
            ...storeResult,
            status: 'error',
            errorCode: safeErrorCode(error, 'ATTEMPT_LEDGER_TERMINAL_ERROR'),
          };
        }
      }
      results.push(storeResult);
    }
  } finally {
    await pool.end();
  }

  const failedStores = results.filter(({ status }) => (
    ['partial', 'error', 'skipped'].includes(status)
  )).length;
  return Object.freeze({
    ok: failedStores === 0,
    runId: baseRunId,
    mode: normalizedMode,
    sourceFetchedAt: windows.sourceFetchedAt,
    windows,
    domains: normalizedDomains,
    config: summarizeFullManagedConfig(config),
    loadedStores: results.filter(({ status }) => status === 'loaded').length,
    failedStores,
    coverageGate: Object.freeze({
      requestedRangeLoaded: failedStores === 0,
      historicalCompletenessClaimed: false,
      backfillReadbackRequired: normalizedMode === SUPPLY_SYNC_MODES.BACKFILL,
      eligibleForIncrementalEnableAfterReadback:
        normalizedMode === SUPPLY_SYNC_MODES.BACKFILL && failedStores === 0,
    }),
    results,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadFullManagedConfig(args.config);
  const databaseUrl = args['database-url']
    ?? process.env.FULL_BI_DATABASE_URL
    ?? process.env.DATABASE_URL;
  const summary = await runSupplySync({
    config,
    databaseUrl,
    stores: args.stores,
    domains: args.domains,
    now: args.now ?? new Date(),
    runId: args['run-id'],
    mode: args.mode,
    backfillStart: args['backfill-start'],
    backfillEnd: args['backfill-end'],
  });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 2;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      errorCode: safeErrorCode(error, 'SUPPLY_SYNC_FAILED'),
      error: 'Full-managed read-only supply sync did not complete.',
    }));
    process.exitCode = 1;
  });
}
