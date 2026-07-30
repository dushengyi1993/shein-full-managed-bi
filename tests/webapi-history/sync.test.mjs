import assert from 'node:assert/strict';
import test from 'node:test';

import { runFullHomeHistorySync } from '../../src/webapi-history/sync.mjs';

function response(body) {
  return { httpStatus: 200, byteLength: JSON.stringify(body).length, body };
}

test('homepage history sync processes one Profile at a time and preserves partial product failure', async () => {
  const events = [];
  const audits = [];
  const storeRows = [];
  const productRows = [];
  let activeSessions = 0;
  const result = await runFullHomeHistorySync({
    storeCodes: ['DL5477', 'MZ2406'],
    startDate: '2026-07-28',
    endDate: '2026-07-28',
    clock: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 6, 29, 0, 0, tick++));
    })(),
    openSession: async ({ storeCode }) => {
      activeSessions += 1;
      assert.equal(activeSessions, 1);
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
