import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

async function appSource() {
  return readFile(new URL('src/web/app.js', projectRoot), 'utf8');
}

/**
 * `src/web/app.js` is a classic browser script, not a module. The canonical
 * hash-state contract is written as a self-contained, DOM-free block so it can be
 * extracted and exercised behaviorally instead of only asserted as text.
 */
async function loadHashStateContract() {
  const source = await appSource();
  const start = source.indexOf('/* --- canonical-hash-state:start ---');
  const end = source.indexOf('/* --- canonical-hash-state:end --- */');
  assert.notEqual(start, -1, 'canonical hash-state block start marker must exist');
  assert.notEqual(end, -1, 'canonical hash-state block end marker must exist');
  const block = source.slice(start, end);
  const executableBlock = block
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(executableBlock, /\bdocument\b|\bwindow\b/, 'the contract must stay DOM-free');
  // eslint-disable-next-line no-new-func
  return new Function(`
    ${block}
    return {
      parseHashState, serializeHashState, canonicalHref,
      parseScopeToken, parseFocusToken, FOCUS_DOMAINS,
    };
  `)();
}

test('hash state parsing and serialization are deterministic round trips', async () => {
  const { parseHashState, serializeHashState } = await loadHashStateContract();

  const link = '#inventory?scope=STORE%3AFY4021&range=today&q=I46bnuv4yyuh'
    + '&focus=inventory%3AFY4021%3AI46bnuv4yyuh';
  const parsed = parseHashState(link);
  assert.equal(parsed.route, 'inventory');
  assert.equal(parsed.store, 'FY4021');
  assert.equal(parsed.owner, 'ALL');
  assert.equal(parsed.range, 'today');
  assert.equal(parsed.query, 'I46bnuv4yyuh');
  assert.deepEqual(parsed.focus, {
    domain: 'inventory',
    storeCode: 'FY4021',
    code: 'I46bnuv4yyuh',
  });

  // Serializing then reparsing yields identical state, and serializing twice
  // yields an identical string.
  const serialized = serializeHashState(parsed);
  assert.equal(serializeHashState(parseHashState(serialized)), serialized);
  assert.deepEqual(parseHashState(serialized), parsed);
  // Defaults are omitted so a shared link stays compact.
  assert.doesNotMatch(serialized, /range=today/);
  assert.equal(serializeHashState({ route: 'home' }), '#home');
  assert.equal(
    serializeHashState({ route: 'home', owner: 'ALL', store: 'ALL', range: 'today', query: '' }),
    '#home',
  );
  // Parameter order is fixed regardless of input key order.
  assert.equal(
    serializeHashState({ range: 'last7Days', route: 'sales', store: 'DL5477' }),
    serializeHashState({ store: 'DL5477', route: 'sales', range: 'last7Days' }),
  );
  assert.match(
    serializeHashState({ route: 'sales', store: 'DL5477', range: 'last7Days' }),
    /^#sales\?scope=STORE%3ADL5477&range=last7Days$/,
  );
});

test('a direct load restores DL5477, last7Days and the global query', async () => {
  const { parseHashState } = await loadHashStateContract();
  const restored = parseHashState('#sales?scope=STORE%3ADL5477&range=last7Days&q=SM-505A');
  assert.equal(restored.route, 'sales');
  assert.equal(restored.store, 'DL5477');
  assert.equal(restored.range, 'last7Days');
  assert.equal(restored.query, 'SM-505A');
  assert.equal(restored.quick, 'ALL');

  const owned = parseHashState('#home?scope=OWNER%3Adushengyi&range=last30Days&quick=HIGH');
  assert.equal(owned.owner, 'dushengyi');
  assert.equal(owned.store, 'ALL');
  assert.equal(owned.range, 'last30Days');
  assert.equal(owned.quick, 'HIGH');

  const unicode = parseHashState(
    '#products?scope=OWNER%3A负责人甲&q=保温杯&focus=product%3A%3AGLOBAL-PRODUCT%3A保温杯%2001',
  );
  assert.equal(unicode.owner, '负责人甲');
  assert.equal(unicode.query, '保温杯');
  assert.equal(unicode.focus?.code, 'GLOBAL-PRODUCT:保温杯 01');
});

