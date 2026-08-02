import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeRealtimeStoreRows,
  runFullHomeHistorySync,
} from '../../src/webapi-history/sync.mjs';

function response(body) {
  return { httpStatus: 200, byteLength: JSON.stringify(body).length, body };
}

test('homepage history sync processes one Profile at a time and preserves partial product failure', async () => {
  const events = [];
  const audits = [];
  const storeRows = [];
  const productRows = [];
  const sessionOptions = [];
  let activeSessions = 0;
  const result = await runFullHomeHistorySync({
    storeCodes: ['DL5477', 'MZ2406'],
    startDate: '2026-07-28',
    endDate: '2026-07-28',
    clock: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 6, 29, 0, 0, tick++));
    })(),
    openSession: async ({ storeCode, allowSavedCredentialLogin }) => {
      activeSessions += 1;
      assert.equal(activeSessions, 1);
      sessionOptions.push({ storeCode, allowSavedCredentialLogin });
      events.push(`open:${storeCode}`);
      return {
        storeCode,
        evaluate() {},
        async close() {
          events.push(`close:${storeCode}`);
          activeSessions -= 1;
        },
      };
    },
    transportFactory: ({ session }) => async (endpointCode, request) => {
      events.push(`${session.storeCode}:${endpointCode}`);
      if (endpointCode === 'STORE_DAILY_HISTORY') {
        return response({
          code: '0',
          info: [{
            dataDate: '20260728',
            saleCnt1d: session.storeCode === 'DL5477' ? '4' : '7',
          }],
        });
      }
      if (endpointCode === 'ANALYSE_MODEL' && request.dimension.dimensionType === 'product') {
        return response({ code: '0', info: { status: false, errorMsg: 'private platform detail' } });
      }
      if (endpointCode === 'ANALYSE_MODEL') {
        return response({ code: '0', info: { status: true, errorMsg: null } });
      }
      return response({
        code: '0',
        info: {
          analyseResult: {
            data: [{
              reportDate: '2026-07-28',
              flow: { exposeUv: '10' },
              trade: { payOrderCnt: '2', saleCnt: '3' },
            }],
            meta: { count: 1 },
          },
        },
      });
    },
    repository: {
      async recordFetchAudit(entry) {
        audits.push(entry);
      },
      async upsertStoreDaily(rows) {
        storeRows.push(...rows);
      },
      async upsertProducts(rows) {
        productRows.push(...rows);
      },
      async upsertRegions() {},
      async successfulDailyDates() {
        return new Set();
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(activeSessions, 0);
  assert.deepEqual(sessionOptions, [
    { storeCode: 'DL5477', allowSavedCredentialLogin: true },
    { storeCode: 'MZ2406', allowSavedCredentialLogin: true },
  ]);
  assert.deepEqual(events.filter((item) => item.startsWith('open:') || item.startsWith('close:')), [
    'open:DL5477',
    'close:DL5477',
    'open:MZ2406',
    'close:MZ2406',
  ]);
  assert.equal(storeRows.filter((row) => row.sourceCode === 'WEBAPI_INDEX').length, 2);
  assert.equal(storeRows.filter((row) => row.sourceCode === 'WEBAPI_ANALYSE').length, 2);
  assert.equal(storeRows.filter((row) => row.sourceCodes?.includes('WEBAPI_ANALYSE')).length, 2);
  assert.equal(productRows.length, 0);
  assert.equal(
    audits.filter((entry) => entry.sanitizedErrorCode === 'HOME_ANALYSE_MODEL_REJECTED').length,
    2,
  );
  assert.equal(events.filter((item) => item.endsWith(':TRADE_OVERVIEW')).length, 2);
  assert.equal(events.filter((item) => item.endsWith(':REGION_RANK')).length, 2);
  assert.ok(audits.every((entry) => !JSON.stringify(entry).includes('private platform detail')));
});

