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
    },
  });
  assert.equal(result.ok, true);
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
  assert.ok(audits.every((entry) => !JSON.stringify(entry).includes('private platform detail')));
});
