import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, projectRoot), 'utf8');
}

test('full-managed primary navigation exposes eight operator workspaces in decision order', async () => {
  const [html, app, styles] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/app.js'),
    read('src/web/styles.css'),
  ]);
  const routes = [
    'home',
    'ops',
    'sales',
    'inventory',
    'procurement',
    'fulfilment',
    'products',
    'system',
  ];

  for (const route of routes) {
    assert.match(html, new RegExp(`data-route="${route}"`));
    assert.match(app, new RegExp(`\\b${route}: \\{ title:`));
  }
  assert.equal((html.match(/data-route=/g) || []).length, 8);
  assert.deepEqual(
    [...html.matchAll(/data-route="([^"]+)"/g)].map((match) => match[1]),
    routes,
  );
  assert.doesNotMatch(html, /data-route="(?:returns|compliance|finance|platform)"/);
  assert.match(html, /data-route="home"><span>今日经营<\/span>/);
  assert.match(html, /data-route="ops"><span>运营待办<\/span>/);
  assert.match(html, /data-route="sales"><span>销量洞察<\/span>/);
  assert.match(html, /data-route="inventory"><span>供给与备货<\/span>/);
  assert.match(html, /data-route="system"><span>数据健康<\/span>/);
  assert.match(html, /缺失值不补零；建议不等于已执行/);
  assert.doesNotMatch(styles, /gradient\(/);
  assert.match(styles, /\.table-wrap\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*auto/s);
  assert.match(styles, /@media \(max-width: 620px\)/);
});

test('home shell includes sales windows, truth states, owner scope, trend and safe rankings', async () => {
  const [html, app] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/app.js'),
  ]);

  assert.match(html, /id="owner-filter"/);
  assert.match(app, /today: \{ label: '今日'/);
  assert.match(app, /yesterday: \{ label: '昨日'/);
  assert.match(app, /last7Days: \{ label: '近 7 日'/);
  assert.match(app, /last30Days: \{ label: '近 30 日'/);
  assert.match(app, /\$\{escapeHtml\(meta\.label\)\}销量/);
  assert.match(app, /真实销量趋势/);
  assert.match(app, /店铺销量 Top/);
  assert.match(app, /店内商品排行（标准商品待归并）/);
  assert.match(app, /合法为 0/);
  assert.match(app, /数据已过期/);
  assert.match(app, /数据未接入/);
  assert.match(app, /不使用抓取时间冒充业务日期/);
});

test('full-managed shell keeps unsupported consumer metrics out of the KPI and ranking functions', async () => {
  const app = await read('src/web/app.js');
  const homeStart = app.indexOf('function metricStrip()');
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