test('homepage history sync resumes successful daily trade and region requests', async () => {
  const events = [];
  const storeRows = [];
  const regionRows = [];
  let activeDailyRequests = 0;
  let maximumDailyRequests = 0;
  const result = await runFullHomeHistorySync({
    storeCodes: ['DL5477'],
    startDate: '2026-07-28',
    endDate: '2026-07-30',
    includeProducts: false,
    openSession: async () => ({
      evaluate() {},
      async close() {},
    }),
    transportFactory: () => async (endpointCode, request) => {
      events.push(`${endpointCode}:${request.startDate ?? request.startDt ?? request.time?.startDate}`);
      if (['TRADE_OVERVIEW', 'REGION_RANK'].includes(endpointCode)) {
        activeDailyRequests += 1;
        maximumDailyRequests = Math.max(maximumDailyRequests, activeDailyRequests);
        await new Promise((resolve) => setImmediate(resolve));
        activeDailyRequests -= 1;
      }
      if (endpointCode === 'STORE_DAILY_HISTORY') {
        return response({
          code: '0',
          info: [
            { dataDate: '20260728', saleCnt1d: '4' },
            { dataDate: '20260729', saleCnt1d: '5' },
          ],
        });
      }
      if (endpointCode === 'ANALYSE_MODEL') {
        return response({ code: '0', info: { status: true } });
      }
      if (endpointCode === 'ANALYSE_SEARCH') {
        return response({
          code: '0',
          info: { analyseResult: { data: [], meta: { count: 0 } } },
        });
      }
      if (endpointCode === 'TRADE_OVERVIEW') {
        return response({
          code: '0',
          info: {
            sales: { newUser: '2' },
            payOrder: { newUser: '1', cnt: '3' },
          },
        });
      }
      return response({
        code: '0',
        info: {
          countryTrade: [{
            key: 'SA',
            name: 'Saudi Arabia',
            saleCnt: '5',
            saleRate: '50',
          }],
        },
      });
    },
    repository: {
      async recordFetchAudit() {},
      async upsertStoreDaily(rows) {
        storeRows.push(...rows);
      },
      async upsertProducts() {},
      async upsertRegions(rows) {
        regionRows.push(...rows);
      },
      async successfulDailyDates({ endpointCode }) {
        return endpointCode === 'TRADE_OVERVIEW'
          ? new Set(['2026-07-28'])
          : new Set(['2026-07-29']);
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.deepEqual(
    events.filter((item) => item.startsWith('TRADE_OVERVIEW')),
    ['TRADE_OVERVIEW:20260729', 'TRADE_OVERVIEW:20260730'],
  );
  assert.deepEqual(
    events.filter((item) => item.startsWith('REGION_RANK')),
    ['REGION_RANK:20260728', 'REGION_RANK:20260730'],
  );
  assert.equal(storeRows.filter((row) => row.sourceCode === 'WEBAPI_TRADE').length, 2);
  assert.equal(regionRows.length, 2);
  assert.equal(result.results[0].tradeDaily.skipped, 1);
  assert.equal(result.results[0].regionDaily.skipped, 1);
  assert.equal(maximumDailyRequests, 2);
});

test('current-day sync aggregates only additive hourly realtime metrics', async () => {
  const audits = [];
  const storeRows = [];
  const endpoints = [];
  const merged = mergeRealtimeStoreRows([
    {
      storeCode: 'DL5477',
      businessDate: '2026-08-02',
      dealAmount: 10,
      netDealAmount: 8,
      salesQuantity: 1,
      buyerCount: 1,
      goodsDetailVisitors: 20,
      stockingOrderCount: 0,
      urgentPurchaseOrderCount: 1,
    },
    {
      storeCode: 'DL5477',
      businessDate: '2026-08-02',
      dealAmount: 25,
      netDealAmount: 20,
      salesQuantity: 2,
      buyerCount: 2,
      goodsDetailVisitors: 30,
      stockingOrderCount: 1,
      urgentPurchaseOrderCount: 0,
    },
  ], {
    storeCode: 'DL5477',
    businessDate: '2026-08-02',
    observedAt: '2026-08-02T13:00:00.000Z',
  });
  assert.deepEqual({
    dealAmount: merged.dealAmount,
    netDealAmount: merged.netDealAmount,
    salesQuantity: merged.salesQuantity,
    buyerCount: merged.buyerCount,
    goodsDetailVisitors: merged.goodsDetailVisitors,
    stockingOrderCount: merged.stockingOrderCount,
    urgentPurchaseOrderCount: merged.urgentPurchaseOrderCount,
  }, {
    dealAmount: 35,
    netDealAmount: 28,
    salesQuantity: 3,
    buyerCount: null,
    goodsDetailVisitors: null,
    stockingOrderCount: 1,
    urgentPurchaseOrderCount: 1,
  });

  const result = await runFullHomeHistorySync({
    storeCodes: ['DL5477'],
    startDate: '2026-08-02',
    endDate: '2026-08-02',
    includeProducts: false,
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
    openSession: async () => ({ async close() {} }),
    transportFactory: () => async (endpointCode) => {
      endpoints.push(endpointCode);
      if (endpointCode === 'STORE_DAILY_HISTORY') {
        return response({ code: '0', info: [] });
      }
      if (endpointCode === 'STORE_REALTIME') {
        return response({
          code: '0',
          info: [
            {
              dealAmtH: '10',
              netDealAmtH: '8',
              saleCntH: '1',
              buyerCntH: '1',
              shopGoodsUvH: '20',
              bhOrdCntH: '0',
              jcOrdCntH: '1',
            },
            {
              dealAmtH: '25',
              netDealAmtH: '20',
              saleCntH: '2',
              buyerCntH: '2',
              shopGoodsUvH: '30',
              bhOrdCntH: '1',
              jcOrdCntH: '0',
            },
          ],
        });
      }
      if (endpointCode === 'ANALYSE_MODEL') {
        return response({ code: '0', info: { status: true } });
      }
      if (endpointCode === 'ANALYSE_SEARCH') {
        return response({
          code: '0',
          info: { analyseResult: { data: [], meta: { count: 0 } } },
        });
      }
      if (endpointCode === 'TRADE_OVERVIEW') {
        return response({ code: '0', info: {} });
      }
      return response({ code: '0', info: { countryTrade: [] } });
    },
    repository: {
      async recordFetchAudit(entry) {
        audits.push(entry);
      },
      async upsertStoreDaily(rows) {
        storeRows.push(...rows);
      },
      async upsertProducts() {},
      async upsertRegions() {},
      async successfulDailyDates() {
        return new Set();
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(endpoints.filter((code) => code === 'STORE_REALTIME').length, 1);
  assert.equal(endpoints.filter((code) => code === 'STORE_DAILY_HISTORY').length, 0);
  assert.equal(result.windowCount, 0);
  const realtime = storeRows.find(({ sourceCode }) => sourceCode === 'WEBAPI_REALTIME');
  assert.equal(realtime.dealAmount, 35);
  assert.equal(realtime.salesQuantity, 3);
  assert.equal(realtime.buyerCount, null);
  assert.equal(realtime.goodsDetailVisitors, null);
  const audit = audits.find(({ endpointCode }) => endpointCode === 'STORE_REALTIME');
  assert.equal(audit.acceptedRowCount, 2);
  assert.deepEqual(result.results[0].realtime.payload, {
    hourlyRows: 2,
    factRows: 1,
    uniqueVisitorMetrics: 'UNAVAILABLE',
  });
});

test('a range ending today anchors settled endpoints to yesterday', async () => {
  const requests = [];
  const result = await runFullHomeHistorySync({
    storeCodes: ['DL5477'],
    startDate: '2026-08-01',
    endDate: '2026-08-02',
    includeProducts: false,
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
    openSession: async () => ({ async close() {} }),
    transportFactory: () => async (endpointCode, request) => {
      requests.push({ endpointCode, request });
      if (endpointCode === 'STORE_DAILY_HISTORY') {
        return response({
          code: '0',
          info: [{
            dataDate: '2026-08-01',
            dealAmt1d: '1498.37',
            saleCnt1d: '35',
          }],
        });
      }
      if (endpointCode === 'STORE_REALTIME') {
        return response({
          code: '0',
          info: [{
            dealAmtH: '10',
            netDealAmtH: '8',
            saleCntH: '1',
            bhOrdCntH: '0',
            jcOrdCntH: '0',
          }],
        });
      }
      if (endpointCode === 'ANALYSE_MODEL') {
        return response({ code: '0', info: { status: true } });
      }
      if (endpointCode === 'ANALYSE_SEARCH') {
        return response({
          code: '0',
          info: { analyseResult: { data: [], meta: { count: 0 } } },
        });
      }
      if (endpointCode === 'TRADE_OVERVIEW') {
        return response({ code: '0', info: {} });
      }
      return response({ code: '0', info: { countryTrade: [] } });
    },
    repository: {
      async recordFetchAudit() {},
      async upsertStoreDaily() {},
      async upsertProducts() {},
      async upsertRegions() {},
      async successfulDailyDates() {
        return new Set();
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.windowCount, 1);
  const historical = requests.find(({ endpointCode }) => (
    endpointCode === 'STORE_DAILY_HISTORY'
  )).request;
  assert.equal(historical.startDate, '2026-08-01');
  assert.equal(historical.endDate, '2026-08-01');
  assert.equal(historical.dt, '20260801');
  assert.equal(requests.filter(({ endpointCode }) => (
    endpointCode === 'STORE_REALTIME'
  )).length, 1);
});
