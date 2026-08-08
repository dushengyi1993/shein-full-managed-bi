#!/usr/bin/env node

import process from 'node:process';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import {
  FULL_MANAGED_STORE_CODES,
  normalizeFullManagedStoreCode,
} from '../src/config/full-managed-stores.mjs';
import { validateOrderManagementRow } from '../src/order-management/order-management-contract.mjs';
import { createEncryptedWebApiSessionStoreFromEnvironment } from '../src/webapi-session/encrypted-session-store.mjs';
import {
  ORDER_MANAGEMENT_ENDPOINTS,
  ORDER_MANAGEMENT_ONCE_ONLY_PAGES,
  ORDER_MANAGEMENT_SESSION_PAGES,
  ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
} from '../src/webapi-history/order-management-contracts.mjs';
import { atomicWriteJson } from '../src/warehouse/dashboard-materializer.mjs';
import { mergeOrderManagementSessionSnapshots } from '../src/warehouse/order-management-snapshot-merge.mjs';
import {
  normalizeSessionPageScope,
  parseStrictIsoDate,
  runOrderManagementSessionSync,
  shanghaiDate,
} from './sync_full_managed_order_management_sessions.mjs';

const ROSTER = new Set(FULL_MANAGED_STORE_CODES);

/**
 * Fixed page scope of the session backfill: every session-backed
 * order-management page.  `--page-ids` may restrict this to a strict subset
 * (e.g. only the five newly verified pages) without weakening the default.
 */
export const BACKFILL_PAGE_IDS = Object.freeze(Object.keys(ORDER_MANAGEMENT_SESSION_PAGES));

/** Pages whose endpoints carry a date filter and join the per-window loop. */
export const BACKFILL_WINDOWED_PAGE_IDS = Object.freeze(
  Object.entries(ORDER_MANAGEMENT_SESSION_PAGES)
    .filter(([, endpointCode]) => Boolean(ORDER_MANAGEMENT_ENDPOINTS[endpointCode]?.windowFields))
    .map(([pageId]) => pageId),
);

/** Pages whose endpoints carry no date filter and are fetched once in full. */
export const BACKFILL_ONCE_PAGE_IDS = Object.freeze([...ORDER_MANAGEMENT_ONCE_ONLY_PAGES]);

const DAY_MS = 86_400_000;

function epochDays(value) {
  return Math.round(Date.parse(`${value}T00:00:00.000Z`) / DAY_MS);
}

