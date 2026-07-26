import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createProductIdentityEvidencePlanHash,
  parseProductIdentityEvidenceSyncArgs,
  readActiveFullManagedSpuUniverse,
  runProductIdentityEvidenceSync,
} from '../../scripts/sync_full_managed_product_identity_evidence.mjs';

const NOW = '2026-07-27T01:02:03.000Z';
const RUN_ID = 'identity-evidence-test-run';
const DATABASE_URL = 'postgres://user:database-secret@fake.invalid/full-managed';

function eligibleStore(storeCode, secretKey = `${storeCode}-secret`) {
  return {
    storeCode,
    storeName: storeCode,
    legalEntityName: null,
    platformShopId: null,
    platformSupplierId: null,
    enabled: true,
    appId: 'shared-app',
    openKeyId: `${storeCode}-open-key`,
    secretKey,
    applicationStatus: 'approved',
    authorizationStatus: 'authorized',
  };
}

function config(stores = [
  eligibleStore('CX4412'),
  eligibleStore('DL5477'),
]) {
  return {
    schemaVersion: 1,
    cooperationMode: 'FULL_MANAGED',
    baseUrl: 'http://127.0.0.1:3999',
    allowFakeBaseUrl: true,
    timeoutMs: 20_000,
    pageSize: 100,
    permissionPackageCode: 'sales-query',
    stores,
  };
}

function fakePool() {
  return {
    ended: false,
    async end() {
      this.ended = true;
    },
  };
}

function mappedSpuInfo(spuName, skuCount = 1) {
  return {
    spuName,
    skcs: [{
      skcName: `${spuName}-SKC`,
      skus: Array.from(
        { length: skuCount },
        (_, index) => ({ skuCode: `${spuName}-SKU-${index + 1}` }),
      ),
    }],
    responseFingerprint: 'a'.repeat(64),
    requestFingerprint: 'b'.repeat(64),
  };
}

async function dryRun({
  localConfig = config(),
  rows = [
    { storeCode: 'DL5477', spuName: 'SPU-DL-1' },
    { storeCode: 'CX4412', spuName: 'SPU-CX-1' },
  ],
  stores,
  languages,
  limit,
} = {}) {
  const pool = fakePool();
  const summary = await runProductIdentityEvidenceSync({
    config: localConfig,
    databaseUrl: DATABASE_URL,
    stores,
    now: NOW,
    runId: RUN_ID,
    languages,
    limit,
    poolFactory: async () => pool,
    operations: {
      async readUniverse() {
        return rows;
      },
      async fetchSpuInfo() {
        throw new Error('dry-run must not fetch');
      },
      async recordObservation() {
        throw new Error('dry-run must not write');
      },
    },
  });
  assert.equal(pool.ended, true);
  return summary;
}

test('argument parsing requires an exact apply hash and rejects ambiguous flags', () => {
  const hash = 'a'.repeat(64);
  assert.deepEqual(
    parseProductIdentityEvidenceSyncArgs([
      '--config',
      'config.secret.json',
      '--stores',
      'DL5477,CX4412',
      '--now',
      NOW,
      '--run-id',
      RUN_ID,
      '--languages',
      'zh-cn,en',
      '--max-concurrency',
      '3',
      '--limit',
      '10',
      '--apply',
      '--approved-hash',
      hash,
    ]),
    {
      apply: true,
      config: 'config.secret.json',
      stores: 'DL5477,CX4412',
      now: NOW,
      'run-id': RUN_ID,
      languages: 'zh-cn,en',
      'max-concurrency': '3',
      limit: '10',
      'approved-hash': hash,
    },
  );
  assert.throws(
    () => parseProductIdentityEvidenceSyncArgs(['--apply']),
    ({ code }) => code === 'APPROVED_HASH_REQUIRED',
  );
  assert.throws(
    () => parseProductIdentityEvidenceSyncArgs(['--approved-hash', hash]),
    ({ code }) => code === 'APPROVED_HASH_NOT_ALLOWED',
  );
  assert.throws(
    () => parseProductIdentityEvidenceSyncArgs(['--limit', '1', '--limit', '2']),
    ({ code }) => code === 'INVALID_ARGUMENTS',
  );
  assert.throws(
    () => parseProductIdentityEvidenceSyncArgs(['--unknown', 'value']),
    ({ code }) => code === 'INVALID_ARGUMENTS',
  );
  assert.throws(
    () => parseProductIdentityEvidenceSyncArgs(['--database-url', DATABASE_URL]),
    ({ code }) => code === 'INVALID_ARGUMENTS',
  );
});

