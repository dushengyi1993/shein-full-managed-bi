const STORE_PATTERN = /^[A-Z0-9]{2,12}$/;
const OWNER_PATTERN = /^[\p{L}\p{N}._:-]{1,64}$/u;
const INTEGER_PATTERN = /^[1-9][0-9]*$/;
const QUERY_PARAMETERS = Object.freeze(new Set([
  'owner',
  'store',
  'q',
  'quick',
  'inventoryType',
  'inventorySort',
  'adviceSort',
  'inventoryPage',
  'advicePage',
  'pageSize',
]));

const QUICK_FILTERS = Object.freeze([
  'ALL',
  'HIGH',
  'SHORTAGE',
  'RECONCILIATION',
  'URGENT',
  'ADVICE',
  'WARNING',
]);

/** Quick filters that can narrow each list. Others stay a no-op for that list
 * so the inactive tab keeps an honest matched count instead of a false zero. */
const INVENTORY_QUICK = Object.freeze(['HIGH', 'SHORTAGE', 'RECONCILIATION']);
const ADVICE_QUICK = Object.freeze(['HIGH', 'URGENT', 'ADVICE', 'WARNING']);

const INVENTORY_TYPES = Object.freeze(['ALL', 'PI', 'JI', 'VI']);

const INVENTORY_SORTS = Object.freeze([
  'PRIORITY',
  'SHORTAGE_DESC',
  'USABLE_ASC',
  'FRESHNESS_DESC',
]);

const ADVICE_SORTS = Object.freeze([
  'PRIORITY',
  'URGENT_DESC',
  'ADVICE_DESC',
  'DAILY_SALES_DESC',
  'FRESHNESS_DESC',
]);

const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const SEVERITY_RANK = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
});

export class InventoryQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InventoryQueryError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new InventoryQueryError(code, message);
}

