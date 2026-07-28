const numberFormatter = new Intl.NumberFormat('zh-CN');
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  hour12: false,
});

const ROUTES = Object.freeze({
  home: { title: '总控驾驶舱', code: 'CONTROL' },
  procurement: { title: '采购单', code: 'PO' },
  fulfilment: { title: '交付入仓', code: 'INBOUND' },
  products: { title: '商品中心', code: 'MDM' },
  sales: { title: '销量洞察', code: 'SALES' },
  inventory: { title: '供给与备货', code: 'SUPPLY' },
  returns: { title: '采购退货', code: 'RETURNS' },
  compliance: { title: '合规与价格', code: 'COMPLIANCE' },
  finance: { title: '财务结算', code: 'FINANCE' },
  platform: { title: '平台动态', code: 'WEBHOOK' },
  ops: { title: '运营待办', code: 'AUTOMATION' },
  system: { title: '数据健康', code: 'SYSTEM' },
});

const RANGE_META = Object.freeze({
  today: { label: '今日', note: '当日累计', days: 1 },
  yesterday: { label: '昨日', note: '完整自然日', days: 1 },
  last7Days: { label: '近 7 日', note: '预聚合滚动窗口', days: 7 },
  last30Days: { label: '近 30 日', note: '预聚合滚动窗口', days: 30 },
});

const WINDOW_KEYS = Object.freeze(['today', 'yesterday', 'last7Days', 'last30Days']);

/* --- canonical-hash-state:start ---
   Pure, DOM-free investigation-state contract.

   URL shape: #<route>?scope=<ALL|OWNER:key|STORE:code>&range=<window>
              &q=<text>&quick=<value>&focus=<domain:store:code>

   Defaults are omitted so a shared link stays short. Every value is
   allow-listed; anything unknown falls back to the default instead of throwing,
   and nothing parsed here is ever treated as HTML. */

const URL_ROUTE_KEYS = Object.freeze([
  'home', 'procurement', 'fulfilment', 'products', 'sales', 'inventory',
  'returns', 'compliance', 'finance', 'platform', 'ops', 'system',
]);

const URL_RANGE_KEYS = Object.freeze(['today', 'yesterday', 'last7Days', 'last30Days']);

const URL_DEFAULT_ROUTE = 'home';
const URL_DEFAULT_RANGE = 'today';

/** Focus domains map one alert or row to the surface that can prove it. */
const FOCUS_DOMAINS = Object.freeze({
  inventory: { route: 'inventory', label: '库存风险' },
  advice: { route: 'inventory', label: '备货建议' },
  procurement: { route: 'procurement', label: '采购单' },
  fulfilment: { route: 'fulfilment', label: '交付单' },
  product: { route: 'products', label: '商品身份' },
  ops: { route: 'ops', label: '运营提醒' },
});

const QUICK_FILTER_VALUES = Object.freeze([
  'ALL', 'HIGH', 'SHORTAGE', 'URGENT', 'ADVICE', 'SYNC',
  'PENDING_DELIVERY', 'PENDING_RECEIPT', 'PENDING_STORAGE', 'OVERDUE',
  'GROWING', 'DECLINING', 'UNCOMPARABLE', 'CANONICAL', 'UNMAPPED',
  'WITH_SALES', 'MISSING_SPU',
]);

const URL_STORE_PATTERN = /^[A-Z0-9]{2,12}$/;
const URL_OWNER_PATTERN = /^[\p{L}\p{N}._:-]{1,64}$/u;
const URL_CODE_PATTERN = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>"'`\\]{1,120}$/u;
const URL_CODE_MAX = 120;
const URL_QUERY_MAX = 120;

function urlSafeText(value, maxLength) {
  // Preserve Unicode business text (Chinese search terms, owner keys and
  // supplier codes) while removing controls and markup delimiters before the
  // value reaches state. Rendering still escapes every value independently.
  return Array.from(String(value ?? ''))
    .filter((character) => (
      !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character)
      && !['<', '>', '"', "'", '`', '\\'].includes(character)
    ))
    .slice(0, maxLength)
    .join('')
    .trim();
}

function parseScopeToken(value) {
  const token = urlSafeText(value, 80);
  if (token === '' || token === 'ALL') return { owner: 'ALL', store: 'ALL' };
  if (token.startsWith('STORE:')) {
    const store = token.slice(6).toUpperCase();
    return URL_STORE_PATTERN.test(store)
      ? { owner: 'ALL', store }
      : { owner: 'ALL', store: 'ALL' };
  }
  if (token.startsWith('OWNER:')) {
    const owner = token.slice(6);
    return URL_OWNER_PATTERN.test(owner)
      ? { owner, store: 'ALL' }
      : { owner: 'ALL', store: 'ALL' };
  }
  return { owner: 'ALL', store: 'ALL' };
}

function serializeScopeToken({ owner = 'ALL', store = 'ALL' } = {}) {
  if (store && store !== 'ALL') return `STORE:${store}`;
  if (owner && owner !== 'ALL') return `OWNER:${owner}`;
  return 'ALL';
}

/** `domain:store:code`; the code may itself contain separators. */
function parseFocusToken(value) {
  const token = urlSafeText(value, URL_CODE_MAX + 40);
  if (token === '') return null;
  const separator = token.indexOf(':');
  if (separator <= 0) return null;
  const domain = token.slice(0, separator);
  if (!Object.prototype.hasOwnProperty.call(FOCUS_DOMAINS, domain)) return null;
  const rest = token.slice(separator + 1);
  const storeSeparator = rest.indexOf(':');
  const storeCode = storeSeparator === -1
    ? ''
    : rest.slice(0, storeSeparator).toUpperCase();
  const code = storeSeparator === -1 ? rest : rest.slice(storeSeparator + 1);
  if (storeCode !== '' && !URL_STORE_PATTERN.test(storeCode)) return null;
  if (!URL_CODE_PATTERN.test(code)) return null;
  return { domain, storeCode, code };
}

function serializeFocusToken(focus) {
  if (!focus || !Object.prototype.hasOwnProperty.call(FOCUS_DOMAINS, focus.domain)) {
    return '';
  }
  const code = urlSafeText(focus.code, URL_CODE_MAX);
  if (!URL_CODE_PATTERN.test(code)) return '';
  const storeCode = urlSafeText(focus.storeCode, 12).toUpperCase();
  return `${focus.domain}:${URL_STORE_PATTERN.test(storeCode) ? storeCode : ''}:${code}`;
}

/**
 * Parse a location hash into investigation state.
 *
 * A bare hash such as `#inventory` is main-nav navigation: it carries no
 * parameters, so the caller's current scope/range/query are inherited and the
 * focus is cleared. A hash with a query string is a canonical link, so absent
 * parameters mean their default value.
 */
function parseHashState(rawHash, inherited = {}) {
  const hash = String(rawHash ?? '').replace(/^#/, '');
  const separator = hash.indexOf('?');
  const routeToken = urlSafeText(separator === -1 ? hash : hash.slice(0, separator), 40);
  const route = URL_ROUTE_KEYS.includes(routeToken) ? routeToken : URL_DEFAULT_ROUTE;
  const isCanonicalLink = separator !== -1;
  if (!isCanonicalLink) {
    return {
      route,
      owner: inherited.owner ?? 'ALL',
      store: inherited.store ?? 'ALL',
      range: URL_RANGE_KEYS.includes(inherited.range) ? inherited.range : URL_DEFAULT_RANGE,
      query: urlSafeText(inherited.query, URL_QUERY_MAX),
      quick: 'ALL',
      // Navigating to another surface invalidates a focus that belonged to the
      // previous one.
      focus: null,
      canonicalLink: false,
    };
  }

  const params = new URLSearchParams(hash.slice(separator + 1));
  const scope = parseScopeToken(params.get('scope'));
  const rangeToken = urlSafeText(params.get('range'), 20);
  const quickToken = urlSafeText(params.get('quick'), 32).toUpperCase();
  const focus = parseFocusToken(params.get('focus'));
  return {
    route,
    owner: scope.owner,
    store: scope.store,
    range: URL_RANGE_KEYS.includes(rangeToken) ? rangeToken : URL_DEFAULT_RANGE,
    query: urlSafeText(params.get('q'), URL_QUERY_MAX),
    quick: QUICK_FILTER_VALUES.includes(quickToken) ? quickToken : 'ALL',
    // A focus only applies on the surface that can prove it.
    focus: focus && FOCUS_DOMAINS[focus.domain].route === route ? focus : null,
    canonicalLink: true,
  };
}

/** Deterministic serialization: fixed parameter order, defaults omitted. */
function serializeHashState(input = {}) {
  const route = URL_ROUTE_KEYS.includes(input.route) ? input.route : URL_DEFAULT_ROUTE;
  const params = new URLSearchParams();
  const scope = serializeScopeToken(input);
  if (scope !== 'ALL') params.set('scope', scope);
  if (URL_RANGE_KEYS.includes(input.range) && input.range !== URL_DEFAULT_RANGE) {
    params.set('range', input.range);
  }
  const query = urlSafeText(input.query, URL_QUERY_MAX);
  if (query !== '') params.set('q', query);
  const quick = urlSafeText(input.quick, 32).toUpperCase();
  if (QUICK_FILTER_VALUES.includes(quick) && quick !== 'ALL') params.set('quick', quick);
  const focus = input.focus && FOCUS_DOMAINS[input.focus.domain]?.route === route
    ? serializeFocusToken(input.focus)
    : '';
  if (focus !== '') params.set('focus', focus);
  const search = params.toString();
  return search === '' ? `#${route}` : `#${route}?${search}`;
}

/** Canonical link builder used by every alert and row drilldown. */
function canonicalHref({ route, storeCode = '', range, query = '', quick = 'ALL', focus = null } = {}) {
  const targetRoute = URL_ROUTE_KEYS.includes(route) ? route : URL_DEFAULT_ROUTE;
  const store = urlSafeText(storeCode, 12).toUpperCase();
  return serializeHashState({
    route: targetRoute,
    store: URL_STORE_PATTERN.test(store) ? store : 'ALL',
    owner: 'ALL',
    range,
    query,
    quick,
    focus,
  });
}
/* --- canonical-hash-state:end --- */

const GROUP_LABELS = Object.freeze({
  procurement: '采购单',
  fulfilment: '交付入仓',
  inventory: '库存与缺货',
  supply: '备货建议',
  products: '商品身份',
  platform: 'Webhook 事件',
  system: '数据质量与同步',
  other: '运营复核',
});

const EXPECTED_READINESS = Object.freeze([
  { key: 'applications', label: '全托应用审核', note: '需要逐店应用列表回读证据' },
  { key: 'sales_permission', label: '销量权限包', note: '需要逐店权限包审批结果' },
  { key: 'store_authorization', label: '店铺授权', note: '需要店铺授权与凭证交换证据' },
  { key: 'sales_probe', label: '接口探针', note: '以真实销量接口业务成功为准' },
  { key: 'fact_load', label: '事实入仓', note: '探针和字段对账通过后开始' },
]);

const SUPPLY_COVERAGE_META = Object.freeze({
  productCatalog: '商品目录',
  productDetails: '商品详情',
  inventory: '库存快照',
  stockAdvice: '备货建议',
  purchaseOrders: '采购单',
  deliveries: '交付单',
});

const initialHashState = parseHashState(
  typeof window === 'undefined' ? '' : window.location.hash,
);

const state = {
  route: initialHashState.route,
  range: initialHashState.range,
  query: initialHashState.query,
  owner: initialHashState.owner,
  store: initialHashState.store,
  quickFilters: Object.assign(Object.create(null), (
    initialHashState.quick === 'ALL' ? {} : { [initialHashState.route]: initialHashState.quick }
  )),
  // Read-only investigation target restored from the canonical link.
  focus: initialHashState.focus,
  data: null,
  health: null,
  healthError: '',
  loading: true,
  error: '',
};

const elements = {
  view: document.querySelector('#view'),
  navLinks: [...document.querySelectorAll('[data-route]')],
  search: document.querySelector('#global-search'),
  scope: document.querySelector('#scope-filter'),
  rangeButtons: [...document.querySelectorAll('[data-range]')],
  rangeSummary: document.querySelector('#range-summary'),
  clearFilters: document.querySelector('#clear-filters'),
  datasetBadge: document.querySelector('#dataset-badge'),
  updatedAt: document.querySelector('#updated-at'),
  sidebarDataset: document.querySelector('#sidebar-dataset'),
  sidebarPermission: document.querySelector('#sidebar-permission'),
  sidebarSampleNote: document.querySelector('#sidebar-sample-note'),
  mobilePageTitle: document.querySelector('#mobile-page-title'),
  errorPanel: document.querySelector('#error-panel'),
  errorMessage: document.querySelector('#error-message'),
  retryButton: document.querySelector('#retry-button'),
  logoutButton: document.querySelector('#logout-button'),
};

function routeFromLocation() {
  const candidate = String(window.location.hash || '').replace(/^#/, '');
  return Object.prototype.hasOwnProperty.call(ROUTES, candidate) ? candidate : 'home';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]);
}

function isUnit(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function formatUnits(value) {
  return isUnit(value) ? numberFormatter.format(value) : '—';
}

function formatDateTime(value) {
  if (!value) return '暂无有效销量快照';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '更新时间待确认' : dateTimeFormatter.format(date);
}

function datasetStatus() {
  const status = state.data?.dataset?.status;
  return ['live', 'sample', 'empty'].includes(status) ? status : 'neutral';
}

function datasetLabel() {
  return state.data?.dataset?.label || '数据状态待确认';
}

function sourceLabel() {
  return datasetStatus() === 'sample' ? '示例数据' : datasetLabel();
}

function sourceChip() {
  return `<span class="source-chip ${escapeHtml(datasetStatus())}">${escapeHtml(sourceLabel())}</span>`;
}

function sampleNotice() {
  if (datasetStatus() !== 'sample') return '';
  return `
    <aside class="dataset-notice" aria-label="示例数据提示">
      <strong>示例数据环境</strong>
      <span>本页销量数字仅用于验证界面、筛选和接入流程，不代表任何店铺的真实经营结果。</span>
    </aside>`;
}

function readinessStages() {
  const incoming = Array.isArray(state.data?.readiness) ? state.data.readiness : [];
  const byKey = new Map(incoming.map((stage) => [stage.key, stage]));
  const knownKeys = new Set(EXPECTED_READINESS.map((stage) => stage.key));
  const expected = EXPECTED_READINESS.map((stage) => {
    const provided = byKey.get(stage.key);
    return provided || {
      ...stage,
      status: 'unknown',
      statusLabel: '待确认',
      completed: null,
      total: null,
    };
  });
  const extra = incoming.filter((stage) => !knownKeys.has(stage.key));
  return [...expected, ...extra];
}

function readinessClass(status) {
  return ['complete', 'partial', 'pending', 'not_started', 'blocked'].includes(status)
    ? status.replace('_', '-')
    : 'unknown';
}

function readinessCount(stage) {
  return isUnit(stage?.completed) && isUnit(stage?.total)
    ? `${numberFormatter.format(stage.completed)} / ${numberFormatter.format(stage.total)}`
    : '证据待接入';
}

function activeReadinessStage() {
  const stages = readinessStages();
  return stages.find((stage) => stage.status !== 'complete') || stages.at(-1);
}

function normalizedQuery() {
  return state.query.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function baseStores() {
  return Array.isArray(state.data?.storeRanking) ? state.data.storeRanking : [];
}

function ownerKeyForStore(store) {
  return String(store?.ownerKey || store?.owner?.key || '').trim();
}

function ownerNameForStore(store) {
  return String(store?.ownerName || store?.owner?.name || '').trim();
}

function allOwners() {
  const provided = Array.isArray(state.data?.owners) ? state.data.owners : [];
  const visibleStoreCodes = new Set(baseStores().map(({ code }) => String(code)));
  const byKey = new Map();

  provided.forEach((owner) => {
    const key = String(owner?.key || '').trim();
    if (!key) return;
    byKey.set(key, {
      key,
      name: String(owner?.name || key),
      storeCodes: new Set(
        Array.isArray(owner?.storeCodes)
          ? owner.storeCodes.map(String).filter((code) => visibleStoreCodes.has(code))
          : [],
      ),
      salesTrend: Array.isArray(owner?.salesTrend) ? owner.salesTrend : [],
    });
  });

  baseStores().forEach((store) => {
    const key = ownerKeyForStore(store);
    if (!key) return;
    const owner = byKey.get(key) || {
      key,
      name: ownerNameForStore(store) || key,
      storeCodes: new Set(),
      salesTrend: [],
    };
    owner.storeCodes.add(String(store.code));
    byKey.set(key, owner);
  });

  return [...byKey.values()]
    .filter((owner) => owner.storeCodes.size > 0)
    .map((owner) => ({
      ...owner,
      storeCodes: [...owner.storeCodes],
    }));
}

function selectedOwner() {
  return state.owner === 'ALL'
    ? null
    : allOwners().find((owner) => owner.key === state.owner) || null;
}

function storeMatchesOwner(store) {
  const owner = selectedOwner();
  if (!owner) return true;
  return ownerKeyForStore(store) === owner.key || owner.storeCodes.includes(String(store.code));
}

function allStores() {
  return baseStores().filter(storeMatchesOwner);
}

function allSkus() {
  return Array.isArray(state.data?.skuRanking) ? state.data.skuRanking : [];
}

function canonicalProducts() {
  return Array.isArray(state.data?.productRanking) ? state.data.productRanking : [];
}

function isCanonicalProduct(item) {
  const level = String(item?.identityLevel || item?.identityScope || '').toUpperCase();
  const confirmedStoreSku = (
    String(item?.mappingStatus || '').toUpperCase() === 'CONFIRMED'
    && Boolean(item?.canonicalProductId)
    && Boolean(item?.standardProductCode)
  );
  return (
    confirmedStoreSku
    || (
      (level === 'CANONICAL_CONFIRMED' || level === 'CANONICAL')
      && Boolean(item?.canonicalProductId || item?.standardProductCode)
    )
  );
}

function rankingProducts() {
  const products = canonicalProducts();
  if (products.length) {
    const confirmedRows = products.filter(isCanonicalProduct);
    const localRows = products.filter((item) => !isCanonicalProduct(item));
    return {
      rows: products,
      confirmedRows,
      localRows,
      canonical: localRows.length === 0,
      mixed: confirmedRows.length > 0 && localRows.length > 0,
      unmappedCount: localRows.length,
    };
  }
  const rows = allSkus();
  return {
    rows,
    confirmedRows: [],
    localRows: rows,
    canonical: false,
    mixed: false,
    unmappedCount: rows.length,
  };
}

function selectedStore() {
  return state.store === 'ALL'
    ? null
    : baseStores().find((store) => store.code === state.store && storeMatchesOwner(store)) || null;
}

function matchingEntities(items) {
  const query = normalizedQuery();
  if (!query) return items;
  return items.filter((item) => {
    const haystack = [
      item.canonicalProductId,
      item.standardProductCode,
      item.standardProductName,
      item.productKey,
      item.supplierCode,
      item.supplierSku,
      item.skc,
      item.sku,
      item.name,
    ].filter(Boolean).join(' ')
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN');
    return haystack.includes(query);
  });
}

function matchingSkus() {
  return matchingEntities(allSkus());
}

function matchingProducts() {
  const source = rankingProducts();
  return { ...source, rows: matchingEntities(source.rows) };
}

function productCode(item, canonical = isCanonicalProduct(item)) {
  if (canonical) {
    return item.standardProductCode || item.canonicalProductId || '标准商品待编号';
  }
  return item.productKey || item.supplierCode || item.skc || item.sku || '店内商品待确认';
}

function productName(item) {
  return item.name || item.standardProductName || item.sku || '商品名称待确认';
}

function productIdentityLabel(source = scopedProductRanking()) {
  if (source.mixed) return '完整商品排行（标准与店内身份分开）';
  return source.canonical ? '标准商品排行' : '店内商品排行（标准商品待归并）';
}

function identityCoverage() {
  const incoming = state.data?.productIdentityCoverage || {};
  const total = isUnit(incoming.totalSkus) ? incoming.totalSkus : allSkus().length;
  const confirmed = isUnit(incoming.confirmedSkus)
    ? Math.min(incoming.confirmedSkus, total)
    : allSkus().filter((item) => String(item?.mappingStatus || '').toUpperCase() === 'CONFIRMED').length;
  const rate = total > 0 ? confirmed / total : null;
  return {
    total,
    confirmed,
    unconfirmed: Math.max(total - confirmed, 0),
    missingSpu: isUnit(incoming.missingSpuSkus) ? incoming.missingSpuSkus : null,
    rate,
    label: rate === null ? '标准身份覆盖待确认' : `标准身份覆盖 ${(rate * 100).toFixed(1)}%`,
  };
}

function productIdentityBadge(item) {
  const canonical = isCanonicalProduct(item);
  return `<span class="row-status ${canonical ? 'complete' : 'partial'}">${canonical ? '标准商品' : '店内身份'}</span>`;
}

function storeSkuRows() {
  const visibleStoreCodes = new Set(baseStores().map(({ code }) => String(code)));
  return Array.isArray(state.data?.storeSkuRanking)
    ? state.data.storeSkuRanking.filter((row) => visibleStoreCodes.has(String(row?.storeCode || '')))
    : [];
}

function matchingStoreSkuRows() {
  const owner = selectedOwner();
  const store = selectedStore();
  const ownerStoreCodes = owner ? new Set(owner.storeCodes.map(String)) : null;
  return matchingEntities(storeSkuRows()).filter((row) => {
    const rowStoreCode = String(row?.storeCode || '');
    if (store && rowStoreCode !== String(store.code)) return false;
    if (!store && ownerStoreCodes && !ownerStoreCodes.has(rowStoreCode)) return false;
    return true;
  });
}

function unmappedStoreSkuRows() {
  return matchingStoreSkuRows().filter(
    (row) => String(row?.mappingStatus || '').toUpperCase() !== 'CONFIRMED',
  );
}

function mappingStatusLabel(value) {
  const status = String(value || '').toUpperCase();
  if (status === 'CONFIRMED') return '已确认归并';
  if (status === 'MISSING_SPU_ID') return '缺少平台 SPU，无法自动归并';
  return '等待证据归并';
}

function sumCompleteWindow(items, key) {
  if (!items.length) return null;
  const values = items.map((item) => item?.unitsSold?.[key]);
  if (values.some((value) => !isUnit(value))) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function scopedUnits() {
  const store = selectedStore();
  const owner = selectedOwner();
  const query = normalizedQuery();

  if (store && query) {
    const rows = matchingStoreSkuRows();
    return {
      units: {
        today: sumCompleteWindow(rows, 'today'),
        yesterday: sumCompleteWindow(rows, 'yesterday'),
        last7Days: sumCompleteWindow(rows, 'last7Days'),
        last30Days: sumCompleteWindow(rows, 'last30Days'),
      },
      title: rows.length ? `${store.name || store.code} · 当前货号筛选` : '店铺 × 货号事实未接入',
      note: rows.length
        ? '只汇总带店铺键的货号销量事实。'
        : '当前数据没有店铺到货号的交叉事实，不会用全局排行冒充店铺结果。',
    };
  }

  if (store) {
    return {
      units: store.unitsSold || {},
      title: `${store.name || store.code} 店铺汇总`,
      note: '来自带店铺键的销量快照；缺失窗口保持空白。',
    };
  }

  if (owner && query) {
    const rows = matchingStoreSkuRows();
    return {
      units: {
        today: sumCompleteWindow(rows, 'today'),
        yesterday: sumCompleteWindow(rows, 'yesterday'),
        last7Days: sumCompleteWindow(rows, 'last7Days'),
        last30Days: sumCompleteWindow(rows, 'last30Days'),
      },
      title: rows.length ? `${owner.name} · 当前货号筛选` : '负责人 × 货号事实未接入',
      note: rows.length
        ? '只汇总该负责人店铺范围内带店铺键的货号销量事实。'
        : '当前数据无法把全局货号排行安全拆到负责人范围。',
    };
  }

  if (query) {
    const products = matchingProducts();
    const rows = products.rows;
    return {
      units: {
        today: sumCompleteWindow(rows, 'today'),
        yesterday: sumCompleteWindow(rows, 'yesterday'),
        last7Days: sumCompleteWindow(rows, 'last7Days'),
        last30Days: sumCompleteWindow(rows, 'last30Days'),
      },
      title: products.canonical ? '当前标准商品筛选合计' : '当前可见 SKU 清单合计',
      note: rows.length
        ? (products.canonical
          ? '仅合计已完成标准商品归并且命中搜索的行。'
          : '标准商品尚未归并；仅合计命中搜索的原始 SKU 行。')
        : '当前商品清单中没有匹配项。',
    };
  }

  if (owner) {
    const stores = allStores();
    return {
      units: {
        today: sumCompleteWindow(stores, 'today'),
        yesterday: sumCompleteWindow(stores, 'yesterday'),
        last7Days: sumCompleteWindow(stores, 'last7Days'),
        last30Days: sumCompleteWindow(stores, 'last30Days'),
      },
      title: `${owner.name} 负责店铺汇总`,
      note: stores.length
        ? `仅汇总负责人归属表中的 ${stores.length} 家店铺。`
        : '当前负责人没有生效中的店铺归属。',
    };
  }

  return {
    units: state.data?.unitsSold || {},
    title: '全部店铺销量汇总',
    note: '来自只读 API 的预聚合销量数量。',
  };
}

function priorTwentyThreeDays(units) {
  return (
    isUnit(units?.last30Days)
    && isUnit(units?.last7Days)
    && units.last30Days >= units.last7Days
  )
    ? units.last30Days - units.last7Days
    : null;
}

/** Count entities that actually carry a fact for one window; absence stays absence. */
function windowFactCoverage(windowKey) {
  const stores = selectedStore() ? [selectedStore()] : allStores();
  const products = scopedProductRanking().rows;
  return {
    stores: stores.filter((item) => isUnit(item?.unitsSold?.[windowKey])).length,
    storeTotal: stores.length,
    products: products.filter((item) => isUnit(item?.unitsSold?.[windowKey])).length,
    productTotal: products.length,
  };
}

/** Only compare windows that share a caliber; otherwise stay explicitly incomparable. */
function windowChange(windowKey, units) {
  if (windowKey === 'today') {
    if (!isUnit(units.today) || !isUnit(units.yesterday)) {
      return { label: '不可比', note: '缺完整昨日窗口', tone: 'unknown' };
    }
    return {
      label: formatDelta(units.today, units.yesterday),
      note: '对昨日 · 今日仍在累计',
      tone: '',
    };
  }
  if (windowKey === 'last7Days') {
    const previous = priorTwentyThreeDays(units);
    if (previous === null) {
      return { label: '不可比', note: '缺此前 23 日窗口', tone: 'unknown' };
    }
    return {
      label: formatDelta(Math.round(units.last7Days / 7), Math.round(previous / 23)),
      note: '近 7 日日均对此前 23 日日均',
      tone: '',
    };
  }
  if (windowKey === 'yesterday') {
    return { label: '不可比', note: 'API 未提供前日窗口', tone: 'unknown' };
  }
  return { label: '不可比', note: 'API 未提供前 30 日窗口', tone: 'unknown' };
}

function rowWindowSupported() {
  if (state.range !== 'yesterday') return true;
  return [...allStores(), ...scopedProductRanking().rows]
    .some((item) => isUnit(item?.unitsSold?.yesterday));
}

function sortBySelectedRange(items) {
  if (!rowWindowSupported()) return [];
  return [...items].sort((left, right) => {
    const leftValue = left?.unitsSold?.[state.range];
    const rightValue = right?.unitsSold?.[state.range];
    const normalizedLeft = isUnit(leftValue) ? leftValue : -1;
    const normalizedRight = isUnit(rightValue) ? rightValue : -1;
    return normalizedRight - normalizedLeft;
  });
}

function storeRowsForView() {
  if (normalizedQuery()) return [];
  const rows = selectedStore() ? [selectedStore()] : allStores();
  return sortBySelectedRange(rows);
}

function aggregateCanonicalProducts(rows) {
  const windows = Object.keys(RANGE_META);
  const grouped = new Map();
  rows.forEach((row) => {
    const key = String(row.canonicalProductId || row.standardProductCode || '');
    if (!key) return;
    const item = grouped.get(key) || {
      canonicalProductId: row.canonicalProductId || key,
      standardProductCode: row.standardProductCode || key,
      name: row.standardProductName || row.name || key,
      storeCodes: new Set(),
      unitsSold: Object.fromEntries(windows.map((windowKey) => [windowKey, 0])),
      completeWindows: new Set(windows),
    };
    item.storeCodes.add(String(row.storeCode || ''));
    windows.forEach((windowKey) => {
      const value = row?.unitsSold?.[windowKey];
      if (!isUnit(value)) item.completeWindows.delete(windowKey);
      else {
        const total = item.unitsSold[windowKey] + value;
        if (!isUnit(total)) item.completeWindows.delete(windowKey);
        else item.unitsSold[windowKey] = total;
      }
    });
    grouped.set(key, item);
  });
  return [...grouped.values()].map((item) => ({
    ...item,
    storeCount: [...item.storeCodes].filter(Boolean).length,
    unitsSold: Object.fromEntries(windows.map((windowKey) => [
      windowKey,
      item.completeWindows.has(windowKey) ? item.unitsSold[windowKey] : null,
    ])),
  }));
}

function scopedProductRanking() {
  if (selectedStore() || selectedOwner()) {
    const rows = matchingStoreSkuRows();
    return {
      rows,
      confirmedRows: rows.filter(isCanonicalProduct),
      localRows: rows.filter((row) => !isCanonicalProduct(row)),
      canonical: rows.length > 0 && rows.every(isCanonicalProduct),
      mixed: rows.some(isCanonicalProduct) && rows.some((row) => !isCanonicalProduct(row)),
      scoped: true,
    };
  }
  return { ...matchingProducts(), scoped: false };
}

function skuRowsForView() {
  return sortBySelectedRange(scopedProductRanking().rows);
}

function storeRowsForTable() {
  if (normalizedQuery()) return [];
  const rows = selectedStore() ? [selectedStore()] : allStores();
  return rowWindowSupported() ? sortBySelectedRange(rows) : rows;
}

function skuRowsForTable() {
  const rows = scopedProductRanking().rows;
  return rowWindowSupported() ? sortBySelectedRange(rows) : rows;
}

function dimensionBoundary(kind) {
  if (!rowWindowSupported()) {
    return `当前 API 未提供分${kind === 'store' ? '店' : ' SKU'}昨日销量；不会用其他窗口替代。`;
  }
  if (kind === 'store' && normalizedQuery()) {
    return 'SKU 搜索已生效，但当前 API 没有 SKU 到店铺的交叉事实，因此店铺视图暂停展示。';
  }
  if (kind === 'sku' && selectedStore()) {
    return '店铺筛选已生效，但当前数据没有店铺到货号的交叉事实，因此商品排行暂停展示。';
  }
  if (kind === 'sku' && selectedOwner()) {
    return '负责人筛选已生效，但当前数据没有店铺到货号的交叉事实，因此商品排行暂停展示。';
  }
  return kind === 'store' ? '暂无符合筛选条件的店铺销量数据。' : '暂无符合筛选条件的 SKU 销量数据。';
}

function qualityState() {
  const store = selectedStore();
  const owner = selectedOwner();
  let scopedQuality = null;
  if (store?.qualityStatus) {
    scopedQuality = {
      status: store.qualityStatus,
      label: ({
        healthy: '店铺数据健康',
        legal_zero: '店铺合法零销量',
        partial: '店铺部分覆盖',
        stale: '店铺数据已过期',
        error: '店铺数据异常',
        unavailable: '店铺数据未接入',
      })[store.qualityStatus],
      reason: store.qualityReason,
    };
  } else if (owner) {
    const statuses = allStores().map(({ qualityStatus }) => qualityStatus).filter(Boolean);
    const priority = ['error', 'stale', 'partial', 'unavailable', 'legal_zero', 'healthy'];
    const status = priority.find((candidate) => statuses.includes(candidate));
    if (status) {
      scopedQuality = {
        status,
        label: `${owner.name} · ${({
          healthy: '数据健康',
          legal_zero: '合法零销量',
          partial: '部分覆盖',
          stale: '存在过期店铺',
          error: '存在异常店铺',
          unavailable: '存在未接入店铺',
        })[status]}`,
        reason: status === 'healthy'
          ? '负责店铺均返回健康销量观测'
          : '请下钻店铺排行查看具体质量原因',
      };
    }
  }
  const quality = scopedQuality || state.data?.quality || {};
  const coverage = state.data?.salesCoverage || {};
  const status = String(quality.status || coverage.status || 'unknown').toLowerCase();
  const known = ['healthy', 'complete', 'legal_zero', 'partial', 'stale', 'error', 'blocked', 'unavailable'];
  return {
    status: known.includes(status) ? status : 'unknown',
    label: quality.label || coverage.label || ({
      healthy: '数据健康',
      complete: '覆盖完整',
      legal_zero: '合法零销量',
      partial: '部分覆盖',
      stale: '数据已过期',
      error: '数据异常',
      blocked: '数据受阻',
      unavailable: '数据未接入',
    }[status] || '质量待确认'),
    reason: quality.reason || coverage.reason || '',
    impact: quality.impact || '',
    nextStep: quality.nextStep || '',
  };
}

function qualityTone(status = qualityState().status) {
  if (['healthy', 'complete', 'legal_zero'].includes(status)) return 'complete';
  if (['error', 'blocked'].includes(status)) return 'blocked';
  if (['partial', 'stale'].includes(status)) return 'pending';
  return 'unknown';
}

function businessDate() {
  return selectedStore()?.businessDate
    || state.data?.businessDate
    || state.data?.salesCoverage?.businessDate
    || state.data?.salesCoverage?.latestBusinessDate
    || null;
}

function coverageLabel() {
  const store = selectedStore();
  if (store) {
    return ['healthy', 'partial', 'legal_zero'].includes(store.qualityStatus)
      ? '1 / 1 家店'
      : '0 / 1 家店';
  }
  const owner = selectedOwner();
  if (owner) {
    const stores = allStores();
    const covered = stores.filter(({ qualityStatus }) => (
      ['healthy', 'partial', 'legal_zero'].includes(qualityStatus)
    )).length;
    return `${numberFormatter.format(covered)} / ${numberFormatter.format(stores.length)} 家店`;
  }
  const coverage = state.data?.salesCoverage || {};
  const covered = coverage.coveredStores;
  const total = coverage.totalStores;
  if (isUnit(covered) && isUnit(total)) return `${numberFormatter.format(covered)} / ${numberFormatter.format(total)} 家店`;
  return '覆盖范围待确认';
}

function trendSourceRows() {
  const rawRows = Array.isArray(state.data?.salesTrend) ? state.data.salesTrend : [];
  const explicitStoreRows = Array.isArray(state.data?.salesTrendByStore)
    ? state.data.salesTrendByStore
    : [];
  const visibleStoreCodes = new Set(baseStores().map(({ code }) => String(code)));
  const scopedRows = (explicitStoreRows.length
    ? explicitStoreRows
    : rawRows.filter((row) => row?.storeCode))
    .filter((row) => visibleStoreCodes.has(String(row?.storeCode || '')));
  const store = selectedStore();
  const owner = selectedOwner();

  if (normalizedQuery()) return [];

  if (!scopedRows.length) {
    if (store) {
      return Array.isArray(store.salesTrend) ? store.salesTrend : [];
    }
    if (owner) {
      return Array.isArray(owner.salesTrend) ? owner.salesTrend : [];
    }
    return rawRows;
  }

  const storeCodes = store
    ? new Set([String(store.code)])
    : owner
      ? new Set(owner.storeCodes.map(String))
      : null;
  const filtered = storeCodes
    ? scopedRows.filter((row) => storeCodes.has(String(row.storeCode)))
    : scopedRows;
  const byDate = new Map();
  filtered.forEach((row) => {
    if (!row?.date || !isUnit(row.unitsSold)) return;
    byDate.set(row.date, (byDate.get(row.date) || 0) + row.unitsSold);
  });
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, unitsSold]) => ({ date, unitsSold }));
}

