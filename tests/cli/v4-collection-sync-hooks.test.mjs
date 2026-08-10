import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  runOrderManagementSessionSync,
} from '../../scripts/sync_full_managed_order_management_sessions.mjs';
import {
  FULL_MANAGED_STORE_CODES,
} from '../../src/config/full-managed-stores.mjs';
import {
  ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS,
  ORDER_MANAGEMENT_ENDPOINTS,
  ORDER_MANAGEMENT_SESSION_PAGES,
} from '../../src/webapi-history/order-management-contracts.mjs';
import {
  OrderManagementTransportError,
} from '../../src/webapi-session/order-management-http.mjs';

const NOW = new Date('2026-08-11T04:00:00.000Z');
const WINDOW = Object.freeze({ startDate: '2026-07-12', endDate: '2026-08-10' });
const STORE = 'CX4412';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function schemaShape(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    const memberShapes = [...new Set(
      value.map((item) => stableJson(schemaShape(item))),
    )].sort();
    return { array: memberShapes };
  }
  if (typeof value === 'object') {
    const shape = {};
    for (const key of Object.keys(value).sort()) shape[key] = schemaShape(value[key]);
    return shape;
  }
  return typeof value;
}

function responseFor(endpointCode, body) {
  const base = { code: '0', msg: 'OK' };
  switch (endpointCode) {
    case 'STOCK_RECORDS_LIST':
      return {
        ...base,
        info: { count: 1, list: [{ id: 'SR-1', orderNo: 'SO-1', addTime: '2026-07-20 08:00:00' }] },
      };
    case 'WAYBILLS_PAGE': {
      const page = body.pageNumber;
      const rows = page === 1
        ? Array.from({ length: 50 }, (_, index) => ({
          id: `W-${index + 1}`,
          trackingNumber: `TRK-${index + 1}`,
          addTime: '2026-07-20 08:00:00',
        }))
        : Array.from({ length: 5 }, (_, index) => ({
          id: `W-2-${index + 1}`,
          trackingNumber: `TRK-2-${index + 1}`,
          addTime: '2026-07-20 08:00:00',
        }));
      return { ...base, info: { meta: { count: 55 }, data: rows } };
    }
    case 'RETURN_APPLICATIONS_LIST':
      return {
        ...base,
        info: { meta: { count: 1 }, data: [{ id: 'RA-1', returnPlanNo: 'RP-1' }] },
      };
    case 'RETURN_ORDERS_PAGE':
      return {
        ...base,
        info: { meta: { count: 1 }, data: [{ id: 'RO-1', returnOrderNo: 'RNO-1' }] },
      };
    case 'EXCEPTIONS_PAGE':
      return {
        ...base,
        info: { meta: { count: 1 }, data: [{ id: 'E-1', workorderNo: 'WO-1' }] },
      };
    case 'VALUE_ADDED_SERVICES_PAGE':
      return {
        ...base,
        info: {
          count: 1,
          list: [{
            id: 'V-1',
            orderNo: 'VO-1',
            // Currency-absent amounts: the probe proves the session boundary
            // drops them even when the platform payload carries them.
            actualTotalAmount: 12.5,
            estimateIncrementAmount: 6.78,
            skcNum: 3,
            defectiveQuantity: 1,
          }],
        },
      };
    case 'QUALITY_REPORTS_PAGE':
      return {
        ...base,
        info: { totalCount: 1, list: [{ id: 'Q-1', qcInspectionNo: 'QC-1' }] },
      };
    case 'WAYBILLS_STATISTICS':
      return { ...base, info: 42 };
    default:
      throw new Error(`UNEXPECTED_ENDPOINT: ${endpointCode}`);
  }
}

function fakeOrderManagementSession(calls, { failStatistics = false } = {}) {
  return async ({ storeCode }) => ({
    request: async (endpointCode, body) => {
      calls.push({ endpointCode, body });
      if (endpointCode === 'WAYBILLS_STATISTICS' && failStatistics) {
        throw new OrderManagementTransportError(
          'ORDER_MANAGEMENT_BUSINESS_STATUS_FAILED',
          { platformCode: 'X1' },
        );
      }
      const responseBody = responseFor(endpointCode, body);
      return { httpStatus: 200, byteLength: 2, body: responseBody };
    },
    close: async () => ({ closed: true }),
    expiry: () => ({}),
  });
}

