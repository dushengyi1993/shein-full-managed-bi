import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  computeSupplyPlan,
  computeSupplyWindows,
  normalizeSupplyDomains,
  parseArgs,
  readActiveFullManagedSkuUniverse,
  runSupplySync,
} from '../../scripts/sync_full_managed_supply.mjs';
import {
  DELIVERY_QUERY_PATH,
} from '../../src/openapi/deliveries.mjs';
import {
  STOCK_QUERY_PATH,
} from '../../src/openapi/inventory.mjs';
import {
  PRODUCT_FULL_DETAIL_PATH,
  PRODUCT_QUERY_PATH,
} from '../../src/openapi/product-catalog.mjs';
import {
  PURCHASE_ORDER_INFOS_PATH,
} from '../../src/openapi/purchase-orders.mjs';
import {
  STOCK_GOODS_LIST_PATH,
} from '../../src/openapi/stock-advice.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function config() {
  return {
    schemaVersion: 1,
    cooperationMode: 'FULL_MANAGED',
    baseUrl: 'http://127.0.0.1:49091',
    allowFakeBaseUrl: true,
    timeoutMs: 5_000,
    pageSize: 100,
    permissionPackageCode: 'FULL_MANAGED_SKU_SALES',
    stores: [{
      storeCode: 'DL5477',
      storeName: 'DL5477',
      legalEntityName: 'DL company',
      platformShopId: 'shop-1',
      platformSupplierId: 'supplier-1',
      enabled: true,
      applicationStatus: 'approved',
      authorizationStatus: 'authorized',
      appId: 'app-id',
      openKeyId: 'open-key-id',
      secretKey: 'test-secret-key-that-must-not-be-logged',
    }, {
      storeCode: 'OFF0001',
      storeName: 'OFF0001',
      legalEntityName: null,
      platformShopId: null,
      platformSupplierId: null,
      enabled: false,
      applicationStatus: 'approved',
      authorizationStatus: 'not_started',
      appId: null,
      openKeyId: null,
      secretKey: null,
    }],
  };
}

function fakePool() {
  return {
    ended: false,
    async query() {
      return { rows: [] };
    },
    async end() {
      this.ended = true;
    },
  };
}

function supplyEvidenceOperations({
  activeSkuCodes = [],
  attempts = null,
} = {}) {
  return {
    async readActiveSkuUniverse(_pool, { storeCode }) {
      return {
        status: 'AVAILABLE',
        reasonCode: null,
        skuCodes: [...activeSkuCodes],
        evidenceRunId: `sales-membership:${storeCode}`,
        evidenceSourceFetchedAt: '2026-07-26T12:34:56.000Z',
      };
    },
    async recordAttempt(_pool, input) {
      attempts?.push(input);
      return input;
    },
  };
}

function productRows(page) {
  const start = (page - 1) * 100;
  if (start >= 205) return [];
  return Array.from(
    { length: Math.min(100, 205 - start) },
    (_, index) => {
      const number = start + index + 1;
      return {
        spuName: `SPU-${number}`,
        skcName: `SKC-${number}`,
        skuCodeList: [`SKU-${number}`],
      };
    },
  );
}

function stockResponse(body) {
  return {
    code: '0',
    info: [{
      goodsInventory: body.skuCodeList.map((skuCode) => ({
        spuName: `SPU-${skuCode.slice(4)}`,
        skcName: `SKC-${skuCode.slice(4)}`,
        skuList: [{
          skuCode,
          totalInventoryQuantity: 10,
          totalLockedQuantity: 1,
          totalTempLockQuantity: 0,
          totalUsableInventory: 9,
          totalOutOfStockQty: null,
          totalTransitQuantity: null,
          warehouseInventoryList: [],
        }],
      })),
    }],
  };
}

