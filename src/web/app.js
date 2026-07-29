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
const URL_SALES_SORTS = Object.freeze([
  'LAST30_DESC',
  'LAST7_DESC',
  'TODAY_DESC',
  'MOMENTUM_DESC',
  'MOMENTUM_ASC',
]);

/** Focus domains map one alert or row to the surface that can prove it. */
const FOCUS_DOMAINS = Object.freeze({
  inventory: { route: 'inventory', label: '库存风险' },
  advice: { route: 'inventory', label: '备货建议' },
  procurement: { route: 'procurement', label: '采购单' },
  fulfilment: { route: 'fulfilment', label: '交付单' },
  product: { route: 'products', label: '商品身份' },
  ops: { route: 'ops', label: '运营提醒' },
});

/* Every route-specific quick value must appear here. A value missing from this
   allow-list is silently dropped by `serializeHashState` and then reloaded as
   `ALL` by `parseHashState`, so the shared link would lose the filter. */
const QUICK_FILTER_VALUES = Object.freeze([
  'ALL', 'HIGH', 'SHORTAGE', 'RECONCILIATION', 'URGENT', 'ADVICE', 'WARNING', 'SYNC',
  'PENDING_DELIVERY', 'PENDING_RECEIPT', 'PENDING_STORAGE', 'OVERDUE',
  // Procurement attention semantics.
  'DEFECTIVE',
  // Fulfilment milestone semantics.
  'CREATED', 'PICKUP_RESERVED', 'IN_TRANSIT',
  'GROWING', 'DECLINING', 'UNCOMPARABLE', 'CANONICAL', 'UNMAPPED',
  'WITH_SALES', 'MISSING_SPU',
]);

/* Inventory workspace state. Every token is allow-listed here and re-checked
   before it reaches `/api/inventory`, so a shared link can never widen the
   server contract. */
const URL_INVENTORY_VIEWS = Object.freeze(['INVENTORY', 'ADVICE']);
const URL_INVENTORY_TYPES = Object.freeze(['ALL', 'PI', 'JI', 'VI']);
const URL_INVENTORY_SORTS = Object.freeze([
  'PRIORITY',
  'SHORTAGE_DESC',
  'USABLE_ASC',
  'FRESHNESS_DESC',
]);
const URL_ADVICE_SORTS = Object.freeze([
  'PRIORITY',
  'URGENT_DESC',
  'ADVICE_DESC',
  'DAILY_SALES_DESC',
  'FRESHNESS_DESC',
]);
const URL_INVENTORY_PAGE_SIZES = Object.freeze([25, 50, 100]);
const URL_DEFAULT_INVENTORY_PAGE_SIZE = 25;

/* Product identity workspace state. Values are allow-listed here and checked
   again before reaching `/api/products`, so a shared link can never widen the
   server contract. */
const URL_PRODUCT_VIEWS = Object.freeze(['PENDING', 'CANONICAL']);
const URL_PRODUCT_SORTS = Object.freeze([
  'IMPACT_DESC',
  'LAST30_DESC',
  'LAST7_DESC',
  'TODAY_DESC',
  'STORE_ASC',
]);

/* Procurement and fulfilment workspace state. Each token is allow-listed here
   and re-checked before it reaches `/api/procurement` or `/api/fulfilment`, so
   a shared link can never widen the server contract. */
const URL_PROCUREMENT_SORTS = Object.freeze([
  'PRIORITY',
  'LATEST',
  'DELIVERY_DEADLINE',
]);
const URL_FULFILMENT_SORTS = Object.freeze([
  'PRIORITY',
  'LATEST',
  'EXPECTED_RECEIPT',
]);
/** Mirrors the `MILESTONE_PATTERN`/`STATUS_PATTERN` guards on the server. */
const URL_OPERATION_CODE_PATTERN = /^[\p{L}\p{N}._:-]{1,80}$/u;

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

/** Unknown tokens fall back to the default instead of reaching the server. */
function allowListedToken(value, allowed, fallback) {
  const token = urlSafeText(value, 32).toUpperCase();
  return allowed.includes(token) ? token : fallback;
}

/** Page size is a closed set, so an arbitrary number can never be requested. */
function pageSizeParam(value) {
  const token = urlSafeText(value, 8);
  const parsed = /^[1-9][0-9]{0,2}$/.test(token) ? Number(token) : 0;
  return URL_INVENTORY_PAGE_SIZES.includes(parsed)
    ? parsed
    : URL_DEFAULT_INVENTORY_PAGE_SIZE;
}

/**
 * A platform status or milestone code is an open vocabulary, so it cannot be
 * allow-listed by value. It is instead bounded by the same pattern the server
 * enforces; anything else degrades to `ALL` rather than reaching the endpoint.
 */
function operationCodeParam(value) {
  // Validate the raw trimmed token, never a sanitized one. Running this through
  // the generic text sanitizer first would strip angle brackets and hand
  // back `SCRIPT`, silently turning hostile input into a different but valid
  // platform code. The pattern already bounds length and rejects controls,
  // markup and whitespace, so anything failing it degrades to `ALL`.
  const raw = String(value ?? '').trim();
  if (raw === '') return 'ALL';
  if (!URL_OPERATION_CODE_PATTERN.test(raw)) return 'ALL';
  return raw.toUpperCase();
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
      salesSort: inherited.salesSort || 'LAST30_DESC',
      productPage: Number.isSafeInteger(inherited.productPage) ? inherited.productPage : 1,
      standardPage: Number.isSafeInteger(inherited.standardPage) ? inherited.standardPage : 1,
      inventoryView: URL_INVENTORY_VIEWS.includes(inherited.inventoryView)
        ? inherited.inventoryView
        : 'INVENTORY',
      inventoryType: URL_INVENTORY_TYPES.includes(inherited.inventoryType)
        ? inherited.inventoryType
        : 'ALL',
      inventorySort: URL_INVENTORY_SORTS.includes(inherited.inventorySort)
        ? inherited.inventorySort
        : 'PRIORITY',
      adviceSort: URL_ADVICE_SORTS.includes(inherited.adviceSort)
        ? inherited.adviceSort
        : 'PRIORITY',
      // A bare nav hash restarts paging; an inherited page number would point
      // at a page that the new scope may not have.
      inventoryPage: 1,
      advicePage: 1,
      inventoryPageSize: URL_INVENTORY_PAGE_SIZES.includes(inherited.inventoryPageSize)
        ? inherited.inventoryPageSize
        : URL_DEFAULT_INVENTORY_PAGE_SIZE,
      productView: URL_PRODUCT_VIEWS.includes(inherited.productView)
        ? inherited.productView
        : 'PENDING',
      productSort: URL_PRODUCT_SORTS.includes(inherited.productSort)
        ? inherited.productSort
        : 'IMPACT_DESC',
      productPendingPage: 1,
      productCanonicalPage: 1,
      productPageSize: URL_INVENTORY_PAGE_SIZES.includes(inherited.productPageSize)
        ? inherited.productPageSize
        : URL_DEFAULT_INVENTORY_PAGE_SIZE,
      procurementStatus: URL_OPERATION_CODE_PATTERN.test(String(inherited.procurementStatus ?? ''))
        ? inherited.procurementStatus
        : 'ALL',
      procurementSort: URL_PROCUREMENT_SORTS.includes(inherited.procurementSort)
        ? inherited.procurementSort
        : 'PRIORITY',
      // A bare nav hash restarts paging; an inherited page could point past the
      // end of the new scope.
      procurementPage: 1,
      procurementPageSize: URL_INVENTORY_PAGE_SIZES.includes(inherited.procurementPageSize)
        ? inherited.procurementPageSize
        : URL_DEFAULT_INVENTORY_PAGE_SIZE,
      fulfilmentMilestone: URL_OPERATION_CODE_PATTERN.test(
        String(inherited.fulfilmentMilestone ?? ''),
      ) ? inherited.fulfilmentMilestone : 'ALL',
      fulfilmentSort: URL_FULFILMENT_SORTS.includes(inherited.fulfilmentSort)
        ? inherited.fulfilmentSort
        : 'PRIORITY',
      fulfilmentPage: 1,
      fulfilmentPageSize: URL_INVENTORY_PAGE_SIZES.includes(inherited.fulfilmentPageSize)
        ? inherited.fulfilmentPageSize
        : URL_DEFAULT_INVENTORY_PAGE_SIZE,
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
  const salesSortToken = urlSafeText(params.get('sort'), 32).toUpperCase();
  const pageParam = (name) => {
    const value = params.get(name);
    return /^[1-9][0-9]{0,3}$/.test(String(value ?? '')) ? Number(value) : 1;
  };
  /* `size` and `view` are shared parameter names across workspaces, and
     `serializeHashState` only ever writes them for the active route. Parsing
     them unconditionally let a `#procurement?size=50` link contaminate the
     inherited fulfilment page size, which then survived a later bare
     `#fulfilment` navigation. Each shared parameter now binds to its own route
     and every other route keeps its inherited or default value. */
  const routePageSize = (routeKey, inheritedValue) => {
    if (route === routeKey) return pageSizeParam(params.get('size'));
    return URL_INVENTORY_PAGE_SIZES.includes(inheritedValue)
      ? inheritedValue
      : URL_DEFAULT_INVENTORY_PAGE_SIZE;
  };
  const routeView = (routeKey, allowed, fallback, inheritedValue) => {
    if (route === routeKey) return allowListedToken(params.get('view'), allowed, fallback);
    return allowed.includes(inheritedValue) ? inheritedValue : fallback;
  };
  return {
    route,
    owner: scope.owner,
    store: scope.store,
    range: URL_RANGE_KEYS.includes(rangeToken) ? rangeToken : URL_DEFAULT_RANGE,
    query: urlSafeText(params.get('q'), URL_QUERY_MAX),
    quick: QUICK_FILTER_VALUES.includes(quickToken) ? quickToken : 'ALL',
    salesSort: URL_SALES_SORTS.includes(salesSortToken)
      ? salesSortToken
      : 'LAST30_DESC',
    productPage: pageParam('page'),
    standardPage: pageParam('standardPage'),
    inventoryView: routeView(
      'inventory',
      URL_INVENTORY_VIEWS,
      'INVENTORY',
      inherited.inventoryView,
    ),
    inventoryType: allowListedToken(
      params.get('invType'),
      URL_INVENTORY_TYPES,
      'ALL',
    ),
    inventorySort: allowListedToken(
      params.get('invSort'),
      URL_INVENTORY_SORTS,
      'PRIORITY',
    ),
    adviceSort: allowListedToken(
      params.get('adviceSort'),
      URL_ADVICE_SORTS,
      'PRIORITY',
    ),
    inventoryPage: pageParam('invPage'),
    advicePage: pageParam('advicePage'),
    inventoryPageSize: routePageSize('inventory', inherited.inventoryPageSize),
    productView: routeView('products', URL_PRODUCT_VIEWS, 'PENDING', inherited.productView),
    productSort: allowListedToken(params.get('prodSort'), URL_PRODUCT_SORTS, 'IMPACT_DESC'),
    productPendingPage: pageParam('pendingPage'),
    productCanonicalPage: pageParam('canonicalPage'),
    productPageSize: routePageSize('products', inherited.productPageSize),
    procurementStatus: operationCodeParam(params.get('status')),
    procurementSort: allowListedToken(
      params.get('poSort'),
      URL_PROCUREMENT_SORTS,
      'PRIORITY',
    ),
    procurementPage: pageParam('poPage'),
    procurementPageSize: routePageSize('procurement', inherited.procurementPageSize),
    fulfilmentMilestone: operationCodeParam(params.get('milestone')),
    fulfilmentSort: allowListedToken(
      params.get('dnSort'),
      URL_FULFILMENT_SORTS,
      'PRIORITY',
    ),
    fulfilmentPage: pageParam('dnPage'),
    fulfilmentPageSize: routePageSize('fulfilment', inherited.fulfilmentPageSize),
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
  if (route === 'sales') {
    const salesSort = urlSafeText(input.salesSort, 32).toUpperCase();
    if (URL_SALES_SORTS.includes(salesSort) && salesSort !== 'LAST30_DESC') {
      params.set('sort', salesSort);
    }
    if (Number.isSafeInteger(input.productPage) && input.productPage > 1) {
      params.set('page', String(Math.min(input.productPage, 9999)));
    }
    if (Number.isSafeInteger(input.standardPage) && input.standardPage > 1) {
      params.set('standardPage', String(Math.min(input.standardPage, 9999)));
    }
  }
  if (route === 'inventory') {
    const view = allowListedToken(input.inventoryView, URL_INVENTORY_VIEWS, 'INVENTORY');
    if (view !== 'INVENTORY') params.set('view', view);
    const inventoryType = allowListedToken(input.inventoryType, URL_INVENTORY_TYPES, 'ALL');
    if (inventoryType !== 'ALL') params.set('invType', inventoryType);
    const inventorySort = allowListedToken(
      input.inventorySort,
      URL_INVENTORY_SORTS,
      'PRIORITY',
    );
    if (inventorySort !== 'PRIORITY') params.set('invSort', inventorySort);
    const adviceSort = allowListedToken(input.adviceSort, URL_ADVICE_SORTS, 'PRIORITY');
    if (adviceSort !== 'PRIORITY') params.set('adviceSort', adviceSort);
    if (Number.isSafeInteger(input.inventoryPage) && input.inventoryPage > 1) {
      params.set('invPage', String(Math.min(input.inventoryPage, 9999)));
    }
    if (Number.isSafeInteger(input.advicePage) && input.advicePage > 1) {
      params.set('advicePage', String(Math.min(input.advicePage, 9999)));
    }
    const pageSize = pageSizeParam(input.inventoryPageSize);
    if (pageSize !== URL_DEFAULT_INVENTORY_PAGE_SIZE) params.set('size', String(pageSize));
  }
  if (route === 'products') {
    const view = allowListedToken(input.productView, URL_PRODUCT_VIEWS, 'PENDING');
    if (view !== 'PENDING') params.set('view', view);
    const productSort = allowListedToken(input.productSort, URL_PRODUCT_SORTS, 'IMPACT_DESC');
    if (productSort !== 'IMPACT_DESC') params.set('prodSort', productSort);
    if (Number.isSafeInteger(input.productPendingPage) && input.productPendingPage > 1) {
      params.set('pendingPage', String(Math.min(input.productPendingPage, 9999)));
    }
    if (Number.isSafeInteger(input.productCanonicalPage) && input.productCanonicalPage > 1) {
      params.set('canonicalPage', String(Math.min(input.productCanonicalPage, 9999)));
    }
    const productPageSize = pageSizeParam(input.productPageSize);
    if (productPageSize !== URL_DEFAULT_INVENTORY_PAGE_SIZE) {
      params.set('size', String(productPageSize));
    }
  }
  if (route === 'procurement') {
    const status = operationCodeParam(input.procurementStatus);
    if (status !== 'ALL') params.set('status', status);
    const poSort = allowListedToken(input.procurementSort, URL_PROCUREMENT_SORTS, 'PRIORITY');
    if (poSort !== 'PRIORITY') params.set('poSort', poSort);
    if (Number.isSafeInteger(input.procurementPage) && input.procurementPage > 1) {
      params.set('poPage', String(Math.min(input.procurementPage, 9999)));
    }
    const poPageSize = pageSizeParam(input.procurementPageSize);
    if (poPageSize !== URL_DEFAULT_INVENTORY_PAGE_SIZE) params.set('size', String(poPageSize));
  }
  if (route === 'fulfilment') {
    const milestone = operationCodeParam(input.fulfilmentMilestone);
    if (milestone !== 'ALL') params.set('milestone', milestone);
    const dnSort = allowListedToken(input.fulfilmentSort, URL_FULFILMENT_SORTS, 'PRIORITY');
    if (dnSort !== 'PRIORITY') params.set('dnSort', dnSort);
    if (Number.isSafeInteger(input.fulfilmentPage) && input.fulfilmentPage > 1) {
      params.set('dnPage', String(Math.min(input.fulfilmentPage, 9999)));
    }
    const dnPageSize = pageSizeParam(input.fulfilmentPageSize);
    if (dnPageSize !== URL_DEFAULT_INVENTORY_PAGE_SIZE) params.set('size', String(dnPageSize));
  }
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
  homeDateStart: null,
  homeDateEnd: null,
  homeDateCustom: false,
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
  procurement: {
    data: null,
    loading: false,
    error: '',
    requestSerial: 0,
    status: initialHashState.procurementStatus || 'ALL',
    sort: initialHashState.procurementSort || 'PRIORITY',
    page: initialHashState.procurementPage || 1,
    pageSize: initialHashState.procurementPageSize || URL_DEFAULT_INVENTORY_PAGE_SIZE,
  },
  fulfilment: {
    data: null,
    loading: false,
    error: '',
    requestSerial: 0,
    milestone: initialHashState.fulfilmentMilestone || 'ALL',
    sort: initialHashState.fulfilmentSort || 'PRIORITY',
    page: initialHashState.fulfilmentPage || 1,
    pageSize: initialHashState.fulfilmentPageSize || URL_DEFAULT_INVENTORY_PAGE_SIZE,
  },
  sales: {
    data: null,
    loading: false,
    error: '',
    requestSerial: 0,
    productPage: initialHashState.productPage || 1,
    standardPage: initialHashState.standardPage || 1,
    pageSize: 50,
    sort: initialHashState.salesSort || 'LAST30_DESC',
  },
  inventory: {
    data: null,
    loading: false,
    error: '',
    requestSerial: 0,
    view: initialHashState.inventoryView || 'INVENTORY',
    inventoryType: initialHashState.inventoryType || 'ALL',
    inventorySort: initialHashState.inventorySort || 'PRIORITY',
    adviceSort: initialHashState.adviceSort || 'PRIORITY',
    inventoryPage: initialHashState.inventoryPage || 1,
    advicePage: initialHashState.advicePage || 1,
    pageSize: initialHashState.inventoryPageSize || URL_DEFAULT_INVENTORY_PAGE_SIZE,
  },
  products: {
    data: null,
    loading: false,
    error: '',
    requestSerial: 0,
    view: initialHashState.productView || 'PENDING',
    sort: initialHashState.productSort || 'IMPACT_DESC',
    pendingPage: initialHashState.productPendingPage || 1,
    canonicalPage: initialHashState.productCanonicalPage || 1,
    pageSize: initialHashState.productPageSize || URL_DEFAULT_INVENTORY_PAGE_SIZE,
  },
  updates: {
    status: 'connecting',
    observedAt: null,
  },
};

const elements = {
  view: document.querySelector('#view'),
  navLinks: [...document.querySelectorAll('[data-route]')],
  search: document.querySelector('#global-search'),
  scope: document.querySelector('#scope-filter'),
  rangeButtons: [...document.querySelectorAll('[data-range]')],
  rangeSummary: document.querySelector('#range-summary'),
  homeDateStart: document.querySelector('#home-date-start'),
  homeDateEnd: document.querySelector('#home-date-end'),
  clearFilters: document.querySelector('#clear-filters'),
  datasetBadge: document.querySelector('#dataset-badge'),
  liveUpdateBadge: document.querySelector('#live-update-badge'),
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

let procurementLoadTimer = null;
let salesLoadTimer = null;
let inventoryLoadTimer = null;
let productLoadTimer = null;
let fulfilmentLoadTimer = null;
let dashboardEventSource = null;

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

function shanghaiToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function shiftIsoDate(date, offsetDays) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + offsetDays);
  return parsed.toISOString().slice(0, 10);
}

