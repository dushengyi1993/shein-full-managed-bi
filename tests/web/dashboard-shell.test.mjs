import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, projectRoot), 'utf8');
}

test('full-managed navigation exposes the control home and eleven real business or system pages', async () => {
  const html = await read('src/web/index.html');
  const app = await read('src/web/app.js');
  const routes = [
    'home',
    'procurement',
    'fulfilment',
    'products',
    'sales',
    'inventory',
    'returns',
    'compliance',
    'finance',
    'platform',
    'ops',
    'system',
  ];

  for (const route of routes) {
    assert.match(html, new RegExp(`data-route="${route}"`));
    assert.match(app, new RegExp(`\\b${route}: \\{ title:`));
  }
  assert.equal((html.match(/data-route=/g) || []).length, 12);
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
  assert.match(app, /待归并货号明细/);
  assert.match(app, /店铺 \+ 原始货号\/SKC\/SKU/);
  assert.match(app, /不参与跨店标准商品合计/);
  assert.match(app, /function pendingProductMappingTable\(rows\)/);
  assert.match(app, /缺少平台 SPU，无法自动归并/);
  assert.match(app, /mappingStatusLabel\(item\.mappingStatus\)/);
  assert.match(app, /缺少平台 SPU \$\{numberFormatter\.format\(missingSpuSkus\)\} 个/);
});
