import { canonicalHash, sha256Hex } from './canonical.mjs';
import {
  BACKFILL_DOMAIN_CATALOG,
  CAPABILITY_STATUSES,
  isExecutableCapability,
} from './capability-catalog.mjs';

export const BACKFILL_PLAN_VERSION = 'backfill-plan.v1';

export const BACKFILL_MODES = Object.freeze({
  DRY_RUN: 'DRY_RUN',
  EXECUTE: 'EXECUTE',
});

export const PLAN_LIMITS = Object.freeze({
  minStoreCodes: 1,
  maxStoreCodes: 24,
  minDomains: 1,
  maxDomains: 12,
  minWindowSpanDays: 1,
  maxWindowSpanDays: 31,
  maxRangeDays: 400,
  maxWindowsPerPlan: 2000,
  minConcurrency: 1,
  maxConcurrency: 4,
  maxAttempts: 5,
});

const STORE_CODE_PATTERN = /^[A-Z]{2}[0-9]{4}$/;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CREATED_BY_PATTERN = /^[A-Za-z0-9._:-]{3,80}$/;
const PLAN_HASH_PATTERN = /^[0-9a-f]{64}$/;

export class BackfillPlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BackfillPlanError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new BackfillPlanError(code, message, details);
}

function parseBusinessDate(value, field) {
  if (typeof value !== 'string' || !BUSINESS_DATE_PATTERN.test(value)) {
    fail('INVALID_BUSINESS_DATE', `${field} must use YYYY-MM-DD`, { field });
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('INVALID_BUSINESS_DATE', `${field} is not a valid calendar date`, { field });
  }
  return parsed;
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.valueOf() + (days * 86_400_000));
}

function dayDifference(from, to) {
  return Math.round((to.valueOf() - from.valueOf()) / 86_400_000);
}

function normalizeStoreCodes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('EMPTY_STORE_SCOPE', 'at least one explicit store code is required');
  }
  const normalized = [...new Set(value.map((item) => String(item ?? '').trim().toUpperCase()))]
    .filter((item) => item !== '')
    .sort();
  if (normalized.length === 0) {
    fail('EMPTY_STORE_SCOPE', 'at least one explicit store code is required');
  }
  for (const storeCode of normalized) {
    if (!STORE_CODE_PATTERN.test(storeCode)) {
      fail('INVALID_STORE_CODE', 'store codes must use the canonical AA9999 form', {
        storeCode,
      });
    }
  }
  if (normalized.length > PLAN_LIMITS.maxStoreCodes) {
    fail('STORE_SCOPE_TOO_LARGE', 'store scope exceeds the planner bound', {
      count: normalized.length,
      limit: PLAN_LIMITS.maxStoreCodes,
    });
  }
  return normalized;
}

function normalizeDomains(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('EMPTY_DOMAIN_SCOPE', 'at least one explicit domain is required');
  }
  const normalized = [...new Set(value.map((item) => String(item ?? '').trim().toLowerCase()))]
    .filter((item) => item !== '')
    .sort();
  if (normalized.length === 0) {
    fail('EMPTY_DOMAIN_SCOPE', 'at least one explicit domain is required');
  }
  for (const domain of normalized) {
    if (!Object.hasOwn(BACKFILL_DOMAIN_CATALOG, domain)) {
      fail('UNKNOWN_DOMAIN', 'domain is not present in the capability catalog', { domain });
    }
  }
  if (normalized.length > PLAN_LIMITS.maxDomains) {
    fail('DOMAIN_SCOPE_TOO_LARGE', 'domain scope exceeds the planner bound', {
      count: normalized.length,
      limit: PLAN_LIMITS.maxDomains,
    });
  }
  return normalized;
}

function normalizeInteger(value, field, { min, max }) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    fail('INVALID_BOUND', `${field} must be an integer between ${min} and ${max}`, { field });
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail('INVALID_BOUND', `${field} must be an integer between ${min} and ${max}`, { field });
  }
  return parsed;
}

