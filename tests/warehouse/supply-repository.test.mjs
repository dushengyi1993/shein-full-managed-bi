import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadFullManagedSupplySnapshot,
  PURCHASE_ORDER_LOAD_ERROR_CODES,
  productImageUrlHash,
  readFullManagedSupplySyncHealth,
  readFullManagedSupplyDashboard,
  recordFullManagedSupplySyncAttempt,
  SUPPLY_DASHBOARD_SQL,
  SUPPLY_SYNC_HEALTH_SQL,
} from '../../src/warehouse/supply-repository.mjs';
import { payloadFingerprint } from '../../src/openapi/paginated-fetch.mjs';

class FakeClient {
  constructor({ failOnInventory = false } = {}) {
    this.calls = [];
    this.ids = {
      batch: 10,
      inventory: 20,
      warehouse: 30,
      order: 40,
      delivery: 50,
      projection: 60,
      projectionMember: 70,
    };
    this.failOnInventory = failOnInventory;
    this.released = false;
  }

  async query(sql, values = []) {
    this.calls.push({ sql, values });
    if (this.failOnInventory && sql.includes('INSERT INTO fact.inventory_snapshot')) {
      throw new Error('inventory write failed');
    }
    if (sql.includes('RETURNING store_id')) return { rows: [{ store_id: 1 }] };
    if (sql.includes('RETURNING fetch_batch_id')) {
      return { rows: [{ fetch_batch_id: this.ids.batch++ }] };
    }
    if (sql.includes('RETURNING inventory_snapshot_id')) {
      return { rows: [{ inventory_snapshot_id: this.ids.inventory++ }] };
    }
    if (sql.includes('RETURNING full_warehouse_id')) {
      return { rows: [{ full_warehouse_id: this.ids.warehouse++ }] };
    }
    if (sql.includes('RETURNING purchase_order_id')) {
      return { rows: [{ purchase_order_id: this.ids.order++ }] };
    }
    if (sql.includes('RETURNING delivery_id')) {
      return { rows: [{ delivery_id: this.ids.delivery++ }] };
    }
    if (sql.includes('RETURNING supply_projection_batch_id')) {
      return { rows: [{ supply_projection_batch_id: this.ids.projection++ }], rowCount: 1 };
    }
    if (sql.includes('RETURNING supply_projection_member_id')) {
      return {
        rows: [{ supply_projection_member_id: this.ids.projectionMember++ }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  }

  release() {
    this.released = true;
  }
}

function pool(client) {
  return { async connect() { return client; } };
}

function supplyInput() {
  const sourceFetchedAt = '2026-07-26T12:00:00.000Z';
  return {
    store: { storeCode: 'DL', storeName: 'DL' },
    runId: 'supply-20260726:DL',
    sourceFetchedAt,
    inventory: {
      queryDimension: 'SKU',
      requestedCodes: ['SKU-1'],
      inventoryType: 'PI',
      requestFingerprint: 'a'.repeat(64),
      coverage: {
        status: 'COMPLETE',
        requestedCount: 1,
        observedCount: 1,
        missingCodes: [],
      },
      items: [{
        skuCode: 'SKU-1',
        skcName: 'SKC-1',
        spuName: 'SPU-1',
        totalInventoryQuantity: 10,
        totalLockedQuantity: 1,
        totalTempLockQuantity: 0,
        totalUsableInventory: 9,
        totalOutOfStockQty: 2,
        totalTransitQuantity: 3,
        warehouses: [{
          warehouseCode: 'WH-1',
          warehouseTypeCode: '1',
          inventoryQuantity: 10,
          lockedQuantity: 1,
          tempLockQuantity: 0,
          usableInventory: 9,
          outOfStockQty: 2,
          transitQuantity: 3,
        }],
        reconciliation: {
          status: 'RECONCILED',
          explanation: 'matches',
          checks: [{
            metric: 'totalInventoryQuantity',
            status: 'MATCH',
            aggregate: 10,
            warehouseSum: 10,
          }],
        },
      }],
    },
    purchaseOrders: {
      requestFingerprint: 'b'.repeat(64),
      incrementalStrategy: { callerSuppliedOverlap: true },
      pages: [{
        page: 1,
        pageSize: 200,
        recordCount: 1,
        responseFingerprint: 'c'.repeat(64),
      }],
      orders: [{
        orderNo: 'PO-1',
        orderTypeCode: '99',
        orderTypeName: 'Future',
        statusCode: '987',
        statusName: 'Future',
        prepareTypeCode: null,
        prepareTypeName: null,
        categoryCode: null,
        categoryName: null,
        currencyCode: null,
        warehouseCode: null,
        warehouseName: null,
        jitRoleCode: 'future-jit-role',
        createdAt: '2026-07-20T02:00:00.000Z',
        sourceUpdatedAt: sourceFetchedAt,
        requestedDeliveryAt: null,
        requestedReceiptAt: null,
        deliveredAt: null,
        receivedAt: null,
        storedAt: null,
        fetchedAt: sourceFetchedAt,
        linesComplete: true,
        lines: [{
          skuCode: 'SKU-1',
          skc: 'SKC-1',
          supplierCode: 'MODEL-1',
          supplierSku: null,
          variantName: null,
          needQuantity: null,
          orderQuantity: 10,
          deliveryQuantity: 2,
          receiptQuantity: 1,
          storageQuantity: 1,
          defectiveQuantity: 0,
          requestDeliveryQuantity: null,
          noRequestDeliveryQuantity: null,
          alreadyDeliveryQuantity: null,
        }],
        jitRelations: [],
        jitRelationsComplete: true,
        jitRelationScopes: ['AS_MOTHER', 'AS_CHILD'],
      }],
    },
    deliveries: {
      requestFingerprint: 'd'.repeat(64),
      incrementalStrategy: { mode: 'ROLLING_CREATION_TIME_LOOKBACK_REQUIRED' },
      pages: [{
        page: 1,
        pageSize: 200,
        recordCount: 1,
        responseFingerprint: 'e'.repeat(64),
      }],
      deliveries: [{
        deliveryCode: 'DEL-1',
        deliveryTypeCode: '42',
        deliveryTypeName: 'Future',
        logisticsLabelPrintFlagCode: null,
        expressCode: null,
        expressCompanyCode: null,
        expressCompanyName: null,
        packageCount: 1,
        packageWeight: 2,
        warehouseCode: null,
        warehouseName: null,
        createdAt: '2026-07-20T04:00:00.000Z',
        reservedParcelAt: null,
        takenAt: null,
        expectedReceiptAt: null,
        receivedAt: null,
        fetchedAt: sourceFetchedAt,
        linesComplete: true,
        lines: [{
          orderNo: 'PO-1',
          skc: 'SKC-1',
          skuCode: 'SKU-1',
          deliveryQuantity: 2,
        }],
      }],
    },
  };
}

test('loads inventory, purchase and delivery domains atomically with newer-source guards', async () => {
  const client = new FakeClient();
  const result = await loadFullManagedSupplySnapshot(pool(client), supplyInput());

  assert.equal(client.calls[0].sql, 'BEGIN');
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
  assert.equal(client.released, true);
  assert.equal(result.inventoryCount, 1);
  assert.equal(result.purchaseOrderCount, 1);
  assert.equal(result.deliveryCount, 1);
  assert.equal(client.calls.some(({ sql }) => (
    sql.includes('INSERT INTO fact.shortage_event')
  )), true);
  assert.equal(client.calls.some(({ sql }) => (
    sql.includes('INSERT INTO ops.reconciliation_result')
  )), true);
  const guardedUpdates = client.calls.filter(({ sql }) => (
    sql.includes('ON CONFLICT') && sql.includes('EXCLUDED.source_fetched_at >=')
  ));
  assert.ok(guardedUpdates.length >= 4);
  assert.equal(client.calls.some(({ sql }) => (
    sql.includes('UPDATE fact.purchase_order_line')
    && sql.includes('SET is_current = false')
  )), true);
  assert.equal(client.calls.some(({ sql }) => (
    sql.includes('UPDATE fact.delivery_line')
    && sql.includes('SET is_current = false')
  )), true);
  assert.equal(client.calls.some(({ sql }) => (
    sql.includes('UPDATE fact.purchase_order_jit_relation')
    && sql.includes('SET is_current = false')
  )), true);
  assert.equal(client.calls.some(({ sql }) => (
    sql.includes('ON CONFLICT (\n           store_id, purchase_order_id')
    && sql.includes('source_fetched_at')
  )), true);
  assert.equal(client.calls.some(({ sql }) => /\bDELETE\b|\bTRUNCATE\b/.test(sql)), false);
});

test('repository persists no contact, phone or address fields', async () => {
  const client = new FakeClient();
  await loadFullManagedSupplySnapshot(pool(client), supplyInput());
  const sql = client.calls.map(({ sql }) => sql).join('\n');
  assert.doesNotMatch(sql, /\b(contact|person|phone|mobile|address|recipient)\b/i);
});

test('a domain failure rolls back the full store transaction', async () => {
  const client = new FakeClient({ failOnInventory: true });
  await assert.rejects(
    () => loadFullManagedSupplySnapshot(pool(client), supplyInput()),
    /inventory write failed/,
  );
  assert.equal(client.calls.some(({ sql }) => sql === 'ROLLBACK'), true);
  assert.equal(client.calls.some(({ sql }) => sql === 'COMMIT'), false);
  assert.equal(client.released, true);
});

test('same run/domain idempotency key with different source evidence fails closed', async () => {
  class DriftClient extends FakeClient {
    async query(sql, values = []) {
      this.calls.push({ sql, values });
      if (sql.includes('RETURNING store_id')) return { rows: [{ store_id: 1 }] };
      if (
        sql.includes('INSERT INTO raw.openapi_fetch_batch')
        && sql.includes('RETURNING fetch_batch_id')
      ) {
        return { rows: [] };
      }
      if (sql.includes('FROM raw.openapi_fetch_batch')) {
        return {
          rows: [{
            fetch_batch_id: 10,
            request_fingerprint: '0'.repeat(64),
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    }
  }
  const client = new DriftClient();
  await assert.rejects(
    () => loadFullManagedSupplySnapshot(pool(client), supplyInput()),
    /idempotency key was reused with non-identical source evidence/,
  );
  assert.equal(client.calls.some(({ sql }) => sql === 'ROLLBACK'), true);
  assert.equal(
    client.calls.some(({ sql }) => sql.includes('INSERT INTO fact.inventory_snapshot')),
    false,
  );
});

test('supply catalog/detail only enrich sales-owned SKU rows under the shared lock', async () => {
  const products = [{
    spuName: 'SPU-1',
    skcName: 'SKC-1',
    skuCodes: ['SKU-1'],
  }];
  const catalogFingerprint = payloadFingerprint(products);
  const sourceFetchedAt = '2026-07-26T12:00:00.000Z';
  const client = new FakeClient();
  const result = await loadFullManagedSupplySnapshot(pool(client), {
    store: { storeCode: 'DL', storeName: 'DL' },
    runId: 'catalog-20260726:DL',
    sourceFetchedAt,
    productCatalog: {
      stable: true,
      products,
      productCount: 1,
      skuCount: 1,
      catalogFingerprint,
      sweepCount: 2,
      filters: {},
      pages: [{ page: 1, pageSize: 50, recordCount: 1 }],
      sweeps: [1, 2].map((sweep) => ({
        sweep,
        productCount: 1,
        skuCount: 1,
        catalogFingerprint,
        terminalReason: 'SHORT_PAGE',
      })),
    },
    productDetails: {
      details: [{
        skuCode: 'SKU-1',
        skcName: 'SKC-1',
        spuName: 'SPU-1',
        supplierSku: 'SELLER-1',
        supplierCode: 'MODEL-1',
        productName: 'Product',
        categoryId: 'CAT-1',
        categoryName: 'Appliances',
        productTypeId: 'TYPE-1',
        brandCode: 'BRAND-1',
        mainImageUrl: 'https://CDN.EXAMPLE.com:443/images/main.jpg?width=800#preview',
        dimensions: {
          length: '10',
          width: '20',
          height: '30',
          weight: '1.5',
        },
        stopPurchaseCode: '0',
      }],
      batches: [{
        batchIndex: 0,
        skuCount: 1,
        responseCount: 1,
        requestFingerprint: 'a'.repeat(64),
        responseFingerprint: 'b'.repeat(64),
      }],
    },
  });

  assert.equal(result.catalogEnrichedSkuCount, 1);
  assert.equal(result.productDetailEnrichedCount, 1);
  const detailWrite = client.calls.find(({ sql }) => (
    sql.includes('UPDATE dim.full_sku')
    && sql.includes('main_image_url_hash')
  ));
  assert.ok(detailWrite);
  assert.equal(detailWrite.values[7], 'CAT-1');
  assert.equal(detailWrite.values[10], 'BRAND-1');
  assert.equal(
    detailWrite.values[11],
    productImageUrlHash('https://cdn.example.com/images/main.jpg'),
  );
  assert.equal(detailWrite.values[12], '10');
  assert.equal(detailWrite.values[16], '0');
  assert.equal(detailWrite.values.includes('https://CDN.EXAMPLE.com:443/images/main.jpg?width=800#preview'), false);
  assert.equal(client.calls.some(({ sql }) => (
    sql.includes("hashtext('full-managed-sales-loader')")
  )), true);
  assert.equal(client.calls.some(({ sql, values }) => (
    sql === 'SELECT pg_advisory_xact_lock(hashtext($1))'
    && values[0] === 'full-managed-catalog:1'
  )), true);
  const skuWrites = client.calls
    .map(({ sql }) => sql)
    .filter((sql) => /\bdim\.full_sku\b/.test(sql) && /\b(?:INSERT|UPDATE)\b/.test(sql));
  assert.ok(skuWrites.length >= 2);
  assert.ok(skuWrites.every((sql) => sql.trimStart().startsWith('UPDATE dim.full_sku')));
  assert.doesNotMatch(
    skuWrites.join('\n'),
    /\bis_active\s*=|\bcatalog_run_key\s*=|\bretired_at\s*=|\blast_seen_at\s*=/,
  );
});

test('product image URL hash strips query/fragment and rejects unsafe URLs', () => {
  const expected = productImageUrlHash('https://cdn.example.com/image/a.jpg');
  assert.equal(
    productImageUrlHash('https://CDN.EXAMPLE.com:443/image/a.jpg?size=800#hero'),
    expected,
  );
  assert.equal(productImageUrlHash('javascript:alert(1)'), null);
  assert.equal(productImageUrlHash('https://user:secret@example.com/image.jpg'), null);
  assert.equal(productImageUrlHash('not a URL'), null);
});

test('unstable product catalog is rejected before any warehouse transaction', async () => {
  const rejectingPool = {
    async connect() {
      throw new Error('must not connect');
    },
  };
  await assert.rejects(
    () => loadFullManagedSupplySnapshot(rejectingPool, {
      store: { storeCode: 'DL' },
      runId: 'catalog-unstable:DL',
      productCatalog: {
        stable: false,
        products: [],
        sweeps: [],
      },
    }),
    /requires two consecutive identical complete sweeps/,
  );
});

test('raw supply batch exact replay is immutable and time/payload drift is rejected', async () => {
  class ReplayClient extends FakeClient {
    constructor() {
      super();
      this.raw = new Map();
    }

    async query(sql, values = []) {
      this.calls.push({ sql, values });
      if (sql.includes('RETURNING store_id')) return { rows: [{ store_id: 1 }], rowCount: 1 };
      if (sql.includes('INSERT INTO raw.openapi_fetch_batch')) {
        const key = values[3];
        if (this.raw.has(key)) return { rows: [], rowCount: 0 };
        const row = {
          fetch_batch_id: this.ids.batch++,
          capability_code: values[1],
          endpoint_code: values[2],
          request_fingerprint: values[4],
          response_record_count: values[5],
          request_payload: JSON.parse(values[6]),
          response_payload: JSON.parse(values[7]),
          started_at: values[8],
          completed_at: values[8],
        };
        this.raw.set(key, row);
        return { rows: [{ fetch_batch_id: row.fetch_batch_id }], rowCount: 1 };
      }
      if (sql.includes('FROM raw.openapi_fetch_batch')) {
        const row = this.raw.get(values[1]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('RETURNING inventory_snapshot_id')) {
        return { rows: [{ inventory_snapshot_id: this.ids.inventory++ }], rowCount: 1 };
      }
      if (sql.includes('RETURNING full_warehouse_id')) {
        return { rows: [{ full_warehouse_id: this.ids.warehouse++ }], rowCount: 1 };
      }
      if (sql.includes('RETURNING supply_projection_batch_id')) {
        return {
          rows: [{ supply_projection_batch_id: this.ids.projection++ }],
          rowCount: 1,
        };
      }
      if (sql.includes('RETURNING supply_projection_member_id')) {
        return {
          rows: [{ supply_projection_member_id: this.ids.projectionMember++ }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    }
  }

  const client = new ReplayClient();
  const input = supplyInput();
  input.purchaseOrders = null;
  input.deliveries = null;
  await loadFullManagedSupplySnapshot(pool(client), input);
  await loadFullManagedSupplySnapshot(pool(client), input);
  const rawSql = client.calls
    .filter(({ sql }) => sql.includes('INSERT INTO raw.openapi_fetch_batch'))
    .map(({ sql }) => sql)
    .join('\n');
  assert.match(rawSql, /ON CONFLICT \(store_id, idempotency_key\) DO NOTHING/);
  assert.doesNotMatch(rawSql, /DO UPDATE/);

  await assert.rejects(
    () => loadFullManagedSupplySnapshot(pool(client), {
      ...input,
      sourceFetchedAt: '2026-07-26T12:00:01.000Z',
    }),
    /non-identical source evidence/,
  );
  const changed = structuredClone(input);
  changed.inventory.items[0].totalInventoryQuantity = 11;
  await assert.rejects(
    () => loadFullManagedSupplySnapshot(pool(client), changed),
    /non-identical source evidence/,
  );
});

test('projection replay is order-insensitive but rejects same-time member content drift', async () => {
  class ProjectionClient extends FakeClient {
    constructor() {
      super();
      this.projection = null;
      this.members = new Map();
      this.inventoryFacts = new Map();
    }

    async query(sql, values = []) {
      this.calls.push({ sql, values });
      if (sql.includes('RETURNING store_id')) return { rows: [{ store_id: 1 }], rowCount: 1 };
      if (sql.includes('FROM dim.full_sku') && sql.includes('AND is_active')) {
        return {
          rows: [
            { platform_sku_id: 'SKU-1' },
            { platform_sku_id: 'SKU-2' },
          ],
          rowCount: 2,
        };
      }
      if (sql.includes('INSERT INTO raw.openapi_fetch_batch')) {
        return { rows: [{ fetch_batch_id: this.ids.batch++ }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO fact.supply_projection_batch')) {
        if (this.projection) return { rows: [], rowCount: 0 };
        this.projection = {
          supply_projection_batch_id: this.ids.projection++,
          coverage_status_code: values[3],
          requested_count: values[4],
          observed_count: values[5],
          member_count: values[6],
          source_fetch_batch_id: values[7],
          payload_fingerprint: values[8],
          source_fetched_at: values[9],
        };
        return {
          rows: [{
            supply_projection_batch_id: this.projection.supply_projection_batch_id,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM fact.supply_projection_batch')) {
        return { rows: [this.projection], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO fact.supply_projection_member')) {
        const key = values[2];
        if (this.members.has(key)) return { rows: [], rowCount: 0 };
        this.members.set(key, {
          source_fetch_batch_id: values[3],
          payload_fingerprint: values[4],
          source_fetched_at: values[5],
        });
        return {
          rows: [{ supply_projection_member_id: this.ids.projectionMember++ }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM fact.supply_projection_member')) {
        const row = this.members.get(values[2]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO fact.inventory_snapshot')) {
        const key = `${values[1]}:${values[4]}:${values[15]}`;
        if (this.inventoryFacts.has(key)) return { rows: [], rowCount: 0 };
        const row = {
          inventory_snapshot_id: this.ids.inventory++,
          payload_fingerprint: values[14],
          source_fetched_at: values[15],
        };
        this.inventoryFacts.set(key, row);
        return { rows: [{ inventory_snapshot_id: row.inventory_snapshot_id }], rowCount: 1 };
      }
      if (sql.includes('FROM fact.inventory_snapshot')) {
        const key = `${values[1]}:${values[2]}:${values[3]}`;
        const row = this.inventoryFacts.get(key);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    }
  }

  function item(skuCode, quantity) {
    return {
      skuCode,
      skcName: `SKC-${skuCode}`,
      spuName: `SPU-${skuCode}`,
      totalInventoryQuantity: quantity,
      totalLockedQuantity: 0,
      totalTempLockQuantity: 0,
      totalUsableInventory: quantity,
      totalOutOfStockQty: 0,
      totalTransitQuantity: 0,
      warehouses: [],
      reconciliation: {
        status: 'TOTAL_ONLY',
        explanation: 'No warehouse detail.',
        checks: [],
      },
    };
  }
  const sourceFetchedAt = '2026-07-26T12:00:00.000Z';
  const base = {
    store: { storeCode: 'DL' },
    sourceFetchedAt,
    inventory: {
      queryDimension: 'SKU',
      requestedCodes: ['SKU-1', 'SKU-2'],
      inventoryType: 'PI',
      requestFingerprint: 'a'.repeat(64),
      coverage: {
        status: 'COMPLETE',
        requestedCount: 2,
        observedCount: 2,
        missingCodes: [],
      },
      items: [item('SKU-1', 1), item('SKU-2', 2)],
    },
  };
  const client = new ProjectionClient();
  await loadFullManagedSupplySnapshot(pool(client), {
    ...base,
    runId: 'projection-order-a:DL',
  });
  await loadFullManagedSupplySnapshot(pool(client), {
    ...base,
    runId: 'projection-order-b:DL',
    inventory: {
      ...base.inventory,
      items: [...base.inventory.items].reverse(),
    },
  });
  await assert.rejects(
    () => loadFullManagedSupplySnapshot(pool(client), {
      ...base,
      runId: 'projection-drift-c:DL',
      inventory: {
        ...base.inventory,
        items: [item('SKU-1', 99), item('SKU-2', 2)],
      },
    }),
    /projection batch replay drifted/,
  );
});

test('inventory completeness is measured against sales-owned active SKU membership', async () => {
  class ActiveMembershipClient extends FakeClient {
    async query(sql, values = []) {
      if (sql.includes('FROM dim.full_sku') && sql.includes('AND is_active')) {
        this.calls.push({ sql, values });
        return {
          rows: [
            { platform_sku_id: 'SKU-1' },
            { platform_sku_id: 'SKU-ACTIVE-NOT-REQUESTED' },
          ],
          rowCount: 2,
        };
      }
      return super.query(sql, values);
    }
  }
  const client = new ActiveMembershipClient();
  const input = supplyInput();
  input.purchaseOrders = null;
  input.deliveries = null;
  const result = await loadFullManagedSupplySnapshot(pool(client), input);
  assert.equal(result.inventoryCoverageStatus, 'PARTIAL');
  assert.equal(result.inventoryRequestedCount, 2);
  assert.equal(result.inventoryObservedCount, 1);
  assert.equal(result.inventoryMissingActiveSkuCount, 1);
  const projection = client.calls.find(({ sql }) => (
    sql.includes('INSERT INTO fact.supply_projection_batch')
  ));
  assert.equal(projection.values[3], 'PARTIAL');
  assert.equal(projection.values[4], 2);
  assert.equal(projection.values[5], 1);
});

test('JIT relation replacement is batch-canonical and does not infer completeness from absence', async () => {
  const sourceFetchedAt = '2026-07-26T12:00:00.000Z';
  const baseOrder = supplyInput().purchaseOrders.orders[0];
  const mother = {
    ...baseOrder,
    orderNo: 'PO-MOTHER',
    sourceUpdatedAt: '2026-07-26T10:00:00.000Z',
    lines: [],
    jitRelations: [{
      motherOrderNo: 'PO-MOTHER',
      childOrderNo: 'PO-CHILD',
    }],
    jitRelationsComplete: true,
    jitRelationScopes: ['AS_MOTHER'],
  };
  const childWithoutOfficialRelationFields = {
    ...baseOrder,
    orderNo: 'PO-CHILD',
    sourceUpdatedAt: '2026-07-26T11:00:00.000Z',
    lines: [],
    jitRelations: [],
    jitRelationsComplete: false,
    jitRelationScopes: [],
  };
  const client = new FakeClient();
  await loadFullManagedSupplySnapshot(pool(client), {
    store: { storeCode: 'DL' },
    runId: 'jit-batch-canonical:DL',
    sourceFetchedAt,
    purchaseOrders: {
      requestFingerprint: 'a'.repeat(64),
      incrementalStrategy: { callerSuppliedOverlap: true },
      pages: [{ page: 1, pageSize: 200, recordCount: 2 }],
      orders: [mother, childWithoutOfficialRelationFields],
    },
  });
  const relationInserts = client.calls.filter(({ sql }) => (
    sql.includes('INSERT INTO fact.purchase_order_jit_relation')
  ));
  assert.equal(relationInserts.length, 1);
  assert.equal(relationInserts[0].values[1], 'PO-MOTHER');
  assert.equal(relationInserts[0].values[2], 'PO-CHILD');
  assert.equal(relationInserts[0].values[5], sourceFetchedAt);

  const contradictoryClient = new FakeClient();
  await assert.rejects(
    () => loadFullManagedSupplySnapshot(pool(contradictoryClient), {
      store: { storeCode: 'DL' },
      runId: 'jit-batch-conflict:DL',
      sourceFetchedAt,
      purchaseOrders: {
        requestFingerprint: 'b'.repeat(64),
        incrementalStrategy: { callerSuppliedOverlap: true },
        pages: [{ page: 1, pageSize: 200, recordCount: 2 }],
        orders: [
          mother,
          {
            ...childWithoutOfficialRelationFields,
            jitRelationsComplete: true,
            jitRelationScopes: ['AS_CHILD'],
          },
        ],
      },
    }),
    /is contradictory/,
  );
  assert.equal(
    contradictoryClient.calls.some(({ sql }) => sql === 'ROLLBACK'),
    true,
  );
});

test('sync attempt ledger separates PI/VI/JI, live/backfill and rejects replay drift', async () => {
  class AttemptClient extends FakeClient {
    constructor() {
      super();
      this.events = new Map();
    }

    async query(sql, values = []) {
      this.calls.push({ sql, values });
      if (sql.includes('RETURNING store_id')) return { rows: [{ store_id: 1 }], rowCount: 1 };
      if (sql.includes('INSERT INTO ops.supply_sync_attempt')) {
        const key = `${values[2]}:${values[3]}:${values[1]}:${values[10]}`;
        if (this.events.has(key)) return { rows: [], rowCount: 0 };
        const row = {
          supply_sync_attempt_event_id: this.events.size + 1,
          request_fingerprint: values[14],
        };
        this.events.set(key, row);
        return { rows: [{ supply_sync_attempt_event_id: row.supply_sync_attempt_event_id }], rowCount: 1 };
      }
      if (sql.includes('FROM ops.supply_sync_attempt')) {
        const key = `${values[1]}:${values[2]}:${values[3]}:${values[4]}`;
        const row = this.events.get(key);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    }
  }

  const client = new AttemptClient();
  const base = {
    store: { storeCode: 'DL' },
    attemptId: 'attempt-20260726:DL:PI',
    domain: 'inventory',
    subtype: 'PI',
    mode: 'INCREMENTAL',
    window: {
      start: '2026-07-25T16:00:00.000Z',
      end: '2026-07-26T15:59:59.000Z',
    },
    requestedCount: 10,
    startedAt: '2026-07-26T12:00:00.000Z',
  };
  await recordFullManagedSupplySyncAttempt(pool(client), {
    ...base,
    status: 'STARTED',
  });
  await recordFullManagedSupplySyncAttempt(pool(client), {
    ...base,
    status: 'SUCCEEDED',
    observedCount: 10,
    completedAt: '2026-07-26T12:01:00.000Z',
  });
  await recordFullManagedSupplySyncAttempt(pool(client), {
    ...base,
    status: 'SUCCEEDED',
    observedCount: 10,
    completedAt: '2026-07-26T12:01:00.000Z',
  });
  await assert.rejects(
    () => recordFullManagedSupplySyncAttempt(pool(client), {
      ...base,
      status: 'SUCCEEDED',
      observedCount: 10,
      completedAt: '2026-07-26T12:02:00.000Z',
    }),
    /replay drifted/,
  );
  await recordFullManagedSupplySyncAttempt(pool(client), {
    ...base,
    attemptId: 'attempt-20260726:DL:VI',
    subtype: 'VI',
    mode: 'BACKFILL',
    freshnessScope: 'BACKFILL',
    status: 'PARTIAL',
    observedCount: 8,
    completedAt: '2026-07-26T12:03:00.000Z',
  });

  const inserts = client.calls.filter(({ sql }) => (
    sql.includes('INSERT INTO ops.supply_sync_attempt')
  ));
  assert.ok(inserts.every(({ sql }) => /ON CONFLICT DO NOTHING/.test(sql)));
  assert.ok(inserts.every(({ sql }) => !/DO UPDATE/.test(sql)));
  assert.equal(inserts.some(({ values }) => (
    values[3] === 'PI' && values[5] === 'LIVE'
  )), true);
  assert.equal(inserts.some(({ values }) => (
    values[3] === 'VI' && values[5] === 'BACKFILL'
  )), true);
});

test('failed attempt reason is sanitized before append-only persistence', async () => {
  const client = new FakeClient();
  await recordFullManagedSupplySyncAttempt(pool(client), {
    store: { storeCode: 'DL' },
    attemptId: 'attempt-failed-20260726:DL',
    domain: 'deliveries',
    mode: 'ROLLING_LOOKBACK',
    status: 'FAILED',
    errorCode: 'HTTP_500',
    errorReason: 'token=secret-value owner@example.com +86 138 0013 8000',
    startedAt: '2026-07-26T12:00:00.000Z',
    completedAt: '2026-07-26T12:00:10.000Z',
  });
  const insert = client.calls.find(({ sql }) => (
    sql.includes('INSERT INTO ops.supply_sync_attempt')
  ));
  assert.match(insert.values[12], /\[REDACTED\]/);
  assert.match(insert.values[12], /\[REDACTED_EMAIL\]/);
  assert.match(insert.values[12], /\[REDACTED_PHONE\]/);
  assert.doesNotMatch(insert.values[12], /secret-value|owner@example\.com|138 0013/);
});

test('sync health reads attempt truth instead of inferring health from raw success', async () => {
  const client = {
    async query(sql, values) {
      assert.equal(sql, SUPPLY_SYNC_HEALTH_SQL);
      assert.deepEqual(values, [[1], 'LIVE']);
      return { rows: [{
        store_id: '1',
        store_code: 'DL',
        store_name: 'DL',
        attempt_id: 'attempt-20260726:DL:PI',
        domain_code: 'INVENTORY',
        subtype_code: 'PI',
        mode_code: 'INCREMENTAL',
        freshness_scope_code: 'LIVE',
        window_start_at: '2026-07-25T16:00:00.000Z',
        window_end_at: '2026-07-26T15:59:59.000Z',
        requested_count: '10',
        observed_count: '8',
        status_code: 'PARTIAL',
        error_code: 'PARTIAL_COVERAGE',
        error_reason: 'Two identifiers were omitted.',
        started_at: '2026-07-26T12:00:00.000Z',
        completed_at: '2026-07-26T12:01:00.000Z',
      }] };
    },
  };
  const result = await readFullManagedSupplySyncHealth(client, { storeIds: [1] });
  assert.equal(result[0].status, 'PARTIAL');
  assert.equal(result[0].observedCount, 8);
  assert.equal(result[0].freshnessScope, 'LIVE');
});

test('read-only supply dashboard exposes scoped operational quantities and milestones', async () => {
  const scopes = [];
  const sourceTime = '2026-07-26T12:00:00.000Z';
  const client = {
    async query(sql, values) {
      scopes.push(values[0]);
      if (sql === SUPPLY_DASHBOARD_SQL.purchaseOrderStatus) {
        return { rows: [{
          store_id: '1',
          store_code: 'DL',
          store_name: 'DL',
          status_code: '987',
          status_name: 'Future',
          order_count: '2',
          latest_source_fetched_at: sourceTime,
        }] };
      }
      if (sql === SUPPLY_DASHBOARD_SQL.deliveryMilestones) {
        return { rows: [{
          store_id: '1',
          store_code: 'DL',
          store_name: 'DL',
          milestone_code: 'IN_TRANSIT',
          delivery_count: '1',
          delivery_quantity: '5',
          known_delivery_quantity_line_count: '1',
          total_delivery_line_count: '1',
          latest_source_fetched_at: sourceTime,
        }] };
      }
      if (sql === SUPPLY_DASHBOARD_SQL.inventory) {
        return { rows: [{
          store_id: '1',
          store_code: 'DL',
          store_name: 'DL',
          inventory_type_code: 'PI',
          coverage_status_code: 'COMPLETE',
          requested_count: '3',
          observed_count: '3',
          member_count: '3',
          inactive_filtered_sku_count: '0',
          sku_count: '3',
          inventory_quantity: '10',
          usable_inventory: '8',
          transit_quantity: '2',
          transit_known_sku_count: '3',
          shortage_sku_count: '1',
          shortage_quantity: '4',
          shortage_known_sku_count: '3',
          reconciliation_mismatch_count: '0',
          latest_source_fetched_at: sourceTime,
        }] };
      }
      if (sql === SUPPLY_DASHBOARD_SQL.stockAdvice) return { rows: [{
        store_id: '1',
        store_code: 'DL',
        store_name: 'DL',
        coverage_status_code: 'COMPLETE',
        requested_count: null,
        observed_count: '3',
        member_count: '3',
        inactive_filtered_sku_count: '0',
        total_sku_count: '3',
        advised_order_known_sku_count: '3',
        advised_sku_count: '2',
        advised_order_quantity: '7',
        planned_urgent_known_sku_count: '3',
        planned_urgent_quantity: '1',
        warning_known_sku_count: '3',
        warning_sku_count: '1',
        latest_source_fetched_at: sourceTime,
      }] };
      return { rows: [] };
    },
  };

  const result = await readFullManagedSupplyDashboard(client, { storeIds: [1, 1] });
  assert.deepEqual(scopes, [[1], [1], [1], [1], [1], [1], [1], [1]]);
  assert.equal(result.purchaseOrderStatus[0].orderCount, 2);
  assert.equal(result.deliveryMilestones[0].deliveryQuantity, 5);
  assert.equal(result.inventory[0].shortageQuantity, 4);
  assert.equal(result.stockAdvice[0].advisedOrderQuantity, 7);
  assert.deepEqual(result.inventory[0].shortageCoverage, {
    knownSkuCount: 3,
    totalSkuCount: 3,
  });
  assert.deepEqual(result.inventory[0].projectionCoverage, {
    status: 'COMPLETE',
    requestedIdentifierCount: 3,
    observedIdentifierCount: 3,
    memberSkuCount: 3,
    inactiveFilteredSkuCount: 0,
  });
  assert.match(SUPPLY_DASHBOARD_SQL.inventory, /fact\.supply_projection_batch/);
  assert.match(SUPPLY_DASHBOARD_SQL.inventory, /snapshot\.source_fetch_batch_id = latest_batch\.source_fetch_batch_id/);
  assert.match(SUPPLY_DASHBOARD_SQL.stockAdvice, /advice\.source_fetch_batch_id = latest_batch\.source_fetch_batch_id/);
  assert.match(SUPPLY_DASHBOARD_SQL.inventory, /sku\.is_active/);
  assert.match(SUPPLY_DASHBOARD_SQL.stockAdvice, /sku\.is_active/);
  assert.doesNotMatch(
    SUPPLY_DASHBOARD_SQL.inventory,
    /PARTITION BY snapshot\.store_id, snapshot\.sku_code/,
  );
  assert.doesNotMatch(JSON.stringify(SUPPLY_DASHBOARD_SQL), /phone|address|person/i);
});

test('read-only summaries preserve all-unknown as null and known zero as zero', async () => {
  const sourceTime = '2026-07-26T12:00:00.000Z';
  const common = (id, code) => ({
    store_id: String(id),
    store_code: code,
    store_name: code,
    latest_source_fetched_at: sourceTime,
  });
  const client = {
    async query(sql) {
      if (sql === SUPPLY_DASHBOARD_SQL.purchaseOrderStatus) return { rows: [] };
      if (sql === SUPPLY_DASHBOARD_SQL.deliveryMilestones) {
        return { rows: [{
          ...common(1, 'UNKNOWN'),
          milestone_code: 'CREATED',
          delivery_count: '1',
          delivery_quantity: null,
          known_delivery_quantity_line_count: '0',
          total_delivery_line_count: '2',
        }, {
          ...common(2, 'ZERO'),
          milestone_code: 'CREATED',
          delivery_count: '1',
          delivery_quantity: '0',
          known_delivery_quantity_line_count: '2',
          total_delivery_line_count: '2',
        }] };
      }
      if (sql === SUPPLY_DASHBOARD_SQL.inventory) {
        return { rows: [{
          ...common(1, 'UNKNOWN'),
          inventory_type_code: 'PI',
          coverage_status_code: 'PARTIAL',
          requested_count: '3',
          observed_count: '2',
          member_count: '2',
          inactive_filtered_sku_count: '0',
          sku_count: '2',
          inventory_quantity: null,
          usable_inventory: null,
          transit_quantity: null,
          transit_known_sku_count: '0',
          shortage_sku_count: null,
          shortage_quantity: null,
          shortage_known_sku_count: '0',
          reconciliation_mismatch_count: null,
        }, {
          ...common(2, 'ZERO'),
          inventory_type_code: 'PI',
          coverage_status_code: 'COMPLETE',
          requested_count: '2',
          observed_count: '2',
          member_count: '2',
          inactive_filtered_sku_count: '0',
          sku_count: '2',
          inventory_quantity: '10',
          usable_inventory: '8',
          transit_quantity: '0',
          transit_known_sku_count: '2',
          shortage_sku_count: '0',
          shortage_quantity: '0',
          shortage_known_sku_count: '2',
          reconciliation_mismatch_count: '0',
        }] };
      }
      if (sql === SUPPLY_DASHBOARD_SQL.stockAdvice) return { rows: [{
        ...common(1, 'UNKNOWN'),
        coverage_status_code: 'PARTIAL',
        requested_count: '3',
        observed_count: '2',
        member_count: '2',
        inactive_filtered_sku_count: '0',
        total_sku_count: '2',
        advised_order_known_sku_count: '0',
        advised_sku_count: null,
        advised_order_quantity: null,
        planned_urgent_known_sku_count: '0',
        planned_urgent_quantity: null,
        warning_known_sku_count: '0',
        warning_sku_count: null,
      }, {
        ...common(2, 'ZERO'),
        coverage_status_code: 'COMPLETE',
        requested_count: null,
        observed_count: '2',
        member_count: '2',
        inactive_filtered_sku_count: '0',
        total_sku_count: '2',
        advised_order_known_sku_count: '2',
        advised_sku_count: '0',
        advised_order_quantity: '0',
        planned_urgent_known_sku_count: '2',
        planned_urgent_quantity: '0',
        warning_known_sku_count: '2',
        warning_sku_count: '0',
      }] };
      return { rows: [] };
    },
  };

  const result = await readFullManagedSupplyDashboard(client);
  assert.equal(result.deliveryMilestones[0].deliveryQuantity, null);
  assert.equal(result.deliveryMilestones[1].deliveryQuantity, 0);
  assert.equal(result.inventory[0].transitQuantity, null);
  assert.equal(result.inventory[0].shortageSkuCount, null);
  assert.equal(result.inventory[0].shortageQuantity, null);
  assert.equal(result.inventory[1].transitQuantity, 0);
  assert.equal(result.inventory[1].shortageSkuCount, 0);
  assert.equal(result.inventory[1].shortageQuantity, 0);
  assert.equal(result.stockAdvice[0].advisedSkuCount, null);
  assert.equal(result.stockAdvice[0].advisedOrderQuantity, null);
  assert.equal(result.stockAdvice[0].plannedUrgentQuantity, null);
  assert.equal(result.stockAdvice[0].warningSkuCount, null);
  assert.equal(result.stockAdvice[1].advisedSkuCount, 0);
  assert.equal(result.stockAdvice[1].advisedOrderQuantity, 0);
  assert.equal(result.stockAdvice[1].plannedUrgentQuantity, 0);
  assert.equal(result.stockAdvice[1].warningSkuCount, 0);
  assert.deepEqual(result.stockAdvice[0].warningCoverage, {
    knownSkuCount: 0,
    totalSkuCount: 2,
  });
});

test('complete empty batches clear current inventory/advice while partial batches stay unknown', async () => {
  const sourceTime = '2026-07-26T12:00:00.000Z';
  const client = {
    async query(sql) {
      if (
        sql === SUPPLY_DASHBOARD_SQL.purchaseOrderStatus
        || sql === SUPPLY_DASHBOARD_SQL.deliveryMilestones
      ) return { rows: [] };
      if (sql === SUPPLY_DASHBOARD_SQL.inventory) {
        return { rows: [{
          store_id: '1',
          store_code: 'DL',
          store_name: 'DL',
          inventory_type_code: 'PI',
          coverage_status_code: 'COMPLETE',
          requested_count: '0',
          observed_count: '0',
          member_count: '0',
          inactive_filtered_sku_count: '0',
          sku_count: '0',
          inventory_quantity: '0',
          usable_inventory: '0',
          transit_quantity: '0',
          transit_known_sku_count: '0',
          shortage_sku_count: '0',
          shortage_quantity: '0',
          shortage_known_sku_count: '0',
          reconciliation_mismatch_count: '0',
          latest_source_fetched_at: sourceTime,
        }, {
          store_id: '1',
          store_code: 'DL',
          store_name: 'DL',
          inventory_type_code: 'VI',
          coverage_status_code: 'PARTIAL',
          requested_count: '2',
          observed_count: '0',
          member_count: '0',
          inactive_filtered_sku_count: '0',
          sku_count: '0',
          inventory_quantity: null,
          usable_inventory: null,
          transit_quantity: null,
          transit_known_sku_count: '0',
          shortage_sku_count: null,
          shortage_quantity: null,
          shortage_known_sku_count: '0',
          reconciliation_mismatch_count: null,
          latest_source_fetched_at: sourceTime,
        }] };
      }
      if (sql === SUPPLY_DASHBOARD_SQL.stockAdvice) return { rows: [{
        store_id: '1',
        store_code: 'DL',
        store_name: 'DL',
        coverage_status_code: 'COMPLETE',
        requested_count: null,
        observed_count: '0',
        member_count: '0',
        inactive_filtered_sku_count: '0',
        total_sku_count: '0',
        advised_order_known_sku_count: '0',
        advised_sku_count: '0',
        advised_order_quantity: '0',
        planned_urgent_known_sku_count: '0',
        planned_urgent_quantity: '0',
        warning_known_sku_count: '0',
        warning_sku_count: '0',
        latest_source_fetched_at: sourceTime,
      }] };
      return { rows: [] };
    },
  };
  const result = await readFullManagedSupplyDashboard(client);
  assert.equal(result.inventory[0].inventoryQuantity, 0);
  assert.equal(result.inventory[0].shortageQuantity, 0);
  assert.equal(result.inventory[1].inventoryQuantity, null);
  assert.equal(result.inventory[1].shortageQuantity, null);
  assert.equal(result.inventory[1].reconciliationMismatchCount, null);
  assert.equal(result.stockAdvice[0].advisedOrderQuantity, 0);
  assert.equal(result.stockAdvice[0].warningSkuCount, 0);
});

test('safe dashboard counts reject null instead of silently converting unknown to zero', async () => {
  const client = {
    async query(sql) {
      if (sql === SUPPLY_DASHBOARD_SQL.purchaseOrderStatus) {
        return { rows: [{
          store_id: '1',
          store_code: 'DL',
          store_name: 'DL',
          status_code: 'UNKNOWN',
          status_name: null,
          order_count: null,
          latest_source_fetched_at: null,
        }] };
      }
      return { rows: [] };
    },
  };
  await assert.rejects(
    () => readFullManagedSupplyDashboard(client),
    /order_count must be a non-negative safe integer/,
  );
});

test('read-only attention details preserve unknown quantities, decimals and explicit truncation', async () => {
  const sourceTime = '2026-07-26T12:00:00.000Z';
  const common = {
    store_id: '1',
    store_code: 'DL5477',
    store_name: 'DL5477',
    latest_source_fetched_at: sourceTime,
  };
  const client = {
    async query(sql, values) {
      assert.deepEqual(values, [[1]]);
      if (
        sql === SUPPLY_DASHBOARD_SQL.purchaseOrderStatus
        || sql === SUPPLY_DASHBOARD_SQL.deliveryMilestones
        || sql === SUPPLY_DASHBOARD_SQL.inventory
        || sql === SUPPLY_DASHBOARD_SQL.stockAdvice
      ) return { rows: [] };
      if (sql === SUPPLY_DASHBOARD_SQL.purchaseOrderAttention) {
        return { rows: [{
          ...common,
          order_no: 'PO-OVERDUE-1',
          status_code: '2',
          status_name: '待交付',
          order_type_name: '首单',
          warehouse_name: '华南仓',
          requested_delivery_at: '2026-07-25T00:00:00.000Z',
          requested_receipt_at: null,
          delivered_at: null,
          received_at: null,
          stored_at: null,
          line_count: '2',
          order_quantity: null,
          delivery_quantity: '0',
          receipt_quantity: null,
          storage_quantity: null,
          defective_quantity: null,
          attention_code: 'DELIVERY_OVERDUE',
          attention_label: '采购单已超过要求交付时间',
          severity: 'critical',
          total_count: '250',
        }] };
      }
      if (sql === SUPPLY_DASHBOARD_SQL.deliveryAttention) {
        return { rows: [{
          ...common,
          delivery_code: 'DELIVERY-1',
          milestone_code: 'IN_TRANSIT',
          warehouse_name: '华南仓',
          express_code: 'EXP-1',
          express_company_name: '承运商',
          reserved_parcel_at: '2026-07-24T00:00:00.000Z',
          taken_at: '2026-07-24T08:00:00.000Z',
          expected_receipt_at: '2026-07-25T00:00:00.000Z',
          received_at: null,
          line_count: '1',
          delivery_quantity: null,
          attention_code: 'RECEIPT_OVERDUE',
          attention_label: '送货单已超过预计收货时间',
          severity: 'critical',
          total_count: '1',
        }] };
      }
      if (sql === SUPPLY_DASHBOARD_SQL.inventoryRisks) {
        return { rows: [{
          ...common,
          sku_code: 'SKU-1',
          skc_name: null,
          spu_name: 'SPU-1',
          inventory_type_code: 'PI',
          total_inventory: '8',
          usable_inventory: '3',
          transit_quantity: null,
          shortage_quantity: '5',
          reconciliation_status: 'MISMATCH',
          severity: 'critical',
          total_count: '1',
        }] };
      }
      if (sql === SUPPLY_DASHBOARD_SQL.stockAdviceRisks) {
        return { rows: [{
          ...common,
          sku_code: 'SKU-1',
          skc_name: 'SKC-1',
          spu_name: 'SPU-1',
          supplier_code: 'SUPPLIER-1',
          predicted_daily_sales: '1.25',
          pending_order_quantity: null,
          pending_delivery_quantity: '0',
          pending_shelf_quantity: '2',
          transit_quantity: null,
          stock_quantity: '3',
          advised_order_quantity: '4',
          placed_order_quantity: null,
          planned_urgent_quantity: '2',
          supply_status_code: null,
          shelf_status_code: 'ON_SHELF',
          stock_warning_status_code: 'WARN',
          stock_warning_is_warning: true,
          severity: 'critical',
          total_count: '1',
        }] };
      }
      throw new Error('unexpected query');
    },
  };

  const result = await readFullManagedSupplyDashboard(client, { storeIds: [1] });
  assert.equal(result.purchaseOrderAttention[0].orderQuantity, null);
  assert.equal(result.purchaseOrderAttention[0].deliveryQuantity, 0);
  assert.equal(result.deliveryAttention[0].deliveryQuantity, null);
  assert.equal(result.inventoryRisks[0].skuCode, 'SKU-1');
  assert.equal(result.inventoryRisks[0].skcName, null);
  assert.equal(result.inventoryRisks[0].transitQuantity, null);
  assert.equal(result.stockAdviceRisks[0].predictedDailySales, 1.25);
  assert.equal(result.stockAdviceRisks[0].pendingOrderQuantity, null);
  assert.equal(result.stockAdviceRisks[0].pendingDeliveryQuantity, 0);
  assert.equal(result.stockAdviceRisks[0].supplierCode, 'SUPPLIER-1');
  assert.equal(result.stockAdviceRisks[0].stockWarningIsWarning, true);
  assert.deepEqual(result.attentionMeta.purchaseOrders, {
    total: 250,
    returned: 1,
    truncated: true,
  });

  assert.match(SUPPLY_DASHBOARD_SQL.purchaseOrderAttention, /clock_timestamp\(\)/);
  assert.match(SUPPLY_DASHBOARD_SQL.purchaseOrderAttention, /line\.is_current/);
  assert.match(SUPPLY_DASHBOARD_SQL.purchaseOrderAttention, /NOT IN \('7', '8', '10'\)/);
  assert.match(
    SUPPLY_DASHBOARD_SQL.purchaseOrderAttention,
    /WHERE[\s\S]*NOT IN \('7', '8', '10'\)[\s\S]*!~ '\(已完成\|已作废\|已退货\)'[\s\S]*AND \(\s*line_totals\.defective_quantity > 0\s*OR purchase_order\.stored_at IS NULL\s*\)/,
  );
  assert.equal(
    (
      SUPPLY_DASHBOARD_SQL.purchaseOrderAttention.match(
        /WHEN purchase_order\.received_at IS NULL\s+AND purchase_order\.delivered_at IS NULL/g,
      ) ?? []
    ).length,
    3,
  );
  assert.match(SUPPLY_DASHBOARD_SQL.deliveryAttention, /delivery\.received_at IS NULL/);
  assert.match(
    SUPPLY_DASHBOARD_SQL.deliveryAttention,
    /WHEN delivery\.received_at IS NULL\s+AND delivery\.expected_receipt_at IS NOT NULL[\s\S]*THEN 'RECEIPT_OVERDUE'/,
  );
  assert.match(SUPPLY_DASHBOARD_SQL.deliveryAttention, /line\.is_current/);
  assert.match(SUPPLY_DASHBOARD_SQL.inventoryRisks, /source_batch\.status = 'SUCCEEDED'/);
  assert.match(SUPPLY_DASHBOARD_SQL.inventoryRisks, /sku\.is_active/);
  assert.match(SUPPLY_DASHBOARD_SQL.stockAdviceRisks, /source_batch\.status = 'SUCCEEDED'/);
  assert.match(SUPPLY_DASHBOARD_SQL.stockAdviceRisks, /sku\.is_active/);
  assert.doesNotMatch(
    JSON.stringify({
      purchaseOrderAttention: SUPPLY_DASHBOARD_SQL.purchaseOrderAttention,
      deliveryAttention: SUPPLY_DASHBOARD_SQL.deliveryAttention,
    }),
    /phone|address|contact|person/i,
  );
});

test('purchase guard codes are fixed, unique and bounded', () => {
  assert.equal(Object.isFrozen(PURCHASE_ORDER_LOAD_ERROR_CODES), true);
  const codes = Object.values(PURCHASE_ORDER_LOAD_ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.match(code, /^[A-Z0-9_]{3,80}$/);
});

for (const scenario of [
  { name: 'incomplete lines', code: 'PURCHASE_ORDER_LINE_SET_INCOMPLETE',
    mutate: (order) => { order.linesComplete = false; }, message: /complete line set/ },
  { name: 'invalid JIT evidence', code: 'PURCHASE_ORDER_JIT_EVIDENCE_INVALID',
    mutate: (order) => { order.jitRelations = null; }, message: /invalid JIT relation evidence/ },
  { name: 'same-time drift', code: 'PURCHASE_ORDER_SAME_TIME_PAYLOAD_DRIFT',
    mutate: () => {}, message: /identical source timestamp/, existing: true },
]) {
  test(`purchase ${scenario.name} preserves rejection and rolls back with a safe code`, async () => {
    const input = supplyInput();
    input.inventory = null;
    input.deliveries = null;
    const order = input.purchaseOrders.orders[0];
    order.orderNo = 'PRIVATE-ORDER-SENTINEL';
    scenario.mutate(order);
    class GuardClient extends FakeClient {
      async query(sql, values = []) {
        if (scenario.existing && sql.includes('SELECT purchase_order_id, payload_fingerprint, source_fetched_at')) {
          this.calls.push({ sql, values });
          return { rows: [{ purchase_order_id: 40, payload_fingerprint: '0'.repeat(64),
            source_fetched_at: input.sourceFetchedAt }], rowCount: 1 };
        }
        return super.query(sql, values);
      }
    }
    const client = new GuardClient();
    await assert.rejects(() => loadFullManagedSupplySnapshot(pool(client), input), (error) => {
      assert.equal(error.code, scenario.code);
      assert.match(error.message, scenario.message);
      assert.doesNotMatch(error.code, /PRIVATE|SENTINEL|SKU-1/);
      return true;
    });
    assert.equal(client.calls.some(({ sql }) => sql === 'ROLLBACK'), true);
    assert.equal(client.calls.some(({ sql }) => sql === 'COMMIT'), false);
    assert.equal(client.released, true);
  });
}