function trendRowsForRange() {
  const rows = trendSourceRows();
  if (state.range === 'last30Days') return rows.slice(-30);
  return rows.slice(-7);
}

function trendWindowLabel() {
  return state.range === 'last30Days' ? '最近 30 个可用业务日' : '最近 7 个可用业务日';
}

function trendEmptyMessage() {
  if (normalizedQuery()) {
    return '当前日趋势没有标准商品或货号维度，已停止展示，避免把全局走势冒充搜索结果。';
  }
  if (selectedStore() || selectedOwner()) {
    return '当前日趋势只有全局序列，不能按负责人或店铺切片；已停止展示，避免冒充筛选结果。';
  }
  const rows = trendRowsForRange();
  if (rows.length < 2) {
    return `${trendWindowLabel()}不足两个日粒度点，暂时无法形成趋势。`;
  }
  return 'API 尚未提供可用的日粒度销量序列。';
}

function chartTip(lines) {
  return escapeHtml(lines.filter(Boolean).join('\n'));
}

function trendRangeLabel(rows) {
  if (!rows.length) return '暂无可用业务日';
  return `${rows[0].date} → ${rows.at(-1).date} · ${numberFormatter.format(rows.length)} 个业务日 · 单位 件`;
}

function renderTrendChart() {
  const rows = trendRowsForRange();
  if (rows.length < 2 || rows.some((row) => !isUnit(row.unitsSold))) {
    return emptyEvidence('销量趋势暂不可画', trendEmptyMessage());
  }

  const width = 760;
  const height = 262;
  const left = 54;
  const right = 16;
  const top = 20;
  const bottom = 40;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const maximum = Math.max(...rows.map((row) => row.unitsSold), 1);
  const step = innerWidth / (rows.length - 1);
  const points = rows.map((row, index) => ({
    ...row,
    x: left + step * index,
    y: top + innerHeight - (row.unitsSold / maximum) * innerHeight,
  }));
  const pointString = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const areaPoints = `${left},${top + innerHeight} ${pointString} ${left + innerWidth},${top + innerHeight}`;
  const lastPoint = points.at(-1);
  const labelEvery = Math.max(1, Math.ceil(rows.length / 6));
  const hitWidth = innerWidth / rows.length;
  const ariaLabel = `${trendWindowLabel()}日销量折线图，${trendRangeLabel(rows)}`;

  return `
    <div class="trend-chart">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}">
        <title>${escapeHtml(ariaLabel)}</title>
        <text class="chart-axis" x="2" y="${top - 7}">件</text>
        ${[1, 0.5, 0].map((ratio) => {
          const y = top + innerHeight - innerHeight * ratio;
          return `
        <line class="chart-grid" x1="${left}" y1="${y.toFixed(1)}" x2="${left + innerWidth}" y2="${y.toFixed(1)}"></line>
        <text class="chart-axis chart-axis-end" x="${left - 8}" y="${(y + 3.5).toFixed(1)}">${escapeHtml(numberFormatter.format(Math.round(maximum * ratio)))}</text>`;
        }).join('')}
        <polygon class="chart-area" points="${areaPoints}"></polygon>
        <polyline class="chart-line" points="${pointString}"></polyline>
        ${points.map((point) => `<circle class="chart-dot" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.6"></circle>`).join('')}
        <circle class="chart-point" cx="${lastPoint.x.toFixed(1)}" cy="${lastPoint.y.toFixed(1)}" r="4.5"></circle>
        <text class="chart-value" x="${(lastPoint.x - 6).toFixed(1)}" y="${Math.max(lastPoint.y - 11, 14).toFixed(1)}">${escapeHtml(numberFormatter.format(lastPoint.unitsSold))}</text>
        ${points.map((point, index) => (
          index % labelEvery === 0 || index === points.length - 1
            ? `<text class="chart-axis chart-axis-center" x="${point.x.toFixed(1)}" y="${height - 21}">${escapeHtml(point.date.slice(5))}</text>`
            : ''
        )).join('')}
        <text class="chart-axis" x="${left}" y="${height - 6}">${escapeHtml(`${rows[0].date} 起`)}</text>
        <text class="chart-axis chart-axis-end" x="${left + innerWidth}" y="${height - 6}">${escapeHtml(`${lastPoint.date} 止`)}</text>
        ${points.map((point) => {
          const tip = chartTip([
            point.date,
            `销量 ${numberFormatter.format(point.unitsSold)} 件`,
            isUnit(point.coveredStores)
              ? `覆盖店铺 ${numberFormatter.format(point.coveredStores)} 家`
              : '覆盖店铺数未知',
          ]);
          const hitX = Math.max(
            left,
            Math.min(point.x - hitWidth / 2, left + innerWidth - hitWidth),
          );
          return `
        <rect class="chart-hit" x="${hitX.toFixed(1)}" y="${top}" width="${hitWidth.toFixed(1)}" height="${innerHeight}" tabindex="0" role="img" aria-label="${tip}" data-tip="${tip}"></rect>`;
        }).join('')}
      </svg>
    </div>`;
}

function monthDayCount(month) {
  const [year, index] = String(month).split('-').map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(index)) return null;
  return new Date(Date.UTC(year, index, 0)).getUTCDate();
}

/**
 * Group only provable day-grain facts into natural months.
 * The four rolling windows are never reused as month totals.
 */
function monthlyTrendRows() {
  const byMonth = new Map();
  trendSourceRows().forEach((row) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row?.date || '')) || !isUnit(row.unitsSold)) return;
    const month = row.date.slice(0, 7);
    const current = byMonth.get(month) || { month, unitsSold: 0, days: new Set() };
    current.unitsSold += row.unitsSold;
    current.days.add(row.date);
    byMonth.set(month, current);
  });
  return [...byMonth.values()]
    .sort((left, right) => left.month.localeCompare(right.month))
    .slice(-12)
    .map((row) => {
      const calendarDays = monthDayCount(row.month);
      return {
        month: row.month,
        unitsSold: row.unitsSold,
        days: row.days.size,
        calendarDays,
        complete: calendarDays !== null && row.days.size >= calendarDays,
      };
    });
}

function monthlyCoverageLabel(rows) {
  if (!rows.length) return '暂无可归月的日粒度事实';
  const partial = rows.filter((row) => !row.complete).length;
  return partial === 0
    ? `${numberFormatter.format(rows.length)} 个自然月全部按完整日粒度事实归集`
    : `${numberFormatter.format(rows.length)} 个自然月 · ${numberFormatter.format(partial)} 个仅部分覆盖`;
}

function renderMonthlyTrendChart() {
  const rows = monthlyTrendRows();
  if (!rows.length) {
    return emptyEvidence(
      '月趋势暂不可画',
      normalizedQuery()
        ? '月趋势没有货号维度，搜索条件生效时不展示全局走势。'
        : '当前仓库还没有可按业务日期归集的日销量快照；不会把四个窗口累计值伪造成月趋势。',
    );
  }

  const width = 760;
  const height = 262;
  const left = 54;
  const right = 16;
  const top = 20;
  const bottom = 48;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const maximum = Math.max(...rows.map((row) => row.unitsSold), 1);
  const band = innerWidth / rows.length;
  const barWidth = Math.min(54, Math.max(10, band * 0.56));
  const bars = rows.map((row, index) => {
    const barHeight = Math.max(2, (row.unitsSold / maximum) * innerHeight);
    return {
      ...row,
      bandX: left + (band * index),
      x: left + (band * index) + ((band - barWidth) / 2),
      y: top + innerHeight - barHeight,
      barHeight,
    };
  });
  const ariaLabel = `${rows[0].month} 至 ${rows.at(-1).month} 月销量柱状图，单位件，每根柱标注实际覆盖业务日数`;

  return `
    <div class="trend-chart month-chart">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}">
        <title>${escapeHtml(ariaLabel)}</title>
        <text class="chart-axis" x="2" y="${top - 7}">件</text>
        ${[1, 0.5, 0].map((ratio) => {
          const y = top + innerHeight - innerHeight * ratio;
          return `
        <line class="chart-grid" x1="${left}" y1="${y.toFixed(1)}" x2="${left + innerWidth}" y2="${y.toFixed(1)}"></line>
        <text class="chart-axis chart-axis-end" x="${left - 8}" y="${(y + 3.5).toFixed(1)}">${escapeHtml(numberFormatter.format(Math.round(maximum * ratio)))}</text>`;
        }).join('')}
        ${bars.map((bar) => {
          const center = (bar.x + (barWidth / 2)).toFixed(1);
          const tip = chartTip([
            `${bar.month} 月`,
            `销量 ${numberFormatter.format(bar.unitsSold)} 件`,
            bar.calendarDays === null
              ? `覆盖 ${numberFormatter.format(bar.days)} 个业务日`
              : `覆盖 ${numberFormatter.format(bar.days)} / ${numberFormatter.format(bar.calendarDays)} 个业务日`,
            bar.complete ? '完整月覆盖' : '部分覆盖 · 不代表整月合计',
          ]);
          return `
        <rect class="chart-bar${bar.complete ? '' : ' partial'}" x="${bar.x.toFixed(1)}" y="${bar.y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${bar.barHeight.toFixed(1)}" rx="3"></rect>
        <text class="chart-value chart-value-center" x="${center}" y="${Math.max(bar.y - 7, 14).toFixed(1)}">${escapeHtml(numberFormatter.format(bar.unitsSold))}</text>
        <text class="chart-axis chart-axis-center" x="${center}" y="${height - 24}">${escapeHtml(bar.month.slice(2))}</text>
        <text class="chart-axis chart-axis-center" x="${center}" y="${height - 11}">${escapeHtml(bar.calendarDays === null ? `${bar.days} 日` : `${bar.days}/${bar.calendarDays} 日`)}</text>
        <rect class="chart-hit" x="${bar.bandX.toFixed(1)}" y="${top}" width="${band.toFixed(1)}" height="${innerHeight}" tabindex="0" role="img" aria-label="${tip}" data-tip="${tip}"></rect>`;
        }).join('')}
      </svg>
    </div>`;
}

function emptyEvidence(title, message, action = '') {
  return `
    <div class="evidence-empty">
      <span class="empty-mark" aria-hidden="true">—</span>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(message)}</p>
        ${action ? `<span>${escapeHtml(action)}</span>` : ''}
      </div>
    </div>`;
}

function pageIntro(kicker, title, description, aside = '') {
  return `
    <header class="page-intro">
      <div>
        <span class="eyebrow">${escapeHtml(kicker)}</span>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(description)}</p>
      </div>
      ${aside ? `<div class="intro-aside">${aside}</div>` : ''}
    </header>`;
}

function panelHeading(kicker, title, note = '') {
  return `
    <header class="panel-heading">
      <div><span>${escapeHtml(kicker)}</span><h2>${escapeHtml(title)}</h2></div>
      ${note ? `<p>${escapeHtml(note)}</p>` : ''}
    </header>`;
}

function filterSummary() {
  const store = selectedStore();
  const owner = selectedOwner();
  const query = state.query.trim();
  return [
    RANGE_META[state.range].label,
    owner ? `负责人：${owner.name}` : '全部负责人',
    store ? `店铺：${store.name || store.code}` : '全部店铺',
    query ? `搜索：${query}` : '全部商品',
  ].join(' · ');
}

function homeTruthStrip() {
  const quality = qualityState();
  const coverage = state.data?.salesCoverage || {};
  const qualityReason = [quality.reason, quality.impact, quality.nextStep].filter(Boolean).join(' · ');
  let rowCoverage = isUnit(coverage.datedRows) && isUnit(coverage.totalRows)
    ? `${numberFormatter.format(coverage.datedRows)} / ${numberFormatter.format(coverage.totalRows)} 行带统计日`
    : '行级日期覆盖待确认';
  if (selectedStore()) rowCoverage = selectedStore().qualityReason || '店铺质量说明待确认';
  else if (selectedOwner()) rowCoverage = '按负责人归属店铺逐店判断，不跨业务日混算';
  const items = [
    ['业务日期', businessDate() || '待确认', '不使用抓取时间冒充业务日期', 'date'],
    ['店铺覆盖', coverageLabel(), rowCoverage, 'coverage'],
    ['数据质量', quality.label, qualityReason || '暂无更具体的质量说明', qualityTone(quality.status)],
    [
      '当前窗口',
      `${RANGE_META[state.range].label} · ${RANGE_META[state.range].note}`,
      '窗口口径独立取数，不跨业务日混算',
      'window',
    ],
  ];
  return `
    <section class="truth-strip" aria-label="销量数据口径与质量">
      ${items.map(([label, value, note, tone]) => `
        <article class="${escapeHtml(tone)}">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(note)}</small>
        </article>`).join('')}
    </section>`;
}

/** Compact page head: name, active scope, latest fact time and dataset state. */
function homeHeader() {
  const quality = qualityState();
  const status = datasetStatus();
  const statusLabel = ({
    live: 'live · 云端事实',
    sample: 'example · 示例数据',
    empty: 'empty · 暂无快照',
  })[status] || 'unknown · 状态待确认';
  const partial = ['partial', 'stale'].includes(quality.status)
    ? 'partial · 部分覆盖'
    : '';
  return `
    <header class="home-topbar">
      <div class="home-topbar-main">
        <span class="eyebrow">FULL-MANAGED COCKPIT</span>
        <h1>全托经营驾驶舱</h1>
        <p>${escapeHtml(`当前范围 ${filterSummary()}`)}</p>
      </div>
      <dl class="home-topbar-facts">
        <div>
          <dt>主要事实业务日</dt>
          <dd>${escapeHtml(businessDate() || '待确认')}</dd>
        </div>
        <div>
          <dt>数据生成时间</dt>
          <dd>${escapeHtml(formatDateTime(state.data?.updatedAt))}</dd>
        </div>
        <div class="home-topbar-state">
          <dt>数据状态</dt>
          <dd>
            <span class="source-chip ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
            <span class="row-status ${escapeHtml(qualityTone(quality.status))}">${escapeHtml(quality.label)}</span>
            ${partial ? `<span class="row-status partial">${escapeHtml(partial)}</span>` : ''}
          </dd>
        </div>
      </dl>
    </header>`;
}

function dataQualityNotice() {
  const quality = qualityState();
  if (['healthy', 'complete'].includes(quality.status)) return '';
  if (quality.status === 'legal_zero') {
    return `
      <aside class="quality-notice complete">
        <strong>当前销量合法为 0</strong>
        <span>${escapeHtml(quality.reason || '接口已返回有效覆盖与零销量事实；0 不作为系统错误。')}</span>
      </aside>`;
  }
  if (quality.status === 'unknown') {
    return `
      <aside class="quality-notice unknown">
        <strong>销量质量仍待确认</strong>
        <span>${escapeHtml(quality.reason || '当前数据没有提供覆盖与统计日质量说明，数字只能按现有快照解读。')}</span>
      </aside>`;
  }
  return `
    <aside class="quality-notice ${escapeHtml(qualityTone(quality.status))}">
      <strong>${escapeHtml(quality.label)}</strong>
      <span>${escapeHtml([quality.reason, quality.impact, quality.nextStep].filter(Boolean).join(' · ') || '请先处理数据质量问题，再据此做经营判断。')}</span>
    </aside>`;
}

function metricState(value) {
  const quality = qualityState();
  if (!isUnit(value)) return { label: '未接入', tone: 'unknown' };
  if (quality.status === 'stale') return { label: '数据已过期', tone: 'pending' };
  if (value === 0 && quality.status === 'legal_zero') return { label: '合法为 0', tone: 'complete' };
  if (['error', 'blocked'].includes(quality.status)) return { label: '质量异常', tone: 'blocked' };
  return { label: value === 0 ? '销量为 0' : '销量事实', tone: qualityTone(quality.status) };
}

function formatDelta(current, baseline) {
  if (!isUnit(current) || !isUnit(baseline)) return '不可比';
  if (baseline === 0) return current === 0 ? '持平' : '新增';
  const delta = (current - baseline) / baseline;
  return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`;
}

function formatAverage(value, days) {
  return isUnit(value)
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value / days)
    : '—';
}

function metricValue(main, note = '', tone = '') {
  return `<span class="metric-main-value${tone ? ` ${escapeHtml(tone)}` : ''}">${escapeHtml(main)}</span>${note ? `<small class="metric-subvalue">${escapeHtml(note)}</small>` : ''}`;
}

