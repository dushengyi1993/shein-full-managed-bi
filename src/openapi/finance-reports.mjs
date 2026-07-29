import crypto from 'node:crypto';

import { SheinOpenApiError } from './shein-client.mjs';

export const FINANCE_REPORT_LIST_PATH = '/open-api/finance/report-list';
export const FINANCE_REPORT_SALES_DETAIL_PATH =
  '/open-api/finance/report-sales-detail';
export const FINANCE_HISTORY_EARLIEST_DATE = '2023-06-07';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function fail(code, message) {
  throw new SheinOpenApiError(code, message);
}

function record(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_RESPONSE_SHAPE', `${location} must be an object`);
  }
  return value;
}

function date(value, location) {
  const text = String(value ?? '').slice(0, 10);
  if (!DATE_PATTERN.test(text)) fail('FINANCE_DATE_INVALID', `${location} is invalid`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) {
    fail('FINANCE_DATE_INVALID', `${location} is invalid`);
  }
  return text;
}

function integer(value, location, { minimum = 0 } = {}) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    fail('INVALID_RESPONSE_SHAPE', `${location} must be an integer`);
  }
  return number;
}

function decimal(value, location) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    fail('INVALID_RESPONSE_SHAPE', `${location} must be a non-negative decimal`);
  }
  return number;
}

function optionalText(value, maximum = 160) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).normalize('NFKC').trim();
  return text ? text.slice(0, maximum) : null;
}

function currency(value, location) {
  const text = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(text)) {
    fail('INVALID_RESPONSE_SHAPE', `${location} must be an ISO currency`);
  }
  return text;
}

function successfulInfo(response, path) {
  const body = record(response?.data, `${path} response`);
  if (String(body.code) !== '0') {
    throw new SheinOpenApiError(
      'PLATFORM_ERROR',
      `${path} returned a platform error`,
      {
        platformCode: body.code === undefined ? null : String(body.code),
        platformMessage: typeof body.msg === 'string' ? body.msg.slice(0, 240) : null,
        traceId: typeof body.traceId === 'string' ? body.traceId.slice(0, 128) : null,
      },
    );
  }
  return record(body.info, `${path} response.info`);
}

function isoInstantFromShanghai(value, location) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) fail('INVALID_RESPONSE_SHAPE', `${location} must be a Shanghai datetime`);
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
  if (Number.isNaN(parsed.valueOf())) {
    fail('INVALID_RESPONSE_SHAPE', `${location} must be a Shanghai datetime`);
  }
  return parsed.toISOString();
}

