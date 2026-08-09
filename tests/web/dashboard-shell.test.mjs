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

test('full-managed primary navigation keeps home first and nests shipping orders inside the order-management group', async () => {
  const [html, app, styles] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/app.js'),
    read('src/web/styles.css'),
  ]);
  const routes = [
    'home',
    'fulfilment',
    'delivery-notes',
    'stock-records',
    'waybills',
    'return-applications',
    'return-orders',
    'exceptions',
    'value-added-services',
    'quality-reports',
    'sales',
    'products',
    'inventory',
    'procurement',
    'platform',
    'ops',
    'system',
  ];

  for (const route of routes) {
    assert.match(html, new RegExp(`data-route="${route}"`));
    assert.match(app, new RegExp(`\\b['"]?${route}['"]?: \\{ title:`));
  }
  assert.equal((html.match(/data-route=/g) || []).length, 17);
  assert.deepEqual(
    [...html.matchAll(/data-route="([^"]+)"/g)].map((match) => match[1]),
    routes,
  );
  assert.doesNotMatch(html, /data-route="(?:returns|compliance|finance)"/);
  assert.match(html, /data-route="home"><span>总控驾驶舱<\/span>/);
  // The expandable top-level group carries the confirmed ORDER code.
  assert.match(html, /<button type="button" class="nav-group-toggle" id="order-nav-toggle"/);
  assert.match(html, /aria-expanded="false" aria-controls="order-nav-panel"/);
  assert.match(html, /<span>订单管理<\/span>/);
  assert.match(html, /<small>ORDER<\/small>/);
  // The group panel is one flat nine-item list, with 发货订单 (#fulfilment)
  // first and no secondary category headings.
  const panelStart = html.indexOf('id="order-nav-panel"');
  const panelEnd = html.indexOf('</div>', panelStart + 1);
  const panel = html.slice(panelStart, panelEnd);
  assert.doesNotMatch(panel, /nav-subgroup|<p[^>]*>发货履约<\/p>|<p[^>]*>退货异常<\/p>|<p[^>]*>服务质检<\/p>/);
  assert.deepEqual(
    [...panel.matchAll(/data-route="([^"]+)"/g)].map((match) => match[1]),
    [
      'fulfilment',
      'delivery-notes',
      'stock-records',
      'waybills',
      'return-applications',
      'return-orders',
      'exceptions',
      'value-added-services',
      'quality-reports',
    ],
  );
  assert.match(html, /data-route="sales"><span>销量分析<\/span>/);
  assert.match(html, /data-route="products"><span>商品分析<\/span>/);
  assert.match(html, /data-route="inventory"><span>库存与备货<\/span>/);
  assert.match(html, /data-route="platform"><span>平台动态<\/span>/);
  assert.match(html, /data-route="ops"><span>运营工具<\/span>/);
  assert.match(html, /data-route="system"><span>系统管理<\/span>/);
  assert.match(html, /缺失值不补零；建议不等于已执行/);
  assert.match(styles, /\.table-wrap\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.nav-group-panel\s*\{/);
  assert.match(styles, /\.nav-group-toggle\s*\{/);
  assert.doesNotMatch(styles, /\.nav-subgroup-label\s*\{/);
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

test('procurement uses an independent server query and authenticated snapshot update stream', async () => {
  const [html, app, styles] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/app.js'),
    read('src/web/styles.css'),
  ]);
  assert.match(html, /id="live-update-badge"/);
  assert.match(app, /\/api\/procurement\?/);
  assert.match(app, /function loadProcurement\(/);
  assert.match(app, /matchedMaterializedAttentionCount/);
  // Truncation stays explicit; the workspace now names the source scope too.
  assert.match(app, /源明细已截断/);
  assert.match(app, /源结果已截断，非仓库全量/);
  assert.match(app, /data-procurement-page/);
  assert.match(app, /new EventSource\('\/api\/events'\)/);
  assert.match(app, /dashboard-updated/);
  assert.match(app, /快照自动更新/);
  assert.doesNotMatch(app, /实时采购|采购实时/);
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
