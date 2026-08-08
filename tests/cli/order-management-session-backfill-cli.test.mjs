import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';
import {
  BACKFILL_ONCE_PAGE_IDS,
  BACKFILL_PAGE_IDS,
  BACKFILL_WINDOWED_PAGE_IDS,
  buildBackfillWindows,
  parseArgs as parseBackfillArgs,
  partFileForWindow,
  partFileForOnce,
  runOrderManagementSessionBackfill,
} from '../../scripts/backfill_full_managed_order_management_sessions.mjs';
import {
  runOrderManagementSessionSync,
} from '../../scripts/sync_full_managed_order_management_sessions.mjs';
import { mergeOrderManagementSessionSnapshots } from '../../src/warehouse/order-management-snapshot-merge.mjs';

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

test('backfill CLI validates the page-id scope strictly', () => {
  const stores = FULL_MANAGED_STORE_CODES.join(',');
  const args = parseBackfillArgs([
    `--stores=${stores}`,
    '--start-date=2026-01-01',
    '--end-date=2026-08-08',
    '--output=/tmp/backfill.json',
    '--page-ids=return-applications,return-orders,exceptions,value-added-services,quality-reports',
    '--merge-with=/tmp/production.json',
  ]);
  assert.deepEqual(args.pageIds, [
    'return-applications',
    'return-orders',
    'exceptions',
    'value-added-services',
    'quality-reports',
  ]);
  assert.equal(args.mergeWith, '/tmp/production.json');
  assert.deepEqual(parseBackfillArgs([
    `--stores=${stores}`,
    '--start-date=2026-01-01',
    '--end-date=2026-08-08',
    '--output=/tmp/backfill.json',
  ]).pageIds, [...BACKFILL_PAGE_IDS]);
  assert.throws(
    () => parseBackfillArgs([
      `--stores=${stores}`,
      '--start-date=2026-01-01',
      '--end-date=2026-08-08',
      '--output=/tmp/backfill.json',
      '--page-ids=delivery-desk',
    ]),
    /ORDER_MANAGEMENT_BACKFILL_PAGE_SCOPE_REQUIRED/,
  );
  assert.throws(
    () => parseBackfillArgs([
      `--stores=${stores}`,
      '--start-date=2026-01-01',
      '--end-date=2026-08-08',
      '--output=/tmp/backfill.json',
      '--page-ids=',
    ]),
    /ORDER_MANAGEMENT_BACKFILL_ARGUMENT_INVALID/,
  );
});