test('dry-run reads a deterministic universe but performs zero network calls and zero writes', async () => {
  let networkCalls = 0;
  let evidenceWrites = 0;
  const pool = fakePool();
  const summary = await runProductIdentityEvidenceSync({
    config: config(),
    databaseUrl: DATABASE_URL,
    now: NOW,
    runId: RUN_ID,
    languages: 'zh-cn,en,zh-cn',
    maxConcurrency: 3,
    poolFactory: async () => pool,
    operations: {
      async readUniverse(_pool, { storeCodes, limit }) {
        assert.deepEqual(storeCodes, ['CX4412', 'DL5477']);
        assert.equal(limit, null);
        return [
          { storeCode: 'DL5477', spuName: 'SPU-DL-2' },
          { storeCode: 'CX4412', spuName: 'SPU-CX-1' },
          { storeCode: 'DL5477', spuName: 'SPU-DL-1' },
          { storeCode: 'DL5477', spuName: 'SPU-DL-1' },
        ];
      },
      async fetchSpuInfo() {
        networkCalls += 1;
      },
      async recordObservation() {
        evidenceWrites += 1;
      },
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.mode, 'dry-run');
  assert.equal(summary.networkRequests, 0);
  assert.equal(summary.evidenceWrites, 0);
  assert.equal(summary.selectedStoreCount, 2);
  assert.equal(summary.plannedSpuCount, 3);
  assert.match(summary.planHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(summary.languages, ['en', 'zh-cn']);
  assert.deepEqual(summary.stores, [
    { storeCode: 'CX4412', plannedSpuCount: 1 },
    { storeCode: 'DL5477', plannedSpuCount: 2 },
  ]);
  assert.equal(networkCalls, 0);
  assert.equal(evidenceWrites, 0);
  assert.equal(pool.ended, true);
  assert.doesNotMatch(JSON.stringify(summary), /SPU-DL|SPU-CX|database-secret/);

  const reordered = await dryRun({
    rows: [
      { storeCode: 'DL5477', spuName: 'SPU-DL-1' },
      { storeCode: 'DL5477', spuName: 'SPU-DL-2' },
      { storeCode: 'CX4412', spuName: 'SPU-CX-1' },
    ],
    languages: 'en,zh-cn',
  });
  assert.equal(reordered.planHash, summary.planHash);
});

test('apply refuses a stale or unapproved universe hash before client, network or repository work', async () => {
  let clients = 0;
  let networkCalls = 0;
  let writes = 0;
  const pool = fakePool();
  await assert.rejects(
    runProductIdentityEvidenceSync({
      config: config(),
      databaseUrl: DATABASE_URL,
      now: NOW,
      runId: RUN_ID,
      apply: true,
      approvedHash: '0'.repeat(64),
      poolFactory: async () => pool,
      clientFactory() {
        clients += 1;
        return {};
      },
      operations: {
        async readUniverse() {
          return [{ storeCode: 'DL5477', spuName: 'SPU-DL-1' }];
        },
        async fetchSpuInfo() {
          networkCalls += 1;
        },
        async recordObservation() {
          writes += 1;
        },
      },
    }),
    ({ code }) => code === 'PLAN_HASH_MISMATCH',
  );
  assert.equal(clients, 0);
  assert.equal(networkCalls, 0);
  assert.equal(writes, 0);
  assert.equal(pool.ended, true);
});

test('confirmed apply uses bounded concurrency and aggregates repository readback by store', async () => {
  const rows = [
    { storeCode: 'DL5477', spuName: 'SPU-DL-2' },
    { storeCode: 'CX4412', spuName: 'SPU-CX-1' },
    { storeCode: 'DL5477', spuName: 'SPU-DL-1' },
  ];
  const approved = await dryRun({ rows, languages: 'zh-cn,en' });
  const pool = fakePool();
  const fetches = [];
  const records = [];
  let active = 0;
  let maximumActive = 0;
  const summary = await runProductIdentityEvidenceSync({
    config: config(),
    databaseUrl: DATABASE_URL,
    now: NOW,
    runId: RUN_ID,
    languages: 'en,zh-cn',
    maxConcurrency: 2,
    apply: true,
    approvedHash: approved.planHash,
    poolFactory: async () => pool,
    clientFactory({ openKeyId, secretKey }) {
      assert.ok(openKeyId.endsWith('-open-key'));
      assert.ok(secretKey.endsWith('-secret'));
      return { storeCode: openKeyId.replace('-open-key', '') };
    },
    operations: {
      async readUniverse() {
        return rows;
      },
      async fetchSpuInfo(client, { spuName, languageList }) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        fetches.push({ storeCode: client.storeCode, languageList });
        return mappedSpuInfo(spuName, spuName.endsWith('-2') ? 2 : 1);
      },
      async recordObservation(_pool, input) {
        records.push(input);
        const observedSkuCount = input.spuInfo.skcs[0].skus.length;
        return {
          observedSkuCount,
          resolvedSkuCount: observedSkuCount - 1,
          unresolvedSkuCount: 1,
          observationSetCount: 1,
          createdObservationSetCount: 1,
        };
      },
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.mode, 'applied');
  assert.equal(summary.succeeded, 3);
  assert.equal(summary.failed, 0);
  assert.equal(summary.observedSkuCount, 4);
  assert.equal(summary.unresolvedSkuCount, 3);
  assert.ok(maximumActive <= 2);
  assert.equal(fetches.length, 3);
  assert.ok(fetches.every(({ languageList }) => (
    JSON.stringify(languageList) === JSON.stringify(['en', 'zh-cn'])
  )));
  assert.equal(records.length, 3);
  assert.ok(records.every((record) => (
    record.runId === RUN_ID
    && record.sourceFetchedAt === NOW
    && record.documentVersion === 27
    && record.mapperVersion === 'spu-info-v1'
  )));
  assert.deepEqual(summary.stores, [
    {
      storeCode: 'CX4412',
      plannedSpuCount: 1,
      succeeded: 1,
      failed: 0,
      observedSkuCount: 1,
      unresolvedSkuCount: 1,
      errorCounts: [],
    },
    {
      storeCode: 'DL5477',
      plannedSpuCount: 2,
      succeeded: 2,
      failed: 0,
      observedSkuCount: 3,
      unresolvedSkuCount: 2,
      errorCounts: [],
    },
  ]);
  assert.equal(pool.ended, true);
  assert.doesNotMatch(JSON.stringify(summary), /SPU-|open-key|secret|postgres/);
});

test('one SPU failure is isolated and output contains only a safe code', async () => {
  const secret = 'raw-platform-secret-that-must-never-appear';
  const rows = [
    { storeCode: 'DL5477', spuName: 'SPU-DL-GOOD-1' },
    { storeCode: 'DL5477', spuName: 'SPU-DL-FAIL' },
    { storeCode: 'DL5477', spuName: 'SPU-DL-GOOD-2' },
  ];
  const approved = await dryRun({
    localConfig: config([eligibleStore('DL5477', secret)]),
    rows,
  });
  let writes = 0;
  const summary = await runProductIdentityEvidenceSync({
    config: config([eligibleStore('DL5477', secret)]),
    databaseUrl: DATABASE_URL,
    stores: 'DL5477',
    now: NOW,
    runId: RUN_ID,
    apply: true,
    approvedHash: approved.planHash,
    poolFactory: async () => fakePool(),
    clientFactory: () => ({}),
    operations: {
      async readUniverse() {
        return rows;
      },
      async fetchSpuInfo(_client, { spuName }) {
        if (spuName.endsWith('FAIL')) {
          const error = new Error(`${secret} ${spuName} ${DATABASE_URL}`);
          error.code = 'platform-error-with-secret';
          throw error;
        }
        return mappedSpuInfo(spuName);
      },
      async recordObservation() {
        writes += 1;
        return { observedSkuCount: 1, unresolvedSkuCount: 0 };
      },
    },
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 1);
  assert.equal(writes, 2);
  assert.deepEqual(summary.stores[0].errorCounts, [{
    errorCode: 'SPU_EVIDENCE_SYNC_FAILED',
    count: 1,
  }]);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /SPU-DL|database-secret|platform-error-with-secret/);
});

test('client construction failure is isolated to that store without exposing credentials', async () => {
  const rows = [
    { storeCode: 'CX4412', spuName: 'SPU-CX-1' },
    { storeCode: 'DL5477', spuName: 'SPU-DL-1' },
  ];
  const approved = await dryRun({ rows });
  let fetches = 0;
  const summary = await runProductIdentityEvidenceSync({
    config: config(),
    databaseUrl: DATABASE_URL,
    now: NOW,
    runId: RUN_ID,
    apply: true,
    approvedHash: approved.planHash,
    poolFactory: async () => fakePool(),
    clientFactory({ openKeyId }) {
      if (openKeyId.startsWith('CX')) {
        const error = new Error(`do not log ${DATABASE_URL}`);
        error.code = 'CLIENT_SETUP_FAILED';
        throw error;
      }
      return {};
    },
    operations: {
      async readUniverse() {
        return rows;
      },
      async fetchSpuInfo(_client, { spuName }) {
        fetches += 1;
        return mappedSpuInfo(spuName);
      },
      async recordObservation() {
        return { observedSkuCount: 1, unresolvedSkuCount: 0 };
      },
    },
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 1);
  assert.equal(fetches, 1);
  assert.deepEqual(summary.stores[0].errorCounts, [{
    errorCode: 'CLIENT_SETUP_FAILED',
    count: 1,
  }]);
  assert.doesNotMatch(JSON.stringify(summary), /database-secret|open-key|secret/);
});

test('unknown and ineligible stores fail closed before creating a database pool', async () => {
  let poolFactories = 0;
  await assert.rejects(
    runProductIdentityEvidenceSync({
      config: config(),
      databaseUrl: DATABASE_URL,
      stores: 'NOT_CONFIGURED',
      now: NOW,
      runId: RUN_ID,
      poolFactory: async () => {
        poolFactories += 1;
        return fakePool();
      },
    }),
    ({ code }) => code === 'UNKNOWN_STORE',
  );

  const ineligible = {
    ...eligibleStore('DL5477'),
    authorizationStatus: 'pending',
  };
  await assert.rejects(
    runProductIdentityEvidenceSync({
      config: config([ineligible]),
      databaseUrl: DATABASE_URL,
      stores: 'DL5477',
      now: NOW,
      runId: RUN_ID,
      poolFactory: async () => {
        poolFactories += 1;
        return fakePool();
      },
    }),
    ({ code }) => code === 'STORE_NOT_ELIGIBLE',
  );
  assert.equal(poolFactories, 0);
});

test('an entirely ineligible config reports no eligible stores', async () => {
  const disabled = {
    ...eligibleStore('DL5477'),
    enabled: false,
    appId: null,
    openKeyId: null,
    secretKey: null,
    applicationStatus: 'unknown',
    authorizationStatus: 'unknown',
  };
  await assert.rejects(
    runProductIdentityEvidenceSync({
      config: config([disabled]),
      databaseUrl: DATABASE_URL,
      now: NOW,
      runId: RUN_ID,
      poolFactory: async () => {
        throw new Error('must fail before pool creation');
      },
    }),
    ({ code }) => code === 'NO_ELIGIBLE_STORES',
  );
});

test('languages, concurrency, limit, time and run ID are strictly validated', async () => {
  const base = {
    config: config(),
    databaseUrl: DATABASE_URL,
    now: NOW,
    runId: RUN_ID,
    poolFactory: async () => {
      throw new Error('validation must happen before pool creation');
    },
  };
  for (const [override, code] of [
    [{ languages: 'zh-cn,xx' }, 'INVALID_LANGUAGES'],
    [{ maxConcurrency: 0 }, 'INVALID_ARGUMENTS'],
    [{ maxConcurrency: 17 }, 'INVALID_ARGUMENTS'],
    [{ limit: 0 }, 'INVALID_ARGUMENTS'],
    [{ limit: 100_001 }, 'INVALID_ARGUMENTS'],
    [{ now: '2026-07-27' }, 'INVALID_NOW'],
    [{ runId: 'short' }, 'INVALID_RUN_ID'],
  ]) {
    await assert.rejects(
      runProductIdentityEvidenceSync({ ...base, ...override }),
      (error) => error.code === code,
    );
  }
});

test('limit is applied after canonical store and SPU sorting and participates in the hash', async () => {
  const rows = [
    { storeCode: 'DL5477', spuName: 'SPU-2' },
    { storeCode: 'CX4412', spuName: 'SPU-2' },
    { storeCode: 'CX4412', spuName: 'SPU-1' },
  ];
  const limited = await dryRun({ rows, limit: 2 });
  const unlimited = await dryRun({ rows });
  assert.equal(limited.plannedSpuCount, 2);
  assert.deepEqual(limited.stores, [
    { storeCode: 'CX4412', plannedSpuCount: 2 },
    { storeCode: 'DL5477', plannedSpuCount: 0 },
  ]);
  assert.notEqual(limited.planHash, unlimited.planHash);
});

test('the default universe query is read-only, canonical and committed before return', async () => {
  const statements = [];
  let transactionOpen = false;
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql.startsWith('BEGIN')) {
        transactionOpen = true;
        return { rows: [] };
      }
      if (sql.includes('product-identity-evidence:active-spu-universe')) {
        assert.equal(transactionOpen, true);
        assert.match(sql, /dim\.full_sku/);
        assert.match(sql, /sku\.is_active = true/);
        assert.match(sql, /store\.is_active = true/);
        return {
          rows: [
            { store_code: 'DL5477', platform_spu_id: 'SPU-2' },
            { store_code: 'DL5477', platform_spu_id: 'SPU-1' },
          ],
        };
      }
      if (sql === 'COMMIT') {
        transactionOpen = false;
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {
      statements.push({ sql: 'RELEASE' });
    },
  };
  const universe = await readActiveFullManagedSpuUniverse({
    async connect() {
      return client;
    },
  }, {
    storeCodes: ['DL5477'],
    limit: 1,
  });

  assert.equal(transactionOpen, false);
  assert.deepEqual(universe, [{ storeCode: 'DL5477', spuName: 'SPU-1' }]);
  assert.equal(statements[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(statements.at(-2).sql, 'COMMIT');
  assert.equal(statements.at(-1).sql, 'RELEASE');
});

test('network begins only after the authoritative universe transaction is closed', async () => {
  let transactionOpen = false;
  const rows = [{ store_code: 'DL5477', platform_spu_id: 'SPU-DL-1' }];
  const universe = [{ storeCode: 'DL5477', spuName: 'SPU-DL-1' }];
  const approvedHash = createProductIdentityEvidencePlanHash({
    runId: RUN_ID,
    sourceFetchedAt: NOW,
    languages: ['zh-cn'],
    limit: null,
    universe,
  });
  const client = {
    async query(sql) {
      if (sql.startsWith('BEGIN')) {
        transactionOpen = true;
        return { rows: [] };
      }
      if (sql.includes('active-spu-universe')) return { rows };
      if (sql === 'COMMIT') {
        transactionOpen = false;
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
    async end() {},
  };
  const summary = await runProductIdentityEvidenceSync({
    config: config([eligibleStore('DL5477')]),
    databaseUrl: DATABASE_URL,
    now: NOW,
    runId: RUN_ID,
    apply: true,
    approvedHash,
    poolFactory: async () => pool,
    clientFactory: () => ({}),
    operations: {
      async fetchSpuInfo(_openApiClient, { spuName }) {
        assert.equal(transactionOpen, false);
        return mappedSpuInfo(spuName);
      },
      async recordObservation() {
        assert.equal(transactionOpen, false);
        return { observedSkuCount: 1, unresolvedSkuCount: 0 };
      },
    },
  });
  assert.equal(summary.ok, true);
});

test('the CLI delegates network access to the read-only SPU adapter and defines no write endpoint', async () => {
  const source = await readFile(
    new URL('../../scripts/sync_full_managed_product_identity_evidence.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /fetchFullManagedProductSpuInfo/);
  assert.doesNotMatch(source, /\.request\s*\(/);
  assert.doesNotMatch(
    source,
    /open-api\/(?:goods\/(?:edit|publish|delete)|webhook|marketing|activity)/i,
  );
  assert.equal(
    [...source.matchAll(/\/open-api\/goods\/spu-info/g)].length,
    1,
    'the only endpoint mention is the read-only adapter contract comment',
  );
  assert.match(source, /process\.env\.FULL_BI_DATABASE_URL/);
  assert.doesNotMatch(source, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(source, /--database-url|args\[['"]database-url['"]\]/);
});
