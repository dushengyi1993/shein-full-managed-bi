import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, projectRoot), 'utf8');
}

function functionBody(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, nextFunction === -1 ? source.length : nextFunction);
}

test('returns, finance and marketing no longer route through integrationGate', async () => {
  const app = await read('src/web/app.js');
  for (const name of ['renderReturns', 'renderFinance', 'renderMarketing']) {
    assert.doesNotMatch(functionBody(app, name), /integrationGate/);
  }
  // The only remaining caller is the legacy compliance page.
  assert.match(functionBody(app, 'renderCompliance'), /integrationGate\(\{/);
  assert.equal((app.match(/integrationGate\(\{/g) || []).length, 2);
});

test('home render keeps its locked composition and no new structure replaces it', async () => {
  const app = await read('src/web/app.js');
  const home = functionBody(app, 'renderHome');
  const blocks = [
    'renderTodayCoreCards()',
    'renderHistoryKpis()',
    'renderHistoryTrends()',
    'renderHistoryRankings()',
  ];
  const order = blocks.map((token) => home.indexOf(token));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
  // The locked-composition contract lives in the block comment directly above
  // renderHome; assert it on the source so a moved comment still fails closed.
  assert.match(app, /Vertical order is fixed/);
  assert.match(app, /首页噪音（pulse、supply radar、运营提醒）不再参与组装/);
  assert.doesNotMatch(home, /integrationGate/);
  assert.doesNotMatch(home, /opsTriageBoard|returnsEvidenceLane|productLifecycleBand/);

  // Finance and marketing share only the bounded /api/home data contract,
  // never the homepage layout.
  assert.match(app, /const HISTORY_DECISION_ROUTES = Object\.freeze\(\[[\s\S]*?'home'[\s\S]*?'finance'[\s\S]*?'marketing'/);
  assert.match(app, /The homepage keeps its locked composition/);
  assert.match(app, /reuse only the data contract, not the homepage layout\./);
  for (const name of ['renderFinance', 'renderMarketing']) {
    assert.doesNotMatch(
      functionBody(app, name),
      /renderTodayCoreCards|renderHistoryKpis|renderHistoryTrends|renderHistoryRankings/,
    );
  }
});

test('returns page composes four independent evidence lanes and never renders PARTIAL as zero', async () => {
  const app = await read('src/web/app.js');
  const returns = functionBody(app, 'renderReturns');
  const ids = app.match(/const RETURNS_CASE_PAGE_IDS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(ids, 'RETURNS_CASE_PAGE_IDS must exist');
  for (const pageId of ['return-applications', 'return-orders', 'exceptions', 'quality-reports']) {
    assert.match(ids[1], new RegExp(`'${pageId}'`));
  }
  assert.match(returns, /RETURNS_CASE_PAGE_IDS\.map/);
  assert.match(returns, /returnsEvidenceLane\(queryData, pageId\)/);
  assert.match(returns, /returnsCoverageLabel\(domain\)/);
  assert.match(returns, /四列是四类业务实体，不是同一批案件的连续阶段，因此不能横向相减或相加/);
  assert.match(returns, /退货地址、联系人、手机号等 PII 不进入本接口或页面/);
  assert.doesNotMatch(returns, /integrationGate/);

  const state = functionBody(app, 'returnsQueryState');
  assert.match(state, /任一域缺失都不会被当成零/);

  const display = functionBody(app, 'returnsDomainDisplay');
  assert.match(display, /count === null/);
  assert.match(display, /coverage\?\.status === 'COMPLETE'/);
  assert.match(display, /count > 0 \? `≥/);
  assert.match(display, /'—'/);

  const tone = functionBody(app, 'returnsCoverageTone');
  assert.match(tone, /'COMPLETE'/);
  assert.match(tone, /'PARTIAL'/);
  assert.match(tone, /'unavailable'/);

  const lane = functionBody(app, 'returnsEvidenceLane');
  assert.match(lane, /domain\.status === 'UNAVAILABLE'/);
  assert.match(lane, /不按 0 处理/);
  assert.match(lane, /不代表平台业务数量为 0/);

  const card = functionBody(app, 'returnsEvidenceCard');
  assert.match(card, /orderSensitiveKey\(item\.name\)/);
  const sensitivePattern = app.match(/const ORDER_SENSITIVE_KEY_PATTERN = \/([^/]+)\/i;/);
  assert.ok(sensitivePattern, 'ORDER_SENSITIVE_KEY_PATTERN must exist');
  for (const token of ['address', 'contact', 'phone', 'mobile', 'recipient', '收件', '电话', '手机', '地址', '联系人', '门牌', '街道']) {
    assert.match(sensitivePattern[1], new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }

  const invalidate = functionBody(app, 'invalidateReturnsScope');
  assert.match(invalidate, /state\.returns\.data = null/);
  const schedule = functionBody(app, 'scheduleReturnsLoad');
  assert.match(schedule, /invalidateReturnsScope\(\)/);
  assert.ok(
    schedule.indexOf('invalidateReturnsScope()') < schedule.indexOf('render();'),
    'old-scope returns data must be cleared before the new scope renders',
  );
  const routeSync = functionBody(app, 'syncRouteFromLocation');
  assert.ok(
    routeSync.indexOf('invalidateReturnsScope()') < routeSync.indexOf('render();'),
    'hash scope changes must invalidate old returns data before rendering',
  );
  assert.match(
    app,
    /elements\.search\.addEventListener\('input',[\s\S]*?syncUrlFromState\(\);\s+if \(state\.route === 'returns'\) invalidateReturnsScope\(\);\s+render\(\);/,
  );
  assert.match(
    app,
    /elements\.scope\.addEventListener\('change',[\s\S]*?syncUrlFromState\(\);\s+if \(state\.route === 'returns'\) invalidateReturnsScope\(\);\s+render\(\);/,
  );
});

test('product five stages are evidence stages, not a funnel', async () => {
  const app = await read('src/web/app.js');
  const band = functionBody(app, 'productLifecycleBand');
  assert.match(band, /五阶段经营证据/);
  for (const label of ['资料与身份', '审核与上架', '价格与议价', '经营与库存', '质量与合规']) {
    assert.match(band, new RegExp(`label: '${label}'`));
  }
  assert.match(band, /“能力已审”只表示接口合同已确认，不表示当前 25 店有完整业务事实/);
  assert.match(band, /待事实包络/);
  assert.doesNotMatch(band, /漏斗|转化率|转化/);

  const flow = functionBody(app, 'productPipelineFlow');
  assert.match(flow, /四个阶段数量均显示未知，不显示 0/);
  assert.doesNotMatch(flow, /漏斗/);
});

test('procurement six entities stay independent snapshots without funnel semantics', async () => {
  const app = await read('src/web/app.js');
  const lifecycle = functionBody(app, 'procurementLifecycle');
  for (const code of ['purchase_order', 'stock_record', 'shipping_order', 'delivery_note', 'waybill', 'receiving']) {
    assert.match(lifecycle, new RegExp(`code: '${code}'`));
  }
  // Independent detail pages keep an unknown count instead of a fabricated zero.
  assert.match(lifecycle, /count: null/);
  assert.match(lifecycle, /note: '独立明细'/);

  const procurement = functionBody(app, 'renderProcurement');
  assert.match(procurement, /六类实体快照/);
  assert.match(procurement, /每列独立取数、独立覆盖，不连线、不相减，不作为转化漏斗/);
  assert.match(procurement, /receiptDifferenceComplete/);

  const display = functionBody(app, 'procurementEvidenceValue');
  assert.match(display, /complete === true/);
  assert.match(display, /value > 0 \? `≥/);
  assert.match(display, /'—'/);
});

test('finance aggregates stay unknown unless every scoped store and date is covered', async () => {
  const app = await read('src/web/app.js');
  const amounts = functionBody(app, 'financePeriodAmount');
  const units = functionBody(app, 'financePeriodUnits');
  for (const body of [amounts, units]) {
    assert.match(body, /homeMetricCoverage/);
    assert.match(body, /coverage\.total === 0 \|\| coverage\.complete !== coverage\.total/);
    assert.match(body, /return null/);
  }

  const bridge = functionBody(app, 'financeLedgerBridge');
  for (const key of ['ledgerBeginCount', 'ledgerInboundCount', 'ledgerOutboundCount', 'ledgerEndCount']) {
    assert.match(bridge, new RegExp(`financePeriodUnits\\(bundle, '${key}'`));
  }

  const waterfall = functionBody(app, 'financeWaterfall');
  assert.match(waterfall, /finance-waterfall-unknown/);
  assert.match(waterfall, /事实未知/);
  assert.doesNotMatch(waterfall, /Math\.abs\(value \?\? 0\)/);

  const finance = functionBody(app, 'renderFinance');
  assert.match(finance, /pendingCountsComplete/);
  assert.match(finance, /pendingDatesComplete/);
  assert.match(finance, /pendingReportCount: pendingCountsComplete/);
  assert.match(finance, /pendingMetricCurrency === currency/);

  const currency = functionBody(app, 'financeMetricCurrency');
  assert.match(currency, /key\.startsWith\('ledger'\)/);
  assert.match(currency, /'ledgerCurrency'/);
  assert.match(currency, /metricRows\.some\(\(row\) => !row\[currencyKey\]\)/);
  assert.match(amounts, /financeMetricCurrency\(bundle, key\)/);
});

test('ops board renders the three server triage lanes with explicit dueAt discipline', async () => {
  const app = await read('src/web/app.js');
  const board = functionBody(app, 'opsTriageBoard');
  assert.match(board, /运营事项三泳道/);
  assert.match(board, /opsTriageLane\('now', '现在处理'/);
  assert.match(board, /opsTriageLane\('today', '今日截止'/);
  assert.match(board, /无 dueAt 不进入/);
  assert.match(board, /opsTriageLane\('watch', '继续观察'/);

  const card = functionBody(app, 'opsTriageCard');
  assert.match(card, /无明确截止/);
  assert.match(card, /item\.dueAt \? sourceTime\(item\.dueAt\)/);

  const lane = functionBody(app, 'opsTriageLane');
  assert.match(lane, /lane\?\.completeness === 'COMPLETE'/);
  assert.match(lane, /`≥ \$\{numberFormatter\.format\(rows\.length\)\}`/);
  assert.match(lane, /不把缺口算成 0/);

  const url = functionBody(app, 'opsQueryUrl');
  assert.match(url, /owner: state\.owner/);
  assert.match(url, /store: state\.store/);
  assert.match(url, /view: allowListedToken\(state\.ops\.view/);
  assert.match(url, /severity: allowListedToken\(state\.ops\.severity/);
  assert.match(url, /domain: allowListedToken\(state\.ops\.domain/);
  assert.match(url, /quick: opsQuickValue\(\)/);
  assert.match(url, /pageSize: String\(pageSizeParam\(state\.ops\.pageSize\)\)/);

  const load = functionBody(app, 'loadOps');
  assert.match(load, /result\.readOnly !== true/);
  assert.match(load, /Array\.isArray\(result\.worklist\?\.rows\)/);
  assert.match(load, /result\.summary\.attentionByStore/);
});

test('system capability rack discloses a single-store audit with unknown portfolio coverage', async () => {
  const app = await read('src/web/app.js');
  const evidence = functionBody(app, 'systemCapabilityEvidence');
  assert.match(evidence, /单店现场样本 · 25 店覆盖未知/);
  assert.match(evidence, /<dt>组合覆盖<\/dt><dd>未知<\/dd>/);
  assert.match(evidence, /不证明 25 店已采集/);
  assert.match(evidence, /auditHash\.slice\(0, 16\)/);
  assert.match(evidence, /脱敏合同 SHA-256；不是业务数据哈希/);
  assert.doesNotMatch(evidence, /25\/25/);

  const system = functionBody(app, 'renderSystem');
  assert.match(system, /低频平台能力证据架/);
  assert.match(system, /单店现场审计与 25 店生产覆盖严格分开/);
  assert.match(system, /systemCapabilityEvidence\(queryData\)/);
});