test('the backfill page scope separates windowed and once-only pages', () => {
  assert.deepEqual(BACKFILL_WINDOWED_PAGE_IDS, [
    'stock-records',
    'waybills',
    'return-applications',
    'return-orders',
    'quality-reports',
  ]);
  assert.deepEqual(BACKFILL_ONCE_PAGE_IDS, ['exceptions', 'value-added-services']);
  assert.equal(BACKFILL_PAGE_IDS.length, 7);
  assert.ok(!BACKFILL_PAGE_IDS.includes('delivery-desk'));
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

test('backfill dry-run with a five-page scope plans windows and a once part deterministically', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-backfill-scope-dry-'));
  const output = path.join(directory, 'backfill.json');
  const scope = [
    'return-applications',
    'return-orders',
    'exceptions',
    'value-added-services',
    'quality-reports',
  ];
  const options = {
    storeCodes: ROSTER,
    startDate: '2026-01-01',
    endDate: '2026-03-31',
    output,
    execute: false,
    pageIds: scope,
    now: NOW,
    runWindow: async () => {
      throw new Error('MUST_NOT_CALL');
    },
  };
  const result1 = await runOrderManagementSessionBackfill(options);
  const result2 = await runOrderManagementSessionBackfill(options);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result1.plan)),
    JSON.parse(JSON.stringify(result2.plan)),
  );
  assert.deepEqual(result1.plan.pageIds, scope);
  assert.deepEqual(result1.plan.windowedPageIds, [
    'return-applications',
    'return-orders',
    'quality-reports',
  ]);
  assert.deepEqual(result1.plan.oncePageIds, ['exceptions', 'value-added-services']);
  assert.equal(result1.plan.windowCount, 3);
  assert.deepEqual(result1.plan.onceParts, [{
    partFile: path.resolve(partFileForOnce(output, ['exceptions', 'value-added-services'])),
    pageIds: ['exceptions', 'value-added-services'],
  }]);
  assert.ok(result1.plan.onceParts[0].partFile.endsWith(
    'backfill.json.part.once.exceptions.value-added-services.json',
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
    contentVerified: status === 'AVAILABLE',
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
  const oncePerWindowRow = (id) => makeRow(id, 'CX4412');
  return Object.freeze({
    schemaVersion: 1,
    updatedAt: '2026-08-08T06:00:00.000Z',
    roster: Object.freeze([...FULL_MANAGED_STORE_CODES]),
    window: Object.freeze({ ...window }),
    pages: Object.freeze({
      'stock-records': page('stock-records', stockRows),
      waybills: page('waybills', waybillRows),
      'return-applications': page('return-applications', [oncePerWindowRow('RA-W')]),
      'return-orders': page('return-orders', [oncePerWindowRow('RO-W')]),
      'quality-reports': page('quality-reports', [oncePerWindowRow('QC-W')]),
    }),
  });
}

function makeOnceSnapshot() {
  const gates = Object.freeze({
    totalVerified: true,
    pagingVerified: true,
    dedupeVerified: true,
    contentVerified: true,
    storeCount: 25,
  });
  const page = (pageId, rows) => Object.freeze({
    status: 'AVAILABLE',
    source: 'SESSION_HTTP',
    latestSourceFetchedAt: '2026-08-08T06:00:00.000Z',
    reason: null,
    storeCodes: Object.freeze([...FULL_MANAGED_STORE_CODES]),
    gates,
    rows: Object.freeze(rows),
  });
  return Object.freeze({
    schemaVersion: 1,
    updatedAt: '2026-08-08T06:00:00.000Z',
    roster: Object.freeze([...FULL_MANAGED_STORE_CODES]),
    window: null,
    pages: Object.freeze({
      exceptions: page('exceptions', [makeRow('WO-W', 'CX4412')]),
      'value-added-services': page('value-added-services', [makeRow('VA-W', 'CX4412')]),
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
      if (options.window === null) return { snapshot: makeOnceSnapshot(), written: options.output };
      return { snapshot: makeWindowSnapshot(options.window), written: options.output };
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].window.startDate, '2026-01-01');
  assert.equal(calls[0].window.endDate, '2026-01-30');
  assert.equal(calls[1].window.startDate, '2026-01-31');
  assert.equal(calls[1].window.endDate, '2026-02-09');
  assert.equal(calls[2].window, null);
  assert.deepEqual(calls[0].pageIds, [
    'stock-records',
    'waybills',
    'return-applications',
    'return-orders',
    'quality-reports',
  ]);
  assert.deepEqual(calls[2].pageIds, ['exceptions', 'value-added-services']);
  assert.equal(calls[0].sessionStore, sessionStore);
  assert.equal(calls[1].sessionStore, sessionStore);
  assert.equal(calls[2].sessionStore, sessionStore);
  assert.equal(calls[0].includeStatistics, false);
  assert.equal(calls[1].includeStatistics, false);
  assert.equal(calls[2].includeStatistics, false);
  assert.equal(calls[0].storeConcurrency, 5);
  assert.equal(calls[1].storeConcurrency, 5);
  assert.equal(calls[2].storeConcurrency, 5);
  assert.equal(result.written, output);
  const snapshot = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.scope.startDate, '2026-01-01');
  assert.equal(snapshot.scope.endDate, '2026-02-09');
  assert.equal(snapshot.scope.windowCount, 2);
  assert.equal(snapshot.backfill.windows.length, 2);
  assert.equal(snapshot.backfill.once.length, 1);
  assert.equal(snapshot.pages.exceptions.rows.length, 1);
  assert.equal(snapshot.backfill.windows[0].partFile, path.resolve(
    partFileForWindow(output, 0, { startDate: '2026-01-01', endDate: '2026-01-30' }),
  ));
  assert.equal(snapshot.pages['stock-records'].status, 'AVAILABLE');
  assert.deepEqual(snapshot.pages['stock-records'].gates, {
    totalVerified: true,
    pagingVerified: true,
    dedupeVerified: true,
    contentVerified: true,
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
        if (options.window === null) {
          await writeFile(options.output, JSON.stringify({ once: true }));
          return { snapshot: makeOnceSnapshot(), written: options.output };
        }
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
        addTime: '2026-07-20 10:00:00',
        returnReasonType: 1,
        returnReasonName: '滞销退',
        returnDealType: 1,
        returnDealTypeName: '退货',
        returnMode: 1,
        returnModeName: 'SHEIN合作物流',
        returnQuantity: 10,
        returnGenerateQuantity: 10,
        returnTotalAmount: 123.45,
        currencyCode: 'USD',
        warehouseIds: ['W1', 'W2'],
        sellerAddress: 'secret street',
        phone: '13800138000',
        contract: 'secret contract',
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
        returnPlanNo: 'RA-SYNC-1',
        returnOrderStatus: '2',
        returnOrderStatusName: '待退货',
        returnOrderType: 1,
        returnOrderTypeName: '退货',
        returnWayType: 1,
        returnWayTypeName: 'SHEIN合作物流',
        addTime: '2026-07-20 10:00:00',
        warehouseId: 1,
        warehouseName: '总仓',
        waitReturnQuantity: 10,
        returnQuantity: 10,
        skcNameList: ['sv-1'],
        returnAmount: 50,
        currencyCode: 'USD',
        returnAddress: 'secret address',
        driverName: '司机',
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
        categoryName: '收货异常',
        sceneTypeName: '缺货',
        statusValue: '1',
        statusName: '处理中',
        createTime: '2026-07-20 10:00:00',
        sellerTitle: '某卖家',
        creator: '张三',
        problemDesc: '问题描述',
        resultReply: '答复',
        attachmentUrlList: ['https://img.example/a.png'],
        goodsThumb: 'https://img.example/t.png',
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
        subOrderNo: 'VA-SUB-4',
        serviceSiteName: '华东仓',
        orderState: '1',
        orderStateName: '服务中',
        actualTotalAmount: 12.5,
        skc: 'sv-1',
        skcNum: 1,
        serviceDesc: '描述',
        remark: '备注',
        img: 'https://img.example/v.png',
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
        hasDefectiveTotal: 0,
        hasDefectiveTotalName: '无次品',
        inspectionTime: '2026-07-20 10:00:00',
        defectiveTotalQty: 0,
        qcType: 1,
        qcTypeName: '出库质检',
        orderQcResult: 1,
        orderQcResultName: '合格',
        inspectionResult: 1,
        inspectionResultName: '合格',
        reportUrl: 'https://img.example/report.png',
        img: 'https://img.example/q.png',
      }],
      totalCount: 1,
    },
  },
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

test('session sync rejects unsafe store concurrency before opening a session', async () => {
  let opens = 0;
  await assert.rejects(
    () => runOrderManagementSessionSync({
      storeCodes: ROSTER,
      output: 'unused.json',
      storeConcurrency: 6,
      openSession: async () => {
        opens += 1;
        throw new Error('MUST_NOT_OPEN');
      },
      now: NOW,
    }),
    /ORDER_MANAGEMENT_SYNC_CONCURRENCY_INVALID/,
  );
  assert.equal(opens, 0);
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

  assert.equal(result.partFiles.length, 3);
  const firstPart = JSON.parse(await readFile(result.partFiles[0], 'utf8'));
  assert.equal(firstPart.window.startDate, '2026-06-30');
  assert.deepEqual(firstPart.evidence.perStore[0].statistics, []);
  assert.equal(firstPart.pages['stock-records'].status, 'AVAILABLE');
  assert.deepEqual(firstPart.pages['stock-records'].gates, {
    totalVerified: true,
    pagingVerified: true,
    dedupeVerified: true,
    contentVerified: true,
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
    contentVerified: true,
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

test('five-page backfill never refetches stock-records or waybills and writes one once part', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-backfill-five-'));
  const output = path.join(directory, 'backfill.json');
  const endpointCalls = [];
  const scope = [
    'return-applications',
    'return-orders',
    'exceptions',
    'value-added-services',
    'quality-reports',
  ];
  const result = await runOrderManagementSessionBackfill({
    storeCodes: ROSTER,
    startDate: '2026-07-30',
    endDate: '2026-08-08',
    output,
    execute: true,
    pageIds: scope,
    sessionStore: {
      read: async () => { throw new Error('UNUSED'); },
      write: async () => { throw new Error('UNUSED'); },
    },
    now: NOW,
    openSession: fakeOrderManagementSession(endpointCalls),
  });
  assert.ok(!endpointCalls.some((call) => call.endpointCode === 'STOCK_RECORDS_LIST'));
  assert.ok(!endpointCalls.some((call) => call.endpointCode === 'WAYBILLS_PAGE'));
  assert.ok(!endpointCalls.some((call) => call.endpointCode === 'WAYBILLS_STATISTICS'));
  const returnPlanBodies = endpointCalls
    .filter((call) => call.endpointCode === 'RETURN_APPLICATIONS_LIST')
    .map((call) => call.body);
  assert.equal(returnPlanBodies[0].returnTimeStart, '2026-07-30 00:00:00');
  assert.equal(returnPlanBodies[0].returnTimeEnd, '2026-08-08 23:59:59');
  const qualityBodies = endpointCalls
    .filter((call) => call.endpointCode === 'QUALITY_REPORTS_PAGE')
    .map((call) => call.body);
  assert.equal(qualityBodies[0].reportUrl, 1);
  assert.equal(qualityBodies[0].perPage, '50');
  const exceptionBodies = endpointCalls
    .filter((call) => call.endpointCode === 'EXCEPTIONS_PAGE')
    .map((call) => call.body);
  const vasBodies = endpointCalls
    .filter((call) => call.endpointCode === 'VALUE_ADDED_SERVICES_PAGE')
    .map((call) => call.body);
  assert.equal(exceptionBodies.length, ROSTER.length);
  assert.equal(vasBodies.length, ROSTER.length);
  assert.ok(exceptionBodies.every((body) => !Object.keys(body).some((key) => /Time|Date/.test(key))));
  assert.ok(vasBodies.every((body) => !Object.keys(body).some((key) => /Time|Date/.test(key))));
  assert.equal(vasBodies[0].pageNumber, 1);
  assert.equal(vasBodies[0].pageSize, 50);

  assert.equal(result.partFiles.length, 2);
  const oncePart = JSON.parse(await readFile(result.partFiles[1], 'utf8'));
  assert.deepEqual(Object.keys(oncePart.pages).sort(), ['exceptions', 'value-added-services']);
  assert.equal(oncePart.pages.exceptions.status, 'AVAILABLE');
  assert.equal(oncePart.pages.exceptions.gates.contentVerified, true);
  assert.equal(oncePart.window, null);

  const snapshot = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(Object.keys(snapshot.pages).sort(), [...scope].sort());
  assert.deepEqual(snapshot.scope.pageIds, scope);
  assert.equal(snapshot.scope.windowCount, 1);
  assert.equal(snapshot.backfill.windows.length, 1);
  assert.equal(snapshot.backfill.once.length, 1);
  assert.equal(snapshot.pages.exceptions.rows.length, ROSTER.length);
  assert.equal(snapshot.pages['value-added-services'].rows.length, ROSTER.length);
  assert.equal(snapshot.pages['quality-reports'].rows.length, ROSTER.length);
  assert.equal(snapshot.pages['return-applications'].rows.length, ROSTER.length);
  assert.equal(snapshot.pages['return-orders'].rows.length, ROSTER.length);
  const text = JSON.stringify(snapshot);
  for (const leaked of [
    'sellerAddress', 'phone', 'contract', 'returnAddress', 'driverName',
    'sellerTitle', 'creator', 'problemDesc', 'resultReply',
    'attachmentUrlList', 'goodsThumb', 'serviceDesc', 'remark', 'img',
    'reportUrl',
  ]) {
    assert.ok(!text.includes(leaked), `snapshot must not contain ${leaked}`);
  }
});

test('a once-only page scope skips the window loop entirely', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-backfill-once-only-'));
  const output = path.join(directory, 'backfill.json');
  const endpointCalls = [];
  const result = await runOrderManagementSessionBackfill({
    storeCodes: ROSTER,
    startDate: '2022-01-01',
    endDate: '2026-08-08',
    output,
    execute: true,
    pageIds: ['exceptions', 'value-added-services'],
    sessionStore: {},
    now: NOW,
    openSession: fakeOrderManagementSession(endpointCalls),
  });
  assert.ok(endpointCalls.every((call) => (
    call.endpointCode === 'EXCEPTIONS_PAGE' || call.endpointCode === 'VALUE_ADDED_SERVICES_PAGE'
  )));
  assert.equal(result.partFiles.length, 1);
  const snapshot = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(snapshot.scope.windowCount, 0);
  assert.deepEqual(snapshot.backfill.windows, []);
  assert.equal(snapshot.backfill.once.length, 1);
  assert.deepEqual(Object.keys(snapshot.pages).sort(), ['exceptions', 'value-added-services']);
});

test('a page whose rows are all dropped by the allowlist fails the content gate', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-backfill-content-'));
  const output = path.join(directory, 'backfill.json');
  const endpointCalls = [];
  const openSession = async ({ storeCode }) => ({
    request: async (endpointCode) => {
      endpointCalls.push(endpointCode);
      if (endpointCode === 'QUALITY_REPORTS_PAGE') {
        // The raw rows carry no allowlisted qcInspectionNo, so every row is
        // dropped and the content gate must fail closed.
        return {
          httpStatus: 200,
          byteLength: 1,
          body: {
            code: '0',
            msg: 'OK',
            info: { list: [{ otherKey: 'x' }], totalCount: 1 },
          },
        };
      }
      return { httpStatus: 200, byteLength: 1, body: GOOD_RESPONSES[endpointCode] };
    },
    close: async () => ({ closed: true }),
    expiry: () => ({}),
  });
  await assert.rejects(
    () => runOrderManagementSessionBackfill({
      storeCodes: ROSTER,
      startDate: '2026-08-01',
      endDate: '2026-08-08',
      output,
      execute: true,
      pageIds: ['quality-reports'],
      sessionStore: {},
      now: NOW,
      openSession,
    }),
    /ORDER_MANAGEMENT_BACKFILL_WINDOW_GATE_FAILED|ORDER_MANAGEMENT_BACKFILL_ONCE_GATE_FAILED/,
  );
  assert.equal(existsSync(output), false);
});

function productionCompleteSnapshot() {
  const stockRow = {
    id: 'PB-PROD-1',
    storeCode: 'CX4412',
    statusCode: '1',
    statusName: null,
    createdAt: '2022-01-02T00:00:00.000Z',
    updatedAt: '2026-08-08T06:00:00.000Z',
    primary: 'PB-PROD-1',
    secondary: null,
    tags: [],
    metrics: [],
    facts: [],
    details: [],
  };
  const waybillRow = {
    ...stockRow,
    id: 'SF-PROD-1',
    primary: 'SF-PROD-1',
    tags: ['运单'],
  };
  const page = (rows) => ({
    status: 'AVAILABLE',
    source: 'SESSION_HTTP',
    latestSourceFetchedAt: '2026-08-08T06:00:00.000Z',
    reason: null,
    storeCodes: [...FULL_MANAGED_STORE_CODES].sort(),
    gates: {
      totalVerified: true,
      pagingVerified: true,
      dedupeVerified: true,
      storeCount: 25,
    },
    rows,
  });
  const windows = buildBackfillWindows({ startDate: '2022-01-01', endDate: '2026-08-08' })
    .map((window, index) => ({
      index: index + 1,
      startDate: window.startDate,
      endDate: window.endDate,
      partFile: `/tmp/production.part.${String(index + 1).padStart(2, '0')}.json`,
      fetchedAt: '2026-08-08T06:00:00.000Z',
      pages: {},
    }));
  return {
    schemaVersion: 1,
    updatedAt: '2026-08-08T06:00:00.000Z',
    roster: [...FULL_MANAGED_STORE_CODES],
    window: { startDate: '2022-01-01', endDate: '2026-08-08' },
    scope: {
      startDate: '2022-01-01',
      endDate: '2026-08-08',
      storeCodes: [...FULL_MANAGED_STORE_CODES].sort(),
      windowCount: windows.length,
      maximumDays: 30,
    },
    backfill: { windows },
    pages: {
      'stock-records': page([stockRow]),
      waybills: page([waybillRow]),
    },
  };
}

test('backfill merges the five new pages over the production snapshot without touching its two pages', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'om-backfill-merge-'));
  const production = path.join(directory, 'production.json');
  const output = path.join(directory, 'combined.json');
  await writeFile(production, JSON.stringify(productionCompleteSnapshot()));
  const endpointCalls = [];
  const scope = [
    'return-applications',
    'return-orders',
    'exceptions',
    'value-added-services',
    'quality-reports',
  ];
  const result = await runOrderManagementSessionBackfill({
    storeCodes: ROSTER,
    startDate: '2022-01-01',
    endDate: '2026-08-08',
    output,
    execute: true,
    pageIds: scope,
    mergeWith: production,
    sessionStore: {
      read: async () => { throw new Error('UNUSED'); },
      write: async () => { throw new Error('UNUSED'); },
    },
    now: NOW,
    openSession: fakeOrderManagementSession(endpointCalls),
  });
  assert.equal(result.mergedFrom, production);
  const existing = JSON.parse(await readFile(production, 'utf8'));
  const merged = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(merged.pages['stock-records'], existing.pages['stock-records']);
  assert.deepEqual(merged.pages.waybills, existing.pages.waybills);
  assert.deepEqual(Object.keys(merged.pages).sort(), [...scope, 'stock-records', 'waybills'].sort());
  assert.equal(merged.scope.startDate, '2022-01-01');
  assert.equal(merged.scope.endDate, '2026-08-08');
  assert.equal(merged.scope.windowCount, existing.backfill.windows.length);
  assert.equal(merged.backfill.windows.length, existing.backfill.windows.length);
  assert.equal(merged.backfill.windows[0].partFiles.length, 2);
  assert.equal(result.partFiles.length, existing.backfill.windows.length + 1);
  assert.equal(merged.backfill.once.length, 1);
  assert.equal(merged.pages['quality-reports'].rows.length, ROSTER.length);
  assert.ok(!JSON.stringify(merged).includes('reportUrl'));
});