function metricMatrix(headers, rows) {
  const [corner, ...columnHeaders] = headers;
  return `
    <div class="metric-matrix-scroll">
      <table class="metric-matrix cols-${Math.max(1, columnHeaders.length)}">
        <thead>
          <tr>
            <th scope="col">${escapeHtml(corner)}</th>
            ${columnHeaders.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <th scope="row">${escapeHtml(row.label)}</th>
              ${row.cells.map((cell) => `<td>${cell}</td>`).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function metricCard(title, subtitle, headers, rows, note = '', cardClass = '') {
  return `
    <article class="overview-matrix-card${cardClass ? ` ${escapeHtml(cardClass)}` : ''}">
      <div class="matrix-card-head">
        <h4>${escapeHtml(title)}</h4>
        <div class="sub">${escapeHtml(subtitle)}</div>
      </div>
      ${metricMatrix(headers, rows)}
      ${note ? `<p class="matrix-footnote">${escapeHtml(note)}</p>` : ''}
    </article>`;
}

/** Source and freshness stamp reused by every matrix block. */
function factSourceNote(extra = '') {
  return [
    `来源 ${datasetStatus() === 'sample' ? '本地示例数据（非真实经营结果）' : '只读 OpenAPI 销量快照'}`,
    `数据生成 ${formatDateTime(state.data?.updatedAt)}`,
    `业务日 ${businessDate() || '待确认'}`,
    extra,
  ].filter(Boolean).join(' · ');
}

function homeKpis() {
  const scope = scopedUnits();
  const units = scope.units;
  const currentStores = storeRowsForView();
  const currentProducts = skuRowsForView();
  const visibleStores = baseStores();
  const productSource = scopedProductRanking();
  const canonicalRows = currentProducts.filter(isCanonicalProduct);
  const localRows = currentProducts.filter((item) => !isCanonicalProduct(item));
  const moving = (rows) => rows.filter((item) => isUnit(item?.unitsSold?.[state.range])
    && item.unitsSold[state.range] > 0).length;
  const sellingStores = currentStores.filter((item) => isUnit(item?.unitsSold?.[state.range])
    && item.unitsSold[state.range] > 0).length;
  const identity = identityCoverage();
  const coveredStores = visibleStores.filter(({ qualityStatus }) => (
    ['healthy', 'partial', 'legal_zero'].includes(qualityStatus)
  )).length;
  const permission = state.data?.permission || {};
  const permissionStores = isUnit(permission.authorizedStores) ? permission.authorizedStores : null;
  const permissionTotal = isUnit(permission.totalStores) ? permission.totalStores : visibleStores.length;
  const latestText = state.data?.updatedAt ? formatDateTime(state.data.updatedAt) : '尚无有效快照';
  const previous23 = priorTwentyThreeDays(units);
  const windowLabels = WINDOW_KEYS.map((key) => RANGE_META[key].label);
  const perWindow = (build) => WINDOW_KEYS.map(build);

  return `
    <section class="kpi-six sales-matrix" aria-label="销售数据矩阵">
      ${metricCard(
        '销量规模',
        `${scope.title} · 四个可信数量窗口同表比较`,
        ['数量口径', ...windowLabels],
        [
          {
            label: '销量',
            cells: perWindow((key) => {
              const signal = metricState(units[key]);
              return metricValue(`${formatUnits(units[key])} 件`, signal.label, signal.tone);
            }),
          },
          {
            label: '本窗口日均',
            cells: perWindow((key) => metricValue(
              isUnit(units[key]) ? `${formatAverage(units[key], RANGE_META[key].days)} 件/日` : '—',
              `${RANGE_META[key].days} 日口径`,
            )),
          },
          {
            label: '覆盖 店铺 / 货号',
            cells: perWindow((key) => {
              const cover = windowFactCoverage(key);
              return metricValue(
                `${numberFormatter.format(cover.stores)} / ${numberFormatter.format(cover.products)}`,
                `范围内 ${numberFormatter.format(cover.storeTotal)} 店 · ${numberFormatter.format(cover.productTotal)} 货号`,
              );
            }),
          },
          {
            label: '可比变化',
            cells: perWindow((key) => {
              const change = windowChange(key, units);
              return metricValue(change.label, change.note, change.tone);
            }),
          },
        ],
        `${scope.note} ${factSourceNote('缺失窗口保持“—”，不补零也不估算')}`,
        'matrix-span-2',
      )}
      ${metricCard(
        '销售动能',
        '只用同口径基线判断趋势',
        ['经营信号', '当前', '可比基线', '变化'],
        [
          {
            label: '今日 / 昨日',
            cells: [
              metricValue(`${formatUnits(units.today)} 件`, '实时累计'),
              metricValue(`${formatUnits(units.yesterday)} 件`, '完整自然日'),
              metricValue(formatDelta(units.today, units.yesterday), '仅作参考'),
            ],
          },
          {
            label: '近 7 日日均',
            cells: [
              metricValue(`${formatAverage(units.last7Days, 7)} 件`, '近 7 日'),
              metricValue(previous23 === null ? '—' : `${formatAverage(previous23, 23)} 件`, '此前 23 日'),
              metricValue(
                previous23 === null
                  ? '不可比'
                  : formatDelta(Math.round(units.last7Days / 7), Math.round(previous23 / 23)),
                previous23 === null ? '缺可比窗口' : '同口径日均对比',
                previous23 === null ? 'unknown' : '',
              ),
            ],
          },
        ],
        `今日仍在累计，不与完整昨日直接作因果比较。${factSourceNote()}`,
      )}
      ${metricCard(
        '店铺经营',
        '负责人与店铺共用同一个范围选择框',
        ['范围', '店铺', '有销量', '数据覆盖'],
        [
          {
            label: RANGE_META[state.range].label,
            cells: [
              metricValue(`${numberFormatter.format(currentStores.length)} 家`, '当前筛选'),
              metricValue(`${numberFormatter.format(sellingStores)} 家`, '窗口内 > 0'),
              metricValue(coverageLabel(), '可解释观测'),
            ],
          },
          {
            label: '全部可见',
            cells: [
              metricValue(`${numberFormatter.format(visibleStores.length)} 家`, '全员可读'),
              metricValue(`${numberFormatter.format(coveredStores)} 家`, '数据覆盖'),
              metricValue(`${numberFormatter.format(allOwners().length)} 人`, '负责人分组'),
            ],
          },
        ],
        `负责人只影响查看范围，不表达读权限限制。${factSourceNote()}`,
      )}
      ${metricCard(
        '商品与归并',
        productIdentityLabel(productSource),
        ['身份口径', '可见货号', '动销', '聚合边界'],
        [
          {
            label: '标准商品',
            cells: [
              metricValue(`${numberFormatter.format(canonicalRows.length)} 个`, '已确认归并'),
              metricValue(`${numberFormatter.format(moving(canonicalRows))} 个`, RANGE_META[state.range].label),
              metricValue('可跨店聚合', '身份已确认', 'complete'),
            ],
          },
          {
            label: '店内身份',
            cells: [
              metricValue(`${numberFormatter.format(localRows.length)} 个`, '店铺隔离'),
              metricValue(`${numberFormatter.format(moving(localRows))} 个`, RANGE_META[state.range].label),
              metricValue(`${numberFormatter.format(identity.unconfirmed)} 个待归并`, '禁止跨店合计', 'pending'),
            ],
          },
        ],
        `${identity.label}。未确认店内身份不会伪装成跨店标准商品。${factSourceNote()}`,
      )}
      ${metricCard(
        '数据健康',
        `${datasetLabel()} · 缺失值不补零`,
        ['核对项', '当前', '范围', '状态'],
        [
          {
            label: '业务日期',
            cells: [
              metricValue(businessDate() || '待确认'),
              metricValue('北京时间'),
              metricValue(qualityState().label),
            ],
          },
          {
            label: '销量权限',
            cells: [
              metricValue(permissionStores === null ? '待确认' : `${numberFormatter.format(permissionStores)} 家`),
              metricValue(`${numberFormatter.format(permissionTotal)} 家`),
              metricValue(permission.label || '待确认'),
            ],
          },
          {
            label: '最新生成',
            cells: [
              metricValue(latestText),
              metricValue(datasetStatus() === 'live' ? '云端事实' : sourceLabel()),
              metricValue(qualityState().label),
            ],
          },
        ],
        factSourceNote('同步失败、过期与未接入分开表达'),
      )}
      ${metricCard(
        '财务与结算',
        '实时金额 · WebAPI 来源验证中；结算金额 · 财务 OpenAPI 待接入',
        ['金额口径', '当前值', '来源', '状态'],
        [
          {
            label: '实时金额',
            cells: [
              metricValue('未接入', '不按件数估算', 'pending'),
              metricValue('WebAPI 来源验证中', '受控只读实验', 'pending'),
              metricValue('来源验证中', '未通过前不展示金额', 'pending'),
            ],
          },
          {
            label: '结算金额',
            cells: [
              metricValue('未接入', '等待账单事实', 'pending'),
              metricValue('财务 OpenAPI 待接入', '报账单与销售明细', 'pending'),
              metricValue('待接入', '与实时口径永久分开', 'pending'),
            ],
          },
          {
            label: '流量与支付人数',
            cells: [
              metricValue('未接入', '无可信来源', 'pending'),
              metricValue('WebAPI 待验证', '商详访客 / 支付人数', 'pending'),
              metricValue('不由销量推导', '拒绝反推', 'pending'),
            ],
          },
        ],
        '没有可信金额事实前，这里不显示任何金额数字、0 或百分比。',
        'matrix-span-2',
      )}
    </section>`;
}

function readinessStrip() {
  return `
    <section class="readiness-panel">
      ${panelHeading('ACCESS READINESS', '接入阶段', '五个阶段分别取证，不把应用审核等同于销量可读')}
      <ol class="readiness-list">
        ${readinessStages().map((stage, index) => `
          <li class="${readinessClass(stage.status)}">
            <span class="stage-index">${String(index + 1).padStart(2, '0')}</span>
            <div><strong>${escapeHtml(stage.label)}</strong><p>${escapeHtml(stage.note || '当前阶段暂无说明')}</p></div>
            <div class="stage-state"><span>${escapeHtml(stage.statusLabel || '待确认')}</span><small>${escapeHtml(readinessCount(stage))}</small></div>
          </li>`).join('')}
      </ol>
    </section>`;
}

function topEntity(items, kind) {
  if (!items.length) return null;
  const first = items[0];
  const value = first?.unitsSold?.[state.range];
  if (!isUnit(value)) return null;
  return {
    name: kind === 'store'
      ? (first.name || first.code)
      : productCode(first, scopedProductRanking().canonical),
    detail: kind === 'store'
      ? [first.code, ownerNameForStore(first)].filter(Boolean).join(' · ')
      : [productName(first), first.storeCode].filter(Boolean).join(' · '),
    value,
  };
}

function attentionSummary() {
  const store = topEntity(storeRowsForView(), 'store');
  const product = topEntity(skuRowsForView(), 'product');
  const productSource = scopedProductRanking();
  const stage = activeReadinessStage();
  const cards = [
    {
      label: `店铺关注 · ${RANGE_META[state.range].label}`,
      value: store ? store.name : '暂无可比结果',
      detail: store ? `${formatUnits(store.value)} 件 · ${store.detail}` : dimensionBoundary('store'),
      tone: 'accent',
    },
    {
      label: `${productIdentityLabel(productSource)} · ${RANGE_META[state.range].label}`,
      value: product ? product.name : '暂无可比结果',
      detail: product ? `${formatUnits(product.value)} 件 · ${product.detail}` : dimensionBoundary('sku'),
      tone: '',
    },
    {
      label: '当前接入关注',
      value: stage?.label || '接入阶段待确认',
      detail: stage ? `${stage.statusLabel || '待确认'} · ${stage.note || '等待运行证据'}` : 'readiness 字段尚未接入',
      tone: stage?.status === 'blocked' ? 'danger' : 'warning',
    },
  ];
  return `
    <section>
      ${panelHeading('ATTENTION', '今天先看什么', '只列当前筛选可证明的销量与阻断点')}
      <div class="attention-grid">
        ${cards.map((card) => `
          <article class="attention-card ${card.tone}">
            <span>${escapeHtml(card.label)}</span>
            <strong>${escapeHtml(card.value)}</strong>
            <p>${escapeHtml(card.detail)}</p>
          </article>`).join('')}
      </div>
    </section>`;
}

function rankingCoverageNote(kind) {
  const meta = state.data?.rankingMeta?.[kind];
  if (!meta || !isUnit(meta.returnedCount) || !isUnit(meta.totalCount)) {
    return '服务端返回范围待确认';
  }
  return `服务端返回 ${numberFormatter.format(meta.returnedCount)} / ${numberFormatter.format(meta.totalCount)} 条${meta.truncated === true ? '（已截断，未命中不代表没有销量）' : ''}`;
}

function homeRankList(items, kind, windowKey = state.range) {
  if (!items.length) return emptyEvidence(
    kind === 'store' ? '店铺排行不可用' : '商品排行不可用',
    dimensionBoundary(kind),
  );
  const ranked = items
    .filter((item) => isUnit(item?.unitsSold?.[windowKey]))
    .sort((left, right) => right.unitsSold[windowKey] - left.unitsSold[windowKey])
    .slice(0, 10);
  if (!ranked.length) return emptyEvidence(
    kind === 'store' ? '店铺排行不可用' : '商品排行不可用',
    `${RANGE_META[windowKey]?.label || windowKey}没有可比的${kind === 'store' ? '店铺' : '货号'}销量事实。`,
  );
  const maximum = Math.max(...ranked.map((item) => item.unitsSold[windowKey]), 1);
  return `
    <ol class="rank-list">
      ${ranked.map((item, index) => {
        const value = item.unitsSold[windowKey];
        const fill = Math.max(1, Math.ceil((value / maximum) * 10));
        const isStore = kind === 'store';
        const owner = isStore ? ownerNameForStore(item) : '';
        const canonical = isStore ? null : isCanonicalProduct(item);
        const name = isStore ? (item.name || item.code) : productCode(item, canonical);
        const meta = isStore
          ? [
            ['店铺', item.code || '—'],
            ['负责人', owner || '待分配'],
            ['今日', `${formatUnits(item?.unitsSold?.today)} 件`],
            ['近 30 日', `${formatUnits(item?.unitsSold?.last30Days)} 件`],
          ]
          : [
            ['商品', productName(item)],
            ['归属', canonical
              ? (isUnit(item.storeCount) ? `跨店 ${item.storeCount} 店` : '跨店标准商品')
              : (item.storeCode ? `店铺 ${item.storeCode}` : '店内身份待确认')],
            ['今日', `${formatUnits(item?.unitsSold?.today)} 件`],
            ['近 30 日', `${formatUnits(item?.unitsSold?.last30Days)} 件`],
          ];
        return `
        <li class="rank-item rank-fill-${fill}">
          <span class="rank-no">${index + 1}</span>
          <span class="rank-main">
            <span class="rank-title-line">
              <span class="rank-name">${escapeHtml(name)}</span>
              ${owner ? `<span class="rank-owner">负责人 ${escapeHtml(owner)}</span>` : ''}
              ${canonical === null ? '' : `<span class="rank-identity ${canonical ? 'canonical' : 'local'}">${canonical ? '标准商品' : '店内身份'}</span>`}
            </span>
            <span class="rank-meta">${meta.map(([label, itemValue]) => `<span class="meta-part">${escapeHtml(label)} <b>${escapeHtml(itemValue)}</b></span>`).join('<i class="meta-sep">·</i>')}</span>
          </span>
          <span class="rank-value">${formatUnits(value)} 件<small>${escapeHtml(RANGE_META[windowKey]?.label || windowKey)}</small></span>
        </li>`;
      }).join('')}
    </ol>`;
}

function compactRanking(items, kind) {
  return homeRankList(items, kind, state.range);
}

function supplyDomain() {
  const supply = state.data?.supply;
  return supply && typeof supply === 'object' ? supply : {};
}

function platformDomain() {
  const platform = state.data?.platform;
  return platform && typeof platform === 'object' ? platform : {};
}

function actionPoolDomain() {
  const actionPool = state.data?.actionPool;
  return actionPool && typeof actionPool === 'object' ? actionPool : {};
}

function domainRows(domain, key) {
  return Array.isArray(domain?.[key]) ? domain[key] : [];
}

function storeScopedRows(rows) {
  const store = selectedStore();
  const owner = selectedOwner();
  const ownerStores = owner ? new Set(owner.storeCodes.map(String)) : null;
  return rows.filter((row) => {
    const storeCode = String(row?.storeCode || '');
    if (store && storeCode !== String(store.code)) return false;
    if (!store && ownerStores && !ownerStores.has(storeCode)) return false;
    return true;
  });
}

function searchableOperationRows(rows) {
  const query = normalizedQuery();
  if (!query) return rows;
  return rows.filter((row) => {
    let safeProjection = '';
    if (row?.safeProjection && typeof row.safeProjection === 'object') {
      try {
        safeProjection = JSON.stringify(row.safeProjection);
      } catch {
        safeProjection = '';
      }
    }
    return [
      row?.storeCode,
      row?.storeName,
      row?.statusCode,
      row?.statusName,
      row?.orderNo,
      row?.orderTypeName,
      row?.deliveryCode,
      row?.milestoneCode,
      row?.warehouseName,
      row?.expressCompanyName,
      row?.inventoryTypeCode,
      row?.skuCode,
      row?.skcName,
      row?.spuName,
      row?.supplierCode,
      row?.attentionCode,
      row?.attentionLabel,
      row?.eventCode,
      row?.eventPath,
      row?.eventFamily,
      row?.businessType,
      row?.businessKey,
      row?.action,
      row?.severity,
      row?.type,
      row?.title,
      row?.reason,
      row?.entityCode,
      safeProjection,
    ].filter(Boolean).join(' ')
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN')
      .includes(query);
  });
}

function scopedOperationRows(rows) {
  return searchableOperationRows(storeScopedRows(rows));
}

const SEVERITY_META = Object.freeze({
  critical: { label: '紧急', rank: 4, tone: 'blocked' },
  high: { label: '高优先', rank: 3, tone: 'blocked' },
  medium: { label: '中优先', rank: 2, tone: 'partial' },
  low: { label: '低优先', rank: 1, tone: 'complete' },
  unknown: { label: '待评估', rank: 0, tone: 'unknown' },
});

const CANDIDATE_TYPE_META = Object.freeze({
  PURCHASE_ORDER_OVERDUE: {
    label: '采购单逾期',
    group: 'procurement',
    nextStep: '核对采购单要求时间、当前节点和未完成数量',
    href: '#procurement',
  },
  DELIVERY_OVERDUE: {
    label: '交付单逾期',
    group: 'fulfilment',
    nextStep: '核对交付里程碑、物流状态和预计收货时间',
    href: '#fulfilment',
  },
  SKU_SHORTAGE_REVIEW: {
    label: '缺货 SKU',
    group: 'inventory',
    nextStep: '核对缺货数量、可用库存与在途数量',
    href: '#inventory',
  },
  SKU_URGENT_SUPPLY_REVIEW: {
    label: 'SKU 急采复核',
    group: 'supply',
    nextStep: '优先核对急采量、已下单量和待交付供给',
    href: '#inventory',
  },
  SKU_STOCK_WARNING_REVIEW: {
    label: 'SKU 库存预警',
    group: 'supply',
    nextStep: '核对平台预警、可用库存与供给状态',
    href: '#inventory',
  },
  SKU_RESTOCK_ADVICE_REVIEW: {
    label: 'SKU 建议备货',
    group: 'supply',
    nextStep: '核对平台建议量、已下单量和在途量',
    href: '#inventory',
  },
  SHORTAGE_REVIEW: {
    label: '缺货复核',
    group: 'inventory',
    nextStep: '核对缺货 SKU、可用库存与在途数量',
    href: '#inventory',
  },
  INVENTORY_RECONCILIATION: {
    label: '库存对账',
    group: 'inventory',
    nextStep: '核对库存汇总与仓库分项差异',
    href: '#inventory',
  },
  STOCK_WARNING_REVIEW: {
    label: '库存预警',
    group: 'inventory',
    nextStep: '按 SKU 复核平台预警与供给状态',
    href: '#inventory',
  },
  RESTOCK_ADVICE_REVIEW: {
    label: '建议备货',
    group: 'supply',
    nextStep: '核对平台建议量、已下单量和在途量',
    href: '#inventory',
  },
  URGENT_SUPPLY_REVIEW: {
    label: '急采复核',
    group: 'supply',
    nextStep: '优先核对计划急采量与待交付供给',
    href: '#inventory',
  },
  SUPPLY_SYNC_FAILURE_REVIEW: {
    label: '同步失败',
    group: 'system',
    nextStep: '定位失败店铺和数据域，等待成功回读后再判断业务数量',
    href: '#system',
  },
  SUPPLY_COVERAGE_REVIEW: {
    label: '覆盖缺口',
    group: 'system',
    nextStep: '补齐店铺数据覆盖并确认最新成功水位',
    href: '#system',
  },
  WEBHOOK_DEAD_LETTER: {
    label: 'Webhook 死信',
    group: 'system',
    nextStep: '检查死信原因并确认业务详情是否已补查',
    href: '#platform',
  },
  AUTHORIZATION_GATE_REVIEW: {
    label: '授权封闸',
    group: 'system',
    nextStep: '复核授权变化及受影响店铺',
    href: '#system',
  },
});

function severityMeta(value) {
  return SEVERITY_META[String(value || '').toLowerCase()] || SEVERITY_META.unknown;
}

function severityBadge(value) {
  const meta = severityMeta(value);
  return `<span class="row-status ${meta.tone}">${meta.label}</span>`;
}

function comparePriority(left, right) {
  const severityDelta = severityMeta(right?.severity).rank - severityMeta(left?.severity).rank;
  if (severityDelta) return severityDelta;
  const leftTime = new Date(left?.evidenceAt || left?.latestSourceFetchedAt || 0).valueOf();
  const rightTime = new Date(right?.evidenceAt || right?.latestSourceFetchedAt || 0).valueOf();
  return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
}

function attentionMeta(key) {
  const value = supplyDomain()?.attentionMeta?.[key];
  return value && typeof value === 'object' ? value : {};
}

function attentionRows(key) {
  return domainRows(supplyDomain(), key);
}

function attentionEvidence(key, metaKey = key) {
  const rows = attentionRows(key);
  const meta = attentionMeta(metaKey);
  return meta.available === true
    || rows.length > 0
    || meta.truncated === true
    || (isUnit(meta.total) && meta.total > 0);
}

function metaCountLabel(key, rows) {
  const meta = attentionMeta(key);
  const total = isUnit(meta.total) ? meta.total : rows.length;
  const returned = isUnit(meta.returned) ? meta.returned : rows.length;
  const truncated = meta.truncated === true || total > returned;
  return `当前筛选 ${numberFormatter.format(rows.length)} 条 · 全量返回 ${numberFormatter.format(returned)} / ${numberFormatter.format(total)} 条${truncated ? '（已截断）' : ''}`;
}

function quickFilterValue(route) {
  return state.quickFilters[route] || 'ALL';
}

function quickFilterBar(route, label, options) {
  const active = quickFilterValue(route);
  return `
    <div class="range-filter" role="group" aria-label="${escapeHtml(label)}">
      <span>${escapeHtml(label)}</span>
      <div>
        ${options.map(([value, text]) => `
          <button type="button" data-quick-route="${escapeHtml(route)}" data-quick-value="${escapeHtml(value)}" class="${active === value ? 'active' : ''}" aria-pressed="${active === value ? 'true' : 'false'}">${escapeHtml(text)}</button>
        `).join('')}
      </div>
    </div>`;
}

function rowAttentionStage(row, kind) {
  if (row?.attentionLabel) return row.attentionLabel;
  if (kind === 'procurement') {
    if (!row?.deliveredAt) return '待交付';
    if (!row?.receivedAt) return '待收货';
    if (!row?.storedAt) return '待入库';
    return row?.statusName || row?.statusCode || '待复核';
  }
  if (!row?.takenAt) return '待揽收';
  if (!row?.receivedAt) return row?.takenAt ? '运输中 / 待收货' : '待收货';
  return row?.milestoneCode || '已收货';
}

function matchesQuickFilter(row, route, kind = route) {
  const active = quickFilterValue(route);
  if (active === 'ALL') return true;
  const haystack = [
    row?.attentionCode,
    row?.attentionLabel,
    row?.statusCode,
    row?.statusName,
    row?.milestoneCode,
    row?.type,
    row?.group,
    row?.supplyStatusCode,
    row?.stockWarningStatusCode,
    rowAttentionStage(row, kind),
  ].filter(Boolean).join(' ').toUpperCase();
  if (active === 'HIGH') return severityMeta(row?.severity).rank >= severityMeta('high').rank;
  if (active === 'SHORTAGE') return isUnit(row?.shortageQuantity) && row.shortageQuantity > 0
    || /SHORTAGE|缺货/.test(haystack);
  if (active === 'URGENT') return isUnit(row?.plannedUrgentQuantity) && row.plannedUrgentQuantity > 0
    || /URGENT|急采/.test(haystack);
  if (active === 'ADVICE') return isUnit(row?.advisedOrderQuantity) && row.advisedOrderQuantity > 0
    || /RESTOCK|ADVICE|建议/.test(haystack);
  if (active === 'SYNC') return /SYNC|COVERAGE|同步|覆盖/.test(haystack);
  if (active === 'PENDING_DELIVERY') return /待交付|DELIVER/.test(haystack) && !/已交付|DELIVERED/.test(haystack);
  if (active === 'PENDING_RECEIPT') return /待收货|运输中|RECEIPT|TRANSIT/.test(haystack);
  if (active === 'PENDING_STORAGE') return /待入库|STOR/.test(haystack);
  if (active === 'OVERDUE') return /OVERDUE|逾期|超时/.test(haystack);
  return haystack.includes(active);
}

function hasRows(domain, keys) {
  return keys.some((key) => domainRows(domain, key).length > 0);
}

function supplyCoverageDomain(key) {
  const value = supplyDomain()?.coverage?.domains?.[key];
  return value && typeof value === 'object' ? value : null;
}

function coverageHasEvidence(coverage) {
  if (!coverage) return false;
  return [
    coverage.observedStores,
    coverage.succeededStores,
    coverage.failedStores,
    coverage.missingStores,
    coverage.inProgressStores,
    coverage.staleStores,
    coverage.totalStores,
  ].some(isUnit) || Boolean(
    coverage.latestFetchedAt
    || coverage.watermarkStart
    || coverage.watermarkEnd
    || coverage.evaluatedAt
    || coverage.reason,
  );
}

function domainConnectionState(domain, keys, coverageKeys = []) {
  if (hasRows(domain, keys)) return 'available';
  const coverage = coverageKeys.map(supplyCoverageDomain).filter(Boolean);
  if (coverage.length === coverageKeys.length && coverage.length > 0) {
    if (coverage.some((item) => item.status === 'blocked')) return 'blocked';
    if (coverage.every((item) => item.status === 'complete')) return 'available';
    if (coverage.some((item) => item.status === 'partial' || coverageHasEvidence(item))) {
      return 'partial';
    }
  }
  return domain?.status === 'available' ? 'partial' : 'pending';
}

function nullableUnits(value, unknownLabel = '—') {
  return isUnit(value) ? numberFormatter.format(value) : unknownLabel;
}

function nullableDecimal(value, unknownLabel = '—') {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
    : unknownLabel;
}

function coverageParts(coverage, variants = []) {
  for (const [knownKey, totalKey, noun] of variants) {
    if (isUnit(coverage?.[knownKey]) && isUnit(coverage?.[totalKey])) {
      return {
        known: coverage[knownKey],
        total: coverage[totalKey],
        noun,
      };
    }
  }
  return null;
}

function fieldCoverageLabel(coverage, variants) {
  const parts = coverageParts(coverage, variants);
  if (!parts) return '覆盖待确认';
  return `已知 ${numberFormatter.format(parts.known)} / ${numberFormatter.format(parts.total)} ${parts.noun}`;
}

function completeNullableSum(rows, key) {
  if (!rows.length) return null;
  const values = rows.map((row) => row?.[key]);
  if (values.some((value) => !isUnit(value))) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function completeCoveredNullableSum(rows, key, coverageKey, variants) {
  if (!rows.length) return null;
  const complete = rows.every((row) => {
    const coverage = coverageParts(row?.[coverageKey], variants);
    return coverage !== null && coverage.known === coverage.total;
  });
  if (!complete) return null;
  return completeNullableSum(rows, key);
}

function operationScopeNote(rows, noun) {
  const filterActive = Boolean(selectedStore() || selectedOwner() || normalizedQuery());
  if (!rows.length) {
    return filterActive
      ? `当前筛选没有命中${noun}事实；这不代表业务数量为 0`
      : `${noun}事实尚无可展示行；不补成业务 0`;
  }
  if (!filterActive) return `共 ${numberFormatter.format(rows.length)} 条${noun}事实`;
  return `当前筛选命中 ${numberFormatter.format(rows.length)} 条${noun}事实`;
}

function sourceTime(value) {
  return value ? formatDateTime(value) : '来源时间未知';
}

function sourceStatusTone(status) {
  const normalized = String(status || '').toLocaleLowerCase('zh-CN');
  if (/(complete|success|received|inbound|active|enabled|granted|processed|healthy|ok)/.test(normalized)) return 'complete';
  if (/(failed|error|blocked|dead|expired|disabled|denied|cancel)/.test(normalized)) return 'blocked';
  return 'partial';
}

function supplyAvailable() {
  if (hasRows(supplyDomain(), [
    'purchaseOrderStatus',
    'purchaseOrderAttention',
    'deliveryMilestones',
    'deliveryAttention',
    'inventory',
    'inventoryRisks',
    'stockAdvice',
    'stockAdviceRisks',
  ])) return true;
  return Object.keys(SUPPLY_COVERAGE_META)
    .some((key) => coverageHasEvidence(supplyCoverageDomain(key)));
}

function platformAvailable() {
  const platform = platformDomain();
  return domainRows(platform, 'events').length > 0
    || domainRows(platform, 'subscriptions').length > 0
    || queueHasEvidence(platform.queue)
    || platform.health?.warehouseReady === true
    || Boolean(platform.health?.receiver || platform.health?.worker);
}

function actionPoolAvailable() {
  return domainRows(actionPoolDomain(), 'candidates').length > 0;
}

function compactQuantityParts(parts) {
  return parts
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    .map(([label, value]) => `${label} ${nullableDecimal(value)} 件`)
    .join(' · ');
}

function itemSourceLabel(item) {
  return item?.sourceLabel || GROUP_LABELS[item?.group] || GROUP_LABELS.other;
}

/* --- focused-evidence:start ---
   Read-only drilldown. Every candidate code below already exists in the current
   /api/dashboard payload; nothing is derived, estimated or invented. */

/** Codes that can identify one row, most specific first. */
function focusCandidateCodes(row, domain) {
  if (domain === 'procurement') return [row?.orderNo];
  if (domain === 'fulfilment') return [row?.deliveryCode];
  if (domain === 'product') {
    return [
      row?.standardProductCode,
      row?.canonicalProductId,
      row?.productKey,
      row?.supplierCode,
      row?.supplierSku,
      row?.skc,
      row?.sku,
    ];
  }
  // inventory and advice share the SKU-centric supply grain.
  return [row?.skuCode, row?.sku, row?.skcName, row?.skc, row?.supplierCode];
}

function focusCodeFor(row, domain) {
  const candidate = focusCandidateCodes(row, domain)
    .map((value) => String(value ?? '').trim())
    .find((value) => value !== '' && URL_CODE_PATTERN.test(value));
  return candidate ?? '';
}

/** A row matches a focus when any of its identifying codes equals the target. */
function rowMatchesFocus(row, focus) {
  if (!focus) return false;
  const target = String(focus.code).toUpperCase();
  const storeCode = String(row?.storeCode ?? '').trim().toUpperCase();
  if (focus.storeCode !== '' && storeCode !== '' && storeCode !== focus.storeCode) {
    return false;
  }
  return focusCandidateCodes(row, focus.domain)
    .map((value) => String(value ?? '').trim().toUpperCase())
    .some((value) => value !== '' && value === target);
}

/** Rows that the active focus could name, per domain. */
function focusSearchRows(domain) {
  if (domain === 'inventory') return scopedOperationRows(attentionRows('inventoryRisks'));
  if (domain === 'advice') return scopedOperationRows(attentionRows('stockAdviceRisks'));
  if (domain === 'procurement') return scopedOperationRows(attentionRows('purchaseOrderAttention'));
  if (domain === 'fulfilment') return scopedOperationRows(attentionRows('deliveryAttention'));
  if (domain === 'product') {
    // Product identity has two honest grains: canonical cross-store rows and
    // store-local SKU evidence. Search both so neither kind of drilldown turns
    // into a false "not found".
    return [...new Set([
      ...scopedProductRanking().rows,
      ...matchingStoreSkuRows(),
    ])];
  }
  return [];
}

/**
 * Resolve the active focus against the current snapshot.
 *
 * Returns `null` when no focus applies to this route, `{found: false}` when the
 * target is genuinely absent. A near miss is never substituted for the request.
 */
function activeFocus(route = state.route) {
  const focus = state.focus;
  if (!focus) return null;
  if (FOCUS_DOMAINS[focus.domain].route !== route && route !== 'ops') return null;
  const domains = focus.domain === 'ops'
    ? ['inventory', 'advice', 'procurement', 'fulfilment', 'product']
    : [focus.domain];
  for (const domain of domains) {
    const rows = focusSearchRows(domain);
    const match = rows.find((row) => rowMatchesFocus(row, { ...focus, domain }));
    if (match) return { focus, domain, row: match, found: true };
  }
  return { focus, domain: focus.domain, row: null, found: false };
}

function focusDetailRows(domain, row) {
  const optional = (label, value) => (
    value === undefined || value === null || value === '' ? null : [label, value]
  );
  const quantity = (label, value) => [label, nullableUnits(value, '—')];
  if (domain === 'inventory') {
    return [
      optional('SKU', row.skuCode),
      optional('SKC / 商品', row.skcName || row.spuName),
      optional('库存类型', row.inventoryTypeCode),
      quantity('库存', row.totalInventoryQuantity ?? row.totalInventory),
      quantity('可用', row.usableInventory),
      quantity('在途', row.transitQuantity),
      quantity('缺货', row.shortageQuantity),
      optional('对账状态', row.reconciliationStatus),
    ];
  }
  if (domain === 'advice') {
    return [
      optional('SKU', row.skuCode),
      optional('SKC / 商品', row.skcName || row.spuName),
      optional('供应商货号', row.supplierCode),
      ['预测日销', nullableDecimal(row.predictedDailySales, '—')],
      quantity('建议下单', row.advisedOrderQuantity),
      quantity('已下单', row.placedOrderQuantity),
      quantity('计划急采', row.plannedUrgentQuantity),
      quantity('库存', row.stockQuantity),
      quantity('在途', row.transitQuantity),
      optional('供给状态', row.supplyStatusCode),
      optional('预警状态', row.stockWarningStatusCode),
    ];
  }
  if (domain === 'procurement') {
    return [
      optional('采购单号', row.orderNo),
      optional('状态', row.statusName || row.statusCode),
      optional('类型', row.orderTypeName),
      optional('关注语义', row.attentionLabel || row.attentionCode),
      quantity('订购', row.orderQuantity),
      quantity('交付', row.deliveryQuantity),
      quantity('收货', row.receiptQuantity),
      quantity('入库', row.storageQuantity),
      quantity('残次', row.defectiveQuantity),
      optional('要求交付', row.requestedDeliveryAt ? sourceTime(row.requestedDeliveryAt) : null),
      optional('要求收货', row.requestedReceiptAt ? sourceTime(row.requestedReceiptAt) : null),
      optional('仓库', row.warehouseName),
    ];
  }
  if (domain === 'fulfilment') {
    return [
      optional('交付单号', row.deliveryCode),
      optional('里程碑', row.milestoneCode),
      optional('关注语义', row.attentionLabel || row.attentionCode),
      quantity('交付数量', row.deliveryQuantity),
      quantity('行项目', row.lineCount),
      optional('预约揽收', row.reservedParcelAt ? sourceTime(row.reservedParcelAt) : null),
      optional('实际揽收', row.takenAt ? sourceTime(row.takenAt) : null),
      optional('预计收货', row.expectedReceiptAt ? sourceTime(row.expectedReceiptAt) : null),
      optional('仓库', row.warehouseName),
      optional('物流', row.expressCompanyName),
    ];
  }
  return [
    optional('店内货号', row.supplierCode || row.productKey),
    optional('SKC', row.skc),
    optional('平台 SKU', row.sku),
    optional('商品名', productName(row)),
    optional('标准商品', row.standardProductCode || row.canonicalProductId),
    ['身份范围', isCanonicalProduct(row) ? '标准商品（可跨店聚合）' : '店内身份（禁止跨店合并）'],
    ['归并状态', mappingStatusLabel(row.mappingStatus)],
    [`${RANGE_META[state.range].label}销量`, `${formatUnits(row?.unitsSold?.[state.range])} 件`],
  ];
}

function queryAfterClearingFocus() {
  const focusCode = String(state.focus?.code ?? '');
  return focusCode !== '' && state.query === focusCode ? '' : state.query;
}

function clearFocusControl() {
  return `
    <a class="text-link focus-clear" data-clear-focus="1" href="${escapeHtml(serializeHashState({
      ...currentHashState(),
      query: queryAfterClearingFocus(),
      focus: null,
    }))}">清除定位，查看当前范围全部结果</a>`;
}

