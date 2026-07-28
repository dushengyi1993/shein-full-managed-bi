const STORE_PATTERN = /^[A-Z0-9]{2,12}$/;
const OWNER_PATTERN = /^[\p{L}\p{N}._:-]{1,64}$/u;
const INTEGER_PATTERN = /^[1-9][0-9]*$/;

const IDENTITIES = Object.freeze(['ALL', 'CANONICAL', 'UNMAPPED']);
const MOMENTUM_FILTERS = Object.freeze([
  'ALL',
  'GROWING',
  'DECLINING',
  'UNCOMPARABLE',
]);
const SORTS = Object.freeze([
  'LAST30_DESC',
  'LAST7_DESC',
  'TODAY_DESC',
  'MOMENTUM_DESC',
  'MOMENTUM_ASC',
]);

export class SalesQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SalesQueryError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new SalesQueryError(code, message);
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

function units(value) {
  const source = record(value);
  return {
    today: Number.isSafeInteger(source.today) && source.today >= 0 ? source.today : null,
    yesterday: Number.isSafeInteger(source.yesterday) && source.yesterday >= 0
      ? source.yesterday
      : null,
    last7Days: Number.isSafeInteger(source.last7Days) && source.last7Days >= 0
      ? source.last7Days
      : null,
    last30Days: Number.isSafeInteger(source.last30Days) && source.last30Days >= 0
      ? source.last30Days
      : null,
  };
}

function momentum(value) {
  const normalized = units(value);
  if (
    normalized.last7Days === null
    || normalized.last30Days === null
    || normalized.last30Days < normalized.last7Days
  ) {
    return {
      comparable: false,
      recentDailyAverage: null,
      previousDailyAverage: null,
      changeRate: null,
      direction: 'UNCOMPARABLE',
    };
  }
  const recent = normalized.last7Days / 7;
  const previous = (normalized.last30Days - normalized.last7Days) / 23;
  if (previous === 0) {
    return {
      comparable: true,
      recentDailyAverage: recent,
      previousDailyAverage: previous,
      changeRate: null,
      direction: recent > 0 ? 'NEW' : 'FLAT',
    };
  }
  const rate = (recent - previous) / previous;
  return {
    comparable: true,
    recentDailyAverage: recent,
    previousDailyAverage: previous,
    changeRate: rate,
    direction: rate >= 0.1 ? 'GROWING' : rate <= -0.1 ? 'DECLINING' : 'FLAT',
  };
}

function withMomentum(row) {
  return { ...row, momentum: momentum(row.unitsSold) };
}

function ownerStoreSet(dashboard, ownerKey) {
  if (ownerKey === 'ALL') return null;
  const owner = rows(dashboard.owners).find((item) => item.key === ownerKey);
  if (!owner) fail('QUERY_OWNER_UNKNOWN', '负责人不在当前数据范围内');
  return new Set(rows(owner.storeCodes).map((code) => String(code).toUpperCase()));
}

function rowStoreCodes(row) {
  const values = rows(row.storeCodes).map((code) => String(code).toUpperCase());
  const direct = String(row.storeCode ?? row.code ?? '').toUpperCase();
  if (direct !== '') values.push(direct);
  return [...new Set(values.filter((code) => STORE_PATTERN.test(code)))];
}

function matchesScope(row, { store, ownerStores }) {
  const codes = rowStoreCodes(row);
  if (store !== 'ALL' && !codes.includes(store)) return false;
  return ownerStores === null || codes.some((code) => ownerStores.has(code));
}

function containsQuery(row, query) {
  if (query === '') return true;
  return [
    row.code,
    row.name,
    row.storeCode,
    row.sku,
    row.skc,
    row.supplierCode,
    row.supplierSku,
    row.productKey,
    row.canonicalProductId,
    row.standardProductCode,
    row.standardProductName,
  ].some((value) => searchable(value).includes(query));
}

function isCanonical(row) {
  return (
    row.identityLevel === 'CANONICAL_CONFIRMED'
    || row.mappingStatus === 'CONFIRMED'
  ) && Boolean(row.standardProductCode || row.canonicalProductId);
}

function matchesIdentity(row, identity) {
  if (identity === 'ALL') return true;
  return identity === 'CANONICAL' ? isCanonical(row) : !isCanonical(row);
}

function matchesMomentum(row, filter) {
  if (filter === 'ALL') return true;
  const signal = row.momentum;
  if (filter === 'UNCOMPARABLE') return signal.comparable !== true;
  return signal.direction === filter;
}

function rankValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN');
}

