import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';
import {
  buildBackfillWindows,
  parseArgs as parseBackfillArgs,
  partFileForWindow,
  runOrderManagementSessionBackfill,
} from '../../scripts/backfill_full_managed_order_management_sessions.mjs';
import {
  runOrderManagementSessionSync,
} from '../../scripts/sync_full_managed_order_management_sessions.mjs';

const NOW = new Date('2026-08-08T06:00:00.000Z');
const ROSTER = [...FULL_MANAGED_STORE_CODES];

test('backfill CLI requires the full roster, a complete range and an output', () => {
  const stores = FULL_MANAGED_STORE_CODES.join(',');
  const args = parseBackfillArgs([
    `--stores=${stores}`,
    '--start-date=2026-01-01',
    '--end-date=2026-06-30',
    '--output=/tmp/backfill.json',
    '--execute',
  ]);
  assert.equal(args.execute, true);
  assert.equal(args.startDate, '2026-01-01');
  assert.equal(args.endDate, '2026-06-30');
  assert.equal(args.output, '/tmp/backfill.json');
  assert.deepEqual(args.stores, ROSTER);
  assert.throws(
    () => parseBackfillArgs([`--stores=${stores}`, '--output=/tmp/backfill.json']),
    /ORDER_MANAGEMENT_BACKFILL_RANGE_REQUIRED/,
  );
  assert.throws(
    () => parseBackfillArgs([
      `--stores=${stores}`,
      '--start-date=2026-01-01',
      '--end-date=2026-06-30',
    ]),
    /ORDER_MANAGEMENT_BACKFILL_OUTPUT_REQUIRED/,
  );
  assert.throws(
    () => parseBackfillArgs([
      '--stores=DL5477',
      '--start-date=2026-01-01',
      '--end-date=2026-06-30',
      '--output=/tmp/backfill.json',
    ]),
    /ORDER_MANAGEMENT_BACKFILL_STORE_SCOPE_REQUIRED/,
  );
  assert.throws(
    () => parseBackfillArgs([
      `--stores=${stores},ZZ0000`,
      '--start-date=2026-01-01',
      '--end-date=2026-06-30',
      '--output=/tmp/backfill.json',
    ]),
    /ORDER_MANAGEMENT_BACKFILL_STORE_SCOPE_REQUIRED/,
  );
  assert.throws(
    () => parseBackfillArgs([
      `--stores=${stores}`,
      '--start-date=2026-01-01',
      '--end-date=2026-06-30',
      '--output=/tmp/backfill.json',
      '--unknown=x',
    ]),
    /ORDER_MANAGEMENT_BACKFILL_ARGUMENT_INVALID/,
  );
});

test('backfill windows are contiguous, non-overlapping and never wider than 30 days', () => {
  const days = (value) => Math.round(Date.parse(`${value}T00:00:00.000Z`) / 86_400_000);
  const windows = buildBackfillWindows({ startDate: '2026-01-01', endDate: '2026-03-31' });
  assert.deepEqual(windows, [
    { startDate: '2026-01-01', endDate: '2026-01-30' },
    { startDate: '2026-01-31', endDate: '2026-03-01' },
    { startDate: '2026-03-02', endDate: '2026-03-31' },
  ]);
  for (let index = 1; index < windows.length; index += 1) {
    assert.equal(days(windows[index].startDate), days(windows[index - 1].endDate) + 1);
  }
  for (const window of windows) {
    assert.ok(days(window.endDate) - days(window.startDate) + 1 <= 30);
  }
  assert.equal(buildBackfillWindows({ startDate: '2026-01-01', endDate: '2026-01-30' }).length, 1);
  assert.equal(buildBackfillWindows({ startDate: '2026-01-01', endDate: '2026-01-31' }).length, 2);
  assert.equal(buildBackfillWindows({ startDate: '2026-01-01', endDate: '2026-01-01' }).length, 1);
  assert.throws(
    () => buildBackfillWindows({ startDate: '2026-01-02', endDate: '2026-01-01' }),
    /ORDER_MANAGEMENT_BACKFILL_RANGE_INVALID/,
  );
  assert.throws(
    () => buildBackfillWindows({ startDate: '2026-13-01', endDate: '2026-01-31' }),
    /ORDER_MANAGEMENT_BACKFILL_DATE_INVALID/,
  );
  assert.throws(
    () => buildBackfillWindows({ startDate: '2026-02-30', endDate: '2026-03-31' }),
    /ORDER_MANAGEMENT_BACKFILL_DATE_INVALID/,
  );
  assert.throws(
    () => buildBackfillWindows({ startDate: '2026-01-01', endDate: '2026-03-31', maximumDays: 31 }),
    /ORDER_MANAGEMENT_BACKFILL_WINDOW_MAX_INVALID/,
  );
  assert.deepEqual(
    buildBackfillWindows({ startDate: '2025-06-01', endDate: '2026-05-31' }),
    buildBackfillWindows({ startDate: '2025-06-01', endDate: '2026-05-31' }),
  );
});

