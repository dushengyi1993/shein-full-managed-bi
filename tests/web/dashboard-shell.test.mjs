import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, projectRoot), 'utf8');
}

test('full-managed primary navigation follows the sales-first semi-managed interaction order', async () => {
  const [html, app, styles] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/app.js'),
    read('src/web/styles.css'),
  ]);
  const routes = [
    'home',
    'sales',
    'products',
    'inventory',
    'procurement',
    'fulfilment',
    'platform',
    'ops',
    'system',
  ];

  for (const route of routes) {
    assert.match(html, new RegExp(`data-route="${route}"`));
    assert.match(app, new RegExp(`\\b${route}: \\{ title:`));
  }
  assert.equal((html.match(/data-route=/g) || []).length, 9);
  assert.deepEqual(
    [...html.matchAll(/data-route="([^"]+)"/g)].map((match) => match[1]),
    routes,
  );
  assert.doesNotMatch(html, /data-route="(?:returns|compliance|finance)"/);
  assert.match(html, /data-route="home"><span>总控驾驶舱<\/span>/);
  assert.match(html, /data-route="sales"><span>销量分析<\/span>/);
  assert.match(html, /data-route="products"><span>商品分析<\/span>/);
  assert.match(html, /data-route="inventory"><span>库存与备货<\/span>/);
  assert.match(html, /data-route="platform"><span>平台动态<\/span>/);
  assert.match(html, /data-route="ops"><span>运营工具<\/span>/);
  assert.match(html, /data-route="system"><span>系统管理<\/span>/);
  assert.match(html, /缺失值不补零；建议不等于已执行/);
  assert.doesNotMatch(styles, /gradient\(/);
  assert.match(styles, /\.table-wrap\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*auto/s);
  assert.match(styles, /@media \(max-width: 620px\)/);
});

