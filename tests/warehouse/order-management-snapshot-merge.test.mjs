import assert from 'node:assert/strict';
import test from 'node:test';

import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';
import {
  expectedWindows,
  mergeOrderManagementSessionSnapshots,
  rowKeyConflicts,
  validateSnapshotForMerge,
  validateWindowContinuity,
} from '../../src/warehouse/order-management-snapshot-merge.mjs';

const NOW = new Date('2026-08-08T06:00:00.000Z');
const ROSTER = [...FULL_MANAGED_STORE_CODES];
const DAY_MS = 86_400_000;

function epochDays(value) {
  return Math.round(Date.parse(`${value}T00:00:00.000Z`) / DAY_MS);
}

function isoFromDays(days) {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

function row(id, storeCode = 'CX4412') {
  return Object.freeze({
    id,
    storeCode,
    statusCode: null,
    statusName: null,
    createdAt: '2022-01-02T00:00:00.000Z',
    updatedAt: '2026-08-08T06:00:00.000Z',
    primary: id,
    secondary: null,
    tags: Object.freeze([]),
    metrics: Object.freeze([]),
    facts: Object.freeze([]),
    details: Object.freeze([]),
  });
}

function page(rows, { contentVerified = true } = {}) {
  return Object.freeze({
    status: 'AVAILABLE',
    source: 'SESSION_HTTP',
    latestSourceFetchedAt: '2026-08-08T06:00:00.000Z',
    reason: null,
    storeCodes: Object.freeze([...ROSTER].sort()),
    gates: Object.freeze({
      totalVerified: true,
      pagingVerified: true,
      dedupeVerified: true,
      contentVerified,
      storeCount: ROSTER.length,
    }),
    rows: Object.freeze(rows),
  });
}

function snapshot({
  startDate = '2026-08-01',
  endDate = '2026-08-08',
  pages = {},
  maximumDays = 30,
  windows = null,
  roster = ROSTER,
} = {}) {
  const windowsList = windows ?? expectedWindows({ startDate, endDate, maximumDays })
    .map((window, index) => ({
      index: index + 1,
      startDate: window.startDate,
      endDate: window.endDate,
      partFile: `/tmp/part.${String(index + 1).padStart(2, '0')}.json`,
      fetchedAt: '2026-08-08T06:00:00.000Z',
      pages: {},
    }));
  return Object.freeze({
    schemaVersion: 1,
    updatedAt: '2026-08-08T06:00:00.000Z',
    roster: Object.freeze([...roster]),
    window: Object.freeze({ startDate, endDate }),
    scope: Object.freeze({
      startDate,
      endDate,
      storeCodes: Object.freeze([...ROSTER].sort()),
      windowCount: windowsList.length,
      maximumDays,
      pageIds: Object.freeze(Object.keys(pages)),
    }),
    backfill: Object.freeze({ windows: Object.freeze(windowsList), once: Object.freeze([]) }),
    pages: Object.freeze(pages),
  });
}

/**
 * Split a range per calendar year: every year starts a fresh 30-day run that
 * is truncated at the year boundary.  This is the segmentation shape of the
 * existing production snapshot (e.g. 2023-12-22..2023-12-31 followed by
 * 2024-01-01..2024-01-30).
 */
function yearTruncatedWindows(startDate, endDate, maximumDays = 30) {
  const windows = [];
  const last = epochDays(endDate);
  const startYear = Number(startDate.slice(0, 4));
  const endYear = Number(endDate.slice(0, 4));
  for (let year = startYear; year <= endYear; year += 1) {
    const yearStart = Math.max(epochDays(startDate), epochDays(`${year}-01-01`));
    const yearEnd = Math.min(last, epochDays(`${year}-12-31`));
    let cursor = yearStart;
    while (cursor <= yearEnd) {
      const candidateEnd = Math.min(cursor + maximumDays - 1, yearEnd);
      windows.push(Object.freeze({
        startDate: isoFromDays(cursor),
        endDate: isoFromDays(candidateEnd),
      }));
      cursor = candidateEnd + 1;
    }
  }
  return Object.freeze(windows);
}

function pageAudit({ rowCount, gates = null } = {}) {
  return Object.freeze({
    status: 'AVAILABLE',
    rowCount,
    latestSourceFetchedAt: '2026-08-08T06:00:00.000Z',
    gates: Object.freeze(gates ?? {
      totalVerified: true,
      pagingVerified: true,
      dedupeVerified: true,
      contentVerified: true,
      storeCount: ROSTER.length,
    }),
  });
}

test('expectedWindows splits deterministically and rejects invalid input', () => {
  assert.deepEqual(expectedWindows({ startDate: '2026-01-01', endDate: '2026-01-31' }), [
    { startDate: '2026-01-01', endDate: '2026-01-30' },
    { startDate: '2026-01-31', endDate: '2026-01-31' },
  ]);
  assert.throws(() => expectedWindows({ startDate: '2026-01-02', endDate: '2026-01-01' }), /INVALID/);
  assert.throws(() => expectedWindows({ startDate: '2026-01-01', endDate: '2026-01-31', maximumDays: 31 }), /INVALID/);
});

test('additive merge keeps the existing pages byte-identical and adds the new pages', () => {
  const existing = snapshot({
    startDate: '2022-01-01',
    endDate: '2026-08-08',
    pages: {
      'stock-records': page([row('PB-1')]),
      waybills: page([row('SF-1')]),
    },
  });
  const produced = snapshot({
    startDate: '2022-01-01',
    endDate: '2026-08-08',
    pages: {
      'return-applications': page([row('RA-1')]),
      'return-orders': page([row('RO-1')]),
      exceptions: page([row('WO-1')]),
      'value-added-services': page([row('VA-1')]),
      'quality-reports': page([row('QC-1')]),
    },
  });
  const merged = mergeOrderManagementSessionSnapshots({ existing, produced, now: NOW }).snapshot;
  assert.deepEqual(merged.pages['stock-records'], existing.pages['stock-records']);
  assert.deepEqual(merged.pages.waybills, existing.pages.waybills);
  assert.equal(merged.pages['quality-reports'].rows[0].id, 'QC-1');
  assert.equal(merged.scope.startDate, '2022-01-01');
  assert.equal(merged.scope.endDate, '2026-08-08');
  assert.equal(
    merged.scope.windowCount,
    existing.scope.windowCount,
  );
  assert.equal(merged.backfill.windows.length, merged.scope.windowCount);
  assert.ok(merged.backfill.windows[0].partFiles.length >= 1);
  assert.deepEqual(Object.keys(merged.backfill.windows[0].pages).sort(), []);
});

test('an identical overlap is tolerated and keeps the existing copy', () => {
  const stockPage = page([row('PB-1')]);
  const existing = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: { 'stock-records': stockPage },
  });
  const produced = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: {
      'stock-records': JSON.parse(JSON.stringify(stockPage)),
      'quality-reports': page([row('QC-1')]),
    },
  });
  const merged = mergeOrderManagementSessionSnapshots({ existing, produced, now: NOW }).snapshot;
  assert.deepEqual(merged.pages['stock-records'], existing.pages['stock-records']);
  assert.equal(merged.pages['quality-reports'].rows.length, 1);
});