test('backfill dry-run is deterministic, writes nothing and never calls a window', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-backfill-dry-'));
  const output = path.join(directory, 'backfill.json');
  let calls = 0;
  const options = {
    storeCodes: ROSTER,
    startDate: '2026-01-01',
    endDate: '2026-03-31',
    output,
    execute: false,
    now: NOW,
    runWindow: async () => {
      calls += 1;
      throw new Error('MUST_NOT_CALL');
    },
  };
  const result1 = await runOrderManagementSessionBackfill(options);
  const result2 = await runOrderManagementSessionBackfill(options);
  assert.equal(calls, 0);
  assert.equal(result1.mode, 'DRY_RUN');
  assert.deepEqual(
    JSON.parse(JSON.stringify(result1.plan)),
    JSON.parse(JSON.stringify(result2.plan)),
  );
  assert.equal(result1.plan.windowCount, 3);
  assert.equal(result1.plan.windows[1].startDate, '2026-01-31');
  assert.ok(result1.plan.windows[0].partFile.endsWith(
    `backfill.json.part.01.2026-01-01.2026-01-30.json`,
  ));
  assert.equal(existsSync(output), false);
});

test('backfill rejects a future range even in dry-run', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-backfill-future-'));
  const output = path.join(directory, 'backfill.json');
  await assert.rejects(
    () => runOrderManagementSessionBackfill({
      storeCodes: ROSTER,
      startDate: '2026-01-01',
      endDate: '2026-08-09',
      output,
      execute: false,
      now: NOW,
    }),
    /ORDER_MANAGEMENT_BACKFILL_RANGE_FUTURE/,
  );
  assert.equal(existsSync(output), false);
});

function makeRow(id, storeCode) {
  return Object.freeze({
    id,
    storeCode,
    statusCode: null,
    statusName: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-08-08T06:00:00.000Z',
    primary: id,
    secondary: null,
    tags: Object.freeze([]),
    metrics: Object.freeze([]),
    facts: Object.freeze([]),
    details: Object.freeze([]),
  });
}

function makeWindowSnapshot(window, { status = 'AVAILABLE', storeCount = 25, stockRows = [], waybillRows = [] } = {}) {
  const gates = Object.freeze({
    totalVerified: status === 'AVAILABLE',
    pagingVerified: status === 'AVAILABLE',
    dedupeVerified: status === 'AVAILABLE',
    storeCount,
  });
  const page = (pageId, rows) => Object.freeze({
    status,
    source: 'SESSION_HTTP',
    latestSourceFetchedAt: '2026-08-08T06:00:00.000Z',
    reason: status === 'AVAILABLE' ? null : 'SESSION_GATE_FAILED',
    storeCodes: Object.freeze([...FULL_MANAGED_STORE_CODES]),
    gates,
    rows: Object.freeze(rows),
  });
  return Object.freeze({
    schemaVersion: 1,
    updatedAt: '2026-08-08T06:00:00.000Z',
    roster: Object.freeze([...FULL_MANAGED_STORE_CODES]),
    window: Object.freeze({ ...window }),
    pages: Object.freeze({
      'stock-records': page('stock-records', stockRows),
      waybills: page('waybills', waybillRows),
    }),
  });
}

