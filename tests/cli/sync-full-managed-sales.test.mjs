import assert from 'node:assert/strict';
import test from 'node:test';

import {
  failedProbe,
  failedResult,
  fetchAndLoadSalesWithDateRetry,
  runKeyedStoreGroups,
  summarizeSyncResults,
} from '../../scripts/sync_full_managed_sales.mjs';
import {
  MIXED_STATISTICS_DATES_CODE,
  MIXED_STATISTICS_DATES_MESSAGE,
  SalesDataQualityError,
} from '../../src/warehouse/full-managed-sales-repository.mjs';

test('mixed statistics dates preserve granted permission but keep the service failed closed', () => {
  const error = new SalesDataQualityError(
    MIXED_STATISTICS_DATES_CODE,
    MIXED_STATISTICS_DATES_MESSAGE,
    { statisticsDateCount: 2 },
  );
  const probe = failedProbe('TEST', error);

  assert.equal(probe.outcome, 'GRANTED');
  assert.equal(probe.httpStatus, 200);
  assert.equal(probe.platformErrorCode, MIXED_STATISTICS_DATES_CODE);
  assert.equal(probe.platformMessage, MIXED_STATISTICS_DATES_MESSAGE);
  assert.deepEqual(probe.evidence, {
    endpointReached: '/open-api/goods/query-sku-sales',
    salesEndpointExercised: true,
    statisticsDateAvailable: true,
    dataLoadable: false,
    dataQualityStatus: 'BLOCKED',
    dataQualityReason: MIXED_STATISTICS_DATES_CODE,
    statisticsDateCount: 2,
  });

  const result = failedResult('TEST', probe);
  assert.deepEqual(result, {
    storeCode: 'TEST',
    status: 'quality_blocked',
    errorCode: MIXED_STATISTICS_DATES_CODE,
  });
  assert.deepEqual(summarizeSyncResults([result]), {
    loaded: 0,
    partial: 0,
    pending: 0,
    errors: 0,
    qualityBlocked: 1,
    ok: false,
    exitCode: 2,
  });
});

test('an untyped or generic error remains an ERROR even when its message resembles the quality gate', () => {
  const generic = new Error(MIXED_STATISTICS_DATES_MESSAGE);
  generic.code = MIXED_STATISTICS_DATES_CODE;
  generic.details = { statisticsDateCount: 2 };
  const probe = failedProbe('TEST', generic);
  const result = failedResult('TEST', probe);

  assert.equal(probe.outcome, 'ERROR');
  assert.equal(probe.httpStatus, null);
  assert.equal(probe.platformErrorCode, MIXED_STATISTICS_DATES_CODE);
  assert.equal(probe.evidence.salesEndpointExercised, false);
  assert.equal(result.status, 'error');
  assert.equal(summarizeSyncResults([result]).exitCode, 2);

  const plainProbe = failedProbe('TEST', new Error('generic failure'));
  assert.equal(plainProbe.outcome, 'ERROR');
  assert.equal(plainProbe.platformErrorCode, 'SYNC_ERROR');
});

test('a partial store load keeps the run failed closed with exit code 2', () => {
  const result = { storeCode: 'DL5477', status: 'loaded', qualityStatus: 'PARTIAL' };
  assert.deepEqual(summarizeSyncResults([result]), {
    loaded: 1,
    partial: 1,
    pending: 0,
    errors: 0,
    qualityBlocked: 0,
    ok: false,
    exitCode: 2,
  });
});

test('partial quality status propagates in mixed valid and degraded results', () => {
  const summary = summarizeSyncResults([
    { storeCode: 'STORE-V', status: 'loaded', qualityStatus: 'VALID' },
    { storeCode: 'STORE-P', status: 'loaded', qualityStatus: 'PARTIAL' },
    { storeCode: 'STORE-L', status: 'loaded', qualityStatus: 'LEGAL_ZERO_UNANCHORED' },
  ]);
  assert.deepEqual(summary, {
    loaded: 3,
    partial: 1,
    pending: 0,
    errors: 0,
    qualityBlocked: 0,
    ok: false,
    exitCode: 2,
  });
});

test('valid and legal-zero loads remain fully successful with exit code 0', () => {
  assert.deepEqual(
    summarizeSyncResults([
      { storeCode: 'STORE-V', status: 'loaded', qualityStatus: 'VALID' },
      { storeCode: 'STORE-L', status: 'loaded', qualityStatus: 'LEGAL_ZERO_UNANCHORED' },
    ]),
    {
      loaded: 2,
      partial: 0,
      pending: 0,
      errors: 0,
      qualityBlocked: 0,
      ok: true,
      exitCode: 0,
    },
  );
});

