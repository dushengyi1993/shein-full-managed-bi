const STORE_PATTERN = /^[A-Z0-9]{2,12}$/;
const OWNER_PATTERN = /^[\p{L}\p{N}._:-]{1,64}$/u;
const QUERY_PARAMETERS = Object.freeze(new Set(['owner', 'store', 'q']));
const RESULT_LIMIT = 100;

export const RETURNS_DOMAIN_IDS = Object.freeze([
  'return-applications',
  'return-orders',
  'exceptions',
  'quality-reports',
]);

export class ReturnsQueryError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'ReturnsQueryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode = 400) {
  throw new ReturnsQueryError(code, message, statusCode);
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
  if (!values.length) return fallback;
  const value = values[0].normalize('NFKC').trim();
  if (value.length > maximum) fail('QUERY_PARAMETER_TOO_LONG', `参数 ${name} 过长`);
  if (pattern && value && !pattern.test(value)) fail('QUERY_PARAMETER_INVALID', `参数 ${name} 无效`);
  return value;
}

function searchable(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return searchable(value.value);
  }
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function matchesQuery(row, query) {
  if (!query) return true;
  return [
    row.id,
    row.storeCode,
    row.statusCode,
    row.statusName,
    row.primary,
    row.secondary,
    ...rows(row.tags),
    ...rows(row.facts),
    ...rows(row.details),
  ].some((value) => searchable(value).includes(query));
}