test('backfill execute reuses one session store across contiguous windows', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-backfill-exec-'));
  const output = path.join(directory, 'backfill.json');
  const sessionStore = {
    read: async () => { throw new Error('UNUSED'); },
    write: async () => { throw new Error('UNUSED'); },
  };
  const calls = [];
  const result = await runOrderManagementSessionBackfill({
    storeCodes: ROSTER,
    startDate: '2026-01-01',
    endDate: '2026-02-09',
    output,
    execute: true,
    sessionStore,
    now: NOW,
    runWindow: async (options) => {
      calls.push(options);
      await writeFile(options.output, JSON.stringify({ window: options.window }));
      return { snapshot: makeWindowSnapshot(options.window), written: options.output };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].window.startDate, '2026-01-01');
  assert.equal(calls[0].window.endDate, '2026-01-30');
  assert.equal(calls[1].window.startDate, '2026-01-31');
  assert.equal(calls[1].window.endDate, '2026-02-09');
  assert.equal(calls[0].sessionStore, sessionStore);
  assert.equal(calls[1].sessionStore, sessionStore);
  assert.equal(calls[0].includeStatistics, false);
  assert.equal(calls[1].includeStatistics, false);
  assert.equal(result.written, output);
  const snapshot = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.scope.startDate, '2026-01-01');
  assert.equal(snapshot.scope.endDate, '2026-02-09');
  assert.equal(snapshot.scope.windowCount, 2);
  assert.equal(snapshot.backfill.windows.length, 2);
  assert.equal(snapshot.backfill.windows[0].partFile, path.resolve(
    partFileForWindow(output, 0, { startDate: '2026-01-01', endDate: '2026-01-30' }),
  ));
  assert.equal(snapshot.pages['stock-records'].status, 'AVAILABLE');
  assert.deepEqual(snapshot.pages['stock-records'].gates, {
    totalVerified: true,
    pagingVerified: true,
    dedupeVerified: true,
    storeCount: 25,
  });
  assert.deepEqual(snapshot.pages.waybills.gates, snapshot.pages['stock-records'].gates);
  assert.equal(JSON.parse(await readFile(partFileForWindow(
    output,
    0,
    { startDate: '2026-01-01', endDate: '2026-01-30' },
  ), 'utf8')).window.endDate, '2026-01-30');
});

test('backfill gate failure keeps a pre-existing final output untouched', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-backfill-gate-'));
  const output = path.join(directory, 'backfill.json');
  await writeFile(output, JSON.stringify({ sentinel: 'keep-me' }));
  let callIndex = 0;
  await assert.rejects(
    () => runOrderManagementSessionBackfill({
      storeCodes: ROSTER,
      startDate: '2026-01-01',
      endDate: '2026-02-09',
      output,
      execute: true,
      sessionStore: {},
      now: NOW,
      runWindow: async (options) => {
        callIndex += 1;
        const failing = callIndex === 2;
        await writeFile(options.output, JSON.stringify({ failing }));
        return {
          snapshot: failing
            ? makeWindowSnapshot(options.window, { status: 'PARTIAL' })
            : makeWindowSnapshot(options.window),
          written: options.output,
        };
      },
    }),
    /ORDER_MANAGEMENT_BACKFILL_WINDOW_GATE_FAILED/,
  );
  assert.equal(JSON.parse(await readFile(output, 'utf8')).sentinel, 'keep-me');
  const firstPart = partFileForWindow(output, 0, { startDate: '2026-01-01', endDate: '2026-01-30' });
  const secondPart = partFileForWindow(output, 1, { startDate: '2026-01-31', endDate: '2026-02-09' });
  assert.equal(JSON.parse(await readFile(firstPart, 'utf8')).failing, false);
  assert.equal(JSON.parse(await readFile(secondPart, 'utf8')).failing, true);
});

test('backfill fails when a window gate reports fewer than 25 stores', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-backfill-gate24-'));
  const output = path.join(directory, 'backfill.json');
  await assert.rejects(
    () => runOrderManagementSessionBackfill({
      storeCodes: ROSTER,
      startDate: '2026-01-01',
      endDate: '2026-01-30',
      output,
      execute: true,
      sessionStore: {},
      now: NOW,
      runWindow: async (options) => {
        await writeFile(options.output, JSON.stringify({ window: options.window }));
        return {
          snapshot: makeWindowSnapshot(options.window, { storeCount: 24 }),
          written: options.output,
        };
      },
    }),
    /ORDER_MANAGEMENT_BACKFILL_WINDOW_GATE_FAILED/,
  );
  assert.equal(existsSync(output), false);
});

