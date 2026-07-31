import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HomeQueryError, queryHomeDashboard } from '../../src/server/home-query.mjs';

const dashboard = {
  updatedAt: '2026-07-31T00:00:00.000Z',
  storeRanking: [
    { code: 'DL5477', name: '地利' },
    { code: 'MZ2406', name: '妙正' },
  ],
  owners: [{ key: 'LIU', name: '刘广洪', storeCodes: ['DL5477'] }],
};

const history = {
  updatedAt: dashboard.updatedAt,
  home: {
    status: 'available',
    coverage: { earliestDate: '2026-07-01', latestDate: '2026-07-31' },
    storeDaily: [
      { storeCode: 'DL5477', date: '2026-07-30', salesQuantity: 2 },
      { storeCode: 'DL5477', date: '2026-07-31', salesQuantity: 3 },
      { storeCode: 'MZ2406', date: '2026-07-31', salesQuantity: 4 },
    ],
    productDaily: [],
    regionDaily: [],
    financeDaily: [],
    productFinanceDaily: [
      {
        storeCode: 'DL5477',
        date: '2026-07-31',
        productKey: 'SKC-1',
        supplierSku: 'DL-HOT',
        incomeAmount: 12,
        goodsCount: 3,
      },
      {
        storeCode: 'MZ2406',
        date: '2026-07-31',
        productKey: 'SKC-2',
        supplierSku: 'MZ-HOT',
        incomeAmount: 20,
        goodsCount: 4,
      },
    ],
  },
};

test('home query returns only the selected current and comparison window', () => {
  const result = queryHomeDashboard(
    dashboard,
    history,
    new URLSearchParams({
      start: '2026-07-31',
      end: '2026-07-31',
      owner: 'LIU',
      store: 'ALL',
    }),
  );
  assert.deepEqual(result.query, {
    start: '2026-07-31',
    end: '2026-07-31',
    previousStart: '2026-07-30',
    previousEnd: '2026-07-30',
    owner: 'LIU',
    store: 'ALL',
    q: '',
  });
  assert.deepEqual(result.home.storeDaily.map(({ storeCode, date }) => [storeCode, date]), [
    ['DL5477', '2026-07-30'],
    ['DL5477', '2026-07-31'],
  ]);
  assert.equal(result.home.productFinanceDaily.length, 1);
  assert.equal(result.home.productFinanceDaily[0].supplierSku, 'DL-HOT');
});

test('home query searches products without leaking another store', () => {
  const result = queryHomeDashboard(
    dashboard,
    history,
    new URLSearchParams({
      start: '2026-07-31',
      end: '2026-07-31',
      owner: 'LIU',
      store: 'ALL',
      q: 'DL-HOT',
    }),
  );
  assert.equal(result.home.productFinanceDaily.length, 1);
  assert.equal(result.home.productFinanceDaily[0].storeCode, 'DL5477');
});

test('home query rejects an unbounded range', () => {
  assert.throws(
    () => queryHomeDashboard(
      dashboard,
      history,
      new URLSearchParams({
        start: '2025-01-01',
        end: '2026-07-31',
      }),
    ),
    (error) => error instanceof HomeQueryError && error.code === 'QUERY_DATE_RANGE_TOO_LARGE',
  );
});
