import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InventoryQueryError,
  queryInventoryDashboard,
} from '../../src/server/inventory-query.mjs';

const DASHBOARD = Object.freeze({
  updatedAt: '2026-07-29T02:00:00.000Z',
  businessDate: '2026-07-28',
  dataset: { status: 'live' },
  owners: [
    { key: 'alice', name: 'Alice', storeCodes: ['DL5477'] },
    { key: 'bob', name: 'Bob', storeCodes: ['MZ2406'] },
  ],
  storeRanking: [
    { code: 'DL5477', name: 'DL' },
    { code: 'MZ2406', name: 'MZ' },
  ],
  supply: {
    status: 'available',
    coverage: {
      domains: {
        inventory: { status: 'partial', succeededStores: 2, totalStores: 24 },
        stockAdvice: { status: 'partial', succeededStores: 2, totalStores: 24 },
      },
    },
    attentionMeta: {
      inventoryRisks: { available: true, total: 57, returned: 4, truncated: true },
      stockAdviceRisks: { available: true, total: 118, returned: 3, truncated: true },
    },
    inventory: [
      {
        storeCode: 'DL5477',
        storeName: 'DL',
        inventoryTypeCode: 'PI',
        skuCount: 12,
        inventoryQuantity: 400,
        usableInventory: 380,
        shortageQuantity: 20,
        latestSourceFetchedAt: '2026-07-29T01:00:00.000Z',
      },
      {
        storeCode: 'MZ2406',
        storeName: 'MZ',
        inventoryTypeCode: 'JI',
        skuCount: null,
        inventoryQuantity: null,
        latestSourceFetchedAt: '2026-07-28T23:00:00.000Z',
      },
    ],
    stockAdvice: [
      {
        storeCode: 'DL5477',
        storeName: 'DL',
        advisedSkuCount: 4,
        advisedOrderQuantity: 90,
        latestSourceFetchedAt: '2026-07-29T01:00:00.000Z',
      },
    ],
    inventoryRisks: [
      {
        storeCode: 'DL5477',
        storeName: 'DL',
        skuCode: 'SKU-LOW',
        skcName: 'SKC-LOW',
        inventoryTypeCode: 'PI',
        totalInventory: 10,
        usableInventory: 2,
        transitQuantity: 0,
        shortageQuantity: 30,
        reconciliationStatus: 'MATCH',
        severity: 'high',
        latestSourceFetchedAt: '2026-07-29T01:00:00.000Z',
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL',
        skuCode: 'SKU-MISMATCH',
        inventoryTypeCode: 'JI',
        totalInventory: 5,
        usableInventory: null,
        shortageQuantity: null,
        reconciliationStatus: 'MISMATCH',
        severity: 'critical',
        latestSourceFetchedAt: '2026-07-28T20:00:00.000Z',
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL',
        skuCode: 'SKU-CALM',
        inventoryTypeCode: 'PI',
        totalInventory: 900,
        usableInventory: 900,
        shortageQuantity: 0,
        reconciliationStatus: 'MATCH',
        severity: 'low',
        latestSourceFetchedAt: '2026-07-29T00:30:00.000Z',
      },
      {
        storeCode: 'MZ2406',
        storeName: 'MZ',
        skuCode: 'SKU-MZ',
        inventoryTypeCode: 'VI',
        totalInventory: null,
        usableInventory: 40,
        shortageQuantity: 7,
        reconciliationStatus: 'MATCH',
        severity: 'medium',
        latestSourceFetchedAt: '2026-07-28T22:00:00.000Z',
      },
    ],
    stockAdviceRisks: [
      {
        storeCode: 'DL5477',
        storeName: 'DL',
        skuCode: 'SKU-URGENT',
        supplierCode: 'SUP-1',
        predictedDailySales: 12.5,
        advisedOrderQuantity: 200,
        plannedUrgentQuantity: 60,
        stockWarningIsWarning: true,
        supplyStatusCode: 'WAIT_SUPPLY',
        severity: 'critical',
        latestSourceFetchedAt: '2026-07-29T01:30:00.000Z',
      },
      {
        storeCode: 'DL5477',
        storeName: 'DL',
        skuCode: 'SKU-ADVICE',
        predictedDailySales: null,
        advisedOrderQuantity: 40,
        plannedUrgentQuantity: 0,
        stockWarningIsWarning: false,
        severity: 'medium',
        latestSourceFetchedAt: '2026-07-29T00:00:00.000Z',
      },
      {
        storeCode: 'MZ2406',
        storeName: 'MZ',
        skuCode: 'SKU-MZ-ADVICE',
        predictedDailySales: 3,
        advisedOrderQuantity: null,
        plannedUrgentQuantity: null,
        stockWarningIsWarning: null,
        severity: 'high',
        latestSourceFetchedAt: '2026-07-28T21:00:00.000Z',
      },
    ],
  },
});