/**
 * Read-only focused-evidence panel.
 *
 * It contains no form, submit, edit or approve control: this batch only proves a
 * fact, it never changes one.
 */
function focusEvidencePanel(route = state.route) {
  const resolved = activeFocus(route);
  if (!resolved) return '';
  const { focus } = resolved;
  const identifiers = [
    ['数据域', FOCUS_DOMAINS[focus.domain].label],
    ['店铺', focus.storeCode === '' ? '未指定店铺' : focus.storeCode],
    ['定位对象', focus.code],
  ];
  if (!resolved.found) {
    return `
      <section class="focus-panel focus-panel-missing" aria-label="定位事实未找到">
        <header>
          <span class="eyebrow">FOCUSED EVIDENCE</span>
          <h2>当前快照未找到该事实</h2>
          <p>该对象不在当前 /api/dashboard 快照的可见范围内，可能已完成、超出返回窗口或尚未同步。系统不会改用其他相近记录冒充定位结果。</p>
        </header>
        <dl class="focus-facts">
          ${identifiers.map(([label, value]) => `
            <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
        </dl>
        ${clearFocusControl()}
      </section>`;
  }
  const details = focusDetailRows(resolved.domain, resolved.row)
    .filter(Boolean)
    .map(([label, value]) => [label, String(value)]);
  const storeLabel = resolved.row.storeName || resolved.row.storeCode || focus.storeCode;
  return `
    <section class="focus-panel" aria-label="定位事实证据">
      <header>
        <span class="eyebrow">FOCUSED EVIDENCE</span>
        <h2>${escapeHtml(`${FOCUS_DOMAINS[resolved.domain].label} · ${focus.code}`)}</h2>
        <p>${escapeHtml(`店铺 ${storeLabel || '未指定'} · 只读证据，不提供任何执行入口`)}</p>
      </header>
      <dl class="focus-facts">
        ${details.map(([label, value]) => `
          <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
        <div>
          <dt>证据时间</dt>
          <dd>${escapeHtml(sourceTime(resolved.row.latestSourceFetchedAt ?? resolved.row.evidenceAt))}</dd>
        </div>
        <div>
          <dt>来源与状态</dt>
          <dd>${escapeHtml(`${sourceLabel()} · ${qualityState().label}`)}</dd>
        </div>
      </dl>
      ${clearFocusControl()}
    </section>`;
}

/** Put the focused row first so the investigation target is never buried. */
function orderRowsForFocus(rows, domain, route = state.route) {
  const resolved = activeFocus(route);
  if (!resolved?.found || resolved.domain !== domain) return rows;
  const matched = rows.filter((row) => rowMatchesFocus(row, { ...resolved.focus, domain }));
  if (!matched.length) return rows;
  return [...matched, ...rows.filter((row) => !matched.includes(row))];
}

function isFocusedRow(row, domain, route = state.route) {
  const resolved = activeFocus(route);
  return Boolean(
    resolved?.found
    && resolved.domain === domain
    && rowMatchesFocus(row, { ...resolved.focus, domain }),
  );
}

const ALERT_GROUP_FOCUS_DOMAINS = Object.freeze({
  procurement: 'procurement',
  fulfilment: 'fulfilment',
  inventory: 'inventory',
  supply: 'advice',
  products: 'product',
});

/**
 * Canonical drilldown href for one operating alert.
 *
 * The alert already knows its store and its object code, so the link carries
 * target route, store scope, an exact object query and a typed focus instead of
 * a bare `#inventory` that opens an all-store table.
 */
function alertFocusHref(item) {
  const domain = item?.focusDomain
    ?? ALERT_GROUP_FOCUS_DOMAINS[String(item?.group ?? '')];
  if (!domain) return item?.href || '#ops';
  const explicit = String(item?.focusCode ?? '').trim();
  const code = explicit !== '' && URL_CODE_PATTERN.test(explicit)
    ? explicit
    : focusCodeFor(item, domain) || (() => {
      const fallback = String(item?.objectCode ?? item?.entityCode ?? '').trim();
      return URL_CODE_PATTERN.test(fallback) ? fallback : '';
    })();
  if (code === '') return item?.href || '#ops';
  const storeCode = String(item?.storeCode ?? '').trim().toUpperCase();
  return canonicalHref({
    route: FOCUS_DOMAINS[domain].route,
    storeCode,
    range: state.range,
    // The exact object also seeds the global query so the underlying table is
    // narrowed to the fact, not merely scrolled to it.
    query: code,
    focus: { domain, storeCode, code },
  });
}

/** Keyboard-reachable canonical drilldown link for one row. */
function rowFocusLink(row, domain, { label = '查看详情' } = {}) {
  const code = focusCodeFor(row, domain);
  if (code === '') return '';
  const storeCode = String(row?.storeCode ?? '').trim().toUpperCase();
  const href = canonicalHref({
    route: FOCUS_DOMAINS[domain].route,
    storeCode,
    range: state.range,
    focus: { domain, storeCode, code },
  });
  return `<a class="text-link row-focus-link" href="${escapeHtml(href)}">${escapeHtml(label)}<span class="sr-only">${escapeHtml(`：${code}`)}</span></a>`;
}
/* --- focused-evidence:end --- */

/** Product identity is a first-class operating alert, not only a catalogue task. */
function productIdentityAlertItems() {
  const pending = unmappedStoreSkuRows();
  if (!pending.length) return [];
  const coverage = identityCoverage();
  const impact = sumCompleteWindow(pending, state.range);
  const share = coverage.total > 0 ? pending.length / coverage.total : null;
  return [{
    group: 'products',
    sourceLabel: '商品身份归并',
    type: 'PRODUCT_IDENTITY_PENDING',
    severity: share !== null && share >= 0.5 ? 'high' : 'medium',
    storeCode: selectedStore()?.code || null,
    storeName: selectedStore()?.name || '跨店商品身份',
    objectCode: `${numberFormatter.format(pending.length)} 个店内身份`,
    objectName: coverage.label,
    title: '标准商品归并待确认',
    impact: impact === null
      ? `${RANGE_META[state.range].label}销量影响存在缺失窗口，拒绝补零合计`
      : `${RANGE_META[state.range].label}涉及 ${numberFormatter.format(impact)} 件`,
    nextStep: '在商品中心按销量影响优先归并；未确认身份不参与跨店合计',
    // The highest-impact pending row is the best identity key this alert owns.
    focusDomain: 'product',
    focusCode: focusCodeFor(pending[0], 'product'),
    href: '#products',
    evidenceAt: state.data?.updatedAt || null,
  }];
}

/** Sales quality problems must surface on the cockpit, not only on the system page. */
function salesQualityAlertItems() {
  const quality = qualityState();
  if (['healthy', 'complete', 'legal_zero'].includes(quality.status)) return [];
  return [{
    group: 'system',
    sourceLabel: '销量数据质量',
    type: 'SALES_QUALITY_REVIEW',
    severity: ['error', 'blocked'].includes(quality.status)
      ? 'critical'
      : quality.status === 'stale' ? 'high' : 'medium',
    storeCode: selectedStore()?.code || null,
    storeName: selectedStore()?.name || '当前销量范围',
    objectCode: quality.label,
    objectName: coverageLabel(),
    title: `销量质量：${quality.label}`,
    impact: [quality.reason, quality.impact].filter(Boolean).join(' · ')
      || '缺失窗口不会补零，请按现有覆盖解读数字',
    nextStep: quality.nextStep || '在系统健康页核对覆盖水位、统计日与同步失败',
    href: '#system',
    evidenceAt: state.data?.updatedAt || null,
  }];
}

/** Webhook runtime and dead letters are data-quality facts with operating impact. */
function platformAlertItems() {
  const platform = platformDomain();
  const queue = platform.queue && typeof platform.queue === 'object' ? platform.queue : null;
  const candidateTypes = new Set(
    domainRows(actionPoolDomain(), 'candidates').map(({ type }) => type),
  );
  const items = [];
  if (
    queue
    && !candidateTypes.has('WEBHOOK_DEAD_LETTER')
    && isUnit(queue.deadLetter)
    && queue.deadLetter > 0
  ) {
    items.push({
      group: 'platform',
      sourceLabel: 'Webhook 队列',
      type: 'WEBHOOK_DEAD_LETTER',
      severity: 'high',
      storeCode: null,
      storeName: '跨店事件链路',
      objectCode: `死信 ${numberFormatter.format(queue.deadLetter)} 条`,
      objectName: `过期租约 ${nullableUnits(queue.expiredLeases, '未知')} 条`,
      title: 'Webhook 死信待处理',
      impact: `未处理事件可能导致采购、交付与库存事实延迟；待补查 ${nullableUnits(queue.hydrationPending, '未知')} 条`,
      nextStep: '在平台动态页核对死信原因、受阻店铺与补查指令',
      href: '#platform',
      evidenceAt: queue.lastProcessedAt || queue.lastReceivedAt || null,
    });
  }
  if (platform.health?.ok === false) {
    items.push({
      group: 'platform',
      sourceLabel: 'Webhook 运行态',
      type: 'WEBHOOK_RUNTIME_REVIEW',
      severity: 'high',
      storeCode: null,
      storeName: '跨店事件链路',
      objectCode: 'Receiver / Worker',
      objectName: '心跳失效',
      title: 'Webhook 运行态需关注',
      impact: [
        webhookRuntimeLabel(platform.health.receiver, 'Receiver'),
        webhookRuntimeLabel(platform.health.worker, 'Worker'),
      ].join(' · '),
      nextStep: '在平台动态页核对进程心跳、队列积压与订阅回读',
      href: '#platform',
      evidenceAt: platform.health.evaluatedAt || null,
    });
  }
  return items;
}

function operationPriorityItems() {
  const items = [];
  const purchaseRows = scopedOperationRows(attentionRows('purchaseOrderAttention'));
  const deliveryRows = scopedOperationRows(attentionRows('deliveryAttention'));
  const inventoryRows = scopedOperationRows(attentionRows('inventoryRisks'));
  const adviceRows = scopedOperationRows(attentionRows('stockAdviceRisks'));

  purchaseRows.forEach((row) => {
    const stage = rowAttentionStage(row, 'procurement');
    const quantity = compactQuantityParts([
      ['订购', row.orderQuantity],
      ['交付', row.deliveryQuantity],
      ['收货', row.receiptQuantity],
      ['入库', row.storageQuantity],
      ['残次', row.defectiveQuantity],
    ]);
    const dueAt = row.requestedDeliveryAt || row.requestedReceiptAt;
    items.push({
      ...row,
      group: 'procurement',
      type: row.attentionCode || 'PURCHASE_ORDER_ATTENTION',
      title: stage,
      impact: quantity || (dueAt ? `要求时间 ${sourceTime(dueAt)}` : '单据数量影响待回读'),
      objectCode: row.orderNo,
      objectName: row.orderTypeName || row.statusName,
      nextStep: stage.includes('交付')
        ? '核对要求交期、订购量与尚未交付数量'
        : stage.includes('收货')
          ? '核对已交付数量、要求收货时间与仓库状态'
          : '核对收货、入库和残次数量',
      href: '#procurement',
      evidenceAt: row.latestSourceFetchedAt,
    });
  });

  deliveryRows.forEach((row) => {
    const stage = rowAttentionStage(row, 'fulfilment');
    const quantity = compactQuantityParts([['交付', row.deliveryQuantity]]);
    items.push({
      ...row,
      group: 'fulfilment',
      type: row.attentionCode || 'DELIVERY_ATTENTION',
      title: stage,
      impact: [
        quantity,
        row.expectedReceiptAt ? `预计收货 ${sourceTime(row.expectedReceiptAt)}` : '',
      ].filter(Boolean).join(' · ') || '交付影响待回读',
      objectCode: row.deliveryCode,
      objectName: row.warehouseName || row.expressCompanyName,
      nextStep: stage.includes('揽收')
        ? '核对预约揽收和物流交接'
        : stage.includes('收货') || stage.includes('运输')
          ? '核对预计收货时间、物流状态和交付数量'
          : '核对收货结果与关联采购单',
      href: '#fulfilment',
      evidenceAt: row.latestSourceFetchedAt,
    });
  });

  inventoryRows.forEach((row) => {
    const shortage = isUnit(row.shortageQuantity) && row.shortageQuantity > 0;
    const mismatch = String(row.reconciliationStatus || '').toUpperCase() === 'MISMATCH';
    items.push({
      ...row,
      group: 'inventory',
      type: shortage ? 'SHORTAGE_REVIEW' : mismatch ? 'INVENTORY_RECONCILIATION' : 'INVENTORY_RISK',
      title: shortage ? '缺货 SKU' : mismatch ? '库存对账异常' : '库存风险',
      impact: compactQuantityParts([
        ['缺货', row.shortageQuantity],
        ['可用', row.usableInventory],
        ['在途', row.transitQuantity],
      ]) || '库存数量影响待回读',
      objectCode: row.skuCode,
      objectName: row.skcName || row.spuName,
      nextStep: shortage
        ? '核对可用库存、在途和平台备货建议'
        : '核对库存汇总与仓库分项',
      href: '#inventory',
      evidenceAt: row.latestSourceFetchedAt,
    });
  });

  adviceRows.forEach((row) => {
    const urgent = isUnit(row.plannedUrgentQuantity) && row.plannedUrgentQuantity > 0;
    const advised = isUnit(row.advisedOrderQuantity) && row.advisedOrderQuantity > 0;
    const warning = row.stockWarningIsWarning === true;
    items.push({
      ...row,
      group: 'supply',
      type: urgent ? 'URGENT_SUPPLY_REVIEW' : warning ? 'STOCK_WARNING_REVIEW' : 'RESTOCK_ADVICE_REVIEW',
      title: urgent ? '急采复核' : warning ? '库存预警' : advised ? '建议备货' : '供给风险',
      impact: compactQuantityParts([
        ['预测日销', row.predictedDailySales],
        ['建议', row.advisedOrderQuantity],
        ['急采', row.plannedUrgentQuantity],
        ['库存', row.stockQuantity],
        ['在途', row.transitQuantity],
      ]) || '供给数量影响待回读',
      objectCode: row.skuCode,
      objectName: row.skcName || row.spuName || row.supplierCode,
      nextStep: urgent
        ? '核对急采量、已下单量、待交付和在途'
        : advised
          ? '核对平台建议量与当前供给链路'
          : '核对平台预警和供给状态',
      href: '#inventory',
      evidenceAt: row.latestSourceFetchedAt,
    });
  });

  const detailedPurchase = attentionEvidence('purchaseOrderAttention', 'purchaseOrders');
  const detailedDelivery = attentionEvidence('deliveryAttention', 'deliveries');
  const detailedInventory = attentionEvidence('inventoryRisks');
  const detailedAdvice = attentionEvidence('stockAdviceRisks');
  scopedOperationRows(domainRows(actionPoolDomain(), 'candidates')).forEach((candidate) => {
    const meta = CANDIDATE_TYPE_META[candidate.type] || {
      label: candidate.title || '运营复核',
      group: 'other',
      nextStep: '打开对应业务页核对事实与影响范围',
      href: '#ops',
    };
    if (
      (detailedPurchase && candidate.type === 'PURCHASE_ORDER_OVERDUE')
      || (detailedDelivery && candidate.type === 'DELIVERY_OVERDUE')
      || (
        detailedInventory
        && ['SKU_SHORTAGE_REVIEW', 'SHORTAGE_REVIEW', 'INVENTORY_RECONCILIATION'].includes(candidate.type)
      )
      || (
        detailedAdvice
        && [
          'SKU_URGENT_SUPPLY_REVIEW',
          'SKU_STOCK_WARNING_REVIEW',
          'SKU_RESTOCK_ADVICE_REVIEW',
          'STOCK_WARNING_REVIEW',
          'RESTOCK_ADVICE_REVIEW',
          'URGENT_SUPPLY_REVIEW',
        ].includes(candidate.type)
      )
    ) return;
    items.push({
      ...candidate,
      group: meta.group,
      title: meta.label,
      impact: candidate.reason || '影响范围待回读',
      objectCode: candidate.entityCode,
      objectName: null,
      nextStep: meta.nextStep,
      href: meta.href,
      evidenceAt: candidate.evidenceAt,
    });
  });

  items.push(
    ...productIdentityAlertItems(),
    ...salesQualityAlertItems(),
    ...platformAlertItems(),
  );

  const deduplicated = new Map();
  items.forEach((item) => {
    const key = [
      item.group,
      item.storeCode,
      item.objectCode || item.entityCode || item.type,
    ].join('\u001f');
    if (!deduplicated.has(key)) deduplicated.set(key, item);
  });
  return [...deduplicated.values()].sort(comparePriority);
}

function operationPriorityCoverage(rows, { quickFiltered = false } = {}) {
  const scoped = Boolean(selectedStore() || selectedOwner() || normalizedQuery() || quickFiltered);
  const detailMeta = ['purchaseOrders', 'deliveries', 'inventoryRisks', 'stockAdviceRisks']
    .map((key) => attentionMeta(key));
  const incompleteDetails = detailMeta.some((meta) => (
    meta.truncated === true
    || (
      isUnit(meta.total)
      && isUnit(meta.returned)
      && meta.total > meta.returned
    )
  ));
  const poolMeta = actionPoolDomain().meta;
  const incompletePool = poolMeta && typeof poolMeta === 'object'
    ? (
      poolMeta.truncated === true
      || (
        isUnit(poolMeta.total)
        && isUnit(poolMeta.returned)
        && poolMeta.total > poolMeta.returned
      )
    )
    : false;
  const incomplete = incompleteDetails || incompletePool;
  if (scoped) {
    return {
      loaded: rows.length,
      totalAtLeast: rows.length,
      incomplete,
      note: incomplete
        ? '当前筛选仅扫描服务端已返回窗口；源端结果有截断，未命中不能解释为无风险。'
        : '当前筛选已应用到完整返回窗口。',
    };
  }
  const hiddenDetailRows = detailMeta.reduce((total, meta) => {
    if (!isUnit(meta.total) || !isUnit(meta.returned)) return total;
    return total + Math.max(meta.total - meta.returned, 0);
  }, 0);
  return {
    loaded: rows.length,
    totalAtLeast: rows.length + hiddenDetailRows,
    incomplete,
    note: incomplete
      ? `已返回明细之外至少还有 ${numberFormatter.format(hiddenDetailRows)} 条源端风险；当前队列只展示已载入证据。`
      : '当前队列覆盖服务端完整返回窗口。',
  };
}

function priorityWorklistTable(
  rows,
  {
    limit = 50,
    totalCount = null,
    totalAtLeast = false,
    coverageNote = '',
  } = {},
) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有运营优先事项',
      '仅在存在单据异常、SKU 风险、供给建议或同步失败证据时生成待办；空结果不代表全部业务无风险。',
    );
  }
  const visible = rows.slice(0, limit);
  const total = isUnit(totalCount) ? totalCount : rows.length;
  return `
    <div class="table-wrap">
      <table class="data-table action-table">
        <thead><tr><th scope="col">严重度</th><th scope="col">来源域</th><th scope="col">影响范围</th><th scope="col">为何关注</th><th scope="col">建议查看</th><th scope="col">证据时间</th><th scope="col">下钻</th></tr></thead>
        <tbody>${visible.map((item) => `
          <tr>
            <td>${severityBadge(item.severity)}</td>
            <td class="entity-column"><strong>${escapeHtml(itemSourceLabel(item))}</strong><span>${escapeHtml(item.type || '只读事实')}</span></td>
            <td class="entity-column"><strong>${escapeHtml(item.storeName || item.storeCode || '跨店系统项')}</strong><span>${escapeHtml([item.objectCode, item.objectName].filter(Boolean).join(' · ') || item.title)}</span></td>
            <td class="entity-column"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.impact || '影响范围待回读')}</span></td>
            <td class="boundary-cell">${escapeHtml(item.nextStep || '打开业务页核对事实')}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(item.evidenceAt))}</td>
            <td><a class="text-link" href="${escapeHtml(alertFocusHref(item))}">查看事实 →<span class="sr-only">${escapeHtml(`：${item.objectCode || item.entityCode || item.title}`)}</span></a></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">按严重度和最新证据时间排序；当前显示 ${numberFormatter.format(visible.length)} / ${totalAtLeast ? '至少 ' : ''}${numberFormatter.format(total)} 条。${escapeHtml(coverageNote)} 本批只读：这里只组织证据和建议查看的子页面，没有任何执行按钮，也不会触发 SHEIN 写请求。</p>`;
}