export function windowKeyFor({ storeCode, domain, adapterKey, windowStart, windowEnd }) {
  return sha256Hex(
    [storeCode, domain, adapterKey, windowStart, windowEnd].join(''),
  );
}

/**
 * Plan windows from the most recent date backwards.
 *
 * `windowEnd` is exclusive so adjacent windows never overlap and a late fact can
 * be replayed for exactly one business-date range.
 *
 * A non-executable capability collapses to the fewest schema-compatible ledger
 * chunks. Repeating the same immovable blocker once per business date would
 * inflate the plan and operator report, but ops.backfill_window deliberately
 * rejects ranges longer than PLAN_LIMITS.maxWindowSpanDays. A 65-day blocked
 * request therefore produces three rows (31, 31 and 3 days), not 65 rows and
 * not one row that the database cannot persist.
 */
function planWindowRanges({
  from,
  to,
  windowSpanDays,
  maxWindowSpanDays,
  windowGrain,
  executable,
}) {
  if (!executable) {
    const ranges = [];
    let cursorEnd = addDays(to, 1);
    while (cursorEnd.valueOf() > from.valueOf()) {
      const candidateStart = addDays(cursorEnd, -PLAN_LIMITS.maxWindowSpanDays);
      const windowStart = candidateStart.valueOf() < from.valueOf() ? from : candidateStart;
      ranges.push({
        windowStart: toIsoDate(windowStart),
        windowEnd: toIsoDate(cursorEnd),
      });
      cursorEnd = windowStart;
    }
    return ranges;
  }
  if (windowGrain === 'DIMENSION' || windowGrain === 'WINDOW_SNAPSHOT') {
    return [{
      windowStart: toIsoDate(to),
      windowEnd: toIsoDate(addDays(to, 1)),
    }];
  }
  const spanDays = Math.min(windowSpanDays, maxWindowSpanDays);
  const ranges = [];
  let cursorEnd = addDays(to, 1);
  while (cursorEnd.valueOf() > from.valueOf()) {
    const candidateStart = addDays(cursorEnd, -spanDays);
    const windowStart = candidateStart.valueOf() < from.valueOf() ? from : candidateStart;
    ranges.push({
      windowStart: toIsoDate(windowStart),
      windowEnd: toIsoDate(cursorEnd),
    });
    cursorEnd = windowStart;
  }
  return ranges;
}

/**
 * Build a deterministic, bounded backfill plan.
 *
 * The plan hash covers only the requested scope and the planner bounds, never
 * the mode, the caller or a timestamp. A dry-run hash can therefore be reviewed
 * and then supplied verbatim as the approved hash for an execute run.
 */
