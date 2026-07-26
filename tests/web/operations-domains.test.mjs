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
  assert.match(app, /采购单状态分布/);
  assert.match(app, /交付与入仓里程碑/);
  assert.match(app, /库存与缺货快照/);
  assert.match(app, /平台备货建议/);
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

test('automation candidates remain observe-only and every action control is disabled', async () => {
  const app = await read('src/web/app.js');
  const ops = functionBody(app, 'renderOps');
  const candidateTable = functionBody(app, 'actionCandidateTable');

  assert.match(ops, /只读运营候选池/);
  assert.match(ops, /writeEnabled/);
  assert.match(ops, /<button type="button" disabled>生成预演<\/button>/);
  assert.match(ops, /<button type="button" disabled>确认并提交<\/button>/);
  assert.match(candidateTable, /type="button" disabled>仅观察<\/button>/);
  assert.doesNotMatch(ops, /fetch\(|XMLHttpRequest|method:\s*['"]POST['"]/);
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
