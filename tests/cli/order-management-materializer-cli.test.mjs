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

test('session sync accepts an explicit paired date window only', () => {
  const stores = FULL_MANAGED_STORE_CODES.join(',');
  const now = new Date('2026-08-08T06:00:00.000Z');
  const args = parseSyncArgs([
    `--stores=${stores}`,
    '--start-date=2026-07-02',
    '--end-date=2026-07-31',
  ], { now });
  assert.equal(args.startDate, '2026-07-02');
  assert.equal(args.endDate, '2026-07-31');
  assert.equal(args.windowDays, 30);
  assert.equal(args.execute, false);
  assert.throws(
    () => parseSyncArgs([
      `--stores=${stores}`,
      '--start-date=2026-07-01',
      '--end-date=2026-07-31',
    ], { now }),
    /ORDER_MANAGEMENT_SYNC_WINDOW_INVALID/,
  );
  assert.throws(
    () => parseSyncArgs([`--stores=${stores}`, '--start-date=2026-07-01'], { now }),
    /ORDER_MANAGEMENT_SYNC_WINDOW_PAIR_REQUIRED/,
  );
  assert.throws(
    () => parseSyncArgs([`--stores=${stores}`, '--end-date=2026-07-31'], { now }),
    /ORDER_MANAGEMENT_SYNC_WINDOW_PAIR_REQUIRED/,
  );
  assert.throws(
    () => parseSyncArgs([
      `--stores=${stores}`,
      '--start-date=2026-07-02',
      '--end-date=2026-07-01',
    ], { now }),
    /ORDER_MANAGEMENT_SYNC_WINDOW_INVALID/,
  );
  assert.throws(
    () => parseSyncArgs([
      `--stores=${stores}`,
      '--start-date=2026-02-30',
      '--end-date=2026-03-31',
    ], { now }),
    /ORDER_MANAGEMENT_SYNC_WINDOW_INVALID/,
  );
  assert.throws(
    () => parseSyncArgs([
      `--stores=${stores}`,
      '--start-date=2026-06-01',
      '--end-date=2026-07-31',
    ], { now }),
    /ORDER_MANAGEMENT_SYNC_WINDOW_INVALID/,
  );
  assert.throws(
    () => parseSyncArgs([
      `--stores=${stores}`,
      '--start-date=2026-08-01',
      '--end-date=2026-08-09',
    ], { now }),
    /ORDER_MANAGEMENT_SYNC_WINDOW_FUTURE/,
  );
  assert.throws(
    () => parseSyncArgs([
      `--stores=${stores}`,
      '--start-date=2026-07-01',
      '--end-date=2026-07-31',
      '--window-days=30',
    ], { now }),
    /ORDER_MANAGEMENT_SYNC_WINDOW_CONFLICT/,
  );
});

function fakeOpenSession(respond) {
  return async () => ({
    request: async (endpointCode) => ({ httpStatus: 200, byteLength: 1, body: respond(endpointCode) }),
    close: async () => ({ closed: true }),
    expiry: () => ({}),
  });
}