export function buildBackfillPlan(request = {}) {
  const storeCodes = normalizeStoreCodes(request.storeCodes);
  const domains = normalizeDomains(request.domains);
  const from = parseBusinessDate(request.from, 'from');
  const to = parseBusinessDate(request.to, 'to');
  if (from.valueOf() > to.valueOf()) {
    fail('INVALID_DATE_RANGE', 'from must not be after to');
  }
  const rangeDays = dayDifference(from, to) + 1;
  if (rangeDays > PLAN_LIMITS.maxRangeDays) {
    fail('DATE_RANGE_TOO_LARGE', 'requested range exceeds the planner bound', {
      rangeDays,
      limit: PLAN_LIMITS.maxRangeDays,
    });
  }
  const today = request.today === undefined
    ? null
    : parseBusinessDate(request.today, 'today');
  if (today && to.valueOf() > today.valueOf()) {
    fail('FUTURE_DATE_RANGE', 'backfill cannot plan a future business date');
  }

  const windowSpanDays = normalizeInteger(
    request.windowSpanDays ?? 1,
    'windowSpanDays',
    { min: PLAN_LIMITS.minWindowSpanDays, max: PLAN_LIMITS.maxWindowSpanDays },
  );
  const concurrency = normalizeInteger(
    request.concurrency ?? 1,
    'concurrency',
    { min: PLAN_LIMITS.minConcurrency, max: PLAN_LIMITS.maxConcurrency },
  );
  const maxAttempts = normalizeInteger(
    request.maxAttempts ?? 3,
    'maxAttempts',
    { min: 1, max: PLAN_LIMITS.maxAttempts },
  );
  const createdBy = String(request.createdBy ?? '').trim();
  if (!CREATED_BY_PATTERN.test(createdBy)) {
    fail('INVALID_CREATED_BY', 'createdBy must be an explicit auditable operator key');
  }

  const windows = [];
  for (const storeCode of storeCodes) {
    for (const domain of domains) {
      const capability = BACKFILL_DOMAIN_CATALOG[domain];
      const executable = isExecutableCapability(capability.capabilityStatus);
      const ranges = planWindowRanges({
        from,
        to,
        windowSpanDays,
        maxWindowSpanDays: capability.maxWindowSpanDays,
        windowGrain: capability.windowGrain,
        executable,
      });
      for (const range of ranges) {
        windows.push({
          storeCode,
          domain,
          adapterKey: capability.adapterKey,
          capabilityStatus: capability.capabilityStatus,
          windowGrain: capability.windowGrain,
          windowStart: range.windowStart,
          windowEnd: range.windowEnd,
          windowKey: windowKeyFor({
            storeCode,
            domain,
            adapterKey: capability.adapterKey,
            windowStart: range.windowStart,
            windowEnd: range.windowEnd,
          }),
          executable,
          blockedReasonCode: executable ? null : capability.blockedReasonCode,
          dailyHistoryReconstructable: capability.dailyHistoryReconstructable,
          maxAttempts: executable ? Math.min(maxAttempts, capability.maxAttempts) : 0,
          maxPagesPerWindow: capability.maxPagesPerWindow,
          maxRowsPerWindow: capability.maxRowsPerWindow,
        });
      }
    }
  }

  windows.sort((left, right) => (
    left.storeCode.localeCompare(right.storeCode)
    || left.domain.localeCompare(right.domain)
    // Newest window first: recent business dates matter most for operations.
    || right.windowStart.localeCompare(left.windowStart)
  ));

  if (windows.length > PLAN_LIMITS.maxWindowsPerPlan) {
    fail('WINDOW_COUNT_TOO_LARGE', 'planned window count exceeds the planner bound', {
      windowCount: windows.length,
      limit: PLAN_LIMITS.maxWindowsPerPlan,
    });
  }

  const seenWindowKeys = new Set();
  for (const window of windows) {
    if (seenWindowKeys.has(window.windowKey)) {
      fail('DUPLICATE_WINDOW', 'planner produced a duplicate window grain', {
        windowKey: window.windowKey,
      });
    }
    seenWindowKeys.add(window.windowKey);
  }

  const hashInput = {
    planVersion: BACKFILL_PLAN_VERSION,
    storeCodes,
    domains,
    from: toIsoDate(from),
    to: toIsoDate(to),
    windowSpanDays,
    concurrency,
    maxAttempts,
    windows: windows.map((window) => ({
      storeCode: window.storeCode,
      domain: window.domain,
      adapterKey: window.adapterKey,
      capabilityStatus: window.capabilityStatus,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      // The blocker reason is part of the reviewed evidence, so a catalog change
      // that keeps the same non-executable status still produces a new hash.
      blockedReasonCode: window.blockedReasonCode ?? null,
      executable: window.executable,
    })),
  };
  const planHash = canonicalHash(hashInput);

  const byCapability = Object.fromEntries(
    Object.values(CAPABILITY_STATUSES).map((status) => [
      status,
      windows.filter((window) => window.capabilityStatus === status).length,
    ]),
  );

  const blockedDomains = [...new Set(
    windows.filter((window) => !window.executable).map((window) => window.domain),
  )].sort();
  const blockedWindowCount = windows.filter((window) => !window.executable).length;
  const blockedWindowCountPerStoreDomain = Math.ceil(
    rangeDays / PLAN_LIMITS.maxWindowSpanDays,
  );
  // Assert the minimal schema-compatible chunk count in production code, not
  // only in tests, so a future change cannot silently restore daily fan-out or
  // produce an overlong row rejected by ops.backfill_window.
  if (
    blockedWindowCount
    !== storeCodes.length * blockedDomains.length * blockedWindowCountPerStoreDomain
  ) {
    fail('BLOCKER_NOT_COLLAPSED', 'blocked domains must use minimal bounded ledger chunks', {
      blockedWindowCount,
      expected: (
        storeCodes.length
        * blockedDomains.length
        * blockedWindowCountPerStoreDomain
      ),
    });
  }

  return Object.freeze({
    planVersion: BACKFILL_PLAN_VERSION,
    planHash,
    createdBy,
    storeCodes: Object.freeze(storeCodes),
    domains: Object.freeze(domains),
    from: toIsoDate(from),
    to: toIsoDate(to),
    windowSpanDays,
    concurrency,
    maxAttempts,
    windows: Object.freeze(windows.map((window) => Object.freeze(window))),
    summary: Object.freeze({
      plannedWindowCount: windows.length,
      executableWindowCount: windows.filter((window) => window.executable).length,
      blockedWindowCount,
      blockedDomains: Object.freeze(blockedDomains),
      // Blockers are chunked only to satisfy the immutable 31-day warehouse
      // constraint; they are never expanded to one row per business date.
      blockedWindowChunkDays: PLAN_LIMITS.maxWindowSpanDays,
      blockedWindowCountPerStoreDomain: (
        blockedDomains.length === 0 ? 0 : blockedWindowCountPerStoreDomain
      ),
      executableDomains: Object.freeze([...new Set(
        windows.filter((window) => window.executable).map((window) => window.domain),
      )].sort()),
      byCapability: Object.freeze(byCapability),
      blockedReasonCodes: Object.freeze([...new Set(
        windows.filter((window) => !window.executable)
          .map((window) => window.blockedReasonCode),
      )].sort()),
    }),
  });
}

