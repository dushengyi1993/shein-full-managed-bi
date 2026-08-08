import { isDeepStrictEqual } from 'node:util';

import { FULL_MANAGED_STORE_CODES } from '../config/full-managed-stores.mjs';
import {
  ORDER_MANAGEMENT_PAGE_IDS,
  validateOrderManagementRow,
} from '../order-management/order-management-contract.mjs';
import { ORDER_MANAGEMENT_ONCE_ONLY_PAGES } from '../webapi-history/order-management-contracts.mjs';

const DAY_MS = 86_400_000;
const ROSTER = new Set(FULL_MANAGED_STORE_CODES);

function epochDays(value) {
  return Math.round(Date.parse(`${value}T00:00:00.000Z`) / DAY_MS);
}

function isoFromDays(days) {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Deterministic split of a date range into contiguous, non-overlapping
 * windows of at most `maximumDays` inclusive days.  The same algorithm the
 * backfill CLI uses, kept local so the merge stays import-independent.
 */
export function expectedWindows({
  startDate,
  endDate,
  maximumDays = 30,
} = {}) {
  if (!Number.isSafeInteger(maximumDays) || maximumDays < 1 || maximumDays > 30) {
    throw new TypeError('ORDER_MANAGEMENT_MERGE_WINDOW_MAX_INVALID');
  }
  const first = epochDays(startDate);
  const last = epochDays(endDate);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) {
    throw new TypeError('ORDER_MANAGEMENT_MERGE_RANGE_INVALID');
  }
  const windows = [];
  let cursor = first;
  while (cursor <= last) {
    const candidateEnd = Math.min(cursor + maximumDays - 1, last);
    windows.push(Object.freeze({
      startDate: isoFromDays(cursor),
      endDate: isoFromDays(candidateEnd),
    }));
    cursor = candidateEnd + 1;
  }
  return Object.freeze(windows);
}

function pageRows(page) {
  return Array.isArray(page?.rows) ? page.rows : [];
}

function gatesOf(page) {
  const gates = page?.gates && typeof page.gates === 'object' ? page.gates : {};
  return gates;
}

function fullGatesPassed(page, expectedStoreCount) {
  const gates = gatesOf(page);
  return page?.status === 'AVAILABLE'
    && gates.totalVerified === true
    && gates.pagingVerified === true
    && gates.dedupeVerified === true
    && gates.contentVerified !== false
    && Number.isSafeInteger(gates.storeCount)
    && gates.storeCount === expectedStoreCount;
}

function rosterOf(snapshot) {
  const roster = snapshot?.roster ?? snapshot?.scope?.storeCodes ?? null;
  if (!Array.isArray(roster)) return null;
  const codes = [...new Set(roster.map((code) => String(code ?? '').trim()).filter(Boolean))].sort();
  return codes;
}

function validateRowsOfPage(pageId, page) {
  const errors = [];
  pageRows(page).forEach((row, index) => {
    const check = validateOrderManagementRow(row, { pageId });
    if (!check.ok) {
      check.errors.forEach((message) => errors.push(`${pageId}[${index}] ${message}`));
    }
  });
  return errors;
}

/**
 * Conflict detection on the canonical row key pageId + storeCode + row.id.
 * Each endpoint's raw id namespace is independent, so the same (storeCode,
 * id) may legitimately appear in two different pages (e.g. return-plan id 1
 * and return-order id 1).  Only two rows sharing the SAME triple key with
 * different content are a conflict.
 */
export function rowKeyConflicts(pages) {
  const seen = new Map();
  const conflicts = [];
  for (const [pageId, page] of Object.entries(pages ?? {})) {
    for (const row of pageRows(page)) {
      const storeCode = String(row?.storeCode ?? '').trim();
      const id = String(row?.id ?? '').trim();
      if (!storeCode || !id) continue;
      const key = `${pageId}\u001f${storeCode}\u001f${id}`;
      const previous = seen.get(key);
      if (previous === undefined) seen.set(key, row);
      else conflicts.push(`${pageId}/${storeCode}/${id}`);
    }
  }
  return conflicts;
}

function auditWindows(snapshot) {
  const windows = snapshot?.backfill?.windows;
  if (!Array.isArray(windows)) return null;
  return windows
    .map((window) => ({ startDate: window?.startDate, endDate: window?.endDate }))
    .filter((window) => typeof window.startDate === 'string' && typeof window.endDate === 'string');
}

function isOnceOnlySnapshot(snapshot) {
  const pageIds = Object.keys(snapshot?.pages ?? {});
  return pageIds.length > 0
    && pageIds.every((pageId) => ORDER_MANAGEMENT_ONCE_ONLY_PAGES.includes(pageId));
}

function mergeAuditPages(left = {}, right = {}, location) {
  const overlap = Object.keys(left)
    .filter((pageId) => Object.prototype.hasOwnProperty.call(right, pageId));
  for (const pageId of overlap) {
    if (!isDeepStrictEqual(left[pageId], right[pageId])) {
      throw new TypeError(`ORDER_MANAGEMENT_MERGE_AUDIT_PAGE_CONFLICT: ${location}/${pageId}`);
    }
  }
  return Object.freeze({ ...left, ...right });
}

