const STORE_PATTERN = /^[A-Z0-9]{2,12}$/;
const OWNER_PATTERN = /^[\p{L}\p{N}._:-]{1,64}$/u;
const STATUS_PATTERN = /^[\p{L}\p{N}._:-]{1,80}$/u;
const INTEGER_PATTERN = /^[1-9][0-9]*$/;

const QUICK_FILTERS = Object.freeze([
  'ALL',
  'HIGH',
  'OVERDUE',
  'PENDING_DELIVERY',
  'PENDING_RECEIPT',
  'PENDING_STORAGE',
  'DEFECTIVE',
]);

/**
 * Explicit attention-code semantics.
 *
 * Substring matching was wrong: `PENDING_RECEIPT` also matched
 * `RECEIVED_PENDING_STORAGE`, and `OVERDUE` silently swallowed unrelated codes.
 * Each quick filter now names the exact codes the materializer emits.
 */
const QUICK_ATTENTION_CODES = Object.freeze({
  OVERDUE: Object.freeze(['DELIVERY_OVERDUE', 'RECEIPT_OVERDUE']),
  PENDING_DELIVERY: Object.freeze(['OPEN_PURCHASE_ORDER', 'DELIVERY_OVERDUE']),
  PENDING_RECEIPT: Object.freeze(['DELIVERED_PENDING_RECEIPT', 'RECEIPT_OVERDUE']),
  PENDING_STORAGE: Object.freeze(['RECEIVED_PENDING_STORAGE']),
  DEFECTIVE: Object.freeze(['DEFECTIVE_QUANTITY']),
});

const PAGE_SIZES = Object.freeze([25, 50, 100]);

const SORTS = Object.freeze([
  'PRIORITY',
  'LATEST',
  'DELIVERY_DEADLINE',
]);

const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const SEVERITY_RANK = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
});

export class ProcurementQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProcurementQueryError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new ProcurementQueryError(code, message);
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
  const value = textParam(params, name, { maximum: 80, fallback }).toUpperCase();
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