test('home shell keeps the decision flow, sales matrix, trends, ranking tables and operating alerts', async () => {
  const [html, app, parityStyles] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/app.js'),
    read('src/web/home-parity.css'),
  ]);

  assert.match(html, /id="scope-filter"/);
  assert.match(html, /aria-label="店铺或负责人范围"/);
  assert.doesNotMatch(html, /id="owner-filter"|id="store-filter"/);
  assert.match(app, /today: \{ label: '今日'/);
  assert.match(app, /yesterday: \{ label: '昨日'/);
  assert.match(app, /last7Days: \{ label: '近 7 日'/);
  assert.match(app, /last30Days: \{ label: '近 30 日'/);
  assert.match(app, /销量规模/);
  assert.match(app, /销售动能/);
  assert.match(app, /店铺经营/);
  assert.match(app, /商品与归并/);
  assert.match(app, /数据健康/);
  assert.match(app, /财务与结算/);
  assert.match(app, /日销量趋势/);
  assert.match(app, /月销量趋势/);
  assert.match(app, /店铺经营排行/);
  assert.match(app, /货号经营排行/);
  assert.match(app, /function metricMatrix\(/);
  assert.match(app, /function homeStoreRankingTable\(/);
  assert.match(app, /function homeProductRankingTable\(/);
  assert.match(app, /function homeHeader\(\)/);
  assert.match(app, /function homeTruthStrip\(\)/);
  assert.match(app, /class="home-topbar"/);
  assert.match(app, /class="kpi-six sales-matrix"/);
  assert.match(app, /class="trend-stack home-trend-stack"/);
  assert.match(app, /class="rank-grid rank-tables"/);
  assert.match(app, /renderOperationalPriorities\(\{ home: true \}\)/);
  assert.match(parityStyles, /\.kpi-six\s*\{/);
  assert.match(parityStyles, /\.metric-matrix\s*\{/);
  assert.match(parityStyles, /\.trend-stack\s*\{/);
  assert.match(parityStyles, /\.rank-grid\s*\{/);
  assert.match(parityStyles, /\.kpi-six \.matrix-span-2\s*\{/);
  assert.match(parityStyles, /\.metric-matrix-scroll\s*\{/);
  assert.match(parityStyles, /\.rank-identity\.canonical\s*\{/);
  assert.match(app, /function monthlyTrendRows\(\)/);
  assert.match(app, /OWNER:\$\{owner\.key\}/);
  assert.match(app, /STORE:\$\{store\.code\}/);
  assert.match(app, /店内商品排行（标准商品待归并）/);
  assert.match(app, /合法为 0/);
  assert.match(app, /数据已过期/);
  assert.match(app, /数据未接入/);
  assert.match(app, /不使用抓取时间冒充业务日期/);
});

test('full-managed shell keeps unsupported consumer metrics out of the KPI and ranking functions', async () => {
  const app = await read('src/web/app.js');
  const homeStart = app.indexOf('function homeKpis()');
  const homeEnd = app.indexOf('function permissionBadge', homeStart);
  const homeFunctions = app.slice(homeStart, homeEnd);

  assert.doesNotMatch(homeFunctions, /\bGMV\b/i);
  assert.doesNotMatch(homeFunctions, /\bCOD\b/i);
  assert.doesNotMatch(homeFunctions, /订单数|消费者退货/);
});

test('product identity page keeps unmapped store-local SKUs visible without cross-store aggregation', async () => {
  const app = await read('src/web/app.js');

  assert.match(app, /function unmappedStoreSkuRows\(\)/);
  assert.match(app, /mappingStatus \|\| ''\).*CONFIRMED/s);
  assert.match(app, /高销量待归并货号/);
  assert.match(app, /const visible = sorted\.slice\(0, 50\)/);
  assert.match(app, /销量影响降序/);
  assert.match(app, /店铺 \+ 原始货号\/SKC\/SKU/);
  assert.match(app, /不参与跨店标准商品合计/);
  assert.match(app, /function pendingProductMappingTable\(rows\)/);
  assert.match(app, /缺少平台 SPU，无法自动归并/);
  assert.match(app, /mappingStatusLabel\(item\.mappingStatus\)/);
  assert.match(app, /缺少平台 SPU \$\{numberFormatter\.format\(coverage\.missingSpu\)\} 个/);
  assert.match(app, /全量活跃目录/);
  assert.match(app, /function rankingProducts\(\)[\s\S]*rows: products/);
  assert.match(app, /排行同时保留已确认标准商品和未确认店内商品/);
});

test('web assets stay self-hosted and off the banned typefaces', async () => {
  const [html, styles, parityStyles] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/styles.css'),
    read('src/web/home-parity.css'),
  ]);

  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<script[^>]+src="(?!\/app\.js)/);
  for (const asset of ['favicon.svg', 'styles.css', 'home-parity.css', 'app.js']) {
    assert.match(html, new RegExp(`/${asset.replace('.', '\\.')}\\?v=20260729\\.6`));
  }
  assert.doesNotMatch(html, /v=20260728\.[123]/);
  for (const sheet of [styles, parityStyles]) {
    assert.doesNotMatch(sheet, /font-family:[^;]*(?:Inter|Roboto|Open Sans)/i);
    assert.doesNotMatch(sheet, /gradient\(/);
    assert.match(sheet, /font:[^;]*"PingFang SC"|font-family:[^;]*"PingFang SC"/);
  }
  assert.match(styles, /--bg: #fafaf8/);
  assert.match(styles, /--paper: #ffffff/);
  assert.match(styles, /--ink: #1a1916/);
  assert.match(styles, /--line: #e8e6e1/);
  assert.match(styles, /--accent: #2d6a4f/);
  assert.match(parityStyles, /\.overview-matrix-card\s*\{[^}]*border: 1px solid var\(--line\)[^}]*border-radius: 12px/s);
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
  assert.match(app, /源数据已截断/);
  assert.match(app, /data-procurement-page/);
  assert.match(app, /new EventSource\('\/api\/events'\)/);
  assert.match(app, /dashboard-updated/);
  assert.match(app, /快照自动更新/);
  assert.doesNotMatch(app, /实时采购|采购实时/);
  assert.match(styles, /\.table-pagination\s*\{/);
});

test('sales uses a server query and home exposes a compact operating pulse', async () => {
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
