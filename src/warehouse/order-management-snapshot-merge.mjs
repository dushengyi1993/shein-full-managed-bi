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
 * Existing and additive backfills cover the same scope but may legitimately
 * carry different segmentations (e.g. the production split truncated at
 * year boundaries vs. a from-start 30-day split).  Both audits were already
 * validated as legal before this point, so merge them into the deterministic
 * common refinement: every boundary date of either input becomes a
 * merged-window boundary, which yields contiguous, non-overlapping windows
 * each contained in exactly one window of each input.  Merging by index or
 * concatenating the two calendars would either fail on the differing split
 * or fabricate overlapping/duplicated windows, so neither is used.
 *
 * Each merged window keeps the deduplicated partFile/partFiles, the latest
 * fetchedAt, the union of the two source windows' page audits (identical
 * overlapping page audits merge, conflicting ones fail closed) and an
 * explicit `sources` attribution naming the exact original window of each
 * input that contributed the evidence.
 */
function mergeWindowAudits(existing, produced) {
  const left = existing?.backfill?.windows;
  const right = produced?.backfill?.windows;
  if (!Array.isArray(left) || !Array.isArray(right)) {
    throw new TypeError('ORDER_MANAGEMENT_MERGE_WINDOW_SCOPE_MISMATCH');
  }
  if (right.length === 0 && isOnceOnlySnapshot(produced)) return Object.freeze([...left]);
  if (left.length === 0 && isOnceOnlySnapshot(existing)) return Object.freeze([...right]);
  if (left.length === 0 || right.length === 0) {
    throw new TypeError('ORDER_MANAGEMENT_MERGE_WINDOW_SCOPE_MISMATCH');
  }
  const boundaries = new Set();
  for (const entry of [...left, ...right]) {
    const start = epochDays(entry?.startDate);
    const end = epochDays(entry?.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new TypeError('ORDER_MANAGEMENT_MERGE_WINDOW_SCOPE_MISMATCH');
    }
    boundaries.add(start);
    boundaries.add(end + 1);
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const merged = [];
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const segmentStart = sorted[index];
    const segmentEnd = sorted[index + 1] - 1;
    const startDate = isoFromDays(segmentStart);
    const endDate = isoFromDays(segmentEnd);
    const covers = (entry) => epochDays(entry.startDate) <= segmentStart
      && epochDays(entry.endDate) >= segmentEnd;
    const leftSource = left.find(covers);
    const rightSource = right.find(covers);
    if (!leftSource || !rightSource) {
      throw new TypeError('ORDER_MANAGEMENT_MERGE_WINDOW_SCOPE_MISMATCH');
    }
    const partFiles = [...new Set([
      ...auditPartFiles(leftSource),
      ...auditPartFiles(rightSource),
    ])].sort();
    const fetchedAt = [leftSource?.fetchedAt, rightSource?.fetchedAt]
      .filter((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
      .sort()
      .at(-1) ?? null;
    merged.push(Object.freeze({
      index: merged.length + 1,
      startDate,
      endDate,
      partFile: partFiles[0] ?? null,
      partFiles: Object.freeze(partFiles),
      fetchedAt,
      pages: mergeAuditPages(
        leftSource.pages,
        rightSource.pages,
        `window-${merged.length + 1}`,
      ),
      sources: Object.freeze([
        Object.freeze({
          snapshot: 'existing',
          startDate: leftSource.startDate,
          endDate: leftSource.endDate,
        }),
        Object.freeze({
          snapshot: 'produced',
          startDate: rightSource.startDate,
          endDate: rightSource.endDate,
        }),
      ]),
    }));
  }
  return Object.freeze(merged);
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
 * Verify one snapshot's window audit against its declared scope.  A legal
 * audit is any segmentation that covers the scope exactly: the first window
 * starts at scope.startDate, the last window ends at scope.endDate, windows
 * are sorted, contiguous, non-overlapping and gap-free, and each window spans
 * at most scope.maximumDays inclusive days.  The exact boundary choice is not
 * constrained: different backfill runs may legitimately segment the same
 * scope differently (e.g. a year-boundary-truncated split in production vs.
 * a from-start 30-day split in a later run).
 *
 * Returns a list of human-readable errors (empty when the snapshot carries
 * no audit and no scope to check).  `options` is accepted for caller
 * compatibility; the recorded scope.maximumDays is authoritative because the
 * audit must be judged against the maximum the backfill actually used.
 */
export function validateWindowContinuity(snapshot, options = {}) {
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
  const maxDays = scope.maximumDays;
  if (!Number.isSafeInteger(maxDays) || maxDays < 1 || maxDays > 30) {
    errors.push(`scope maximumDays ${maxDays} is invalid (must be an integer between 1 and 30)`);
    return errors;
  }
  const first = epochDays(scope.startDate);
  const last = epochDays(scope.endDate);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) {
    errors.push('scope range is invalid');
    return errors;
  }
  if (windows.length === 0) {
    errors.push('window audit is empty but the scope requires coverage');
    return errors;
  }
  const ranges = windows.map((window) => ({
    start: epochDays(window.startDate),
    end: epochDays(window.endDate),
  }));
  for (let index = 0; index < ranges.length; index += 1) {
    const { start, end } = ranges[index];
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      errors.push(`window audit [${index}] ${windows[index].startDate}..${windows[index].endDate} is not a valid date range`);
      return errors;
    }
    if (end - start + 1 > maxDays) {
      errors.push(`window audit [${index}] ${windows[index].startDate}..${windows[index].endDate} exceeds the ${maxDays}-day maximum`);
      return errors;
    }
  }
  if (ranges[0].start !== first) {
    errors.push(`window audit starts at ${windows[0].startDate} but the scope starts at ${scope.startDate}`);
    return errors;
  }
  if (ranges[ranges.length - 1].end !== last) {
    errors.push(`window audit ends at ${windows[ranges.length - 1].endDate} but the scope ends at ${scope.endDate}`);
    return errors;
  }
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start !== ranges[index - 1].end + 1) {
      errors.push(`window audit has a gap or overlap between [${index - 1}] ${windows[index - 1].startDate}..${windows[index - 1].endDate} and [${index}] ${windows[index].startDate}..${windows[index].endDate}`);
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
 * - When a backfill audit is present it must be a legal segmentation of the
 *   declared scope: contiguous, non-overlapping and gap-free, covering the
 *   scope exactly with windows of at most scope.maximumDays inclusive days
 *   (the exact boundary choice is free).
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
 * - the produced window audit must be a legal segmentation of its scope:
 *   contiguous, non-overlapping and gap-free, covering the scope exactly
 *   with windows of at most scope.maximumDays inclusive days (the exact
 *   boundary choice is free, so a from-start 30-day split may merge over a
 *   production audit split at year boundaries);
 * - every produced page must pass the total/paging/dedupe/content/25-store
 *   gates;
 * - two rows with the same pageId + storeCode + row.id must be identical.
 *
 * The returned snapshot is frozen and pure; the caller writes it atomically.
 * The merged window audit is the deterministic common refinement of the two
 * inputs' legal segmentations, so every part file and page audit from both
 * inputs survives with an explicit `sources` attribution and no window is
 * duplicated or overlapped.
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
