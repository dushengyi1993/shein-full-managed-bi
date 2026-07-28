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

test('home renders a compact head with scope, fact time and dataset state', async () => {
  const [app, styles] = await Promise.all([
    read('src/web/app.js'),
    read('src/web/styles.css'),
  ]);
  const header = functionBody(app, 'homeHeader');
  const strip = functionBody(app, 'homeTruthStrip');
  const home = functionBody(app, 'renderHome');

  // The head is a dense operating bar, not a landing-page hero.
  assert.match(styles, /\.home-topbar\s*\{/);
  assert.match(styles, /\.home-topbar h1\s*\{[^}]*font-size: clamp\(1\.32rem/s);
  assert.match(styles, /\.home-topbar-facts\s*\{/);

  assert.match(header, /<header class="home-topbar">/);
  assert.match(header, /<h1>全托经营驾驶舱<\/h1>/);
  assert.match(header, /当前范围 \$\{filterSummary\(\)\}/);
  assert.match(header, /<dt>主要事实业务日<\/dt>/);
  assert.match(header, /<dt>数据生成时间<\/dt>/);
  assert.match(header, /<dt>数据状态<\/dt>/);
  assert.match(header, /live: 'live · 云端事实'/);
  assert.match(header, /sample: 'example · 示例数据'/);
  assert.match(header, /empty: 'empty · 暂无快照'/);
  assert.match(header, /'unknown · 状态待确认'/);
  assert.match(header, /'partial · 部分覆盖'/);
  // A compact operating head, not a marketing hero.
  assert.doesNotMatch(header, /page-intro|hero/);

  assert.match(strip, /'业务日期'/);
  assert.match(strip, /'店铺覆盖'/);
  assert.match(strip, /'数据质量'/);
  assert.match(strip, /'当前窗口'/);
  assert.match(strip, /不使用抓取时间冒充业务日期/);
  assert.match(strip, /窗口口径独立取数，不跨业务日混算/);

  // Page order: head, truth strip, decision summary, matrix, supply radar,
  // trends, ranking tables, alerts.
  const order = [
    'homeHeader()',
    'homeTruthStrip()',
    'homeBusinessPulse()',
    '销售数据矩阵',
    'homeKpis()',
    'supplyRadar()',
    '趋势',
    'trendCoverageBanner()',
    '日销量趋势',
    '月销量趋势',
    '排行榜',
    'homeStoreRankingTable(storeRows)',
    'homeProductRankingTable(productRows)',
    'renderOperationalPriorities({ home: true })',
  ].map((marker) => home.indexOf(marker));
  assert.ok(order.every((index) => index !== -1), '每个首页区块都必须存在');
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
});

test('decision summary states each signal, why it matters and a scope-preserving drilldown', async () => {
  const app = await read('src/web/app.js');
  const pulse = functionBody(app, 'homeBusinessPulse');
  const today = functionBody(app, 'pulseTodaySignal');
  const momentum = functionBody(app, 'pulseMomentumSignal');
  const supply = functionBody(app, 'pulseSupplySignal');
  const trust = functionBody(app, 'pulseTrustSignal');
  const card = functionBody(app, 'pulseCard');

  // Four concrete decisions, in order, each rendered through one card helper.
  for (const signal of [
    'pulseTodaySignal(units)',
    'pulseMomentumSignal(units)',
    'pulseSupplySignal()',
    'pulseTrustSignal()',
  ]) {
    assert.ok(pulse.includes(signal), signal);
  }
  assert.match(card, /signal\.why/);
  assert.match(card, /signal\.evidence/);
  assert.match(card, /signal\.linkLabel/);

  // Today is never presented as a finished day.
  assert.match(today, /今日 vs 昨日/);
  assert.match(today, /今日仍在累计/);
  assert.match(today, /今日为当日累计，非完整自然日/);
  assert.match(today, /不能当作 0 判断经营节奏/);
  assert.match(today, /缺完整昨日窗口/);
  assert.match(today, /isUnit\(today\)/);
  assert.match(today, /isUnit\(yesterday\)/);

  // Momentum only exists where the two rolling windows are comparable.
  assert.match(momentum, /近 7 日日均 vs 此前 23 日日均/);
  assert.match(momentum, /comparableDailySignal\(\{ unitsSold: units \}\)/);
  assert.match(momentum, /signal\.recent === null/);
  assert.match(momentum, /'不可比'/);
  assert.match(momentum, /滚动窗口不是历史时间序列/);
  assert.match(momentum, /formatDailyAverage\(signal\.recent\)/);
  assert.match(momentum, /formatDailyAverage\(signal\.previous\)/);

  // Supply urgency uses current shortage, urgent, purchase and delivery facts
  // together with honest returned/total coverage.
  assert.match(supply, /attentionRows\('inventoryRisks'\)/);
  assert.match(supply, /attentionRows\('stockAdviceRisks'\)/);
  assert.match(supply, /attentionRows\('purchaseOrderAttention'\)/);
  assert.match(supply, /attentionRows\('deliveryAttention'\)/);
  assert.match(supply, /riskWindowMetric\(shortageRows, 'inventoryRisks', 'shortageQuantity'\)/);
  assert.match(supply, /riskWindowMetric\(urgentRows, 'stockAdviceRisks', 'plannedUrgentQuantity'\)/);
  assert.match(supply, /仅统计已物化明细，未命中不等于无风险/);
  assert.match(supply, /shortageMetric\.note/);

  // Trust names same-day coverage, mixed dates, quarantine and identity.
  assert.match(trust, /coverage\.coveredStores/);
  assert.match(trust, /coverage\.totalStores/);
  assert.match(trust, /当日覆盖 \$\{numberFormatter\.format\(covered\)\} \/ \$\{numberFormatter\.format\(total\)\} 家店/);
  assert.match(trust, /coverage\.mixedStatisticsDateStores/);
  assert.match(trust, /coverage\.quarantinedRows/);
  assert.match(trust, /identityCoverage\(\)/);
  assert.match(trust, /标准身份 \$\{numberFormatter\.format\(identity\.confirmed\)\}/);
  assert.match(trust, /businessDate\(\)/);

  // Every card keeps the current scope and adds no amount or consumer metric.
  for (const body of [today, momentum, supply, trust]) {
    assert.match(body, /homePulseHref\(/);
    assert.doesNotMatch(body, /[¥€]|\bSAR\b|\bRMB\b|\bGMV\b|订单数|利润|转化率|支付人数/i);
  }
});

test('limited day-grain history is stated exactly and never padded into a full series', async () => {
  const app = await read('src/web/app.js');
  const history = functionBody(app, 'trendHistoryState');
  const notice = functionBody(app, 'trendHistoryNotice');
  const banner = functionBody(app, 'trendCoverageBanner');

  // Coverage is counted from real dated rows only.
  assert.match(history, /trendSourceRows\(\)/);
  assert.match(history, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(history, /days: dates\.length/);
  assert.match(history, /completeMonths/);
  assert.match(history, /partialMonths/);
  assert.doesNotMatch(history, /last7Days|last30Days/);

  assert.match(notice, /当前真实日粒度历史只有/);
  assert.match(notice, /不代表 30 个完整日或任何完整自然月/);

  // The banner is a visible block, not a footnote, and refuses to fabricate.
  assert.match(banner, /class="quality-notice/);
  assert.match(banner, /trend-coverage-banner/);
  assert.match(banner, /日粒度历史尚未建立/);
  assert.match(banner, /不会被当作历史时间序列补线/);
  assert.match(banner, /缺失的业务日和月份不会被补线或补零/);
  assert.match(banner, /少于当前窗口请求的/);
  assert.match(banner, /目前没有任何完整自然月/);
  // A product search must not show a global trend as if it were product-scoped.
  assert.match(banner, /货号搜索生效时不展示全局走势，避免把全局趋势冒充商品趋势/);
});

test('sales matrix compares today, yesterday, last 7 and last 30 days with coverage and comparable change', async () => {
  const app = await read('src/web/app.js');
  const kpis = functionBody(app, 'homeKpis');
  const coverage = functionBody(app, 'windowFactCoverage');
  const change = functionBody(app, 'windowChange');
  const sourceNote = functionBody(app, 'factSourceNote');

  assert.match(app, /const WINDOW_KEYS = Object\.freeze\(\['today', 'yesterday', 'last7Days', 'last30Days'\]\)/);
  assert.match(app, /today: \{ label: '今日', note: '当日累计', days: 1 \}/);
  assert.match(app, /last7Days: \{ label: '近 7 日', note: '预聚合滚动窗口', days: 7 \}/);
  assert.match(app, /last30Days: \{ label: '近 30 日', note: '预聚合滚动窗口', days: 30 \}/);

  assert.match(kpis, /class="kpi-six sales-matrix" aria-label="销售数据矩阵"/);
  assert.match(kpis, /\['数量口径', \.\.\.windowLabels\]/);
  assert.match(kpis, /label: '销量'/);
  assert.match(kpis, /label: '本窗口日均'/);
  assert.match(kpis, /label: '覆盖 店铺 \/ 货号'/);
  assert.match(kpis, /label: '可比变化'/);
  assert.match(kpis, /formatAverage\(units\[key\], RANGE_META\[key\]\.days\)/);
  assert.match(kpis, /windowFactCoverage\(key\)/);
  assert.match(kpis, /windowChange\(key, units\)/);

  // Coverage counts only entities that actually carry a fact for that window.
  assert.match(coverage, /isUnit\(item\?\.unitsSold\?\.\[windowKey\]\)/);
  assert.match(coverage, /storeTotal/);
  assert.match(coverage, /productTotal/);

  // Change is computed only where the two windows share a caliber.
  assert.match(change, /缺完整昨日窗口/);
  assert.match(change, /对昨日 · 今日仍在累计/);
  assert.match(change, /priorTwentyThreeDays\(units\)/);
  assert.match(change, /近 7 日日均对此前 23 日日均/);
  assert.match(change, /API 未提供前日窗口/);
  assert.match(change, /API 未提供前 30 日窗口/);
  assert.ok(
    (change.match(/'不可比'/g) || []).length >= 3,
    '缺可比基线的窗口必须显示不可比，不得编造变化率',
  );

  // Every matrix block stamps source and freshness.
  assert.match(sourceNote, /来源 \$\{datasetStatus\(\) === 'sample'/);
  assert.match(sourceNote, /数据生成 \$\{formatDateTime\(state\.data\?\.updatedAt\)\}/);
  assert.match(sourceNote, /业务日 \$\{businessDate\(\) \|\| '待确认'\}/);
  assert.ok((kpis.match(/factSourceNote\(/g) || []).length >= 5, '每张矩阵卡都要带来源与新鲜度');
});

test('unsupported amount and consumer metrics never render as numbers', async () => {
  const app = await read('src/web/app.js');
  const kpis = functionBody(app, 'homeKpis');
  const finance = kpis.slice(kpis.indexOf("'财务与结算'"));

  assert.notEqual(kpis.indexOf("'财务与结算'"), -1);
  assert.match(finance, /实时金额 · WebAPI 来源验证中；结算金额 · 财务 OpenAPI 待接入/);
  assert.match(finance, /label: '实时金额'/);
  assert.match(finance, /label: '结算金额'/);
  assert.match(finance, /label: '流量与支付人数'/);
  assert.match(finance, /'WebAPI 来源验证中'/);
  assert.match(finance, /'财务 OpenAPI 待接入'/);
  assert.match(finance, /'不由销量推导'/);
  assert.match(finance, /没有可信金额事实前，这里不显示任何金额数字、0 或百分比。/);
  assert.ok((finance.match(/'未接入'/g) || []).length >= 3, '金额与消费者指标一律显示未接入');

  // No currency, no derived figure, no fake zero in the amount block.
  assert.doesNotMatch(finance, /[¥$€]|SAR|RMB|元|GMV/i);
  assert.doesNotMatch(finance, /metricValue\('\d/);
  assert.doesNotMatch(finance, /formatUnits|formatAverage|formatDelta|numberFormatter\.format/);
  assert.doesNotMatch(finance, /metricValue\('0'|: 0\b/);
});

test('daily trend uses real day-grain points and the month trend refuses fabricated totals', async () => {
  const app = await read('src/web/app.js');
  const daily = functionBody(app, 'renderTrendChart');
  const monthRows = functionBody(app, 'monthlyTrendRows');
  const monthly = functionBody(app, 'renderMonthlyTrendChart');
  const monthCoverage = functionBody(app, 'monthlyCoverageLabel');
  const emptyMessage = functionBody(app, 'trendEmptyMessage');

  // Daily: real points only, explicit empty state, readable axes and hover.
  assert.match(daily, /const rows = trendRowsForRange\(\)/);
  assert.match(daily, /rows\.length < 2 \|\| rows\.some\(\(row\) => !isUnit\(row\.unitsSold\)\)/);
  assert.match(daily, /emptyEvidence\('销量趋势暂不可画', trendEmptyMessage\(\)\)/);
  assert.match(daily, /class="chart-axis chart-axis-end"/);
  assert.match(daily, /class="chart-dot"/);
  assert.match(daily, /class="chart-hit"[^`]*tabindex="0"[^`]*data-tip="\$\{tip\}"/);
  assert.match(daily, /覆盖店铺 \$\{numberFormatter\.format\(point\.coveredStores\)\} 家/);
  assert.match(daily, /覆盖店铺数未知/);
  assert.match(daily, />件</);
  assert.match(emptyMessage, /不足两个日粒度点，暂时无法形成趋势/);
  assert.match(emptyMessage, /API 尚未提供可用的日粒度销量序列/);

  // Month: grouped from day-grain facts only, never from the rolling windows.
  assert.match(monthRows, /row\.date\.slice\(0, 7\)/);
  assert.match(monthRows, /calendarDays/);
  assert.match(monthRows, /complete: calendarDays !== null && row\.days\.size >= calendarDays/);
  assert.match(monthRows, /\.slice\(-12\)/);
  assert.doesNotMatch(monthRows, /last7Days|last30Days|scopedUnits/);
  assert.match(monthly, /emptyEvidence\(/);
  assert.match(monthly, /不会把四个窗口累计值伪造成月趋势/);
  assert.match(monthly, /class="chart-bar\$\{bar\.complete \? '' : ' partial'\}"/);
  assert.match(monthly, /部分覆盖 · 不代表整月合计/);
  assert.match(monthly, /class="chart-hit"[^`]*tabindex="0"/);
  assert.match(monthCoverage, /个自然月全部按完整日粒度事实归集/);
  assert.match(monthCoverage, /个仅部分覆盖/);
  assert.match(monthCoverage, /暂无可归月的日粒度事实/);
});

test('ranking tables show all four windows, comparable momentum and honest boundaries', async () => {
  const app = await read('src/web/app.js');
  const storeTable = functionBody(app, 'homeStoreRankingTable');
  const productTable = functionBody(app, 'homeProductRankingTable');
  const windowCells = functionBody(app, 'homeWindowCells');
  const momentumCell = functionBody(app, 'homeMomentumCell');
  const qualityCell = functionBody(app, 'homeStoreQualityCell');
  const ranked = functionBody(app, 'homeRankedRows');
  const rankMeta = functionBody(app, 'rankingCoverageNote');
  const home = functionBody(app, 'renderHome');

  // The four quantity windows are columns, sourced from WINDOW_KEYS only.
  assert.match(windowCells, /WINDOW_KEYS/);
  assert.match(windowCells, /formatUnits\(item\?\.unitsSold\?\.\[key\]\)/);
  assert.doesNotMatch(windowCells, /\|\| 0|\?\? 0/);
  for (const table of [storeTable, productTable]) {
    assert.match(table, /WINDOW_KEYS\.map\(\(key\) => `<th scope="col" class="number-column">\$\{escapeHtml\(RANGE_META\[key\]\.label\)\}<\/th>`\)/);
    assert.match(table, /homeWindowCells\(item\)/);
    assert.match(table, /homeMomentumCell\(item\)/);
    assert.match(table, /<th scope="col">可比动量<\/th>/);
    assert.match(table, /homeRankedRows\(rows\)/);
    assert.match(table, /emptyEvidence\(/);
  }

  // Momentum is the only comparable trend signal and names its two averages.
  assert.match(momentumCell, /comparableDailySignal\(item\)/);
  assert.match(momentumCell, /signal\.recent === null/);
  assert.match(momentumCell, /'缺完整窗口'/);
  assert.match(momentumCell, /formatDailyAverage\(signal\.recent\)/);
  assert.match(momentumCell, /formatDailyAverage\(signal\.previous\)/);

  // Unknown windows never enter the ordering and the list stays bounded.
  assert.match(ranked, /isUnit\(item\?\.unitsSold\?\.\[windowKey\]\)/);
  assert.match(ranked, /slice\(0, HOME_RANK_LIMIT\)/);
  assert.match(app, /const HOME_RANK_LIMIT = 8/);

  // Store rows carry the owner inline plus data quality and coverage.
  assert.match(storeTable, /<th scope="col">店铺 \/ 负责人<\/th>/);
  assert.match(storeTable, /<th scope="col">数据质量 \/ 覆盖<\/th>/);
  assert.match(storeTable, /ownerNameForStore\(item\)/);
  assert.match(storeTable, /负责人 \$\{ownerNameForStore\(item\) \|\| '待分配'\}/);
  assert.match(storeTable, /homeStoreQualityCell\(item\)/);
  assert.match(storeTable, /homeStoreDrilldownHref\(item\)/);
  assert.match(qualityCell, /legal_zero: '合法零销量'/);
  assert.match(qualityCell, /partial: '部分覆盖'/);
  assert.match(qualityCell, /unavailable: '未接入'/);
  assert.match(qualityCell, /'覆盖待确认'/);
  assert.match(qualityCell, /业务日 \$\{businessDay\}/);

  // Product rows separate canonical identity from store-local identity.
  assert.match(productTable, /<th scope="col">身份边界<\/th>/);
  assert.match(productTable, /isCanonicalProduct\(item\)/);
  assert.match(productTable, /class="rank-identity \$\{canonical \? 'canonical' : 'local'\}"/);
  assert.match(productTable, /canonical \? '标准商品' : '店内身份'/);
  assert.match(productTable, /跨店 \$\{numberFormatter\.format\(item\.storeCount\)\} 店可合计/);
  assert.match(productTable, /'跨店标准商品'/);
  assert.match(productTable, /店铺 \$\{item\.storeCode\} 内身份，禁止跨店合并/);
  assert.match(productTable, /'店内身份待确认'/);
  assert.match(productTable, /productCode\(item, canonical\)/);
  assert.match(productTable, /homeProductDrilldownHref\(item\)/);
  assert.doesNotMatch(productTable, /aggregateCanonicalProducts/);

  // Both tables sit on home with server coverage and truncation disclosed.
  assert.match(rankMeta, /rankingMeta\?\.\[kind\]/);
  assert.match(rankMeta, /服务端返回范围待确认/);
  assert.match(rankMeta, /已截断，未命中不代表没有销量/);
  assert.match(home, /homeStoreRankingTable\(storeRows\)/);
  assert.match(home, /homeProductRankingTable\(productRows\)/);
  assert.match(home, /rankingCoverageNote\('store'\)/);
  assert.match(home, /rankingCoverageNote\(productRankingKey\)/);
  assert.match(home, /标准商品与店铺本地 SKU 分别标记，未归并商品不会伪装成跨店标准商品/);
  assert.match(home, /不把滚动窗口当作历史时间序列/);
  assert.match(home, /命中数不是 SHEIN 仓库全量货号数/);
  // Home only shows a bounded top list and links to the full workspaces.
  assert.match(home, /查看完整店铺销量工作台 →/);
  assert.match(home, /查看完整商品身份与排行 →/);
});

test('owner scope lives inside the single store selector with no separate owner control', async () => {
  const [html, app] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/app.js'),
  ]);
  const scopeOptions = functionBody(app, 'populateScopeOptions');

  assert.equal((html.match(/<select/g) || []).length, 1);
  assert.match(html, /<select id="scope-filter" aria-label="店铺或负责人范围"/);
  assert.match(html, /内含负责人分组/);
  assert.doesNotMatch(html, /id="owner-filter"|data-filter="owner"|name="owner"/);

  assert.match(scopeOptions, /createElement\('optgroup'\)/);
  assert.match(scopeOptions, /ownerGroup\.label = '负责人分组'/);
  assert.match(scopeOptions, /option\.value = `OWNER:\$\{owner\.key\}`/);
  assert.match(scopeOptions, /storeGroup\.label = '单个店铺（含负责人）'/);
  assert.match(scopeOptions, /const ownerName = ownerNameForStore\(store\)/);

  // Owner only narrows the visible scope; it is not a read-permission gate.
  assert.match(app, /负责人只影响查看范围，不表达读权限限制/);
  assert.doesNotMatch(app, /canSeeTechnicalGlobal|role === 'admin'/);
});

test('operating alerts expose source, scope, severity, freshness and a read-only drill-down', async () => {
  const app = await read('src/web/app.js');
  const table = functionBody(app, 'priorityWorklistTable');
  const section = functionBody(app, 'renderOperationalPriorities');
  const items = functionBody(app, 'operationPriorityItems');
  const identity = functionBody(app, 'productIdentityAlertItems');
  const quality = functionBody(app, 'salesQualityAlertItems');
  const platform = functionBody(app, 'platformAlertItems');
  const sourceLabel = functionBody(app, 'itemSourceLabel');

  assert.match(app, /const GROUP_LABELS = Object\.freeze\(\{/);
  for (const label of ['采购单', '交付入仓', '库存与缺货', '备货建议', '商品身份', 'Webhook 事件', '数据质量与同步']) {
    assert.match(app, new RegExp(`: '${label}',`));
  }
  assert.match(sourceLabel, /item\?\.sourceLabel \|\| GROUP_LABELS\[item\?\.group\]/);

  assert.match(table, /<th scope="col">严重度<\/th>/);
  assert.match(table, /<th scope="col">来源域<\/th>/);
  assert.match(table, /<th scope="col">影响范围<\/th>/);
  assert.match(table, /<th scope="col">为何关注<\/th>/);
  assert.match(table, /<th scope="col">建议查看<\/th>/);
  assert.match(table, /<th scope="col">证据时间<\/th>/);
  assert.match(table, /severityBadge\(item\.severity\)/);
  assert.match(table, /itemSourceLabel\(item\)/);
  assert.match(table, /sourceTime\(item\.evidenceAt\)/);
  assert.match(table, /查看事实 →/);
  assert.match(table, /本批只读：这里只组织证据和建议查看的子页面，没有任何执行按钮/);
  assert.doesNotMatch(table, /<button|fetch\(/);

  assert.match(section, /'OPERATING ALERTS'/);
  assert.match(section, /home \? '运营提醒' : '运营待办队列'/);
  assert.match(section, /const sources = \[\.\.\.new Set\(rows\.map\(itemSourceLabel\)\)\]/);
  assert.match(section, /来源：\$\{sources\.join\('、'\)\}/);
  assert.doesNotMatch(section, /<button/);

  // Inventory, procurement, delivery, identity, webhook and data quality all feed the list.
  assert.match(items, /attentionRows\('inventoryRisks'\)/);
  assert.match(items, /attentionRows\('stockAdviceRisks'\)/);
  assert.match(items, /attentionRows\('purchaseOrderAttention'\)/);
  assert.match(items, /attentionRows\('deliveryAttention'\)/);
  assert.match(items, /\.\.\.productIdentityAlertItems\(\)/);
  assert.match(items, /\.\.\.salesQualityAlertItems\(\)/);
  assert.match(items, /\.\.\.platformAlertItems\(\)/);

  assert.match(identity, /sourceLabel: '商品身份归并'/);
  assert.match(identity, /unmappedStoreSkuRows\(\)/);
  assert.match(identity, /href: '#products'/);
  assert.match(identity, /销量影响存在缺失窗口，拒绝补零合计/);

  assert.match(quality, /sourceLabel: '销量数据质量'/);
  assert.match(quality, /href: '#system'/);
  assert.match(quality, /\['healthy', 'complete', 'legal_zero'\]\.includes\(quality\.status\)/);

  assert.match(platform, /sourceLabel: 'Webhook 队列'/);
  assert.match(platform, /sourceLabel: 'Webhook 运行态'/);
  assert.match(platform, /href: '#platform'/);
  assert.match(
    platform,
    /isUnit\(queue\.deadLetter\)\s*&&\s*queue\.deadLetter > 0/,
  );
  assert.match(platform, /nullableUnits\(queue\.expiredLeases, '未知'\)/);
});

test('truthfulness vocabulary separates real zero, unknown, not-integrated, partial, stale and sample', async () => {
  const app = await read('src/web/app.js');

  assert.match(app, /label: '合法为 0'/);
  assert.match(app, /label: '未接入', tone: 'unknown'/);
  assert.match(app, /legal_zero: '合法零销量'/);
  assert.match(app, /partial: '部分覆盖'/);
  assert.match(app, /stale: '数据已过期'/);
  assert.match(app, /error: '数据异常'/);
  assert.match(app, /unavailable: '数据未接入'/);
  assert.match(app, /示例数据环境/);
  assert.match(app, /本地示例数据（非真实经营结果）/);
  assert.match(app, /同步失败/);
  assert.match(app, /function formatUnits\(value\)[\s\S]*isUnit\(value\) \? numberFormatter\.format\(value\) : '—'/);
});

test('390px layout has explicit page-level overflow guards', async () => {
  const [styles, parity] = await Promise.all([
    read('src/web/styles.css'),
    read('src/web/home-parity.css'),
  ]);

  assert.match(styles, /html\s*\{[^}]*overflow-x:\s*clip/s);
  assert.match(styles, /body\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*clip/s);

  const mobileIndex = parity.indexOf('@media (max-width: 430px)');
  assert.notEqual(mobileIndex, -1, '首页样式必须有 390px 断点');
  const mobile = parity.slice(mobileIndex);
  assert.match(mobile, /\.workspace\.main\s*\{[^}]*max-width: 100%[^}]*overflow-x: clip/s);
  assert.match(mobile, /#view,\s*\n\s*#view > \*\s*\{[^}]*max-width: 100%/s);
  assert.match(mobile, /\.kpi-six,[\s\S]*grid-template-columns: 1fr;/);
  assert.match(mobile, /\.kpi-six \.matrix-span-2\s*\{\s*grid-column: span 1;/);
  assert.match(mobile, /\.metric-matrix-scroll\s*\{[^}]*overflow-x: auto;[^}]*overscroll-behavior-inline: contain/s);
  assert.match(mobile, /overflow-wrap: anywhere/);

  // Wide blocks scroll inside their own container instead of widening the page.
  assert.match(parity, /\.metric-matrix-scroll\s*\{[^}]*max-width: 100%[^}]*overflow-x: auto/s);
  assert.match(styles, /\.table-wrap\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*auto/s);

  // 1440 keeps four matrix columns; 1024 turns the rail into a top bar.
  assert.match(parity, /@media \(min-width: 1400px\)[\s\S]*?\.kpi-six\s*\{[\s\S]*?repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(parity, /@media \(max-width: 1280px\)[\s\S]*?position: static/);
  assert.match(parity, /@media \(max-width: 1280px\)[\s\S]*?\.workspace\.main\s*\{[\s\S]*?margin-left: 0/);
});

test('desktop partial-quality evidence spans the full content rail without pushing trends below the first screen', async () => {
  const parity = await read('src/web/home-parity.css');

  assert.match(
    parity,
    /@media \(min-width: 1400px\)[\s\S]*?#view > \.truth-strip \+ \.quality-notice\s*\{[^}]*width: 100%/s,
  );
  assert.match(
    parity,
    /@media \(min-width: 1400px\)[\s\S]*?\.quality-notice span\s*\{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s,
  );
});