function isoFromDays(days) {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Deterministic offline split of a backfill range into consecutive,
 * non-overlapping windows of at most `maximumDays` inclusive days each.
 */
export function buildBackfillWindows({
  startDate,
  endDate,
  maximumDays = ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
} = {}) {
  if (
    !Number.isSafeInteger(maximumDays)
    || maximumDays < 1
    || maximumDays > ORDER_MANAGEMENT_WINDOW_MAX_DAYS
  ) {
    throw new TypeError('ORDER_MANAGEMENT_BACKFILL_WINDOW_MAX_INVALID');
  }
  const start = parseStrictIsoDate(startDate);
  const end = parseStrictIsoDate(endDate);
  if (!start || !end) throw new TypeError('ORDER_MANAGEMENT_BACKFILL_DATE_INVALID');
  const first = epochDays(start);
  const last = epochDays(end);
  if (first > last) throw new TypeError('ORDER_MANAGEMENT_BACKFILL_RANGE_INVALID');
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

/**
 * Deterministic per-window audit part path derived from the final output
 * path and the window dates.
 */
export function partFileForWindow(output, index, window) {
  return `${output}.part.${String(index + 1).padStart(2, '0')}.${window.startDate}.${window.endDate}.json`;
}

/**
 * Deterministic audit part path for the once-only full fetch of the
 * no-date-filter pages (exceptions / value-added-services).
 */
export function partFileForOnce(output, pageIds) {
  const key = [...new Set(pageIds)].sort().join('.');
  return `${output}.part.once.${key}.json`;
}

export function parseArgs(argv) {
  const result = {
    stores: [],
    startDate: null,
    endDate: null,
    output: null,
    pageIds: [...BACKFILL_PAGE_IDS],
    mergeWith: null,
    execute: false,
  };
  for (const token of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) throw new Error('ORDER_MANAGEMENT_BACKFILL_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'execute' && value === undefined) result.execute = true;
    else if (name === 'stores' && value) {
      result.stores = [...new Set(value.split(',').map((item) => item.trim().toUpperCase()))];
    } else if (name === 'page-ids' && value) {
      result.pageIds = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
    } else if (name === 'merge-with' && value) result.mergeWith = value;
    else if (name === 'start-date' && value) result.startDate = value;
    else if (name === 'end-date' && value) result.endDate = value;
    else if (name === 'output' && value) result.output = value;
    else throw new Error('ORDER_MANAGEMENT_BACKFILL_ARGUMENT_INVALID');
  }
  if (!result.startDate || !result.endDate) throw new Error('ORDER_MANAGEMENT_BACKFILL_RANGE_REQUIRED');
  if (!result.output) throw new Error('ORDER_MANAGEMENT_BACKFILL_OUTPUT_REQUIRED');
  if (
    result.stores.length === 0
    || result.stores.some((store) => !normalizeFullManagedStoreCode(store))
  ) {
    throw new Error('ORDER_MANAGEMENT_BACKFILL_STORE_SCOPE_REQUIRED');
  }
  const rosterCovered = FULL_MANAGED_STORE_CODES.every((store) => result.stores.includes(store))
    && result.stores.every((store) => ROSTER.has(store));
  if (!rosterCovered) throw new Error('ORDER_MANAGEMENT_BACKFILL_STORE_SCOPE_REQUIRED');
  if (result.pageIds.length === 0
    || result.pageIds.some((pageId) => !BACKFILL_PAGE_IDS.includes(pageId))) {
    throw new Error('ORDER_MANAGEMENT_BACKFILL_PAGE_SCOPE_REQUIRED');
  }
  return result;
}

function pageGatesPassed(page, expectedStoreCount = FULL_MANAGED_STORE_CODES.length) {
  const gates = page?.gates ?? {};
  return page?.status === 'AVAILABLE'
    && gates.totalVerified === true
    && gates.pagingVerified === true
    && gates.dedupeVerified === true
    && gates.contentVerified !== false
    && gates.storeCount === expectedStoreCount;
}

function windowGatesPassed(snapshot, { startDate, endDate, pageIds } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.pages || typeof snapshot.pages !== 'object') {
    return false;
  }
  if (
    snapshot.window?.startDate !== startDate
    || snapshot.window?.endDate !== endDate
  ) {
    return false;
  }
  const pageIdsInSnapshot = Object.keys(snapshot.pages).sort();
  if (
    pageIdsInSnapshot.length !== pageIds.length
    || pageIdsInSnapshot.some((pageId) => !pageIds.includes(pageId))
  ) {
    return false;
  }
  return pageIds.every((pageId) => pageGatesPassed(snapshot.pages[pageId]));
}

function onceGatesPassed(snapshot, { pageIds } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.pages || typeof snapshot.pages !== 'object') {
    return false;
  }
  const pageIdsInSnapshot = Object.keys(snapshot.pages).sort();
  if (
    pageIdsInSnapshot.length !== pageIds.length
    || pageIdsInSnapshot.some((pageId) => !pageIds.includes(pageId))
  ) {
    return false;
  }
  return pageIds.every((pageId) => pageGatesPassed(snapshot.pages[pageId]));
}

/**
 * Dedupe merge by pageId + storeCode + row.id.  A key that appears in more
 * than one window must carry an identical row; any inconsistency fails the
 * whole backfill instead of guessing.
 */
function mergeWindowRows(snapshots, { pageIds }) {
  const merged = new Map();
  const conflicts = [];
  for (const snapshot of snapshots) {
    for (const pageId of pageIds) {
      const rows = snapshot.pages?.[pageId]?.rows;
      if (!Array.isArray(rows)) {
        throw new TypeError(`ORDER_MANAGEMENT_BACKFILL_WINDOW_GATE_FAILED: ${pageId} rows missing`);
      }
      for (const row of rows) {
        const key = `${pageId}\u001f${row.storeCode}\u001f${row.id}`;
        const existing = merged.get(key);
        if (existing === undefined) merged.set(key, row);
        else if (!isDeepStrictEqual(existing, row)) {
          conflicts.push(`${pageId}/${row.storeCode}/${row.id}`);
        }
      }
    }
  }
  if (conflicts.length > 0) {
    const shown = conflicts.slice(0, 8).join(', ');
    throw new TypeError(
      `ORDER_MANAGEMENT_BACKFILL_CROSS_WINDOW_CONFLICT: ${shown}${conflicts.length > 8 ? ', ...' : ''}`,
    );
  }
  return merged;
}

