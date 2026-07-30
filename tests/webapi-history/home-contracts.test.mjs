import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnalyseSearchRequest,
  buildProductDailyRequest,
  buildRegionRankRequest,
  buildStoreDailyHistoryRequest,
  buildTradeOverviewRequest,
  historyWindows,
  parseProductDailyRows,
  parseShopAnalysisRows,
  parseStoreDailyHistory,
  parseTradeOverview,
} from '../../src/webapi-history/home-contracts.mjs';

test('history windows are contiguous and never exceed the official 90-day bound', () => {
  const windows = historyWindows({
    startDate: '2023-06-07',
    endDate: '2024-01-10',
  });
  assert.deepEqual(windows, [
    { startDate: '2023-06-07', endDate: '2023-09-04' },
    { startDate: '2023-09-05', endDate: '2023-12-03' },
    { startDate: '2023-12-04', endDate: '2024-01-10' },
  ]);
});

test('store history request is fixed to the full-managed all-site contract', () => {
  assert.deepEqual(buildStoreDailyHistoryRequest({
    startDate: '2026-07-01',
    endDate: '2026-07-29',
  }), {
    areaCd: 'cn',
    dt: '20260729',
    countrySite: ['shein-all'],
    startDate: '2026-07-01',
    endDate: '2026-07-29',
    queryType: 1,
    pageNum: 1,
    pageSize: 1000,
  });
  assert.throws(
    () => buildStoreDailyHistoryRequest({
      startDate: '2026-01-01',
      endDate: '2026-07-29',
    }),
    { code: 'HOME_DATE_RANGE_INVALID' },
  );
});

test('trade and region requests match the live management-analysis contracts', () => {
  assert.deepEqual(buildTradeOverviewRequest({
    startDate: '2026-07-28',
    endDate: '2026-07-28',
  }), {
    areaCd: 'cn',
    dt: '20260728',
    countrySite: ['shein-all'],
    startDt: '20260728',
    endDt: '20260728',
    dtFlag: 1,
  });
  assert.deepEqual(buildRegionRankRequest({
    startDate: '2026-07-28',
    endDate: '2026-07-28',
  }), {
    areaCd: 'cn',
    dt: '20260728',
    countrySite: ['shein-all'],
    startDt: '20260728',
    endDt: '20260728',
    statType: 2,
  });
});

test('historical store rows preserve unavailable values as null instead of zero', () => {
  const rows = parseStoreDailyHistory([
    {
      dataDate: '20260728',
      dealAmt1d: '1200.50',
      netDealAmt1d: '-',
      saleCnt1d: '42',
      idxBuyerCnt1d: null,
      idxShopGoodsUv1d: '510',
      bhOrdCnt1d: '7',
      jcOrdCnt1d: '2',
    },
  ], { storeCode: 'DL5477', observedAt: '2026-07-29T05:00:00.000Z' });
  assert.deepEqual(rows, [{
    storeCode: 'DL5477',
    businessDate: '2026-07-28',
    currency: null,
    dealAmount: 1200.5,
    netDealAmount: null,
    salesQuantity: 42,
    buyerCount: null,
    goodsDetailVisitors: 510,
    stockingOrderCount: 7,
    urgentPurchaseOrderCount: 2,
    sourceUpdatedAt: null,
    observedAt: '2026-07-29T05:00:00.000Z',
    sourceCode: 'WEBAPI_INDEX',
  }]);
});

test('shop analysis sums brand rows while naming the non-deduplicated exposure basis', () => {
  const rows = parseShopAnalysisRows({
    analyseResult: {
      data: [
        {
          reportDate: '2026-07-28',
          flow: { exposeUv: '100' },
          trade: { payOrderCnt: '4', saleCnt: '5' },
        },
        {
          reportDate: '2026-07-28',
          flow: { exposeUv: '80' },
          trade: { payOrderCnt: '3', saleCnt: '6' },
        },
      ],
    },
  }, { storeCode: 'MZ2406' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exposureUsers, 180);
  assert.equal(rows[0].exposureBasis, 'BRAND_SUMMED');
  assert.equal(rows[0].paymentOrderCount, 7);
  assert.equal(rows[0].salesQuantity, 11);
});

test('product analysis keeps daily store-local grain and no invented amount', () => {
  const request = buildProductDailyRequest({
    startDate: '2026-07-01',
    endDate: '2026-07-29',
    grain: 'SKC',
  });
  assert.equal(request.dimension.dimensionSub, 'SKC');
  assert.deepEqual(request.range.skuCate4Id, []);
  assert.deepEqual(buildAnalyseSearchRequest({ pageNum: 2 }), {
    pageNum: 2,
    pageSize: 200,
  });

  const rows = parseProductDailyRows({
    analyseResult: {
      data: [{
        reportDate: '2026-07-28',
        goods: { goodsSn: 'SKC-11', goodsName: 'Coffee maker' },
        trade: { saleCnt: '12', gmv: '-' },
      }],
    },
  }, { storeCode: 'DL5477', grain: 'SKC' });
  assert.deepEqual(rows[0], {
    storeCode: 'DL5477',
    businessDate: '2026-07-28',
    productGrain: 'SKC',
    productKey: 'SKC-11',
    platformSpuId: null,
    platformSkcId: 'SKC-11',
    supplierCode: null,
    supplierSku: null,
    displayName: 'Coffee maker',
    salesQuantity: 12,
    observedAt: rows[0].observedAt,
    sourceUpdatedAt: null,
  });
  assert.equal(Object.hasOwn(rows[0], 'estimatedDealAmount'), false);
});

test('trade overview maps new-customer quantities without treating missing as zero', () => {
  const row = parseTradeOverview({
    data: {
      sales: { cnt: 100, newUser: 34 },
      payOrder: { cnt: 77, newUser: null },
    },
  }, {
    storeCode: 'DL5477',
    businessDate: '2026-07-28',
  });
  assert.equal(row.newCustomerSalesQuantity, 34);
  assert.equal(row.paymentOrderCount, 77);
  assert.equal(row.newCustomerPaymentOrderCount, null);
});