test('an unauthorized or unconfigured store cannot make a sales run look complete', () => {
  assert.deepEqual(summarizeSyncResults([{ storeCode: 'TEST', status: 'pending' }]), {
    loaded: 0,
    partial: 0,
    pending: 1,
    errors: 0,
    qualityBlocked: 0,
    ok: false,
    exitCode: 2,
  });
});

test('mixed statistics dates refetch the whole store before loading', async () => {
  const fetches = [];
  const loads = [];
  const inventory = { items: [{ skuCode: 'SKU-1' }] };
  const loaded = await fetchAndLoadSalesWithDateRetry({
    client: {},
    store: { storeCode: 'DL5477' },
    storeRunId: 'sync-test:DL5477',
    permissionPackageCode: 'SALES',
    inventory,
    pool: {},
    clock: () => new Date('2026-07-30T07:00:00.000Z'),
    fetchSales: async (_client, input) => {
      fetches.push(input);
      return { snapshots: [], batches: [] };
    },
    loadSales: async (_pool, input) => {
      loads.push(input);
      if (loads.length === 1) {
        throw new SalesDataQualityError(
          MIXED_STATISTICS_DATES_CODE,
          MIXED_STATISTICS_DATES_MESSAGE,
          { statisticsDateCount: 2 },
        );
      }
      return { storeCode: 'DL5477', qualityStatus: 'PARTIAL' };
    },
  });
  assert.equal(fetches.length, 2);
  assert.equal(loads.length, 2);
  assert.deepEqual(fetches[0].skuCodes, ['SKU-1']);
  assert.equal(loaded.statisticsDateRetryCount, 1);
});

test('date retry never retries a generic load failure or exceeds its bound', async () => {
  let genericFetches = 0;
  await assert.rejects(
    fetchAndLoadSalesWithDateRetry({
      client: {},
      store: { storeCode: 'DL5477' },
      storeRunId: 'sync-test:DL5477',
      permissionPackageCode: 'SALES',
      inventory: { items: [{ skuCode: 'SKU-1' }] },
      pool: {},
      fetchSales: async () => {
        genericFetches += 1;
        return { snapshots: [], batches: [] };
      },
      loadSales: async () => {
        throw new Error('database unavailable');
      },
    }),
    /database unavailable/,
  );
  assert.equal(genericFetches, 1);

  let rolloverFetches = 0;
  await assert.rejects(
    fetchAndLoadSalesWithDateRetry({
      client: {},
      store: { storeCode: 'DL5477' },
      storeRunId: 'sync-test:DL5477',
      permissionPackageCode: 'SALES',
      inventory: { items: [{ skuCode: 'SKU-1' }] },
      pool: {},
      maximumAttempts: 2,
      fetchSales: async () => {
        rolloverFetches += 1;
        return { snapshots: [], batches: [] };
      },
      loadSales: async () => {
        throw new SalesDataQualityError(
          MIXED_STATISTICS_DATES_CODE,
          MIXED_STATISTICS_DATES_MESSAGE,
          { statisticsDateCount: 2 },
        );
      },
    }),
    (error) => error.code === MIXED_STATISTICS_DATES_CODE,
  );
  assert.equal(rolloverFetches, 2);
});

test('store concurrency never overlaps shops owned by one legal entity', async () => {
  const stores = [
    { storeCode: 'NM7397', legalEntityName: '南墨', openKeyId: 'nm-a' },
    { storeCode: 'DL5477', legalEntityName: '地利', openKeyId: 'dl-a' },
    { storeCode: 'NM7418', legalEntityName: '南墨', openKeyId: 'nm-b' },
  ];
  const active = new Map();
  let differentEntitiesOverlapped = false;
  const results = await runKeyedStoreGroups(stores, 2, async (store) => {
    assert.equal(active.get(store.legalEntityName) ?? 0, 0);
    active.set(store.legalEntityName, 1);
    if ([...active.values()].filter(Boolean).length === 2) differentEntitiesOverlapped = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    active.set(store.legalEntityName, 0);
    return store.storeCode;
  });
  assert.equal(differentEntitiesOverlapped, true);
  assert.deepEqual(results, ['NM7397', 'DL5477', 'NM7418']);
});