function assertKnownParameters(params) {
  for (const name of params.keys()) {
    if (!QUERY_PARAMETERS.has(name)) {
      fail('QUERY_PARAMETER_UNKNOWN', `不支持参数 ${name}`);
    }
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function textParam(params, name, { maximum, pattern, fallback = '' } = {}) {
  const values = params.getAll(name);
  if (values.length > 1) fail('QUERY_PARAMETER_DUPLICATED', `参数 ${name} 不能重复`);
  if (values.length === 0) return fallback;
  const value = values[0].trim();
  if (value.length > maximum) fail('QUERY_PARAMETER_TOO_LONG', `参数 ${name} 过长`);
  if (pattern && value !== '' && !pattern.test(value)) {
    fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  }
  return value;
}

function enumParam(params, name, allowed, fallback) {
  const value = textParam(params, name, { maximum: 40, fallback }).toUpperCase();
  if (!allowed.includes(value)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  return value;
}

function integerParam(params, name, { fallback, minimum, maximum }) {
  const value = textParam(params, name, { maximum: 8, fallback: String(fallback) });
  if (!INTEGER_PATTERN.test(value)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 必须是整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('QUERY_PARAMETER_OUT_OF_RANGE', `参数 ${name} 超出范围`);
  }
  return parsed;
}

function searchable(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function isUnit(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isDecimal(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function containsQuery(row, query) {
  if (query === '') return true;
  return [
    row.storeCode,
    row.storeName,
    row.skuCode,
    row.skcName,
    row.spuName,
    row.supplierCode,
    row.inventoryTypeCode,
    row.reconciliationStatus,
    row.supplyStatusCode,
  ].some((value) => searchable(value).includes(query));
}

function ownerStoreSet(dashboard, ownerKey) {
  if (ownerKey === 'ALL') return null;
  const owner = rows(dashboard.owners).find((item) => item.key === ownerKey);
  if (!owner) fail('QUERY_OWNER_UNKNOWN', '负责人不在当前数据范围内');
  return new Set(rows(owner.storeCodes).map((code) => String(code).toUpperCase()));
}

function knownStoreCodes(dashboard, supply) {
  const codes = new Set();
  for (const owner of rows(dashboard.owners)) {
    for (const code of rows(owner.storeCodes)) {
      const normalized = String(code).toUpperCase();
      if (STORE_PATTERN.test(normalized)) codes.add(normalized);
    }
  }
  for (const row of rows(dashboard.storeRanking)) {
    const normalized = String(row?.code ?? '').toUpperCase();
    if (STORE_PATTERN.test(normalized)) codes.add(normalized);
  }
  for (const key of ['inventory', 'stockAdvice', 'inventoryRisks', 'stockAdviceRisks']) {
    for (const row of rows(supply[key])) {
      const normalized = String(row?.storeCode ?? '').toUpperCase();
      if (STORE_PATTERN.test(normalized)) codes.add(normalized);
    }
  }
  return codes;
}

function matchesScope(row, { store, ownerStores }) {
  const storeCode = String(row.storeCode ?? '').toUpperCase();
  if (store !== 'ALL' && storeCode !== store) return false;
  return ownerStores === null || ownerStores.has(storeCode);
}

function severityRank(value) {
  return SEVERITY_RANK[String(value ?? '').toLowerCase()] ?? 0;
}

function isReconciliationMismatch(row) {
  const status = String(row.reconciliationStatus ?? '').toUpperCase();
  if (status === '') return false;
  return !/^(MATCH|MATCHED|RECONCILED|OK|CONSISTENT|BALANCED)$/.test(status);
}

function matchesInventoryQuick(row, quick) {
  if (!INVENTORY_QUICK.includes(quick)) return true;
  if (quick === 'HIGH') return severityRank(row.severity) >= SEVERITY_RANK.high;
  if (quick === 'SHORTAGE') return isUnit(row.shortageQuantity) && row.shortageQuantity > 0;
  return isReconciliationMismatch(row);
}

function matchesAdviceQuick(row, quick) {
  if (!ADVICE_QUICK.includes(quick)) return true;
  if (quick === 'HIGH') return severityRank(row.severity) >= SEVERITY_RANK.high;
  if (quick === 'URGENT') {
    return isUnit(row.plannedUrgentQuantity) && row.plannedUrgentQuantity > 0;
  }
  if (quick === 'ADVICE') {
    return isUnit(row.advisedOrderQuantity) && row.advisedOrderQuantity > 0;
  }
  return row.stockWarningIsWarning === true;
}

function comparableInstant(value, fallback) {
  const parsed = value ? new Date(value).valueOf() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN');
}

/** Known values always rank ahead of unknown ones in a descending sort. */
function rankDesc(value) {
  return isDecimal(value) ? value : -1;
}

/** Unknown values sort last in an ascending sort instead of posing as zero. */
function rankAsc(value) {
  return isDecimal(value) ? value : Number.POSITIVE_INFINITY;
}

function tieBreak(left, right) {
  return (
    compareText(left.storeCode, right.storeCode)
    || compareText(left.skuCode, right.skuCode)
    || compareText(left.inventoryTypeCode, right.inventoryTypeCode)
  );
}

function compareInventory(sort) {
  return (left, right) => {
    if (sort === 'SHORTAGE_DESC') {
      const delta = rankDesc(right.shortageQuantity) - rankDesc(left.shortageQuantity);
      if (delta !== 0) return delta;
    } else if (sort === 'USABLE_ASC') {
      const leftValue = rankAsc(left.usableInventory);
      const rightValue = rankAsc(right.usableInventory);
      // Both unknown: neither row may claim a lower usable inventory.
      if (Number.isFinite(leftValue) || Number.isFinite(rightValue)) {
        if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
      }
    } else if (sort === 'FRESHNESS_DESC') {
      const delta = (
        comparableInstant(right.latestSourceFetchedAt, Number.NEGATIVE_INFINITY)
        - comparableInstant(left.latestSourceFetchedAt, Number.NEGATIVE_INFINITY)
      );
      if (delta !== 0) return delta;
    } else {
      const delta = severityRank(right.severity) - severityRank(left.severity);
      if (delta !== 0) return delta;
      const shortage = rankDesc(right.shortageQuantity) - rankDesc(left.shortageQuantity);
      if (shortage !== 0) return shortage;
    }
    return tieBreak(left, right);
  };
}

function compareAdvice(sort) {
  return (left, right) => {
    if (sort === 'URGENT_DESC') {
      const delta = rankDesc(right.plannedUrgentQuantity)
        - rankDesc(left.plannedUrgentQuantity);
      if (delta !== 0) return delta;
    } else if (sort === 'ADVICE_DESC') {
      const delta = rankDesc(right.advisedOrderQuantity)
        - rankDesc(left.advisedOrderQuantity);
      if (delta !== 0) return delta;
    } else if (sort === 'DAILY_SALES_DESC') {
      const delta = rankDesc(right.predictedDailySales) - rankDesc(left.predictedDailySales);
      if (delta !== 0) return delta;
    } else if (sort === 'FRESHNESS_DESC') {
      const delta = (
        comparableInstant(right.latestSourceFetchedAt, Number.NEGATIVE_INFINITY)
        - comparableInstant(left.latestSourceFetchedAt, Number.NEGATIVE_INFINITY)
      );
      if (delta !== 0) return delta;
    } else {
      const delta = severityRank(right.severity) - severityRank(left.severity);
      if (delta !== 0) return delta;
      const urgent = rankDesc(right.plannedUrgentQuantity)
        - rankDesc(left.plannedUrgentQuantity);
      if (urgent !== 0) return urgent;
      const advised = rankDesc(right.advisedOrderQuantity)
        - rankDesc(left.advisedOrderQuantity);
      if (advised !== 0) return advised;
    }
    return tieBreak(left, right);
  };
}

function paginate(inputRows, page, pageSize) {
  const count = inputRows.length;
  const pageCount = count === 0 ? 0 : Math.ceil(count / pageSize);
  const offset = (page - 1) * pageSize;
  return {
    rows: inputRows.slice(offset, offset + pageSize),
    pagination: {
      page,
      pageSize,
      pageCount,
      matchedMaterializedRows: count,
      hasPrevious: page > 1,
      hasNext: page < pageCount,
    },
  };
}

function safeMeta(value) {
  const source = record(value);
  return {
    available: source.available === true,
    total: isUnit(source.total) ? source.total : null,
    returned: isUnit(source.returned) ? source.returned : null,
    truncated: source.truncated === true,
  };
}

/**
 * Sum one field without turning unknown into zero.
 *
 * `total` stays null while any matched row is unknown; `knownCount` and
 * `unknownCount` let the page explain why.
 */
function nullableMetric(inputRows, field, { decimal = false } = {}) {
  const known = inputRows.filter((row) => (
    decimal ? isDecimal(row[field]) : isUnit(row[field])
  ));
  const unknownCount = inputRows.length - known.length;
  const knownSum = known.reduce((sum, row) => sum + row[field], 0);
  const positiveRows = known.filter((row) => row[field] > 0);
  return {
    rowCount: inputRows.length,
    knownCount: known.length,
    unknownCount,
    knownSum: known.length === 0 ? null : knownSum,
    total: inputRows.length > 0 && unknownCount === 0 ? knownSum : null,
    positiveRowCount: positiveRows.length,
    affectedStoreCount: new Set(
      positiveRows.map((row) => row.storeCode).filter(Boolean),
    ).size,
  };
}

function countBy(inputRows, resolve) {
  const counts = new Map();
  for (const row of inputRows) {
    const key = resolve(row);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => compareText(left, right))
    .map(([code, count]) => ({ code, count }));
}

function severityCounts(inputRows) {
  // Keys come only from the frozen SEVERITIES allow-list, so a plain object
  // stays safe and serializes with a predictable prototype.
  const counts = {};
  for (const severity of SEVERITIES) counts[severity] = 0;
  for (const row of inputRows) {
    const severity = String(row.severity ?? '').toLowerCase();
    if (Object.hasOwn(counts, severity)) counts[severity] += 1;
  }
  return counts;
}

function latestInstant(inputRows) {
  const values = inputRows
    .map((row) => comparableInstant(row.latestSourceFetchedAt, Number.NaN))
    .filter(Number.isFinite);
  return values.length === 0 ? null : new Date(Math.max(...values)).toISOString();
}

function storeOptions(dashboard, supply) {
  const names = new Map();
  for (const key of ['inventory', 'stockAdvice', 'inventoryRisks', 'stockAdviceRisks']) {
    for (const row of rows(supply[key])) {
      const code = String(row?.storeCode ?? '').toUpperCase();
      if (!STORE_PATTERN.test(code)) continue;
      if (!names.has(code)) names.set(code, row.storeName || code);
    }
  }
  for (const owner of rows(dashboard.owners)) {
    for (const code of rows(owner.storeCodes)) {
      const normalized = String(code).toUpperCase();
      if (STORE_PATTERN.test(normalized) && !names.has(normalized)) {
        names.set(normalized, normalized);
      }
    }
  }
  return [...names].sort(([left], [right]) => left.localeCompare(right))
    .map(([code, name]) => ({ code, name }));
}

/**
 * Query only the bounded, materialized inventory and stock-advice evidence in
 * dashboard.json.
 *
 * Every count is named `matchedMaterialized*` and carries the materializer's
 * `returned / total / truncated` metadata; this endpoint never claims SHEIN or
 * warehouse completeness, and never converts an unknown quantity into zero.
 */
export function queryInventoryDashboard(dashboardValue, paramsValue = new URLSearchParams()) {
  const dashboard = record(dashboardValue);
  const params = paramsValue instanceof URLSearchParams
    ? paramsValue
    : new URLSearchParams(paramsValue);
  assertKnownParameters(params);
  const supply = record(dashboard.supply);

  const owner = textParam(params, 'owner', {
    maximum: 64,
    pattern: OWNER_PATTERN,
    fallback: 'ALL',
  }) || 'ALL';
  const store = (textParam(params, 'store', {
    maximum: 12,
    pattern: STORE_PATTERN,
    fallback: 'ALL',
  }) || 'ALL').toUpperCase();
  const rawQuery = textParam(params, 'q', { maximum: 120, fallback: '' });
  const query = searchable(rawQuery);
  const quick = enumParam(params, 'quick', QUICK_FILTERS, 'ALL');
  const inventoryType = enumParam(params, 'inventoryType', INVENTORY_TYPES, 'ALL');
  const inventorySort = enumParam(params, 'inventorySort', INVENTORY_SORTS, 'PRIORITY');
  const adviceSort = enumParam(params, 'adviceSort', ADVICE_SORTS, 'PRIORITY');
  const inventoryPage = integerParam(params, 'inventoryPage', {
    fallback: 1,
    minimum: 1,
    maximum: 10_000,
  });
  const advicePage = integerParam(params, 'advicePage', {
    fallback: 1,
    minimum: 1,
    maximum: 10_000,
  });
  const pageSize = integerParam(params, 'pageSize', {
    fallback: 25,
    minimum: 1,
    maximum: 100,
  });

  const ownerStores = ownerStoreSet(dashboard, owner);
  if (store !== 'ALL') {
    if (!knownStoreCodes(dashboard, supply).has(store)) {
      fail('QUERY_STORE_UNKNOWN', '店铺不在当前数据范围内');
    }
    if (ownerStores !== null && !ownerStores.has(store)) {
      fail('QUERY_STORE_UNKNOWN', '店铺不在当前负责人范围内');
    }
  }
  const scope = { store, ownerStores };

  const allInventoryRisks = rows(supply.inventoryRisks);
  const allAdviceRisks = rows(supply.stockAdviceRisks);
  const matchedInventory = allInventoryRisks
    .filter((row) => (
      matchesScope(row, scope)
      && containsQuery(row, query)
      && (
        inventoryType === 'ALL'
        || String(row.inventoryTypeCode ?? '').toUpperCase() === inventoryType
      )
      && matchesInventoryQuick(row, quick)
    ))
    .sort(compareInventory(inventorySort));
  const matchedAdvice = allAdviceRisks
    .filter((row) => (
      matchesScope(row, scope)
      && containsQuery(row, query)
      && matchesAdviceQuick(row, quick)
    ))
    .sort(compareAdvice(adviceSort));

  const inventoryResult = paginate(matchedInventory, inventoryPage, pageSize);
  const adviceResult = paginate(matchedAdvice, advicePage, pageSize);

  const inventorySummaryRows = rows(supply.inventory)
    .filter((row) => matchesScope(row, scope) && containsQuery(row, query));
  const adviceSummaryRows = rows(supply.stockAdvice)
    .filter((row) => matchesScope(row, scope) && containsQuery(row, query));

  const attentionMeta = record(supply.attentionMeta);
  const domains = record(record(supply.coverage).domains);
  const reconciliationRows = matchedInventory.filter(isReconciliationMismatch);

  return Object.freeze({
    schemaVersion: 1,
    readOnly: true,
    source: Object.freeze({
      dashboardUpdatedAt: dashboard.updatedAt ?? null,
      businessDate: dashboard.businessDate ?? null,
      datasetStatus: record(dashboard.dataset).status ?? null,
      supplyStatus: supply.status ?? 'unknown',
      coverage: Object.freeze({
        inventory: record(domains.inventory),
        stockAdvice: record(domains.stockAdvice),
      }),
      materializedInventoryRisks: Object.freeze(safeMeta(attentionMeta.inventoryRisks)),
      materializedStockAdviceRisks: Object.freeze(
        safeMeta(attentionMeta.stockAdviceRisks),
      ),
      latestSourceFetchedAt: latestInstant([
        ...matchedInventory,
        ...matchedAdvice,
        ...inventorySummaryRows,
        ...adviceSummaryRows,
      ]),
    }),
    query: Object.freeze({
      owner,
      store,
      q: rawQuery,
      quick,
      inventoryType,
      inventorySort,
      adviceSort,
      inventoryPage,
      advicePage,
      pageSize,
    }),
    scope: Object.freeze({
      ownerKey: owner,
      storeCode: store,
      scopedStoreCodes: Object.freeze(
        ownerStores === null ? [] : [...ownerStores].sort(),
      ),
      quickAppliesToInventory: INVENTORY_QUICK.includes(quick),
      quickAppliesToAdvice: ADVICE_QUICK.includes(quick),
    }),
    overview: Object.freeze({
      matchedMaterializedInventoryRows: matchedInventory.length,
      matchedMaterializedAdviceRows: matchedAdvice.length,
      matchedInventorySummaryRows: inventorySummaryRows.length,
      matchedAdviceSummaryRows: adviceSummaryRows.length,
      affectedStoreCount: new Set([
        ...matchedInventory.map((row) => row.storeCode),
        ...matchedAdvice.map((row) => row.storeCode),
      ].filter(Boolean)).size,
      shortage: Object.freeze(nullableMetric(matchedInventory, 'shortageQuantity')),
      usable: Object.freeze(nullableMetric(matchedInventory, 'usableInventory')),
      urgent: Object.freeze(nullableMetric(matchedAdvice, 'plannedUrgentQuantity')),
      advised: Object.freeze(nullableMetric(matchedAdvice, 'advisedOrderQuantity')),
      predictedDailySales: Object.freeze(
        nullableMetric(matchedAdvice, 'predictedDailySales', { decimal: true }),
      ),
      reconciliation: Object.freeze({
        rowCount: reconciliationRows.length,
        affectedStoreCount: new Set(
          reconciliationRows.map((row) => row.storeCode).filter(Boolean),
        ).size,
        statuses: Object.freeze(countBy(
          matchedInventory,
          (row) => String(row.reconciliationStatus ?? '').toUpperCase() || null,
        )),
      }),
      warningRowCount: matchedAdvice.filter((row) => row.stockWarningIsWarning === true).length,
      inventorySeverity: Object.freeze(severityCounts(matchedInventory)),
      adviceSeverity: Object.freeze(severityCounts(matchedAdvice)),
      inventoryTypes: Object.freeze(countBy(
        matchedInventory,
        (row) => String(row.inventoryTypeCode ?? '').toUpperCase() || null,
      )),
    }),
    filters: Object.freeze({
      owners: Object.freeze(rows(dashboard.owners).map((item) => ({
        key: item.key,
        name: item.name,
        storeCodes: rows(item.storeCodes),
      }))),
      stores: Object.freeze(storeOptions(dashboard, supply)),
      quick: QUICK_FILTERS,
      inventoryTypes: INVENTORY_TYPES,
      inventorySorts: INVENTORY_SORTS,
      adviceSorts: ADVICE_SORTS,
    }),
    inventory: Object.freeze({
      rows: Object.freeze(inventoryResult.rows),
      pagination: Object.freeze(inventoryResult.pagination),
      source: Object.freeze(safeMeta(attentionMeta.inventoryRisks)),
      storeSummaryRows: Object.freeze(inventorySummaryRows),
    }),
    advice: Object.freeze({
      rows: Object.freeze(adviceResult.rows),
      pagination: Object.freeze(adviceResult.pagination),
      source: Object.freeze(safeMeta(attentionMeta.stockAdviceRisks)),
      storeSummaryRows: Object.freeze(adviceSummaryRows),
    }),
  });
}