async function runSyncWithEvidence({
  failStatistics = false,
  evidence = null,
  storeCodes = [STORE],
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-sync-hooks-'));
  const output = path.join(directory, 'candidate.json');
  const calls = [];
  const result = await runOrderManagementSessionSync({
    storeCodes,
    output,
    window: WINDOW,
    pageIds: Object.keys(ORDER_MANAGEMENT_SESSION_PAGES),
    includeStatistics: true,
    storeConcurrency: 1,
    openSession: fakeOrderManagementSession(calls, { failStatistics }),
    now: NOW,
    evidence,
  });
  return { calls, output, result };
}

test('page evidence hooks fire once per actual transport request with truthful metadata', async () => {
  const pageHooks = [];
  const statsHooks = [];
  const { calls } = await runSyncWithEvidence({
    evidence: {
      async onPage(entry) { pageHooks.push(entry); },
      async onStatistics(entry) { statsHooks.push(entry); },
    },
  });

  // Every successful page transport request produces exactly one hook entry.
  const waybillRequests = calls.filter((call) => call.endpointCode === 'WAYBILLS_PAGE');
  const waybillHooks = pageHooks.filter((entry) => entry.endpointCode === 'WAYBILLS_PAGE');
  assert.equal(waybillHooks.length, 2);
  assert.equal(waybillHooks.length, waybillRequests.length);
  assert.deepEqual(
    waybillHooks.map((entry) => entry.pageNumber),
    [1, 2],
  );

  for (const [index, hook] of waybillHooks.entries()) {
    const request = waybillRequests[index];
    assert.equal(hook.storeCode, STORE);
    assert.equal(hook.pageId, 'waybills');
    assert.equal(hook.endpointCode, 'WAYBILLS_PAGE');
    assert.equal(hook.pageSize, 50);
    assert.equal(hook.pageRequestFingerprint, sha256Hex(stableJson(request.body)));
    assert.equal(hook.httpStatus, 200);
    assert.equal(hook.observedAt, NOW.toISOString());
    const responseBody = responseFor('WAYBILLS_PAGE', request.body);
    assert.equal(hook.responseSchemaHash, sha256Hex(stableJson(schemaShape(responseBody))));
    assert.equal(hook.payloadHash, sha256Hex(stableJson(responseBody)));
  }

  // Page hooks for page 1 and page 2 carry different request fingerprints.
  assert.notEqual(waybillHooks[0].pageRequestFingerprint, waybillHooks[1].pageRequestFingerprint);
  assert.deepEqual(
    waybillHooks[0].rows.map((row) => row.trackingNumber),
    Array.from({ length: 50 }, (_, index) => `TRK-${index + 1}`),
  );
  assert.equal(waybillHooks[1].rows.length, 5);
});

test('page hook rows are allowlist-picked raw records with no foreign keys', async () => {
  const pageHooks = [];
  const { calls } = await runSyncWithEvidence({
    evidence: {
      async onPage(entry) { pageHooks.push(entry); },
      async onStatistics() {},
    },
  });
  assert.equal(pageHooks.length, 8); // 5 single-page windowed + 2 waybill pages + 2 once-only - 1 = 8
  for (const hook of pageHooks) {
    const allowlist = ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS[hook.endpointCode];
    const allowedNames = new Set(allowlist.map((entry) => entry.name));
    for (const row of hook.rows) {
      for (const key of Object.keys(row)) {
        assert.ok(allowedNames.has(key), `${hook.endpointCode} row leaked key ${key}`);
      }
    }
  }
  // The once-only pages are fetched without a window in their request body.
  const onceHooks = pageHooks.filter((entry) => (
    entry.endpointCode === 'EXCEPTIONS_PAGE' || entry.endpointCode === 'VALUE_ADDED_SERVICES_PAGE'
  ));
  assert.equal(onceHooks.length, 2);
  for (const hook of onceHooks) {
    const request = calls.find((call) => call.endpointCode === hook.endpointCode);
    const endpoint = ORDER_MANAGEMENT_ENDPOINTS[hook.endpointCode];
    assert.equal(request.body[endpoint.pageKey], 1);
    assert.ok(!('addTimeStart' in request.body));
    assert.ok(!('inspectionTimeStart' in request.body));
    assert.equal(hook.pageRequestFingerprint, sha256Hex(stableJson(request.body)));
  }
});

test('statistics hooks fire once per WAYBILLS_STATISTICS type with hashes and status', async () => {
  const statsHooks = [];
  const { calls } = await runSyncWithEvidence({
    evidence: {
      async onPage() {},
      async onStatistics(entry) { statsHooks.push(entry); },
    },
  });
  const statsRequests = calls.filter((call) => call.endpointCode === 'WAYBILLS_STATISTICS');
  assert.equal(statsHooks.length, 6);
  assert.equal(statsRequests.length, 6);
  for (const [index, hook] of statsHooks.entries()) {
    const statisticsType = index + 1;
    assert.equal(hook.storeCode, STORE);
    assert.equal(hook.statisticsType, statisticsType);
    assert.equal(hook.ok, true);
    assert.equal(hook.errorCode, null);
    assert.equal(hook.httpStatus, 200);
    assert.equal(hook.observedAt, NOW.toISOString());
    assert.equal(
      hook.pageRequestFingerprint,
      sha256Hex(stableJson(statsRequests[index].body)),
    );
    assert.equal(hook.payloadHash, sha256Hex(stableJson({ code: '0', msg: 'OK', info: 42 })));
    assert.match(hook.responseSchemaHash, /^[0-9a-f]{64}$/);
    assert.equal(statsRequests[index].body.statisticsType, statisticsType);
  }
});

test('a failed statistics call reports ok=false with a sanitized error code and no hashes', async () => {
  const statsHooks = [];
  const { result } = await runSyncWithEvidence({
    failStatistics: true,
    evidence: {
      async onPage() {},
      async onStatistics(entry) { statsHooks.push(entry); },
    },
  });
  assert.equal(statsHooks.length, 6);
  for (const hook of statsHooks) {
    assert.equal(hook.ok, false);
    assert.equal(hook.errorCode, 'ORDER_MANAGEMENT_BUSINESS_STATUS_FAILED');
    assert.equal(hook.responseSchemaHash, null);
    assert.equal(hook.payloadHash, null);
    assert.equal(hook.httpStatus, null);
    assert.match(hook.pageRequestFingerprint, /^[0-9a-f]{64}$/);
  }
  const firstStatistics = result.snapshot.evidence.perStore[0].statistics;
  assert.equal(firstStatistics.length, 6);
  assert.ok(firstStatistics.every((entry) => entry.errorCode === 'ORDER_MANAGEMENT_BUSINESS_STATUS_FAILED'));
});

test('without evidence hooks the sync keeps its exact snapshot shape (backward compatible)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-sync-nohooks-'));
  const output = path.join(directory, 'candidate.json');
  const calls = [];
  const result = await runOrderManagementSessionSync({
    storeCodes: [STORE],
    output,
    window: WINDOW,
    pageIds: Object.keys(ORDER_MANAGEMENT_SESSION_PAGES),
    includeStatistics: false,
    openSession: fakeOrderManagementSession(calls),
    now: NOW,
  });
  assert.equal(result.snapshot.schemaVersion, 1);
  assert.deepEqual(result.snapshot.window, WINDOW);
  assert.equal(result.snapshot.roster.length, 25);
  assert.deepEqual(Object.keys(result.snapshot.pages).sort(), [
    'exceptions',
    'quality-reports',
    'return-applications',
    'return-orders',
    'stock-records',
    'value-added-services',
    'waybills',
  ]);
  assert.equal(result.snapshot.evidence.perStore.length, 1);
  assert.equal(result.written, output);
  const written = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(written.schemaVersion, 1);
});

