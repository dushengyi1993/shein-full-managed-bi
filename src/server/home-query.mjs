const STORE_PATTERN = /^[A-Z0-9_-]{1,24}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const PRODUCT_LIMIT = 24;

export class HomeQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HomeQueryError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new HomeQueryError(code, message);
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function textParam(params, name, maximum, fallback = '') {
  const values = params.getAll(name);
  if (values.length > 1) fail('QUERY_PARAMETER_DUPLICATED', `参数 ${name} 不能重复`);
  if (!values.length) return fallback;
  const value = values[0].trim();
  if (value.length > maximum) fail('QUERY_PARAMETER_TOO_LONG', `参数 ${name} 过长`);
  return value;
}

function dateValue(params, name) {
  const value = textParam(params, name, 10);
  if (!DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    fail('QUERY_DATE_INVALID', `参数 ${name} 必须是有效日期`);
  }
  return value;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function spanDays(start, end) {
  return Math.round(
    (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000,
  ) + 1;
}

function sourceFreshness(inputRows) {
  const sourceRows = rows(inputRows);
  let businessDate = null;
  let observedAt = null;
  for (const row of sourceRows) {
    const rowDate = String(row?.date || '');
    if (DATE_PATTERN.test(rowDate) && (!businessDate || rowDate > businessDate)) {
      businessDate = rowDate;
    }
    const rowObservedAt = String(row?.observedAt || '');
    if (rowObservedAt && (!observedAt || rowObservedAt > observedAt)) {
      observedAt = rowObservedAt;
    }
  }
  return Object.freeze({
    businessDate,
    observedAt,
  });
}

function searchable(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function productSearchText(row) {
  return searchable([
    row.productKey,
    row.platformSpuId,
    row.platformSkcId,
    row.platformSkuId,
    row.supplierCode,
    row.supplierSku,
    row.displayName,
    row.storeCode,
  ].filter(Boolean).join(' '));
}

function allowedStoreCodes(dashboard, owner, store, query) {
  const ownerNamesByStore = new Map();
  for (const ownerRow of rows(dashboard.owners)) {
    for (const code of rows(ownerRow.storeCodes)) {
      const normalizedCode = String(code).toUpperCase();
      const names = ownerNamesByStore.get(normalizedCode) || [];
      names.push(ownerRow.name, ownerRow.key);
      ownerNamesByStore.set(normalizedCode, names);
    }
  }
  const stores = rows(dashboard.storeRanking).map((item) => ({
    code: String(item.code || '').toUpperCase(),
    name: item.name || item.code || '',
    ownerNames: ownerNamesByStore.get(String(item.code || '').toUpperCase()) || [],
  })).filter(({ code }) => STORE_PATTERN.test(code));
  let codes = new Set(stores.map(({ code }) => code));

  if (owner !== 'ALL') {
    const ownerRow = rows(dashboard.owners).find(({ key }) => String(key) === owner);
    if (!ownerRow) fail('QUERY_OWNER_UNKNOWN', '负责人不在当前数据范围内');
    const ownerCodes = new Set(rows(ownerRow.storeCodes).map((code) => String(code).toUpperCase()));
    codes = new Set([...codes].filter((code) => ownerCodes.has(code)));
  }
  if (store !== 'ALL') {
    if (!STORE_PATTERN.test(store) || !codes.has(store)) {
      fail('QUERY_STORE_UNKNOWN', '店铺不在当前数据范围内');
    }
    codes = new Set([store]);
  }

  const matchedBySearch = query
    ? new Set(stores.filter(({ code, name, ownerNames }) => (
      searchable(`${code} ${name} ${ownerNames.join(' ')}`).includes(query)
    ))
      .map(({ code }) => code))
    : new Set();
  return { codes, matchedBySearch };
}

function topProductKeys(inputRows, limit = PRODUCT_LIMIT) {
  const grouped = new Map();
  for (const row of inputRows) {
    const key = `${row.storeCode}:${row.productKey}`;
    const item = grouped.get(key) || { income: 0, net: 0, goods: 0 };
    if (typeof row.incomeAmount === 'number' && Number.isFinite(row.incomeAmount)) {
      item.income += row.incomeAmount;
    }
    if (typeof row.netAmount === 'number' && Number.isFinite(row.netAmount)) {
      item.net += row.netAmount;
    }
    if (Number.isSafeInteger(row.goodsCount) && row.goodsCount >= 0) item.goods += row.goodsCount;
    grouped.set(key, item);
  }
  const byIncome = [...grouped].sort((left, right) => right[1].income - left[1].income);
  const byNet = [...grouped].sort((left, right) => right[1].net - left[1].net);
  const byGoods = [...grouped].sort((left, right) => right[1].goods - left[1].goods);
  return new Set([
    ...byIncome.slice(0, limit).map(([key]) => key),
    ...byNet.slice(0, limit).map(([key]) => key),
    ...byGoods.slice(0, limit).map(([key]) => key),
  ]);
}

function topProductDailyKeys(inputRows, limit = PRODUCT_LIMIT) {
  const grouped = new Map();
  for (const row of inputRows) {
    const key = `${row.storeCode}:${row.productGrain}:${row.productKey}`;
    const current = grouped.get(key) || { quantity: 0, amount: 0, hasAmount: false };
    if (Number.isSafeInteger(row.salesQuantity) && row.salesQuantity >= 0) {
      current.quantity += row.salesQuantity;
    }
    if (typeof row.estimatedDealAmount === 'number' && Number.isFinite(row.estimatedDealAmount)) {
      current.amount += row.estimatedDealAmount;
      current.hasAmount = true;
    }
    grouped.set(key, current);
  }
  const ranked = [...grouped];
  const byQuantity = ranked
    .sort((left, right) => right[1].quantity - left[1].quantity)
    .slice(0, limit)
    .map(([key]) => key);
  const byAmount = ranked.some(([, value]) => value.hasAmount)
    ? [...ranked]
      .sort((left, right) => right[1].amount - left[1].amount)
      .slice(0, limit)
      .map(([key]) => key)
    : [];
  return new Set([...byQuantity, ...byAmount]);
}

function topRegionKeys(inputRows, limit = 4) {
  const grouped = new Map();
  for (const row of inputRows) {
    const key = `${row.regionKey}:${row.regionName}`;
    const current = grouped.get(key) || 0;
    if (Number.isSafeInteger(row.salesQuantity) && row.salesQuantity >= 0) {
      grouped.set(key, current + row.salesQuantity);
    } else if (!grouped.has(key)) {
      grouped.set(key, current);
    }
  }
  return new Set([...grouped]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([key]) => key));
}

function projectLedgerRow(row) {
  return Object.freeze({
    storeCode: row.storeCode,
    date: row.date,
    currency: row.currency ?? null,
    beginBalanceCount: row.beginBalanceCount ?? null,
    inboundCount: row.inboundCount ?? null,
    outboundCount: row.outboundCount ?? null,
    endBalanceCount: row.endBalanceCount ?? null,
    urgentOrderEntryCount: row.urgentOrderEntryCount ?? null,
    prepareOrderEntryCount: row.prepareOrderEntryCount ?? null,
    customerOutboundCount: row.customerOutboundCount ?? null,
    beginBalanceAmount: row.beginBalanceAmount ?? null,
    inboundAmount: row.inboundAmount ?? null,
    outboundAmount: row.outboundAmount ?? null,
    endBalanceAmount: row.endBalanceAmount ?? null,
    observedAt: row.observedAt ?? null,
    qualityStatus: row.qualityStatus ?? null,
    basis: row.basis ?? null,
  });
}

export function queryHomeDashboard(
  dashboardValue,
  historyValue,
  paramsValue = new URLSearchParams(),
) {
  const dashboard = record(dashboardValue);
  const historyEnvelope = record(historyValue);
  const history = record(historyEnvelope.home ?? historyEnvelope);
  const params = paramsValue instanceof URLSearchParams
    ? paramsValue
    : new URLSearchParams(paramsValue);
  const start = dateValue(params, 'start');
  const end = dateValue(params, 'end');
  if (start > end) fail('QUERY_DATE_RANGE_INVALID', '开始日期不能晚于结束日期');
  const days = spanDays(start, end);
  if (days > MAX_RANGE_DAYS) fail('QUERY_DATE_RANGE_TOO_LARGE', '单次最多查询 366 天');

  const owner = textParam(params, 'owner', 64, 'ALL') || 'ALL';
  const rawStore = textParam(params, 'store', 24, 'ALL') || 'ALL';
  const store = rawStore.toUpperCase();
  const rawQuery = textParam(params, 'q', 120);
  const query = searchable(rawQuery);
  const previousStart = shiftDate(start, -days);
  const previousEnd = shiftDate(start, -1);
  const { codes, matchedBySearch } = allowedStoreCodes(dashboard, owner, store, query);
  const effectiveCodes = query && matchedBySearch.size > 0
    ? new Set([...codes].filter((code) => matchedBySearch.has(code)))
    : codes;
  const dateMatches = ({ date }) => (
    typeof date === 'string'
    && date >= previousStart
    && date <= end
  );
  const storeMatches = ({ storeCode }) => effectiveCodes.has(String(storeCode));
  const baseStoreMatches = ({ storeCode }) => codes.has(String(storeCode));

  const storeDaily = rows(history.storeDaily).filter(dateMatches).filter(storeMatches);
  const productDailyCandidates = rows(history.productDaily)
    .filter(dateMatches)
    .filter(baseStoreMatches);
  const scopedProductDaily = query && matchedBySearch.size === 0
    ? productDailyCandidates.filter((row) => productSearchText(row).includes(query))
    : productDailyCandidates.filter(storeMatches);
  const retainedProductDailyKeys = topProductDailyKeys(scopedProductDaily);
  const productDaily = scopedProductDaily.filter((row) => retainedProductDailyKeys.has(
    `${row.storeCode}:${row.productGrain}:${row.productKey}`,
  ));
  const regionDailyCandidates = rows(history.regionDaily).filter(dateMatches).filter(storeMatches);
  const retainedRegionKeys = topRegionKeys(regionDailyCandidates);
  const regionDaily = regionDailyCandidates.filter((row) => retainedRegionKeys.has(
    `${row.regionKey}:${row.regionName}`,
  ));
  const financeDaily = rows(history.financeDaily).filter(dateMatches).filter(storeMatches);
  const ledgerDaily = rows(history.ledgerDaily)
    .filter(dateMatches)
    .filter(storeMatches)
    .map(projectLedgerRow);
  const billDaily = rows(history.billDaily).filter(dateMatches).filter(storeMatches);
  let productFinanceCandidates = rows(history.productFinanceDaily)
    .filter(dateMatches)
    .filter(baseStoreMatches);
  if (query && matchedBySearch.size === 0) {
    productFinanceCandidates = productFinanceCandidates
      .filter((row) => productSearchText(row).includes(query));
  } else {
    productFinanceCandidates = productFinanceCandidates.filter(storeMatches);
  }
  const retainedProductKeys = topProductKeys(productFinanceCandidates);
  const productFinanceDaily = productFinanceCandidates.filter(
    (row) => retainedProductKeys.has(`${row.storeCode}:${row.productKey}`),
  );
  const countWindowRows = (inputRows, windowStart, windowEnd) => (
    inputRows.filter(({ date }) => (
      typeof date === 'string'
      && date >= windowStart
      && date <= windowEnd
    )).length
  );
  const returnedRows = {
    storeDaily: storeDaily.length,
    productDaily: productDaily.length,
    regionDaily: regionDaily.length,
    financeDaily: financeDaily.length,
    ledgerDaily: ledgerDaily.length,
    billDaily: billDaily.length,
    productFinanceDaily: productFinanceDaily.length,
  };
  const returnedCurrentRows = {
    storeDaily: countWindowRows(storeDaily, start, end),
    productDaily: countWindowRows(productDaily, start, end),
    regionDaily: countWindowRows(regionDaily, start, end),
    financeDaily: countWindowRows(financeDaily, start, end),
    ledgerDaily: countWindowRows(ledgerDaily, start, end),
    billDaily: countWindowRows(billDaily, start, end),
    productFinanceDaily: countWindowRows(productFinanceDaily, start, end),
  };
  const returnedComparisonRows = {
    storeDaily: countWindowRows(storeDaily, previousStart, previousEnd),
    productDaily: countWindowRows(productDaily, previousStart, previousEnd),
    regionDaily: countWindowRows(regionDaily, previousStart, previousEnd),
    financeDaily: countWindowRows(financeDaily, previousStart, previousEnd),
    ledgerDaily: countWindowRows(ledgerDaily, previousStart, previousEnd),
    billDaily: countWindowRows(billDaily, previousStart, previousEnd),
    productFinanceDaily: countWindowRows(productFinanceDaily, previousStart, previousEnd),
  };

  return Object.freeze({
    schemaVersion: 1,
    readOnly: true,
    query: Object.freeze({
      start,
      end,
      previousStart,
      previousEnd,
      owner,
      store,
      q: rawQuery,
    }),
    source: Object.freeze({
      dashboardUpdatedAt: dashboard.updatedAt ?? historyEnvelope.updatedAt ?? null,
      latestAvailableDate: record(history.coverage).latestDate ?? null,
      productLimitPerMetric: PRODUCT_LIMIT,
      rows: Object.freeze({
        storeDaily: rows(history.storeDaily).length,
        productDaily: rows(history.productDaily).length,
        regionDaily: rows(history.regionDaily).length,
        financeDaily: rows(history.financeDaily).length,
        ledgerDaily: rows(history.ledgerDaily).length,
        billDaily: rows(history.billDaily).length,
        productFinanceDaily: rows(history.productFinanceDaily).length,
      }),
      returnedRows: Object.freeze(returnedRows),
      returnedCurrentRows: Object.freeze(returnedCurrentRows),
      returnedComparisonRows: Object.freeze(returnedComparisonRows),
      freshness: Object.freeze({
        operating: sourceFreshness(history.storeDaily),
        finance: sourceFreshness(history.financeDaily),
        ledger: sourceFreshness(history.ledgerDaily),
        settlement: sourceFreshness(history.billDaily),
      }),
    }),
    home: Object.freeze({
      status: history.status || 'unavailable',
      storeDaily: Object.freeze(storeDaily),
      productDaily: Object.freeze(productDaily),
      regionDaily: Object.freeze(regionDaily),
      financeDaily: Object.freeze(financeDaily),
      ledgerDaily: Object.freeze(ledgerDaily),
      billDaily: Object.freeze(billDaily),
      productFinanceDaily: Object.freeze(productFinanceDaily),
      coverage: Object.freeze(record(history.coverage)),
    }),
  });
}
