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

test('home opens with one editorial verdict band: conclusions left, scope and fact time right', async () => {
  const [app, styles] = await Promise.all([
    read('src/web/app.js'),
    read('src/web/styles.css'),
  ]);
  const header = functionBody(app, 'homeHeader');
  const today = functionBody(app, 'homeTodayVerdict');
  const momentum = functionBody(app, 'homeMomentumVerdict');

  // The band is a horizontal editorial strip, not a card grid.
  assert.match(styles, /\.home-topbar\s*\{/);
  assert.match(header, /<header class="home-topbar home-verdict" aria-label="首屏经营结论">/);
  assert.match(header, /<h1>全托经营驾驶舱<\/h1>/);
  assert.match(header, /class="verdict-primary"/);
  assert.match(header, /class="verdict-secondary"/);
  assert.match(header, /homeTodayVerdict\(units\)/);
  assert.match(header, /homeMomentumVerdict\(units\)/);
  assert.doesNotMatch(header, /business-pulse-grid|pulse-card|overview-matrix-card/);

  // Right context: scope, business date, generation time and honest flags.
  assert.match(header, /<dt>当前范围<\/dt>/);
  assert.match(header, /<dt>主要事实业务日<\/dt>/);
  assert.match(header, /<dt>数据生成时间<\/dt>/);
  assert.match(header, /<dt>数据状态<\/dt>/);
  assert.match(header, /live: 'live · 云端事实'/);
  assert.match(header, /sample: 'example · 示例数据'/);
  assert.match(header, /empty: 'empty · 暂无快照'/);
  assert.match(header, /'unknown · 状态待确认'/);
  assert.match(header, /'partial · 部分覆盖'/);

  // Main conclusion: today vs yesterday, in natural language, never a fake 0%.
  assert.match(today, /isUnit\(today\)/);
  assert.match(today, /isUnit\(yesterday\)/);
  assert.match(today, /不能当作 0 判断经营节奏/);
  assert.match(today, /昨日窗口缺失，不做增降结论/);
  assert.match(today, /与昨日持平/);
  assert.match(today, /今日仍在累计，并非完整自然日/);
  assert.doesNotMatch(today, /[¥€]|\bGMV\b|订单数|利润/i);

  // Secondary conclusion: the only comparable momentum, or an honest refusal.
  assert.match(momentum, /comparableDailySignal\(\{ unitsSold: units \}\)/);
  assert.match(momentum, /signal\.recent === null/);
  assert.match(momentum, /日均动量不可比/);
  assert.match(momentum, /formatDailyAverage\(signal\.recent\)/);
  assert.match(momentum, /formatDailyAverage\(signal\.previous\)/);
  assert.match(momentum, /不按百分比解读/);

  // The verdict numbers ignore the search box like every other KPI.
  assert.match(header, /scopedUnits\(\{ ignoreQuery: true \}\)/);
});

test('home assembles KPI tables, vertical trends and rankings without a redundant heading block', async () => {
  const app = await read('src/web/app.js');
  const home = functionBody(app, 'renderHome');

  const order = [
    'renderHistoryKpis()',
    'renderHistoryTrends()',
    'renderHistoryRankings()',
    'home-footnote',
  ].map((marker) => home.indexOf(marker));
  assert.ok(order.every((index) => index !== -1), '首页历史经营区块都必须存在');
  assert.deepEqual(order, [...order].sort((left, right) => left - right));

  assert.doesNotMatch(home, /homeBusinessPulse|supplyRadar|renderOperationalPriorities/);
  assert.doesNotMatch(home, /homeTruthStrip|trendCoverageBanner|homeSectionHeading/);
  assert.match(home, /缺失金额时回退为 OpenAPI 财务报账收入\/净额/);
  assert.match(home, /不等同消费者下单日 GMV/);
  assert.match(home, /“销量 × 最新财务单价”得到会单独标记估算/);
  assert.doesNotMatch(app, /function renderHistoryHomeHeader\(\)/);
  const trends = functionBody(app, 'renderHistoryTrends');
  assert.ok(trends.indexOf("'日趋势'") < trends.indexOf("'月趋势'"));
  assert.match(trends, /home-history-trends/);
});

test('home names every loading group and offers an explicit cache refresh', async () => {
  const [app, html, styles] = await Promise.all([
    read('src/web/app.js'),
    read('src/web/index.html'),
    read('src/web/styles.css'),
  ]);
  const home = functionBody(app, 'renderHome');
  const homePath = functionBody(app, 'homeApiPath');
  const dashboardLoad = functionBody(app, 'loadDashboard');
  assert.match(home, /店铺经营日数据/);
  assert.match(home, /财务日报与净成交额/);
  assert.match(home, /主销地区与销量趋势/);
  assert.match(home, /货号金额 \/ 销量排行候选/);
  assert.match(home, /data-home-force-refresh/);
  assert.match(home, /当前日期范围已经加载完成，但没有经营历史数据/);
  assert.match(home, /data-home-latest-date/);
  assert.match(home, /首页数据已就绪/);
  assert.match(html, /id="force-refresh"[^>]*>强制刷新缓存<\/button>/);
  assert.match(homePath, /if \(force\) params\.set\('refresh', '1'\)/);
  assert.match(dashboardLoad, /\/api\/dashboard\?refresh=1/);
  assert.match(styles, /\.home-loading-list\s*\{/);
  assert.match(styles, /\.home-cache-status\s*\{/);
});

test('monthly trend and store quantity stay useful with explicitly labelled finance fallback', async () => {
  const app = await read('src/web/app.js');
  const monthly = functionBody(app, 'groupHistoryByMonth');
  const period = functionBody(app, 'periodMetric');
  const rankings = functionBody(app, 'renderHistoryRankings');

  assert.match(monthly, /availableMetricSum\(item\.rows, key\)/);
  assert.match(monthly, /availableSignedMetricSum\(item\.rows, key\)/);
  assert.match(period, /key === 'salesQuantity'[\s\S]*bundle\.financeDaily, 'goodsCount'/);
  assert.match(rankings, /storeQuantityBasis === 'FINANCE' \? '店铺财务明细件数排行'/);
  assert.match(rankings, /来自报账销售款明细 goodsCount/);
});

test('historical KPI cards stay row-balanced and expose only evidence-backed traffic derivations', async () => {
  const app = await read('src/web/app.js');
  const metrics = functionBody(app, 'historyMetricRows');
  const kpis = functionBody(app, 'renderHistoryKpis');

  assert.match(metrics, /'paymentOrderCount'/);
  assert.match(metrics, /key: 'detailPaymentRate'/);
  assert.match(metrics, /ratePointChange\(trafficRate, previousTrafficRate\)/);
  assert.match(kpis, /homeMetricTable\('成交与支付'[^]*summary\.transactionRows, summary\.range, previousRange\)/);
  assert.match(kpis, /homeMetricTable\('流量表现'[^]*summary\.trafficRows, summary\.range, previousRange\)/);
  assert.match(kpis, /homeMetricTable\('供给与新客'[^]*summary\.supplyRows, summary\.range, previousRange\)/);
  assert.match(kpis, /Array\.from\(\{ length: 4 \}/);
  assert.match(kpis, /销量 Top 4/);
  assert.match(kpis, /previousHomeDateRange\(summary\.range\)/);
  const table = functionBody(app, 'homeMetricTable');
  assert.match(table, /<strong>本期<\/strong>/);
  assert.match(table, /<strong>前期<\/strong>/);
  assert.match(table, />较前期</);
  assert.doesNotMatch(table, /当前区间|上个等长区间/);
});

test('KPI matrix is one dense real table with legal comparisons only', async () => {
  const [app, parity] = await Promise.all([
    read('src/web/app.js'),
    read('src/web/home-parity.css'),
  ]);
  const kpis = functionBody(app, 'homeKpis');
  const change = functionBody(app, 'windowChange');
  const coverage = functionBody(app, 'windowFactCoverage');

  // One table: four windows as columns, measures as rows, one note column.
  assert.match(kpis, /<section class="home-kpi" aria-label="销量 KPI 数据矩阵">/);
  assert.match(kpis, /class="metric-matrix-scroll home-kpi-scroll"/);
  assert.match(kpis, /class="home-kpi-table"/);
  assert.equal((kpis.match(/<table/g) || []).length, 1);
  assert.match(kpis, /<th scope="col" class="note-column">口径说明<\/th>/);
  for (const rowLabel of ['销量', '日均销量', '可比变化', '店铺 / 货号覆盖']) {
    assert.match(kpis, new RegExp(`<th scope="row">${rowLabel.replace('/', '\\/')}<\\/th>`), rowLabel);
  }
  assert.match(kpis, /WINDOW_KEYS\.map\(\(key\) => `<th scope="col" class="num">/);
  assert.match(kpis, /formatUnits\(units\[key\]\)/);
  assert.match(kpis, /formatAverage\(units\[key\], RANGE_META\[key\]\.days\)/);
  assert.match(kpis, /windowFactCoverage\(key, \{ ignoreQuery: true \}\)/);
  assert.match(kpis, /windowChange\(key, units\)/);
  assert.match(kpis, /factSourceNote\('缺失窗口保持 —，不补零也不估算'\)/);

  // Change only exists where a same-caliber baseline exists; elsewhere —.
  assert.match(kpis, /change\.label === '不可比' \? '—' : escapeHtml\(change\.label\)/);
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

  // Coverage counts only entities that actually carry a fact for that window.
  assert.match(coverage, /isUnit\(item\?\.unitsSold\?\.\[windowKey\]\)/);
  assert.match(coverage, /scopedProductRanking\(\{ ignoreQuery \}\)/);
  assert.match(coverage, /storeTotal/);
  assert.match(coverage, /productTotal/);

  // The dense table scrolls horizontally with a pinned first column.
  assert.match(parity, /\.home-kpi-table\s*\{[^}]*min-width: 760px/s);
  assert.match(parity, /\.home-kpi-table tbody th\[scope="row"\]\s*\{[^}]*position: sticky[^}]*left: 0/s);
  assert.match(parity, /\.home-kpi-table \.num\s*\{[^}]*font-variant-numeric: tabular-nums[^}]*text-align: right/s);
});

test('unsupported amount, traffic and order metrics live only in the single caliber footnote', async () => {
  const app = await read('src/web/app.js');
  const kpis = functionBody(app, 'homeKpis');
  const footnote = functionBody(app, 'homeFootnote');
  const home = functionBody(app, 'renderHome');

  // No finance or consumer block anywhere in the home assembly.
  assert.doesNotMatch(kpis, /财务与结算|实时金额|结算金额|流量与支付人数/);
  assert.doesNotMatch(home, /财务与结算/);
  assert.doesNotMatch(kpis, /[¥€]|\bSAR\b|\bRMB\b|\bGMV\b|订单数|转化率|支付人数/i);

  // Exactly one footnote sentence states the boundary.
  assert.match(footnote, /财务与结算、流量、订单等指标尚未接入，不由销量推导金额/);
  assert.match(footnote, /未知为 —，合法零为 0，缺失不补零、不插值/);
  assert.doesNotMatch(footnote, /\d+%|metricValue|formatUnits/);
});

test('daily trend uses real day-grain points and names the real window length', async () => {
  const app = await read('src/web/app.js');
  const daily = functionBody(app, 'renderTrendChart');
  const windowLabel = functionBody(app, 'trendWindowLabel');
  const rowsForRange = functionBody(app, 'trendRowsForRange');
  const emptyMessage = functionBody(app, 'trendEmptyMessage');

  // The four ranges have real branches: 7 recent day-grain points for the
  // short windows, up to 30 for the 30-day request — never padded, never the
  // four pre-aggregated window values plotted as a series.
  assert.match(rowsForRange, /state\.range === 'last30Days'/);
  assert.match(rowsForRange, /rows\.slice\(-30\)/);
  assert.match(rowsForRange, /rows\.slice\(-7\)/);
  assert.doesNotMatch(rowsForRange, /unitsSold\.last7Days|scopedUnits/);

  // Titles state the actual day count instead of promising 7 or 30 days.
  assert.match(windowLabel, /最近 30 个业务日/);
  assert.match(windowLabel, /请求最近 30 日 · 实际 \$\{numberFormatter\.format\(rows\.length\)\} 个业务日/);
  assert.match(windowLabel, /最近 7 个业务日/);
  assert.match(windowLabel, /不足 7 日，缺口不补零/);

  // Real points only, explicit empty state, readable axes and hover.
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
});

test('monthly trend aggregates day-grain facts and refuses a single fake bar', async () => {
  const app = await read('src/web/app.js');
  const monthRows = functionBody(app, 'monthlyTrendRows');
  const monthly = functionBody(app, 'renderMonthlyTrendChart');
  const monthCoverage = functionBody(app, 'monthlyCoverageLabel');

  // Grouped from day-grain facts only, never from the rolling windows.
  assert.match(monthRows, /row\.date\.slice\(0, 7\)/);
  assert.match(monthRows, /calendarDays/);
  assert.match(monthRows, /complete: calendarDays !== null && row\.days\.size >= calendarDays/);
  assert.match(monthRows, /\.slice\(-12\)/);
  assert.doesNotMatch(monthRows, /last7Days|last30Days|scopedUnits/);

  // Fewer than two usable months is an explicit empty state, not one fake bar.
  assert.match(monthly, /rows\.length < 2/);
  assert.match(monthly, /emptyEvidence\(/);
  assert.match(monthly, /需要至少两个月，当前只有一个部分月；不会画一根假柱冒充月趋势/);
  assert.match(monthly, /缺少第二个可比月份/);
  assert.match(monthly, /不会把四个窗口累计值伪造成月趋势/);
  assert.match(monthly, /class="chart-bar\$\{bar\.complete \? '' : ' partial'\}"/);
  assert.match(monthly, /部分覆盖 · 不代表整月合计/);
  assert.match(monthly, /class="chart-hit"[^`]*tabindex="0"/);
  assert.match(monthCoverage, /个自然月全部按完整日粒度事实归集/);
  assert.match(monthCoverage, /个仅部分覆盖/);
  assert.match(monthCoverage, /暂无可归月的日粒度事实/);
});

test('search narrows only rankings and never blanks trends, KPI or store scope', async () => {
  const app = await read('src/web/app.js');
  const trendSource = functionBody(app, 'trendSourceRows');
  const scopedTrend = functionBody(app, 'scopedTrendSeries');
  const kpis = functionBody(app, 'homeKpis');
  const scoped = functionBody(app, 'scopedUnits');
  const storeRows = functionBody(app, 'homeStoreRows');
  const productRows = functionBody(app, 'homeProductRows');
  const emptyStore = functionBody(app, 'homeRankingEmptyMessage');

  // The trend source has no query branch at all.
  assert.doesNotMatch(trendSource, /normalizedQuery/);
  assert.match(trendSource, /state\.data\?\.salesTrend/);
  assert.match(trendSource, /scopedTrendSeries\(\)/);
  assert.match(trendSource, /scopedRows\.length \? scopedRows : globalRows/);
  assert.match(scopedTrend, /state\.data\?\.salesTrendByStore/);
  assert.match(scopedTrend, /storeCodes\.has\(String\(row\?\.storeCode \|\| ''\)\)/);
  assert.doesNotMatch(app, /store\.salesTrend|owner\??\.salesTrend/);

  // KPI and verdict explicitly ignore the query; other pages keep the default.
  assert.match(scoped, /function scopedUnits\(\{ ignoreQuery = false \} = \{\}\)/);
  assert.match(scoped, /const query = ignoreQuery \? '' : normalizedQuery\(\)/);
  assert.match(kpis, /scopedUnits\(\{ ignoreQuery: true \}\)/);
  assert.match(kpis, /windowFactCoverage\(key, \{ ignoreQuery: true \}\)/);

  // The store ranking haystack covers store code, store name and owner name.
  assert.match(storeRows, /normalizedQuery\(\)/);
  assert.match(storeRows, /\[store\.code, store\.name, ownerNameForStore\(store\)\]/);
  assert.match(storeRows, /haystack\.includes\(query\)/);

  // The product ranking haystack covers product ids, names, store and owner.
  assert.match(productRows, /item\.skc/);
  assert.match(productRows, /item\.sku/);
  assert.match(productRows, /item\.standardProductName/);
  assert.match(productRows, /ownerNameForStoreCode\(item\?\.storeCode\)/);
  assert.match(productRows, /scopedProductRanking\(\{ ignoreQuery: true \}\)/);

  // No match is an explicit empty state that names the unaffected blocks.
  assert.match(emptyStore, /未命中店铺编码、店铺名称或负责人/);
  assert.match(emptyStore, /未命中货号、商品名或所属店铺/);
  assert.match(emptyStore, /趋势、KPI 与店铺范围不受搜索影响/);
});

test('ranking tables show four windows, tiered magnitude and scope-preserving drilldown', async () => {
  const [app, parity] = await Promise.all([
    read('src/web/app.js'),
    read('src/web/home-parity.css'),
  ]);
  const storeTable = functionBody(app, 'homeStoreRankingTable');
  const productTable = functionBody(app, 'homeProductRankingTable');
  const windowCells = functionBody(app, 'homeWindowCells');
  const meterCell = functionBody(app, 'homeMagnitudeCell');
  const momentumCell = functionBody(app, 'homeMomentumCell');
  const qualityCell = functionBody(app, 'homeStoreQualityCell');
  const ranked = functionBody(app, 'homeRankedRows');
  const rankingWindow = functionBody(app, 'homeRankingWindow');
  const storeDrill = functionBody(app, 'homeStoreDrilldownHref');
  const productDrill = functionBody(app, 'homeProductDrilldownHref');
  const rankMeta = functionBody(app, 'rankingCoverageNote');
  const home = functionBody(app, 'renderHome');

  // The four quantity windows are columns, sourced from WINDOW_KEYS only,
  // and the active window is visibly the primary value.
  assert.match(windowCells, /WINDOW_KEYS/);
  assert.match(windowCells, /formatUnits\(item\?\.unitsSold\?\.\[key\]\)/);
  assert.match(windowCells, /current-window/);
  assert.doesNotMatch(windowCells, /\|\| 0|\?\? 0/);
  for (const table of [storeTable, productTable]) {
    assert.match(table, /homeWindowCells\(item\)/);
    assert.match(table, /homeMagnitudeCell\(item, maximum\)/);
    assert.match(table, /homeMomentumCell\(item\)/);
    assert.match(table, /<th scope="col">量级<\/th>/);
    assert.match(table, /<th scope="col">可比动量<\/th>/);
    assert.match(table, /homeRankedRows\(rows\)/);
    assert.match(table, /emptyEvidence\(/);
    assert.match(table, /查看明细 →/);
  }

  // Bounded top list; unknown windows never enter the ordering.
  assert.match(ranked, /isUnit\(item\?\.unitsSold\?\.\[windowKey\]\)/);
  assert.match(ranked, /windowKey = homeRankingWindow\(\)\.key/);
  assert.match(ranked, /slice\(0, HOME_RANK_LIMIT\)/);
  assert.match(rankingWindow, /state\.range === 'yesterday'/);
  assert.match(rankingWindow, /scopedProductRanking\(\{ ignoreQuery: true \}\)/);
  assert.match(rankingWindow, /key: state\.range === 'yesterday' && !yesterdayAvailable \? 'today' : state\.range/);
  assert.match(app, /const HOME_RANK_LIMIT = 8/);

  // Magnitude bars exist only as CSS tier classes 1–20 — no inline styles.
  assert.match(app, /const HOME_METER_TIERS = 20/);
  assert.match(meterCell, /rank-meter-t\$\{tier\}/);
  assert.match(meterCell, /aria-label="当前窗口量级 \$\{tier\} \/ \$\{HOME_METER_TIERS\} 档"/);
  assert.match(meterCell, /rank-meter-empty/);
  assert.doesNotMatch(meterCell, /style=/);
  assert.match(parity, /\.rank-meter-t1 \{\s*width: 5%;\s*\}/);
  assert.match(parity, /\.rank-meter-t10 \{\s*width: 50%;\s*\}/);
  assert.match(parity, /\.rank-meter-t20 \{\s*width: 100%;\s*\}/);
  assert.equal((parity.match(/\.rank-meter-t\d+ \{/g) || []).length, 20);
  assert.match(parity, /\.rank-meter-fill\s*\{[^}]*background: var\(--accent\)/s);
  assert.doesNotMatch(parity, /rank-meter-fill\s*\{[^}]*gradient/s);

  // Momentum is the only comparable trend signal and names its two averages.
  assert.match(momentumCell, /comparableDailySignal\(item\)/);
  assert.match(momentumCell, /signal\.recent === null/);
  assert.match(momentumCell, /'缺完整窗口'/);
  assert.match(momentumCell, /formatDailyAverage\(signal\.recent\)/);
  assert.match(momentumCell, /formatDailyAverage\(signal\.previous\)/);

  // Store rows carry the owner inline; a missing owner is —, never guessed.
  assert.match(storeTable, /<th scope="col">店铺 \/ 负责人<\/th>/);
  assert.match(storeTable, /负责人 \$\{ownerNameForStore\(item\) \|\| '—'\}/);
  assert.doesNotMatch(storeTable, /待分配/);
  assert.match(storeTable, /homeStoreQualityCell\(item\)/);
  assert.match(qualityCell, /legal_zero: '合法零销量'/);
  assert.match(qualityCell, /partial: '部分覆盖'/);
  assert.match(qualityCell, /unavailable: '未接入'/);
  assert.match(qualityCell, /'覆盖待确认'/);

  // Product rows separate canonical identity from store-local identity.
  assert.match(productTable, /<th scope="col">身份边界<\/th>/);
  assert.match(productTable, /isCanonicalProduct\(item\)/);
  assert.match(productTable, /class="rank-identity \$\{canonical \? 'canonical' : 'local'\}"/);
  assert.match(productTable, /canonical \? '标准商品' : '店内身份'/);
  assert.match(productTable, /跨店 \$\{numberFormatter\.format\(item\.storeCount\)\} 店可合计/);
  assert.match(productTable, /店铺 \$\{item\.storeCode\} 内身份，禁止跨店合并/);
  assert.match(productTable, /'店内身份待确认'/);
  assert.doesNotMatch(productTable, /aggregateCanonicalProducts/);

  // Row body narrows the hash scope in place; drilldown preserves owner,
  // store, range and query — owner is never reset to ALL.
  assert.match(storeTable, /class="rank-entity" href="\$\{escapeHtml\(homeStoreScopeHref\(item\)\)\}"/);
  assert.match(productTable, /class="rank-entity" href="\$\{escapeHtml\(homeProductScopeHref\(item\)\)\}"/);
  for (const drill of [storeDrill, productDrill]) {
    assert.match(drill, /owner: state\.owner/);
    assert.match(drill, /range: state\.range/);
    assert.match(drill, /query: state\.query/);
    assert.doesNotMatch(drill, /owner: 'ALL'/);
  }
  assert.match(storeDrill, /route: 'sales'/);
  assert.match(productDrill, /route: 'products'/);
  assert.match(productDrill, /store: state\.store/);
  assert.doesNotMatch(productDrill, /URL_STORE_PATTERN|selectedStore\(\) \?/);

  // Legacy server coverage helpers remain for the sales workbench; the
  // homepage itself now uses date-grain historical facts and four rankings.
  assert.match(rankMeta, /rankingMeta\?\.\[kind\]/);
  assert.match(rankMeta, /服务端返回范围待确认/);
  assert.match(rankMeta, /已截断，未命中不代表没有销量/);
  assert.match(home, /renderHistoryRankings\(\)/);
  const historical = functionBody(app, 'renderHistoryRankings');
  assert.match(historical, /店铺成交金额排行/);
  assert.match(historical, /店铺销量排行/);
  assert.match(historical, /货号成交金额排行（估算）/);
  assert.match(historical, /货号销量排行/);
  assert.match(historical, /无匹配单价则不入榜/);
});

test('owner scope lives inside the single store selector with no separate owner control', async () => {
  const [html, app] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/app.js'),
  ]);
  const scopeOptions = functionBody(app, 'populateScopeOptions');

  assert.equal((html.match(/<select/g) || []).length, 1);
  assert.match(html, /<select id="scope-filter" aria-label="店铺或负责人范围"/);
  assert.doesNotMatch(html, /内含负责人分组/);
  assert.doesNotMatch(html, /id="owner-filter"|data-filter="owner"|name="owner"/);

  assert.match(scopeOptions, /createElement\('optgroup'\)/);
  assert.match(scopeOptions, /ownerGroup\.label = '负责人分组'/);
  assert.match(scopeOptions, /option\.value = `OWNER:\$\{owner\.key\}`/);
  assert.match(scopeOptions, /负责人 · \$\{owner\.name\}（\$\{owner\.storeCodes\.length\} 家店）/);
  assert.match(scopeOptions, /storeGroup\.label = '单个店铺（含负责人）'/);
  assert.match(scopeOptions, /const ownerName = ownerNameForStore\(store\)/);

  // Owner only narrows the visible scope; it is not a read-permission gate.
  assert.match(app, /负责人只影响查看范围，不表达读权限限制/);
  assert.doesNotMatch(app, /canSeeTechnicalGlobal|role === 'admin'/);
});

test('limited day-grain history is stated exactly and never padded into a full series', async () => {
  const app = await read('src/web/app.js');
  const history = functionBody(app, 'trendHistoryState');
  const notice = functionBody(app, 'trendHistoryNotice');
  const banner = functionBody(app, 'trendCoverageBanner');
  const home = functionBody(app, 'renderHome');

  // Coverage is counted from real dated rows only.
  assert.match(history, /trendSourceRows\(\)/);
  assert.match(history, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(history, /days: dates\.length/);
  assert.match(history, /completeMonths/);
  assert.match(history, /partialMonths/);
  assert.doesNotMatch(history, /last7Days|last30Days/);

  assert.match(notice, /当前真实日粒度历史只有/);
  assert.match(notice, /不代表 30 个完整日或任何完整自然月/);

  // The historical homepage uses only real dated rows and states the same
  // missing-day boundary in its chart empty state.
  assert.match(home, /renderHistoryTrends\(\)/);
  const historicalChart = functionBody(app, 'historyTrendChart');
  assert.match(historicalChart, /缺失不补零、不连线/);
  assert.match(historicalChart, /for \(const index of \[maxIndex, minIndex, 0, points\.length - 1\]\)/);
  assert.match(historicalChart, /minimumLabelGap/);
  assert.match(historicalChart, /class="chart-value-label"/);
  assert.match(historicalChart, /class="history-bar"/);

  // The banner helper stays available for callers outside home.
  assert.match(banner, /class="quality-notice/);
  assert.match(banner, /日粒度历史尚未建立/);
  assert.match(banner, /缺失的业务日和月份不会被补线或补零/);
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

test('semi-managed parity keeps proportional ranking bars and reduced-motion support', async () => {
  const [html, app, styles, parity] = await Promise.all([
    read('src/web/index.html'),
    read('src/web/app.js'),
    read('src/web/styles.css'),
    read('src/web/home-parity.css'),
  ]);
  const rankingTable = functionBody(app, 'historyRankTable');

  assert.doesNotMatch(html, /style="/);
  assert.doesNotMatch(rankingTable, /style="/);
  assert.match(rankingTable, /rank-item rank-fill-\$\{fillStep\} rank-tone-\$\{escapeHtml\(tone\)\}/);
  assert.match(app, /ownerDisplayTone\(ownerKey\)/);
  assert.match(app, /shortOwnerName\(row\.ownerName\)/);
  assert.match(app, /storeHistoryRankMeta\(next, 'amount'\)/);
  assert.match(app, /SKC 财务报账收入排行（待归并）/);
  assert.match(parity, /\.rank-item\.rank-fill-10::before \{ width: 100%; \}/);
  assert.match(parity, /\.rank-tone-owner-1,[\s\S]*--owner-color: #0f766e/);
  assert.match(parity, /\.rank-item::after[\s\S]*background: var\(--bar-color\)/);
  assert.match(parity, /\.rank-owner[\s\S]*background: var\(--owner-color\)/);
  assert.match(parity, /\.rank-owner[\s\S]*color: #fff/);
  assert.match(parity, /backdrop-filter: blur\(18px\)/);
  assert.match(parity, /prefers-reduced-motion/);
});

test('homepage range, trend labels and renewal cadence match the operating preference', async () => {
  const [app, parity, timer] = await Promise.all([
    read('src/web/app.js'),
    read('src/web/home-parity.css'),
    read('infra/systemd/shein-fm-session-renewal.timer'),
  ]);
  const chart = functionBody(app, 'historyTrendChart');

  assert.match(parity, /grid-template-columns: minmax\(220px, 250px\) minmax\(180px, 200px\) minmax\(900px, 1fr\) auto/);
  assert.match(parity, /grid-template-columns: minmax\(340px, 380px\) minmax\(540px, 1fr\)/);
  assert.match(parity, /@media \(max-width: 1650px\)[\s\S]*"range range range"/);
  assert.match(parity, /\.metric-matrix \.matrix-cell\.head\s*\{[^}]*margin: 0;[^}]*gap: 0;/s);
  assert.doesNotMatch(chart, /point\.currency/);
  assert.match(chart, /minimumLabelGap/);
  assert.match(chart, /Math\.abs\(existing - index\) >= minimumLabelGap/);
  assert.match(timer, /Description=Daily full-managed SHEIN Profile session renewal/);
  assert.match(timer, /OnCalendar=\*-\*-\* 03:20:00 Asia\/Shanghai/);
  assert.doesNotMatch(timer, /00,04,08,12,16,20/);
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
  assert.match(mobile, /\.metric-matrix-scroll\s*\{[^}]*overflow-x: auto;[^}]*overscroll-behavior-inline: contain/s);
  assert.match(mobile, /overflow-wrap: anywhere/);

  // Wide blocks scroll inside their own container instead of widening the page.
  assert.match(parity, /\.metric-matrix-scroll\s*\{[^}]*max-width: 100%[^}]*overflow-x: auto/s);
  assert.match(styles, /\.table-wrap\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*auto/s);
  assert.match(mobile, /\.home-kpi-table\s*\{[^}]*min-width: 560px/s);
  assert.match(mobile, /\.home-rank-table\s*\{[^}]*min-width: 680px/s);
  assert.match(mobile, /\.verdict-primary,[\s\S]*?white-space: normal/);

  // The mobile command bar is three compact rows, not four stacked controls.
  const compactIndex = parity.indexOf('@media (max-width: 720px)');
  const compact = parity.slice(compactIndex, mobileIndex);
  assert.match(compact, /"search search"\s*"scope range-summary"\s*"range-presets actions"/);
  assert.match(compact, /\.home-filter-bar \.range-dock,[\s\S]*?display: contents/);
  assert.match(compact, /\.home-filter-bar \.range-button\s*\{[^}]*grid-area: range-summary/s);
  assert.match(compact, /\.home-filter-bar \.range-preset-strip\s*\{[^}]*grid-area: range-presets/s);

  // 1400 keeps the first screen compact; 1280 turns the rail into a top bar.
  assert.match(parity, /@media \(min-width: 1400px\)[\s\S]*?\.home-kpi-table th,[\s\S]*?padding: 5px 10px/);
  assert.match(parity, /@media \(max-width: 1280px\)[\s\S]*?position: static/);
  assert.match(parity, /@media \(max-width: 1280px\)[\s\S]*?\.workspace\.main\s*\{[\s\S]*?margin-left: 0/);
});

test('1440px homepage keeps historical sections ordered and the trend stack vertical', async () => {
  const [app, parity] = await Promise.all([
    read('src/web/app.js'),
    read('src/web/home-parity.css'),
  ]);
  const home = functionBody(app, 'renderHome');

  const firstScreen = ['renderHistoryKpis()', 'renderHistoryTrends()']
    .map((marker) => home.indexOf(marker));
  assert.ok(firstScreen.every((index) => index !== -1));
  assert.deepEqual(firstScreen, [...firstScreen].sort((left, right) => left - right));
  const historicalTrends = functionBody(app, 'renderHistoryTrends');
  assert.ok(historicalTrends.indexOf("'日趋势'") < historicalTrends.indexOf("'月趋势'"));
  assert.match(parity, /\.home-history-trends\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);

  const desktopIndex = parity.indexOf('@media (min-width: 1400px)');
  assert.notEqual(desktopIndex, -1);
  const desktop = parity.slice(desktopIndex, parity.indexOf('@media', desktopIndex + 1));
  assert.match(desktop, /\.home-kpi\s*\{[^}]*margin-bottom: 10px/s);
  assert.match(desktop, /\.home-kpi-table th,[\s\S]*?padding: 5px 10px/);
});