/** Page size is a closed set, so no caller can request an unbounded page. */
function pageSizeParam(params) {
  const value = textParam(params, 'pageSize', { maximum: 8, fallback: '25' });
  if (!INTEGER_PATTERN.test(value)) fail('QUERY_PARAMETER_INVALID', '参数 pageSize 必须是整数');
  const parsed = Number(value);
  if (!PAGE_SIZES.includes(parsed)) {
    fail('QUERY_PARAMETER_OUT_OF_RANGE', '参数 pageSize 只能是 25、50 或 100');
  }
  return parsed;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isUnit(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Sum one quantity field across the matched attention rows.
 *
 * These are stage quantities on the current materialized attention scope, not a
 * conversion funnel: an unknown value keeps the total unknown instead of being
 * silently treated as zero, and no ratio is ever derived from them.
 */
function stageQuantity(inputRows, field) {
  const known = inputRows.filter((row) => isUnit(row[field]));
  const knownSum = known.reduce((total, row) => total + row[field], 0);
  return {
    knownSum: known.length === 0 ? null : knownSum,
    total: inputRows.length > 0 && known.length === inputRows.length ? knownSum : null,
    knownCount: known.length,
    unknownCount: inputRows.length - known.length,
    rowCount: inputRows.length,
  };
}

/** Aggregate the scoped status rows by status, never dumping every store row. */
function statusOverview(statusRows) {
  const byStatus = new Map();
  for (const row of statusRows) {
    const code = String(row.statusCode ?? '');
    if (code === '') continue;
    const current = byStatus.get(code) ?? {
      statusCode: code,
      statusName: row.statusName || code,
      storeCount: 0,
      orderCount: 0,
      orderCountKnown: true,
    };
    current.storeCount += 1;
    if (isUnit(row.orderCount)) current.orderCount += row.orderCount;
    else current.orderCountKnown = false;
    byStatus.set(code, current);
  }
  return [...byStatus.values()]
    .map((row) => ({
      statusCode: row.statusCode,
      statusName: row.statusName,
      storeCount: row.storeCount,
      // A single unknown store keeps the status total unknown.
      orderCount: row.orderCountKnown ? row.orderCount : null,
    }))
    .sort((left, right) => (
      (isUnit(right.orderCount) ? right.orderCount : -1)
      - (isUnit(left.orderCount) ? left.orderCount : -1)
      || compareText(left.statusName, right.statusName)
    ));
}

/** Count the matched attention rows per explicit attention code. */
function attentionCodeCounts(inputRows) {
  const counts = new Map();
  for (const row of inputRows) {
    const code = String(row.attentionCode ?? '').toUpperCase();
    if (code === '') continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts]
    .sort(([leftCode, leftCount], [rightCode, rightCount]) => (
      rightCount - leftCount || compareText(leftCode, rightCode)
    ))
    .map(([code, count]) => ({ code, count }));
}

function outstandingQuantity(inputRows, attentionCodes, earlierField, laterField) {
  const selected = inputRows.filter((row) => (
    attentionCodes.includes(String(row.attentionCode ?? '').toUpperCase())
  ));
  const known = selected.filter((row) => (
    isUnit(row[earlierField]) && isUnit(row[laterField])
  ));
  const knownSum = known.reduce((sum, row) => (
    sum + Math.max(0, row[earlierField] - row[laterField])
  ), 0);
  return {
    rowCount: selected.length,
    knownCount: known.length,
    unknownCount: selected.length - known.length,
    knownSum: known.length > 0 ? knownSum : null,
    total: selected.length > 0 && known.length === selected.length ? knownSum : null,
  };
}

/** Compact operating roll-up used by the page rankings. */
function attentionByStore(inputRows) {
  const grouped = new Map();
  for (const row of inputRows) {
    const storeCode = String(row.storeCode ?? '').toUpperCase();
    if (!STORE_PATTERN.test(storeCode)) continue;
    const group = grouped.get(storeCode) ?? [];
    group.push(row);
    grouped.set(storeCode, group);
  }
  return [...grouped]
    .map(([storeCode, storeRows]) => {
      const codes = attentionCodeCounts(storeRows);
      const count = (code) => codes.find((item) => item.code === code)?.count ?? 0;
      const defectiveCount = storeRows.filter((row) => (
        String(row.attentionCode ?? '').toUpperCase() === 'DEFECTIVE_QUANTITY'
        || (isUnit(row.defectiveQuantity) && row.defectiveQuantity > 0)
      )).length;
      return {
        storeCode,
        storeName: storeRows.find((row) => row.storeName)?.storeName || storeCode,
        attentionCount: storeRows.length,
        overdueCount: count('DELIVERY_OVERDUE') + count('RECEIPT_OVERDUE'),
        pendingDeliveryCount: count('OPEN_PURCHASE_ORDER') + count('DELIVERY_OVERDUE'),
        pendingReceiptCount: count('DELIVERED_PENDING_RECEIPT') + count('RECEIPT_OVERDUE'),
        pendingStorageCount: count('RECEIVED_PENDING_STORAGE'),
        defectiveCount,
        pendingDeliveryQuantity: outstandingQuantity(
          storeRows,
          ['OPEN_PURCHASE_ORDER', 'DELIVERY_OVERDUE'],
          'orderQuantity',
          'deliveryQuantity',
        ),
        pendingReceiptQuantity: outstandingQuantity(
          storeRows,
          ['DELIVERED_PENDING_RECEIPT', 'RECEIPT_OVERDUE'],
          'deliveryQuantity',
          'receiptQuantity',
        ),
        pendingStorageQuantity: outstandingQuantity(
          storeRows,
          ['RECEIVED_PENDING_STORAGE'],
          'receiptQuantity',
          'storageQuantity',
        ),
        latestSourceFetchedAt: latestInstant(storeRows),
      };
    })
    .sort((left, right) => (
      right.attentionCount - left.attentionCount
      || right.overdueCount - left.overdueCount
      || compareText(left.storeCode, right.storeCode)
    ));
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function searchable(value) {
  return String(value ?? '').trim().toLocaleLowerCase('zh-CN');
}

function containsQuery(row, query) {
  if (query === '') return true;
  return [
    row.storeCode,
    row.storeName,
    row.orderNo,
    row.statusCode,
    row.statusName,
    row.orderTypeName,
    row.warehouseName,
    row.attentionCode,
    row.attentionLabel,
  ].some((value) => searchable(value).includes(query));
}

function matchesQuickFilter(row, quick) {
  if (quick === 'ALL') return true;
  const severity = String(row.severity ?? '').toLowerCase();
  const attentionCode = String(row.attentionCode ?? '').toUpperCase();
  if (quick === 'HIGH') return severity === 'critical' || severity === 'high';
  if (quick === 'DEFECTIVE') {
    // A defective quantity is a fact on the row, so it counts even when the
    // materializer chose a higher-priority attention code for the same order.
    return QUICK_ATTENTION_CODES.DEFECTIVE.includes(attentionCode)
      || (Number.isSafeInteger(row.defectiveQuantity) && row.defectiveQuantity > 0);
  }
  return (QUICK_ATTENTION_CODES[quick] ?? []).includes(attentionCode);
}

function comparableInstant(value, fallback) {
  const parsed = value ? new Date(value).valueOf() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN');
}

function compareAttention(sort) {
  return (left, right) => {
    if (sort === 'LATEST') {
      const latest = (
        comparableInstant(right.latestSourceFetchedAt, Number.NEGATIVE_INFINITY)
        - comparableInstant(left.latestSourceFetchedAt, Number.NEGATIVE_INFINITY)
      );
      if (latest !== 0) return latest;
    } else if (sort === 'DELIVERY_DEADLINE') {
      const deadline = (
        comparableInstant(left.requestedDeliveryAt, Number.POSITIVE_INFINITY)
        - comparableInstant(right.requestedDeliveryAt, Number.POSITIVE_INFINITY)
      );
      if (deadline !== 0) return deadline;
    } else {
      const priority = (
        (SEVERITY_RANK[String(right.severity ?? '').toLowerCase()] ?? 0)
        - (SEVERITY_RANK[String(left.severity ?? '').toLowerCase()] ?? 0)
      );
      if (priority !== 0) return priority;
      const deadline = (
        comparableInstant(left.requestedDeliveryAt, Number.POSITIVE_INFINITY)
        - comparableInstant(right.requestedDeliveryAt, Number.POSITIVE_INFINITY)
      );
      if (deadline !== 0) return deadline;
    }
    return (
      compareText(left.storeCode, right.storeCode)
      || compareText(left.orderNo, right.orderNo)
      || compareText(left.attentionCode, right.attentionCode)
    );
  };
}

function ownerStoreSet(dashboard, ownerKey) {
  if (ownerKey === 'ALL') return null;
  const owner = rows(dashboard.owners).find((item) => item.key === ownerKey);
  if (!owner) fail('QUERY_OWNER_UNKNOWN', '负责人不在当前数据范围内');
  return new Set(rows(owner.storeCodes));
}

function expectedStoreSet(dashboard, store, ownerStores) {
  if (store !== 'ALL') return new Set([store]);
  if (ownerStores) return new Set(ownerStores);
  const stores = new Set(rows(dashboard.stores)
    .map((item) => String(item?.code ?? '').toUpperCase())
    .filter((code) => STORE_PATTERN.test(code)));
  for (const owner of rows(dashboard.owners)) {
    for (const code of rows(owner?.storeCodes)) {
      const normalized = String(code ?? '').toUpperCase();
      if (STORE_PATTERN.test(normalized)) stores.add(normalized);
    }
  }
  return stores;
}

function coverageCompleteForScope(coverage, expectedStores) {
  if (expectedStores.size === 0) return false;
  const succeeded = new Set(rows(coverage?.succeededStoreCodes)
    .map((code) => String(code).toUpperCase()));
  // Aggregate COMPLETE counts do not prove membership for the current owner
  // or store scope. Only the explicit successful roster may authorize an
  // exact count; a stale/global 1-of-1 receipt must not bless another store.
  return [...expectedStores].every((code) => succeeded.has(code));
}

function matchesScope(row, { store, ownerStores }) {
  const storeCode = String(row.storeCode ?? '').toUpperCase();
  if (store !== 'ALL' && storeCode !== store) return false;
  return ownerStores === null || ownerStores.has(storeCode);
}

function completeOrderCount(statusRows) {
  if (statusRows.length === 0) return null;
  if (statusRows.some((row) => !Number.isSafeInteger(row.orderCount) || row.orderCount < 0)) {
    return null;
  }
  return statusRows.reduce((total, row) => total + row.orderCount, 0);
}

function latestInstant(inputRows) {
  const values = inputRows
    .map((row) => comparableInstant(row.latestSourceFetchedAt, Number.NaN))
    .filter(Number.isFinite);
  return values.length === 0 ? null : new Date(Math.max(...values)).toISOString();
}

function safeMeta(value) {
  const source = record(value);
  return {
    available: source.available === true,
    total: Number.isSafeInteger(source.total) && source.total >= 0 ? source.total : null,
    returned: Number.isSafeInteger(source.returned) && source.returned >= 0
      ? source.returned
      : null,
    truncated: source.truncated === true,
  };
}

function storeOptions(dashboard, statusRows, attentionRows) {
  const names = new Map();
  for (const row of [...statusRows, ...attentionRows]) {
    const code = String(row.storeCode ?? '').toUpperCase();
    if (!STORE_PATTERN.test(code)) continue;
    if (!names.has(code)) names.set(code, row.storeName || code);
  }
  for (const owner of rows(dashboard.owners)) {
    for (const code of rows(owner.storeCodes)) {
      if (STORE_PATTERN.test(code) && !names.has(code)) names.set(code, code);
    }
  }
  return [...names].sort(([left], [right]) => left.localeCompare(right))
    .map(([code, name]) => ({ code, name }));
}

/**
 * Query only the bounded, materialized procurement evidence in dashboard.json.
 *
 * The returned totals are explicitly named `matchedMaterialized*`; they never
 * claim to represent warehouse rows hidden by the materializer's source limit.
 */
export function queryProcurementDashboard(dashboardValue, paramsValue = new URLSearchParams()) {
  const dashboard = record(dashboardValue);
  const params = paramsValue instanceof URLSearchParams
    ? paramsValue
    : new URLSearchParams(paramsValue);
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
  const query = searchable(textParam(params, 'q', { maximum: 80, fallback: '' }));
  const status = (textParam(params, 'status', {
    maximum: 80,
    pattern: STATUS_PATTERN,
    fallback: 'ALL',
  }) || 'ALL').toUpperCase();
  const quick = enumParam(params, 'quick', QUICK_FILTERS, 'ALL');
  const sort = enumParam(params, 'sort', SORTS, 'PRIORITY');
  const page = integerParam(params, 'page', { fallback: 1, minimum: 1, maximum: 10_000 });
  const pageSize = pageSizeParam(params);
  const ownerStores = ownerStoreSet(dashboard, owner);

  const supply = record(dashboard.supply);
  const allStatusRows = rows(supply.purchaseOrderStatus);
  const allAttentionRows = rows(supply.purchaseOrderAttention);
  const scopedStatusRows = allStatusRows.filter((row) => (
    matchesScope(row, { store, ownerStores })
    && (status === 'ALL' || row.statusCode === status)
    && containsQuery(row, query)
  ));
  const matchedAttentionRows = allAttentionRows
    .filter((row) => (
      matchesScope(row, { store, ownerStores })
      && (status === 'ALL' || row.statusCode === status)
      && containsQuery(row, query)
      && matchesQuickFilter(row, quick)
    ))
    .sort(compareAttention(sort));

  const offset = (page - 1) * pageSize;
  const pageRows = matchedAttentionRows.slice(offset, offset + pageSize);
  const pageCount = matchedAttentionRows.length === 0
    ? 0
    : Math.ceil(matchedAttentionRows.length / pageSize);
  const attentionMeta = safeMeta(record(supply.attentionMeta).purchaseOrders);
  const coverage = record(record(supply.coverage).domains).purchaseOrders;
  const scopeCoverageComplete = coverageCompleteForScope(
    coverage,
    expectedStoreSet(dashboard, store, ownerStores),
  );
  const statuses = [...new Map(
    allStatusRows
      .filter((row) => row.statusCode)
      .map((row) => [row.statusCode, {
        code: row.statusCode,
        name: row.statusName || row.statusCode,
      }]),
  ).values()].sort((left, right) => compareText(left.name, right.name));

  return Object.freeze({
    schemaVersion: 1,
    readOnly: true,
    source: Object.freeze({
      dashboardUpdatedAt: dashboard.updatedAt ?? null,
      businessDate: dashboard.businessDate ?? null,
      datasetStatus: record(dashboard.dataset).status ?? null,
      supplyStatus: supply.status ?? 'unknown',
      coverage: record(coverage),
      materializedAttention: Object.freeze(attentionMeta),
    }),
    query: Object.freeze({
      owner,
      store,
      q: textParam(params, 'q', { maximum: 80, fallback: '' }),
      status,
      quick,
      sort,
      page,
      pageSize,
    }),
    summary: Object.freeze({
      matchedMaterializedAttentionCount: matchedAttentionRows.length,
      matchedStatusRowCount: scopedStatusRows.length,
      // Order count comes from the status snapshot; the stage quantities below
      // come from the attention rows. They are deliberately separate scopes.
      orderCount: scopeCoverageComplete ? completeOrderCount(scopedStatusRows) : null,
      coverageComplete: scopeCoverageComplete,
      statusCount: new Set(scopedStatusRows.map((row) => row.statusCode).filter(Boolean)).size,
      storeCount: new Set([
        ...scopedStatusRows.map((row) => row.storeCode),
        ...matchedAttentionRows.map((row) => row.storeCode),
      ].filter(Boolean)).size,
      latestSourceFetchedAt: latestInstant([...scopedStatusRows, ...matchedAttentionRows]),
      // Stage quantities over the current materialized attention scope only.
      // This is not a conversion funnel and carries no derived percentage.
      attentionScopeLabel: '当前已物化关注范围的阶段数量，不是转化漏斗',
      quantityStages: Object.freeze({
        order: Object.freeze(stageQuantity(matchedAttentionRows, 'orderQuantity')),
        delivery: Object.freeze(stageQuantity(matchedAttentionRows, 'deliveryQuantity')),
        receipt: Object.freeze(stageQuantity(matchedAttentionRows, 'receiptQuantity')),
        storage: Object.freeze(stageQuantity(matchedAttentionRows, 'storageQuantity')),
        defective: Object.freeze(stageQuantity(matchedAttentionRows, 'defectiveQuantity')),
      }),
      attentionCodes: Object.freeze(attentionCodeCounts(matchedAttentionRows)),
      attentionByStore: Object.freeze(attentionByStore(matchedAttentionRows)),
    }),
    // Compact aggregate: one row per status, not one row per store and status.
    statusOverview: Object.freeze(statusOverview(scopedStatusRows)),
    filters: Object.freeze({
      owners: Object.freeze(rows(dashboard.owners).map((item) => ({
        key: item.key,
        name: item.name,
        storeCodes: rows(item.storeCodes),
      }))),
      stores: Object.freeze(storeOptions(dashboard, allStatusRows, allAttentionRows)),
      statuses: Object.freeze(statuses),
      quick: QUICK_FILTERS,
      sorts: SORTS,
      pageSizes: PAGE_SIZES,
    }),
    statusRows: Object.freeze(scopedStatusRows),
    attention: Object.freeze({
      rows: Object.freeze(pageRows),
      pagination: Object.freeze({
        page,
        pageSize,
        pageCount,
        matchedMaterializedRows: matchedAttentionRows.length,
        hasPrevious: page > 1,
        hasNext: page < pageCount,
      }),
    }),
  });
}