function auditPartFiles(entry) {
  return [
    ...(Array.isArray(entry?.partFiles) ? entry.partFiles : []),
    entry?.partFile,
  ].filter((value) => typeof value === 'string' && value);
}

/**
 * Existing and additive backfills cover the same calendar windows but carry
 * disjoint page evidence.  Merge evidence inside each matching window; never
 * concatenate two copies of the calendar because that would turn 57
 * contiguous windows into an invalid 114-window audit.
 */
function mergeWindowAudits(existing, produced) {
  const left = existing?.backfill?.windows;
  const right = produced?.backfill?.windows;
  if (!Array.isArray(left) || !Array.isArray(right)) {
    throw new TypeError('ORDER_MANAGEMENT_MERGE_WINDOW_SCOPE_MISMATCH');
  }
  if (right.length === 0 && isOnceOnlySnapshot(produced)) return Object.freeze([...left]);
  if (left.length === 0 && isOnceOnlySnapshot(existing)) return Object.freeze([...right]);
  if (left.length !== right.length) throw new TypeError('ORDER_MANAGEMENT_MERGE_WINDOW_SCOPE_MISMATCH');
  return Object.freeze(left.map((entry, index) => {
    const additive = right[index];
    if (entry?.startDate !== additive?.startDate || entry?.endDate !== additive?.endDate) {
      throw new TypeError(`ORDER_MANAGEMENT_MERGE_WINDOW_SCOPE_MISMATCH: ${index + 1}`);
    }
    const partFiles = [...new Set([
      ...auditPartFiles(entry),
      ...auditPartFiles(additive),
    ])];
    const fetchedAt = [entry?.fetchedAt, additive?.fetchedAt]
      .filter((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
      .sort()
      .at(-1) ?? null;
    return Object.freeze({
      index: index + 1,
      startDate: entry.startDate,
      endDate: entry.endDate,
      partFile: partFiles[0] ?? null,
      partFiles: Object.freeze(partFiles),
      fetchedAt,
      pages: mergeAuditPages(entry.pages, additive.pages, `window-${index + 1}`),
    });
  }));
}

function mergeOnceAudits(existing, produced) {
  const entries = [
    ...(existing?.backfill?.once ?? []),
    ...(produced?.backfill?.once ?? []),
  ];
  const owners = new Map();
  for (const [index, entry] of entries.entries()) {
    for (const pageId of entry?.pageIds ?? Object.keys(entry?.pages ?? {})) {
      if (owners.has(pageId)) {
        throw new TypeError(`ORDER_MANAGEMENT_MERGE_ONCE_PAGE_CONFLICT: ${pageId}`);
      }
      owners.set(pageId, index);
    }
  }
  return Object.freeze(entries);
}

/**
 * Verify one snapshot's window audit against its declared scope: the windows
 * must be exactly the deterministic contiguous split of the scope range with
 * the recorded maximum window size.  Returns a list of human-readable errors
 * (empty when the snapshot carries no audit and no scope to check).
 */
export function validateWindowContinuity(snapshot, { maximumDays = 30 } = {}) {
  const errors = [];
  const scope = snapshot?.scope;
  const windows = auditWindows(snapshot);
  if (!scope || !windows) return errors;
  if (windows.length === 0 && isOnceOnlySnapshot(snapshot)) return errors;
  if (
    typeof scope.startDate !== 'string'
    || typeof scope.endDate !== 'string'
    || typeof scope.maximumDays !== 'number'
  ) {
    errors.push('scope must carry startDate/endDate/maximumDays');
    return errors;
  }
  let expected;
  try {
    expected = expectedWindows({
      startDate: scope.startDate,
      endDate: scope.endDate,
      maximumDays: scope.maximumDays,
    });
  } catch {
    errors.push('scope range is invalid');
    return errors;
  }
  if (windows.length !== expected.length) {
    errors.push(`window audit length ${windows.length} does not match expected ${expected.length}`);
    return errors;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (windows[index].startDate !== expected[index].startDate
      || windows[index].endDate !== expected[index].endDate) {
      errors.push(`window audit [${index}] ${windows[index].startDate}..${windows[index].endDate} does not match ${expected[index].startDate}..${expected[index].endDate}`);
      return errors;
    }
  }
  return errors;
}

/**
 * Validate one session snapshot before it may enter a merge.
 *
 * - `strictProduced` requires every page to be AVAILABLE with all four gates
 *   and the full store roster (a half-set must never merge into production).
 * - The roster must be the canonical 25-store roster.
 * - Every row must pass the shared row contract.
 * - When a backfill audit is present it must be a deterministic contiguous
 *   split of the declared scope.
 * - Two rows with the same pageId + storeCode + row.id must carry identical
 *   content (the raw id namespaces of different pages stay independent).
 */
export function validateSnapshotForMerge(snapshot, {
  strictProduced = false,
  expectedStoreCount = FULL_MANAGED_STORE_CODES.length,
} = {}) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return ['snapshot must be an object'];
  }
  if (snapshot.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!snapshot.pages || typeof snapshot.pages !== 'object' || Array.isArray(snapshot.pages)) {
    return [...errors, 'pages is required'];
  }
  const roster = rosterOf(snapshot);
  if (!roster) {
    errors.push('roster is required');
  } else if (roster.length !== expectedStoreCount
    || roster.some((code) => !ROSTER.has(code))) {
    errors.push(`roster must be the canonical ${expectedStoreCount}-store roster`);
  }
  const pageIds = Object.keys(snapshot.pages).sort();
  for (const pageId of pageIds) {
    if (!ORDER_MANAGEMENT_PAGE_IDS.includes(pageId)) {
      errors.push(`pages.${pageId} is not a fixed page id`);
      continue;
    }
    const page = snapshot.pages[pageId];
    errors.push(...validateRowsOfPage(pageId, page));
    if (strictProduced) {
      if (!fullGatesPassed(page, expectedStoreCount)) {
        errors.push(`pages.${pageId} must be AVAILABLE with total/paging/dedupe/content gates and ${expectedStoreCount} stores`);
      }
    } else if (page?.status === 'AVAILABLE' && !fullGatesPassed(page, expectedStoreCount)) {
      errors.push(`pages.${pageId} claims AVAILABLE without the full gate set`);
    }
  }
  if (strictProduced && pageIds.length === 0) errors.push('produced snapshot carries no pages');
  errors.push(...validateWindowContinuity(snapshot));
  errors.push(...rowKeyConflicts(snapshot.pages).map((conflict) => `row conflict: ${conflict}`));
  return errors;
}