test('CLI arguments and default Shanghai overlap windows are explicit', () => {
  assert.deepEqual(parseArgs([
    '--config', 'openapi.secret.json',
    '--database-url', 'postgres://warehouse',
    '--stores', 'DL5477',
    '--domains', 'products,inventory:PI',
    '--now', '2026-07-26T12:34:56Z',
    '--run-id', 'supply-fixed',
  ]), {
    config: 'openapi.secret.json',
    'database-url': 'postgres://warehouse',
    stores: 'DL5477',
    domains: 'products,inventory:PI',
    now: '2026-07-26T12:34:56Z',
    'run-id': 'supply-fixed',
  });
  assert.deepEqual(normalizeSupplyDomains('products,inventory:pi,deliveries'), [
    'product-catalog',
    'product-details',
    'inventory:PI',
    'deliveries',
  ]);
  const windows = computeSupplyWindows('2026-07-26T12:34:56Z');
  assert.equal(windows.sourceFetchedAt, '2026-07-26T12:34:56.000Z');
  assert.deepEqual(windows.purchaseOrders.windows, [{
    start: '2026-07-24 20:34:56',
    end: '2026-07-26 20:34:56',
  }]);
  assert.equal(windows.purchaseOrders.mode, 'INCREMENTAL');
  assert.equal(windows.purchaseOrders.overlapHours, 48);
  assert.equal(windows.purchaseOrders.completeHistoricalCoverage, false);
  assert.deepEqual(windows.deliveries.windows, [{
    start: '2026-07-12 20:34:56',
    end: '2026-07-26 20:34:56',
  }]);
  assert.equal(windows.deliveries.mode, 'INCREMENTAL');
  assert.equal(windows.deliveries.rollingLookbackDays, 14);
  assert.equal(windows.deliveries.pendingPointLookup, true);
  assert.equal(windows.deliveries.completeHistoricalCoverage, false);
});