function buildFinalPages(mergedRows, snapshots, { now, pageIds }) {
  const pages = {};
  for (const pageId of pageIds) {
    const rows = [];
    for (const [key, row] of mergedRows) {
      if (key.startsWith(`${pageId}\u001f`)) rows.push(row);
    }
    rows.forEach((row, index) => {
      const check = validateOrderManagementRow(row, { pageId });
      if (!check.ok) {
        throw new TypeError(`ORDER_MANAGEMENT_BACKFILL_ROW_INVALID: ${pageId}[${index}] ${check.errors[0]}`);
      }
    });
    const fetched = snapshots
      .map((snapshot) => snapshot.pages?.[pageId]?.latestSourceFetchedAt)
      .filter((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
      .map((value) => Date.parse(value))
      .sort((a, b) => a - b);
    pages[pageId] = Object.freeze({
      status: 'AVAILABLE',
      source: 'SESSION_HTTP',
      latestSourceFetchedAt: fetched.length > 0
        ? new Date(fetched.at(-1)).toISOString()
        : now.toISOString(),
      reason: null,
      storeCodes: Object.freeze([...FULL_MANAGED_STORE_CODES].sort()),
      gates: Object.freeze({
        totalVerified: true,
        pagingVerified: true,
        dedupeVerified: true,
        contentVerified: true,
        storeCount: FULL_MANAGED_STORE_CODES.length,
      }),
      rows: Object.freeze(rows),
    });
  }
  return Object.freeze(pages);
}

/**
 * History backfill over explicit date ranges.  Dry-run returns a
 * deterministic offline plan and never touches the network.  Execute splits
 * the range into contiguous non-overlapping windows of at most 30 days for
 * the date-filtered pages and calls runOrderManagementSessionSync once per
 * window with the same encrypted session store; each window writes its own
 * audit part file.  Pages without a date filter (exceptions /
 * value-added-services) are fetched exactly once in full per run and written
 * to a single deterministic once-part.  The final output is only written
 * after every window and the once part pass the AVAILABLE / total / paging /
 * dedupe / content / 25-store gates and the dedupe merge finds no
 * cross-window conflict.  With `--merge-with` the produced snapshot is
 * additively merged over the existing snapshot (e.g. the verified production
 * complete snapshot) so the existing stock-records / waybills pages are kept
 * byte-identical and never refetched.
 */
export async function runOrderManagementSessionBackfill({
  storeCodes,
  startDate,
  endDate,
  output,
  execute = false,
  sessionStore = null,
  openSession = null,
  runWindow = runOrderManagementSessionSync,
  now = new Date(),
  maximumDays = ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
  pageIds = null,
  mergeWith = null,
} = {}) {
  const stores = [...new Set((storeCodes ?? []).map((value) => String(value).trim().toUpperCase()))];
  const rosterCovered = stores.length > 0
    && stores.every((store) => normalizeFullManagedStoreCode(store) !== null)
    && FULL_MANAGED_STORE_CODES.every((store) => stores.includes(store))
    && stores.every((store) => ROSTER.has(store));
  if (!rosterCovered) throw new TypeError('ORDER_MANAGEMENT_BACKFILL_STORE_SCOPE_REQUIRED');
  const rangeStart = parseStrictIsoDate(startDate);
  const rangeEnd = parseStrictIsoDate(endDate);
  if (!rangeStart || !rangeEnd) throw new TypeError('ORDER_MANAGEMENT_BACKFILL_DATE_INVALID');
  if (rangeStart > rangeEnd) throw new TypeError('ORDER_MANAGEMENT_BACKFILL_RANGE_INVALID');
  if (rangeEnd > shanghaiDate(now)) throw new TypeError('ORDER_MANAGEMENT_BACKFILL_RANGE_FUTURE');
  if (!output) throw new TypeError('ORDER_MANAGEMENT_BACKFILL_OUTPUT_REQUIRED');

  const scopedPageIds = normalizeSessionPageScope(
    pageIds ?? Object.keys(ORDER_MANAGEMENT_SESSION_PAGES),
  );
  if (scopedPageIds.some((pageId) => !BACKFILL_PAGE_IDS.includes(pageId))) {
    throw new TypeError('ORDER_MANAGEMENT_BACKFILL_PAGE_SCOPE_REQUIRED');
  }
  const windowedPageIds = scopedPageIds
    .filter((pageId) => BACKFILL_WINDOWED_PAGE_IDS.includes(pageId));
  const oncePageIds = scopedPageIds
    .filter((pageId) => BACKFILL_ONCE_PAGE_IDS.includes(pageId));
  const windows = windowedPageIds.length > 0
    ? buildBackfillWindows({ startDate: rangeStart, endDate: rangeEnd, maximumDays })
    : Object.freeze([]);
  const windowPartFiles = windows.map((window, index) => path.resolve(partFileForWindow(output, index, window)));
  const oncePartFile = oncePageIds.length > 0
    ? path.resolve(partFileForOnce(output, oncePageIds))
    : null;
  const plan = {
    ok: true,
    mode: 'DRY_RUN',
    stores: [...stores].sort(),
    startDate: rangeStart,
    endDate: rangeEnd,
    windowCount: windows.length,
    maximumDays,
    pageIds: [...scopedPageIds],
    windowedPageIds: [...windowedPageIds],
    oncePageIds: [...oncePageIds],
    output: path.resolve(output),
    mergeWith: mergeWith ? path.resolve(mergeWith) : null,
    windows: windows.map((window, index) => ({
      index: index + 1,
      startDate: window.startDate,
      endDate: window.endDate,
      partFile: windowPartFiles[index],
    })),
    onceParts: oncePartFile ? [{ partFile: oncePartFile, pageIds: [...oncePageIds] }] : [],
  };
  if (!execute) return Object.freeze({ ok: true, mode: 'DRY_RUN', plan });
  if (!sessionStore) throw new TypeError('ORDER_MANAGEMENT_BACKFILL_SESSION_STORE_REQUIRED');

  const runOptions = {
    storeCodes: stores,
    includeStatistics: false,
    storeConcurrency: 5,
    sessionStore,
    now,
    ...(openSession ? { openSession } : {}),
  };
  const windowResults = [];
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    const partFile = partFileForWindow(output, index, window);
    const result = await runWindow({
      ...runOptions,
      output: partFile,
      window,
      pageIds: windowedPageIds,
    });
    if (!windowGatesPassed(result?.snapshot, {
      startDate: window.startDate,
      endDate: window.endDate,
      pageIds: windowedPageIds,
    })) {
      throw new TypeError(
        `ORDER_MANAGEMENT_BACKFILL_WINDOW_GATE_FAILED: window ${index + 1} (${window.startDate}..${window.endDate})`,
      );
    }
    windowResults.push(result);
  }

  const onceResults = [];
  if (oncePageIds.length > 0) {
    const partFile = partFileForOnce(output, oncePageIds);
    const result = await runWindow({
      ...runOptions,
      output: partFile,
      window: null,
      pageIds: oncePageIds,
    });
    if (!onceGatesPassed(result?.snapshot, { pageIds: oncePageIds })) {
      throw new TypeError(`ORDER_MANAGEMENT_BACKFILL_ONCE_GATE_FAILED: ${partFile}`);
    }
    onceResults.push(result);
  }

  const snapshots = windowResults.map((result) => result.snapshot);
  const mergedRows = mergeWindowRows(snapshots, { pageIds: windowedPageIds });
  for (const result of onceResults) {
    for (const pageId of oncePageIds) {
      const rows = result.snapshot.pages?.[pageId]?.rows;
      if (!Array.isArray(rows)) {
        throw new TypeError(`ORDER_MANAGEMENT_BACKFILL_ONCE_GATE_FAILED: ${pageId} rows missing`);
      }
      for (const row of rows) {
        const key = `${pageId}\u001f${row.storeCode}\u001f${row.id}`;
        if (mergedRows.has(key)) {
          throw new TypeError(`ORDER_MANAGEMENT_BACKFILL_ONCE_ROW_CONFLICT: ${pageId}/${row.storeCode}/${row.id}`);
        }
        mergedRows.set(key, row);
      }
    }
  }

  const pages = buildFinalPages(mergedRows, [...snapshots, ...onceResults.map((result) => result.snapshot)], {
    now,
    pageIds: scopedPageIds,
  });
  const windowsAudit = snapshots.map((snapshot, index) => {
    const window = windows[index];
    return Object.freeze({
      index: index + 1,
      startDate: window.startDate,
      endDate: window.endDate,
      partFile: path.resolve(partFileForWindow(output, index, window)),
      fetchedAt: snapshot.updatedAt ?? null,
      pages: Object.freeze(Object.fromEntries(windowedPageIds.map((pageId) => {
        const page = snapshot.pages[pageId];
        return [pageId, Object.freeze({
          status: page.status,
          rowCount: page.rows.length,
          latestSourceFetchedAt: page.latestSourceFetchedAt ?? null,
          gates: Object.freeze({
            totalVerified: page.gates?.totalVerified === true,
            pagingVerified: page.gates?.pagingVerified === true,
            dedupeVerified: page.gates?.dedupeVerified === true,
            contentVerified: page.gates?.contentVerified !== false,
            storeCount: page.gates?.storeCount ?? null,
          }),
        })];
      }))),
    });
  });
  const onceAudit = onceResults.map((result) => Object.freeze({
    index: 1,
    pageIds: Object.freeze([...oncePageIds]),
    partFile: path.resolve(partFileForOnce(output, oncePageIds)),
    fetchedAt: result.snapshot.updatedAt ?? null,
    pages: Object.freeze(Object.fromEntries(oncePageIds.map((pageId) => {
      const page = result.snapshot.pages[pageId];
      return [pageId, Object.freeze({
        status: page.status,
        rowCount: page.rows.length,
        latestSourceFetchedAt: page.latestSourceFetchedAt ?? null,
        gates: Object.freeze({
          totalVerified: page.gates?.totalVerified === true,
          pagingVerified: page.gates?.pagingVerified === true,
          dedupeVerified: page.gates?.dedupeVerified === true,
          contentVerified: page.gates?.contentVerified !== false,
          storeCount: page.gates?.storeCount ?? null,
        }),
      })];
    }))),
  }));
  const snapshot = Object.freeze({
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    roster: Object.freeze([...FULL_MANAGED_STORE_CODES]),
    window: Object.freeze({ startDate: rangeStart, endDate: rangeEnd }),
    scope: Object.freeze({
      startDate: rangeStart,
      endDate: rangeEnd,
      storeCodes: Object.freeze([...FULL_MANAGED_STORE_CODES].sort()),
      windowCount: windows.length,
      maximumDays,
      pageIds: Object.freeze([...scopedPageIds]),
    }),
    backfill: Object.freeze({
      windows: Object.freeze(windowsAudit),
      once: Object.freeze(onceAudit),
    }),
    pages,
  });
  const partFiles = Object.freeze([
    ...windowPartFiles,
    ...(oncePartFile ? [oncePartFile] : []),
  ]);
  if (mergeWith) {
    const sourcePath = path.resolve(mergeWith);
    let existing;
    try {
      existing = JSON.parse(await readFile(sourcePath, 'utf8'));
    } catch {
      throw new TypeError('ORDER_MANAGEMENT_BACKFILL_MERGE_SOURCE_INVALID_JSON');
    }
    const merged = mergeOrderManagementSessionSnapshots({ existing, produced: snapshot, now });
    const written = await atomicWriteJson(output, merged.snapshot);
    return Object.freeze({
      ok: true,
      mode: 'EXECUTE',
      snapshot: merged.snapshot,
      written,
      partFiles,
      mergedFrom: sourcePath,
    });
  }
  const written = await atomicWriteJson(output, snapshot);
  return Object.freeze({
    ok: true,
    mode: 'EXECUTE',
    snapshot,
    written,
    partFiles,
    mergedFrom: null,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionStore = args.execute
    ? await createEncryptedWebApiSessionStoreFromEnvironment()
    : null;
  const result = await runOrderManagementSessionBackfill({
    storeCodes: args.stores,
    startDate: args.startDate,
    endDate: args.endDate,
    output: args.output,
    execute: args.execute,
    sessionStore,
    pageIds: args.pageIds,
    mergeWith: args.mergeWith,
  });
  if (!args.execute) {
    console.log(JSON.stringify(result.plan, null, 2));
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    mode: 'EXECUTE',
    output: result.written,
    updatedAt: result.snapshot.updatedAt,
    mergedFrom: result.mergedFrom,
    scope: {
      startDate: result.snapshot.scope.startDate,
      endDate: result.snapshot.scope.endDate,
      windowCount: result.snapshot.scope.windowCount,
      pageIds: result.snapshot.scope.pageIds,
    },
    partFiles: result.partFiles,
    pages: Object.fromEntries(
      Object.entries(result.snapshot.pages).map(([pageId, page]) => [
        pageId,
        { status: page.status, rows: page.rows.length, gates: page.gates },
      ]),
    ),
  }, null, 2));
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/backfill_full_managed_order_management_sessions.mjs')) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      errorCode: String(error?.message ?? 'ORDER_MANAGEMENT_BACKFILL_FAILED')
        .split(':')[0].trim().replace(/[^A-Z0-9_]/g, '_'),
      message: String(error?.message ?? 'Order-management session backfill failed.'),
    }));
    process.exitCode = 1;
  });
}
