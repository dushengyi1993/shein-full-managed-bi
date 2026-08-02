import assert from 'node:assert/strict';
import test from 'node:test';

import { runFullHomeLedgerSync } from '../../src/webapi-history/ledger-sync.mjs';

test('ledger sync opens one store session and persists bounded daily windows', async () => {
  const calls = [];
  const persisted = [];
  const audits = [];
  const result = await runFullHomeLedgerSync({
    storeCodes: ['MZ2406'],
    startDate: '2026-07-01',
    endDate: '2026-08-02',
    clock: (() => {
      let tick = 0;
      return () => new Date(Date.parse('2026-08-02T10:00:00.000Z') + tick++ * 1000);
    })(),
    async openSession({ storeCode }) {
      calls.push({ type: 'open', storeCode });
      return {
        async evaluate() {},
        async close() {
          calls.push({ type: 'close', storeCode });
        },
      };
    },
    transportFactory() {
      return async (endpointCode, body) => {
        calls.push({ type: 'request', endpointCode, body });
        const reportDate = body.reportDateStart;
        return {
          httpStatus: 200,
          body: {
            code: '0',
            info: {
              containAmount: 1,
              data: {
                count: 1,
                list: [{
                  reportDate,
                  beginBalanceCnt: 10,
                  inCnt: 2,
                  outCnt: 3,
                  endBalanceCnt: 9,
                  totalCustomerCnt: 2,
                  beginBalanceAmount: 100,
                  inAmount: 20,
                  outAmount: 30,
                  endBalanceAmount: 90,
                }],
              },
            },
          },
        };
      };
    },
    repository: {
      async upsertLedgerDaily(rows) {
        persisted.push(...rows);
      },
      async recordFetchAudit(row) {
        audits.push(row);
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.windowCount, 2);
  assert.equal(persisted.length, 2);
  assert.equal(audits.length, 2);
  assert.ok(calls.every(
    (call) => call.type !== 'request' || call.endpointCode === 'LEDGER_DAILY',
  ));
  assert.equal(calls.filter(({ type }) => type === 'open').length, 1);
  assert.equal(calls.filter(({ type }) => type === 'close').length, 1);
});