function fakeOpenSessionWithCapture(respond) {
  return async () => ({
    request: async (endpointCode, body) => {
      const captured = body ?? {};
      respond(endpointCode, captured);
      return { httpStatus: 200, byteLength: 1, body: GOOD_RESPONSES[endpointCode] };
    },
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
  RETURN_APPLICATIONS_LIST: {
    code: '0',
    msg: 'OK',
    info: {
      data: [{
        id: 1,
        returnPlanNo: 'RA-SYNC-1',
        state: '1',
        stateName: '待商家确认',
        returnTime: '2026-07-20 10:00:00',
        returnQuantity: 10,
        returnDealTypeName: '退货',
      }],
      meta: { count: 1 },
    },
  },
  RETURN_ORDERS_PAGE: {
    code: '0',
    msg: 'OK',
    info: {
      data: [{
        id: 2,
        returnOrderNo: 'RO-SYNC-2',
        returnOrderStatus: '2',
        returnOrderStatusName: '待退货',
        addTime: '2026-07-20 10:00:00',
        warehouseName: '总仓',
        returnQuantity: 5,
      }],
      meta: { count: 1 },
    },
  },
  EXCEPTIONS_PAGE: {
    code: '0',
    msg: 'OK',
    info: {
      data: [{
        id: 3,
        workorderNo: 'WO-SYNC-3',
        statusValue: '1',
        statusName: '处理中',
        createTime: '2026-07-20 10:00:00',
        categoryName: '收货异常',
      }],
      meta: { count: 1 },
    },
  },
  VALUE_ADDED_SERVICES_PAGE: {
    code: '0',
    msg: 'OK',
    info: {
      list: [{
        id: 4,
        orderNo: 'VA-SYNC-4',
        orderState: '1',
        orderStateName: '服务中',
        actualTotalAmount: 12.5,
        serviceSiteName: '华东仓',
      }],
      count: 1,
    },
  },
  QUALITY_REPORTS_PAGE: {
    code: '0',
    msg: 'OK',
    info: {
      list: [{
        purchaseCode: 'PB-SYNC-1',
        qcInspectionNo: 'QC-SYNC-5',
        skc: 'sv-1',
        inspectionTime: '2026-07-20 10:00:00',
        defectiveTotalQty: 0,
        qcTypeName: '出库质检',
        inspectionResult: '1',
        inspectionResultName: '合格',
      }],
      totalCount: 1,
    },
  },
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
    contentVerified: true,
    storeCount: 25,
  });
  assert.equal(snapshot.pages.waybills.status, 'AVAILABLE');
  assert.equal(snapshot.pages.waybills.rows.length, 25);
  assert.equal(snapshot.pages['return-applications'].status, 'AVAILABLE');
  assert.equal(snapshot.pages['return-applications'].rows.length, 25);
  assert.equal(snapshot.pages['return-applications'].rows[0].statusName, '待商家确认');
  assert.equal(snapshot.pages['quality-reports'].status, 'AVAILABLE');
  assert.equal(snapshot.pages['quality-reports'].rows[0].id, 'QC-SYNC-5');
  assert.equal(snapshot.pages['value-added-services'].rows[0].id, '4');
  assert.equal(snapshot.pages['value-added-services'].rows[0].primary, 'VA-SYNC-4');
  const stockRow = snapshot.pages['stock-records'].rows[0];
  assert.equal(stockRow.id, 'stock-record:1');
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

async function syncStockFixture(records) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-stock-identity-'));
  const result = await runOrderManagementSessionSync({
    storeCodes: [...FULL_MANAGED_STORE_CODES],
    output: path.join(directory, 'order-management.sessions.json'),
    pageIds: ['stock-records'],
    windowDays: 30,
    openSession: fakeOpenSession(() => ({
      code: '0', info: { count: records.length, list: records },
    })),
    now: new Date('2026-08-08T06:00:00.000Z'),
  });
  return result.snapshot.pages['stock-records'];
}

test('stock applications without order numbers retain exact coverage and stable identity', async () => {
  const before = await syncStockFixture([{ id: 123, orderNo: null }, { id: '124', orderNo: '' }]);
  assert.equal(before.status, 'AVAILABLE');
  assert.equal(before.rows.length, FULL_MANAGED_STORE_CODES.length * 2);
  assert.equal(before.gates.totalVerified, true);
  assert.equal(before.gates.contentVerified, true);
  assert.ok(before.rows.every((row) => row.primary === null));
  const after = await syncStockFixture([{ id: 123, orderNo: 'PB-NEW-A' }, { id: '124', orderNo: 'PB-NEW-B' }]);
  assert.deepEqual(before.rows.map((row) => row.id), after.rows.map((row) => row.id));
  assert.equal(after.rows[0].primary, 'PB-NEW-A');
});

test('stock duplicate platform identity cannot pass dedupe using different order numbers', async () => {
  const page = await syncStockFixture([{ id: 123, orderNo: 'PB-A' }, { id: 123, orderNo: 'PB-B' }]);
  assert.equal(page.status, 'UNAVAILABLE');
  assert.equal(page.gates.storeCount, 0);
});

test('stock missing or malformed identities fail closed without synthesizing rows', async () => {
  for (const id of [undefined, null, {}, [], true, 1.5, Number.MAX_SAFE_INTEGER + 1, 'bad id']) {
    const page = await syncStockFixture([{ id, orderNo: null }]);
    assert.equal(page.status, 'UNAVAILABLE');
    assert.equal(page.gates.contentVerified, false);
    assert.equal(page.gates.totalVerified, false);
  }
});

test('stock legacy order-only records remain representable in a separate identity namespace', async () => {
  const page = await syncStockFixture([{ orderNo: 'PB-LEGACY' }, { id: 'PB-LEGACY', orderNo: null }]);
  assert.equal(page.status, 'AVAILABLE');
  assert.deepEqual(page.rows.slice(0, 2).map((row) => row.id), ['stock-order:PB-LEGACY', 'stock-record:PB-LEGACY']);
});

