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
 * Static source contracts for the procurement and fulfilment workspaces. They
 * prove each surface is wired to its own server query rather than filtering the
 * whole Dashboard snapshot; they do not replace visual acceptance.
 */

test('each workspace consumes only its own independent endpoint', async () => {
  const app = await read('src/web/app.js');
  const procurementUrl = functionBody(app, 'procurementQueryUrl');
  const fulfilmentUrl = functionBody(app, 'fulfilmentQueryUrl');

  assert.match(procurementUrl, /`\/api\/procurement\?\$\{params\.toString\(\)\}`/);
  assert.match(fulfilmentUrl, /`\/api\/fulfilment\?\$\{params\.toString\(\)\}`/);
  for (const parameter of ['owner', 'store', 'q', 'status', 'quick', 'sort', 'page', 'pageSize']) {
    assert.match(procurementUrl, new RegExp(`${parameter}:`), parameter);
  }
  for (const parameter of [
    'owner', 'store', 'q', 'milestone', 'quick', 'sort', 'page', 'pageSize',
  ]) {
    assert.match(fulfilmentUrl, new RegExp(`${parameter}:`), parameter);
  }
  // Every value is re-checked against an allow-list before it leaves the client.
  assert.match(procurementUrl, /allowListedToken\(state\.procurement\.sort, URL_PROCUREMENT_SORTS, 'PRIORITY'\)/);
  assert.match(procurementUrl, /operationCodeParam\(state\.procurement\.status\)/);
  assert.match(procurementUrl, /pageSizeParam\(state\.procurement\.pageSize\)/);
  assert.match(fulfilmentUrl, /allowListedToken\(state\.fulfilment\.sort, URL_FULFILMENT_SORTS, 'PRIORITY'\)/);
  assert.match(fulfilmentUrl, /operationCodeParam\(state\.fulfilment\.milestone\)/);
  assert.match(fulfilmentUrl, /pageSizeParam\(state\.fulfilment\.pageSize\)/);

  // Neither workspace filters the full Dashboard snapshot any more.
  const procurement = functionBody(app, 'renderProcurement');
  const fulfilment = functionBody(app, 'renderFulfilment');
  assert.match(procurement, /state\.procurement\.data/);
  assert.match(fulfilment, /state\.fulfilment\.data/);
  for (const body of [procurement, fulfilment]) {
    assert.doesNotMatch(body, /scopedOperationRows\(|domainRows\(supply|attentionRows\(/);
    assert.doesNotMatch(body, /matchesQuickFilter\(/);
    assert.doesNotMatch(body, /slice\(0, ?100\)/);
  }
  // The old unbounded per-store status table is gone from procurement.
  assert.match(procurement, /procurementDecisionOverview\(queryData\)/);
  assert.match(procurement, /procurementStoreRankings\(queryData\)/);
  assert.match(procurement, /procurementEvidenceDisclosure\(queryData\)/);
  assert.match(functionBody(app, 'procurementEvidenceDisclosure'), /statusOverview/);
  assert.doesNotMatch(procurement, /queryData\.statusRows/);
  assert.match(fulfilment, /fulfilmentDecisionOverview\(queryData\)/);
  assert.match(fulfilment, /fulfilmentStoreRankings\(queryData\)/);
  assert.match(fulfilment, /fulfilmentEvidenceDisclosure\(queryData\)/);
  assert.match(functionBody(app, 'fulfilmentEvidenceDisclosure'), /milestoneOverview/);
});

test('quick filter tokens are narrowed to each endpoint vocabulary', async () => {
  const app = await read('src/web/app.js');
  const procurementQuick = functionBody(app, 'procurementQuickValue');
  const fulfilmentQuick = functionBody(app, 'fulfilmentQuickValue');

  assert.match(
    procurementQuick,
    /'HIGH', 'OVERDUE', 'PENDING_DELIVERY',\s*'PENDING_RECEIPT', 'PENDING_STORAGE', 'DEFECTIVE',/,
  );
  assert.match(procurementQuick, /: 'ALL'/);
  assert.match(
    fulfilmentQuick,
    /\['HIGH', 'CREATED', 'PICKUP_RESERVED', 'IN_TRANSIT', 'PENDING_RECEIPT'\]/,
  );
  assert.match(fulfilmentQuick, /: 'ALL'/);

  // The rendered quick bars offer exactly the server's semantics.
  const procurement = functionBody(app, 'renderProcurement');
  for (const value of [
    'ALL', 'HIGH', 'OVERDUE', 'PENDING_DELIVERY',
    'PENDING_RECEIPT', 'PENDING_STORAGE', 'DEFECTIVE',
  ]) {
    assert.match(procurement, new RegExp(`\\['${value}',`), value);
  }
  const fulfilment = functionBody(app, 'renderFulfilment');
  for (const value of [
    'ALL', 'HIGH', 'CREATED', 'PICKUP_RESERVED', 'IN_TRANSIT', 'PENDING_RECEIPT',
  ]) {
    assert.match(fulfilment, new RegExp(`\\['${value}',`), value);
  }
});

test('fulfilment guards stale responses and exposes loading, error and retry', async () => {
  const app = await read('src/web/app.js');
  const load = functionBody(app, 'loadFulfilment');
  const schedule = functionBody(app, 'scheduleFulfilmentLoad');
  const queryState = functionBody(app, 'fulfilmentQueryState');

  assert.match(load, /const requestSerial = state\.fulfilment\.requestSerial \+ 1/);
  assert.ok(
    (load.match(/if \(requestSerial !== state\.fulfilment\.requestSerial\) return;/g) || []).length >= 2,
  );
  assert.match(load, /if \(requestSerial === state\.fulfilment\.requestSerial\)/);
  assert.match(load, /state\.fulfilment\.loading = true/);
  // A structurally invalid payload is an error, not a silently empty table.
  assert.match(load, /交付入仓查询结构无效/);
  assert.match(load, /result\.readOnly !== true/);
  assert.match(load, /Array\.isArray\(result\.attention\?\.rows\)/);
  assert.match(load, /Array\.isArray\(result\.milestoneOverview\)/);
  assert.match(load, /Array\.isArray\(result\.summary\.attentionByStore\)/);

  // The debounce invalidates in-flight work immediately, not when it fires.
  assert.match(schedule, /window\.clearTimeout\(fulfilmentLoadTimer\)/);
  assert.match(schedule, /state\.fulfilment\.requestSerial \+= 1/);
  assert.match(schedule, /window\.setTimeout\(/);
  assert.match(app, /scheduleFulfilmentLoad\(\{ resetPage: true, delay: 220 \}\)/);

  assert.match(queryState, /role="\$\{error \? 'alert' : 'status'\}"/);
  assert.match(queryState, /data-fulfilment-retry="1"/);
  assert.match(queryState, /query-skeleton/);
  assert.match(queryState, /旧筛选结果不会冒充新结果/);
  assert.match(app, /const fulfilmentRetry = event\.target\.closest\?\.\('\[data-fulfilment-retry\]'\)/);
  assert.match(app, /void loadFulfilment\(\)/);

  // Leaving the route drops any in-flight response for both workspaces.
  assert.match(app, /state\.fulfilment\.requestSerial \+= 1;\s*\n\s*state\.fulfilment\.loading = false/);
  assert.match(app, /state\.procurement\.requestSerial \+= 1/);
  // An atomic snapshot promotion refreshes the active workspace via the SSE path.
  const dashboardLoad = functionBody(app, 'loadDashboard');
  assert.match(dashboardLoad, /state\.route === 'fulfilment'[\s\S]*scheduleFulfilmentLoad\(\)/);
  assert.match(dashboardLoad, /state\.route === 'procurement'[\s\S]*scheduleProcurementLoad\(\)/);
});

test('workspace URL state round-trips through allow-listed hash parameters', async () => {
  const app = await read('src/web/app.js');
  const parse = functionBody(app, 'parseHashState');
  const serialize = functionBody(app, 'serializeHashState');
  const current = functionBody(app, 'currentHashState');
  const apply = functionBody(app, 'applyHashState');
  const codeParam = functionBody(app, 'operationCodeParam');

  assert.match(
    app,
    /const URL_PROCUREMENT_SORTS = Object\.freeze\(\[\s*'PRIORITY',\s*'LATEST',\s*'DELIVERY_DEADLINE',\s*\]\)/,
  );
  assert.match(
    app,
    /const URL_FULFILMENT_SORTS = Object\.freeze\(\[\s*'PRIORITY',\s*'LATEST',\s*'EXPECTED_RECEIPT',\s*\]\)/,
  );
  // A platform code is an open vocabulary, so it is pattern-bounded, not listed.
  // It must validate the RAW trimmed token: sanitizing first would strip the
  // angle brackets from `<script>` and yield the valid-looking code `SCRIPT`.
  assert.match(codeParam, /const raw = String\(value \?\? ''\)\.trim\(\)/);
  assert.match(codeParam, /if \(!URL_OPERATION_CODE_PATTERN\.test\(raw\)\) return 'ALL'/);
  assert.match(codeParam, /return raw\.toUpperCase\(\)/);
  assert.doesNotMatch(codeParam, /urlSafeText/);

  assert.match(parse, /procurementStatus: operationCodeParam\(params\.get\('status'\)\)/);
  assert.match(parse, /procurementPage: pageParam\('poPage'\)/);
  assert.match(parse, /fulfilmentMilestone: operationCodeParam\(params\.get\('milestone'\)\)/);
  assert.match(parse, /fulfilmentPage: pageParam\('dnPage'\)/);
  // `size` is a shared parameter name, so it must bind to the active route only.
  assert.match(parse, /procurementPageSize: routePageSize\('procurement', inherited\.procurementPageSize\)/);
  assert.match(parse, /fulfilmentPageSize: routePageSize\('fulfilment', inherited\.fulfilmentPageSize\)/);
  assert.match(parse, /const routePageSize = \(routeKey, inheritedValue\) => \{/);
  assert.match(parse, /if \(route === routeKey\) return pageSizeParam\(params\.get\('size'\)\)/);

  // Serialization omits defaults, bounds pages and is route scoped.
  assert.match(serialize, /if \(route === 'procurement'\) \{/);
  assert.match(serialize, /if \(status !== 'ALL'\) params\.set\('status', status\)/);
  assert.match(serialize, /if \(poSort !== 'PRIORITY'\) params\.set\('poSort', poSort\)/);
  assert.match(serialize, /params\.set\('poPage', String\(Math\.min\(input\.procurementPage, 9999\)\)\)/);
  assert.match(serialize, /if \(route === 'fulfilment'\) \{/);
  assert.match(serialize, /if \(milestone !== 'ALL'\) params\.set\('milestone', milestone\)/);
  assert.match(serialize, /if \(dnSort !== 'PRIORITY'\) params\.set\('dnSort', dnSort\)/);
  assert.match(serialize, /params\.set\('dnPage', String\(Math\.min\(input\.fulfilmentPage, 9999\)\)\)/);

  for (const key of [
    'procurementStatus', 'procurementSort', 'procurementPage', 'procurementPageSize',
    'fulfilmentMilestone', 'fulfilmentSort', 'fulfilmentPage', 'fulfilmentPageSize',
  ]) {
    assert.match(current, new RegExp(`${key}:`), key);
    assert.match(apply, new RegExp(`parsed\\.${key}`), key);
  }
  // Page size stays the closed 25/50/100 set on both workspaces.
  assert.match(apply, /state\.procurement\.pageSize = pageSizeParam\(parsed\.procurementPageSize\)/);
  assert.match(apply, /state\.fulfilment\.pageSize = pageSizeParam\(parsed\.fulfilmentPageSize\)/);
  assert.match(app, /const URL_INVENTORY_PAGE_SIZES = Object\.freeze\(\[25, 50, 100\]\)/);
});

test('filter and page controls update the URL and reset paging', async () => {
  const app = await read('src/web/app.js');

  // Every select writes state, syncs the URL, then reloads from page 1.
  assert.match(app, /const operationSelectControl = event\.target\.closest\?\.\('\[data-operation-select\]'\)/);
  assert.match(app, /state\.procurement\.status = operationCodeParam\(raw\)/);
  assert.match(app, /state\.fulfilment\.milestone = operationCodeParam\(raw\)/);
  assert.match(app, /state\.procurement\.pageSize = pageSizeParam\(raw\)/);
  assert.match(app, /state\.fulfilment\.pageSize = pageSizeParam\(raw\)/);
  assert.match(
    app,
    /syncUrlFromState\(\);\s*\n\s*if \(kind\.startsWith\('procurement'\)\) scheduleProcurementLoad\(\{ resetPage: true \}\);\s*\n\s*else scheduleFulfilmentLoad\(\{ resetPage: true \}\)/,
  );

  // Paging syncs the URL before fetching, so a shared link matches the view.
  assert.match(
    app,
    /state\.fulfilment\.page = nextPage;\s*\n\s*syncUrlFromState\(\);\s*\n\s*void loadFulfilment\(\)/,
  );

  // Explicit search and reset controls exist and keep global state coherent.
  const controls = functionBody(app, 'operationSearchControls');
  assert.match(controls, /data-operation-search/);
  assert.match(controls, /data-operation-reset/);
  assert.match(app, /if \(elements\.search\) elements\.search\.value = ''/);
  assert.match(app, /delete state\.quickFilters\[kind\]/);
  assert.match(app, /state\.procurement\.status = 'ALL'/);
  assert.match(app, /state\.fulfilment\.milestone = 'ALL'/);

  // Quick filters reload the matching workspace only.
  assert.match(app, /if \(route === 'procurement'\) scheduleProcurementLoad\(\{ resetPage: true \}\)/);
  assert.match(app, /if \(route === 'fulfilment'\) scheduleFulfilmentLoad\(\{ resetPage: true \}\)/);
});

test('both queues page above and below the table', async () => {
  const app = await read('src/web/app.js');
  const procurement = functionBody(app, 'renderProcurement');
  const fulfilment = functionBody(app, 'renderFulfilment');
  const procurementPagination = functionBody(app, 'procurementPagination');
  const fulfilmentPagination = functionBody(app, 'fulfilmentPagination');

  assert.match(procurement, /procurementPagination\(queryData, 'top'\)/);
  assert.match(procurement, /procurementPagination\(queryData, 'bottom'\)/);
  assert.match(fulfilment, /fulfilmentPagination\(queryData\.attention\.pagination, 'top'\)/);
  assert.match(fulfilment, /fulfilmentPagination\(queryData\.attention\.pagination, 'bottom'\)/);
  for (const body of [procurementPagination, fulfilmentPagination]) {
    assert.match(body, /pagination\.hasPrevious \? '' : 'disabled'/);
    assert.match(body, /pagination\.hasNext \? '' : 'disabled'/);
    assert.match(body, /已物化范围命中/);
    assert.match(body, /pagination-top/);
  }
});

test('coverage, truncation and quantity wording stay honest', async () => {
  const app = await read('src/web/app.js');
  const coverage = functionBody(app, 'operationCoverageLine');
  const metricValue = functionBody(app, 'stageMetricValue');
  const metricNote = functionBody(app, 'stageMetricNote');
  const procurement = functionBody(app, 'renderProcurement');
  const fulfilment = functionBody(app, 'renderFulfilment');

  // 23/24 plus the in-progress store, watermark window and source truncation.
  assert.match(coverage, /succeededStores/);
  assert.match(coverage, /totalStores/);
  assert.match(coverage, /inProgressStoreCodes/);
  assert.match(coverage, /进行中 \$\{inProgress\.join\('、'\)\}/);
  assert.match(coverage, /watermarkStart/);
  assert.match(coverage, /watermarkEnd/);
  assert.match(coverage, /源结果已截断，非仓库全量/);
  assert.match(coverage, /店铺覆盖未知/);

  // Unknown is never rendered as zero; a partial total degrades to "≥".
  assert.match(metricValue, /isUnit\(source\.total\)/);
  assert.match(metricValue, /≥ \$\{numberFormatter\.format\(source\.knownSum\)\}/);
  assert.match(metricValue, /'未知'/);
  assert.match(metricNote, /拒绝补零合计/);
  assert.match(metricNote, /不代表业务数量为 0/);

  // Neither workspace derives a funnel, completion rate or percentage.
  const procurementEvidence = functionBody(app, 'procurementEvidenceDisclosure');
  assert.match(procurementEvidence, /不是转化漏斗/);
  assert.match(procurementEvidence, /不构成转化漏斗，也不据此推导完成率或百分比/);
  const fulfilmentEvidence = functionBody(app, 'fulfilmentEvidenceDisclosure');
  assert.match(fulfilmentEvidence, /不据此推导履约率或准时率/);
  // Counts and quantities are labelled as different units.
  assert.match(fulfilmentEvidence, /交付单数与交付数量单位不同，不可相加/);
  assert.match(functionBody(app, 'procurementDecisionOverview'), /来自当前平台状态快照，不等于关注队列/);
  // A missing expectedReceiptAt stays unknown and is never fabricated.
  const deliveryTable = functionBody(app, 'deliveryAttentionTable');
  assert.match(deliveryTable, /expectedReceiptAt/);
  assert.match(deliveryTable, /预计收货时间缺失时保持未知，不用其他时间冒充/);
  assert.match(functionBody(app, 'fulfilmentEvidenceDisclosure'), /来源缺失时保持未知，不用预约或揽收时间冒充/);

  // Read-only: no SHEIN write control on either surface. Assert on markup and
  // request verbs, not on prose, since the boundary copy legitimately says
  // "不提交任何采购单动作".
  for (const body of [procurement, fulfilment]) {
    assert.doesNotMatch(body, /<form|<input|type="submit"/);
    assert.doesNotMatch(body, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
    // Every button is read-only navigation: retry, quick filter, paging, search.
    for (const [button] of body.matchAll(/<button[^>]*>/g)) {
      assert.match(
        button,
        /data-procurement-retry|data-fulfilment-retry|data-procurement-page|data-fulfilment-page|data-quick-route|data-operation-search|data-operation-reset/,
        button,
      );
    }
  }
  assert.match(functionBody(app, 'procurementEvidenceDisclosure'), /不提交任何采购单动作/);
  assert.match(functionBody(app, 'fulfilmentEvidenceDisclosure'), /不提交任何交付动作/);
});

test('operational styles keep dense filters inside the viewport', async () => {
  const styles = await read('src/web/styles.css');

  assert.match(styles, /\.operation-controls\s*\{/);
  assert.match(styles, /\.operation-search\s*\{/);
  assert.match(styles, /\.stage-snapshot\s*\{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/s);
  assert.match(styles, /\.stage-cell strong\s*\{[^}]*font-variant-numeric: tabular-nums/s);
  // Wide content collapses instead of widening the 390px document.
  assert.match(
    styles,
    /@media \(max-width: 640px\)[\s\S]*?\.stage-snapshot\s*\{\s*grid-template-columns: 1fr;/,
  );
  assert.match(
    styles,
    /@media \(max-width: 640px\)[\s\S]*?\.operation-search\s*\{\s*flex: 1 0 100%;/,
  );
  assert.match(styles, /\.table-wrap\s*\{[^}]*overflow:\s*auto/s);
  // Warm editorial minimalism: no gradient, neon or glass treatment. An
  // explicit `backdrop-filter: none` reset is allowed, since it disables glass.
  assert.doesNotMatch(styles, /gradient\(|text-shadow/);
  for (const [, value] of styles.matchAll(/backdrop-filter:\s*([^;]+)/g)) {
    assert.equal(value.trim(), 'none', 'backdrop-filter may only reset glass');
  }
});

/**
 * `src/web/app.js` is a classic browser script. The canonical hash-state block
 * is self-contained and DOM-free, so it can be extracted and exercised
 * behaviourally rather than only asserted as text.
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

test('every route-specific quick filter survives a serialize and parse round trip', async () => {
  const { parseHashState, serializeHashState } = await loadHashStateContract();

  // A quick value missing from QUICK_FILTER_VALUES is dropped by
  // serializeHashState and then reloaded as ALL, silently losing the operator's
  // filter. Each value below is really offered by one of the two workspaces.
  const cases = [
    ['procurement', 'HIGH'],
    ['procurement', 'OVERDUE'],
    ['procurement', 'PENDING_DELIVERY'],
    ['procurement', 'PENDING_RECEIPT'],
    ['procurement', 'PENDING_STORAGE'],
    ['procurement', 'DEFECTIVE'],
    ['fulfilment', 'HIGH'],
    ['fulfilment', 'CREATED'],
    ['fulfilment', 'PICKUP_RESERVED'],
    ['fulfilment', 'IN_TRANSIT'],
    ['fulfilment', 'PENDING_RECEIPT'],
  ];
  for (const [route, quick] of cases) {
    const serialized = serializeHashState({ route, quick });
    assert.match(serialized, new RegExp(`quick=${quick}`), `${route}/${quick} must serialize`);
    assert.equal(
      parseHashState(serialized).quick,
      quick,
      `${route}/${quick} must survive the round trip`,
    );
    // Re-serializing the reparsed state is stable.
    assert.equal(serializeHashState(parseHashState(serialized)), serialized);
  }
  // ALL remains the omitted default on both routes.
  assert.equal(serializeHashState({ route: 'procurement', quick: 'ALL' }), '#procurement');
  assert.equal(serializeHashState({ route: 'fulfilment', quick: 'ALL' }), '#fulfilment');
});

test('procurement and fulfilment filter state survives a full round trip', async () => {
  const { parseHashState, serializeHashState } = await loadHashStateContract();

  const procurement = serializeHashState({
    route: 'procurement',
    store: 'DL5477',
    quick: 'DEFECTIVE',
    procurementStatus: 'WAIT_DELIVERY',
    procurementSort: 'DELIVERY_DEADLINE',
    procurementPage: 3,
    procurementPageSize: 100,
  });
  const parsedProcurement = parseHashState(procurement);
  assert.equal(parsedProcurement.quick, 'DEFECTIVE');
  assert.equal(parsedProcurement.procurementStatus, 'WAIT_DELIVERY');
  assert.equal(parsedProcurement.procurementSort, 'DELIVERY_DEADLINE');
  assert.equal(parsedProcurement.procurementPage, 3);
  assert.equal(parsedProcurement.procurementPageSize, 100);
  assert.equal(parsedProcurement.store, 'DL5477');
  assert.equal(serializeHashState(parsedProcurement), procurement);

  const fulfilment = serializeHashState({
    route: 'fulfilment',
    store: 'MZ2406',
    quick: 'IN_TRANSIT',
    fulfilmentMilestone: 'IN_TRANSIT',
    fulfilmentSort: 'EXPECTED_RECEIPT',
    fulfilmentPage: 2,
    fulfilmentPageSize: 50,
  });
  const parsedFulfilment = parseHashState(fulfilment);
  assert.equal(parsedFulfilment.quick, 'IN_TRANSIT');
  assert.equal(parsedFulfilment.fulfilmentMilestone, 'IN_TRANSIT');
  assert.equal(parsedFulfilment.fulfilmentSort, 'EXPECTED_RECEIPT');
  assert.equal(parsedFulfilment.fulfilmentPage, 2);
  assert.equal(parsedFulfilment.fulfilmentPageSize, 50);
  assert.equal(parsedFulfilment.store, 'MZ2406');
  assert.equal(serializeHashState(parsedFulfilment), fulfilment);

  // An unknown sort or an off-list page size degrades to the default rather than
  // reaching the endpoint.
  const hostile = parseHashState('#fulfilment?dnSort=DROP&size=30&milestone=%3Cscript%3E');
  assert.equal(hostile.fulfilmentSort, 'PRIORITY');
  assert.equal(hostile.fulfilmentPageSize, 25);
  assert.equal(hostile.fulfilmentMilestone, 'ALL');
});

test('the shared size parameter binds only to the active route', async () => {
  const { parseHashState } = await loadHashStateContract();

  // Every workspace serializes its page size as `size`, so parsing it into all
  // four fields let a procurement link contaminate the other workspaces.
  const inherited = {
    inventoryPageSize: 25,
    productPageSize: 25,
    procurementPageSize: 25,
    fulfilmentPageSize: 25,
  };
  const procurement = parseHashState('#procurement?size=50', inherited);
  assert.equal(procurement.procurementPageSize, 50);
  assert.equal(procurement.fulfilmentPageSize, 25, 'fulfilment size must not be contaminated');
  assert.equal(procurement.inventoryPageSize, 25);
  assert.equal(procurement.productPageSize, 25);

  // A later bare navigation inherits the untouched fulfilment size.
  const bareFulfilment = parseHashState('#fulfilment', procurement);
  assert.equal(bareFulfilment.fulfilmentPageSize, 25);
  assert.equal(bareFulfilment.canonicalLink, false);

  // The same isolation holds in the opposite direction.
  const fulfilment = parseHashState('#fulfilment?size=100', inherited);
  assert.equal(fulfilment.fulfilmentPageSize, 100);
  assert.equal(fulfilment.procurementPageSize, 25);
  assert.equal(parseHashState('#procurement', fulfilment).procurementPageSize, 25);

  // Inventory and products own `size` on their own routes only.
  const inventory = parseHashState('#inventory?size=100', inherited);
  assert.equal(inventory.inventoryPageSize, 100);
  assert.equal(inventory.productPageSize, 25);
  assert.equal(inventory.procurementPageSize, 25);
  const products = parseHashState('#products?size=50', inherited);
  assert.equal(products.productPageSize, 50);
  assert.equal(products.inventoryPageSize, 25);

  // An off-list size still degrades to the default on its own route.
  assert.equal(parseHashState('#procurement?size=30', inherited).procurementPageSize, 25);
  // With no inherited value the default applies to the inactive routes.
  assert.equal(parseHashState('#procurement?size=50').fulfilmentPageSize, 25);
});

test('the shared view parameter binds only to the active route', async () => {
  const { parseHashState } = await loadHashStateContract();

  // Inventory and products both serialize their tab as `view`.
  const inherited = { inventoryView: 'INVENTORY', productView: 'PENDING' };
  const inventory = parseHashState('#inventory?view=ADVICE', inherited);
  assert.equal(inventory.inventoryView, 'ADVICE');
  assert.equal(inventory.productView, 'PENDING', 'product view must not be contaminated');

  const products = parseHashState('#products?view=CANONICAL', inherited);
  assert.equal(products.productView, 'CANONICAL');
  assert.equal(products.inventoryView, 'INVENTORY');

  // A value valid for the other route is not accepted here.
  assert.equal(parseHashState('#inventory?view=CANONICAL', inherited).inventoryView, 'INVENTORY');
  assert.equal(parseHashState('#products?view=ADVICE', inherited).productView, 'PENDING');
});

test('the milestone snapshot caption describes the snapshot, not the attention scope', async () => {
  const app = await read('src/web/app.js');
  const fulfilment = functionBody(app, 'fulfilmentEvidenceDisclosure');
  const caption = fulfilment.slice(fulfilment.indexOf("'MILESTONE SNAPSHOT'"));
  const heading = caption.slice(0, caption.indexOf(')}'));

  // The overview holds the whole scoped snapshot including RECEIVED, so it must
  // not borrow the attention-scope wording used by the unreceived queue.
  assert.match(heading, /当前交付里程碑快照（含已收货）/);
  assert.match(heading, /交付单数与交付数量单位不同，不可相加/);
  assert.match(heading, /不是转化漏斗/);
  assert.doesNotMatch(heading, /attentionScopeLabel/);
  assert.doesNotMatch(heading, /已物化关注范围/);
  // Procurement's stage snapshot legitimately keeps the attention-scope label,
  // since those quantities really do come from the attention rows.
  const procurementDisclosure = functionBody(app, 'procurementEvidenceDisclosure');
  assert.match(procurementDisclosure, /summary\.attentionScopeLabel/);
});

test('the global search placeholder covers every searchable identifier', async () => {
  const html = await read('src/web/index.html');

  // The endpoints search store, order/delivery number, supplier code, SKC, SKU
  // and product name, so the placeholder must not read as product-only.
  assert.match(
    html,
    /id="global-search"[^>]*placeholder="店铺 \/ 单号 \/ 货号 \/ SKC \/ SKU \/ 商品名"/,
  );
  assert.doesNotMatch(html, /placeholder="标准货号 \/ SKC \/ SKU \/ 商品名"/);
});

test('both queue tables preserve the server order and page', async () => {
  const app = await read('src/web/app.js');
  const procurementTableBody = functionBody(app, 'purchaseOrderAttentionTable');
  const fulfilmentTableBody = functionBody(app, 'deliveryAttentionTable');

  for (const body of [procurementTableBody, fulfilmentTableBody]) {
    // Re-sorting a server-paginated page would silently override the chosen
    // LATEST, DELIVERY_DEADLINE or EXPECTED_RECEIPT sort.
    assert.doesNotMatch(body, /\.sort\(/);
    assert.doesNotMatch(body, /comparePriority/);
    // The server already applied the page window.
    assert.doesNotMatch(body, /slice\(0, ?100\)/);
    // Focus-first ordering is the only permitted reordering.
    assert.match(body, /orderRowsForFocus\(rows, '(procurement|fulfilment)'\)/);
    assert.match(body, /排序与分页由服务端决定/);
    assert.match(body, /页面不再按优先级重排当前页/);
  }
});

test('procurement paging mirrors the page into the URL before fetching', async () => {
  const app = await read('src/web/app.js');

  // Without the sync a shared link would keep the previous page number.
  assert.match(
    app,
    /state\.procurement\.page = nextPage;\s*\n(?:\s*\/\/[^\n]*\n)*\s*syncUrlFromState\(\);\s*\n\s*void loadProcurement\(\)/,
  );
  assert.match(
    app,
    /state\.fulfilment\.page = nextPage;\s*\n\s*syncUrlFromState\(\);\s*\n\s*void loadFulfilment\(\)/,
  );
});

test('procurement stage cards name the field they actually render', async () => {
  const app = await read('src/web/app.js');
  const procurement = functionBody(app, 'procurementEvidenceDisclosure');

  // The stage snapshot keeps each label paired with its own field.
  assert.match(procurement, /\['订购', stages\.order\]/);
  assert.match(procurement, /\['交付', stages\.delivery\]/);
  assert.match(procurement, /\['收货', stages\.receipt\]/);
  assert.match(procurement, /\['入库', stages\.storage\]/);
  assert.match(procurement, /\['残次', stages\.defective\]/);
});

test('the superseded per-store table helpers are gone', async () => {
  const app = await read('src/web/app.js');

  // Both were left unreferenced once the compact aggregates replaced them.
  assert.doesNotMatch(app, /function procurementTable\(/);
  assert.doesNotMatch(app, /function fulfilmentTable\(/);
  // The active queue and aggregate helpers must survive.
  for (const helper of [
    'purchaseOrderAttentionTable',
    'deliveryAttentionTable',
    'renderProcurement',
    'renderFulfilment',
  ]) {
    assert.match(app, new RegExp(`function ${helper}\\(`), helper);
  }
});
