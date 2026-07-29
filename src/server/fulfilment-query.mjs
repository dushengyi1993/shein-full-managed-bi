const STORE_PATTERN = /^[A-Z0-9]{2,12}$/;
const OWNER_PATTERN = /^[\p{L}\p{N}._:-]{1,64}$/u;
const MILESTONE_PATTERN = /^[\p{L}\p{N}._:-]{1,80}$/u;
const INTEGER_PATTERN = /^[1-9][0-9]*$/;

const QUICK_FILTERS = Object.freeze([
  'ALL',
  'HIGH',
  'CREATED',
  'PICKUP_RESERVED',
  'IN_TRANSIT',
  'PENDING_RECEIPT',
]);

/**
 * Explicit attention-code semantics.
 *
 * These are the exact codes `src/warehouse/supply-repository.mjs` emits for
 * delivery attention. Note `DELIVERY_CREATED_PENDING`, not `CREATED_PENDING`.
 * Every attention row already has `received_at IS NULL`, so `PENDING_RECEIPT`
 * legitimately covers all four codes rather than being a fifth milestone.
 */
const QUICK_ATTENTION_CODES = Object.freeze({
  CREATED: Object.freeze(['DELIVERY_CREATED_PENDING']),
  PICKUP_RESERVED: Object.freeze(['PICKUP_RESERVED_PENDING']),
  IN_TRANSIT: Object.freeze(['IN_TRANSIT_PENDING_RECEIPT', 'RECEIPT_OVERDUE']),
  PENDING_RECEIPT: Object.freeze([
    'DELIVERY_CREATED_PENDING',
    'PICKUP_RESERVED_PENDING',
    'IN_TRANSIT_PENDING_RECEIPT',
    'RECEIPT_OVERDUE',
  ]),
});

const SORTS = Object.freeze([
  'PRIORITY',
  'LATEST',
  'EXPECTED_RECEIPT',
]);

const PAGE_SIZES = Object.freeze([25, 50, 100]);

const SEVERITY_RANK = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
});

export class FulfilmentQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FulfilmentQueryError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new FulfilmentQueryError(code, message);
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

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function isUnit(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function searchable(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function containsQuery(row, query) {
  if (query === '') return true;
  return [
    row.storeCode,
    row.storeName,
    row.deliveryCode,
    row.milestoneCode,
    row.warehouseName,
    row.expressCode,
    row.expressCompanyName,
    row.attentionCode,
    row.attentionLabel,
  ].some((value) => searchable(value).includes(query));
}

function matchesQuickFilter(row, quick) {
  if (quick === 'ALL') return true;
  const severity = String(row.severity ?? '').toLowerCase();
  if (quick === 'HIGH') return severity === 'critical' || severity === 'high';
  const attentionCode = String(row.attentionCode ?? '').toUpperCase();
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
    } else if (sort === 'EXPECTED_RECEIPT') {
      // expectedReceiptAt is absent in the current production snapshot, so an
      // unknown expectation sorts last instead of pretending to be imminent.
      const expected = (
        comparableInstant(left.expectedReceiptAt, Number.POSITIVE_INFINITY)
        - comparableInstant(right.expectedReceiptAt, Number.POSITIVE_INFINITY)
      );
      if (expected !== 0 && Number.isFinite(expected)) return expected;
      const leftKnown = comparableInstant(left.expectedReceiptAt, Number.NaN);
      const rightKnown = comparableInstant(right.expectedReceiptAt, Number.NaN);
      if (Number.isFinite(leftKnown) !== Number.isFinite(rightKnown)) {
        return Number.isFinite(leftKnown) ? -1 : 1;
      }
    } else {
      const priority = (
        (SEVERITY_RANK[String(right.severity ?? '').toLowerCase()] ?? 0)
        - (SEVERITY_RANK[String(left.severity ?? '').toLowerCase()] ?? 0)
      );
      if (priority !== 0) return priority;
      const taken = (
        comparableInstant(left.takenAt, Number.POSITIVE_INFINITY)
        - comparableInstant(right.takenAt, Number.POSITIVE_INFINITY)
      );
      if (taken !== 0 && Number.isFinite(taken)) return taken;
      // Subtracting two infinities yields NaN, so a known pickup time has to be
      // compared against an unknown one explicitly.
      const leftTaken = comparableInstant(left.takenAt, Number.NaN);
      const rightTaken = comparableInstant(right.takenAt, Number.NaN);
      if (Number.isFinite(leftTaken) !== Number.isFinite(rightTaken)) {
        return Number.isFinite(leftTaken) ? -1 : 1;
      }
    }
    return (
      compareText(left.storeCode, right.storeCode)
      || compareText(left.deliveryCode, right.deliveryCode)
      || compareText(left.attentionCode, right.attentionCode)
    );
  };
}

