import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, projectRoot), 'utf8');
}

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.indexOf('\nfunction ', start + 10);
  return source.slice(start, next === -1 ? source.length : next);
}

test('inventory workspace consumes its authenticated server query', async () => {
  const app = await read('src/web/app.js');
  assert.match(app, /return `\/api\/inventory\?\$\{params\.toString\(\)\}`/);
  assert.match(app, /async function loadInventory\(/);
  assert.match(app, /requestSerial !== state\.inventory\.requestSerial/);
  assert.match(app, /scheduleInventoryLoad\(\{ resetPages: true, delay: 220 \}\)/);
  assert.match(app, /state\.data && state\.route === 'inventory'/);
  assert.match(app, /scheduleInventoryLoad\(\)/);

  const queryBlock = app.slice(
    app.indexOf('/* --- inventory-query:start ---'),
    app.indexOf('/* --- inventory-query:end --- */'),
  );
  assert.doesNotMatch(queryBlock, /method:\s*['"]POST['"]/);
  assert.match(queryBlock, /result\.readOnly !== true/);
  assert.match(queryBlock, /old scope can never paint under the new URL state/);
});

test('inventory workspace renders one server-paged decision table at a time', async () => {
  const app = await read('src/web/app.js');
  const render = functionBody(app, 'renderInventory');
  const inventoryTable = functionBody(app, 'inventoryRiskQueryTable');
  const adviceTable = functionBody(app, 'stockAdviceQueryTable');

  assert.match(render, /inventoryViewTabs\(queryData\)/);
  assert.match(render, /inventorySummaryCards\(queryData\)/);
  assert.match(render, /inventoryPagination\(pagination, paginationKind, paginationLabel, 'top'\)/);
  assert.match(render, /inventoryPagination\(pagination, paginationKind, paginationLabel, 'bottom'\)/);
  assert.match(render, /inventoryRiskQueryTable\(queryData\.inventory\.rows\)/);
  assert.match(render, /stockAdviceQueryTable\(queryData\.advice\.rows\)/);
  assert.match(render, /inventoryStoreSummary\(queryData\)/);
  assert.doesNotMatch(render, /inventoryRiskTable|stockAdviceRiskTable/);
  assert.doesNotMatch(inventoryTable, /\.slice\(/);
  assert.doesNotMatch(adviceTable, /\.slice\(/);
  assert.match(inventoryTable, /排序与分页由服务端决定/);
  assert.match(adviceTable, /不等于已执行的采购动作/);
});

test('inventory controls are contextual, shareable and reset invisible quick filters', async () => {
  const app = await read('src/web/app.js');
  assert.match(app, /data-inventory-view=/);
  assert.match(app, /data-inventory-select=/);
  assert.match(app, /\['ALL', 'HIGH', 'SHORTAGE', 'RECONCILIATION'\]/);
  assert.match(app, /\['ALL', 'HIGH', 'URGENT', 'ADVICE', 'WARNING'\]/);
  assert.match(app, /quickNeedsReset/);
  assert.match(app, /delete state\.quickFilters\.inventory/);
  assert.match(app, /scheduleInventoryLoad\(\{ resetPages: true \}\)/);
  for (const token of [
    'inventoryView',
    'inventoryType',
    'inventorySort',
    'adviceSort',
    'inventoryPage',
    'advicePage',
    'inventoryPageSize',
  ]) {
    assert.ok(app.includes(token), token);
  }
});

test('inventory workspace keeps the warm editorial and mobile containment rules', async () => {
  const [styles, html] = await Promise.all([
    read('src/web/styles.css'),
    read('src/web/index.html'),
  ]);
  assert.match(styles, /\.segmented-tabs\s*\{/);
  assert.match(styles, /\.inventory-controls\s*\{/);
  assert.match(styles, /\.query-skeleton\s*\{/);
  assert.match(styles, /max-width:\s*100%/);
  assert.match(styles, /\.table-wrap/);
  assert.doesNotMatch(styles, /gradient\(/);
  assert.match(html, /\/app\.js\?v=20260729\.12/);
  assert.match(html, /\/styles\.css\?v=20260729\.12/);
});
