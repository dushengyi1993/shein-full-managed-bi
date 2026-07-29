import assert from 'node:assert/strict';
import test from 'node:test';

import { createFinanceHomeRepository } from '../../src/warehouse/finance-home-repository.mjs';

function runtime() {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    release() {},
  };
  return {
    calls,
    repository: createFinanceHomeRepository({
      pool: { async connect() { return client; } },
    }),
  };
}

test('finance repository replaces only its bounded derived window and hashes price evidence', async () => {
  const { calls, repository } = runtime();
  const loaded = await repository.replaceWindow({
    storeCode: 'DL5477',
    startDate: '2026-07-23',
    endDate: '2026-07-29',
    observedAt: '2026-07-29T08:00:00.000Z',
    completedAt: '2026-07-29T08:01:00.000Z',
    reports: [{
      addTime: '2026-07-28T01:00:00.000Z',
      currency: 'SAR',
    }],
    details: [{
      businessDate: '2026-07-28',
      observedBusinessAt: '2026-07-28T02:00:00.000Z',
      currency: 'SAR',
      direction: 'IN',
      amount: 25,
      goodsCount: 2,
      unitPrice: 12.5,
      secondOrderType: '1',
      productKey: 'SUP-1',
      platformSkuId: 'SKU-1',
      platformSkcId: 'SKC-1',
      supplierSku: 'SUP-1',
      reportOrderNoHash: 'a'.repeat(64),
      detailRowKeyHash: 'b'.repeat(64),
    }],
  });

  assert.deepEqual(loaded, {
    financeDailyRows: 1,
    productFinanceRows: 1,
    priceObservations: 1,
  });
  assert.ok(calls.some(({ sql }) => /SET LOCAL ROLE sheinfm_sales_loader/.test(sql)));
  const deletes = calls.filter(({ sql }) => /DELETE FROM fact\.full_home/.test(sql));
  assert.equal(deletes.length, 2);
  assert.ok(deletes.every(({ params }) => (
    params[0] === 'DL5477'
    && params[1] === '2026-07-23'
    && params[2] === '2026-07-29'
  )));
  const price = calls.find(({ sql }) => /INSERT INTO fact\.full_product_price_observation/.test(sql));
  assert.equal(price.params[0].length, 64);
  assert.doesNotMatch(JSON.stringify(calls), /REPORT-SECRET|DETAIL-SECRET/);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('finance repository persists only a sanitized failed-window code', async () => {
  const { calls, repository } = runtime();
  await repository.recordFailure({
    storeCode: 'MZ2406',
    startDate: '2026-07-23',
    endDate: '2026-07-29',
    observedAt: '2026-07-29T08:00:00.000Z',
    completedAt: '2026-07-29T08:00:01.000Z',
    sanitizedErrorCode: 'PLATFORM_ERROR',
  });
  const failure = calls.find(({ sql }) => /result_status[\s\S]*'FAILED'/.test(sql));
  assert.ok(failure);
  assert.equal(failure.params.at(-1), 'PLATFORM_ERROR');
  assert.equal(calls.at(-1).sql, 'COMMIT');
});
