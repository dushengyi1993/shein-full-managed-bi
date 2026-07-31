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

test('supply pages consume real purchase, delivery, inventory and stock-advice contracts', async () => {
  const app = await read('src/web/app.js');
  const procurement = await read('src/server/procurement-query.mjs');
  const fulfilment = await read('src/server/fulfilment-query.mjs');
  const inventory = await read('src/server/inventory-query.mjs');

  assert.match(procurement, /purchaseOrderStatus/);
  assert.match(procurement, /purchaseOrderAttention/);
  assert.match(fulfilment, /deliveryMilestones/);
  assert.match(fulfilment, /deliveryAttention/);
  assert.match(inventory, /inventoryRisks/);
  assert.match(inventory, /stockAdviceRisks/);
  assert.match(app, /\/api\/procurement/);
  assert.match(app, /\/api\/fulfilment/);
  assert.match(app, /\/api\/inventory/);
  assert.match(app, /采购单关注队列/);
  assert.match(app, /交付入仓关注队列/);
  assert.match(app, /SKU 风险与备货筛查/);
  assert.match(app, /店铺 × 库存类型汇总/);
  // Procurement and fulfilment no longer render an unbounded per-store table.
  // Both now aggregate the scoped snapshot into a compact overview instead.
  assert.match(app, /采购单状态紧凑总览/);
  assert.match(app, /交付里程碑紧凑总览/);
  assert.doesNotMatch(app, /店铺×采购单状态汇总/);
  assert.doesNotMatch(app, /店铺×交付里程碑汇总/);
});

