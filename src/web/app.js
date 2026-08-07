const numberFormatter = new Intl.NumberFormat('zh-CN');
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  hour12: false,
});
const sourceUpdateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
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
  system: { title: '系统管理', code: 'SYSTEM' },
});

const RANGE_META = Object.freeze({
  today: { label: '今日', note: '当日累计', days: 1 },
  yesterday: { label: '昨日', note: '完整自然日', days: 1 },
  last7Days: { label: '近 7 日', note: '预聚合滚动窗口', days: 7 },
  last30Days: { label: '近 30 日', note: '预聚合滚动窗口', days: 30 },
});

const WINDOW_KEYS = Object.freeze(['today', 'yesterday', 'last7Days', 'last30Days']);

const HOME_RANGE_PRESETS = Object.freeze({
  today: { label: '今天', days: 1, window: 'today' },
  yesterday: { label: '昨天', days: 1, window: 'yesterday' },
  last3: { label: '近3天', days: 3, window: 'last7Days' },
  last7: { label: '近7天', days: 7, window: 'last7Days' },
  last15: { label: '近15天', days: 15, window: 'last30Days' },
  last30: { label: '近30天', days: 30, window: 'last30Days' },
  thisMonth: { label: '本月', mode: 'thisMonth', window: 'last30Days' },
  lastMonth: { label: '上个月', mode: 'lastMonth', window: 'last30Days' },
  last3Months: { label: '近3个月', months: 3, window: 'last30Days' },
  last6Months: { label: '近6个月', months: 6, window: 'last30Days' },
  lastYear: { label: '近一年', months: 12, window: 'last30Days' },
});

