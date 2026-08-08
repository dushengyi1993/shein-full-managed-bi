#!/usr/bin/env node

import process from 'node:process';

import {
  FULL_MANAGED_STORE_CODES,
  normalizeFullManagedStoreCode,
} from '../src/config/full-managed-stores.mjs';
import {
  assertAllowlistedFieldName,
  pickFieldsByAllowlist,
  scrubPiiText,
  validateOrderManagementRow,
} from '../src/order-management/order-management-contract.mjs';
import { createEncryptedWebApiSessionStoreFromEnvironment } from '../src/webapi-session/encrypted-session-store.mjs';
import {
  ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS,
  ORDER_MANAGEMENT_ENDPOINTS,
  ORDER_MANAGEMENT_MAX_PAGES,
  ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
  orderManagementRequestBody,
  orderManagementWindow,
} from '../src/webapi-history/order-management-contracts.mjs';
import {
  createOrderManagementHttpTransport,
  openOrderManagementHttpSession,
  orderManagementResponseReader,
} from '../src/webapi-session/order-management-http.mjs';
import { atomicWriteJson } from '../src/warehouse/dashboard-materializer.mjs';

const ROSTER = new Set(FULL_MANAGED_STORE_CODES);

/**
 * Strict YYYY-MM-DD calendar-date parse.  Returns the normalized text or
 * null so callers can fail closed with their own error codes.
 */
export function parseStrictIsoDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) return null;
  return text;
}

/**
 * The calendar date (YYYY-MM-DD) in Asia/Shanghai for an instant.  The
 * "future window" gate is defined against this calendar so it stays stable
 * no matter which timezone the host runs in.
 */
export function shanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).formatToParts(now);
  const field = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

export function parseArgs(argv, { now = new Date() } = {}) {
  const result = {
    stores: [],
    output: process.env.FULL_BI_ORDER_MANAGEMENT_SESSION_SNAPSHOT ?? null,
    windowDays: ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
    startDate: null,
    endDate: null,
    execute: false,
  };
  let windowDaysProvided = false;
  for (const token of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) throw new Error('ORDER_MANAGEMENT_SYNC_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'execute' && value === undefined) result.execute = true;
    else if (name === 'stores' && value) {
      result.stores = [...new Set(value.split(',').map((item) => item.trim().toUpperCase()))];
    } else if (name === 'output' && value) result.output = value;
    else if (name === 'start-date' && value) result.startDate = value;
    else if (name === 'end-date' && value) result.endDate = value;
    else if (name === 'window-days' && /^[1-9]$|^[12][0-9]$|^30$/.test(value ?? '')) {
      result.windowDays = Number(value);
      windowDaysProvided = true;
    } else throw new Error('ORDER_MANAGEMENT_SYNC_ARGUMENT_INVALID');
  }
  if (
    result.stores.length === 0
    || result.stores.some((store) => !normalizeFullManagedStoreCode(store))
  ) {
    throw new Error('ORDER_MANAGEMENT_SYNC_STORE_SCOPE_REQUIRED');
  }
  const rosterCovered = FULL_MANAGED_STORE_CODES.every((store) => result.stores.includes(store))
    && result.stores.every((store) => ROSTER.has(store));
  if (!rosterCovered) {
    throw new Error('ORDER_MANAGEMENT_SYNC_STORE_SCOPE_REQUIRED');
  }
  const hasStart = result.startDate !== null;
  const hasEnd = result.endDate !== null;
  if (hasStart !== hasEnd) throw new Error('ORDER_MANAGEMENT_SYNC_WINDOW_PAIR_REQUIRED');
  if (hasStart && windowDaysProvided) throw new Error('ORDER_MANAGEMENT_SYNC_WINDOW_CONFLICT');
  if (hasStart) {
    const start = parseStrictIsoDate(result.startDate);
    const end = parseStrictIsoDate(result.endDate);
    if (!start || !end || start > end) throw new Error('ORDER_MANAGEMENT_SYNC_WINDOW_INVALID');
    try {
      orderManagementWindow({
        startDate: start,
        endDate: end,
        maximumDays: ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
      });
    } catch {
      throw new Error('ORDER_MANAGEMENT_SYNC_WINDOW_INVALID');
    }
    if (end > shanghaiDate(now)) throw new Error('ORDER_MANAGEMENT_SYNC_WINDOW_FUTURE');
    result.startDate = start;
    result.endDate = end;
  }
  return result;
}