/**
 * Execute authorization is explicit and non-inferable.
 *
 * The caller must pass the exact reviewed plan hash plus the allowed store and
 * domain lists. No environment variable, default or catalog value can broaden
 * the scope, and nothing outside the intersection may run.
 */
export function assertExecuteAuthorization({
  plan,
  approvedPlanHash,
  allowedStoreCodes,
  allowedDomains,
} = {}) {
  if (!plan || typeof plan.planHash !== 'string') {
    fail('MISSING_PLAN', 'execute authorization requires a built plan');
  }
  const hash = String(approvedPlanHash ?? '').trim().toLowerCase();
  if (!PLAN_HASH_PATTERN.test(hash)) {
    fail('MISSING_APPROVED_PLAN_HASH', 'execute requires an explicit 64-hex plan hash');
  }
  if (hash !== plan.planHash) {
    fail('PLAN_HASH_MISMATCH', 'approved plan hash does not match the built plan');
  }
  const stores = normalizeStoreCodes(allowedStoreCodes);
  const domains = normalizeDomains(allowedDomains);
  if (
    stores.length !== plan.storeCodes.length
    || stores.some((code, index) => code !== plan.storeCodes[index])
  ) {
    fail('STORE_NOT_AUTHORIZED', 'execute store scope must exactly match the reviewed plan', {
      storeCount: stores.length,
    });
  }
  if (
    domains.length !== plan.domains.length
    || domains.some((domain, index) => domain !== plan.domains[index])
  ) {
    fail('DOMAIN_NOT_AUTHORIZED', 'execute domain scope must exactly match the reviewed plan', {
      domainCount: domains.length,
    });
  }
  const nonExecutable = [...new Set(
    plan.windows.filter((window) => !window.executable).map((window) => window.domain),
  )].sort();
  return Object.freeze({
    planHash: plan.planHash,
    allowedStoreCodes: Object.freeze(stores),
    allowedDomains: Object.freeze(domains),
    blockedDomains: Object.freeze(nonExecutable),
  });
}
