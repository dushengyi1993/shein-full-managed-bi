import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ORDER_MANAGEMENT_PAGE_IDS,
  allowlistedFieldNames,
} from '../../src/order-management/order-management-contract.mjs';

const projectRoot = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, projectRoot), 'utf8');
}

/** Slice one top-level function declaration out of the browser bundle. */
function functionBody(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, nextFunction === -1 ? source.length : nextFunction);
}

const ORDER_PAGES = [
  'delivery-notes',
  'stock-records',
  'waybills',
  'return-applications',
  'return-orders',
  'exceptions',
  'value-added-services',
  'quality-reports',
];

function defaultOrderPages() {
  return Object.fromEntries(ORDER_PAGES.map((pageId) => [
    pageId,
    { sort: 'LATEST', status: 'ALL', page: 1, pageSize: 50 },
  ]));
}

/**
 * The canonical hash-state block is self-contained and DOM-free, so it can be
 * extracted and exercised behaviourally rather than only asserted as text.
 */
async function loadHashStateContract() {
  const source = await read('src/web/app.js');
  const start = source.indexOf('/* --- canonical-hash-state:start ---');
  const end = source.indexOf('/* --- canonical-hash-state:end --- */');
  assert.notEqual(start, -1, 'canonical hash-state block start marker must exist');
  assert.notEqual(end, -1, 'canonical hash-state block end marker must exist');
  const block = source.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`
    ${block}
    return { parseHashState, serializeHashState };
  `)();
}

test('the eight order-management pages stay registered compatibility deep links', async () => {
  const [html, app] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/app.js'),
  ]);

  for (const page of ORDER_PAGES) {
    // The pages are no longer primary-navigation entries.
    assert.doesNotMatch(html, new RegExp(`data-route="${page}"`), page);
    // ... but they remain registered routes with researched copy.
    assert.match(app, new RegExp(`\\b['"]?${page}['"]?: \\{ title:`), page);
    assert.match(app, new RegExp(`['"]?${page}['"]?: \\{\\s*title:`), page);
  }
  assert.match(app, /const URL_ORDER_PAGE_IDS = Object\.freeze\(\[/);
  for (const page of ORDER_PAGES) {
    assert.match(app, new RegExp(`'${page}'`), page);
  }
  // Every page dispatches to the shared order workspace renderer.
  const renderRoute = functionBody(app, 'renderRoute');
  for (const page of ORDER_PAGES) {
    assert.match(
      renderRoute,
      new RegExp(`['"]?${page}['"]?: renderOrderWorkspace,`),
      page,
    );
  }

  // Research-based per-page title, description, filter hint and read-only
  // boundary all exist and are rendered. Secondary category metadata is gone.
  for (const page of ORDER_PAGES) {
    assert.match(
      app,
      new RegExp(`['"]?${page}['"]?: \\{\\s*title: '[^']+',\\s*description:`),
      `${page} must carry title and description`,
    );
    assert.match(app, /filterHint:/);
    assert.match(app, /readOnly:/);
  }
  const orderMetaStart = app.indexOf('const ORDER_PAGE_META = Object.freeze({');
  const orderMetaEnd = app.indexOf('\n});', orderMetaStart);
  const orderMeta = app.slice(orderMetaStart, orderMetaEnd);
  assert.doesNotMatch(orderMeta, /group:|code:|'发货履约'|'退货异常'|'服务质检'/);
  const render = functionBody(app, 'renderOrderWorkspace');
  assert.match(render, /ORDER_PAGE_META\[pageId\]/);
  assert.match(render, /meta\.filterHint/);
  assert.match(render, /meta\.readOnly/);
  assert.match(render, /本页只读：/);
});