test('sales sort and both materialized pages survive a canonical link', async () => {
  const { parseHashState, serializeHashState } = await loadHashStateContract();
  const href = serializeHashState({
    route: 'sales',
    owner: 'ALL',
    store: 'DL5477',
    range: 'last30Days',
    quick: 'DECLINING',
    salesSort: 'MOMENTUM_ASC',
    productPage: 3,
    standardPage: 2,
  });
  assert.match(href, /sort=MOMENTUM_ASC/);
  assert.match(href, /page=3/);
  assert.match(href, /standardPage=2/);
  const parsed = parseHashState(href);
  assert.equal(parsed.salesSort, 'MOMENTUM_ASC');
  assert.equal(parsed.productPage, 3);
  assert.equal(parsed.standardPage, 2);

  const unsafe = parseHashState('#sales?sort=DROP&page=0&standardPage=99999');
  assert.equal(unsafe.salesSort, 'LAST30_DESC');
  assert.equal(unsafe.productPage, 1);
  assert.equal(unsafe.standardPage, 1);
});

test('inventory workspace state survives a safe canonical link', async () => {
  const { parseHashState, serializeHashState } = await loadHashStateContract();
  const href = serializeHashState({
    route: 'inventory',
    owner: 'ALL',
    store: 'DL5477',
    range: 'today',
    quick: 'URGENT',
    inventoryView: 'ADVICE',
    inventoryType: 'JI',
    inventorySort: 'USABLE_ASC',
    adviceSort: 'URGENT_DESC',
    inventoryPage: 3,
    advicePage: 2,
    inventoryPageSize: 50,
  });

  assert.match(href, /view=ADVICE/);
  assert.match(href, /invType=JI/);
  assert.match(href, /invSort=USABLE_ASC/);
  assert.match(href, /adviceSort=URGENT_DESC/);
  assert.match(href, /invPage=3/);
  assert.match(href, /advicePage=2/);
  assert.match(href, /size=50/);
  const parsed = parseHashState(href);
  assert.equal(parsed.inventoryView, 'ADVICE');
  assert.equal(parsed.inventoryType, 'JI');
  assert.equal(parsed.inventorySort, 'USABLE_ASC');
  assert.equal(parsed.adviceSort, 'URGENT_DESC');
  assert.equal(parsed.inventoryPage, 3);
  assert.equal(parsed.advicePage, 2);
  assert.equal(parsed.inventoryPageSize, 50);

  const unsafe = parseHashState(
    '#inventory?view=DROP&invType=XX&invSort=DROP&adviceSort=DROP'
      + '&invPage=0&advicePage=10000&size=99',
  );
  assert.equal(unsafe.inventoryView, 'INVENTORY');
  assert.equal(unsafe.inventoryType, 'ALL');
  assert.equal(unsafe.inventorySort, 'PRIORITY');
  assert.equal(unsafe.adviceSort, 'PRIORITY');
  assert.equal(unsafe.inventoryPage, 1);
  assert.equal(unsafe.advicePage, 1);
  assert.equal(unsafe.inventoryPageSize, 25);
});

test('platform workspace state survives a safe canonical link', async () => {
  const { parseHashState, serializeHashState } = await loadHashStateContract();
  const href = serializeHashState({
    route: 'platform',
    owner: 'ALL',
    store: 'DL5477',
    range: 'today',
    query: 'PO-1',
    platformView: 'BUSINESS',
    platformSeverity: 'P1',
    platformFamily: 'purchase_order',
    platformStatus: 'FAILED',
    platformSort: 'LATEST',
    platformPage: 3,
    platformPageSize: 50,
  });

  assert.match(href, /view=BUSINESS/);
  assert.match(href, /eventSeverity=P1/);
  assert.match(href, /eventFamily=PURCHASE_ORDER/);
  assert.match(href, /eventStatus=FAILED/);
  assert.match(href, /eventSort=LATEST/);
  assert.match(href, /eventPage=3/);
  assert.match(href, /size=50/);
  const parsed = parseHashState(href);
  assert.equal(parsed.platformView, 'BUSINESS');
  assert.equal(parsed.platformSeverity, 'P1');
  assert.equal(parsed.platformFamily, 'PURCHASE_ORDER');
  assert.equal(parsed.platformStatus, 'FAILED');
  assert.equal(parsed.platformSort, 'LATEST');
  assert.equal(parsed.platformPage, 3);
  assert.equal(parsed.platformPageSize, 50);

  const unsafe = parseHashState(
    '#platform?view=DROP&eventSeverity=P9&eventFamily=%3Cscript%3E'
      + '&eventStatus=bad%20status&eventSort=DROP&eventPage=0&size=99',
  );
  assert.equal(unsafe.platformView, 'URGENT');
  assert.equal(unsafe.platformSeverity, 'ALL');
  assert.equal(unsafe.platformFamily, 'ALL');
  assert.equal(unsafe.platformStatus, 'ALL');
  assert.equal(unsafe.platformSort, 'PRIORITY');
  assert.equal(unsafe.platformPage, 1);
  assert.equal(unsafe.platformPageSize, 25);
});

