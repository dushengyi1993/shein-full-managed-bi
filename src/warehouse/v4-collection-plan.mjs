/**
 * Full-managed v4 order-WebAPI collection plan.
 *
 * Pure, frozen, deterministic planner for the one authorized settled-window
 * collection run:
 *   - the exact canonical 25-store roster (FULL_MANAGED_STORE_CODES),
 *   - the frozen 13 work-item manifest: the 7 ORDER_MANAGEMENT_SESSION_PAGES
 *     endpoint codes plus six distinct WAYBILLS_STATISTICS_<type> codes,
 *   - one inclusive 30-day settled Shanghai calendar window ending yesterday
 *     (windowed endpoints only; once-only pages ignore it),
 *   - retryPolicy NONE.
 *
 * v2 plan format binds the authorization hash to the exact executable request
 * contracts: the plan carries an ordered per-work-item request-contract
 * manifest (method, path, body template, window fields, paging contract or
 * statistics scope, plus the schema hash and the concrete request fingerprint
 * of each of the 13 work items), and the plan hash is canonical JSON over
 * that manifest.  Any change to an endpoint method/path/body template/window
 * field/paging contract/statistics type or to the concrete request body
 * therefore changes the plan hash with no human contractVersion bump.
 * parseV4CollectionPlan always recomputes the manifest against the current
 * frozen contracts and fails closed on drift; a persisted plan that lost the
 * manifest (older tooling) is re-validated through the same recomputation and
 * hash gate.
 *
 * The plan hash is deterministic canonical JSON over every executable input,
 * and the run key is derived from the plan hash, so re-running the same
 * reviewed plan replays the exact same DB run (byte-identical) and anything
 * else fails closed.
 *
 * This module never opens a session, a socket, a database or a file.  It only
 * re-reads the frozen order-management contracts; it adds no URL and no body
 * key of its own.
 *
 * Drift-verification seam: every function that reads the contracts accepts an
 * optional trailing `contracts` view (default: the live frozen
 * order-management-contracts module).  Production callers never pass it; the
 * view exists so tests can prove that any endpoint method/path/body
 * template/window field/paging/statistics change invalidates the plan hash
 * without editing the frozen contracts file.
 */

import { canonicalHash, canonicalJson, sha256Hex } from '../backfill/canonical.mjs';
import { FULL_MANAGED_STORE_CODES } from '../config/full-managed-stores.mjs';
import * as LIVE_ORDER_MANAGEMENT_CONTRACTS from '../webapi-history/order-management-contracts.mjs';
import {
  ORDER_MANAGEMENT_ENDPOINTS,
  ORDER_MANAGEMENT_SESSION_PAGES,
  ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
  orderManagementWindow,
} from '../webapi-history/order-management-contracts.mjs';

export const V4_COLLECTION_PLAN_VERSION = 'full-managed-v4-collection-plan.v2';
export const V4_COLLECTION_CONTRACT_VERSION = 1;
export const V4_COLLECTION_RETRY_POLICY = 'NONE';
export const V4_COLLECTION_WINDOW_DAYS = ORDER_MANAGEMENT_WINDOW_MAX_DAYS;
export const V4_COLLECTION_RUN_KEY_DOMAIN = 'full-managed.v4.collection.run:';

export const V4_COLLECTION_STATISTICS_TYPES = Object.freeze([
  ...ORDER_MANAGEMENT_ENDPOINTS.WAYBILLS_STATISTICS.statisticsTypes,
]);

/** The 7 paged work-item codes in canonical contract order. */
export const V4_COLLECTION_PAGE_ENDPOINT_CODES = Object.freeze([
  ...Object.values(ORDER_MANAGEMENT_SESSION_PAGES),
]);

/** The 6 supplemental statistics work-item codes. */
export const V4_COLLECTION_STATISTICS_ENDPOINT_CODES = Object.freeze(
  V4_COLLECTION_STATISTICS_TYPES.map((type) => `WAYBILLS_STATISTICS_${type}`),
);

