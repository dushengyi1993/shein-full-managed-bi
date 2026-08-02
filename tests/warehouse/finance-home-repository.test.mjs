import assert from 'node:assert/strict';
import test from 'node:test';

import { createFinanceHomeRepository } from '../../src/warehouse/finance-home-repository.mjs';

function runtime() {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO fact\.full_home_finance_daily/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO fact\.full_home_product_finance_daily/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO fact\.full_home_bill_daily/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
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
      reportOrderNoHash: 'a'.repeat(64),
      addTime: '2026-07-28T01:00:00.000Z',
      currency: 'SAR',
      expectedSettlementAmount: 22,
      settlementStatus: 2,
      completedPayAt: null,
      estimatedPayAt: '2026-08-15T16:00:00.000Z',
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
    adjustments: [{
      currency: 'SAR',
      direction: 'DEDUCTION',
      amount: 3,
      goodsCount: 1,
      category: '物流扣款',
      productKey: 'SUP-1',
      platformSkuId: 'SKU-1',
      platformSkcId: 'SKC-1',
      supplierSku: 'SUP-1',
      unitPrice: 3,
      reportOrderNoHash: 'a'.repeat(64),
      detailRowKeyHash: 'c'.repeat(64),
    }],
  });

  assert.deepEqual(loaded, {
    financeDailyRows: 1,
    productFinanceRows: 1,
    billDailyRows: 1,
    priceObservations: 1,
  });
  assert.ok(calls.some(({ sql }) => /SET LOCAL ROLE sheinfm_sales_loader/.test(sql)));
  const observationDelete = calls.find(
    ({ sql }) => /DELETE FROM fact\.full_home_finance_detail_observation/.test(sql),
  );
  assert.deepEqual(observationDelete.params, [
    'DL5477',
    '2026-07-23',
    '2026-07-29',
  ]);
  const observationInsert = calls.find(
    ({ sql }) => /INSERT INTO fact\.full_home_finance_detail_observation/.test(sql),
  );
  const observationPayload = JSON.parse(observationInsert.params[0]);
  assert.equal(observationPayload[0].observation_key.length, 64);
  assert.equal(observationPayload[0].report_generated_date, '2026-07-28');
  assert.ok(calls.some(
    ({ sql }) => /FROM fact\.full_home_finance_detail_observation[\s\S]*GROUP BY store_code, business_date, currency/.test(sql),
  ));
  const price = calls.find(({ sql }) => /INSERT INTO fact\.full_product_price_observation/.test(sql));
  assert.equal(JSON.parse(price.params[0])[0].observation_key.length, 64);
  const adjustment = calls.find(
    ({ sql }) => /INSERT INTO fact\.full_home_finance_adjustment_observation/.test(sql),
  );
  assert.equal(JSON.parse(adjustment.params[0])[0].direction, 'DEDUCTION');
  assert.ok(calls.some(
    ({ sql }) => /INSERT INTO fact\.full_home_bill_daily/.test(sql),
  ));
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

test('finance repository rejects a detail that is not tied to the fetched report set', async () => {
  const { repository } = runtime();
  await assert.rejects(
    repository.replaceWindow({
      storeCode: 'DL5477',
      startDate: '2026-07-23',
      endDate: '2026-07-29',
      observedAt: '2026-07-29T08:00:00.000Z',
      completedAt: '2026-07-29T08:01:00.000Z',
      reports: [],
      details: [{
        reportOrderNoHash: 'a'.repeat(64),
        detailRowKeyHash: 'b'.repeat(64),
      }],
    }),
    /unknown report/,
  );
});
