import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createWarehouseStoreInventoryPlanHash,
  isMainModule,
  main,
  migrateFullManagedWarehouseStoreInventory,
} from '../../scripts/migrate_full_managed_warehouse_store_inventory.mjs';

const CONFIRMATION = 'SHEIN_FULL_WAREHOUSE_STORE_INVENTORY_APPLY';
const STORE_CODES = Object.freeze(
  Array.from({ length: 25 }, (_, index) => `T${String(index + 1).padStart(4, '0')}`),
);

function fakeDatabase(overrides = {}) {
  const calls = [];
  const previousActiveCount = Number(
    overrides.baseline?.previous_active_count ?? 18,
  );
  const state = {
    safety: {
      blocked_legacy_count: '0',
      preserved_pending_probe_count: '684',
      ...overrides.safety,
    },
    baseline: {
      previous_active_count: '18',
      existing_expected_count: '0',
      active_expected_count: '0',
      legacy_active_count: '18',
      active_store_codes: Array.from(
        { length: previousActiveCount },
        (_, index) => `L${String(index + 1).padStart(4, '0')}`,
      ),
      ...overrides.baseline,
    },
    postcondition: {
      active_count: '25',
      expected_active_count: '25',
      unexpected_active_count: '0',
      ...overrides.postcondition,
    },
    deactivatedRowCount: overrides.deactivatedRowCount ?? 18,
  };

  const client = {
    released: false,
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes(':legacy-safety')) {
        return { rows: [state.safety] };
      }
      if (text.includes(':baseline')) {
        return { rows: [state.baseline] };
      }
      if (text.includes(':deactivate-legacy')) {
        return { rows: [], rowCount: state.deactivatedRowCount };
      }
      if (text.includes(':postcondition')) {
        return { rows: [state.postcondition] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      this.released = true;
    },
  };
  const pool = {
    ended: false,
    async connect() {
      return client;
    },
    async end() {
      this.ended = true;
    },
  };
  return { pool, client, calls, state };
}

function planHashFor(database, storeCodes = STORE_CODES) {
  return createWarehouseStoreInventoryPlanHash({
    storeCodes,
    baseline: {
      previousActiveCount: Number(database.state.baseline.previous_active_count),
      existingExpectedCount: Number(database.state.baseline.existing_expected_count),
      activeExpectedCount: Number(database.state.baseline.active_expected_count),
      legacyActiveCount: Number(database.state.baseline.legacy_active_count),
      activeStoreCodes: database.state.baseline.active_store_codes,
    },
    safety: {
      blockedLegacyCount: Number(database.state.safety.blocked_legacy_count),
      preservedPendingProbeCount: Number(
        database.state.safety.preserved_pending_probe_count,
      ),
    },
  });
}

function sqlCalls(database) {
  return database.calls.map(({ text }) => text.replace(/\s+/g, ' ').trim());
}

function capture() {
  return {
    value: '',
    write(chunk) {
      this.value += String(chunk);
      return true;
    },
  };
}

async function inventoryFixture(stores = STORE_CODES) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fm-warehouse-inventory-'));
  const inventoryFile = path.join(directory, 'stores.example.json');
  await writeFile(inventoryFile, `${JSON.stringify({
    schemaVersion: 1,
    cooperationMode: 'FULL_MANAGED',
    stores: stores.map((storeCode) => ({ storeCode, enabled: false })),
  }, null, 2)}\n`);
  return { directory, inventoryFile };
}

