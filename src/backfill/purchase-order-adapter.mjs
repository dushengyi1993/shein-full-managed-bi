/**
 * Historical backfill adapter for purchase orders, by OpenAPI `updateTime`.
 *
 * This is the only executable backfill domain. The adapter owns no transport, no
 * pagination, no mapper, no reconciliation and no persistence: one `fetchWindow`
 * delegates exactly once to the existing, proven `runSupplySync` for one store,
 * the `purchase-orders` domain only, in BACKFILL mode, over the exact planned
 * one-day range.
 *
 * Everything else here is verification. The adapter re-reads the returned
 * evidence and refuses to translate it into a passing quality-gate result unless
 * every single completeness fact is proven. A missing fact is a failure, never an
 * assumption, so a checkpoint can never advance on unproven coverage.
 */

import { canonicalHash } from './canonical.mjs';
import {
  BACKFILL_DOMAIN_CATALOG,
  CAPABILITY_STATUSES,
  EXECUTABLE_BACKFILL_DOMAIN,
} from './capability-catalog.mjs';

export const PURCHASE_ORDER_BACKFILL_DOMAIN = EXECUTABLE_BACKFILL_DOMAIN;

export const PURCHASE_ORDER_BACKFILL_ADAPTER_KEY = 'openapi.purchase-orders.v1';

export const PURCHASE_ORDER_BACKFILL_MODE = 'BACKFILL';

/** The terminal-page proof the supply purchase-order merge emits. */
export const PURCHASE_ORDER_TERMINAL_REASON = 'ALL_WINDOWS_REACHED_TERMINAL_PAGE';

const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WINDOW_KEY_PATTERN = /^[0-9a-f]{64}$/;
const STORE_CODE_PATTERN = /^[A-Z]{2}[0-9]{4}$/;
const DAY_MS = 86_400_000;

/**
 * The adapter contract this module proves, hashed once.
 *
 * The fingerprint is a property of *this verification contract*, not of a single
 * response payload: the underlying supply mapper already rejects a drifted
 * purchase-order response before the adapter sees it. Listing the proven facts
 * explicitly means that relaxing any one of them changes the fingerprint, which
 * the quality gate reports as schema drift against every existing checkpoint.
 */
export const PURCHASE_ORDER_ADAPTER_CONTRACT = Object.freeze({
  contract: 'backfill.purchase-order-adapter.v1',
  domain: PURCHASE_ORDER_BACKFILL_DOMAIN,
  adapterKey: PURCHASE_ORDER_BACKFILL_ADAPTER_KEY,
  delegate: 'scripts/sync_full_managed_supply.mjs#runSupplySync',
  mode: PURCHASE_ORDER_BACKFILL_MODE,
  sourceField: 'updateTime',
  sourceTimezone: 'Asia/Shanghai',
  windowGrain: 'BUSINESS_DATE',
  windowSpanDays: 1,
  storeCountPerCall: 1,
  domainScopePerCall: [PURCHASE_ORDER_BACKFILL_DOMAIN],
  provenFacts: Object.freeze([
    'exactly-one-store-result',
    'purchase-domain-loaded',
    'terminal-page-reached-for-every-window',
    'plan-covers-the-exact-requested-one-day-range',
    'exactly-one-planned-window',
    'requested-range-complete',
    'historical-coverage-not-claimed',
    'observation-instant-is-the-real-clock',
    'persisted-purchase-order-count-equals-record-count',
    'requested-range-loaded',
  ]),
});

export const PURCHASE_ORDER_ADAPTER_SCHEMA_FINGERPRINT = canonicalHash(
  PURCHASE_ORDER_ADAPTER_CONTRACT,
);