test('operations workspace state survives a safe canonical link', async () => {
  const { parseHashState, serializeHashState } = await loadHashStateContract();
  const href = serializeHashState({
    route: 'ops',
    owner: 'ALL',
    store: 'DL5477',
    query: 'PO-1',
    quick: 'OVERDUE',
    opsView: 'ALL',
    opsSeverity: 'HIGH',
    opsDomain: 'PROCUREMENT',
    opsSort: 'DEADLINE',
    opsPage: 4,
    opsPageSize: 50,
  });

  assert.match(href, /quick=OVERDUE/);
  assert.match(href, /view=ALL/);
  assert.match(href, /opsSeverity=HIGH/);
  assert.match(href, /opsDomain=PROCUREMENT/);
  assert.match(href, /opsSort=DEADLINE/);
  assert.match(href, /opsPage=4/);
  assert.match(href, /size=50/);
  const parsed = parseHashState(href);
  assert.equal(parsed.quick, 'OVERDUE');
  assert.equal(parsed.opsView, 'ALL');
  assert.equal(parsed.opsSeverity, 'HIGH');
  assert.equal(parsed.opsDomain, 'PROCUREMENT');
  assert.equal(parsed.opsSort, 'DEADLINE');
  assert.equal(parsed.opsPage, 4);
  assert.equal(parsed.opsPageSize, 50);
  assert.equal(serializeHashState(parsed), href);

  const unsafe = parseHashState(
    '#ops?view=DROP&opsSeverity=P0&opsDomain=DELETE'
      + '&opsSort=DROP&opsPage=0&size=99',
  );
  assert.equal(unsafe.opsView, 'PRIORITY');
  assert.equal(unsafe.opsSeverity, 'ALL');
  assert.equal(unsafe.opsDomain, 'ALL');
  assert.equal(unsafe.opsSort, 'PRIORITY');
  assert.equal(unsafe.opsPage, 1);
  assert.equal(unsafe.opsPageSize, 25);
});