test('inventory query is read-only and scopes both lists by owner', () => {
  const result = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ owner: 'alice' }),
  );
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.readOnly, true);
  assert.deepEqual(
    result.inventory.rows.map((row) => row.skuCode),
    ['SKU-MISMATCH', 'SKU-LOW', 'SKU-CALM'],
  );
  assert.deepEqual(
    result.advice.rows.map((row) => row.skuCode),
    ['SKU-URGENT', 'SKU-ADVICE'],
  );
  assert.deepEqual(
    result.inventory.storeSummaryRows.map((row) => row.storeCode),
    ['DL5477'],
  );
  assert.deepEqual(result.scope.scopedStoreCodes, ['DL5477']);
  assert.equal(result.overview.affectedStoreCount, 1);
});

test('inventory type, quick filter and text search run server-side', () => {
  const typed = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ inventoryType: 'PI' }),
  );
  assert.deepEqual(
    typed.inventory.rows.map((row) => row.skuCode),
    ['SKU-LOW', 'SKU-CALM'],
  );
  // An inventory-only type filter must not silently shrink the advice list.
  assert.equal(typed.advice.pagination.matchedMaterializedRows, 3);

  const shortage = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ quick: 'SHORTAGE' }),
  );
  assert.deepEqual(
    shortage.inventory.rows.map((row) => row.skuCode),
    ['SKU-LOW', 'SKU-MZ'],
  );
  assert.equal(shortage.scope.quickAppliesToInventory, true);
  assert.equal(shortage.scope.quickAppliesToAdvice, false);
  assert.equal(shortage.advice.pagination.matchedMaterializedRows, 3);

  const reconciliation = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ quick: 'RECONCILIATION' }),
  );
  assert.deepEqual(
    reconciliation.inventory.rows.map((row) => row.skuCode),
    ['SKU-MISMATCH'],
  );

  const urgent = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ quick: 'URGENT' }),
  );
  assert.deepEqual(urgent.advice.rows.map((row) => row.skuCode), ['SKU-URGENT']);
  assert.equal(urgent.scope.quickAppliesToInventory, false);

  const warning = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ quick: 'WARNING' }),
  );
  assert.deepEqual(warning.advice.rows.map((row) => row.skuCode), ['SKU-URGENT']);

  const searched = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ q: 'sup-1' }),
  );
  assert.deepEqual(searched.advice.rows.map((row) => row.skuCode), ['SKU-URGENT']);
  assert.deepEqual(searched.inventory.rows, []);
  assert.equal(searched.inventory.pagination.pageCount, 0);
});