test('backfill fails closed on a cross-window row conflict without writing the final', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-backfill-conflict-'));
  const output = path.join(directory, 'backfill.json');
  const rowA = makeRow('PB-X1', 'CX4412');
  const rowB = { ...rowA, primary: 'DIFFERENT' };
  let callIndex = 0;
  await assert.rejects(
    () => runOrderManagementSessionBackfill({
      storeCodes: ROSTER,
      startDate: '2026-01-01',
      endDate: '2026-02-09',
      output,
      execute: true,
      sessionStore: {},
      now: NOW,
      runWindow: async (options) => {
        const windowIndex = callIndex;
        callIndex += 1;
        const rows = windowIndex === 0 ? [rowA] : [rowB];
        await writeFile(options.output, JSON.stringify({ windowIndex }));
        return {
          snapshot: makeWindowSnapshot(options.window, { stockRows: rows }),
          written: options.output,
        };
      },
    }),
    /ORDER_MANAGEMENT_BACKFILL_CROSS_WINDOW_CONFLICT/,
  );
  assert.equal(existsSync(output), false);
});

const GOOD_RESPONSES = {
  STOCK_RECORDS_LIST: {
    code: '0',
    msg: 'OK',
    info: {
      count: 1,
      list: [{
        id: 1,
        orderNo: 'PB-SYNC-1',
        supplierCode: 'MODEL-A',
        skc: 'sv-sync-1',
        orderMode: 2,
        orderModeValue: '系统自动下单',
        applyStatus: '1',
        stockType: '备货单',
        orderSign: '订单',
        addTime: '2026-07-20 10:00:00',
        timezone: 'Asia/Shanghai',
      }],
    },
  },
  WAYBILLS_PAGE: {
    code: '0',
    msg: 'OK',
    info: {
      data: [{
        id: 9,
        trackingNumber: 'SF-SYNC-9',
        logisticsCompanyName: '顺丰',
        waybillTypeSellerName: '发货运单',
        orderSystem: 'PFMP',
        isFreeName: '正常',
        signTime: '2026-07-20 09:00:00',
        pickupTime: null,
        packQuantity: 1,
        sendGoodsQuantity: 20,
      }],
      meta: { count: 1 },
    },
  },
  WAYBILLS_STATISTICS: { code: '0', msg: 'OK', info: '491' },
};

function fakeOrderManagementSession(endpointCalls, failStockWindow = null) {
  return async ({ storeCode }) => ({
    request: async (endpointCode, body) => {
      endpointCalls.push({ endpointCode, body });
      if (
        failStockWindow
        && endpointCode === 'STOCK_RECORDS_LIST'
        && body?.addTimeBegin?.slice(0, 10) === failStockWindow
      ) {
        return { httpStatus: 200, byteLength: 1, body: { code: '0', msg: 'OK', info: { list: [] } } };
      }
      return { httpStatus: 200, byteLength: 1, body: GOOD_RESPONSES[endpointCode] };
    },
    close: async () => ({ closed: true }),
    expiry: () => ({}),
  });
}

test('session sync can skip statistics with includeStatistics false', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-sync-nostats-'));
  const output = path.join(directory, 'order-management.sessions.json');
  const endpointCalls = [];
  const result = await runOrderManagementSessionSync({
    storeCodes: ROSTER,
    output,
    windowDays: 30,
    includeStatistics: false,
    openSession: fakeOrderManagementSession(endpointCalls),
    now: NOW,
  });
  assert.ok(!endpointCalls.some((call) => call.endpointCode === 'WAYBILLS_STATISTICS'));
  assert.ok(endpointCalls.some((call) => call.endpointCode === 'STOCK_RECORDS_LIST'));
  assert.ok(endpointCalls.some((call) => call.endpointCode === 'WAYBILLS_PAGE'));
  assert.deepEqual(result.snapshot.evidence.perStore[0].statistics, []);
  assert.equal(result.snapshot.pages['stock-records'].status, 'AVAILABLE');
  assert.equal(result.snapshot.pages.waybills.status, 'AVAILABLE');
});