test('dry-run executes the complete migration under an advisory transaction and rolls back', async () => {
  const database = fakeDatabase();
  const result = await migrateFullManagedWarehouseStoreInventory({
    pool: database.pool,
    storeCodes: [...STORE_CODES],
  });

  assert.deepEqual(result, {
    ok: true,
    mode: 'dry-run',
    expectedStoreCount: 25,
    previousActiveStoreCount: 18,
    insertedStoreCount: 25,
    reactivatedStoreCount: 0,
    deactivatedLegacyStoreCount: 18,
    preservedPendingProbeCount: 684,
    activeStoreCount: 25,
    planHash: planHashFor(database),
  });
  const queries = sqlCalls(database);
  assert.equal(queries[0], 'BEGIN');
  assert.match(queries[1], /SET LOCAL lock_timeout TO '10s'/);
  assert.match(queries[2], /SET LOCAL statement_timeout TO '60s'/);
  assert.match(queries[3], /pg_advisory_xact_lock/);
  assert.match(queries[4], /warehouse-store-inventory:table-locks/);
  for (const table of [
    'dim.store',
    'raw.openapi_fetch_batch',
    'dim.full_sku',
    'fact.full_sku_sales_snapshot',
    'mart.full_store_sales_latest',
    'mart.full_product_sales_latest',
    'ops.permission_probe',
  ]) {
    assert.equal(queries[4].includes(table), true);
  }
  assert.match(queries[4], /IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(queries[5], /warehouse-store-inventory:legacy-safety/);
  assert.match(queries[6], /warehouse-store-inventory:baseline/);
  assert.match(queries[6], /array_agg\(store_code ORDER BY store_code\)/);
  assert.match(queries[7], /INSERT INTO dim\.store/);
  assert.match(
    queries[7],
    /is_active, first_seen_at, last_seen_at\s*\)/,
  );
  assert.equal(
    (queries[7].match(/statement_timestamp\(\)/g) || []).length,
    2,
  );
  assert.doesNotMatch(
    queries[7].slice(queries[7].indexOf('ON CONFLICT')),
    /first_seen_at/,
  );
  assert.match(queries[8], /UPDATE dim\.store/);
  assert.match(queries[9], /warehouse-store-inventory:postcondition/);
  assert.equal(queries[10], 'ROLLBACK');
  assert.equal(queries.includes('COMMIT'), false);
  assert.equal(database.client.released, true);
});

test('confirmed apply commits and reports inserted, reactivated and deactivated counts', async () => {
  const database = fakeDatabase({
    baseline: {
      previous_active_count: '20',
      existing_expected_count: '8',
      active_expected_count: '6',
      legacy_active_count: '14',
    },
    deactivatedRowCount: 14,
  });
  const result = await migrateFullManagedWarehouseStoreInventory({
    pool: database.pool,
    storeCodes: [...STORE_CODES],
    apply: true,
    planHash: planHashFor(database),
  });

  assert.equal(result.mode, 'applied');
  assert.equal(result.insertedStoreCount, 17);
  assert.equal(result.reactivatedStoreCount, 2);
  assert.equal(result.deactivatedLegacyStoreCount, 14);
  assert.equal(sqlCalls(database).at(-1), 'COMMIT');
});

test('apply requires the approved hash and same-count active identity drift fails before writes', async () => {
  const missing = fakeDatabase();
  await assert.rejects(
    migrateFullManagedWarehouseStoreInventory({
      pool: missing.pool,
      storeCodes: [...STORE_CODES],
      apply: true,
    }),
    (error) => error.code === 'PLAN_HASH_REQUIRED',
  );
  assert.equal(missing.calls.length, 0);

  const approved = fakeDatabase();
  const approvedHash = planHashFor(approved);
  const driftedCodes = [...approved.state.baseline.active_store_codes];
  driftedCodes[driftedCodes.length - 1] = 'Z9999';
  const drifted = fakeDatabase({
    baseline: { active_store_codes: driftedCodes },
  });
  assert.notEqual(planHashFor(drifted), approvedHash);

  await assert.rejects(
    migrateFullManagedWarehouseStoreInventory({
      pool: drifted.pool,
      storeCodes: [...STORE_CODES],
      apply: true,
      planHash: approvedHash,
    }),
    (error) => error.code === 'PLAN_HASH_MISMATCH',
  );
  const queries = sqlCalls(drifted);
  assert.equal(
    queries.some((query) => /INSERT INTO dim\.store|UPDATE dim\.store/.test(query)),
    false,
  );
  assert.equal(queries.at(-1), 'ROLLBACK');
});