test('merge refuses conflicting overlap, roster mismatch and dropped gates', () => {
  const existing = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: { 'stock-records': page([row('PB-1')]) },
  });
  const conflictingProduced = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: { 'stock-records': page([]) },
  });
  assert.throws(
    () => mergeOrderManagementSessionSnapshots({ existing, produced: conflictingProduced, now: NOW }),
    /ORDER_MANAGEMENT_MERGE_PAGE_CONFLICT/,
  );

  const gated = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: {
      'quality-reports': {
        ...page([row('QC-1')]),
        gates: { ...page([row('QC-1')]).gates, totalVerified: false },
      },
    },
  });
  assert.throws(
    () => mergeOrderManagementSessionSnapshots({ existing, produced: gated, now: NOW }),
    /ORDER_MANAGEMENT_MERGE_SNAPSHOT_INVALID/,
  );

  const contentFailed = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: {
      'quality-reports': page([row('QC-1')], { contentVerified: false }),
    },
  });
  assert.throws(
    () => mergeOrderManagementSessionSnapshots({ existing, produced: contentFailed, now: NOW }),
    /ORDER_MANAGEMENT_MERGE_SNAPSHOT_INVALID/,
  );

  const wrongRoster = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    roster: ROSTER.slice(0, 24),
    pages: { 'quality-reports': page([row('QC-1')]) },
  });
  assert.throws(
    () => mergeOrderManagementSessionSnapshots({ existing, produced: wrongRoster, now: NOW }),
    /ORDER_MANAGEMENT_MERGE_SNAPSHOT_INVALID|ORDER_MANAGEMENT_MERGE_ROSTER_MISMATCH/,
  );
});