/**
 * Additive snapshot merge.  `produced` (a new backfill run, strictly gated)
 * is layered over `existing` (e.g. the verified production complete snapshot):
 *
 * - both snapshots must carry the canonical 25-store roster;
 * - a page present in both must be byte-identical (nothing may be silently
 *   overwritten, and the existing stock-records/waybills history is kept
 *   untouched);
 * - the produced window audit must be contiguous over its scope;
 * - every produced page must pass the total/paging/dedupe/content/25-store
 *   gates;
 * - two rows with the same pageId + storeCode + row.id must be identical.
 *
 * The returned snapshot is frozen and pure; the caller writes it atomically.
 */
export function mergeOrderManagementSessionSnapshots({
  existing,
  produced,
  now = new Date(),
} = {}) {
  const existingErrors = validateSnapshotForMerge(existing);
  const producedErrors = validateSnapshotForMerge(produced, { strictProduced: true });
  const errors = [
    ...existingErrors.map((error) => `existing: ${error}`),
    ...producedErrors.map((error) => `produced: ${error}`),
  ];
  if (errors.length > 0) {
    throw new TypeError(`ORDER_MANAGEMENT_MERGE_SNAPSHOT_INVALID\n${errors.join('\n')}`);
  }
  const existingRoster = rosterOf(existing);
  const producedRoster = rosterOf(produced);
  if (!isDeepStrictEqual(existingRoster, producedRoster)) {
    throw new TypeError('ORDER_MANAGEMENT_MERGE_ROSTER_MISMATCH');
  }
  const overlap = Object.keys(existing.pages)
    .filter((pageId) => Object.prototype.hasOwnProperty.call(produced.pages, pageId));
  for (const pageId of overlap) {
    if (!isDeepStrictEqual(existing.pages[pageId], produced.pages[pageId])) {
      throw new TypeError(`ORDER_MANAGEMENT_MERGE_PAGE_CONFLICT: ${pageId}`);
    }
  }
  const pages = Object.freeze({
    ...existing.pages,
    ...produced.pages,
  });
  const startDate = existing.scope?.startDate;
  const endDate = existing.scope?.endDate;
  const maximumDays = existing.scope?.maximumDays ?? 30;
  if (!startDate || !endDate
    || startDate !== produced.scope?.startDate
    || endDate !== produced.scope?.endDate
    || maximumDays !== (produced.scope?.maximumDays ?? 30)) {
    throw new TypeError('ORDER_MANAGEMENT_MERGE_SCOPE_MISMATCH');
  }
  if (existing.window?.startDate !== startDate
    || existing.window?.endDate !== endDate
    || produced.window?.startDate !== startDate
    || produced.window?.endDate !== endDate) {
    throw new TypeError('ORDER_MANAGEMENT_MERGE_SCOPE_MISSING');
  }
  const windows = mergeWindowAudits(existing, produced);
  const once = mergeOnceAudits(existing, produced);
  const scope = Object.freeze({
    startDate,
    endDate,
    storeCodes: Object.freeze([...FULL_MANAGED_STORE_CODES].sort()),
    windowCount: windows.length,
    maximumDays,
    pageIds: Object.freeze(Object.keys(pages).sort()),
  });
  const snapshot = Object.freeze({
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    roster: Object.freeze([...FULL_MANAGED_STORE_CODES].sort()),
    window: Object.freeze({ startDate: scope.startDate, endDate: scope.endDate }),
    scope,
    backfill: Object.freeze({
      windows,
      once,
    }),
    pages,
  });
  return Object.freeze({ snapshot });
}