export function buildWindow({ days = ORDER_MANAGEMENT_WINDOW_MAX_DAYS, now = new Date() } = {}) {
  const end = new Date(now.getTime());
  const start = new Date(now.getTime());
  start.setDate(start.getDate() - (days - 1));
  const isoDate = (date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  return orderManagementWindow({
    startDate: isoDate(start),
    endDate: isoDate(end),
    maximumDays: days,
  });
}

function parseShanghaiDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return null;
  const date = new Date(`${text.replace(' ', 'T')}+08:00`);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function toNumber(value, { nonNegative = true } = {}) {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (nonNegative && parsed < 0) return null;
  return parsed;
}

function metricEntry(pageId, name, value, options) {
  assertAllowlistedFieldName(pageId, name);
  return Object.freeze({ name, value: toNumber(value, options) });
}

function factEntry(pageId, name, value) {
  assertAllowlistedFieldName(pageId, name);
  const text = scrubPiiText(value);
  if (text === null) return null;
  return Object.freeze({ name, value: text.slice(0, 512) });
}

function deriveWaybillStatus(waybill) {
  if (waybill.signTime) return Object.freeze({ code: 'SIGNED', name: '已签收' });
  if (waybill.pickupTime) return Object.freeze({ code: 'IN_TRANSIT', name: '运输中' });
  return Object.freeze({ code: 'PENDING_PICKUP', name: '待取件' });
}

function buildStockRecordRow(record, storeCode, fetchedAt) {
  const orderNo = String(record.orderNo ?? '').trim();
  if (!orderNo) return null;
  return Object.freeze({
    id: orderNo,
    storeCode,
    statusCode: String(record.applyStatus ?? '').trim() || null,
    statusName: null,
    createdAt: parseShanghaiDateTime(record.addTime),
    updatedAt: fetchedAt,
    primary: orderNo,
    secondary: String(record.orderModeValue ?? record.orderMode ?? '').trim() || null,
    tags: Object.freeze(['备货记录', record.stockType, record.orderSign].filter(Boolean)),
    metrics: Object.freeze([]),
    facts: Object.freeze([
      factEntry('stock-records', 'supplierCode', record.supplierCode),
      factEntry('stock-records', 'skc', record.skc),
      factEntry('stock-records', 'orderMode', record.orderMode),
      factEntry('stock-records', 'orderModeValue', record.orderModeValue),
      factEntry('stock-records', 'applyStatus', record.applyStatus),
      factEntry('stock-records', 'stockType', record.stockType),
      factEntry('stock-records', 'orderSign', record.orderSign),
      factEntry('stock-records', 'timezone', record.timezone),
      factEntry('stock-records', 'addTime', record.addTime),
    ].filter(Boolean)),
    details: Object.freeze([]),
  });
}

function buildWaybillRow(record, storeCode, fetchedAt) {
  const trackingNumber = String(record.trackingNumber ?? '').trim();
  if (!trackingNumber) return null;
  const status = deriveWaybillStatus(record);
  return Object.freeze({
    id: trackingNumber,
    storeCode,
    statusCode: status.code,
    statusName: status.name,
    createdAt: parseShanghaiDateTime(record.addTime),
    updatedAt: fetchedAt,
    primary: trackingNumber,
    secondary: String(record.combineNumber ?? '').trim() || null,
    tags: Object.freeze(['运单', record.waybillTypeSellerName, record.orderSystem, record.isFreeName].filter(Boolean)),
    metrics: Object.freeze([
      metricEntry('waybills', 'packQuantity', record.packQuantity),
      metricEntry('waybills', 'sendGoodsQuantity', record.sendGoodsQuantity),
      metricEntry('waybills', 'actualWeight', record.actualWeight),
      metricEntry('waybills', 'volumeWeight', record.volumeWeight),
      metricEntry('waybills', 'estimatedWeight', record.estimatedWeight),
      metricEntry('waybills', 'finalSettlementWeight', record.finalSettlementWeight),
      metricEntry('waybills', 'convertedFinalApportionment', record.convertedFinalApportionment),
      metricEntry('waybills', 'exemptionAmount', record.exemptionAmount),
      metricEntry('waybills', 'actualDeductionAmount', record.actualDeductionAmount),
      metricEntry('waybills', 'changedEstimatedApportionment', record.changedEstimatedApportionment),
      metricEntry('waybills', 'differenceDeductedAmount', record.differenceDeductedAmount),
    ].filter((entry) => entry.value !== null)),
    facts: Object.freeze([
      factEntry('waybills', 'logisticsCompanyName', record.logisticsCompanyName),
      factEntry('waybills', 'waybillTypeSellerName', record.waybillTypeSellerName),
      factEntry('waybills', 'orderTypeName', record.orderTypeName),
      factEntry('waybills', 'serviceModeCodeName', record.serviceModeCodeName),
      factEntry('waybills', 'supplierCurrencyName', record.supplierCurrencyName),
      factEntry('waybills', 'collectBatchNo', record.collectBatchNo),
      factEntry('waybills', 'apportionmentState', record.apportionmentState),
      factEntry('waybills', 'supplierTitle', record.supplierTitle),
      factEntry('waybills', 'rightsResultTypeName', record.rightsResultTypeName),
      factEntry('waybills', 'syStatusName', record.syStatusName),
    ].filter(Boolean)),
    details: Object.freeze([]),
  });
}

async function fetchPageRows(transport, endpointCode, { window, maxPages }) {
  const endpoint = ORDER_MANAGEMENT_ENDPOINTS[endpointCode];
  const failures = [];
  const rows = [];
  let total = null;
  let pagesFetched = 0;
  let lastPageLength = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const body = Object.freeze({
      ...orderManagementRequestBody(endpointCode, { window }),
      [endpoint.pageKey]: page,
      [endpoint.pageSizeKey]: endpoint.defaultPageSize,
    });
    let response;
    try {
      response = await transport.fetch(endpointCode, body);
    } catch (error) {
      failures.push(`PAGE_${page}_FETCH_FAILED:${String(error?.code ?? error?.message ?? 'UNKNOWN')}`);
      break;
    }
    const reader = orderManagementResponseReader(endpointCode, response);
    total = reader.total;
    if (!Array.isArray(reader.rows)) {
      failures.push(`PAGE_${page}_ROWS_PATH_MISSING`);
      break;
    }
    rows.push(...reader.rows);
    pagesFetched += 1;
    lastPageLength = reader.rows.length;
    if (reader.rows.length < endpoint.defaultPageSize) break;
  }
  const reachedTotal = total !== null && rows.length >= total;
  const naturalEnd = pagesFetched > 0 && lastPageLength < endpoint.defaultPageSize;
  if (pagesFetched === 0 || (!naturalEnd && !reachedTotal)) {
    failures.push('PAGING_INCOMPLETE');
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    total,
    pagesFetched,
    failures: Object.freeze(failures),
  });
}