const HOME_TREND_METRICS = Object.freeze({
  netDealAmount: { label: '净成交金额', money: true, group: '经营', aggregate: 'sum' },
  dealAmount: { label: '成交金额', money: true, group: '经营', aggregate: 'sum' },
  salesQuantity: { label: '销量', suffix: '件', group: '经营', aggregate: 'sum' },
  buyerCount: { label: '支付人数', group: '经营', aggregate: 'sum' },
  paymentOrderCount: { label: '支付订单', group: '经营', aggregate: 'sum' },
  exposureUsers: { label: '曝光量', group: '流量', aggregate: 'sum' },
  goodsDetailVisitors: { label: '商详访客', group: '流量', aggregate: 'sum' },
  financeNetAmount: {
    label: '财务明细净额',
    money: true,
    group: '财务',
    aggregate: 'sum',
  },
  billSalesAmount: { label: '结算销售款', money: true, group: '结算', aggregate: 'sum' },
  supplementAmount: { label: '补款', money: true, group: '结算', aggregate: 'sum' },
  deductionAmount: { label: '扣款', money: true, group: '结算', aggregate: 'sum' },
  settlementAmount: { label: '实际结算金额', money: true, group: '结算', aggregate: 'sum' },
  ledgerBeginCount: { label: '期初数量', suffix: '件', group: '台账数量', aggregate: 'first' },
  ledgerInboundCount: { label: '入库数量', suffix: '件', group: '台账数量', aggregate: 'sum' },
  ledgerOutboundCount: { label: '出库数量', suffix: '件', group: '台账数量', aggregate: 'sum' },
  ledgerEndCount: { label: '期末数量', suffix: '件', group: '台账数量', aggregate: 'last' },
  ledgerBeginAmount: { label: '期初金额', money: true, group: '台账金额', aggregate: 'first' },
  ledgerInboundAmount: { label: '入库金额', money: true, group: '台账金额', aggregate: 'sum' },
  ledgerOutboundAmount: { label: '出库金额', money: true, group: '台账金额', aggregate: 'sum' },
  ledgerEndAmount: { label: '期末金额', money: true, group: '台账金额', aggregate: 'last' },
});

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
const URL_PLATFORM_VIEWS = Object.freeze(['URGENT', 'ATTENTION', 'BUSINESS', 'ALL']);
const URL_PLATFORM_SEVERITIES = Object.freeze(['ALL', 'P0', 'P1', 'P2', 'P3']);
const URL_PLATFORM_SORTS = Object.freeze(['PRIORITY', 'LATEST']);
const URL_OPS_VIEWS = Object.freeze(['PRIORITY', 'ALL']);
const URL_OPS_SEVERITIES = Object.freeze(['ALL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const URL_OPS_DOMAINS = Object.freeze([
  'ALL',
  'PROCUREMENT',
  'FULFILMENT',
  'INVENTORY',
  'SUPPLY',
  'PRODUCTS',
  'PLATFORM',
  'SYSTEM',
  'OTHER',
]);
const URL_OPS_SORTS = Object.freeze(['PRIORITY', 'LATEST', 'DEADLINE', 'STORE']);
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
      platformView: URL_PLATFORM_VIEWS.includes(inherited.platformView)
        ? inherited.platformView
        : 'URGENT',
      platformSeverity: URL_PLATFORM_SEVERITIES.includes(inherited.platformSeverity)
        ? inherited.platformSeverity
        : 'ALL',
      platformFamily: URL_OPERATION_CODE_PATTERN.test(String(inherited.platformFamily ?? ''))
        ? inherited.platformFamily
        : 'ALL',
      platformStatus: URL_OPERATION_CODE_PATTERN.test(String(inherited.platformStatus ?? ''))
        ? inherited.platformStatus
        : 'ALL',
      platformSort: URL_PLATFORM_SORTS.includes(inherited.platformSort)
        ? inherited.platformSort
        : 'PRIORITY',
      platformPage: 1,
      platformPageSize: URL_INVENTORY_PAGE_SIZES.includes(inherited.platformPageSize)
        ? inherited.platformPageSize
        : URL_DEFAULT_INVENTORY_PAGE_SIZE,
      opsView: URL_OPS_VIEWS.includes(inherited.opsView)
        ? inherited.opsView
        : 'PRIORITY',
      opsSeverity: URL_OPS_SEVERITIES.includes(inherited.opsSeverity)
        ? inherited.opsSeverity
        : 'ALL',
      opsDomain: URL_OPS_DOMAINS.includes(inherited.opsDomain)
        ? inherited.opsDomain
        : 'ALL',
      opsSort: URL_OPS_SORTS.includes(inherited.opsSort)
        ? inherited.opsSort
        : 'PRIORITY',
      opsPage: 1,
      opsPageSize: URL_INVENTORY_PAGE_SIZES.includes(inherited.opsPageSize)
        ? inherited.opsPageSize
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
    platformView: routeView(
      'platform',
      URL_PLATFORM_VIEWS,
      'URGENT',
      inherited.platformView,
    ),
    platformSeverity: allowListedToken(
      params.get('eventSeverity'),
      URL_PLATFORM_SEVERITIES,
      'ALL',
    ),
    platformFamily: operationCodeParam(params.get('eventFamily')),
    platformStatus: operationCodeParam(params.get('eventStatus')),
    platformSort: allowListedToken(
      params.get('eventSort'),
      URL_PLATFORM_SORTS,
      'PRIORITY',
    ),
    platformPage: pageParam('eventPage'),
    platformPageSize: routePageSize('platform', inherited.platformPageSize),
    opsView: routeView('ops', URL_OPS_VIEWS, 'PRIORITY', inherited.opsView),
    opsSeverity: allowListedToken(
      params.get('opsSeverity'),
      URL_OPS_SEVERITIES,
      'ALL',
    ),
    opsDomain: allowListedToken(params.get('opsDomain'), URL_OPS_DOMAINS, 'ALL'),
    opsSort: allowListedToken(params.get('opsSort'), URL_OPS_SORTS, 'PRIORITY'),
    opsPage: pageParam('opsPage'),
    opsPageSize: routePageSize('ops', inherited.opsPageSize),
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
  if (route === 'platform') {
    const view = allowListedToken(input.platformView, URL_PLATFORM_VIEWS, 'URGENT');
    if (view !== 'URGENT') params.set('view', view);
    const severity = allowListedToken(
      input.platformSeverity,
      URL_PLATFORM_SEVERITIES,
      'ALL',
    );
    if (severity !== 'ALL') params.set('eventSeverity', severity);
    const family = operationCodeParam(input.platformFamily);
    if (family !== 'ALL') params.set('eventFamily', family);
    const status = operationCodeParam(input.platformStatus);
    if (status !== 'ALL') params.set('eventStatus', status);
    const sort = allowListedToken(input.platformSort, URL_PLATFORM_SORTS, 'PRIORITY');
    if (sort !== 'PRIORITY') params.set('eventSort', sort);
    if (Number.isSafeInteger(input.platformPage) && input.platformPage > 1) {
      params.set('eventPage', String(Math.min(input.platformPage, 9999)));
    }
    const platformPageSize = pageSizeParam(input.platformPageSize);
    if (platformPageSize !== URL_DEFAULT_INVENTORY_PAGE_SIZE) {
      params.set('size', String(platformPageSize));
    }
  }
  if (route === 'ops') {
    const view = allowListedToken(input.opsView, URL_OPS_VIEWS, 'PRIORITY');
    if (view !== 'PRIORITY') params.set('view', view);
    const severity = allowListedToken(input.opsSeverity, URL_OPS_SEVERITIES, 'ALL');
    if (severity !== 'ALL') params.set('opsSeverity', severity);
    const domain = allowListedToken(input.opsDomain, URL_OPS_DOMAINS, 'ALL');
    if (domain !== 'ALL') params.set('opsDomain', domain);
    const sort = allowListedToken(input.opsSort, URL_OPS_SORTS, 'PRIORITY');
    if (sort !== 'PRIORITY') params.set('opsSort', sort);
    if (Number.isSafeInteger(input.opsPage) && input.opsPage > 1) {
      params.set('opsPage', String(Math.min(input.opsPage, 9999)));
    }
    const opsPageSize = pageSizeParam(input.opsPageSize);
    if (opsPageSize !== URL_DEFAULT_INVENTORY_PAGE_SIZE) {
      params.set('size', String(opsPageSize));
    }
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
  homeRangePreset: ({
    today: 'today',
    yesterday: 'yesterday',
    last7Days: 'last7',
    last30Days: 'last30',
  })[initialHashState.range] || 'today',
  homeDateStart: null,
  homeDateEnd: null,
  homeDateCustom: false,
  homeRangeOpen: false,
  homeCalendarAnchor: null,
  homeCalendarPickingEnd: false,
  homeTrendMetric: 'netDealAmount',
  homeRankingBasis: 'OPERATING',
  query: initialHashState.query,
  owner: initialHashState.owner,
  store: initialHashState.store,
  quickFilters: Object.assign(Object.create(null), (
    initialHashState.quick === 'ALL' ? {} : { [initialHashState.route]: initialHashState.quick }
  )),
  // Read-only investigation target restored from the canonical link.
  focus: initialHashState.focus,
  data: null,
  home: {
    data: null,
    loading: false,
    error: '',
    requestSerial: 0,
    forceRefresh: false,
    lastLoadedAt: null,
    cache: new Map(),
    prefetchScope: '',
    prefetching: false,
  },
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
  platform: {
    data: null,
    loading: false,
    error: '',
    requestSerial: 0,
    view: initialHashState.platformView || 'URGENT',
    severity: initialHashState.platformSeverity || 'ALL',
    family: initialHashState.platformFamily || 'ALL',
    status: initialHashState.platformStatus || 'ALL',
    sort: initialHashState.platformSort || 'PRIORITY',
    page: initialHashState.platformPage || 1,
    pageSize: initialHashState.platformPageSize || URL_DEFAULT_INVENTORY_PAGE_SIZE,
  },
  ops: {
    data: null,
    loading: false,
    error: '',
    requestSerial: 0,
    view: initialHashState.opsView || 'PRIORITY',
    severity: initialHashState.opsSeverity || 'ALL',
    domain: initialHashState.opsDomain || 'ALL',
    sort: initialHashState.opsSort || 'PRIORITY',
    page: initialHashState.opsPage || 1,
    pageSize: initialHashState.opsPageSize || URL_DEFAULT_INVENTORY_PAGE_SIZE,
  },
  system: {
    data: null,
    loading: false,
    error: '',
    requestSerial: 0,
    maintenance: {
      data: null,
      loading: false,
      error: '',
      requestSerial: 0,
      busyAction: '',
      busyStore: '',
      activeUrl: sessionStorage.getItem('fmSystemStoreLoginActiveUrl') || '',
    },
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
  rangeButtons: [...document.querySelectorAll('[data-home-range-preset]')],
  rangeSummary: document.querySelector('#range-summary'),
  rangeToggle: document.querySelector('#range-toggle'),
  rangePopover: document.querySelector('#range-popover'),
  homeCalendarGrid: document.querySelector('#home-calendar-grid'),
  homeDateStart: document.querySelector('#home-date-start'),
  homeDateEnd: document.querySelector('#home-date-end'),
  clearFilters: document.querySelector('#clear-filters'),
  forceRefresh: document.querySelector('#force-refresh'),
  datasetBadge: document.querySelector('#dataset-badge'),
  liveUpdateBadge: document.querySelector('#live-update-badge'),
  updatedAt: document.querySelector('#updated-at'),
  sidebarAccountName: document.querySelector('#sidebar-account-name'),
  sidebarPermission: document.querySelector('#sidebar-permission'),
  sidebarOperatingFreshness: document.querySelector('#sidebar-operating-freshness'),
  sidebarFinanceFreshness: document.querySelector('#sidebar-finance-freshness'),
  sidebarLedgerFreshness: document.querySelector('#sidebar-ledger-freshness'),
  sidebarSettlementFreshness: document.querySelector('#sidebar-settlement-freshness'),
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
let platformLoadTimer = null;
let opsLoadTimer = null;
let systemLoadTimer = null;
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

function formatSourceUpdateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : sourceUpdateTimeFormatter.format(date);
}

function sidebarFreshnessText(source) {
  const businessDate = /^\d{4}-\d{2}-\d{2}$/.test(String(source?.businessDate || ''))
    ? String(source.businessDate)
    : '';
  const observed = source?.observedAt ? new Date(source.observedAt) : null;
  const observedText = observed && !Number.isNaN(observed.valueOf())
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(observed)
    : '';
  return {
    label: observedText || (businessDate ? businessDate.slice(5).replace('-', '/') : '待回读'),
    title: [
      businessDate ? `最新业务日 ${businessDate}` : null,
      observedText ? `最近读取 ${formatDateTime(source.observedAt)}` : null,
    ].filter(Boolean).join(' · ') || '该数据源尚未回读更新时间',
  };
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

function shiftIsoMonth(date, offsetMonths) {
  const parsed = new Date(`${date.slice(0, 7)}-01T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) return date;
  parsed.setUTCMonth(parsed.getUTCMonth() + offsetMonths);
  return parsed.toISOString().slice(0, 10);
}

function monthEnd(date) {
  return shiftIsoDate(shiftIsoMonth(date, 1), -1);
}

function homePresetDateRange(presetKey = state.homeRangePreset) {
  const preset = HOME_RANGE_PRESETS[presetKey] || HOME_RANGE_PRESETS.today;
  const today = shanghaiToday();
  if (presetKey === 'yesterday') {
    const day = shiftIsoDate(today, -1);
    return { start: day, end: day, custom: false };
  }
  if (preset.mode === 'thisMonth') {
    return { start: `${today.slice(0, 7)}-01`, end: today, custom: false };
  }
  if (preset.mode === 'lastMonth') {
    const start = shiftIsoMonth(today, -1);
    return { start, end: monthEnd(start), custom: false };
  }
  if (preset.months) {
    return {
      start: shiftIsoMonth(today, -(preset.months - 1)),
      end: today,
      custom: false,
    };
  }
  return {
    start: shiftIsoDate(today, -((preset.days || 1) - 1)),
    end: today,
    custom: false,
  };
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
  return homePresetDateRange();
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

const OWNER_TONE_COUNT = 8;

function shortOwnerName(value) {
  const name = String(value || '').trim();
  return [...name].length > 2 ? [...name].slice(-2).join('') : name;
}

function ownerDisplayTone(value) {
  const source = String(value || 'unassigned');
  let hash = 0;
  for (const character of source) {
    hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
  }
  return `owner-${(hash % OWNER_TONE_COUNT) + 1}`;
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
      || !Array.isArray(result.statusOverview)
      || !Array.isArray(result.summary?.attentionByStore)
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
      || !Array.isArray(result.summary.attentionByStore)
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

/* --- platform-query:start ---
   The platform workspace reads only `/api/platform`. The materialized event
   slice is filtered and paged on the server, while runtime health, queue and
   subscription readback remain independent evidence. */

function platformQueryUrl() {
  const params = new URLSearchParams({
    owner: state.owner,
    store: state.store,
    q: state.query,
    view: allowListedToken(state.platform.view, URL_PLATFORM_VIEWS, 'URGENT'),
    severity: allowListedToken(
      state.platform.severity,
      URL_PLATFORM_SEVERITIES,
      'ALL',
    ),
    family: operationCodeParam(state.platform.family),
    status: operationCodeParam(state.platform.status),
    sort: allowListedToken(state.platform.sort, URL_PLATFORM_SORTS, 'PRIORITY'),
    page: String(state.platform.page),
    pageSize: String(pageSizeParam(state.platform.pageSize)),
  });
  return `/api/platform?${params.toString()}`;
}

async function loadPlatform({ resetPage = false } = {}) {
  if (resetPage) state.platform.page = 1;
  if (state.route !== 'platform') return;
  const requestSerial = state.platform.requestSerial + 1;
  state.platform.requestSerial = requestSerial;
  state.platform.loading = true;
  state.platform.error = '';
  render();
  try {
    const result = await fetchJson(platformQueryUrl());
    if (requestSerial !== state.platform.requestSerial) return;
    if (
      !result
      || result.readOnly !== true
      || !Array.isArray(result.events?.rows)
      || !result.events?.pagination
      || !result.summary
      || !Array.isArray(result.summary.attentionByStore)
      || !Array.isArray(result.summary.attentionByFamily)
      || !result.subscription
      || !Array.isArray(result.subscription.rows)
      || !result.source
    ) {
      throw new Error('平台动态查询结构无效');
    }
    state.platform.data = result;
  } catch (error) {
    if (requestSerial !== state.platform.requestSerial) return;
    state.platform.data = null;
    state.platform.error = error instanceof Error
      ? error.message
      : '平台动态查询暂不可用';
  } finally {
    if (requestSerial === state.platform.requestSerial) {
      state.platform.loading = false;
      render();
    }
  }
}

function schedulePlatformLoad({ resetPage = false, delay = 0 } = {}) {
  if (platformLoadTimer !== null) window.clearTimeout(platformLoadTimer);
  state.platform.requestSerial += 1;
  if (resetPage) {
    state.platform.page = 1;
    state.platform.data = null;
    state.platform.error = '';
    state.platform.loading = true;
  }
  if (state.route !== 'platform') return;
  if (resetPage) render();
  platformLoadTimer = window.setTimeout(() => {
    platformLoadTimer = null;
    void loadPlatform();
  }, delay);
}

/* --- ops-query:start ---
   The operations workspace reads a bounded server-side worklist. The browser
   receives only one page of rows, while summary metrics and rankings keep the
   full current owner/store scope. */

function opsQuickValue() {
  const active = quickFilterValue('ops');
  return ['HIGH', 'OVERDUE', 'SHORTAGE', 'URGENT', 'SYNC'].includes(active)
    ? active
    : 'ALL';
}

function opsQueryUrl() {
  const params = new URLSearchParams({
    owner: state.owner,
    store: state.store,
    q: state.query,
    view: allowListedToken(state.ops.view, URL_OPS_VIEWS, 'PRIORITY'),
    severity: allowListedToken(state.ops.severity, URL_OPS_SEVERITIES, 'ALL'),
    domain: allowListedToken(state.ops.domain, URL_OPS_DOMAINS, 'ALL'),
    quick: opsQuickValue(),
    sort: allowListedToken(state.ops.sort, URL_OPS_SORTS, 'PRIORITY'),
    page: String(state.ops.page),
    pageSize: String(pageSizeParam(state.ops.pageSize)),
  });
  return `/api/ops?${params.toString()}`;
}

async function loadOps({ resetPage = false } = {}) {
  if (resetPage) state.ops.page = 1;
  if (state.route !== 'ops') return;
  const requestSerial = state.ops.requestSerial + 1;
  state.ops.requestSerial = requestSerial;
  state.ops.loading = true;
  state.ops.error = '';
  render();
  try {
    const result = await fetchJson(opsQueryUrl());
    if (requestSerial !== state.ops.requestSerial) return;
    if (
      !result
      || result.readOnly !== true
      || !Array.isArray(result.worklist?.rows)
      || !result.worklist?.pagination
      || !result.summary
      || !Array.isArray(result.summary.attentionByStore)
      || !Array.isArray(result.summary.attentionByDomain)
      || !result.source
      || !result.automation
    ) {
      throw new Error('运营待办查询结构无效');
    }
    state.ops.data = result;
  } catch (error) {
    if (requestSerial !== state.ops.requestSerial) return;
    state.ops.data = null;
    state.ops.error = error instanceof Error
      ? error.message
      : '运营待办查询暂不可用';
  } finally {
    if (requestSerial === state.ops.requestSerial) {
      state.ops.loading = false;
      render();
    }
  }
}

function scheduleOpsLoad({ resetPage = false, delay = 0 } = {}) {
  if (opsLoadTimer !== null) window.clearTimeout(opsLoadTimer);
  state.ops.requestSerial += 1;
  if (resetPage) {
    state.ops.page = 1;
    state.ops.data = null;
    state.ops.error = '';
    state.ops.loading = true;
  }
  if (state.route !== 'ops') return;
  if (resetPage) render();
  opsLoadTimer = window.setTimeout(() => {
    opsLoadTimer = null;
    void loadOps();
  }, delay);
}
/* --- ops-query:end --- */

/* --- system-query:start ---
   The System workspace reads a sanitized root-owned runtime snapshot plus the
   materialized business coverage. It never reads Profile files or systemd from
   the browser process. */

function systemQueryUrl() {
  const params = new URLSearchParams({
    owner: state.owner,
    store: state.store,
    q: state.query,
  });
  return `/api/system?${params.toString()}`;
}

async function loadSystem() {
  if (state.route !== 'system') return;
  const requestSerial = state.system.requestSerial + 1;
  state.system.requestSerial = requestSerial;
  state.system.loading = true;
  state.system.error = '';
  render();
  try {
    const result = await fetchJson(systemQueryUrl());
    if (requestSerial !== state.system.requestSerial) return;
    if (
      !result
      || result.readOnly !== true
      || !result.verdict
      || !result.summary
      || !Array.isArray(result.issues?.rows)
      || !Array.isArray(result.services?.rows)
      || !Array.isArray(result.profiles?.rows)
      || !Array.isArray(result.coverage?.rows)
      || !Array.isArray(result.readiness)
      || !result.source
    ) {
      throw new Error('系统管理查询结构无效');
    }
    state.system.data = result;
  } catch (error) {
    if (requestSerial !== state.system.requestSerial) return;
    state.system.data = null;
    state.system.error = error instanceof Error
      ? error.message
      : '系统管理查询暂不可用';
  } finally {
    if (requestSerial === state.system.requestSerial) {
      state.system.loading = false;
      render();
    }
  }
}

async function loadSystemLoginMaintenance() {
  if (state.route !== 'system') return;
  const maintenance = state.system.maintenance;
  const requestSerial = maintenance.requestSerial + 1;
  maintenance.requestSerial = requestSerial;
  maintenance.loading = true;
  maintenance.error = '';
  render();
  try {
    const result = await fetchJson('/api/system/store-login/status');
    if (requestSerial !== maintenance.requestSerial) return;
    if (
      !result
      || result.ok !== true
      || !Number.isSafeInteger(result.total)
      || !Number.isSafeInteger(result.completed)
      || !Array.isArray(result.stores)
    ) {
      throw new Error('登录维护状态结构无效');
    }
    maintenance.data = result;
    if (!result.active) {
      maintenance.activeUrl = '';
      sessionStorage.removeItem('fmSystemStoreLoginActiveUrl');
    }
  } catch (error) {
    if (requestSerial !== maintenance.requestSerial) return;
    maintenance.data = null;
    maintenance.error = error instanceof Error
      ? error.message
      : '登录维护中心暂不可用';
  } finally {
    if (requestSerial === maintenance.requestSerial) {
      maintenance.loading = false;
      render();
    }
  }
}

function scheduleSystemLoad({ reset = false, delay = 0 } = {}) {
  if (systemLoadTimer !== null) window.clearTimeout(systemLoadTimer);
  state.system.requestSerial += 1;
  if (reset) {
    state.system.data = null;
    state.system.error = '';
    state.system.loading = true;
  }
  if (state.route !== 'system') return;
  if (reset) render();
  systemLoadTimer = window.setTimeout(() => {
    systemLoadTimer = null;
    void loadSystem();
    void loadSystemLoginMaintenance();
  }, delay);
}
/* --- system-query:end --- */

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
  const controlId = `operation-${kind}`;
  return `
    <label class="sales-sort-control" for="${escapeHtml(controlId)}">
      <span>${escapeHtml(label)}</span>
      <select id="${escapeHtml(controlId)}" name="${escapeHtml(controlId)}" data-operation-select="${escapeHtml(kind)}">
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

/** Truthful coverage line: completed/25 with any in-progress stores named explicitly. */
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
    const [result, history] = await Promise.all([
      fetchJson(salesQueryUrl()),
      fetchJson(homeApiPath()),
    ]);
    if (requestSerial !== state.sales.requestSerial) return;
    if (
      !result
      || result.readOnly !== true
      || !Array.isArray(result.stores?.rows)
      || !Array.isArray(result.products?.rows)
      || !Array.isArray(result.standardProducts?.rows)
      || history?.readOnly !== true
      || !Array.isArray(history.home?.storeDaily)
      || !Array.isArray(history.home?.productDaily)
    ) {
      throw new Error('销量查询结构无效');
    }
    state.sales.data = { ...result, history };
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
    ['INVENTORY', '库存缺货', inventoryMatched],
    ['ADVICE', '备货与急采', adviceMatched],
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
  const controlId = `inventory-${kind}`;
  return `
    <label class="sales-sort-control" for="${escapeHtml(controlId)}">
      <span>${escapeHtml(label)}</span>
      <select id="${escapeHtml(controlId)}" name="${escapeHtml(controlId)}" data-inventory-select="${escapeHtml(kind)}">
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

function inventoryTypeRows(queryData, type) {
  const rows = Array.isArray(queryData?.inventory?.storeSummaryRows)
    ? queryData.inventory.storeSummaryRows
    : [];
  return rows.filter((row) => String(row.inventoryTypeCode || '').toUpperCase() === type);
}

function inventoryCoverageSum(rows, coverageKey, variants) {
  const parts = rows.map((row) => coverageParts(row?.[coverageKey], variants));
  if (!rows.length || parts.some((item) => item === null)) return null;
  return parts.reduce((summary, item) => ({
    known: summary.known + item.known,
    total: summary.total + item.total,
  }), { known: 0, total: 0 });
}

function inventoryScopeLabel() {
  const store = selectedStore();
  if (store) return store.code;
  const owner = selectedOwner();
  if (owner) return `负责人 · ${shortOwnerName(owner.name)}`;
  return '全部店铺';
}

function inventorySummaryCards(queryData) {
  const overview = queryData.overview || {};
  const jiRows = inventoryTypeRows(queryData, 'JI');
  const piRows = inventoryTypeRows(queryData, 'PI');
  const adviceRows = Array.isArray(queryData?.advice?.storeSummaryRows)
    ? queryData.advice.storeSummaryRows
    : [];
  const jiInventory = completeNullableSum(jiRows, 'inventoryQuantity');
  const jiUsable = completeNullableSum(jiRows, 'usableInventory');
  const piInventory = completeNullableSum(piRows, 'inventoryQuantity');
  const shortageSku = completeCoveredNullableSum(
    jiRows,
    'shortageSkuCount',
    'shortageCoverage',
    [['knownSkuCount', 'totalSkuCount', 'SKU']],
  );
  const shortageQuantity = completeCoveredNullableSum(
    jiRows,
    'shortageQuantity',
    'shortageCoverage',
    [['knownSkuCount', 'totalSkuCount', 'SKU']],
  );
  const urgentQuantity = completeCoveredNullableSum(
    adviceRows,
    'plannedUrgentQuantity',
    'plannedUrgentCoverage',
    [['knownSkuCount', 'totalSkuCount', 'SKU']],
  );
  const adviceCoverage = inventoryCoverageSum(
    adviceRows,
    'advisedOrderCoverage',
    [['knownSkuCount', 'totalSkuCount', 'SKU']],
  );
  const inventoryCoverage = queryData.source?.coverage?.inventory || {};
  const observedStores = new Set(jiRows.map(({ storeCode }) => storeCode).filter(Boolean)).size;
  const adviceKnownLabel = adviceCoverage
    ? `${numberFormatter.format(adviceCoverage.known)} / ${numberFormatter.format(adviceCoverage.total)} SKU`
    : '覆盖未知';
  const shortageLabel = isUnit(shortageSku) && isUnit(shortageQuantity)
    ? `${numberFormatter.format(shortageSku)} SKU / ${numberFormatter.format(shortageQuantity)} 件`
    : '未知';
  const adviceImpact = overview.advised || {};
  return `
    <section class="sales-period-overview inventory-decision-overview" aria-label="库存与备货经营概览">
      <header class="sales-workspace-head">
        <div>
          <span class="eyebrow">INVENTORY ANALYSIS</span>
          <h1>库存与备货</h1>
          <p>先看全盘库存、缺货和急采结论，再进入 SKU 清单处理；JI、PI、VI 始终分开，不把未知补成 0。</p>
        </div>
        <div class="sales-range-receipt">
          <span>库存业务日 / 当前范围</span>
          <strong>${escapeHtml(`${queryData.source?.businessDate || '业务日未知'} · ${inventoryScopeLabel()}`)}</strong>
          <small>${escapeHtml(`${numberFormatter.format(observedStores)} 家店有 JI 汇总 · 顶部日期不改写当前库存快照`)}</small>
        </div>
      </header>
      <div class="sales-period-grid inventory-decision-grid">
        ${salesPeriodMetric('JI 库存', isUnit(jiInventory) ? `${numberFormatter.format(jiInventory)} 件` : '未知', `${numberFormatter.format(jiRows.length)} 个店铺快照 · 平台库存类型原值`, 'primary')}
        ${salesPeriodMetric('JI 可用库存', isUnit(jiUsable) ? `${numberFormatter.format(jiUsable)} 件` : '未知', '只汇总字段完整的 JI 店铺快照')}
        ${salesPeriodMetric('PI 库存', isUnit(piInventory) ? `${numberFormatter.format(piInventory)} 件` : '未知', `${numberFormatter.format(piRows.length)} 个店铺快照 · 不与 JI 相加`)}
        ${salesPeriodMetric('缺货需求', shortageLabel, `涉及 ${nullableUnits(overview.shortage?.affectedStoreCount, '未知')} 家店`)}
        ${salesPeriodMetric('计划急采', isUnit(urgentQuantity) ? `${numberFormatter.format(urgentQuantity)} 件` : '未知', `${nullableUnits(overview.urgent?.positiveRowCount, '未知')} 个 SKU 有急采量`)}
        ${salesPeriodMetric('建议量字段覆盖', adviceKnownLabel, isUnit(adviceImpact.unknownCount) && adviceImpact.unknownCount > 0 ? `风险队列仍有 ${numberFormatter.format(adviceImpact.unknownCount)} 行建议量未知` : '建议量字段完整')}
      </div>
      <div class="sales-data-receipt">
        <span><i></i>库存快照覆盖</span>
        <p>${escapeHtml(`${nullableUnits(inventoryCoverage.succeededStores, '未知')} / ${nullableUnits(inventoryCoverage.totalStores, '未知')} 家成功 · 最新来源 ${sourceTime(queryData.source?.latestSourceFetchedAt)} · ${inventoryCoverage.reason || '覆盖说明待确认'}`)}</p>
      </div>
    </section>`;
}

function inventoryPriorityCards(queryData) {
  const overview = queryData.overview || {};
  const shortage = overview.shortage || {};
  const urgent = overview.urgent || {};
  const advised = overview.advised || {};
  const reconciliation = overview.reconciliation || {};
  const advisedValue = isUnit(advised.total)
    ? `${numberFormatter.format(advised.total)} 件`
    : isUnit(advised.knownSum)
      ? `≥ ${numberFormatter.format(advised.knownSum)} 件`
      : '未知';
  return operationSummaryCards([
    {
      label: '先处理 · 缺货',
      value: `${nullableUnits(shortage.positiveRowCount, '未知')} 个 SKU`,
      note: `${nullableUnits(shortage.affectedStoreCount, '未知')} 家店 · 缺货 ${isUnit(shortage.total) ? numberFormatter.format(shortage.total) : '未知'} 件`,
      tone: isUnit(shortage.positiveRowCount) && shortage.positiveRowCount > 0 ? 'blocked' : 'available',
    },
    {
      label: '再复核 · 急采',
      value: `${nullableUnits(urgent.positiveRowCount, '未知')} 个 SKU`,
      note: `${nullableUnits(urgent.affectedStoreCount, '未知')} 家店 · 计划急采 ${isUnit(urgent.total) ? numberFormatter.format(urgent.total) : '未知'} 件`,
      tone: isUnit(urgent.positiveRowCount) && urgent.positiveRowCount > 0 ? 'partial' : 'available',
    },
    {
      label: '平台建议量',
      value: advisedValue,
      note: isUnit(advised.unknownCount) && advised.unknownCount > 0
        ? `${numberFormatter.format(advised.knownCount)} 行已知 · ${numberFormatter.format(advised.unknownCount)} 行未知`
        : '当前风险队列建议量字段完整',
      tone: isUnit(advised.unknownCount) && advised.unknownCount > 0 ? 'partial' : 'available',
    },
    {
      label: '对账异常',
      value: `${nullableUnits(reconciliation.rowCount, '未知')} 行`,
      note: isUnit(reconciliation.rowCount) && reconciliation.rowCount > 0
        ? `涉及 ${nullableUnits(reconciliation.affectedStoreCount, '未知')} 家店，进入差异筛查`
        : 'RECONCILED 视为已对账，不再误报为异常',
      tone: isUnit(reconciliation.rowCount) && reconciliation.rowCount > 0 ? 'blocked' : 'available',
    },
  ]);
}

function inventoryStoreRankings(queryData) {
  const jiRows = inventoryTypeRows(queryData, 'JI');
  const adviceRows = Array.isArray(queryData?.advice?.storeSummaryRows)
    ? queryData.advice.storeSummaryRows
    : [];
  const rankedRow = (row, value, sub) => {
    const store = baseStores().find(({ code }) => code === row.storeCode);
    const ownerName = ownerNameForStore(store);
    return {
      key: row.storeCode,
      label: row.storeCode,
      ownerName,
      tone: ownerDisplayTone(ownerKeyForStore(store) || ownerName),
      value,
      sub,
    };
  };
  const shortage = jiRows
    .filter((row) => isUnit(row.shortageQuantity) && row.shortageQuantity > 0)
    .map((row) => rankedRow(
      row,
      row.shortageQuantity,
      `缺货 ${nullableUnits(row.shortageSkuCount, '未知')} SKU · JI 可用 ${nullableUnits(row.usableInventory, '未知')} 件`,
    ))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, 8);
  const urgent = adviceRows
    .filter((row) => isUnit(row.plannedUrgentQuantity) && row.plannedUrgentQuantity > 0)
    .map((row) => rankedRow(
      row,
      row.plannedUrgentQuantity,
      `${fieldCoverageLabel(row.plannedUrgentCoverage, [['knownSkuCount', 'totalSkuCount', 'SKU']])} · 总 SKU ${nullableUnits(row.totalSkuCount, '未知')}`,
    ))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, 8);
  return `
    <section class="rank-grid inventory-risk-rankings" aria-label="库存与急采店铺排行">
      ${historyRankTable(
        '缺货数量店铺排行',
        'JI 缺货需求 · Top 8 · 先处理缺货数量高的店铺',
        shortage,
        { defaultTone: 'store-quantity' },
      )}
      ${historyRankTable(
        '计划急采店铺排行',
        '平台急采数量 · Top 8 · 只使用字段完整的店铺快照',
        urgent,
        { defaultTone: 'product-quantity' },
      )}
    </section>`;
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

function inventoryEvidenceDisclosure(queryData) {
  const inventoryView = state.inventory.view === 'INVENTORY';
  return `
    <details class="panel product-boundary-disclosure inventory-evidence-disclosure">
      <summary>
        <span class="eyebrow">DETAIL & BOUNDARY</span>
        <strong>店铺汇总与口径说明</strong>
        <small>${escapeHtml(inventoryView ? '展开查看店铺 × 库存类型完整汇总' : '展开查看店铺级备货字段覆盖')}</small>
      </summary>
      <div class="inventory-disclosure-body">
        ${panelHeading(
          inventoryView ? 'STORE INVENTORY SUMMARY' : 'STORE ADVICE SUMMARY',
          inventoryView ? '店铺 × 库存类型汇总' : '店铺级平台备货建议汇总',
          '服务端已按当前负责人、店铺和搜索范围筛选',
        )}
        ${inventoryStoreSummary(queryData)}
        <div class="inventory-boundary-grid">
          <article><strong>库存类型</strong><span>JI、PI、VI 保留平台原值，任何页面合计都不把三种类型混在一起。</span></article>
          <article><strong>未知值</strong><span>字段缺失以“—”和覆盖率表达，不参与合计，也不冒充业务 0。</span></article>
          <article><strong>平台建议</strong><span>建议量、急采量和预警是只读事实，不等于采购动作已经执行。</span></article>
          <article><strong>顶部日期</strong><span>当前库存使用最新快照；顶部日期只影响有历史事实的页面，不改写库存业务日。</span></article>
        </div>
      </div>
    </details>`;
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

function queryRangeForProductImpact() {
  const range = state.products.data?.query?.range;
  return URL_RANGE_KEYS.includes(range) ? range : URL_DEFAULT_RANGE;
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
  const controlId = `product-${kind}`;
  return `
    <label class="sales-sort-control" for="${escapeHtml(controlId)}">
      <span>${escapeHtml(label)}</span>
      <select id="${escapeHtml(controlId)}" name="${escapeHtml(controlId)}" data-product-select="${escapeHtml(kind)}">
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
  const pendingRows = isUnit(summary.matchedMaterializedPendingRows)
    ? numberFormatter.format(summary.matchedMaterializedPendingRows)
    : '未知';
  const fixedRange = RANGE_META[queryData.query?.range]?.label || '固定窗口';
  return `
    <section class="sales-period-overview product-decision-overview" aria-label="商品身份经营概览">
      <header class="sales-workspace-head">
        <div>
          <span class="eyebrow">PRODUCT ANALYSIS</span>
          <h1>商品分析</h1>
          <p>先按销量影响处理待归并货号，再查看标准商品的跨店覆盖；店内身份不会被裸 SKU 误合并。</p>
        </div>
        <div class="sales-range-receipt">
          <span>身份盘点 / 销量影响窗口</span>
          <strong>${escapeHtml(`${queryData.source?.businessDate || '业务日未知'} · ${fixedRange}`)}</strong>
          <small>身份覆盖不依赖顶部日期；销量影响只使用平台已接入的固定窗口</small>
        </div>
      </header>
      <div class="sales-period-grid product-decision-grid">
        ${salesPeriodMetric('活跃目录 SKU', nullableUnits(catalog.totalSkus, '未知'), '这是全量活跃目录口径，不依赖销量业务日', 'primary')}
        ${salesPeriodMetric('已确认身份', nullableUnits(catalog.confirmedSkus, '未知'), `覆盖率 ${coverageValue} · 未确认 ${nullableUnits(catalog.unconfirmedSkus, '未知')}`)}
        ${salesPeriodMetric('标准商品', `${nullableUnits(canonical.globalActiveProductCount, '未知')} 个`, `当前生效归并 ${nullableUnits(assignments.currentConfirmedCount, '未知')} 条`)}
        ${salesPeriodMetric('待归并队列', `${pendingRows} 条`, `涉及 ${nullableUnits(summary.pendingStoreCount, '未知')} 家店`)}
        ${salesPeriodMetric(`${fixedRange}待归并影响`, impactValue, isUnit(impact.unknownCount) && impact.unknownCount > 0 ? `${numberFormatter.format(impact.unknownCount)} 行未知，已按 ≥ 展示` : '销量窗口完整')}
        ${salesPeriodMetric('全量目录缺 SPU', `${nullableUnits(catalog.missingSpuSkus, '未知')} 个`, `销量物化队列命中 ${nullableUnits(summary.missingSpuStoreSkuRows, '未知')} 条`)}
      </div>
      <div class="sales-data-receipt">
        <span><i></i>证据覆盖（最新密封 run）</span>
        <p>${escapeHtml(`${nullableUnits(evidence.sealedSetCount, '未知')} 组 / ${nullableUnits(evidence.observedStoreCount, '未知')} 店 · 标识符成员 ${nullableUnits(evidence.identifierMemberCount, '未知')} 条 · 最新密封 ${sourceTime(evidence.latestSealedAt)} · 源物化 ${nullableUnits(pendingSource.returned, '未知')} / ${nullableUnits(pendingSource.total, '未知')}${pendingSource.truncated === true ? '，已截断' : ''}`)}</p>
      </div>
    </section>`;
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
    <section class="panel product-pipeline-panel">
      ${panelHeading(
        'IDENTITY RESOLUTION',
        '归并进度',
        unknown
          ? '身份归并证据当前不可用，四个阶段数量均显示未知，不显示 0'
          : `身份归并流水线（只读） · 真实聚合计数 · ${String(pipeline.note || '')}`,
      )}
      <ol class="process-flow four-steps product-pipeline-rail">
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

function productPendingStoreRanking(queryData) {
  const rows = Array.isArray(queryData.summary?.pendingByStore)
    ? queryData.summary.pendingByStore
    : [];
  const ranked = rows.map((item) => {
    const store = baseStores().find(({ code }) => code === item.storeCode);
    const ownerName = ownerNameForStore(store);
    const value = isUnit(item.impact?.total)
      ? item.impact.total
      : isUnit(item.impact?.knownSum)
        ? item.impact.knownSum
        : 0;
    const unknown = isUnit(item.impact?.unknownCount) ? item.impact.unknownCount : null;
    return {
      key: item.storeCode,
      label: item.storeCode,
      ownerName,
      tone: ownerDisplayTone(ownerKeyForStore(store) || ownerName),
      value,
      sub: [
        `待归并 ${nullableUnits(item.pendingRows, '未知')} 条`,
        `有销量 ${nullableUnits(item.withSalesRows, '未知')} 条`,
        item.missingSpuRows ? `缺 SPU ${numberFormatter.format(item.missingSpuRows)} 条` : null,
        unknown ? `${numberFormatter.format(unknown)} 条销量未知` : null,
      ].filter(Boolean).join(' · '),
    };
  });
  return historyRankTable(
    '待归并销量影响店铺排行',
    `${RANGE_META[queryData.query?.range]?.label || '固定窗口'} · Top 8 · 先处理高影响店铺；条形长度代表当前榜内相对规模`,
    ranked.slice(0, 8),
    { defaultTone: 'product-quantity' },
  );
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
      <table class="data-table product-table pending-mapping-table product-decision-table" id="product-workspace-table" role="tabpanel" aria-labelledby="product-tab-PENDING">
        <caption class="sr-only">当前筛选命中的已物化待归并店内货号</caption>
        <thead><tr><th scope="col">序号</th><th scope="col">店铺</th><th scope="col">店内货号 / 商品</th><th scope="col">SPU / SKC / SKU</th><th scope="col" class="number-column">今日</th><th scope="col" class="number-column">近 7 日</th><th scope="col" class="number-column">近 30 日</th><th scope="col" class="number-column">当前窗口影响</th><th scope="col">归并状态</th><th scope="col">定位</th></tr></thead>
        <tbody>${visible.map((item, index) => `
          <tr class="${isFocusedRow(item, 'product') ? 'focused-row' : ''}">
            <td class="row-index">${String(index + 1).padStart(2, '0')}</td>
            <td class="entity-column"><strong>${escapeHtml(item.storeCode || '店铺待确认')}</strong><span>${escapeHtml(shortOwnerName(ownerNameForStoreCode(item.storeCode)) || '负责人待分配')}</span></td>
            <td class="entity-column product-name-cell"><strong>${escapeHtml(item.supplierCode || item.supplierSku || item.productKey || '店内货号待确认')}</strong><span>${escapeHtml([productName(item), item.supplierSku].filter(Boolean).join(' · '))}</span></td>
            <td class="entity-column"><strong>${escapeHtml(item.sku || 'SKU 待确认')}</strong><span>${escapeHtml([item.skc || 'SKC 待确认', item.productKey].filter(Boolean).join(' · '))}</span></td>
            <td class="number-column">${formatUnits(item?.unitsSold?.today)}</td>
            <td class="number-column">${formatUnits(item?.unitsSold?.last7Days)}</td>
            <td class="number-column">${formatUnits(item?.unitsSold?.last30Days)}</td>
            <td class="number-column selected-column"><strong>${formatUnits(item?.unitsSold?.[queryRangeForProductImpact()])}</strong></td>
            <td><span class="row-status partial">${escapeHtml(mappingStatusLabel(item.mappingStatus))}</span></td>
            <td>${rowFocusLink(item, 'product')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">当前页显示 ${numberFormatter.format(visible.length)} 条，排序与分页由服务端决定。“—”表示该窗口未知而非 0；平台 SPU/SKC/SKU 仅在本店为强标识，禁止跨店按裸 SKU 合并，不参与跨店标准商品合计。</p>`;
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
      <table class="data-table product-table product-decision-table canonical-product-table" id="product-workspace-table" role="tabpanel" aria-labelledby="product-tab-CANONICAL">
        <caption class="sr-only">当前筛选命中的已确认跨店标准商品</caption>
        <thead><tr><th scope="col">序号</th><th scope="col">标准商品</th><th scope="col">覆盖店铺</th><th scope="col" class="number-column">今日</th><th scope="col" class="number-column">近 7 日</th><th scope="col" class="number-column">近 30 日</th><th scope="col" class="number-column">当前窗口影响</th><th scope="col">可比动量</th><th scope="col">确认状态</th><th scope="col">定位</th></tr></thead>
        <tbody>${visible.map((item, index) => {
          const scopedCount = isUnit(item.scopedStoreCount) ? item.scopedStoreCount : null;
          const totalCount = isUnit(item.totalStoreCount) ? item.totalStoreCount : null;
          const breakdown = Array.isArray(item.storeBreakdown) ? item.storeBreakdown : [];
          return `
          <tr class="${isFocusedRow(item, 'product') ? 'focused-row' : ''}">
            <td class="row-index">${String(index + 1).padStart(2, '0')}</td>
            <td class="entity-column"><strong>${escapeHtml(item.standardProductCode || item.canonicalProductId || '标准商品待编号')}</strong><span>${escapeHtml(productName(item))}</span></td>
            <td class="entity-column"><strong>${escapeHtml(scopedCount === null ? '店铺数未知' : `${numberFormatter.format(scopedCount)} 家店`)}</strong><span>${escapeHtml(breakdown.slice(0, 4).map(({ storeCode }) => storeCode).join(' · ') || '店铺明细未知')}${breakdown.length > 4 ? ' …' : ''}</span></td>
            <td class="number-column">${formatUnits(item?.unitsSold?.today)}</td>
            <td class="number-column">${formatUnits(item?.unitsSold?.last7Days)}</td>
            <td class="number-column">${formatUnits(item?.unitsSold?.last30Days)}</td>
            <td class="number-column selected-column"><strong>${formatUnits(item?.unitsSold?.[queryRangeForProductImpact()])}</strong></td>
            ${homeMomentumCell(item)}
            <td><span class="rank-identity canonical">GLOBAL 已确认</span><small class="product-scope-note">${escapeHtml(item.scopeRecomputed === true
              ? `范围内 ${scopedCount === null ? '未知' : numberFormatter.format(scopedCount)} / 全量 ${totalCount === null ? '未知' : numberFormatter.format(totalCount)} 店`
              : '允许跨店合计')}</small></td>
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
    <details class="panel product-boundary-disclosure">
      <summary><span>IDENTITY BOUNDARY</span><strong>查看身份判定边界（只读）</strong><small>强证据、召回信号与冲突阻断项；本页没有合并、审批或编辑入口</small></summary>
      <ul class="condition-list">
        <li><strong>店内强标识</strong><span>平台 SPU、SKC、SKU 只在同一店铺内是强标识，跨店不成立</span></li>
        <li><strong>仅召回信号</strong><span>供应商编码、商家 SKU、标题与图片 URL 只用于生成候选，不作为归并证据</span></li>
        <li><strong>强证据</strong><span>有效 GTIN 与官方型号属性 1000546；品类、品牌与白名单规格只在严格策略下参与</span></li>
        <li><strong>冲突阻断</strong><span>电压、插头、容量、端子品类或关键尺寸冲突时禁止自动合并</span></li>
        <li><strong>聚合边界</strong><span>只有 GLOBAL + CONFIRMED 归并可跨店聚合，店内行始终隔离</span></li>
        <li><strong>写入能力</strong><span>本批不写 SHEIN，也不写归并与决策；所有控件保持只读</span></li>
      </ul>
    </details>`;
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
  if (/(complete|success|received|inbound|active|enabled|granted|processed|reconciled|healthy|ok)/.test(normalized)) return 'complete';
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
  const routeFallback = URL_ROUTE_KEYS.includes(String(item?.route || ''))
    ? `#${item.route}`
    : '#ops';
  if (!domain) return item?.href || routeFallback;
  const explicit = String(item?.focusCode ?? '').trim();
  const code = explicit !== '' && URL_CODE_PATTERN.test(explicit)
    ? explicit
    : focusCodeFor(item, domain) || (() => {
      const fallback = String(item?.objectCode ?? item?.entityCode ?? '').trim();
      return URL_CODE_PATTERN.test(fallback) ? fallback : '';
    })();
  if (code === '') return item?.href || routeFallback;
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

function finiteMetric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function homeHistory() {
  const source = (
    state.route === 'sales'
      ? state.sales.data?.history?.home
      : state.home.data?.home
  ) ?? state.data?.home;
  return source && typeof source === 'object'
    ? source
    : {
        status: 'unavailable',
        storeDaily: [],
        productDaily: [],
        regionDaily: [],
        financeDaily: [],
        productFinanceDaily: [],
        ledgerDaily: [],
        billDaily: [],
        settlementPositionDaily: [],
        todayStoreDaily: [],
        currentSettlementPosition: [],
        analysisCapabilities: [],
        coverage: {},
      };
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
    row.standardGoodsCode,
    row.standardGoodsName,
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
  const financeDaily = (Array.isArray(history.financeDaily) ? history.financeDaily : [])
    .filter((row) => effectiveCodes.has(String(row.storeCode)))
    .filter((row) => homeDateInRange(row.date, range));
  const ledgerDaily = (Array.isArray(history.ledgerDaily) ? history.ledgerDaily : [])
    .filter((row) => effectiveCodes.has(String(row.storeCode)))
    .filter((row) => homeDateInRange(row.date, range));
  const billDaily = (Array.isArray(history.billDaily) ? history.billDaily : [])
    .filter((row) => effectiveCodes.has(String(row.storeCode)))
    .filter((row) => homeDateInRange(row.date, range));
  const settlementPositionDaily = (
    Array.isArray(history.settlementPositionDaily)
      ? history.settlementPositionDaily
      : []
  )
    .filter((row) => effectiveCodes.has(String(row.storeCode)))
    .filter((row) => homeDateInRange(row.date, range));
  const productFinanceCandidates = (
    Array.isArray(history.productFinanceDaily) ? history.productFinanceDaily : []
  )
    .filter((row) => baseCodes.has(String(row.storeCode)))
    .filter((row) => homeDateInRange(row.date, range));
  const matchingProductFinance = query
    ? productFinanceCandidates.filter(homeProductSearchMatch)
    : productFinanceCandidates;
  const productFinanceDaily = productMode
    ? matchingProductFinance
    : productFinanceCandidates.filter(
        (row) => effectiveCodes.has(String(row.storeCode)),
      );
  return {
    range,
    storeDaily,
    productDaily,
    regionDaily,
    financeDaily,
    ledgerDaily,
    billDaily,
    settlementPositionDaily,
    productFinanceDaily,
    storeCodes: effectiveCodes,
    productMode,
  };
}

/**
 * SHEIN's product-diagnose endpoint settles at day grain and returns an empty
 * catalogue for the current Shanghai business day. Keep the exact historical
 * rows untouched, but make the current-day ranking useful by allocating each
 * store's verified realtime quantity over that store's latest settled product
 * mix. Allocation uses largest remainders, so every store's estimated product
 * quantities add back to the exact realtime store total.
 */
function estimatedCurrentProductRows(bundle) {
  const today = shanghaiToday();
  if (bundle?.range?.end !== today) return [];
  const history = homeHistory();
  const allowedStores = bundle.storeCodes instanceof Set
    ? bundle.storeCodes
    : new Set(bundle.storeCodes || []);
  const actualTodayStores = new Set((bundle.productDaily || [])
    .filter(({ date }) => date === today)
    .map(({ storeCode }) => String(storeCode)));
  const todayQuantityByStore = new Map();
  for (const row of bundle.storeDaily || []) {
    if (row.date !== today || !isUnit(row.salesQuantity)) continue;
    todayQuantityByStore.set(
      String(row.storeCode),
      (todayQuantityByStore.get(String(row.storeCode)) || 0) + row.salesQuantity,
    );
  }
  const candidates = (Array.isArray(history.productDaily) ? history.productDaily : [])
    .filter((row) => allowedStores.has(String(row.storeCode)))
    .filter((row) => typeof row.date === 'string' && row.date < today)
    .filter(homeProductSearchMatch)
    .filter((row) => isUnit(row.salesQuantity) && row.salesQuantity > 0);
  const latestDateByStore = new Map();
  for (const row of candidates) {
    const storeCode = String(row.storeCode);
    if (!latestDateByStore.has(storeCode) || row.date > latestDateByStore.get(storeCode)) {
      latestDateByStore.set(storeCode, row.date);
    }
  }
  const rowsByStore = new Map();
  for (const row of candidates) {
    const storeCode = String(row.storeCode);
    if (row.date !== latestDateByStore.get(storeCode)) continue;
    const values = rowsByStore.get(storeCode) || [];
    values.push(row);
    rowsByStore.set(storeCode, values);
  }
  const estimated = [];
  for (const [storeCode, realtimeQuantity] of todayQuantityByStore) {
    if (actualTodayStores.has(storeCode) || realtimeQuantity <= 0) continue;
    const referenceRows = rowsByStore.get(storeCode) || [];
    const referenceTotal = referenceRows.reduce((sum, row) => sum + row.salesQuantity, 0);
    if (referenceTotal <= 0) continue;
    const allocations = referenceRows.map((row) => {
      const exact = (realtimeQuantity * row.salesQuantity) / referenceTotal;
      return { row, quantity: Math.floor(exact), remainder: exact - Math.floor(exact) };
    });
    let remaining = realtimeQuantity - allocations.reduce((sum, row) => sum + row.quantity, 0);
    allocations.sort((left, right) => (
      right.remainder - left.remainder
      || right.row.salesQuantity - left.row.salesQuantity
      || String(left.row.productKey).localeCompare(String(right.row.productKey))
    ));
    for (const allocation of allocations) {
      if (remaining <= 0) break;
      allocation.quantity += 1;
      remaining -= 1;
    }
    for (const { row, quantity } of allocations) {
      if (quantity <= 0) continue;
      const referenceUnitAmount = finiteMetric(row.unitPriceEvidence)
        ? row.unitPriceEvidence
        : finiteMetric(row.estimatedDealAmount) && row.salesQuantity > 0
          ? row.estimatedDealAmount / row.salesQuantity
          : null;
      estimated.push({
        ...row,
        date: today,
        salesQuantity: quantity,
        estimatedDealAmount: referenceUnitAmount !== null
          ? quantity * referenceUnitAmount
          : null,
        estimationBasis: 'REALTIME_STORE_QUANTITY_X_LATEST_PRODUCT_SHARE',
        rankingSource: 'REALTIME_SHARE_ESTIMATE',
        rankingReferenceDate: row.date,
      });
    }
  }
  return estimated;
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

function completeSignedMetricSum(rows, key) {
  if (!rows.length) return null;
  const values = rows.map((row) => row?.[key]);
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return null;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) ? total : null;
}

function availableMetricSum(rows, key) {
  const values = rows.map((row) => row?.[key]).filter(finiteMetric);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function availableSignedMetricSum(rows, key) {
  const values = rows.map((row) => row?.[key])
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function homeStoreDateKey(row) {
  return `${row?.storeCode || ''}\u001f${row?.date || ''}`;
}

function firstRowByStoreDate(rows) {
  return new Map(rows.map((row) => [homeStoreDateKey(row), row]));
}

function homeOperatingBasis(row) {
  const codes = Array.isArray(row?.sourceCodes) ? row.sourceCodes : [];
  if (codes.includes('WEBAPI_REALTIME')) return 'WEBAPI_REALTIME';
  if (codes.includes('WEBAPI_INDEX')) return 'WEBAPI_INDEX';
  return 'WEBAPI';
}

function resolvedHomeDaily(bundle) {
  if (bundle.productMode) {
    const group = (rows) => {
      const result = new Map();
      for (const row of rows) {
        const key = homeStoreDateKey(row);
        const current = result.get(key) || [];
        current.push(row);
        result.set(key, current);
      }
      return result;
    };
    const operating = group(bundle.productDaily);
    const finance = group(bundle.productFinanceDaily);
    const keys = new Set([...operating.keys(), ...finance.keys()]);
    return [...keys].map((key) => {
      const directRows = operating.get(key) || [];
      const billedRows = finance.get(key) || [];
      const seed = directRows[0] || billedRows[0];
      const billedAmount = availableSignedMetricSum(billedRows, 'netAmount');
      const estimatedAmount = availableMetricSum(directRows, 'estimatedDealAmount');
      const directQuantity = availableMetricSum(directRows, 'salesQuantity');
      return {
        storeCode: seed?.storeCode,
        date: seed?.date,
        dealAmount: estimatedAmount,
        netDealAmount: null,
        financeNetAmount: billedAmount,
        salesQuantity: directQuantity,
        webapiSalesQuantity: directQuantity,
        currency: billedRows[0]?.currency || directRows[0]?.estimationCurrency || null,
        operatingAmountBasis: estimatedAmount !== null ? 'ESTIMATED' : 'UNAVAILABLE',
        salesQuantityBasis: directQuantity !== null
          ? 'WEBAPI'
          : 'UNAVAILABLE',
      };
    });
  }

  const operating = firstRowByStoreDate(bundle.storeDaily);
  const finance = firstRowByStoreDate(bundle.financeDaily);
  const ledger = firstRowByStoreDate(bundle.ledgerDaily);
  const bill = firstRowByStoreDate(bundle.billDaily);
  const settlementPosition = firstRowByStoreDate(bundle.settlementPositionDaily);
  const keys = new Set([
    ...operating.keys(),
    ...finance.keys(),
    ...ledger.keys(),
    ...bill.keys(),
    ...settlementPosition.keys(),
  ]);
  return [...keys].map((key) => {
    const live = operating.get(key);
    const confirmedFinance = finance.get(key);
    const confirmedLedger = ledger.get(key);
    const confirmedBill = bill.get(key);
    const pendingPosition = settlementPosition.get(key);
    const seed = live
      || confirmedFinance
      || confirmedLedger
      || confirmedBill
      || pendingPosition;
    const operatingBasis = homeOperatingBasis(live);
    const otherOutboundCount = (
      isUnit(confirmedLedger?.outboundCount)
      && isUnit(confirmedLedger?.customerOutboundCount)
      && confirmedLedger.outboundCount >= confirmedLedger.customerOutboundCount
    )
      ? confirmedLedger.outboundCount - confirmedLedger.customerOutboundCount
      : null;
    const otherOutboundAmount = (
      finiteMetric(confirmedLedger?.outboundAmount)
      && finiteMetric(confirmedLedger?.customerOutboundAmount)
      && confirmedLedger.outboundAmount >= confirmedLedger.customerOutboundAmount
    )
      ? confirmedLedger.outboundAmount - confirmedLedger.customerOutboundAmount
      : null;
    return {
      storeCode: seed?.storeCode,
      date: seed?.date,
      currency: live?.currency
        || confirmedFinance?.currency
        || confirmedBill?.currency
        || confirmedLedger?.currency
        || pendingPosition?.currency
        || null,
      dealAmount: live?.dealAmount ?? null,
      netDealAmount: live?.netDealAmount ?? null,
      financeNetAmount: confirmedFinance?.netAmount ?? null,
      salesQuantity: live?.salesQuantity ?? null,
      webapiSalesQuantity: live?.salesQuantity ?? null,
      operatingAmountBasis: finiteMetric(live?.netDealAmount)
        || finiteMetric(live?.dealAmount)
        ? operatingBasis
        : 'UNAVAILABLE',
      salesQuantityBasis: isUnit(live?.salesQuantity)
        ? operatingBasis
        : 'UNAVAILABLE',
      buyerCount: live?.buyerCount ?? null,
      paymentOrderCount: live?.paymentOrderCount ?? null,
      exposureUsers: live?.exposureUsers ?? null,
      goodsDetailVisitors: live?.goodsDetailVisitors ?? null,
      stockingOrderCount: live?.stockingOrderCount ?? null,
      urgentPurchaseOrderCount: live?.urgentPurchaseOrderCount ?? null,
      newCustomerSalesQuantity: live?.newCustomerSalesQuantity ?? null,
      newCustomerPaymentOrderCount: live?.newCustomerPaymentOrderCount ?? null,
      billSalesAmount: confirmedBill?.salesAmount ?? null,
      supplementAmount: confirmedBill?.supplementAmount ?? null,
      deductionAmount: confirmedBill?.deductionAmount ?? null,
      settlementAmount: confirmedBill?.reportedSettlementAmount
        ?? confirmedBill?.calculatedSettlementAmount
        ?? null,
      pendingSettlementAmount: pendingPosition?.pendingSettlementAmount ?? null,
      pendingReportCount: pendingPosition?.pendingReportCount ?? null,
      overdueReportCount: pendingPosition?.overdueReportCount ?? null,
      earliestEstimatedPayDate: pendingPosition?.earliestEstimatedPayDate ?? null,
      latestEstimatedPayDate: pendingPosition?.latestEstimatedPayDate ?? null,
      billReconciliationStatus: confirmedBill?.reconciliationStatus ?? null,
      ledgerBeginCount: confirmedLedger?.beginBalanceCount ?? null,
      ledgerInboundCount: confirmedLedger?.inboundCount ?? null,
      ledgerOutboundCount: confirmedLedger?.outboundCount ?? null,
      ledgerEndCount: confirmedLedger?.endBalanceCount ?? null,
      ledgerBeginAmount: confirmedLedger?.beginBalanceAmount ?? null,
      ledgerInboundAmount: confirmedLedger?.inboundAmount ?? null,
      ledgerOutboundAmount: confirmedLedger?.outboundAmount ?? null,
      ledgerEndAmount: confirmedLedger?.endBalanceAmount ?? null,
      ledgerCustomerOutboundCount: confirmedLedger?.customerOutboundCount ?? null,
      ledgerCustomerOutboundAmount: confirmedLedger?.customerOutboundAmount ?? null,
      ledgerOtherOutboundCount: otherOutboundCount,
      ledgerOtherOutboundAmount: otherOutboundAmount,
      ledgerPrepareEntryCount: confirmedLedger?.prepareOrderEntryCount ?? null,
      ledgerUrgentEntryCount: confirmedLedger?.urgentOrderEntryCount ?? null,
      ledgerObservedAt: confirmedLedger?.observedAt ?? null,
      financeObservedAt: confirmedFinance?.observedAt ?? null,
      billObservedAt: confirmedBill?.observedAt ?? null,
      pendingObservedAt: pendingPosition?.observedAt ?? null,
    };
  }).sort((left, right) => (
    left.date.localeCompare(right.date) || left.storeCode.localeCompare(right.storeCode)
  ));
}

function endpointMetricRows(rows, key, edge) {
  const byStore = new Map();
  for (const row of rows) {
    if (!finiteMetric(row[key])) continue;
    const current = byStore.get(row.storeCode);
    if (
      !current
      || (edge === 'first' && row.date < current.date)
      || (edge === 'last' && row.date > current.date)
    ) {
      byStore.set(row.storeCode, row);
    }
  }
  return [...byStore.values()];
}

function periodMetric(bundle, key, {
  aggregate = HOME_TREND_METRICS[key]?.aggregate,
  signed = HOME_TREND_METRICS[key]?.money === true,
} = {}) {
  const rows = resolvedHomeDaily(bundle);
  const selectedRows = aggregate === 'first'
    ? endpointMetricRows(rows, key, 'first')
    : aggregate === 'last'
      ? endpointMetricRows(rows, key, 'last')
      : rows;
  return signed
    ? availableSignedMetricSum(selectedRows, key)
    : availableMetricSum(selectedRows, key);
}

function metricComparison(current, previous) {
  if (
    typeof current !== 'number'
    || !Number.isFinite(current)
    || typeof previous !== 'number'
    || !Number.isFinite(previous)
  ) return '—';
  if (previous === 0) return current === 0 ? '持平' : '新增';
  const change = ((current - previous) / previous) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
}

function formatMoney(value, currency = 'SAR') {
  if (typeof value !== 'number' || !Number.isFinite(value) || !currency) return '—';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

function financeCurrency(bundle) {
  const source = bundle.productMode
    ? bundle.productFinanceDaily
    : [
        ...bundle.billDaily,
        ...bundle.financeDaily,
        ...(bundle.settlementPositionDaily || []),
      ];
  const values = [...new Set(source.map(({ currency }) => currency))];
  return values.length === 1 ? values[0] : null;
}

function homeCurrency(bundle) {
  const direct = [...new Set(
    bundle.storeDaily.map(({ currency }) => currency).filter(Boolean),
  )];
  return direct.length === 1 ? direct[0] : financeCurrency(bundle);
}

function homeTopRegions(bundle) {
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
    .sort((left, right) => right.salesQuantity - left.salesQuantity);
}

function metricRate(numerator, denominator) {
  if (
    typeof numerator !== 'number'
    || !Number.isFinite(numerator)
    || typeof denominator !== 'number'
    || !Number.isFinite(denominator)
    || denominator <= 0
  ) return null;
  return numerator / denominator;
}

function boundedShare(numerator, denominator) {
  const value = metricRate(numerator, denominator);
  return value !== null && value <= 1 ? value : null;
}

function formatRate(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : '—';
}

function ratePointChange(current, previous) {
  if (
    typeof current !== 'number'
    || !Number.isFinite(current)
    || typeof previous !== 'number'
    || !Number.isFinite(previous)
  ) return '—';
  const points = (current - previous) * 100;
  return `${points >= 0 ? '+' : ''}${points.toFixed(1)}pp`;
}

function formatPlainAmount(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('zh-CN', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(value)
    : '—';
}

function homeRangeDates(range) {
  const result = [];
  let cursor = range.start;
  while (cursor <= range.end) {
    result.push(cursor);
    cursor = shiftIsoDate(cursor, 1);
  }
  return result;
}

function homeMetricCoverage(bundle, keys, {
  aggregate = 'sum',
  signed = false,
  resolvedRows = resolvedHomeDaily(bundle),
} = {}) {
  const metricKeys = Array.isArray(keys) ? keys : [keys];
  const storeCodes = [...bundle.storeCodes].sort();
  const permissionMissing = metricKeys.some((key) => (
    ['exposureUsers', 'paymentOrderCount'].includes(key)
  ))
    ? (Array.isArray(homeHistory().analysisCapabilities)
        ? homeHistory().analysisCapabilities
        : [])
      .filter(({ storeCode, status }) => (
        bundle.storeCodes.has(String(storeCode))
        && status === 'permission_denied'
      ))
      .map(({ storeCode }) => String(storeCode))
      .sort()
    : [];
  const expectedDates = aggregate === 'first'
    ? [bundle.range.start]
    : aggregate === 'last'
      ? [bundle.range.end]
      : homeRangeDates(bundle.range);
  const valueIsKnown = (value) => (
    typeof value === 'number'
    && Number.isFinite(value)
    && (signed || value >= 0)
  );
  const knownDatesByStore = new Map(storeCodes.map((storeCode) => [storeCode, new Set()]));
  for (const row of resolvedRows) {
    if (
      knownDatesByStore.has(row.storeCode)
      && metricKeys.every((key) => valueIsKnown(row[key]))
    ) {
      knownDatesByStore.get(row.storeCode).add(row.date);
    }
  }
  const available = [];
  const complete = [];
  const missing = [];
  const partial = [];
  for (const storeCode of storeCodes) {
    const knownDates = knownDatesByStore.get(storeCode) || new Set();
    if (knownDates.size === 0) {
      missing.push(storeCode);
      continue;
    }
    available.push(storeCode);
    const missingDates = expectedDates.filter((date) => !knownDates.has(date));
    if (missingDates.length === 0) complete.push(storeCode);
    else partial.push({ storeCode, missingDates });
  }
  const total = storeCodes.length;
  const label = total === 0
    ? '当前无店铺'
    : complete.length === total
      ? `${total}/${total}家完整`
      : available.length === 0
        ? `0/${total}家有值`
        : `${available.length}/${total}家有值${complete.length ? ` · ${complete.length}家完整` : ''}`;
  const partialDetail = partial.slice(0, 8).map(({ storeCode, missingDates }) => (
    `${storeCode} 缺 ${missingDates.slice(0, 4).map((date) => date.slice(5).replace('-', '/')).join('、')}${missingDates.length > 4 ? '等' : ''}`
  ));
  const detail = [
    permissionMissing.length
      ? `经营分析权限缺失：${permissionMissing.join('、')}`
      : '',
    missing.length ? `完全未返回：${missing.join('、')}` : '',
    partialDetail.length ? `日期有缺口：${partialDetail.join('；')}` : '',
    partial.length > partialDetail.length
      ? `另有 ${partial.length - partialDetail.length} 家存在日期缺口`
      : '',
  ].filter(Boolean).join('\n') || '当前范围全部店铺和日期均有值';
  return { label, detail, available: available.length, complete: complete.length, total };
}

function pendingPositionSummary(rows) {
  const selected = endpointMetricRows(rows, 'pendingSettlementAmount', 'last');
  const pendingReportCount = availableMetricSum(selected, 'pendingReportCount');
  const overdueReportCount = availableMetricSum(selected, 'overdueReportCount');
  const earliest = selected
    .map(({ earliestEstimatedPayDate }) => earliestEstimatedPayDate)
    .filter(Boolean)
    .sort()
    .at(0) || null;
  const latest = selected
    .map(({ latestEstimatedPayDate }) => latestEstimatedPayDate)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  return {
    pendingReportCount,
    overdueReportCount,
    earliest,
    latest,
  };
}

function pendingPositionSubvalue(summary) {
  if (!summary || summary.pendingReportCount === null) return '';
  const expectedRange = summary.earliest
    ? `预计 ${summary.earliest.slice(5).replace('-', '/')}${summary.latest && summary.latest !== summary.earliest ? `–${summary.latest.slice(5).replace('-', '/')}` : ''}`
    : '预计日期未知';
  return [
    `${formatUnits(summary.pendingReportCount)}笔`,
    expectedRange,
    summary.overdueReportCount ? `逾期 ${formatUnits(summary.overdueReportCount)}笔` : null,
  ].filter(Boolean).join(' · ');
}

function historyMetricRows() {
  const range = selectedHomeDateRange();
  const current = homeScopedRows(range);
  const previous = homeScopedRows(previousHomeDateRange(range));
  const currentCurrency = homeCurrency(current);
  const previousCurrency = homeCurrency(previous);
  const resolvedCurrent = resolvedHomeDaily(current);
  const resolvedPrevious = resolvedHomeDaily(previous);
  const formatterFor = (type) => (
    type === 'money'
      ? (input, currency) => (
          currency ? formatMoney(input, currency) : formatPlainAmount(input)
        )
      : type === 'plain-money'
        ? (input) => formatPlainAmount(input)
        : (input) => formatUnits(input)
  );
  const metric = (label, key, type, note, {
    basis = '业务发生日',
    aggregate = HOME_TREND_METRICS[key]?.aggregate || 'sum',
    signed = type === 'money' || type === 'plain-money',
    secondaryKey = null,
    secondaryLabel = '',
    secondaryType = type,
    currentSubvalue = '',
    previousSubvalue = '',
    groupStart = false,
    groupLabel = '',
  } = {}) => {
    const value = periodMetric(current, key, { aggregate, signed });
    const baseline = periodMetric(previous, key, { aggregate, signed });
    const formatter = formatterFor(type);
    const secondaryFormatter = formatterFor(secondaryType);
    const secondaryValue = secondaryKey
      ? periodMetric(current, secondaryKey, {
          aggregate,
          signed: secondaryType === 'money' || secondaryType === 'plain-money',
        })
      : null;
    const secondaryBaseline = secondaryKey
      ? periodMetric(previous, secondaryKey, {
          aggregate,
          signed: secondaryType === 'money' || secondaryType === 'plain-money',
        })
      : null;
    return {
      label,
      key,
      value,
      baseline,
      display: formatter(value, currentCurrency),
      baselineDisplay: formatter(baseline, previousCurrency),
      secondaryDisplay: secondaryKey && secondaryValue !== null
        ? `${secondaryLabel}${secondaryFormatter(secondaryValue, currentCurrency)}`
        : currentSubvalue,
      baselineSecondaryDisplay: secondaryKey && secondaryBaseline !== null
        ? `${secondaryLabel}${secondaryFormatter(secondaryBaseline, previousCurrency)}`
        : previousSubvalue,
      change: metricComparison(value, baseline),
      note,
      basis,
      groupStart,
      groupLabel,
      coverage: homeMetricCoverage(current, key, {
        aggregate,
        signed,
        resolvedRows: resolvedCurrent,
      }),
      baselineCoverage: homeMetricCoverage(previous, key, {
        aggregate,
        signed,
        resolvedRows: resolvedPrevious,
      }),
    };
  };
  const ratioMetric = (
    label,
    key,
    currentValue,
    previousValue,
    note,
    coverageKeys,
  ) => ({
    label,
    key,
    value: currentValue,
    baseline: previousValue,
    display: formatRate(currentValue),
    baselineDisplay: formatRate(previousValue),
    secondaryDisplay: '',
    baselineSecondaryDisplay: '',
    change: ratePointChange(currentValue, previousValue),
    note,
    basis: '业务发生日',
    coverage: homeMetricCoverage(current, coverageKeys, {
      resolvedRows: resolvedCurrent,
    }),
    baselineCoverage: homeMetricCoverage(previous, coverageKeys, {
      resolvedRows: resolvedPrevious,
    }),
  });
  const ratioFrom = (rows, numerator, denominator) => metricRate(
    availableMetricSum(rows, numerator),
    availableMetricSum(rows, denominator),
  );
  const exposureVisitRate = ratioFrom(
    resolvedCurrent,
    'goodsDetailVisitors',
    'exposureUsers',
  );
  const previousExposureVisitRate = ratioFrom(
    resolvedPrevious,
    'goodsDetailVisitors',
    'exposureUsers',
  );
  const detailPaymentRate = ratioFrom(
    resolvedCurrent,
    'paymentOrderCount',
    'goodsDetailVisitors',
  );
  const previousDetailPaymentRate = ratioFrom(
    resolvedPrevious,
    'paymentOrderCount',
    'goodsDetailVisitors',
  );
  const validNewCustomerSalesRate = boundedShare(
    availableMetricSum(resolvedCurrent, 'newCustomerSalesQuantity'),
    availableMetricSum(resolvedCurrent, 'webapiSalesQuantity'),
  );
  const validPreviousNewCustomerSalesRate = boundedShare(
    availableMetricSum(resolvedPrevious, 'newCustomerSalesQuantity'),
    availableMetricSum(resolvedPrevious, 'webapiSalesQuantity'),
  );
  const validNewCustomerOrderRate = boundedShare(
    availableMetricSum(resolvedCurrent, 'newCustomerPaymentOrderCount'),
    availableMetricSum(resolvedCurrent, 'paymentOrderCount'),
  );
  const validPreviousNewCustomerOrderRate = boundedShare(
    availableMetricSum(resolvedPrevious, 'newCustomerPaymentOrderCount'),
    availableMetricSum(resolvedPrevious, 'paymentOrderCount'),
  );
  const pendingCurrent = pendingPositionSummary(resolvedCurrent);
  const pendingPrevious = pendingPositionSummary(resolvedPrevious);

  const operatingRows = [
    metric(
      '净成交金额',
      'netDealAmount',
      'money',
      '经营后台净成交金额；只读取经营概览，不使用财务明细或商家账单覆盖',
      { secondaryKey: 'dealAmount', secondaryLabel: '成交金额 ' },
    ),
    metric('销量', 'salesQuantity', 'count', '经营后台销量；不使用台账客单出库量替换'),
    metric('支付人数', 'buyerCount', 'count', '经营后台支付买家去重人数'),
    metric('支付订单数', 'paymentOrderCount', 'count', '经营后台支付成功订单数'),
    metric(
      '新客支付订单数',
      'newCustomerPaymentOrderCount',
      'count',
      '经营后台新客支付订单数',
    ),
    ratioMetric(
      '新客订单占比',
      'newCustomerOrderRate',
      validNewCustomerOrderRate,
      validPreviousNewCustomerOrderRate,
      '新客支付订单数 ÷ 支付订单数；分子大于分母时视为口径不兼容',
      ['newCustomerPaymentOrderCount', 'paymentOrderCount'],
    ),
  ];
  const trafficRows = [
    metric('曝光量', 'exposureUsers', 'count', '经营分析品牌行求和；不冒充跨店去重人数'),
    metric('商详访客', 'goodsDetailVisitors', 'count', '经营后台商品详情页去重访客'),
    ratioMetric(
      '曝光到访率',
      'exposureVisitRate',
      exposureVisitRate,
      previousExposureVisitRate,
      '商详访客 ÷ 曝光量',
      ['goodsDetailVisitors', 'exposureUsers'],
    ),
    ratioMetric(
      '商详支付率',
      'detailPaymentRate',
      detailPaymentRate,
      previousDetailPaymentRate,
      '支付订单数 ÷ 商详访客',
      ['paymentOrderCount', 'goodsDetailVisitors'],
    ),
    metric('新客销量', 'newCustomerSalesQuantity', 'count', '经营后台新客成交件数'),
    ratioMetric(
      '新客销量占比',
      'newCustomerSalesRate',
      validNewCustomerSalesRate,
      validPreviousNewCustomerSalesRate,
      '新客销量 ÷ 同口径经营销量；分子大于分母时视为口径不兼容',
      ['newCustomerSalesQuantity', 'webapiSalesQuantity'],
    ),
  ];
  const financeRows = [
    metric(
      '财务明细净额',
      'financeNetAmount',
      'money',
      'OpenAPI 财务明细收入－支出，按明细 addTime 对应的业务发生日归属',
      { signed: true, groupLabel: '业务发生' },
    ),
    metric(
      '期末预计待结算',
      'pendingSettlementAmount',
      'money',
      '截至所选结束日，已经生成但尚未完成结算的账单预计金额；余额只取期末，不按天累加',
      {
        basis: '期末状态',
        aggregate: 'last',
        signed: true,
        currentSubvalue: pendingPositionSubvalue(pendingCurrent),
        previousSubvalue: pendingPositionSubvalue(pendingPrevious),
        groupStart: true,
        groupLabel: '资金结算',
      },
    ),
    metric(
      '已结算销售款',
      'billSalesAmount',
      'money',
      '已完成结算账单中的销售明细收入－支出，按 completedPayTime 实际完成结算日归属',
      { basis: '实际结算日', signed: true },
    ),
    metric(
      '补款',
      'supplementAmount',
      'money',
      '已完成结算账单中的补款，随所属账单按实际结算日归属',
      { basis: '实际结算日' },
    ),
    metric(
      '扣款',
      'deductionAmount',
      'money',
      '已完成结算账单中的扣款，随所属账单按实际结算日归属',
      { basis: '实际结算日' },
    ),
    metric(
      '实际结算金额',
      'settlementAmount',
      'money',
      '已结算销售款＋补款－扣款，并与平台账单金额核对；按实际完成结算日归属',
      { basis: '实际结算日', signed: true },
    ),
  ];
  const ledgerRows = [
    metric('期初库存', 'ledgerBeginCount', 'count', '所选范围每家店第一天的库存台账期初值', {
      basis: '台账业务日',
      aggregate: 'first',
      secondaryKey: 'ledgerBeginAmount',
      secondaryLabel: '金额 ',
      secondaryType: 'plain-money',
    }),
    metric('入库', 'ledgerInboundCount', 'count', '所选范围库存台账入库累计', {
      basis: '台账业务日',
      secondaryKey: 'ledgerInboundAmount',
      secondaryLabel: '金额 ',
      secondaryType: 'plain-money',
    }),
    metric('客单出库', 'ledgerCustomerOutboundCount', 'count', '库存台账客户订单出库；用于核对，不替换经营销量', {
      basis: '台账业务日',
      secondaryKey: 'ledgerCustomerOutboundAmount',
      secondaryLabel: '金额 ',
      secondaryType: 'plain-money',
    }),
    metric('其他出库', 'ledgerOtherOutboundCount', 'count', '库存台账全部出库－客单出库', {
      basis: '台账业务日',
      secondaryKey: 'ledgerOtherOutboundAmount',
      secondaryLabel: '金额 ',
      secondaryType: 'plain-money',
    }),
    metric('全部出库', 'ledgerOutboundCount', 'count', '库存台账全部出库，不等同经营销量', {
      basis: '台账业务日',
      secondaryKey: 'ledgerOutboundAmount',
      secondaryLabel: '金额 ',
      secondaryType: 'plain-money',
    }),
    metric('期末库存', 'ledgerEndCount', 'count', '所选范围每家店最后一天的库存台账期末值', {
      basis: '台账业务日',
      aggregate: 'last',
      secondaryKey: 'ledgerEndAmount',
      secondaryLabel: '金额 ',
      secondaryType: 'plain-money',
    }),
  ];
  const supplyRows = [
    metric('备货订单数', 'stockingOrderCount', 'count', '经营后台备货订单数'),
    metric('备货入库件数', 'ledgerPrepareEntryCount', 'count', '库存台账备货订单入库件数', {
      basis: '台账业务日',
    }),
    metric('集采订单数', 'urgentPurchaseOrderCount', 'count', '经营后台集采订单数'),
    metric('集采入库件数', 'ledgerUrgentEntryCount', 'count', '库存台账集采订单入库件数', {
      basis: '台账业务日',
    }),
  ];
  return {
    range,
    current,
    previous,
    rows: operatingRows,
    operatingRows,
    trafficRows,
    financeRows,
    ledgerRows,
    supplyRows,
    topRegions: homeTopRegions(current),
  };
}

function compactRangeLabel(range) {
  const compact = (value) => String(value || '').replace(/^\d{4}-/, '').replace('-', '/');
  return `${compact(range.start)}–${compact(range.end)}`;
}

function homeHelpTip(text, label = '查看口径说明') {
  return `<button type="button" class="help" aria-label="${escapeHtml(label)}" data-tip="${escapeHtml(text)}">?</button>`;
}

function homeMetricTable(title, subtitle, metrics, currentRange, previousRange) {
  const tableNotes = {
    经营成交与支付: '用于判断所选范围的经营成交与支付规模。成交金额、净成交金额、销量、支付人数和支付订单全部来自全托经营后台 WebAPI；财务明细和库存台账只用于独立核对，绝不覆盖经营指标。未知显示 —，不会补零。',
    流量与客户: '用于判断曝光到商详、商详到支付及新客贡献。数据来自全托经营后台；曝光到访率＝商详访客÷曝光量，商详支付率＝支付订单数÷商详访客。跨店汇总为各店数据求和，不冒充平台跨店去重人数。',
    财务与结算: '业务发生组来自 OpenAPI 财务明细，净额＝收入－支出并按明细 addTime 归属。资金结算组来自商家账单：期末预计待结算只取范围结束日余额；已结算销售款、补款、扣款和实际结算金额均按 completedPayTime 实际完成结算日归属。实际结算金额＝销售款＋补款－扣款。',
    库存台账: '用于复盘库存数量与价值流转。期初取范围第一天、期末取最后一天，入库和出库在范围内累计；客单出库只用于与经营销量核对，不会替换经营销量。每行主值为数量，小字为同口径台账金额。',
    采购履约: '用于观察备货与集采规模及实际入库承接。订单数来自全托经营后台，入库件数来自官方库存台账；所选范围内按各自业务日汇总。',
  };
  const comparisonNote = tableNotes[title] || subtitle;
  const valueCell = (metric, period) => {
    const current = period === 'current';
    const display = current ? metric.display : metric.baselineDisplay;
    const secondary = current
      ? metric.secondaryDisplay
      : metric.baselineSecondaryDisplay;
    const coverage = current ? metric.coverage : metric.baselineCoverage;
    return `<span class="matrix-cell value ${current ? '' : 'comparison-value'}${metric.groupStart ? ' group-start' : ''}" role="cell">
      <strong>${escapeHtml(display)}</strong>
      ${secondary ? `<span class="metric-subvalue">${escapeHtml(secondary)}</span>` : ''}
      <small class="metric-coverage${coverage.complete === coverage.total && coverage.total > 0 ? ' complete' : ' partial'}" tabindex="0" data-tip="${escapeHtml(coverage.detail)}">${escapeHtml(coverage.label)}</small>
    </span>`;
  };
  return `
    <article class="overview-matrix-card home-history-card">
      <div class="matrix-card-head">
        <div class="title-with-help"><h4>${escapeHtml(title)}</h4>${homeHelpTip(comparisonNote, `${title}用途、来源、公式与覆盖`)}</div>
      </div>
      <div class="metric-matrix-viewport">
      <div class="metric-matrix cols-4 home-history-matrix" role="table" aria-label="${escapeHtml(title)}">
        <span class="matrix-cell head" role="columnheader">指标</span>
        <span class="matrix-cell head" role="columnheader">日期口径</span>
        <span class="matrix-cell head" role="columnheader"><strong>本期</strong></span>
        <span class="matrix-cell head" role="columnheader" tabindex="0" data-tip="前期为本期之前紧邻的同长度窗口"><strong>前期</strong></span>
        <span class="matrix-cell head" role="columnheader">较前期</span>
        ${metrics.map((metric) => `
          <span class="matrix-cell label${metric.groupStart ? ' group-start' : ''}" role="rowheader" tabindex="0" data-tip="${escapeHtml(metric.note)}">${metric.groupLabel ? `<small>${escapeHtml(metric.groupLabel)}</small>` : ''}${escapeHtml(metric.label)}</span>
          <span class="matrix-cell metric-basis${metric.groupStart ? ' group-start' : ''}" role="cell">${escapeHtml(metric.basis)}</span>
          ${valueCell(metric, 'current')}
          ${valueCell(metric, 'previous')}
          <span class="matrix-cell value change-value${metric.groupStart ? ' group-start' : ''}" role="cell">${escapeHtml(metric.change)}</span>`).join('')}
      </div></div>
    </article>`;
}

function renderTodayCoreCards() {
  const history = homeHistory();
  const operatingRows = Array.isArray(history.todayStoreDaily)
    ? history.todayStoreDaily
    : [];
  const pendingRows = Array.isArray(history.currentSettlementPosition)
    ? history.currentSettlementPosition
    : [];
  const baseCodes = homeBaseStoreCodes();
  const storeMatches = homeStoreSearchMatches();
  const expectedCodes = normalizedQuery() && storeMatches.size > 0
    ? new Set([...baseCodes].filter((code) => storeMatches.has(code)))
    : baseCodes;
  const expectedStores = Math.max(0, expectedCodes.size);
  const operatingDate = operatingRows.map(({ date }) => date).filter(Boolean).sort().at(-1) || null;
  const pendingDate = pendingRows.map(({ date }) => date).filter(Boolean).sort().at(-1) || null;
  const sourceUpdateTimes = [...new Set(operatingRows
    .map(({ sourceUpdatedAt }) => sourceUpdatedAt)
    .filter((value) => formatSourceUpdateTime(value)))]
    .sort();
  const sourceUpdateText = sourceUpdateTimes.length === 0
    ? '更新时间：待更新'
    : sourceUpdateTimes.length === 1
      ? `更新时间：${formatSourceUpdateTime(sourceUpdateTimes[0])}`
      : `更新时间：${formatSourceUpdateTime(sourceUpdateTimes[0])}–${formatSourceUpdateTime(sourceUpdateTimes.at(-1))}`;
  const operatingCurrency = [...new Set(
    operatingRows.map(({ currency }) => currency).filter(Boolean),
  )];
  const pendingCurrency = [...new Set(
    pendingRows.map(({ currency }) => currency).filter(Boolean),
  )];
  const referenceCurrency = [...new Set([
    ...pendingRows,
    ...(Array.isArray(history.financeDaily) ? history.financeDaily : []),
    ...(Array.isArray(history.billDaily) ? history.billDaily : []),
  ].map(({ currency }) => currency).filter(Boolean))];
  const operatingDisplayCurrency = operatingCurrency.length === 1
    ? operatingCurrency
    : operatingCurrency.length === 0 && referenceCurrency.length === 1
      ? referenceCurrency
      : [];
  const knownSum = (rows, key, { signed = false } = {}) => {
    if (!expectedStores) return null;
    return signed
      ? availableSignedMetricSum(rows, key)
      : availableMetricSum(rows, key);
  };
  const knownStores = (rows, key, { signed = false } = {}) => new Set(rows
    .filter((row) => (
      typeof row[key] === 'number'
      && Number.isFinite(row[key])
      && (signed || row[key] >= 0)
    ))
    .map(({ storeCode }) => storeCode)).size;
  const pendingSummary = {
    pendingReportCount: availableMetricSum(pendingRows, 'pendingReportCount'),
    overdueReportCount: availableMetricSum(pendingRows, 'overdueReportCount'),
    earliest: pendingRows
      .map(({ earliestEstimatedPayDate }) => earliestEstimatedPayDate)
      .filter(Boolean)
      .sort()
      .at(0) || null,
    latest: pendingRows
      .map(({ latestEstimatedPayDate }) => latestEstimatedPayDate)
      .filter(Boolean)
      .sort()
      .at(-1) || null,
  };
  const cards = [
    {
      key: 'netDealAmount',
      label: '净成交金额',
      value: knownSum(operatingRows, 'netDealAmount'),
      money: true,
      primary: true,
      note: '经营后台当日累计净成交金额；不使用财务明细或商家账单覆盖。',
    },
    {
      key: 'dealAmount',
      label: '成交金额',
      value: knownSum(operatingRows, 'dealAmount'),
      money: true,
      note: '经营后台当日累计成交金额。',
    },
    {
      key: 'salesQuantity',
      label: '销量',
      value: knownSum(operatingRows, 'salesQuantity'),
      suffix: '件',
      note: '经营后台当日累计销量；不使用库存台账客单出库替换。',
    },
    {
      key: 'buyerCount',
      label: '支付人数',
      value: knownSum(operatingRows, 'buyerCount'),
      suffix: '人',
      note: '经营后台当日去重支付人数；小时去重人数不能直接相加。',
    },
    {
      key: 'goodsDetailVisitors',
      label: '商详访客',
      value: knownSum(operatingRows, 'goodsDetailVisitors'),
      suffix: '人',
      note: '经营后台当日去重商品详情页访客；小时去重访客不能直接相加。',
    },
    {
      key: 'pendingSettlementAmount',
      label: '预计待结算金额',
      value: knownSum(pendingRows, 'pendingSettlementAmount', { signed: true }),
      money: true,
      pending: true,
      note: '截至最新账单同步时仍未完成结算的预计金额；按当前状态汇总，不按天累加。',
    },
  ];
  const formatCardValue = (card) => {
    if (card.money) {
      const currency = card.pending ? pendingCurrency : operatingDisplayCurrency;
      return currency.length === 1
        ? formatMoney(card.value, currency[0])
        : formatPlainAmount(card.value);
    }
    return card.value === null ? '—' : formatUnits(card.value);
  };
  const cardMeta = (card) => {
    const rows = card.pending ? pendingRows : operatingRows;
    const known = knownStores(rows, card.key, { signed: card.pending });
    if (card.pending) {
      return pendingPositionSubvalue(pendingSummary)
        || `${known}/${expectedStores}家有返回`;
    }
    const coverage = known < expectedStores
      ? `已返回 ${known}/${expectedStores} 家 · 当前为已返回店铺合计`
      : `${known}/${expectedStores} 家已齐`;
    return `${coverage}${operatingDate ? ` · 数据 ${operatingDate.slice(5).replace('-', '/')}` : ''}`;
  };
  return `
    <section class="home-today-core" aria-label="今日核心经营指标">
      <header class="home-block-head">
        <div><span class="eyebrow">TODAY</span><h2>今日核心</h2></div>
        <p>${escapeHtml(`经营 ${operatingDate || '待更新'} · 待结算 ${pendingDate || '待更新'} · ${sourceUpdateText} · 固定今日，只跟随店铺范围`)}</p>
      </header>
      <div class="today-core-strip">
        ${cards.map((card) => `
          <article class="today-core-card${card.primary ? ' primary' : ''}${card.pending ? ' settlement' : ''}">
            <div class="today-core-label"><span>${escapeHtml(card.label)}</span>${homeHelpTip(card.note, `${card.label}口径说明`)}</div>
            <strong>${escapeHtml(formatCardValue(card))}</strong>
            <small>${escapeHtml(cardMeta(card))}</small>
          </article>`).join('')}
      </div>
    </section>`;
}

function renderHistoryKpis() {
  const summary = historyMetricRows();
  const previousRange = previousHomeDateRange(summary.range);
  const regionRows = Array.from({ length: 4 }, (_, index) => ({
    rank: index + 1,
    region: summary.topRegions[index] ?? null,
  }));
  return `
    <section class="home-kpi home-history-kpis" aria-label="全托关键经营数据">
      <header class="home-block-head">
        <div><span class="eyebrow">BUSINESS OVERVIEW</span><h2>关键经营数据</h2></div>
        <p>${escapeHtml(`本期 ${compactRangeLabel(summary.range)} · 前期 ${compactRangeLabel(previousRange)} · ${summary.current.productMode ? '货号搜索范围' : `${summary.current.storeCodes.size} 家店`} · 未知不补零`)}</p>
      </header>
      <div class="kpi-six home-history-card-grid">
        ${homeMetricTable('经营成交与支付', '经营后台成交与支付', summary.operatingRows, summary.range, previousRange)}
        ${homeMetricTable('流量与客户', '曝光、商详、支付与新客', summary.trafficRows, summary.range, previousRange)}
        ${homeMetricTable('财务与结算', '业务发生与资金结算分组', summary.financeRows, summary.range, previousRange)}
        ${homeMetricTable('库存台账', '数量为主、金额为辅', summary.ledgerRows, summary.range, previousRange)}
        ${homeMetricTable('采购履约', '订单数量与台账入库件数', summary.supplyRows, summary.range, previousRange)}
        <article class="overview-matrix-card home-history-card home-region-card">
          <div class="matrix-card-head">
            <div class="title-with-help"><h4>主销地区</h4>${homeHelpTip('用于判断销量主要流向。数据来自经营后台地区销量，按当前日期和店铺范围汇总后降序排列，只展示 Top 4；未知不补零。', '主销地区用途与来源')}</div>
          </div>
          <div class="metric-matrix cols-region" role="table" aria-label="销量 Top 主销地区">
            <span class="matrix-cell head" role="columnheader">排名</span>
            <span class="matrix-cell head" role="columnheader">地区</span>
            <span class="matrix-cell head" role="columnheader">销量</span>
            ${regionRows.map(({ rank, region }) => `
              <span class="matrix-cell label" role="rowheader">Top ${rank}</span>
              <span class="matrix-cell value region-name" role="cell">${escapeHtml(region?.name || '—')}</span>
              <span class="matrix-cell value" role="cell">${region ? `${escapeHtml(formatUnits(region.salesQuantity))} 件` : '—'}</span>`).join('')}
          </div>
        </article>
      </div>
    </section>`;
}

function groupHistoryByDate(bundle) {
  const source = resolvedHomeDaily(bundle);
  const grouped = new Map();
  for (const row of source) {
    const current = grouped.get(row.date) || { date: row.date, rows: [] };
    current.rows.push(row);
    grouped.set(row.date, current);
  }
  return [...grouped.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map(({ date, rows }) => {
      const metrics = Object.fromEntries(Object.keys(HOME_TREND_METRICS).map((key) => [
        key,
        HOME_TREND_METRICS[key]?.money
          ? availableSignedMetricSum(rows, key)
          : availableMetricSum(rows, key),
      ]));
      const operatingAmountBasis = rows.some(
        ({ operatingAmountBasis: basis }) => basis === 'WEBAPI_REALTIME',
      )
        ? 'PROVISIONAL'
        : rows.some(
            ({ operatingAmountBasis: basis }) => (
              basis === 'WEBAPI_INDEX' || basis === 'WEBAPI'
            ),
          )
          ? 'CONFIRMED'
          : 'UNAVAILABLE';
      const basisByMetric = {
        netDealAmount: operatingAmountBasis,
        dealAmount: operatingAmountBasis,
        salesQuantity: rows.some(
          ({ salesQuantityBasis }) => salesQuantityBasis === 'WEBAPI_REALTIME',
        )
          ? 'PROVISIONAL'
          : rows.some(
              ({ salesQuantityBasis }) => (
                salesQuantityBasis === 'WEBAPI_INDEX'
                || salesQuantityBasis === 'WEBAPI'
              ),
            )
            ? 'CONFIRMED'
            : 'UNAVAILABLE',
      };
      for (const key of Object.keys(HOME_TREND_METRICS)) {
        if (!basisByMetric[key]) {
          basisByMetric[key] = finiteMetric(metrics[key]) ? 'CONFIRMED' : 'UNAVAILABLE';
        }
      }
      const currencies = [...new Set(rows.map(({ currency }) => currency).filter(Boolean))];
      return {
        date,
        ...metrics,
        currency: currencies.length === 1 ? currencies[0] : null,
        basisByMetric,
      };
    });
}

function groupHistoryByMonth(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    const current = grouped.get(month) || { date: month, rows: [] };
    current.rows.push(row);
    grouped.set(month, current);
  }
  return [...grouped.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((item) => {
      const metrics = Object.fromEntries(Object.entries(HOME_TREND_METRICS)
        .map(([key, definition]) => {
          const visible = item.rows.filter((row) => (
            definition.money
              ? typeof row[key] === 'number' && Number.isFinite(row[key])
              : finiteMetric(row[key])
          ));
          let value = null;
          if (visible.length) {
            if (definition.aggregate === 'first') value = visible[0][key];
            else if (definition.aggregate === 'last') value = visible.at(-1)[key];
            else {
              value = definition.money
                ? availableSignedMetricSum(visible, key)
                : availableMetricSum(visible, key);
            }
          }
          return [key, value];
        }));
      const basisByMetric = Object.fromEntries(Object.keys(HOME_TREND_METRICS).map((key) => {
        const bases = item.rows.map((row) => row.basisByMetric?.[key]);
        return [
          key,
          bases.includes('PROVISIONAL')
            ? 'PROVISIONAL'
            : bases.includes('CONFIRMED')
              ? 'CONFIRMED'
              : 'UNAVAILABLE',
        ];
      }));
      const currencies = [...new Set(item.rows.map(({ currency }) => currency).filter(Boolean))];
      return {
        date: item.date,
        ...metrics,
        currency: currencies.length === 1 ? currencies[0] : null,
        basisByMetric,
      };
    });
}

function historyTrendChart(rows, key, { money = false, suffix = '' } = {}, kind = 'line') {
  const visible = rows.filter((row) => (
    money
      ? typeof row[key] === 'number' && Number.isFinite(row[key])
      : finiteMetric(row[key])
  ));
  if (!visible.length) {
    return emptyEvidence('当前指标暂无趋势', '所选日期范围没有完整的日粒度事实，缺失不补零、不连线。');
  }
  const width = 980;
  const height = 256;
  const left = 58;
  const right = 18;
  const top = 32;
  const bottom = 42;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const rawMin = Math.min(...visible.map((row) => row[key]));
  const rawMax = Math.max(...visible.map((row) => row[key]));
  const barChart = kind === 'bar';
  const rawSpan = rawMax - rawMin;
  const linePadding = rawSpan > 0
    ? rawSpan * 0.14
    : Math.max(1, Math.abs(rawMax) * 0.12);
  let min = barChart ? Math.min(0, rawMin) : rawMin - linePadding;
  let max = barChart ? Math.max(0, rawMax) : rawMax + linePadding;
  if (!barChart && rawMin === 0) min = 0;
  if (!barChart && rawMax === 0) max = 0;
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = Math.max(1, max - min);
  const yFor = (value) => top + innerHeight - (((value - min) / span) * innerHeight);
  const points = visible.map((row, index) => ({
    ...row,
    x: left + (visible.length === 1 ? innerWidth / 2 : (innerWidth * index) / (visible.length - 1)),
    y: yFor(row[key]),
  }));
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const valueLabel = (point) => money
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(point[key])
    : `${formatUnits(point[key])}${suffix ? ` ${suffix}` : ''}`;
  const compactValue = (point) => {
    const value = new Intl.NumberFormat('zh-CN', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(point[key]);
    return `${value}${!money && suffix ? suffix : ''}`;
  };
  const maxIndex = points.reduce(
    (best, point, index) => (point[key] > points[best][key] ? index : best),
    0,
  );
  const minIndex = points.reduce(
    (best, point, index) => (point[key] < points[best][key] ? index : best),
    0,
  );
  const evenlySpacedIndices = (count, limit) => {
    if (count <= 0 || limit <= 0) return [];
    if (count <= limit) return Array.from({ length: count }, (_, index) => index);
    return [...new Set(Array.from(
      { length: limit },
      (_, index) => Math.round((index * (count - 1)) / (limit - 1)),
    ))];
  };
  const tickIndices = new Set(evenlySpacedIndices(points.length, 7));
  const labelLimit = Math.min(points.length, points.length <= 8 ? points.length : 6);
  const labelled = new Set([maxIndex, minIndex]);
  const minimumLabelPixelGap = points.length > 12 ? 96 : 72;
  for (const index of [0, points.length - 1]) {
    if ([...labelled].every((existing) => (
      Math.abs(points[existing].x - points[index].x) >= minimumLabelPixelGap
    ))) {
      labelled.add(index);
    }
  }
  while (labelled.size < labelLimit) {
    let candidate = -1;
    let candidateDistance = -1;
    for (let index = 0; index < points.length; index += 1) {
      if (labelled.has(index)) continue;
      const nearest = Math.min(...[...labelled].map((existing) => (
        Math.abs(points[existing].x - points[index].x)
      )));
      if (nearest > candidateDistance) {
        candidate = index;
        candidateDistance = nearest;
      }
    }
    if (candidate < 0 || candidateDistance < minimumLabelPixelGap) break;
    labelled.add(candidate);
  }
  const gridValues = Array.from(
    { length: 4 },
    (_, index) => max - ((span * index) / 3),
  );
  const axis = gridValues.map((value) => {
    const y = yFor(value);
    const label = money
      ? new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
      : numberFormatter.format(Math.round(value));
    return `<line class="chart-grid" x1="${left}" y1="${y.toFixed(1)}" x2="${left + innerWidth}" y2="${y.toFixed(1)}"></line>
      <text class="chart-axis chart-axis-end" x="${left - 8}" y="${(y + 4).toFixed(1)}">${escapeHtml(label)}</text>`;
  }).join('');
  const zeroY = yFor(0);
  const zeroLine = min <= 0 && max >= 0
    ? `<line class="chart-zero" x1="${left}" y1="${zeroY.toFixed(1)}" x2="${left + innerWidth}" y2="${zeroY.toFixed(1)}"></line>`
    : '';
  const pointLabels = points.map((point, index) => {
    if (!labelled.has(index)) return '';
    const placeBelow = point.y < top + 18 || index % 2 === 1;
    const y = placeBelow
      ? Math.min(height - bottom - 2, point.y + 18)
      : Math.max(14, point.y - 10);
    const anchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
    return `<text class="chart-value-label" text-anchor="${anchor}" x="${point.x.toFixed(1)}" y="${y.toFixed(1)}">${escapeHtml(compactValue(point))}</text>`;
  }).join('');
  const axisDateLabel = (date) => (
    String(date).length === 7
      ? String(date).replace('-', '/')
      : String(date).slice(5).replace('-', '/')
  );
  const lineAxis = points.map((point, index) => {
    if (!tickIndices.has(index)) return '';
    const anchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
    return `<text class="chart-axis chart-date-axis" text-anchor="${anchor}" x="${point.x.toFixed(1)}" y="${height - 12}">${escapeHtml(axisDateLabel(point.date))}</text>`;
  }).join('');
  const bars = points.map((point, index) => {
    const slot = innerWidth / Math.max(1, points.length);
    const barWidth = Math.max(5, Math.min(44, slot * 0.58));
    const x = left + (slot * index) + ((slot - barWidth) / 2);
    const y = Math.min(point.y, zeroY);
    const barHeight = Math.max(1, Math.abs(zeroY - point.y));
    const provisional = point.basisByMetric?.[key] === 'PROVISIONAL';
    return `<rect class="history-bar${provisional ? ' provisional' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="5" tabindex="0" data-tip="${escapeHtml(`${point.date} · ${valueLabel(point)}${provisional ? ' · 含实时暂估' : ''}`)}"></rect>`;
  }).join('');
  const barLabels = points.map((point, index) => {
    if (!labelled.has(index)) return '';
    const slot = innerWidth / Math.max(1, points.length);
    const x = left + (slot * index) + (slot / 2);
    const y = point[key] < 0 ? point.y + 18 : Math.max(14, point.y - 8);
    return `<text class="chart-value-label" text-anchor="middle" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${escapeHtml(compactValue(point))}</text>`;
  }).join('');
  const barAxis = points.map((point, index) => {
    if (!tickIndices.has(index)) return '';
    const slot = innerWidth / Math.max(1, points.length);
    const x = left + (slot * index) + (slot / 2);
    const anchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
    return `<text class="chart-axis chart-date-axis" text-anchor="${anchor}" x="${x.toFixed(1)}" y="${height - 12}">${escapeHtml(axisDateLabel(point.date))}</text>`;
  }).join('');
  return `
    <div class="line-chart trend-chart home-history-chart ${barChart ? 'history-bar-chart' : 'history-line-chart'}">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(`${points[0].date} 至 ${points.at(-1).date} 趋势`)}">
        ${axis}
        ${zeroLine}
        ${barChart
          ? `${bars}${barLabels}${barAxis}`
          : `<path class="chart-line" d="${path}"></path>
             ${points.map((point) => {
               const provisional = point.basisByMetric?.[key] === 'PROVISIONAL';
               return `<circle class="chart-point${provisional ? ' provisional' : ''}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${provisional ? '4.5' : '3.6'}" tabindex="0" data-tip="${escapeHtml(`${point.date} · ${valueLabel(point)}${provisional ? ' · 实时暂估' : ''}`)}"></circle>`;
             }).join('')}
             ${pointLabels}
             ${lineAxis}`}
      </svg>
    </div>`;
}

function renderHistoryTrends() {
  const bundle = homeScopedRows();
  const daily = groupHistoryByDate(bundle);
  const monthly = groupHistoryByMonth(daily);
  const metricKey = Object.prototype.hasOwnProperty.call(
    HOME_TREND_METRICS,
    state.homeTrendMetric,
  ) ? state.homeTrendMetric : 'netDealAmount';
  const metric = HOME_TREND_METRICS[metricKey];
  const hasProvisional = daily.some(
    (row) => row.basisByMetric?.[metricKey] === 'PROVISIONAL',
  );
  const metricLabel = metric.label;
  const metricGroups = [...new Set(Object.values(HOME_TREND_METRICS).map(({ group }) => group))];
  const trendPanel = (title, rows, visibleRange, helpText, kind) => `
    <article class="panel trend-panel home-history-trend-panel">
      <div class="title-with-help"><h4>${escapeHtml(`${title} · ${metricLabel}`)}</h4>${homeHelpTip(helpText, `${title}口径说明`)}</div>
      <p class="sub">${escapeHtml(visibleRange)}</p>
      ${historyTrendChart(rows, metricKey, metric, kind)}
    </article>`;
  const provisionalNote = hasProvisional
    ? '实心点为同来源历史事实；颜色较浅的点或柱表示经营后台日内累计。经营、财务和台账来源始终分开，不会自动互相覆盖。'
    : '当前指标来自标题所示的独立业务来源；经营、财务和台账不会互相覆盖。';
  return `
    <section class="home-history-trends" aria-label="经营趋势">
      <header class="head home-trend-section-head">
        <div class="title-with-help"><h3>趋势</h3>${homeHelpTip(`${provisionalNote} 日趋势不强制从零起轴，避免有效波动被大片空白压扁；横轴均匀展示日期。`, '趋势图说明')}</div>
        <div class="trend-toggle" role="group" aria-label="趋势指标">
          ${metricGroups.map((group) => `<span class="trend-group"><em>${escapeHtml(group)}</em>${Object.entries(HOME_TREND_METRICS).filter(([, item]) => item.group === group).map(([key, item]) => `<button type="button" class="${metricKey === key ? 'active' : ''}" data-home-trend-metric="${escapeHtml(key)}" aria-pressed="${metricKey === key ? 'true' : 'false'}">${escapeHtml(item.label)}</button>`).join('')}</span>`).join('')}
        </div>
      </header>
      <div class="trend-stack home-trend-stack">
        ${trendPanel(
          '日趋势',
          daily,
          `${selectedHomeDateRange().start} → ${selectedHomeDateRange().end}`,
          `按业务日展示连续变化，横轴均匀标日期，关键点直接标数。${provisionalNote}`,
          'line',
        )}
        ${trendPanel(
          '月趋势',
          monthly,
          `${selectedHomeDateRange().start.slice(0, 7)} → ${selectedHomeDateRange().end.slice(0, 7)}`,
          `${['billSalesAmount', 'supplementAmount', 'deductionAmount', 'settlementAmount'].includes(metricKey) ? '实际完成结算日' : metricKey === 'financeNetAmount' ? '财务明细业务发生日' : '经营或台账业务日'}归入自然月；库存期初、期末取月首、月末，其余指标累计。${provisionalNote}`,
          'bar',
        )}
      </div>
    </section>`;
}

function aggregateHistoryRanking(rows, identity, metricKey, limit = HOME_RANK_LIMIT) {
  const grouped = new Map();
  for (const row of rows) {
    const key = identity.key(row);
    if (!key) continue;
    const item = grouped.get(key) || {
      key,
      label: identity.label(row),
      sub: identity.sub(row),
      ownerName: identity.owner?.(row) || '',
      rows: [],
    };
    item.rows.push(row);
    grouped.set(key, item);
  }
  const ranked = [...grouped.values()].map((item) => ({
    ...item,
    value: availableSignedMetricSum(item.rows, metricKey),
  })).filter(({ value }) => finiteMetric(value))
    .sort((left, right) => right.value - left.value);
  return Number.isSafeInteger(limit) && limit >= 0
    ? ranked.slice(0, limit)
    : ranked;
}

function rankingKnownSum(rows, keys) {
  for (const key of keys) {
    const value = availableSignedMetricSum(rows, key);
    if (value !== null) return value;
  }
  return null;
}

function rankingObservedDays(rows) {
  return new Set(rows.map(({ date }) => date).filter(Boolean)).size;
}

function rankMetaMetric(label, value, suffix = '') {
  return value === null || value === undefined || value === ''
    ? null
    : { label, value: String(value), suffix };
}

function rankMetaText(text) {
  return text ? { text: String(text) } : null;
}

function renderRankMeta(parts) {
  if (!Array.isArray(parts)) return escapeHtml(parts || '');
  return parts.filter(Boolean).map((part) => {
    if (part.text) {
      return `<span class="meta-part meta-text"><em>${escapeHtml(part.text)}</em></span>`;
    }
    return `<span class="meta-part">${part.label ? `<em>${escapeHtml(part.label)}</em>` : ''}<b>${escapeHtml(part.value)}</b>${part.suffix ? `<em>${escapeHtml(part.suffix)}</em>` : ''}</span>`;
  }).join('<i class="meta-sep" aria-hidden="true">·</i>');
}

function storeHistoryRankMeta(row, primary) {
  const quantity = rankingKnownSum(row.rows, ['salesQuantity']);
  const amount = rankingKnownSum(row.rows, ['netDealAmount', 'dealAmount']);
  const orders = rankingKnownSum(row.rows, ['paymentOrderCount']);
  const days = rankingObservedDays(row.rows);
  const parts = primary === 'amount'
    ? [
      rankMetaMetric('销量', quantity === null ? null : formatUnits(quantity), '件'),
      rankMetaMetric('支付订单', orders === null ? null : formatUnits(orders), '单'),
      rankMetaMetric('', days ? formatUnits(days) : null, '天有数据'),
    ]
    : [
      rankMetaMetric('金额', amount === null ? null : formatMoney(amount, row.currency)),
      rankMetaMetric('支付订单', orders === null ? null : formatUnits(orders), '单'),
      rankMetaMetric('', days ? formatUnits(days) : null, '天有数据'),
    ];
  return parts.filter(Boolean);
}

function productHistoryRankMeta(row, primary, {
  basis = 'OPERATING',
  operatingQuantity = null,
  financeQuantity = null,
  financeAmount = null,
} = {}) {
  const rowOperatingQuantity = rankingKnownSum(row.rows, ['salesQuantity']);
  const rowFinanceQuantity = rankingKnownSum(row.rows, ['goodsCount']);
  const estimatedAmount = rankingKnownSum(row.rows, ['estimatedDealAmount']);
  const resolvedOperatingQuantity = operatingQuantity ?? rowOperatingQuantity;
  const resolvedFinanceQuantity = financeQuantity ?? rowFinanceQuantity;
  const storeCodes = [...new Set(row.rows.map(({ storeCode }) => storeCode).filter(Boolean))];
  const days = rankingObservedDays(row.rows);
  const hasRealtimeEstimate = row.rows.some(
    ({ rankingSource }) => rankingSource === 'REALTIME_SHARE_ESTIMATE',
  );
  const parts = primary === 'amount'
    ? [
      hasRealtimeEstimate ? rankMetaText('实时估算') : null,
      basis === 'FINANCE'
        ? rankMetaMetric(
            '财务明细件数',
            resolvedFinanceQuantity === null
              ? null
              : formatUnits(resolvedFinanceQuantity),
            '件',
          )
        : rankMetaMetric(
            '经营销量',
            resolvedOperatingQuantity === null
              ? null
              : formatUnits(resolvedOperatingQuantity),
            '件',
          ),
      basis === 'FINANCE'
        ? rankMetaMetric(
            '经营销量',
            operatingQuantity === null ? null : formatUnits(operatingQuantity),
            '件',
          )
        : null,
      rankMetaMetric('覆盖', storeCodes.length ? formatUnits(storeCodes.length) : null, '店'),
      rankMetaMetric('', days ? formatUnits(days) : null, '天有数据'),
    ]
    : [
      hasRealtimeEstimate ? rankMetaText('实时估算') : null,
      rankMetaMetric(
        financeAmount === null ? '估算金额' : '报账销售款',
        financeAmount === null && estimatedAmount === null
          ? null
          : formatMoney(financeAmount ?? estimatedAmount, row.currency),
      ),
      rankMetaMetric('覆盖', storeCodes.length ? formatUnits(storeCodes.length) : null, '店'),
      rankMetaMetric('', days ? formatUnits(days) : null, '天有数据'),
    ];
  return parts.filter(Boolean);
}

function rankingValueByKey(rows, identity, metricKey) {
  return new Map(aggregateHistoryRanking(rows, identity, metricKey, null)
    .map(({ key, value }) => [key, value]));
}

function productFactCoverage(rows, storeCodes, label) {
  const covered = new Set(rows.map(({ storeCode }) => String(storeCode || '')).filter(Boolean));
  return `${label}有明细 ${covered.size}/${storeCodes.size} 店`;
}

function historyRankTable(title, note, rows, {
  money = false,
  estimated = false,
  defaultTone = 'store-quantity',
  unit = '件',
} = {}) {
  const max = Math.max(1, ...rows.map(({ value }) => Math.abs(value)));
  return `
    <article class="panel rank-panel home-history-rank-card">
      <div class="title-with-help"><h4>${escapeHtml(title)}</h4>${homeHelpTip(note, `${title}口径说明`)}</div>
      ${rows.length ? `<div class="rank-list">${rows.map((row, index) => {
        const pct = Math.max(4, Math.round((Math.abs(row.value) / max) * 100));
        const fillStep = Math.max(1, Math.min(10, Math.ceil(pct / 10)));
        const tone = row.tone || defaultTone;
        return `<div class="rank-item rank-fill-${fillStep} rank-tone-${escapeHtml(tone)}">
          <span class="rank-no">${index + 1}</span>
          <span class="rank-main">
            <span class="rank-title-line"><span class="rank-name">${escapeHtml(row.label)}</span>${row.ownerName ? `<span class="rank-owner" title="${escapeHtml(row.ownerName)}">${escapeHtml(shortOwnerName(row.ownerName))}</span>` : ''}</span>
            <span class="rank-meta">${renderRankMeta(row.sub)}</span>
          </span>
          <span class="rank-value">${escapeHtml(money ? formatMoney(row.value, row.currency) : formatUnits(row.value))}<small>${estimated ? '估算' : money ? '' : escapeHtml(unit)}</small></span>
        </div>`;
      }).join('')}</div>` : emptyEvidence('当前排行暂无数据', '所选日期和范围内没有完整可排序事实。')}
    </article>`;
}

function renderHistoryRankings() {
  const bundle = homeScopedRows();
  const rankingBasis = state.homeRankingBasis === 'FINANCE' ? 'FINANCE' : 'OPERATING';
  const realtimeProductEstimates = rankingBasis === 'OPERATING'
    ? estimatedCurrentProductRows(bundle)
    : [];
  const operatingProductRows = [
    ...bundle.productDaily,
    ...realtimeProductEstimates,
  ];
  const storeIdentity = {
    key: (row) => row.storeCode,
    label: (row) => baseStores().find(({ code }) => code === row.storeCode)?.name || row.storeCode,
    owner: (row) => {
      const store = baseStores().find(({ code }) => code === row.storeCode);
      return ownerNameForStore(store);
    },
    sub: () => '',
  };
  const productIdentity = {
    key: (row) => row.standardGoodsCode
      ? `STANDARD:${row.standardGoodsCode}`
      : `LOCAL:${row.storeCode}:${row.productGrain}:${row.productKey}`,
    label: (row) => row.standardGoodsCode
      || row.supplierCode
      || row.supplierSku
      || row.productKey,
    sub: (row) => row.standardGoodsName || row.displayName || '',
  };
  const financeProductIdentity = {
    key: (row) => row.standardGoodsCode
      ? `STANDARD:${row.standardGoodsCode}`
      : `LOCAL:${row.storeCode}:FINANCE:${row.productKey}`,
    label: (row) => row.standardGoodsCode
      || row.supplierSku
      || (row.platformSkcId ? `SKC ${row.platformSkcId}` : '')
      || (row.platformSkuId ? `SKU ${row.platformSkuId}` : '')
      || row.productKey,
    sub: (row) => row.standardGoodsName || '',
  };
  const resolvedStoreRows = resolvedHomeDaily({ ...bundle, productMode: false });
  const rankedFinanceCurrency = financeCurrency(bundle);
  const rankingBasisNote = (basisKey, confirmedLabel) => {
    const bases = new Set(resolvedStoreRows.map((row) => row[basisKey]));
    return [
      bases.has('WEBAPI') || bases.has('WEBAPI_INDEX') ? confirmedLabel : null,
      bases.has('WEBAPI_INDEX') ? '历史日经营口径' : null,
      bases.has('WEBAPI_REALTIME') ? '含日内实时暂估' : null,
    ].filter(Boolean).join(' + ') || '当前可用口径';
  };
  const storeAmountBasisNote = rankingBasis === 'FINANCE'
    ? '财务明细净额，按业务发生日'
    : rankingBasisNote('operatingAmountBasis', '经营后台净成交金额');
  const storeQuantityBasisNote = rankingBasis === 'FINANCE'
    ? '财务明细 goodsCount，按业务发生日'
    : rankingBasisNote('salesQuantityBasis', '经营后台销量');
  const storeAmountCurrency = homeCurrency(bundle) || rankedFinanceCurrency;
  const storeFinanceQuantityByKey = rankingValueByKey(
    bundle.productFinanceDaily,
    storeIdentity,
    'goodsCount',
  );
  const storeFinanceAmountByKey = rankingValueByKey(
    bundle.financeDaily,
    storeIdentity,
    'netAmount',
  );
  const storeAmountSource = rankingBasis === 'FINANCE'
    ? bundle.financeDaily
    : resolvedStoreRows;
  const storeAmountMetric = rankingBasis === 'FINANCE' ? 'netAmount' : 'netDealAmount';
  const storeAmount = aggregateHistoryRanking(
    storeAmountSource,
    storeIdentity,
    storeAmountMetric,
    null,
  ).filter(({ value }) => value > 0).map((row) => {
    const store = baseStores().find(({ code }) => code === row.key);
    const ownerKey = ownerKeyForStore(store) || row.ownerName;
    const next = {
      ...row,
      currency: row.currency || storeAmountCurrency,
      tone: ownerDisplayTone(ownerKey),
    };
    return {
      ...next,
      sub: rankingBasis === 'FINANCE'
        ? [
            rankMetaMetric(
              '财务件数',
              storeFinanceQuantityByKey.has(row.key)
                ? formatUnits(storeFinanceQuantityByKey.get(row.key))
                : null,
              '件',
            ),
            rankMetaMetric('', rankingObservedDays(row.rows) || null, '天有数据'),
          ].filter(Boolean)
        : storeHistoryRankMeta(next, 'amount'),
    };
  });
  const storeQuantitySource = rankingBasis === 'FINANCE'
    ? bundle.productFinanceDaily
    : resolvedStoreRows;
  const storeQuantityMetric = rankingBasis === 'FINANCE' ? 'goodsCount' : 'salesQuantity';
  const storeQuantity = aggregateHistoryRanking(
    storeQuantitySource,
    storeIdentity,
    storeQuantityMetric,
    null,
  ).filter(({ value }) => value > 0).map((row) => {
    const store = baseStores().find(({ code }) => code === row.key);
    const ownerKey = ownerKeyForStore(store) || row.ownerName;
    const next = {
      ...row,
      currency: homeCurrency(bundle) || rankedFinanceCurrency,
      tone: ownerDisplayTone(ownerKey),
    };
    return {
      ...next,
      sub: rankingBasis === 'FINANCE'
        ? [
            rankMetaMetric(
              '财务净额',
              storeFinanceAmountByKey.has(row.key)
                ? formatMoney(storeFinanceAmountByKey.get(row.key), rankedFinanceCurrency)
                : null,
            ),
            rankMetaMetric('', rankingObservedDays(row.rows) || null, '天有数据'),
          ].filter(Boolean)
        : storeHistoryRankMeta(next, 'quantity'),
    };
  });
  const operatingQuantityByKey = rankingValueByKey(
    operatingProductRows,
    productIdentity,
    'salesQuantity',
  );
  const financeQuantityByKey = rankingValueByKey(
    bundle.productFinanceDaily,
    financeProductIdentity,
    'goodsCount',
  );
  const financeAmountByKey = rankingValueByKey(
    bundle.productFinanceDaily,
    financeProductIdentity,
    'netAmount',
  );
  const operatingCoverage = productFactCoverage(
    operatingProductRows,
    bundle.storeCodes,
    '经营货号',
  );
  const financeCoverage = productFactCoverage(
    bundle.productFinanceDaily,
    bundle.storeCodes,
    '财务货号',
  );
  const productAmountBasis = rankingBasis === 'FINANCE' ? 'FINANCE' : 'ESTIMATED';
  const productAmount = aggregateHistoryRanking(
    rankingBasis === 'FINANCE' ? bundle.productFinanceDaily : operatingProductRows,
    rankingBasis === 'FINANCE' ? financeProductIdentity : productIdentity,
    rankingBasis === 'FINANCE' ? 'netAmount' : 'estimatedDealAmount',
    20,
  )
    .map((row) => rankingBasis === 'FINANCE'
      ? { ...row, currency: rankedFinanceCurrency }
      : row)
    .filter(({ value }) => value > 0).slice(0, 20).map((row) => {
      const mapped = row.key.startsWith('STANDARD:');
      const next = {
        ...row,
        currency: row.currency || homeCurrency(bundle) || rankedFinanceCurrency,
        tone: 'product-amount',
      };
      return {
        ...next,
        sub: [
          mapped ? null : rankMetaText('未归并'),
          ...productHistoryRankMeta(next, 'amount', {
            basis: productAmountBasis,
            operatingQuantity: rankingBasis === 'OPERATING'
              ? operatingQuantityByKey.get(row.key) ?? null
              : null,
            financeQuantity: rankingBasis === 'FINANCE'
              ? financeQuantityByKey.get(row.key) ?? null
              : null,
          }),
        ].filter(Boolean),
      };
    });
  const productQuantityBasis = rankingBasis;
  const productQuantity = aggregateHistoryRanking(
    rankingBasis === 'FINANCE' ? bundle.productFinanceDaily : operatingProductRows,
    rankingBasis === 'FINANCE' ? financeProductIdentity : productIdentity,
    rankingBasis === 'FINANCE' ? 'goodsCount' : 'salesQuantity',
    20,
  ).filter(({ value }) => value > 0).slice(0, 20).map((row) => {
    const mapped = row.key.startsWith('STANDARD:');
    const next = {
      ...row,
      currency: homeCurrency(bundle) || rankedFinanceCurrency,
      tone: 'product-quantity',
    };
    return {
      ...next,
      sub: [
        mapped ? null : rankMetaText('未归并'),
        ...productHistoryRankMeta(next, 'quantity', {
          financeAmount: rankingBasis === 'FINANCE'
            ? financeAmountByKey.get(row.key) ?? null
            : null,
        }),
      ].filter(Boolean),
    };
  });
  const range = selectedHomeDateRange();
  const note = `${range.start} → ${range.end} · 当前筛选联动`;
  const estimateStoreCount = new Set(realtimeProductEstimates.map(({ storeCode }) => storeCode)).size;
  return `
    <section class="home-history-rankings" aria-label="经营排行榜">
      <header class="head home-ranking-head">
        <div class="title-with-help"><h3>排行榜</h3>${homeHelpTip('经营口径使用经营后台净成交金额和销量；商品接口当天尚未结算时，今日货号榜按店铺实时销量与最近已结算货号构成估算并明确标记。财务口径只使用财务明细业务发生日，不会被经营估算覆盖。店铺展示全部有销售记录，货号展示 Top 20。', '排行榜说明')}</div>
        <div class="ranking-basis-toggle" role="group" aria-label="排行榜数据口径">
          <button type="button" class="${rankingBasis === 'OPERATING' ? 'active' : ''}" data-home-ranking-basis="OPERATING" aria-pressed="${rankingBasis === 'OPERATING' ? 'true' : 'false'}">经营口径</button>
          <button type="button" class="${rankingBasis === 'FINANCE' ? 'active' : ''}" data-home-ranking-basis="FINANCE" aria-pressed="${rankingBasis === 'FINANCE' ? 'true' : 'false'}">财务口径</button>
        </div>
        <span class="sub">${escapeHtml(note)}${rankingBasis === 'OPERATING' && estimateStoreCount ? ` · 今日 ${numberFormatter.format(estimateStoreCount)} 店货号为实时估算` : ''}</span>
      </header>
      <div class="rank-grid home-rank-grid">
        ${historyRankTable(
          rankingBasis === 'FINANCE' ? '店铺财务净额排行' : '店铺净成交金额排行',
          `${note} · ${storeAmountBasisNote}`,
          storeAmount,
          { money: true, defaultTone: 'store-amount' },
        )}
        ${historyRankTable(
          rankingBasis === 'FINANCE' ? '店铺财务明细件数排行' : '店铺销量排行',
          `${note} · ${storeQuantityBasisNote}`,
          storeQuantity,
          { defaultTone: 'store-quantity' },
        )}
        ${historyRankTable(
          productAmountBasis === 'FINANCE' ? '标准货号报账销售款 Top 20' : '标准货号销售金额 Top 20（估算）',
          productAmountBasis === 'FINANCE'
            ? `按财务明细业务发生日汇总；${financeCoverage}。财务明细件数与经营销量是不同口径，分别标注，不再混称销量。`
            : `销量 × 最新财务单价证据；无匹配单价则不入榜。${operatingCoverage}。${estimateStoreCount ? `今日逐货号数据尚未结算，${estimateStoreCount} 店按实时店铺销量与最近货号构成估算。` : ''}`,
          productAmount,
          { money: true, estimated: productAmountBasis === 'ESTIMATED', defaultTone: 'product-amount' },
        )}
        ${historyRankTable(
          productQuantityBasis === 'FINANCE' ? '标准货号财务件数 Top 20' : '标准货号销量 Top 20',
          productQuantityBasis === 'FINANCE'
            ? `来自财务明细 goodsCount，按明细业务发生日汇总；${financeCoverage}`
            : `已结算日期来自经营分析商品诊断销量；${operatingCoverage}。${estimateStoreCount ? `今日 ${estimateStoreCount} 店按实时店铺销量与最近货号构成估算；新货当日可能暂未进入。` : '无货号事实的店不补零。'}`,
          productQuantity,
          { defaultTone: 'product-quantity' },
        )}
      </div>
    </section>`;
}

/* Vertical order is fixed: A 销量 KPI 数据矩阵 → B 日销量趋势 →
   C 月销量趋势 → D 店铺经营排行 → E 货号/商品经营排行。
   口径说明放在相应标题的问号提示中；首页噪音（pulse、supply radar、运营提醒）不再参与组装，
   相关函数保留给其他路由使用。 */
function renderHome() {
  if (state.home.loading && !state.home.data) {
    const loadingTitle = state.home.forceRefresh
      ? '正在强制刷新首页缓存'
      : '正在加载首页经营数据';
    return `<section class="panel home-loading-panel" aria-live="polite">
      <header><span class="home-loading-spinner" aria-hidden="true"></span><div><h3>${escapeHtml(loadingTitle)}</h3><p>只读取当前日期、店铺和搜索范围；不会一次下载整份历史明细。</p></div></header>
      <div class="home-loading-list" role="list" aria-label="首页数据加载进度">
        <div role="listitem" class="ready"><span></span><strong>核心范围与店铺权限</strong><em>已就绪</em></div>
        <div role="listitem"><span></span><strong>店铺经营日数据</strong><em>加载中</em></div>
        <div role="listitem"><span></span><strong>商家账单、补款与扣款</strong><em>加载中</em></div>
        <div role="listitem"><span></span><strong>库存台账数量与金额</strong><em>加载中</em></div>
        <div role="listitem"><span></span><strong>主销地区、趋势与排行榜</strong><em>加载中</em></div>
      </div>
      <p class="home-loading-foot">首次读取服务器分片通常需要数秒；完成后页面会自动显示，不需要重复点击。</p>
    </section>`;
  }
  if (state.home.error && !state.home.data) {
    return `<section class="panel empty-state" role="alert"><h3>首页经营数据加载失败</h3><p>${escapeHtml(state.home.error)}</p><button type="button" class="refresh-cache-button" data-home-force-refresh>强制刷新缓存并重试</button></section>`;
  }
  const returnedRows = state.home.data?.source?.returnedCurrentRows || {};
  const comparisonRows = state.home.data?.source?.returnedComparisonRows || {};
  const currentRowTotal = Object.values(returnedRows)
    .reduce((sum, value) => sum + (Number.isSafeInteger(value) ? value : 0), 0);
  const latestAvailableDate = state.home.data?.source?.latestAvailableDate || '';
  const comparisonSummary = [
    comparisonRows.storeDaily,
    comparisonRows.billDaily,
    comparisonRows.ledgerDaily,
    comparisonRows.regionDaily,
    comparisonRows.productFinanceDaily,
  ].reduce((sum, value) => sum + (Number.isSafeInteger(value) ? value : 0), 0);
  const emptyCurrentNotice = currentRowTotal === 0
    ? `<section class="home-empty-range-notice" role="status">
        <div><strong>当前日期范围已经加载完成，但没有经营历史数据。</strong><span>这不是仍在加载。${latestAvailableDate ? `最新完整历史日期是 ${escapeHtml(latestAvailableDate)}；对比期返回 ${numberFormatter.format(comparisonSummary)} 行。` : '最新完整历史日期待确认。'}</span></div>
        ${latestAvailableDate ? `<button type="button" class="refresh-cache-button" data-home-latest-date="${escapeHtml(latestAvailableDate)}">查看 ${escapeHtml(latestAvailableDate)}</button>` : ''}
      </section>`
    : '';
  return `
    ${emptyCurrentNotice}
    ${renderTodayCoreCards()}
    ${renderHistoryKpis()}
    ${renderHistoryTrends()}
    ${renderHistoryRankings()}`;
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
            const storeOwner = isStore ? ownerNameForStore(item) : '';
            const storeSubline = isStore
              ? [
                  item.name && item.name !== item.code ? item.name : null,
                  storeOwner ? shortOwnerName(storeOwner) : '负责人未分配',
                ].filter(Boolean).join(' · ')
              : '';
            return `
            <tr>
              <td class="row-index">${String(index + 1).padStart(2, '0')}</td>
              <td class="entity-column">
                <strong>${escapeHtml(isStore ? item.code : productCode(item, isStandard || isCanonicalProduct(item)))}</strong>
                <span>${escapeHtml(isStore
                  ? storeSubline
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

function salesPeriodStoreRanking(bundle) {
  const identity = {
    key: (row) => row.storeCode,
    label: (row) => baseStores().find(({ code }) => code === row.storeCode)?.name
      || row.storeCode,
    owner: (row) => {
      const store = baseStores().find(({ code }) => code === row.storeCode);
      return ownerNameForStore(store);
    },
    sub: () => '',
  };
  const operatingComplete = completeMetricSum(bundle.storeDaily, 'salesQuantity') !== null;
  let rows = operatingComplete
    ? aggregateHistoryRanking(bundle.storeDaily, identity, 'salesQuantity', null)
    : [];
  let basis = operatingComplete ? 'OPERATING' : 'UNAVAILABLE';
  if (!operatingComplete) {
    rows = aggregateHistoryRanking(bundle.financeDaily, identity, 'goodsCount', null);
    basis = rows.length ? 'FINANCE' : 'UNAVAILABLE';
  }
  const currency = homeCurrency(bundle) || financeCurrency(bundle);
  return {
    basis,
    rows: rows.filter(({ value }) => value > 0).map((row) => {
      const store = baseStores().find(({ code }) => code === row.key);
      const ownerKey = ownerKeyForStore(store) || row.ownerName;
      const next = {
        ...row,
        currency,
        tone: ownerDisplayTone(ownerKey),
      };
      return {
        ...next,
        sub: storeHistoryRankMeta(next, 'quantity'),
      };
    }),
  };
}

function salesPeriodSummary() {
  const metrics = historyMetricRows();
  const quantity = metrics.rows.find(({ key }) => key === 'salesQuantity');
  const storeRanking = salesPeriodStoreRanking(metrics.current);
  const financeBasis = storeRanking.basis === 'FINANCE';
  const observedSource = financeBasis
    ? metrics.current.financeDaily
    : metrics.current.productMode
      ? metrics.current.productDaily
      : metrics.current.storeDaily;
  const observedDays = new Set(observedSource.map(({ date }) => date).filter(Boolean)).size;
  const activeProductsSource = !financeBasis && metrics.current.productDaily.length
    ? metrics.current.productDaily.filter(({ salesQuantity }) => finiteMetric(salesQuantity) && salesQuantity > 0)
    : metrics.current.productFinanceDaily.filter(({ goodsCount }) => finiteMetric(goodsCount) && goodsCount > 0);
  const activeProductKeys = new Set(activeProductsSource.map((row) => [
    row.storeCode,
    row.productGrain,
    row.productKey,
  ].filter(Boolean).join(':')).filter(Boolean));
  const rankedQuantity = storeRanking.rows.reduce((sum, row) => sum + row.value, 0);
  const topShare = rankedQuantity > 0 && storeRanking.rows.length
    ? storeRanking.rows[0].value / rankedQuantity
    : null;
  const dailyAverage = typeof quantity?.value === 'number' && observedDays > 0
    ? quantity.value / observedDays
    : null;
  return {
    ...metrics,
    quantity,
    observedDays,
    activeProducts: activeProductKeys.size,
    activeStores: storeRanking.rows.length,
    dailyAverage,
    topShare,
    storeRanking,
  };
}

function salesPeriodMetric(label, value, note, tone = '') {
  return `
    <article class="sales-period-metric ${escapeHtml(tone)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(note)}</small>
    </article>`;
}

function salesPeriodOverview(summary, queryData) {
  const range = summary.range;
  const previousRange = previousHomeDateRange(range);
  const latestDate = queryData.history?.source?.latestAvailableDate;
  const returned = queryData.history?.source?.returnedCurrentRows || {};
  const historyRows = [
    returned.storeDaily || 0,
    returned.productDaily || 0,
    returned.financeDaily || 0,
    returned.productFinanceDaily || 0,
  ].reduce((sum, value) => sum + (Number.isSafeInteger(value) ? value : 0), 0);
  const quantityDisplay = typeof summary.quantity?.value === 'number'
    ? `${formatUnits(summary.quantity.value)} 件`
    : '—';
  const previousDisplay = typeof summary.quantity?.baseline === 'number'
    ? `${formatUnits(summary.quantity.baseline)} 件`
    : '—';
  const comparison = summary.quantity?.change || '—';
  const comparisonTone = comparison.startsWith('-')
    ? 'decline'
    : comparison.startsWith('+') || comparison === '新增'
      ? 'growth'
      : '';
  return `
    <section class="sales-period-overview" aria-label="当前筛选销量概览">
      <header class="sales-workspace-head">
        <div>
          <span class="eyebrow">SALES ANALYSIS</span>
          <h1>销量分析</h1>
          <p>先看选定日期的规模与变化，再用固定窗口定位增长、下滑和待归并商品。</p>
        </div>
        <div class="sales-range-receipt">
          <span>当前筛选</span>
          <strong>${escapeHtml(`${range.start} → ${range.end}`)}</strong>
          <small>${escapeHtml(`${summary.current.productMode ? '货号搜索范围' : `${summary.current.storeCodes.size} 家店`} · 前期 ${previousRange.start} → ${previousRange.end}`)}</small>
        </div>
      </header>
      <div class="sales-period-grid">
        ${salesPeriodMetric('本期销量', quantityDisplay, summary.storeRanking.basis === 'FINANCE' ? '财务明细 goodsCount · 报账生成日' : (summary.quantity?.note || '成交件数'), 'primary')}
        ${salesPeriodMetric('前期销量', previousDisplay, `${compactRangeLabel(previousRange)} 同长度窗口`)}
        ${salesPeriodMetric('较前期', comparison, '同长度窗口对比', comparisonTone)}
        ${salesPeriodMetric('有数据日日均', summary.dailyAverage === null ? '—' : `${formatDailyAverage(summary.dailyAverage)} 件`, `${numberFormatter.format(summary.observedDays)} 个有数据日，不补缺失日`)}
        ${salesPeriodMetric('有销量店铺', `${numberFormatter.format(summary.activeStores)} 家`, '当前返回范围内销量大于 0')}
        ${salesPeriodMetric('Top 1 店铺占比', summary.topShare === null ? '—' : formatRate(summary.topShare), summary.storeRanking.rows[0]?.label || '暂无可排序店铺')}
      </div>
      <div class="sales-data-receipt">
        <span><i></i>选定日期数据已就绪</span>
        <p>${escapeHtml(`本期返回 ${numberFormatter.format(historyRows)} 行 · 有销量货号 ${numberFormatter.format(summary.activeProducts)} 个 · ${summary.storeRanking.basis === 'FINANCE' ? '销量使用财务明细件数' : '销量使用经营日事实'}${latestDate ? ` · 最新历史 ${latestDate}` : ''} · 未知不补 0`)}</p>
      </div>
    </section>`;
}

function salesDailySeries(summary) {
  if (summary.storeRanking.basis !== 'FINANCE') {
    return groupHistoryByDate(summary.current);
  }
  const grouped = new Map();
  for (const row of summary.current.financeDaily) {
    const current = grouped.get(row.date) || [];
    current.push(row);
    grouped.set(row.date, current);
  }
  return [...grouped].sort(([left], [right]) => left.localeCompare(right))
    .map(([date, rows]) => ({
      date,
      salesQuantity: completeMetricSum(rows, 'goodsCount'),
      currency: financeCurrency(summary.current),
      amountBasis: 'FINANCE',
    }));
}

function salesTrendPanel(summary) {
  const daily = salesDailySeries(summary);
  const known = daily.filter(({ salesQuantity }) => finiteMetric(salesQuantity));
  const peak = known.slice().sort((left, right) => right.salesQuantity - left.salesQuantity)[0];
  const latest = known.at(-1);
  const first = known[0];
  const startEndChange = first && latest && first.salesQuantity > 0
    ? (latest.salesQuantity - first.salesQuantity) / first.salesQuantity
    : null;
  return `
    <section class="panel sales-trend-panel">
      <header class="sales-panel-head">
        <div><span class="eyebrow">PERIOD TREND</span><h2>日销量趋势</h2></div>
        <p>${escapeHtml(`${summary.range.start} → ${summary.range.end} · ${summary.storeRanking.basis === 'FINANCE' ? '财务报账明细生成日' : '经营业务日'} · 缺失不补线`)}</p>
      </header>
      <div class="sales-trend-layout">
        ${historyTrendChart(daily, 'salesQuantity', { suffix: '件' }, 'bar')}
        <aside class="sales-trend-insights" aria-label="趋势关键点">
          <div><span>峰值</span><strong>${peak ? `${formatUnits(peak.salesQuantity)} 件` : '—'}</strong><small>${peak?.date || '暂无完整日事实'}</small></div>
          <div><span>最新有数据日</span><strong>${latest ? `${formatUnits(latest.salesQuantity)} 件` : '—'}</strong><small>${latest?.date || '—'}</small></div>
          <div><span>首末变化</span><strong>${startEndChange === null ? '—' : `${startEndChange >= 0 ? '+' : ''}${(startEndChange * 100).toFixed(1)}%`}</strong><small>仅比较区间首个与最后一个有数据日</small></div>
        </aside>
      </div>
    </section>`;
}

function salesMomentumPanel(storeRows) {
  const comparable = storeRows.map((row) => {
    const signal = comparableDailySignal(row);
    const rate = signal.previous > 0
      ? (signal.recent - signal.previous) / signal.previous
      : null;
    return { row, signal, rate };
  });
  const growing = comparable.filter(({ rate }) => rate !== null && rate >= 0.1);
  const declining = comparable.filter(({ rate }) => rate !== null && rate <= -0.1);
  const zeroToday = storeRows.filter(({ unitsSold }) => unitsSold?.today === 0);
  const strongest = growing.slice().sort((left, right) => right.rate - left.rate)[0];
  const weakest = declining.slice().sort((left, right) => left.rate - right.rate)[0];
  const insight = (label, item, empty) => `
    <div class="sales-momentum-line">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(item?.row?.code || empty)}</strong>
      <small>${item ? escapeHtml(item.signal.label) : '—'}</small>
    </div>`;
  return `
    <article class="panel sales-momentum-panel">
      <header><span class="eyebrow">MOMENTUM</span><h3>店铺动量提示</h3><p>近 7 日日均对比此前 23 日日均。</p></header>
      <div class="sales-momentum-counts">
        <span><b>${numberFormatter.format(growing.length)}</b>增长 ≥10%</span>
        <span><b>${numberFormatter.format(declining.length)}</b>下降 ≤-10%</span>
        <span><b>${numberFormatter.format(zeroToday.length)}</b>今日为 0</span>
      </div>
      ${insight('增长最快', strongest, '暂无')}
      ${insight('下降最快', weakest, '暂无')}
      <p class="table-note">今日为实时累计；增长判断不使用今日与完整昨日直接对比。</p>
    </article>`;
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
  const period = salesPeriodSummary();
  return `
    ${sampleNotice()}
    ${salesPeriodOverview(period, queryData)}
    ${salesTrendPanel(period)}
    <section class="sales-store-analysis">
      ${historyRankTable(
        period.storeRanking.basis === 'FINANCE' ? '店铺财务明细件数排行' : '店铺销量贡献排行',
        period.storeRanking.basis === 'FINANCE'
          ? '当前经营日销量缺失，回退为财务报账明细 goodsCount；不冒充消费者下单日'
          : `${period.range.start} → ${period.range.end} · 条形长度代表当前榜内相对规模`,
        period.storeRanking.rows,
        { defaultTone: 'store-quantity' },
      )}
      ${salesMomentumPanel(storeRows)}
    </section>
    <section class="table-section">
      ${panelHeading('FIXED WINDOW STORE DETAIL', '店铺固定窗口对比', `当前筛选命中 ${numberFormatter.format(queryData.summary?.matchedMaterializedStoreCount || 0)} 家 · 今日 / 昨日 / 近 7 日 / 近 30 日来自最新销量快照`)}
      <aside class="quality-notice unknown">
        <strong>今日是实时累计，不与完整昨日直接作因果比较</strong>
        <span>动量统一使用近 7 日日均对比此前 23 日日均；破折号表示未知，不表示销量为 0。</span>
      </aside>
      ${salesTable('store', storeRows)}
    </section>
    <section class="table-section">
      ${panelHeading('PRODUCT MOMENTUM', '完整商品口径 · 商品动量筛查', `${sourceBoundary} · ${coverage.label} · 未归并商品保持店内隔离`)}
      ${quickFilterBar('sales', '商品快速筛查', [
        ['ALL', '全部商品'],
        ['GROWING', '增长 ≥10%'],
        ['DECLINING', '下降 ≤-10%'],
        ['UNCOMPARABLE', '不可比'],
        ['CANONICAL', '标准身份'],
        ['UNMAPPED', '待归并'],
      ])}
      ${salesSortControl()}
      <div class="sales-product-scope-note">
        <strong>${escapeHtml(productIdentityLabel())}</strong>
        <span>以下为固定窗口销量动量，不随顶部任意日期伪装变化；顶部日期影响本页概览、趋势和店铺贡献排行。</span>
      </div>
      ${salesTable('sku', productRows, queryData.products.pagination)}
      ${salesPagination(queryData.products.pagination, 'product', '商品销量')}
      ${state.sales.loading ? '<p class="query-refresh-note" role="status">正在刷新当前销量筛选结果…</p>' : ''}
      ${storeSkuMeta.truncated === true ? '<p class="table-note warning-note">当前筛选只覆盖物化到 Dashboard 的店内商品排行；源结果已截断，命中数不是仓库全量商品数量。</p>' : ''}
    </section>
    <section class="table-section">
      ${panelHeading('STANDARD PRODUCT DETAIL', '标准商品排行（已归并）', `${coverage.confirmed}/${coverage.total} 个目录 SKU 已确认；源物化 ${numberFormatter.format(productMeta.returned || 0)} / ${numberFormatter.format(productMeta.total || 0)}`)}
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
  const source = productRecord(activeList.source);
  const quickOptions = pendingView
    ? [
        ['ALL', '全部待归并'],
        ['WITH_SALES', '当前窗口有销量'],
        ['UNMAPPED', '等待证据归并'],
        ['MISSING_SPU', '销量队列缺 SPU'],
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
  const impactRange = queryData.query?.range || URL_DEFAULT_RANGE;
  const canonicalCoverage = productRecord(queryData.summary?.canonicalCoverage);
  return `
    ${sampleNotice()}
    ${focusEvidencePanel()}
    ${productDecisionSummary(queryData)}
    <section class="product-decision-workbench">
      ${productPendingStoreRanking(queryData)}
      ${productPipelineFlow(queryData)}
    </section>
    <section class="table-section inventory-workspace">
      ${panelHeading(
        'IDENTITY WORKSPACE',
        pendingView ? '待归并处理清单' : '标准商品覆盖清单',
        pendingView
          ? `按销量影响确定处理顺序 · ${sourceLine}`
          : `跨店标准商品 ${nullableUnits(canonicalCoverage.rowCount, '未知')} 个 · 多店覆盖 ${nullableUnits(canonicalCoverage.multiStoreRows, '未知')} 个 · ${sourceLine}`,
      )}
      ${productViewTabs(queryData)}
      ${quickFilterBar('products', pendingView ? '待归并快速筛查' : '标准商品快速筛查', quickOptions)}
      <div class="inventory-controls">
        ${productSelect('sort', '排序', [
          ['IMPACT_DESC', `${RANGE_META[impactRange].label}影响`],
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

function procurementAttentionCount(summary, ...codes) {
  const rows = Array.isArray(summary?.attentionCodes) ? summary.attentionCodes : [];
  return codes.reduce((total, code) => {
    const row = rows.find((item) => item.code === code);
    return total + (isUnit(row?.count) ? row.count : 0);
  }, 0);
}

function procurementDecisionOverview(queryData) {
  const summary = productRecord(queryData.summary);
  const totalOrders = isUnit(summary.orderCount) ? summary.orderCount : null;
  const attentionCount = isUnit(summary.matchedMaterializedAttentionCount)
    ? summary.matchedMaterializedAttentionCount
    : null;
  const overdue = procurementAttentionCount(summary, 'DELIVERY_OVERDUE', 'RECEIPT_OVERDUE');
  const pendingDelivery = procurementAttentionCount(
    summary,
    'OPEN_PURCHASE_ORDER',
    'DELIVERY_OVERDUE',
  );
  const pendingReceipt = procurementAttentionCount(
    summary,
    'DELIVERED_PENDING_RECEIPT',
    'RECEIPT_OVERDUE',
  );
  const pendingStorage = procurementAttentionCount(summary, 'RECEIVED_PENDING_STORAGE');
  const coverage = productRecord(queryData.source?.coverage);
  return `
    <section class="sales-period-overview procurement-decision-overview" aria-label="采购单经营概览">
      <header class="sales-workspace-head">
        <div>
          <span class="eyebrow">PURCHASE ORDER ANALYSIS</span>
          <h1>采购单</h1>
          <p>先处理逾期、待交付、待收货和待入库单据，再查看平台状态与数量证据；这里不是消费者订单。</p>
        </div>
        <div class="sales-range-receipt">
          <span>采购单业务日 / 当前范围</span>
          <strong>${escapeHtml(`${queryData.source?.businessDate || '业务日未知'} · ${inventoryScopeLabel()}`)}</strong>
          <small>${escapeHtml(`${nullableUnits(coverage.succeededStores, '未知')} / ${nullableUnits(coverage.totalStores, '未知')} 家店快照成功 · 顶部日期不改写当前单据状态`)}</small>
        </div>
      </header>
      <div class="sales-period-grid procurement-decision-grid">
        ${salesPeriodMetric('采购单总量', totalOrders === null ? '未知' : `${numberFormatter.format(totalOrders)} 张`, '来自当前平台状态快照，不等于关注队列', 'primary')}
        ${salesPeriodMetric('关注队列', attentionCount === null ? '未知' : `${numberFormatter.format(attentionCount)} 张`, '当前仍需交付、收货、入库或复核的已物化单据')}
        ${salesPeriodMetric('已逾期', `${numberFormatter.format(overdue)} 张`, '要求交付或收货时间已经超过')}
        ${salesPeriodMetric('待交付', `${numberFormatter.format(pendingDelivery)} 张`, '未交付单据，包含交付逾期')}
        ${salesPeriodMetric('待收货', `${numberFormatter.format(pendingReceipt)} 张`, '已交付尚未收货，包含收货逾期')}
        ${salesPeriodMetric('待入库', `${numberFormatter.format(pendingStorage)} 张`, '已收货尚未完成入库')}
      </div>
      <div class="sales-data-receipt">
        <span><i></i>采购单快照覆盖</span>
        <p>${escapeHtml(`${nullableUnits(coverage.succeededStores, '未知')} / ${nullableUnits(coverage.totalStores, '未知')} 家成功 · 最新来源 ${sourceTime(summary.latestSourceFetchedAt)} · ${coverage.reason || '覆盖说明待确认'}`)}</p>
      </div>
    </section>`;
}

function procurementStoreRankings(queryData) {
  const rows = Array.isArray(queryData.summary?.attentionByStore)
    ? queryData.summary.attentionByStore
    : [];
  const rankRow = (row, value, sub) => {
    const store = baseStores().find(({ code }) => code === row.storeCode);
    const ownerName = ownerNameForStore(store);
    return {
      key: row.storeCode,
      label: row.storeCode,
      ownerName,
      tone: ownerDisplayTone(ownerKeyForStore(store) || ownerName),
      value,
      sub,
    };
  };
  const attention = rows
    .filter((row) => isUnit(row.attentionCount) && row.attentionCount > 0)
    .map((row) => rankRow(
      row,
      row.attentionCount,
      `逾期 ${nullableUnits(row.overdueCount, '未知')} · 待交付 ${nullableUnits(row.pendingDeliveryCount, '未知')} · 待收货 ${nullableUnits(row.pendingReceiptCount, '未知')} · 待入库 ${nullableUnits(row.pendingStorageCount, '未知')}`,
    ))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, 8);
  const pendingStorage = rows
    .map((row) => {
      const metric = productRecord(row.pendingStorageQuantity);
      const value = isUnit(metric.total)
        ? metric.total
        : isUnit(metric.knownSum)
          ? metric.knownSum
          : 0;
      return rankRow(
        row,
        value,
        `${nullableUnits(row.pendingStorageCount, '未知')} 张待入库${isUnit(metric.unknownCount) && metric.unknownCount > 0 ? ` · ${numberFormatter.format(metric.unknownCount)} 张数量未知` : ' · 数量字段完整'}`,
      );
    })
    .filter((row) => row.value > 0)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, 8);
  return `
    <section class="rank-grid operation-risk-rankings" aria-label="采购单店铺排行">
      ${historyRankTable(
        '采购单关注量店铺排行',
        '当前关注队列 · Top 8 · 先定位积压单据最多的店铺',
        attention,
        { defaultTone: 'store-quantity', unit: '张' },
      )}
      ${historyRankTable(
        '待入库数量店铺排行',
        '已收货减已入库 · Top 8 · 未知数量不补零',
        pendingStorage,
        { defaultTone: 'product-quantity' },
      )}
    </section>`;
}

function procurementEvidenceDisclosure(queryData) {
  const summary = productRecord(queryData.summary);
  const stages = productRecord(summary.quantityStages);
  const overview = Array.isArray(queryData.statusOverview) ? queryData.statusOverview : [];
  return `
    <details class="panel product-boundary-disclosure operation-evidence-disclosure">
      <summary>
        <span class="eyebrow">DETAIL & BOUNDARY</span>
        <strong>状态总览与数量口径</strong>
        <small>展开查看平台状态、关注单据阶段数量和只读边界</small>
      </summary>
      <div class="inventory-disclosure-body">
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
          <p class="table-note">任一店铺数量未知时该状态合计保持“—”，绝不补零；具体行动以关注队列为准。</p>`
          : emptyEvidence('当前筛选没有采购单状态行', '这不代表没有采购单；请调整负责人、店铺、状态或搜索条件。')}
        ${panelHeading(
          'ATTENTION QUANTITY SNAPSHOT',
          '关注单据阶段数量证据',
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
        <p class="table-note">五个数量是同一批关注单据的独立阶段字段，不构成转化漏斗，也不据此推导完成率或百分比。</p>
        <div class="inventory-boundary-grid">
          <article><strong>单据口径</strong><span>SHEIN 向商家下达的采购单，不是消费者订单。</span></article>
          <article><strong>数量口径</strong><span>订购、交付、收货、入库与残次保持独立，不相加也不算比率。</span></article>
          <article><strong>来源时间</strong><span>接口快照时间与要求交付、收货等平台业务时间分开保存。</span></article>
          <article><strong>写操作</strong><span>当前页面与服务仍为只读，不提交任何采购单动作。</span></article>
        </div>
      </div>
    </details>`;
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
  const coverageLine = operationCoverageLine(queryData.source);
  const statusOptions = [
    ['ALL', '全部状态'],
    ...(Array.isArray(queryData.filters?.statuses) ? queryData.filters.statuses : [])
      .map((row) => [row.code, row.name || row.code]),
  ];
  return `
    ${sampleNotice()}
    ${focusEvidencePanel()}
    ${procurementDecisionOverview(queryData)}
    ${procurementStoreRankings(queryData)}
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
    ${procurementEvidenceDisclosure(queryData)}`;
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

function fulfilmentAttentionCount(summary, ...codes) {
  const rows = Array.isArray(summary?.attentionCodes) ? summary.attentionCodes : [];
  return codes.reduce((total, code) => {
    const row = rows.find((item) => item.code === code);
    return total + (isUnit(row?.count) ? row.count : 0);
  }, 0);
}

function fulfilmentMilestoneValue(queryData, code, field) {
  const rows = Array.isArray(queryData.milestoneOverview)
    ? queryData.milestoneOverview
    : [];
  const row = rows.find((item) => item.milestoneCode === code);
  return isUnit(row?.[field]) ? row[field] : null;
}

function fulfilmentDecisionOverview(queryData) {
  const summary = productRecord(queryData.summary);
  const coverage = productRecord(queryData.source?.coverage);
  const total = productRecord(summary.snapshotDeliveryCount);
  const attentionQuantity = productRecord(summary.attentionDeliveryQuantity);
  const received = fulfilmentMilestoneValue(queryData, 'RECEIVED', 'deliveryCount');
  const created = fulfilmentAttentionCount(summary, 'DELIVERY_CREATED_PENDING');
  const reserved = fulfilmentAttentionCount(summary, 'PICKUP_RESERVED_PENDING');
  const inTransit = fulfilmentAttentionCount(
    summary,
    'IN_TRANSIT_PENDING_RECEIPT',
    'RECEIPT_OVERDUE',
  );
  const coverageNote = [
    isUnit(coverage.failedStores) && coverage.failedStores > 0
      ? `失败 ${coverage.failedStoreCodes?.join('、') || `${coverage.failedStores} 家`}`
      : null,
    isUnit(coverage.inProgressStores) && coverage.inProgressStores > 0
      ? `同步中 ${coverage.inProgressStoreCodes?.join('、') || `${coverage.inProgressStores} 家`}`
      : null,
  ].filter(Boolean).join(' · ');
  return `
    <section class="sales-period-overview fulfilment-decision-overview" aria-label="交付入仓经营概览">
      <header class="sales-workspace-head">
        <div>
          <span class="eyebrow">DELIVERY & INBOUND ANALYSIS</span>
          <h1>交付入仓</h1>
          <p>先看待预约、待揽收和运输中单据，再进入交付单明细；预计收货时间缺失时保持未知。</p>
        </div>
        <div class="sales-range-receipt">
          <span>交付业务日 / 当前范围</span>
          <strong>${escapeHtml(`${queryData.source?.businessDate || '业务日未知'} · ${inventoryScopeLabel()}`)}</strong>
          <small>${escapeHtml(`${nullableUnits(coverage.succeededStores, '未知')} / ${nullableUnits(coverage.totalStores, '未知')} 家成功${coverageNote ? ` · ${coverageNote}` : ''}`)}</small>
        </div>
      </header>
      <div class="sales-period-grid fulfilment-decision-grid">
        ${salesPeriodMetric('交付单快照', stageMetricValue(total, '单'), '当前里程碑快照的交付单数', 'primary')}
        ${salesPeriodMetric('已收货', received === null ? '未知' : `${numberFormatter.format(received)} 单`, 'RECEIVED 当前快照，不据此推导履约率')}
        ${salesPeriodMetric('待预约', `${numberFormatter.format(created)} 单`, '交付单已创建，尚未完成预约')}
        ${salesPeriodMetric('待揽收', `${numberFormatter.format(reserved)} 单`, '已预约，物流尚未揽收')}
        ${salesPeriodMetric('运输中', `${numberFormatter.format(inTransit)} 单`, '尚未收货，包含逾期待收货')}
        ${salesPeriodMetric('未收货交付数量', stageMetricValue(attentionQuantity, '件'), `${stageMetricNote(attentionQuantity)} · 只统计关注队列`)}
      </div>
      <div class="sales-data-receipt">
        <span><i></i>交付快照覆盖</span>
        <p>${escapeHtml(`${nullableUnits(coverage.succeededStores, '未知')} / ${nullableUnits(coverage.totalStores, '未知')} 家成功 · 最新来源 ${sourceTime(queryData.source?.latestSourceFetchedAt)} · ${coverage.reason || '覆盖说明待确认'}`)}</p>
      </div>
    </section>`;
}

function fulfilmentStoreRankings(queryData) {
  const rows = Array.isArray(queryData.summary?.attentionByStore)
    ? queryData.summary.attentionByStore
    : [];
  const rankRow = (row, value, sub) => {
    const store = baseStores().find(({ code }) => code === row.storeCode);
    const ownerName = ownerNameForStore(store);
    return {
      key: row.storeCode,
      label: row.storeCode,
      ownerName,
      tone: ownerDisplayTone(ownerKeyForStore(store) || ownerName),
      value,
      sub,
    };
  };
  const countRows = rows
    .filter((row) => isUnit(row.attentionCount) && row.attentionCount > 0)
    .map((row) => rankRow(
      row,
      row.attentionCount,
      `待预约 ${nullableUnits(row.createdCount, '未知')} · 待揽收 ${nullableUnits(row.pickupReservedCount, '未知')} · 运输中 ${nullableUnits(row.inTransitCount, '未知')}${row.receiptOverdueCount ? ` · 逾期 ${numberFormatter.format(row.receiptOverdueCount)}` : ''}`,
    ))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, 8);
  const quantityRows = rows
    .map((row) => {
      const metric = productRecord(row.deliveryQuantity);
      const value = isUnit(metric.total)
        ? metric.total
        : isUnit(metric.knownSum)
          ? metric.knownSum
          : 0;
      const oldest = row.oldestInTransitTakenAt
        ? `最早揽收 ${formatDateTime(row.oldestInTransitTakenAt)}`
        : '暂无运输中揽收时间';
      return rankRow(
        row,
        value,
        `${oldest}${isUnit(metric.unknownCount) && metric.unknownCount > 0 ? ` · ${numberFormatter.format(metric.unknownCount)} 单数量未知` : ' · 数量字段完整'}`,
      );
    })
    .filter((row) => row.value > 0)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, 8);
  return `
    <section class="rank-grid operation-risk-rankings" aria-label="交付入仓店铺排行">
      ${historyRankTable(
        '未收货交付单店铺排行',
        '当前关注队列 · Top 8 · 先定位积压单据最多的店铺',
        countRows,
        { defaultTone: 'store-quantity', unit: '单' },
      )}
      ${historyRankTable(
        '未收货交付数量店铺排行',
        '当前关注队列交付数量 · Top 8 · 未知数量不补零',
        quantityRows,
        { defaultTone: 'product-quantity' },
      )}
    </section>`;
}

function fulfilmentEvidenceDisclosure(queryData) {
  const overview = Array.isArray(queryData.milestoneOverview) ? queryData.milestoneOverview : [];
  return `
    <details class="panel product-boundary-disclosure operation-evidence-disclosure">
      <summary>
        <span class="eyebrow">DETAIL & BOUNDARY</span>
        <strong>里程碑总览与口径说明</strong>
        <small>展开查看全部里程碑、交付数量和只读边界</small>
      </summary>
      <div class="inventory-disclosure-body">
        ${panelHeading(
          'MILESTONE SNAPSHOT',
          '交付里程碑紧凑总览',
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
          <p class="table-note">里程碑只表示单据当前阶段，不据此推导履约率或准时率；单数与数量各自独立判空。</p>`
          : emptyEvidence(
            '当前筛选没有交付里程碑行',
            `${['complete', 'partial'].includes(String(productRecord(queryData.source?.coverage).status || ''))
              ? '接口已有覆盖 · 当前筛选无事实行'
              : '尚未完成可信接入'}；请调整负责人、店铺、里程碑或搜索条件。`,
          )}
        <div class="inventory-boundary-grid">
          <article><strong>单位口径</strong><span>交付单数与交付数量是两个单位，不相加也不算比率。</span></article>
          <article><strong>预计收货</strong><span>来源缺失时保持未知，不用预约或揽收时间冒充。</span></article>
          <article><strong>里程碑</strong><span>只表示单据当前阶段，不构成转化漏斗或履约率。</span></article>
          <article><strong>写操作</strong><span>当前页面与服务仍为只读，不提交任何交付动作。</span></article>
        </div>
      </div>
    </details>`;
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
  const coverageLine = operationCoverageLine(queryData.source);
  const milestoneOptions = [
    ['ALL', '全部里程碑'],
    ...(Array.isArray(queryData.filters?.milestones) ? queryData.filters.milestones : [])
      .map((row) => [row.code, row.name || row.code]),
  ];
  return `
    ${sampleNotice()}
    ${focusEvidencePanel()}
    ${fulfilmentDecisionOverview(queryData)}
    ${fulfilmentStoreRankings(queryData)}
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
    ${fulfilmentEvidenceDisclosure(queryData)}`;
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
    ${inventorySummaryCards(queryData)}
    <section class="inventory-priority-section">
      ${panelHeading(
        'ACTION FIRST',
        '先处理这些',
        '缺货、急采、建议量缺口和对账异常分开表达；数字只来自当前筛选范围',
      )}
      ${inventoryPriorityCards(queryData)}
    </section>
    ${inventoryStoreRankings(queryData)}
    <section class="table-section inventory-workspace">
      ${panelHeading(
        'SUPPLY RISK WORKSPACE',
        inventoryView ? '库存缺货处理清单' : '平台备货与急采清单',
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
    ${inventoryEvidenceDisclosure(queryData)}`;
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

const WEBHOOK_EVENT_LABELS = Object.freeze({
  product_receive: '商品接收',
  product_audit_all_channels: '全渠道商品审核',
  product_audit: '商品审核',
  product_delete_audit: '商品删除审核',
  product_quota: '商品额度变更',
  rrp_review: '建议零售价审核',
  rrp_validity: '建议零售价有效期',
  product_compliance: '商品合规变更',
  purchase_order: '采购单',
  delivery: '发货单变更',
  logistics_forecast: '采购物流预报',
  purchase_return_application: '采购退货申请',
  purchase_return: '采购退货单',
  shortage: '缺货需求',
  authorization_change: '授权关系变更',
});

function webhookPriorityMeta(value) {
  const normalized = String(value || '').toUpperCase();
  if (['P0', 'CRITICAL'].includes(normalized)) {
    return { label: '紧急', tone: 'blocked', rank: 4 };
  }
  if (['P1', 'HIGH'].includes(normalized)) {
    return { label: '高优先', tone: 'blocked', rank: 3 };
  }
  if (['P2', 'MEDIUM'].includes(normalized)) {
    return { label: '需关注', tone: 'partial', rank: 2 };
  }
  if (['P3', 'LOW'].includes(normalized)) {
    return { label: '普通', tone: 'complete', rank: 1 };
  }
  return { label: '待评估', tone: 'unknown', rank: 0 };
}

function webhookEventLabel(event) {
  const projection = productRecord(event?.safeProjection);
  return projection.eventLabel
    || WEBHOOK_EVENT_LABELS[event?.eventFamily]
    || event?.businessType
    || '平台事件';
}

function webhookIdentifierParts(event) {
  const identifiers = productRecord(productRecord(event?.safeProjection).identifiers);
  return [
    ['SPU', identifiers.spu],
    ['SKC', identifiers.skc],
    ['SKU', identifiers.sku],
    ['单据', identifiers.document],
  ].filter(([, value]) => value).map(([label, value]) => `${label} ${value}`);
}

function webhookEventSummary(event) {
  const familyCopy = {
    purchase_order: '平台采购单发生变化，系统已记录并等待独立只读补查。',
    delivery: '发货或交付节点发生变化，请结合交付入仓页继续核对。',
    logistics_forecast: '采购物流预报发生变化，请核对预约、揽收与收货节点。',
    shortage: '平台推送缺货需求，请结合库存与备货页核对可用库存和建议量。',
    product_receive: '商品接收状态发生变化，请核对商品中心的最新平台状态。',
    product_audit: '商品审核状态发生变化，请核对审核结果与受影响商品。',
    product_audit_all_channels: '全渠道商品审核状态发生变化，请核对受影响渠道。',
    product_delete_audit: '商品删除审核发生变化，请确认商品是否仍可运营。',
    product_quota: '商品额度发生变化，请关注剩余额度和受影响店铺。',
    rrp_review: '建议零售价审核状态发生变化，请核对驳回或待处理项。',
    rrp_validity: '建议零售价有效期发生变化，请核对即将到期或已到期商品。',
    product_compliance: '商品合规状态发生变化，请优先核对可能影响在售的商品。',
    purchase_return_application: '采购退货申请发生变化，请核对当前处理节点。',
    purchase_return: '采购退货单状态发生变化，请核对退货与入仓影响。',
    authorization_change: '店铺授权关系发生变化，系统安全闸门可能受到影响。',
  };
  const details = [
    event?.businessKey ? `业务对象 ${event.businessKey}` : null,
    ...webhookIdentifierParts(event),
    event?.status ? `平台状态 ${event.status}` : null,
  ].filter(Boolean);
  return [
    familyCopy[event?.eventFamily] || '平台业务状态发生变化，请根据对象和状态继续核对。',
    details.join(' · '),
  ].filter(Boolean).join(' ');
}

function platformQueryState(kind) {
  const error = kind === 'error';
  return `
    <section class="panel procurement-query-state${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">
      <span class="eyebrow">PLATFORM QUERY</span>
      <h2>${error ? '平台动态查询暂不可用' : '正在读取平台重点动态'}</h2>
      <p>${error
        ? escapeHtml(state.platform.error || '请稍后重试。')
        : '队列、运行心跳、订阅回读和事件明细分别读取；加载失败不会显示成 0。'}</p>
      ${error
        ? '<button type="button" class="clear-button" data-platform-retry="1">重新查询</button>'
        : '<div class="query-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>'}
    </section>`;
}

function platformPagination(pagination, position = 'bottom') {
  if (!pagination || !isUnit(pagination.page) || !isUnit(pagination.pageSize)) return '';
  const matched = isUnit(pagination.matchedMaterializedRows)
    ? pagination.matchedMaterializedRows
    : 0;
  const pageCount = isUnit(pagination.pageCount) ? pagination.pageCount : 0;
  const displayedPage = pageCount === 0 ? 0 : pagination.page;
  return `
    <nav class="table-pagination ${position === 'top' ? 'pagination-top' : ''}" aria-label="平台动态分页（${position === 'top' ? '列表上方' : '列表下方'}）">
      <p>当前条件命中 ${numberFormatter.format(matched)} 条 · 第 ${numberFormatter.format(displayedPage)} / ${numberFormatter.format(pageCount)} 页</p>
      <div>
        <button type="button" data-platform-page="${Math.max(1, pagination.page - 1)}" ${pagination.hasPrevious ? '' : 'disabled'}>上一页</button>
        <button type="button" data-platform-page="${pagination.page + 1}" ${pagination.hasNext ? '' : 'disabled'}>下一页</button>
      </div>
    </nav>`;
}

function platformDecisionOverview(queryData) {
  const health = productRecord(queryData.health);
  const queue = productRecord(queryData.queue);
  const summary = productRecord(queryData.summary);
  const queuePending = isUnit(queue.queued) && isUnit(queue.running)
    ? queue.queued + queue.running
    : null;
  const failed = isUnit(summary.failureEventCount) && isUnit(queue.deadLetter)
    ? summary.failureEventCount + queue.deadLetter
    : null;
  return `
    <section class="sales-period-overview platform-decision-overview" aria-label="平台动态经营概览">
      <header class="sales-workspace-head">
        <div>
          <span class="eyebrow">PLATFORM OPERATING PULSE</span>
          <h1>平台动态</h1>
          <p>集中查看会影响销售、履约、商品可售状态或自动化能力的变化；普通成功回执保留在审计层。</p>
        </div>
        <div class="sales-range-receipt">
          <span>当前店铺范围</span>
          <strong>${escapeHtml(inventoryScopeLabel())}</strong>
          <small>${escapeHtml(`事件更新 ${sourceTime(queryData.source?.healthEvaluatedAt)}`)}</small>
        </div>
      </header>
      <div class="sales-period-grid platform-decision-grid">
        ${salesPeriodMetric('近24小时重点动态', isUnit(summary.last24hAttentionCount) ? `${numberFormatter.format(summary.last24hAttentionCount)} 条` : '未知', `影响 ${nullableUnits(summary.impactedStoreCount)} 家店`, 'primary')}
        ${salesPeriodMetric('系统处理中', queuePending === null ? '未知' : `${numberFormatter.format(queuePending)} 条`, `等待 ${queueMetric(queue, 'queued')} · 处理中 ${queueMetric(queue, 'running')}`)}
        ${salesPeriodMetric('处理失败', failed === null ? '未知' : `${numberFormatter.format(failed)} 条`, `事件失败 ${nullableUnits(summary.failureEventCount)} · 死信 ${nullableUnits(queue.deadLetter)}`)}
        ${salesPeriodMetric('高优先需处理', isUnit(summary.highPriorityCount) ? `${numberFormatter.format(summary.highPriorityCount)} 条` : '未知', '当前范围内的紧急与高优先事项')}
      </div>
      <div class="sales-data-receipt">
        <span><i></i>${health.ok === true ? '事件链路运行正常' : '事件链路需要检查'}</span>
        <p>${escapeHtml(`最后接收 ${sourceTime(queue.lastReceivedAt)} · 最后业务事件 ${sourceTime(queryData.source?.latestEventAt)}`)}</p>
      </div>
    </section>`;
}

function platformRankings(queryData) {
  const storeRows = Array.isArray(queryData.summary?.attentionByStore)
    ? queryData.summary.attentionByStore
    : [];
  const familyRows = Array.isArray(queryData.summary?.attentionByFamily)
    ? queryData.summary.attentionByFamily
    : [];
  const stores = storeRows.slice(0, 8).map((row) => {
    const store = baseStores().find(({ code }) => code === row.key);
    const ownerName = ownerNameForStore(store);
    return {
      key: row.key,
      label: row.key,
      ownerName,
      tone: ownerDisplayTone(ownerKeyForStore(store) || ownerName),
      value: row.count,
      sub: `最新重点动态 ${sourceTime(row.latestAt)}`,
    };
  });
  const families = familyRows.slice(0, 8).map((row) => ({
    key: row.key,
    label: row.label || WEBHOOK_EVENT_LABELS[row.key] || row.key,
    tone: 'product-quantity',
    value: row.count,
    sub: `${row.key} · 最新 ${sourceTime(row.latestAt)}`,
  }));
  return `
    <section class="rank-grid operation-risk-rankings platform-risk-rankings" aria-label="平台重点动态排行">
      ${historyRankTable(
        '重点动态店铺排行',
        '当前店铺范围 · Top 8 · 只统计需运营关注的事件',
        stores,
        { defaultTone: 'store-quantity', unit: '条' },
      )}
      ${historyRankTable(
        '重点动态类型排行',
        '当前店铺范围 · Top 8 · 普通验证回调不进入排行',
        families,
        { defaultTone: 'product-quantity', unit: '条' },
      )}
    </section>`;
}

function platformEventFilters(queryData) {
  const familyOptions = [
    ['ALL', '全部业务类型'],
    ...(Array.isArray(queryData.filters?.families) ? queryData.filters.families : [])
      .map((item) => [item.code, item.name || item.code]),
  ];
  const statusOptions = [
    ['ALL', '全部平台状态'],
    ...(Array.isArray(queryData.filters?.statuses) ? queryData.filters.statuses : [])
      .map((item) => [item.code, item.name || item.code]),
  ];
  return `
    <div class="operation-controls platform-filter-bar">
      ${operationSelect('platformView', '动态范围', [
        ['URGENT', '紧急与高优先'],
        ['ATTENTION', '只看需要关注'],
        ['BUSINESS', '全部业务动态'],
        ['ALL', '含技术验证'],
      ], state.platform.view)}
      ${operationSelect('platformSeverity', '重要程度', [
        ['ALL', '全部等级'],
        ['P0', 'P0 · 紧急'],
        ['P1', 'P1 · 高优先'],
        ['P2', 'P2 · 需关注'],
        ['P3', 'P3 · 普通'],
      ], state.platform.severity)}
      ${operationSelect('platformFamily', '业务类型', familyOptions, state.platform.family)}
      ${operationSelect('platformStatus', '平台状态', statusOptions, state.platform.status)}
      ${operationSearchControls('platform')}
    </div>`;
}

function webhookEventTimeline(rows, hasEvidence) {
  if (!rows.length) {
    return emptyEvidence(
      '当前没有需要关注的平台动态',
      hasEvidence
        ? '事件仓库已完成读取；当前筛选没有命中重点动态。普通成功回执仍可能只保留在技术审计中。'
        : '事件可能尚未接入或订阅回读尚未建立，不能把空列表解释为平台没有变化。',
    );
  }
  return `
    <div class="platform-event-list">
      ${rows.map((event) => {
        const priority = webhookPriorityMeta(event.severity);
        const store = baseStores().find(({ code }) => code === event.storeCode);
        const ownerName = ownerNameForStore(store);
        const technical = event.deliveryScope === 'APP_ONLY';
        return `
          <article class="platform-event-card ${priority.tone}">
            <div class="platform-event-time">
              <time>${escapeHtml(sourceTime(event.occurredAt || event.safeProjection?.receivedAt || event.createdAt))}</time>
              <span class="row-status ${priority.tone}">${escapeHtml(priority.label)}</span>
            </div>
            <div class="platform-event-body">
              <header>
                <div class="platform-event-title">
                  ${event.storeCode
                    ? `<strong>${escapeHtml(event.storeCode)}</strong>${ownerName ? `<span class="rank-owner" title="${escapeHtml(ownerName)}">${escapeHtml(shortOwnerName(ownerName))}</span>` : ''}`
                    : '<strong>应用级验证</strong>'}
                </div>
                ${event.status ? `<span class="row-status ${sourceStatusTone(event.status)}">${escapeHtml(event.status)}</span>` : '<span class="row-status unknown">状态未知</span>'}
              </header>
              <h3>${escapeHtml(webhookEventLabel(event))}</h3>
              <p>${escapeHtml(webhookEventSummary(event))}</p>
              <footer>
                <span>${escapeHtml(technical ? '技术验证回调' : '店铺业务事件')}</span>
                ${event.businessKey ? `<span class="platform-business-key">${escapeHtml(event.businessKey)}</span>` : ''}
              </footer>
            </div>
          </article>`;
      }).join('')}
    </div>`;
}

function platformEvidenceDisclosure(queryData) {
  const health = productRecord(queryData.health);
  const queue = queryData.queue && typeof queryData.queue === 'object'
    ? queryData.queue
    : null;
  const subscriptions = Array.isArray(queryData.subscription?.rows)
    ? queryData.subscription.rows
    : [];
  const receiverReady = health.receiver?.fresh === true;
  const workerReady = health.worker?.fresh === true;
  const eventGroups = [
    ['商品与合规', '商品接收、审核、删除、额度、建议零售价、合规变更'],
    ['采购与履约', '采购单、发货单、物流预报、缺货需求'],
    ['采购退货', '退货申请、退货单'],
    ['授权关系', '店铺授权关系变化'],
  ];
  return `
    <details class="panel product-boundary-disclosure operation-evidence-disclosure platform-evidence-disclosure">
      <summary>
        <span class="eyebrow">TECHNICAL EVIDENCE</span>
        <strong>队列、订阅回读与事件处理链路</strong>
        <small>展开查看技术运行证据；主视图不堆验签和密文流程</small>
      </summary>
      <div class="inventory-disclosure-body">
        ${panelHeading('QUEUE HEALTH', 'Webhook 队列健康', health.ok === true ? 'Receiver / Worker 心跳均在有效期内' : health.ok === false ? '至少一个运行进程心跳失效' : '运行态未知，不补充健康结论')}
        ${webhookQueueView(queue)}
        <section class="platform-subscription-evidence">
          ${panelHeading('SUBSCRIPTION READBACK', '订阅回读', subscriptions.length ? `${subscriptions.length} 条真实回读` : '没有回读记录，不等于已证明未订阅')}
          ${webhookSubscriptionTable(subscriptions)}
        </section>
        ${panelHeading('EVENT PIPELINE', '事件处理链路', '快速回执，业务处理不阻塞回调')}
        <ol class="process-flow four-steps">
          <li class="${receiverReady ? 'pipeline-ready' : ''}"><span>01</span><div><strong>验签与快速回执</strong><p>Receiver 校验应用身份、时间戳和签名，只保存加密 eventData。</p></div><b>${receiverReady ? 'Receiver 在线' : health.receiver ? '心跳失效' : '待心跳'}</b></li>
          <li class="${queueHasEvidence(queue) ? 'pipeline-ready' : ''}"><span>02</span><div><strong>Receipt 与队列</strong><p>原始回执、幂等键与队列消息同事务保存并快速返回 2xx。</p></div><b>${queueHasEvidence(queue) ? '运行态可见' : '待证据'}</b></li>
          <li class="${workerReady ? 'pipeline-ready' : ''}"><span>03</span><div><strong>解密与规范化</strong><p>Worker 只写白名单事件，需要详情时生成只读补查指令。</p></div><b>${workerReady ? 'Worker 在线' : health.worker ? '心跳失效' : '待心跳'}</b></li>
          <li class="${subscriptions.length || queryData.source?.eventMaterialization?.returned > 0 ? 'pipeline-ready' : ''}"><span>04</span><div><strong>回读与独立补漏</strong><p>订阅状态必须回读；定时同步器独立补齐事实，事件本身不等于详情已入仓。</p></div><b>${subscriptions.length || queryData.source?.eventMaterialization?.returned > 0 ? '证据可见' : '待证据'}</b></li>
        </ol>
        <div class="inventory-boundary-grid">
          ${eventGroups.map(([title, detail]) => `<article><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></article>`).join('')}
        </div>
      </div>
    </details>`;
}

function renderPlatform() {
  if (state.platform.loading && !state.platform.data) {
    return `${sampleNotice()}${platformQueryState('loading')}`;
  }
  if (state.platform.error && !state.platform.data) {
    return `${sampleNotice()}${platformQueryState('error')}`;
  }
  const queryData = state.platform.data;
  if (!queryData) return `${sampleNotice()}${platformQueryState('loading')}`;
  const events = Array.isArray(queryData.events?.rows) ? queryData.events.rows : [];
  const materialized = productRecord(queryData.source?.eventMaterialization);
  const hasEvidence = materialized.truncated === false
    || isUnit(materialized.returned)
    || platformAvailable();
  return `
    ${sampleNotice()}
    ${platformDecisionOverview(queryData)}
    <section class="table-section inventory-workspace platform-workspace">
      ${panelHeading(
        'OPERATOR ATTENTION',
        '需要关注',
        `服务端筛选与分页 · 当前物化 ${nullableUnits(materialized.returned)} 条${materialized.truncated === true ? ' · 源明细已截断' : ''}`,
      )}
      ${platformEventFilters(queryData)}
      ${platformPagination(queryData.events?.pagination, 'top')}
      ${webhookEventTimeline(events, hasEvidence)}
      ${platformPagination(queryData.events?.pagination, 'bottom')}
      ${state.platform.loading ? '<p class="query-refresh-note" role="status">正在刷新当前平台动态筛选结果…</p>' : ''}
      ${materialized.truncated === true ? '<p class="table-note warning-note">当前 Dashboard 只物化最近 100 条平台事件；筛选结果不是仓库全量历史。请缩小店铺或条件，并以事件仓库为最终证据。</p>' : ''}
    </section>
    ${platformEvidenceDisclosure(queryData)}`;
}

function opsQueryState(kind) {
  const error = kind === 'error';
  return `
    <section class="panel procurement-query-state${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">
      <span class="eyebrow">OPERATIONS QUERY</span>
      <h2>${error ? '运营待办查询暂不可用' : '正在汇总当前运营优先事项'}</h2>
      <p>${error
        ? escapeHtml(state.ops.error || '请稍后重试。')
        : '采购、交付、缺货、急采和同步质量分开取证；筛选与分页在服务端执行。'}</p>
      ${error
        ? '<button type="button" class="clear-button" data-ops-retry="1">重新查询</button>'
        : '<div class="query-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>'}
    </section>`;
}

function opsPagination(pagination, position = 'bottom') {
  if (!pagination || !isUnit(pagination.page) || !isUnit(pagination.pageSize)) return '';
  const matched = isUnit(pagination.matchedRows) ? pagination.matchedRows : 0;
  const pageCount = isUnit(pagination.pageCount) ? pagination.pageCount : 0;
  const displayedPage = pageCount === 0 ? 0 : pagination.page;
  return `
    <nav class="table-pagination ${position === 'top' ? 'pagination-top' : ''}" aria-label="运营待办分页（${position === 'top' ? '表格上方' : '表格下方'}）">
      <p>当前条件命中 ${numberFormatter.format(matched)} 条 · 第 ${numberFormatter.format(displayedPage)} / ${numberFormatter.format(pageCount)} 页</p>
      <div>
        <button type="button" data-ops-page="${Math.max(1, pagination.page - 1)}" ${pagination.hasPrevious ? '' : 'disabled'}>上一页</button>
        <button type="button" data-ops-page="${pagination.page + 1}" ${pagination.hasNext ? '' : 'disabled'}>下一页</button>
      </div>
    </nav>`;
}

function opsDecisionOverview(queryData) {
  const summary = productRecord(queryData.summary);
  const source = productRecord(queryData.source);
  const automation = productRecord(queryData.automation);
  const priorityCount = isUnit(summary.priorityCount)
    ? `${numberFormatter.format(summary.priorityCount)} 条`
    : '未知';
  const totalCount = isUnit(summary.scopedCount)
    ? `${numberFormatter.format(summary.scopedCount)} 条`
    : '未知';
  const writeBoundary = automation.writeEnabled === false
    ? '只读工作台'
    : automation.writeEnabled === true ? '写闸异常开启' : '写闸状态未知';
  const windows = productRecord(source.businessWindows);
  const windowLabels = [
    ['采购', windows.purchaseOrders],
    ['交付', windows.deliveries],
    ['库存', windows.inventoryRisks],
    ['备货', windows.stockAdviceRisks],
  ].map(([label, value]) => {
    const item = productRecord(value);
    const returned = nullableUnits(item.returned);
    const total = nullableUnits(item.total);
    return `${label} ${returned}/${total}${item.truncated === true ? ' 截断' : ''}`;
  });
  return `
    <section class="sales-period-overview ops-decision-overview" aria-label="运营优先事项概览">
      <header class="sales-workspace-head">
        <div>
          <span class="eyebrow">OPERATIONS CONTROL DESK</span>
          <h1>运营待办</h1>
          <p>把采购、交付、库存、备货和数据质量问题按严重度排成可筛查、可下钻的工作清单。</p>
        </div>
        <div class="sales-range-receipt">
          <span>当前范围 / 执行边界</span>
          <strong>${escapeHtml(inventoryScopeLabel())}</strong>
          <small>${escapeHtml(`${writeBoundary} · 快照 ${sourceTime(source.dashboardUpdatedAt)}`)}</small>
        </div>
      </header>
      <div class="sales-period-grid ops-decision-grid">
        ${salesPeriodMetric('优先处理', priorityCount, `当前范围共 ${totalCount}`, 'primary')}
        ${salesPeriodMetric('紧急 / 高优先', `${nullableUnits(summary.criticalCount)} / ${nullableUnits(summary.highPriorityCount)} 条`, '两类严重度分开统计')}
        ${salesPeriodMetric('逾期单据', `${nullableUnits(summary.overdueCount)} 条`, '只统计明确带逾期证据的采购或交付事项')}
        ${salesPeriodMetric('缺货 SKU', `${nullableUnits(summary.shortageCount)} 个`, '按独立库存风险明细统计')}
        ${salesPeriodMetric('急采 SKU', `${nullableUnits(summary.urgentCount)} 个`, '按平台备货建议与急采事实统计')}
        ${salesPeriodMetric('涉及店铺', `${nullableUnits(summary.impactedStoreCount)} 家`, '跨店系统项不虚构店铺归属')}
      </div>
      <div class="sales-data-receipt">
        <span><i></i>运营事实证据</span>
        <p>${escapeHtml(`${windowLabels.join(' · ')} · ${source.businessWindowTruncated === true ? '至少一个业务窗口已截断' : source.businessWindowTruncated === false ? '四类业务窗口未截断' : '截断状态未知'}`)}</p>
      </div>
    </section>`;
}

function opsRankings(queryData) {
  const storeRows = Array.isArray(queryData.summary?.attentionByStore)
    ? queryData.summary.attentionByStore
    : [];
  const domainRows = Array.isArray(queryData.summary?.attentionByDomain)
    ? queryData.summary.attentionByDomain
    : [];
  const stores = storeRows.slice(0, 6).map((row) => {
    const store = baseStores().find(({ code }) => code === row.key);
    const ownerName = ownerNameForStore(store);
    return {
      key: row.key,
      label: row.key,
      ownerName,
      tone: ownerDisplayTone(ownerKeyForStore(store) || ownerName),
      value: row.count,
      sub: `紧急 ${nullableUnits(row.criticalCount)} · 高优先 ${nullableUnits(row.highCount)} · 最新 ${sourceTime(row.latestAt)}`,
    };
  });
  const domains = domainRows.slice(0, 6).map((row) => ({
    key: row.key,
    label: row.label || row.key,
    tone: 'product-quantity',
    value: row.count,
    sub: `紧急 ${nullableUnits(row.criticalCount)} · 高优先 ${nullableUnits(row.highCount)} · 最新 ${sourceTime(row.latestAt)}`,
  }));
  return `
    <section class="rank-grid operation-risk-rankings ops-risk-rankings" aria-label="运营优先事项排行">
      ${historyRankTable(
        '优先事项店铺排行',
        '当前店铺范围 · Top 6 · 按紧急、高优先和事项数排序',
        stores,
        { defaultTone: 'store-quantity', unit: '条' },
      )}
      ${historyRankTable(
        '优先事项类型排行',
        '当前店铺范围 · Top 6 · 采购、交付、库存、备货和数据质量分开',
        domains,
        { defaultTone: 'product-quantity', unit: '条' },
      )}
    </section>`;
}

function opsFilters(queryData) {
  const domainOptions = Array.isArray(queryData.filters?.domains)
    ? queryData.filters.domains.map((item) => [item.code, item.name || item.code])
    : [['ALL', '全部业务类型']];
  return `
    ${quickFilterBar('ops', '快速筛查', [
      ['ALL', '全部'],
      ['HIGH', '高优先'],
      ['OVERDUE', '逾期单据'],
      ['SHORTAGE', '缺货'],
      ['URGENT', '急采'],
      ['SYNC', '同步 / 质量'],
    ])}
    <div class="operation-controls ops-filter-bar">
      ${operationSelect('opsView', '清单范围', [
        ['PRIORITY', '只看优先事项'],
        ['ALL', '全部运营事项'],
      ], state.ops.view)}
      ${operationSelect('opsSeverity', '严重度', [
        ['ALL', '全部等级'],
        ['CRITICAL', '紧急'],
        ['HIGH', '高优先'],
        ['MEDIUM', '中优先'],
        ['LOW', '低优先'],
      ], state.ops.severity)}
      ${operationSelect('opsDomain', '业务类型', domainOptions, state.ops.domain)}
      ${operationSelect('opsSort', '排序', [
        ['PRIORITY', '严重度优先'],
        ['LATEST', '证据时间最新'],
        ['DEADLINE', '要求时间最早'],
        ['STORE', '店铺顺序'],
      ], state.ops.sort)}
      ${operationSelect('opsPageSize', '每页', [
        ['25', '25 条'],
        ['50', '50 条'],
        ['100', '100 条'],
      ], String(state.ops.pageSize))}
      ${operationSearchControls('ops')}
    </div>`;
}

function opsEvidenceDisclosure(queryData) {
  const source = productRecord(queryData.source);
  const automation = productRecord(queryData.automation);
  const candidate = productRecord(source.candidateWindow);
  const windows = productRecord(source.businessWindows);
  const cards = [
    ['采购单', windows.purchaseOrders],
    ['交付入仓', windows.deliveries],
    ['库存风险', windows.inventoryRisks],
    ['备货风险', windows.stockAdviceRisks],
  ];
  return `
    <details class="panel product-boundary-disclosure operation-evidence-disclosure ops-evidence-disclosure">
      <summary>
        <span class="eyebrow">EVIDENCE & AUTOMATION BOUNDARY</span>
        <strong>数据范围与自动化边界</strong>
        <small>展开查看四类明细覆盖、候选池截断状态和写动作总闸</small>
      </summary>
      <div class="inventory-disclosure-body">
        <div class="inventory-boundary-grid">
          ${cards.map(([label, value]) => {
            const item = productRecord(value);
            return `<article><strong>${escapeHtml(label)}</strong><span>${escapeHtml(`返回 ${nullableUnits(item.returned)} / ${nullableUnits(item.total)} 条 · ${item.truncated === true ? '已截断' : item.truncated === false ? '未截断' : '截断状态未知'}`)}</span></article>`;
          }).join('')}
        </div>
        <section class="focus-strip ops-boundary-strip">
          <div><span>候选池</span><strong>${escapeHtml(`返回 ${nullableUnits(candidate.returned)} / ${nullableUnits(candidate.total)} 条`)}</strong></div>
          <p><b>${candidate.truncated === true ? '候选池已截断' : '候选池状态可读'}</b>${escapeHtml(candidate.note || '候选池只作补充，不替代业务明细。')}</p>
          <span class="row-status ${automation.writeEnabled === false ? 'complete' : 'blocked'}">${automation.writeEnabled === false ? '写动作关闭' : '写闸需检查'}</span>
        </section>
      </div>
    </details>`;
}

function renderOps() {
  if (state.ops.loading && !state.ops.data) {
    return `${sampleNotice()}${opsQueryState('loading')}`;
  }
  if (state.ops.error && !state.ops.data) {
    return `${sampleNotice()}${opsQueryState('error')}`;
  }
  const queryData = state.ops.data;
  if (!queryData) return `${sampleNotice()}${opsQueryState('loading')}`;
  const rows = Array.isArray(queryData.worklist?.rows) ? queryData.worklist.rows : [];
  const pagination = queryData.worklist?.pagination;
  const coverageNote = queryData.source?.businessWindowTruncated === true
    ? '至少一个独立业务明细窗口已截断，未命中不能解释为无风险。'
    : '四类独立业务明细窗口未截断；候选池只用于补充系统项。';
  return `
    ${sampleNotice()}
    ${focusEvidencePanel()}
    ${opsDecisionOverview(queryData)}
    ${opsRankings(queryData)}
    <section class="table-section ops-workspace">
      ${panelHeading(
        'OPERATOR WORKLIST',
        '运营优先事项清单',
        `服务端筛选与分页 · 当前范围 ${nullableUnits(queryData.summary?.scopedCount)} 条`,
      )}
      ${opsFilters(queryData)}
      ${opsPagination(pagination, 'top')}
      ${priorityWorklistTable(rows, {
        limit: pageSizeParam(state.ops.pageSize),
        totalCount: pagination?.matchedRows,
        totalAtLeast: false,
        coverageNote,
      })}
      ${opsPagination(pagination, 'bottom')}
      ${state.ops.loading ? '<p class="query-refresh-note" role="status">正在刷新当前运营待办筛选结果…</p>' : ''}
    </section>
    ${opsEvidenceDisclosure(queryData)}`;
}

function systemQueryState(kind) {
  const error = kind === 'error';
  return `
    <section class="panel procurement-query-state system-query-state${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">
      <span class="eyebrow">SYSTEM RUNTIME</span>
      <h2>${error ? '系统管理数据暂不可用' : '正在读取运行与数据维护状态'}</h2>
      <p>${error
        ? escapeHtml(state.system.error || '请稍后重新读取。')
        : '正在合并脱敏 systemd、Profile 续期、磁盘守卫和 Dashboard 覆盖；失败不会显示成正常。'}</p>
      ${error
        ? '<button type="button" class="clear-button" data-system-retry="1">重新读取</button>'
        : ''}
    </section>`;
}

function systemStatusClass(value) {
  if (['healthy', 'complete', 'active'].includes(value)) return 'complete';
  if (['attention', 'expired', 'blocked', 'critical'].includes(value)) return 'blocked';
  if (['running', 'scheduled', 'pending', 'unverified'].includes(value)) return 'pending';
  return 'unknown';
}

function systemSeverityLabel(value) {
  return ({
    P0: '紧急',
    P1: '高优先',
    P2: '需关注',
    P3: '观察',
  })[value] || '未知';
}

function systemSessionReason(row) {
  if (row?.state === 'active') return '最近一次续期验真通过';
  if (row?.state === 'pending') return '等待完成店铺登录';
  if (row?.state === 'attention') return '登录登记需处理';
  if (row?.state === 'unverified') return '等待下一次续期验真';
  if (row?.state === 'unknown') return '尚无续期验真证据';
  const code = row?.errorCode;
  return ({
    WEBAPI_SESSION_AUTH_EXPIRED: '保存登录态已失效',
    WEBAPI_SESSION_IDENTITY_UNPROVEN: '店铺身份未通过',
    WEBAPI_SESSION_ORIGIN_MISMATCH: '页面来源不匹配',
    WEBAPI_SESSION_LAUNCH_BLOCKED: 'Profile 启动受阻',
    SESSION_RENEWAL_FAILED: '续期未完成',
  })[code] || (code ? `错误码 ${code}` : '等待下一次续期验真');
}

function systemNextRunLabel(row) {
  if (row.nextRunAt) return sourceTime(row.nextRunAt);
  if (row.kind === 'daemon') return '持续运行';
  if (row.timerState === 'active') return '按间隔运行';
  return '尚无计划时间';
}

function systemRouteHref(hrefOrRoute) {
  const token = String(hrefOrRoute || 'system').replace(/^#/, '');
  const route = URL_ROUTE_KEYS.includes(token) ? token : 'system';
  return serializeHashState({
    route,
    owner: state.owner,
    store: state.store,
    range: state.range,
  });
}

function systemDecisionOverview(queryData) {
  const verdict = productRecord(queryData.verdict);
  const summary = productRecord(queryData.summary);
  const service = productRecord(summary.services);
  const profiles = productRecord(summary.profiles);
  const coverage = productRecord(summary.coverage);
  const disks = Array.isArray(summary.disks) ? summary.disks : [];
  const rootDisk = disks.find((row) => row.filesystem === '/') || {};
  const dataDisk = disks.find((row) => row.filesystem === '/data') || {};
  const writeClosed = queryData.boundaries?.actionWriteEnabled === false;
  const issueTone = verdict.level === 'critical'
    ? 'decline'
    : verdict.level === 'healthy' ? 'growth' : 'primary';
  return `
    <section class="sales-period-overview system-decision-overview ${escapeHtml(verdict.level || 'unknown')}" aria-label="系统运行与数据维护概览">
      <header class="sales-workspace-head">
        <div>
          <span class="eyebrow">RUNTIME & DATA CONTROL</span>
          <h1>系统管理</h1>
          <p>${escapeHtml(verdict.headline || '正在判断运行态')}。先处理会影响数据新鲜度的异常，再查看 Profile、同步覆盖与技术边界。</p>
        </div>
        <div class="sales-range-receipt">
          <span>当前店铺范围 / 运行快照</span>
          <strong>${escapeHtml(`${inventoryScopeLabel()} · ${nullableUnits(queryData.scope?.storeCount)} 家`)}</strong>
          <small>${escapeHtml(`运行态 ${sourceTime(queryData.source?.runtimeGeneratedAt)} · 只读查询`)}</small>
        </div>
      </header>
      <div class="sales-period-grid system-decision-grid">
        ${salesPeriodMetric('待处理事项', `${nullableUnits(verdict.issueCount)} 项`, `当前搜索命中 ${nullableUnits(verdict.matchedIssueCount)} 项`, issueTone)}
        ${salesPeriodMetric('核心任务', `${nullableUnits(service.healthy)} / ${nullableUnits(service.total)} 正常`, `异常 ${nullableUnits(service.attention)} · 运行中 ${nullableUnits(service.running)}`)}
        ${salesPeriodMetric('Profile 续期有效', `${nullableUnits(profiles.active)} / ${nullableUnits(profiles.total)} 家`, `最近验真 ${nullableUnits(profiles.verified)} 家 · 待处理 ${nullableUnits(profiles.actionRequired)}`)}
        ${salesPeriodMetric('数据域覆盖', `${nullableUnits(coverage.complete)} / ${nullableUnits(coverage.total)} 完整`, `同步中 ${nullableUnits(coverage.running)} · 异常 ${nullableUnits(coverage.attention)}`)}
        ${salesPeriodMetric('磁盘', `系统盘 ${rootDisk.usedPercent ?? '—'}%`, `数据盘 ${dataDisk.usedPercent ?? '—'}% · 阈值前告警`)}
        ${salesPeriodMetric('写动作总闸', writeClosed ? '关闭' : '需检查', writeClosed ? '系统页只提供观测和下钻' : '服务端写开关与只读阶段不一致', writeClosed ? 'growth' : 'decline')}
      </div>
      <div class="sales-data-receipt">
        <span><i></i>证据时间</span>
        <p>${escapeHtml(`Dashboard ${sourceTime(queryData.source?.dashboardUpdatedAt)} · 供应链 ${sourceTime(queryData.source?.supplyEvaluatedAt)} · Profile 续期 ${sourceTime(queryData.source?.renewalGeneratedAt)} · 运行态每 5 分钟刷新`)}</p>
      </div>
    </section>`;
}

function systemEmptyState(title, note) {
  return `
    <div class="empty-state system-empty-state" role="status">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(note)}</p>
    </div>`;
}

function systemIssueTable(queryData) {
  const issues = Array.isArray(queryData.issues?.rows) ? queryData.issues.rows : [];
  if (!issues.length) {
    return systemEmptyState(
      queryData.issues?.total > 0 ? '当前搜索没有命中系统问题' : '当前范围没有待处理系统问题',
      queryData.issues?.total > 0
        ? '清空搜索后可查看当前范围的全部运行与数据问题。'
        : '运行、Profile、数据覆盖和磁盘均未发现需处理项。',
    );
  }
  return `
    <div class="table-wrap">
      <table class="data-table system-issue-table">
        <thead><tr><th scope="col">优先级</th><th scope="col">问题</th><th scope="col">影响店铺</th><th scope="col">事实时间</th><th scope="col">查看</th></tr></thead>
        <tbody>${issues.map((row) => {
          const stores = Array.isArray(row.affectedStoreCodes) ? row.affectedStoreCodes : [];
          return `
            <tr>
              <td><span class="row-status ${row.severity === 'P0' || row.severity === 'P1' ? 'blocked' : 'pending'}">${escapeHtml(systemSeverityLabel(row.severity))}</span><small>${escapeHtml(row.domain || '系统')}</small></td>
              <td class="boundary-cell"><strong>${escapeHtml(row.title || '系统问题')}</strong><span>${escapeHtml(row.detail || '等待更多证据')}</span></td>
              <td>${stores.length ? `<div class="system-store-list">${stores.slice(0, 8).map((code) => `<span>${escapeHtml(code)}</span>`).join('')}${stores.length > 8 ? `<small>+${numberFormatter.format(stores.length - 8)}</small>` : ''}</div>` : '<span class="muted-value">跨店 / 系统级</span>'}</td>
              <td>${escapeHtml(sourceTime(row.evidenceAt))}</td>
              <td><a class="text-link" href="${escapeHtml(systemRouteHref(row.href))}">查看事实 →</a></td>
            </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}

function systemLoginMaintenanceAction(row) {
  const maintenance = state.system.maintenance;
  const status = maintenance.data;
  if (!status) {
    return `<span class="muted-value">${escapeHtml(
      maintenance.loading ? '正在读取' : maintenance.error || '暂不可用',
    )}</span>`;
  }
  const direct = status.stores.find((candidate) => candidate.storeCode === row.storeCode);
  if (!direct) return '<span class="muted-value">尚未纳入维护清单</span>';
  const active = status.active;
  const busy = Boolean(maintenance.busyAction);
  if (active && active.storeCode !== row.storeCode) {
    return `<button type="button" class="system-login-button" disabled>正在处理 ${escapeHtml(active.storeCode)}</button>`;
  }
  if (active?.storeCode === row.storeCode) {
    return `
      <div class="system-login-actions">
        <button type="button" class="system-login-button secondary" data-store-login-open="${escapeHtml(row.storeCode)}" ${maintenance.activeUrl ? '' : 'disabled'}>进入窗口</button>
        <button type="button" class="system-login-button" data-store-login-finish="${escapeHtml(row.storeCode)}" ${busy ? 'disabled' : ''}>完成并验证</button>
        <button type="button" class="system-login-button danger" data-store-login-close="${escapeHtml(row.storeCode)}" ${busy ? 'disabled' : ''}>关闭重来</button>
      </div>`;
  }
  const label = direct.status === 'completed' ? '重新登录' : '打开登录';
  return `<button type="button" class="system-login-button" data-store-login-start="${escapeHtml(row.storeCode)}" ${busy ? 'disabled' : ''}>${label}</button>`;
}

function systemLoginMaintenanceSummary() {
  const maintenance = state.system.maintenance;
  if (maintenance.error && !maintenance.data) {
    return `<p class="system-login-maintenance-error">${escapeHtml(maintenance.error)}。只读状态仍可查看，登录操作仅向系统管理员开放。</p>`;
  }
  if (!maintenance.data) {
    return '<p>正在读取 25 家店的云端登录登记与活动窗口。</p>';
  }
  const status = maintenance.data;
  const active = status.active?.storeCode
    ? `当前正在处理 ${status.active.storeCode}`
    : '当前没有打开的云端登录窗口';
  return `<p>登录维护中心：已登记 ${numberFormatter.format(status.completed)} / ${numberFormatter.format(status.total)} 家；${escapeHtml(active)}。登录掉线时可直接在对应行重新打开，不需要再次输入授权口令。</p>`;
}

function systemProfileTable(queryData) {
  const rows = Array.isArray(queryData.profiles?.rows) ? queryData.profiles.rows : [];
  if (!rows.length) {
    return systemEmptyState(
      queryData.profiles?.total > 0 ? '当前搜索没有命中 Profile' : '当前范围没有 Profile 状态',
      '这里只显示脱敏的登录登记和最近一次续期验真，不读取 Cookie、密码或页面内容。',
    );
  }
  return `
    <div class="system-workspace-actions system-login-maintenance-summary">
      ${systemLoginMaintenanceSummary()}
      <button type="button" class="clear-button" data-store-login-refresh="1" ${state.system.maintenance.loading ? 'disabled' : ''}>刷新登录状态</button>
    </div>
    <div class="table-wrap">
      <table class="data-table system-profile-table">
        <thead><tr><th scope="col">店铺</th><th scope="col">登录登记</th><th scope="col">最近续期验真</th><th scope="col">事实时间</th><th scope="col">判断</th><th scope="col">登录维护</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr class="${row.actionRequired ? 'needs-attention' : ''}">
            <td class="entity-column"><strong>${escapeHtml(row.storeCode)}</strong><span>${escapeHtml(row.ownerName || '负责人未知')}</span></td>
            <td><span class="row-status ${row.loginStatus === 'completed' ? 'complete' : row.loginStatus === 'needs_attention' ? 'blocked' : 'pending'}">${escapeHtml(({ completed: '已登记', pending: '未完成', needs_attention: '需处理' })[row.loginStatus] || '未知')}</span><small>${row.loginVerified ? '登记已验证' : '未标记验证'}</small></td>
            <td><span class="row-status ${systemStatusClass(row.state)}">${escapeHtml(row.stateLabel || '待确认')}</span><small>${escapeHtml(systemSessionReason(row))}</small></td>
            <td>${escapeHtml(sourceTime(row.evidenceAt))}</td>
            <td><strong class="system-decision-text ${row.actionRequired ? 'attention' : 'healthy'}">${row.actionRequired ? '需要登录或复核' : '当前有效'}</strong></td>
            <td>${systemLoginMaintenanceAction(row)}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">登录登记和续期验真是两套证据：显示“已登记”不等于当前登录态仍有效；续期快照未覆盖的店铺保留为待验真。</p>`;
}

function systemServiceTable(queryData) {
  const rows = Array.isArray(queryData.services?.rows) ? queryData.services.rows : [];
  return `
    <div class="table-wrap">
      <table class="data-table system-service-table">
        <thead><tr><th scope="col">任务</th><th scope="col">状态</th><th scope="col">最近运行</th><th scope="col">下次计划</th><th scope="col">结果</th><th scope="col">页面</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.kind === 'daemon' ? '常驻服务' : '计划任务')}</span></td>
            <td><span class="row-status ${systemStatusClass(row.state)}">${escapeHtml(({ healthy: '正常', running: '运行中', scheduled: '已计划', attention: '需处理', unknown: '未知' })[row.state] || '未知')}</span></td>
            <td>${escapeHtml(sourceTime(row.lastRunAt))}</td>
            <td>${escapeHtml(systemNextRunLabel(row))}</td>
            <td class="boundary-cell"><strong>${escapeHtml(`${row.activeState || 'unknown'} / ${row.subState || 'unknown'}`)}</strong><span>${escapeHtml(`${row.result || 'unknown'}${isUnit(row.exitStatus) ? ` · exit ${row.exitStatus}` : ''}`)}</span></td>
            <td><a class="text-link" href="${escapeHtml(systemRouteHref(row.route))}">进入 →</a></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function systemCoverageTable(queryData) {
  const rows = Array.isArray(queryData.coverage?.rows) ? queryData.coverage.rows : [];
  return `
    <div class="table-wrap">
      <table class="data-table system-coverage-table">
        <thead><tr><th scope="col">数据域</th><th scope="col">当前状态</th><th scope="col">成功覆盖</th><th scope="col">失败 / 缺失 / 过期 / 同步中</th><th scope="col">受影响店铺</th><th scope="col">证据时间</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td class="entity-column"><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.mode || '模式未知')}</span></td>
            <td><span class="row-status ${systemStatusClass(row.status)}">${escapeHtml(({ complete: '完整', running: '同步中', attention: '需处理', unknown: '未知' })[row.status] || '未知')}</span></td>
            <td>${escapeHtml(`${nullableUnits(row.complete)} / ${nullableUnits(row.total)} 家`)}</td>
            <td>${escapeHtml(`${nullableUnits(row.failed)} / ${nullableUnits(row.missing)} / ${nullableUnits(row.stale)} / ${nullableUnits(row.running)}`)}</td>
            <td>${Array.isArray(row.affectedStoreCodes) && row.affectedStoreCodes.length ? `<div class="system-store-list">${row.affectedStoreCodes.slice(0, 8).map((code) => `<span>${escapeHtml(code)}</span>`).join('')}</div>` : '<span class="muted-value">无</span>'}</td>
            <td class="boundary-cell"><strong>${escapeHtml(sourceTime(row.evaluatedAt || row.latestFetchedAt))}</strong><span>${escapeHtml(isUnit(row.freshnessMaxAgeSeconds) ? `时效门槛 ${Math.round(row.freshnessMaxAgeSeconds / 3600)} 小时` : '时效门槛未知')}</span></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="table-note">覆盖按当前负责人或店铺范围重新计算；同步中、历史失败和缺失分别显示，不用旧成功掩盖当前问题。</p>`;
}

function systemBoundaryDisclosure(queryData) {
  const boundaries = productRecord(queryData.boundaries);
  const releases = productRecord(boundaries.releases);
  const readiness = Array.isArray(queryData.readiness) ? queryData.readiness : [];
  const current = releases.current ? releases.current.slice(0, 7) : '未知';
  const previous = releases.previous ? releases.previous.slice(0, 7) : '未知';
  return `
    <details class="panel product-boundary-disclosure system-boundary-disclosure">
      <summary>
        <span class="eyebrow">TECHNICAL BOUNDARY</span>
        <strong>接入证据与安全边界</strong>
        <small>展开查看应用、授权、销量探针、事实入仓、版本和写动作总闸</small>
      </summary>
      <div class="inventory-disclosure-body">
        <div class="system-boundary-grid">
          <article><span>当前 / 上一版本</span><strong>${escapeHtml(`${current} / ${previous}`)}</strong><small>回滚版本持续保留</small></article>
          <article><span>销量权限</span><strong>${escapeHtml(boundaries.salesPermission?.status === 'granted' ? '已授权' : '待确认')}</strong><small>${escapeHtml(`${nullableUnits(boundaries.salesPermission?.authorizedStores)} / ${nullableUnits(boundaries.salesPermission?.totalStores)} 家`)}</small></article>
          <article><span>自动化模式</span><strong>${escapeHtml(boundaries.actionMode || 'unknown')}</strong><small>${boundaries.actionWriteEnabled ? '写动作需检查' : '所有执行入口关闭'}</small></article>
          <article><span>Webhook 仓库</span><strong>${boundaries.platformWarehouseReady ? '已就绪' : '待确认'}</strong><small>运行心跳在平台动态页独立取证</small></article>
        </div>
        <div class="table-wrap">
          <table class="data-table readiness-table">
            <thead><tr><th scope="col">阶段</th><th scope="col">状态</th><th scope="col">证据范围</th><th scope="col">说明</th></tr></thead>
            <tbody>${readiness.map((row) => `
              <tr>
                <td class="entity-column"><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.key)}</span></td>
                <td><span class="row-status ${readinessClass(row.status)}">${escapeHtml(row.status || 'unknown')}</span></td>
                <td>${escapeHtml(isUnit(row.completed) && isUnit(row.total) ? `${row.completed} / ${row.total}` : '证据待接入')}</td>
                <td>${escapeHtml(row.note || '暂无说明')}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </details>`;
}

function renderSystem() {
  if (state.system.loading && !state.system.data) {
    return `${sampleNotice()}${systemQueryState('loading')}`;
  }
  if (state.system.error && !state.system.data) {
    return `${sampleNotice()}${systemQueryState('error')}`;
  }
  const queryData = state.system.data;
  if (!queryData) return `${sampleNotice()}${systemQueryState('loading')}`;
  return `
    ${sampleNotice()}
    ${systemDecisionOverview(queryData)}
    <section class="table-section system-issues-workspace">
      ${panelHeading('ACTION REQUIRED', '系统待处理事项', `按影响程度排序 · 当前范围 ${nullableUnits(queryData.issues?.total)} 项`)}
      <div class="system-workspace-actions">
        <p>搜索框可按店铺、问题或错误码筛查；重新读取只获取脱敏快照，不执行 systemd、登录或同步任务。</p>
        <button type="button" class="clear-button" data-system-retry="1">重新读取运行态</button>
      </div>
      ${systemIssueTable(queryData)}
    </section>
    <section class="table-section system-profiles-workspace">
      ${panelHeading('PROFILE SESSION', '店铺登录与续期', `当前筛选显示 ${nullableUnits(queryData.profiles?.matched)} / ${nullableUnits(queryData.profiles?.total)} 家`)}
      ${systemProfileTable(queryData)}
    </section>
    <section class="table-section">
      ${panelHeading('SERVICE RUNTIME', '核心服务与计划任务', 'systemd 脱敏回读 · 失败结果不会被 inactive 状态掩盖')}
      ${systemServiceTable(queryData)}
    </section>
    <section class="table-section">
      ${panelHeading('DATA FRESHNESS', '数据同步覆盖', '按当前负责人或店铺范围核算 6 个只读业务域')}
      ${systemCoverageTable(queryData)}
    </section>
    ${systemBoundaryDisclosure(queryData)}
    ${state.system.loading ? '<p class="query-refresh-note" role="status">正在重新读取系统运行态…</p>' : ''}`;
}

async function runSystemStoreLoginAction(action, storeCode = '') {
  const maintenance = state.system.maintenance;
  if (maintenance.busyAction) return;
  const normalizedStoreCode = String(storeCode || '').trim().toUpperCase();
  let popup = null;
  if (action === 'start') {
    popup = window.open('about:blank', `fm-store-login-${normalizedStoreCode}`);
  }
  maintenance.busyAction = action;
  maintenance.busyStore = normalizedStoreCode;
  maintenance.error = '';
  render();
  try {
    const result = await postJson(
      `/api/system/store-login/${action}`,
      action === 'close' ? {} : { storeCode: normalizedStoreCode },
    );
    if (action === 'start') {
      const openUrl = String(result.openUrl || '');
      if (!/^\/store-login\/session\/[A-Za-z0-9%_-]+#token=[A-Za-z0-9_-]+$/.test(openUrl)) {
        throw new Error('登录窗口地址无效');
      }
      maintenance.activeUrl = openUrl;
      sessionStorage.setItem('fmSystemStoreLoginActiveUrl', openUrl);
      if (popup) popup.location.replace(openUrl);
    } else {
      maintenance.activeUrl = '';
      sessionStorage.removeItem('fmSystemStoreLoginActiveUrl');
    }
  } catch (error) {
    popup?.close();
    maintenance.error = error instanceof Error ? error.message : '登录维护操作未完成';
  } finally {
    maintenance.busyAction = '';
    maintenance.busyStore = '';
    await loadSystemLoginMaintenance();
  }
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

function renderHomeCalendar() {
  if (!elements.homeCalendarGrid) return;
  const range = selectedHomeDateRange();
  const anchor = state.homeCalendarAnchor || `${range.start.slice(0, 7)}-01`;
  state.homeCalendarAnchor = anchor;
  const week = ['一', '二', '三', '四', '五', '六', '日'];
  const panel = (monthStart, position) => {
    const first = new Date(`${monthStart}T00:00:00.000Z`);
    const offset = (first.getUTCDay() + 6) % 7;
    const gridStart = shiftIsoDate(monthStart, -offset);
    const monthLabel = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'long',
    }).format(first);
    const days = Array.from({ length: 42 }, (_, index) => shiftIsoDate(gridStart, index));
    return `
      <section class="range-calendar-panel">
        <header class="calendar-panel-head">
          <div><span>${position === 'start' ? '开始月份' : '结束月份'}</span><h4>${escapeHtml(monthLabel)}</h4></div>
          <div class="calendar-nav">
            ${position === 'start' ? '<button type="button" data-home-calendar-shift="-1" aria-label="上一个月">‹</button>' : ''}
            ${position === 'end' ? '<button type="button" data-home-calendar-shift="1" aria-label="下一个月">›</button>' : ''}
          </div>
        </header>
        <div class="calendar-week">${week.map((day) => `<span>${day}</span>`).join('')}</div>
        <div class="calendar-days">${days.map((date) => {
          const classes = [
            'calendar-day',
            date.slice(0, 7) === monthStart.slice(0, 7) ? '' : 'out',
            date >= range.start && date <= range.end ? 'in-range' : '',
            date === range.start ? 'start' : '',
            date === range.end ? 'end' : '',
          ].filter(Boolean).join(' ');
          return `<button type="button" class="${classes}" data-home-calendar-date="${date}" aria-label="${date}">${Number(date.slice(-2))}</button>`;
        }).join('')}</div>
      </section>`;
  };
  elements.homeCalendarGrid.innerHTML = `${panel(anchor, 'start')}${panel(shiftIsoMonth(anchor, 1), 'end')}`;
}

function updateFilters() {
  elements.search.value = state.query;
  elements.scope.value = state.store !== 'ALL'
    ? `STORE:${state.store}`
    : state.owner !== 'ALL'
      ? `OWNER:${state.owner}`
      : 'ALL';
  elements.rangeButtons.forEach((button) => {
    const active = button.dataset.homeRangePreset === state.homeRangePreset;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (elements.rangeSummary) {
    const dates = selectedHomeDateRange();
    const label = dates.custom
      ? '自定义'
      : HOME_RANGE_PRESETS[state.homeRangePreset]?.label || '今天';
    elements.rangeSummary.textContent = `${dates.start} → ${dates.end} · ${label}`;
  }
  if (elements.rangeToggle) {
    elements.rangeToggle.setAttribute('aria-expanded', String(state.homeRangeOpen));
  }
  if (elements.rangePopover) elements.rangePopover.hidden = !state.homeRangeOpen;
  const dates = selectedHomeDateRange();
  if (elements.homeDateStart) elements.homeDateStart.value = dates.start;
  if (elements.homeDateEnd) elements.homeDateEnd.value = dates.end;
  if (state.homeRangeOpen) renderHomeCalendar();
  const hasFilters = Boolean(state.query.trim())
    || state.owner !== 'ALL'
    || state.store !== 'ALL'
    || state.range !== 'today'
    || state.homeDateCustom;
  elements.clearFilters.disabled = !hasFilters;
  if (elements.forceRefresh) {
    const refreshing = state.loading || state.home.loading;
    elements.forceRefresh.disabled = refreshing;
    elements.forceRefresh.textContent = refreshing ? '刷新中…' : '强制刷新缓存';
  }
}

function updateDatasetChrome() {
  if (!state.data) {
    elements.datasetBadge.textContent = state.loading ? '正在读取' : '数据不可用';
    elements.datasetBadge.className = `status-badge ${state.loading ? 'neutral' : 'error'}`;
    elements.updatedAt.textContent = state.loading ? '--' : '读取失败';
    elements.sidebarAccountName.textContent = state.loading ? '正在读取' : '登录状态待确认';
    elements.sidebarPermission.textContent = '账号权限待确认';
    [
      elements.sidebarOperatingFreshness,
      elements.sidebarFinanceFreshness,
      elements.sidebarLedgerFreshness,
      elements.sidebarSettlementFreshness,
    ].forEach((element) => {
      element.textContent = state.loading ? '读取中' : '读取失败';
      element.title = '';
    });
    elements.sidebarSampleNote.hidden = true;
    delete document.body.dataset.dataset;
    return;
  }

  const status = datasetStatus();
  const statusLabels = {
    live: '正式数据',
    sample: '示例数据',
    empty: '暂无数据',
    neutral: '状态待确认',
  };
  const access = state.data.access || {};
  const accountName = access.displayName || access.username || '已登录';
  const accessParts = [
    access.roleLabel || null,
    access.readAllStores === true ? '全部店铺可查看' : '查看范围待确认',
    access.writeEnabled === true ? '写入已启用' : '写入需单独授权',
  ].filter(Boolean);
  elements.datasetBadge.textContent = statusLabels[status] || statusLabels.neutral;
  elements.datasetBadge.className = `status-badge ${status}`;
  elements.updatedAt.textContent = formatDateTime(state.data.updatedAt);
  elements.sidebarAccountName.textContent = accountName;
  elements.sidebarAccountName.title = access.username && access.username !== accountName
    ? `${accountName} · ${access.username}`
    : accountName;
  elements.sidebarPermission.textContent = accessParts.join(' · ') || '账号权限待确认';
  const freshness = state.home.data?.source?.freshness || {};
  [
    [elements.sidebarOperatingFreshness, freshness.operating],
    [elements.sidebarFinanceFreshness, freshness.finance],
    [elements.sidebarLedgerFreshness, freshness.ledger],
    [elements.sidebarSettlementFreshness, freshness.settlement],
  ].forEach(([element, source]) => {
    const display = sidebarFreshnessText(source);
    element.textContent = display.label;
    element.title = display.title;
  });
  elements.sidebarSampleNote.hidden = status !== 'sample';
  document.body.dataset.dataset = status;
}

function updateLiveUpdateChrome() {
  if (!elements.liveUpdateBadge) return;
  const labels = {
    connecting: ['连接中', 'neutral'],
    connected: ['快照自动更新', 'complete'],
    refreshing: ['读取新快照', 'partial'],
    reconnecting: ['重新连接', 'partial'],
    unsupported: ['需手动刷新', 'neutral'],
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

async function postJson(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = '';
    try {
      const payload = await response.json();
      message = payload?.error?.message || '';
    } catch {
      message = '';
    }
    throw new Error(message || `登录维护服务返回 HTTP ${response.status}`);
  }
  return response.json();
}

const HOME_CACHE_LIMIT = 24;
const HOME_CACHE_FRESH_MS = 5 * 60 * 1000;
const HOME_PREFETCH_PRESETS = Object.freeze([
  'today',
  'yesterday',
  'last7',
  'last30',
  'last3',
  'last15',
  'thisMonth',
  'lastMonth',
]);

function homeApiPath({ force = false, range = selectedHomeDateRange() } = {}) {
  const params = new URLSearchParams({
    start: range.start,
    end: range.end,
    owner: state.owner,
    store: state.store,
  });
  if (state.query.trim()) params.set('q', state.query.trim());
  if (force) params.set('refresh', '1');
  return `/api/home?${params.toString()}`;
}

function rememberHomeResult(key, data) {
  state.home.cache.delete(key);
  state.home.cache.set(key, { data, cachedAt: Date.now() });
  while (state.home.cache.size > HOME_CACHE_LIMIT) {
    state.home.cache.delete(state.home.cache.keys().next().value);
  }
}

function cachedHomeResult(key) {
  const cached = state.home.cache.get(key);
  if (!cached) return null;
  state.home.cache.delete(key);
  state.home.cache.set(key, cached);
  return cached;
}

function homePrefetchScope() {
  return [state.owner, state.store, state.query.trim()].join('|');
}

function scheduleHomePresetPrefetch() {
  const scope = homePrefetchScope();
  if (
    state.route !== 'home'
    || state.home.prefetching
    || state.home.prefetchScope === scope
  ) return;
  state.home.prefetchScope = scope;
  const paths = [...new Set(HOME_PREFETCH_PRESETS.map((preset) => homeApiPath({
    range: homePresetDateRange(preset),
  })))].filter((path) => !state.home.cache.has(path));
  if (!paths.length) return;
  state.home.prefetching = true;
  window.setTimeout(async () => {
    try {
      const queue = [...paths];
      const worker = async () => {
        while (queue.length) {
          if (state.route !== 'home' || homePrefetchScope() !== scope) return;
          const path = queue.shift();
          try {
            rememberHomeResult(path, await fetchJson(path));
          } catch {
            // Prefetch is optional. An explicit range selection still performs
            // the normal authenticated request and reports its own error.
          }
        }
      };
      await Promise.all([worker(), worker()]);
    } finally {
      state.home.prefetching = false;
    }
  }, 250);
}

async function loadHome({ force = false } = {}) {
  if (!state.data || state.route !== 'home') return;
  const cacheKey = homeApiPath();
  const serial = state.home.requestSerial + 1;
  state.home.requestSerial = serial;
  state.home.loading = true;
  state.home.error = '';
  state.home.forceRefresh = force;
  try {
    const result = await fetchJson(homeApiPath({ force }));
    if (serial !== state.home.requestSerial) return;
    rememberHomeResult(cacheKey, result);
    state.home.data = result;
    state.home.lastLoadedAt = new Date().toISOString();
    scheduleHomePresetPrefetch();
  } catch (error) {
    if (serial !== state.home.requestSerial) return;
    state.home.error = error instanceof Error ? error.message : '首页经营数据暂不可用';
  } finally {
    if (serial === state.home.requestSerial) {
      state.home.loading = false;
      state.home.forceRefresh = false;
      render();
    }
  }
}

let homeLoadTimer = null;
function scheduleHomeLoad({ delay = 0, force = false } = {}) {
  if (homeLoadTimer) clearTimeout(homeLoadTimer);
  if (state.route !== 'home') {
    state.home.requestSerial += 1;
    state.home.loading = false;
    return;
  }
  const cacheKey = homeApiPath();
  const cached = force ? null : cachedHomeResult(cacheKey);
  if (cached) {
    state.home.data = cached.data;
    state.home.loading = false;
    state.home.error = '';
    state.home.forceRefresh = false;
    render();
    if ((Date.now() - cached.cachedAt) <= HOME_CACHE_FRESH_MS) {
      scheduleHomePresetPrefetch();
      return;
    }
  }
  if (!cached) state.home.data = null;
  state.home.loading = true;
  state.home.error = '';
  state.home.forceRefresh = force;
  render();
  homeLoadTimer = setTimeout(() => {
    homeLoadTimer = null;
    void loadHome({ force });
  }, delay);
}

async function loadDashboard(options = {}) {
  const force = options?.force === true;
  if (force) {
    state.home.cache.clear();
    state.home.prefetchScope = '';
  }
  state.loading = true;
  state.error = '';
  state.healthError = '';
  render();

  const healthPromise = fetchJson('/health')
    .then((health) => ({ ok: true, health }))
    .catch((error) => ({ ok: false, error }));

  try {
    const dashboard = await fetchJson(force ? '/api/dashboard?refresh=1' : '/api/dashboard');
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
  if (state.data && state.route === 'home') {
    scheduleHomeLoad({ force });
  }
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
  if (state.data && state.route === 'platform') {
    schedulePlatformLoad();
  }
  if (state.data && state.route === 'ops') {
    scheduleOpsLoad();
  }
  if (state.data && state.route === 'system') {
    scheduleSystemLoad();
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
    state.home.cache.clear();
    state.home.prefetchScope = '';
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
    platformView: state.platform.view,
    platformSeverity: state.platform.severity,
    platformFamily: state.platform.family,
    platformStatus: state.platform.status,
    platformSort: state.platform.sort,
    platformPage: state.platform.page,
    platformPageSize: state.platform.pageSize,
    opsView: state.ops.view,
    opsSeverity: state.ops.severity,
    opsDomain: state.ops.domain,
    opsSort: state.ops.sort,
    opsPage: state.ops.page,
    opsPageSize: state.ops.pageSize,
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
  if (!state.homeDateCustom) {
    state.homeRangePreset = ({
      today: 'today',
      yesterday: 'yesterday',
      last7Days: 'last7',
      last30Days: 'last30',
    })[parsed.range] || 'today';
  }
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
  state.platform.view = allowListedToken(
    parsed.platformView,
    URL_PLATFORM_VIEWS,
    'URGENT',
  );
  state.platform.severity = allowListedToken(
    parsed.platformSeverity,
    URL_PLATFORM_SEVERITIES,
    'ALL',
  );
  state.platform.family = operationCodeParam(parsed.platformFamily);
  state.platform.status = operationCodeParam(parsed.platformStatus);
  state.platform.sort = allowListedToken(
    parsed.platformSort,
    URL_PLATFORM_SORTS,
    'PRIORITY',
  );
  state.platform.page = parsed.platformPage || 1;
  state.platform.pageSize = pageSizeParam(parsed.platformPageSize);
  state.ops.view = allowListedToken(parsed.opsView, URL_OPS_VIEWS, 'PRIORITY');
  state.ops.severity = allowListedToken(parsed.opsSeverity, URL_OPS_SEVERITIES, 'ALL');
  state.ops.domain = allowListedToken(parsed.opsDomain, URL_OPS_DOMAINS, 'ALL');
  state.ops.sort = allowListedToken(parsed.opsSort, URL_OPS_SORTS, 'PRIORITY');
  state.ops.page = parsed.opsPage || 1;
  state.ops.pageSize = pageSizeParam(parsed.opsPageSize);
  if (parsed.quick === 'ALL') delete state.quickFilters[parsed.route];
  else state.quickFilters[parsed.route] = parsed.quick;
}

function syncRouteFromLocation() {
  const parsed = parseHashState(window.location.hash, currentHashState());
  const routeChanged = state.route !== parsed.route;
  applyHashState(parsed);
  syncUrlFromState();
  render();
  if (state.route === 'home') {
    scheduleHomeLoad();
  } else if (routeChanged) {
    state.home.requestSerial += 1;
    state.home.loading = false;
  }
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
  if (state.route === 'platform') {
    schedulePlatformLoad({ resetPage: routeChanged });
  } else if (routeChanged) {
    state.platform.requestSerial += 1;
    state.platform.loading = false;
  }
  if (state.route === 'ops') {
    scheduleOpsLoad({ resetPage: routeChanged });
  } else if (routeChanged) {
    state.ops.requestSerial += 1;
    state.ops.loading = false;
  }
  if (state.route === 'system') {
    scheduleSystemLoad({ reset: routeChanged });
  } else if (routeChanged) {
    state.system.requestSerial += 1;
    state.system.loading = false;
    state.system.maintenance.requestSerial += 1;
    state.system.maintenance.loading = false;
  }
  if (routeChanged && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

elements.search.addEventListener('input', (event) => {
  state.query = event.currentTarget.value;
  syncUrlFromState();
  render();
  scheduleHomeLoad({ delay: 220 });
  scheduleProcurementLoad({ resetPage: true, delay: 220 });
  scheduleSalesLoad({ resetPages: true, delay: 220 });
  scheduleInventoryLoad({ resetPages: true, delay: 220 });
  scheduleProductLoad({ resetPages: true, delay: 220 });
  scheduleFulfilmentLoad({ resetPage: true, delay: 220 });
  schedulePlatformLoad({ resetPage: true, delay: 220 });
  scheduleOpsLoad({ resetPage: true, delay: 220 });
  scheduleSystemLoad({ reset: true, delay: 220 });
});

elements.scope.addEventListener('change', (event) => {
  const value = String(event.currentTarget.value || 'ALL');
  state.owner = value.startsWith('OWNER:') ? value.slice(6) : 'ALL';
  state.store = value.startsWith('STORE:') ? value.slice(6) : 'ALL';
  syncUrlFromState();
  render();
  scheduleHomeLoad({ delay: 120 });
  scheduleProcurementLoad({ resetPage: true });
  scheduleSalesLoad({ resetPages: true });
  scheduleInventoryLoad({ resetPages: true, delay: 120 });
  scheduleProductLoad({ resetPages: true, delay: 120 });
  scheduleFulfilmentLoad({ resetPage: true, delay: 120 });
  schedulePlatformLoad({ resetPage: true, delay: 120 });
  scheduleOpsLoad({ resetPage: true, delay: 120 });
  scheduleSystemLoad({ reset: true, delay: 120 });
});

elements.rangeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const presetKey = button.dataset.homeRangePreset;
    const preset = HOME_RANGE_PRESETS[presetKey];
    if (!preset) return;
    state.homeRangePreset = presetKey;
    state.range = preset.window;
    state.homeDateCustom = false;
    state.homeDateStart = null;
    state.homeDateEnd = null;
    state.homeCalendarAnchor = homePresetDateRange(presetKey).start.slice(0, 7) + '-01';
    syncUrlFromState();
    render();
    scheduleHomeLoad();
    scheduleSalesLoad({ resetPages: true });
    // The product query ranks and filters by the selected range on the server.
    scheduleProductLoad({ resetPages: true });
  });
});

elements.rangeToggle?.addEventListener('click', () => {
  state.homeRangeOpen = !state.homeRangeOpen;
  state.homeCalendarAnchor = `${selectedHomeDateRange().start.slice(0, 7)}-01`;
  render();
});

elements.rangePopover?.addEventListener('click', (event) => {
  const shift = event.target.closest?.('[data-home-calendar-shift]');
  if (shift) {
    state.homeCalendarAnchor = shiftIsoMonth(
      state.homeCalendarAnchor || `${selectedHomeDateRange().start.slice(0, 7)}-01`,
      Number(shift.dataset.homeCalendarShift),
    );
    renderHomeCalendar();
    return;
  }
  const day = event.target.closest?.('[data-home-calendar-date]');
  if (!day) return;
  const date = String(day.dataset.homeCalendarDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  if (!state.homeCalendarPickingEnd) {
    state.homeDateStart = date;
    state.homeDateEnd = date;
    state.homeCalendarPickingEnd = true;
  } else {
    const firstDate = state.homeDateStart;
    state.homeDateStart = date < firstDate ? date : firstDate;
    state.homeDateEnd = date < firstDate ? firstDate : date;
    state.homeCalendarPickingEnd = false;
  }
  state.homeDateCustom = true;
  state.homeRangePreset = 'custom';
  render();
  scheduleHomeLoad({ delay: 120 });
  scheduleSalesLoad({ resetPages: true, delay: 120 });
});

for (const element of [elements.homeDateStart, elements.homeDateEnd]) {
  element?.addEventListener('change', () => {
    const start = String(elements.homeDateStart?.value || '');
    const end = String(elements.homeDateEnd?.value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return;
    state.homeDateStart = start <= end ? start : end;
    state.homeDateEnd = start <= end ? end : start;
    state.homeDateCustom = true;
    state.homeRangePreset = 'custom';
    state.homeCalendarAnchor = `${state.homeDateStart.slice(0, 7)}-01`;
    render();
    scheduleHomeLoad();
    scheduleSalesLoad({ resetPages: true });
  });
}

elements.view.addEventListener('click', (event) => {
  const latestHomeDate = event.target.closest?.('[data-home-latest-date]');
  if (latestHomeDate && elements.view.contains(latestHomeDate)) {
    const date = String(latestHomeDate.dataset.homeLatestDate || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      state.homeDateStart = date;
      state.homeDateEnd = date;
      state.homeDateCustom = true;
      state.homeRangePreset = 'custom';
      state.homeCalendarAnchor = `${date.slice(0, 7)}-01`;
      syncUrlFromState();
      render();
      scheduleHomeLoad();
    }
    return;
  }
  const homeForceRefresh = event.target.closest?.('[data-home-force-refresh]');
  if (homeForceRefresh && elements.view.contains(homeForceRefresh)) {
    void loadDashboard({ force: true });
    return;
  }
  const trendMetric = event.target.closest?.('[data-home-trend-metric]');
  if (trendMetric && elements.view.contains(trendMetric)) {
    const metric = String(trendMetric.dataset.homeTrendMetric || '');
    if (Object.prototype.hasOwnProperty.call(HOME_TREND_METRICS, metric)) {
      state.homeTrendMetric = metric;
      render();
    }
    return;
  }
  const rankingBasis = event.target.closest?.('[data-home-ranking-basis]');
  if (rankingBasis && elements.view.contains(rankingBasis)) {
    const basis = String(rankingBasis.dataset.homeRankingBasis || '').toUpperCase();
    if (['OPERATING', 'FINANCE'].includes(basis)) {
      state.homeRankingBasis = basis;
      render();
    }
    return;
  }
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
  const platformRetry = event.target.closest?.('[data-platform-retry]');
  if (platformRetry && elements.view.contains(platformRetry)) {
    void loadPlatform();
    return;
  }
  const opsRetry = event.target.closest?.('[data-ops-retry]');
  if (opsRetry && elements.view.contains(opsRetry)) {
    void loadOps();
    return;
  }
  const storeLoginRefresh = event.target.closest?.('[data-store-login-refresh]');
  if (storeLoginRefresh && elements.view.contains(storeLoginRefresh)) {
    void loadSystemLoginMaintenance();
    return;
  }
  const storeLoginOpen = event.target.closest?.('[data-store-login-open]');
  if (storeLoginOpen && elements.view.contains(storeLoginOpen)) {
    const openUrl = state.system.maintenance.activeUrl;
    if (/^\/store-login\/session\/[A-Za-z0-9%_-]+#token=[A-Za-z0-9_-]+$/.test(openUrl)) {
      window.open(openUrl, `fm-store-login-${storeLoginOpen.dataset.storeLoginOpen}`);
    }
    return;
  }
  const storeLoginStart = event.target.closest?.('[data-store-login-start]');
  if (storeLoginStart && elements.view.contains(storeLoginStart)) {
    void runSystemStoreLoginAction('start', storeLoginStart.dataset.storeLoginStart);
    return;
  }
  const storeLoginFinish = event.target.closest?.('[data-store-login-finish]');
  if (storeLoginFinish && elements.view.contains(storeLoginFinish)) {
    void runSystemStoreLoginAction('finish', storeLoginFinish.dataset.storeLoginFinish);
    return;
  }
  const storeLoginClose = event.target.closest?.('[data-store-login-close]');
  if (storeLoginClose && elements.view.contains(storeLoginClose)) {
    void runSystemStoreLoginAction('close');
    return;
  }
  const systemRetry = event.target.closest?.('[data-system-retry]');
  if (systemRetry && elements.view.contains(systemRetry)) {
    void loadSystem();
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
  const platformPage = event.target.closest?.('[data-platform-page]');
  if (platformPage && elements.view.contains(platformPage)) {
    const nextPage = Number(platformPage.dataset.platformPage);
    if (Number.isSafeInteger(nextPage) && nextPage >= 1 && !platformPage.disabled) {
      state.platform.page = nextPage;
      syncUrlFromState();
      void loadPlatform();
    }
    return;
  }
  const opsPage = event.target.closest?.('[data-ops-page]');
  if (opsPage && elements.view.contains(opsPage)) {
    const nextPage = Number(opsPage.dataset.opsPage);
    if (Number.isSafeInteger(nextPage) && nextPage >= 1 && !opsPage.disabled) {
      state.ops.page = nextPage;
      syncUrlFromState();
      void loadOps();
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
    if (kind === 'platform') schedulePlatformLoad({ resetPage: true });
    if (kind === 'ops') scheduleOpsLoad({ resetPage: true });
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
    if (kind === 'platform') {
      state.platform.view = 'URGENT';
      state.platform.severity = 'ALL';
      state.platform.family = 'ALL';
      state.platform.status = 'ALL';
      state.platform.sort = 'PRIORITY';
      state.platform.pageSize = URL_DEFAULT_INVENTORY_PAGE_SIZE;
      syncUrlFromState();
      schedulePlatformLoad({ resetPage: true });
    }
    if (kind === 'ops') {
      state.ops.view = 'PRIORITY';
      state.ops.severity = 'ALL';
      state.ops.domain = 'ALL';
      state.ops.sort = 'PRIORITY';
      state.ops.pageSize = URL_DEFAULT_INVENTORY_PAGE_SIZE;
      syncUrlFromState();
      scheduleOpsLoad({ resetPage: true });
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
    scheduleHomeLoad({ delay: 120 });
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
  scheduleHomeLoad();
  if (route === 'procurement') scheduleProcurementLoad({ resetPage: true });
  if (route === 'sales') scheduleSalesLoad({ resetPages: true });
  if (route === 'inventory') scheduleInventoryLoad({ resetPages: true });
  if (route === 'products') scheduleProductLoad({ resetPages: true });
  if (route === 'fulfilment') scheduleFulfilmentLoad({ resetPage: true });
  if (route === 'ops') scheduleOpsLoad({ resetPage: true });
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
    } else if (kind === 'platformView') {
      state.platform.view = allowListedToken(raw, URL_PLATFORM_VIEWS, 'URGENT');
    } else if (kind === 'platformSeverity') {
      state.platform.severity = allowListedToken(
        raw,
        URL_PLATFORM_SEVERITIES,
        'ALL',
      );
    } else if (kind === 'platformFamily') {
      state.platform.family = operationCodeParam(raw);
    } else if (kind === 'platformStatus') {
      state.platform.status = operationCodeParam(raw);
    } else if (kind === 'platformSort') {
      state.platform.sort = allowListedToken(raw, URL_PLATFORM_SORTS, 'PRIORITY');
    } else if (kind === 'platformPageSize') {
      state.platform.pageSize = pageSizeParam(raw);
    } else if (kind === 'opsView') {
      state.ops.view = allowListedToken(raw, URL_OPS_VIEWS, 'PRIORITY');
    } else if (kind === 'opsSeverity') {
      state.ops.severity = allowListedToken(raw, URL_OPS_SEVERITIES, 'ALL');
    } else if (kind === 'opsDomain') {
      state.ops.domain = allowListedToken(raw, URL_OPS_DOMAINS, 'ALL');
    } else if (kind === 'opsSort') {
      state.ops.sort = allowListedToken(raw, URL_OPS_SORTS, 'PRIORITY');
    } else if (kind === 'opsPageSize') {
      state.ops.pageSize = pageSizeParam(raw);
    } else {
      return;
    }
    // Any filter change restarts paging so page 2 of an old filter can never be
    // requested against the new one.
    syncUrlFromState();
    if (kind.startsWith('procurement')) scheduleProcurementLoad({ resetPage: true });
    else if (kind.startsWith('fulfilment')) scheduleFulfilmentLoad({ resetPage: true });
    else if (kind.startsWith('ops')) scheduleOpsLoad({ resetPage: true });
    else schedulePlatformLoad({ resetPage: true });
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
  state.homeRangePreset = 'today';
  state.homeDateStart = null;
  state.homeDateEnd = null;
  state.homeDateCustom = false;
  state.homeRangeOpen = false;
  state.homeCalendarPickingEnd = false;
  state.quickFilters = Object.create(null);
  state.focus = null;
  populateScopeOptions();
  syncUrlFromState();
  render();
  scheduleHomeLoad();
  scheduleProcurementLoad({ resetPage: true });
  scheduleSalesLoad({ resetPages: true });
  scheduleInventoryLoad({ resetPages: true });
  scheduleProductLoad({ resetPages: true });
  scheduleFulfilmentLoad({ resetPage: true });
  schedulePlatformLoad({ resetPage: true });
  scheduleOpsLoad({ resetPage: true });
  scheduleSystemLoad({ reset: true });
  elements.search.focus();
});

elements.forceRefresh?.addEventListener('click', () => {
  void loadDashboard({ force: true });
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
  if (opsLoadTimer !== null) window.clearTimeout(opsLoadTimer);
  if (systemLoadTimer !== null) window.clearTimeout(systemLoadTimer);
  dashboardEventSource?.close();
});

// Normalize whatever arrived in the address bar into the canonical form once, so
// a hand-edited or stale link becomes shareable without a reload.
syncUrlFromState();
render();
loadDashboard();
connectDashboardUpdates();