/** The frozen 13-item work-item manifest (DB endpoint roster of the run). */
export const V4_COLLECTION_WORK_ITEM_CODES = Object.freeze([
  ...V4_COLLECTION_PAGE_ENDPOINT_CODES,
  ...V4_COLLECTION_STATISTICS_ENDPOINT_CODES,
]);

export const V4_COLLECTION_ATTEMPT_COUNT =
  FULL_MANAGED_STORE_CODES.length * V4_COLLECTION_WORK_ITEM_CODES.length;

const PLAN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STATISTICS_WORK_ITEM_PATTERN = /^WAYBILLS_STATISTICS_([1-9][0-9]*)$/;
const DAY_MS = 86_400_000;

export class V4CollectionPlanError extends Error {
  constructor(code, message = '', details = {}) {
    super(message || `full-managed v4 collection plan refused: ${code}`);
    this.name = 'V4CollectionPlanError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message = '', details = {}) {
  throw new V4CollectionPlanError(code, message, details);
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameManifestEntry(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

/**
 * The calendar date (YYYY-MM-DD) in Asia/Shanghai for an instant.  The
 * settled-window gate is defined against this calendar so it stays stable no
 * matter which timezone the host runs in.
 */
export function v4ShanghaiCalendarDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.valueOf())) {
    fail('V4_COLLECTION_CLOCK_INVALID', 'clock must return a valid instant');
  }
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).formatToParts(date);
  const field = (type) => parts.find((part) => part.type === type)?.value ?? '';
  const text = `${field('year')}-${field('month')}-${field('day')}`;
  if (!ISO_DATE_PATTERN.test(text)) {
    fail('V4_COLLECTION_CLOCK_INVALID', 'clock must produce a Shanghai calendar date');
  }
  return text;
}

function addIsoDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The single authorized window: 30 inclusive settled Shanghai calendar days
 * ending yesterday.  Windowed endpoints fetch exactly this window; once-only
 * endpoints (exceptions / value-added-services) ignore it.
 */
export function v4CollectionSettledWindow(now = new Date()) {
  const yesterday = addIsoDays(v4ShanghaiCalendarDate(now), -1);
  const startDate = addIsoDays(yesterday, -(V4_COLLECTION_WINDOW_DAYS - 1));
  return orderManagementWindow({
    startDate,
    endDate: yesterday,
    maximumDays: V4_COLLECTION_WINDOW_DAYS,
  });
}

function hashInputOf(plan) {
  return {
    planVersion: plan.planVersion,
    contractVersion: plan.contractVersion,
    retryPolicy: plan.retryPolicy,
    storeCodes: plan.storeCodes,
    workItemCodes: plan.workItemCodes,
    statisticsTypes: plan.statisticsTypes,
    windowDays: plan.windowDays,
    window: { startDate: plan.window.startDate, endDate: plan.window.endDate },
    requestContractManifest: plan.requestContractManifest,
  };
}

/**
 * Build the frozen, deterministic collection plan.  The plan hash covers every
 * executable input (version, contract version, retry policy, canonical roster,
 * the exact 13-item manifest, the statistics types, the exact settled window
 * and the ordered per-work-item request-contract manifest) and nothing else,
 * so a reviewed dry-run hash authorizes exactly one execute run.  Any change
 * to an endpoint method/path/body template/window field/paging contract/
 * statistics type or to the concrete request body changes the hash without a
 * human contractVersion bump.  The optional `contracts` view is a
 * drift-verification seam only; production callers never pass it.
 */
