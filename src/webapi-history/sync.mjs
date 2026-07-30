import {
  buildAnalyseSearchRequest,
  buildProductDailyRequest,
  buildRegionRankRequest,
  buildShopDailyRequest,
  buildStoreDailyHistoryRequest,
  buildTradeOverviewRequest,
  historyWindows,
  parseProductDailyRows,
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

async function syncStoreWindow({
  storeCode,
  window,
  transport,
  repository,
  clock,
  includeProducts,
  completedTradeDates,
  completedRegionDates,
}) {
  const result = {
    storeCode,
    ...window,
    storeDaily: null,
    shopDaily: null,
    productDaily: null,
    tradeDaily: null,
    regionDaily: null,
  };
  const storeRequest = buildStoreDailyHistoryRequest(window);
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
      return { accepted: rows.length };
    },
  });

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

  const tradeDaily = {
    ok: true,
    loaded: 0,
    skipped: 0,
    failed: 0,
    firstErrorCode: null,
  };
  const regionDaily = {
    ok: true,
    loaded: 0,
    skipped: 0,
    failed: 0,
    acceptedRows: 0,
    firstErrorCode: null,
  };
  for (const businessDate of datesInWindow(window)) {
    if (completedTradeDates.has(businessDate)) {
      tradeDaily.skipped += 1;
    } else {
      const request = buildTradeOverviewRequest({
        startDate: businessDate,
        endDate: businessDate,
        observedDate: businessDate,
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

    if (completedRegionDates.has(businessDate)) {
      regionDaily.skipped += 1;
      continue;
    }
    const request = buildRegionRankRequest({
      startDate: businessDate,
      endDate: businessDate,
      observedDate: businessDate,
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
  result.tradeDaily = tradeDaily;
  result.regionDaily = regionDaily;

  if (!includeProducts) return result;

  const productModelRequest = buildProductDailyRequest({
    ...window,
    grain: 'SPU',
  });
  const productModel = await requestAndAudit({
    transport,
    repository,
    storeCode,
    endpointCode: 'ANALYSE_MODEL',
    request: productModelRequest,
    startDate: window.startDate,
    endDate: window.endDate,
    clock,
    handle: async (body) => {
      assertAnalyseModelAccepted(body);
      return { accepted: 0 };
    },
  });
  if (!productModel.ok) {
    result.productDaily = productModel;
    return result;
  }

  let pageNum = 1;
  let total = null;
  let accepted = 0;
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
      handle: async (body, observedAt) => {
        const rows = parseProductDailyRows(body, {
          storeCode,
          grain: 'SPU',
          observedAt,
        });
        total = analyseCount(body);
        await repository.upsertProducts(rows);
        return { accepted: rows.length, total };
      },
    });
    if (!page.ok) {
      result.productDaily = page;
      return result;
    }
    accepted += page.accepted;
    pageNum += 1;
  } while (total !== null && (pageNum - 1) * 200 < total);
  result.productDaily = { ok: true, accepted, total };
  return result;
}

export async function runFullHomeHistorySync({
  storeCodes,
  startDate,
  endDate,
  includeProducts = true,
  openSession,
  transportFactory,
  repository,
  clock = () => new Date(),
} = {}) {
  if (!Array.isArray(storeCodes) || storeCodes.length === 0) {
    throw new TypeError('storeCodes are required');
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
  const windows = historyWindows({ startDate, endDate });
  const results = [];
  for (const rawStoreCode of storeCodes) {
    const storeCode = String(rawStoreCode).trim().toUpperCase();
    let session = null;
    try {
      session = await openSession({ storeCode });
      const transport = transportFactory({ session });
      const [completedTradeDates, completedRegionDates] = await Promise.all([
        repository.successfulDailyDates({
          storeCode,
          endpointCode: 'TRADE_OVERVIEW',
          startDate,
          endDate,
        }),
        repository.successfulDailyDates({
          storeCode,
          endpointCode: 'REGION_RANK',
          startDate,
          endDate,
        }),
      ]);
      for (const window of windows) {
        results.push(await syncStoreWindow({
          storeCode,
          window,
          transport,
          repository,
          clock,
          includeProducts,
          completedTradeDates,
          completedRegionDates,
        }));
      }
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
    || row.shopDaily?.ok === false
  )).length;
  const partialWindows = results.filter((row) => (
    row.sessionErrorCode
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