function renderOperationalPriorities({ home = false } = {}) {
  const allRows = operationPriorityItems();
  const quickFiltered = !home && quickFilterValue('ops') !== 'ALL';
  const rows = home ? allRows : allRows.filter((row) => matchesQuickFilter(row, 'ops'));
  const coverage = operationPriorityCoverage(rows, { quickFiltered });
  const visible = home ? rows.slice(0, 8) : rows;
  const high = rows.filter((row) => severityMeta(row.severity).rank >= severityMeta('high').rank).length;
  const sources = [...new Set(rows.map(itemSourceLabel))];
  const countSummary = coverage.incomplete
    ? `已载入 ${numberFormatter.format(rows.length)} 条${coverage.totalAtLeast > rows.length ? ` · 全量至少 ${numberFormatter.format(coverage.totalAtLeast)} 条` : ' · 返回窗口不完整'}`
    : `${numberFormatter.format(rows.length)} 条有证据事项`;
  return `
    <section class="table-section">
      ${panelHeading(
        'OPERATING ALERTS',
        home ? '运营提醒' : '运营待办队列',
        rows.length
          ? `${countSummary} · ${numberFormatter.format(high)} 条高优先 · 来源：${sources.join('、')}`
          : '没有事实时不显示伪 0；继续使用各业务汇总判断覆盖',
      )}
      ${home ? '' : quickFilterBar('ops', '快速筛查', [
        ['ALL', '全部'],
        ['HIGH', '高优先'],
        ['SHORTAGE', '缺货'],
        ['URGENT', '急采'],
        ['SYNC', '同步 / 覆盖'],
      ])}
      ${priorityWorklistTable(
        visible,
        {
          limit: home ? 8 : 100,
          totalCount: coverage.totalAtLeast,
          totalAtLeast: coverage.incomplete,
          coverageNote: coverage.note,
        },
      )}
      ${home && rows.length > visible.length ? '<a class="text-link" href="#ops">查看全部运营待办 →</a>' : ''}
    </section>`;
}

function attentionWindowState(key) {
  const meta = attentionMeta(key);
  const total = isUnit(meta.total) ? meta.total : null;
  const returned = isUnit(meta.returned) ? meta.returned : null;
  return {
    total,
    returned,
    truncated: meta.truncated === true
      || (total !== null && returned !== null && total > returned),
  };
}

function riskWindowMetric(rows, metaKey, quantityKey, noun = '个 SKU') {
  const window = attentionWindowState(metaKey);
  const quantity = quantityKey && rows.length
    ? completeNullableSum(rows, quantityKey)
    : quantityKey ? 0 : null;
  if (!window.truncated) {
    return {
      countLabel: `${numberFormatter.format(rows.length)} ${noun}`,
      quantity,
      quantityPrefix: '',
      note: '明细返回窗口完整',
    };
  }
  const windowNote = (
    window.returned !== null && window.total !== null
      ? `全量已返回 ${numberFormatter.format(window.returned)} / ${numberFormatter.format(window.total)} 条`
      : '源端详细结果已截断'
  );
  return {
    countLabel: rows.length
      ? `至少 ${numberFormatter.format(rows.length)} ${noun}`
      : '当前返回窗口未命中',
    quantity: rows.length ? quantity : null,
    quantityPrefix: rows.length ? '至少 ' : '',
    note: `${windowNote}；未命中不能推断为 0`,
  };
}

function supplyRadar() {
  const inventoryRisks = scopedOperationRows(attentionRows('inventoryRisks'));
  const adviceRisks = scopedOperationRows(attentionRows('stockAdviceRisks'));
  const purchaseAttention = scopedOperationRows(attentionRows('purchaseOrderAttention'));
  const deliveryAttention = scopedOperationRows(attentionRows('deliveryAttention'));
  const inventorySummary = scopedOperationRows(domainRows(supplyDomain(), 'inventory'));
  const adviceSummary = scopedOperationRows(domainRows(supplyDomain(), 'stockAdvice'));
  const hasInventoryDetail = attentionEvidence('inventoryRisks');
  const hasAdviceDetail = attentionEvidence('stockAdviceRisks');
  const hasPurchaseDetail = attentionEvidence('purchaseOrderAttention', 'purchaseOrders');
  const hasDeliveryDetail = attentionEvidence('deliveryAttention', 'deliveries');
  const shortageRows = inventoryRisks.filter((row) => isUnit(row.shortageQuantity) && row.shortageQuantity > 0);
  const urgentRows = adviceRisks.filter((row) => isUnit(row.plannedUrgentQuantity) && row.plannedUrgentQuantity > 0);
  const advisedRows = adviceRisks.filter((row) => isUnit(row.advisedOrderQuantity) && row.advisedOrderQuantity > 0);
  const shortageMetric = riskWindowMetric(shortageRows, 'inventoryRisks', 'shortageQuantity');
  const urgentMetric = riskWindowMetric(urgentRows, 'stockAdviceRisks', 'plannedUrgentQuantity');
  const advisedMetric = riskWindowMetric(advisedRows, 'stockAdviceRisks', 'advisedOrderQuantity');
  const purchaseMetric = riskWindowMetric(purchaseAttention, 'purchaseOrders', null, '条');
  const deliveryMetric = riskWindowMetric(deliveryAttention, 'deliveries', null, '条');
  const shortageQuantity = hasInventoryDetail
    ? shortageMetric.quantity
    : completeCoveredNullableSum(
      inventorySummary,
      'shortageQuantity',
      'shortageCoverage',
      [['knownSkuCount', 'totalSkuCount', 'SKU']],
    );
  const urgentQuantity = hasAdviceDetail
    ? urgentMetric.quantity
    : completeCoveredNullableSum(
      adviceSummary,
      'plannedUrgentQuantity',
      'plannedUrgentCoverage',
      [['knownSkuCount', 'totalSkuCount', 'SKU']],
    );
  const advisedQuantity = hasAdviceDetail
    ? advisedMetric.quantity
    : completeCoveredNullableSum(
      adviceSummary,
      'advisedOrderQuantity',
      'advisedOrderCoverage',
      [['knownSkuCount', 'totalSkuCount', 'SKU']],
    );
  const cards = [
    {
      label: '缺货风险',
      value: hasInventoryDetail
        ? shortageMetric.countLabel
        : nullableUnits(completeNullableSum(inventorySummary, 'shortageSkuCount'), '未知'),
      note: shortageQuantity === null
        ? hasInventoryDetail ? shortageMetric.note : '缺货数量覆盖不完整'
        : `缺货 ${shortageMetric.quantityPrefix}${numberFormatter.format(shortageQuantity)} 件${hasInventoryDetail && shortageMetric.note ? ` · ${shortageMetric.note}` : ''}`,
      tone: shortageRows.length > 0 || (isUnit(shortageQuantity) && shortageQuantity > 0) ? 'blocked' : '',
    },
    {
      label: '计划急采',
      value: hasAdviceDetail ? urgentMetric.countLabel : '店铺汇总',
      note: urgentQuantity === null
        ? hasAdviceDetail ? urgentMetric.note : '急采数量覆盖不完整'
        : `急采 ${urgentMetric.quantityPrefix}${numberFormatter.format(urgentQuantity)} 件${hasAdviceDetail && urgentMetric.note ? ` · ${urgentMetric.note}` : ''}`,
      tone: urgentRows.length > 0 || (isUnit(urgentQuantity) && urgentQuantity > 0) ? 'partial' : '',
    },
    {
      label: '平台建议备货',
      value: hasAdviceDetail
        ? advisedMetric.countLabel
        : nullableUnits(completeNullableSum(adviceSummary, 'advisedSkuCount'), '未知'),
      note: advisedQuantity === null
        ? hasAdviceDetail ? advisedMetric.note : '建议数量覆盖不完整'
        : `建议 ${advisedMetric.quantityPrefix}${numberFormatter.format(advisedQuantity)} 件${hasAdviceDetail && advisedMetric.note ? ` · ${advisedMetric.note}` : ''}`,
    },
    {
      label: '采购 / 交付关注',
      value: hasPurchaseDetail || hasDeliveryDetail
        ? `${hasPurchaseDetail ? purchaseMetric.countLabel : '待接入'} / ${hasDeliveryDetail ? deliveryMetric.countLabel : '待接入'}`
        : '单据级待接入',
      note: hasPurchaseDetail || hasDeliveryDetail
        ? `${hasPurchaseDetail ? purchaseMetric.note : '采购明细待接入'}；${hasDeliveryDetail ? deliveryMetric.note : '交付明细待接入'}`
        : '采购异常与交付异常明细均待接入',
    },
  ];
  return `
    <section class="table-section">
      ${panelHeading('SUPPLY RADAR', '供给雷达', '缺货、急采、备货和单据异常均来自只读事实；未知不补零')}
      ${operationSummaryCards(cards)}
      <a class="text-link" href="#inventory">进入 SKU 风险与备货筛查 →</a>
    </section>`;
}

function compactTechnicalFooter() {
  const stage = activeReadinessStage();
  return `
    <section class="focus-strip">
      <div><span>技术接入摘要</span><strong>${escapeHtml(stage?.label || datasetLabel())}</strong></div>
      <p><b>${escapeHtml(stage?.statusLabel || qualityState().label)}</b>${escapeHtml(stage?.note || '详细权限、同步、Webhook 与覆盖状态已下沉系统健康页。')}</p>
      <a class="text-link" href="#system">查看系统健康 →</a>
    </section>`;
}

function businessMap() {
  const supply = supplyDomain();
  const platform = platformDomain();
  const procurementState = domainConnectionState(
    supply,
    ['purchaseOrderAttention', 'purchaseOrderStatus'],
    ['purchaseOrders'],
  );
  const fulfilmentState = domainConnectionState(
    supply,
    ['deliveryAttention', 'deliveryMilestones'],
    ['deliveries'],
  );
  const inventoryState = domainConnectionState(
    supply,
    ['inventoryRisks', 'stockAdviceRisks', 'inventory', 'stockAdvice'],
    ['inventory', 'stockAdvice'],
  );
  const platformState = platformAvailable()
    ? 'available'
    : platform?.status === 'available' ? 'partial' : 'pending';
  const actionState = actionPoolAvailable() ? 'partial' : 'locked';
  const domains = [
    ['procurement', '采购单中心', procurementState === 'available' ? '采购单状态事实已接入' : '等待采购单、采购数量与状态事实', procurementState],
    ['fulfilment', '交付与入仓', fulfilmentState === 'available' ? '交付与入仓里程碑已接入' : '等待发货、收货、查验与入库节点', fulfilmentState],
    ['products', '商品与货号', '标准商品归并与店内货号映射', canonicalProducts().length ? 'partial' : 'pending'],
    ['sales', '销量分析', '销量数量已接入', 'available'],
    ['inventory', '库存与供给', inventoryState === 'available' ? '库存与备货建议事实已接入' : '等待库存、缺货需求和供给风险事实', inventoryState],
    ['platform', '平台动态', platformState === 'available' ? 'Webhook 队列、订阅回读与事件可见' : 'Webhook 订阅、处理与补查链路待接入', platformState],
    ['ops', '自动化运营', actionState === 'partial' ? '只读候选池已接入；写动作保持关闭' : '只读建议；写动作保持关闭', actionState],
    ['system', '系统健康', '授权、同步、覆盖、备份与运行态', 'available'],
  ];
  return `
    <section class="domain-section">
      ${panelHeading('BUSINESS MAP', '业务入口', '明细和接入条件下沉到各业务页')}
      <div class="domain-grid">
        ${domains.map(([route, title, detail, status]) => `
          <a href="#${route}" class="domain-card ${status}">
            <span>${escapeHtml(ROUTES[route].code)}</span>
            <strong>${escapeHtml(title)}</strong>
            <p>${escapeHtml(detail)}</p>
            <b>进入业务页 <span aria-hidden="true">→</span></b>
          </a>`).join('')}
      </div>
    </section>`;
}

function homeSectionHeading(title, description, tight = false) {
  return `
    <div class="head${tight ? ' head-tight' : ''}">
      <div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(description)}</p>
      </div>
    </div>`;
}

function renderHome() {
  const coverage = identityCoverage();
  const storeRows = storeRowsForView();
  const productRows = skuRowsForView();
  const productSource = scopedProductRanking();
  const dailyRows = trendRowsForRange();
  const monthlyRows = monthlyTrendRows();
  const scopeName = selectedStore()
    ? `店铺 ${selectedStore().code}`
    : selectedOwner()
      ? `负责人 ${selectedOwner().name}`
      : '全部店铺';
  const productRankingKey = canonicalProducts().length ? 'product' : 'storeSku';
  return `
    ${homeHeader()}
    ${homeTruthStrip()}
    ${sampleNotice()}
    ${dataQualityNotice()}
    ${homeSectionHeading(
      '销售数据矩阵',
      '只使用当前可信 OpenAPI 数量事实：今日、昨日、近 7 日、近 30 日。金额位置显示来源状态，不显示估算值。',
      true,
    )}
    ${homeKpis()}
    ${homeSectionHeading(
      '趋势',
      '日图按业务日期取真实日粒度点，月图只按可证明的日粒度事实归自然月；两图都随负责人、店铺与货号范围联动。',
    )}
    <div class="trend-stack home-trend-stack">
      <article class="panel trend-panel">
        <h4>日销量趋势</h4>
        <p class="sub">${escapeHtml(`${trendWindowLabel()} · ${scopeName} · ${trendRangeLabel(dailyRows)}`)}</p>
        ${renderTrendChart()}
        <p class="chart-legend">纵轴为销量（件），横轴为业务日期；悬停或键盘聚焦任意日期可读出该日销量与覆盖店铺数。缺日粒度点时保留空态，不用窗口累计值补线。</p>
      </article>
      <article class="panel trend-panel">
        <h4>月销量趋势</h4>
        <p class="sub">${escapeHtml(`按业务日期归自然月 · ${scopeName} · ${monthlyCoverageLabel(monthlyRows)}`)}</p>
        ${renderMonthlyTrendChart()}
        <p class="chart-legend">纵轴为月销量（件）；每根柱下方标出该月实际覆盖业务日数 / 自然日数，部分覆盖的月份不能当作整月合计。</p>
      </article>
    </div>
    ${homeSectionHeading(
      '排行榜',
      '店铺排行与商品排行同时存在；标准商品与店铺本地 SKU 分别标记，未归并商品不会伪装成跨店标准商品。负责人姓名直接显示在店铺结果中。',
    )}
    <section class="rank-grid">
      <article class="panel rank-panel">
        <h4>店铺销量排行</h4>
        <p class="sub">${escapeHtml(`${RANGE_META[state.range].label} · 当前范围 ${storeRows.length} 家店 · ${rankingCoverageNote('store')}`)}</p>
        ${homeRankList(storeRows, 'store', state.range)}
        <a class="text-link" href="#sales">查看完整店铺表 →</a>
      </article>
      <article class="panel rank-panel">
        <h4>店铺近 30 日排行</h4>
        <p class="sub">${escapeHtml(`滚动近 30 日 · 当前范围 ${storeRows.length} 家店 · 用于识别稳定规模`)}</p>
        ${homeRankList(storeRows, 'store', 'last30Days')}
        <a class="text-link" href="#sales">查看店铺销量分析 →</a>
      </article>
      <article class="panel rank-panel">
        <h4>货号销量排行</h4>
        <p class="sub">${escapeHtml(`${RANGE_META[state.range].label} · ${productIdentityLabel(productSource)} · ${rankingCoverageNote(productRankingKey)}`)}</p>
        ${homeRankList(productRows, 'sku', state.range)}
        <a class="text-link" href="#products">查看商品身份与完整排行 →</a>
      </article>
      <article class="panel rank-panel">
        <h4>货号近 30 日排行</h4>
        <p class="sub">${escapeHtml(`滚动近 30 日 · ${coverage.label} · 用于识别长期主力货号`)}</p>
        ${homeRankList(productRows, 'sku', 'last30Days')}
        <a class="text-link" href="#products">查看商品归并与明细 →</a>
      </article>
    </section>
    ${homeSectionHeading(
      '运营提醒',
      '汇总库存缺货、采购交付、商品身份、Webhook 与数据质量异常；每条给出来源、影响范围、严重度和建议查看的子页面。本批只读，不提供执行入口。',
    )}
    ${renderOperationalPriorities({ home: true })}`;
}

function permissionBadge(permission) {
  const status = permission?.status || 'unknown';
  return `<span class="row-status ${escapeHtml(status)}">${escapeHtml(permission?.label || '权限待确认')}</span>`;
}

function comparableDailySignal(item) {
  const last7Days = item?.unitsSold?.last7Days;
  const last30Days = item?.unitsSold?.last30Days;
  if (!isUnit(last7Days) || !isUnit(last30Days) || last30Days < last7Days) {
    return {
      recent: null,
      previous: null,
      label: '不可比',
      tone: 'unknown',
    };
  }
  const recent = last7Days / 7;
  const previous = (last30Days - last7Days) / 23;
  if (previous === 0) {
    return {
      recent,
      previous,
      label: recent === 0 ? '持平' : '新增销量',
      tone: recent === 0 ? 'unknown' : 'complete',
    };
  }
  if (previous < 1 && recent > previous) {
    return {
      recent,
      previous,
      label: '低基数增长',
      tone: 'partial',
    };
  }
  const change = (recent - previous) / previous;
  return {
    recent,
    previous,
    label: `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`,
    tone: change >= 0.1 ? 'complete' : change <= -0.1 ? 'blocked' : 'partial',
  };
}

function formatDailyAverage(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)
    : '—';
}

function standardProductRowsForTable() {
  const source = scopedProductRanking();
  const rows = source.rows.filter(isCanonicalProduct);
  const safeRows = source.scoped ? aggregateCanonicalProducts(rows) : rows;
  return rowWindowSupported() ? sortBySelectedRange(safeRows) : safeRows;
}

function matchesSalesProductFilter(item) {
  const active = quickFilterValue('sales');
  if (active === 'ALL') return true;
  if (active === 'CANONICAL') return isCanonicalProduct(item);
  if (active === 'UNMAPPED') return !isCanonicalProduct(item);
  const signal = comparableDailySignal(item);
  if (active === 'UNCOMPARABLE') return signal.recent === null || signal.previous === null;
  if (signal.recent === null || signal.previous === null) return false;
  if (active === 'GROWING') {
    if (signal.previous === 0) return signal.recent > 0;
    return (signal.recent - signal.previous) / signal.previous >= 0.1;
  }
  if (active === 'DECLINING') {
    if (signal.previous === 0) return false;
    return (signal.recent - signal.previous) / signal.previous <= -0.1;
  }
  return true;
}