export const PURCHASE_ORDER_ADAPTER_REJECT_CODES = Object.freeze({
  DOMAIN_NOT_EXECUTABLE: 'BACKFILL_DOMAIN_NOT_EXECUTABLE',
  STORE_NOT_AUTHORIZED: 'BACKFILL_STORE_NOT_AUTHORIZED',
  WINDOW_INVALID: 'BACKFILL_WINDOW_INVALID',
  WINDOW_NOT_ONE_DAY: 'BACKFILL_WINDOW_NOT_ONE_DAY',
  WINDOW_END_AFTER_NOW: 'BACKFILL_WINDOW_END_AFTER_NOW',
  ATTEMPT_INVALID: 'BACKFILL_ATTEMPT_INVALID',
  DELEGATE_THREW: 'SUPPLY_SYNC_DELEGATE_THREW',
  RESULT_SHAPE_INVALID: 'SUPPLY_SYNC_RESULT_SHAPE_INVALID',
  RESULT_MODE_NOT_BACKFILL: 'SUPPLY_SYNC_MODE_NOT_BACKFILL',
  RESULT_DOMAIN_SCOPE_WIDER: 'SUPPLY_SYNC_DOMAIN_SCOPE_WIDER',
  RESULT_STORE_COUNT_NOT_ONE: 'SUPPLY_SYNC_STORE_COUNT_NOT_ONE',
  RESULT_STORE_MISMATCH: 'SUPPLY_SYNC_STORE_MISMATCH',
  OBSERVATION_INSTANT_MISMATCH: 'SUPPLY_OBSERVATION_INSTANT_MISMATCH',
  DOMAIN_RESULT_MISSING: 'PURCHASE_DOMAIN_RESULT_MISSING',
  DOMAIN_NOT_LOADED: 'PURCHASE_DOMAIN_NOT_LOADED',
  TERMINAL_PAGE_NOT_PROVEN: 'PURCHASE_TERMINAL_PAGE_NOT_PROVEN',
  WINDOW_PLAN_MISMATCH: 'PURCHASE_WINDOW_PLAN_MISMATCH',
  WINDOW_COUNT_NOT_ONE: 'PURCHASE_WINDOW_COUNT_NOT_ONE',
  REQUESTED_RANGE_INCOMPLETE: 'PURCHASE_REQUESTED_RANGE_INCOMPLETE',
  HISTORICAL_COVERAGE_CLAIMED: 'PURCHASE_HISTORICAL_COVERAGE_CLAIMED',
  PAGE_COUNT_INVALID: 'PURCHASE_PAGE_COUNT_INVALID',
  RECORD_COUNT_INVALID: 'PURCHASE_RECORD_COUNT_INVALID',
  REQUESTED_RANGE_NOT_LOADED: 'PURCHASE_REQUESTED_RANGE_NOT_LOADED',
  PERSISTED_COUNT_EVIDENCE_MISSING: 'PURCHASE_PERSISTED_COUNT_EVIDENCE_MISSING',
  PERSISTED_COUNT_MISMATCH: 'PURCHASE_PERSISTED_COUNT_MISMATCH',
});

function reject(sanitizedErrorCode, details = {}) {
  return Object.freeze({
    ok: false,
    adapterError: true,
    sanitizedErrorCode,
    // Bounded, non-secret facts only: counts, states and business dates.
    details: Object.freeze({ ...details }),
  });
}