function selectedHomeDateRange() {
  if (
    state.homeDateCustom
    && /^\d{4}-\d{2}-\d{2}$/.test(String(state.homeDateStart || ''))
    && /^\d{4}-\d{2}-\d{2}$/.test(String(state.homeDateEnd || ''))
    && state.homeDateStart <= state.homeDateEnd
  ) {
    return { start: state.homeDateStart, end: state.homeDateEnd, custom: true };
  }
  const today = shanghaiToday();
  const days = RANGE_META[state.range]?.days || 1;
  const end = state.range === 'yesterday' ? shiftIsoDate(today, -1) : today;
  return { start: shiftIsoDate(end, -(days - 1)), end, custom: false };
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
    });
  });

  baseStores().forEach((store) => {
    const key = ownerKeyForStore(store);
    if (!key) return;
    const owner = byKey.get(key) || {
      key,
      name: ownerNameForStore(store) || key,
      storeCodes: new Set(),
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

function matchingStoreSkuRows({ ignoreQuery = false } = {}) {
  const owner = selectedOwner();
  const store = selectedStore();
  const ownerStoreCodes = owner ? new Set(owner.storeCodes.map(String)) : null;
  const base = ignoreQuery ? storeSkuRows() : matchingEntities(storeSkuRows());
  return base.filter((row) => {
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

function scopedUnits({ ignoreQuery = false } = {}) {
  const store = selectedStore();
  const owner = selectedOwner();
  // Home keeps KPI, trend and scope stable under a search term: the query only
  // narrows rankings and detail lists, never the headline numbers.
  const query = ignoreQuery ? '' : normalizedQuery();

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
function windowFactCoverage(windowKey, { ignoreQuery = false } = {}) {
  const stores = selectedStore() ? [selectedStore()] : allStores();
  const products = scopedProductRanking({ ignoreQuery }).rows;
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
  return sortByWindow(items, state.range);
}

function sortByWindow(items, windowKey) {
  return [...items].sort((left, right) => {
    const leftValue = left?.unitsSold?.[windowKey];
    const rightValue = right?.unitsSold?.[windowKey];
    const normalizedLeft = isUnit(leftValue) ? leftValue : -1;
    const normalizedRight = isUnit(rightValue) ? rightValue : -1;
    return normalizedRight - normalizedLeft;
  });
}

/** Keep homepage rankings useful when yesterday has no row-level facts. */
function homeRankingWindow() {
  const yesterdayAvailable = state.range !== 'yesterday' || [
    ...allStores(),
    ...scopedProductRanking({ ignoreQuery: true }).rows,
  ].some((item) => isUnit(item?.unitsSold?.yesterday));
  return {
    key: state.range === 'yesterday' && !yesterdayAvailable ? 'today' : state.range,
    fallback: state.range === 'yesterday' && !yesterdayAvailable,
  };
}

function homeRankingWindowNote() {
  return homeRankingWindow().fallback
    ? '行级昨日销量未提供，排行按今日口径展示'
    : '';
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

function scopedProductRanking({ ignoreQuery = false } = {}) {
  if (selectedStore() || selectedOwner()) {
    // The scoped branch starts from store-keyed rows before the query filter:
    // homeProductRows re-applies the search itself over a wider haystack that
    // also covers store code, store name and owner name.
    const rows = matchingStoreSkuRows({ ignoreQuery });
    return {
      rows,
      confirmedRows: rows.filter(isCanonicalProduct),
      localRows: rows.filter((row) => !isCanonicalProduct(row)),
      canonical: rows.length > 0 && rows.every(isCanonicalProduct),
      mixed: rows.some(isCanonicalProduct) && rows.some((row) => !isCanonicalProduct(row)),
      scoped: true,
    };
  }
  if (ignoreQuery) return { ...rankingProducts(), scoped: false };
  return { ...matchingProducts(), scoped: false };
}

function skuRowsForView() {
  return sortBySelectedRange(scopedProductRanking().rows);
}

/* Home ranking rows respond to the search box: store code, store name and
   owner name all join the haystack, and an unmatched query shows an explicit
   empty state instead of silently widening or narrowing the scope. */
function homeStoreRows() {
  const rows = selectedStore() ? [selectedStore()] : allStores();
  const query = normalizedQuery();
  const filtered = !query ? rows : rows.filter((store) => {
    const haystack = [store.code, store.name, ownerNameForStore(store)]
      .filter(Boolean)
      .join(' ')
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN');
    return haystack.includes(query);
  });
  return sortByWindow(filtered, homeRankingWindow().key);
}

function homeProductRows() {
  // Start from the query-free scope so a store code, store name or owner name
  // search can still recover matching products; the extended haystack below is
  // the only query filter applied here.
  const rows = scopedProductRanking({ ignoreQuery: true }).rows;
  const query = normalizedQuery();
  const filtered = !query ? rows : rows.filter((item) => {
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
      item.storeCode,
      item.storeName,
      ownerNameForStoreCode(item?.storeCode),
    ].filter(Boolean)
      .join(' ')
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN');
    return haystack.includes(query);
  });
  return sortByWindow(filtered, homeRankingWindow().key);
}

function homeRankingEmptyMessage(kind) {
  const query = state.query.trim();
  if (query) {
    return kind === 'store'
      ? `搜索“${query}”未命中店铺编码、店铺名称或负责人；趋势、KPI 与店铺范围不受搜索影响。`
      : `搜索“${query}”未命中货号、商品名或所属店铺；趋势、KPI 与店铺范围不受搜索影响。`;
  }
  if (homeRankingWindow().fallback) {
    return `行级昨日销量未提供，且按今日口径暂无可排序的${kind === 'store' ? '店铺' : '货号'}销量事实。`;
  }
  return dimensionBoundary(kind);
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

function scopedTrendSeries() {
  const rows = Array.isArray(state.data?.salesTrendByStore)
    ? state.data.salesTrendByStore
    : [];
  const store = selectedStore();
  const owner = selectedOwner();
  if (!store && !owner) return [];
  const storeCodes = store
    ? new Set([String(store.code)])
    : new Set(owner.storeCodes.map(String));
  const byDate = new Map();
  rows
    .filter((row) => storeCodes.has(String(row?.storeCode || '')))
    .forEach((row) => {
    if (!row?.date || !isUnit(row.unitsSold)) return;
    byDate.set(row.date, (byDate.get(row.date) || 0) + row.unitsSold);
  });
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, unitsSold]) => ({ date, unitsSold }));
}

function trendSourceRows() {
  const globalRows = Array.isArray(state.data?.salesTrend) ? state.data.salesTrend : [];
  const store = selectedStore();
  const owner = selectedOwner();
  // Search narrows rankings only. Global scope always uses the authoritative
  // global series; scoped views use exact salesTrendByStore rows or name the
  // fallback to the global series when that grain is unavailable.
  if (!store && !owner) return globalRows;
  const scopedRows = scopedTrendSeries();
  return scopedRows.length ? scopedRows : globalRows;
}

function trendRowsForRange() {
  const rows = trendSourceRows();
  if (state.range === 'last30Days') return rows.slice(-30);
  return rows.slice(-7);
}

/** Title for the active window; names the real day count instead of promising 7/30. */
function trendWindowLabel(rows = trendRowsForRange()) {
  if (state.range === 'last30Days') {
    return rows.length >= 30
      ? '最近 30 个业务日'
      : `请求最近 30 日 · 实际 ${numberFormatter.format(rows.length)} 个业务日`;
  }
  return rows.length >= 7
    ? '最近 7 个业务日'
    : `最近 ${numberFormatter.format(rows.length)} 个业务日（不足 7 日，缺口不补零）`;
}

/** Where the trend series actually comes from; global fallback is always named. */
function trendScopeLabel() {
  const store = selectedStore();
  const owner = selectedOwner();
  if (!store && !owner) return '全部店铺汇总';
  const scope = store ? `店铺 ${store.name || store.code}` : `负责人 ${owner.name}`;
  return scopedTrendSeries().length
    ? `${scope} · 按店日粒度序列`
    : `${scope} · 无按店日粒度序列，回退全局趋势`;
}

function trendEmptyMessage() {
  const rows = trendRowsForRange();
  if (rows.length > 0 && rows.length < 2) {
    return `${trendWindowLabel(rows)}不足两个日粒度点，暂时无法形成趋势。`;
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

/**
 * Exact day-grain history coverage.
 *
 * The rolling windows (today / 7d / 30d) are pre-aggregated quantities, not a
 * time series. Only the dated rows below can carry a trend, so their real count
 * is reported verbatim instead of implying 30 complete days or a full month.
 */
function trendHistoryState() {
  const dates = [...new Set(
    trendSourceRows()
      .map((row) => String(row?.date || ''))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)),
  )].sort();
  const monthly = monthlyTrendRows();
  return {
    days: dates.length,
    first: dates[0] || null,
    last: dates.at(-1) || null,
    requestedDays: RANGE_META[state.range].days,
    completeMonths: monthly.filter((row) => row.complete).length,
    partialMonths: monthly.filter((row) => !row.complete).length,
  };
}

/** One sentence stating how many real business days exist right now. */
function trendHistoryNotice() {
  const history = trendHistoryState();
  if (history.days === 0) return '当前还没有任何日粒度业务日事实，两张图都保持空态。';
  return `当前真实日粒度历史只有 ${numberFormatter.format(history.days)} 个业务日（${history.first} → ${history.last}），不代表 30 个完整日或任何完整自然月。`;
}

/** Unmissable coverage banner: partial history must not be read as a full series. */
function trendCoverageBanner() {
  const history = trendHistoryState();
  const scopeNote = normalizedQuery()
    ? '货号搜索生效时不展示全局走势，避免把全局趋势冒充商品趋势。'
    : '趋势随负责人、店铺范围联动。';
  if (history.days === 0) {
    return `
      <aside class="quality-notice unknown trend-coverage-banner" aria-label="趋势历史覆盖">
        <strong>日粒度历史尚未建立</strong>
        <span>${escapeHtml(`没有可用业务日序列，因此不画任何趋势线；四个滚动窗口是预聚合数量，不会被当作历史时间序列补线。${scopeNote}`)}</span>
      </aside>`;
  }
  const monthNote = history.completeMonths === 0
    ? '目前没有任何完整自然月，月图只能作为部分覆盖参考'
    : `${numberFormatter.format(history.completeMonths)} 个自然月完整 · ${numberFormatter.format(history.partialMonths)} 个仅部分覆盖`;
  const incomplete = history.days < history.requestedDays;
  return `
    <aside class="quality-notice ${incomplete ? 'unknown' : 'complete'} trend-coverage-banner" aria-label="趋势历史覆盖">
      <strong>${escapeHtml(`真实日粒度历史 ${numberFormatter.format(history.days)} 个业务日${incomplete ? `，少于当前窗口请求的 ${numberFormatter.format(history.requestedDays)} 日` : ''}`)}</strong>
      <span>${escapeHtml(`区间 ${history.first} → ${history.last} · ${monthNote}；缺失的业务日和月份不会被补线或补零。${scopeNote}`)}</span>
    </aside>`;
}

function renderMonthlyTrendChart() {
  const rows = monthlyTrendRows();
  if (rows.length < 2) {
    return emptyEvidence(
      '月趋势暂不可画',
      rows.length === 1
        ? (rows[0].complete
          ? '当前只有一个完整自然月，缺少第二个可比月份；不会画一根假柱冒充月趋势。'
          : '需要至少两个月，当前只有一个部分月；不会画一根假柱冒充月趋势。')
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

/** Main conclusion: today's running total against the last complete day. */
function homeTodayVerdict(units) {
  const today = units?.today;
  const yesterday = units?.yesterday;
  if (!isUnit(today)) {
    return '今日销量未知：缺少可信数量事实，不能当作 0 判断经营节奏。';
  }
  if (!isUnit(yesterday)) {
    return `今日已售 ${numberFormatter.format(today)} 件（当日累计）；昨日窗口缺失，不做增降结论。`;
  }
  if (today === yesterday) {
    return `今日已售 ${numberFormatter.format(today)} 件，与昨日持平；今日仍在累计，并非完整自然日。`;
  }
  const direction = today > yesterday ? '高于' : '低于';
  return `今日已售 ${numberFormatter.format(today)} 件，${direction}昨日（${formatDelta(today, yesterday)}）；今日仍在累计，并非完整自然日。`;
}

/** Secondary conclusion: the only comparable momentum, in plain language. */
function homeMomentumVerdict(units) {
  const signal = comparableDailySignal({ unitsSold: units });
  if (signal.recent === null) {
    return '近 7 日或此前 23 日窗口不完整，日均动量不可比；不用其他窗口替代。';
  }
  if (signal.previous === 0) {
    return `近 7 日日均 ${formatDailyAverage(signal.recent)} 件，此前 23 日日均接近 0，记为${signal.label}，不按百分比解读。`;
  }
  return `近 7 日日均 ${formatDailyAverage(signal.recent)} 件，此前 23 日日均 ${formatDailyAverage(signal.previous)} 件，动量 ${signal.label}。`;
}

/** One horizontal editorial band: conclusions left, scope and fact time right. */
function homeHeader() {
  const units = scopedUnits({ ignoreQuery: true }).units;
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
  const scopeLabel = selectedStore()
    ? `店铺 ${selectedStore().name || selectedStore().code}`
    : selectedOwner()
      ? `负责人 ${selectedOwner().name}`
      : '全部店铺 · 全部负责人';
  return `
    <header class="home-topbar home-verdict" aria-label="首屏经营结论">
      <div class="home-topbar-main">
        <span class="eyebrow">FULL-MANAGED COCKPIT</span>
        <h1>全托经营驾驶舱</h1>
        <p class="verdict-primary">${escapeHtml(homeTodayVerdict(units))}</p>
        <p class="verdict-secondary">${escapeHtml(homeMomentumVerdict(units))}</p>
      </div>
      <dl class="home-topbar-facts">
        <div>
          <dt>当前范围</dt>
          <dd>${escapeHtml(scopeLabel)}</dd>
        </div>
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

/* One dense matrix table: four trusted quantity windows as columns, the
   business measures as rows. Unknown stays —, legal zero stays 0, and only
   the two legal comparison cells carry a change value. */
function homeKpis() {
  const scope = scopedUnits({ ignoreQuery: true });
  const units = scope.units;
  const perWindow = (build) => WINDOW_KEYS.map(build).join('');
  return `
    <section class="home-kpi" aria-label="销量 KPI 数据矩阵">
      <header class="home-block-head">
        <h2>销量 KPI 数据矩阵</h2>
        <p>${escapeHtml(`${scope.title} · ${scope.note}`)}</p>
      </header>
      <div class="metric-matrix-scroll home-kpi-scroll">
        <table class="home-kpi-table">
          <caption class="sr-only">今日、昨日、近 7 日、近 30 日四个窗口的销量、日均销量、可比变化与覆盖</caption>
          <thead>
            <tr>
              <th scope="col">指标</th>
              ${WINDOW_KEYS.map((key) => `<th scope="col" class="num">${escapeHtml(RANGE_META[key].label)}</th>`).join('')}
              <th scope="col" class="note-column">口径说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">销量</th>
              ${perWindow((key) => `<td class="num">${formatUnits(units[key])}<small>件</small></td>`)}
              <td class="note">未知窗口保持 —，不补零；接口确认的合法零显示 0。</td>
            </tr>
            <tr>
              <th scope="row">日均销量</th>
              ${perWindow((key) => `<td class="num">${isUnit(units[key]) ? `${formatAverage(units[key], RANGE_META[key].days)}<small>件/日</small>` : '—'}</td>`)}
              <td class="note">按窗口天数折算（1 / 1 / 7 / 30 日），缺失窗口不折算。</td>
            </tr>
            <tr>
              <th scope="row">可比变化</th>
              ${perWindow((key) => {
                const change = windowChange(key, units);
                return `<td class="num">${change.label === '不可比' ? '—' : escapeHtml(change.label)}</td>`;
              })}
              <td class="note">今日对昨日（今日仍在累计，仅作进度参考）；近 7 日日均对此前 23 日日均；其余位置无前序基线，保持 —，不编造对比。</td>
            </tr>
            <tr>
              <th scope="row">店铺 / 货号覆盖</th>
              ${perWindow((key) => {
                const cover = windowFactCoverage(key, { ignoreQuery: true });
                return `<td class="num">${numberFormatter.format(cover.stores)} / ${numberFormatter.format(cover.products)}<small>范围内 ${numberFormatter.format(cover.storeTotal)} 店 · ${numberFormatter.format(cover.productTotal)} 货号</small></td>`;
              })}
              <td class="note">只统计该窗口带真实销量事实的店铺与货号，未命中不等于没有销量。</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="matrix-footnote">${escapeHtml(`${factSourceNote('缺失窗口保持 —，不补零也不估算')} · 数据质量 ${qualityState().label}`)}</p>
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

function procurementQuickValue() {
  const active = quickFilterValue('procurement');
  return [
    'HIGH', 'OVERDUE', 'PENDING_DELIVERY',
    'PENDING_RECEIPT', 'PENDING_STORAGE', 'DEFECTIVE',
  ].includes(active) ? active : 'ALL';
}

function procurementQueryUrl() {
  const params = new URLSearchParams({
    owner: state.owner,
    store: state.store,
    q: state.query,
    status: operationCodeParam(state.procurement.status),
    quick: procurementQuickValue(),
    sort: allowListedToken(state.procurement.sort, URL_PROCUREMENT_SORTS, 'PRIORITY'),
    page: String(state.procurement.page),
    pageSize: String(pageSizeParam(state.procurement.pageSize)),
  });
  return `/api/procurement?${params.toString()}`;
}

async function loadProcurement({ resetPage = false } = {}) {
  if (resetPage) state.procurement.page = 1;
  if (state.route !== 'procurement') return;
  const requestSerial = state.procurement.requestSerial + 1;
  state.procurement.requestSerial = requestSerial;
  state.procurement.loading = true;
  state.procurement.error = '';
  render();
  try {
    const result = await fetchJson(procurementQueryUrl());
    if (requestSerial !== state.procurement.requestSerial) return;
    if (
      !result
      || result.readOnly !== true
      || !result.attention
      || !Array.isArray(result.attention.rows)
      || !Array.isArray(result.statusRows)
    ) {
      throw new Error('采购单查询结构无效');
    }
    state.procurement.data = result;
  } catch (error) {
    if (requestSerial !== state.procurement.requestSerial) return;
    state.procurement.data = null;
    state.procurement.error = error instanceof Error
      ? error.message
      : '采购单查询暂不可用';
  } finally {
    if (requestSerial === state.procurement.requestSerial) {
      state.procurement.loading = false;
      render();
    }
  }
}

function scheduleProcurementLoad({ resetPage = false, delay = 0 } = {}) {
  if (procurementLoadTimer !== null) window.clearTimeout(procurementLoadTimer);
  // Invalidate an in-flight response immediately. Waiting until the debounce
  // fires would let an old filter result flash under the new URL state.
  state.procurement.requestSerial += 1;
  if (resetPage) {
    state.procurement.page = 1;
    state.procurement.data = null;
    state.procurement.error = '';
    state.procurement.loading = true;
  }
  if (state.route !== 'procurement') return;
  if (resetPage) render();
  procurementLoadTimer = window.setTimeout(() => {
    procurementLoadTimer = null;
    void loadProcurement();
  }, delay);
}

function procurementLoadingState() {
  return `
    <section class="panel procurement-query-state" role="status">
      <span class="eyebrow">PROCUREMENT QUERY</span>
      <h2>正在按当前条件查询采购单</h2>
      <p>筛选和分页在服务端执行；页面不会把旧筛选结果冒充新结果。</p>
    </section>`;
}

function procurementErrorState() {
  return `
    <section class="panel procurement-query-state error" role="alert">
      <span class="eyebrow">PROCUREMENT QUERY</span>
      <h2>采购单独立查询暂不可用</h2>
      <p>${escapeHtml(state.procurement.error || '请稍后重试。')}</p>
      <button type="button" class="clear-button" data-procurement-retry="1">重新查询</button>
    </section>`;
}

function procurementPagination(queryData, position = 'bottom') {
  const pagination = queryData?.attention?.pagination;
  if (!pagination || !isUnit(pagination.page) || !isUnit(pagination.pageSize)) return '';
  const matched = isUnit(pagination.matchedMaterializedRows)
    ? pagination.matchedMaterializedRows
    : 0;
  const pageCount = isUnit(pagination.pageCount) ? pagination.pageCount : 0;
  const displayedPage = pageCount === 0 ? 0 : pagination.page;
  return `
    <nav class="table-pagination ${position === 'top' ? 'pagination-top' : ''}" aria-label="采购单关注清单分页（${position === 'top' ? '表格上方' : '表格下方'}）">
      <p>已物化范围命中 ${numberFormatter.format(matched)} 条 · 第 ${numberFormatter.format(displayedPage)} / ${numberFormatter.format(pageCount)} 页</p>
      <div>
        <button type="button" data-procurement-page="${Math.max(1, pagination.page - 1)}" ${pagination.hasPrevious ? '' : 'disabled'}>上一页</button>
        <button type="button" data-procurement-page="${pagination.page + 1}" ${pagination.hasNext ? '' : 'disabled'}>下一页</button>
      </div>
    </nav>`;
}

/* --- fulfilment-query:start ---
   The fulfilment workspace reads only `/api/fulfilment`. Filtering, sorting and
   paging happen on the server, so the browser never filters the whole Dashboard
   snapshot and never presents the materialized slice as the SHEIN universe. */

function fulfilmentQuickValue() {
  const active = quickFilterValue('fulfilment');
  return ['HIGH', 'CREATED', 'PICKUP_RESERVED', 'IN_TRANSIT', 'PENDING_RECEIPT']
    .includes(active) ? active : 'ALL';
}

function fulfilmentQueryUrl() {
  const params = new URLSearchParams({
    owner: state.owner,
    store: state.store,
    q: state.query,
    milestone: operationCodeParam(state.fulfilment.milestone),
    quick: fulfilmentQuickValue(),
    sort: allowListedToken(state.fulfilment.sort, URL_FULFILMENT_SORTS, 'PRIORITY'),
    page: String(state.fulfilment.page),
    pageSize: String(pageSizeParam(state.fulfilment.pageSize)),
  });
  return `/api/fulfilment?${params.toString()}`;
}

async function loadFulfilment({ resetPage = false } = {}) {
  if (resetPage) state.fulfilment.page = 1;
  if (state.route !== 'fulfilment') return;
  const requestSerial = state.fulfilment.requestSerial + 1;
  state.fulfilment.requestSerial = requestSerial;
  state.fulfilment.loading = true;
  state.fulfilment.error = '';
  render();
  try {
    const result = await fetchJson(fulfilmentQueryUrl());
    // A response that lost the race must never replace newer filter state.
    if (requestSerial !== state.fulfilment.requestSerial) return;
    if (
      !result
      || result.readOnly !== true
      || !Array.isArray(result.attention?.rows)
      || !Array.isArray(result.milestoneOverview)
      || !result.summary
      || !result.source
    ) {
      throw new Error('交付入仓查询结构无效');
    }
    state.fulfilment.data = result;
  } catch (error) {
    if (requestSerial !== state.fulfilment.requestSerial) return;
    state.fulfilment.data = null;
    state.fulfilment.error = error instanceof Error
      ? error.message
      : '交付入仓查询暂不可用';
  } finally {
    if (requestSerial === state.fulfilment.requestSerial) {
      state.fulfilment.loading = false;
      render();
    }
  }
}

function scheduleFulfilmentLoad({ resetPage = false, delay = 0 } = {}) {
  if (fulfilmentLoadTimer !== null) window.clearTimeout(fulfilmentLoadTimer);
  // Invalidate any in-flight response now, not when the debounce fires, so an
  // old scope can never paint under the new URL state.
  state.fulfilment.requestSerial += 1;
  if (resetPage) {
    state.fulfilment.page = 1;
    state.fulfilment.data = null;
    state.fulfilment.error = '';
    state.fulfilment.loading = true;
  }
  if (state.route !== 'fulfilment') return;
  if (resetPage) render();
  fulfilmentLoadTimer = window.setTimeout(() => {
    fulfilmentLoadTimer = null;
    void loadFulfilment();
  }, delay);
}

function fulfilmentQueryState(kind) {
  const error = kind === 'error';
  return `
    <section class="panel procurement-query-state${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">
      <span class="eyebrow">FULFILMENT QUERY</span>
      <h2>${error ? '交付入仓查询暂不可用' : '正在按当前条件查询交付单'}</h2>
      <p>${error
        ? escapeHtml(state.fulfilment.error || '请稍后重试。')
        : '筛选、排序和分页在服务端执行；旧筛选结果不会冒充新结果。'}</p>
      ${error
        ? '<button type="button" class="clear-button" data-fulfilment-retry="1">重新查询</button>'
        : '<div class="query-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>'}
    </section>`;
}

function fulfilmentPagination(pagination, position) {
  if (!pagination || !isUnit(pagination.page) || !isUnit(pagination.pageSize)) return '';
  const matched = isUnit(pagination.matchedMaterializedRows)
    ? pagination.matchedMaterializedRows
    : 0;
  const pageCount = isUnit(pagination.pageCount) ? pagination.pageCount : 0;
  const displayedPage = pageCount === 0 ? 0 : pagination.page;
  return `
    <nav class="table-pagination ${position === 'top' ? 'pagination-top' : ''}" aria-label="交付单关注清单分页（${position === 'top' ? '表格上方' : '表格下方'}）">
      <p>已物化范围命中 ${numberFormatter.format(matched)} 条 · 第 ${numberFormatter.format(displayedPage)} / ${numberFormatter.format(pageCount)} 页</p>
      <div>
        <button type="button" data-fulfilment-page="${Math.max(1, pagination.page - 1)}" ${pagination.hasPrevious ? '' : 'disabled'}>上一页</button>
        <button type="button" data-fulfilment-page="${pagination.page + 1}" ${pagination.hasNext ? '' : 'disabled'}>下一页</button>
      </div>
    </nav>`;
}

/** Shared select control for the operational filter bars. */
function operationSelect(kind, label, options, current) {
  return `
    <label class="sales-sort-control">
      <span>${escapeHtml(label)}</span>
      <select data-operation-select="${escapeHtml(kind)}">
        ${options.map(([value, text]) => `<option value="${escapeHtml(String(value))}" ${String(current) === String(value) ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}
      </select>
    </label>`;
}

/** Search and reset act on the shared global query used by every endpoint. */
function operationSearchControls(kind) {
  return `
    <div class="operation-search" role="group" aria-label="工作台搜索">
      <button type="button" class="clear-button" data-operation-search="${escapeHtml(kind)}">搜索当前条件</button>
      <button type="button" class="clear-button" data-operation-reset="${escapeHtml(kind)}">重置筛选</button>
    </div>`;
}

/** Truthful coverage line: 23/24 with the in-progress store named explicitly. */
function operationCoverageLine(source) {
  const coverage = productRecord(source?.coverage);
  const meta = productRecord(source?.materializedAttention);
  const succeeded = isUnit(coverage.succeededStores) ? coverage.succeededStores : null;
  const total = isUnit(coverage.totalStores) ? coverage.totalStores : null;
  const inProgress = Array.isArray(coverage.inProgressStoreCodes)
    ? coverage.inProgressStoreCodes
    : [];
  return [
    succeeded === null || total === null
      ? '店铺覆盖未知'
      : `店铺覆盖 ${numberFormatter.format(succeeded)} / ${numberFormatter.format(total)}`,
    inProgress.length ? `进行中 ${inProgress.join('、')}` : '无进行中店铺',
    isUnit(coverage.failedStores) ? `失败 ${numberFormatter.format(coverage.failedStores)}` : '失败数未知',
    isUnit(coverage.staleStores) ? `过期 ${numberFormatter.format(coverage.staleStores)}` : '过期数未知',
    coverage.watermarkStart && coverage.watermarkEnd
      ? `水位 ${sourceTime(coverage.watermarkStart)} → ${sourceTime(coverage.watermarkEnd)}`
      : '水位区间未知',
    isUnit(meta.returned) && isUnit(meta.total)
      ? `源物化 ${numberFormatter.format(meta.returned)} / ${numberFormatter.format(meta.total)} 条`
      : '源物化数量未知',
    meta.truncated === true ? '源结果已截断，非仓库全量' : '源物化未截断',
  ].join(' · ');
}

/** Render one nullable quantity metric without turning unknown into zero. */
function stageMetricValue(metric, unit) {
  const source = productRecord(metric);
  if (isUnit(source.total)) return `${numberFormatter.format(source.total)} ${unit}`;
  if (isUnit(source.knownSum)) return `≥ ${numberFormatter.format(source.knownSum)} ${unit}`;
  return '未知';
}

function stageMetricNote(metric) {
  const source = productRecord(metric);
  const rowCount = isUnit(source.rowCount) ? source.rowCount : 0;
  const unknownCount = isUnit(source.unknownCount) ? source.unknownCount : 0;
  if (rowCount === 0) return '当前筛选没有命中已物化行；不代表业务数量为 0';
  if (unknownCount === 0) return `${numberFormatter.format(rowCount)} 行数量全部已知`;
  return `${numberFormatter.format(unknownCount)} / ${numberFormatter.format(rowCount)} 行未知，拒绝补零合计`;
}
/* --- fulfilment-query:end --- */

function salesQueryUrl() {
  const quick = quickFilterValue('sales');
  const identity = ['CANONICAL', 'UNMAPPED'].includes(quick) ? quick : 'ALL';
  const momentum = ['GROWING', 'DECLINING', 'UNCOMPARABLE'].includes(quick)
    ? quick
    : 'ALL';
  const params = new URLSearchParams({
    owner: state.owner,
    store: state.store,
    q: state.query,
    identity,
    momentum,
    sort: state.sales.sort,
    productPage: String(state.sales.productPage),
    standardPage: String(state.sales.standardPage),
    pageSize: String(state.sales.pageSize),
  });
  return `/api/sales?${params.toString()}`;
}

async function loadSales({ resetPages = false } = {}) {
  if (resetPages) {
    state.sales.productPage = 1;
    state.sales.standardPage = 1;
  }
  if (state.route !== 'sales') return;
  const requestSerial = state.sales.requestSerial + 1;
  state.sales.requestSerial = requestSerial;
  state.sales.loading = true;
  state.sales.error = '';
  render();
  try {
    const result = await fetchJson(salesQueryUrl());
    if (requestSerial !== state.sales.requestSerial) return;
    if (
      !result
      || result.readOnly !== true
      || !Array.isArray(result.stores?.rows)
      || !Array.isArray(result.products?.rows)
      || !Array.isArray(result.standardProducts?.rows)
    ) {
      throw new Error('销量查询结构无效');
    }
    state.sales.data = result;
  } catch (error) {
    if (requestSerial !== state.sales.requestSerial) return;
    state.sales.data = null;
    state.sales.error = error instanceof Error ? error.message : '销量查询暂不可用';
  } finally {
    if (requestSerial === state.sales.requestSerial) {
      state.sales.loading = false;
      render();
    }
  }
}

function scheduleSalesLoad({ resetPages = false, delay = 0 } = {}) {
  if (salesLoadTimer !== null) window.clearTimeout(salesLoadTimer);
  state.sales.requestSerial += 1;
  if (resetPages) {
    state.sales.productPage = 1;
    state.sales.standardPage = 1;
    state.sales.data = null;
    state.sales.error = '';
    state.sales.loading = true;
  }
  if (state.route !== 'sales') return;
  if (resetPages) render();
  salesLoadTimer = window.setTimeout(() => {
    salesLoadTimer = null;
    void loadSales();
  }, delay);
}

function salesQueryState(kind) {
  const error = kind === 'error';
  return `
    <section class="panel procurement-query-state${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">
      <span class="eyebrow">SALES QUERY</span>
      <h2>${error ? '销量独立查询暂不可用' : '正在按当前条件查询销量'}</h2>
      <p>${error
        ? escapeHtml(state.sales.error || '请稍后重试。')
        : '商品筛选、排序和分页在服务端执行；旧筛选结果不会冒充新结果。'}</p>
      ${error ? '<button type="button" class="clear-button" data-sales-retry="1">重新查询</button>' : ''}
    </section>`;
}

function salesPagination(pagination, kind, label) {
  if (!pagination || !isUnit(pagination.page) || !isUnit(pagination.pageSize)) return '';
  const matched = isUnit(pagination.matchedMaterializedRows)
    ? pagination.matchedMaterializedRows
    : 0;
  const pageCount = isUnit(pagination.pageCount) ? pagination.pageCount : 0;
  const displayedPage = pageCount === 0 ? 0 : pagination.page;
  return `
    <nav class="table-pagination" aria-label="${escapeHtml(label)}分页">
      <p>已物化范围命中 ${numberFormatter.format(matched)} 条 · 第 ${numberFormatter.format(displayedPage)} / ${numberFormatter.format(pageCount)} 页</p>
      <div>
        <button type="button" data-sales-page-kind="${escapeHtml(kind)}" data-sales-page="${Math.max(1, pagination.page - 1)}" ${pagination.hasPrevious ? '' : 'disabled'}>上一页</button>
        <button type="button" data-sales-page-kind="${escapeHtml(kind)}" data-sales-page="${pagination.page + 1}" ${pagination.hasNext ? '' : 'disabled'}>下一页</button>
      </div>
    </nav>`;
}

function salesSortControl() {
  const options = [
    ['LAST30_DESC', '近 30 日销量'],
    ['LAST7_DESC', '近 7 日销量'],
    ['TODAY_DESC', '今日销量'],
    ['MOMENTUM_DESC', '增长动量'],
    ['MOMENTUM_ASC', '下降动量'],
  ];
  return `
    <label class="sales-sort-control">
      <span>排序</span>
      <select data-sales-sort>
        ${options.map(([value, label]) => `<option value="${value}" ${state.sales.sort === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </label>`;
}

/* --- inventory-query:start ---
   The inventory workspace reads only `/api/inventory`. Filtering, sorting and
   paging happen on the server, so the browser never truncates a result set and
   never presents the materialized slice as the warehouse universe. */

function inventoryQuickValue() {
  const active = quickFilterValue('inventory');
  return ['HIGH', 'SHORTAGE', 'RECONCILIATION', 'URGENT', 'ADVICE', 'WARNING']
    .includes(active) ? active : 'ALL';
}

function inventoryQueryUrl() {
  const params = new URLSearchParams({
    owner: state.owner,
    store: state.store,
    q: state.query,
    quick: inventoryQuickValue(),
    inventoryType: allowListedToken(
      state.inventory.inventoryType,
      URL_INVENTORY_TYPES,
      'ALL',
    ),
    inventorySort: allowListedToken(
      state.inventory.inventorySort,
      URL_INVENTORY_SORTS,
      'PRIORITY',
    ),
    adviceSort: allowListedToken(state.inventory.adviceSort, URL_ADVICE_SORTS, 'PRIORITY'),
    inventoryPage: String(state.inventory.inventoryPage),
    advicePage: String(state.inventory.advicePage),
    pageSize: String(pageSizeParam(state.inventory.pageSize)),
  });
  return `/api/inventory?${params.toString()}`;
}

async function loadInventory({ resetPages = false } = {}) {
  if (resetPages) {
    state.inventory.inventoryPage = 1;
    state.inventory.advicePage = 1;
  }
  if (state.route !== 'inventory') return;
  const requestSerial = state.inventory.requestSerial + 1;
  state.inventory.requestSerial = requestSerial;
  state.inventory.loading = true;
  state.inventory.error = '';
  render();
  try {
    const result = await fetchJson(inventoryQueryUrl());
    // A response that lost the race must never replace newer filter state.
    if (requestSerial !== state.inventory.requestSerial) return;
    if (
      !result
      || result.readOnly !== true
      || !Array.isArray(result.inventory?.rows)
      || !Array.isArray(result.advice?.rows)
      || !Array.isArray(result.inventory?.storeSummaryRows)
      || !Array.isArray(result.advice?.storeSummaryRows)
      || !result.overview
    ) {
      throw new Error('库存与备货查询结构无效');
    }
    state.inventory.data = result;
  } catch (error) {
    if (requestSerial !== state.inventory.requestSerial) return;
    state.inventory.data = null;
    state.inventory.error = error instanceof Error
      ? error.message
      : '库存与备货查询暂不可用';
  } finally {
    if (requestSerial === state.inventory.requestSerial) {
      state.inventory.loading = false;
      render();
    }
  }
}

function scheduleInventoryLoad({ resetPages = false, delay = 0 } = {}) {
  if (inventoryLoadTimer !== null) window.clearTimeout(inventoryLoadTimer);
  // Invalidate any in-flight response now, not when the debounce fires, so an
  // old scope can never paint under the new URL state.
  state.inventory.requestSerial += 1;
  if (resetPages) {
    state.inventory.inventoryPage = 1;
    state.inventory.advicePage = 1;
    state.inventory.data = null;
    state.inventory.error = '';
    state.inventory.loading = true;
  }
  if (state.route !== 'inventory') return;
  if (resetPages) render();
  inventoryLoadTimer = window.setTimeout(() => {
    inventoryLoadTimer = null;
    void loadInventory();
  }, delay);
}

function inventoryQueryState(kind) {
  const error = kind === 'error';
  return `
    <section class="panel procurement-query-state${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">
      <span class="eyebrow">INVENTORY QUERY</span>
      <h2>${error ? '库存与备货查询暂不可用' : '正在按当前条件查询库存与备货'}</h2>
      <p>${error
        ? escapeHtml(state.inventory.error || '请稍后重试。')
        : '筛选、排序和分页在服务端执行；旧筛选结果不会冒充新结果。'}</p>
      ${error
        ? '<button type="button" class="clear-button" data-inventory-retry="1">重新查询</button>'
        : '<div class="query-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>'}
    </section>`;
}

function inventoryPagination(pagination, kind, label, position) {
  if (!pagination || !isUnit(pagination.page) || !isUnit(pagination.pageSize)) return '';
  const matched = isUnit(pagination.matchedMaterializedRows)
    ? pagination.matchedMaterializedRows
    : 0;
  const pageCount = isUnit(pagination.pageCount) ? pagination.pageCount : 0;
  const displayedPage = pageCount === 0 ? 0 : pagination.page;
  return `
    <nav class="table-pagination ${position === 'top' ? 'pagination-top' : ''}" aria-label="${escapeHtml(label)}分页（${position === 'top' ? '表格上方' : '表格下方'}）">
      <p>已物化范围命中 ${numberFormatter.format(matched)} 条 · 第 ${numberFormatter.format(displayedPage)} / ${numberFormatter.format(pageCount)} 页</p>
      <div>
        <button type="button" data-inventory-page-kind="${escapeHtml(kind)}" data-inventory-page="${Math.max(1, pagination.page - 1)}" ${pagination.hasPrevious ? '' : 'disabled'}>上一页</button>
        <button type="button" data-inventory-page-kind="${escapeHtml(kind)}" data-inventory-page="${pagination.page + 1}" ${pagination.hasNext ? '' : 'disabled'}>下一页</button>
      </div>
    </nav>`;
}

function inventoryViewTabs(queryData) {
  const active = state.inventory.view;
  const inventoryMatched = isUnit(queryData?.inventory?.pagination?.matchedMaterializedRows)
    ? queryData.inventory.pagination.matchedMaterializedRows
    : 0;
  const adviceMatched = isUnit(queryData?.advice?.pagination?.matchedMaterializedRows)
    ? queryData.advice.pagination.matchedMaterializedRows
    : 0;
  const tabs = [
    ['INVENTORY', '库存风险', inventoryMatched],
    ['ADVICE', '备货建议', adviceMatched],
  ];
  return `
    <div class="segmented-tabs" role="tablist" aria-label="库存与备货工作台视图">
      ${tabs.map(([value, label, matched]) => `
        <button type="button" role="tab" id="inventory-tab-${escapeHtml(value)}" data-inventory-view="${escapeHtml(value)}" class="${active === value ? 'active' : ''}" aria-selected="${active === value ? 'true' : 'false'}" aria-controls="inventory-workspace-table">
          <strong>${escapeHtml(label)}</strong>
          <small>命中 ${numberFormatter.format(matched)} 条</small>
        </button>`).join('')}
    </div>`;
}

function inventorySelect(kind, label, options, current) {
  return `
    <label class="sales-sort-control">
      <span>${escapeHtml(label)}</span>
      <select data-inventory-select="${escapeHtml(kind)}">
        ${options.map(([value, text]) => `<option value="${escapeHtml(String(value))}" ${String(current) === String(value) ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}
      </select>
    </label>`;
}

/** Turn one nullable server metric into an honest card value and note. */
function inventoryMetricCard(label, metric, unit, { decimal = false } = {}) {
  const source = metric && typeof metric === 'object' ? metric : {};
  const total = decimal
    ? (typeof source.total === 'number' && Number.isFinite(source.total) ? source.total : null)
    : (isUnit(source.total) ? source.total : null);
  const knownSum = decimal
    ? (typeof source.knownSum === 'number' && Number.isFinite(source.knownSum)
        ? source.knownSum
        : null)
    : (isUnit(source.knownSum) ? source.knownSum : null);
  const rowCount = isUnit(source.rowCount) ? source.rowCount : 0;
  const unknownCount = isUnit(source.unknownCount) ? source.unknownCount : 0;
  const format = (value) => (decimal
    ? nullableDecimal(value)
    : numberFormatter.format(value));
  if (rowCount === 0) {
    return {
      label,
      value: '无命中行',
      note: '当前筛选没有命中已物化风险行；这不代表业务数量为 0',
      tone: 'partial',
    };
  }
  if (total !== null) {
    return {
      label,
      value: `${format(total)} ${unit}`,
      note: `${numberFormatter.format(rowCount)} 行全部已知；受影响店铺 ${numberFormatter.format(isUnit(source.affectedStoreCount) ? source.affectedStoreCount : 0)} 家`,
      tone: 'available',
    };
  }
  return {
    label,
    value: knownSum === null ? '未知' : `≥ ${format(knownSum)} ${unit}`,
    note: `${numberFormatter.format(unknownCount)} / ${numberFormatter.format(rowCount)} 行未知，拒绝补零合计`,
    tone: 'partial',
  };
}

function inventorySummaryCards(queryData) {
  const overview = queryData.overview;
  const inventoryView = state.inventory.view === 'INVENTORY';
  const reconciliation = overview.reconciliation || {};
  const freshness = queryData.source?.latestSourceFetchedAt;
  const primary = inventoryView
    ? inventoryMetricCard('当前范围缺货数量', overview.shortage, '件')
    : inventoryMetricCard('平台建议下单量', overview.advised, '件');
  const secondary = inventoryView
    ? inventoryMetricCard('当前范围可用库存', overview.usable, '件')
    : inventoryMetricCard('平台计划急采量', overview.urgent, '件');
  const attention = inventoryView
    ? {
        label: '库存对账待复核',
        value: `${numberFormatter.format(isUnit(reconciliation.rowCount) ? reconciliation.rowCount : 0)} 行`,
        note: `涉及 ${numberFormatter.format(isUnit(reconciliation.affectedStoreCount) ? reconciliation.affectedStoreCount : 0)} 家店铺；对账状态保留平台原值`,
        tone: (isUnit(reconciliation.rowCount) && reconciliation.rowCount > 0) ? 'partial' : 'available',
      }
    : {
        label: '平台预警 SKU',
        value: `${numberFormatter.format(isUnit(overview.warningRowCount) ? overview.warningRowCount : 0)} 行`,
        note: '仅统计平台明确标记为预警的行；未知预警状态不计入',
        tone: (isUnit(overview.warningRowCount) && overview.warningRowCount > 0) ? 'partial' : 'available',
      };
  return operationSummaryCards([
    primary,
    secondary,
    attention,
    {
      label: '最新来源快照',
      value: freshness ? formatDateTime(freshness) : '未知',
      note: '来源抓取时间，不冒充库存业务时点',
      tone: freshness ? 'available' : 'partial',
    },
  ]);
}

/** Truthful source line: materialized rows are never called a warehouse total. */
function inventorySourceLine(queryData) {
  const inventoryView = state.inventory.view === 'INVENTORY';
  const source = inventoryView ? queryData.inventory.source : queryData.advice.source;
  const pagination = inventoryView
    ? queryData.inventory.pagination
    : queryData.advice.pagination;
  const matched = isUnit(pagination?.matchedMaterializedRows)
    ? pagination.matchedMaterializedRows
    : 0;
  const returned = isUnit(source?.returned) ? source.returned : null;
  const total = isUnit(source?.total) ? source.total : null;
  const parts = [
    `已物化范围命中 ${numberFormatter.format(matched)} 条`,
    returned === null || total === null
      ? '源物化数量未知'
      : `源物化 ${numberFormatter.format(returned)} / ${numberFormatter.format(total)} 条`,
    source?.truncated === true ? '源结果已截断，非仓库全量' : '源物化未截断',
    `业务日期 ${escapeHtml(String(queryData.source?.businessDate || '未知'))}`,
  ];
  return parts.join(' · ');
}

function inventoryRiskQueryTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有库存风险 SKU',
      '服务端在已物化范围内没有命中缺货或库存对账风险；这不代表所有库存类型和店铺都已完整覆盖。',
    );
  }
  const visible = orderRowsForFocus(rows, 'inventory');
  return `
    <div class="table-wrap">
      <table class="data-table operational-table inventory-table" id="inventory-workspace-table" role="tabpanel" aria-labelledby="inventory-tab-INVENTORY">
        <caption class="sr-only">当前筛选命中的已物化库存风险行</caption>
        <thead><tr><th scope="col">优先级</th><th scope="col">店铺 / SKU</th><th scope="col">商品</th><th scope="col">库存类型</th><th scope="col" class="number-column">库存</th><th scope="col" class="number-column">可用</th><th scope="col" class="number-column">在途</th><th scope="col" class="number-column">缺货</th><th scope="col">对账状态</th><th scope="col">证据时间</th><th scope="col">定位</th></tr></thead>
        <tbody>${visible.map((row) => `
          <tr class="${isFocusedRow(row, 'inventory') ? 'focused-row' : ''}">
            <td>${severityBadge(row.severity)}</td>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml(row.skuCode || 'SKU 待确认')}</span></td>
            <td class="entity-column"><strong>${escapeHtml(row.skcName || row.spuName || '商品待确认')}</strong><span>${escapeHtml(row.spuName || '')}</span></td>
            <td><span class="row-status partial">${escapeHtml(row.inventoryTypeCode || '类型未知')}</span></td>
            <td class="number-column">${nullableUnits(row.totalInventory)}</td>
            <td class="number-column">${nullableUnits(row.usableInventory)}</td>
            <td class="number-column">${nullableUnits(row.transitQuantity)}</td>
            <td class="number-column">${nullableUnits(row.shortageQuantity)}</td>
            <td><span class="row-status ${sourceStatusTone(row.reconciliationStatus)}">${escapeHtml(row.reconciliationStatus || '未知')}</span></td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
            <td>${rowFocusLink(row, 'inventory')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">当前页显示 ${numberFormatter.format(visible.length)} 条，排序与分页由服务端决定。PI、JI、VI 保持平台库存类型原值，不相互混算；“—”表示未知，不表示 0。</p>`;
}

function stockAdviceQueryTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有备货建议 SKU',
      '服务端在已物化范围内没有命中急采、建议备货或平台预警；未知字段不会补成 0。',
    );
  }
  const visible = orderRowsForFocus(rows, 'advice');
  return `
    <div class="table-wrap">
      <table class="data-table operational-table advice-table" id="inventory-workspace-table" role="tabpanel" aria-labelledby="inventory-tab-ADVICE">
        <caption class="sr-only">当前筛选命中的已物化备货建议行</caption>
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
    <p class="table-note">当前页显示 ${numberFormatter.format(visible.length)} 条。平台预测、建议和急采都是只读事实，不等于已执行的采购动作，也不会自动生成采购单。</p>`;
}

/** Compact secondary overview: store-level rows already scoped by the server. */
function inventoryStoreSummary(queryData) {
  const inventoryView = state.inventory.view === 'INVENTORY';
  const rows = inventoryView
    ? queryData.inventory.storeSummaryRows
    : queryData.advice.storeSummaryRows;
  if (!rows.length) {
    return emptyEvidence(
      inventoryView ? '当前筛选没有店铺级库存快照' : '当前筛选没有店铺级备货建议快照',
      '空行不等于业务 0；调整负责人、店铺或搜索条件后重试。',
    );
  }
  const header = inventoryView
    ? '<th scope="col">店铺 / 类型</th><th scope="col" class="number-column">SKU 数</th><th scope="col" class="number-column">库存数量</th><th scope="col" class="number-column">可用库存</th><th scope="col" class="number-column">缺货 SKU</th><th scope="col">缺货覆盖</th><th scope="col">来源快照</th>'
    : '<th scope="col">店铺</th><th scope="col" class="number-column">SKU 总数</th><th scope="col" class="number-column">建议 SKU</th><th scope="col" class="number-column">建议下单量</th><th scope="col" class="number-column">计划紧急量</th><th scope="col">下单量覆盖</th><th scope="col">来源快照</th>';
  const body = rows.map((row) => (inventoryView
    ? `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml([row.storeCode, row.inventoryTypeCode].filter(Boolean).join(' · ') || '库存类型未知')}</span></td>
            <td class="number-column ${isUnit(row.skuCount) ? '' : 'missing-value'}">${nullableUnits(row.skuCount)}</td>
            <td class="number-column ${isUnit(row.inventoryQuantity) ? '' : 'missing-value'}">${nullableUnits(row.inventoryQuantity)}</td>
            <td class="number-column ${isUnit(row.usableInventory) ? '' : 'missing-value'}">${nullableUnits(row.usableInventory)}</td>
            <td class="number-column ${isUnit(row.shortageSkuCount) ? '' : 'missing-value'}">${nullableUnits(row.shortageSkuCount)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.shortageCoverage, [['knownSkuCount', 'totalSkuCount', 'SKU']]))}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
          </tr>`
    : `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.storeName || row.storeCode || '店铺待确认')}</strong><span>${escapeHtml(row.storeCode || '店铺编码未知')}</span></td>
            <td class="number-column ${isUnit(row.totalSkuCount) ? '' : 'missing-value'}">${nullableUnits(row.totalSkuCount)}</td>
            <td class="number-column ${isUnit(row.advisedSkuCount) ? '' : 'missing-value'}">${nullableUnits(row.advisedSkuCount)}</td>
            <td class="number-column ${isUnit(row.advisedOrderQuantity) ? '' : 'missing-value'}">${nullableUnits(row.advisedOrderQuantity)}</td>
            <td class="number-column ${isUnit(row.plannedUrgentQuantity) ? '' : 'missing-value'}">${nullableUnits(row.plannedUrgentQuantity)}</td>
            <td class="boundary-cell">${escapeHtml(fieldCoverageLabel(row.advisedOrderCoverage, [['knownSkuCount', 'totalSkuCount', 'SKU']]))}</td>
            <td class="boundary-cell">${escapeHtml(sourceTime(row.latestSourceFetchedAt))}</td>
          </tr>`)).join('');
  return `
    <div class="table-wrap">
      <table class="data-table operational-table store-summary-table">
        <thead><tr>${header}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="table-note">店铺级第二层总览，共 ${numberFormatter.format(rows.length)} 行；库存、可用、在途、缺货和建议是不同口径。“—”表示未知并同时展示覆盖率；明确 0 才展示为 0。</p>`;
}
/* --- inventory-query:end --- */

/* --- product-query:start ---
   The product identity workspace reads only `/api/products`. Filtering, sorting
   and paging happen on the server, so the browser never slices the dashboard
   and never presents the materialized ranking as the SHEIN catalog. */

function productRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Owner name for a bare store code; pending rows carry no owner field. */
function ownerNameForStoreCode(storeCode) {
  const normalized = String(storeCode ?? '').trim().toUpperCase();
  if (normalized === '') return '';
  const store = baseStores().find(
    (item) => String(item?.code ?? '').toUpperCase() === normalized,
  );
  return store ? ownerNameForStore(store) : '';
}

function productQuickValue() {
  const active = quickFilterValue('products');
  return ['WITH_SALES', 'UNMAPPED', 'MISSING_SPU', 'CANONICAL'].includes(active)
    ? active
    : 'ALL';
}

function productQueryUrl() {
  const params = new URLSearchParams({
    owner: state.owner,
    store: state.store,
    q: state.query,
    quick: productQuickValue(),
    sort: allowListedToken(state.products.sort, URL_PRODUCT_SORTS, 'IMPACT_DESC'),
    range: URL_RANGE_KEYS.includes(state.range) ? state.range : URL_DEFAULT_RANGE,
    pendingPage: String(state.products.pendingPage),
    canonicalPage: String(state.products.canonicalPage),
    pageSize: String(pageSizeParam(state.products.pageSize)),
  });
  return `/api/products?${params.toString()}`;
}

async function loadProducts({ resetPages = false } = {}) {
  if (resetPages) {
    state.products.pendingPage = 1;
    state.products.canonicalPage = 1;
  }
  if (state.route !== 'products') return;
  const requestSerial = state.products.requestSerial + 1;
  state.products.requestSerial = requestSerial;
  state.products.loading = true;
  state.products.error = '';
  render();
  try {
    const result = await fetchJson(productQueryUrl());
    // A response that lost the race must never replace newer filter state.
    if (requestSerial !== state.products.requestSerial) return;
    if (
      !result
      || result.readOnly !== true
      || !Array.isArray(result.pending?.rows)
      || !Array.isArray(result.canonical?.rows)
      || !result.summary
      || !result.source
    ) {
      throw new Error('商品身份查询结构无效');
    }
    state.products.data = result;
  } catch (error) {
    if (requestSerial !== state.products.requestSerial) return;
    state.products.data = null;
    state.products.error = error instanceof Error
      ? error.message
      : '商品身份查询暂不可用';
  } finally {
    if (requestSerial === state.products.requestSerial) {
      state.products.loading = false;
      render();
    }
  }
}

function scheduleProductLoad({ resetPages = false, delay = 0 } = {}) {
  if (productLoadTimer !== null) window.clearTimeout(productLoadTimer);
  // Invalidate any in-flight response now, not when the debounce fires, so an
  // old scope can never paint under the new URL state.
  state.products.requestSerial += 1;
  if (resetPages) {
    state.products.pendingPage = 1;
    state.products.canonicalPage = 1;
    state.products.data = null;
    state.products.error = '';
    state.products.loading = true;
  }
  if (state.route !== 'products') return;
  if (resetPages) render();
  productLoadTimer = window.setTimeout(() => {
    productLoadTimer = null;
    void loadProducts();
  }, delay);
}

function productQueryState(kind) {
  const error = kind === 'error';
  return `
    <section class="panel procurement-query-state${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">
      <span class="eyebrow">PRODUCT QUERY</span>
      <h2>${error ? '商品身份查询暂不可用' : '正在按当前条件查询商品身份'}</h2>
      <p>${error
        ? escapeHtml(state.products.error || '请稍后重试。')
        : '筛选、排序和分页在服务端执行；旧筛选结果不会冒充新结果。'}</p>
      ${error
        ? '<button type="button" class="clear-button" data-product-retry="1">重新查询</button>'
        : '<div class="query-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>'}
    </section>`;
}

function productPagination(pagination, kind, label, position) {
  if (!pagination || !isUnit(pagination.page) || !isUnit(pagination.pageSize)) return '';
  const matched = isUnit(pagination.matchedMaterializedRows)
    ? pagination.matchedMaterializedRows
    : 0;
  const pageCount = isUnit(pagination.pageCount) ? pagination.pageCount : 0;
  const displayedPage = pageCount === 0 ? 0 : pagination.page;
  return `
    <nav class="table-pagination ${position === 'top' ? 'pagination-top' : ''}" aria-label="${escapeHtml(label)}分页（${position === 'top' ? '表格上方' : '表格下方'}）">
      <p>已物化范围命中 ${numberFormatter.format(matched)} 条 · 第 ${numberFormatter.format(displayedPage)} / ${numberFormatter.format(pageCount)} 页</p>
      <div>
        <button type="button" data-product-page-kind="${escapeHtml(kind)}" data-product-page="${Math.max(1, pagination.page - 1)}" ${pagination.hasPrevious ? '' : 'disabled'}>上一页</button>
        <button type="button" data-product-page-kind="${escapeHtml(kind)}" data-product-page="${pagination.page + 1}" ${pagination.hasNext ? '' : 'disabled'}>下一页</button>
      </div>
    </nav>`;
}

function productViewTabs(queryData) {
  const active = state.products.view;
  const pendingMatched = isUnit(queryData?.pending?.pagination?.matchedMaterializedRows)
    ? queryData.pending.pagination.matchedMaterializedRows
    : 0;
  const canonicalMatched = isUnit(queryData?.canonical?.pagination?.matchedMaterializedRows)
    ? queryData.canonical.pagination.matchedMaterializedRows
    : 0;
  const tabs = [
    ['PENDING', '待归并队列', pendingMatched],
    ['CANONICAL', '标准商品', canonicalMatched],
  ];
  return `
    <div class="segmented-tabs" role="tablist" aria-label="商品身份工作台视图">
      ${tabs.map(([value, label, matched]) => `
        <button type="button" role="tab" id="product-tab-${escapeHtml(value)}" data-product-view="${escapeHtml(value)}" class="${active === value ? 'active' : ''}" aria-selected="${active === value ? 'true' : 'false'}" aria-controls="product-workspace-table">
          <strong>${escapeHtml(label)}</strong>
          <small>命中 ${numberFormatter.format(matched)} 条</small>
        </button>`).join('')}
    </div>`;
}

function productSelect(kind, label, options, current) {
  return `
    <label class="sales-sort-control">
      <span>${escapeHtml(label)}</span>
      <select data-product-select="${escapeHtml(kind)}">
        ${options.map(([value, text]) => `<option value="${escapeHtml(String(value))}" ${String(current) === String(value) ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}
      </select>
    </label>`;
}

/** Two universes side by side: the active catalog and the sealed evidence run. */
function productDecisionSummary(queryData) {
  const catalog = productRecord(queryData.source?.activeCatalogCoverage);
  const pipeline = productRecord(queryData.source?.pipeline);
  const evidence = productRecord(pipeline.evidence);
  const assignments = productRecord(pipeline.assignments);
  const canonical = productRecord(pipeline.canonical);
  const summary = productRecord(queryData.summary);
  const impact = productRecord(summary.pendingImpact);
  const pendingSource = productRecord(queryData.pending?.source);
  const coverageValue = typeof catalog.coverageRate === 'number'
    ? `${(catalog.coverageRate * 100).toFixed(1)}%`
    : '待确认';
  const impactValue = isUnit(impact.total)
    ? `${numberFormatter.format(impact.total)} 件`
    : isUnit(impact.knownSum)
      ? `≥ ${numberFormatter.format(impact.knownSum)} 件`
      : '未知';
  return operationSummaryCards([
    {
      label: '活跃目录身份覆盖',
      value: `${nullableUnits(catalog.confirmedSkus, '未知')} / ${nullableUnits(catalog.totalSkus, '未知')}`,
      note: `覆盖率 ${coverageValue} · 缺少平台 SPU ${nullableUnits(catalog.missingSpuSkus, '未知')} 个；这是全量活跃目录口径，不依赖销量业务日。未确认 ${nullableUnits(catalog.unconfirmedSkus, '未知')} 个`,
      tone: catalog.coverageRate === 1 ? 'available' : 'partial',
    },
    {
      label: '证据覆盖（最新密封 run）',
      value: `${nullableUnits(evidence.sealedSetCount, '未知')} 组 / ${nullableUnits(evidence.observedStoreCount, '未知')} 店`,
      note: `标识符成员 ${nullableUnits(evidence.identifierMemberCount, '未知')} 条 · 最新密封 ${sourceTime(evidence.latestSealedAt)}`,
      tone: pipeline.status === 'available' ? 'available' : 'partial',
    },
    {
      label: '已确认归并与标准商品',
      value: `${nullableUnits(assignments.currentConfirmedCount, '未知')} / ${nullableUnits(canonical.globalActiveProductCount, '未知')}`,
      note: `当前生效 GLOBAL 归并数 / GLOBAL ACTIVE 标准商品数 · 活跃变体 ${nullableUnits(canonical.activeVariantCount, '未知')}`,
      tone: pipeline.status === 'available' ? 'available' : 'partial',
    },
    {
      label: '销量物化待归并队列',
      value: `${numberFormatter.format(isUnit(summary.matchedMaterializedPendingRows) ? summary.matchedMaterializedPendingRows : 0)} 条`,
      note: `${RANGE_META[state.range].label}影响 ${impactValue}${isUnit(impact.unknownCount) && impact.unknownCount > 0 ? `（${numberFormatter.format(impact.unknownCount)} 行未知，拒绝补零）` : ''} · 源物化 ${nullableUnits(pendingSource.returned, '未知')} / ${nullableUnits(pendingSource.total, '未知')}${pendingSource.truncated === true ? '，已截断' : ''}`,
      tone: isUnit(summary.matchedMaterializedPendingRows) && summary.matchedMaterializedPendingRows > 0
        ? 'partial'
        : 'available',
    },
  ]);
}

/** The real read-only pipeline: sealed evidence → candidate → decision → product. */
function productPipelineFlow(queryData) {
  const pipeline = productRecord(queryData.source?.pipeline);
  const evidence = productRecord(pipeline.evidence);
  const candidates = productRecord(pipeline.candidates);
  const decisions = productRecord(pipeline.decisions);
  const assignments = productRecord(pipeline.assignments);
  const canonical = productRecord(pipeline.canonical);
  const unknown = pipeline.status === 'unavailable';
  const stageValue = (value, unit) => (
    unknown || !isUnit(value) ? '未知' : `${numberFormatter.format(value)} ${unit}`
  );
  const stages = [
    [
      '密封证据集',
      `按店铺密封的观测集与标识符成员；平台 SPU/SKC/SKU 仅在店内为强标识。`,
      stageValue(evidence.sealedSetCount, '组'),
      sourceTime(evidence.latestSealedAt),
    ],
    [
      '候选生成',
      `同一 run 内的候选与推荐分布：确认 ${stageValue(candidates.confirmed, '条')} · 待提议 ${stageValue(candidates.proposed, '条')} · 需人工 ${stageValue(candidates.reviewRequired, '条')} · 冲突阻断 ${stageValue(candidates.blocked, '条')}。`,
      stageValue(candidates.total, '条'),
      sourceTime(candidates.latestEvaluatedAt),
    ],
    [
      '身份决策',
      `AUTO 与人工决策共用同一审计表；决策不等于当前生效归并。GLOBAL ${stageValue(candidates.globalScope, '条')} · 店内单例 ${stageValue(candidates.localSingletonScope, '条')}。`,
      stageValue(decisions.confirmedCount, '条'),
      sourceTime(decisions.latestDecidedAt),
    ],
    [
      '归并与标准商品',
      `只有 GLOBAL + CONFIRMED 的当前归并可跨店聚合；标准商品 ${stageValue(canonical.globalActiveProductCount, '个')} · 活跃变体 ${stageValue(canonical.activeVariantCount, '个')}。`,
      stageValue(assignments.currentConfirmedCount, '条'),
      sourceTime(assignments.latestAssignedAt),
    ],
  ];
  return `
    <section class="process-panel">
      ${panelHeading(
        'IDENTITY RESOLUTION',
        '身份归并流水线（只读）',
        unknown
          ? '身份归并证据当前不可用，四个阶段数量均显示未知，不显示 0'
          : `真实聚合计数 · ${String(pipeline.note || '')}`,
      )}
      <ol class="process-flow four-steps">
        ${stages.map(([title, description, value, freshness], index) => `
          <li>
            <span>${String(index + 1).padStart(2, '0')}</span>
            <div>
              <strong>${escapeHtml(title)}</strong>
              <p>${escapeHtml(description)}</p>
              <small class="stage-freshness">证据时间 ${escapeHtml(freshness)}</small>
            </div>
            <b>${escapeHtml(value)}</b>
          </li>`).join('')}
      </ol>
    </section>`;
}

function productPendingTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有待归并货号',
      '服务端在已物化范围内没有命中未确认店内身份；这不代表全量活跃目录已完成归并。',
    );
  }
  const visible = orderRowsForFocus(rows, 'product');
  return `
    <div class="table-wrap">
      <table class="data-table product-table pending-mapping-table" id="product-workspace-table" role="tabpanel" aria-labelledby="product-tab-PENDING">
        <caption class="sr-only">当前筛选命中的已物化待归并店内货号</caption>
        <thead><tr><th scope="col">店铺 / 负责人</th><th scope="col">店内货号</th><th scope="col">SPU / SKC / SKU</th><th scope="col">商品名称</th>${WINDOW_KEYS.map((key) => `<th scope="col" class="number-column">${escapeHtml(RANGE_META[key].label)}</th>`).join('')}<th scope="col" class="number-column">当前窗口影响</th><th scope="col">归并状态</th><th scope="col">身份边界</th><th scope="col">定位</th></tr></thead>
        <tbody>${visible.map((item) => `
          <tr class="${isFocusedRow(item, 'product') ? 'focused-row' : ''}">
            <td class="entity-column"><strong>${escapeHtml(item.storeCode || '店铺待确认')}</strong><span>${escapeHtml(`负责人 ${ownerNameForStoreCode(item.storeCode) || '待分配'}`)}</span></td>
            <td class="entity-column"><strong>${escapeHtml(item.supplierCode || item.supplierSku || item.productKey || '店内货号待确认')}</strong><span>${escapeHtml(item.supplierSku || '')}</span></td>
            <td class="entity-column"><strong>${escapeHtml(item.sku || 'SKU 待确认')}</strong><span>${escapeHtml([item.skc || 'SKC 待确认', item.productKey].filter(Boolean).join(' · '))}</span></td>
            <td>${escapeHtml(productName(item))}</td>
            ${WINDOW_KEYS.map((key) => `<td class="number-column">${formatUnits(item?.unitsSold?.[key])}</td>`).join('')}
            <td class="number-column">${formatUnits(item?.unitsSold?.[state.range])}</td>
            <td><span class="row-status partial">${escapeHtml(mappingStatusLabel(item.mappingStatus))}</span></td>
            <td class="boundary-cell"><span class="rank-identity local">店内身份</span><span>平台 SPU/SKC/SKU 仅在本店为强标识，禁止跨店按裸 SKU 合并</span></td>
            <td>${rowFocusLink(item, 'product')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">当前页显示 ${numberFormatter.format(visible.length)} 条，排序与分页由服务端决定。“—”表示该窗口未知而非 0；这些行始终保留“店铺 + 店内货号 / SKC / SKU”身份，不参与跨店标准商品合计。</p>`;
}

function productCanonicalTable(rows) {
  if (!rows.length) {
    return emptyEvidence(
      '当前筛选没有标准商品',
      '服务端在已物化范围内没有命中 GLOBAL + CONFIRMED 的跨店标准商品；未确认身份不会被当作标准商品展示。',
    );
  }
  const visible = orderRowsForFocus(rows, 'product');
  return `
    <div class="table-wrap">
      <table class="data-table product-table" id="product-workspace-table" role="tabpanel" aria-labelledby="product-tab-CANONICAL">
        <caption class="sr-only">当前筛选命中的已确认跨店标准商品</caption>
        <thead><tr><th scope="col">标准商品</th><th scope="col">覆盖店铺</th>${WINDOW_KEYS.map((key) => `<th scope="col" class="number-column">${escapeHtml(RANGE_META[key].label)}</th>`).join('')}<th scope="col">可比动量</th><th scope="col">确认边界</th><th scope="col">定位</th></tr></thead>
        <tbody>${visible.map((item) => {
          const scopedCount = isUnit(item.scopedStoreCount) ? item.scopedStoreCount : null;
          const totalCount = isUnit(item.totalStoreCount) ? item.totalStoreCount : null;
          const breakdown = Array.isArray(item.storeBreakdown) ? item.storeBreakdown : [];
          return `
          <tr class="${isFocusedRow(item, 'product') ? 'focused-row' : ''}">
            <td class="entity-column"><strong>${escapeHtml(item.standardProductCode || item.canonicalProductId || '标准商品待编号')}</strong><span>${escapeHtml(productName(item))}</span></td>
            <td class="entity-column"><strong>${escapeHtml(scopedCount === null ? '店铺数未知' : `${numberFormatter.format(scopedCount)} 家店`)}</strong><span>${escapeHtml(breakdown.slice(0, 4).map(({ storeCode }) => storeCode).join(' · ') || '店铺明细未知')}${breakdown.length > 4 ? ' …' : ''}</span></td>
            ${WINDOW_KEYS.map((key) => `<td class="number-column">${formatUnits(item?.unitsSold?.[key])}</td>`).join('')}
            ${homeMomentumCell(item)}
            <td class="boundary-cell"><span class="rank-identity canonical">GLOBAL 已确认</span><span>${escapeHtml(item.scopeRecomputed === true
              ? `已按当前范围重算：${scopedCount === null ? '店铺数未知' : `${numberFormatter.format(scopedCount)}`} / 全量 ${totalCount === null ? '未知' : numberFormatter.format(totalCount)} 家店`
              : '仅 GLOBAL + CONFIRMED 归并允许跨店合计')}</span></td>
            <td>${rowFocusLink(item, 'product')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">当前页显示 ${numberFormatter.format(visible.length)} 条。只有 GLOBAL + CONFIRMED 的当前归并参与跨店合计；任一店铺窗口未知时该窗口合计保持“—”，不补零。</p>`;
}

/** The scientific rules, stated as boundaries rather than fake process steps. */
function productIdentityBoundaries() {
  return `
    <section class="panel condition-panel">
      ${panelHeading('IDENTITY BOUNDARY', '身份判定边界（只读）', '强证据、召回信号与冲突阻断项分开表达；本页不提供任何合并、审批或编辑入口')}
      <ul class="condition-list">
        <li><strong>店内强标识</strong><span>平台 SPU、SKC、SKU 只在同一店铺内是强标识，跨店不成立</span></li>
        <li><strong>仅召回信号</strong><span>供应商编码、商家 SKU、标题与图片 URL 只用于生成候选，不作为归并证据</span></li>
        <li><strong>强证据</strong><span>有效 GTIN 与官方型号属性 1000546；品类、品牌与白名单规格只在严格策略下参与</span></li>
        <li><strong>冲突阻断</strong><span>电压、插头、容量、端子品类或关键尺寸冲突时禁止自动合并</span></li>
        <li><strong>聚合边界</strong><span>只有 GLOBAL + CONFIRMED 归并可跨店聚合，店内行始终隔离</span></li>
        <li><strong>写入能力</strong><span>本批不写 SHEIN，也不写归并与决策；所有控件保持只读</span></li>
      </ul>
    </section>`;
}
/* --- product-query:end --- */

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

function homePulseHref(route, quick = 'ALL', focus = null) {
  return serializeHashState({
    route,
    owner: state.owner,
    store: state.store,
    range: state.range,
    query: state.query,
    quick,
    focus,
    salesSort: state.sales.sort,
    productPage: 1,
    standardPage: 1,
  });
}

/* --- home-decision-summary:start ---
   Four evidence-backed decisions, each stating the fact, why it matters and
   where to prove it. Only quantity, coverage, supply and identity facts feed
   these cards; unknown, partial and legal zero stay distinguishable. */

/** Today against the last complete day, never hiding that today is partial. */
function pulseTodaySignal(units) {
  const today = units?.today;
  const yesterday = units?.yesterday;
  if (!isUnit(today)) {
    return {
      label: '今日 vs 昨日',
      value: '今日未知',
      why: '今日窗口缺少可信数量事实，不能当作 0 判断经营节奏。',
      evidence: `昨日 ${formatUnits(yesterday)} 件 · 今日仍在累计`,
      tone: 'attention',
      href: homePulseHref('system'),
      linkLabel: '核对覆盖与同步',
    };
  }
  if (!isUnit(yesterday)) {
    return {
      label: '今日 vs 昨日',
      value: `今日 ${formatUnits(today)} 件`,
      why: '缺完整昨日窗口，今日只能单独看累计量，不做增降结论。',
      evidence: '昨日窗口不可比 · 今日仍在累计，尚未走完整日',
      tone: 'attention',
      href: homePulseHref('sales'),
      linkLabel: '查看销量明细',
    };
  }
  const delta = formatDelta(today, yesterday);
  return {
    label: '今日 vs 昨日',
    value: `${formatUnits(today)} 件 · ${delta}`,
    why: '今日仍在累计，与已走完的昨日相比只能作为进度参考，不能直接当作增降结论。',
    evidence: `昨日 ${formatUnits(yesterday)} 件 · 今日为当日累计，非完整自然日`,
    tone: '',
    href: homePulseHref('sales'),
    linkLabel: '查看销量明细',
  };
}

/** Rolling 7-day daily average against the prior 23 days, only when comparable. */
function pulseMomentumSignal(units) {
  const signal = comparableDailySignal({ unitsSold: units });
  if (signal.recent === null) {
    return {
      label: '近 7 日日均 vs 此前 23 日日均',
      value: '不可比',
      why: '缺少完整的近 7 日或近 30 日窗口时，任何日均对比都会失真。',
      evidence: '近 7 日或此前 23 日窗口不完整 · 不用其他窗口替代',
      tone: 'attention',
      href: homePulseHref('sales'),
      linkLabel: '查看销量窗口',
    };
  }
  return {
    label: '近 7 日日均 vs 此前 23 日日均',
    value: signal.label,
    why: '这是当前唯一同口径的趋势判断：两侧都是滚动窗口日均，不受今日未走完影响。',
    evidence: `近 7 日日均 ${formatDailyAverage(signal.recent)} 件 · 此前 23 日日均 ${formatDailyAverage(signal.previous)} 件 · 滚动窗口不是历史时间序列`,
    tone: signal.tone === 'blocked' ? 'attention' : '',
    href: homePulseHref('sales', signal.tone === 'blocked' ? 'DECLINING' : 'GROWING'),
    linkLabel: signal.tone === 'blocked' ? '查看下降货号' : '查看增长货号',
  };
}

/** Supply urgency from current shortage, urgent, purchase and delivery facts. */
function pulseSupplySignal() {
  const inventoryRisks = scopedOperationRows(attentionRows('inventoryRisks'));
  const adviceRisks = scopedOperationRows(attentionRows('stockAdviceRisks'));
  const purchaseRows = scopedOperationRows(attentionRows('purchaseOrderAttention'));
  const deliveryRows = scopedOperationRows(attentionRows('deliveryAttention'));
  const shortageRows = inventoryRisks.filter(
    (row) => isUnit(row.shortageQuantity) && row.shortageQuantity > 0,
  );
  const urgentRows = adviceRisks.filter(
    (row) => isUnit(row.plannedUrgentQuantity) && row.plannedUrgentQuantity > 0,
  );
  const shortageMetric = riskWindowMetric(shortageRows, 'inventoryRisks', 'shortageQuantity');
  const urgentMetric = riskWindowMetric(urgentRows, 'stockAdviceRisks', 'plannedUrgentQuantity');
  const purchaseMetric = riskWindowMetric(purchaseRows, 'purchaseOrders', null, '条');
  const deliveryMetric = riskWindowMetric(deliveryRows, 'deliveries', null, '条');
  const hasInventoryDetail = attentionEvidence('inventoryRisks');
  const hasAdviceDetail = attentionEvidence('stockAdviceRisks');
  const urgentTotal = shortageRows.length + urgentRows.length;
  const value = hasInventoryDetail || hasAdviceDetail
    ? `缺货 ${shortageMetric.countLabel} · 急采 ${urgentMetric.countLabel}`
    : '明细待接入';
  return {
    label: '供给紧迫度',
    value,
    why: '缺货和急采直接决定要不要今天补单；采购与交付关注决定在途能否接上。',
    evidence: [
      `采购关注 ${purchaseMetric.countLabel} · 交付关注 ${deliveryMetric.countLabel}`,
      shortageMetric.note,
      '仅统计已物化明细，未命中不等于无风险',
    ].filter(Boolean).join(' · '),
    tone: urgentTotal > 0 ? 'attention' : '',
    href: homePulseHref('inventory', shortageRows.length ? 'SHORTAGE' : urgentRows.length ? 'URGENT' : 'ALL'),
    linkLabel: '进入库存与备货工作台',
  };
}

/** Same-day store coverage, identity confirmation and source freshness. */
function pulseTrustSignal() {
  const coverage = state.data?.salesCoverage || {};
  const quality = qualityState();
  const identity = identityCoverage();
  const covered = coverage.coveredStores;
  const total = coverage.totalStores;
  const sameDay = isUnit(covered) && isUnit(total)
    ? `当日覆盖 ${numberFormatter.format(covered)} / ${numberFormatter.format(total)} 家店`
    : '当日店铺覆盖待确认';
  const reasons = [
    isUnit(coverage.mixedStatisticsDateStores) && coverage.mixedStatisticsDateStores > 0
      ? `${numberFormatter.format(coverage.mixedStatisticsDateStores)} 家店统计日混合`
      : '',
    isUnit(coverage.quarantinedRows) && coverage.quarantinedRows > 0
      ? `${numberFormatter.format(coverage.quarantinedRows)} 行被隔离`
      : '',
  ].filter(Boolean);
  return {
    label: '数据与身份可信度',
    value: `${coverageLabel()} · ${quality.label}`,
    why: '覆盖不全或身份未归并时，排行和合计只能当作部分事实，不能当经营结论。',
    evidence: [
      sameDay,
      reasons.length ? reasons.join(' · ') : '未发现统计日混合或隔离行',
      `标准身份 ${numberFormatter.format(identity.confirmed)} / ${numberFormatter.format(identity.total)} 已确认`,
      `事实业务日 ${businessDate() || '待确认'} · 数据生成 ${formatDateTime(state.data?.updatedAt)}`,
    ].filter(Boolean).join(' · '),
    tone: ['healthy', 'complete', 'legal_zero'].includes(quality.status) ? '' : 'attention',
    href: homePulseHref('system'),
    linkLabel: '查看数据健康',
  };
}

function pulseCard(signal) {
  return `
    <a href="${escapeHtml(signal.href)}" class="pulse-card${signal.tone ? ` ${escapeHtml(signal.tone)}` : ''}">
      <span>${escapeHtml(signal.label)}</span>
      <strong>${escapeHtml(signal.value)}</strong>
      <em class="pulse-why">${escapeHtml(signal.why)}</em>
      <small>${escapeHtml(signal.evidence)}</small>
      <b class="pulse-link">${escapeHtml(signal.linkLabel)} →</b>
    </a>`;
}

function homeBusinessPulse() {
  const units = scopedUnits().units;
  const signals = [
    pulseTodaySignal(units),
    pulseMomentumSignal(units),
    pulseSupplySignal(),
    pulseTrustSignal(),
  ];
  return `
    <section class="business-pulse" aria-label="经营决策摘要">
      <div class="business-pulse-head">
        <div>
          <span class="eyebrow">OPERATING PULSE</span>
          <h2>今日经营简报</h2>
        </div>
        <p>每张卡给出事实、为何关注和证据入口；金额、消费者订单和未知值不参与推导，合法 0 与未知分开表达。</p>
      </div>
      <div class="business-pulse-grid">
        ${signals.map(pulseCard).join('')}
      </div>
    </section>`;
}
/* --- home-decision-summary:end --- */

/* --- home-ranking-tables:start ---
   Two operational ranking tables replace the four single-window ranking cards.
   Every row shows all four quantity windows plus the only comparable momentum
   signal, its data-quality or identity boundary, and a scope-preserving
   drilldown. Nothing is aggregated across identities that cannot be merged. */

const HOME_RANK_LIMIT = 8;

/** Rank by the active window, keeping unknown windows out of the ordering. */
function homeRankedRows(items, windowKey = homeRankingWindow().key) {
  return items
    .filter((item) => isUnit(item?.unitsSold?.[windowKey]))
    .sort((left, right) => right.unitsSold[windowKey] - left.unitsSold[windowKey])
    .slice(0, HOME_RANK_LIMIT);
}

function homeWindowCells(item) {
  const windowKey = homeRankingWindow().key;
  return WINDOW_KEYS
    .map((key) => `<td class="number-column${key === windowKey ? ' current-window' : ''}">${formatUnits(item?.unitsSold?.[key])}</td>`)
    .join('');
}

/* Magnitude bar: a restrained tiered fill for the active window, driven only
   by CSS tier classes — never inline styles, never a gradient. */
const HOME_METER_TIERS = 20;

function homeMagnitudeCell(item, maximum) {
  const value = item?.unitsSold?.[homeRankingWindow().key];
  if (!isUnit(value) || !Number.isFinite(maximum) || maximum <= 0) {
    return '<td class="meter-cell"><span class="rank-meter rank-meter-empty" role="img" aria-label="当前窗口未知，不画量级条"></span></td>';
  }
  const tier = Math.max(1, Math.min(HOME_METER_TIERS, Math.ceil((value / maximum) * HOME_METER_TIERS)));
  return `<td class="meter-cell"><span class="rank-meter" role="img" aria-label="当前窗口量级 ${tier} / ${HOME_METER_TIERS} 档"><i class="rank-meter-fill rank-meter-t${tier}"></i></span></td>`;
}

function homeMomentumCell(item) {
  const signal = comparableDailySignal(item);
  const detail = signal.recent === null
    ? '缺完整窗口'
    : `${formatDailyAverage(signal.recent)} / ${formatDailyAverage(signal.previous)} 件·日`;
  return `<td class="boundary-cell"><span class="row-status ${escapeHtml(signal.tone)}">${escapeHtml(signal.label)}</span><span>${escapeHtml(detail)}</span></td>`;
}

/** Store-level quality wording; a legal zero never reads as missing data. */
function homeStoreQualityCell(item) {
  const status = String(item?.qualityStatus || '');
  const label = ({
    healthy: '完整覆盖',
    legal_zero: '合法零销量',
    partial: '部分覆盖',
    stale: '数据已过期',
    error: '数据异常',
    unavailable: '未接入',
  })[status] || '覆盖待确认';
  const businessDay = item?.businessDate || businessDate() || '待确认';
  return `<td class="boundary-cell"><span class="row-status ${escapeHtml(qualityTone(status))}">${escapeHtml(label)}</span><span>${escapeHtml(`业务日 ${businessDay}`)}</span></td>`;
}

/** Row body click: narrow the home scope in place, keeping range and query. */
function homeStoreScopeHref(item) {
  return serializeHashState({
    route: 'home',
    owner: state.owner,
    store: String(item?.code || '').toUpperCase(),
    range: state.range,
    query: state.query,
    quick: 'ALL',
  });
}

/** Explicit drilldown keeps the current owner, range and query — never resets owner to ALL. */
function homeStoreDrilldownHref(item) {
  return serializeHashState({
    route: 'sales',
    owner: state.owner,
    store: String(item?.code || '').toUpperCase(),
    range: state.range,
    query: state.query,
    quick: 'ALL',
    salesSort: state.sales.sort,
    productPage: 1,
    standardPage: 1,
  });
}

/** Row body click: filter home in place to this product code. */
function homeProductScopeHref(item) {
  return serializeHashState({
    route: 'home',
    owner: state.owner,
    store: state.store,
    range: state.range,
    query: productCode(item, isCanonicalProduct(item)),
    quick: 'ALL',
  });
}

function homeProductDrilldownHref(item) {
  const code = focusCodeFor(item, 'product');
  return serializeHashState({
    route: 'products',
    owner: state.owner,
    store: state.store,
    range: state.range,
    query: state.query,
    quick: 'ALL',
    focus: code === '' ? null : { domain: 'product', storeCode: item?.storeCode || '', code },
  });
}

function homeStoreRankingTable(rows) {
  const windowKey = homeRankingWindow().key;
  const ranked = homeRankedRows(rows);
  if (!ranked.length) {
    return emptyEvidence('店铺排行不可用', homeRankingEmptyMessage('store'));
  }
  const maximum = Math.max(1, ...ranked.map((item) => item.unitsSold[windowKey]));
  return `
    <div class="table-wrap">
      <table class="data-table home-rank-table">
        <caption class="sr-only">按当前窗口排序的店铺销量，含四个窗口、量级与可比动量</caption>
        <thead><tr><th scope="col">店铺 / 负责人</th>${WINDOW_KEYS.map((key) => `<th scope="col" class="number-column${key === windowKey ? ' current-window' : ''}">${escapeHtml(RANGE_META[key].label)}</th>`).join('')}<th scope="col">量级</th><th scope="col">可比动量</th><th scope="col">数据质量 / 覆盖</th><th scope="col">下钻</th></tr></thead>
        <tbody>${ranked.map((item) => `
          <tr>
            <td class="entity-column"><a class="rank-entity" href="${escapeHtml(homeStoreScopeHref(item))}"><strong>${escapeHtml(item.name || item.code || '店铺待确认')}</strong><span>${escapeHtml(`${item.code || '编码未知'} · 负责人 ${ownerNameForStore(item) || '—'}`)}</span></a></td>
            ${homeWindowCells(item)}
            ${homeMagnitudeCell(item, maximum)}
            ${homeMomentumCell(item)}
            ${homeStoreQualityCell(item)}
            <td><a class="text-link" href="${escapeHtml(homeStoreDrilldownHref(item))}">查看明细 →</a></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function homeProductRankingTable(rows) {
  const windowKey = homeRankingWindow().key;
  const ranked = homeRankedRows(rows);
  if (!ranked.length) {
    return emptyEvidence('商品排行不可用', homeRankingEmptyMessage('sku'));
  }
  const maximum = Math.max(1, ...ranked.map((item) => item.unitsSold[windowKey]));
  return `
    <div class="table-wrap">
      <table class="data-table home-rank-table">
        <caption class="sr-only">按当前窗口排序的货号销量，标准商品与店内身份分开</caption>
        <thead><tr><th scope="col">货号 / 商品</th>${WINDOW_KEYS.map((key) => `<th scope="col" class="number-column${key === windowKey ? ' current-window' : ''}">${escapeHtml(RANGE_META[key].label)}</th>`).join('')}<th scope="col">量级</th><th scope="col">可比动量</th><th scope="col">身份边界</th><th scope="col">下钻</th></tr></thead>
        <tbody>${ranked.map((item) => {
          const canonical = isCanonicalProduct(item);
          const boundary = canonical
            ? (isUnit(item.storeCount) ? `跨店 ${numberFormatter.format(item.storeCount)} 店可合计` : '跨店标准商品')
            : (item.storeCode ? `店铺 ${item.storeCode} 内身份，禁止跨店合并` : '店内身份待确认');
          return `
          <tr>
            <td class="entity-column"><a class="rank-entity" href="${escapeHtml(homeProductScopeHref(item))}"><strong>${escapeHtml(productCode(item, canonical))}</strong><span>${escapeHtml(productName(item))}</span></a></td>
            ${homeWindowCells(item)}
            ${homeMagnitudeCell(item, maximum)}
            ${homeMomentumCell(item)}
            <td class="boundary-cell"><span class="rank-identity ${canonical ? 'canonical' : 'local'}">${canonical ? '标准商品' : '店内身份'}</span><span>${escapeHtml(boundary)}</span></td>
            <td><a class="text-link" href="${escapeHtml(homeProductDrilldownHref(item))}">查看明细 →</a></td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}
/* --- home-ranking-tables:end --- */

/** One compact caliber footnote plus the entries into the other workspaces. */
function homeFootnote() {
  return `
    <footer class="home-footnote" aria-label="口径脚注与其他业务页面入口">
      <p>口径：仅统计销量数量事实；未知为 —，合法零为 0，缺失不补零、不插值；四个窗口独立取数，不跨业务日混算；财务与结算、流量、订单等指标尚未接入，不由销量推导金额。</p>
      <nav class="home-footnote-links" aria-label="其他业务页面入口">
        <a href="${escapeHtml(homePulseHref('sales'))}">销量分析</a>
        <a href="${escapeHtml(homePulseHref('products'))}">商品分析</a>
        <a href="#inventory">库存与备货</a>
        <a href="#procurement">采购单</a>
        <a href="#fulfilment">交付入仓</a>
        <a href="#platform">平台动态</a>
        <a href="#ops">运营工具</a>
        <a href="#system">系统管理</a>
      </nav>
    </footer>`;
}

function finiteMetric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function homeHistory() {
  const source = state.data?.home;
  return source && typeof source === 'object'
    ? source
    : { status: 'unavailable', storeDaily: [], productDaily: [], regionDaily: [], coverage: {} };
}

function homeDateInRange(date, range = selectedHomeDateRange()) {
  return typeof date === 'string' && date >= range.start && date <= range.end;
}

function homeBaseStoreCodes() {
  const selected = selectedStore();
  const owner = selectedOwner();
  return new Set(
    baseStores()
      .filter((store) => !selected || store.code === selected.code)
      .filter((store) => !owner || storeMatchesOwner(store))
      .map(({ code }) => String(code)),
  );
}

function homeStoreSearchMatches() {
  const query = normalizedQuery();
  if (!query) return new Set();
  return new Set(baseStores().filter((store) => [
    store.code,
    store.name,
    ownerNameForStore(store),
  ].filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase('zh-CN').includes(query))
    .map(({ code }) => String(code)));
}

function homeProductSearchMatch(row) {
  const query = normalizedQuery();
  if (!query) return true;
  return [
    row.productKey,
    row.platformSpuId,
    row.platformSkcId,
    row.supplierCode,
    row.supplierSku,
    row.displayName,
    row.storeCode,
  ].filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase('zh-CN').includes(query);
}

function homeScopedRows(range = selectedHomeDateRange()) {
  const history = homeHistory();
  const baseCodes = homeBaseStoreCodes();
  const storeMatches = homeStoreSearchMatches();
  const query = normalizedQuery();
  const effectiveCodes = query && storeMatches.size > 0
    ? new Set([...baseCodes].filter((code) => storeMatches.has(code)))
    : baseCodes;
  const storeDaily = (Array.isArray(history.storeDaily) ? history.storeDaily : [])
    .filter((row) => effectiveCodes.has(String(row.storeCode)))
    .filter((row) => homeDateInRange(row.date, range));
  const productCandidates = (Array.isArray(history.productDaily) ? history.productDaily : [])
    .filter((row) => baseCodes.has(String(row.storeCode)))
    .filter((row) => homeDateInRange(row.date, range));
  const matchingProducts = query
    ? productCandidates.filter(homeProductSearchMatch)
    : productCandidates;
  const productMode = Boolean(query && storeMatches.size === 0 && matchingProducts.length > 0);
  const productDaily = productMode
    ? matchingProducts
    : productCandidates.filter((row) => effectiveCodes.has(String(row.storeCode)));
  const regionDaily = (Array.isArray(history.regionDaily) ? history.regionDaily : [])
    .filter((row) => effectiveCodes.has(String(row.storeCode)))
    .filter((row) => homeDateInRange(row.date, range));
  return {
    storeDaily,
    productDaily,
    regionDaily,
    storeCodes: effectiveCodes,
    productMode,
  };
}

function dateSpanDays(range) {
  const start = new Date(`${range.start}T00:00:00.000Z`);
  const end = new Date(`${range.end}T00:00:00.000Z`);
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function previousHomeDateRange(range = selectedHomeDateRange()) {
  const days = dateSpanDays(range);
  return {
    start: shiftIsoDate(range.start, -days),
    end: shiftIsoDate(range.start, -1),
    custom: true,
  };
}

function completeMetricSum(rows, key) {
  if (!rows.length) return null;
  const values = rows.map((row) => row?.[key]);
  if (values.some((value) => !finiteMetric(value))) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) ? total : null;
}

function availableMetricSum(rows, key) {
  const values = rows.map((row) => row?.[key]).filter(finiteMetric);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function periodMetric(bundle, key) {
  if (bundle.productMode) {
    if (key === 'salesQuantity') return completeMetricSum(bundle.productDaily, 'salesQuantity');
    if (key === 'dealAmount') return completeMetricSum(bundle.productDaily, 'estimatedDealAmount');
    return null;
  }
  return completeMetricSum(bundle.storeDaily, key);
}

function metricComparison(current, previous) {
  if (!finiteMetric(current) || !finiteMetric(previous)) return '—';
  if (previous === 0) return current === 0 ? '持平' : '新增';
  const change = ((current - previous) / previous) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
}

function formatMoney(value, currency = 'SAR') {
  if (!finiteMetric(value)) return '—';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

function homeTopRegion(bundle) {
  const grouped = new Map();
  for (const row of bundle.regionDaily) {
    const current = grouped.get(row.regionKey) || {
      name: row.regionName,
      salesQuantity: 0,
      complete: true,
    };
    if (!isUnit(row.salesQuantity)) current.complete = false;
    else current.salesQuantity += row.salesQuantity;
    grouped.set(row.regionKey, current);
  }
  return [...grouped.values()]
    .filter(({ complete }) => complete)
    .sort((left, right) => right.salesQuantity - left.salesQuantity)[0] ?? null;
}

function historyMetricRows() {
  const range = selectedHomeDateRange();
  const current = homeScopedRows(range);
  const previous = homeScopedRows(previousHomeDateRange(range));
  const rows = [
    ['成交金额', 'dealAmount', 'money', current.productMode ? '按已匹配货号单价估算' : 'WebAPI 经营指标'],
    ['净成交金额', 'netDealAmount', 'money', 'WebAPI 经营指标'],
    ['支付人数', 'buyerCount', 'count', '支付买家去重人数'],
    ['销量', 'salesQuantity', 'count', current.productMode ? '按匹配货号汇总' : '成交件数'],
    ['曝光量', 'exposureUsers', 'count', '多品牌求和时标注非店铺去重'],
    ['商详访客', 'goodsDetailVisitors', 'count', '商品详情页访客'],
    ['备货订单数', 'stockingOrderCount', 'count', '备货订单'],
    ['集采订单数', 'urgentPurchaseOrderCount', 'count', 'SHEIN 字段 jcOrdCnt1d'],
    ['新客销量', 'newCustomerSalesQuantity', 'count', '能力未返回时保持 —'],
    ['新客支付订单数', 'newCustomerPaymentOrderCount', 'count', '能力未返回时保持 —'],
  ].map(([label, key, type, note]) => {
    const value = periodMetric(current, key);
    const baseline = periodMetric(previous, key);
    return {
      label,
      key,
      value,
      baseline,
      display: type === 'money' ? formatMoney(value) : formatUnits(value),
      baselineDisplay: type === 'money' ? formatMoney(baseline) : formatUnits(baseline),
      change: metricComparison(value, baseline),
      note,
    };
  });
  return { range, current, previous, rows, topRegion: homeTopRegion(current) };
}

function homeMetricTable(title, subtitle, metrics) {
  return `
    <article class="overview-matrix-card home-history-card">
      <div class="matrix-card-head"><h4>${escapeHtml(title)}</h4><div class="sub">${escapeHtml(subtitle)}</div></div>
      <div class="metric-matrix-scroll">
        <table class="metric-matrix home-history-matrix">
          <thead><tr><th>指标</th><th>当前区间</th><th>上个等长区间</th><th>变化</th><th>口径</th></tr></thead>
          <tbody>${metrics.map((metric) => `
            <tr>
              <th scope="row">${escapeHtml(metric.label)}</th>
              <td class="num"><strong>${escapeHtml(metric.display)}</strong></td>
              <td class="num">${escapeHtml(metric.baselineDisplay)}</td>
              <td class="num">${escapeHtml(metric.change)}</td>
              <td class="note">${escapeHtml(metric.note)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </article>`;
}

function renderHistoryKpis() {
  const summary = historyMetricRows();
  const rangeLabel = `${summary.range.start} → ${summary.range.end}`;
  const region = summary.topRegion;
  return `
    <section class="home-kpi home-history-kpis" aria-label="全托关键经营数据">
      <header class="home-block-head">
        <div><span class="eyebrow">BUSINESS OVERVIEW</span><h2>关键经营数据</h2></div>
        <p>${escapeHtml(`${rangeLabel} · ${summary.current.productMode ? '货号搜索范围' : `${summary.current.storeCodes.size} 家店`} · 未返回字段保持 —`)}</p>
      </header>
      <div class="home-history-card-stack">
        ${homeMetricTable('成交与支付', '金额、买家与销量', summary.rows.slice(0, 4))}
        ${homeMetricTable('流量表现', '曝光与商详访问', summary.rows.slice(4, 6))}
        ${homeMetricTable('供给与新客', '备货、集采与新客结构', summary.rows.slice(6))}
      </div>
      <article class="home-region-summary">
        <span>销量 Top 主销地区</span>
        <strong>${escapeHtml(region?.name || '—')}</strong>
        <small>${region ? `${formatUnits(region.salesQuantity)} 件 · 当前筛选区间` : '地区能力尚未取得可靠结果，不用店铺站点冒充'}</small>
      </article>
    </section>`;
}

function groupHistoryByDate(bundle) {
  const source = bundle.productMode ? bundle.productDaily : bundle.storeDaily;
  const quantityKey = 'salesQuantity';
  const amountKey = bundle.productMode ? 'estimatedDealAmount' : 'dealAmount';
  const grouped = new Map();
  for (const row of source) {
    const current = grouped.get(row.date) || { date: row.date, rows: [] };
    current.rows.push(row);
    grouped.set(row.date, current);
  }
  return [...grouped.values()].sort((left, right) => left.date.localeCompare(right.date)).map((item) => ({
    date: item.date,
    salesQuantity: completeMetricSum(item.rows, quantityKey),
    dealAmount: completeMetricSum(item.rows, amountKey),
  }));
}

function groupHistoryByMonth(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    const current = grouped.get(month) || { date: month, rows: [] };
    current.rows.push(row);
    grouped.set(month, current);
  }
  return [...grouped.values()].sort((left, right) => left.date.localeCompare(right.date)).map((item) => ({
    date: item.date,
    salesQuantity: completeMetricSum(item.rows, 'salesQuantity'),
    dealAmount: completeMetricSum(item.rows, 'dealAmount'),
  }));
}

function historySparkline(rows, key, { money = false } = {}) {
  const visible = rows.filter((row) => finiteMetric(row[key]));
  if (!visible.length) {
    return emptyEvidence('当前指标暂无趋势', '所选日期范围没有完整的日粒度事实，缺失不补零、不连线。');
  }
  const width = 980;
  const height = 236;
  const left = 58;
  const right = 18;
  const top = 18;
  const bottom = 42;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const max = Math.max(1, ...visible.map((row) => row[key]));
  const points = visible.map((row, index) => ({
    ...row,
    x: left + (visible.length === 1 ? innerWidth / 2 : (innerWidth * index) / (visible.length - 1)),
    y: top + innerHeight - ((row[key] / max) * innerHeight),
  }));
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const valueLabel = (value) => money ? formatMoney(value) : `${formatUnits(value)} 件`;
  return `
    <div class="trend-chart home-history-chart">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(`${points[0].date} 至 ${points.at(-1).date} 趋势`)}">
        ${[1, 0.5, 0].map((ratio) => {
          const y = top + innerHeight - innerHeight * ratio;
          return `<line class="chart-grid" x1="${left}" y1="${y.toFixed(1)}" x2="${left + innerWidth}" y2="${y.toFixed(1)}"></line>
            <text class="chart-axis chart-axis-end" x="${left - 8}" y="${(y + 4).toFixed(1)}">${escapeHtml(money ? new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(max * ratio) : numberFormatter.format(Math.round(max * ratio)))}</text>`;
        }).join('')}
        <path class="chart-line" d="${path}"></path>
        ${points.map((point) => `<circle class="chart-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4" tabindex="0" data-tip="${escapeHtml(`${point.date} · ${valueLabel(point[key])}`)}"></circle>`).join('')}
        <text class="chart-axis" x="${left}" y="${height - 12}">${escapeHtml(points[0].date)}</text>
        <text class="chart-axis chart-axis-end" x="${left + innerWidth}" y="${height - 12}">${escapeHtml(points.at(-1).date)}</text>
      </svg>
    </div>`;
}

function renderHistoryTrends() {
  const daily = groupHistoryByDate(homeScopedRows());
  const monthly = groupHistoryByMonth(daily);
  const trendPanel = (title, rows, note) => `
    <article class="panel trend-panel home-history-trend-panel">
      <header class="home-trend-heading"><div><span class="eyebrow">TREND</span><h4>${escapeHtml(title)}</h4></div><p>${escapeHtml(note)}</p></header>
      <div class="history-trend-metric"><h5>成交金额${homeScopedRows().productMode ? '（估算）' : ''}</h5>${historySparkline(rows, 'dealAmount', { money: true })}</div>
      <div class="history-trend-metric"><h5>销量</h5>${historySparkline(rows, 'salesQuantity')}</div>
    </article>`;
  return `
    <div class="trend-stack home-trend-stack home-history-trends">
      ${trendPanel('日趋势', daily, `${selectedHomeDateRange().start} → ${selectedHomeDateRange().end} · 按业务日`)}
      ${trendPanel('月趋势', monthly, '按日粒度事实归入自然月；不完整月份不补齐')}
    </div>`;
}

function aggregateHistoryRanking(rows, identity, metricKey) {
  const grouped = new Map();
  for (const row of rows) {
    const key = identity.key(row);
    if (!key) continue;
    const item = grouped.get(key) || { key, label: identity.label(row), sub: identity.sub(row), rows: [] };
    item.rows.push(row);
    grouped.set(key, item);
  }
  return [...grouped.values()].map((item) => ({
    ...item,
    value: completeMetricSum(item.rows, metricKey),
  })).filter(({ value }) => finiteMetric(value))
    .sort((left, right) => right.value - left.value)
    .slice(0, HOME_RANK_LIMIT);
}

function historyRankTable(title, note, rows, { money = false, estimated = false } = {}) {
  return `
    <article class="panel home-history-rank-card">
      <header><div><span class="eyebrow">RANKING</span><h4>${escapeHtml(title)}</h4></div><p>${escapeHtml(note)}</p></header>
      ${rows.length ? `<div class="table-wrap"><table class="data-table compact-rank-table">
        <thead><tr><th>#</th><th>对象</th><th class="number-column">${money ? '金额' : '销量'}</th></tr></thead>
        <tbody>${rows.map((row, index) => `<tr>
          <td class="rank-index">${index + 1}</td>
          <td class="entity-column"><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.sub || '')}</span></td>
          <td class="number-column"><strong>${escapeHtml(money ? formatMoney(row.value) : formatUnits(row.value))}</strong>${estimated ? '<small>估算</small>' : money ? '' : '<small>件</small>'}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyEvidence('当前排行暂无数据', '所选日期和范围内没有完整可排序事实。')}
    </article>`;
}

function renderHistoryRankings() {
  const bundle = homeScopedRows();
  const storeIdentity = {
    key: (row) => row.storeCode,
    label: (row) => baseStores().find(({ code }) => code === row.storeCode)?.name || row.storeCode,
    sub: (row) => {
      const store = baseStores().find(({ code }) => code === row.storeCode);
      return [row.storeCode, ownerNameForStore(store)].filter(Boolean).join(' · ');
    },
  };
  const productIdentity = {
    key: (row) => `${row.storeCode}:${row.productGrain}:${row.productKey}`,
    label: (row) => row.supplierCode || row.supplierSku || row.productKey,
    sub: (row) => [row.displayName, row.storeCode].filter(Boolean).join(' · '),
  };
  const storeAmount = aggregateHistoryRanking(bundle.storeDaily, storeIdentity, 'dealAmount');
  const storeQuantity = aggregateHistoryRanking(bundle.storeDaily, storeIdentity, 'salesQuantity');
  const productAmount = aggregateHistoryRanking(bundle.productDaily, productIdentity, 'estimatedDealAmount');
  const productQuantity = aggregateHistoryRanking(bundle.productDaily, productIdentity, 'salesQuantity');
  const range = selectedHomeDateRange();
  const note = `${range.start} → ${range.end} · 当前筛选联动`;
  return `
    <section class="home-history-rankings" aria-label="经营排行榜">
      <header class="home-block-head"><div><span class="eyebrow">TOP PERFORMANCE</span><h2>经营排行榜</h2></div><p>${escapeHtml(note)}</p></header>
      <div class="home-rank-grid">
        ${historyRankTable('店铺成交金额排行', note, storeAmount, { money: true })}
        ${historyRankTable('店铺销量排行', note, storeQuantity)}
        ${historyRankTable('货号成交金额排行（估算）', '销量 × 最新财务单价证据；无匹配单价则不入榜', productAmount, { money: true, estimated: true })}
        ${historyRankTable('货号销量排行', note, productQuantity)}
      </div>
    </section>`;
}

function renderHistoryHomeHeader() {
  const history = homeHistory();
  const range = selectedHomeDateRange();
  const rows = homeScopedRows(range);
  const scope = selectedStore()
    ? `${selectedStore().code} · ${selectedStore().name || selectedStore().code}`
    : selectedOwner()
      ? `${selectedOwner().name}负责店铺`
      : '全部店铺';
  return `
    <header class="home-topbar home-verdict home-history-header">
      <div class="home-topbar-main">
        <span class="eyebrow">FULL-MANAGED BUSINESS INTELLIGENCE</span>
        <h1>全托经营总览</h1>
        <p class="verdict-primary">${escapeHtml(`${range.start} → ${range.end} · ${scope}`)}</p>
        <p class="verdict-secondary">${escapeHtml(rows.productMode ? '当前为货号搜索范围：销量与金额按命中货号汇总，店铺级人数、流量和订单指标保持未知。' : '首页所有指标、趋势和排行使用同一日期与店铺范围；未知不补零。')}</p>
      </div>
      <dl class="home-topbar-facts">
        <div><dt>历史覆盖</dt><dd>${escapeHtml(history.coverage?.earliestDate && history.coverage?.latestDate ? `${history.coverage.earliestDate} → ${history.coverage.latestDate}` : '待回填')}</dd></div>
        <div><dt>当前事实行</dt><dd>${numberFormatter.format(rows.storeDaily.length)} 店日 · ${numberFormatter.format(rows.productDaily.length)} 货号日</dd></div>
        <div><dt>最近入仓</dt><dd>${escapeHtml(formatDateTime(history.coverage?.latestObservedAt))}</dd></div>
        <div class="home-topbar-state"><dt>数据状态</dt><dd><span class="source-chip ${history.status === 'available' ? 'live' : 'empty'}">${history.status === 'available' ? '历史事实可用' : history.status === 'empty' ? '等待历史数据' : '历史表未接入'}</span></dd></div>
      </dl>
    </header>`;
}

/* Vertical order is fixed: A 首屏经营结论 → B 销量 KPI 数据矩阵 →
   C 日销量趋势 → D 月销量趋势 → E 店铺经营排行 → F 货号/商品经营排行 →
   口径脚注与业务入口。首页噪音（pulse、supply radar、运营提醒）不再参与组装，
   相关函数保留给其他路由使用。 */
function renderHome() {
  return `
    ${renderHistoryHomeHeader()}
    ${renderHistoryKpis()}
    ${renderHistoryTrends()}
    ${renderHistoryRankings()}
    <footer class="home-footnote"><p>口径：成交金额为 WebAPI 经营指标；货号金额为“销量 × 最新财务报表单价”的估算值并单独标识；曝光若来自品牌行求和则不是店铺去重人数；未知显示 —，不会补 0。</p></footer>`;
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

function salesTable(kind, rowsOverride = null, pagination = null) {
  const isStore = kind === 'store';
  const isStandard = kind === 'standard';
  const rows = rowsOverride || (isStore ? storeRowsForTable() : skuRowsForTable());
  if (!rows.length) return emptyEvidence(
    isStore ? '店铺销量表暂无可用行' : isStandard ? '标准商品销量表暂无可用行' : '商品销量表暂无可用行',
    dimensionBoundary(kind),
  );
  const visibleRows = rows;

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
    <p class="table-note">* 破折号表示该窗口未接入或不完整，不表示销量为 0。日均变化使用“近 7 日日均”对比“此前 23 日日均”；低基数增长不展示夸张百分比。当前页显示 ${numberFormatter.format(visibleRows.length)} 条${pagination && isUnit(pagination.matchedMaterializedRows) ? `，已物化范围命中 ${numberFormatter.format(pagination.matchedMaterializedRows)} 条` : ''}；店内商品身份不会跨店按裸 SKU 合并。</p>`;
}

function renderSales() {
  if (state.sales.loading && !state.sales.data) {
    return `${sampleNotice()}${focusEvidencePanel()}${salesQueryState('loading')}`;
  }
  if (state.sales.error && !state.sales.data) {
    return `${sampleNotice()}${focusEvidencePanel()}${salesQueryState('error')}`;
  }
  const queryData = state.sales.data;
  if (!queryData) return salesQueryState('loading');
  const scope = scopedUnits();
  const focusValue = scope.units[state.range];
  const coverage = identityCoverage();
  const productRows = queryData.products.rows;
  const standardRows = queryData.standardProducts.rows;
  const storeRows = queryData.stores.rows;
  const sourceMeta = queryData.source?.materializedRankings || {};
  const storeSkuMeta = sourceMeta.storeSku || {};
  const productMeta = sourceMeta.product || {};
  const sourceBoundary = [
    `服务端筛选命中 ${numberFormatter.format(queryData.summary?.matchedMaterializedProductCount || 0)} 条`,
    `店内商品物化 ${numberFormatter.format(storeSkuMeta.returned || 0)} / ${numberFormatter.format(storeSkuMeta.total || 0)}`,
    storeSkuMeta.truncated === true ? '源结果已截断' : '源物化未截断',
  ].join(' · ');
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
      ${panelHeading('STORE DETAIL', '店铺销量表', `服务端当前筛选命中 ${numberFormatter.format(queryData.summary?.matchedMaterializedStoreCount || 0)} 家`)}
      ${salesTable('store', storeRows)}
    </section>
    <section class="table-section">
      ${panelHeading('PRODUCT DETAIL', productIdentityLabel(), `完整商品口径规则（非全量行声明） · ${sourceBoundary} · ${coverage.label} · 未归并商品保持店内隔离`)}
      ${quickFilterBar('sales', '商品快速筛查', [
        ['ALL', '全部商品'],
        ['GROWING', '增长 ≥10%'],
        ['DECLINING', '下降 ≤-10%'],
        ['UNCOMPARABLE', '不可比'],
        ['CANONICAL', '标准身份'],
        ['UNMAPPED', '待归并'],
      ])}
      ${salesSortControl()}
      ${salesTable('sku', productRows, queryData.products.pagination)}
      ${salesPagination(queryData.products.pagination, 'product', '商品销量')}
      ${state.sales.loading ? '<p class="query-refresh-note" role="status">正在刷新当前销量筛选结果…</p>' : ''}
      ${storeSkuMeta.truncated === true ? '<p class="table-note warning-note">当前筛选只覆盖物化到 Dashboard 的店内商品排行；源结果已截断，命中数不是仓库全量商品数量。</p>' : ''}
    </section>
    <section class="table-section">
      ${panelHeading('STANDARD PRODUCT DETAIL', '标准商品排行', `${coverage.confirmed}/${coverage.total} 个目录 SKU 已确认；源物化 ${numberFormatter.format(productMeta.returned || 0)} / ${numberFormatter.format(productMeta.total || 0)}`)}
      ${salesTable('standard', standardRows, queryData.standardProducts.pagination)}
      ${salesPagination(queryData.standardProducts.pagination, 'standard', '标准商品销量')}
    </section>`;
}

function renderProducts() {
  if (state.products.loading && !state.products.data) {
    return `${sampleNotice()}${focusEvidencePanel()}${productQueryState('loading')}`;
  }
  if (state.products.error && !state.products.data) {
    return `${sampleNotice()}${focusEvidencePanel()}${productQueryState('error')}`;
  }
  const queryData = state.products.data;
  if (!queryData) return productQueryState('loading');
  const pendingView = state.products.view === 'PENDING';
  const activeList = pendingView ? queryData.pending : queryData.canonical;
  const pagination = activeList.pagination;
  const paginationKind = pendingView ? 'pending' : 'canonical';
  const paginationLabel = pendingView ? '待归并队列' : '标准商品';
  const catalog = productRecord(queryData.source?.activeCatalogCoverage);
  const source = productRecord(activeList.source);
  const quickOptions = pendingView
    ? [
        ['ALL', '全部待归并'],
        ['WITH_SALES', '当前窗口有销量'],
        ['UNMAPPED', '等待证据归并'],
        ['MISSING_SPU', '缺少平台 SPU'],
      ]
    : [
        ['ALL', '全部标准商品'],
        ['WITH_SALES', '当前窗口有销量'],
        ['CANONICAL', '仅已确认身份'],
      ];
  const sourceLine = [
    `已物化范围命中 ${numberFormatter.format(isUnit(pagination?.matchedMaterializedRows) ? pagination.matchedMaterializedRows : 0)} 条`,
    `源物化 ${nullableUnits(source.returned, '未知')} / ${nullableUnits(source.total, '未知')} 条`,
    source.truncated === true ? '源结果已截断，非 SHEIN 全量目录' : '源物化未截断',
    `业务日期 ${queryData.source?.businessDate || '未知'}`,
  ].join(' · ');
  return `
    ${sampleNotice()}
    ${focusEvidencePanel()}
    ${pageIntro(
      'PRODUCT IDENTITY',
      '商品分析',
      '店内货号、SKC、SKU 与标准商品分层保存；只有 GLOBAL + CONFIRMED 归并才能跨店聚合。',
      `<span>活跃目录身份覆盖</span><strong>${escapeHtml(`${nullableUnits(catalog.confirmedSkus, '未知')} / ${nullableUnits(catalog.totalSkus, '未知')}`)}</strong><small>${escapeHtml(`缺少平台 SPU ${nullableUnits(catalog.missingSpuSkus, '未知')} 个 · 与销量物化范围是两个不同口径`)}</small>`,
    )}
    ${productDecisionSummary(queryData)}
    ${productPipelineFlow(queryData)}
    <section class="table-section inventory-workspace">
      ${panelHeading(
        'IDENTITY WORKSPACE',
        '商品身份工作台',
        `服务端筛选、排序与分页 · ${sourceLine}`,
      )}
      ${productViewTabs(queryData)}
      ${quickFilterBar('products', pendingView ? '待归并快速筛查' : '标准商品快速筛查', quickOptions)}
      <div class="inventory-controls">
        ${productSelect('sort', '排序', [
          ['IMPACT_DESC', `${RANGE_META[state.range].label}影响`],
          ['LAST30_DESC', '近 30 日销量'],
          ['LAST7_DESC', '近 7 日销量'],
          ['TODAY_DESC', '今日销量'],
          ['STORE_ASC', '按店铺编码'],
        ], state.products.sort)}
        ${productSelect('pageSize', '每页', [
          [25, '25 条'],
          [50, '50 条'],
          [100, '100 条'],
        ], pageSizeParam(state.products.pageSize))}
      </div>
      ${productPagination(pagination, paginationKind, paginationLabel, 'top')}
      ${pendingView
        ? productPendingTable(queryData.pending.rows)
        : productCanonicalTable(queryData.canonical.rows)}
      ${productPagination(pagination, paginationKind, paginationLabel, 'bottom')}
      ${state.products.loading ? '<p class="query-refresh-note" role="status">正在刷新当前商品身份筛选结果…</p>' : ''}
      ${source.truncated === true ? '<p class="table-note warning-note">当前队列只覆盖物化到 Dashboard 的销量排行行；源结果已截断，命中数不是活跃目录或 SHEIN 仓库全量商品数。</p>' : ''}
      ${queryData.scope?.canonicalQuantitiesRecomputed === true ? '<p class="table-note">当前范围已生效：标准商品数量与店铺数按范围内店铺重算，不展示全量跨店合计。</p>' : ''}
    </section>
    ${productIdentityBoundaries()}`;
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
  // Preserve the server order. Re-sorting here would silently override the
  // chosen LATEST or DELIVERY_DEADLINE sort on every paginated page. Focus-first
  // ordering is the only permitted reordering.
  const visible = orderRowsForFocus(rows, 'procurement');
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
    <p class="table-note">当前页显示 ${numberFormatter.format(visible.length)} 条，排序与分页由服务端决定，页面不再按优先级重排当前页。数量链路未知时保留“—”，不补 0。</p>`;
}

function renderProcurement() {
  if (state.procurement.loading && !state.procurement.data) {
    return `${sampleNotice()}${focusEvidencePanel()}${procurementLoadingState()}`;
  }
  if (state.procurement.error && !state.procurement.data) {
    return `${sampleNotice()}${focusEvidencePanel()}${procurementErrorState()}`;
  }
  const queryData = state.procurement.data;
  if (!queryData) return procurementLoadingState();
  const attention = queryData.attention.rows;
  const sourceMeta = productRecord(queryData.source?.materializedAttention);
  const attentionAvailable = sourceMeta.available === true
    || attention.length > 0
    || sourceMeta.truncated === true;
  const summary = productRecord(queryData.summary);
  const stages = productRecord(summary.quantityStages);
  const overview = Array.isArray(queryData.statusOverview) ? queryData.statusOverview : [];
  const totalOrders = isUnit(summary.orderCount) ? summary.orderCount : null;
  const coverageLine = operationCoverageLine(queryData.source);
  const statusOptions = [
    ['ALL', '全部状态'],
    ...(Array.isArray(queryData.filters?.statuses) ? queryData.filters.statuses : [])
      .map((row) => [row.code, row.name || row.code]),
  ];
  return `
    ${sampleNotice()}
    ${focusEvidencePanel()}
    ${pageIntro(
      'PURCHASE ORDERS',
      '采购单中心',
      '采购单是 SHEIN 向商家下达的供货单据，不是消费者订单；销量只作为需求参照。',
      `<span>采购单证据</span><strong>${escapeHtml(`已物化范围命中 ${numberFormatter.format(isUnit(summary.matchedMaterializedAttentionCount) ? summary.matchedMaterializedAttentionCount : 0)} 条`)}</strong><small>${escapeHtml(coverageLine)}</small>`,
    )}
    ${operationSummaryCards([
      {
        label: '当前范围采购单',
        value: totalOrders === null ? '未知' : `${numberFormatter.format(totalOrders)} 张`,
        note: totalOrders === null
          ? '存在数量未知的状态行，拒绝补零后合计；单据张数与下方数量口径不同'
          : '来自状态快照的单据张数，与阶段数量是两个口径',
        tone: totalOrders === null ? 'partial' : 'available',
      },
      {
        // The field is the receipt stage quantity, so the label says 收货数量.
        // Calling it 待入库 would imply a pending remainder the data never states.
        label: '收货数量',
        value: stageMetricValue(stages.receipt, '件'),
        note: stageMetricNote(stages.receipt),
        tone: 'partial',
      },
      {
        label: '残次数量',
        value: stageMetricValue(stages.defective, '件'),
        note: stageMetricNote(stages.defective),
        tone: 'partial',
      },
      {
        label: '最新来源快照',
        value: summary.latestSourceFetchedAt
          ? formatDateTime(summary.latestSourceFetchedAt)
          : '未知',
        note: '接口抓取时间，不冒充采购单业务时间',
        tone: summary.latestSourceFetchedAt ? 'available' : 'partial',
      },
    ])}
    <section class="table-section">
      ${panelHeading(
        'ATTENTION QUANTITY SNAPSHOT',
        '关注范围阶段数量快照',
        escapeHtml(String(summary.attentionScopeLabel || '当前已物化关注范围的阶段数量，不是转化漏斗')),
      )}
      <div class="stage-snapshot">
        ${[
          ['订购', stages.order],
          ['交付', stages.delivery],
          ['收货', stages.receipt],
          ['入库', stages.storage],
          ['残次', stages.defective],
        ].map(([label, metric]) => `
          <article class="stage-cell">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(stageMetricValue(metric, '件'))}</strong>
            <small>${escapeHtml(stageMetricNote(metric))}</small>
          </article>`).join('')}
      </div>
      <p class="table-note">这五个数量属于同一批已物化关注单据的不同阶段字段，彼此独立，不构成转化漏斗，也不据此推导完成率或百分比。</p>
    </section>
    <section class="table-section">
      ${panelHeading(
        'STATUS OVERVIEW',
        '采购单状态紧凑总览',
        `按平台状态聚合 ${numberFormatter.format(overview.length)} 类 · 不逐店铺展开`,
      )}
      ${overview.length ? `
        <div class="table-wrap">
          <table class="data-table operational-table">
            <thead><tr><th scope="col">平台状态</th><th scope="col" class="number-column">采购单数</th><th scope="col" class="number-column">覆盖店铺</th></tr></thead>
            <tbody>${overview.map((row) => `
              <tr>
                <td class="entity-column"><strong>${escapeHtml(row.statusName || row.statusCode)}</strong><span>${escapeHtml(row.statusCode)}</span></td>
                <td class="number-column ${isUnit(row.orderCount) ? '' : 'missing-value'}">${nullableUnits(row.orderCount)}</td>
                <td class="number-column">${nullableUnits(row.storeCount)}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        <p class="table-note">任一店铺数量未知时该状态合计保持“—”，绝不补零；这里只做范围判断，具体行动看下方关注队列。</p>`
        : emptyEvidence('当前筛选没有采购单状态行', '这不代表没有采购单；请调整负责人、店铺、状态或搜索条件。')}
    </section>
    <section class="table-section inventory-workspace">
      ${panelHeading(
        'PURCHASE ATTENTION',
        '采购单关注队列',
        attentionAvailable ? `${coverageLine} · 单据级事实优先` : '单据级事实待接入',
      )}
      ${quickFilterBar('procurement', '快速筛查', [
        ['ALL', '全部关注'],
        ['HIGH', '高优先'],
        ['OVERDUE', '逾期'],
        ['PENDING_DELIVERY', '待交付'],
        ['PENDING_RECEIPT', '待收货'],
        ['PENDING_STORAGE', '待入库'],
        ['DEFECTIVE', '存在残次'],
      ])}
      <div class="operation-controls">
        ${operationSelect('procurementStatus', '平台状态', statusOptions, state.procurement.status)}
        ${operationSelect('procurementSort', '排序', [
          ['PRIORITY', '优先级'],
          ['LATEST', '证据最新'],
          ['DELIVERY_DEADLINE', '要求交付时间'],
        ], state.procurement.sort)}
        ${operationSelect('procurementPageSize', '每页', [
          [25, '25 条'], [50, '50 条'], [100, '100 条'],
        ], pageSizeParam(state.procurement.pageSize))}
        ${operationSearchControls('procurement')}
      </div>
      ${procurementPagination(queryData, 'top')}
      ${purchaseOrderAttentionTable(attention, attentionAvailable)}
      ${procurementPagination(queryData, 'bottom')}
      ${state.procurement.loading ? '<p class="query-refresh-note" role="status">正在刷新当前筛选结果…</p>' : ''}
      ${sourceMeta.truncated === true ? '<p class="table-note warning-note">当前接口只筛选物化到页面的单据级关注记录；源明细已截断，因此筛选结果不是仓库全量采购单数量。</p>' : ''}
    </section>
    <section class="panel condition-panel">
      ${panelHeading('DATA BOUNDARY', '采购单数据边界', '事实接入不等于写能力开放')}
      <ul class="condition-list">
        <li><strong>单据口径</strong><span>SHEIN 向商家下达的采购单，不是消费者订单</span></li>
        <li><strong>数量口径</strong><span>采购、交付、收货、入库与残次数量保持独立，不相加也不算比率</span></li>
        <li><strong>来源时间</strong><span>接口快照时间与平台业务时间分开保存</span></li>
        <li><strong>写操作</strong><span>当前页面与服务仍为只读，不提交任何采购单动作</span></li>
      </ul>
    </section>`;
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
  // Preserve the server order. Re-sorting here would silently override the
  // chosen LATEST or EXPECTED_RECEIPT sort on every paginated page. Focus-first
  // ordering is the only permitted reordering.
  const visible = orderRowsForFocus(rows, 'fulfilment');
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
    <p class="table-note">当前页显示 ${numberFormatter.format(visible.length)} 条，排序与分页由服务端决定，页面不再按优先级重排当前页。预计收货时间缺失时保持未知，不用其他时间冒充。</p>`;
}

function renderFulfilment() {
  if (state.fulfilment.loading && !state.fulfilment.data) {
    return `${sampleNotice()}${focusEvidencePanel()}${fulfilmentQueryState('loading')}`;
  }
  if (state.fulfilment.error && !state.fulfilment.data) {
    return `${sampleNotice()}${focusEvidencePanel()}${fulfilmentQueryState('error')}`;
  }
  const queryData = state.fulfilment.data;
  if (!queryData) return fulfilmentQueryState('loading');
  const attention = queryData.attention.rows;
  const sourceMeta = productRecord(queryData.attention.source);
  const attentionAvailable = sourceMeta.available === true
    || attention.length > 0
    || sourceMeta.truncated === true;
  const summary = productRecord(queryData.summary);
  const overview = Array.isArray(queryData.milestoneOverview) ? queryData.milestoneOverview : [];
  const coverageLine = operationCoverageLine(queryData.source);
  const expectedKnown = isUnit(summary.expectedReceiptKnownCount)
    ? summary.expectedReceiptKnownCount
    : 0;
  const milestoneOptions = [
    ['ALL', '全部里程碑'],
    ...(Array.isArray(queryData.filters?.milestones) ? queryData.filters.milestones : [])
      .map((row) => [row.code, row.name || row.code]),
  ];
  return `
    ${sampleNotice()}
    ${focusEvidencePanel()}
    ${pageIntro(
      'DELIVERY & INBOUND',
      '交付与入仓',
      '跟踪发货、物流预报、送达、收货、查验、入库和残次节点；每个节点只认平台单据事实。',
      `<span>交付证据</span><strong>${escapeHtml(`已物化范围命中 ${numberFormatter.format(isUnit(summary.matchedMaterializedAttentionCount) ? summary.matchedMaterializedAttentionCount : 0)} 条`)}</strong><small>${escapeHtml(coverageLine)}</small>`,
    )}
    ${operationSummaryCards([
      {
        label: '快照交付单数',
        value: stageMetricValue(summary.snapshotDeliveryCount, '单'),
        note: `${stageMetricNote(summary.snapshotDeliveryCount)}；交付单数与交付数量单位不同，不可相加`,
        tone: 'partial',
      },
      {
        label: '快照交付数量',
        value: stageMetricValue(summary.snapshotDeliveryQuantity, '件'),
        note: stageMetricNote(summary.snapshotDeliveryQuantity),
        tone: 'partial',
      },
      {
        label: '关注范围交付数量',
        value: stageMetricValue(summary.attentionDeliveryQuantity, '件'),
        note: `${stageMetricNote(summary.attentionDeliveryQuantity)}；仅统计未收货的关注单据`,
        tone: 'partial',
      },
      {
        label: '预计收货时间已知',
        value: `${numberFormatter.format(expectedKnown)} 条`,
        note: expectedKnown === 0
          ? '当前来源没有提供预计收货时间，保持未知，不用其他时间冒充'
          : '仅统计来源明确给出预计收货时间的单据',
        tone: expectedKnown === 0 ? 'partial' : 'available',
      },
    ])}
    <section class="table-section">
      ${panelHeading(
        'MILESTONE SNAPSHOT',
        '交付里程碑紧凑总览',
        // This overview is the whole scoped milestone snapshot, including
        // RECEIVED, so it must not borrow the attention-scope caption: the
        // attention queue below only holds unreceived deliveries.
        '当前交付里程碑快照（含已收货）· 交付单数与交付数量单位不同，不可相加 · 不是转化漏斗',
      )}
      ${overview.length ? `
        <div class="table-wrap">
          <table class="data-table operational-table">
            <thead><tr><th scope="col">履约里程碑</th><th scope="col" class="number-column">交付单数</th><th scope="col" class="number-column">交付数量</th><th scope="col" class="number-column">覆盖店铺</th></tr></thead>
            <tbody>${overview.map((row) => `
              <tr>
                <td><span class="row-status ${sourceStatusTone(row.milestoneCode)}">${escapeHtml(row.milestoneCode)}</span></td>
                <td class="number-column ${isUnit(row.deliveryCount) ? '' : 'missing-value'}">${nullableUnits(row.deliveryCount)}</td>
                <td class="number-column ${isUnit(row.deliveryQuantity) ? '' : 'missing-value'}">${nullableUnits(row.deliveryQuantity)}</td>
                <td class="number-column">${nullableUnits(row.storeCount)}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        <p class="table-note">里程碑是单据当前所处阶段，不是转化漏斗，也不据此推导履约率或准时率。交付单数与交付数量各自独立判空，任一店铺未知即保持“—”。</p>`
        : emptyEvidence(
          '当前筛选没有交付里程碑行',
          // A covered domain with no rows is a different fact from a domain that
          // was never integrated, so the two are never collapsed into one label.
          `${['complete', 'partial'].includes(String(productRecord(queryData.source?.coverage).status || ''))
            ? '接口覆盖完整 · 当前窗口无事实行'
            : '尚未完成可信接入'}；这不代表没有发货或入仓，请调整负责人、店铺、里程碑或搜索条件。`,
        )}
    </section>
    <section class="table-section inventory-workspace">
      ${panelHeading(
        'DELIVERY ATTENTION',
        '交付入仓关注队列',
        attentionAvailable ? `${coverageLine} · 单据级事实优先` : '单据级事实待接入',
      )}
      ${quickFilterBar('fulfilment', '快速筛查', [
        ['ALL', '全部关注'],
        ['HIGH', '高优先'],
        ['CREATED', '已创建待预约'],
        ['PICKUP_RESERVED', '已预约待揽收'],
        ['IN_TRANSIT', '运输中'],
        ['PENDING_RECEIPT', '全部待收货'],
      ])}
      <div class="operation-controls">
        ${operationSelect('fulfilmentMilestone', '履约里程碑', milestoneOptions, state.fulfilment.milestone)}
        ${operationSelect('fulfilmentSort', '排序', [
          ['PRIORITY', '优先级'],
          ['LATEST', '证据最新'],
          ['EXPECTED_RECEIPT', '预计收货时间'],
        ], state.fulfilment.sort)}
        ${operationSelect('fulfilmentPageSize', '每页', [
          [25, '25 条'], [50, '50 条'], [100, '100 条'],
        ], pageSizeParam(state.fulfilment.pageSize))}
        ${operationSearchControls('fulfilment')}
      </div>
      ${fulfilmentPagination(queryData.attention.pagination, 'top')}
      ${deliveryAttentionTable(attention, attentionAvailable)}
      ${fulfilmentPagination(queryData.attention.pagination, 'bottom')}
      ${state.fulfilment.loading ? '<p class="query-refresh-note" role="status">正在刷新当前交付筛选结果…</p>' : ''}
      ${sourceMeta.truncated === true ? '<p class="table-note warning-note">当前接口只筛选物化到页面的单据级关注记录；源明细已截断，因此筛选结果不是仓库全量交付单数量。</p>' : ''}
    </section>
    <section class="panel condition-panel">
      ${panelHeading('DATA BOUNDARY', '交付入仓数据边界', '事实接入不等于写能力开放')}
      <ul class="condition-list">
        <li><strong>单位口径</strong><span>交付单数与交付数量是两个单位，不相加也不算比率</span></li>
        <li><strong>预计收货</strong><span>来源缺失时保持未知，不用预约或揽收时间冒充</span></li>
        <li><strong>里程碑</strong><span>只表示单据当前阶段，不构成转化漏斗或履约率</span></li>
        <li><strong>写操作</strong><span>当前页面与服务仍为只读，不提交任何交付动作</span></li>
      </ul>
    </section>`;
}

function renderInventory() {
  if (state.inventory.loading && !state.inventory.data) {
    return `${sampleNotice()}${focusEvidencePanel()}${inventoryQueryState('loading')}`;
  }
  if (state.inventory.error && !state.inventory.data) {
    return `${sampleNotice()}${focusEvidencePanel()}${inventoryQueryState('error')}`;
  }
  const queryData = state.inventory.data;
  if (!queryData) return inventoryQueryState('loading');
  const inventoryView = state.inventory.view === 'INVENTORY';
  const activeList = inventoryView ? queryData.inventory : queryData.advice;
  const pagination = activeList.pagination;
  const paginationKind = inventoryView ? 'inventory' : 'advice';
  const paginationLabel = inventoryView ? '库存风险' : '备货建议';
  const quickOptions = inventoryView
    ? [
        ['ALL', '全部风险'],
        ['HIGH', '高优先'],
        ['SHORTAGE', '缺货'],
        ['RECONCILIATION', '对账差异'],
      ]
    : [
        ['ALL', '全部建议'],
        ['HIGH', '高优先'],
        ['URGENT', '急采'],
        ['ADVICE', '建议备货'],
        ['WARNING', '平台预警'],
      ];
  return `
    ${sampleNotice()}
    ${focusEvidencePanel()}
    ${pageIntro(
      'INVENTORY',
      '库存与供给',
      '库存、缺货需求、待交付、在途与已入库数量分开表达；销量只能作为供给速度参考。',
      `<span>供给事实</span><strong>${escapeHtml(String(queryData.source?.supplyStatus === 'available' ? '真实快照已接入' : '覆盖不完整'))}</strong><small>${escapeHtml(inventorySourceLine(queryData))}</small>`,
    )}
    ${inventorySummaryCards(queryData)}
    <section class="table-section inventory-workspace">
      ${panelHeading(
        'SUPPLY RISK WORKSPACE',
        '库存风险与备货工作台',
        `服务端筛选、排序与分页 · ${inventorySourceLine(queryData)}`,
      )}
      ${inventoryViewTabs(queryData)}
      ${quickFilterBar('inventory', inventoryView ? '库存快速筛查' : '备货快速筛查', quickOptions)}
      <div class="inventory-controls">
        ${inventoryView
          ? inventorySelect('type', '库存类型', [
              ['ALL', '全部类型'],
              ['PI', 'PI'],
              ['JI', 'JI'],
              ['VI', 'VI'],
            ], state.inventory.inventoryType)
          : ''}
        ${inventoryView
          ? inventorySelect('inventorySort', '排序', [
              ['PRIORITY', '优先级'],
              ['SHORTAGE_DESC', '缺货数量'],
              ['USABLE_ASC', '可用库存最少'],
              ['FRESHNESS_DESC', '证据最新'],
            ], state.inventory.inventorySort)
          : inventorySelect('adviceSort', '排序', [
              ['PRIORITY', '优先级'],
              ['URGENT_DESC', '急采数量'],
              ['ADVICE_DESC', '建议数量'],
              ['DAILY_SALES_DESC', '预测日销'],
              ['FRESHNESS_DESC', '证据最新'],
            ], state.inventory.adviceSort)}
        ${inventorySelect('pageSize', '每页', [
          [25, '25 条'],
          [50, '50 条'],
          [100, '100 条'],
        ], pageSizeParam(state.inventory.pageSize))}
      </div>
      ${inventoryPagination(pagination, paginationKind, paginationLabel, 'top')}
      ${inventoryView
        ? inventoryRiskQueryTable(queryData.inventory.rows)
        : stockAdviceQueryTable(queryData.advice.rows)}
      ${inventoryPagination(pagination, paginationKind, paginationLabel, 'bottom')}
      ${state.inventory.loading ? '<p class="query-refresh-note" role="status">正在刷新当前库存与备货筛选结果…</p>' : ''}
      ${activeList.source?.truncated === true ? '<p class="table-note warning-note">当前筛选只覆盖物化到 Dashboard 的风险明细；源结果已截断，命中数不是 SHEIN 仓库全量。</p>' : ''}
    </section>
    <section class="table-section inventory-store-summary">
      ${panelHeading(
        inventoryView ? 'STORE INVENTORY SUMMARY' : 'STORE ADVICE SUMMARY',
        inventoryView ? '店铺×库存类型汇总' : '店铺级平台备货建议汇总',
        '第二层总览 · 服务端已按当前负责人、店铺和搜索筛选',
      )}
      ${inventoryStoreSummary(queryData)}
    </section>
    <section class="panel condition-panel">
      ${panelHeading('READ-ONLY BOUNDARY', '只读能力边界', '供给事实可读，库存写操作仍关闭')}
      <ul class="condition-list">
        <li><strong>库存事实</strong><span>实际、可用、在途与缺货按来源字段分开</span></li>
        <li><strong>未知值</strong><span>以 null 和覆盖率表达，不参与合计</span></li>
        <li><strong>建议事实</strong><span>平台备货建议是只读事实，不等于已执行的采购动作</span></li>
        <li><strong>执行能力</strong><span>任何提交按钮和写接口仍保持禁用</span></li>
      </ul>
    </section>`;
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
    const dates = selectedHomeDateRange();
    elements.rangeSummary.textContent = dates.custom
      ? `${dates.start} → ${dates.end}`
      : `${RANGE_META[state.range].label} · ${RANGE_META[state.range].note}`;
  }
  const dates = selectedHomeDateRange();
  if (elements.homeDateStart) elements.homeDateStart.value = dates.start;
  if (elements.homeDateEnd) elements.homeDateEnd.value = dates.end;
  const hasFilters = Boolean(state.query.trim())
    || state.owner !== 'ALL'
    || state.store !== 'ALL'
    || state.range !== 'today'
    || state.homeDateCustom;
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

function updateLiveUpdateChrome() {
  if (!elements.liveUpdateBadge) return;
  const labels = {
    connecting: ['自动更新连接中', 'neutral'],
    connected: ['快照自动更新', 'complete'],
    refreshing: ['正在读取新快照', 'partial'],
    reconnecting: ['自动更新重连中', 'partial'],
    unsupported: ['浏览器需手动刷新', 'neutral'],
  };
  const [label, tone] = labels[state.updates.status] || labels.connecting;
  elements.liveUpdateBadge.textContent = label;
  elements.liveUpdateBadge.className = `status-badge ${tone}`;
  const observed = state.updates.observedAt
    ? `；最近检测到新快照：${formatDateTime(state.updates.observedAt)}`
    : '';
  elements.liveUpdateBadge.title = `只监听已物化 Dashboard 快照，不直接连接 SHEIN${observed}`;
}

function updateErrorPanel() {
  elements.errorPanel.hidden = !state.error;
  elements.errorMessage.textContent = state.error || '';
  elements.retryButton.disabled = state.loading;
  elements.retryButton.textContent = state.loading ? '重新加载中…' : '重新加载';
}

function populateScopeOptions() {
  // 负责人只影响查看范围，不表达读权限限制；负责人与店铺共用这唯一一个范围选择框。
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
      option.textContent = `负责人 · ${owner.name}（${owner.storeCodes.length} 家店）`;
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
  updateLiveUpdateChrome();
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
  if (state.data && state.route === 'procurement') {
    scheduleProcurementLoad();
  }
  if (state.data && state.route === 'sales') {
    scheduleSalesLoad();
  }
  if (state.data && state.route === 'inventory') {
    scheduleInventoryLoad();
  }
  if (state.data && state.route === 'products') {
    scheduleProductLoad();
  }
  if (state.data && state.route === 'fulfilment') {
    scheduleFulfilmentLoad();
  }
}

function connectDashboardUpdates() {
  if (typeof EventSource !== 'function') {
    state.updates.status = 'unsupported';
    render();
    return;
  }
  if (dashboardEventSource) dashboardEventSource.close();
  const source = new EventSource('/api/events');
  dashboardEventSource = source;
  state.updates.status = 'connecting';
  render();
  source.addEventListener('open', () => {
    if (dashboardEventSource !== source) return;
    state.updates.status = 'connected';
    render();
  });
  source.addEventListener('dashboard-updated', async (event) => {
    if (dashboardEventSource !== source) return;
    let observedAt = new Date().toISOString();
    try {
      const payload = JSON.parse(event.data);
      if (payload?.observedAt && !Number.isNaN(new Date(payload.observedAt).valueOf())) {
        observedAt = payload.observedAt;
      }
    } catch {
      // Event data is only freshness evidence. A malformed optional timestamp
      // never replaces the authenticated dashboard fetch below.
    }
    state.updates.observedAt = observedAt;
    state.updates.status = 'refreshing';
    render();
    await loadDashboard();
    if (dashboardEventSource === source) {
      state.updates.status = source.readyState === EventSource.OPEN
        ? 'connected'
        : 'reconnecting';
      render();
    }
  });
  source.addEventListener('error', () => {
    if (dashboardEventSource !== source) return;
    state.updates.status = 'reconnecting';
    render();
  });
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
    salesSort: state.sales.sort,
    productPage: state.sales.productPage,
    standardPage: state.sales.standardPage,
    inventoryView: state.inventory.view,
    inventoryType: state.inventory.inventoryType,
    inventorySort: state.inventory.inventorySort,
    adviceSort: state.inventory.adviceSort,
    inventoryPage: state.inventory.inventoryPage,
    advicePage: state.inventory.advicePage,
    inventoryPageSize: state.inventory.pageSize,
    productView: state.products.view,
    productSort: state.products.sort,
    productPendingPage: state.products.pendingPage,
    productCanonicalPage: state.products.canonicalPage,
    productPageSize: state.products.pageSize,
    procurementStatus: state.procurement.status,
    procurementSort: state.procurement.sort,
    procurementPage: state.procurement.page,
    procurementPageSize: state.procurement.pageSize,
    fulfilmentMilestone: state.fulfilment.milestone,
    fulfilmentSort: state.fulfilment.sort,
    fulfilmentPage: state.fulfilment.page,
    fulfilmentPageSize: state.fulfilment.pageSize,
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
  state.sales.sort = parsed.salesSort || 'LAST30_DESC';
  state.sales.productPage = parsed.productPage || 1;
  state.sales.standardPage = parsed.standardPage || 1;
  state.inventory.view = parsed.inventoryView || 'INVENTORY';
  state.inventory.inventoryType = parsed.inventoryType || 'ALL';
  state.inventory.inventorySort = parsed.inventorySort || 'PRIORITY';
  state.inventory.adviceSort = parsed.adviceSort || 'PRIORITY';
  state.inventory.inventoryPage = parsed.inventoryPage || 1;
  state.inventory.advicePage = parsed.advicePage || 1;
  state.inventory.pageSize = pageSizeParam(parsed.inventoryPageSize);
  state.products.view = parsed.productView || 'PENDING';
  state.products.sort = parsed.productSort || 'IMPACT_DESC';
  state.products.pendingPage = parsed.productPendingPage || 1;
  state.products.canonicalPage = parsed.productCanonicalPage || 1;
  state.products.pageSize = pageSizeParam(parsed.productPageSize);
  state.procurement.status = operationCodeParam(parsed.procurementStatus);
  state.procurement.sort = parsed.procurementSort || 'PRIORITY';
  state.procurement.page = parsed.procurementPage || 1;
  state.procurement.pageSize = pageSizeParam(parsed.procurementPageSize);
  state.fulfilment.milestone = operationCodeParam(parsed.fulfilmentMilestone);
  state.fulfilment.sort = parsed.fulfilmentSort || 'PRIORITY';
  state.fulfilment.page = parsed.fulfilmentPage || 1;
  state.fulfilment.pageSize = pageSizeParam(parsed.fulfilmentPageSize);
  if (parsed.quick === 'ALL') delete state.quickFilters[parsed.route];
  else state.quickFilters[parsed.route] = parsed.quick;
}

function syncRouteFromLocation() {
  const parsed = parseHashState(window.location.hash, currentHashState());
  const routeChanged = state.route !== parsed.route;
  applyHashState(parsed);
  syncUrlFromState();
  render();
  if (state.route === 'procurement') {
    scheduleProcurementLoad({ resetPage: routeChanged });
  } else if (routeChanged) {
    state.procurement.requestSerial += 1;
    state.procurement.loading = false;
  }
  if (state.route === 'sales') {
    scheduleSalesLoad({ resetPages: routeChanged });
  } else if (routeChanged) {
    state.sales.requestSerial += 1;
    state.sales.loading = false;
  }
  if (state.route === 'inventory') {
    scheduleInventoryLoad({ resetPages: routeChanged });
  } else if (routeChanged) {
    // Leaving the surface must also drop any in-flight inventory response.
    state.inventory.requestSerial += 1;
    state.inventory.loading = false;
  }
  if (state.route === 'products') {
    scheduleProductLoad({ resetPages: routeChanged });
  } else if (routeChanged) {
    state.products.requestSerial += 1;
    state.products.loading = false;
  }
  if (state.route === 'fulfilment') {
    scheduleFulfilmentLoad({ resetPage: routeChanged });
  } else if (routeChanged) {
    // Leaving the surface must also drop any in-flight fulfilment response.
    state.fulfilment.requestSerial += 1;
    state.fulfilment.loading = false;
  }
  if (routeChanged && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

elements.search.addEventListener('input', (event) => {
  state.query = event.currentTarget.value;
  syncUrlFromState();
  render();
  scheduleProcurementLoad({ resetPage: true, delay: 220 });
  scheduleSalesLoad({ resetPages: true, delay: 220 });
  scheduleInventoryLoad({ resetPages: true, delay: 220 });
  scheduleProductLoad({ resetPages: true, delay: 220 });
  scheduleFulfilmentLoad({ resetPage: true, delay: 220 });
});

elements.scope.addEventListener('change', (event) => {
  const value = String(event.currentTarget.value || 'ALL');
  state.owner = value.startsWith('OWNER:') ? value.slice(6) : 'ALL';
  state.store = value.startsWith('STORE:') ? value.slice(6) : 'ALL';
  syncUrlFromState();
  render();
  scheduleProcurementLoad({ resetPage: true });
  scheduleSalesLoad({ resetPages: true });
  scheduleInventoryLoad({ resetPages: true, delay: 120 });
  scheduleProductLoad({ resetPages: true, delay: 120 });
  scheduleFulfilmentLoad({ resetPage: true, delay: 120 });
});

elements.rangeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (!Object.prototype.hasOwnProperty.call(RANGE_META, button.dataset.range)) return;
    state.range = button.dataset.range;
    state.homeDateCustom = false;
    state.homeDateStart = null;
    state.homeDateEnd = null;
    syncUrlFromState();
    render();
    // The product query ranks and filters by the selected range on the server.
    scheduleProductLoad({ resetPages: true });
  });
});

for (const element of [elements.homeDateStart, elements.homeDateEnd]) {
  element?.addEventListener('change', () => {
    const start = String(elements.homeDateStart?.value || '');
    const end = String(elements.homeDateEnd?.value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return;
    state.homeDateStart = start <= end ? start : end;
    state.homeDateEnd = start <= end ? end : start;
    state.homeDateCustom = true;
    render();
  });
}

elements.view.addEventListener('click', (event) => {
  const salesRetry = event.target.closest?.('[data-sales-retry]');
  if (salesRetry && elements.view.contains(salesRetry)) {
    void loadSales();
    return;
  }
  const salesPage = event.target.closest?.('[data-sales-page]');
  if (salesPage && elements.view.contains(salesPage)) {
    const nextPage = Number(salesPage.dataset.salesPage);
    const kind = salesPage.dataset.salesPageKind;
    if (Number.isSafeInteger(nextPage) && nextPage >= 1 && !salesPage.disabled) {
      if (kind === 'standard') state.sales.standardPage = nextPage;
      else state.sales.productPage = nextPage;
      syncUrlFromState();
      void loadSales();
    }
    return;
  }
  const procurementRetry = event.target.closest?.('[data-procurement-retry]');
  if (procurementRetry && elements.view.contains(procurementRetry)) {
    void loadProcurement();
    return;
  }
  const fulfilmentRetry = event.target.closest?.('[data-fulfilment-retry]');
  if (fulfilmentRetry && elements.view.contains(fulfilmentRetry)) {
    void loadFulfilment();
    return;
  }
  const fulfilmentPage = event.target.closest?.('[data-fulfilment-page]');
  if (fulfilmentPage && elements.view.contains(fulfilmentPage)) {
    const nextPage = Number(fulfilmentPage.dataset.fulfilmentPage);
    if (Number.isSafeInteger(nextPage) && nextPage >= 1 && !fulfilmentPage.disabled) {
      state.fulfilment.page = nextPage;
      syncUrlFromState();
      void loadFulfilment();
    }
    return;
  }
  const operationSearch = event.target.closest?.('[data-operation-search]');
  if (operationSearch && elements.view.contains(operationSearch)) {
    // The endpoint already reads the shared global query, so an explicit search
    // just re-runs the active workspace from page 1.
    const kind = String(operationSearch.dataset.operationSearch || '');
    syncUrlFromState();
    if (kind === 'procurement') scheduleProcurementLoad({ resetPage: true });
    if (kind === 'fulfilment') scheduleFulfilmentLoad({ resetPage: true });
    return;
  }
  const operationReset = event.target.closest?.('[data-operation-reset]');
  if (operationReset && elements.view.contains(operationReset)) {
    const kind = String(operationReset.dataset.operationReset || '');
    // Resetting clears the shared text input as well, so the visible control,
    // the hash and the request all agree.
    state.query = '';
    if (elements.search) elements.search.value = '';
    delete state.quickFilters[kind];
    if (kind === 'procurement') {
      state.procurement.status = 'ALL';
      state.procurement.sort = 'PRIORITY';
      state.procurement.pageSize = URL_DEFAULT_INVENTORY_PAGE_SIZE;
      syncUrlFromState();
      scheduleProcurementLoad({ resetPage: true });
    }
    if (kind === 'fulfilment') {
      state.fulfilment.milestone = 'ALL';
      state.fulfilment.sort = 'PRIORITY';
      state.fulfilment.pageSize = URL_DEFAULT_INVENTORY_PAGE_SIZE;
      syncUrlFromState();
      scheduleFulfilmentLoad({ resetPage: true });
    }
    return;
  }
  const procurementPage = event.target.closest?.('[data-procurement-page]');
  if (procurementPage && elements.view.contains(procurementPage)) {
    const nextPage = Number(procurementPage.dataset.procurementPage);
    if (Number.isSafeInteger(nextPage) && nextPage >= 1 && !procurementPage.disabled) {
      state.procurement.page = nextPage;
      // Mirror the page into the URL before fetching so a shared link and the
      // rendered page can never disagree.
      syncUrlFromState();
      void loadProcurement();
    }
    return;
  }
  const inventoryRetry = event.target.closest?.('[data-inventory-retry]');
  if (inventoryRetry && elements.view.contains(inventoryRetry)) {
    void loadInventory();
    return;
  }
  const inventoryView = event.target.closest?.('[data-inventory-view]');
  if (inventoryView && elements.view.contains(inventoryView)) {
    const value = String(inventoryView.dataset.inventoryView || '').toUpperCase();
    if (URL_INVENTORY_VIEWS.includes(value) && value !== state.inventory.view) {
      const currentQuick = inventoryQuickValue();
      const nextQuickValues = value === 'INVENTORY'
        ? ['ALL', 'HIGH', 'SHORTAGE', 'RECONCILIATION']
        : ['ALL', 'HIGH', 'URGENT', 'ADVICE', 'WARNING'];
      state.inventory.view = value;
      const quickNeedsReset = !nextQuickValues.includes(currentQuick);
      if (quickNeedsReset) delete state.quickFilters.inventory;
      syncUrlFromState();
      if (quickNeedsReset) {
        // A view-specific quick filter must never remain invisibly active after
        // switching tabs. Reset it and query the unfiltered target view.
        scheduleInventoryLoad({ resetPages: true });
      } else {
        // Both lists arrived under the same applicable filter, so switching
        // tabs is a local view change and does not need a network request.
        render();
      }
    }
    return;
  }
  const inventoryPage = event.target.closest?.('[data-inventory-page]');
  if (inventoryPage && elements.view.contains(inventoryPage)) {
    const nextPage = Number(inventoryPage.dataset.inventoryPage);
    const kind = inventoryPage.dataset.inventoryPageKind;
    if (Number.isSafeInteger(nextPage) && nextPage >= 1 && !inventoryPage.disabled) {
      if (kind === 'advice') state.inventory.advicePage = nextPage;
      else state.inventory.inventoryPage = nextPage;
      syncUrlFromState();
      void loadInventory();
    }
    return;
  }
  const productRetry = event.target.closest?.('[data-product-retry]');
  if (productRetry && elements.view.contains(productRetry)) {
    void loadProducts();
    return;
  }
  const productView = event.target.closest?.('[data-product-view]');
  if (productView && elements.view.contains(productView)) {
    const value = String(productView.dataset.productView || '').toUpperCase();
    if (URL_PRODUCT_VIEWS.includes(value) && value !== state.products.view) {
      const currentQuick = productQuickValue();
      const nextQuickValues = value === 'PENDING'
        ? ['ALL', 'WITH_SALES', 'UNMAPPED', 'MISSING_SPU']
        : ['ALL', 'WITH_SALES', 'CANONICAL'];
      state.products.view = value;
      const quickNeedsReset = !nextQuickValues.includes(currentQuick);
      if (quickNeedsReset) delete state.quickFilters.products;
      syncUrlFromState();
      if (quickNeedsReset) {
        // A view-specific quick filter must never stay invisibly active after
        // switching tabs. Reset it and query the unfiltered target view.
        scheduleProductLoad({ resetPages: true });
      } else {
        // Both lists arrived under the same applicable filter, so switching
        // tabs is a local view change and needs no network request.
        render();
      }
    }
    return;
  }
  const productPage = event.target.closest?.('[data-product-page]');
  if (productPage && elements.view.contains(productPage)) {
    const nextPage = Number(productPage.dataset.productPage);
    const kind = productPage.dataset.productPageKind;
    if (Number.isSafeInteger(nextPage) && nextPage >= 1 && !productPage.disabled) {
      if (kind === 'canonical') state.products.canonicalPage = nextPage;
      else state.products.pendingPage = nextPage;
      syncUrlFromState();
      void loadProducts();
    }
    return;
  }
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
  if (route === 'procurement') scheduleProcurementLoad({ resetPage: true });
  if (route === 'sales') scheduleSalesLoad({ resetPages: true });
  if (route === 'inventory') scheduleInventoryLoad({ resetPages: true });
  if (route === 'products') scheduleProductLoad({ resetPages: true });
  if (route === 'fulfilment') scheduleFulfilmentLoad({ resetPage: true });
});

elements.view.addEventListener('change', (event) => {
  const inventorySelectControl = event.target.closest?.('[data-inventory-select]');
  if (inventorySelectControl && elements.view.contains(inventorySelectControl)) {
    const kind = String(inventorySelectControl.dataset.inventorySelect || '');
    const raw = String(inventorySelectControl.value || '');
    if (kind === 'type') {
      const value = allowListedToken(raw, URL_INVENTORY_TYPES, 'ALL');
      state.inventory.inventoryType = value;
    } else if (kind === 'inventorySort') {
      state.inventory.inventorySort = allowListedToken(raw, URL_INVENTORY_SORTS, 'PRIORITY');
    } else if (kind === 'adviceSort') {
      state.inventory.adviceSort = allowListedToken(raw, URL_ADVICE_SORTS, 'PRIORITY');
    } else if (kind === 'pageSize') {
      state.inventory.pageSize = pageSizeParam(raw);
    } else {
      return;
    }
    state.inventory.inventoryPage = 1;
    state.inventory.advicePage = 1;
    syncUrlFromState();
    void loadInventory();
    return;
  }
  const operationSelectControl = event.target.closest?.('[data-operation-select]');
  if (operationSelectControl && elements.view.contains(operationSelectControl)) {
    const kind = String(operationSelectControl.dataset.operationSelect || '');
    const raw = String(operationSelectControl.value || '');
    if (kind === 'procurementStatus') {
      state.procurement.status = operationCodeParam(raw);
    } else if (kind === 'procurementSort') {
      state.procurement.sort = allowListedToken(raw, URL_PROCUREMENT_SORTS, 'PRIORITY');
    } else if (kind === 'procurementPageSize') {
      state.procurement.pageSize = pageSizeParam(raw);
    } else if (kind === 'fulfilmentMilestone') {
      state.fulfilment.milestone = operationCodeParam(raw);
    } else if (kind === 'fulfilmentSort') {
      state.fulfilment.sort = allowListedToken(raw, URL_FULFILMENT_SORTS, 'PRIORITY');
    } else if (kind === 'fulfilmentPageSize') {
      state.fulfilment.pageSize = pageSizeParam(raw);
    } else {
      return;
    }
    // Any filter change restarts paging so page 2 of an old filter can never be
    // requested against the new one.
    syncUrlFromState();
    if (kind.startsWith('procurement')) scheduleProcurementLoad({ resetPage: true });
    else scheduleFulfilmentLoad({ resetPage: true });
    return;
  }
  const productSelectControl = event.target.closest?.('[data-product-select]');
  if (productSelectControl && elements.view.contains(productSelectControl)) {
    const kind = String(productSelectControl.dataset.productSelect || '');
    const raw = String(productSelectControl.value || '');
    if (kind === 'sort') {
      state.products.sort = allowListedToken(raw, URL_PRODUCT_SORTS, 'IMPACT_DESC');
    } else if (kind === 'pageSize') {
      state.products.pageSize = pageSizeParam(raw);
    } else {
      return;
    }
    state.products.pendingPage = 1;
    state.products.canonicalPage = 1;
    syncUrlFromState();
    void loadProducts();
    return;
  }
  const salesSort = event.target.closest?.('[data-sales-sort]');
  if (!salesSort || !elements.view.contains(salesSort)) return;
  const value = String(salesSort.value || '').toUpperCase();
  if (!URL_SALES_SORTS.includes(value)) return;
  state.sales.sort = value;
  state.sales.productPage = 1;
  state.sales.standardPage = 1;
  syncUrlFromState();
  void loadSales();
});

elements.clearFilters.addEventListener('click', () => {
  state.query = '';
  state.owner = 'ALL';
  state.store = 'ALL';
  state.range = 'today';
  state.homeDateStart = null;
  state.homeDateEnd = null;
  state.homeDateCustom = false;
  state.quickFilters = Object.create(null);
  state.focus = null;
  populateScopeOptions();
  syncUrlFromState();
  render();
  scheduleProcurementLoad({ resetPage: true });
  scheduleSalesLoad({ resetPages: true });
  scheduleInventoryLoad({ resetPages: true });
  scheduleProductLoad({ resetPages: true });
  scheduleFulfilmentLoad({ resetPage: true });
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
window.addEventListener('beforeunload', () => {
  if (procurementLoadTimer !== null) window.clearTimeout(procurementLoadTimer);
  if (salesLoadTimer !== null) window.clearTimeout(salesLoadTimer);
  dashboardEventSource?.close();
});

// Normalize whatever arrived in the address bar into the canonical form once, so
// a hand-edited or stale link becomes shareable without a reload.
syncUrlFromState();
render();
loadDashboard();
connectDashboardUpdates();