test('backfill execute merges gated windows without calling the statistics endpoint', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-backfill-integration-'));
  const output = path.join(directory, 'backfill.json');
  const endpointCalls = [];
  const result = await runOrderManagementSessionBackfill({
    storeCodes: ROSTER,
    startDate: '2026-06-30',
    endDate: '2026-08-08',
    output,
    execute: true,
    sessionStore: {
      read: async () => { throw new Error('UNUSED'); },
      write: async () => { throw new Error('UNUSED'); },
    },
    now: NOW,
    openSession: fakeOrderManagementSession(endpointCalls),
  });
  assert.ok(!endpointCalls.some((call) => call.endpointCode === 'WAYBILLS_STATISTICS'));
  assert.ok(endpointCalls.some((call) => call.endpointCode === 'STOCK_RECORDS_LIST'));
  assert.ok(endpointCalls.some((call) => call.endpointCode === 'WAYBILLS_PAGE'));
  const firstStockBody = endpointCalls.find((call) => call.endpointCode === 'STOCK_RECORDS_LIST').body;
  assert.equal(firstStockBody.addTimeBegin, '2026-06-30 00:00:00');
  assert.equal(firstStockBody.addTimeEnd, '2026-07-29 23:59:59');
  const lastStockBody = [...endpointCalls]
    .reverse()
    .find((call) => call.endpointCode === 'STOCK_RECORDS_LIST').body;
  assert.equal(lastStockBody.addTimeBegin, '2026-07-30 00:00:00');
  assert.equal(lastStockBody.addTimeEnd, '2026-08-08 23:59:59');

  assert.equal(result.partFiles.length, 2);
  const firstPart = JSON.parse(await readFile(result.partFiles[0], 'utf8'));
  assert.equal(firstPart.window.startDate, '2026-06-30');
  assert.deepEqual(firstPart.evidence.perStore[0].statistics, []);
  assert.equal(firstPart.pages['stock-records'].status, 'AVAILABLE');
  assert.deepEqual(firstPart.pages['stock-records'].gates, {
    totalVerified: true,
    pagingVerified: true,
    dedupeVerified: true,
    storeCount: 25,
  });

  const snapshot = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.scope.windowCount, 2);
  assert.equal(snapshot.backfill.windows.length, 2);
  assert.equal(snapshot.backfill.windows[0].startDate, '2026-06-30');
  assert.equal(snapshot.backfill.windows[0].endDate, '2026-07-29');
  assert.equal(snapshot.backfill.windows[1].startDate, '2026-07-30');
  assert.equal(snapshot.backfill.windows[1].endDate, '2026-08-08');
  assert.equal(snapshot.pages['stock-records'].status, 'AVAILABLE');
  assert.equal(snapshot.pages.waybills.status, 'AVAILABLE');
  assert.deepEqual(snapshot.pages['stock-records'].gates, {
    totalVerified: true,
    pagingVerified: true,
    dedupeVerified: true,
    storeCount: 25,
  });
  // Same fake row per store appears in both windows; the merge dedupes to one
  // row per store instead of doubling.
  assert.equal(snapshot.pages['stock-records'].rows.length, FULL_MANAGED_STORE_CODES.length);
  assert.equal(snapshot.pages.waybills.rows.length, FULL_MANAGED_STORE_CODES.length);
  assert.deepEqual(snapshot.pages['stock-records'].storeCodes, [...FULL_MANAGED_STORE_CODES].sort());
  assert.equal(snapshot.pages['stock-records'].reason, null);
  assert.equal(snapshot.pages['stock-records'].source, 'SESSION_HTTP');
});

test('backfill fails the whole run when a real window misses the total gate', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-backfill-integration-fail-'));
  const output = path.join(directory, 'backfill.json');
  const endpointCalls = [];
  await assert.rejects(
    () => runOrderManagementSessionBackfill({
      storeCodes: ROSTER,
      startDate: '2026-06-30',
      endDate: '2026-08-08',
      output,
      execute: true,
      sessionStore: {},
      now: NOW,
      openSession: fakeOrderManagementSession(endpointCalls, '2026-07-30'),
    }),
    /ORDER_MANAGEMENT_BACKFILL_WINDOW_GATE_FAILED/,
  );
  assert.equal(existsSync(output), false);
  assert.equal(
    existsSync(partFileForWindow(output, 0, { startDate: '2026-06-30', endDate: '2026-07-29' })),
    true,
  );
  assert.equal(
    existsSync(partFileForWindow(output, 1, { startDate: '2026-07-30', endDate: '2026-08-08' })),
    true,
  );
  const failedPart = JSON.parse(await readFile(
    partFileForWindow(output, 1, { startDate: '2026-07-30', endDate: '2026-08-08' }),
    'utf8',
  ));
  assert.equal(failedPart.pages['stock-records'].status, 'UNAVAILABLE');
  assert.equal(failedPart.pages['stock-records'].gates.totalVerified, false);
});
