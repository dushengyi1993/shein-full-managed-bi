import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadFullManagedSalesSync,
  persistPermissionProbe,
  salesWindows,
  sha256,
  stableJson,
} from '../../src/warehouse/full-managed-sales-repository.mjs';

class FakeClient {
  constructor({ failOnFact = false, existingFacts = false, driftFacts = false } = {}) {
    this.calls = [];
    this.ids = { fetch: 10, sku: 100, fact: 1000 };
    this.failOnFact = failOnFact;
    this.existingFacts = existingFacts;
    this.driftFacts = driftFacts;
    this.released = false;
  }

  async query(sql, values = []) {
    this.calls.push({ sql, values });
    if (this.failOnFact && sql.includes('INSERT INTO fact.full_sku_sales_snapshot')) {
      throw new Error('fact insert failed');
    }
    if (sql.includes('SELECT sales_snapshot_id, payload_fingerprint')) {
      if (!this.existingFacts && !this.driftFacts) return { rows: [], rowCount: 0 };
      return {
        rows: [{ sales_snapshot_id: this.ids.fact++, payload_fingerprint: this.driftFacts ? '0'.repeat(64) : values[4] }],
        rowCount: 1,
      };
    }
    if (sql.includes('RETURNING store_id')) return { rows: [{ store_id: 1 }], rowCount: 1 };
    if (sql.includes('RETURNING fetch_batch_id')) return { rows: [{ fetch_batch_id: this.ids.fetch++ }], rowCount: 1 };
    if (sql.includes('RETURNING full_sku_id')) return { rows: [{ full_sku_id: this.ids.sku++ }], rowCount: 1 };
    if (sql.includes('RETURNING sales_snapshot_id')) return { rows: [{ sales_snapshot_id: this.ids.fact++ }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }

  release() {
    this.released = true;
  }
}

function pool(client) {
  return { async connect() { return client; } };
}

function syncInput() {
  return {
    store: { storeCode: 'DL', storeName: 'DL' },
    runId: 'sync-20260720:DL',
    permissionPackageCode: 'SALES',
    inventory: {
      items: [
        { skuCode: 'SKU-1', skc: 'SKC-1', supplierSku: 'S-1', attribute: 'Red' },
        { skuCode: 'SKU-2', skc: 'SKC-1', supplierSku: 'S-2', attribute: 'Blue' },
      ],
      pages: [{ page: 1, recordCount: 2, traceId: 'safe-trace' }],
    },
    sales: {
      snapshots: [
        {
          storeCode: 'DL', skuCode: 'SKU-1', statisticsDate: '2026-07-20',
          fetchedAt: '2026-07-20T04:00:00.000Z', salesToday: 1, salesYesterday: 2, sales7Days: 7, sales30Days: 30,
        },
        {
          storeCode: 'DL', skuCode: 'SKU-2', statisticsDate: '2026-07-20',
          fetchedAt: '2026-07-20T04:00:00.000Z', salesToday: 3, salesYesterday: 4, sales7Days: 14, sales30Days: 60,
        },
      ],
      batches: [{ batchIndex: 0, skuCount: 2, responseRecordCount: 2, traceId: 'safe-trace', message: 'OK' }],
    },
  };
}

test('stable fingerprints do not depend on object key order', () => {
  assert.equal(stableJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(sha256(stableJson({ b: 2, a: 1 })), sha256(stableJson({ a: 1, b: 2 })));
});

test('derives four half-open Asia/Shanghai measurement windows', () => {
  const windows = salesWindows('2026-07-20');
  assert.deepEqual(
    Object.fromEntries(Object.entries(windows).map(([key, range]) => [key, range.map((date) => date.toISOString())])),
    {
      today: ['2026-07-19T16:00:00.000Z', '2026-07-20T16:00:00.000Z'],
      yesterday: ['2026-07-18T16:00:00.000Z', '2026-07-19T16:00:00.000Z'],
      last7Days: ['2026-07-13T16:00:00.000Z', '2026-07-20T16:00:00.000Z'],
      last30Days: ['2026-06-20T16:00:00.000Z', '2026-07-20T16:00:00.000Z'],
    },
  );
});

test('loads store, raw batches, SKU identities and four facts per SKU then refreshes both marts in one transaction', async () => {
  const client = new FakeClient();
  const result = await loadFullManagedSalesSync(pool(client), syncInput());
  assert.deepEqual(result, { storeCode: 'DL', skuCount: 2, factCount: 8, batchCount: 2 });
  assert.equal(client.calls[0].sql, 'BEGIN');
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
  assert.equal(client.released, true);
  assert.equal(client.calls.filter(({ sql }) => sql.includes('INSERT INTO fact.full_sku_sales_snapshot')).length, 8);
  assert.equal(client.calls.some(({ sql }) => sql.includes('DELETE FROM mart.full_store_sales_latest')), true);
  assert.equal(client.calls.some(({ sql }) => sql.includes('DELETE FROM mart.full_product_sales_latest')), true);
  const probeInsert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.permission_probe'));
  assert.deepEqual(JSON.parse(probeInsert.values[9]), {
    endpointReached: 'goods.query-sku-sales',
    salesEndpointExercised: true,
    statisticsDateAvailable: true,
    dataLoadable: true,
    dataQualityStatus: 'VALID',
    dataQualityReason: null,
  });

  const serializedValues = JSON.stringify(client.calls.flatMap(({ values }) => values));
  assert.doesNotMatch(serializedValues, /secret|openKey|signature|cookie/i);
});

test('rolls back the entire store load when a fact fails', async () => {
  const client = new FakeClient({ failOnFact: true });
  await assert.rejects(() => loadFullManagedSalesSync(pool(client), syncInput()), /fact insert failed/);
  assert.equal(client.calls.some(({ sql }) => sql === 'ROLLBACK'), true);
  assert.equal(client.calls.some(({ sql }) => sql === 'COMMIT'), false);
  assert.equal(client.released, true);
});

test('a retry with the same source batch and payload is an idempotent fact no-op', async () => {
  const client = new FakeClient({ existingFacts: true });
  const result = await loadFullManagedSalesSync(pool(client), syncInput());
  assert.equal(result.factCount, 8);
  assert.equal(client.calls.filter(({ sql }) => sql.includes('INSERT INTO fact.full_sku_sales_snapshot')).length, 0);
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
});

test('same idempotency grain with different payload fingerprint fails closed', async () => {
  const client = new FakeClient({ driftFacts: true });
  await assert.rejects(() => loadFullManagedSalesSync(pool(client), syncInput()), /drifted/);
  assert.equal(client.calls.some(({ sql }) => sql === 'ROLLBACK'), true);
});

test('refuses partial sales coverage before beginning a database transaction', async () => {
  const input = syncInput();
  input.sales.snapshots.pop();
  const client = new FakeClient();
  await assert.rejects(() => loadFullManagedSalesSync(pool(client), input), /Every inventory SKU/);
  assert.equal(client.calls.length, 0);
});

test('fails closed on duplicate, mismatched, or incomplete sales load coverage', async (t) => {
  const cases = [
    {
      name: 'duplicate inventory SKU',
      mutate(input) { input.inventory.items[1].skuCode = 'SKU-1'; },
      message: /Inventory contains a duplicate SKU/,
    },
    {
      name: 'duplicate sales SKU',
      mutate(input) { input.sales.snapshots[1].skuCode = 'SKU-1'; },
      message: /Sales snapshots contain a duplicate SKU/,
    },
    {
      name: 'equal-size but different SKU sets',
      mutate(input) { input.sales.snapshots[1].skuCode = 'SKU-3'; },
      message: /SKU sets must match exactly/,
    },
    {
      name: 'wrong snapshot store',
      mutate(input) { input.sales.snapshots[1].storeCode = 'OTHER'; },
      message: /store code does not match/,
    },
    {
      name: 'mixed statistics dates',
      mutate(input) { input.sales.snapshots[1].statisticsDate = '2026-07-21'; },
      message: /one statistics date/,
    },
    {
      name: 'non-contiguous batch index',
      mutate(input) { input.sales.batches[0].batchIndex = 1; },
      message: /indexes must be contiguous/,
    },
    {
      name: 'response count mismatch',
      mutate(input) { input.sales.batches[0].responseRecordCount = 1; },
      message: /response count must match/,
    },
    {
      name: 'batch evidence omits one snapshot',
      mutate(input) {
        input.sales.batches[0].skuCount = 1;
        input.sales.batches[0].responseRecordCount = 1;
      },
      message: /evidence must cover every snapshot/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const input = structuredClone(syncInput());
      entry.mutate(input);
      const client = new FakeClient();
      await assert.rejects(() => loadFullManagedSalesSync(pool(client), input), entry.message);
      assert.equal(client.calls.length, 0);
    });
  }
});

test('persists sanitized permission and data-quality evidence without credentials', async () => {
  const client = new FakeClient();
  const result = await persistPermissionProbe(pool(client), {
    store: { storeCode: 'DL', storeName: 'DL' },
    runId: 'probe-20260726:DL',
    permissionPackageCode: 'SALES',
    probe: {
      outcome: 'GRANTED',
      probedAt: '2026-07-26T11:00:00.000Z',
      httpStatus: 200,
      platformErrorCode: null,
      platformMessage: 'query-sku-sales returned code 0, but dt was empty.',
      evidence: {
        endpointReached: '/open-api/goods/query-sku-sales',
        salesEndpointExercised: true,
        statisticsDateAvailable: false,
        dataLoadable: false,
        dataQualityStatus: 'DEGRADED',
        dataQualityReason: 'MISSING_STATISTICS_DATE',
        secretKey: 'must-not-persist',
      },
    },
  });

  assert.deepEqual(result, { storeCode: 'DL', outcome: 'GRANTED' });
  const insert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.permission_probe'));
  assert.ok(insert);
  assert.deepEqual(JSON.parse(insert.values[9]), {
    endpointReached: '/open-api/goods/query-sku-sales',
    salesEndpointExercised: true,
    statisticsDateAvailable: false,
    dataLoadable: false,
    dataQualityStatus: 'DEGRADED',
    dataQualityReason: 'MISSING_STATISTICS_DATE',
  });
  assert.doesNotMatch(JSON.stringify(insert.values), /must-not-persist/);
});