test('every order page reads only /api/orders with server-side filters', async () => {
  const app = await read('src/web/app.js');
  const url = functionBody(app, 'orderQueryUrl');

  assert.match(url, /`\/api\/orders\?\$\{params\.toString\(\)\}`/);
  for (const parameter of [
    'page', 'store', 'status', 'q', 'sort', 'pageNumber', 'pageSize',
  ]) {
    assert.match(url, new RegExp(`${parameter}:`), parameter);
  }
  assert.match(url, /page: pageId/);
  assert.match(url, /status: pageState\.status/);
  assert.match(url, /sort: pageState\.sort/);
  assert.match(url, /pageNumber: String\(pageState\.page\)/);
  assert.match(url, /pageSizeParam\(pageState\.pageSize\)/);
  // The server contract has no owner parameter, so the query never sends one.
  assert.doesNotMatch(url, /owner:/);
  // Filtering, sorting and pagination are decided by the server; the browser
  // never filters the full dashboard snapshot on these pages.
  const render = functionBody(app, 'renderOrderWorkspace');
  assert.doesNotMatch(render, /\.filter\(/);
  assert.doesNotMatch(render, /\.sort\(/);
  assert.doesNotMatch(render, /slice\(0, ?100\)/);
  assert.doesNotMatch(render, /scopedOperationRows\(/);
});

test('order page state is allow-listed and round-trips through the canonical hash', async () => {
  const { parseHashState, serializeHashState } = await loadHashStateContract();

  const canonical = serializeHashState({
    route: 'delivery-notes',
    store: 'DL5477',
    owner: 'ALL',
    query: '单号',
    orderPages: {
      ...defaultOrderPages(),
      'delivery-notes': {
        sort: 'STORE',
        status: 'WAIT_SHIP',
        page: 2,
        pageSize: 50,
      },
    },
  });
  assert.match(canonical, /^#delivery-notes\?/);
  assert.match(canonical, /scope=STORE%3ADL5477/);
  assert.match(canonical, /q=/);
  assert.match(canonical, /sort=STORE/);
  assert.match(canonical, /status=WAIT_SHIP/);
  assert.match(canonical, /page=2/);

  const parsed = parseHashState(canonical);
  assert.equal(parsed.route, 'delivery-notes');
  assert.equal(parsed.store, 'DL5477');
  assert.equal(parsed.orderPages['delivery-notes'].sort, 'STORE');
  assert.equal(parsed.orderPages['delivery-notes'].status, 'WAIT_SHIP');
  assert.equal(parsed.orderPages['delivery-notes'].page, 2);
  assert.equal(parsed.orderPages['delivery-notes'].pageSize, 50);
  assert.equal(serializeHashState(parsed), canonical);

  // Defaults stay omitted, so a plain order link is short.
  assert.equal(serializeHashState({
    route: 'waybills',
    orderPages: defaultOrderPages(),
  }), '#waybills');

  // Hostile tokens degrade to defaults instead of reaching the endpoint.
  const hostile = parseHashState('#delivery-notes?sort=%3Cscript%3E&status=bad%20code&size=30&page=0');
  assert.equal(hostile.orderPages['delivery-notes'].sort, 'LATEST');
  assert.equal(hostile.orderPages['delivery-notes'].status, 'ALL');
  assert.equal(hostile.orderPages['delivery-notes'].pageSize, 50);
  assert.equal(hostile.orderPages['delivery-notes'].page, 1);
});

test('order page sizes and filters bind only to the active order page', async () => {
  const { parseHashState } = await loadHashStateContract();
  const inherited = {
    orderPages: {
      ...defaultOrderPages(),
      'delivery-notes': {
        sort: 'STATUS',
        status: 'WAIT_SHIP',
        page: 3,
        pageSize: 25,
      },
      waybills: {
        sort: 'STORE',
        status: 'ALL',
        page: 2,
        pageSize: 100,
      },
    },
  };

  // `size` on one order page must not contaminate the sibling pages.
  const deliveryNotes = parseHashState('#delivery-notes?size=100&sort=STORE', inherited);
  assert.equal(deliveryNotes.orderPages['delivery-notes'].pageSize, 100);
  assert.equal(deliveryNotes.orderPages['delivery-notes'].sort, 'STORE');
  assert.equal(deliveryNotes.orderPages.waybills.pageSize, 100, 'waybills size must be inherited');
  assert.equal(deliveryNotes.orderPages.waybills.sort, 'STORE');

  // A bare navigation restarts paging but keeps every page's own filters.
  const bareWaybills = parseHashState('#waybills', inherited);
  assert.equal(bareWaybills.route, 'waybills');
  assert.equal(bareWaybills.orderPages.waybills.page, 1);
  assert.equal(bareWaybills.orderPages.waybills.sort, 'STORE');
  assert.equal(bareWaybills.orderPages.waybills.pageSize, 100);
  assert.equal(bareWaybills.orderPages['delivery-notes'].page, 1);
  assert.equal(bareWaybills.orderPages['delivery-notes'].sort, 'STATUS');
  assert.equal(bareWaybills.orderPages['delivery-notes'].status, 'WAIT_SHIP');
  assert.equal(bareWaybills.orderPages['delivery-notes'].pageSize, 25);
  assert.equal(bareWaybills.canonicalLink, false);

  // A non-order route never touches order page state.
  const procurement = parseHashState('#procurement?size=50', inherited);
  assert.equal(procurement.orderPages['delivery-notes'].pageSize, 25);
  assert.equal(procurement.orderPages.waybills.pageSize, 100);
});

test('order pages guard stale responses and validate the shared contract', async () => {
  const app = await read('src/web/app.js');
  const load = functionBody(app, 'loadOrder');
  const schedule = functionBody(app, 'scheduleOrderLoad');
  const normalize = functionBody(app, 'normalizeOrderPageResult');

  assert.match(load, /const requestSerial = state\.orderWorkspace\.requestSerial \+ 1/);
  assert.ok(
    (load.match(/if \(requestSerial !== state\.orderWorkspace\.requestSerial\) return;/g) || []).length >= 2,
  );
  assert.match(load, /if \(requestSerial === state\.orderWorkspace\.requestSerial\)/);
  assert.match(load, /state\.orderWorkspace\.loading = true/);
  assert.match(load, /订单管理查询暂不可用/);
  assert.match(load, /fetchOrderJson\(orderQueryUrl\(pageId\)\)/);
  assert.match(load, /normalizeOrderPageResult\(result, pageId\)/);
  // The server fails closed for UNAVAILABLE pages; the frontend maps that
  // specific error code to the page state instead of a generic outage.
  assert.match(load, /error\?\.code === 'ORDER_MANAGEMENT_PAGE_UNAVAILABLE'/);
  assert.match(load, /status: 'UNAVAILABLE'/);
  assert.match(load, /reason: error instanceof Error \? error\.message : '页面数据暂不可用'/);
  assert.match(functionBody(app, 'fetchOrderJson'), /payload\?\.error\?\.code/);
  assert.match(functionBody(app, 'fetchOrderJson'), /error\.code = code/);

  // The debounce invalidates in-flight work immediately, not when it fires.
  assert.match(schedule, /window\.clearTimeout\(orderLoadTimer\)/);
  assert.match(schedule, /state\.orderWorkspace\.requestSerial \+= 1/);
  assert.match(schedule, /window\.setTimeout\(/);
  assert.match(schedule, /resetPage && URL_ORDER_PAGE_IDS\.includes\(pageId\)/);

  // The shared index contract is validated, so a malformed payload is an
  // error, not a silently empty table.
  assert.match(normalize, /result\.readOnly !== true/);
  assert.match(normalize, /订单管理查询结构无效/);
  assert.match(normalize, /result\.page && result\.pageId === pageId/);
  assert.match(normalize, /ORDER_STATUSES\.includes\(status\)/);
  assert.match(normalize, /订单页面状态缺失或未知/);
  assert.match(normalize, /订单明细结构无效/);
  assert.match(normalize, /status !== 'UNAVAILABLE'/);
  assert.match(normalize, /订单分页信息缺失/);
  assert.match(normalize, /sourcePagination\.page/);
  assert.match(normalize, /sourcePagination\.matchedRows/);
  assert.match(normalize, /latestSourceFetchedAt/);
  assert.match(normalize, /coverage/);
  assert.match(normalize, /reason/);

  // Leaving the route drops any in-flight response.
  assert.match(
    app,
    /state\.orderWorkspace\.requestSerial \+= 1;\s*\n\s*state\.orderWorkspace\.loading = false/,
  );
  // An atomic snapshot promotion refreshes the active order page via the SSE
  // path, and the global search/scope inputs reload it from page 1.
  assert.match(
    functionBody(app, 'loadDashboard'),
    /URL_ORDER_PAGE_IDS\.includes\(state\.route\)[\s\S]*scheduleOrderLoad\(\)/,
  );
  assert.match(app, /scheduleOrderLoad\(\{ resetPage: true, delay: 220 \}\)/);
  assert.match(app, /scheduleOrderLoad\(\{ resetPage: true, delay: 120 \}\)/);
});

test('order workspace distinguishes AVAILABLE, PARTIAL, UNAVAILABLE, empty and failure', async () => {
  const app = await read('src/web/app.js');
  const render = functionBody(app, 'renderOrderWorkspace');
  const label = functionBody(app, 'orderStatusLabel');
  const empty = functionBody(app, 'orderEmptyState');
  const unavailable = functionBody(app, 'orderUnavailablePanel');
  const queryState = functionBody(app, 'orderWorkspaceQueryState');

  // The hero follows 发货订单; PARTIAL renders one operational line, full
  // pages render none, and UNAVAILABLE keeps its fail-closed panel.
  assert.match(render, /status === 'PARTIAL' \? orderPartialNote\(queryData\)/);
  assert.match(render, /status === 'UNAVAILABLE' \? orderUnavailablePanel\(\)/);
  assert.match(render, /rows\.length \? orderRowTable\(rows\) : orderEmptyState\(\)/);
  assert.match(label, /'数据可用'/);
  assert.match(label, /'部分覆盖'/);
  assert.match(label, /'数据不可用'/);
  assert.match(render, /orderStatusControl\(queryData, pageState\)/);
  assert.match(render, /负责人筛选（/);
  assert.match(render, /负责人范围不作用于本页/);

  // No technical diagnostics reach the business UI: no gate codes, no raw
  // reason strings, no store lists and no global coverage banner.
  assert.doesNotMatch(
    render,
    /PAGE_GATE_FAILED|SESSION_GATE_FAILED|STORE_COVERAGE_INCOMPLETE|DATABASE_STORE_COVERAGE_INCOMPLETE/,
  );
  assert.doesNotMatch(render, /queryData\.reason/);
  assert.doesNotMatch(render, /order-status-banner/);
  assert.doesNotMatch(render, /orderCoverageLine\(queryData\.coverage\)/);

  // PARTIAL shows exactly one operational line plus a small, low-interference
  // entry; the explanation stays operational and never names gate codes.
  const partial = functionBody(app, 'orderPartialNote');
  assert.match(partial, /orderCoverageLine\(queryData\)/);
  assert.match(functionBody(app, 'orderCoverageLine'), /当前展示 /);
  assert.match(partial, /查看说明/);
  assert.match(partial, /不会补零/);
  assert.match(partial, /后台审计与日志/);
  assert.doesNotMatch(partial, /PAGE_GATE_FAILED|SESSION_GATE_FAILED/);

  // A real empty result is neither an error nor "数据不可用".
  assert.match(empty, /当前条件下没有可展示的记录/);
  assert.match(empty, /这不等同于加载失败，也不会被补成 0/);
  assert.match(empty, /order-empty-state/);

  // UNAVAILABLE fails closed with its own panel and copy.
  assert.match(unavailable, /数据未更新，本页面暂缓展示/);
  assert.match(unavailable, /不会沿用旧候选、旧快照或补零数字冒充结果/);
  assert.match(unavailable, /data-order-retry="1"/);
  assert.doesNotMatch(unavailable, /PAGE_GATE_FAILED|SESSION_GATE_FAILED/);

  // A load failure is a separate state with retry and honest copy.
  assert.match(queryState, /role="\$\{error \? 'alert' : 'status'\}"/);
  assert.match(queryState, /data-order-retry="1"/);
  assert.match(queryState, /订单管理页面加载失败/);
  assert.match(queryState, /不会用旧数据冒充新结果/);
  assert.match(queryState, /query-skeleton/);
  assert.match(queryState, /order-query-error/);

  // Coverage comes from the page-specific server gate, including successful
  // zero-row stores; it is never inferred from row facets or a global gate.
  const pageCoverage = functionBody(app, 'orderPageCoverage');
  assert.match(pageCoverage, /coverage\.completedStoreCount/);
  assert.match(pageCoverage, /expectedStoreCount/);
  assert.doesNotMatch(pageCoverage, /facets\.stores|coverage\.storeCodes/);
  const coverage = functionBody(app, 'orderCoverageLine');
  assert.match(coverage, /当前展示 /);
  assert.match(coverage, /家暂无数据/);
  assert.match(coverage, /numberFormatter\.format\(expected\)/);
  assert.match(coverage, /部分店铺数据未完成/);
});

test('order page coverage is per-page and never the global 25/25 intersection', async () => {
  const source = await read('src/web/app.js');
  const numberFormatterStart = source.indexOf('const numberFormatter = ');
  const numberFormatterEnd = source.indexOf(';', numberFormatterStart) + 1;
  const productRecordStart = source.indexOf('function productRecord(');
  const productRecordEnd = source.indexOf('\nfunction ', productRecordStart);
  const pageCoverage = functionBody(source, 'orderPageCoverage');
  const coverageLine = functionBody(source, 'orderCoverageLine');
  // eslint-disable-next-line no-new-func
  const { orderPageCoverage, orderCoverageLine } = new Function(`
    ${source.slice(numberFormatterStart, numberFormatterEnd)}
    ${source.slice(productRecordStart, productRecordEnd === -1 ? source.length : productRecordEnd)}
    ${pageCoverage}
    ${coverageLine}
    return { orderPageCoverage, orderCoverageLine };
  `)();

  // A PARTIAL page reports its own gate evidence, including successful stores
  // that returned zero rows.
  const partialQuery = {
    facets: { stores: Array.from({ length: 4 }, (_, index) => ({ code: `S${index}` })) },
    coverage: { expectedStoreCount: 25, completedStoreCount: 16 },
  };
  assert.deepEqual(orderPageCoverage(partialQuery), { completed: 16, expected: 25 });
  assert.equal(orderCoverageLine(partialQuery), '当前展示 16/25 家，9 家暂无数据');

  // A full page reports 25/25 with zero missing.
  assert.equal(
    orderCoverageLine({
      facets: { stores: Array.from({ length: 8 }, (_, index) => ({ code: `S${index}` })) },
      coverage: { expectedStoreCount: 25, completedStoreCount: 25 },
    }),
    '当前展示 25/25 家，0 家暂无数据',
  );

  // An unknown expected count fails closed instead of inventing numbers.
  assert.equal(
    orderCoverageLine({ facets: { stores: [] }, coverage: { expectedStoreCount: null, completedStoreCount: null } }),
    '部分店铺数据未完成，覆盖按本页实际数据计算。',
  );
});

test('order details render allow-listed sanitized fields and never write to the platform', async () => {
  const app = await read('src/web/app.js');
  const render = functionBody(app, 'renderOrderWorkspace');
  const row = functionBody(app, 'orderRow');
  const rowDetails = functionBody(app, 'orderRowDetails');
  const fieldList = functionBody(app, 'orderFieldList');
  const sensitive = functionBody(app, 'orderSensitiveKey');

  // Address/contact/phone-looking keys are defensively dropped client-side.
  assert.match(
    app,
    /const ORDER_SENSITIVE_KEY_PATTERN = \/\^?\((?:address|addr|contact|phone|mobile|tel|recipient|收件|电话|手机|地址|联系人|门牌|街道|区号)[^)]*\)\/i/,
  );
  assert.match(fieldList, /orderSensitiveKey\(key\)\) continue/);
  // Every entry renders under its centralized Chinese business label with any
  // required unit; the raw English internal field name is never shown.
  assert.match(fieldList, /orderFieldLabel\(entry\.name\)/);
  assert.match(fieldList, /orderFieldLabel\(String\(key\)\)/);
  assert.match(fieldList, /orderFieldValue\(entry\.name, entry\.value\)/);
  assert.doesNotMatch(fieldList, /escapeHtml\(entry\.name\)/);
  assert.doesNotMatch(fieldList, /escapeHtml\(String\(key\)\)/);
  assert.match(fieldList, /escapeHtml\(text\)/);
  assert.match(row, /查看脱敏明细/);
  assert.match(rowDetails, /orderFieldList\(record\.metrics, '数量概览', '数值'\)/);
  assert.match(rowDetails, /orderFieldList\(record\.facts, '履约信息', '信息'\)/);
  assert.match(rowDetails, /orderFieldList\(record\.details, '商品明细', '信息'\)/);
  assert.match(row, /order-detail-disclosure/);
  assert.match(row, /escapeHtml\(primary/);
  assert.match(row, /escapeHtml\(storeCode/);
  assert.match(render, /明细中的指标、事实与详情均为脱敏后的允许字段/);
  assert.match(render, /地址、联系人与电话不会展示/);

  // Read-only: no form submission and no platform write button anywhere.
  assert.doesNotMatch(render, /<form|type="submit"/);
  assert.doesNotMatch(render, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
  for (const [button] of render.matchAll(/<button[^>]*>/g)) {
    assert.match(
      button,
      /data-order-retry|data-order-page|data-operation-search|data-operation-reset/,
      button,
    );
  }
  assert.match(render, /不提供任何平台写操作按钮/);
  assert.match(render, /筛选、排序与分页由服务端执行/);
});

test('order field labels are centralized and cover the full shared-contract allowlist', async () => {
  const app = await read('src/web/app.js');
  const labelsStart = app.indexOf('const ORDER_FIELD_LABELS = Object.freeze({');
  assert.notEqual(labelsStart, -1, 'ORDER_FIELD_LABELS must exist');
  const labelsEnd = app.indexOf('});', labelsStart);
  const labelsBlock = app.slice(labelsStart, labelsEnd);
  const unitsStart = app.indexOf('const ORDER_FIELD_UNITS = Object.freeze({');
  assert.notEqual(unitsStart, -1, 'ORDER_FIELD_UNITS must exist');
  const unitsEnd = app.indexOf('});', unitsStart);
  const unitsBlock = app.slice(unitsStart, unitsEnd);

  // Every page allowlist of the shared contract has a Chinese business label,
  // so no allow-listed field can ever surface under its English internal name.
  for (const pageId of ORDER_MANAGEMENT_PAGE_IDS) {
    for (const name of allowlistedFieldNames(pageId)) {
      assert.match(
        labelsBlock,
        new RegExp(`\\b${name}: '[^']+'`),
        `${pageId}/${name} must have a Chinese business label`,
      );
    }
  }

  // The required shared-contract business labels are exact.
  const required = {
    packageCount: '包裹数',
    packageWeight: '包裹重量',
    lineCount: '明细行数',
    skuCount: 'SKU 数',
    orderCount: '订单数',
    deliveryQuantity: '发货件数',
    deliveryTypeName: '送货方式',
    expressCompanyName: '承运商',
    warehouseName: '收货仓',
    orderTypeName: '订单类型',
    skuCode: 'SKU',
  };
  for (const [name, label] of Object.entries(required)) {
    assert.match(labelsBlock, new RegExp(`\\b${name}: '${label}'`), name);
  }

  // Weights and business counts carry explicit units; unknown fields degrade
  // to 其他信息 instead of leaking the technical key.
  assert.match(unitsBlock, /packageWeight: 'kg'/);
  assert.match(unitsBlock, /finalSettlementWeight: 'kg'/);
  assert.match(unitsBlock, /deliveryQuantity: '件'/);
  assert.match(unitsBlock, /returnQuantity: '件'/);
  assert.match(unitsBlock, /returnBoxNum: '箱'/);
  assert.match(app, /ORDER_FIELD_UNKNOWN_LABEL = '其他信息'/);
  assert.match(app, /function orderFieldLabel\(name\)/);
  assert.match(app, /return label \|\| ORDER_FIELD_UNKNOWN_LABEL/);
  assert.match(app, /function orderFieldValue\(name, value\)/);
  const sourceLabel = functionBody(app, 'orderSourceLabel');
  assert.match(sourceLabel, /SESSION_HTTP.*平台订单页只读数据/);
  assert.match(sourceLabel, /OPENAPI_FACT_DATABASE.*官方接口事实库/);
  assert.doesNotMatch(sourceLabel, /return value;/);
});

test('order paging and filter controls stay server-driven and URL-synced', async () => {
  const app = await read('src/web/app.js');
  const pagination = functionBody(app, 'orderPagination');

  assert.match(pagination, /data-order-page/);
  assert.match(pagination, /pagination\.hasPrevious \? '' : 'disabled'/);
  assert.match(pagination, /pagination\.hasNext \? '' : 'disabled'/);
  assert.match(pagination, /pagination-top/);
  assert.match(pagination, /orderPaginationCaption\(pagination, \[\]\)/);
  const caption = functionBody(app, 'orderPaginationCaption');
  assert.match(caption, /已物化范围命中/);
  assert.match(caption, /pagination\.matchedRows/);
  assert.match(caption, /条数未知/);
  // The page is mirrored into the URL before fetching.
  assert.match(
    app,
    /state\.orderPages\[pageId\]\.page = nextPage;\s*\n(?:\s*\/\/[^\n]*\n)*\s*syncUrlFromState\(\);\s*\n\s*void loadOrder\(\)/,
  );
  // Sort and page-size selects write allow-listed state and restart paging.
  assert.match(app, /if \(kind === 'orderSort'\)/);
  assert.match(app, /if \(kind === 'orderPageSize'\)/);
  assert.match(app, /if \(kind === 'orderStatus'\)/);
  assert.match(app, /state\.orderPages\[pageId\]\.sort = allowListedToken\(raw, URL_ORDER_SORTS, 'LATEST'\)/);
  assert.match(app, /state\.orderPages\[pageId\]\.pageSize = pageSizeParam\(raw\)/);
  assert.match(app, /state\.orderPages\[pageId\]\.status = operationCodeParam\(raw\)/);
  assert.match(app, /if \(kind\.startsWith\('order'\)\) scheduleOrderLoad\(\{ resetPage: true \}\)/);
  // The free-text status code is pattern-bounded before it reaches the server.
  assert.match(app, /\[data-order-status\]/);
  assert.match(app, /state\.orderPages\[pageId\]\.status = operationCodeParam\(orderStatus\.value\)/);
  assert.match(app, /if \(kind === 'order'\) scheduleOrderLoad\(\{ resetPage: true \}\)/);
  // The primary status filter is a select fed by the server facet vocabulary,
  // with the bounded free-text input kept as the contract-shape fallback.
  const statusControl = functionBody(app, 'orderStatusControl');
  assert.match(statusControl, /facets\.statuses/);
  assert.match(statusControl, /operationSelect\('orderStatus', '状态', options, pageState\.status\)/);
  assert.match(statusControl, /data-order-status/);
  // Reset restores the page defaults.
  assert.match(app, /state\.orderPages\[pageId\]\.status = 'ALL'/);
  assert.match(app, /state\.orderPages\[pageId\]\.sort = 'LATEST'/);
  assert.match(app, /state\.orderPages\[pageId\]\.pageSize = URL_DEFAULT_ORDER_PAGE_SIZE/);
});

test('old order routes stay compatible deep links without any nav group', async () => {
  const [html, styles, app] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/styles.css'),
    read('src/web/app.js'),
  ]);

  // The shell no longer mounts an order-management group: no toggle, no panel
  // and no secondary category labels.
  assert.doesNotMatch(html, /nav-group|order-nav-toggle|order-nav-panel|nav-subgroup/);
  assert.doesNotMatch(
    app,
    /orderGroupToggle|orderGroupPanel|toggleOrderNavPanel|closeOrderNavPanel/,
  );
  // Old order routes resolve to the new workspaces through the alias table.
  assert.match(app, /const NAV_ROUTE_ALIASES = Object\.freeze\(\{/);
  assert.match(app, /function navigationRouteFor\(route\)/);
  const navigation = functionBody(app, 'updateNavigation');
  assert.match(navigation, /const activeRoute = navigationRouteFor\(state\.route\);/);
  assert.match(navigation, /link\.dataset\.route === activeRoute/);
  assert.match(navigation, /document\.body\.dataset\.route = state\.route/);
  assert.match(navigation, /document\.body\.dataset\.navRoute = activeRoute/);
  // Hash navigation still re-parses every change into the canonical state.
  assert.match(
    app,
    /window\.addEventListener\('hashchange', \(\) => \{\s*syncRouteFromLocation\(\);/,
  );
  // The old order deep links keep rendering through the shared workspace.
  const renderRoute = functionBody(app, 'renderRoute');
  assert.match(renderRoute, /fulfilment: renderFulfilment,/);
  for (const page of ORDER_PAGES) {
    assert.match(
      renderRoute,
      new RegExp(`['"]?${page}['"]?: renderOrderWorkspace,`),
      page,
    );
  }

  // PARTIAL, empty and unavailable states are visually distinct, and tables
  // never widen the 390px document.
  assert.match(styles, /\.order-partial-note\s*[,{]/);
  assert.match(styles, /\.order-partial-line\s*[,{]/);
  assert.match(styles, /\.order-empty-state\s*[,{]/);
  assert.match(styles, /\.order-unavailable-panel\s*[,{]/);
  assert.match(styles, /\.order-unavailable-panel\s*\{[^}]*border-color: var\(--danger\)/s);
  assert.match(styles, /\.table-wrap\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.order-table\s*\{[^}]*min-width: 940px/s);
  // The detail grid is compact and single-column on mobile.
  assert.match(
    styles,
    /\.order-field-list li\s*\{[^}]*grid-template-columns: minmax\(0, auto\) minmax\(0, 1fr\)/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 640px\)[\s\S]*?\.order-detail-grid\s*\{\s*grid-template-columns: 1fr;/,
  );
  assert.match(
    styles,
    /@media \(max-width: 640px\)[\s\S]*?\.order-table\s*\{[^}]*min-width: 0;[^}]*table-layout: auto;/,
  );
  assert.match(
    styles,
    /@media \(max-width: 640px\)[\s\S]*?\.order-table \.order-row\s*\{[^}]*display: grid;[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
  );
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*?\.order-filter-toolbar\s*\{\s*display: grid;/,
  );
});