export function buildV4CollectionPlan({
  now = new Date(),
  contracts = LIVE_ORDER_MANAGEMENT_CONTRACTS,
} = {}) {
  const window = v4CollectionSettledWindow(now);
  const requestContractManifest = v4CollectionRequestContractManifest({
    window,
    contracts,
  });
  const executable = Object.freeze({
    planVersion: V4_COLLECTION_PLAN_VERSION,
    contractVersion: V4_COLLECTION_CONTRACT_VERSION,
    retryPolicy: V4_COLLECTION_RETRY_POLICY,
    storeCodes: Object.freeze([...FULL_MANAGED_STORE_CODES]),
    workItemCodes: V4_COLLECTION_WORK_ITEM_CODES,
    statisticsTypes: V4_COLLECTION_STATISTICS_TYPES,
    windowDays: V4_COLLECTION_WINDOW_DAYS,
    window,
    requestContractManifest,
  });
  const planHash = canonicalHash(hashInputOf(executable));
  const runKey = sha256Hex(`${V4_COLLECTION_RUN_KEY_DOMAIN}${planHash}`);
  return Object.freeze({
    ...executable,
    planHash,
    runKey,
    pageEndpointCodes: V4_COLLECTION_PAGE_ENDPOINT_CODES,
    statisticsEndpointCodes: V4_COLLECTION_STATISTICS_ENDPOINT_CODES,
    summary: Object.freeze({
      storeCount: executable.storeCodes.length,
      workItemCount: executable.workItemCodes.length,
      pageEndpointCount: V4_COLLECTION_PAGE_ENDPOINT_CODES.length,
      statisticsEndpointCount: V4_COLLECTION_STATISTICS_ENDPOINT_CODES.length,
      attemptCount: V4_COLLECTION_ATTEMPT_COUNT,
      windowDays: V4_COLLECTION_WINDOW_DAYS,
    }),
  });
}

export function verifyV4CollectionPlanHash(plan, approvedHash) {
  return typeof plan?.planHash === 'string'
    && String(approvedHash ?? '').trim().toLowerCase() === plan.planHash;
}

/**
 * Execute authorization is explicit and non-inferable: the caller must supply
 * the exact reviewed plan hash.  A mismatch or a missing hash fails before any
 * pool, session store, transport or file can exist.
 */
export function assertApprovedV4CollectionPlanHash(plan, approvedHash) {
  if (!plan || typeof plan.planHash !== 'string') {
    fail('V4_COLLECTION_PLAN_MISSING', 'execute authorization requires a built/read plan');
  }
  const hash = String(approvedHash ?? '').trim().toLowerCase();
  if (!PLAN_HASH_PATTERN.test(hash)) {
    fail('V4_COLLECTION_APPROVED_PLAN_HASH_INVALID', 'execute requires an explicit 64-hex plan hash');
  }
  if (hash !== plan.planHash) {
    fail('V4_COLLECTION_PLAN_HASH_MISMATCH', 'approved plan hash does not match the built/read plan');
  }
  return Object.freeze({ planHash: plan.planHash, runKey: plan.runKey });
}

/**
 * Parse a previously emitted plan JSON and prove it is internally consistent:
 * canonical roster, frozen 13-item manifest, exact 30-day window, the ordered
 * per-work-item request-contract manifest recomputed against the current
 * frozen contracts, recomputed hash and deterministic run key.  Any drift
 * fails closed.  The optional `contracts` view is a drift-verification seam
 * only; production callers never pass it.
 */
