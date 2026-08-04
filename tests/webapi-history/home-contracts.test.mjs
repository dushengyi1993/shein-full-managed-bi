import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnalyseSearchRequest,
  buildIndexUpdateTimeRequest,
  buildLedgerDailyRequest,
  buildProductDailyRequest,
  buildProductDiagnoseListRequest,
  buildRealtimeRequest,
  buildRealtimeUpdateTimeRequest,
  buildRegionRankRequest,
  buildStoreDailyHistoryRequest,
  buildTradeOverviewRequest,
  historyWindows,
  parseIndexUpdateTime,
  parseProductDiagnosePage,
  parseProductDailyRows,
  parseRealtimeStoreSummary,
  parseRealtimeUpdateTime,
  parseLedgerDailyRows,
  parseShopAnalysisRows,
  parseStoreDailyHistory,
  parseTradeOverview,
} from '../../src/webapi-history/home-contracts.mjs';

test('ledger daily contract keeps customer shipment separate from total outbound', () => {
  assert.deepEqual(buildLedgerDailyRequest({
    startDate: '2026-08-01',
    endDate: '2026-08-02',
  }), {
    reportDateStart: '2026-08-01',
    reportDateEnd: '2026-08-02',
    pageNumber: 1,
    pageSize: 200,
  });
  const parsed = parseLedgerDailyRows({
    code: '0',
    info: {
      containAmount: 1,
      data: {
        count: 1,
        list: [{
          reportDate: '2026-08-01',
          beginBalanceCnt: 5247,
          inCnt: 521,
          outCnt: 546,
          endBalanceCnt: 5222,
          totalCustomerCnt: 521,
          customerCnt: 436,
          platformCustomerCnt: 85,
          outSupplierCnt: 25,
          beginBalanceAmount: 215645.94,
          inAmount: 16914.6,
          outAmount: 17533.47,
          endBalanceAmount: 212213.16,
          totalCustomerAmount: 16666.27,
        }],
      },
    },
  }, {
    storeCode: 'MZ2406',
    observedAt: '2026-08-02T10:00:00.000Z',
  });
  assert.equal(parsed.count, 1);
  assert.equal(parsed.rows[0].outboundCount, 546);
  assert.equal(parsed.rows[0].customerOutboundCount, 521);
  assert.equal(parsed.rows[0].supplierOutboundCount, 25);
  assert.equal(parsed.rows[0].customerOutboundAmount, 16666.27);
  assert.equal(parsed.rows[0].currency, null);
});

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

test('index update time pins the official data-version anchor', () => {
  assert.deepEqual(buildIndexUpdateTimeRequest(), {
    pageCode: 'Index',
    areaCd: 'cn',
  });
  assert.deepEqual(parseIndexUpdateTime({
    code: '0',
    info: {
      pageNm: '首页概览',
      areaCd: 'cn',
      dt: '20260801',
      updateTime: '2026-08-02 05:44:33',
    },
  }), {
    dataAnchorDate: '2026-08-01',
    sourceUpdatedAt: '2026-08-02 05:44:33',
  });
  assert.throws(
    () => parseIndexUpdateTime({ info: { areaCd: 'cn', dt: '' } }),
    { code: 'HOME_UPDATE_TIME_INVALID' },
  );
});

