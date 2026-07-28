import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PURCHASE_ORDER_ADAPTER_REJECT_CODES,
  PURCHASE_ORDER_ADAPTER_SCHEMA_FINGERPRINT,
  createPurchaseOrderBackfillAdapter,
} from '../../src/backfill/purchase-order-adapter.mjs';

const NOW = new Date('2026-07-28T12:34:56.000Z');
const WINDOW = Object.freeze({
  planHash: 'f'.repeat(64),
  storeCode: 'DL5477',
  domain: 'purchase-orders',
  windowStart: '2026-07-01',
  windowEnd: '2026-07-02',
  windowKey: 'a'.repeat(64),
  attempt: 1,
});

function purchasePlan() {
  return {
    mode: 'BACKFILL',
    field: 'updateTime',
    timezone: 'Asia/Shanghai',
    start: '2026-07-01 00:00:00',
    end: '2026-07-02 00:00:00',
    windows: [{
      start: '2026-07-01 00:00:00',
      end: '2026-07-02 00:00:00',
    }],
    completeRequestedRange: true,
    completeHistoricalCoverage: false,
  };
}

function passingSummary() {
  const plan = purchasePlan();
  return {
    ok: true,
    mode: 'BACKFILL',
    sourceFetchedAt: NOW.toISOString(),
    domains: ['purchase-orders'],
    windows: { purchaseOrders: plan },
    coverageGate: {
      requestedRangeLoaded: true,
      historicalCompletenessClaimed: false,
    },
    results: [{
      storeCode: 'DL5477',
      domains: [{
        domain: 'purchase-orders',
        status: 'loaded',
        recordCount: 2,
        pageCount: 1,
        terminalReason: 'ALL_WINDOWS_REACHED_TERMINAL_PAGE',
        mode: 'BACKFILL',
        window: plan,
      }],
      warehouseLoads: [{ counts: { purchaseOrderCount: 2 } }],
    }],
  };
}

function adapterFor(runSupplySync) {
  return createPurchaseOrderBackfillAdapter({
    runSupplySync,
    config: { stores: [] },
    databaseUrl: 'postgresql://supply.invalid/db',
    allowedStoreCodes: ['DL5477'],
    clock: () => NOW,
  });
}

test('delegates one exact purchase-order window and translates proven evidence', async () => {
  const calls = [];
  const adapter = adapterFor(async (input) => {
    calls.push(input);
    return passingSummary();
  });
  const result = await adapter.fetchWindow(WINDOW);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].stores, 'DL5477');
  assert.equal(calls[0].domains, 'purchase-orders');
  assert.equal(calls[0].mode, 'BACKFILL');
  assert.equal(calls[0].backfillStart, '2026-07-01T00:00:00+08:00');
  assert.equal(calls[0].backfillEnd, '2026-07-02T00:00:00+08:00');
  assert.equal(calls[0].now, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.acceptedRowCount, 2);
  assert.equal(result.persistedRowCount, 2);
  assert.equal(result.expectedPageCount, 1);
  assert.equal(result.observedPageCount, 1);
  assert.equal(result.sourceBusinessWatermark, '2026-07-01');
  assert.equal(result.schemaFingerprint, PURCHASE_ORDER_ADAPTER_SCHEMA_FINGERPRINT);
});

test('delivery scope and an unapproved store fail before delegation', async () => {
  let calls = 0;
  const adapter = adapterFor(async () => {
    calls += 1;
    return passingSummary();
  });
  const delivery = await adapter.fetchWindow({ ...WINDOW, domain: 'deliveries' });
  assert.equal(delivery.sanitizedErrorCode,
    PURCHASE_ORDER_ADAPTER_REJECT_CODES.DOMAIN_NOT_EXECUTABLE);
  const store = await adapter.fetchWindow({ ...WINDOW, storeCode: 'MZ2406' });
  assert.equal(store.sanitizedErrorCode,
    PURCHASE_ORDER_ADAPTER_REJECT_CODES.STORE_NOT_AUTHORIZED);
  assert.equal(calls, 0);
});

test('every incomplete delegate shape fails closed', async () => {
  const cases = [
    ['multiple stores', (value) => value.results.push(structuredClone(value.results[0])),
      PURCHASE_ORDER_ADAPTER_REJECT_CODES.RESULT_STORE_COUNT_NOT_ONE],
    ['not loaded', (value) => { value.results[0].domains[0].status = 'partial'; },
      PURCHASE_ORDER_ADAPTER_REJECT_CODES.DOMAIN_NOT_LOADED],
    ['terminal missing', (value) => { value.results[0].domains[0].terminalReason = 'SHORT_PAGE'; },
      PURCHASE_ORDER_ADAPTER_REJECT_CODES.TERMINAL_PAGE_NOT_PROVEN],
    ['range widened', (value) => { value.windows.purchaseOrders.end = '2026-07-03 00:00:00'; },
      PURCHASE_ORDER_ADAPTER_REJECT_CODES.WINDOW_PLAN_MISMATCH],
    ['persisted mismatch', (value) => {
      value.results[0].warehouseLoads[0].counts.purchaseOrderCount = 1;
    }, PURCHASE_ORDER_ADAPTER_REJECT_CODES.PERSISTED_COUNT_MISMATCH],
    ['coverage false', (value) => { value.coverageGate.requestedRangeLoaded = false; },
      PURCHASE_ORDER_ADAPTER_REJECT_CODES.REQUESTED_RANGE_NOT_LOADED],
  ];
  for (const [name, mutate, expected] of cases) {
    const summary = passingSummary();
    mutate(summary);
    const result = await adapterFor(async () => summary).fetchWindow(WINDOW);
    assert.equal(result.ok, false, name);
    assert.equal(result.adapterError, true, name);
    assert.equal(result.sanitizedErrorCode, expected, name);
  }
});

test('invalid and future windows fail before delegation', async () => {
  let calls = 0;
  const adapter = adapterFor(async () => {
    calls += 1;
    return passingSummary();
  });
  const multiDay = await adapter.fetchWindow({ ...WINDOW, windowEnd: '2026-07-03' });
  assert.equal(multiDay.sanitizedErrorCode,
    PURCHASE_ORDER_ADAPTER_REJECT_CODES.WINDOW_NOT_ONE_DAY);
  const future = await adapter.fetchWindow({
    ...WINDOW,
    windowStart: '2026-07-28',
    windowEnd: '2026-07-29',
  });
  assert.equal(future.sanitizedErrorCode,
    PURCHASE_ORDER_ADAPTER_REJECT_CODES.WINDOW_END_AFTER_NOW);
  assert.equal(calls, 0);
});