export function parseV4CollectionPlan(json, contracts = LIVE_ORDER_MANAGEMENT_CONTRACTS) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    fail('V4_COLLECTION_PLAN_INVALID', 'plan must be a JSON object');
  }
  if (json.planVersion !== V4_COLLECTION_PLAN_VERSION) {
    fail('V4_COLLECTION_PLAN_VERSION_UNSUPPORTED', 'plan version is not supported');
  }
  if (json.contractVersion !== V4_COLLECTION_CONTRACT_VERSION) {
    fail('V4_COLLECTION_CONTRACT_VERSION_UNSUPPORTED', 'contract version is not supported');
  }
  if (json.retryPolicy !== V4_COLLECTION_RETRY_POLICY) {
    fail('V4_COLLECTION_RETRY_POLICY_INVALID', 'only retryPolicy NONE is authorized');
  }
  if (json.windowDays !== V4_COLLECTION_WINDOW_DAYS) {
    fail('V4_COLLECTION_WINDOW_DAYS_INVALID', 'only the 30-day settled window is authorized');
  }
  if (!sameArray(json.storeCodes, FULL_MANAGED_STORE_CODES)) {
    fail('V4_COLLECTION_ROSTER_MISMATCH', 'plan store roster must equal the canonical 25-store roster');
  }
  if (!sameArray(json.workItemCodes, V4_COLLECTION_WORK_ITEM_CODES)) {
    fail('V4_COLLECTION_MANIFEST_MISMATCH', 'plan work-item manifest must equal the frozen 13-item manifest');
  }
  if (!sameArray(json.statisticsTypes, V4_COLLECTION_STATISTICS_TYPES)) {
    fail('V4_COLLECTION_STATISTICS_TYPES_INVALID', 'plan statistics types must be exactly 1..6');
  }
  const window = orderManagementWindow({
    startDate: json.window?.startDate,
    endDate: json.window?.endDate,
    maximumDays: V4_COLLECTION_WINDOW_DAYS,
  });
  const spanDays = Math.round(
    (Date.parse(`${window.endDate}T00:00:00.000Z`)
      - Date.parse(`${window.startDate}T00:00:00.000Z`)) / DAY_MS,
  ) + 1;
  if (spanDays !== V4_COLLECTION_WINDOW_DAYS) {
    fail('V4_COLLECTION_WINDOW_SPAN_INVALID', 'plan window must span exactly 30 inclusive days');
  }
  const requestContractManifest = v4CollectionRequestContractManifest({
    window,
    contracts,
  });
  if (json.requestContractManifest !== undefined) {
    if (!Array.isArray(json.requestContractManifest)
      || json.requestContractManifest.length !== requestContractManifest.length
      || json.requestContractManifest.some((entry, index) => (
        !sameManifestEntry(entry, requestContractManifest[index])
      ))) {
      fail(
        'V4_COLLECTION_REQUEST_CONTRACT_DRIFT',
        'plan request-contract manifest no longer matches the current frozen request contracts',
      );
    }
  }
  const parsed = Object.freeze({
    planVersion: json.planVersion,
    contractVersion: json.contractVersion,
    retryPolicy: json.retryPolicy,
    storeCodes: Object.freeze([...json.storeCodes]),
    workItemCodes: Object.freeze([...json.workItemCodes]),
    statisticsTypes: Object.freeze([...json.statisticsTypes]),
    windowDays: json.windowDays,
    window,
    requestContractManifest,
    pageEndpointCodes: V4_COLLECTION_PAGE_ENDPOINT_CODES,
    statisticsEndpointCodes: V4_COLLECTION_STATISTICS_ENDPOINT_CODES,
    summary: Object.freeze({
      storeCount: json.storeCodes.length,
      workItemCount: json.workItemCodes.length,
      pageEndpointCount: V4_COLLECTION_PAGE_ENDPOINT_CODES.length,
      statisticsEndpointCount: V4_COLLECTION_STATISTICS_ENDPOINT_CODES.length,
      attemptCount: V4_COLLECTION_ATTEMPT_COUNT,
      windowDays: V4_COLLECTION_WINDOW_DAYS,
    }),
  });
  const planHash = canonicalHash(hashInputOf(parsed));
  const runKey = sha256Hex(`${V4_COLLECTION_RUN_KEY_DOMAIN}${planHash}`);
  if (String(json.planHash ?? '') !== planHash) {
    fail('V4_COLLECTION_PLAN_HASH_MISMATCH', 'plan hash does not match the parsed executable inputs');
  }
  if (String(json.runKey ?? '') !== runKey) {
    fail('V4_COLLECTION_RUN_KEY_MISMATCH', 'run key is not deterministic from the plan hash');
  }
  return Object.freeze({ ...parsed, planHash, runKey });
}