test('the same raw id in different pages is legal and only same-triple conflicts fail', () => {
  const existing = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: { 'stock-records': page([row('PB-1')]) },
  });
  // Return-plan id 1 and return-order id 1 live in independent namespaces:
  // the same (storeCode, id) may legitimately appear in different pages.
  const produced = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: {
      exceptions: page([row('1')]),
      'value-added-services': page([row('1')]),
    },
  });
  const merged = mergeOrderManagementSessionSnapshots({ existing, produced, now: NOW }).snapshot;
  assert.equal(merged.pages.exceptions.rows[0].id, '1');
  assert.equal(merged.pages['value-added-services'].rows[0].id, '1');

  // Two rows with the SAME pageId + storeCode + row.id but different content
  // are a real conflict and must fail validation.
  const conflictingPage = {
    ...page([row('WO-1')]),
    rows: Object.freeze([row('WO-1'), { ...row('WO-1'), primary: 'DIFFERENT' }]),
  };
  const conflicting = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: { exceptions: conflictingPage },
  });
  assert.deepEqual(rowKeyConflicts(conflicting.pages), ['exceptions/CX4412/WO-1']);
  assert.ok(validateSnapshotForMerge(conflicting).some((error) => error.includes('row conflict')));
  assert.throws(
    () => mergeOrderManagementSessionSnapshots({ existing, produced: conflicting, now: NOW }),
    /ORDER_MANAGEMENT_MERGE_SNAPSHOT_INVALID/,
  );
  const identicalDuplicate = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: { exceptions: page([row('WO-DUP'), row('WO-DUP')]) },
  });
  assert.deepEqual(rowKeyConflicts(identicalDuplicate.pages), ['exceptions/CX4412/WO-DUP']);
  assert.ok(validateSnapshotForMerge(identicalDuplicate).some((error) => error.includes('row conflict')));
});

test('merge rejects a window audit that does not cover the scope contiguously', () => {
  const existing = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: { 'stock-records': page([row('PB-1')]) },
  });
  const discontinuous = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    windows: [{
      index: 1,
      startDate: '2026-08-01',
      endDate: '2026-08-02',
      partFile: '/tmp/part.01.json',
      fetchedAt: '2026-08-08T06:00:00.000Z',
      pages: {},
    }],
    pages: { 'quality-reports': page([row('QC-1')]) },
  });
  assert.ok(validateWindowContinuity(discontinuous).length > 0);
  assert.throws(
    () => mergeOrderManagementSessionSnapshots({ existing, produced: discontinuous, now: NOW }),
    /ORDER_MANAGEMENT_MERGE_SNAPSHOT_INVALID/,
  );
});