test('inventory and advice sorts and pages stay independent and deterministic', () => {
  const shortageSorted = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ inventorySort: 'SHORTAGE_DESC' }),
  );
  assert.deepEqual(
    shortageSorted.inventory.rows.map((row) => row.skuCode),
    ['SKU-LOW', 'SKU-MZ', 'SKU-CALM', 'SKU-MISMATCH'],
  );

  const usableAscending = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ inventorySort: 'USABLE_ASC' }),
  );
  assert.deepEqual(
    usableAscending.inventory.rows.map((row) => row.skuCode),
    ['SKU-LOW', 'SKU-MZ', 'SKU-CALM', 'SKU-MISMATCH'],
  );

  const freshest = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ inventorySort: 'FRESHNESS_DESC', adviceSort: 'DAILY_SALES_DESC' }),
  );
  assert.equal(freshest.inventory.rows[0].skuCode, 'SKU-LOW');
  assert.deepEqual(
    freshest.advice.rows.map((row) => row.skuCode),
    ['SKU-URGENT', 'SKU-MZ-ADVICE', 'SKU-ADVICE'],
  );

  const adviceSorted = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ adviceSort: 'ADVICE_DESC' }),
  );
  assert.deepEqual(
    adviceSorted.advice.rows.map((row) => row.skuCode),
    ['SKU-URGENT', 'SKU-ADVICE', 'SKU-MZ-ADVICE'],
  );

  const paged = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ pageSize: '2', inventoryPage: '2', advicePage: '1' }),
  );
  assert.deepEqual(paged.inventory.rows.map((row) => row.skuCode), ['SKU-MZ', 'SKU-CALM']);
  assert.deepEqual(paged.inventory.pagination, {
    page: 2,
    pageSize: 2,
    pageCount: 2,
    matchedMaterializedRows: 4,
    hasPrevious: true,
    hasNext: false,
  });
  assert.deepEqual(paged.advice.pagination, {
    page: 1,
    pageSize: 2,
    pageCount: 2,
    matchedMaterializedRows: 3,
    hasPrevious: false,
    hasNext: true,
  });
});

test('overview keeps unknown quantities unknown and never fabricates a total', () => {
  const result = queryInventoryDashboard(DASHBOARD, new URLSearchParams());
  assert.equal(result.overview.shortage.total, null);
  assert.equal(result.overview.shortage.knownCount, 3);
  assert.equal(result.overview.shortage.unknownCount, 1);
  assert.equal(result.overview.shortage.knownSum, 37);
  assert.equal(result.overview.shortage.positiveRowCount, 2);
  assert.equal(result.overview.shortage.affectedStoreCount, 2);
  assert.equal(result.overview.advised.total, null);
  assert.equal(result.overview.advised.knownSum, 240);
  assert.equal(result.overview.predictedDailySales.knownSum, 15.5);
  assert.equal(result.overview.predictedDailySales.unknownCount, 1);
  assert.equal(result.overview.reconciliation.rowCount, 1);
  assert.equal(result.overview.reconciliation.affectedStoreCount, 1);
  assert.equal(result.overview.warningRowCount, 1);
  assert.deepEqual(result.overview.inventorySeverity, {
    critical: 1,
    high: 1,
    medium: 1,
    low: 1,
  });
  assert.deepEqual(result.overview.inventoryTypes, [
    { code: 'JI', count: 1 },
    { code: 'PI', count: 2 },
    { code: 'VI', count: 1 },
  ]);
  assert.equal(result.overview.affectedStoreCount, 2);

  const complete = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ inventoryType: 'PI' }),
  );
  assert.equal(complete.overview.shortage.total, 30);
  assert.equal(complete.overview.shortage.unknownCount, 0);
});