test('orchestrator uses only read-only endpoints, bounded batches and explicit inventory types', async () => {
  const calls = [];
  const loads = [];
  const pool = fakePool();
  const client = {
    async request(apiPath, options) {
      calls.push({ path: apiPath, options });
      if (apiPath === PRODUCT_QUERY_PATH) {
        return {
          data: {
            code: '0',
            info: { data: productRows(options.body.pageNum) },
          },
        };
      }
      if (apiPath === PRODUCT_FULL_DETAIL_PATH) {
        return {
          data: {
            code: '0',
            info: options.body.skuCodes.map((skuCode) => ({
              skuCode,
              spuName: `SPU-${skuCode.slice(4)}`,
              skcName: `SKC-${skuCode.slice(4)}`,
              productName: { productName: `Product ${skuCode}` },
              productNumber: `MODEL-${skuCode.slice(4)}`,
              imageList: [],
              skuDimensionsInfo: {},
            })),
          },
        };
      }
      if (apiPath === STOCK_QUERY_PATH) {
        return { data: stockResponse(options.body) };
      }
      if (apiPath === STOCK_GOODS_LIST_PATH) {
        return { data: { code: '0', info: { count: 0, list: [] } } };
      }
      if (apiPath === PURCHASE_ORDER_INFOS_PATH) {
        return {
          data: {
            code: '0',
            info: {
              count: 0,
              pageNo: options.query.pageNumber,
              pageSize: options.query.pageSize,
              list: [],
            },
          },
        };
      }
      if (apiPath === DELIVERY_QUERY_PATH) {
        return { data: { code: '0', info: { count: 0, list: [] } } };
      }
      throw new Error(`Unexpected API path ${apiPath}`);
    },
  };

  const summary = await runSupplySync({
    config: config(),
    databaseUrl: 'postgres://fake.invalid/warehouse',
    now: '2026-07-26T12:34:56Z',
    runId: 'supply-fixed',
    poolFactory: async () => pool,
    clientFactory: () => client,
    operations: {
      ...supplyEvidenceOperations({
        activeSkuCodes: Array.from({ length: 205 }, (_, index) => `SKU-${index + 1}`),
      }),
      async loadSnapshot(_pool, input) {
        loads.push(input);
        return {
          inventoryCount: input.inventory?.items.length,
          catalogSkuCount: input.productCatalog?.products.length,
        };
      },
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.loadedStores, 1);
  assert.equal(summary.results[0].runId, 'supply-fixed:DL5477');
  assert.equal(pool.ended, true);

  const details = calls.filter(({ path: apiPath }) => apiPath === PRODUCT_FULL_DETAIL_PATH);
  assert.deepEqual(details.map(({ options }) => options.body.skuCodes.length), [100, 100, 5]);

  const inventory = calls.filter(({ path: apiPath }) => apiPath === STOCK_QUERY_PATH);
  assert.equal(inventory.length, 9);
  assert.ok(inventory.every(({ options }) => options.body.skuCodeList.length <= 100));
  assert.deepEqual(
    [...new Set(inventory.map(({ options }) => options.body.invType))].sort(),
    ['JI', 'PI', 'VI'],
  );

  const stockAdvice = calls.find(({ path: apiPath }) => apiPath === STOCK_GOODS_LIST_PATH);
  assert.equal(stockAdvice.options.body.pageSize, 20);
  const purchaseOrders = calls.find(
    ({ path: apiPath }) => apiPath === PURCHASE_ORDER_INFOS_PATH,
  );
  assert.equal(purchaseOrders.options.method, 'GET');
  assert.equal(purchaseOrders.options.query.updateTimeStart, '2026-07-24 20:34:56');
  assert.equal(purchaseOrders.options.query.updateTimeEnd, '2026-07-26 20:34:56');
  const deliveries = calls.find(({ path: apiPath }) => apiPath === DELIVERY_QUERY_PATH);
  assert.equal(deliveries.options.method, 'GET');
  assert.equal(deliveries.options.query.startTime, '2026-07-12 20:34:56');
  assert.equal(deliveries.options.query.endTime, '2026-07-26 20:34:56');

  const allowedReadOnlyPaths = new Set([
    PRODUCT_QUERY_PATH,
    PRODUCT_FULL_DETAIL_PATH,
    STOCK_QUERY_PATH,
    STOCK_GOODS_LIST_PATH,
    PURCHASE_ORDER_INFOS_PATH,
    DELIVERY_QUERY_PATH,
  ]);
  assert.ok(calls.every(({ path: apiPath }) => allowedReadOnlyPaths.has(apiPath)));
  assert.equal(loads.length, 4);
  assert.deepEqual(loads.slice(1).map(({ runId }) => runId), [
    'supply-fixed:DL5477:inventory:PI',
    'supply-fixed:DL5477:inventory:VI',
    'supply-fixed:DL5477:inventory:JI',
  ]);
});

test('inventory follows sales number-list membership even when product enrichment differs', async () => {
  const attempts = [];
  const requested = [];
  const loads = [];
  const summary = await runSupplySync({
    config: config(),
    databaseUrl: 'postgres://fake.invalid/warehouse',
    stores: 'DL5477',
    domains: 'product-catalog,inventory:PI',
    now: '2026-07-26T12:34:56Z',
    runId: 'supply-authority',
    poolFactory: async () => fakePool(),
    clientFactory: () => ({}),
    operations: {
      ...supplyEvidenceOperations({
        activeSkuCodes: ['SKU-AUTHORITATIVE'],
        attempts,
      }),
      async fetchProductCatalog() {
        return {
          products: [{
            spuName: 'SPU-ENRICHMENT',
            skcName: 'SKC-ENRICHMENT',
            skuCodes: ['SKU-ENRICHMENT-ONLY'],
          }],
          pages: [],
          terminalReason: 'SHORT_PAGE',
          catalogFingerprint: 'a'.repeat(64),
          filters: {},
        };
      },
      async fetchInventory(_client, options) {
        requested.push(...options.skuCodeList);
        return {
          queryDimension: 'SKU',
          requestedCodes: options.skuCodeList,
          inventoryType: 'PI',
          fetchedAt: '2026-07-26T12:34:56.000Z',
          items: [{
            skuCode: 'SKU-AUTHORITATIVE',
            skcName: null,
            spuName: null,
            totalInventoryQuantity: 3,
            totalLockedQuantity: 0,
            totalTempLockQuantity: 0,
            totalUsableInventory: 3,
            totalOutOfStockQty: null,
            totalTransitQuantity: null,
            warehouses: [],
            reconciliation: {
              status: 'TOTAL_ONLY',
              explanation: 'No warehouse detail',
              checks: [],
            },
          }],
          shortages: [],
          coverage: {
            status: 'COMPLETE',
            requestedCount: 1,
            observedCount: 1,
            missingCodes: [],
            explanation: 'Complete.',
          },
          traceId: null,
          requestFingerprint: 'b'.repeat(64),
        };
      },
      async loadSnapshot(_pool, input) {
        loads.push(input);
        return {};
      },
    },
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.results[0].status, 'partial');
  assert.deepEqual(requested, ['SKU-AUTHORITATIVE']);
  assert.equal(loads.length, 2);
  const catalog = summary.results[0].domains.find(({ domain }) => (
    domain === 'product-catalog'
  ));
  assert.equal(catalog.catalogMissingActiveSkuCount, 1);
  assert.equal(catalog.coverageStatus, 'PARTIAL');
  const terminal = attempts.filter(({ status }) => status !== 'STARTED');
  assert.deepEqual(
    terminal.map(({ domain, subtype, status }) => ({ domain, subtype, status })),
    [
      { domain: 'productCatalog', subtype: 'ALL', status: 'PARTIAL' },
      { domain: 'inventory', subtype: 'PI', status: 'SUCCEEDED' },
    ],
  );
});

test('a proven empty sales membership is a complete zero-SKU inventory universe', async () => {
  const attempts = [];
  const loads = [];
  let inventoryCalled = false;
  const summary = await runSupplySync({
    config: config(),
    databaseUrl: 'postgres://fake.invalid/warehouse',
    stores: 'DL5477',
    domains: 'inventory:PI',
    now: '2026-07-26T12:34:56Z',
    runId: 'supply-empty-authority',
    poolFactory: async () => fakePool(),
    clientFactory: () => ({}),
    operations: {
      ...supplyEvidenceOperations({ activeSkuCodes: [], attempts }),
      async fetchInventory() {
        inventoryCalled = true;
        throw new Error('must not call inventory with an empty proven universe');
      },
      async loadSnapshot(_pool, input) {
        loads.push(input);
        return { inventoryCount: 0 };
      },
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(inventoryCalled, false);
  assert.equal(loads.length, 1);
  assert.deepEqual(loads[0].inventory.requestedCodes, []);
  assert.deepEqual(loads[0].inventory.items, []);
  assert.equal(loads[0].inventory.coverage.status, 'COMPLETE');
  assert.deepEqual(summary.results[0].domains, [{
    domain: 'inventory:PI',
    status: 'loaded',
    reasonCode: 'AUTHORITATIVE_SKU_UNIVERSE_EMPTY',
    inventoryType: 'PI',
    requestedCount: 0,
    observedCount: 0,
    missingCount: 0,
    coverageStatus: 'COMPLETE',
    batchCount: 0,
  }]);
  assert.equal(attempts.at(-1).status, 'SUCCEEDED');
  assert.equal(attempts.at(-1).requestedCount, 0);
  assert.equal(attempts.at(-1).observedCount, 0);
});

test('authoritative SKU membership and its sales evidence are read atomically', async () => {
  const statements = [];
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql.startsWith('BEGIN')) return { rows: [] };
      if (sql.includes('FROM ops.sales_sync_run')) {
        return {
          rows: [{
            sales_sync_run_id: 41,
            run_key: 'sales-run-41',
            status: 'SUCCEEDED',
            quality_status: 'VALID',
            requested_sku_count: 2,
            source_fetched_at: '2026-07-26T12:00:00.000Z',
          }],
        };
      }
      if (sql.includes('FROM dim.full_sku')) {
        return {
          rows: [
            { platform_sku_id: 'SKU-A' },
            { platform_sku_id: 'SKU-B' },
          ],
        };
      }
      if (sql === 'COMMIT') return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {
      statements.push({ sql: 'RELEASE' });
    },
  };
  const universe = await readActiveFullManagedSkuUniverse({
    async connect() {
      return client;
    },
  }, { storeCode: 'DL5477' });

  assert.deepEqual(universe.skuCodes, ['SKU-A', 'SKU-B']);
  assert.equal(universe.evidenceRunId, 'sales-run-41');
  assert.match(statements[0].sql, /REPEATABLE READ READ ONLY/);
  assert.equal(statements.at(-2).sql, 'COMMIT');
  assert.equal(statements.at(-1).sql, 'RELEASE');
});

test('a latest failed sales run makes the SKU membership unavailable', async () => {
  let membershipRead = false;
  const client = {
    async query(sql) {
      if (sql.startsWith('BEGIN')) return { rows: [] };
      if (sql.includes('FROM ops.sales_sync_run')) {
        return {
          rows: [{
            sales_sync_run_id: 42,
            run_key: 'sales-run-failed',
            status: 'FAILED',
            quality_status: 'PARTIAL',
            requested_sku_count: 1,
            source_fetched_at: '2026-07-26T12:00:00.000Z',
          }],
        };
      }
      if (sql.includes('FROM dim.full_sku')) {
        membershipRead = true;
        return { rows: [{ platform_sku_id: 'STALE-SKU' }] };
      }
      if (sql === 'COMMIT') return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const universe = await readActiveFullManagedSkuUniverse({
    async connect() {
      return client;
    },
  }, { storeCode: 'DL5477' });

  assert.equal(universe.status, 'UNAVAILABLE');
  assert.equal(universe.reasonCode, 'LATEST_SALES_MEMBERSHIP_RUN_NOT_ACCEPTED');
  assert.deepEqual(universe.skuCodes, []);
  assert.equal(membershipRead, false);
});

test('explicit backfill splits PO and delivery coverage into bounded windows and persists evidence', async () => {
  const loads = [];
  const purchaseCalls = [];
  const deliveryCalls = [];
  const pool = fakePool();
  const plan = computeSupplyPlan({
    mode: 'backfill',
    backfillStart: '2026-01-01T00:00:00+08:00',
    now: '2026-07-26T12:34:56Z',
  });
  assert.equal(plan.purchaseOrders.mode, 'BACKFILL');
  assert.equal(plan.purchaseOrders.completeRequestedRange, true);
  assert.equal(plan.purchaseOrders.completeHistoricalCoverage, false);
  assert.equal(plan.purchaseOrders.windows.length, 4);
  assert.equal(plan.deliveries.windows.length, 7);
  for (const window of plan.purchaseOrders.windows) {
    const start = new Date(`${window.start.replace(' ', 'T')}+08:00`);
    const end = new Date(`${window.end.replace(' ', 'T')}+08:00`);
    assert.ok(end - start <= 60 * 86_400_000);
  }
  for (const window of plan.deliveries.windows) {
    const start = new Date(`${window.start.replace(' ', 'T')}+08:00`);
    const end = new Date(`${window.end.replace(' ', 'T')}+08:00`);
    assert.ok(end - start <= 30 * 86_400_000);
  }

  const summary = await runSupplySync({
    config: config(),
    databaseUrl: 'postgres://fake.invalid/warehouse',
    stores: 'DL5477',
    domains: 'purchase-orders,deliveries',
    mode: 'backfill',
    backfillStart: '2026-01-01T00:00:00+08:00',
    now: '2026-07-26T12:34:56Z',
    runId: 'supply-backfill',
    poolFactory: async () => pool,
    clientFactory: () => ({}),
    operations: {
      ...supplyEvidenceOperations(),
      async fetchPurchaseOrders(_client, options) {
        purchaseCalls.push(options);
        return {
          orders: [],
          pages: [],
          terminalReason: 'SHORT_PAGE',
          requestFingerprint: `${String(purchaseCalls.length).padStart(64, '0')}`,
          incrementalStrategy: {},
        };
      },
      async fetchDeliveries(_client, options) {
        deliveryCalls.push(options);
        return {
          deliveries: [],
          pages: [],
          terminalReason: 'SHORT_PAGE',
          requestFingerprint: `${String(deliveryCalls.length).padStart(64, 'a')}`,
          incrementalStrategy: {},
        };
      },
      async loadSnapshot(_pool, input) {
        loads.push(input);
        return { purchaseOrderCount: 0, deliveryCount: 0 };
      },
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.mode, 'BACKFILL');
  assert.equal(summary.windows.purchaseOrders.completeRequestedRange, true);
  assert.equal(summary.windows.purchaseOrders.completeHistoricalCoverage, false);
  assert.equal(summary.coverageGate.historicalCompletenessClaimed, false);
  assert.equal(summary.coverageGate.eligibleForIncrementalEnableAfterReadback, true);
  assert.equal(purchaseCalls.length, 4);
  assert.equal(deliveryCalls.length, 7);
  assert.ok(purchaseCalls.every(({ updateTimeStart, updateTimeEnd }) => (
    updateTimeStart && updateTimeEnd
  )));
  assert.ok(deliveryCalls.every(({ startTime, endTime, deliveryCode }) => (
    startTime && endTime && deliveryCode === undefined
  )));
  assert.equal(loads.length, 1);
  assert.equal(loads[0].purchaseOrders.incrementalStrategy.mode, 'BACKFILL');
  assert.equal(loads[0].purchaseOrders.incrementalStrategy.windowCount, 4);
  assert.equal(loads[0].deliveries.incrementalStrategy.mode, 'BACKFILL');
  assert.equal(loads[0].deliveries.incrementalStrategy.windowCount, 7);
  assert.equal(loads[0].deliveries.incrementalStrategy.pendingPointLookup, false);
});

test('incremental delivery combines rolling creation window with older pending point lookups', async () => {
  const calls = [];
  const loads = [];
  const pool = fakePool();
  pool.query = async (sql, values) => {
    assert.match(sql, /delivery\.received_at IS NULL/);
    assert.equal(values[0], 'DL5477');
    assert.equal(values[1], '2026-07-12T12:34:56.000Z');
    return { rows: [{ delivery_code: 'DEL-OLD-1' }] };
  };
  const makeResult = (deliveryCode) => ({
    deliveries: [{
      deliveryCode,
      fetchedAt: '2026-07-26T12:34:56.000Z',
      receivedAt: null,
      takenAt: null,
      lines: [],
    }],
    pages: [{
      page: 1,
      pageSize: 100,
      recordCount: 1,
      responseFingerprint: 'f'.repeat(64),
    }],
    terminalReason: 'SHORT_PAGE',
    requestFingerprint: (deliveryCode === 'DEL-RECENT' ? '1' : '2').repeat(64),
    incrementalStrategy: {},
  });

  const summary = await runSupplySync({
    config: config(),
    databaseUrl: 'postgres://fake.invalid/warehouse',
    stores: 'DL5477',
    domains: 'deliveries',
    now: '2026-07-26T12:34:56Z',
    runId: 'supply-pending-delivery',
    poolFactory: async () => pool,
    clientFactory: () => ({}),
    operations: {
      ...supplyEvidenceOperations(),
      async fetchDeliveries(_client, options) {
        calls.push(options);
        return makeResult(options.deliveryCode ?? 'DEL-RECENT');
      },
      async loadSnapshot(_pool, input) {
        loads.push(input);
        return { deliveryCount: input.deliveries.deliveries.length };
      },
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    startTime: '2026-07-12 20:34:56',
    endTime: '2026-07-26 20:34:56',
    pageSize: 100,
    fetchedAt: '2026-07-26T12:34:56.000Z',
  });
  assert.deepEqual(calls[1], {
    deliveryCode: 'DEL-OLD-1',
    pageSize: 100,
    fetchedAt: '2026-07-26T12:34:56.000Z',
  });
  assert.deepEqual(
    loads[0].deliveries.deliveries.map(({ deliveryCode }) => deliveryCode),
    ['DEL-RECENT', 'DEL-OLD-1'],
  );
  assert.equal(
    loads[0].deliveries.incrementalStrategy.pendingPointLookupCount,
    1,
  );
  const domain = summary.results[0].domains.find(({ domain: name }) => name === 'deliveries');
  assert.equal(domain.pendingPointLookupCount, 1);
  assert.equal(domain.window.completeHistoricalCoverage, false);
});

test('domain failure is isolated, secrets are absent and missing inventory stays unknown', async () => {
  const secret = 'highly-sensitive-openapi-secret';
  const localConfig = config();
  localConfig.stores[0].secretKey = secret;
  const loads = [];
  const pool = fakePool();
  const item = {
    skuCode: 'SKU-1',
    skcName: 'SKC-1',
    spuName: 'SPU-1',
    totalInventoryQuantity: 7,
    totalLockedQuantity: 0,
    totalTempLockQuantity: 0,
    totalUsableInventory: 7,
    totalOutOfStockQty: null,
    totalTransitQuantity: null,
    warehouses: [],
    reconciliation: {
      status: 'TOTAL_ONLY',
      explanation: 'No warehouse detail',
      checks: [],
    },
  };

  const summary = await runSupplySync({
    config: localConfig,
    databaseUrl: 'postgres://user:another-secret@fake.invalid/warehouse',
    stores: 'DL5477',
    domains: 'products,inventory:PI,stock-advice,purchase-orders,deliveries',
    now: '2026-07-26T12:34:56Z',
    runId: 'supply-isolation',
    poolFactory: async () => pool,
    clientFactory: () => ({ async request() { throw new Error('must use injected operation'); } }),
    operations: {
      ...supplyEvidenceOperations({
        activeSkuCodes: ['SKU-1', 'SKU-MISSING'],
      }),
      async fetchProductCatalog() {
        return {
          products: [{
            spuName: 'SPU-1',
            skcName: 'SKC-1',
            skuCodes: ['SKU-1', 'SKU-MISSING'],
          }],
          pages: [],
          terminalReason: 'SHORT_PAGE',
          catalogFingerprint: 'a'.repeat(64),
          filters: {},
        };
      },
      async fetchProductDetails() {
        return { details: [], batches: [] };
      },
      async fetchInventory(_client, { skuCodeList, invType }) {
        assert.deepEqual(skuCodeList, ['SKU-1', 'SKU-MISSING']);
        assert.equal(invType, 'PI');
        return {
          queryDimension: 'SKU',
          requestedCodes: skuCodeList,
          inventoryType: invType,
          fetchedAt: '2026-07-26T12:34:56.000Z',
          items: [item],
          shortages: [],
          coverage: {
            status: 'PARTIAL',
            requestedCount: 2,
            observedCount: 1,
            missingCodes: ['SKU-MISSING'],
            explanation: 'Missing is unknown.',
          },
          traceId: null,
          requestFingerprint: 'b'.repeat(64),
        };
      },
      async fetchStockAdvice() {
        const error = new Error(`platform failed with ${secret}`);
        error.code = 'PLATFORM_ERROR';
        throw error;
      },
      async fetchPurchaseOrders() {
        return {
          orders: [],
          pages: [],
          terminalReason: 'SHORT_PAGE',
          requestFingerprint: 'c'.repeat(64),
          incrementalStrategy: { callerSuppliedOverlap: true },
        };
      },
      async fetchDeliveries() {
        return {
          deliveries: [],
          pages: [],
          terminalReason: 'SHORT_PAGE',
          requestFingerprint: 'd'.repeat(64),
          incrementalStrategy: { mode: 'ROLLING_CREATION_TIME_LOOKBACK_REQUIRED' },
        };
      },
      async loadSnapshot(_pool, input) {
        loads.push(input);
        return { inventoryCount: input.inventory?.items.length ?? 0 };
      },
    },
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.results[0].status, 'partial');
  const advice = summary.results[0].domains.find(({ domain }) => domain === 'stock-advice');
  assert.deepEqual(advice, {
    domain: 'stock-advice',
    status: 'fetch_error',
    errorCode: 'PLATFORM_ERROR',
  });
  assert.equal(Object.hasOwn(loads[0], 'stockAdvice'), false);

  const inventoryLoad = loads.find(({ inventory }) => inventory);
  assert.equal(inventoryLoad.inventory.items.length, 1);
  assert.deepEqual(inventoryLoad.inventory.coverage, {
    status: 'PARTIAL',
    requestedCount: 2,
    observedCount: 1,
    missingCodes: ['SKU-MISSING'],
    explanation: 'SHEIN omitted requested SKUs; they remain unknown and were not converted to zero inventory.',
  });
  const inventoryResult = summary.results[0].domains.find(
    ({ domain }) => domain === 'inventory:PI',
  );
  assert.equal(inventoryResult.observedCount, 1);
  assert.equal(inventoryResult.missingCount, 1);
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(summary), /another-secret/);
});

test('an unexpected store failure does not stop the next eligible store', async () => {
  const localConfig = config();
  localConfig.stores = [
    localConfig.stores[0],
    {
      ...localConfig.stores[0],
      storeCode: 'CX4412',
      storeName: 'CX4412',
      openKeyId: 'cx-open-key',
      secretKey: 'cx-secret-key',
    },
  ];
  const loadedStores = [];
  const pool = fakePool();
  const summary = await runSupplySync({
    config: localConfig,
    databaseUrl: 'postgres://fake.invalid/warehouse',
    domains: 'stock-advice',
    now: '2026-07-26T12:34:56Z',
    runId: 'supply-store-isolation',
    poolFactory: async () => pool,
    clientFactory({ openKeyId }) {
      if (openKeyId === 'open-key-id') {
        const error = new Error('first store client construction failed');
        error.code = 'CLIENT_CONSTRUCTION_FAILED';
        throw error;
      }
      return {};
    },
    operations: {
      ...supplyEvidenceOperations(),
      async fetchStockAdvice() {
        return {
          advice: [],
          pages: [],
          terminalReason: 'SHORT_PAGE',
          requestFingerprint: 'e'.repeat(64),
        };
      },
      async loadSnapshot(_pool, input) {
        loadedStores.push(input.store.storeCode);
        return { stockAdviceCount: 0 };
      },
    },
  });

  assert.equal(summary.ok, false);
  assert.deepEqual(summary.results.map(({ storeCode, status }) => ({ storeCode, status })), [
    { storeCode: 'DL5477', status: 'error' },
    { storeCode: 'CX4412', status: 'loaded' },
  ]);
  assert.deepEqual(loadedStores, ['CX4412']);
  assert.equal(pool.ended, true);
});

test('default client refuses real SHEIN calls on Windows before network access', {
  skip: process.platform !== 'win32',
}, async () => {
  const localConfig = config();
  localConfig.baseUrl = 'https://openapi.sheincorp.com';
  localConfig.allowFakeBaseUrl = false;
  const pool = fakePool();
  const summary = await runSupplySync({
    config: localConfig,
    databaseUrl: 'postgres://fake.invalid/warehouse',
    stores: 'DL5477',
    domains: 'stock-advice',
    now: '2026-07-26T12:34:56Z',
    runId: 'supply-windows-gate',
    poolFactory: async () => pool,
    operations: supplyEvidenceOperations(),
  });
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.results[0].domains, [{
    domain: 'stock-advice',
    status: 'fetch_error',
    errorCode: 'REAL_OPENAPI_BLOCKED_ON_WINDOWS',
  }]);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /test-secret-key-that-must-not-be-logged/,
  );
});

test('systemd timer is gated and remains opt-in after deployment', async () => {
  const service = await readFile(
    `${PROJECT_ROOT}infra/systemd/shein-fm-supply-sync.service`,
    'utf8',
  );
  const timer = await readFile(
    `${PROJECT_ROOT}infra/systemd/shein-fm-supply-sync.timer`,
    'utf8',
  );
  assert.match(service, /ConditionPathExists=\/srv\/shein-fm\/runtime\/supply-sync\.enabled/);
  assert.match(service, /ConditionPathExists=\/srv\/shein-fm\/runtime\/supply-backfill\.verified/);
  assert.match(service, /SHEIN_FM_CLOUD_EXECUTION=1/);
  assert.match(service, /sync_full_managed_supply\.mjs/);
  assert.match(timer, /ConditionPathExists=\/srv\/shein-fm\/runtime\/supply-sync\.enabled/);
  assert.match(timer, /ConditionPathExists=\/srv\/shein-fm\/runtime\/supply-backfill\.verified/);
  assert.match(timer, /Deliberately disabled by default/);
  assert.doesNotMatch(service, /systemctl\s+enable|curl|wget/);
});
