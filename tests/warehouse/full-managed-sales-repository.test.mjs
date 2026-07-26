import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadFullManagedSalesSync,
  MIXED_STATISTICS_DATES_CODE,
  MIXED_STATISTICS_DATES_MESSAGE,
  persistPermissionProbe,
  salesWindows,
  sha256,
  stableJson,
} from '../../src/warehouse/full-managed-sales-repository.mjs';

class FakeClient {
  constructor({ failOnFact = false, existingFacts = false, driftFacts = false } = {}) {
    this.calls = [];
    this.ids = { fetch: 10, sku: 100, fact: 1000, run: 2000, probe: 3000 };
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
    if (sql.includes('RETURNING sales_sync_run_id')) return { rows: [{ sales_sync_run_id: this.ids.run++ }], rowCount: 1 };
    if (sql.includes('RETURNING permission_probe_id')) return { rows: [{ permission_probe_id: this.ids.probe++ }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }

  release() {
    this.released = true;
  }
}

class ReplayClient extends FakeClient {
  constructor({ rawMatches = true, runMatches = true } = {}) {
    super({ existingFacts: true });
    this.rawMatches = rawMatches;
    this.runMatches = runMatches;
  }

  async query(sql, values = []) {
    if (sql.includes('INSERT INTO raw.openapi_fetch_batch')) {
      this.calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT fetch_batch_id')) {
      this.calls.push({ sql, values });
      return this.rawMatches
        ? { rows: [{ fetch_batch_id: this.ids.fetch++ }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO ops.sales_sync_run')) {
      this.calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT sales_sync_run_id')) {
      this.calls.push({ sql, values });
      return this.runMatches
        ? { rows: [{ sales_sync_run_id: this.ids.run++ }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return super.query(sql, values);
  }
}

class ProbeReplayClient extends FakeClient {
  constructor({ matches = true } = {}) {
    super();
    this.matches = matches;
  }

  async query(sql, values = []) {
    if (sql.includes('INSERT INTO ops.permission_probe')) {
      this.calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT permission_probe_id')) {
      this.calls.push({ sql, values });
      return this.matches
        ? { rows: [{ permission_probe_id: this.ids.probe++ }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return super.query(sql, values);
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

function nm7397ShapeInput() {
  const storeCode = 'NM7397';
  const skuCodes = Array.from(
    { length: 548 },
    (_, index) => `NM-SKU-${String(index + 1).padStart(4, '0')}`,
  );
  const items = skuCodes.map((skuCode) => ({
    skuCode,
    skc: `SKC-${skuCode}`,
    supplierSku: `SUP-${skuCode}`,
    attribute: 'Default',
  }));
  const snapshots = skuCodes.map((skuCode, index) => {
    if (index < 83) {
      return {
        storeCode,
        skuCode,
        statisticsDate: '2026-07-25',
        fetchedAt: '2026-07-26T17:00:00.000Z',
        salesToday: 1,
        salesYesterday: 2,
        sales7Days: 7,
        sales30Days: 30,
      };
    }
    if (index < 546) {
      return {
        storeCode,
        skuCode,
        statisticsDate: null,
        fetchedAt: '2026-07-26T17:00:00.000Z',
        salesToday: 0,
        salesYesterday: 0,
        sales7Days: 0,
        sales30Days: 0,
      };
    }
    return {
      storeCode,
      skuCode,
      statisticsDate: null,
      fetchedAt: '2026-07-26T17:00:00.000Z',
      salesToday: index === 546 ? 1 : 0,
      salesYesterday: index === 547 ? 2 : 0,
      sales7Days: 2,
      sales30Days: 3,
    };
  });
  const batches = [];
  const pages = [];
  for (let offset = 0, batchIndex = 0; offset < skuCodes.length; offset += 100, batchIndex += 1) {
    const size = Math.min(100, skuCodes.length - offset);
    batches.push({
      batchIndex,
      skuCount: size,
      responseRecordCount: size,
      traceId: `trace-${batchIndex + 1}`,
      message: 'OK',
    });
    pages.push({
      page: batchIndex + 1,
      perPage: 100,
      recordCount: size,
      skcCount: size,
      traceId: `catalog-${batchIndex + 1}`,
    });
  }
  return {
    store: { storeCode, storeName: storeCode },
    runId: 'sync-20260726:NM7397',
    permissionPackageCode: 'SALES',
    inventory: {
      items,
      pages,
      advertisedCount: 548,
      sweepCount: 2,
    },
    sales: { snapshots, batches },
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
  assert.equal(client.calls.some(({ sql }) => sql.includes('SET is_active = false')), true);
  assert.equal(client.calls.some(({ sql }) => sql.includes('INSERT INTO ops.sales_sync_run')), true);
  assert.equal(client.calls.some(({ sql }) => sql.includes('INSERT INTO ops.sales_business_watermark')), true);
  assert.equal(client.calls.some(({ sql }) => sql.includes('DELETE FROM mart.full_store_sales_latest')), true);
  assert.equal(client.calls.some(({ sql }) => sql.includes('DELETE FROM mart.full_product_sales_latest')), true);
  const factReadback = client.calls.find(({ sql }) => sql.includes('SELECT sales_snapshot_id, payload_fingerprint'));
  assert.deepEqual(factReadback.values, [
    1,
    100,
    11,
    'today:SKU-1',
    sha256(stableJson({
      skuCode: 'SKU-1',
      statisticsDate: '2026-07-20',
      windowCode: 'today',
      quantity: 1,
    })),
    '2026-07-19T16:00:00.000Z',
    '2026-07-20T16:00:00.000Z',
    '2026-07-20T04:00:00.000Z',
  ]);
  assert.match(factReadback.values[4], /^[a-f0-9]{64}$/);
  assert.match(factReadback.sql, /\$5::text AS requested_payload_fingerprint/);
  assert.match(factReadback.sql, /metric_window_start = \$6::timestamptz/);
  assert.match(factReadback.sql, /snapshot_at = \$8::timestamptz/);
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

test('accepts a complete unanchored zero response, records legal zero and does not invent dated facts', async () => {
  const input = syncInput();
  for (const snapshot of input.sales.snapshots) {
    snapshot.statisticsDate = null;
    snapshot.salesToday = 0;
    snapshot.salesYesterday = 0;
    snapshot.sales7Days = 0;
    snapshot.sales30Days = 0;
  }
  const client = new FakeClient();

  const result = await loadFullManagedSalesSync(pool(client), input);

  assert.deepEqual(result, {
    storeCode: 'DL',
    skuCount: 2,
    factCount: 0,
    batchCount: 2,
    qualityStatus: 'LEGAL_ZERO_UNANCHORED',
    businessDate: null,
    quarantinedSkuCount: 0,
    quarantinedSkuCodes: [],
    unanchoredZeroSkuCount: 2,
  });
  assert.equal(
    client.calls.filter(({ sql }) => sql.includes('INSERT INTO fact.full_sku_sales_snapshot')).length,
    0,
  );
  const runInsert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.sales_sync_run'));
  assert.equal(runInsert.values[2], 'SUCCEEDED');
  assert.equal(runInsert.values[3], null);
  assert.equal(runInsert.values[4], 'UNANCHORED_ZERO');
  assert.equal(runInsert.values[5], 'LEGAL_ZERO_UNANCHORED');
  assert.deepEqual(runInsert.values.slice(11, 15), [0, 0, 0, 0]);
  assert.equal(
    client.calls.some(({ sql }) => sql.includes('INSERT INTO ops.sales_business_watermark')),
    false,
  );
  const eventInsert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.sales_quality_event'));
  assert.equal(eventInsert.values[2], 'SALES_DATE_UNANCHORED_ZERO');
  assert.equal(eventInsert.values[3], 'INFO');
  const probeInsert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.permission_probe'));
  assert.equal(probeInsert.values[5], 'GRANTED');
  assert.deepEqual(JSON.parse(probeInsert.values[9]), {
    endpointReached: 'goods.query-sku-sales',
    salesEndpointExercised: true,
    statisticsDateAvailable: false,
    dataLoadable: true,
    dataQualityStatus: 'DEGRADED',
    dataQualityReason: 'LEGAL_ZERO_UNANCHORED',
  });
});

test('quarantines unanchored non-zero rows while publishing dated rows as partial coverage', async () => {
  const input = syncInput();
  input.sales.snapshots[0].statisticsDate = null;
  const client = new FakeClient();

  const result = await loadFullManagedSalesSync(pool(client), input);

  assert.equal(result.qualityStatus, 'PARTIAL');
  assert.equal(result.quarantinedSkuCount, 1);
  assert.equal(result.factCount, 4);
  const runInsert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.sales_sync_run'));
  assert.equal(runInsert.values[2], 'SUCCEEDED');
  assert.equal(runInsert.values[4], 'PARTIAL');
  assert.deepEqual(runInsert.values.slice(11, 15), [3, 4, 14, 60]);
  assert.equal(
    client.calls.some(({ sql }) => sql.includes('INSERT INTO ops.sales_business_watermark')),
    true,
  );
  const eventInsert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.sales_quality_event'));
  assert.equal(eventInsert.values[2], 'SALES_DATE_UNANCHORED_NONZERO');
  assert.equal(eventInsert.values[3], 'WARNING');
  assert.deepEqual(JSON.parse(eventInsert.values[5]), {
    affectedSkuCodes: ['SKU-1'],
    affectedSkuCodesTruncated: false,
    impact: 'Unanchored non-zero rows were excluded; dated rows remain visible as partial coverage.',
    loadDecision: 'QUARANTINE',
  });
  const probeInsert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.permission_probe'));
  assert.equal(probeInsert.values[5], 'GRANTED');
  assert.deepEqual(JSON.parse(probeInsert.values[9]), {
    endpointReached: 'goods.query-sku-sales',
    salesEndpointExercised: true,
    statisticsDateAvailable: true,
    dataLoadable: true,
    dataQualityStatus: 'DEGRADED',
    dataQualityReason: 'UNANCHORED_NONZERO',
  });
});

test('blocks a store when every non-zero row lacks a statistics date', async () => {
  const input = syncInput();
  for (const snapshot of input.sales.snapshots) snapshot.statisticsDate = null;
  const client = new FakeClient();

  const result = await loadFullManagedSalesSync(pool(client), input);

  assert.equal(result.qualityStatus, 'UNANCHORED_NONZERO');
  assert.equal(result.quarantinedSkuCount, 2);
  assert.equal(result.factCount, 0);
  const runInsert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.sales_sync_run'));
  assert.equal(runInsert.values[2], 'QUALITY_BLOCKED');
  assert.equal(runInsert.values[4], 'BLOCKED');
  assert.deepEqual(runInsert.values.slice(11, 15), [null, null, null, null]);
  assert.equal(
    client.calls.some(({ sql }) => sql.includes('INSERT INTO ops.sales_business_watermark')),
    false,
  );
  const eventInsert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.sales_quality_event'));
  assert.equal(eventInsert.values[3], 'ERROR');
  assert.deepEqual(JSON.parse(eventInsert.values[5]).affectedSkuCodes, ['SKU-1', 'SKU-2']);
});

test('matches the live NM7397 83 dated, 463 zero-unanchored and 2 quarantined shape', async () => {
  const client = new FakeClient();
  const result = await loadFullManagedSalesSync(pool(client), nm7397ShapeInput());

  assert.deepEqual(result, {
    storeCode: 'NM7397',
    skuCount: 548,
    factCount: 332,
    batchCount: 7,
    qualityStatus: 'PARTIAL',
    businessDate: '2026-07-25',
    quarantinedSkuCount: 2,
    quarantinedSkuCodes: ['NM-SKU-0547', 'NM-SKU-0548'],
    unanchoredZeroSkuCount: 463,
  });
  const runInsert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.sales_sync_run'));
  assert.deepEqual(runInsert.values.slice(2, 16), [
    'SUCCEEDED',
    '2026-07-25',
    'PARTIAL',
    'PARTIAL',
    548,
    548,
    83,
    463,
    2,
    83,
    166,
    581,
    2490,
    '2026-07-26T17:00:00.000Z',
  ]);
  assert.equal(
    client.calls.filter(({ sql }) => sql.includes('INSERT INTO fact.full_sku_sales_snapshot')).length,
    332,
  );
  const watermark = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.sales_business_watermark'));
  assert.equal(watermark.values[3], 'PARTIAL');
  const events = client.calls.filter(({ sql }) => sql.includes('INSERT INTO ops.sales_quality_event'));
  assert.equal(events.length, 2);
  const zeroEvent = events.find(({ values }) => values[2] === 'SALES_DATE_UNANCHORED_ZERO');
  const quarantineEvent = events.find(({ values }) => values[2] === 'SALES_DATE_UNANCHORED_NONZERO');
  assert.equal(zeroEvent.values[3], 'INFO');
  assert.equal(zeroEvent.values[4], 463);
  assert.equal(quarantineEvent.values[3], 'WARNING');
  assert.equal(quarantineEvent.values[4], 2);
  assert.deepEqual(
    JSON.parse(quarantineEvent.values[5]).affectedSkuCodes,
    ['NM-SKU-0547', 'NM-SKU-0548'],
  );
});

test('the live-shaped partial observation replays without mutable facts or evidence drift', async () => {
  const client = new ReplayClient();
  const result = await loadFullManagedSalesSync(pool(client), nm7397ShapeInput());

  assert.equal(result.qualityStatus, 'PARTIAL');
  assert.equal(result.factCount, 332);
  assert.equal(
    client.calls.filter(({ sql }) => sql.includes('INSERT INTO fact.full_sku_sales_snapshot')).length,
    0,
  );
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
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

test('an exact raw-batch and run replay is immutable and succeeds without updates', async () => {
  const client = new ReplayClient();
  const result = await loadFullManagedSalesSync(pool(client), syncInput());
  assert.equal(result.factCount, 8);
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
  assert.equal(
    client.calls
      .filter(({ sql }) => sql.includes('INSERT INTO raw.openapi_fetch_batch'))
      .every(({ sql }) => sql.includes('DO NOTHING')),
    true,
  );
  assert.equal(
    client.calls
      .filter(({ sql }) => sql.includes('INSERT INTO ops.sales_sync_run'))
      .every(({ sql }) => sql.includes('DO NOTHING')),
    true,
  );
  const exactReadbacks = client.calls.filter(({ sql }) => (
    sql.includes('SELECT fetch_batch_id')
    || sql.includes('SELECT sales_snapshot_id')
    || sql.includes('SELECT sales_sync_run_id')
  ));
  assert.ok(exactReadbacks.length > 0);
  for (const { sql } of exactReadbacks) {
    assert.doesNotMatch(sql, /\bFOR (?:UPDATE|SHARE)\b/);
  }
  assert.equal(
    client.calls.some(({ sql }) => sql.includes("pg_advisory_xact_lock(hashtext('full-managed-sales-loader'))")),
    true,
  );
});

test('a reused raw-batch id rejects different response evidence', async () => {
  const client = new ReplayClient({ rawMatches: false });
  await assert.rejects(
    () => loadFullManagedSalesSync(pool(client), syncInput()),
    /different request or response evidence/,
  );
  assert.equal(client.calls.some(({ sql }) => sql === 'ROLLBACK'), true);
});

test('a reused sales run id rejects different aggregate evidence', async () => {
  const client = new ReplayClient({ runMatches: false });
  await assert.rejects(
    () => loadFullManagedSalesSync(pool(client), syncInput()),
    /reused with different evidence/,
  );
  assert.equal(client.calls.some(({ sql }) => sql === 'ROLLBACK'), true);
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

test('mixed statistics dates fail before the transaction with a stable sanitized code', async () => {
  const input = syncInput();
  input.sales.snapshots[1].statisticsDate = '2026-07-21';
  const client = new FakeClient();

  await assert.rejects(
    () => loadFullManagedSalesSync(pool(client), input),
    (error) => {
      assert.equal(error.code, MIXED_STATISTICS_DATES_CODE);
      assert.equal(error.message, MIXED_STATISTICS_DATES_MESSAGE);
      assert.deepEqual(error.details, { statisticsDateCount: 2 });
      assert.deepEqual(Object.keys(error.details), ['statisticsDateCount']);
      return true;
    },
  );
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

test('persists only the mixed-date count and stable quality reason', async () => {
  const client = new FakeClient();
  await persistPermissionProbe(pool(client), {
    store: { storeCode: 'DL', storeName: 'DL' },
    runId: 'probe-20260727:DL',
    permissionPackageCode: 'SALES',
    probe: {
      outcome: 'GRANTED',
      probedAt: '2026-07-27T04:18:00.000Z',
      httpStatus: 200,
      platformErrorCode: MIXED_STATISTICS_DATES_CODE,
      platformMessage: MIXED_STATISTICS_DATES_MESSAGE,
      evidence: {
        endpointReached: '/open-api/goods/query-sku-sales',
        salesEndpointExercised: true,
        statisticsDateAvailable: true,
        dataLoadable: false,
        dataQualityStatus: 'BLOCKED',
        dataQualityReason: MIXED_STATISTICS_DATES_CODE,
        statisticsDateCount: 2,
        statisticsDates: ['2026-07-25', '2026-07-26'],
        affectedSkuCodes: ['must-not-persist'],
      },
    },
  });

  const insert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.permission_probe'));
  assert.deepEqual(JSON.parse(insert.values[9]), {
    endpointReached: '/open-api/goods/query-sku-sales',
    salesEndpointExercised: true,
    statisticsDateAvailable: true,
    dataLoadable: false,
    dataQualityStatus: 'BLOCKED',
    dataQualityReason: MIXED_STATISTICS_DATES_CODE,
    statisticsDateCount: 2,
  });
  assert.doesNotMatch(JSON.stringify(insert.values), /2026-07-25|2026-07-26|must-not-persist/);
});

test('an exact permission-probe replay is read back immutably after the insert conflict', async () => {
  const client = new ProbeReplayClient();
  const result = await persistPermissionProbe(pool(client), {
    store: { storeCode: 'DL', storeName: 'DL' },
    runId: 'probe-20260726:DL',
    permissionPackageCode: 'SALES',
    probe: {
      outcome: 'GRANTED',
      probedAt: '2026-07-26T11:00:00.000Z',
      httpStatus: 200,
      platformErrorCode: null,
      platformMessage: 'OK',
      evidence: {
        endpointReached: '/open-api/goods/query-sku-sales',
        salesEndpointExercised: true,
        statisticsDateAvailable: true,
        dataLoadable: true,
        dataQualityStatus: 'VALID',
      },
    },
  });

  assert.deepEqual(result, { storeCode: 'DL', outcome: 'GRANTED' });
  const insert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.permission_probe'));
  assert.match(insert.sql, /ON CONFLICT \(store_id, idempotency_key\) DO NOTHING/);
  assert.match(insert.sql, /RETURNING permission_probe_id/);
  const readback = client.calls.find(({ sql }) => sql.includes('SELECT permission_probe_id'));
  for (const predicate of [
    'store_id = $1',
    'capability_code = $2',
    'permission_package_code = $3',
    'endpoint_code = $4',
    'idempotency_key = $5',
    'outcome = $6',
    'http_status IS NOT DISTINCT FROM $7::integer',
    'platform_error_code IS NOT DISTINCT FROM $8::text',
    'platform_message IS NOT DISTINCT FROM $9::text',
    'evidence = $10::jsonb',
    'probed_at = $11::timestamptz',
  ]) {
    assert.ok(readback.sql.includes(predicate), `missing immutable predicate: ${predicate}`);
  }
  assert.doesNotMatch(readback.sql, /\bFOR (?:UPDATE|SHARE)\b/);
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
});

test('a permission-probe replay with drifted immutable evidence fails closed', async () => {
  const client = new ProbeReplayClient({ matches: false });
  await assert.rejects(
    () => persistPermissionProbe(pool(client), {
      store: { storeCode: 'DL', storeName: 'DL' },
      runId: 'probe-20260726:DL',
      permissionPackageCode: 'SALES',
      probe: {
        outcome: 'GRANTED',
        probedAt: '2026-07-26T11:00:00.000Z',
        httpStatus: 200,
        platformErrorCode: null,
        platformMessage: 'drifted evidence',
        evidence: {
          endpointReached: '/open-api/goods/query-sku-sales',
          salesEndpointExercised: true,
          statisticsDateAvailable: true,
          dataLoadable: true,
          dataQualityStatus: 'VALID',
        },
      },
    }),
    /Permission probe probe-20260726:DL was reused with different evidence/,
  );
  assert.equal(client.calls.some(({ sql }) => sql === 'ROLLBACK'), true);
  assert.equal(client.calls.some(({ sql }) => sql === 'COMMIT'), false);
});
