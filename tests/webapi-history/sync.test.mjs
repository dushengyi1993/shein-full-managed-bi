import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fullHomeHistoryRequiresRetry,
  mergeRealtimeStoreRows,
  runFullHomeHistorySync,
} from '../../src/webapi-history/sync.mjs';

function response(body) {
  return { httpStatus: 200, byteLength: JSON.stringify(body).length, body };
}

test('hourly partial batches succeed only after at least one realtime store write', () => {
  assert.equal(fullHomeHistoryRequiresRetry({
    requiresRetry: false,
    results: [],
  }, { allowPartial: true }), false);
  assert.equal(fullHomeHistoryRequiresRetry({
    requiresRetry: true,
    results: [{ realtime: { ok: true } }, { sessionErrorCode: 'CDP_COMMAND_TIMEOUT' }],
  }), true);
  assert.equal(fullHomeHistoryRequiresRetry({
    requiresRetry: true,
    results: [{ realtime: { ok: true } }, { sessionErrorCode: 'CDP_COMMAND_TIMEOUT' }],
  }, { allowPartial: true }), false);
  assert.equal(fullHomeHistoryRequiresRetry({
    requiresRetry: true,
    results: [{ sessionErrorCode: 'CDP_COMMAND_TIMEOUT' }],
  }, { allowPartial: true }), true);
});