test('a throwing evidence hook fails the sync closed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-sync-hookthrow-'));
  const output = path.join(directory, 'candidate.json');
  const calls = [];
  await assert.rejects(
    () => runOrderManagementSessionSync({
      storeCodes: [STORE],
      output,
      window: WINDOW,
      pageIds: ['stock-records'],
      includeStatistics: false,
      openSession: fakeOrderManagementSession(calls),
      now: NOW,
      evidence: {
        async onPage() { throw new Error('HOOK_FAILED'); },
        async onStatistics() {},
      },
    }),
    /HOOK_FAILED/,
  );
});

test('page hooks report each endpoint page size exactly as sent', async () => {
  const pageHooks = [];
  const { calls } = await runSyncWithEvidence({
    evidence: {
      async onPage(entry) { pageHooks.push(entry); },
      async onStatistics() {},
    },
  });
  const byEndpoint = new Map();
  for (const hook of pageHooks) {
    byEndpoint.set(hook.endpointCode, hook);
  }
  assert.equal(byEndpoint.get('STOCK_RECORDS_LIST').pageSize, 100);
  assert.equal(byEndpoint.get('WAYBILLS_PAGE').pageSize, 50);
  assert.equal(byEndpoint.get('RETURN_APPLICATIONS_LIST').pageSize, 50);
  assert.equal(byEndpoint.get('RETURN_ORDERS_PAGE').pageSize, 50);
  assert.equal(byEndpoint.get('EXCEPTIONS_PAGE').pageSize, 50);
  assert.equal(byEndpoint.get('VALUE_ADDED_SERVICES_PAGE').pageSize, 50);
  assert.equal(byEndpoint.get('QUALITY_REPORTS_PAGE').pageSize, '50');
  for (const hook of pageHooks) {
    const pageKey = ORDER_MANAGEMENT_ENDPOINTS[hook.endpointCode].pageKey;
    const request = calls.find((call) => call.endpointCode === hook.endpointCode
      && call.body[pageKey] === hook.pageNumber);
    assert.equal(
      hook.pageRequestFingerprint,
      sha256Hex(stableJson(request.body)),
      `${hook.endpointCode} page ${hook.pageNumber}`,
    );
  }
});

