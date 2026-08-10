import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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

test('full-managed primary navigation is a flat nine-entry list with no order group', async () => {
  const [html, app, styles] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/app.js'),
    read('src/web/styles.css'),
  ]);
  const routes = [
    'home',
    'products',
    'inventory',
    'procurement',
    'returns',
    'finance',
    'marketing',
    'ops',
    'system',
  ];

  // The primary nav is exactly the nine decision workspaces, in order, with
  // home first. No secondary grouping or category labels remain.
  assert.equal((html.match(/data-route=/g) || []).length, 9);
  assert.deepEqual(
    [...html.matchAll(/data-route="([^"]+)"/g)].map((match) => match[1]),
    routes,
  );
  assert.doesNotMatch(
    html,
    /nav-group|order-nav-toggle|order-nav-panel|nav-subgroup|<small>ORDER<\/small>/,
  );
  for (const route of routes) {
    assert.match(html, new RegExp(`data-route="${route}"`));
    assert.match(app, new RegExp(`\\b['"]?${route}['"]?: \\{ title:`));
  }
  assert.match(html, /data-route="home">\s*<svg class="nav-icon"/);
  for (const [route, label] of [
    ['home', '总控驾驶舱'],
    ['products', '商品经营'],
    ['inventory', '库存与备货'],
    ['procurement', '采购履约'],
    ['returns', '退货与质量'],
    ['finance', '财务与结算'],
    ['marketing', '营销机会'],
    ['ops', '运营待办'],
    ['system', '数据与系统'],
  ]) {
    assert.match(html, new RegExp(`data-route="${route}">[\\s\\S]*?<span>${label}<\\/span>`));
  }
  // The old order-management pages are compatibility deep links only: they
  // never appear in the shell, and the sidebar health card is gone.
  assert.doesNotMatch(
    html,
    /data-route="(?:fulfilment|delivery-notes|stock-records|waybills|return-applications|return-orders|exceptions|value-added-services|quality-reports|sales|compliance|platform)"/,
  );
  assert.doesNotMatch(html, /sidebar-health|side-note|DATA HEALTH|dataset-badge|data-health/);
  // Old hash routes map onto the new workspaces through the alias table.
  assert.match(app, /const NAV_ROUTE_ALIASES = Object\.freeze\(\{/);
  for (const [oldRoute, target] of [
    ['sales', 'products'],
    ['fulfilment', 'procurement'],
    ["'delivery-notes'", 'procurement'],
    ["'stock-records'", 'inventory'],
    ['waybills', 'procurement'],
    ["'value-added-services'", 'procurement'],
    ["'return-applications'", 'returns'],
    ["'return-orders'", 'returns'],
    ['exceptions', 'returns'],
    ["'quality-reports'", 'returns'],
    ['compliance', 'products'],
    ['platform', 'system'],
  ]) {
    assert.match(app, new RegExp(`${oldRoute}: '${target}'`));
  }
  assert.match(app, /function navigationRouteFor\(route\)/);
  assert.match(app, /return NAV_ROUTE_ALIASES\[route\] \|\| route;/);
  // The active nav item resolves through the alias map; no group wiring left.
  const navigation = functionBody(app, 'updateNavigation');
  assert.match(navigation, /const activeRoute = navigationRouteFor\(state\.route\);/);
  assert.match(navigation, /link\.dataset\.route === activeRoute/);
  assert.match(navigation, /document\.body\.dataset\.route = state\.route/);
  assert.match(navigation, /document\.body\.dataset\.navRoute = activeRoute/);
  assert.doesNotMatch(app, /orderGroupToggle|toggleOrderNavPanel|closeOrderNavPanel/);
  assert.match(html, /缺失值不补零；建议不等于已执行/);
  assert.match(styles, /\.table-wrap\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.primary-nav a\s*\{/);
  assert.match(styles, /\.primary-nav a\.active\s*\{/);
  assert.match(styles, /@media \(max-width: 620px\)/);
});

test('home shell keeps the historical filter, KPI tables, vertical trends and four rankings', async () => {
  const [html, app, parityStyles] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/app.js'),
    read('src/web/home-parity.css'),
  ]);

  assert.match(html, /id="scope-filter"/);
  assert.match(html, /id="home-date-start"/);
  assert.match(html, /id="home-date-end"/);
  assert.match(html, /data-home-range-preset="last3Months"/);
  assert.match(html, /data-home-range-preset="last6Months"/);
  assert.match(html, /data-home-range-preset="lastYear"/);
  assert.match(html, /aria-label="店铺或负责人范围"/);
  assert.doesNotMatch(html, /id="owner-filter"|id="store-filter"/);
  assert.match(app, /today: \{ label: '今日'/);
  assert.match(app, /yesterday: \{ label: '昨日'/);
  assert.match(app, /last7Days: \{ label: '近 7 日'/);
  assert.match(app, /last30Days: \{ label: '近 30 日'/);
  assert.match(app, /关键经营数据/);
  assert.match(app, /日趋势/);
  assert.match(app, /月趋势/);
  assert.match(app, /店铺净成交金额排行/);
  assert.match(app, /店铺销量排行/);
  assert.match(app, /标准货号销售金额 Top 20（估算）/);
  assert.match(app, /标准货号销量 Top 20/);
  assert.doesNotMatch(app, /function renderHistoryHomeHeader\(\)/);
  assert.match(app, /function renderHistoryKpis\(\)/);
  assert.match(app, /function renderHistoryTrends\(\)/);
  assert.match(app, /function renderHistoryRankings\(\)/);
  assert.match(app, /OWNER:\$\{owner\.key\}/);
  assert.match(app, /STORE:\$\{store\.code\}/);
  assert.match(app, /店内商品排行（标准商品待归并）/);
  assert.match(app, /合法为 0/);
  assert.match(app, /数据已过期/);
  assert.match(app, /数据未接入/);
  assert.doesNotMatch(app, /全托经营总览/);
  assert.match(app, /class="metric-matrix cols-4 home-history-matrix"/);
  assert.match(app, /function renderTodayCoreCards\(\)/);
  assert.match(app, /class="trend-stack home-trend-stack"/);
  assert.match(app, /data-home-trend-metric=/);
  assert.match(app, /class="rank-list"/);
  assert.match(app, /rank-item rank-fill-\$\{fillStep\} rank-tone-/);
  assert.match(app, /class="help"/);
  assert.match(app, /data-tip=/);
  assert.doesNotMatch(functionBody(app, 'renderHome'), /home-footnote/);
  assert.match(parityStyles, /\.metric-matrix\s*\{/);
  assert.match(parityStyles, /\.metric-matrix \.matrix-cell\s*\{/);
  assert.match(parityStyles, /\.trend-stack\s*\{/);
  assert.match(parityStyles, /\.rank-item::before\s*\{/);
  assert.match(parityStyles, /\.sidebar\s*\{[\s\S]*background: var\(--side\)/);
  assert.match(parityStyles, /\.home-footnote\s*\{/);

  // The retired home noise leaves renderHome and is no longer mounted on another route.
  const homeStart = app.indexOf('function renderHome()');
  const homeEnd = app.indexOf('\nfunction ', homeStart + 1);
  const home = app.slice(homeStart, homeEnd);
  assert.doesNotMatch(home, /homeBusinessPulse|supplyRadar|renderOperationalPriorities/);
  assert.match(app, /function homeBusinessPulse\(/);
  assert.match(app, /function supplyRadar\(/);
  assert.doesNotMatch(app, /\$\{renderOperationalPriorities\(\)\}/);
});

test('full-managed homepage exposes the confirmed metrics without inventing unsupported profit fields', async () => {
  const app = await read('src/web/app.js');
  const homeStart = app.indexOf('function historyMetricRows()');
  const homeEnd = app.indexOf('function renderHome()', homeStart);
  const homeFunctions = app.slice(homeStart, homeEnd);

  assert.doesNotMatch(homeFunctions, /\bGMV\b/i);
  assert.doesNotMatch(homeFunctions, /\bCOD\b/i);
  assert.doesNotMatch(homeFunctions, /利润|消费者退货/);
  for (const metric of [
    '净成交金额',
    '成交金额',
    '财务明细净额',
    '期末预计待结算',
    '已结算销售款',
    '实际结算金额',
    '支付人数',
    '销量',
    '曝光量',
    '商详访客',
    '备货订单数',
    '集采订单数',
    '期初库存',
    '期末库存',
    '新客销量',
    '新客支付订单数',
  ]) {
    assert.match(homeFunctions, new RegExp(metric));
  }
  assert.match(homeFunctions, /不使用财务明细或商家账单覆盖/);
  assert.match(homeFunctions, /不使用台账客单出库量替换/);
  assert.match(homeFunctions, /销量 Top 主销地区/);
});

test('product identity page keeps unmapped store-local SKUs visible without cross-store aggregation', async () => {
  const app = await read('src/web/app.js');

  // The queue is server-paged now; the old client-side 50-row slice is gone.
  assert.match(app, /function productPendingTable\(rows\)/);
  assert.match(app, /function unmappedStoreSkuRows\(\)/);
  assert.match(app, /mappingStatus \|\| ''\).*CONFIRMED/s);
  assert.match(app, /待归并队列/);
  assert.match(app, /不参与跨店标准商品合计/);
  assert.match(app, /缺少平台 SPU，无法自动归并/);
  assert.match(app, /mappingStatusLabel\(item\.mappingStatus\)/);
  assert.match(app, /平台 SPU\/SKC\/SKU 仅在本店为强标识，禁止跨店按裸 SKU 合并/);
  assert.match(app, /只有 GLOBAL \+ CONFIRMED 归并可跨店聚合/);
  assert.match(app, /function rankingProducts\(\)[\s\S]*rows: products/);

  const products = functionBody(app, 'renderProducts');
  assert.doesNotMatch(products, /slice\(0, 50\)|slice\(0,50\)/);
  assert.match(products, /state\.products\.data/);
});

test('web assets stay self-hosted and off the banned typefaces', async () => {
  const [html, styles, parityStyles] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/styles.css'),
    read('src/web/home-parity.css'),
  ]);

  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<script[^>]+src="(?!\/app\.js)/);
  const assetVersions = [];
  for (const asset of ['favicon.svg', 'styles.css', 'home-parity.css', 'app.js']) {
    const match = html.match(new RegExp(`/${asset.replace('.', '\\.')}\\?v=(\\d{8}\\.\\d+)`));
    assert.ok(match, `${asset} must use a dated local cache key`);
    assetVersions.push(match[1]);
  }
  assert.equal(new Set(assetVersions).size, 1, 'all local assets must share one cache key');
  assert.doesNotMatch(html, /v=20260728\.[123]/);
  for (const sheet of [styles, parityStyles]) {
    assert.doesNotMatch(sheet, /font-family:[^;]*(?:Inter|Roboto|Open Sans)/i);
    assert.match(sheet, /font:[^;]*"PingFang SC"|font-family:[^;]*"PingFang SC"/);
  }
  assert.match(styles, /--bg: #fafaf8/);
  assert.match(styles, /--paper: #ffffff/);
  assert.match(styles, /--ink: #1a1916/);
  assert.match(styles, /--line: #e8e6e1/);
  assert.match(styles, /--accent: #2d6a4f/);
  assert.match(parityStyles, /\.metric-matrix\s*\{[^}]*display: grid/s);
});

test('procurement is a combined read-only query over independent endpoints with authenticated snapshot updates', async () => {
  const [app, styles] = await Promise.all([
    read('src/web/app.js'),
    read('src/web/styles.css'),
  ]);
  assert.match(app, /\/api\/procurement\?/);
  assert.match(app, /function loadProcurement\(/);
  // The unified workspace also reads the fulfilment endpoint, bounded to a
  // fixed 100-row slice while its server facets still carry scoped counts.
  assert.match(app, /function procurementFulfilmentQueryUrl\(\)/);
  const fulfilmentUrl = functionBody(app, 'procurementFulfilmentQueryUrl');
  assert.match(fulfilmentUrl, /`\/api\/fulfilment\?\$\{params\.toString\(\)\}`/);
  for (const parameter of [
    'owner', 'store', 'q', 'orderType', 'status', 'quick', 'timeField',
    'warehouse', 'defective', 'sort', 'page', 'pageSize',
  ]) {
    assert.match(fulfilmentUrl, new RegExp(`${parameter}:`), parameter);
  }
  assert.match(fulfilmentUrl, /pageSize: '100'/);
  assert.match(fulfilmentUrl, /timeField: 'UPDATED'/);
  // The procurement query keeps its server-side filters, sorting and paging.
  const load = functionBody(app, 'loadProcurement');
  assert.match(load, /Promise\.allSettled\(\[/);
  assert.match(load, /fetchJson\(procurementQueryUrl\(\)\)/);
  assert.match(load, /fetchJson\(procurementFulfilmentQueryUrl\(\)\)/);
  assert.match(load, /采购单查询结构无效/);
  assert.match(load, /fulfilmentError/);
  assert.match(app, /data-procurement-page/);
  // Truncation stays explicit and the page never pretends to be realtime.
  assert.match(app, /源明细已截断/);
  assert.match(app, /源结果已截断，非仓库全量/);
  assert.match(app, /发货辅助明细最多回读 100 条/);
  assert.doesNotMatch(app, /实时采购|采购实时/);
  // Snapshot updates arrive over the authenticated SSE stream.
  assert.match(app, /new EventSource\('\/api\/events'\)/);
  assert.match(app, /dashboard-updated/);
  assert.match(app, /快照自动更新/);
  assert.match(styles, /\.table-pagination\s*\{/);
});

test('sales uses a server query and the operating pulse helper stays available off home', async () => {
  const [app, styles] = await Promise.all([
    read('src/web/app.js'),
    read('src/web/styles.css'),
  ]);
  assert.match(app, /\/api\/sales\?/);
  assert.match(app, /function loadSales\(/);
  assert.match(app, /function scheduleSalesLoad\(/);
  assert.match(app, /matchedMaterializedProductCount/);
  assert.match(app, /data-sales-page-kind/);
  assert.match(app, /data-sales-sort/);
  assert.match(app, /源结果已截断/);
  assert.match(app, /function homeBusinessPulse\(/);
  assert.match(app, /OPERATING PULSE/);
  assert.match(app, /今日经营简报/);
  assert.match(app, /近 7 日日均/);
  assert.match(styles, /\.business-pulse-grid\s*\{/);
  assert.match(styles, /\.sales-sort-control\s*\{/);
});