function storePageGates(page) {
  const ids = page.rows
    .map((record) => record.id ?? record.trackingNumber ?? record.orderNo ?? null)
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value));
  const dedupeVerified = new Set(ids).size === ids.length;
  const totalVerified = page.total !== null;
  const pagingVerified = page.pagesFetched > 0 && page.failures.length === 0;
  const ok = totalVerified && pagingVerified && dedupeVerified;
  return Object.freeze({
    ok,
    totalVerified,
    pagingVerified,
    dedupeVerified,
  });
}

async function syncOneStore(transport, storeCode, { window, maxPages, includeStatistics = true }) {
  const stock = await fetchPageRows(transport, 'STOCK_RECORDS_LIST', { window, maxPages });
  const waybills = await fetchPageRows(transport, 'WAYBILLS_PAGE', { window, maxPages });
  const statistics = [];
  if (includeStatistics) {
    for (const statisticsType of ORDER_MANAGEMENT_ENDPOINTS.WAYBILLS_STATISTICS.statisticsTypes) {
      const body = Object.freeze({
        ...orderManagementRequestBody('WAYBILLS_STATISTICS', { window }),
        statisticsType,
      });
      try {
        const response = await transport.fetch('WAYBILLS_STATISTICS', body);
        const value = response?.body?.info;
        statistics.push(Object.freeze({
          statisticsType,
          value: typeof value === 'string' || typeof value === 'number' ? value : null,
        }));
      } catch (error) {
        statistics.push(Object.freeze({
          statisticsType,
          value: null,
          errorCode: String(error?.code ?? error?.message ?? 'STATISTICS_FETCH_FAILED'),
        }));
      }
    }
  }
  return Object.freeze({
    stock: Object.freeze({ ...stock, gates: storePageGates(stock) }),
    waybills: Object.freeze({ ...waybills, gates: storePageGates(waybills) }),
    statistics: Object.freeze(statistics),
  });
}

