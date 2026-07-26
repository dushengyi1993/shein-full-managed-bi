import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchFullManagedStockAdvice } from '../../src/openapi/stock-advice.mjs';

function goods(suffix) {
  return {
    skc: `SKC-${suffix}`,
    spuName: `SPU-${suffix}`,
    supplierCode: `MODEL-${suffix}`,
    shelfDays: 1,
    supplyStatus: { type: 'success', name: '正常供货', value: 7 },
    shelfStatus: { type: 'success', name: '已上架', value: 1 },
    skuList: [{
      skuCode: `SKU-${suffix}`,
      predictDaySales: 2,
      orderCnt: 1,
      totalSaleVolume: 10,
      c7dSaleCnt: 5,
      c30dSaleCnt: 10,
      stayDeliver: 1,
      stayShelf: 0,
      transit: 2,
      stock: 3,
      transitSale: 0,
      preemptionNum: 0,
      planUrgentCount: 0,
      adviceOrderCount: 4,
      orderCount: 1,
      stockSaleDays: 1.5,
      saleDays: 8,
      stockDays: 2,
      price: '9.90',
      currencySymbol: 'USD',
    }, {
      skuCode: '合计',
      stock: 3,
    }],
  };
}

test('stock-goods-list honors pageSize<=20, fully paginates and removes summary rows', async () => {
  const calls = [];
  const client = {
    async request(_path, { body }) {
      calls.push(body);
      return {
        data: {
          code: '0',
          info: {
            count: 2,
            list: body.pageNum <= 2 ? [goods(body.pageNum)] : [],
          },
        },
      };
    },
  };
  const result = await fetchFullManagedStockAdvice(client, {
    pageSize: 1,
    fetchedAt: '2026-07-26T12:00:00Z',
  });
  assert.deepEqual(calls.map(({ pageNum }) => pageNum), [1, 2, 3]);
  assert.equal(result.goods.length, 2);
  assert.equal(result.advice.length, 2);
  assert.equal(result.advice[0].skuCode, 'SKU-1');
  assert.equal(result.advice[0].productStatuses.supplyStatus.code, '7');
  assert.equal(result.advice[0].productStatuses.stockWarningStatus.observed, false);
});

test('stock-goods-list rejects page sizes over the official maximum', async () => {
  await assert.rejects(
    () => fetchFullManagedStockAdvice({ request() {} }, { pageSize: 21 }),
    /from 1 to 20/,
  );
});

test('stock warnings are known only for explicit normal or warning semantics', async () => {
  async function classify(stockWarnStatus) {
    const client = {
      async request() {
        return {
          data: {
            code: '0',
            info: {
              count: 1,
              list: [{ ...goods('X'), stockWarnStatus }],
            },
          },
        };
      },
    };
    const result = await fetchFullManagedStockAdvice(client);
    return result.advice[0].productStatuses.stockWarningStatus;
  }

  assert.deepEqual(
    {
      observed: (await classify({ type: 'success', value: 0 })).observed,
      isWarning: (await classify({ type: 'success', value: 0 })).isWarning,
    },
    { observed: true, isWarning: false },
  );
  assert.deepEqual(
    {
      observed: (await classify({ type: 'warning', value: 1 })).observed,
      isWarning: (await classify({ type: 'warning', value: 1 })).isWarning,
    },
    { observed: true, isWarning: true },
  );
  const unknown = await classify({ type: 'future-status', value: 9 });
  assert.equal(unknown.observed, false);
  assert.equal(unknown.isWarning, null);
  assert.equal(unknown.code, '9');
  const empty = await classify({});
  assert.equal(empty.observed, false);
  assert.equal(empty.isWarning, null);
});

test('stock advice preserves production decimal daily-sales forecasts', async () => {
  const client = {
    async request() {
      return {
        data: {
          code: '0',
          info: {
            count: 1,
            list: [{
              ...goods('DECIMAL'),
              skuList: [{
                ...goods('DECIMAL').skuList[0],
                predictDaySales: 0.125,
              }],
            }],
          },
        },
      };
    },
  };

  const result = await fetchFullManagedStockAdvice(client);
  assert.equal(result.advice[0].predictedDailySales, 0.125);
});

test('stock advice still rejects decimal actual unit counts', async () => {
  const client = {
    async request() {
      return {
        data: {
          code: '0',
          info: {
            count: 1,
            list: [{
              ...goods('COUNT'),
              skuList: [{
                ...goods('COUNT').skuList[0],
                predictDaySales: 0.125,
                stock: 1.5,
              }],
            }],
          },
        },
      };
    },
  };

  await assert.rejects(
    () => fetchFullManagedStockAdvice(client),
    /stock must be a non-negative integer/,
  );
});