test('source metadata reports materialized truncation instead of warehouse totals', () => {
  const result = queryInventoryDashboard(
    DASHBOARD,
    new URLSearchParams({ store: 'MZ2406' }),
  );
  assert.deepEqual(result.source.materializedInventoryRisks, {
    available: true,
    total: 57,
    returned: 4,
    truncated: true,
  });
  assert.deepEqual(result.advice.source, {
    available: true,
    total: 118,
    returned: 3,
    truncated: true,
  });
  assert.equal(result.inventory.pagination.matchedMaterializedRows, 1);
  assert.equal(result.source.businessDate, '2026-07-28');
  assert.equal(result.source.datasetStatus, 'live');
  assert.equal(result.source.latestSourceFetchedAt, '2026-07-28T23:00:00.000Z');
  assert.equal(result.source.coverage.inventory.status, 'partial');

  const missing = queryInventoryDashboard({}, new URLSearchParams());
  assert.deepEqual(missing.source.materializedInventoryRisks, {
    available: false,
    total: null,
    returned: null,
    truncated: false,
  });
  assert.deepEqual(missing.inventory.rows, []);
  assert.equal(missing.overview.shortage.total, null);
  assert.equal(missing.overview.shortage.knownSum, null);
});

test('response exposes only whitelisted filter options', () => {
  const result = queryInventoryDashboard(DASHBOARD, new URLSearchParams());
  assert.deepEqual(result.filters.quick, [
    'ALL', 'HIGH', 'SHORTAGE', 'RECONCILIATION', 'URGENT', 'ADVICE', 'WARNING',
  ]);
  assert.deepEqual(result.filters.inventoryTypes, ['ALL', 'PI', 'JI', 'VI']);
  assert.deepEqual(result.filters.inventorySorts, [
    'PRIORITY', 'SHORTAGE_DESC', 'USABLE_ASC', 'FRESHNESS_DESC',
  ]);
  assert.deepEqual(result.filters.adviceSorts, [
    'PRIORITY', 'URGENT_DESC', 'ADVICE_DESC', 'DAILY_SALES_DESC', 'FRESHNESS_DESC',
  ]);
  assert.deepEqual(
    result.filters.stores.map((store) => store.code),
    ['DL5477', 'MZ2406'],
  );
  assert.deepEqual(
    result.filters.owners.map((owner) => owner.key),
    ['alice', 'bob'],
  );
  assert.deepEqual(Object.keys(result.query), [
    'owner', 'store', 'q', 'quick', 'inventoryType',
    'inventorySort', 'adviceSort', 'inventoryPage', 'advicePage', 'pageSize',
  ]);
});

test('duplicate, unknown and out-of-range parameters fail closed', () => {
  for (const params of [
    new URLSearchParams('q=a&q=b'),
    new URLSearchParams('quick=ALL&quick=HIGH'),
    new URLSearchParams('inventoryPage=1&inventoryPage=2'),
    new URLSearchParams('quick=NOPE'),
    new URLSearchParams('inventoryType=XX'),
    new URLSearchParams('inventorySort=NOPE'),
    new URLSearchParams('adviceSort=NOPE'),
    new URLSearchParams('inventoryPage=0'),
    new URLSearchParams('advicePage=0'),
    new URLSearchParams('inventoryPage=10001'),
    new URLSearchParams('pageSize=0'),
    new URLSearchParams('pageSize=101'),
    new URLSearchParams('unexpected=1'),
    new URLSearchParams('owner=unknown'),
    new URLSearchParams('store=ZZ9999'),
    new URLSearchParams('store=not a store'),
    new URLSearchParams({ q: 'x'.repeat(121) }),
  ]) {
    assert.throws(
      () => queryInventoryDashboard(DASHBOARD, params),
      InventoryQueryError,
      `expected rejection for ${params.toString()}`,
    );
  }

  const wrongOwnerStore = new URLSearchParams({ owner: 'alice', store: 'MZ2406' });
  assert.throws(
    () => queryInventoryDashboard(DASHBOARD, wrongOwnerStore),
    (error) => error instanceof InventoryQueryError
      && error.code === 'QUERY_STORE_UNKNOWN'
      && error.statusCode === 400,
  );

  // UI page sizes stay usable.
  for (const pageSize of ['25', '50', '100']) {
    const result = queryInventoryDashboard(
      DASHBOARD,
      new URLSearchParams({ pageSize }),
    );
    assert.equal(result.query.pageSize, Number(pageSize));
  }
});
