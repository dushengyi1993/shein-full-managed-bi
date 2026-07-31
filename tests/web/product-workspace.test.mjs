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

/**
 * These are static source contracts. They prove the workspace is wired to the
 * server query surface rather than to a client-side slice; they do not replace
 * the Playwright visual acceptance run.
 */

test('the product workspace consumes /api/products with every bounded parameter', async () => {
  const app = await read('src/web/app.js');
  const url = functionBody(app, 'productQueryUrl');
  const quick = functionBody(app, 'productQuickValue');

  assert.match(url, /`\/api\/products\?\$\{params\.toString\(\)\}`/);
  for (const parameter of [
    'owner', 'store', 'q', 'quick', 'sort', 'range',
    'pendingPage', 'canonicalPage', 'pageSize',
  ]) {
    assert.match(url, new RegExp(`${parameter}:`), parameter);
  }
  // Every value is re-checked against an allow-list before it leaves the client.
  assert.match(url, /allowListedToken\(state\.products\.sort, URL_PRODUCT_SORTS, 'IMPACT_DESC'\)/);
  assert.match(url, /pageSizeParam\(state\.products\.pageSize\)/);
  assert.match(url, /URL_RANGE_KEYS\.includes\(state\.range\)/);
  assert.match(quick, /\['WITH_SALES', 'UNMAPPED', 'MISSING_SPU', 'CANONICAL'\]/);
  assert.match(quick, /: 'ALL'/);

  // The page never reads the whole dashboard for its displayed queue.
  const render = functionBody(app, 'renderProducts');
  assert.match(render, /state\.products\.data/);
  assert.doesNotMatch(render, /slice\(0, ?50\)/);
  assert.doesNotMatch(render, /skuRowsForView\(\)|unmappedStoreSkuRows\(\)/);
});