function assertPageEndpointCode(code) {
  if (!V4_COLLECTION_PAGE_ENDPOINT_CODES.includes(code)) {
    fail('V4_COLLECTION_WORK_ITEM_UNKNOWN', `unknown page work item: ${code}`);
  }
  return code;
}

function parseStatisticsType(code) {
  const match = STATISTICS_WORK_ITEM_PATTERN.exec(String(code ?? ''));
  if (!match || !V4_COLLECTION_STATISTICS_ENDPOINT_CODES.includes(code)) {
    fail('V4_COLLECTION_WORK_ITEM_UNKNOWN', `unknown statistics work item: ${code}`);
  }
  return Number(match[1]);
}

/**
 * The attempt window of one work item: the settled window for windowed
 * endpoints and for every statistics work item, null for the once-only pages
 * (exceptions / value-added-services) whose endpoints carry no date filter.
 * The optional `contracts` view is a drift-verification seam only.
 */
export function v4WorkItemWindow({
  workItemCode,
  window = null,
} = {}, contracts = LIVE_ORDER_MANAGEMENT_CONTRACTS) {
  const code = String(workItemCode ?? '');
  if (V4_COLLECTION_STATISTICS_ENDPOINT_CODES.includes(code)) {
    if (!window) {
      fail('V4_COLLECTION_WINDOW_REQUIRED', `statistics work item ${code} requires the settled window`);
    }
    return Object.freeze({ startDate: window.startDate, endDate: window.endDate });
  }
  const endpoint = contracts.ORDER_MANAGEMENT_ENDPOINTS[assertPageEndpointCode(code)];
  if (!endpoint.windowFields) return null;
  if (!window) {
    fail('V4_COLLECTION_WINDOW_REQUIRED', `windowed work item ${code} requires the settled window`);
  }
  return Object.freeze({ startDate: window.startDate, endDate: window.endDate });
}

/**
 * Deterministic SHA-256 of the frozen request schema of one work item (method,
 * path, body template, window fields, paging keys and statistics scope).  This
 * is the attempt-level request_schema_hash; it never embeds a page number or
 * a concrete window value.  The optional `contracts` view is a
 * drift-verification seam only.
 */
export function v4EndpointRequestSchemaHash(
  workItemCode,
  contracts = LIVE_ORDER_MANAGEMENT_CONTRACTS,
) {
  const code = String(workItemCode ?? '');
  if (V4_COLLECTION_STATISTICS_ENDPOINT_CODES.includes(code)) {
    const endpoint = contracts.ORDER_MANAGEMENT_ENDPOINTS.WAYBILLS_STATISTICS;
    return canonicalHash({
      workItemCode: code,
      contractEndpointCode: 'WAYBILLS_STATISTICS',
      method: endpoint.method,
      path: endpoint.path,
      windowFields: endpoint.windowFields,
      statisticsType: parseStatisticsType(code),
      statisticsTypes: [...endpoint.statisticsTypes],
    });
  }
  const endpoint = contracts.ORDER_MANAGEMENT_ENDPOINTS[assertPageEndpointCode(code)];
  return canonicalHash({
    workItemCode: code,
    method: endpoint.method,
    path: endpoint.path,
    bodyTemplate: endpoint.bodyTemplate,
    windowFields: endpoint.windowFields,
    pageKey: endpoint.pageKey ?? null,
    pageSizeKey: endpoint.pageSizeKey ?? null,
    defaultPageSize: endpoint.defaultPageSize ?? null,
    pageSizeValue: endpoint.pageSizeValue ?? null,
  });
}

/**
 * Deterministic SHA-256 of the frozen request contract of one work item: the
 * exact generated filter body plus the paging contract (page number excluded;
 * each actual page request carries its own page-level fingerprint).  A window
 * is required exactly when the endpoint is windowed.  The optional `contracts`
 * view is a drift-verification seam only.
 */
