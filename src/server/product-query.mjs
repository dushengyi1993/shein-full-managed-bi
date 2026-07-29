const STORE_PATTERN = /^[A-Z0-9]{2,12}$/;
const OWNER_PATTERN = /^[\p{L}\p{N}._:-]{1,64}$/u;
const INTEGER_PATTERN = /^[1-9][0-9]*$/;

const WINDOW_KEYS = Object.freeze(['today', 'yesterday', 'last7Days', 'last30Days']);
const RANGES = Object.freeze(['today', 'yesterday', 'last7Days', 'last30Days']);

const QUICK_FILTERS = Object.freeze([
  'ALL',
  'WITH_SALES',
  'UNMAPPED',
  'MISSING_SPU',
  'CANONICAL',
]);

const SORTS = Object.freeze([
  'IMPACT_DESC',
  'LAST30_DESC',
  'LAST7_DESC',
  'TODAY_DESC',
  'STORE_ASC',
]);

const PAGE_SIZES = Object.freeze([25, 50, 100]);

export class ProductQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductQueryError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new ProductQueryError(code, message);
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
  const value = textParam(params, name, { maximum: 40, fallback });
  const normalized = allowed === RANGES ? value : value.toUpperCase();
  if (!allowed.includes(normalized)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  return normalized;
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

/** Page size is a closed set so an operator cannot request an unbounded page. */
function pageSizeParam(params) {
  const value = textParam(params, 'pageSize', { maximum: 8, fallback: '25' });
  if (!INTEGER_PATTERN.test(value)) fail('QUERY_PARAMETER_INVALID', '参数 pageSize 必须是整数');
  const parsed = Number(value);
  if (!PAGE_SIZES.includes(parsed)) {
    fail('QUERY_PARAMETER_OUT_OF_RANGE', '参数 pageSize 只能是 25、50 或 100');
  }
  return parsed;
}

function searchable(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function ownerStoreSet(dashboard, ownerKey) {
  if (ownerKey === 'ALL') return null;
  const owner = rows(dashboard.owners).find((item) => item.key === ownerKey);
  if (!owner) fail('QUERY_OWNER_UNKNOWN', '负责人不在当前数据范围内');
  return new Set(rows(owner.storeCodes).map((code) => String(code).toUpperCase()));
}

function knownStoreCodes(dashboard) {
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
  for (const row of rows(dashboard.storeSkuRanking)) {
    const normalized = String(row?.storeCode ?? '').toUpperCase();
    if (STORE_PATTERN.test(normalized)) codes.add(normalized);
  }
  return codes;
}

/** A store-local row belongs to exactly one store, so scope is a single check. */
function inScope(storeCode, { store, ownerStores }) {
  const normalized = String(storeCode ?? '').toUpperCase();
  if (store !== 'ALL' && normalized !== store) return false;
  return ownerStores === null || ownerStores.has(normalized);
}

function pendingMatchesQuery(row, query) {
  if (query === '') return true;
  return [
    row.storeCode,
    row.sku,
    row.skc,
    row.supplierCode,
    row.supplierSku,
    row.productKey,
    row.name,
  ].some((value) => searchable(value).includes(query));
}

function canonicalMatchesQuery(row, query) {
  if (query === '') return true;
  return [
    row.standardProductCode,
    row.canonicalProductId,
    row.name,
    row.productKey,
    ...rows(row.storeCodes),
  ].some((value) => searchable(value).includes(query));
}

/** Sum only fully known windows; one unknown store keeps the total unknown. */
function safeUnitSum(values) {
  if (values.length === 0) return null;
  if (values.some((value) => !isUnit(value))) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function normalizedUnits(value) {
  const source = record(value);
  return Object.fromEntries(WINDOW_KEYS.map((key) => [
    key,
    isUnit(source[key]) ? source[key] : null,
  ]));
}

/**
 * Rebuild a canonical row for the requested scope.
 *
 * The materialized row aggregates every confirmed store. Under an owner or
 * store filter the global total would overstate the scope, so quantities and
 * the store count are recomputed from the filtered breakdown only. A row with
 * no in-scope store is dropped rather than shown at zero.
 */
function scopeCanonicalRow(row, scope, scoped) {
  const breakdown = rows(row.storeBreakdown)
    .filter((item) => inScope(item?.storeCode, scope));
  if (!scoped) {
    return {
      ...row,
      unitsSold: normalizedUnits(row.unitsSold),
      storeBreakdown: breakdown,
      scopedStoreCount: isUnit(row.storeCount) ? row.storeCount : breakdown.length,
      totalStoreCount: isUnit(row.storeCount) ? row.storeCount : breakdown.length,
      scopeRecomputed: false,
    };
  }
  if (breakdown.length === 0) return null;
  return {
    ...row,
    storeCodes: breakdown.map(({ storeCode }) => storeCode),
    unitsSold: Object.fromEntries(WINDOW_KEYS.map((key) => [
      key,
      safeUnitSum(breakdown.map((item) => record(item.unitsSold)[key])),
    ])),
    storeBreakdown: breakdown,
    scopedStoreCount: breakdown.length,
    totalStoreCount: isUnit(row.storeCount) ? row.storeCount : breakdown.length,
    // The UI must be able to say the quantities are scope-recomputed, not global.
    scopeRecomputed: true,
  };
}

function isCanonicalRow(row) {
  return row.identityLevel === 'CANONICAL_CONFIRMED'
    && Boolean(row.canonicalProductId)
    && Boolean(row.standardProductCode);
}

/* A quick filter that cannot describe a list is a no-op there, so the inactive
   tab keeps an honest matched count instead of collapsing to a false zero. */
const PENDING_QUICK = Object.freeze(['WITH_SALES', 'UNMAPPED', 'MISSING_SPU']);
const CANONICAL_QUICK = Object.freeze(['WITH_SALES', 'CANONICAL']);

function matchesQuick(row, quick, range, allowed) {
  if (!allowed.includes(quick)) return true;
  if (quick === 'WITH_SALES') {
    const value = record(row.unitsSold)[range];
    return isUnit(value) && value > 0;
  }
  if (quick === 'MISSING_SPU') {
    return String(row.mappingStatus ?? '').toUpperCase() === 'MISSING_SPU_ID';
  }
  if (quick === 'UNMAPPED') {
    // "Waiting for evidence" is a narrower bucket than "not confirmed": a row
    // missing its platform SPU cannot be merged at all and has its own filter.
    const status = String(row.mappingStatus ?? '').toUpperCase();
    return !isCanonicalRow(row) && status !== 'CONFIRMED' && status !== 'MISSING_SPU_ID';
  }
  return isCanonicalRow(row);
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN');
}

function rankValue(value) {
  return isUnit(value) ? value : -1;
}

function comparator(sort, range) {
  const field = sort === 'IMPACT_DESC'
    ? range
    : sort === 'LAST30_DESC'
      ? 'last30Days'
      : sort === 'LAST7_DESC' ? 'last7Days' : sort === 'TODAY_DESC' ? 'today' : null;
  return (left, right) => {
    if (field !== null) {
      const delta = rankValue(record(right.unitsSold)[field])
        - rankValue(record(left.unitsSold)[field]);
      if (delta !== 0) return delta;
    } else {
      const delta = compareText(left.storeCode, right.storeCode);
      if (delta !== 0) return delta;
    }
    return (
      compareText(left.storeCode, right.storeCode)
      || compareText(
        left.standardProductCode ?? left.sku ?? left.productKey,
        right.standardProductCode ?? right.sku ?? right.productKey,
      )
      || compareText(left.canonicalProductId, right.canonicalProductId)
    );
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

function rankingMeta(value, returnedFallback) {
  const source = record(value);
  const returned = isUnit(source.returnedCount) ? source.returnedCount : returnedFallback;
  const total = isUnit(source.totalCount) && source.totalCount >= returned
    ? source.totalCount
    : returned;
  return {
    returned,
    total,
    truncated: source.truncated === true || total > returned,
  };
}

function impactMetric(inputRows, range) {
  const values = inputRows.map((row) => record(row.unitsSold)[range]);
  const known = values.filter(isUnit);
  return {
    rowCount: inputRows.length,
    knownCount: known.length,
    unknownCount: inputRows.length - known.length,
    knownSum: known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0),
    total: inputRows.length > 0 && known.length === inputRows.length
      ? known.reduce((sum, value) => sum + value, 0)
      : null,
  };
}

function storeOptions(dashboard) {
  const names = new Map();
  for (const row of rows(dashboard.storeRanking)) {
    const code = String(row?.code ?? '').toUpperCase();
    if (STORE_PATTERN.test(code) && !names.has(code)) names.set(code, row.name || code);
  }
  for (const row of rows(dashboard.storeSkuRanking)) {
    const code = String(row?.storeCode ?? '').toUpperCase();
    if (STORE_PATTERN.test(code) && !names.has(code)) names.set(code, code);
  }
  return [...names].sort(([left], [right]) => left.localeCompare(right))
    .map(([code, name]) => ({ code, name }));
}

/**
 * Query only the bounded, materialized product identity evidence in
 * dashboard.json.
 *
 * The pending queue reads unconfirmed store-local rows so store, supplier code,
 * SKC and SKU stay visible; the canonical list reads confirmed cross-store rows
 * only. Every count is named `matchedMaterialized*` and carries the
 * materializer's returned/total/truncated metadata, so no response ever claims
 * the SHEIN or warehouse universe.
 */
export function queryProductDashboard(dashboardValue, paramsValue = new URLSearchParams()) {
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
  const rawQuery = textParam(params, 'q', { maximum: 120, fallback: '' });
  const query = searchable(rawQuery);
  const quick = enumParam(params, 'quick', QUICK_FILTERS, 'ALL');
  const sort = enumParam(params, 'sort', SORTS, 'IMPACT_DESC');
  const range = enumParam(params, 'range', RANGES, 'today');
  const pendingPage = integerParam(params, 'pendingPage', {
    fallback: 1,
    minimum: 1,
    maximum: 10_000,
  });
  const canonicalPage = integerParam(params, 'canonicalPage', {
    fallback: 1,
    minimum: 1,
    maximum: 10_000,
  });
  const pageSize = pageSizeParam(params);

  const ownerStores = ownerStoreSet(dashboard, owner);
  if (store !== 'ALL') {
    if (!knownStoreCodes(dashboard).has(store)) {
      fail('QUERY_STORE_UNKNOWN', '店铺不在当前数据范围内');
    }
    if (ownerStores !== null && !ownerStores.has(store)) {
      fail('QUERY_STORE_UNKNOWN', '店铺不在当前负责人范围内');
    }
  }
  const scope = { store, ownerStores };
  const scoped = store !== 'ALL' || ownerStores !== null;
  const compare = comparator(sort, range);

  const allStoreSkuRows = rows(dashboard.storeSkuRanking);
  const scopedStoreSkuRows = allStoreSkuRows
    .filter((row) => inScope(row.storeCode, scope) && pendingMatchesQuery(row, query))
    .map((row) => ({ ...row, unitsSold: normalizedUnits(row.unitsSold) }));
  // The pending queue is the unconfirmed side of the store-local universe.
  const pendingRows = scopedStoreSkuRows
    .filter((row) => row.mappingStatus !== 'CONFIRMED')
    .filter((row) => matchesQuick(row, quick, range, PENDING_QUICK))
    .sort(compare);
  const confirmedStoreSkuRows = scopedStoreSkuRows
    .filter((row) => row.mappingStatus === 'CONFIRMED');

  const canonicalRows = rows(dashboard.productRanking)
    .filter(isCanonicalRow)
    .map((row) => scopeCanonicalRow(row, scope, scoped))
    .filter(Boolean)
    .filter((row) => canonicalMatchesQuery(row, query))
    .filter((row) => matchesQuick(row, quick, range, CANONICAL_QUICK))
    .sort(compare);

  const pendingResult = paginate(pendingRows, pendingPage, pageSize);
  const canonicalResult = paginate(canonicalRows, canonicalPage, pageSize);
  const meta = record(dashboard.rankingMeta);
  const identity = record(dashboard.productIdentityCoverage);
  const pipeline = record(dashboard.productIdentityPipeline);
  const missingSpuRows = scopedStoreSkuRows.filter(
    (row) => String(row.mappingStatus ?? '').toUpperCase() === 'MISSING_SPU_ID',
  );

  return Object.freeze({
    schemaVersion: 1,
    readOnly: true,
    source: Object.freeze({
      dashboardUpdatedAt: dashboard.updatedAt ?? null,
      businessDate: dashboard.businessDate ?? null,
      datasetStatus: record(dashboard.dataset).status ?? null,
      // Two different universes: the active catalog and the sales-materialized
      // ranking. They are never merged into one coverage number.
      activeCatalogCoverage: Object.freeze({
        basis: identity.basis ?? null,
        confirmedSkus: isUnit(identity.confirmedSkus) ? identity.confirmedSkus : null,
        totalSkus: isUnit(identity.totalSkus) ? identity.totalSkus : null,
        unconfirmedSkus: isUnit(identity.unconfirmedSkus) ? identity.unconfirmedSkus : null,
        missingSpuSkus: isUnit(identity.missingSpuSkus) ? identity.missingSpuSkus : null,
        coverageRate: typeof identity.coverageRate === 'number' && Number.isFinite(identity.coverageRate)
          ? identity.coverageRate
          : null,
        status: identity.status ?? null,
      }),
      pipeline: Object.freeze(pipeline),
      materializedRankings: Object.freeze({
        storeSku: rankingMeta(meta.storeSku ?? meta.sku, allStoreSkuRows.length),
        product: rankingMeta(meta.product, rows(dashboard.productRanking).length),
      }),
    }),
    query: Object.freeze({
      owner,
      store,
      q: rawQuery,
      quick,
      sort,
      range,
      pendingPage,
      canonicalPage,
      pageSize,
    }),
    scope: Object.freeze({
      ownerKey: owner,
      storeCode: store,
      scopedStoreCodes: Object.freeze(ownerStores === null ? [] : [...ownerStores].sort()),
      canonicalQuantitiesRecomputed: scoped,
      quickAppliesToPending: PENDING_QUICK.includes(quick),
      quickAppliesToCanonical: CANONICAL_QUICK.includes(quick),
    }),
    summary: Object.freeze({
      matchedMaterializedPendingRows: pendingRows.length,
      matchedMaterializedCanonicalRows: canonicalRows.length,
      matchedMaterializedStoreSkuRows: scopedStoreSkuRows.length,
      confirmedStoreSkuRows: confirmedStoreSkuRows.length,
      missingSpuStoreSkuRows: missingSpuRows.length,
      pendingStoreCount: new Set(pendingRows.map((row) => row.storeCode).filter(Boolean)).size,
      pendingImpact: Object.freeze(impactMetric(pendingRows, range)),
      canonicalImpact: Object.freeze(impactMetric(canonicalRows, range)),
    }),
    filters: Object.freeze({
      owners: Object.freeze(rows(dashboard.owners).map((item) => ({
        key: item.key,
        name: item.name,
        storeCodes: rows(item.storeCodes),
      }))),
      stores: Object.freeze(storeOptions(dashboard)),
      quick: QUICK_FILTERS,
      sorts: SORTS,
      ranges: RANGES,
      pageSizes: PAGE_SIZES,
    }),
    pending: Object.freeze({
      rows: Object.freeze(pendingResult.rows),
      pagination: Object.freeze(pendingResult.pagination),
      source: Object.freeze(rankingMeta(meta.storeSku ?? meta.sku, allStoreSkuRows.length)),
    }),
    canonical: Object.freeze({
      rows: Object.freeze(canonicalResult.rows),
      pagination: Object.freeze(canonicalResult.pagination),
      source: Object.freeze(rankingMeta(meta.product, rows(dashboard.productRanking).length)),
    }),
  });
}

export const PRODUCT_QUERY_WINDOW_KEYS = WINDOW_KEYS;
export const PRODUCT_QUERY_PAGE_SIZES = PAGE_SIZES;