test('the additive merge refuses a conflicting overlap on an existing page', async () => {
  const existing = productionCompleteSnapshot();
  const producedPages = JSON.parse(JSON.stringify(existing.pages));
  producedPages['stock-records'] = {
    ...producedPages['stock-records'],
    rows: [],
  };
  const produced = {
    schemaVersion: 1,
    updatedAt: '2026-08-08T07:00:00.000Z',
    roster: [...FULL_MANAGED_STORE_CODES],
    window: { startDate: '2026-08-01', endDate: '2026-08-08' },
    scope: {
      startDate: '2026-08-01',
      endDate: '2026-08-08',
      storeCodes: [...FULL_MANAGED_STORE_CODES].sort(),
      windowCount: 1,
      maximumDays: 30,
      pageIds: ['stock-records'],
    },
    backfill: {
      windows: [{
        index: 1,
        startDate: '2026-08-01',
        endDate: '2026-08-08',
        partFile: '/tmp/produced.part.01.json',
        fetchedAt: '2026-08-08T07:00:00.000Z',
        pages: {},
      }],
      once: [],
    },
    pages: producedPages,
  };
  assert.throws(
    () => mergeOrderManagementSessionSnapshots({ existing, produced, now: NOW }),
    /ORDER_MANAGEMENT_MERGE_PAGE_CONFLICT: stock-records/,
  );
});