export function v4EndpointRequestFingerprint({
  workItemCode,
  window = null,
} = {}, contracts = LIVE_ORDER_MANAGEMENT_CONTRACTS) {
  const code = String(workItemCode ?? '');
  if (V4_COLLECTION_STATISTICS_ENDPOINT_CODES.includes(code)) {
    v4WorkItemWindow({ workItemCode: code, window }, contracts);
    const base = contracts.orderManagementRequestBody('WAYBILLS_STATISTICS', { window });
    return canonicalHash({
      workItemCode: code,
      statisticsType: parseStatisticsType(code),
      body: base,
    });
  }
  const endpoint = contracts.ORDER_MANAGEMENT_ENDPOINTS[assertPageEndpointCode(code)];
  v4WorkItemWindow({ workItemCode: code, window }, contracts);
  const base = contracts.orderManagementRequestBody(
    code,
    endpoint.windowFields ? { window } : {},
  );
  return canonicalHash({
    workItemCode: code,
    body: base,
    pageKey: endpoint.pageKey ?? null,
    pageSizeKey: endpoint.pageSizeKey ?? null,
    pageSize: endpoint.pageSizeValue ?? endpoint.defaultPageSize ?? null,
  });
}

/**
 * The ordered per-work-item request-contract manifest of the frozen plan: for
 * each of the 13 work items in exact canonical order, the visible frozen
 * request contract (method, path, body template, window fields, paging
 * contract or statistics scope) plus the deterministic schema hash and the
 * concrete request fingerprint for the given window.  The manifest is part of
 * the plan hash input, so any contract or concrete-request change invalidates
 * the approved plan hash without a human contractVersion bump.  The optional
 * `contracts` view is a drift-verification seam only; production callers
 * never pass it.
 */
export function v4CollectionRequestContractManifest({
  window = null,
  contracts = LIVE_ORDER_MANAGEMENT_CONTRACTS,
} = {}) {
  return Object.freeze(V4_COLLECTION_WORK_ITEM_CODES.map((workItemCode) => {
    const requestSchemaHash = v4EndpointRequestSchemaHash(workItemCode, contracts);
    const requestFingerprint = v4EndpointRequestFingerprint({
      workItemCode,
      window,
    }, contracts);
    if (V4_COLLECTION_STATISTICS_ENDPOINT_CODES.includes(workItemCode)) {
      const endpoint = contracts.ORDER_MANAGEMENT_ENDPOINTS.WAYBILLS_STATISTICS;
      return Object.freeze({
        workItemCode,
        requestSchemaHash,
        requestFingerprint,
        method: endpoint.method,
        path: endpoint.path,
        windowFields: endpoint.windowFields
          ? Object.freeze({
            start: endpoint.windowFields.start,
            end: endpoint.windowFields.end,
          })
          : null,
        statisticsType: parseStatisticsType(workItemCode),
        statisticsTypes: Object.freeze([...endpoint.statisticsTypes]),
      });
    }
    const endpoint = contracts.ORDER_MANAGEMENT_ENDPOINTS[assertPageEndpointCode(workItemCode)];
    return Object.freeze({
      workItemCode,
      requestSchemaHash,
      requestFingerprint,
      method: endpoint.method,
      path: endpoint.path,
      bodyTemplate: endpoint.bodyTemplate
        ? Object.freeze({ ...endpoint.bodyTemplate })
        : endpoint.bodyTemplate,
      windowFields: endpoint.windowFields
        ? Object.freeze({
          start: endpoint.windowFields.start,
          end: endpoint.windowFields.end,
        })
        : null,
      pageKey: endpoint.pageKey ?? null,
      pageSizeKey: endpoint.pageSizeKey ?? null,
      defaultPageSize: endpoint.defaultPageSize ?? null,
      pageSizeValue: endpoint.pageSizeValue ?? null,
    });
  }));
}