test('legacy identity, warehouse history, or non-PENDING probes block before any write', async () => {
  const database = fakeDatabase({
    safety: {
      blocked_legacy_count: '1',
      preserved_pending_probe_count: '683',
    },
  });

  await assert.rejects(
    migrateFullManagedWarehouseStoreInventory({
      pool: database.pool,
      storeCodes: [...STORE_CODES],
      apply: true,
      planHash: '0'.repeat(64),
    }),
    (error) => error.code === 'LEGACY_STORE_HAS_PROTECTED_STATE',
  );
  const queries = sqlCalls(database);
  assert.match(queries[5], /platform_shop_id IS NOT NULL/);
  assert.match(queries[5], /legal_entity_name IS NOT NULL/);
  assert.match(queries[5], /store_name <> legacy\.store_code/);
  assert.match(queries[5], /cooperation_mode <> 'FULL_MANAGED'/);
  assert.match(queries[5], /raw\.openapi_fetch_batch/);
  assert.match(queries[5], /AS fetch_batch/);
  assert.doesNotMatch(queries[5], /\bAS fetch\b/);
  assert.match(queries[5], /dim\.full_sku/);
  assert.match(queries[5], /fact\.full_sku_sales_snapshot/);
  assert.match(queries[5], /mart\.full_store_sales_latest/);
  assert.match(queries[5], /mart\.full_product_sales_latest/);
  assert.match(queries[5], /probe\.outcome <> 'PENDING'/);
  assert.equal(queries.some((query) => /INSERT INTO|UPDATE dim\.store/.test(query)), false);
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(database.client.released, true);
});

test('a concurrent count change or inexact active postcondition rolls back', async () => {
  const changed = fakeDatabase({ deactivatedRowCount: 17 });
  await assert.rejects(
    migrateFullManagedWarehouseStoreInventory({
      pool: changed.pool,
      storeCodes: [...STORE_CODES],
      apply: true,
      planHash: planHashFor(changed),
    }),
    (error) => error.code === 'CONCURRENT_INVENTORY_CHANGE',
  );
  assert.equal(sqlCalls(changed).at(-1), 'ROLLBACK');

  const inexact = fakeDatabase({
    postcondition: {
      active_count: '26',
      expected_active_count: '25',
      unexpected_active_count: '1',
    },
  });
  await assert.rejects(
    migrateFullManagedWarehouseStoreInventory({
      pool: inexact.pool,
      storeCodes: [...STORE_CODES],
      apply: true,
      planHash: planHashFor(inexact),
    }),
    (error) => error.code === 'POSTCONDITION_FAILED',
  );
  assert.equal(sqlCalls(inexact).at(-1), 'ROLLBACK');
});

test('SQL contract writes only dim.store and never deletes warehouse history', async () => {
  const database = fakeDatabase();
  await migrateFullManagedWarehouseStoreInventory({
    pool: database.pool,
    storeCodes: [...STORE_CODES],
    apply: true,
    planHash: planHashFor(database),
  });

  const sql = sqlCalls(database).join('\n');
  assert.doesNotMatch(sql, /\bDELETE\b|\bTRUNCATE\b/i);
  assert.doesNotMatch(
    sql,
    /\b(?:INSERT\s+INTO|UPDATE)\s+(?:raw|fact|mart|ops)\./i,
  );
  assert.match(sql, /INSERT INTO dim\.store/);
  assert.match(sql, /UPDATE dim\.store/);
  assert.match(sql, /NOT \(store_code = ANY\(\$1::text\[\]\)\)/);
});

