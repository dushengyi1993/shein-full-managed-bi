import {
  buildAnalyseSearchRequest,
  buildIndexUpdateTimeRequest,
  buildProductDiagnoseListRequest,
  buildRealtimeRequest,
  buildRealtimeUpdateTimeRequest,
  buildRegionRankRequest,
  buildShopDailyRequest,
  buildStoreDailyHistoryRequest,
  buildTradeOverviewRequest,
  historyWindows,
  parseIndexUpdateTime,
  parseProductDiagnosePage,
  parseRealtimeStoreSummary,
  parseRealtimeUpdateTime,
  parseRegionRows,
  parseShopAnalysisRows,
  parseStoreDailyHistory,
  parseTradeOverview,
  sha256Json,
} from './home-contracts.mjs';

export class FullHomeSyncError extends Error {
  constructor(code) {
    super(`full homepage sync failed: ${code}`);
    this.name = 'FullHomeSyncError';
    this.code = code;
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function payload(value) {
  const source = record(value);
  return record(source.info ?? source.data ?? source);
}

function analyseRows(value) {
  const result = record(payload(value).analyseResult);
  return Array.isArray(result.data) ? result.data : [];
}

function analyseCount(value) {
  const count = Number(record(record(payload(value).analyseResult).meta).count);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function assertAnalyseModelAccepted(value) {
  if (payload(value).status !== true) {
    throw new FullHomeSyncError('HOME_ANALYSE_MODEL_REJECTED');
  }
}

function schemaDescription(value, prefix = '$', output = []) {
  if (output.length >= 500) return output;
  if (Array.isArray(value)) {
    output.push(`${prefix}:array`);
    if (value.length) schemaDescription(value[0], `${prefix}[]`, output);
    return output;
  }
  if (value && typeof value === 'object') {
    output.push(`${prefix}:object`);
    for (const key of Object.keys(value).sort()) {
      if (output.length >= 500) break;
      schemaDescription(value[key], `${prefix}.${key}`, output);
    }
    return output;
  }
  output.push(`${prefix}:${value === null ? 'null' : typeof value}`);
  return output;
}

function sanitizedErrorCode(error, fallback = 'HOME_SYNC_FAILED') {
  const candidate = String(error?.code ?? fallback).toUpperCase();
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(candidate) ? candidate : fallback;
}

function resultStatus(rows, rejected = 0) {
  if (rejected > 0 && rows > 0) return 'PARTIAL';
  if (rejected > 0) return 'REJECTED';
  return 'SUCCEEDED';
}

function nowIso(clock) {
  const current = clock();
  const date = current instanceof Date ? current : new Date(current);
  if (Number.isNaN(date.valueOf())) throw new TypeError('clock returned an invalid date');
  return date.toISOString();
}

function datesInWindow({ startDate, endDate }) {
  const dates = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const last = new Date(`${endDate}T00:00:00.000Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function mergeShopRows(rows) {
  const byGrain = new Map();
  for (const row of rows) {
    const key = `${row.storeCode}\u001f${row.businessDate}`;
    const current = byGrain.get(key) ?? {
      ...row,
      exposureUsers: null,
      paymentOrderCount: null,
      salesQuantity: null,
      sourceCodes: ['WEBAPI_ANALYSE'],
    };
    for (const field of ['exposureUsers', 'paymentOrderCount', 'salesQuantity']) {
      if (row[field] === null || row[field] === undefined) continue;
      current[field] = (current[field] ?? 0) + row[field];
    }
    if (current.exposureUsers !== null) current.exposureBasis = 'BRAND_SUMMED';
    byGrain.set(key, current);
  }
  return [...byGrain.values()];
}

const SHANGHAI_CLOCK_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

function shanghaiClockParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('clock returned an invalid date');
  const parts = Object.fromEntries(
    SHANGHAI_CLOCK_FORMATTER.formatToParts(date)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value: part }) => [type, part]),
  );
  const businessDate = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    businessDate,
    startHour: `${parts.year}${parts.month}${parts.day}00`,
    endHour: `${parts.year}${parts.month}${parts.day}${parts.hour}`,
  };
}

function previousBusinessDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function shiftBusinessDate(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function operationalRows(rows) {
  const fields = [
    'dealAmount',
    'netDealAmount',
    'salesQuantity',
    'buyerCount',
    'goodsDetailVisitors',
    'stockingOrderCount',
    'urgentPurchaseOrderCount',
  ];
  return rows.filter((row) => fields.some((field) => (
    row[field] !== null && row[field] !== undefined
  )));
}

function completeMetricSum(rows, field) {
  if (
    rows.length === 0
    || rows.some((row) => typeof row[field] !== 'number' || !Number.isFinite(row[field]))
  ) return null;
  return rows.reduce((sum, row) => sum + row[field], 0);
}

export function mergeRealtimeStoreRows(rows, {
  storeCode,
  businessDate,
  sourceUpdatedAt = null,
  observedAt,
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const currencies = [...new Set(rows.map(({ currency }) => currency).filter(Boolean))];
  return Object.freeze({
    storeCode,
    businessDate,
    currency: currencies.length === 1 ? currencies[0] : null,
    dealAmount: completeMetricSum(rows, 'dealAmount'),
    netDealAmount: completeMetricSum(rows, 'netDealAmount'),
    salesQuantity: completeMetricSum(rows, 'salesQuantity'),
    // Hourly UVs are not additive across a day. Preserve them as unavailable
    // instead of overstating unique buyers or product-detail visitors.
    buyerCount: null,
    goodsDetailVisitors: null,
    stockingOrderCount: completeMetricSum(rows, 'stockingOrderCount'),
    urgentPurchaseOrderCount: completeMetricSum(rows, 'urgentPurchaseOrderCount'),
    sourceUpdatedAt,
    observedAt,
    sourceCode: 'WEBAPI_REALTIME',
  });
}

async function audit(repository, input) {
  try {
    await repository.recordFetchAudit(input);
  } catch (error) {
    throw new FullHomeSyncError(
      sanitizedErrorCode(error, 'HOME_AUDIT_PERSIST_FAILED'),
    );
  }
}

async function requestAndAudit({
  transport,
  repository,
  storeCode,
  endpointCode,
  request,
  startDate,
  endDate,
  clock,
  handle,
}) {
  const observedAt = nowIso(clock);
  try {
    const response = await transport(endpointCode, request);
    const output = await handle(response.body, observedAt);
    const completedAt = nowIso(clock);
    const accepted = Number(output?.accepted ?? 0);
    const rejected = Number(output?.rejected ?? 0);
    await audit(repository, {
      storeCode,
      endpointCode,
      requestedStartDate: startDate,
      requestedEndDate: endDate,
      request,
      responseSchemaSha256: sha256Json(schemaDescription(response.body)),
      responseBodySha256: sha256Json(response.body),
      httpStatus: response.httpStatus,
      resultStatus: resultStatus(accepted, rejected),
      acceptedRowCount: accepted,
      rejectedRowCount: rejected,
      observedAt,
      completedAt,
    });
    return {
      ok: true,
      accepted,
      rejected,
      total: output?.total ?? accepted + rejected,
      payload: output?.payload ?? null,
    };
  } catch (error) {
    const completedAt = nowIso(clock);
    const errorCode = sanitizedErrorCode(error);
    await audit(repository, {
      storeCode,
      endpointCode,
      requestedStartDate: startDate,
      requestedEndDate: endDate,
      request,
      httpStatus: null,
      resultStatus: 'FAILED',
      acceptedRowCount: 0,
      rejectedRowCount: 0,
      observedAt,
      completedAt,
      sanitizedErrorCode: errorCode,
    });
    return { ok: false, accepted: 0, rejected: 0, total: 0, errorCode };
  }
}

async function syncRealtimeDay({
  storeCode,
  realtime,
  transport,
  repository,
  clock,
}) {
  const anchorResult = await requestAndAudit({
    transport,
    repository,
    storeCode,
    endpointCode: 'UPDATE_TIME',
    request: buildRealtimeUpdateTimeRequest(),
    startDate: realtime.businessDate,
    endDate: realtime.businessDate,
    clock,
    handle: async (body) => ({
      accepted: 1,
      payload: parseRealtimeUpdateTime(body),
    }),
  });
  if (!anchorResult.ok || !anchorResult.payload?.endHour) {
    return {
      ok: false,
      accepted: 0,
      rejected: 0,
      total: 0,
      errorCode: anchorResult.errorCode ?? 'HOME_REALTIME_UPDATE_TIME_UNAVAILABLE',
      payload: null,
    };
  }
  const anchor = anchorResult.payload;
  if (anchor.businessDate !== realtime.businessDate) {
    return {
      ok: true,
      accepted: 0,
      rejected: 0,
      total: 0,
      payload: {
        sourceUpdatedAt: anchor.sourceUpdatedAt,
        requestedBusinessDate: realtime.businessDate,
        availableBusinessDate: anchor.businessDate,
        stale: true,
      },
    };
  }
  const request = buildRealtimeRequest({
    startHour: anchor.startHour,
    endHour: anchor.endHour,
    observedDate: anchor.businessDate,
  });
  const curveResult = await requestAndAudit({
    transport,
    repository,
    storeCode,
    endpointCode: 'STORE_REALTIME',
    request,
    startDate: realtime.businessDate,
    endDate: realtime.businessDate,
    clock,
    handle: async (body, observedAt) => {
      const hourlyRows = parseStoreDailyHistory(body, {
        storeCode,
        observedAt,
        realtimeDate: realtime.businessDate,
      });
      const merged = mergeRealtimeStoreRows(hourlyRows, {
        storeCode,
        businessDate: anchor.businessDate,
        sourceUpdatedAt: anchor.sourceUpdatedAt,
        observedAt,
      });
      if (merged) await repository.upsertStoreDaily([merged]);
      return {
        accepted: hourlyRows.length,
        payload: {
          hourlyRows: hourlyRows.length,
          factRows: merged ? 1 : 0,
          sourceUpdatedAt: anchor.sourceUpdatedAt,
        },
      };
    },
  });
  const summaryResult = await requestAndAudit({
    transport,
    repository,
    storeCode,
    endpointCode: 'STORE_REALTIME_SUMMARY',
    request,
    startDate: anchor.businessDate,
    endDate: anchor.businessDate,
    clock,
    handle: async (body, observedAt) => {
      const row = parseRealtimeStoreSummary(body, {
        storeCode,
        businessDate: anchor.businessDate,
        sourceUpdatedAt: anchor.sourceUpdatedAt,
        observedAt,
      });
      const accepted = operationalRows([row]).length;
      if (accepted) await repository.upsertStoreDaily([row]);
      return {
        accepted,
        payload: {
          factRows: accepted,
          knownMetricCount: [
            'dealAmount',
            'netDealAmount',
            'salesQuantity',
            'buyerCount',
            'goodsDetailVisitors',
            'stockingOrderCount',
            'urgentPurchaseOrderCount',
          ].filter((field) => row[field] !== null).length,
          sourceUpdatedAt: anchor.sourceUpdatedAt,
        },
      };
    },
  });
  return {
    ok: curveResult.ok && summaryResult.ok,
    accepted: curveResult.accepted + summaryResult.accepted,
    rejected: curveResult.rejected + summaryResult.rejected,
    total: curveResult.total + summaryResult.total,
    errorCode: curveResult.errorCode ?? summaryResult.errorCode,
    payload: {
      sourceUpdatedAt: anchor.sourceUpdatedAt,
      providerRefreshedAt: anchor.providerRefreshedAt,
      curve: curveResult.payload,
      summary: summaryResult.payload,
    },
  };
}

async function resolveDataAnchor({
  storeCode,
  requestedEndDate,
  transport,
  repository,
  clock,
}) {
  const result = await requestAndAudit({
    transport,
    repository,
    storeCode,
    endpointCode: 'UPDATE_TIME',
    request: buildIndexUpdateTimeRequest(),
    startDate: requestedEndDate,
    endDate: requestedEndDate,
    clock,
    handle: async (body) => {
      const parsed = parseIndexUpdateTime(body);
      return { accepted: 1, payload: parsed };
    },
  });
  if (!result.ok || !result.payload?.dataAnchorDate) {
    throw new FullHomeSyncError(
      result.errorCode ?? 'HOME_UPDATE_TIME_UNAVAILABLE',
    );
  }
  return result.payload;
}

async function syncProductDate({
  storeCode,
  businessDate,
  observedDate,
  transport,
  repository,
  clock,
}) {
  const pageSize = 200;
  let pageNum = 1;
  let total = null;
  let accepted = 0;
  let rejected = 0;
  let sourceRows = 0;
  do {
    const request = buildProductDiagnoseListRequest({
      businessDate,
      observedDate,
      pageNum,
      pageSize,
    });
    const page = await requestAndAudit({
      transport,
      repository,
      storeCode,
      endpointCode: 'PRODUCT_DIAGNOSE_LIST',
      request,
      startDate: businessDate,
      endDate: businessDate,
      clock,
      handle: async (body, observedAt) => {
        const parsed = parseProductDiagnosePage(body, {
          storeCode,
          businessDate,
          observedAt,
        });
        await repository.upsertProducts(parsed.rows);
        return {
          accepted: parsed.rows.length,
          rejected: parsed.rejectedRowCount,
          total: parsed.count,
          payload: {
            sourceRows: parsed.sourceRowCount,
            lastSalesQuantity: parsed.lastSalesQuantity,
          },
        };
      },
    });
    if (!page.ok) {
      return {
        ...page,
        pageNum,
        accepted,
        rejected,
        sourceRows,
      };
    }
    total = page.total;
    accepted += page.accepted;
    rejected += page.rejected;
    sourceRows += page.payload?.sourceRows ?? 0;
    const hasAnotherPage = pageNum * pageSize < total;
    const pageMayContainMoreSales = (
      page.payload?.sourceRows === pageSize
      && typeof page.payload?.lastSalesQuantity === 'number'
      && page.payload.lastSalesQuantity > 0
    );
    pageNum += 1;
    if (!hasAnotherPage || !pageMayContainMoreSales) break;
  } while (true);
  return {
    ok: true,
    accepted,
    rejected,
    sourceRows,
    total,
    pages: pageNum - 1,
  };
}

async function syncStoreWindow({
  storeCode,
  window,
  transport,
  repository,
  clock,
  includeProducts,
  completedTradeDates,
  completedRegionDates,
  completedProductDates,
  unsupportedTradeDates,
  unsupportedRegionDates,
  metricFloors,
  dataAnchor,
}) {
  const result = {
    storeCode,
    ...window,
    dataAnchor,
    storeDaily: null,
    shopDaily: null,
    productDaily: null,
    tradeDaily: null,
    regionDaily: null,
    realtime: null,
  };
  const storeRequest = buildStoreDailyHistoryRequest({
    ...window,
    observedDate: dataAnchor.dataAnchorDate,
  });
  result.storeDaily = await requestAndAudit({
    transport,
    repository,
    storeCode,
    endpointCode: 'STORE_DAILY_HISTORY',
    request: storeRequest,
    startDate: window.startDate,
    endDate: window.endDate,
    clock,
    handle: async (body, observedAt) => {
      const rows = parseStoreDailyHistory(body, { storeCode, observedAt });
      await repository.upsertStoreDaily(rows);
      const activeRows = operationalRows(rows);
      return {
        accepted: rows.length,
        payload: {
          hasOperationalRows: activeRows.length > 0,
          productDates: activeRows
            .filter(({ salesQuantity }) => (
              Number.isSafeInteger(salesQuantity) && salesQuantity > 0
            ))
            .map(({ businessDate }) => businessDate),
        },
      };
    },
  });

  if (result.storeDaily.ok && result.storeDaily.payload?.hasOperationalRows) {
    const shopModelRequest = buildShopDailyRequest(window);
    const shopModel = await requestAndAudit({
      transport,
      repository,
      storeCode,
      endpointCode: 'ANALYSE_MODEL',
      request: shopModelRequest,
      startDate: window.startDate,
      endDate: window.endDate,
      clock,
      handle: async (body) => {
        assertAnalyseModelAccepted(body);
        return { accepted: 0 };
      },
    });
    if (shopModel.ok) {
      const shopRawRows = [];
      let pageNum = 1;
      let total = null;
      let searchFailed = false;
      do {
        const request = buildAnalyseSearchRequest({ pageNum, pageSize: 200 });
        const page = await requestAndAudit({
          transport,
          repository,
          storeCode,
          endpointCode: 'ANALYSE_SEARCH',
          request,
          startDate: window.startDate,
          endDate: window.endDate,
          clock,
          handle: async (body) => {
            const rows = analyseRows(body);
            total = analyseCount(body);
            shopRawRows.push(...rows);
            return { accepted: rows.length, total };
          },
        });
        if (!page.ok) {
          searchFailed = true;
          result.shopDaily = page;
          break;
        }
        pageNum += 1;
      } while (total !== null && (pageNum - 1) * 200 < total);
      if (!searchFailed) {
        const parsed = parseShopAnalysisRows({
          info: { analyseResult: { data: shopRawRows } },
        }, {
          storeCode,
          observedAt: nowIso(clock),
        });
        const rows = mergeShopRows(parsed);
        await repository.upsertStoreDaily(rows);
        result.shopDaily = {
          ok: true,
          accepted: rows.length,
          sourceRows: shopRawRows.length,
          total,
        };
      }
    } else {
      result.shopDaily = shopModel;
    }
  } else {
    result.shopDaily = {
      ok: true,
      skipped: true,
      reason: result.storeDaily.ok ? 'NO_OPERATIONAL_DATA' : 'STORE_DAILY_FAILED',
    };
  }

  const tradeDaily = {
    ok: true,
    loaded: 0,
    skipped: 0,
    unsupported: 0,
    failed: 0,
    firstErrorCode: null,
  };
  const regionDaily = {
    ok: true,
    loaded: 0,
    skipped: 0,
    unsupported: 0,
    failed: 0,
    acceptedRows: 0,
    firstErrorCode: null,
  };
  for (const businessDate of datesInWindow(window)) {
    const syncTradeDate = async () => {
      if (
        (metricFloors.tradeFloor && businessDate < metricFloors.tradeFloor)
        || unsupportedTradeDates.has(businessDate)
      ) {
        tradeDaily.unsupported += 1;
      } else if (completedTradeDates.has(businessDate)) {
        tradeDaily.skipped += 1;
      } else {
        const request = buildTradeOverviewRequest({
          startDate: businessDate,
          endDate: businessDate,
          observedDate: dataAnchor.dataAnchorDate,
        });
        const trade = await requestAndAudit({
          transport,
          repository,
          storeCode,
          endpointCode: 'TRADE_OVERVIEW',
          request,
          startDate: businessDate,
          endDate: businessDate,
          clock,
          handle: async (body, observedAt) => {
            const row = parseTradeOverview(body, {
              storeCode,
              businessDate,
              observedAt,
            });
            await repository.upsertStoreDaily([row]);
            return { accepted: 1 };
          },
        });
        if (trade.ok) {
          tradeDaily.loaded += 1;
          completedTradeDates.add(businessDate);
        } else {
          tradeDaily.ok = false;
          tradeDaily.failed += 1;
          tradeDaily.firstErrorCode ??= trade.errorCode;
        }
      }
    };

    const syncRegionDate = async () => {
      if (
        (metricFloors.regionFloor && businessDate < metricFloors.regionFloor)
        || unsupportedRegionDates.has(businessDate)
      ) {
        regionDaily.unsupported += 1;
      } else if (completedRegionDates.has(businessDate)) {
        regionDaily.skipped += 1;
      } else {
        const request = buildRegionRankRequest({
          startDate: businessDate,
          endDate: businessDate,
          observedDate: dataAnchor.dataAnchorDate,
        });
        const region = await requestAndAudit({
          transport,
          repository,
          storeCode,
          endpointCode: 'REGION_RANK',
          request,
          startDate: businessDate,
          endDate: businessDate,
          clock,
          handle: async (body, observedAt) => {
            const rows = parseRegionRows(body, {
              storeCode,
              businessDate,
              observedAt,
            });
            await repository.upsertRegions(rows);
            return { accepted: rows.length };
          },
        });
        if (region.ok) {
          regionDaily.loaded += 1;
          regionDaily.acceptedRows += region.accepted;
          completedRegionDates.add(businessDate);
        } else {
          regionDaily.ok = false;
          regionDaily.failed += 1;
          regionDaily.firstErrorCode ??= region.errorCode;
        }
      }
    };

    // The two live management-analysis endpoints are independent read-only
    // contracts for the same day. Keep dates and Profiles serial, but overlap
    // this pair so a full history run does not pay two network round trips per
    // day.
    await Promise.all([syncTradeDate(), syncRegionDate()]);
  }
  result.tradeDaily = tradeDaily;
  result.regionDaily = regionDaily;

  if (!includeProducts) return result;

  const productDaily = {
    ok: true,
    loadedDates: 0,
    skippedDates: 0,
    failedDates: 0,
    acceptedRows: 0,
    sourceRows: 0,
    firstErrorCode: null,
  };
  const productDates = [
    ...new Set(result.storeDaily.payload?.productDates ?? []),
  ].sort();
  for (const businessDate of productDates) {
    if (completedProductDates.has(businessDate)) {
      productDaily.skippedDates += 1;
      continue;
    }
    const product = await syncProductDate({
      storeCode,
      businessDate,
      observedDate: dataAnchor.dataAnchorDate,
      transport,
      repository,
      clock,
    });
    if (product.ok) {
      productDaily.loadedDates += 1;
      productDaily.acceptedRows += product.accepted;
      productDaily.sourceRows += product.sourceRows;
      completedProductDates.add(businessDate);
    } else {
      productDaily.ok = false;
      productDaily.failedDates += 1;
      productDaily.firstErrorCode ??= product.errorCode;
    }
  }
  result.productDaily = productDaily;
  return result;
}

export async function runFullHomeHistorySync({
  storeCodes,
  startDate,
  endDate,
  includeProducts = true,
  refreshRecentSettledDays = 0,
  requireSettledThrough = null,
  allowSavedCredentialLogin = true,
  openSession,
  transportFactory,
  repository,
  clock = () => new Date(),
} = {}) {
  if (!Array.isArray(storeCodes) || storeCodes.length === 0) {
    throw new TypeError('storeCodes are required');
  }
  if (
    !Number.isSafeInteger(refreshRecentSettledDays)
    || refreshRecentSettledDays < 0
    || refreshRecentSettledDays > 30
  ) {
    throw new TypeError('refreshRecentSettledDays must be between 0 and 30');
  }
  if (
    requireSettledThrough !== null
    && !/^\d{4}-\d{2}-\d{2}$/.test(String(requireSettledThrough))
  ) {
    throw new TypeError('requireSettledThrough must be an ISO business date');
  }
  for (const dependency of [openSession, transportFactory]) {
    if (typeof dependency !== 'function') throw new TypeError('sync dependency missing');
  }
  for (const method of [
    'recordFetchAudit',
    'upsertStoreDaily',
    'upsertRegions',
    'upsertProducts',
    'successfulDailyDates',
  ]) {
    if (typeof repository?.[method] !== 'function') {
      throw new TypeError(`repository.${method} is required`);
    }
  }
  // Validate the complete requested scope before applying the source-specific
  // settled-day boundary below.
  historyWindows({ startDate, endDate });
  const realtimeClock = shanghaiClockParts(clock());
  const realtime = startDate <= realtimeClock.businessDate
    && endDate >= realtimeClock.businessDate
    ? realtimeClock
    : null;
  // The daily index uses its `dt` field as the data-version anchor. Anchoring
  // it to the current Shanghai day returns correctly dated rows whose metrics
  // are still null. Keep every historical endpoint on yesterday or earlier;
  // the current day is supplied only by the hourly realtime endpoint.
  const settledEndDate = realtime
    ? previousBusinessDate(realtime.businessDate)
    : endDate;
  const windows = startDate <= settledEndDate
    ? historyWindows({ startDate, endDate: settledEndDate })
    : [];
  const results = [];
  for (const rawStoreCode of storeCodes) {
    const storeCode = String(rawStoreCode).trim().toUpperCase();
    let session = null;
    try {
      session = await openSession({ storeCode, allowSavedCredentialLogin });
      const transport = transportFactory({ session });
      const storeResults = [];
      const historicalStartDate = windows[0]?.startDate ?? null;
      const historicalEndDate = windows.at(-1)?.endDate ?? null;
      const dataAnchor = windows.length > 0
        ? await resolveDataAnchor({
            storeCode,
            requestedEndDate: historicalEndDate,
            transport,
            repository,
            clock,
          })
        : null;
      if (
        dataAnchor
        && requireSettledThrough
        && dataAnchor.dataAnchorDate < requireSettledThrough
      ) {
        results.push({
          storeCode,
          startDate,
          endDate,
          sessionErrorCode: 'HOME_SETTLEMENT_NOT_READY',
          settlement: {
            requiredThrough: requireSettledThrough,
            availableThrough: dataAnchor.dataAnchorDate,
            sourceUpdatedAt: dataAnchor.sourceUpdatedAt ?? null,
          },
        });
        continue;
      }
      const [
        completedTradeDates,
        completedRegionDates,
        completedProductDates,
        unsupportedTradeDates,
        unsupportedRegionDates,
        metricFloors,
      ] = windows.length > 0
        ? await Promise.all([
          repository.successfulDailyDates({
            storeCode,
            endpointCode: 'TRADE_OVERVIEW',
            startDate: historicalStartDate,
            endDate: historicalEndDate,
          }),
          repository.successfulDailyDates({
            storeCode,
            endpointCode: 'REGION_RANK',
            startDate: historicalStartDate,
            endDate: historicalEndDate,
          }),
          includeProducts
            ? repository.successfulDailyDates({
                storeCode,
                endpointCode: 'PRODUCT_DIAGNOSE_LIST',
                startDate: historicalStartDate,
                endDate: historicalEndDate,
              })
            : Promise.resolve(new Set()),
          typeof repository.terminalUnsupportedDailyDates === 'function'
            ? repository.terminalUnsupportedDailyDates({
                storeCode,
                endpointCode: 'TRADE_OVERVIEW',
                startDate: historicalStartDate,
                endDate: historicalEndDate,
              })
            : Promise.resolve(new Set()),
          typeof repository.terminalUnsupportedDailyDates === 'function'
            ? repository.terminalUnsupportedDailyDates({
                storeCode,
                endpointCode: 'REGION_RANK',
                startDate: historicalStartDate,
                endDate: historicalEndDate,
              })
            : Promise.resolve(new Set()),
          typeof repository.historyMetricFloors === 'function'
            ? repository.historyMetricFloors({ storeCode })
            : Promise.resolve(Object.freeze({
                tradeFloor: null,
                regionFloor: null,
              })),
        ])
        : [
            new Set(),
            new Set(),
            new Set(),
            new Set(),
            new Set(),
            Object.freeze({ tradeFloor: null, regionFloor: null }),
          ];
      if (refreshRecentSettledDays > 0 && windows.length > 0) {
        const refreshStart = shiftBusinessDate(
          settledEndDate,
          1 - refreshRecentSettledDays,
        );
        for (const completed of [
          completedTradeDates,
          completedRegionDates,
          completedProductDates,
          unsupportedTradeDates,
          unsupportedRegionDates,
        ]) {
          for (const date of completed) {
            if (date >= refreshStart) completed.delete(date);
          }
        }
      }
      for (const window of windows) {
        storeResults.push(await syncStoreWindow({
          storeCode,
          window,
          transport,
          repository,
          clock,
          includeProducts,
          completedTradeDates,
          completedRegionDates,
          completedProductDates,
          unsupportedTradeDates,
          unsupportedRegionDates,
          metricFloors,
          dataAnchor,
        }));
      }
      if (realtime) {
        if (storeResults.length === 0) {
          storeResults.push({
            storeCode,
            startDate: realtime.businessDate,
            endDate: realtime.businessDate,
            storeDaily: null,
            shopDaily: null,
            productDaily: null,
            tradeDaily: null,
            regionDaily: null,
            realtime: null,
          });
        }
        storeResults.at(-1).realtime = await syncRealtimeDay({
          storeCode,
          realtime,
          transport,
          repository,
          clock,
        });
      }
      results.push(...storeResults);
    } catch (error) {
      results.push({
        storeCode,
        startDate,
        endDate,
        sessionErrorCode: sanitizedErrorCode(error, 'HOME_SESSION_FAILED'),
      });
    } finally {
      await session?.close?.().catch(() => {});
    }
  }
  const failedWindows = results.filter((row) => (
    row.sessionErrorCode
    || row.storeDaily?.ok === false
    || row.realtime?.ok === false
  )).length;
  const partialWindows = results.filter((row) => (
    row.sessionErrorCode
    || row.shopDaily?.ok === false
    || row.productDaily?.ok === false
    || row.tradeDaily?.ok === false
    || row.regionDaily?.ok === false
  )).length;
  return Object.freeze({
    ok: failedWindows === 0,
    complete: failedWindows === 0 && partialWindows === 0,
    storeCount: storeCodes.length,
    windowCount: windows.length,
    resultCount: results.length,
    failedWindows,
    partialWindows,
    results: Object.freeze(results),
  });
}