function instant(row, field) {
  const value = row?.[field];
  const parsed = value ? new Date(value).valueOf() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestFirst(left, right) {
  return instant(right, 'updatedAt') - instant(left, 'updatedAt')
    || instant(right, 'createdAt') - instant(left, 'createdAt')
    || String(left.id).localeCompare(String(right.id));
}

function projectEntry(value) {
  const source = record(value);
  return Object.freeze({
    name: source.name ?? null,
    value: source.value ?? null,
  });
}

// The shared loader validates the complete order-management contract before
// this query runs. Keep a second, explicit response projection here so a
// future producer cannot smuggle an extra top-level or nested property into a
// newly exposed API merely by widening an in-memory row object.
function projectReturnRow(value) {
  const source = record(value);
  return Object.freeze({
    id: source.id ?? null,
    storeCode: source.storeCode ?? null,
    statusCode: source.statusCode ?? null,
    statusName: source.statusName ?? null,
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null,
    primary: source.primary ?? null,
    secondary: source.secondary ?? null,
    tags: Object.freeze(rows(source.tags).filter((item) => typeof item === 'string')),
    metrics: Object.freeze(rows(source.metrics).map(projectEntry)),
    facts: Object.freeze(rows(source.facts).map(projectEntry)),
    details: Object.freeze(rows(source.details).map(projectEntry)),
  });
}

function dashboardStoreCodes(dashboard) {
  const codes = new Set();
  for (const item of rows(dashboard.stores)) {
    const code = String(item?.code || '').toUpperCase();
    if (code) codes.add(code);
  }
  // normalizeDashboardData intentionally exposes storeRanking rather than a
  // duplicate stores collection. Owners remain an independent roster source
  // for stores with no sales row in the selected date range.
  for (const item of rows(dashboard.storeRanking)) {
    const code = String(item?.code || item?.storeCode || '').toUpperCase();
    if (code) codes.add(code);
  }
  for (const owner of rows(dashboard.owners)) {
    for (const value of rows(owner?.storeCodes)) {
      const code = String(value || '').toUpperCase();
      if (code) codes.add(code);
    }
  }
  return [...codes].sort();
}

function ownerStoreSet(dashboard, ownerKey) {
  if (ownerKey === 'ALL') return null;
  const owner = rows(dashboard.owners).find((item) => item?.key === ownerKey);
  if (!owner) fail('QUERY_OWNER_UNKNOWN', '负责人不在当前数据范围内');
  return new Set(rows(owner.storeCodes).map((code) => String(code).toUpperCase()));
}

function scopedStoreCodes(dashboard, ownerStores, store) {
  const available = new Set(dashboardStoreCodes(dashboard));
  if (store !== 'ALL' && !available.has(store)) {
    fail('QUERY_STORE_UNKNOWN', '店铺不在当前数据范围内');
  }
  if (store !== 'ALL' && ownerStores && !ownerStores.has(store)) {
    fail('QUERY_SCOPE_CONFLICT', '店铺不属于当前负责人范围');
  }
  if (store !== 'ALL') return new Set([store]);
  if (ownerStores) return new Set([...ownerStores].filter((code) => available.has(code)));
  return available;
}

function normalizeCoverage(index, pageId, expectedStores, pageStatus) {
  const coverage = record(record(index.pageCoverage)[pageId]);
  const declaredStatus = ['COMPLETE', 'PARTIAL', 'UNKNOWN', 'UNAVAILABLE']
    .includes(String(coverage.status ?? '').toUpperCase())
    ? String(coverage.status).toUpperCase()
    : null;
  const completedSet = new Set(
    rows(coverage.storeCodes).map((code) => String(code).toUpperCase()),
  );
  const completedStoreCodes = [...expectedStores]
    .filter((code) => completedSet.has(code))
    .sort();
  const expectedStoreCount = expectedStores.size;
  const completedStoreCount = completedStoreCodes.length;
  // Store membership proves which stores produced an evidence partition; it
  // cannot repair a page that the upstream contract already degraded.  For
  // example, a PII-rejected row can leave all store codes present while the
  // page is PARTIAL.  Recomputing COMPLETE from counts alone would turn that
  // evidence failure into an explicit zero in the UI.
  const status = pageStatus === 'UNAVAILABLE' || declaredStatus === 'UNAVAILABLE'
    ? 'UNAVAILABLE'
    : pageStatus === 'PARTIAL' || declaredStatus === 'PARTIAL'
      ? 'PARTIAL'
      : declaredStatus === 'UNKNOWN'
        ? 'UNKNOWN'
        : expectedStoreCount > 0 && completedStoreCount === expectedStoreCount
      ? 'COMPLETE'
      : completedStoreCount > 0
        ? 'PARTIAL'
        : 'UNAVAILABLE';
  return Object.freeze({
    status,
    expectedStoreCount,
    completedStoreCount,
    completedStoreCodes: Object.freeze(completedStoreCodes),
    missingStoreCodes: Object.freeze(
      [...expectedStores].filter((code) => !completedSet.has(code)).sort(),
    ),
    reason: coverage.reason ?? null,
  });
}

function domainResult(index, pageId, expectedStores, query) {
  const page = record(record(index.pages)[pageId]);
  const pageStatus = ['AVAILABLE', 'PARTIAL', 'UNAVAILABLE'].includes(page.status)
    ? page.status
    : 'UNAVAILABLE';
  const coverage = normalizeCoverage(index, pageId, expectedStores, pageStatus);
  if (pageStatus === 'UNAVAILABLE') {
    return Object.freeze({
      pageId,
      status: 'UNAVAILABLE',
      source: page.source ?? null,
      latestSourceFetchedAt: page.latestSourceFetchedAt ?? null,
      reason: page.reason ?? '该业务域尚无可用事实',
      coverage,
      matchedRows: null,
      returnedRows: 0,
      truncated: false,
      rows: Object.freeze([]),
    });
  }
  const matched = rows(page.rows)
    .filter((row) => expectedStores.has(String(row?.storeCode || '').toUpperCase()))
    .filter((row) => matchesQuery(row, query))
    .sort(latestFirst);
  return Object.freeze({
    pageId,
    status: pageStatus,
    source: page.source ?? null,
    latestSourceFetchedAt: page.latestSourceFetchedAt ?? null,
    reason: page.reason ?? coverage.reason ?? null,
    coverage,
    matchedRows: matched.length,
    returnedRows: Math.min(matched.length, RESULT_LIMIT),
    truncated: matched.length > RESULT_LIMIT,
    rows: Object.freeze(matched.slice(0, RESULT_LIMIT).map(projectReturnRow)),
  });
}

export function queryReturnsDashboard(
  dashboardValue,
  orderManagementValue,
  paramsValue = new URLSearchParams(),
) {
  const params = paramsValue instanceof URLSearchParams
    ? paramsValue
    : new URLSearchParams(paramsValue);
  for (const key of params.keys()) {
    if (!QUERY_PARAMETERS.has(key)) {
      fail('QUERY_PARAMETER_UNKNOWN', `参数 ${key} 不受支持`);
    }
  }
  const dashboard = record(dashboardValue);
  const orderManagement = record(orderManagementValue);
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
  const q = textParam(params, 'q', { maximum: 120, fallback: '' });
  const ownerStores = ownerStoreSet(dashboard, owner);
  const storeCodes = scopedStoreCodes(dashboard, ownerStores, store);
  const query = searchable(q);
  const domains = Object.fromEntries(RETURNS_DOMAIN_IDS.map((pageId) => [
    pageId,
    domainResult(orderManagement, pageId, storeCodes, query),
  ]));
  const knownDomains = Object.values(domains).filter(
    ({ matchedRows }) => Number.isSafeInteger(matchedRows),
  );
  return Object.freeze({
    schemaVersion: 1,
    readOnly: true,
    updatedAt: orderManagement.updatedAt ?? null,
    scope: Object.freeze({
      owner,
      store,
      query: q,
      storeCount: storeCodes.size,
      storeCodes: Object.freeze([...storeCodes].sort()),
    }),
    summary: Object.freeze({
      availableDomainCount: knownDomains.length,
      totalDomainCount: RETURNS_DOMAIN_IDS.length,
      matchedMaterializedRows: knownDomains.reduce(
        (total, domain) => total + domain.matchedRows,
        0,
      ),
      allDomainsKnown: knownDomains.length === RETURNS_DOMAIN_IDS.length,
    }),
    domains: Object.freeze(domains),
  });
}