test('session sync sends explicit window dates in every request body', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-sync-window-'));
  const output = path.join(directory, 'order-management.sessions.json');
  const bodies = [];
  const result = await runOrderManagementSessionSync({
    storeCodes: [...FULL_MANAGED_STORE_CODES],
    output,
    window: { startDate: '2026-07-01', endDate: '2026-07-30' },
    openSession: fakeOpenSessionWithCapture((endpointCode, body) => {
      bodies.push({ endpointCode, body });
    }),
    now: new Date('2026-08-08T06:00:00.000Z'),
  });
  assert.equal(result.snapshot.window.startDate, '2026-07-01');
  assert.equal(result.snapshot.window.endDate, '2026-07-30');
  const stockBody = bodies.find((entry) => entry.endpointCode === 'STOCK_RECORDS_LIST').body;
  assert.equal(stockBody.addTimeBegin, '2026-07-01 00:00:00');
  assert.equal(stockBody.addTimeEnd, '2026-07-30 23:59:59');
  const waybillBody = bodies.find((entry) => entry.endpointCode === 'WAYBILLS_PAGE').body;
  assert.equal(waybillBody.addTimeStart, '2026-07-01 00:00:00');
  assert.equal(waybillBody.addTimeEnd, '2026-07-30 23:59:59');
  const returnPlanBody = bodies.find((entry) => entry.endpointCode === 'RETURN_APPLICATIONS_LIST').body;
  assert.equal(returnPlanBody.returnTimeStart, '2026-07-01 00:00:00');
  assert.equal(returnPlanBody.returnTimeEnd, '2026-07-30 23:59:59');
  const returnOrderBody = bodies.find((entry) => entry.endpointCode === 'RETURN_ORDERS_PAGE').body;
  assert.equal(returnOrderBody.addTimeStart, '2026-07-01 00:00:00');
  assert.equal(returnOrderBody.addTimeEnd, '2026-07-30 23:59:59');
  const qualityBody = bodies.find((entry) => entry.endpointCode === 'QUALITY_REPORTS_PAGE').body;
  assert.equal(qualityBody.inspectionTimeStart, '2026-07-01 00:00:00');
  assert.equal(qualityBody.inspectionTimeEnd, '2026-07-30 23:59:59');
  assert.equal(qualityBody.reportUrl, 1);
  const exceptionBody = bodies.find((entry) => entry.endpointCode === 'EXCEPTIONS_PAGE').body;
  assert.ok(!Object.keys(exceptionBody).some((key) => /Time|Date/.test(key)));
  const vasBody = bodies.find((entry) => entry.endpointCode === 'VALUE_ADDED_SERVICES_PAGE').body;
  assert.ok(!Object.keys(vasBody).some((key) => /Time|Date/.test(key)));
  assert.equal(vasBody.pageNumber, 1);
  assert.equal(vasBody.pageSize, 50);
});

test('session sync refuses an explicit future window before any request', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-sync-future-'));
  const output = path.join(directory, 'order-management.sessions.json');
  let opened = 0;
  await assert.rejects(
    () => runOrderManagementSessionSync({
      storeCodes: [...FULL_MANAGED_STORE_CODES],
      output,
      window: { startDate: '2026-08-09', endDate: '2026-08-30' },
      openSession: async () => {
        opened += 1;
        throw new Error('MUST_NOT_OPEN');
      },
      now: new Date('2026-08-08T06:00:00.000Z'),
    }),
    /ORDER_MANAGEMENT_SYNC_WINDOW_FUTURE/,
  );
  assert.equal(opened, 0);
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

test('session sync fails the total gate when retained rows do not exactly match total', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-sync-total-mismatch-'));
  const output = path.join(directory, 'order-management.sessions.json');
  const result = await runOrderManagementSessionSync({
    storeCodes: [...FULL_MANAGED_STORE_CODES],
    output,
    pageIds: ['quality-reports'],
    windowDays: 30,
    openSession: fakeOpenSession((endpointCode) => ({
      ...GOOD_RESPONSES[endpointCode],
      info: {
        ...GOOD_RESPONSES[endpointCode].info,
        totalCount: 2,
      },
    })),
    now: new Date('2026-08-08T06:00:00.000Z'),
  });
  assert.equal(result.snapshot.pages['quality-reports'].status, 'UNAVAILABLE');
  assert.equal(result.snapshot.pages['quality-reports'].gates.totalVerified, false);
  assert.match(result.snapshot.pages['quality-reports'].reason, /SESSION_GATE_FAILED|NO_STORE_SUCCEEDED/);
});

test('session sync requires the total on every page and rejects total drift', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-sync-page-total-'));
  const output = path.join(directory, 'order-management.sessions.json');
  const firstPage = Array.from({ length: 50 }, (_, index) => ({
    qcInspectionNo: `QC-PAGE-${index + 1}`,
    purchaseCode: `PB-${index + 1}`,
    inspectionTime: '2026-07-20 10:00:00',
    inspectionResult: 1,
    inspectionResultName: '合格',
  }));
  const result = await runOrderManagementSessionSync({
    storeCodes: [...FULL_MANAGED_STORE_CODES],
    output,
    pageIds: ['quality-reports'],
    windowDays: 30,
    openSession: async () => ({
      request: async (_endpointCode, body) => ({
        httpStatus: 200,
        byteLength: 1,
        body: body.page === 1
          ? { code: '0', info: { totalCount: 50, list: firstPage } }
          : { code: '0', info: { list: [] } },
      }),
      close: async () => ({ closed: true }),
      expiry: () => ({}),
    }),
    now: new Date('2026-08-08T06:00:00.000Z'),
  });
  assert.equal(result.snapshot.pages['quality-reports'].status, 'UNAVAILABLE');
  assert.equal(result.snapshot.pages['quality-reports'].gates.totalVerified, false);
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