test('realtime summary uses the official data-through hour and preserves daily UVs', () => {
  assert.deepEqual(buildRealtimeUpdateTimeRequest(), {
    pageCode: 'IndexRealTime',
    areaCd: 'cn',
  });
  const anchor = parseRealtimeUpdateTime({
    code: '0',
    info: {
      pageNm: '首页概览实时模块',
      areaCd: 'cn',
      dt: '2026080416',
      updateTime: '2026-08-04 17:27:54',
    },
  });
  assert.deepEqual(anchor, {
    businessDate: '2026-08-04',
    startHour: '2026080400',
    endHour: '2026080416',
    sourceUpdatedAt: '2026-08-04T16:00:00+08:00',
    providerRefreshedAt: '2026-08-04 17:27:54',
  });
  assert.deepEqual(buildRealtimeRequest({
    startHour: anchor.startHour,
    endHour: anchor.endHour,
    observedDate: anchor.businessDate,
  }), {
    areaCd: 'cn',
    dt: '20260804',
    countrySite: ['shein-all'],
    scene: '1',
    startDt: '2026080400',
    endDt: '2026080416',
  });
  assert.deepEqual(parseRealtimeStoreSummary({
    code: '0',
    info: {
      dealAmtH: 16093.52,
      netDealAmtH: 15885.77,
      saleCntH: 451,
      shopGoodsUvH: 31676,
      buyerCntH: 339,
      bhOrdCntH: 9,
      jcOrdCntH: 0,
    },
  }, {
    storeCode: 'MZ2406',
    businessDate: anchor.businessDate,
    sourceUpdatedAt: anchor.sourceUpdatedAt,
    observedAt: '2026-08-04T09:30:00.000Z',
  }), {
    storeCode: 'MZ2406',
    businessDate: '2026-08-04',
    currency: null,
    dealAmount: 16093.52,
    netDealAmount: 15885.77,
    salesQuantity: 451,
    buyerCount: 339,
    goodsDetailVisitors: 31676,
    stockingOrderCount: 9,
    urgentPurchaseOrderCount: 0,
    sourceUpdatedAt: '2026-08-04T16:00:00+08:00',
    observedAt: '2026-08-04T09:30:00.000Z',
    sourceCode: 'WEBAPI_REALTIME',
  });
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

test('current product diagnose contract keeps one-day SPU facts and drops catalogue zero rows', () => {
  assert.deepEqual(buildProductDiagnoseListRequest({
    businessDate: '2026-07-31',
    observedDate: '2026-08-01',
    pageNum: 2,
  }), {
    areaCd: 'cn',
    dt: '20260801',
    countrySite: ['shein-all'],
    startDate: '20260731',
    endDate: '20260731',
    pageNum: 2,
    pageSize: 200,
    groupType: 'total',
    orderList: 'c1dSaleCnt',
    orderType: 'desc',
  });
  const page = parseProductDiagnosePage({
    code: '0',
    info: {
      data: [
        {
          spu: 'v2607071423828016',
          goodsName: '迷你电煮锅',
          c1dSaleCnt: '12',
          c1dSaleAmt: null,
          dataDate: null,
        },
        {
          spu: 'v2607071423828999',
          goodsName: '零销量商品',
          c1dSaleCnt: 0,
        },
      ],
      meta: { count: 378 },
    },
  }, {
    storeCode: 'DL5477',
    businessDate: '2026-07-31',
    observedAt: '2026-08-01T13:00:00.000Z',
  });
  assert.equal(page.count, 378);
  assert.equal(page.sourceRowCount, 2);
  assert.equal(page.lastSalesQuantity, 0);
  assert.equal(page.rows.length, 1);
  assert.deepEqual(page.rows[0], {
    storeCode: 'DL5477',
    businessDate: '2026-07-31',
    productGrain: 'SPU',
    productKey: 'v2607071423828016',
    platformSpuId: 'v2607071423828016',
    platformSkcId: null,
    supplierCode: null,
    supplierSku: null,
    displayName: '迷你电煮锅',
    salesQuantity: 12,
    observedAt: '2026-08-01T13:00:00.000Z',
    sourceUpdatedAt: null,
  });
  assert.equal(Object.hasOwn(page.rows[0], 'estimatedDealAmount'), false);
  const longName = parseProductDiagnosePage({
    info: {
      data: [{
        spu: 'SPU-LONG-NAME',
        goodsName: '超'.repeat(300),
        c1dSaleCnt: 1,
      }],
      meta: { count: 1 },
    },
  }, {
    storeCode: 'DL5477',
    businessDate: '2026-07-31',
  });
  assert.equal(longName.rows[0].displayName.length, 240);
  assert.throws(
    () => parseProductDiagnosePage({
      info: {
        data: [{ spu: 'SPU-1', c1dSaleCnt: null }],
        meta: { count: 1 },
      },
    }, {
      storeCode: 'DL5477',
      businessDate: '2026-07-31',
    }),
    { code: 'HOME_PRODUCT_SALES_UNAVAILABLE' },
  );
  assert.throws(
    () => parseProductDiagnosePage({
      info: {
        data: [
          { spu: 'SPU-1', c1dSaleCnt: 1 },
          { spu: 'SPU-2', c1dSaleCnt: 2 },
        ],
        meta: { count: 2 },
      },
    }, {
      storeCode: 'DL5477',
      businessDate: '2026-07-31',
    }),
    { code: 'HOME_PRODUCT_SORT_INVALID' },
  );
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
