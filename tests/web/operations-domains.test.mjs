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

  assert.match(app, /domainRows\(supply, 'purchaseOrderStatus'\)/);
  assert.match(app, /domainRows\(supply, 'deliveryMilestones'\)/);
  assert.match(app, /domainRows\(supply, 'inventory'\)/);
  assert.match(app, /domainRows\(supply, 'stockAdvice'\)/);
  assert.match(app, /attentionRows\('purchaseOrderAttention'\)/);
  assert.match(app, /attentionRows\('deliveryAttention'\)/);
  assert.match(app, /attentionRows\('inventoryRisks'\)/);
  assert.match(app, /attentionRows\('stockAdviceRisks'\)/);
  assert.match(app, /采购单关注清单/);
  assert.match(app, /交付入仓关注清单/);
  assert.match(app, /SKU 风险与备货筛查/);
  assert.match(app, /店铺×采购单状态汇总/);
  assert.match(app, /店铺×交付里程碑汇总/);
  assert.match(app, /店铺×库存类型汇总/);
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
  assert.match(app, /completeCoveredNullableSum\([\s\S]*deliveryQuantityCoverage/);
  assert.match(app, /completeCoveredNullableSum\([\s\S]*shortageCoverage/);
  assert.match(app, /completeCoveredNullableSum\([\s\S]*advisedOrderCoverage/);
  assert.match(app, /knownLineCount', 'totalLineCount'/);
  assert.ok((app.match(/knownSkuCount', 'totalSkuCount'/g) || []).length >= 5);
  assert.match(app, /明确 0 才展示为 0/);
  assert.match(app, /拒绝补零合计/);
});

test('owner, store and text filters scope all store-keyed operational rows', async () => {
  const app = await read('src/web/app.js');
  const storeScope = functionBody(app, 'storeScopedRows');
  const searchScope = functionBody(app, 'searchableOperationRows');
  const combinedScope = functionBody(app, 'scopedOperationRows');

  assert.match(storeScope, /selectedStore\(\)/);
  assert.match(storeScope, /selectedOwner\(\)/);
  assert.match(storeScope, /owner\.storeCodes/);
  assert.match(storeScope, /row\?\.storeCode/);
  assert.match(searchScope, /normalizedQuery\(\)/);
  assert.match(combinedScope, /searchableOperationRows\(storeScopedRows\(rows\)\)/);

  for (const collection of [
    'purchaseOrderStatus',
    'deliveryMilestones',
    'inventory',
    'stockAdvice',
    'events',
    'candidates',
  ]) {
    assert.match(app, new RegExp(`domainRows\\([^\\n]+, '${collection}'\\)`));
  }
  for (const collection of [
    'purchaseOrderAttention',
    'deliveryAttention',
    'inventoryRisks',
    'stockAdviceRisks',
  ]) {
    assert.match(app, new RegExp(`attentionRows\\('${collection}'\\)`));
  }
  assert.doesNotMatch(app, /canSeeTechnicalGlobal|role === 'admin'/);
});

test('platform page renders queue health, subscription readback and event timeline without empty pseudo-zeroes', async () => {
  const app = await read('src/web/app.js');

  assert.match(app, /Webhook 队列健康/);
  assert.match(app, /订阅回读/);
  assert.match(app, /平台事件时间线/);
  assert.match(app, /queueHasEvidence/);
  assert.match(app, /没有队列快照时不显示等待数、重试数或死信数为 0/);
  assert.match(app, /没有订阅回读时不把任何事件类型标记为已订阅或未订阅/);
  assert.match(app, /这不代表平台没有动态/);
  assert.match(app, /safeProjectionSummary/);
});

test('operations queue is prioritized, localized, drillable and has no write control', async () => {
  const app = await read('src/web/app.js');
  const ops = functionBody(app, 'renderOps');
  const candidateTable = functionBody(app, 'actionCandidateTable');
  const coverage = functionBody(app, 'operationPriorityCoverage');
  const worklist = functionBody(app, 'operationPriorityItems');

  assert.match(ops, /运营待办/);
  assert.match(ops, /高优先事项/);
  assert.match(ops, /筛查 → 下钻 → 人工复核/);
  assert.match(ops, /writeEnabled/);
  assert.match(app, /SHORTAGE_REVIEW:[\s\S]*label: '缺货复核'/);
  assert.match(app, /URGENT_SUPPLY_REVIEW:[\s\S]*label: '急采复核'/);
  assert.match(app, /SUPPLY_SYNC_FAILURE_REVIEW:[\s\S]*label: '同步失败'/);
  assert.match(app, /PURCHASE_ORDER_OVERDUE:[\s\S]*href: '#procurement'/);
  assert.match(app, /DELIVERY_OVERDUE:[\s\S]*href: '#fulfilment'/);
  assert.match(app, /SKU_SHORTAGE_REVIEW:[\s\S]*href: '#inventory'/);
  assert.match(app, /SKU_URGENT_SUPPLY_REVIEW:[\s\S]*href: '#inventory'/);
  assert.match(worklist, /detailedPurchase/);
  assert.match(worklist, /detailedDelivery/);
  assert.match(worklist, /SKU_RESTOCK_ADVICE_REVIEW/);
  assert.match(coverage, /meta\.total - meta\.returned/);
  assert.match(coverage, /未命中不能解释为无风险/);
  assert.match(app, /priorityWorklistTable/);
  assert.match(app, /全量至少/);
  assert.match(app, /查看事实 →/);
  assert.doesNotMatch(candidateTable, /candidateKey/);
  assert.doesNotMatch(ops, /<button/);
  assert.doesNotMatch(ops, /fetch\(|XMLHttpRequest|method:\s*['"]POST['"]/);
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

  assert.match(signal, /last7Days \/ 7/);
  assert.match(signal, /\(last30Days - last7Days\) \/ 23/);
  assert.match(app, /近 7 日日均/);
  assert.match(app, /此前 23 日日均/);
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

test('system capability cards follow real operational domain evidence', async () => {
  const app = await read('src/web/app.js');
  const system = functionBody(app, 'renderSystem');
  const overview = functionBody(app, 'datasetOverview');

  assert.match(system, /procurementConnected/);
  assert.match(system, /fulfilmentConnected/);
  assert.match(system, /inventoryConnected/);
  assert.match(system, /webhookConnected/);
  assert.match(system, /candidateConnected/);
  assert.match(system, /supplyCoverageTable/);
  assert.match(overview, /供应链只读链路/);
  assert.match(overview, /Webhook 链路/);
  assert.match(overview, /写动作总闸/);
  assert.match(overview, /空数组不补成业务 0/);
});

test('supply coverage distinguishes a complete empty business window from missing evidence', async () => {
  const app = await read('src/web/app.js');
  const connectionState = functionBody(app, 'domainConnectionState');
  const coverageTable = functionBody(app, 'supplyCoverageTable');

  assert.match(connectionState, /coverage\.every\(\(item\) => item\.status === 'complete'\)/);
  assert.match(connectionState, /coverage\.some\(\(item\) => item\.status === 'blocked'\)/);
  assert.match(app, /接口覆盖完整 · 当前窗口无事实行/);
  assert.match(coverageTable, /最新同步尝试、覆盖和时效证据/);
  assert.match(coverageTable, /历史成功不能掩盖当前失败/);
  assert.match(coverageTable, /业务数量为 0/);
});

test('operational layouts keep mobile content inside the viewport', async () => {
  const styles = await read('src/web/styles.css');

  assert.match(styles, /\.operation-summary-grid\s*\{/);
  assert.match(styles, /\.table-wrap\s*\{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.event-timeline > li\s*\{[^}]*minmax\(0,\s*1fr\)/s);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.operation-summary-grid,[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.queue-time-strip\s*\{[\s\S]*grid-template-columns:\s*1fr/);
});