function ownerStoreSet(dashboard, ownerKey) {
  if (ownerKey === 'ALL') return null;
  const owner = rows(dashboard.owners).find((item) => item.key === ownerKey);
  if (!owner) fail('QUERY_OWNER_UNKNOWN', '负责人不在当前数据范围内');
  return new Set(rows(owner.storeCodes).map((code) => String(code).toUpperCase()));
}

function matchesScope(row, { store, ownerStores }) {
  const storeCode = String(row.storeCode ?? '').toUpperCase();
  if (store !== 'ALL' && storeCode !== store) return false;
  return ownerStores === null || ownerStores.has(storeCode);
}

/**
 * Sum one quantity across rows without turning unknown into zero.
 *
 * Delivery count and delivery quantity are different units, so the caller keeps
 * them in separate fields rather than adding them together.
 */
function nullableSum(inputRows, field) {
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

/** Aggregate the scoped milestone snapshot per milestone, not per store. */
function milestoneOverview(milestoneRows) {
  const byMilestone = new Map();
  for (const row of milestoneRows) {
    const code = String(row.milestoneCode ?? '');
    if (code === '') continue;
    const current = byMilestone.get(code) ?? {
      milestoneCode: code,
      storeCount: 0,
      deliveryCount: 0,
      deliveryCountKnown: true,
      deliveryQuantity: 0,
      deliveryQuantityKnown: true,
    };
    current.storeCount += 1;
    if (isUnit(row.deliveryCount)) current.deliveryCount += row.deliveryCount;
    else current.deliveryCountKnown = false;
    if (isUnit(row.deliveryQuantity)) current.deliveryQuantity += row.deliveryQuantity;
    else current.deliveryQuantityKnown = false;
    byMilestone.set(code, current);
  }
  return [...byMilestone.values()]
    .map((row) => ({
      milestoneCode: row.milestoneCode,
      storeCount: row.storeCount,
      // Delivery count and quantity stay separate and independently nullable.
      deliveryCount: row.deliveryCountKnown ? row.deliveryCount : null,
      deliveryQuantity: row.deliveryQuantityKnown ? row.deliveryQuantity : null,
    }))
    .sort((left, right) => (
      (isUnit(right.deliveryCount) ? right.deliveryCount : -1)
      - (isUnit(left.deliveryCount) ? left.deliveryCount : -1)
      || compareText(left.milestoneCode, right.milestoneCode)
    ));
}

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
    total: isUnit(source.total) ? source.total : null,
    returned: isUnit(source.returned) ? source.returned : null,
    truncated: source.truncated === true,
  };
}