function buildPageRows(pageId, recordsByStore, storeCodes, buildRow, fetchedAt) {
  const rows = [];
  for (const storeCode of storeCodes) {
    const allowlist = endpointAllowlistFor(pageId);
    for (const record of recordsByStore.get(storeCode) ?? []) {
      const row = buildRow(pickFieldsByAllowlist(allowlist, record), storeCode, fetchedAt);
      if (row === null) continue;
      const check = validateOrderManagementRow(row, { pageId });
      if (!check.ok) {
        throw new TypeError(`ORDER_MANAGEMENT_SYNC_ROW_INVALID ${storeCode}: ${check.errors[0]}`);
      }
      rows.push(row);
    }
  }
  return rows;
}

function endpointAllowlistFor(pageId) {
  if (pageId === 'stock-records') return ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.STOCK_RECORDS_LIST;
  if (pageId === 'waybills') return ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.WAYBILLS_PAGE;
  throw new TypeError(`ORDER_MANAGEMENT_SYNC_PAGE_UNKNOWN: ${pageId}`);
}

export async function runOrderManagementSessionSync({
  storeCodes,
  output,
  windowDays = ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
  window = null,
  includeStatistics = true,
  sessionStore,
  openSession = ({ storeCode }) => openOrderManagementHttpSession({ storeCode, sessionStore }),
  now = new Date(),
  maxPages = ORDER_MANAGEMENT_MAX_PAGES,
} = {}) {
  const roster = [...FULL_MANAGED_STORE_CODES];
  const boundedWindow = window
    ? orderManagementWindow({
        startDate: window.startDate,
        endDate: window.endDate,
        maximumDays: windowDays,
      })
    : buildWindow({ days: windowDays, now });
  if (window && boundedWindow.endDate > shanghaiDate(now)) {
    throw new Error('ORDER_MANAGEMENT_SYNC_WINDOW_FUTURE');
  }
  const perStore = [];
  const rawByStore = {
    'stock-records': new Map(),
    waybills: new Map(),
  };
  for (const storeCode of storeCodes) {
    const session = await openSession({ storeCode });
    const transport = createOrderManagementHttpTransport({ session });
    try {
      const result = await syncOneStore(transport, storeCode, {
        window: boundedWindow,
        maxPages,
        includeStatistics,
      });
      rawByStore['stock-records'].set(storeCode, result.stock.rows);
      rawByStore.waybills.set(storeCode, result.waybills.rows);
      perStore.push(Object.freeze({
        storeCode,
        ok: result.stock.gates.ok && result.waybills.gates.ok,
        pages: Object.freeze({
          'stock-records': result.stock.gates,
          waybills: result.waybills.gates,
        }),
        statistics: result.statistics,
      }));
    } finally {
      await transport.close();
    }
  }

  const fetchedAt = now.toISOString();
  const pages = {};
  for (const [pageId, endpointCode] of [
    ['stock-records', 'STOCK_RECORDS_LIST'],
    ['waybills', 'WAYBILLS_PAGE'],
  ]) {
    const okStores = perStore
      .filter((entry) => entry.pages[pageId].ok)
      .map((entry) => entry.storeCode)
      .sort();
    const gates = {
      totalVerified: okStores.length === roster.length
        && okStores.every((store) => perStore.find((entry) => entry.storeCode === store).pages[pageId].totalVerified),
      pagingVerified: okStores.length === roster.length
        && okStores.every((store) => perStore.find((entry) => entry.storeCode === store).pages[pageId].pagingVerified),
      dedupeVerified: okStores.length === roster.length
        && okStores.every((store) => perStore.find((entry) => entry.storeCode === store).pages[pageId].dedupeVerified),
      storeCount: okStores.length,
    };
    const failedStores = perStore
      .filter((entry) => !entry.pages[pageId].ok)
      .map((entry) => `${entry.storeCode}:GATE_FAILED`);
    const rows = pageId === 'stock-records'
      ? buildPageRows(pageId, rawByStore[pageId], okStores, buildStockRecordRow, fetchedAt)
      : buildPageRows(pageId, rawByStore[pageId], okStores, buildWaybillRow, fetchedAt);
    const status = okStores.length === roster.length
      && gates.totalVerified && gates.pagingVerified && gates.dedupeVerified
      ? 'AVAILABLE'
      : okStores.length === 0
        ? 'UNAVAILABLE'
        : 'PARTIAL';
    pages[pageId] = Object.freeze({
      status,
      source: 'SESSION_HTTP',
      latestSourceFetchedAt: fetchedAt,
      reason: status === 'AVAILABLE'
        ? null
        : `SESSION_GATE_FAILED: ${failedStores.join('; ') || 'NO_STORE_SUCCEEDED'} (endpoint ${endpointCode})`,
      storeCodes: Object.freeze(okStores),
      gates: Object.freeze(gates),
      rows: Object.freeze(rows),
    });
  }

  const snapshot = Object.freeze({
    schemaVersion: 1,
    updatedAt: fetchedAt,
    roster: Object.freeze(roster),
    window: Object.freeze(boundedWindow),
    pages: Object.freeze(pages),
    evidence: Object.freeze({
      perStore: Object.freeze(perStore),
    }),
  });
  const written = await atomicWriteJson(output, snapshot);
  return Object.freeze({ snapshot, written });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.execute) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'DRY_RUN',
      stores: [...FULL_MANAGED_STORE_CODES],
      windowDays: args.windowDays,
      window: args.startDate
        ? { startDate: args.startDate, endDate: args.endDate }
        : buildWindow({ days: args.windowDays }),
      maxPages: ORDER_MANAGEMENT_MAX_PAGES,
      endpoints: Object.keys(ORDER_MANAGEMENT_ENDPOINTS),
      output: args.output,
    }, null, 2));
    return;
  }
  if (!args.output) throw new Error('ORDER_MANAGEMENT_SYNC_OUTPUT_REQUIRED');
  const sessionStore = await createEncryptedWebApiSessionStoreFromEnvironment();
  const result = await runOrderManagementSessionSync({
    storeCodes: args.stores,
    output: args.output,
    windowDays: args.windowDays,
    window: args.startDate ? { startDate: args.startDate, endDate: args.endDate } : undefined,
    sessionStore,
  });
  console.log(JSON.stringify({
    ok: true,
    output: result.written,
    updatedAt: result.snapshot.updatedAt,
    pages: Object.fromEntries(
      Object.entries(result.snapshot.pages).map(([pageId, page]) => [
        pageId,
        { status: page.status, rows: page.rows.length, gates: page.gates, reason: page.reason },
      ]),
    ),
  }, null, 2));
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/sync_full_managed_order_management_sessions.mjs')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Order-management session sync failed.');
    process.exitCode = 1;
  });
}