test('full 25-store-shaped probe: currency-absent VAS amounts never reach candidate rows, metrics or evidence picks', async () => {
  const pageHooks = [];
  const { result } = await runSyncWithEvidence({
    storeCodes: [...FULL_MANAGED_STORE_CODES],
    evidence: {
      async onPage(entry) { pageHooks.push(entry); },
      async onStatistics() {},
    },
  });
  const page = result.snapshot.pages['value-added-services'];
  assert.equal(page.status, 'AVAILABLE');
  assert.equal(page.gates.storeCount, FULL_MANAGED_STORE_CODES.length);
  assert.equal(page.rows.length, FULL_MANAGED_STORE_CODES.length);
  const serializedRows = JSON.stringify(page.rows);
  assert.ok(!serializedRows.includes('actualTotalAmount'));
  assert.ok(!serializedRows.includes('estimateIncrementAmount'));
  for (const row of page.rows) {
    assert.ok(!Object.prototype.hasOwnProperty.call(row, 'actualTotalAmount'));
    assert.ok(!Object.prototype.hasOwnProperty.call(row, 'estimateIncrementAmount'));
    const metricNames = row.metrics.map((entry) => entry.name);
    assert.ok(!metricNames.includes('actualTotalAmount'));
    assert.ok(!metricNames.includes('estimateIncrementAmount'));
  }
  // Sanitization is selective: typed non-monetary VAS fields survive.
  const retainedMetricNames = [
    ...new Set(page.rows.flatMap((row) => row.metrics.map((entry) => entry.name))),
  ].sort();
  assert.deepEqual(retainedMetricNames, ['defectiveQuantity', 'skcNum']);
  // In-memory evidence picks are stripped the same way.
  const vasHooks = pageHooks.filter((entry) => entry.endpointCode === 'VALUE_ADDED_SERVICES_PAGE');
  assert.equal(vasHooks.length, FULL_MANAGED_STORE_CODES.length);
  for (const hook of vasHooks) {
    for (const row of hook.rows) {
      assert.ok(!Object.prototype.hasOwnProperty.call(row, 'actualTotalAmount'));
      assert.ok(!Object.prototype.hasOwnProperty.call(row, 'estimateIncrementAmount'));
    }
  }
});

test('full 25-store-shaped probe: statistics candidate evidence is control receipts only, no business values', async () => {
  const { result } = await runSyncWithEvidence({
    storeCodes: [...FULL_MANAGED_STORE_CODES],
    evidence: {
      async onPage() {},
      async onStatistics() {},
    },
  });
  const perStore = result.snapshot.evidence.perStore;
  assert.equal(perStore.length, FULL_MANAGED_STORE_CODES.length);
  for (const storeEvidence of perStore) {
    assert.equal(storeEvidence.statistics.length, 6);
    for (const receipt of storeEvidence.statistics) {
      // Control receipt only: endpoint/type plus outcome, never the payload's
      // info value or any other business figure.
      assert.deepEqual(Object.keys(receipt).sort(), ['statisticsType']);
    }
  }
  assert.ok(!JSON.stringify(perStore).includes('"value"'));
});
