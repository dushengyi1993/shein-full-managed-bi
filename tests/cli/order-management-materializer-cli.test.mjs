import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';
import {
  loadSnapshot,
  parseArgs as parseMaterializeArgs,
} from '../../scripts/materialize_full_managed_order_management.mjs';
import {
  buildWindow,
  parseArgs as parseSyncArgs,
  runOrderManagementSessionSync,
} from '../../scripts/sync_full_managed_order_management_sessions.mjs';
import { markReadyCoordinatorsPublished } from '../../scripts/mark_full_managed_coordinators_published.mjs';

test('materializer accepts only the fixed CLI arguments', () => {
  const args = parseMaterializeArgs([
    '--database-url=postgres://db',
    '--out=/tmp/order-management.next.json',
    '--session-snapshot=/tmp/snapshot.json',
  ]);
  assert.equal(args.databaseUrl, 'postgres://db');
  assert.equal(args.output, '/tmp/order-management.next.json');
  assert.equal(args.sessionSnapshot, '/tmp/snapshot.json');
  assert.throws(() => parseMaterializeArgs(['--unknown=x']), /ORDER_MANAGEMENT_ARGUMENT_INVALID/);
  assert.throws(() => parseMaterializeArgs(['--out']), /ORDER_MANAGEMENT_ARGUMENT_MISSING_VALUE/);
});

test('materializer refuses unsupported session snapshots', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-materializer-'));
  const badJson = path.join(directory, 'bad.json');
  await writeFile(badJson, '{not json');
  await assert.rejects(() => loadSnapshot(badJson), /ORDER_MANAGEMENT_SESSION_SNAPSHOT_INVALID_JSON/);
  const wrongSchema = path.join(directory, 'wrong.json');
  await writeFile(wrongSchema, JSON.stringify({ schemaVersion: 99 }));
  await assert.rejects(
    () => loadSnapshot(wrongSchema),
    /ORDER_MANAGEMENT_SESSION_SNAPSHOT_SCHEMA_UNSUPPORTED/,
  );
  assert.equal(await loadSnapshot(null), null);
});

test('session sync requires the exact 25-store roster', () => {
  const args = parseSyncArgs([`--stores=${FULL_MANAGED_STORE_CODES.join(',')}`]);
  assert.deepEqual(args.stores, [...FULL_MANAGED_STORE_CODES]);
  assert.equal(args.execute, false);
  assert.equal(args.windowDays, 30);
  assert.throws(
    () => parseSyncArgs(['--stores=DL5477']),
    /ORDER_MANAGEMENT_SYNC_STORE_SCOPE_REQUIRED/,
  );
  assert.throws(
    () => parseSyncArgs([`--stores=${FULL_MANAGED_STORE_CODES.join(',')},ZZ0000`]),
    /ORDER_MANAGEMENT_SYNC_STORE_SCOPE_REQUIRED/,
  );
  assert.throws(
    () => parseSyncArgs([`--stores=${FULL_MANAGED_STORE_CODES.join(',')}`, '--window-days=31']),
    /ORDER_MANAGEMENT_SYNC_ARGUMENT_INVALID/,
  );
});

test('sync windows are bounded to 30 inclusive days', () => {
  const window = buildWindow({
    days: 30,
    now: new Date('2026-08-08T12:00:00+08:00'),
  });
  assert.deepEqual(window, { startDate: '2026-07-10', endDate: '2026-08-08' });
  assert.throws(() => buildWindow({ days: 31 }), /ORDER_MANAGEMENT_WINDOW_INVALID/);
});

function fakeOpenSession(respond) {
  return async () => ({
    request: async (endpointCode) => ({ httpStatus: 200, byteLength: 1, body: respond(endpointCode) }),
    close: async () => ({ closed: true }),
    expiry: () => ({}),
  });
}

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
        addTime: '2026-08-07 10:00:00',
        timezone: 'Asia/Shanghai',
        picUrl: 'https://img.example/p.png',
        orderAccount: 'someone',
        applyNotes: 'note with phone 1381712206781',
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
        signTime: '2026-08-08 09:00:00',
        pickupTime: null,
        packQuantity: 1,
        sendGoodsQuantity: 20,
        senderProvinceName: '浙江省',
        receiverCityName: '肇庆市',
      }],
      meta: { count: 1 },
    },
  },
  WAYBILLS_STATISTICS: { code: '0', msg: 'OK', info: '491' },
};