test('invalid hash input falls back safely and cannot inject markup', async () => {
  const { parseHashState, parseScopeToken, parseFocusToken } = await loadHashStateContract();

  for (const hash of [
    '',
    '#',
    '#not-a-route',
    '#inventory?range=forever&scope=BOGUS&quick=DROP&focus=evil',
    '#inventory?focus=unknownDomain%3AFY4021%3AX',
    '#inventory?scope=STORE%3A%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
    '#inventory?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
  ]) {
    const parsed = parseHashState(hash);
    assert.ok(['home', 'inventory'].includes(parsed.route), hash);
    assert.ok(['today', 'yesterday', 'last7Days', 'last30Days'].includes(parsed.range), hash);
    assert.equal(parsed.quick, 'ALL', hash);
    // Nothing markup-shaped ever reaches state.
    const serializedState = JSON.stringify(parsed);
    assert.doesNotMatch(serializedState, /[<>]/, hash);
    assert.doesNotMatch(serializedState, /[`\\\\]/, hash);
  }
  assert.equal(parseHashState('#inventory?scope=BOGUS').store, 'ALL');
  assert.deepEqual(parseScopeToken('STORE:not a code'), { owner: 'ALL', store: 'ALL' });
  assert.equal(parseFocusToken('inventory'), null);
  assert.equal(parseFocusToken(''), null);

  // A focus that belongs to another surface is dropped rather than applied here.
  assert.equal(parseHashState('#procurement?focus=inventory%3AFY4021%3AX').focus, null);
});

test('main-nav navigation inherits scope, range and query but clears focus', async () => {
  const { parseHashState } = await loadHashStateContract();
  const inherited = {
    owner: 'ALL',
    store: 'FY4021',
    range: 'last7Days',
    query: 'I46bnuv4yyuh',
  };
  // A bare route hash is main-nav navigation, not a canonical link.
  const navigated = parseHashState('#procurement', inherited);
  assert.equal(navigated.route, 'procurement');
  assert.equal(navigated.store, 'FY4021');
  assert.equal(navigated.range, 'last7Days');
  assert.equal(navigated.query, 'I46bnuv4yyuh');
  assert.equal(navigated.focus, null, 'an incompatible focus must be cleared');
  assert.equal(navigated.canonicalLink, false);

  // A canonical link ignores inherited values and uses its own parameters.
  const linked = parseHashState('#procurement?scope=STORE%3ADL5477', inherited);
  assert.equal(linked.store, 'DL5477');
  assert.equal(linked.range, 'today');
  assert.equal(linked.query, '');
  assert.equal(linked.canonicalLink, true);
});

test('canonical hrefs carry route, store scope, exact object and typed focus', async () => {
  const { canonicalHref, parseHashState } = await loadHashStateContract();
  const href = canonicalHref({
    route: 'inventory',
    storeCode: 'FY4021',
    range: 'today',
    query: 'I46bnuv4yyuh',
    focus: { domain: 'inventory', storeCode: 'FY4021', code: 'I46bnuv4yyuh' },
  });
  // The live QA example must survive the whole link round trip.
  assert.match(href, /^#inventory\?/);
  assert.ok(href.includes('FY4021'), href);
  assert.ok(href.includes('I46bnuv4yyuh'), href);
  const parsed = parseHashState(href);
  assert.equal(parsed.store, 'FY4021');
  assert.equal(parsed.query, 'I46bnuv4yyuh');
  assert.deepEqual(parsed.focus, {
    domain: 'inventory',
    storeCode: 'FY4021',
    code: 'I46bnuv4yyuh',
  });

  // Clearing the focus keeps the broader store and range investigation.
  const cleared = { ...parsed, focus: null, query: '' };
  const clearedHref = canonicalHref({
    route: cleared.route,
    storeCode: cleared.store,
    range: cleared.range,
  });
  const reparsed = parseHashState(clearedHref);
  assert.equal(reparsed.store, 'FY4021');
  assert.equal(reparsed.range, 'today');
  assert.equal(reparsed.focus, null);
});

test('alert drilldown replaces the generic route href with a canonical focus link', async () => {
  const source = await appSource();
  // The priority worklist must no longer emit a bare route href.
  assert.doesNotMatch(source, /href="\$\{escapeHtml\(item\.href \|\| '#ops'\)\}"/);
  assert.match(source, /href="\$\{escapeHtml\(alertFocusHref\(item\)\)\}"/);
  assert.match(source, /function alertFocusHref\(item\)/);
  // The alert already knows its store and object, so both enter the link.
  assert.match(
    source,
    /const storeCode = String\(item\?\.storeCode \?\? ''\)\.trim\(\)\.toUpperCase\(\)/,
  );
  assert.match(source, /focus: \{ domain, storeCode, code \}/);
  // Domain mapping covers every operating alert group.
  for (const pair of [
    "procurement: 'procurement'",
    "fulfilment: 'fulfilment'",
    "inventory: 'inventory'",
    "supply: 'advice'",
    "products: 'product'",
  ]) {
    assert.ok(source.includes(pair), pair);
  }
  // Product identity alerts carry a real identity key.
  assert.match(source, /focusDomain: 'product',\s*\n\s*focusCode: focusCodeFor\(pending\[0\], 'product'\)/);
});

test('the focused-evidence panel is read-only, honest and clearable', async () => {
  const source = await appSource();
  assert.match(source, /function focusEvidencePanel\(/);
  assert.match(source, /function clearFocusControl\(/);
  assert.match(source, /当前快照未找到该事实/);
  assert.match(source, /不会改用其他相近记录冒充定位结果/);
  assert.match(source, /清除定位，查看当前范围全部结果/);

  const start = source.indexOf('/* --- focused-evidence:start ---');
  const end = source.indexOf('/* --- focused-evidence:end --- */');
  assert.notEqual(start, -1);
  const block = source.slice(start, end);
  // A read-only surface: no write, submit, approve or mutating request.
  assert.doesNotMatch(block, /<button|<form|<input|type="submit"/);
  assert.doesNotMatch(block, /method:\s*['"]POST['"]|fetch\(/);
  assert.doesNotMatch(block, /提交|批准|保存|删除/);
  // Unknown quantities stay unknown.
  assert.match(block, /nullableUnits\(value, '—'\)/);
  assert.doesNotMatch(block, /\?\? 0\b|\|\| 0\b/);

  // The panel is mounted before the operator-first operations overview.
  assert.match(
    source,
    /\$\{focusEvidencePanel\(\)\}\s*\n\s*\$\{opsDecisionOverview\(queryData\)\}/,
  );
  assert.match(
    source,
    /\$\{focusEvidencePanel\(\)\}\s*\n\s*\$\{productDecisionSummary\(queryData\)\}/,
  );
  assert.match(
    source,
    /\$\{focusEvidencePanel\(\)\}\s*\n\s*\$\{inventorySummaryCards\(queryData\)\}/,
  );
  assert.match(
    source,
    /\$\{focusEvidencePanel\(\)\}\s*\n\s*\$\{procurementDecisionOverview\(queryData\)\}/,
  );
  assert.match(source, /function renderFulfilment\([\s\S]*\$\{focusEvidencePanel\(\)\}/);
  assert.match(source, /shippingOrdersList\(rows, sourceCapabilities\)/);
});

test('focused rows are ordered first, marked, and reachable by keyboard', async () => {
  const source = await appSource();
  assert.match(source, /function orderRowsForFocus\(/);
  assert.match(source, /function isFocusedRow\(/);
  assert.match(source, /function rowFocusLink\(/);
  // Every drilldown surface orders and marks its focused row. Each table now
  // passes the server-ordered page straight through, so focus-first ordering is
  // the only reordering applied; the old `[...rows].sort(...)` copy would have
  // overridden the operator's chosen server sort.
  for (const domain of ['inventory', 'advice', 'procurement']) {
    assert.ok(
      source.includes(`orderRowsForFocus(rows, '${domain}')`),
      domain,
    );
    assert.ok(source.includes(`isFocusedRow(row, '${domain}')`), domain);
    assert.ok(source.includes(`rowFocusLink(row, '${domain}')`), domain);
  }
  assert.doesNotMatch(source, /orderRowsForFocus\(\[\.\.\.rows\]/);
  assert.ok(source.includes("isFocusedRow(item, 'product')"));
  assert.ok(source.includes("rowFocusLink(item, 'product')"));
  // Anchors are natively keyboard reachable and name their target for readers.
  assert.match(source, /class="text-link row-focus-link" href=/);
  assert.match(source, /<span class="sr-only">/);
  // A focus is never guessed: an absent target reports not-found instead.
  assert.match(source, /return \{ focus, domain: focus\.domain, row: null, found: false \}/);
});

test('filter changes mirror into the URL without navigating', async () => {
  const source = await appSource();
  assert.match(source, /function syncUrlFromState\(\)/);
  assert.match(source, /window\.history\.replaceState\(null, '', next\)/);
  // Every filter entry point updates the shareable link.
  const searchHandler = source.slice(source.indexOf("elements.search.addEventListener('input'"));
  assert.match(searchHandler.slice(0, 220), /syncUrlFromState\(\)/);
  const scopeHandler = source.slice(source.indexOf("elements.scope.addEventListener('change'"));
  assert.match(scopeHandler.slice(0, 320), /syncUrlFromState\(\)/);
  const rangeHandler = source.slice(source.lastIndexOf('elements.rangeButtons.forEach'));
  assert.match(rangeHandler.slice(0, 700), /syncUrlFromState\(\)/);
  // Clear-filters resets state, focus and URL together.
  const clearHandler = source.slice(source.indexOf("elements.clearFilters.addEventListener('click'"));
  assert.match(clearHandler.slice(0, 520), /state\.focus = null/);
  assert.match(clearHandler.slice(0, 520), /syncUrlFromState\(\)/);
  // Clearing a focus is handled without a reload.
  assert.match(source, /data-clear-focus/);
  assert.match(source, /event\.preventDefault\(\);[\s\S]{0,160}state\.focus = null/);
  assert.match(source, /const nextQuery = queryAfterClearingFocus\(\)/);
  assert.match(source, /state\.query = nextQuery/);
  // No full-page reload or location assignment for investigation state.
  assert.doesNotMatch(source, /location\.reload\(/);
});

test('the styles keep the warm editorial system and colour is not the only signal', async () => {
  const styles = await readFile(new URL('src/web/styles.css', projectRoot), 'utf8');
  assert.match(styles, /\.focus-panel\s*\{/);
  assert.match(styles, /\.focus-panel-missing\s*\{/);
  assert.match(styles, /\.focus-facts\s*\{/);
  assert.match(styles, /\.sr-only\s*\{/);
  // The located row also carries a rule and weight, not colour alone.
  assert.match(styles, /tr\.focused-row > td:first-child\s*\{[^}]*box-shadow: inset 3px 0 0 var\(--accent\)/s);
  assert.match(styles, /tr\.focused-row > td\s*\{[^}]*font-weight: 620/s);
  // Warm editorial tokens only; no gradient or new palette.
  assert.doesNotMatch(styles, /gradient\(/);
  assert.match(styles, /--accent: #2d6a4f/);
});
