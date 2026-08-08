#!/usr/bin/env node

import process from 'node:process';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  FULL_MANAGED_STORE_CODES,
  normalizeFullManagedStoreCode,
} from '../src/config/full-managed-stores.mjs';
import { validateOrderManagementRow } from '../src/order-management/order-management-contract.mjs';
import { createEncryptedWebApiSessionStoreFromEnvironment } from '../src/webapi-session/encrypted-session-store.mjs';
import { ORDER_MANAGEMENT_WINDOW_MAX_DAYS } from '../src/webapi-history/order-management-contracts.mjs';
import { atomicWriteJson } from '../src/warehouse/dashboard-materializer.mjs';
import {
  parseStrictIsoDate,
  runOrderManagementSessionSync,
  shanghaiDate,
} from './sync_full_managed_order_management_sessions.mjs';

const ROSTER = new Set(FULL_MANAGED_STORE_CODES);
const BACKFILL_PAGE_IDS = Object.freeze(['stock-records', 'waybills']);
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

export function parseArgs(argv) {
  const result = {
    stores: [],
    startDate: null,
    endDate: null,
    output: null,
    execute: false,
  };
  for (const token of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) throw new Error('ORDER_MANAGEMENT_BACKFILL_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'execute' && value === undefined) result.execute = true;
    else if (name === 'stores' && value) {
      result.stores = [...new Set(value.split(',').map((item) => item.trim().toUpperCase()))];
    } else if (name === 'start-date' && value) result.startDate = value;
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
  return result;
}

function windowGatesPassed(snapshot, { startDate, endDate } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.pages || typeof snapshot.pages !== 'object') {
    return false;
  }
  if (
    snapshot.window?.startDate !== startDate
    || snapshot.window?.endDate !== endDate
  ) {
    return false;
  }
  const pageIds = Object.keys(snapshot.pages).sort();
  if (
    pageIds.length !== BACKFILL_PAGE_IDS.length
    || pageIds.some((pageId) => !BACKFILL_PAGE_IDS.includes(pageId))
  ) {
    return false;
  }
  return BACKFILL_PAGE_IDS.every((pageId) => {
    const page = snapshot.pages[pageId];
    const gates = page?.gates ?? {};
    return page?.status === 'AVAILABLE'
      && gates.totalVerified === true
      && gates.pagingVerified === true
      && gates.dedupeVerified === true
      && gates.storeCount === FULL_MANAGED_STORE_CODES.length;
  });
}

/**
 * Dedupe merge by pageId + storeCode + row.id.  A key that appears in more
 * than one window must carry an identical row; any inconsistency fails the
 * whole backfill instead of guessing.
 */
function mergeWindowRows(snapshots) {
  const merged = new Map();
  const conflicts = [];
  for (const snapshot of snapshots) {
    for (const pageId of BACKFILL_PAGE_IDS) {
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

function buildFinalPages(mergedRows, snapshots, { now }) {
  const pages = {};
  for (const pageId of BACKFILL_PAGE_IDS) {
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
 * the range into contiguous non-overlapping windows of at most 30 days and
 * calls runOrderManagementSessionSync once per window with the same
 * encrypted session store; each window writes its own audit part file.  The
 * final output is only written after every window passes the AVAILABLE /
 * total / paging / dedupe / 25-store gates and the dedupe merge finds no
 * cross-window conflict.
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

  const windows = buildBackfillWindows({ startDate: rangeStart, endDate: rangeEnd, maximumDays });
  const plan = {
    ok: true,
    mode: 'DRY_RUN',
    stores: [...stores].sort(),
    startDate: rangeStart,
    endDate: rangeEnd,
    windowCount: windows.length,
    maximumDays,
    output: path.resolve(output),
    windows: windows.map((window, index) => ({
      index: index + 1,
      startDate: window.startDate,
      endDate: window.endDate,
      partFile: path.resolve(partFileForWindow(output, index, window)),
    })),
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
    const result = await runWindow({ ...runOptions, output: partFile, window });
    if (!windowGatesPassed(result?.snapshot, { startDate: window.startDate, endDate: window.endDate })) {
      throw new TypeError(
        `ORDER_MANAGEMENT_BACKFILL_WINDOW_GATE_FAILED: window ${index + 1} (${window.startDate}..${window.endDate})`,
      );
    }
    windowResults.push(result);
  }

  const snapshots = windowResults.map((result) => result.snapshot);
  const mergedRows = mergeWindowRows(snapshots);
  const pages = buildFinalPages(mergedRows, snapshots, { now });
  const windowsAudit = snapshots.map((snapshot, index) => {
    const window = windows[index];
    return Object.freeze({
      index: index + 1,
      startDate: window.startDate,
      endDate: window.endDate,
      partFile: path.resolve(partFileForWindow(output, index, window)),
      fetchedAt: snapshot.updatedAt ?? null,
      pages: Object.freeze(Object.fromEntries(BACKFILL_PAGE_IDS.map((pageId) => {
        const page = snapshot.pages[pageId];
        return [pageId, Object.freeze({
          status: page.status,
          rowCount: page.rows.length,
          latestSourceFetchedAt: page.latestSourceFetchedAt ?? null,
          gates: Object.freeze({
            totalVerified: page.gates?.totalVerified === true,
            pagingVerified: page.gates?.pagingVerified === true,
            dedupeVerified: page.gates?.dedupeVerified === true,
            storeCount: page.gates?.storeCount ?? null,
          }),
        })];
      }))),
    });
  });
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
    }),
    backfill: Object.freeze({
      windows: Object.freeze(windowsAudit),
    }),
    pages,
  });
  const written = await atomicWriteJson(output, snapshot);
  return Object.freeze({
    ok: true,
    mode: 'EXECUTE',
    snapshot,
    written,
    partFiles: Object.freeze(windowsAudit.map((entry) => entry.partFile)),
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
    scope: {
      startDate: result.snapshot.scope.startDate,
      endDate: result.snapshot.scope.endDate,
      windowCount: result.snapshot.scope.windowCount,
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