test('session sync writes a gate-passing snapshot with allowlisted rows only', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-sync-'));
  const output = path.join(directory, 'order-management.sessions.json');
  const result = await runOrderManagementSessionSync({
    storeCodes: [...FULL_MANAGED_STORE_CODES],
    output,
    windowDays: 30,
    openSession: fakeOpenSession((endpointCode) => GOOD_RESPONSES[endpointCode]),
    now: new Date('2026-08-08T06:00:00.000Z'),
  });
  const snapshot = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.pages['stock-records'].status, 'AVAILABLE');
  assert.deepEqual(snapshot.pages['stock-records'].gates, {
    totalVerified: true,
    pagingVerified: true,
    dedupeVerified: true,
    storeCount: 25,
  });
  assert.equal(snapshot.pages.waybills.status, 'AVAILABLE');
  assert.equal(snapshot.pages.waybills.rows.length, 25);
  const stockRow = snapshot.pages['stock-records'].rows[0];
  assert.equal(stockRow.id, 'PB-SYNC-1');
  assert.equal(stockRow.statusName, null);
  assert.ok(!JSON.stringify(stockRow).includes('applyNotes'));
  assert.ok(!JSON.stringify(stockRow).includes('orderAccount'));
  assert.ok(!JSON.stringify(stockRow).includes('picUrl'));
  const waybillRow = snapshot.pages.waybills.rows[0];
  assert.equal(waybillRow.statusCode, 'SIGNED');
  assert.ok(!JSON.stringify(waybillRow).includes('senderProvinceName'));
  assert.ok(!JSON.stringify(waybillRow).includes('receiverCityName'));
  assert.equal(result.written, output);
});

test('session sync fails the gate closed when the platform hides the total', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-sync-fail-'));
  const output = path.join(directory, 'order-management.sessions.json');
  const result = await runOrderManagementSessionSync({
    storeCodes: [...FULL_MANAGED_STORE_CODES],
    output,
    windowDays: 30,
    openSession: fakeOpenSession((endpointCode) => {
      if (endpointCode === 'STOCK_RECORDS_LIST') {
        return { code: '0', msg: 'OK', info: { list: [] } };
      }
      return GOOD_RESPONSES[endpointCode];
    }),
    now: new Date('2026-08-08T06:00:00.000Z'),
  });
  const snapshot = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(snapshot.pages['stock-records'].status, 'UNAVAILABLE');
  assert.equal(snapshot.pages['stock-records'].gates.totalVerified, false);
  assert.equal(snapshot.pages['stock-records'].gates.storeCount, 0);
  assert.match(snapshot.pages['stock-records'].reason, /SESSION_GATE_FAILED|NO_STORE_SUCCEEDED/);
  assert.equal(result.snapshot.pages.waybills.status, 'AVAILABLE');
});

test('coordinator publish marking tolerates not-yet-published optional dashboard files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-mark-'));
  const dashboardFile = path.join(directory, 'dashboard.json');
  const missingFile = path.join(directory, 'order-management.json');
  await writeFile(dashboardFile, JSON.stringify({ schemaVersion: 1 }));
  const stateDir = path.join(directory, 'coordinator');
  await mkdir(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'run.json');
  await writeFile(stateFile, JSON.stringify({
    runId: 'run-1',
    status: 'READY_TO_PUBLISH',
    readyAt: '2026-08-08T05:00:00.000Z',
  }));
  const result = await markReadyCoordinatorsPublished({
    root: directory,
    dashboardFiles: [dashboardFile, missingFile],
    readyThrough: '2026-08-08T06:00:00.000Z',
    now: new Date('2026-08-08T06:30:00.000Z'),
  });
  assert.equal(result.manifest.length, 1);
  assert.deepEqual(result.marked, ['run-1']);
  const marked = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(marked.status, 'PUBLISHED');
  assert.equal(marked.manifest.length, 1);
  assert.ok(marked.manifest[0].file.replaceAll('\\', '/').endsWith('/dashboard.json'));
});

test('coordinator publish marking still refuses a missing core dashboard file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-mark-required-'));
  const missingCore = path.join(directory, 'dashboard.json');
  const optionalOrder = path.join(directory, 'order-management.json');

  await assert.rejects(
    () => markReadyCoordinatorsPublished({
      root: directory,
      dashboardFiles: [missingCore, optionalOrder],
      readyThrough: '2026-08-08T06:00:00.000Z',
      now: new Date('2026-08-08T06:30:00.000Z'),
    }),
    (error) => error?.code === 'ENOENT',
  );
});