function comparator(sort) {
  return (left, right) => {
    if (sort === 'MOMENTUM_DESC' || sort === 'MOMENTUM_ASC') {
      const leftRate = left.momentum.changeRate;
      const rightRate = right.momentum.changeRate;
      const leftComparable = Number.isFinite(leftRate);
      const rightComparable = Number.isFinite(rightRate);
      if (leftComparable && rightComparable) {
        const delta = sort === 'MOMENTUM_DESC'
          ? rightRate - leftRate
          : leftRate - rightRate;
        if (delta !== 0) return delta;
      } else if (leftComparable !== rightComparable) {
        // Comparable rows always precede unknown/zero-baseline rates.
        return leftComparable ? -1 : 1;
      }
    } else {
      const field = sort === 'TODAY_DESC'
        ? 'today'
        : sort === 'LAST7_DESC' ? 'last7Days' : 'last30Days';
      const delta = rankValue(right.unitsSold?.[field]) - rankValue(left.unitsSold?.[field]);
      if (delta !== 0) return delta;
    }
    return (
      compareText(left.storeCode ?? left.code, right.storeCode ?? right.code)
      || compareText(
        left.standardProductCode ?? left.sku ?? left.productKey,
        right.standardProductCode ?? right.sku ?? right.productKey,
      )
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
  const returned = Number.isSafeInteger(source.returnedCount) && source.returnedCount >= 0
    ? source.returnedCount
    : returnedFallback;
  const total = Number.isSafeInteger(source.totalCount) && source.totalCount >= returned
    ? source.totalCount
    : returned;
  return {
    returned,
    total,
    truncated: source.truncated === true || total > returned,
  };
}

function filterOwners(dashboard) {
  return rows(dashboard.owners).map((owner) => ({
    key: owner.key,
    name: owner.name,
    storeCodes: rows(owner.storeCodes),
  }));
}

function filterStores(dashboard) {
  return rows(dashboard.storeRanking)
    .filter((row) => STORE_PATTERN.test(String(row.code ?? '').toUpperCase()))
    .map((row) => ({ code: String(row.code).toUpperCase(), name: row.name || row.code }));
}

/**
 * Query only the strict, materialized sales ranking evidence in dashboard.json.
 * All counts are named as materialized counts and carry source truncation
 * metadata; this endpoint never claims warehouse or SHEIN completeness.
 */
export function querySalesDashboard(dashboardValue, paramsValue = new URLSearchParams()) {
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
  const identity = enumParam(params, 'identity', IDENTITIES, 'ALL');
  const momentumFilter = enumParam(
    params,
    'momentum',
    MOMENTUM_FILTERS,
    'ALL',
  );
  const sort = enumParam(params, 'sort', SORTS, 'LAST30_DESC');
  const productPage = integerParam(params, 'productPage', {
    fallback: 1,
    minimum: 1,
    maximum: 10_000,
  });
  const standardPage = integerParam(params, 'standardPage', {
    fallback: 1,
    minimum: 1,
    maximum: 10_000,
  });
  const pageSize = integerParam(params, 'pageSize', {
    fallback: 50,
    minimum: 1,
    maximum: 100,
  });
  const ownerStores = ownerStoreSet(dashboard, owner);
  const scope = { store, ownerStores };
  const compare = comparator(sort);

  const storeRows = rows(dashboard.storeRanking)
    .filter((row) => matchesScope(row, scope) && containsQuery(row, query))
    .map(withMomentum)
    .filter((row) => matchesMomentum(row, momentumFilter))
    .sort(compare);
  const products = rows(dashboard.storeSkuRanking)
    .filter((row) => (
      matchesScope(row, scope)
      && containsQuery(row, query)
      && matchesIdentity(row, identity)
    ))
    .map(withMomentum)
    .filter((row) => matchesMomentum(row, momentumFilter))
    .sort(compare);
  const standards = rows(dashboard.productRanking)
    .filter((row) => (
      identity !== 'UNMAPPED'
      &&
      isCanonical(row)
      && matchesScope(row, scope)
      && containsQuery(row, query)
    ))
    .map(withMomentum)
    .filter((row) => matchesMomentum(row, momentumFilter))
    .sort(compare);

  const productResult = paginate(products, productPage, pageSize);
  const standardResult = paginate(standards, standardPage, pageSize);
  const meta = record(dashboard.rankingMeta);

  return Object.freeze({
    schemaVersion: 1,
    readOnly: true,
    source: Object.freeze({
      dashboardUpdatedAt: dashboard.updatedAt ?? null,
      businessDate: dashboard.businessDate ?? null,
      datasetStatus: record(dashboard.dataset).status ?? null,
      salesCoverage: record(dashboard.salesCoverage),
      quality: record(dashboard.quality),
      materializedRankings: Object.freeze({
        store: rankingMeta(meta.store, rows(dashboard.storeRanking).length),
        storeSku: rankingMeta(meta.storeSku, rows(dashboard.storeSkuRanking).length),
        product: rankingMeta(meta.product, rows(dashboard.productRanking).length),
      }),
    }),
    query: Object.freeze({
      owner,
      store,
      q: rawQuery,
      identity,
      momentum: momentumFilter,
      sort,
      productPage,
      standardPage,
      pageSize,
    }),
    summary: Object.freeze({
      matchedMaterializedStoreCount: storeRows.length,
      matchedMaterializedProductCount: products.length,
      matchedMaterializedStandardProductCount: standards.length,
    }),
    filters: Object.freeze({
      owners: Object.freeze(filterOwners(dashboard)),
      stores: Object.freeze(filterStores(dashboard)),
      identities: IDENTITIES,
      momentum: MOMENTUM_FILTERS,
      sorts: SORTS,
    }),
    stores: Object.freeze({ rows: Object.freeze(storeRows) }),
    products: Object.freeze({
      rows: Object.freeze(productResult.rows),
      pagination: Object.freeze(productResult.pagination),
    }),
    standardProducts: Object.freeze({
      rows: Object.freeze(standardResult.rows),
      pagination: Object.freeze(standardResult.pagination),
    }),
  });
}