test('CLI validates the 25-store file and emits counts without identities or DATABASE_URL', async () => {
  const files = await inventoryFixture();
  const database = fakeDatabase();
  const stdout = capture();
  const stderr = capture();
  const databaseUrl = 'postgresql://private-user:private-pass@private-host/private-db';
  try {
    const exitCode = await main({
      argv: [
        '--inventory',
        files.inventoryFile,
        '--confirm',
        CONFIRMATION,
        '--plan-hash',
        planHashFor(database),
      ],
      environment: { DATABASE_URL: databaseUrl },
      stdout,
      stderr,
      poolFactory(receivedUrl) {
        assert.equal(receivedUrl, databaseUrl);
        return database.pool;
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.value, '');
    assert.equal(JSON.parse(stdout.value).mode, 'applied');
    assert.equal(JSON.parse(stdout.value).expectedStoreCount, 25);
    for (const secret of [
      databaseUrl,
      'private-pass',
      files.inventoryFile,
      STORE_CODES[0],
      STORE_CODES.at(-1),
    ]) {
      assert.equal(stdout.value.includes(secret), false);
      assert.equal(stderr.value.includes(secret), false);
    }
    assert.equal(database.pool.ended, true);
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('CLI rejects an invalid confirmation or non-unique inventory without connecting', async () => {
  const duplicateCodes = [...STORE_CODES];
  duplicateCodes[24] = duplicateCodes[0];
  const files = await inventoryFixture(duplicateCodes);
  try {
    for (const argv of [
      ['--inventory', files.inventoryFile, '--confirm', 'yes'],
      ['--inventory', files.inventoryFile],
    ]) {
      let connected = false;
      const stderr = capture();
      const exitCode = await main({
        argv,
        environment: { DATABASE_URL: 'postgresql://not-printed' },
        stdout: capture(),
        stderr,
        poolFactory() {
          connected = true;
          return fakeDatabase().pool;
        },
      });
      assert.equal(exitCode, 1);
      assert.equal(connected, false);
      assert.equal(
        JSON.parse(stderr.value).errorCode,
        argv.includes('yes') ? 'CONFIRMATION_REQUIRED' : 'INVENTORY_FILE_INVALID',
      );
      assert.equal(stderr.value.includes(files.inventoryFile), false);
      assert.equal(stderr.value.includes(STORE_CODES[0]), false);
    }
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('CLI confirmed apply requires a canonical dry-run plan hash without connecting', async () => {
  const files = await inventoryFixture();
  let connected = false;
  const stderr = capture();
  try {
    assert.equal(await main({
      argv: ['--inventory', files.inventoryFile, '--confirm', CONFIRMATION],
      environment: { DATABASE_URL: 'postgresql://not-printed' },
      stdout: capture(),
      stderr,
      poolFactory() {
        connected = true;
        return fakeDatabase().pool;
      },
    }), 1);
    assert.equal(connected, false);
    assert.equal(JSON.parse(stderr.value).errorCode, 'PLAN_HASH_REQUIRED');
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('main-module detection resolves a deployment current-directory symlink', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fm-main-realpath-'));
  const releaseDirectory = path.join(directory, 'releases', 'commit', 'scripts');
  const currentDirectory = path.join(directory, 'current');
  const filename = 'migration.mjs';
  try {
    await mkdir(releaseDirectory, { recursive: true });
    await writeFile(path.join(releaseDirectory, filename), '// fixture\n');
    await symlink(
      path.dirname(releaseDirectory),
      currentDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const entryPath = path.join(currentDirectory, 'scripts', filename);
    const moduleUrl = pathToFileURL(path.join(releaseDirectory, filename)).href;
    assert.equal(isMainModule(entryPath, moduleUrl), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('production wrapper uses root-only owner credentials without tracing or printing secrets', async () => {
  const wrapper = await readFile(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../scripts/migrate_full_managed_warehouse_store_inventory.sh',
    ),
    'utf8',
  );
  assert.match(wrapper, /EUID/);
  assert.match(wrapper, /postgres\.env/);
  assert.match(wrapper, /SALES_SYNC_MUST_BE_DISABLED/);
  assert.match(wrapper, /systemctl is-active shein-fm-sales-sync\.service/);
  assert.match(wrapper, /systemctl is-enabled shein-fm-sales-sync\.timer/);
  assert.match(wrapper, /O_NOFOLLOW/);
  assert.match(wrapper, /metadata\.uid !== 0/);
  assert.match(wrapper, /metadata\.mode & 0o027/);
  assert.match(wrapper, /POSTGRES_PASSWORD/);
  assert.match(wrapper, /\/usr\/bin\/env -i/);
  assert.match(wrapper, /spawnSync/);
  assert.match(wrapper, /env:\s*\{/);
  assert.match(wrapper, /DATABASE_URL: url\.href/);
  assert.doesNotMatch(
    wrapper,
    /\/usr\/bin\/env[\s\S]{0,240}DATABASE_URL=/,
  );
  assert.doesNotMatch(wrapper, /(?:^|\n)\s*(?:source|\.)\s+/);
  assert.doesNotMatch(wrapper, /set\s+-x|xtrace|echo\s+.*(?:PASSWORD|DATABASE_URL)/i);
});