test('merge accepts different legal segmentations of the same scope and keeps every part and page audit', () => {
  const startDate = '2022-01-01';
  const endDate = '2026-08-08';
  // Production snapshot: every calendar year segmented separately and
  // truncated at the year boundary (e.g. 2023-12-22..2023-12-31 followed by
  // 2024-01-01..2024-01-30).
  const existingWindows = yearTruncatedWindows(startDate, endDate).map((window, index) => Object.freeze({
    index: index + 1,
    startDate: window.startDate,
    endDate: window.endDate,
    partFile: `/tmp/production.part.${String(index + 1).padStart(2, '0')}.json`,
    fetchedAt: '2026-08-08T06:00:00.000Z',
    pages: Object.freeze({ 'stock-records': pageAudit({ rowCount: 3 }) }),
  }));
  // New backfill run: from-start deterministic 30-day split (e.g.
  // 2023-12-22..2024-01-20 crossing the year boundary).
  const producedWindows = expectedWindows({ startDate, endDate }).map((window, index) => Object.freeze({
    index: index + 1,
    startDate: window.startDate,
    endDate: window.endDate,
    partFile: `/tmp/backfill.part.${String(index + 1).padStart(2, '0')}.json`,
    fetchedAt: '2026-08-09T06:00:00.000Z',
    pages: Object.freeze({ 'quality-reports': pageAudit({ rowCount: 5 }) }),
  }));
  assert.notDeepEqual(
    existingWindows.map((window) => [window.startDate, window.endDate]),
    producedWindows.map((window) => [window.startDate, window.endDate]),
  );
  const existing = snapshot({
    startDate,
    endDate,
    windows: existingWindows,
    pages: { 'stock-records': page([row('PB-1')]) },
  });
  const produced = snapshot({
    startDate,
    endDate,
    windows: producedWindows,
    pages: { 'quality-reports': page([row('QC-1')]) },
  });
  const merged = mergeOrderManagementSessionSnapshots({ existing, produced, now: NOW }).snapshot;
  const mergedWindows = merged.backfill.windows;

  // The merged audit is the common refinement of the two legal splits: one
  // merged window per overlapping input-window pair.
  const overlaps = [];
  for (const existingWindow of existingWindows) {
    for (const producedWindow of producedWindows) {
      const start = Math.max(
        epochDays(existingWindow.startDate),
        epochDays(producedWindow.startDate),
      );
      const end = Math.min(
        epochDays(existingWindow.endDate),
        epochDays(producedWindow.endDate),
      );
      if (start <= end) {
        overlaps.push({
          startDate: isoFromDays(start),
          endDate: isoFromDays(end),
          existingWindow,
          producedWindow,
        });
      }
    }
  }
  assert.equal(mergedWindows.length, overlaps.length);
  assert.equal(merged.scope.windowCount, mergedWindows.length);

  // The merged audit itself covers the scope contiguously with legal widths.
  assert.equal(mergedWindows[0].startDate, startDate);
  assert.equal(mergedWindows.at(-1).endDate, endDate);
  for (let index = 1; index < mergedWindows.length; index += 1) {
    assert.equal(
      epochDays(mergedWindows[index].startDate),
      epochDays(mergedWindows[index - 1].endDate) + 1,
    );
    assert.ok(
      epochDays(mergedWindows[index].endDate) - epochDays(mergedWindows[index].startDate) + 1 <= 30,
    );
  }

  // Every overlap segment exists exactly once and carries the evidence of
  // both contributing windows: part files, page audits and source attribution.
  for (const overlap of overlaps) {
    const entry = mergedWindows.find(
      (window) => window.startDate === overlap.startDate && window.endDate === overlap.endDate,
    );
    assert.ok(entry, `missing merged window ${overlap.startDate}..${overlap.endDate}`);
    assert.ok(entry.partFiles.includes(overlap.existingWindow.partFile));
    assert.ok(entry.partFiles.includes(overlap.producedWindow.partFile));
    assert.equal(entry.pages['stock-records'].rowCount, 3);
    assert.equal(entry.pages['quality-reports'].rowCount, 5);
    assert.deepEqual(entry.sources, [
      {
        snapshot: 'existing',
        startDate: overlap.existingWindow.startDate,
        endDate: overlap.existingWindow.endDate,
      },
      {
        snapshot: 'produced',
        startDate: overlap.producedWindow.startDate,
        endDate: overlap.producedWindow.endDate,
      },
    ]);
  }

  // The produced window crossing 2023-12-31 contributes to both the
  // pre-year and post-year merged windows; the merged audit never overlaps.
  const yearEnd = existingWindows.find((window) => window.endDate === '2023-12-31');
  const crossing = producedWindows.find(
    (window) => epochDays(window.startDate) < epochDays('2023-12-31')
      && epochDays(window.endDate) > epochDays('2023-12-31'),
  );
  assert.ok(yearEnd);
  assert.ok(crossing);
  const tail = mergedWindows.find((window) => window.endDate === '2023-12-31');
  const head = mergedWindows.find((window) => window.startDate === '2024-01-01');
  assert.ok(tail && head);
  assert.ok(tail.partFiles.includes(crossing.partFile));
  assert.ok(head.partFiles.includes(crossing.partFile));

  // Deterministic: a second merge produces a byte-identical audit.
  const again = mergeOrderManagementSessionSnapshots({ existing, produced, now: NOW }).snapshot;
  assert.deepEqual(merged.backfill.windows, again.backfill.windows);
  assert.deepEqual(merged.scope, again.scope);
});

test('merge still rejects a window audit with an over-long window', () => {
  const existing = snapshot({
    startDate: '2026-01-01',
    endDate: '2026-02-10',
    pages: { 'stock-records': page([row('PB-1')]) },
  });
  const overlong = snapshot({
    startDate: '2026-01-01',
    endDate: '2026-02-10',
    windows: [{
      index: 1,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      partFile: '/tmp/part.01.json',
      fetchedAt: '2026-08-08T06:00:00.000Z',
      pages: {},
    }, {
      index: 2,
      startDate: '2026-02-01',
      endDate: '2026-02-10',
      partFile: '/tmp/part.02.json',
      fetchedAt: '2026-08-08T06:00:00.000Z',
      pages: {},
    }],
    pages: { 'quality-reports': page([row('QC-1')]) },
  });
  assert.ok(validateWindowContinuity(overlong).some((error) => error.includes('exceeds')));
  assert.throws(
    () => mergeOrderManagementSessionSnapshots({ existing, produced: overlong, now: NOW }),
    /ORDER_MANAGEMENT_MERGE_SNAPSHOT_INVALID/,
  );
});