test('nullable operational quantities stay unknown and expose field coverage', async () => {
  const app = await read('src/web/app.js');
  const nullableFormatter = functionBody(app, 'nullableUnits');
  const nullableSum = functionBody(app, 'completeNullableSum');
  const coveredSum = functionBody(app, 'completeCoveredNullableSum');

  assert.match(nullableFormatter, /isUnit\(value\)/);
  assert.match(nullableFormatter, /unknownLabel = '—'/);
  assert.doesNotMatch(nullableFormatter, /Number\(|\|\| 0|\?\? 0/);
  assert.match(nullableSum, /values\.some\(\(value\) => !isUnit\(value\)\)/);
  assert.match(nullableSum, /return null/);
  assert.match(coveredSum, /coverage\.known === coverage\.total/);
  // Inventory and stock advice still aggregate coverage on the client.
  assert.match(app, /completeCoveredNullableSum\([\s\S]*shortageCoverage/);
  assert.match(app, /completeCoveredNullableSum\([\s\S]*advisedOrderCoverage/);
  assert.ok((app.match(/knownSkuCount', 'totalSkuCount'/g) || []).length >= 5);
  assert.match(app, /明确 0 才展示为 0/);
  assert.match(app, /拒绝补零合计/);

  // Fulfilment no longer aggregates delivery quantity in the browser: the
  // nullable count and quantity summaries arrive from `/api/fulfilment`, so the
  // dead client-side helper and its coverage pair are gone for good.
  assert.doesNotMatch(app, /deliveryQuantityCoverage/);
  assert.doesNotMatch(app, /knownLineCount', 'totalLineCount'/);
  const fulfilment = functionBody(app, 'fulfilmentDecisionOverview');
  assert.match(fulfilment, /productRecord\(summary\.snapshotDeliveryCount\)/);
  assert.match(fulfilment, /productRecord\(summary\.attentionDeliveryQuantity\)/);
  assert.match(fulfilment, /stageMetricValue\(total, '单'\)/);
  assert.match(fulfilment, /stageMetricValue\(attentionQuantity, '件'\)/);
  assert.match(fulfilment, /stageMetricNote\(attentionQuantity\)/);
  // Unknown stays unknown on the rendered path.
  assert.doesNotMatch(fulfilment, /\|\| 0\b|\?\? 0\b/);
  const metricValue = functionBody(app, 'stageMetricValue');
  const metricNote = functionBody(app, 'stageMetricNote');
  assert.match(metricValue, /isUnit\(source\.total\)/);
  assert.match(metricValue, /'未知'/);
  assert.doesNotMatch(metricValue, /\|\| 0\b|\?\? 0\b/);
  assert.match(metricNote, /拒绝补零合计/);

  // The independent server query owns the nullable aggregation instead.
  const fulfilmentQuery = await read('src/server/fulfilment-query.mjs');
  const nullable = functionBody(fulfilmentQuery, 'nullableSum');
  assert.match(nullable, /known\.length === 0 \? null : knownSum/);
  assert.match(nullable, /known\.length === inputRows\.length \? knownSum : null/);
  assert.match(fulfilmentQuery, /nullableSum\(scopedMilestoneRows, 'deliveryQuantity'\)/);
  assert.match(fulfilmentQuery, /nullableSum\(scopedMilestoneRows, 'deliveryCount'\)/);
});

test('owner, store and text filters scope all store-keyed operational rows', async () => {
  const app = await read('src/web/app.js');
  const queryFiles = await Promise.all([
    'procurement-query.mjs',
    'fulfilment-query.mjs',
    'inventory-query.mjs',
    'platform-query.mjs',
    'ops-query.mjs',
    'system-query.mjs',
  ].map((name) => read(`src/server/${name}`)));

  for (const query of queryFiles) {
    assert.match(query, /owner/);
    assert.match(query, /store/);
    assert.match(query, /\bq\b/);
  }
  assert.match(functionBody(app, 'systemQueryUrl'), /owner: state\.owner/);
  assert.match(functionBody(app, 'systemQueryUrl'), /store: state\.store/);
  assert.match(functionBody(app, 'systemQueryUrl'), /q: state\.query/);
  assert.doesNotMatch(app, /canSeeTechnicalGlobal|role === 'admin'/);
});

test('platform page prioritizes operator attention and keeps technical evidence honest', async () => {
  const app = await read('src/web/app.js');
  const render = functionBody(app, 'renderPlatform');
  const decision = functionBody(app, 'platformDecisionOverview');
  const disclosure = functionBody(app, 'platformEvidenceDisclosure');
  const timeline = functionBody(app, 'webhookEventTimeline');

  assert.match(render, /platformDecisionOverview\(queryData\)/);
  assert.match(render, /platformRankings\(queryData\)/);
  assert.match(render, /platformEventFilters\(queryData\)/);
  assert.match(render, /platformEvidenceDisclosure\(queryData\)/);
  assert.doesNotMatch(render, /process-flow|验签与快速回执/);
  assert.match(decision, /近 24 小时重点动态/);
  assert.match(decision, /高优先 \/ 处理失败/);
  assert.match(decision, /尚无回读记录，不等于已证明未订阅/);
  assert.match(timeline, /当前没有需要关注的平台动态/);
  assert.match(timeline, /普通成功回执仍可能只保留在技术审计中/);
  assert.match(disclosure, /Webhook 队列健康/);
  assert.match(disclosure, /订阅回读/);
  assert.match(disclosure, /验签与快速回执/);
  assert.match(app, /没有队列快照时不显示等待数、重试数或死信数为 0/);
  assert.match(app, /没有订阅回读时不把任何事件类型标记为已订阅或未订阅/);
  assert.doesNotMatch(app, /safeProjectionSummary/);
});

test('operations queue is server-paged, prioritized, localized, drillable and has no write control', async () => {
  const app = await read('src/web/app.js');
  const serverQuery = await read('src/server/ops-query.mjs');
  const ops = functionBody(app, 'renderOps');
  const overview = functionBody(app, 'opsDecisionOverview');
  const filters = functionBody(app, 'opsFilters');
  const evidence = functionBody(app, 'opsEvidenceDisclosure');
  const pagination = functionBody(app, 'opsPagination');

  assert.match(ops, /运营待办/);
  assert.match(ops, /opsDecisionOverview\(queryData\)/);
  assert.match(ops, /opsRankings\(queryData\)/);
  assert.match(ops, /opsPagination\(pagination, 'top'\)/);
  assert.match(overview, /紧急 \/ 高优先/);
  assert.match(overview, /逾期单据/);
  assert.match(overview, /缺货 SKU/);
  assert.match(overview, /急采 SKU/);
  assert.match(filters, /只看优先事项/);
  assert.match(filters, /同步 \/ 质量/);
  assert.match(evidence, /候选池只作补充/);
  assert.match(evidence, /writeEnabled/);
  assert.match(pagination, /当前条件命中/);
  assert.match(serverQuery, /SHORTAGE_REVIEW:[\s\S]*title: '缺货复核'/);
  assert.match(serverQuery, /URGENT_SUPPLY_REVIEW:[\s\S]*title: '急采复核'/);
  assert.match(serverQuery, /SUPPLY_SYNC_FAILURE_REVIEW:[\s\S]*title: '同步失败'/);
  assert.match(serverQuery, /PURCHASE_ORDER_OVERDUE:[\s\S]*domain: 'PROCUREMENT'/);
  assert.match(serverQuery, /DELIVERY_OVERDUE:[\s\S]*domain: 'FULFILMENT'/);
  assert.match(serverQuery, /SKU_SHORTAGE_REVIEW:[\s\S]*domain: 'INVENTORY'/);
  assert.match(serverQuery, /SKU_URGENT_SUPPLY_REVIEW:[\s\S]*domain: 'SUPPLY'/);
  assert.match(serverQuery, /businessWindowTruncated/);
  assert.match(app, /查看事实 →/);
  assert.doesNotMatch(ops, /<button/);
  assert.doesNotMatch(ops, /fetch\(|XMLHttpRequest|method:\s*['"]POST['"]/);
  assert.doesNotMatch(serverQuery, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
});

test('operating alerts aggregate supply, identity, webhook and data-quality evidence read-only', async () => {
  const app = await read('src/web/app.js');
  const worklist = functionBody(app, 'operationPriorityItems');
  const table = functionBody(app, 'priorityWorklistTable');
  const section = functionBody(app, 'renderOperationalPriorities');

  for (const helper of [
    'productIdentityAlertItems',
    'salesQualityAlertItems',
    'platformAlertItems',
    'itemSourceLabel',
  ]) {
    assert.match(app, new RegExp(`function ${helper}\\(`));
    if (helper !== 'itemSourceLabel') {
      assert.match(worklist, new RegExp(`\\.\\.\\.${helper}\\(\\)`));
    }
  }

  // Each row must name its source domain, impact, next page and evidence time.
  assert.match(table, /来源域/);
  assert.match(table, /itemSourceLabel\(item\)/);
  assert.match(table, /item\.impact \|\| '影响范围待回读'/);
  assert.match(table, /item\.nextStep \|\| '打开业务页核对事实'/);
  assert.match(table, /sourceTime\(item\.evidenceAt\)/);
  assert.match(section, /'OPERATING ALERTS'/);
  assert.match(section, /itemSourceLabel/);
  assert.doesNotMatch(table, /<button|<input|<form/);
  assert.doesNotMatch(section, /<button|fetch\(|method:\s*['"]POST['"]/);

  // Derived alerts stay inside the read-only drill-down contract.
  assert.match(app, /nextStep: '在商品中心按销量影响优先归并；未确认身份不参与跨店合计'/);
  assert.match(app, /nextStep: quality\.nextStep \|\| '在系统健康页核对覆盖水位、统计日与同步失败'/);
  assert.match(app, /nextStep: '在平台动态页核对死信原因、受阻店铺与补查指令'/);
  assert.match(app, /candidateTypes\.has\('WEBHOOK_DEAD_LETTER'\)/);
});

test('complete product ranking keeps canonical and store-local rows together without unsafe merging', async () => {
  const app = await read('src/web/app.js');
  const ranking = functionBody(app, 'rankingProducts');
  const scoped = functionBody(app, 'scopedProductRanking');
  const canonical = functionBody(app, 'isCanonicalProduct');

  assert.match(ranking, /rows: products/);
  assert.match(ranking, /confirmedRows/);
  assert.match(ranking, /localRows/);
  assert.doesNotMatch(ranking, /rows:\s*confirmedRows/);
  assert.match(scoped, /rows,/);
  assert.doesNotMatch(scoped, /aggregateCanonicalProducts\(rows\)/);
  assert.match(canonical, /mappingStatus/);
  assert.match(canonical, /canonicalProductId/);
  assert.match(canonical, /standardProductCode/);
  assert.match(canonical, /confirmedStoreSku/);
  assert.match(app, /完整商品排行（标准与店内身份分开）/);
  assert.match(app, /标准身份覆盖/);
  // The product queue is server-paged now: the old client-side 50-row slice is
  // gone and the pending queue is named after the identity workspace tab.
  assert.match(app, /待归并队列/);
  assert.match(app, /function productPendingTable\(rows\)/);
});

test('sales analysis exposes comparable daily averages without comparing partial today to full yesterday', async () => {
  const app = await read('src/web/app.js');
  const signal = functionBody(app, 'comparableDailySignal');
  const sales = functionBody(app, 'renderSales');
  const loader = functionBody(app, 'loadSales');
  const periodRanking = functionBody(app, 'salesPeriodStoreRanking');
  const dailySeries = functionBody(app, 'salesDailySeries');

  assert.match(signal, /last7Days \/ 7/);
  assert.match(signal, /\(last30Days - last7Days\) \/ 23/);
  assert.match(app, /近 7 日日均/);
  assert.match(app, /此前 23 日日均/);
  assert.match(loader, /Promise\.all/);
  assert.match(loader, /homeApiPath\(\)/);
  assert.match(periodRanking, /completeMetricSum\(bundle\.storeDaily, 'salesQuantity'\) !== null/);
  assert.match(periodRanking, /bundle\.financeDaily, identity, 'goodsCount'/);
  assert.match(dailySeries, /summary\.storeRanking\.basis !== 'FINANCE'/);
  assert.match(dailySeries, /completeMetricSum\(rows, 'goodsCount'\)/);
  assert.match(sales, /salesPeriodOverview/);
  assert.match(sales, /salesTrendPanel/);
  assert.match(sales, /店铺销量贡献排行/);
  assert.match(sales, /固定窗口销量动量，不随顶部任意日期伪装变化/);
  assert.match(sales, /今日是实时累计，不与完整昨日直接作因果比较/);
  assert.match(sales, /完整商品口径/);
  assert.match(sales, /标准商品排行/);
});

test('attention and risk workspaces support explicit quick filters and preserve unknown quantities', async () => {
  const app = await read('src/web/app.js');
  const filters = functionBody(app, 'matchesQuickFilter');
  const procurement = functionBody(app, 'purchaseOrderAttentionTable');
  const fulfilment = functionBody(app, 'deliveryAttentionTable');
  // Inventory and advice rows now come from the server query surface.
  const inventory = functionBody(app, 'inventoryRiskQueryTable');
  const advice = functionBody(app, 'stockAdviceQueryTable');
  const radarMetric = functionBody(app, 'riskWindowMetric');
  const metaLabel = functionBody(app, 'metaCountLabel');

  assert.match(filters, /OVERDUE/);
  assert.match(filters, /PENDING_DELIVERY/);
  assert.match(filters, /SHORTAGE/);
  assert.match(filters, /URGENT/);
  assert.match(procurement, /orderNo/);
  assert.match(procurement, /requestedDeliveryAt/);
  assert.match(fulfilment, /deliveryCode/);
  assert.match(fulfilment, /expectedReceiptAt/);
  assert.match(inventory, /skuCode/);
  assert.match(inventory, /shortageQuantity/);
  assert.match(advice, /predictedDailySales/);
  assert.match(advice, /plannedUrgentQuantity/);
  assert.match(radarMetric, /至少/);
  assert.match(radarMetric, /未命中不能推断为 0/);
  assert.match(metaLabel, /当前筛选/);
  assert.match(metaLabel, /全量返回/);
  for (const body of [procurement, fulfilment, inventory, advice]) {
    assert.doesNotMatch(body, /\|\| 0|\?\? 0/);
  }
});

test('system workspace follows sanitized runtime and operational coverage evidence', async () => {
  const app = await read('src/web/app.js');
  const system = functionBody(app, 'renderSystem');
  const overview = functionBody(app, 'systemDecisionOverview');
  const services = functionBody(app, 'systemServiceTable');
  const profiles = functionBody(app, 'systemProfileTable');

  assert.match(system, /systemDecisionOverview\(queryData\)/);
  assert.match(system, /systemIssueTable\(queryData\)/);
  assert.match(system, /systemProfileTable\(queryData\)/);
  assert.match(system, /systemServiceTable\(queryData\)/);
  assert.match(system, /systemCoverageTable\(queryData\)/);
  assert.match(system, /systemBoundaryDisclosure\(queryData\)/);
  assert.match(overview, /Profile 续期有效/);
  assert.match(overview, /数据域覆盖/);
  assert.match(overview, /写动作总闸/);
  assert.match(services, /systemd 脱敏回读|计划任务|常驻服务/);
  assert.match(profiles, /登录登记和续期验真是两套证据/);
  assert.doesNotMatch(system, /capability-grid|system-overview/);
});

test('system coverage distinguishes success, failure, missing, stale and in-progress stores', async () => {
  const app = await read('src/web/app.js');
  const query = await read('src/server/system-query.mjs');
  const coverageState = functionBody(query, 'coverageStateForStore');
  const coverageRows = functionBody(query, 'coverageRows');
  const coverageTable = functionBody(app, 'systemCoverageTable');

  assert.match(coverageState, /\['failed'/);
  assert.match(coverageState, /\['stale'/);
  assert.match(coverageState, /\['missing'/);
  assert.match(coverageState, /\['running'/);
  assert.match(coverageState, /\['complete'/);
  assert.match(coverageRows, /failed \+ stale \+ missing > 0/);
  assert.match(coverageRows, /running > 0/);
  assert.match(coverageTable, /失败 \/ 缺失 \/ 过期 \/ 同步中/);
  assert.match(coverageTable, /旧成功掩盖当前问题/);
});

test('operational layouts keep mobile content inside the viewport', async () => {
  const styles = await read('src/web/styles.css');

  assert.match(styles, /\.operation-summary-grid\s*\{/);
  assert.match(styles, /\.table-wrap\s*\{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.event-timeline > li\s*\{[^}]*minmax\(0,\s*1fr\)/s);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.operation-summary-grid,[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.queue-time-strip\s*\{[\s\S]*grid-template-columns:\s*1fr/);
});