function salesTable(kind, rowsOverride = null) {
  const isStore = kind === 'store';
  const isStandard = kind === 'standard';
  const rows = rowsOverride || (isStore ? storeRowsForTable() : skuRowsForTable());
  if (!rows.length) return emptyEvidence(
    isStore ? '店铺销量表暂无可用行' : isStandard ? '标准商品销量表暂无可用行' : '商品销量表暂无可用行',
    dimensionBoundary(kind),
  );
  const visibleRows = isStore ? rows : rows.slice(0, 100);

  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th scope="col">序号</th>
            <th scope="col">${isStore ? '店铺 / 负责人' : isStandard ? '标准商品' : '商品 / 店内货号'}</th>
            ${isStore ? '<th scope="col">销量权限</th>' : '<th scope="col">身份范围</th>'}
            <th scope="col" class="number-column ${state.range === 'today' ? 'selected-column' : ''}">今日</th>
            <th scope="col" class="number-column ${state.range === 'yesterday' ? 'selected-column' : ''}">昨日*</th>
            <th scope="col" class="number-column ${state.range === 'last7Days' ? 'selected-column' : ''}">近 7 日</th>
            <th scope="col" class="number-column ${state.range === 'last30Days' ? 'selected-column' : ''}">近 30 日</th>
            <th scope="col" class="number-column">近 7 日日均</th>
            <th scope="col" class="number-column">此前 23 日日均</th>
            <th scope="col">日均变化</th>
          </tr>
        </thead>
        <tbody>
          ${visibleRows.map((item, index) => {
            const signal = comparableDailySignal(item);
            return `
            <tr>
              <td class="row-index">${String(index + 1).padStart(2, '0')}</td>
              <td class="entity-column">
                <strong>${escapeHtml(isStore ? (item.name || item.code) : productCode(item, isStandard || isCanonicalProduct(item)))}</strong>
                <span>${escapeHtml(isStore
                  ? [item.code, ownerNameForStore(item) || '负责人未分配'].join(' · ')
                  : [productName(item), item.storeCode, isCanonicalProduct(item) ? '标准身份' : '店内身份'].filter(Boolean).join(' · '))}</span>
              </td>
              <td>${isStore
                ? permissionBadge(item.permission)
                : productIdentityBadge(item)}</td>
              <td class="number-column ${state.range === 'today' ? 'selected-column' : ''}">${formatUnits(item?.unitsSold?.today)}</td>
              <td class="number-column ${isUnit(item?.unitsSold?.yesterday) ? '' : 'missing-value'} ${state.range === 'yesterday' ? 'selected-column' : ''}">${formatUnits(item?.unitsSold?.yesterday)}</td>
              <td class="number-column ${state.range === 'last7Days' ? 'selected-column' : ''}">${formatUnits(item?.unitsSold?.last7Days)}</td>
              <td class="number-column ${state.range === 'last30Days' ? 'selected-column' : ''}">${formatUnits(item?.unitsSold?.last30Days)}</td>
              <td class="number-column">${formatDailyAverage(signal.recent)}</td>
              <td class="number-column">${formatDailyAverage(signal.previous)}</td>
              <td><span class="row-status ${escapeHtml(signal.tone)}">${escapeHtml(signal.label)}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <p class="table-note">* 破折号表示该窗口未接入或不完整，不表示销量为 0。日均变化使用“近 7 日日均”对比“此前 23 日日均”；低基数增长不展示夸张百分比。当前显示 ${numberFormatter.format(visibleRows.length)} / ${numberFormatter.format(rows.length)} 条${!isStore && rows.length > visibleRows.length ? '，商品排行最多展示前 100 条' : ''}；店内商品身份不会跨店按裸 SKU 合并。</p>`;
}

function renderSales() {
  const scope = scopedUnits();
  const focusValue = scope.units[state.range];
  const coverage = identityCoverage();
  const productRows = skuRowsForTable().filter(matchesSalesProductFilter);
  const standardRows = standardProductRowsForTable().filter(matchesSalesProductFilter);
  return `
    ${sampleNotice()}
    ${pageIntro(
      'SALES ANALYSIS',
      '销量分析',
      '比较当前窗口内的负责人、店铺和商品销量数量。店内身份与标准商品身份分开表达。',
      `<span>当前口径</span><strong>${escapeHtml(RANGE_META[state.range].label)}</strong><small>${escapeHtml(filterSummary())}</small>`,
    )}
    <aside class="quality-notice unknown">
      <strong>今日是实时累计，不与完整昨日直接作因果比较</strong>
      <span>趋势判断优先看近 7 日日均与此前 23 日日均；今日数据需结合当前时刻、店铺覆盖和日切状态解释。</span>
    </aside>
    <section class="focus-strip">
      <div><span>当前筛选销量</span><strong>${formatUnits(focusValue)} <small>件</small></strong></div>
      <p><b>${escapeHtml(scope.title)}</b>${escapeHtml(scope.note)}</p>
      ${sourceChip()}
    </section>
    <section class="table-section">
      ${panelHeading('STORE DETAIL', '完整店铺销量表', '当前筛选可用的全部店铺行')}
      ${salesTable('store')}
    </section>
    <section class="table-section">
      ${panelHeading('PRODUCT DETAIL', productIdentityLabel(), `完整商品口径 · ${coverage.label} · 未归并商品保持店内隔离 · 当前最多显示前 100 条`)}
      ${quickFilterBar('sales', '商品快速筛查', [
        ['ALL', '全部商品'],
        ['GROWING', '增长 ≥10%'],
        ['DECLINING', '下降 ≤-10%'],
        ['UNCOMPARABLE', '不可比'],
        ['CANONICAL', '标准身份'],
        ['UNMAPPED', '待归并'],
      ])}
      ${salesTable('sku', productRows)}
    </section>
    <section class="table-section">
      ${panelHeading('STANDARD PRODUCT DETAIL', '标准商品排行', `${coverage.confirmed}/${coverage.total} 个目录 SKU 已确认；该表是独立身份视图，不替代完整商品排行`)}
      ${salesTable('standard', standardRows)}
    </section>`;
}

function productRows() {
  return skuRowsForView();
}

function pendingProductMappingTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有待归并货号',
      '这里只说明没有命中当前筛选的未确认身份；不会据此推断全部货号都已归并。',
    );
  }
  const active = quickFilterValue('products');
  const filtered = rows.filter((row) => {
    if (active === 'MISSING_SPU') return String(row.mappingStatus || '').toUpperCase() === 'MISSING_SPU_ID';
    if (active === 'WITH_SALES') return isUnit(row?.unitsSold?.[state.range]) && row.unitsSold[state.range] > 0;
    return true;
  });
  const sorted = [...filtered].sort((left, right) => {
    const leftValue = left?.unitsSold?.[state.range];
    const rightValue = right?.unitsSold?.[state.range];
    return (isUnit(rightValue) ? rightValue : -1) - (isUnit(leftValue) ? leftValue : -1);
  });
  const visible = sorted.slice(0, 50);
  if (!visible.length) {
    return emptyEvidence(
      '当前快速筛查没有待归并货号',
      '调整快速筛查或全局商品搜索后重试；空结果不表示全量目录已完成归并。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table product-table pending-mapping-table">
        <thead><tr><th scope="col">店铺</th><th scope="col">原始货号 / SKC</th><th scope="col">平台 SKU</th><th scope="col">商品名称</th><th scope="col" class="number-column">${escapeHtml(RANGE_META[state.range].label)}销量</th><th scope="col">归并状态</th><th scope="col">定位</th></tr></thead>
        <tbody>${visible.map((item) => `
          <tr class="${isFocusedRow(item, 'product') ? 'focused-row' : ''}">
            <td class="entity-column"><strong>${escapeHtml(item.storeCode || '店铺待确认')}</strong><span>店内身份隔离</span></td>
            <td class="entity-column"><strong>${escapeHtml(item.supplierCode || item.supplierSku || item.productKey || '原始货号待确认')}</strong><span>${escapeHtml(item.skc || 'SKC 待确认')}</span></td>
            <td class="entity-column"><strong>${escapeHtml(item.sku || 'SKU 待确认')}</strong><span>${escapeHtml(item.productKey || '')}</span></td>
            <td>${escapeHtml(productName(item))}</td>
            <td class="number-column">${formatUnits(item?.unitsSold?.[state.range])}</td>
            <td><span class="row-status partial">${escapeHtml(mappingStatusLabel(item.mappingStatus))}</span></td>
            <td>${rowFocusLink(item, 'product')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">按${escapeHtml(RANGE_META[state.range].label)}销量影响降序，显示前 ${numberFormatter.format(visible.length)} / ${numberFormatter.format(sorted.length)} 条${sorted.length > visible.length ? '，其余已截断' : ''}。优先归并高销量货号；这些行始终保留“店铺 + 原始货号/SKC/SKU”身份，不参与跨店标准商品合计。</p>`;
}

function renderProducts() {
  const rows = productRows();
  const visibleRows = rows.slice(0, 50);
  const source = scopedProductRanking();
  const pendingRows = unmappedStoreSkuRows();
  const coverage = identityCoverage();
  const pendingImpact = sumCompleteWindow(pendingRows, state.range);
  const identityStatus = source.mixed
    ? '标准商品与店内身份分层可见'
    : source.canonical ? '标准商品身份已接入' : '店内商品身份待归并';
  return `
    ${sampleNotice()}
    ${focusEvidencePanel()}
    ${pageIntro(
      'PRODUCT IDENTITY',
      '商品中心',
      '原始店铺货号、SKC、SKU 与标准商品分层保存；只有通过身份归并的商品才能跨店聚合。',
      `<span>当前身份范围</span><strong>${escapeHtml(identityStatus)}</strong><small>${escapeHtml(coverage.label)} · 全量活跃目录 ${numberFormatter.format(coverage.confirmed)}/${numberFormatter.format(coverage.total)} 个 SKU 已确认${coverage.missingSpu === null ? '' : ` · 缺少平台 SPU ${numberFormatter.format(coverage.missingSpu)} 个`}</small>`,
    )}
    ${operationSummaryCards([
      {
        label: '标准身份覆盖',
        value: coverage.rate === null ? '待确认' : `${(coverage.rate * 100).toFixed(1)}%`,
        note: `${numberFormatter.format(coverage.confirmed)} / ${numberFormatter.format(coverage.total)} 个目录 SKU`,
        tone: coverage.rate === 1 ? 'available' : 'partial',
      },
      {
        label: '未确认目录 SKU',
        value: numberFormatter.format(coverage.unconfirmed),
        note: '未确认商品保持店铺隔离，不会按裸 SKU 跨店合并',
        tone: coverage.unconfirmed > 0 ? 'partial' : 'available',
      },
      {
        label: '当前销量范围待归并',
        value: numberFormatter.format(pendingRows.length),
        note: pendingImpact === null ? '销量影响存在缺失窗口' : `${RANGE_META[state.range].label}涉及 ${numberFormatter.format(pendingImpact)} 件`,
        tone: pendingRows.length > 0 ? 'partial' : 'available',
      },
      {
        label: '归并顺序',
        value: '高销量优先',
        note: '先处理销量影响大的货号，再处理缺少平台 SPU 和属性冲突',
      },
    ])}
    <section class="table-section">
      ${panelHeading('PRODUCT RANKING', productIdentityLabel(source), `${RANGE_META[state.range].label} · 完整销量范围 · 标准商品与店内商品明确标记`)}
      ${visibleRows.length ? `
        <div class="table-wrap">
          <table class="data-table product-table">
            <thead><tr><th scope="col">标准商品 / 店内商品键</th><th scope="col">商品名 / 店铺</th><th scope="col">当前窗口销量</th><th scope="col">身份范围</th><th scope="col">映射状态</th><th scope="col">定位</th></tr></thead>
            <tbody>${visibleRows.map((item) => `
              <tr class="${isFocusedRow(item, 'product') ? 'focused-row' : ''}">
                <td class="entity-column"><strong>${escapeHtml(productCode(item))}</strong><span>${escapeHtml(item.canonicalProductId || item.skc || item.sku || '')}</span></td>
                <td class="entity-column"><strong>${escapeHtml(productName(item))}</strong><span>${escapeHtml(item.storeCode ? `店铺 ${item.storeCode}` : `${item.storeCount || '—'} 家店铺`)}</span></td>
                <td class="number-column">${formatUnits(item?.unitsSold?.[state.range])}</td>
                <td>${productIdentityBadge(item)}</td>
                <td class="boundary-cell">${escapeHtml(mappingStatusLabel(item.mappingStatus || (isCanonicalProduct(item) ? 'CONFIRMED' : 'UNMAPPED')))}</td>
                <td>${rowFocusLink(item, 'product')}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        <p class="table-note">按${escapeHtml(RANGE_META[state.range].label)}销量降序显示前 ${numberFormatter.format(visibleRows.length)} / ${numberFormatter.format(rows.length)} 条${rows.length > visibleRows.length ? '，其余已截断' : ''}。排行同时保留已确认标准商品和未确认店内商品；只有标准商品允许跨店聚合，未确认行始终按店铺身份隔离。${coverage.label}。</p>` : emptyEvidence(
          '商品排行暂无可用行',
          selectedStore() || selectedOwner()
            ? '当前数据没有带店铺键的货号销量事实，无法安全生成筛选范围内的商品排行。'
            : '当前 API 没有返回命中搜索的商品销量行。',
        )}
    </section>
    <section class="table-section">
      ${panelHeading('UNMAPPED IDENTITY QUEUE', '高销量待归并货号', `${pendingRows.length ? `${numberFormatter.format(pendingRows.length)} 条未确认店内身份` : '当前筛选无未确认店内身份'} · 每次最多展示前 50 条`)}
      ${quickFilterBar('products', '快速筛查', [
        ['ALL', '全部待归并'],
        ['WITH_SALES', '当前窗口有销量'],
        ['MISSING_SPU', '缺少平台 SPU'],
      ])}
      ${pendingProductMappingTable(pendingRows)}
    </section>
    <section class="process-panel">
      ${panelHeading('IDENTITY RESOLUTION', '货号科学归并', '原始值永不覆盖，合并与拆分均保留版本和审核记录')}
      <ol class="process-flow four-steps">
        <li><span>01</span><div><strong>原始身份留存</strong><p>按店铺保存 supplierCode、supplierSku、SKC、SKU、标题与属性。</p></div><b>平台事实</b></li>
        <li><span>02</span><div><strong>候选归并</strong><p>用型号、品类、关键属性、条码和图片生成候选，不靠单一字符串。</p></div><b>待接入</b></li>
        <li><span>03</span><div><strong>冲突与置信度</strong><p>电压、插头、容量等冲突禁止自动合并；中置信度进入人工审核。</p></div><b>待接入</b></li>
        <li><span>04</span><div><strong>标准商品版本</strong><p>确认后生成标准商品与变体，事实仍引用原始平台 SKU。</p></div><b>${coverage.confirmed > 0 ? '部分可用' : '待接入'}</b></li>
      </ol>
    </section>`;
}

function integrationGate({ kicker, title, description, evidence, boundary, futureFields }) {
  return `
    <section class="integration-gate">
      <div class="gate-state">
        <span>${escapeHtml(kicker)}</span>
        <strong>事实未接入</strong>
        <p>${escapeHtml(description)}</p>
      </div>
      <div class="gate-detail">
        <h2>${escapeHtml(title)}</h2>
        <ol>
          ${evidence.map((item) => `<li><span aria-hidden="true"></span><p>${escapeHtml(item)}</p><b>待证据</b></li>`).join('')}
        </ol>
      </div>
      <aside class="boundary-note">
        <strong>当前展示边界</strong>
        <p>${escapeHtml(boundary)}</p>
        <span>接入后字段：${escapeHtml(futureFields)}</span>
      </aside>
    </section>`;
}

function renderCompliance() {
  return `
    ${sampleNotice()}
    ${pageIntro(
      'COMPLIANCE & PRICE',
      '合规与价格',
      '商品资料、证书、审核、供货价、议价与建议零售价分层管理；价格事实不推导消费者成交额。',
      '<span>合规与价格事实</span><strong>尚未接入</strong><small>写动作保持关闭</small>',
    )}
    ${integrationGate({
      kicker: 'COMPLIANCE DATA',
      title: '合规与价格接入条件',
      description: '不把“没有数据”显示成零风险，也不根据商品名猜证书或价格状态。',
      evidence: [
        '逐店回读“商品合规”业务权限与店铺授权状态',
        '真实探针合规列表、证书资料、供货价、议价与建议零售价接口',
        '确认商品键、证书类型、审核状态、价格类型、原因与更新时间字段',
        '隔离入仓并对照平台页面完成样本回读',
        '写操作另行通过权限、dry-run、确认、审计和结果回读',
      ],
      boundary: '当前页面只说明接入路径。风险商品数、缺证数、供货价和议价状态均未知，因此不展示任何数值或金额。',
      futureFields: '商品身份、资料类型、审核状态、原因、有效期、供货价、议价、建议零售价、更新时间',
    })}`;
}

function demandSignal(kind) {
  const rows = skuRowsForView();
  if (!rows.length) {
    return emptyEvidence('销量需求信号不可用', dimensionBoundary('sku'));
  }
  return `
    <ol class="signal-list">
      ${rows.slice(0, 6).map((item, index) => `
        <li><span>${String(index + 1).padStart(2, '0')}</span><div><strong>${escapeHtml(item.sku)}</strong><small>${escapeHtml(item.name)}</small></div><b>${formatUnits(item?.unitsSold?.[state.range])}<small> 件</small></b></li>`).join('')}
    </ol>
    <p class="table-note">这是${escapeHtml(RANGE_META[state.range].label)}销量信号，不是${kind === 'inventory' ? '实际库存、可售天数或补货量' : '采购建议、备货单或到货承诺'}。</p>`;
}

function latestTimestamp(rows, key = 'latestSourceFetchedAt') {
  const values = rows
    .map((row) => row?.[key])
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.valueOf()));
  if (!values.length) return null;
  return new Date(Math.max(...values.map((value) => value.valueOf()))).toISOString();
}

function operationSummaryCards(cards) {
  return `
    <div class="operation-summary-grid">
      ${cards.map(({ label, value, note, tone = '' }) => `
        <article class="operation-summary-card ${escapeHtml(tone)}">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <p>${escapeHtml(note)}</p>
        </article>`).join('')}
    </div>`;
}

function purchaseOrderAttentionTable(rows, hasEvidence) {
  if (!rows.length) {
    return emptyEvidence(
      hasEvidence ? '当前筛选没有采购单关注项' : '采购单级关注清单待接入',
      hasEvidence
        ? '只表示当前筛选未命中逾期、待交付、待收货或待入库单据；不代表全部采购单已完成。'
        : '先使用下方店铺×状态汇总判断范围；单据级契约接入后可按采购单号、要求时间和数量下钻。',
    );
  }
  const visible = orderRowsForFocus([...rows].sort(comparePriority), 'procurement')
    .slice(0, 100);
  return `
    <div class="table-wrap">
      <table class="data-table operational-table">
        <thead><tr><th scope="col">优先级</th><th scope="col">店铺 / 采购单</th><th scope="col">关注语义</th><th scope="col">状态 / 类型</th><th scope="col">订购→交付→收货→入库</th><th scope="col">要求时间</th><th scope="col">仓库</th><th scope="col">证据时间</th><th scope="col">定位</th></tr></thead>
        <tbody>${visible.map((row) => `
          <tr class="${isFocusedRow(row, 'procurement') ? 'focused-row' : ''}">
            <td>${severityBadge(row.severity)}</td>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml(row.orderNo || '采购单号待确认')}</span></td>
            <td class="entity-column"><strong>${escapeHtml(rowAttentionStage(row, 'procurement'))}</strong><span>${escapeHtml(row.attentionCode || '单据状态复核')}</span></td>
            <td class="entity-column"><strong>${escapeHtml(row.statusName || row.statusCode || '状态未知')}</strong><span>${escapeHtml(row.orderTypeName || '类型未知')}</span></td>
            <td class="boundary-cell"><strong>${escapeHtml([
              nullableUnits(row.orderQuantity),
              nullableUnits(row.deliveryQuantity),
              nullableUnits(row.receiptQuantity),
              nullableUnits(row.storageQuantity),
            ].join(' → '))}</strong><span>${isUnit(row.lineCount) ? `${numberFormatter.format(row.lineCount)} 个行项目` : '行项目数未知'}${isUnit(row.defectiveQuantity) ? ` · 残次 ${numberFormatter.format(row.defectiveQuantity)}` : ''}</span></td>
            <td class="boundary-cell"><strong>交付：${escapeHtml(sourceTime(row.requestedDeliveryAt))}</strong><span>收货：${escapeHtml(sourceTime(row.requestedReceiptAt))}</span></td>
            <td class="boundary-cell">${escapeHtml(row.warehouseName || '仓库待确认')}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
            <td>${rowFocusLink(row, 'procurement')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">清单优先展示逾期、待交付、待收货和待入库单据；数量链路未知时保留“—”。显示 ${numberFormatter.format(visible.length)} / ${numberFormatter.format(rows.length)} 条。</p>`;
}

function procurementTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有采购单状态行',
      '这只表示当前负责人、店铺或搜索条件没有命中；不把空结果解释为 0 张采购单。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table operational-table">
        <thead><tr><th scope="col">店铺</th><th scope="col">采购单状态</th><th scope="col" class="number-column">采购单数</th><th scope="col">来源快照</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml(row.storeCode || '店铺编码未知')}</span></td>
            <td><span class="row-status ${sourceStatusTone(row.statusCode || row.statusName)}">${escapeHtml(row.statusName || row.statusCode || '状态未知')}</span></td>
            <td class="number-column ${isUnit(row.orderCount) ? '' : 'missing-value'}">${nullableUnits(row.orderCount)}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">“—”表示平台字段未知或当前快照未覆盖，不表示采购单数为 0；只有明确返回的 0 才展示为 0。</p>`;
}

function renderProcurement() {
  const supply = supplyDomain();
  const allRows = domainRows(supply, 'purchaseOrderStatus');
  const rows = scopedOperationRows(allRows);
  const attentionAvailable = attentionEvidence('purchaseOrderAttention', 'purchaseOrders');
  const allAttention = scopedOperationRows(attentionRows('purchaseOrderAttention'));
  const attention = allAttention.filter((row) => matchesQuickFilter(row, 'procurement', 'procurement'));
  const totalOrders = completeNullableSum(rows, 'orderCount');
  const statusCount = new Set(rows.map((row) => row.statusCode || row.statusName).filter(Boolean)).size;
  const connectionState = domainConnectionState(
    supply,
    ['purchaseOrderAttention', 'purchaseOrderStatus'],
    ['purchaseOrders'],
  );
  const connected = connectionState === 'available';
  const connectedLabel = allRows.length
    ? '真实状态已接入'
    : connected ? '接口覆盖完整 · 当前窗口无事实行' : '尚未完成可信接入';
  return `
    ${sampleNotice()}
    ${focusEvidencePanel()}
    ${pageIntro(
      'PURCHASE ORDERS',
      '采购单中心',
      '采购单是 SHEIN 向商家下达的供货单据，不是消费者订单；销量只作为需求参照。',
      `<span>采购单事实</span><strong>${escapeHtml(connectedLabel)}</strong><small>${escapeHtml(connected ? operationScopeNote(rows, '采购单状态') : '不展示订单数或伪造状态')}</small>`,
    )}
    <section class="table-section">
      ${panelHeading('PURCHASE ATTENTION', '采购单关注清单', attentionAvailable ? `${metaCountLabel('purchaseOrders', allAttention)} · 单据级事实优先` : '兼容旧契约 · 单据级事实待接入')}
      ${quickFilterBar('procurement', '快速筛查', [
        ['ALL', '全部关注'],
        ['HIGH', '高优先'],
        ['OVERDUE', '逾期'],
        ['PENDING_DELIVERY', '待交付'],
        ['PENDING_RECEIPT', '待收货'],
        ['PENDING_STORAGE', '待入库'],
      ])}
      ${purchaseOrderAttentionTable(attention, attentionAvailable)}
    </section>
    ${connected ? `
      ${operationSummaryCards([
        {
          label: '当前范围采购单',
          value: totalOrders === null ? '未知' : `${numberFormatter.format(totalOrders)} 张`,
          note: totalOrders === null ? '存在数量未知的状态行，拒绝补零后合计' : '各状态明确数量的完整合计',
          tone: totalOrders === null ? 'partial' : 'available',
        },
        {
          label: '状态种类',
          value: statusCount ? `${numberFormatter.format(statusCount)} 类` : '未知',
          note: '按平台状态码去重，不推导业务完成率',
        },
        {
          label: '店铺覆盖',
          value: rows.length ? `${new Set(rows.map((row) => row.storeCode).filter(Boolean)).size} 家` : '当前筛选无行',
          note: operationScopeNote(rows, '采购单状态'),
        },
        {
          label: '最新来源快照',
          value: latestTimestamp(rows) ? formatDateTime(latestTimestamp(rows)) : '未知',
          note: '展示源接口抓取时间，不冒充采购单业务时间',
        },
      ])}
      <section class="table-section">
        ${panelHeading('PURCHASE ORDER STATUS', '店铺×采购单状态汇总', '第二层总览；数量未知保留为空，具体行动以下方单据关注清单为准')}
        ${procurementTable(rows)}
      </section>
      <div class="split-grid">
        <section class="panel">
          ${panelHeading('DEMAND SIGNAL', '销量需求信号', RANGE_META[state.range].label)}
          ${demandSignal('procurement')}
        </section>
        <section class="panel condition-panel">
          ${panelHeading('DATA BOUNDARY', '采购单数据边界', '事实接入不等于写能力开放')}
          <ul class="condition-list">
            <li><strong>单据口径</strong><span>SHEIN 向商家下达的采购单，不是消费者订单</span></li>
            <li><strong>数量口径</strong><span>采购、交付、收货和入库数量保持独立</span></li>
            <li><strong>来源时间</strong><span>接口快照时间与平台业务时间分开保存</span></li>
            <li><strong>写操作</strong><span>当前页面与服务仍为只读，不提交任何采购单动作</span></li>
          </ul>
        </section>
      </div>` : `
      <div class="split-grid">
        <section class="panel">
          ${panelHeading('DEMAND SIGNAL', '销量需求信号', RANGE_META[state.range].label)}
          ${demandSignal('procurement')}
        </section>
        <section class="panel condition-panel">
          ${panelHeading('PURCHASE ORDER GATE', '采购单接入条件', '主动增量、Webhook 与日终补漏共同取证')}
          <ul class="condition-list">
            <li><strong>采购单列表与详情</strong><span>采购单号、类型、状态、仓库、平台业务时间</span></li>
            <li><strong>数量链路</strong><span>采购、交付、收货、入库、残次数量分别保存</span></li>
            <li><strong>商品键</strong><span>SKC、SKU、supplierCode、supplierSku 与店铺身份对账</span></li>
            <li><strong>增量与补漏</strong><span>更新时间增量、采购单事件、日终全量对账</span></li>
          </ul>
        </section>
      </div>
      <section class="wide-empty-section">
        ${emptyEvidence('采购单事实未接入', '当前没有采购单列表、状态或采购数量事实；不会把销量排行换算成采购单或待交付数量。', '接入后展示急采、备货、JIT母子单、状态与数量进度。')}
      </section>`}`;
}

function deliveryAttentionTable(rows, hasEvidence) {
  if (!rows.length) {
    return emptyEvidence(
      hasEvidence ? '当前筛选没有交付关注项' : '交付单级关注清单待接入',
      hasEvidence
        ? '当前筛选没有命中待揽收、运输中、预计收货超时或待确认交付；不把空清单解释为没有交付单。'
        : '先使用下方店铺×里程碑汇总；单据级契约接入后可按交付单号、预计收货和物流状态下钻。',
    );
  }
  const visible = orderRowsForFocus([...rows].sort(comparePriority), 'fulfilment')
    .slice(0, 100);
  return `
    <div class="table-wrap">
      <table class="data-table operational-table">
        <thead><tr><th scope="col">优先级</th><th scope="col">店铺 / 交付单</th><th scope="col">关注语义</th><th scope="col">里程碑</th><th scope="col">交付数量</th><th scope="col">预约 / 揽收 / 预计收货</th><th scope="col">仓库 / 物流</th><th scope="col">证据时间</th><th scope="col">定位</th></tr></thead>
        <tbody>${visible.map((row) => `
          <tr class="${isFocusedRow(row, 'fulfilment') ? 'focused-row' : ''}">
            <td>${severityBadge(row.severity)}</td>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml(row.deliveryCode || '交付单号待确认')}</span></td>
            <td class="entity-column"><strong>${escapeHtml(rowAttentionStage(row, 'fulfilment'))}</strong><span>${escapeHtml(row.attentionCode || '交付状态复核')}</span></td>
            <td><span class="row-status ${sourceStatusTone(row.milestoneCode)}">${escapeHtml(row.milestoneCode || '里程碑未知')}</span></td>
            <td class="boundary-cell"><strong>${nullableUnits(row.deliveryQuantity)}</strong><span>${isUnit(row.lineCount) ? `${numberFormatter.format(row.lineCount)} 个行项目` : '行项目数未知'}</span></td>
            <td class="boundary-cell"><strong>预约：${escapeHtml(sourceTime(row.reservedParcelAt))}</strong><span>揽收：${escapeHtml(sourceTime(row.takenAt))} · 预计收货：${escapeHtml(sourceTime(row.expectedReceiptAt))}</span></td>
            <td class="boundary-cell"><strong>${escapeHtml(row.warehouseName || '仓库待确认')}</strong><span>${escapeHtml(row.expressCompanyName || '物流待确认')}</span></td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
            <td>${rowFocusLink(row, 'fulfilment')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">按优先级展示待揽收、运输中、待收货和超时关注单据。显示 ${numberFormatter.format(visible.length)} / ${numberFormatter.format(rows.length)} 条。</p>`;
}

function fulfilmentTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有交付里程碑行',
      '这不代表没有发货或入仓；请调整负责人、店铺或搜索条件。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table operational-table">
        <thead><tr><th scope="col">店铺</th><th scope="col">履约里程碑</th><th scope="col" class="number-column">交付单数</th><th scope="col" class="number-column">交付数量</th><th scope="col">数量覆盖</th><th scope="col">来源快照</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml(row.storeCode || '店铺编码未知')}</span></td>
            <td><span class="row-status ${sourceStatusTone(row.milestoneCode)}">${escapeHtml(row.milestoneCode || '里程碑未知')}</span></td>
            <td class="number-column ${isUnit(row.deliveryCount) ? '' : 'missing-value'}">${nullableUnits(row.deliveryCount)}</td>
            <td class="number-column ${isUnit(row.deliveryQuantity) ? '' : 'missing-value'}">${nullableUnits(row.deliveryQuantity)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.deliveryQuantityCoverage, [['knownLineCount', 'totalLineCount', '行']]))}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">交付单数与交付数量是两个口径。数量为“—”时同时展示已知行覆盖率，绝不按 0 参与合计。</p>`;
}

function renderFulfilment() {
  const supply = supplyDomain();
  const allRows = domainRows(supply, 'deliveryMilestones');
  const rows = scopedOperationRows(allRows);
  const attentionAvailable = attentionEvidence('deliveryAttention', 'deliveries');
  const allAttention = scopedOperationRows(attentionRows('deliveryAttention'));
  const attention = allAttention.filter((row) => matchesQuickFilter(row, 'fulfilment', 'fulfilment'));
  const connected = domainConnectionState(
    supply,
    ['deliveryAttention', 'deliveryMilestones'],
    ['deliveries'],
  ) === 'available';
  const connectionLabel = allRows.length
    ? '真实里程碑已接入'
    : connected ? '接口覆盖完整 · 当前窗口无事实行' : '尚未完成可信接入';
  const deliveryCount = completeNullableSum(rows, 'deliveryCount');
  const deliveryQuantity = completeCoveredNullableSum(
    rows,
    'deliveryQuantity',
    'deliveryQuantityCoverage',
    [['knownLineCount', 'totalLineCount', '行']],
  );
  return `
    ${sampleNotice()}
    ${focusEvidencePanel()}
    ${pageIntro(
      'DELIVERY & INBOUND',
      '交付与入仓',
      '跟踪发货、物流预报、送达、收货、查验、入库和残次节点；每个节点只认平台单据事实。',
      `<span>交付事实</span><strong>${escapeHtml(connectionLabel)}</strong><small>${escapeHtml(connected ? operationScopeNote(rows, '交付里程碑') : '未知不等于未发货')}</small>`,
    )}
    <section class="table-section">
      ${panelHeading('DELIVERY ATTENTION', '交付入仓关注清单', attentionAvailable ? `${metaCountLabel('deliveries', allAttention)} · 单据级事实优先` : '兼容旧契约 · 单据级事实待接入')}
      ${quickFilterBar('fulfilment', '快速筛查', [
        ['ALL', '全部关注'],
        ['HIGH', '高优先'],
        ['OVERDUE', '超时'],
        ['PENDING_RECEIPT', '运输中 / 待收货'],
      ])}
      ${deliveryAttentionTable(attention, attentionAvailable)}
    </section>
    ${connected ? `
      ${operationSummaryCards([
        {
          label: '里程碑计数合计',
          value: deliveryCount === null ? '未知' : `${numberFormatter.format(deliveryCount)} 次`,
          note: deliveryCount === null ? '存在交付单数未知的行' : '按里程碑状态行合计',
          tone: deliveryCount === null ? 'partial' : 'available',
        },
        {
          label: '当前范围交付数量',
          value: deliveryQuantity === null ? '未知' : `${numberFormatter.format(deliveryQuantity)} 件`,
          note: deliveryQuantity === null ? '至少一行数量未覆盖，拒绝补零合计' : '全部行数量明确',
          tone: deliveryQuantity === null ? 'partial' : 'available',
        },
        {
          label: '里程碑种类',
          value: rows.length ? `${new Set(rows.map((row) => row.milestoneCode).filter(Boolean)).size} 类` : '当前筛选无行',
          note: operationScopeNote(rows, '交付里程碑'),
        },
        {
          label: '最新来源快照',
          value: latestTimestamp(rows) ? formatDateTime(latestTimestamp(rows)) : '未知',
          note: '来源抓取时间与物流节点业务时间分开',
        },
      ])}
      <section class="table-section">
        ${panelHeading('FULFILMENT MILESTONES', '店铺×交付里程碑汇总', '第二层总览；交付数量按行显示覆盖率，未知不等于 0')}
        ${fulfilmentTable(rows)}
      </section>` : integrationGate({
      kicker: 'FULFILMENT DATA',
      title: '交付与入仓接入条件',
      description: '采购数量、交付数量、收货数量和入库数量不能混成一个“完成量”。',
      evidence: [
        '回读发货单、包裹、物流预报和平台业务状态',
        '分别保存分配、交付、送达、收货、查验与入库时间',
        '逐行对账交付、收货、入库、残次与退回数量',
        '按采购单号、发货单号和包裹号建立可追溯关联',
        'Webhook 只做变化通知，Worker 补查详情并由定时任务补漏',
      ],
      boundary: '当前没有真实发货单、物流、收货、查验或入库事实，因此不展示履约率、准时率和异常数。',
      futureFields: '采购单、发货单、包裹、仓库、节点时间、各阶段数量、异常原因',
    })}`;
}

function inventoryRiskTable(rows, hasEvidence) {
  if (!rows.length) {
    return emptyEvidence(
      hasEvidence ? '当前筛选没有库存风险 SKU' : 'SKU 级库存风险待接入',
      hasEvidence
        ? '当前筛选没有命中缺货或库存对账风险；不代表所有库存类型和店铺都已完整覆盖。'
        : '先使用下方店铺级库存汇总；SKU 风险契约接入后可直接查看缺货数量、可用库存和在途。',
    );
  }
  const visible = orderRowsForFocus([...rows].sort((left, right) => (
    comparePriority(left, right)
    || (isUnit(right.shortageQuantity) ? right.shortageQuantity : -1)
      - (isUnit(left.shortageQuantity) ? left.shortageQuantity : -1)
  )), 'inventory').slice(0, 100);
  return `
    <div class="table-wrap">
      <table class="data-table operational-table inventory-table">
        <thead><tr><th scope="col">优先级</th><th scope="col">店铺 / SKU</th><th scope="col">商品</th><th scope="col">库存类型</th><th scope="col" class="number-column">库存</th><th scope="col" class="number-column">可用</th><th scope="col" class="number-column">在途</th><th scope="col" class="number-column">缺货</th><th scope="col">对账状态</th><th scope="col">证据时间</th><th scope="col">定位</th></tr></thead>
        <tbody>${visible.map((row) => `
          <tr class="${isFocusedRow(row, 'inventory') ? 'focused-row' : ''}">
            <td>${severityBadge(row.severity)}</td>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml(row.skuCode || 'SKU 待确认')}</span></td>
            <td class="entity-column"><strong>${escapeHtml(row.skcName || row.spuName || '商品待确认')}</strong><span>${escapeHtml(row.spuName || '')}</span></td>
            <td><span class="row-status partial">${escapeHtml(row.inventoryTypeCode || '类型未知')}</span></td>
            <td class="number-column">${nullableUnits(row.totalInventoryQuantity ?? row.totalInventory)}</td>
            <td class="number-column">${nullableUnits(row.usableInventory)}</td>
            <td class="number-column">${nullableUnits(row.transitQuantity)}</td>
            <td class="number-column">${nullableUnits(row.shortageQuantity)}</td>
            <td><span class="row-status ${sourceStatusTone(row.reconciliationStatus)}">${escapeHtml(row.reconciliationStatus || '未知')}</span></td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
            <td>${rowFocusLink(row, 'inventory')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">SKU 风险按优先级和缺货影响排序；显示 ${numberFormatter.format(visible.length)} / ${numberFormatter.format(rows.length)} 条。PI、JI、VI 保持平台库存类型原值，不相互混算。</p>`;
}

function stockAdviceRiskTable(rows, hasEvidence) {
  if (!rows.length) {
    return emptyEvidence(
      hasEvidence ? '当前筛选没有备货风险 SKU' : 'SKU 级备货风险待接入',
      hasEvidence
        ? '当前筛选没有命中急采、建议备货或平台预警；未知字段不会补成 0。'
        : '先使用下方店铺级建议汇总；SKU 风险契约接入后可联看预测日销、待供给链路和建议量。',
    );
  }
  const visible = orderRowsForFocus([...rows].sort((left, right) => (
    comparePriority(left, right)
    || (isUnit(right.plannedUrgentQuantity) ? right.plannedUrgentQuantity : -1)
      - (isUnit(left.plannedUrgentQuantity) ? left.plannedUrgentQuantity : -1)
    || (isUnit(right.advisedOrderQuantity) ? right.advisedOrderQuantity : -1)
      - (isUnit(left.advisedOrderQuantity) ? left.advisedOrderQuantity : -1)
  )), 'advice').slice(0, 100);
  return `
    <div class="table-wrap">
      <table class="data-table operational-table advice-table">
        <thead><tr><th scope="col">优先级</th><th scope="col">店铺 / SKU</th><th scope="col">商品 / 货号</th><th scope="col" class="number-column">预测日销</th><th scope="col">待下单 / 待交付 / 待上架 / 在途</th><th scope="col" class="number-column">库存</th><th scope="col" class="number-column">建议</th><th scope="col" class="number-column">已下单</th><th scope="col" class="number-column">急采</th><th scope="col">供给状态</th><th scope="col">证据时间</th><th scope="col">定位</th></tr></thead>
        <tbody>${visible.map((row) => `
          <tr class="${isFocusedRow(row, 'advice') ? 'focused-row' : ''}">
            <td>${severityBadge(row.severity)}</td>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml(row.skuCode || 'SKU 待确认')}</span></td>
            <td class="entity-column"><strong>${escapeHtml(row.skcName || row.spuName || '商品待确认')}</strong><span>${escapeHtml(row.supplierCode || '')}</span></td>
            <td class="number-column">${nullableDecimal(row.predictedDailySales)}</td>
            <td class="boundary-cell">${escapeHtml([
              nullableUnits(row.pendingOrderQuantity),
              nullableUnits(row.pendingDeliveryQuantity),
              nullableUnits(row.pendingShelfQuantity),
              nullableUnits(row.transitQuantity),
            ].join(' / '))}</td>
            <td class="number-column">${nullableUnits(row.stockQuantity)}</td>
            <td class="number-column">${nullableUnits(row.advisedOrderQuantity)}</td>
            <td class="number-column">${nullableUnits(row.placedOrderQuantity)}</td>
            <td class="number-column">${nullableUnits(row.plannedUrgentQuantity)}</td>
            <td class="boundary-cell"><strong>${escapeHtml(row.supplyStatusCode || '供给状态未知')}</strong><span>${escapeHtml([row.shelfStatusCode, row.stockWarningStatusCode].filter(Boolean).join(' · ') || '预警状态未知')}</span></td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
            <td>${rowFocusLink(row, 'advice')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">平台预测、建议和急采均为只读事实；显示 ${numberFormatter.format(visible.length)} / ${numberFormatter.format(rows.length)} 条，不会自动生成采购动作。</p>`;
}

function inventoryTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有库存快照行',
      '这不代表库存为 0；请调整负责人、店铺或搜索条件。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table operational-table inventory-table">
        <thead><tr><th scope="col">店铺 / 类型</th><th scope="col" class="number-column">SKU 数</th><th scope="col" class="number-column">库存数量</th><th scope="col" class="number-column">可用库存</th><th scope="col" class="number-column">在途数量</th><th scope="col">在途覆盖</th><th scope="col" class="number-column">缺货 SKU</th><th scope="col" class="number-column">缺货数量</th><th scope="col">缺货覆盖</th><th scope="col" class="number-column">对账差异</th><th scope="col">来源快照</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml([row.storeCode, row.inventoryTypeCode].filter(Boolean).join(' · ') || '库存类型未知')}</span></td>
            <td class="number-column ${isUnit(row.skuCount) ? '' : 'missing-value'}">${nullableUnits(row.skuCount)}</td>
            <td class="number-column ${isUnit(row.inventoryQuantity) ? '' : 'missing-value'}">${nullableUnits(row.inventoryQuantity)}</td>
            <td class="number-column ${isUnit(row.usableInventory) ? '' : 'missing-value'}">${nullableUnits(row.usableInventory)}</td>
            <td class="number-column ${isUnit(row.transitQuantity) ? '' : 'missing-value'}">${nullableUnits(row.transitQuantity)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.transitCoverage, [['knownSkuCount', 'totalSkuCount', 'SKU']]))}</td>
            <td class="number-column ${isUnit(row.shortageSkuCount) ? '' : 'missing-value'}">${nullableUnits(row.shortageSkuCount)}</td>
            <td class="number-column ${isUnit(row.shortageQuantity) ? '' : 'missing-value'}">${nullableUnits(row.shortageQuantity)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.shortageCoverage, [['knownSkuCount', 'totalSkuCount', 'SKU']]))}</td>
            <td class="number-column ${isUnit(row.reconciliationMismatchCount) ? '' : 'missing-value'}">${nullableUnits(row.reconciliationMismatchCount)}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">库存、可用、在途和缺货是不同口径。“—”表示未知并同时展示覆盖率；明确 0 才展示为 0。</p>`;
}

function stockAdviceTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有备货建议行',
      '没有建议快照不等于建议补货量为 0；不会根据销量自行推导平台建议。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table operational-table advice-table">
        <thead><tr><th scope="col">店铺</th><th scope="col" class="number-column">SKU 总数</th><th scope="col" class="number-column">建议 SKU</th><th scope="col" class="number-column">建议下单量</th><th scope="col">下单量覆盖</th><th scope="col" class="number-column">计划紧急量</th><th scope="col">紧急量覆盖</th><th scope="col" class="number-column">预警 SKU</th><th scope="col">预警覆盖</th><th scope="col">来源快照</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml(row.storeCode || '店铺编码未知')}</span></td>
            <td class="number-column ${isUnit(row.totalSkuCount) ? '' : 'missing-value'}">${nullableUnits(row.totalSkuCount)}</td>
            <td class="number-column ${isUnit(row.advisedSkuCount) ? '' : 'missing-value'}">${nullableUnits(row.advisedSkuCount)}</td>
            <td class="number-column ${isUnit(row.advisedOrderQuantity) ? '' : 'missing-value'}">${nullableUnits(row.advisedOrderQuantity)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.advisedOrderCoverage, [['knownSkuCount', 'totalSkuCount', 'SKU']]))}</td>
            <td class="number-column ${isUnit(row.plannedUrgentQuantity) ? '' : 'missing-value'}">${nullableUnits(row.plannedUrgentQuantity)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.plannedUrgentCoverage, [['knownSkuCount', 'totalSkuCount', 'SKU']]))}</td>
            <td class="number-column ${isUnit(row.warningSkuCount) ? '' : 'missing-value'}">${nullableUnits(row.warningSkuCount)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.warningCoverage, [['knownSkuCount', 'totalSkuCount', 'SKU']]))}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">备货建议是平台只读事实，不是系统自动生成的采购动作；所有写入和提交能力保持关闭。</p>`;
}

function renderInventory() {
  const supply = supplyDomain();
  const allInventory = domainRows(supply, 'inventory');
  const allAdvice = domainRows(supply, 'stockAdvice');
  const inventoryRows = scopedOperationRows(allInventory);
  const adviceRows = scopedOperationRows(allAdvice);
  const inventoryRiskAvailable = attentionEvidence('inventoryRisks');
  const adviceRiskAvailable = attentionEvidence('stockAdviceRisks');
  const allInventoryRisks = scopedOperationRows(attentionRows('inventoryRisks'));
  const allAdviceRisks = scopedOperationRows(attentionRows('stockAdviceRisks'));
  const inventoryRisks = allInventoryRisks.filter((row) => matchesQuickFilter(row, 'inventory'));
  const adviceRisks = allAdviceRisks.filter((row) => matchesQuickFilter(row, 'inventory'));
  const connected = domainConnectionState(
    supply,
    ['inventoryRisks', 'stockAdviceRisks', 'inventory', 'stockAdvice'],
    ['inventory', 'stockAdvice'],
  ) === 'available';
  const factLabel = allInventory.length || allAdvice.length
    ? '真实快照已接入'
    : connected ? '接口覆盖完整 · 当前窗口无事实行' : '尚未完成可信接入';
  const totalInventory = completeNullableSum(inventoryRows, 'inventoryQuantity');
  const totalShortage = completeCoveredNullableSum(
    inventoryRows,
    'shortageQuantity',
    'shortageCoverage',
    [['knownSkuCount', 'totalSkuCount', 'SKU']],
  );
  const totalAdvice = completeCoveredNullableSum(
    adviceRows,
    'advisedOrderQuantity',
    'advisedOrderCoverage',
    [['knownSkuCount', 'totalSkuCount', 'SKU']],
  );
  return `
    ${sampleNotice()}
    ${focusEvidencePanel()}
    ${pageIntro(
      'INVENTORY',
      '库存与供给',
      '库存、缺货需求、待交付、在途与已入库数量分开表达；销量只能作为供给速度参考。',
      `<span>供给事实</span><strong>${escapeHtml(factLabel)}</strong><small>${escapeHtml(connected ? `库存 ${inventoryRows.length} 行 · 建议 ${adviceRows.length} 行；空行不等于业务 0` : '未知不等于零库存')}</small>`,
    )}
    <section class="table-section">
      ${panelHeading(
        'SKU RISK SCREENING',
        'SKU 风险与备货筛查',
        `${inventoryRiskAvailable ? metaCountLabel('inventoryRisks', allInventoryRisks) : '库存风险待接入'} · ${adviceRiskAvailable ? metaCountLabel('stockAdviceRisks', allAdviceRisks) : '备货风险待接入'}`,
      )}
      ${quickFilterBar('inventory', '快速筛查', [
        ['ALL', '全部风险'],
        ['HIGH', '高优先'],
        ['SHORTAGE', '缺货'],
        ['URGENT', '急采'],
        ['ADVICE', '建议备货'],
      ])}
      <section class="table-section">
        ${panelHeading('INVENTORY RISKS', '缺货与库存对账', inventoryRiskAvailable ? 'SKU 级事实优先' : '兼容旧店铺汇总')}
        ${inventoryRiskTable(inventoryRisks, inventoryRiskAvailable)}
      </section>
      <section class="table-section">
        ${panelHeading('STOCK ADVICE RISKS', '急采与备货建议', adviceRiskAvailable ? 'SKU 级事实优先' : '兼容旧店铺汇总')}
        ${stockAdviceRiskTable(adviceRisks, adviceRiskAvailable)}
      </section>
    </section>
    ${connected ? `
      ${operationSummaryCards([
        {
          label: '当前范围库存数量',
          value: totalInventory === null ? '未知' : `${numberFormatter.format(totalInventory)} 件`,
          note: totalInventory === null ? '至少一行库存数量未知，拒绝补零合计' : '全部可见库存行数量明确',
          tone: totalInventory === null ? 'partial' : 'available',
        },
        {
          label: '当前范围缺货数量',
          value: totalShortage === null ? '未知' : `${numberFormatter.format(totalShortage)} 件`,
          note: totalShortage === null ? '缺货覆盖不完整，不能当 0' : '全部可见缺货行数量明确',
          tone: totalShortage === null ? 'partial' : 'available',
        },
        {
          label: '平台建议下单量',
          value: totalAdvice === null ? '未知' : `${numberFormatter.format(totalAdvice)} 件`,
          note: totalAdvice === null ? '建议覆盖不完整，不能自动推导' : '只读建议合计，不代表已下单',
          tone: totalAdvice === null ? 'partial' : 'available',
        },
        {
          label: '最新来源快照',
          value: latestTimestamp([...inventoryRows, ...adviceRows]) ? formatDateTime(latestTimestamp([...inventoryRows, ...adviceRows])) : '未知',
          note: '来源抓取时间，不冒充库存业务时点',
        },
      ])}
      <section class="table-section">
        ${panelHeading('INVENTORY SNAPSHOT', '店铺×库存类型汇总', `${operationScopeNote(inventoryRows, '库存')} · 第二层总览`)}
        ${inventoryTable(inventoryRows)}
      </section>
      <section class="table-section">
        ${panelHeading('STOCK ADVICE', '店铺级平台备货建议汇总', `${operationScopeNote(adviceRows, '备货建议')} · 第二层总览`)}
        ${stockAdviceTable(adviceRows)}
      </section>
      <div class="split-grid">
        <section class="panel">
          ${panelHeading('SALES VELOCITY', '销量速度信号', RANGE_META[state.range].label)}
          ${demandSignal('inventory')}
        </section>
        <section class="panel condition-panel">
          ${panelHeading('READ-ONLY BOUNDARY', '只读能力边界', '供给事实可读，库存写操作仍关闭')}
          <ul class="condition-list">
            <li><strong>库存事实</strong><span>实际、可用、在途与缺货按来源字段分开</span></li>
            <li><strong>未知值</strong><span>以 null 和覆盖率表达，不参与合计</span></li>
            <li><strong>建议事实</strong><span>平台备货建议不自动转换成采购或库存写入</span></li>
            <li><strong>执行能力</strong><span>任何提交按钮和写接口仍保持禁用</span></li>
          </ul>
        </section>
      </div>` : `
      <div class="split-grid">
        <section class="panel">
          ${panelHeading('SALES VELOCITY', '销量速度信号', RANGE_META[state.range].label)}
          ${demandSignal('inventory')}
        </section>
        <section class="panel condition-panel">
          ${panelHeading('INVENTORY GATE', '库存接入条件', '读权限和写权限分开验证')}
          <ul class="condition-list">
            <li><strong>库存查询探针</strong><span>店铺、仓库、SKU、库存类型和快照时间</span></li>
            <li><strong>口径核对</strong><span>实际、可用、锁定、在途数量不能混用</span></li>
            <li><strong>商品与仓库映射</strong><span>仓库编码和商品键需要平台回读</span></li>
            <li><strong>更新能力隔离</strong><span>库存写权限不因读接口成功自动开启</span></li>
          </ul>
        </section>
      </div>
      <section class="wide-empty-section">
        ${emptyEvidence('暂无库存明细', '当前没有实际库存、可用库存、锁定库存或在途库存事实，因此不展示库存数和可售天数。', '完成库存查询探针、字段对账与入仓后开放明细。')}
      </section>
    `}`;
}

function renderReturns() {
  return `
    ${sampleNotice()}
    ${pageIntro(
      'PURCHASE RETURNS',
      '采购退货',
      '这里只处理 SHEIN 采购退货申请、退货单与报废单，不展示消费者退货或消费者退款。',
      '<span>采购退货事实</span><strong>尚未接入</strong><small>与消费者售后严格分离</small>',
    )}
    ${integrationGate({
      kicker: 'RETURN DATA',
      title: '采购退货接入条件',
      description: '采购退货是供应链逆向单据，不能套用半托消费者退货口径。',
      evidence: [
        '回读采购退货申请、退货单、报废单和商品详情',
        '保存申请、确认、出库、收货等平台业务时间与状态',
        '按采购单、退货单、包裹与商品键建立可追溯关联',
        '对账申请数量、退货数量、报废数量及异常原因',
        'Webhook 变化通知与主动补查、日终补漏形成闭环',
      ],
      boundary: '当前没有采购退货事实，因此不展示退货数、退货率、退款金额或待确认任务。',
      futureFields: '采购单号、退货申请、退货/报废单、包裹、商品、数量、原因、状态、节点时间',
    })}`;
}

function renderFinance() {
  return `
    ${sampleNotice()}
    ${pageIntro(
      'RECONCILIATION',
      '财务结算',
      '报账单、预计收入、销售款、客退款、补扣款与付款状态必须来自可追溯的财务事实。',
      '<span>金额事实</span><strong>完全未接入</strong><small>本页不显示示例金额</small>',
    )}
    ${integrationGate({
      kicker: 'FINANCE DATA',
      title: '财务域接入条件',
      description: '只有销量件数不能推导销售款、补扣款、付款或利润。',
      evidence: [
        '回读财务管理业务权限、店铺授权与只读接口范围',
        '探针报账单、报账明细、付款状态与补扣款记录',
        '确认报账期间、币种、销售款、客退款与调整项口径',
        '建立报账单和明细级对账键并保留原始凭证与快照时间',
        '与平台页面抽样核验后才开放差异和汇总视图',
      ],
      boundary: '当前没有报账、销售款、客退款、补扣款或付款事实。本页不会显示 0、占位金额、GMV 或由销量推导的估算值。',
      futureFields: '报账期间、报账单号、币种、预计收入、销售款、客退款、补扣款、付款状态、凭证',
    })}`;
}

function queueHasEvidence(queue) {
  if (!queue || typeof queue !== 'object') return false;
  return [
    'queued',
    'running',
    'retry',
    'deadLetter',
    'expiredLeases',
    'oldestReadyAt',
    'lastReceivedAt',
    'lastProcessedAt',
    'hydrationPending',
    'blockedStores',
  ].some((key) => queue[key] !== undefined && queue[key] !== null);
}

function queueMetric(queue, key) {
  return nullableUnits(queue?.[key]);
}

function safeProjectionSummary(value) {
  if (value === null || value === undefined) return '安全投影为空';
  if (typeof value !== 'object') return String(value);
  const entries = Object.entries(value).slice(0, 4);
  if (!entries.length) return '安全投影为空';
  return entries.map(([key, item]) => {
    if (Array.isArray(item)) return `${key}: ${item.slice(0, 3).join('、')}`;
    if (item && typeof item === 'object') return `${key}: [结构化数据]`;
    return `${key}: ${String(item ?? '—')}`;
  }).join(' · ');
}

function webhookQueueView(queue) {
  if (!queueHasEvidence(queue)) {
    return emptyEvidence(
      'Webhook 队列运行态未接入',
      '没有队列快照时不显示等待数、重试数或死信数为 0。',
      '接入后展示排队、处理中、重试、死信、租约和最近收发时间。',
    );
  }
  return `
    ${operationSummaryCards([
      {
        label: '等待处理',
        value: queueMetric(queue, 'queued'),
        note: '明确返回的排队任务数',
        tone: isUnit(queue.queued) && queue.queued === 0 ? 'available' : 'partial',
      },
      {
        label: '处理中 / 重试',
        value: `${queueMetric(queue, 'running')} / ${queueMetric(queue, 'retry')}`,
        note: '运行中与待重试分开统计',
      },
      {
        label: '死信 / 过期租约',
        value: `${queueMetric(queue, 'deadLetter')} / ${queueMetric(queue, 'expiredLeases')}`,
        note: '只显示真实队列快照；— 表示未知',
        tone: (isUnit(queue.deadLetter) && queue.deadLetter > 0) || (isUnit(queue.expiredLeases) && queue.expiredLeases > 0)
          ? 'blocked'
          : '',
      },
      {
        label: '待补查 / 受阻店铺',
        value: `${queueMetric(queue, 'hydrationPending')} / ${queueMetric(queue, 'blockedStores')}`,
        note: '事件收件与业务详情补查分开',
      },
    ])}
    <div class="queue-time-strip">
      <div><span>最早待处理</span><strong>${escapeHtml(sourceTime(queue.oldestReadyAt))}</strong></div>
      <div><span>最近收件</span><strong>${escapeHtml(sourceTime(queue.lastReceivedAt))}</strong></div>
      <div><span>最近处理</span><strong>${escapeHtml(sourceTime(queue.lastProcessedAt))}</strong></div>
    </div>`;
}

function webhookRuntimeLabel(component, label) {
  if (!component) return `${label} 运行态未知`;
  if (component.fresh === true && component.status === 'RUNNING') {
    return `${label} 在线 · ${sourceTime(component.lastSeenAt)}`;
  }
  return `${label} 心跳失效 · ${sourceTime(component.lastSeenAt)}`;
}

function webhookSubscriptionTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '订阅回读尚无事实行',
      '没有订阅回读时不把任何事件类型标记为已订阅或未订阅。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table webhook-table">
        <thead><tr><th scope="col">应用 / 事件</th><th scope="col">期望状态</th><th scope="col">回读状态</th><th scope="col">回调校验</th><th scope="col">检查时间</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.eventCode || '事件编码未知')}</strong><span>${escapeHtml(row.appFingerprint || '应用指纹未知')}</span></td>
            <td><span class="row-status ${sourceStatusTone(row.desiredState)}">${escapeHtml(row.desiredState || '未知')}</span></td>
            <td><span class="row-status ${sourceStatusTone(row.observedState)}">${escapeHtml(row.observedState || '未知')}</span></td>
            <td>${row.callbackValidated === true
              ? '<span class="row-status complete">已校验</span>'
              : row.callbackValidated === false
                ? '<span class="row-status blocked">未通过</span>'
                : '<span class="row-status unknown">未知</span>'}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.checkedAt || row.updatedAt))}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function webhookEventTimeline(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有可归属的平台事件',
      '这不代表平台没有动态；事件可能尚未接入、无法归属店铺，或未命中当前筛选。',
    );
  }
  const sorted = [...rows].sort((left, right) => {
    const leftTime = new Date(left.occurredAt || left.createdAt || 0).valueOf();
    const rightTime = new Date(right.occurredAt || right.createdAt || 0).valueOf();
    return rightTime - leftTime;
  });
  return `
    <ol class="event-timeline">
      ${sorted.slice(0, 60).map((event) => `
        <li class="${sourceStatusTone(event.severity || event.status)}">
          <div class="event-marker" aria-hidden="true"></div>
          <article>
            <header>
              <div>
                <span>${escapeHtml([event.eventFamily, event.eventCode].filter(Boolean).join(' · ') || '平台事件')}</span>
                <strong>${escapeHtml(event.eventPath || event.businessType || '事件路径待确认')}</strong>
              </div>
              <time>${escapeHtml(sourceTime(event.occurredAt || event.createdAt))}</time>
            </header>
            <p>${escapeHtml(safeProjectionSummary(event.safeProjection))}</p>
            <footer>
              <span>${escapeHtml([event.storeCode, event.businessKey].filter(Boolean).join(' · ') || '技术级事件')}</span>
              <span class="row-status ${sourceStatusTone(event.status)}">${escapeHtml(event.status || event.action || '状态未知')}</span>
              ${event.severity ? `<span class="severity-label ${sourceStatusTone(event.severity)}">${escapeHtml(event.severity)}</span>` : ''}
            </footer>
          </article>
        </li>`).join('')}
    </ol>
    ${sorted.length > 60 ? `<p class="table-note">当前显示最近 60 条，共命中 ${numberFormatter.format(sorted.length)} 条；请继续使用筛选缩小范围。</p>` : ''}`;
}

function renderPlatform() {
  const platform = platformDomain();
  const queue = platform.queue && typeof platform.queue === 'object' ? platform.queue : null;
  const subscriptions = domainRows(platform, 'subscriptions');
  const allEvents = domainRows(platform, 'events');
  const events = scopedOperationRows(allEvents);
  const runtimeHealthy = platform.health?.ok === true;
  const runtimeDegraded = platform.health?.ok === false;
  const receiverReady = platform.health?.receiver?.fresh === true;
  const workerReady = platform.health?.worker?.fresh === true;
  const connected = platformAvailable();
  const evidenceLabels = [
    allEvents.length ? `${numberFormatter.format(allEvents.length)} 条事件` : null,
    subscriptions.length ? `${numberFormatter.format(subscriptions.length)} 条订阅回读` : null,
    queueHasEvidence(queue) ? '队列仓库快照可见' : null,
    platform.health?.receiver ? webhookRuntimeLabel(platform.health.receiver, 'Receiver') : null,
    platform.health?.worker ? webhookRuntimeLabel(platform.health.worker, 'Worker') : null,
  ].filter(Boolean);
  const eventGroups = [
    ['商品与合规', '商品接收、审核、删除、额度、建议零售价、合规失效'],
    ['采购与履约', '采购单、发货单、物流预报、缺货需求'],
    ['采购退货', '退货申请、退货单、报废单'],
    ['授权关系', '店铺授权关系变化'],
  ];
  return `
    ${sampleNotice()}
    ${pageIntro(
      'WEBHOOK EVENTS',
      '平台动态',
      'Webhook 负责及时通知“发生变化”；Worker 只解密并生成白名单事件和补查指令，详情由独立只读同步器补齐。',
      `<span>事件链路</span><strong>${runtimeHealthy ? 'Receiver / Worker 在线' : runtimeDegraded ? '已接入 · 运行态需关注' : connected ? '仓库证据已接入 · Runtime 待回读' : '尚未接入'}</strong><small>${escapeHtml(connected ? (evidenceLabels.join(' · ') || '已有仓库证据，业务数量仍未知') : '没有事件统计时不显示 0')}</small>`,
    )}
    <section class="process-panel">
      ${panelHeading('EVENT PIPELINE', '事件处理链路', '快速回执，业务处理不阻塞回调')}
      <ol class="process-flow four-steps">
        <li class="${receiverReady ? 'pipeline-ready' : ''}"><span>01</span><div><strong>验签与快速回执</strong><p>Receiver 校验应用身份、时间戳和签名，只保存加密 eventData。</p></div><b>${receiverReady ? 'Receiver 在线' : platform.health?.receiver ? '心跳失效' : '待心跳'}</b></li>
        <li class="${queueHasEvidence(queue) ? 'pipeline-ready' : ''}"><span>02</span><div><strong>Receipt 与队列</strong><p>原始回执、幂等键与队列消息同事务保存并快速返回 2xx。</p></div><b>${queueHasEvidence(queue) ? '运行态可见' : '待证据'}</b></li>
        <li class="${workerReady ? 'pipeline-ready' : ''}"><span>03</span><div><strong>解密与规范化</strong><p>Worker 解密后只写白名单事件；需要详情时生成待补查指令，不直接调用 OpenAPI。</p></div><b>${workerReady ? 'Worker 在线' : platform.health?.worker ? '心跳失效' : '待心跳'}</b></li>
        <li class="${events.length || subscriptions.length ? 'pipeline-ready' : ''}"><span>04</span><div><strong>回读与独立补漏</strong><p>订阅状态必须回读；定时同步器独立补齐事实，事件本身不等于详情已入仓。</p></div><b>${events.length || subscriptions.length ? '证据可见' : '待证据'}</b></li>
      </ol>
    </section>
    <section class="table-section">
      ${panelHeading('QUEUE HEALTH', 'Webhook 队列健康', runtimeHealthy ? 'Receiver / Worker 心跳均在有效期内' : runtimeDegraded ? '至少一个运行进程心跳失效，请检查服务、死信与受阻店铺' : '仅有仓库/队列证据；Receiver / Worker 运行态未知，不补充健康结论')}
      ${webhookQueueView(queue)}
    </section>
    <div class="split-grid">
      <section class="panel">
        ${panelHeading('SUBSCRIPTION READBACK', '订阅回读', subscriptions.length ? `${subscriptions.length} 条真实回读` : '最终以 DL 应用后台可订阅清单为准')}
        ${subscriptions.length
          ? webhookSubscriptionTable(subscriptions)
          : `<ul class="condition-list">${eventGroups.map(([title, detail]) => `<li><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></li>`).join('')}</ul>`}
      </section>
      <section class="panel">
        ${panelHeading('EVENT DIRECTORY', '全托重点事件目录', '目录不是订阅成功证据')}
        <ul class="condition-list">
          ${eventGroups.map(([title, detail]) => `<li><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></li>`).join('')}
        </ul>
      </section>
    </div>
    <section class="table-section event-section">
      ${panelHeading('EVENT TIMELINE', '平台事件时间线', operationScopeNote(events, '平台事件'))}
      ${webhookEventTimeline(events)}
    </section>`;
}