test('homepage history sync uses the current paginated product contract and preserves partial failure', async () => {
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
      if (endpointCode === 'UPDATE_TIME') {
        return response({
          code: '0',
          info: {
            areaCd: 'cn',
            dt: '20260728',
            updateTime: '2026-07-29 05:00:00',
          },
        });
      }
      if (endpointCode === 'STORE_DAILY_HISTORY') {
        return response({
          code: '0',
          info: [{
            dataDate: '20260728',
            saleCnt1d: session.storeCode === 'DL5477' ? '4' : '7',
          }],
        });
      }
      if (endpointCode === 'PRODUCT_DIAGNOSE_LIST') {
        if (session.storeCode === 'MZ2406') {
          const error = new Error('private platform detail');
          error.code = 'HOME_PRODUCT_FETCH_FAILED';
          throw error;
        }
        return response({
          code: '0',
          info: {
            data: [{
              spu: 'SPU-11',
              goodsName: 'Coffee maker',
              c1dSaleCnt: '4',
            }],
            meta: { count: 1 },
          },
        });
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
  assert.equal(result.requiresRetry, true);
  assert.equal(result.retryablePartialWindows, 1);
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
  assert.equal(productRows.length, 1);
  assert.equal(productRows[0].productKey, 'SPU-11');
  assert.equal(
    audits.filter((entry) => entry.sanitizedErrorCode === 'HOME_PRODUCT_FETCH_FAILED').length,
    1,
  );
  assert.equal(events.filter((item) => item.endsWith(':PRODUCT_DIAGNOSE_LIST')).length, 2);
  assert.equal(events.filter((item) => item.endsWith(':TRADE_OVERVIEW')).length, 2);
  assert.equal(events.filter((item) => item.endsWith(':REGION_RANK')).length, 2);
  assert.ok(audits.every((entry) => !JSON.stringify(entry).includes('private platform detail')));
});

test('analysis permission gaps remain visible without turning a permanent capability gap into a retry loop', async () => {
  const audits = [];
  const result = await runFullHomeHistorySync({
    storeCodes: ['DL5477'],
    startDate: '2026-08-03',
    endDate: '2026-08-03',
    includeProducts: false,
    openSession: async () => ({ async close() {} }),
    transportFactory: () => async (endpointCode) => {
      if (endpointCode === 'UPDATE_TIME') {
        return response({ code: '0', info: { areaCd: 'cn', dt: '20260803' } });
      }
      if (endpointCode === 'STORE_DAILY_HISTORY') {
        return response({ code: '0', info: [{ dataDate: '20260803', saleCnt1d: '3' }] });
      }
      if (endpointCode === 'ANALYSE_MODEL') {
        throw Object.assign(new Error('private permission response'), {
          code: 'HOME_ANALYSE_PERMISSION_DENIED',
        });
      }
      if (endpointCode === 'TRADE_OVERVIEW') return response({ code: '0', info: {} });
      return response({ code: '0', info: { countryTrade: [] } });
    },
    repository: {
      async recordFetchAudit(row) {
        audits.push(row);
      },
      async upsertStoreDaily() {},
      async upsertProducts() {},
      async upsertRegions() {},
      async successfulDailyDates() {
        return new Set();
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(result.requiresRetry, false);
  assert.equal(result.partialWindows, 1);
  assert.equal(result.retryablePartialWindows, 0);
  assert.equal(result.results[0].shopDaily.terminal, true);
  assert.equal(result.results[0].shopDaily.capabilityStatus, 'PERMISSION_DENIED');
  assert.ok(audits.some(({ sanitizedErrorCode }) => (
    sanitizedErrorCode === 'HOME_ANALYSE_PERMISSION_DENIED'
  )));
});

test('history sync closes and reopens only the failed store after a retryable CDP error', async () => {
  let openCount = 0;
  let closeCount = 0;
  const result = await runFullHomeHistorySync({
    storeCodes: ['DL5477'],
    startDate: '2026-08-03',
    endDate: '2026-08-03',
    includeProducts: false,
    retryCdpCount: 1,
    openSession: async () => {
      openCount += 1;
      if (openCount === 1) {
        throw Object.assign(new Error('private timeout detail'), {
          code: 'CDP_COMMAND_TIMEOUT',
        });
      }
      return {
        async close() {
          closeCount += 1;
        },
      };
    },
    transportFactory: () => async (endpointCode) => {
      if (endpointCode === 'UPDATE_TIME') {
        return response({ code: '0', info: { areaCd: 'cn', dt: '20260803' } });
      }
      if (endpointCode === 'STORE_DAILY_HISTORY') {
        return response({ code: '0', info: [{ dataDate: '20260803' }] });
      }
      if (endpointCode === 'TRADE_OVERVIEW') return response({ code: '0', info: {} });
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
  assert.equal(openCount, 2);
  assert.equal(closeCount, 1);
  assert.equal(result.ok, true);
  assert.equal(result.requiresRetry, false);
  assert.equal(result.results[0].cdpRetryCount, 1);
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
      if (endpointCode === 'UPDATE_TIME') {
        return response({
          code: '0',
          info: {
            areaCd: 'cn',
            dt: '20260730',
            updateTime: '2026-07-31 05:00:00',
          },
        });
      }
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

test('history sync does not fan out before the first known metric availability floor', async () => {
  const endpoints = [];
  const result = await runFullHomeHistorySync({
    storeCodes: ['DL5477'],
    startDate: '2026-07-28',
    endDate: '2026-07-30',
    includeProducts: false,
    openSession: async () => ({ async close() {} }),
    transportFactory: () => async (endpointCode) => {
      endpoints.push(endpointCode);
      if (endpointCode === 'UPDATE_TIME') {
        return response({
          code: '0',
          info: { areaCd: 'cn', dt: '20260730' },
        });
      }
      if (endpointCode === 'STORE_DAILY_HISTORY') {
        return response({
          code: '0',
          info: [
            { dataDate: '20260728' },
            { dataDate: '20260729' },
            { dataDate: '20260730' },
          ],
        });
      }
      if (endpointCode === 'TRADE_OVERVIEW') {
        return response({ code: '0', info: { payOrder: { cnt: 1 } } });
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
      async historyMetricFloors() {
        return {
          tradeFloor: '2026-07-29',
          regionFloor: '2026-07-30',
        };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(endpoints.filter((code) => code === 'TRADE_OVERVIEW').length, 2);
  assert.equal(endpoints.filter((code) => code === 'REGION_RANK').length, 1);
  assert.equal(result.results[0].tradeDaily.unsupported, 1);
  assert.equal(result.results[0].regionDaily.unsupported, 2);
});

test('current-day sync aggregates only additive hourly realtime metrics', async () => {
  const audits = [];
  const storeRows = [];
  const productRows = [];
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
    clock: () => new Date('2026-08-02T13:00:00.000Z'),
    openSession: async () => ({ async close() {} }),
    transportFactory: () => async (endpointCode, request) => {
      endpoints.push(endpointCode);
      if (endpointCode === 'UPDATE_TIME') {
        if (request.pageCode === 'IndexRealTime') {
          return response({
            code: '0',
            info: {
              areaCd: 'cn',
              dt: '2026080220',
              updateTime: '2026-08-02 21:27:54',
            },
          });
        }
        return response({
          code: '0',
          info: {
            areaCd: 'cn',
            dt: '20260801',
            updateTime: '2026-08-02 05:00:00',
          },
        });
      }
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
      if (endpointCode === 'STORE_REALTIME_SUMMARY') {
        return response({
          code: '0',
          info: {
            dealAmtH: '35',
            netDealAmtH: '28',
            saleCntH: '3',
            buyerCntH: '2',
            shopGoodsUvH: '40',
            bhOrdCntH: '1',
            jcOrdCntH: '1',
          },
        });
      }
      if (endpointCode === 'PRODUCT_DIAGNOSE_LIST') {
        return response({
          code: '0',
          info: {
            data: [{
              spu: 'SPU-CURRENT',
              goodsName: 'Current product',
              c1dSaleCnt: '3',
            }],
            meta: { count: 1 },
          },
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
  assert.equal(result.complete, true);
  assert.equal(endpoints.filter((code) => code === 'STORE_REALTIME').length, 1);
  assert.equal(endpoints.filter((code) => code === 'STORE_REALTIME_SUMMARY').length, 1);
  assert.equal(endpoints.filter((code) => code === 'PRODUCT_DIAGNOSE_LIST').length, 1);
  assert.equal(endpoints.filter((code) => code === 'STORE_DAILY_HISTORY').length, 0);
  assert.equal(result.windowCount, 0);
  const realtime = storeRows.find(({ buyerCount }) => buyerCount === 2);
  assert.equal(realtime.dealAmount, 35);
  assert.equal(realtime.salesQuantity, 3);
  assert.equal(realtime.buyerCount, 2);
  assert.equal(realtime.goodsDetailVisitors, 40);
  assert.equal(realtime.sourceUpdatedAt, '2026-08-02T20:00:00+08:00');
  assert.equal(productRows.length, 1);
  assert.equal(productRows[0].businessDate, '2026-08-02');
  assert.equal(productRows[0].productKey, 'SPU-CURRENT');
  assert.equal(result.results[0].productDaily.accepted, 1);
  const audit = audits.find(({ endpointCode }) => endpointCode === 'STORE_REALTIME');
  assert.equal(audit.acceptedRowCount, 2);
  assert.deepEqual(result.results[0].realtime.payload, {
    sourceUpdatedAt: '2026-08-02T20:00:00+08:00',
    providerRefreshedAt: '2026-08-02 21:27:54',
    curve: {
      hourlyRows: 2,
      factRows: 1,
      sourceUpdatedAt: '2026-08-02T20:00:00+08:00',
    },
    summary: {
      factRows: 1,
      knownMetricCount: 7,
      sourceUpdatedAt: '2026-08-02T20:00:00+08:00',
    },
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
      if (endpointCode === 'UPDATE_TIME') {
        if (request.pageCode === 'IndexRealTime') {
          return response({
            code: '0',
            info: {
              areaCd: 'cn',
              dt: '2026080220',
              updateTime: '2026-08-02 21:27:54',
            },
          });
        }
        return response({
          code: '0',
          info: {
            areaCd: 'cn',
            dt: '20260801',
            updateTime: '2026-08-02 05:00:00',
          },
        });
      }
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
      if (endpointCode === 'STORE_REALTIME_SUMMARY') {
        return response({
          code: '0',
          info: {
            dealAmtH: '10',
            netDealAmtH: '8',
            saleCntH: '1',
            buyerCntH: '1',
            shopGoodsUvH: '20',
            bhOrdCntH: '0',
            jcOrdCntH: '0',
          },
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
  assert.equal(requests.filter(({ endpointCode }) => (
    endpointCode === 'STORE_REALTIME_SUMMARY'
  )).length, 1);
});

test('current-day product refresh waits until the provider has crossed the business date', async () => {
  const endpoints = [];
  const result = await runFullHomeHistorySync({
    storeCodes: ['DL5477'],
    startDate: '2026-08-03',
    endDate: '2026-08-03',
    clock: () => new Date('2026-08-02T16:02:00.000Z'),
    openSession: async () => ({ async close() {} }),
    transportFactory: () => async (endpointCode) => {
      endpoints.push(endpointCode);
      assert.equal(endpointCode, 'UPDATE_TIME');
      return response({
        code: '0',
        info: {
          areaCd: 'cn',
          dt: '2026080222',
          updateTime: '2026-08-02 23:00:00',
        },
      });
    },
    repository: {
      async recordFetchAudit() {},
      async upsertStoreDaily() {
        assert.fail('stale realtime must not write homepage facts');
      },
      async upsertProducts() {
        assert.fail('stale realtime must not write current-day product facts');
      },
      async upsertRegions() {},
      async successfulDailyDates() {
        return new Set();
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].realtime.payload.stale, true);
  assert.equal(result.results[0].productDaily, null);
  assert.deepEqual(endpoints, ['UPDATE_TIME']);
});

test('daily settlement stops before facts when the platform anchor is stale', async () => {
  const requests = [];
  const result = await runFullHomeHistorySync({
    storeCodes: ['DL5477'],
    startDate: '2026-08-02',
    endDate: '2026-08-02',
    includeProducts: false,
    requireSettledThrough: '2026-08-02',
    clock: () => new Date('2026-08-03T00:30:00.000Z'),
    openSession: async () => ({ async close() {} }),
    transportFactory: () => async (endpointCode) => {
      requests.push(endpointCode);
      return response({
        code: '0',
        info: {
          areaCd: 'cn',
          dt: '20260801',
          updateTime: '2026-08-02 05:00:00',
        },
      });
    },
    repository: {
      async recordFetchAudit() {},
      async upsertStoreDaily() {
        assert.fail('stale settlement must not write homepage facts');
      },
      async upsertProducts() {},
      async upsertRegions() {},
      async successfulDailyDates() {
        return new Set();
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.deepEqual(requests, ['UPDATE_TIME']);
  assert.equal(result.results[0].sessionErrorCode, 'HOME_SETTLEMENT_NOT_READY');
  assert.deepEqual(result.results[0].settlement, {
    requiredThrough: '2026-08-02',
    availableThrough: '2026-08-01',
    sourceUpdatedAt: '2026-08-02 05:00:00',
  });
});