test('merge still rejects window audits with gaps or overlaps', () => {
  const existing = snapshot({
    startDate: '2026-01-01',
    endDate: '2026-01-10',
    pages: { 'stock-records': page([row('PB-1')]) },
  });
  const gapped = snapshot({
    startDate: '2026-01-01',
    endDate: '2026-01-10',
    windows: [{
      index: 1,
      startDate: '2026-01-01',
      endDate: '2026-01-04',
      partFile: '/tmp/part.01.json',
      fetchedAt: '2026-08-08T06:00:00.000Z',
      pages: {},
    }, {
      index: 2,
      startDate: '2026-01-06',
      endDate: '2026-01-10',
      partFile: '/tmp/part.02.json',
      fetchedAt: '2026-08-08T06:00:00.000Z',
      pages: {},
    }],
    pages: { 'quality-reports': page([row('QC-1')]) },
  });
  assert.ok(validateWindowContinuity(gapped).some((error) => error.includes('gap or overlap')));
  assert.throws(
    () => mergeOrderManagementSessionSnapshots({ existing, produced: gapped, now: NOW }),
    /ORDER_MANAGEMENT_MERGE_SNAPSHOT_INVALID/,
  );

  const overlapped = snapshot({
    startDate: '2026-01-01',
    endDate: '2026-01-10',
    windows: [{
      index: 1,
      startDate: '2026-01-01',
      endDate: '2026-01-04',
      partFile: '/tmp/part.01.json',
      fetchedAt: '2026-08-08T06:00:00.000Z',
      pages: {},
    }, {
      index: 2,
      startDate: '2026-01-04',
      endDate: '2026-01-10',
      partFile: '/tmp/part.02.json',
      fetchedAt: '2026-08-08T06:00:00.000Z',
      pages: {},
    }],
    pages: { 'quality-reports': page([row('QC-1')]) },
  });
  assert.ok(validateWindowContinuity(overlapped).some((error) => error.includes('gap or overlap')));
  assert.throws(
    () => mergeOrderManagementSessionSnapshots({ existing, produced: overlapped, now: NOW }),
    /ORDER_MANAGEMENT_MERGE_SNAPSHOT_INVALID/,
  );
});

test('merge requires the exact same date scope instead of widening it', () => {
  const existing = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: { 'stock-records': page([row('PB-1')]) },
  });
  const produced = snapshot({
    startDate: '2026-07-01',
    endDate: '2026-08-08',
    pages: { 'quality-reports': page([row('QC-1')]) },
  });
  assert.throws(
    () => mergeOrderManagementSessionSnapshots({ existing, produced, now: NOW }),
    /ORDER_MANAGEMENT_MERGE_SCOPE_MISMATCH/,
  );
});

test('an once-only snapshot can merge without duplicating calendar windows', () => {
  const existing = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: { 'stock-records': page([row('PB-1')]) },
  });
  const produced = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    windows: [],
    pages: {
      exceptions: page([row('WO-1')]),
      'value-added-services': page([row('VA-1')]),
    },
  });
  assert.deepEqual(validateSnapshotForMerge(produced, { strictProduced: true }), []);
  const merged = mergeOrderManagementSessionSnapshots({ existing, produced, now: NOW }).snapshot;
  assert.equal(merged.backfill.windows.length, existing.backfill.windows.length);
  assert.equal(merged.pages.exceptions.rows[0].id, 'WO-1');
});

test('validateSnapshotForMerge accepts legacy pages without a content gate and rejects unknown page ids', () => {
  const legacyPage = {
    ...page([row('PB-1')]),
    gates: {
      totalVerified: true,
      pagingVerified: true,
      dedupeVerified: true,
      storeCount: ROSTER.length,
    },
  };
  const legacy = snapshot({
    startDate: '2022-01-01',
    endDate: '2026-08-08',
    pages: {
      'stock-records': legacyPage,
      waybills: { ...legacyPage, rows: Object.freeze([row('SF-1')]) },
    },
  });
  assert.deepEqual(validateSnapshotForMerge(legacy), []);
  const withUnknownPage = snapshot({
    startDate: '2026-08-01',
    endDate: '2026-08-08',
    pages: { 'delivery-desk': page([row('DD-1')]) },
  });
  assert.ok(validateSnapshotForMerge(withUnknownPage).some((error) => error.includes('delivery-desk')));
});