function actionCandidateTable(rows) {
  const normalized = rows.map((candidate) => {
    const meta = CANDIDATE_TYPE_META[candidate.type] || {
      label: candidate.title || '运营复核',
      nextStep: '打开对应业务页核对事实',
      href: '#ops',
      group: 'other',
    };
    return {
      ...candidate,
      group: meta.group,
      title: meta.label,
      impact: candidate.reason,
      objectCode: candidate.entityCode,
      nextStep: meta.nextStep,
      href: meta.href,
    };
  }).sort(comparePriority);
  return priorityWorklistTable(normalized);
}

function renderOps() {
  const actionPool = actionPoolDomain();
  const items = operationPriorityItems();
  const coverage = operationPriorityCoverage(items);
  const high = items.filter((item) => severityMeta(item.severity).rank >= severityMeta('high').rank).length;
  const stores = new Set(items.map(({ storeCode }) => storeCode).filter(Boolean)).size;
  const queueLabel = coverage.incomplete
    ? `已载入 ${numberFormatter.format(items.length)} 条${coverage.totalAtLeast > items.length ? ` · 全量至少 ${numberFormatter.format(coverage.totalAtLeast)} 条` : ''}`
    : items.length ? `${numberFormatter.format(items.length)} 条待复核` : '暂无可证明事项';
  return `
    ${sampleNotice()}
    ${focusEvidencePanel()}
    ${pageIntro(
      'CONTROLLED AUTOMATION',
      '运营待办',
      '把单据异常、缺货、急采、建议备货和同步失败按优先级汇成只读工作队列，直接下钻到事实页。',
      `<span>当前队列</span><strong>${escapeHtml(queueLabel)}</strong><small>${escapeHtml(`${coverage.note} ${actionPool.writeEnabled === false ? '只读工作台 · 无 SHEIN 写入口' : '写能力不可用'}`)}</small>`,
    )}
    ${operationSummaryCards([
      {
        label: '高优先事项',
        value: items.length ? (coverage.incomplete ? `已载入 ${numberFormatter.format(high)}` : numberFormatter.format(high)) : '证据待接入',
        note: coverage.incomplete ? '仅统计当前返回窗口；紧急和高优先事项排在前面' : '紧急和高优先事项排在队列前面',
        tone: high > 0 ? 'blocked' : '',
      },
      {
        label: '涉及店铺',
        value: items.length ? `${numberFormatter.format(stores)} 家` : '证据待接入',
        note: '员工可查看全部店铺，归属仅用于筛选',
      },
      {
        label: '事实来源',
        value: supplyAvailable() ? '供给 / 履约可读' : '部分待接入',
        note: '单据、SKU 风险和系统覆盖分别取证',
      },
      {
        label: '执行边界',
        value: '只读',
        note: '本页没有提交、预演或平台写按钮',
        tone: 'available',
      },
    ])}
    ${renderOperationalPriorities()}
    <section class="focus-strip">
      <div><span>工作方式</span><strong>筛查 → 下钻 → 人工复核</strong></div>
      <p><b>无平台写入口</b>当前队列只组织证据和下一步，不会生成或发送 SHEIN 写请求。</p>
      ${sourceChip()}
    </section>`;
}

function datasetOverview() {
  const permission = state.data?.permission || {};
  const permissionCount = isUnit(permission.authorizedStores) && isUnit(permission.totalStores)
    ? `${numberFormatter.format(permission.authorizedStores)} / ${numberFormatter.format(permission.totalStores)} 家店铺`
    : '店铺范围待确认';
  const healthOk = state.health?.status === 'ok';
  const runtimeLabel = healthOk ? '云端服务响应正常' : '未取得 /health 运行态';
  const runtimeNote = healthOk
    ? `${state.health.service || 'shein-full-managed-bi'} · ${state.health.readOnly === true ? '只读' : '模式待确认'}`
    : (state.healthError || '运行态接口尚未返回');
  const dataTone = datasetStatus() === 'live' ? 'complete' : datasetStatus() === 'sample' ? 'pending' : 'unknown';
  const permissionTone = permission.status === 'granted'
    ? 'complete'
    : permission.status === 'denied'
      ? 'blocked'
      : permission.status || 'unknown';
  const supply = supplyDomain();
  const platform = platformDomain();
  const actionPool = actionPoolDomain();
  const supplyFacts = [
    ...domainRows(supply, 'purchaseOrderStatus'),
    ...domainRows(supply, 'deliveryMilestones'),
    ...domainRows(supply, 'inventory'),
    ...domainRows(supply, 'stockAdvice'),
  ];
  const platformFacts = domainRows(platform, 'events');
  const subscriptionFacts = domainRows(platform, 'subscriptions');
  const actionFacts = domainRows(actionPool, 'candidates');
  const supplyCoverageStates = Object.keys(SUPPLY_COVERAGE_META)
    .map(supplyCoverageDomain)
    .filter(coverageHasEvidence);
  const supplyCoverageBlocked = supplyCoverageStates.some((coverage) => coverage.status === 'blocked');
  const supplyLabel = supplyFacts.length
    ? '供应链事实可读'
    : supplyCoverageStates.length
      ? '同步覆盖证据可读 · 暂无事实行'
      : supply.status === 'available' ? '连接可用 · 覆盖未知' : '供应链待接入';
  const platformLabel = platformAvailable()
    ? (platform.health?.ok === true
      ? 'Webhook Receiver / Worker 在线'
      : platform.health?.ok === false
        ? 'Webhook 运行态需关注'
        : 'Webhook 仓库证据可读 · Runtime 未知')
    : platform.status === 'available' ? '连接可用 · 运行态未知' : 'Webhook 待接入';
  const actionLabel = actionFacts.length
    ? '只读候选池可用'
    : actionPool.mode === 'observe_only' ? '观察模式 · 暂无候选行' : '候选池待接入';
  const cards = [
    ['销量数据集', datasetLabel(), state.data?.updatedAt ? `快照：${formatDateTime(state.data.updatedAt)}` : '暂无有效快照', dataTone],
    ['销量权限', permission.label || '权限待确认', permissionCount, permissionTone],
    ['接口模式', state.data?.readOnly === true ? '只读白名单' : '模式待确认', `schema v${isUnit(state.data?.schemaVersion) ? state.data.schemaVersion : '—'}`, state.data?.readOnly === true ? 'complete' : 'unknown'],
    ['云端运行态', runtimeLabel, runtimeNote, healthOk ? 'complete' : 'unknown'],
    ['供应链只读链路', supplyLabel, supplyFacts.length
      ? `${numberFormatter.format(supplyFacts.length)} 条聚合事实行`
      : supplyCoverageStates.length
        ? `${numberFormatter.format(supplyCoverageStates.length)} 个域有同步证据；空数组不补成业务 0`
        : '空数组不补成业务 0', supplyCoverageBlocked ? 'blocked' : supplyFacts.length ? 'complete' : supplyCoverageStates.length ? 'partial' : supply.status === 'available' ? 'pending' : 'unknown'],
    ['Webhook 链路', platformLabel, platformAvailable()
      ? ([
        platformFacts.length ? `${numberFormatter.format(platformFacts.length)} 条事件` : null,
        subscriptionFacts.length ? `${numberFormatter.format(subscriptionFacts.length)} 条订阅回读` : null,
        queueHasEvidence(platform.queue) ? '队列运行态可见' : null,
      ].filter(Boolean).join(' · ') || '仅健康探针已回读，业务数量未知')
      : '队列、订阅与事件均无证据', platform.health?.ok === false ? 'blocked' : platform.health?.ok === true ? 'complete' : platformAvailable() ? 'partial' : 'unknown'],
    ['自动化运营', actionLabel, actionFacts.length ? `${numberFormatter.format(actionFacts.length)} 条 observe-only 候选` : '所有写按钮持续禁用', actionFacts.length ? 'pending' : 'unknown'],
    ['写动作总闸', actionPool.writeEnabled === true ? '配置异常：写开关开启' : '关闭', actionPool.writeEnabled === true ? '首版要求 writeEnabled=false，请立即检查' : '前端无可用提交入口', actionPool.writeEnabled === true ? 'blocked' : 'complete'],
  ];
  return `
    <div class="system-overview">
      ${cards.map(([label, value, note, status]) => `
        <article class="system-card ${readinessClass(status)}">
          <span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(note)}</p>
        </article>`).join('')}
    </div>`;
}

function readinessTable() {
  return `
    <div class="table-wrap">
      <table class="data-table readiness-table">
        <thead><tr><th scope="col">阶段</th><th scope="col">运行态</th><th scope="col">证据范围</th><th scope="col">说明</th></tr></thead>
        <tbody>${readinessStages().map((stage) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(stage.label)}</strong><span>${escapeHtml(stage.key)}</span></td>
            <td><span class="row-status ${readinessClass(stage.status)}">${escapeHtml(stage.statusLabel || '待确认')}</span></td>
            <td>${escapeHtml(readinessCount(stage))}</td>
            <td class="boundary-cell">${escapeHtml(stage.note || '暂无运行证据')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function supplyCoverageTable() {
  const rows = Object.entries(SUPPLY_COVERAGE_META).map(([key, label]) => {
    const coverage = supplyCoverageDomain(key) || {};
    const succeeded = isUnit(coverage.succeededStores)
      ? numberFormatter.format(coverage.succeededStores)
      : '—';
    const total = isUnit(coverage.totalStores)
      ? numberFormatter.format(coverage.totalStores)
      : '—';
    const failed = isUnit(coverage.failedStores)
      ? numberFormatter.format(coverage.failedStores)
      : '—';
    const missing = Array.isArray(coverage.missingStoreCodes)
      ? coverage.missingStoreCodes.length
      : coverage.missingStores;
    const stale = isUnit(coverage.staleStores)
      ? numberFormatter.format(coverage.staleStores)
      : '—';
    const inProgress = isUnit(coverage.inProgressStores)
      ? numberFormatter.format(coverage.inProgressStores)
      : '—';
    const windowLabel = coverage.watermarkStart || coverage.watermarkEnd
      ? `${coverage.watermarkStart ? sourceTime(coverage.watermarkStart) : '起点未知'} → ${coverage.watermarkEnd ? sourceTime(coverage.watermarkEnd) : '终点未知'}`
      : '业务窗口未知';
    return {
      key,
      label,
      coverage,
      succeeded,
      total,
      failed,
      missing: isUnit(missing) ? numberFormatter.format(missing) : '—',
      stale,
      inProgress,
      windowLabel,
    };
  });
  return `
    <div class="table-wrap">
      <table class="data-table supply-coverage-table">
        <thead><tr><th scope="col">只读域</th><th scope="col">最新状态</th><th scope="col">成功覆盖</th><th scope="col">失败 / 缺失 / 过期 / 同步中</th><th scope="col">模式与业务窗口</th><th scope="col">证据与下一步</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.key)}</span></td>
            <td><span class="row-status ${readinessClass(row.coverage.status)}">${escapeHtml(row.coverage.status || 'unknown')}</span></td>
            <td>${escapeHtml(`${row.succeeded} / ${row.total} 家`)}</td>
            <td>${escapeHtml(`${row.failed} / ${row.missing} / ${row.stale} / ${row.inProgress}`)}</td>
            <td class="boundary-cell"><strong>${escapeHtml(row.coverage.mode || '模式未知')}</strong><span>${escapeHtml(row.windowLabel)}</span><small>${escapeHtml(isUnit(row.coverage.freshnessMaxAgeSeconds) ? `时效门槛 ${Math.round(row.coverage.freshnessMaxAgeSeconds / 3600)} 小时` : '时效门槛未知')}</small></td>
            <td class="boundary-cell"><strong>${escapeHtml(row.coverage.latestFetchedAt ? sourceTime(row.coverage.latestFetchedAt) : '尚无最新成功/失败尝试时间')}</strong><span>${escapeHtml(row.coverage.reason || '同步尝试、时效与覆盖证据待接入')}</span></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">这里展示最新同步尝试、覆盖和时效证据；历史成功不能掩盖当前失败，完整空结果也不会被解释成业务数量为 0。</p>`;
}

function renderSystem() {
  const supply = supplyDomain();
  const platform = platformDomain();
  const actionPool = actionPoolDomain();
  const procurementState = domainConnectionState(
    supply,
    ['purchaseOrderAttention', 'purchaseOrderStatus'],
    ['purchaseOrders'],
  );
  const fulfilmentState = domainConnectionState(
    supply,
    ['deliveryAttention', 'deliveryMilestones'],
    ['deliveries'],
  );
  const inventoryState = domainConnectionState(
    supply,
    ['inventoryRisks', 'stockAdviceRisks', 'inventory', 'stockAdvice'],
    ['inventory', 'stockAdvice'],
  );
  const procurementConnected = procurementState === 'available';
  const fulfilmentConnected = fulfilmentState === 'available';
  const inventoryConnected = inventoryState === 'available';
  const webhookConnected = platformAvailable();
  const candidateConnected = domainRows(actionPool, 'candidates').length > 0;
  return `
    ${sampleNotice()}
    ${pageIntro(
      'SYSTEM HEALTH',
      '系统健康',
      '把数据集、权限、接口探针、事实入仓和云端运行态分开判断。',
      `<span>API schema</span><strong>v${isUnit(state.data?.schemaVersion) ? state.data.schemaVersion : '—'}</strong><small>/api/dashboard · GET only</small>`,
    )}
    ${datasetOverview()}
    <section class="table-section">
      ${panelHeading('READINESS LEDGER', '五阶段接入台账', '数量未知时显示“证据待接入”，不补零')}
      ${readinessTable()}
    </section>
    <section class="table-section">
      ${panelHeading('SUPPLY COVERAGE', '供应链同步覆盖水位', '按店铺 × 域读取最新尝试；失败、缺失、时效和业务窗口分开展示')}
      ${supplyCoverageTable()}
    </section>
    <section class="capability-section">
      ${panelHeading('DATA CAPABILITIES', '数据与动作能力', '以当前页面实际消费的字段为准')}
      <div class="capability-grid">
        <article class="available"><span>销量数量</span><strong>可读取</strong><p>总量、店铺排行、SKU 排行；可选日趋势。</p></article>
        <article class="partial"><span>商品身份</span><strong>部分可见</strong><p>SKU 销量清单可读，完整商品主数据待探针。</p></article>
        <article class="${procurementConnected ? 'available' : 'pending'}"><span>采购单</span><strong>${procurementConnected ? '状态事实可读' : '未接入'}</strong><p>${procurementConnected ? '按店铺和平台状态显示真实采购单数。' : '没有事实行时不显示采购单数为 0。'}</p></article>
        <article class="${fulfilmentConnected ? 'available' : 'pending'}"><span>交付与入仓</span><strong>${fulfilmentConnected ? '里程碑可读' : '未接入'}</strong><p>${fulfilmentConnected ? '交付单数、数量和覆盖率分开显示。' : '没有事实行时不推导履约率或异常数。'}</p></article>
        <article class="${inventoryConnected ? 'available' : 'pending'}"><span>库存与供给</span><strong>${inventoryConnected ? '只读快照可见' : '未接入'}</strong><p>${inventoryConnected ? '库存、在途、缺货和备货建议保留未知值。' : '没有快照时不显示库存或建议为 0。'}</p></article>
        <article class="${webhookConnected ? (platform.health?.ok === false ? 'locked' : platform.health?.ok === true ? 'available' : 'partial') : 'pending'}"><span>平台动态</span><strong>${webhookConnected ? (platform.health?.ok === false ? '已接入 · 需关注' : platform.health?.ok === true ? 'Receiver / Worker 在线' : '仓库可读 · Runtime 未知') : '未接入'}</strong><p>${webhookConnected ? '队列、订阅回读、进程心跳和事件时间线分开取证。' : '没有运行态时不显示事件数或队列数为 0。'}</p></article>
        <article class="${candidateConnected ? 'partial' : 'pending'}"><span>运营候选池</span><strong>${candidateConnected ? '观察模式可用' : '未接入'}</strong><p>${candidateConnected ? '候选可筛选，所有执行入口仍禁用。' : '没有候选快照时不展示伪 0。'}</p></article>
        <article class="pending"><span>财务事实</span><strong>未接入</strong><p>没有金额、订单、结算、成本或利润字段。</p></article>
        <article class="${actionPool.writeEnabled === true ? 'locked' : 'available'}"><span>自动化写动作</span><strong>${actionPool.writeEnabled === true ? '配置异常' : '关闭'}</strong><p>${actionPool.writeEnabled === true ? '服务端写开关不符合首版安全要求。' : '所有已登录员工可读全店数据；任何写操作仍保持关闭。'}</p></article>
      </div>
    </section>`;
}

function renderRoute() {
  const renderers = {
    home: renderHome,
    procurement: renderProcurement,
    fulfilment: renderFulfilment,
    products: renderProducts,
    sales: renderSales,
    inventory: renderInventory,
    returns: renderReturns,
    compliance: renderCompliance,
    finance: renderFinance,
    platform: renderPlatform,
    ops: renderOps,
    system: renderSystem,
  };
  return renderers[state.route]();
}

function renderLoading() {
  return `
    <section class="loading-shell" role="status">
      <span class="loading-line wide"></span>
      <span class="loading-line"></span>
      <div class="loading-grid"><span></span><span></span><span></span><span></span></div>
      <p>正在读取全托销量与接入状态…</p>
    </section>`;
}

function renderUnavailable() {
  return `
    <section class="page-intro unavailable-page">
      <div><span class="eyebrow">DATA UNAVAILABLE</span><h1>暂时无法读取运营数据</h1><p>错误已显示在首屏。修复云端数据服务后重新加载，不会使用旧快照或占位数冒充结果。</p></div>
    </section>`;
}

function updateNavigation() {
  elements.navLinks.forEach((link) => {
    const active = link.dataset.route === state.route;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  const route = ROUTES[state.route];
  elements.mobilePageTitle.textContent = route.title;
  document.title = `${route.title} · SHEIN 全托运营工作台`;
}

function updateFilters() {
  elements.search.value = state.query;
  elements.scope.value = state.store !== 'ALL'
    ? `STORE:${state.store}`
    : state.owner !== 'ALL'
      ? `OWNER:${state.owner}`
      : 'ALL';
  elements.rangeButtons.forEach((button) => {
    const active = button.dataset.range === state.range;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (elements.rangeSummary) {
    elements.rangeSummary.textContent = `${RANGE_META[state.range].label} · ${RANGE_META[state.range].note}`;
  }
  const hasFilters = Boolean(state.query.trim())
    || state.owner !== 'ALL'
    || state.store !== 'ALL'
    || state.range !== 'today';
  elements.clearFilters.disabled = !hasFilters;
}

function updateDatasetChrome() {
  if (!state.data) {
    elements.datasetBadge.textContent = state.loading ? '正在读取' : '数据不可用';
    elements.datasetBadge.className = `status-badge ${state.loading ? 'neutral' : 'error'}`;
    elements.updatedAt.textContent = state.loading ? '更新时间：--' : '更新时间：读取失败';
    elements.sidebarDataset.textContent = state.loading ? '正在读取' : '数据不可用';
    elements.sidebarPermission.textContent = '销量权限待确认';
    elements.sidebarSampleNote.hidden = true;
    delete document.body.dataset.dataset;
    return;
  }

  const status = datasetStatus();
  elements.datasetBadge.textContent = datasetLabel();
  elements.datasetBadge.className = `status-badge ${status}`;
  elements.updatedAt.textContent = `更新时间：${formatDateTime(state.data.updatedAt)}`;
  elements.sidebarDataset.textContent = datasetLabel();
  elements.sidebarPermission.textContent = state.data.permission?.label || '销量权限待确认';
  elements.sidebarSampleNote.hidden = status !== 'sample';
  document.body.dataset.dataset = status;
}

function updateErrorPanel() {
  elements.errorPanel.hidden = !state.error;
  elements.errorMessage.textContent = state.error || '';
  elements.retryButton.disabled = state.loading;
  elements.retryButton.textContent = state.loading ? '重新加载中…' : '重新加载';
}

function populateScopeOptions() {
  const previousStore = state.store;
  const previousOwner = state.owner;
  const fragment = document.createDocumentFragment();
  const allOption = document.createElement('option');
  allOption.value = 'ALL';
  allOption.textContent = '全部店铺';
  fragment.append(allOption);

  const owners = allOwners();
  if (owners.length) {
    const ownerGroup = document.createElement('optgroup');
    ownerGroup.label = '负责人分组';
    owners.forEach((owner) => {
      const option = document.createElement('option');
      option.value = `OWNER:${owner.key}`;
      option.textContent = `${owner.name} · ${owner.storeCodes.length} 家店`;
      ownerGroup.append(option);
    });
    fragment.append(ownerGroup);
  }

  const storeGroup = document.createElement('optgroup');
  storeGroup.label = '单个店铺（含负责人）';
  baseStores().forEach((store) => {
    const option = document.createElement('option');
    option.value = `STORE:${store.code}`;
    const ownerName = ownerNameForStore(store);
    option.textContent = [
      store.name && store.name !== store.code ? `${store.code} · ${store.name}` : store.code,
      ownerName,
    ].filter(Boolean).join(' · ');
    storeGroup.append(option);
  });
  fragment.append(storeGroup);

  state.store = baseStores().some((store) => store.code === previousStore) ? previousStore : 'ALL';
  state.owner = state.store === 'ALL' && owners.some((owner) => owner.key === previousOwner)
    ? previousOwner
    : 'ALL';
  elements.scope.replaceChildren(fragment);
  updateFilters();
}

function render() {
  updateNavigation();
  updateFilters();
  updateDatasetChrome();
  updateErrorPanel();

  if (state.loading && !state.data) {
    elements.view.innerHTML = renderLoading();
    elements.view.setAttribute('aria-busy', 'true');
    return;
  }
  elements.view.setAttribute('aria-busy', 'false');
  elements.view.innerHTML = state.data ? renderRoute() : renderUnavailable();
}

async function fetchJson(path) {
  const response = await fetch(path, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) {
    let message = '';
    try {
      const payload = await response.json();
      message = payload?.error?.message || '';
    } catch {
      message = '';
    }
    throw new Error(message || `云端数据服务返回 HTTP ${response.status}`);
  }
  return response.json();
}

async function loadDashboard() {
  state.loading = true;
  state.error = '';
  state.healthError = '';
  render();

  const healthPromise = fetchJson('/health')
    .then((health) => ({ ok: true, health }))
    .catch((error) => ({ ok: false, error }));

  try {
    const dashboard = await fetchJson('/api/dashboard');
    if (!dashboard || typeof dashboard !== 'object' || !dashboard.dataset) {
      throw new Error('销量数据结构无效');
    }
    state.data = dashboard;
    populateScopeOptions();
  } catch (error) {
    state.data = null;
    state.error = error instanceof Error ? error.message : '云端只读数据服务暂不可用。';
  }

  const healthResult = await healthPromise;
  if (healthResult.ok) state.health = healthResult.health;
  else {
    state.health = null;
    state.healthError = healthResult.error instanceof Error
      ? healthResult.error.message
      : '运行态接口不可用';
  }

  state.loading = false;
  render();
}

/** Current investigation state in canonical-link shape. */
function currentHashState() {
  return {
    route: state.route,
    owner: state.owner,
    store: state.store,
    range: state.range,
    query: state.query,
    quick: quickFilterValue(state.route),
    focus: state.focus,
  };
}

/**
 * Mirror state into the address bar without navigating.
 *
 * `replaceState` keeps the investigation bookmarkable and shareable while
 * avoiding a hashchange loop, so no reload or re-render cascade occurs.
 */
function syncUrlFromState() {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const next = serializeHashState(currentHashState());
  if (window.location.hash !== next) {
    window.history.replaceState(null, '', next);
  }
}

function applyHashState(parsed) {
  state.route = parsed.route;
  state.owner = parsed.owner;
  state.store = parsed.store;
  state.range = parsed.range;
  state.query = parsed.query;
  state.focus = parsed.focus;
  if (parsed.quick === 'ALL') delete state.quickFilters[parsed.route];
  else state.quickFilters[parsed.route] = parsed.quick;
}

function syncRouteFromLocation() {
  const parsed = parseHashState(window.location.hash, currentHashState());
  const routeChanged = state.route !== parsed.route;
  applyHashState(parsed);
  syncUrlFromState();
  render();
  if (routeChanged && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

elements.search.addEventListener('input', (event) => {
  state.query = event.currentTarget.value;
  syncUrlFromState();
  render();
});

elements.scope.addEventListener('change', (event) => {
  const value = String(event.currentTarget.value || 'ALL');
  state.owner = value.startsWith('OWNER:') ? value.slice(6) : 'ALL';
  state.store = value.startsWith('STORE:') ? value.slice(6) : 'ALL';
  syncUrlFromState();
  render();
});

elements.rangeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (!Object.prototype.hasOwnProperty.call(RANGE_META, button.dataset.range)) return;
    state.range = button.dataset.range;
    syncUrlFromState();
    render();
  });
});

elements.view.addEventListener('click', (event) => {
  const clearFocus = event.target.closest?.('[data-clear-focus]');
  if (clearFocus && elements.view.contains(clearFocus)) {
    // Clearing a focus keeps the broader store/range investigation intact.
    event.preventDefault();
    const nextQuery = queryAfterClearingFocus();
    state.focus = null;
    state.query = nextQuery;
    syncUrlFromState();
    render();
    return;
  }
  const button = event.target.closest?.('[data-quick-route][data-quick-value]');
  if (!button || !elements.view.contains(button)) return;
  const route = String(button.dataset.quickRoute || '');
  const value = String(button.dataset.quickValue || 'ALL');
  if (!Object.prototype.hasOwnProperty.call(ROUTES, route)) return;
  state.quickFilters[route] = value;
  syncUrlFromState();
  render();
});

elements.clearFilters.addEventListener('click', () => {
  state.query = '';
  state.owner = 'ALL';
  state.store = 'ALL';
  state.range = 'today';
  state.quickFilters = Object.create(null);
  state.focus = null;
  populateScopeOptions();
  syncUrlFromState();
  render();
  elements.search.focus();
});

elements.retryButton.addEventListener('click', loadDashboard);
elements.logoutButton.addEventListener('click', async () => {
  elements.logoutButton.disabled = true;
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
  } finally {
    window.location.assign('/login');
  }
});
function chartTooltipElement() {
  return document.querySelector('#chart-tooltip');
}

function hideChartTooltip() {
  const tooltip = chartTooltipElement();
  if (tooltip) tooltip.hidden = true;
}

function showChartTooltip(clientX, clientY, target) {
  const tooltip = chartTooltipElement();
  const text = target?.getAttribute('data-tip') || '';
  if (!tooltip || !text) {
    hideChartTooltip();
    return;
  }
  tooltip.textContent = text;
  tooltip.hidden = false;
  const margin = 14;
  const box = tooltip.getBoundingClientRect();
  const left = clientX + margin + box.width > window.innerWidth
    ? Math.max(8, clientX - margin - box.width)
    : clientX + margin;
  const top = clientY + margin + box.height > window.innerHeight
    ? Math.max(8, clientY - margin - box.height)
    : clientY + margin;
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

document.addEventListener('pointermove', (event) => {
  const target = event.target?.closest?.('[data-tip]');
  if (target) showChartTooltip(event.clientX, event.clientY, target);
  else hideChartTooltip();
});

document.addEventListener('focusin', (event) => {
  const target = event.target?.closest?.('[data-tip]');
  if (!target) {
    hideChartTooltip();
    return;
  }
  const box = target.getBoundingClientRect?.();
  showChartTooltip(
    box ? box.left + (box.width / 2) : 24,
    box ? box.top + (box.height / 2) : 24,
    target,
  );
});

document.addEventListener('focusout', hideChartTooltip);
document.addEventListener('scroll', hideChartTooltip, true);
window.addEventListener('hashchange', syncRouteFromLocation);

// Normalize whatever arrived in the address bar into the canonical form once, so
// a hand-edited or stale link becomes shareable without a reload.
syncUrlFromState();
render();
loadDashboard();