function storeOptions(dashboard, milestoneRows, attentionRows) {
  const names = new Map();
  for (const row of [...milestoneRows, ...attentionRows]) {
    const code = String(row.storeCode ?? '').toUpperCase();
    if (!STORE_PATTERN.test(code)) continue;
    if (!names.has(code)) names.set(code, row.storeName || code);
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
 * Query only the bounded, materialized delivery evidence in dashboard.json.
 *
 * Counts are named `matchedMaterialized*` and carry the materializer's
 * returned/total/truncated metadata, so no response claims warehouse or SHEIN
 * completeness. `expectedReceiptAt` is absent upstream: it stays null and is
 * never fabricated from another timestamp.
 */
export function queryFulfilmentDashboard(dashboardValue, paramsValue = new URLSearchParams()) {
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
  const rawQuery = textParam(params, 'q', { maximum: 80, fallback: '' });
  const query = searchable(rawQuery);
  const milestone = (textParam(params, 'milestone', {
    maximum: 80,
    pattern: MILESTONE_PATTERN,
    fallback: 'ALL',
  }) || 'ALL').toUpperCase();
  const quick = enumParam(params, 'quick', QUICK_FILTERS, 'ALL');
  const sort = enumParam(params, 'sort', SORTS, 'PRIORITY');
  const page = integerParam(params, 'page', { fallback: 1, minimum: 1, maximum: 10_000 });
  const pageSize = pageSizeParam(params);
  const ownerStores = ownerStoreSet(dashboard, owner);
  const scope = { store, ownerStores };

  const supply = record(dashboard.supply);
  const allMilestoneRows = rows(supply.deliveryMilestones);
  const allAttentionRows = rows(supply.deliveryAttention);
  const scopedMilestoneRows = allMilestoneRows.filter((row) => (
    matchesScope(row, scope)
    && (milestone === 'ALL' || String(row.milestoneCode ?? '').toUpperCase() === milestone)
    && containsQuery(row, query)
  ));
  const matchedAttentionRows = allAttentionRows
    .filter((row) => (
      matchesScope(row, scope)
      && (milestone === 'ALL' || String(row.milestoneCode ?? '').toUpperCase() === milestone)
      && containsQuery(row, query)
      && matchesQuickFilter(row, quick)
    ))
    .sort(compareAttention(sort));

  const offset = (page - 1) * pageSize;
  const pageRows = matchedAttentionRows.slice(offset, offset + pageSize);
  const pageCount = matchedAttentionRows.length === 0
    ? 0
    : Math.ceil(matchedAttentionRows.length / pageSize);
  const attentionMeta = safeMeta(record(supply.attentionMeta).deliveries);
  const coverage = record(record(supply.coverage).domains).deliveries;
  const milestones = [...new Set(
    allMilestoneRows
      .map((row) => String(row.milestoneCode ?? '').toUpperCase())
      .filter((code) => code !== ''),
  )].sort().map((code) => ({ code, name: code }));

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
      latestSourceFetchedAt: latestInstant([...scopedMilestoneRows, ...matchedAttentionRows]),
    }),
    query: Object.freeze({
      owner,
      store,
      q: rawQuery,
      milestone,
      quick,
      sort,
      page,
      pageSize,
    }),
    summary: Object.freeze({
      matchedMaterializedAttentionCount: matchedAttentionRows.length,
      matchedMilestoneRowCount: scopedMilestoneRows.length,
      storeCount: new Set([
        ...scopedMilestoneRows.map((row) => row.storeCode),
        ...matchedAttentionRows.map((row) => row.storeCode),
      ].filter(Boolean)).size,
      // Delivery count and delivery quantity are different units and are never
      // added together or turned into a ratio.
      snapshotDeliveryCount: Object.freeze(nullableSum(scopedMilestoneRows, 'deliveryCount')),
      snapshotDeliveryQuantity: Object.freeze(
        nullableSum(scopedMilestoneRows, 'deliveryQuantity'),
      ),
      attentionDeliveryQuantity: Object.freeze(
        nullableSum(matchedAttentionRows, 'deliveryQuantity'),
      ),
      attentionLineCount: Object.freeze(nullableSum(matchedAttentionRows, 'lineCount')),
      attentionScopeLabel: '当前已物化关注范围的交付单与数量，单位不同不可相加',
      expectedReceiptKnownCount: matchedAttentionRows.filter(
        (row) => Boolean(row.expectedReceiptAt),
      ).length,
      attentionCodes: Object.freeze(attentionCodeCounts(matchedAttentionRows)),
    }),
    filters: Object.freeze({
      owners: Object.freeze(rows(dashboard.owners).map((item) => ({
        key: item.key,
        name: item.name,
        storeCodes: rows(item.storeCodes),
      }))),
      stores: Object.freeze(storeOptions(dashboard, allMilestoneRows, allAttentionRows)),
      milestones: Object.freeze(milestones),
      quick: QUICK_FILTERS,
      sorts: SORTS,
      pageSizes: PAGE_SIZES,
    }),
    // Compact aggregate: one row per milestone, not one row per store.
    milestoneOverview: Object.freeze(milestoneOverview(scopedMilestoneRows)),
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
      source: Object.freeze(attentionMeta),
    }),
  });
}

export const FULFILMENT_QUICK_FILTERS = QUICK_FILTERS;
export const FULFILMENT_PAGE_SIZES = PAGE_SIZES;