test('stale responses, debounce and loading/error/retry are all handled', async () => {
  const app = await read('src/web/app.js');
  const load = functionBody(app, 'loadProducts');
  const schedule = functionBody(app, 'scheduleProductLoad');
  const queryState = functionBody(app, 'productQueryState');

  // A response that lost the race must never replace newer filter state.
  assert.match(load, /const requestSerial = state\.products\.requestSerial \+ 1/);
  assert.ok(
    (load.match(/if \(requestSerial !== state\.products\.requestSerial\) return;/g) || []).length >= 2,
  );
  assert.match(load, /if \(requestSerial === state\.products\.requestSerial\)/);
  assert.match(load, /state\.products\.loading = true/);
  assert.match(load, /state\.products\.error = ''/);
  // A structurally invalid payload is an error, not a silently empty table.
  assert.match(load, /商品身份查询结构无效/);
  assert.match(load, /result\.readOnly !== true/);
  assert.match(load, /Array\.isArray\(result\.pending\?\.rows\)/);
  assert.match(load, /Array\.isArray\(result\.canonical\?\.rows\)/);

  // The debounce invalidates in flight work immediately, not when it fires.
  assert.match(schedule, /window\.clearTimeout\(productLoadTimer\)/);
  assert.match(schedule, /state\.products\.requestSerial \+= 1/);
  assert.match(schedule, /window\.setTimeout\(/);
  assert.match(app, /scheduleProductLoad\(\{ resetPages: true, delay: 220 \}\)/);

  assert.match(queryState, /role="\$\{error \? 'alert' : 'status'\}"/);
  assert.match(queryState, /data-product-retry="1"/);
  assert.match(queryState, /query-skeleton/);
  assert.match(queryState, /旧筛选结果不会冒充新结果/);
  assert.match(app, /const productRetry = event\.target\.closest\?\.\('\[data-product-retry\]'\)/);
  assert.match(app, /void loadProducts\(\)/);

  // Leaving the surface drops any in-flight response.
  assert.match(app, /state\.products\.requestSerial \+= 1;\s*\n\s*state\.products\.loading = false/);
  // An atomic snapshot promotion refreshes the workspace through the SSE path.
  const dashboardLoad = functionBody(app, 'loadDashboard');
  assert.match(dashboardLoad, /state\.route === 'products'[\s\S]*scheduleProductLoad\(\)/);
});

test('workspace URL state round-trips through allow-listed hash parameters', async () => {
  const app = await read('src/web/app.js');
  const parse = functionBody(app, 'parseHashState');
  const serialize = functionBody(app, 'serializeHashState');
  const current = functionBody(app, 'currentHashState');
  const apply = functionBody(app, 'applyHashState');

  assert.match(app, /const URL_PRODUCT_VIEWS = Object\.freeze\(\['PENDING', 'CANONICAL'\]\)/);
  assert.match(
    app,
    /const URL_PRODUCT_SORTS = Object\.freeze\(\[\s*'IMPACT_DESC',\s*'LAST30_DESC',\s*'LAST7_DESC',\s*'TODAY_DESC',\s*'STORE_ASC',\s*\]\)/,
  );

  // Parsing is allow-listed; an unknown token falls back to the default.
  assert.match(parse, /productSort: allowListedToken\(params\.get\('prodSort'\), URL_PRODUCT_SORTS, 'IMPACT_DESC'\)/);
  assert.match(parse, /productPendingPage: pageParam\('pendingPage'\)/);
  assert.match(parse, /productCanonicalPage: pageParam\('canonicalPage'\)/);
  // `view` and `size` are shared parameter names, so each binds to the active
  // route only; inventory must never inherit a products tab or page size.
  assert.match(parse, /productView: routeView\('products', URL_PRODUCT_VIEWS, 'PENDING', inherited\.productView\)/);
  assert.match(parse, /productPageSize: routePageSize\('products', inherited\.productPageSize\)/);
  assert.match(parse, /if \(route === routeKey\) return allowListedToken\(params\.get\('view'\), allowed, fallback\)/);

  // Serialization omits defaults, bounds pages and only runs on this route.
  assert.match(serialize, /if \(route === 'products'\) \{/);
  assert.match(serialize, /if \(view !== 'PENDING'\) params\.set\('view', view\)/);
  assert.match(serialize, /if \(productSort !== 'IMPACT_DESC'\) params\.set\('prodSort', productSort\)/);
  assert.match(serialize, /params\.set\('pendingPage', String\(Math\.min\(input\.productPendingPage, 9999\)\)\)/);
  assert.match(serialize, /params\.set\('canonicalPage', String\(Math\.min\(input\.productCanonicalPage, 9999\)\)\)/);

  // State mirrors into the link and back out again.
  for (const key of [
    'productView', 'productSort', 'productPendingPage',
    'productCanonicalPage', 'productPageSize',
  ]) {
    assert.match(current, new RegExp(`${key}:`), key);
  }
  assert.match(apply, /state\.products\.view = parsed\.productView \|\| 'PENDING'/);
  assert.match(apply, /state\.products\.sort = parsed\.productSort \|\| 'IMPACT_DESC'/);
  assert.match(apply, /state\.products\.pageSize = pageSizeParam\(parsed\.productPageSize\)/);
});

test('two tabs page independently and expose page size and sort controls', async () => {
  const app = await read('src/web/app.js');
  const tabs = functionBody(app, 'productViewTabs');
  const pagination = functionBody(app, 'productPagination');
  const render = functionBody(app, 'renderProducts');

  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /\['PENDING', '待归并队列', pendingMatched\]/);
  assert.match(tabs, /\['CANONICAL', '标准商品', canonicalMatched\]/);
  assert.match(tabs, /aria-selected="\$\{active === value \? 'true' : 'false'\}"/);
  // Each tab shows its own matched count, so an inactive tab is never a zero.
  assert.match(tabs, /pending\?\.pagination\?\.matchedMaterializedRows/);
  assert.match(tabs, /canonical\?\.pagination\?\.matchedMaterializedRows/);

  // Independent pages, rendered above and below the table.
  assert.match(pagination, /data-product-page-kind/);
  assert.match(pagination, /pagination\.hasPrevious \? '' : 'disabled'/);
  assert.match(pagination, /pagination\.hasNext \? '' : 'disabled'/);
  assert.match(render, /productPagination\(pagination, paginationKind, paginationLabel, 'top'\)/);
  assert.match(render, /productPagination\(pagination, paginationKind, paginationLabel, 'bottom'\)/);
  assert.match(render, /paginationKind = pendingView \? 'pending' : 'canonical'/);
  assert.match(app, /if \(kind === 'canonical'\) state\.products\.canonicalPage = nextPage;\s*\n\s*else state\.products\.pendingPage = nextPage;/);

  // Page size is a closed set and resets both pages when changed.
  assert.match(render, /productSelect\('pageSize', '每页', \[\s*\[25, '25 条'\],\s*\[50, '50 条'\],\s*\[100, '100 条'\],\s*\]/);
  assert.match(app, /state\.products\.pageSize = pageSizeParam\(raw\)/);
  assert.match(app, /state\.products\.pendingPage = 1;\s*\n\s*state\.products\.canonicalPage = 1;\s*\n\s*syncUrlFromState\(\);\s*\n\s*void loadProducts\(\)/);

  // A view-specific quick filter never stays invisibly active across tabs.
  assert.match(app, /const nextQuickValues = value === 'PENDING'/);
  assert.match(app, /if \(quickNeedsReset\) delete state\.quickFilters\.products/);
});

test('the workspace shows the real evidence pipeline and both identity universes', async () => {
  const app = await read('src/web/app.js');
  const flow = functionBody(app, 'productPipelineFlow');
  const summary = functionBody(app, 'productDecisionSummary');

  // Four real stages replace the old "待接入" placeholders.
  for (const stage of ['密封证据集', '候选生成', '身份决策', '归并与标准商品']) {
    assert.match(flow, new RegExp(stage), stage);
  }
  assert.doesNotMatch(flow, /待接入/);
  assert.match(flow, /pipeline\.evidence/);
  assert.match(flow, /pipeline\.candidates/);
  assert.match(flow, /pipeline\.decisions/);
  assert.match(flow, /pipeline\.assignments/);
  assert.match(flow, /pipeline\.canonical/);
  // An unknown stage says unknown rather than zero.
  assert.match(flow, /const unknown = pipeline\.status === 'unavailable'/);
  assert.match(flow, /unknown \|\| !isUnit\(value\) \? '未知'/);
  assert.match(flow, /四个阶段数量均显示未知，不显示 0/);
  assert.match(flow, /证据时间 \$\{escapeHtml\(freshness\)\}/);

  // The active catalog and the sealed evidence run stay separate universes.
  assert.match(summary, /activeCatalogCoverage/);
  assert.match(summary, /这是全量活跃目录口径，不依赖销量业务日/);
  assert.match(summary, /证据覆盖（最新密封 run）/);
  assert.match(summary, /evidence\.sealedSetCount/);
  assert.match(summary, /evidence\.observedStoreCount/);
  assert.match(summary, /assignments\.currentConfirmedCount/);
  assert.match(summary, /canonical\.globalActiveProductCount/);
  // Unknown values are rendered as unknown, not coerced to a number.
  assert.ok((summary.match(/nullableUnits\([^,]+, '未知'\)/g) || []).length >= 6);
  assert.doesNotMatch(summary, /\|\| 0\b|\?\? 0\b/);
});

test('source wording stays honest about the materialized scope', async () => {
  const app = await read('src/web/app.js');
  const render = functionBody(app, 'renderProducts');

  assert.match(render, /已物化范围命中/);
  assert.match(render, /源结果已截断，非 SHEIN 全量目录/);
  assert.match(render, /源物化未截断/);
  assert.match(app, /命中数不是活跃目录或 SHEIN 仓库全量商品数/);
  // A scoped canonical list must say its quantities were recomputed.
  assert.match(render, /canonicalQuantitiesRecomputed === true/);
  assert.match(render, /标准商品数量与店铺数按范围内店铺重算，不展示全量跨店合计/);
  assert.match(app, /已物化范围命中 \$\{numberFormatter\.format\(matched\)\} 条/);
});

test('the identity boundary section states strong evidence and conflict blockers', async () => {
  const app = await read('src/web/app.js');
  const boundaries = functionBody(app, 'productIdentityBoundaries');

  assert.match(boundaries, /平台 SPU、SKC、SKU 只在同一店铺内是强标识/);
  assert.match(boundaries, /供应商编码、商家 SKU、标题与图片 URL 只用于生成候选/);
  assert.match(boundaries, /有效 GTIN 与官方型号属性 1000546/);
  assert.match(boundaries, /电压、插头、容量、端子品类或关键尺寸冲突时禁止自动合并/);
  assert.match(boundaries, /只有 GLOBAL \+ CONFIRMED 归并可跨店聚合/);
  assert.match(boundaries, /本批不写 SHEIN，也不写归并与决策/);
});

test('the workspace exposes no mutation control', async () => {
  const app = await read('src/web/app.js');
  const start = app.indexOf('/* --- product-query:start ---');
  const end = app.indexOf('/* --- product-query:end --- */');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = app.slice(start, end);
  const render = functionBody(app, 'renderProducts');

  for (const body of [block, render]) {
    assert.doesNotMatch(body, /<form|<input|type="submit"/);
    assert.doesNotMatch(body, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
  }
  // The only buttons are read-only navigation: retry, tabs and pagination.
  const buttons = [...block.matchAll(/<button[^>]*>/g)].map(([match]) => match);
  assert.ok(buttons.length > 0);
  for (const button of buttons) {
    assert.match(
      button,
      /data-product-retry|data-product-view|data-product-page/,
      button,
    );
  }
});

test('static assets are versioned together at 20260731.4', async () => {
  const html = await read('src/web/index.html');
  for (const asset of ['app.js', 'styles.css', 'home-parity.css', 'favicon.svg']) {
    assert.match(html, new RegExp(`/${asset.replace('.', '\\.')}\\?v=20260731\\.4`), asset);
  }
  assert.doesNotMatch(html, /\?v=20260730\.9/);
});
