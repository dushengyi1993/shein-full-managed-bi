import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINANCE_HISTORY_EARLIEST_DATE,
  fetchFinanceWindow,
  financeWindows,
  mapFinanceAdjustmentDetailResponse,
  mapFinanceReportListResponse,
  mapFinanceSalesDetailResponse,
} from '../../src/openapi/finance-reports.mjs';

function response(info) {
  return { data: { code: '0', msg: 'OK', info } };
}

test('finance history is split into platform-safe seven-calendar-day windows', () => {
  assert.equal(FINANCE_HISTORY_EARLIEST_DATE, '2024-01-01');
  assert.deepEqual(financeWindows({
    startDate: '2026-07-01',
    endDate: '2026-07-15',
  }), [
    { startDate: '2026-07-01', endDate: '2026-07-07' },
    { startDate: '2026-07-08', endDate: '2026-07-14' },
    { startDate: '2026-07-15', endDate: '2026-07-15' },
  ]);
});

test('finance response mapper hashes report identifiers and keeps signed direction separate', () => {
  const reports = mapFinanceReportListResponse(response({
    count: 1,
    reportOrderInfos: [{
      reportOrderNo: 'REPORT-SECRET',
      addTime: '2026-07-28 15:30:00',
      currencyCode: 'sar',
      salesTotal: 1,
      replenishTotal: 1,
      estimateIncomeMoneyTotal: 18.5,
      settlementStatus: 2,
      estimatePayTime: '2026-08-15 00:00:00',
      completedPayTime: '',
      expenseType: 3,
    }],
  }), { page: 1, pageSize: 200 });
  assert.equal(reports.reports[0].reportOrderNoHash.length, 64);
  assert.notEqual(reports.reports[0].reportOrderNoHash, 'REPORT-SECRET');
  assert.equal(reports.reports[0].expectedSettlementAmount, 18.5);
  assert.equal(reports.reports[0].settlementStatus, 2);
  assert.equal(reports.reports[0].completedPayAt, null);

  const details = mapFinanceSalesDetailResponse(response({
    count: 1,
    query: null,
    reportSalesDetails: [{
      id: 'DETAIL-SECRET',
      addTime: '2026-07-28 16:00:00',
      settleCurrencyCode: 'SAR',
      inAndOut: 2,
      amount: '12.50',
      goodsCount: 0,
      unitPrice: '6.25',
      secondOrderType: 7,
      skuCode: 'SKU-1',
      skcName: 'SKC-1',
      supplierSku: 'SUP-1',
    }],
  }), { reportOrderNoHash: reports.reports[0].reportOrderNoHash });
  assert.equal(details.rows[0].direction, 'OUT');
  assert.equal(details.rows[0].amount, 12.5);
  assert.equal(details.rows[0].businessDate, '2026-07-28');
  assert.equal(details.rows[0].productKey, 'SUP-1');
  assert.equal(details.rows[0].detailRowKeyHash.length, 64);
  assert.doesNotMatch(JSON.stringify(details), /DETAIL-SECRET/);

  const adjustments = mapFinanceAdjustmentDetailResponse(response({
    count: 1,
    query: null,
    reportReplenishDetail: [{
      id: 'ADJUSTMENT-SECRET',
      addTime: '2026-07-28 17:00:00',
      settleCurrencyCode: 'SAR',
      replenishType: 2,
      replenishCategory: '物流扣款',
      amount: 4.5,
      goodsCount: 1,
      unitPrice: 4.5,
      skcName: 'SKC-1',
    }],
  }), { reportOrderNoHash: reports.reports[0].reportOrderNoHash });
  assert.equal(adjustments.rows[0].direction, 'DEDUCTION');
  assert.equal(adjustments.rows[0].amount, 4.5);
  assert.equal(adjustments.rows[0].category, '物流扣款');
  assert.doesNotMatch(JSON.stringify(adjustments), /ADJUSTMENT-SECRET/);
});

test('finance mapper accepts the platform null-list sentinel only for a proven zero count', () => {
  assert.deepEqual(mapFinanceReportListResponse(response({}), {
    page: 1,
    pageSize: 200,
  }), {
    count: 0,
    reports: [],
  });
  assert.deepEqual(mapFinanceReportListResponse(response({
    count: 0,
    reportOrderInfos: null,
  }), { page: 1, pageSize: 200 }), {
    count: 0,
    reports: [],
  });
  assert.throws(
    () => mapFinanceReportListResponse(response({
      count: 1,
      reportOrderInfos: null,
    }), { page: 1, pageSize: 200 }),
    /reportOrderInfos must be an array/,
  );
  assert.throws(
    () => mapFinanceReportListResponse(response({
      reportOrderInfos: null,
    }), { page: 1, pageSize: 200 }),
    /response.info.count must be an integer/,
  );
  assert.deepEqual(mapFinanceSalesDetailResponse(response({
    count: 0,
    query: null,
    reportSalesDetails: null,
  }), { reportOrderNoHash: 'a'.repeat(64) }), {
    count: 0,
    nextQuery: null,
    rows: [],
  });
  assert.deepEqual(mapFinanceAdjustmentDetailResponse(response({
    count: 0,
    query: null,
    reportReplenishDetail: null,
  }), { reportOrderNoHash: 'a'.repeat(64) }), {
    count: 0,
    nextQuery: null,
    rows: [],
  });
});

test('finance fetch follows report pages and detail cursors without widening the window', async () => {
  const calls = [];
  const client = {
    async request(path, options) {
      calls.push({ path, body: options.body });
      if (path.endsWith('/report-list')) {
        return response({
          count: 1,
          reportOrderInfos: [{
            reportOrderNo: 'R-1',
            addTime: '2026-07-28 09:00:00',
            currencyCode: 'SAR',
            salesTotal: 1,
            replenishTotal: 1,
            estimateIncomeMoneyTotal: 12,
            settlementStatus: 2,
            estimatePayTime: '2026-08-15 00:00:00',
          }],
        });
      }
      if (path.endsWith('/report-sales-detail')) return response({
        count: 1,
        query: null,
        reportSalesDetails: [{
          id: 'D-1',
          addTime: '2026-07-28 10:00:00',
          settleCurrencyCode: 'SAR',
          inAndOut: 1,
          amount: 15,
          goodsCount: 1,
          unitPrice: 15,
          secondOrderType: 1,
          supplierSku: 'SUP-1',
        }],
      });
      return response({
        count: 1,
        query: null,
        reportReplenishDetail: [{
          id: 'A-1',
          addTime: '2026-07-28 11:00:00',
          settleCurrencyCode: 'SAR',
          replenishType: 2,
          replenishCategory: '物流扣款',
          amount: 3,
          goodsCount: 1,
          unitPrice: 3,
          supplierSku: 'SUP-1',
        }],
      });
    },
  };
  const result = await fetchFinanceWindow(client, {
    startDate: '2026-07-23',
    endDate: '2026-07-29',
  });
  assert.equal(result.reports.length, 1);
  assert.equal(result.details.length, 1);
  assert.equal(result.adjustments.length, 1);
  assert.ok(calls.some(({ path }) => path.endsWith('/report-adjustment-detail')));
  assert.deepEqual(calls[0].body, {
    addTimeStart: '2026-07-23 00:00:00',
    addTimeEnd: '2026-07-29 23:59:59',
    page: 1,
    perPage: 200,
  });
});