export function financeWindows({
  startDate = FINANCE_HISTORY_EARLIEST_DATE,
  endDate,
} = {}) {
  const start = date(startDate, 'startDate');
  const end = date(endDate, 'endDate');
  if (start > end) fail('FINANCE_DATE_RANGE_INVALID', 'startDate is after endDate');
  const windows = [];
  let cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= last) {
    const windowStart = cursor.toISOString().slice(0, 10);
    const candidate = new Date(cursor);
    candidate.setUTCDate(candidate.getUTCDate() + 6);
    const windowEnd = new Date(Math.min(candidate.valueOf(), last.valueOf()))
      .toISOString().slice(0, 10);
    windows.push({ startDate: windowStart, endDate: windowEnd });
    cursor = new Date(`${windowEnd}T00:00:00.000Z`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return windows;
}

export function mapFinanceReportListResponse(response, { page, pageSize } = {}) {
  const info = successfulInfo(response, FINANCE_REPORT_LIST_PATH);
  const count = integer(info.count, 'response.info.count');
  const reportOrderInfos = count === 0 && info.reportOrderInfos == null
    ? []
    : info.reportOrderInfos;
  if (!Array.isArray(reportOrderInfos)) {
    fail('INVALID_RESPONSE_SHAPE', 'response.info.reportOrderInfos must be an array');
  }
  const reports = reportOrderInfos.map((input, index) => {
    const row = record(input, `response.info.reportOrderInfos[${index}]`);
    const reportOrderNo = optionalText(row.reportOrderNo);
    if (!reportOrderNo) fail('INVALID_RESPONSE_SHAPE', 'reportOrderNo is required');
    return {
      reportOrderNo,
      reportOrderNoHash: crypto.createHash('sha256').update(reportOrderNo).digest('hex'),
      addTime: isoInstantFromShanghai(row.addTime, 'report.addTime'),
      currency: currency(row.currencyCode, 'report.currencyCode'),
      salesTotal: row.salesTotal === null || row.salesTotal === undefined
        ? null
        : integer(row.salesTotal, 'report.salesTotal'),
      expenseType: row.expenseType === null || row.expenseType === undefined
        ? null
        : integer(row.expenseType, 'report.expenseType'),
    };
  });
  if (reports.length > pageSize || (page - 1) * pageSize + reports.length > count) {
    fail('PAGINATION_MISMATCH', 'finance report list pagination is inconsistent');
  }
  return { count, reports };
}

export function mapFinanceSalesDetailResponse(response, {
  reportOrderNoHash,
} = {}) {
  if (!/^[0-9a-f]{64}$/.test(String(reportOrderNoHash ?? ''))) {
    fail('FINANCE_REPORT_HASH_INVALID', 'reportOrderNoHash is invalid');
  }
  const info = successfulInfo(response, FINANCE_REPORT_SALES_DETAIL_PATH);
  const count = integer(info.count, 'response.info.count');
  const reportSalesDetails = count === 0 && info.reportSalesDetails == null
    ? []
    : info.reportSalesDetails;
  if (!Array.isArray(reportSalesDetails)) {
    fail('INVALID_RESPONSE_SHAPE', 'response.info.reportSalesDetails must be an array');
  }
  const rows = reportSalesDetails.map((input, index) => {
    const row = record(input, `response.info.reportSalesDetails[${index}]`);
    const id = optionalText(row.id);
    if (!id) fail('INVALID_RESPONSE_SHAPE', 'finance detail id is required');
    const directionCode = integer(row.inAndOut, 'detail.inAndOut', { minimum: 1 });
    if (![1, 2].includes(directionCode)) {
      fail('INVALID_RESPONSE_SHAPE', 'finance detail direction is invalid');
    }
    const platformSkuId = optionalText(row.skuCode);
    const platformSkcId = optionalText(row.skcName);
    const supplierSku = optionalText(row.supplierSku);
    const productKey = supplierSku || platformSkcId || platformSkuId;
    return {
      reportOrderNoHash,
      detailRowKeyHash: crypto.createHash('sha256').update(id).digest('hex'),
      businessDate: date(row.addTime, 'detail.addTime'),
      observedBusinessAt: isoInstantFromShanghai(row.addTime, 'detail.addTime'),
      currency: currency(row.settleCurrencyCode, 'detail.settleCurrencyCode'),
      direction: directionCode === 1 ? 'IN' : 'OUT',
      amount: decimal(row.amount, 'detail.amount'),
      goodsCount: integer(row.goodsCount, 'detail.goodsCount'),
      unitPrice: row.unitPrice === null || row.unitPrice === undefined || row.unitPrice === ''
        ? null
        : decimal(row.unitPrice, 'detail.unitPrice'),
      secondOrderType: String(integer(row.secondOrderType, 'detail.secondOrderType')),
      expenseType: row.expenseType === null || row.expenseType === undefined
        ? null
        : integer(row.expenseType, 'detail.expenseType'),
      productKey,
      platformSkuId,
      platformSkcId,
      supplierSku,
    };
  });
  return {
    count,
    nextQuery: optionalText(info.query, 512),
    rows,
  };
}

export async function fetchFinanceWindow(client, {
  startDate,
  endDate,
  reportPageSize = 200,
  detailPageSize = 200,
  maxReports = 20_000,
  maxDetails = 2_000_000,
} = {}) {
  const [window] = financeWindows({ startDate, endDate });
  if (!window || window.startDate !== startDate || window.endDate !== endDate) {
    fail('FINANCE_DATE_RANGE_INVALID', 'finance window must not exceed seven days');
  }
  const reports = [];
  for (let page = 1; ; page += 1) {
    const response = await client.request(FINANCE_REPORT_LIST_PATH, {
      method: 'POST',
      body: {
        addTimeStart: `${startDate} 00:00:00`,
        addTimeEnd: `${endDate} 23:59:59`,
        page,
        perPage: reportPageSize,
      },
    });
    const mapped = mapFinanceReportListResponse(response, {
      page,
      pageSize: reportPageSize,
    });
    reports.push(...mapped.reports);
    if (reports.length > maxReports) fail('FINANCE_REPORT_LIMIT', 'finance report limit exceeded');
    if (reports.length >= mapped.count) break;
    if (mapped.reports.length === 0) fail('PAGINATION_EMPTY_GAP', 'finance report pagination stopped early');
  }

  const details = [];
  for (const report of reports) {
    if (report.salesTotal === 0) continue;
    let query;
    let received = 0;
    for (;;) {
      const response = await client.request(FINANCE_REPORT_SALES_DETAIL_PATH, {
        method: 'POST',
        body: {
          reportOrderNo: report.reportOrderNo,
          perPage: detailPageSize,
          ...(query ? { query } : {}),
        },
      });
      const mapped = mapFinanceSalesDetailResponse(response, {
        reportOrderNoHash: report.reportOrderNoHash,
      });
      details.push(...mapped.rows);
      received += mapped.rows.length;
      if (details.length > maxDetails) fail('FINANCE_DETAIL_LIMIT', 'finance detail limit exceeded');
      if (!mapped.nextQuery) {
        if (received !== mapped.count) {
          fail('PAGINATION_COUNT_MISMATCH', 'finance detail count did not match');
        }
        break;
      }
      if (mapped.rows.length === 0) {
        fail('PAGINATION_EMPTY_GAP', 'finance detail cursor returned no rows');
      }
      query = mapped.nextQuery;
    }
  }
  return { reports, details };
}