function businessDate(value) {
  if (typeof value !== 'string' || !BUSINESS_DATE_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    ? parsed
    : null;
}

/** `2026-07-01` becomes the exact Asia/Shanghai midnight boundary. */
function shanghaiMidnight(isoDate) {
  return `${isoDate}T00:00:00+08:00`;
}

/** The Asia/Shanghai wall-clock text the supply plan is expected to echo back. */
function shanghaiPlanText(isoDate) {
  return `${isoDate} 00:00:00`;
}

/**
 * A deterministic, safe run id derived only from the window key and attempt.
 *
 * Deterministic means a retry of the same window and attempt reuses the same
 * supply run id, so the supply attempt ledger records a replay instead of an
 * unbounded stream of new identifiers. It carries no store code, no operator and
 * no timestamp, so it can never leak scope into a log line.
 */
export function purchaseOrderBackfillRunId({ planHash, windowKey, attempt } = {}) {
  if (typeof planHash !== 'string' || !WINDOW_KEY_PATTERN.test(planHash)) {
    throw new TypeError('planHash must be the planner 64-hex plan hash');
  }
  if (typeof windowKey !== 'string' || !WINDOW_KEY_PATTERN.test(windowKey)) {
    throw new TypeError('windowKey must be the planner 64-hex window key');
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 99) {
    throw new TypeError('attempt must be an integer from 1 to 99');
  }
  const scopedKey = canonicalHash({ planHash, windowKey }).slice(0, 32);
  return `bfpo-${scopedKey}-a${String(attempt).padStart(2, '0')}`;
}

function isSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Verify the supply plan for one purchase-order window.
 *
 * Both `summary.windows.purchaseOrders` and the per-domain `window` evidence must
 * describe the same exact one-day range, so a widened plan cannot hide behind a
 * narrow per-domain echo, or the reverse.
 */
function verifyPurchasePlan(plan, { expectedStart, expectedEnd }) {
  if (!plan || typeof plan !== 'object') {
    return PURCHASE_ORDER_ADAPTER_REJECT_CODES.WINDOW_PLAN_MISMATCH;
  }
  if (
    plan.mode !== PURCHASE_ORDER_BACKFILL_MODE
    || plan.field !== 'updateTime'
    || plan.timezone !== 'Asia/Shanghai'
    || plan.start !== expectedStart
    || plan.end !== expectedEnd
  ) {
    return PURCHASE_ORDER_ADAPTER_REJECT_CODES.WINDOW_PLAN_MISMATCH;
  }
  if (!Array.isArray(plan.windows) || plan.windows.length !== 1) {
    return PURCHASE_ORDER_ADAPTER_REJECT_CODES.WINDOW_COUNT_NOT_ONE;
  }
  const [window] = plan.windows;
  if (window?.start !== expectedStart || window?.end !== expectedEnd) {
    return PURCHASE_ORDER_ADAPTER_REJECT_CODES.WINDOW_PLAN_MISMATCH;
  }
  if (plan.completeRequestedRange !== true) {
    return PURCHASE_ORDER_ADAPTER_REJECT_CODES.REQUESTED_RANGE_INCOMPLETE;
  }
  // Covering one requested day is never historical completeness. The adapter
  // refuses to proceed if the delegate ever starts claiming otherwise.
  if (plan.completeHistoricalCoverage !== false) {
    return PURCHASE_ORDER_ADAPTER_REJECT_CODES.HISTORICAL_COVERAGE_CLAIMED;
  }
  return null;
}

/**
 * Build the single verified backfill adapter.
 *
 * `runSupplySync`, the private config and the dedicated supply database URL are
 * all injected: this module never reads an environment variable, never opens a
 * pool and never constructs a client, so importing it has no side effect.
 */
export function createPurchaseOrderBackfillAdapter({
  runSupplySync,
  config,
  databaseUrl,
  allowedStoreCodes,
  clock = () => new Date(),
  poolFactory,
  clientFactory,
} = {}) {
  if (typeof runSupplySync !== 'function') {
    throw new TypeError('createPurchaseOrderBackfillAdapter requires runSupplySync');
  }
  if (!config || typeof config !== 'object') {
    throw new TypeError('createPurchaseOrderBackfillAdapter requires a full-managed config');
  }
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new TypeError('createPurchaseOrderBackfillAdapter requires a supply database URL');
  }
  const authorizedStores = [...new Set(
    (Array.isArray(allowedStoreCodes) ? allowedStoreCodes : [])
      .map((item) => String(item ?? '').trim().toUpperCase()),
  )].filter((item) => item !== '');
  if (authorizedStores.length === 0 || authorizedStores.some(
    (storeCode) => !STORE_CODE_PATTERN.test(storeCode),
  )) {
    throw new TypeError('createPurchaseOrderBackfillAdapter requires explicit store codes');
  }
  const capability = BACKFILL_DOMAIN_CATALOG[PURCHASE_ORDER_BACKFILL_DOMAIN];
  if (
    capability?.capabilityStatus !== CAPABILITY_STATUSES.VERIFIED
    || capability.adapterKey !== PURCHASE_ORDER_BACKFILL_ADAPTER_KEY
    || capability.maxWindowSpanDays !== 1
  ) {
    throw new TypeError('the purchase-order capability is not the verified one-day contract');
  }

  const state = { delegationCount: 0 };

  async function fetchWindow({
    planHash,
    storeCode,
    domain,
    windowStart,
    windowEnd,
    windowKey,
    attempt = 1,
  } = {}) {
    if (domain !== PURCHASE_ORDER_BACKFILL_DOMAIN) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.DOMAIN_NOT_EXECUTABLE, { domain });
    }
    const normalizedStoreCode = String(storeCode ?? '').trim().toUpperCase();
    if (!authorizedStores.includes(normalizedStoreCode)) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.STORE_NOT_AUTHORIZED);
    }
    const start = businessDate(windowStart);
    const end = businessDate(windowEnd);
    if (start === null || end === null) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.WINDOW_INVALID);
    }
    if (end.valueOf() - start.valueOf() !== DAY_MS) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.WINDOW_NOT_ONE_DAY, {
        windowStart,
        windowEnd,
      });
    }
    let runId;
    try {
      runId = purchaseOrderBackfillRunId({ planHash, windowKey, attempt });
    } catch {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.ATTEMPT_INVALID);
    }

    // The observation instant is the real clock, never the requested history
    // boundary. A window whose exclusive end lies in the future cannot be a
    // completed history range, so it fails closed rather than fetching a partial
    // day and calling it complete.
    const now = clock();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.WINDOW_INVALID);
    }
    const backfillStart = shanghaiMidnight(windowStart);
    const backfillEnd = shanghaiMidnight(windowEnd);
    if (new Date(backfillEnd).valueOf() > now.valueOf()) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.WINDOW_END_AFTER_NOW, { windowEnd });
    }

    let summary;
    try {
      // Exactly one delegation. Everything below only reads the evidence it
      // returned; no request, page, mapping, reconciliation or write happens here.
      state.delegationCount += 1;
      summary = await runSupplySync({
        config,
        databaseUrl,
        stores: normalizedStoreCode,
        domains: PURCHASE_ORDER_BACKFILL_DOMAIN,
        mode: PURCHASE_ORDER_BACKFILL_MODE,
        backfillStart,
        backfillEnd,
        now,
        runId,
        ...(poolFactory === undefined ? {} : { poolFactory }),
        ...(clientFactory === undefined ? {} : { clientFactory }),
      });
    } catch (error) {
      const code = String(error?.code ?? '').trim().toUpperCase();
      return reject(
        /^[A-Z][A-Z0-9_]{2,60}$/.test(code)
          ? code
          : PURCHASE_ORDER_ADAPTER_REJECT_CODES.DELEGATE_THREW,
      );
    }

    if (!summary || typeof summary !== 'object' || !Array.isArray(summary.results)) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.RESULT_SHAPE_INVALID);
    }
    if (summary.mode !== PURCHASE_ORDER_BACKFILL_MODE) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.RESULT_MODE_NOT_BACKFILL);
    }
    if (
      !Array.isArray(summary.domains)
      || summary.domains.length !== 1
      || summary.domains[0] !== PURCHASE_ORDER_BACKFILL_DOMAIN
    ) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.RESULT_DOMAIN_SCOPE_WIDER, {
        domainCount: Array.isArray(summary.domains) ? summary.domains.length : null,
      });
    }
    if (summary.results.length !== 1) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.RESULT_STORE_COUNT_NOT_ONE, {
        storeResultCount: summary.results.length,
      });
    }
    const [storeResult] = summary.results;
    if (storeResult?.storeCode !== normalizedStoreCode) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.RESULT_STORE_MISMATCH);
    }
    // The recorded observation instant must be the clock instant this adapter
    // passed in, not the replayed history boundary.
    if (summary.sourceFetchedAt !== now.toISOString()) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.OBSERVATION_INSTANT_MISMATCH);
    }

    const expectedStart = shanghaiPlanText(windowStart);
    const expectedEnd = shanghaiPlanText(windowEnd);
    const summaryPlanRejection = verifyPurchasePlan(summary.windows?.purchaseOrders, {
      expectedStart,
      expectedEnd,
    });
    if (summaryPlanRejection !== null) {
      return reject(summaryPlanRejection, { windowStart, windowEnd });
    }

    if (!Array.isArray(storeResult.domains)) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.RESULT_SHAPE_INVALID);
    }
    const domainResults = storeResult.domains.filter(
      (entry) => entry?.domain === PURCHASE_ORDER_BACKFILL_DOMAIN,
    );
    if (domainResults.length !== 1) {
      const upstreamCode = String(storeResult?.errorCode ?? '').trim().toUpperCase();
      if (/^[A-Z][A-Z0-9_]{2,60}$/.test(upstreamCode)) {
        return reject(upstreamCode, {
          domainResultCount: domainResults.length,
        });
      }
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.DOMAIN_RESULT_MISSING, {
        domainResultCount: domainResults.length,
      });
    }
    const [domainResult] = domainResults;
    if (domainResult.status !== 'loaded') {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.DOMAIN_NOT_LOADED, {
        status: String(domainResult.status ?? 'unknown'),
      });
    }
    if (domainResult.mode !== PURCHASE_ORDER_BACKFILL_MODE) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.RESULT_MODE_NOT_BACKFILL);
    }
    // Only a proven terminal page makes "observed pages == expected pages" a
    // statement about coverage rather than a tautology.
    if (domainResult.terminalReason !== PURCHASE_ORDER_TERMINAL_REASON) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.TERMINAL_PAGE_NOT_PROVEN, {
        terminalReason: String(domainResult.terminalReason ?? 'none'),
      });
    }
    const domainPlanRejection = verifyPurchasePlan(domainResult.window, {
      expectedStart,
      expectedEnd,
    });
    if (domainPlanRejection !== null) {
      return reject(domainPlanRejection, { windowStart, windowEnd });
    }

    const recordCount = domainResult.recordCount;
    const pageCount = domainResult.pageCount;
    if (!isSafeCount(recordCount)) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.RECORD_COUNT_INVALID);
    }
    if (!isSafeCount(pageCount)) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.PAGE_COUNT_INVALID);
    }
    if (summary.coverageGate?.requestedRangeLoaded !== true) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.REQUESTED_RANGE_NOT_LOADED);
    }
    if (summary.coverageGate?.historicalCompletenessClaimed !== false) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.HISTORICAL_COVERAGE_CLAIMED);
    }

    // Persistence evidence comes from the warehouse readback count, so a fetched
    // row that never landed cannot be reported as accepted.
    const persistedCounts = (Array.isArray(storeResult.warehouseLoads)
      ? storeResult.warehouseLoads
      : [])
      .map((entry) => entry?.counts?.purchaseOrderCount)
      .filter((value) => value !== undefined);
    if (persistedCounts.length !== 1 || !isSafeCount(persistedCounts[0])) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.PERSISTED_COUNT_EVIDENCE_MISSING, {
        persistedCountEntries: persistedCounts.length,
      });
    }
    const persistedRowCount = persistedCounts[0];
    if (persistedRowCount !== recordCount) {
      return reject(PURCHASE_ORDER_ADAPTER_REJECT_CODES.PERSISTED_COUNT_MISMATCH, {
        recordCount,
        persistedRowCount,
      });
    }

    return Object.freeze({
      ok: true,
      // Every row in a proven-complete window was accepted and persisted; the
      // supply mapper rejects a malformed row by throwing, so a partial accept
      // cannot reach this point.
      acceptedRowCount: recordCount,
      persistedRowCount,
      rejectedRowCount: 0,
      illegalDecimalCount: 0,
      unknownMetricCount: 0,
      // Equal by proof, not by assumption: the terminal page was reached, so the
      // observed page count *is* the complete expected page count.
      expectedPageCount: pageCount,
      observedPageCount: pageCount,
      schemaFingerprint: PURCHASE_ORDER_ADAPTER_SCHEMA_FINGERPRINT,
      // The window is exactly one business date, so its start is the watermark.
      sourceBusinessWatermark: windowStart,
      businessDates: Object.freeze([]),
      supplyRunId: runId,
      delegationCount: state.delegationCount,
    });
  }

  return Object.freeze({
    adapterKey: PURCHASE_ORDER_BACKFILL_ADAPTER_KEY,
    domain: PURCHASE_ORDER_BACKFILL_DOMAIN,
    schemaFingerprint: PURCHASE_ORDER_ADAPTER_SCHEMA_FINGERPRINT,
    get delegationCount() { return state.delegationCount; },
    fetchWindow,
  });
}
