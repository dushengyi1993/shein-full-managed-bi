#!/usr/bin/env node

import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

const CONFIRMATION = 'SHEIN_FULL_WAREHOUSE_STORE_INVENTORY_APPLY';
const EXPECTED_STORE_COUNT = 24;
const LOCK_NAME = 'shein-fm:dim.store:inventory:v1';
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INVENTORY_FILE = path.resolve(
  SCRIPT_DIRECTORY,
  '../config/stores.example.json',
);

export class WarehouseStoreInventoryMigrationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'WarehouseStoreInventoryMigrationError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new WarehouseStoreInventoryMigrationError(code, message, options);
}

function parseArguments(argv, environment) {
  const values = new Map();
  const allowed = new Set(['--inventory', '--confirm', '--plan-hash']);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || values.has(name)) {
      fail('INVALID_ARGUMENTS', 'arguments are incomplete or duplicated');
    }
    values.set(name, value);
  }

  const databaseUrl = String(environment.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    fail('DATABASE_URL_REQUIRED', 'DATABASE_URL is required');
  }

  const inventoryFile = String(
    values.get('--inventory') || DEFAULT_INVENTORY_FILE,
  ).trim();
  if (!inventoryFile) {
    fail('INVENTORY_FILE_REQUIRED', 'inventory file is required');
  }

  const suppliedConfirmation = values.get('--confirm');
  if (suppliedConfirmation !== undefined && suppliedConfirmation !== CONFIRMATION) {
    fail('CONFIRMATION_REQUIRED', 'explicit confirmation is invalid');
  }
  const apply = suppliedConfirmation === CONFIRMATION;
  const planHash = values.get('--plan-hash');
  if (apply && (typeof planHash !== 'string' || !/^[0-9a-f]{64}$/.test(planHash))) {
    fail('PLAN_HASH_REQUIRED', 'a canonical dry-run plan hash is required');
  }
  if (!apply && planHash !== undefined) {
    fail('PLAN_HASH_NOT_ALLOWED', 'a plan hash is only valid for confirmed apply');
  }

  return Object.freeze({
    databaseUrl,
    inventoryFile: path.resolve(inventoryFile),
    apply,
    planHash: planHash || null,
  });
}

async function readInventory(file) {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    fail('INVENTORY_FILE_INVALID', 'inventory file is unavailable', { cause: error });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail('INVENTORY_FILE_INVALID', 'inventory path must be a regular file');
  }

  let document;
  try {
    document = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail('INVENTORY_FILE_INVALID', 'inventory file is invalid JSON', { cause: error });
  }
  if (
    document?.schemaVersion !== 1
    || document?.cooperationMode !== 'FULL_MANAGED'
    || !Array.isArray(document?.stores)
    || document.stores.length !== EXPECTED_STORE_COUNT
  ) {
    fail(
      'INVENTORY_FILE_INVALID',
      'inventory must contain exactly 24 full-managed stores',
    );
  }

  const storeCodes = document.stores.map((store) => {
    const storeCode = typeof store?.storeCode === 'string'
      ? store.storeCode.trim()
      : '';
    if (
      !/^[A-Z0-9_-]+$/.test(storeCode)
      || storeCode.length > 24
      || storeCode !== store?.storeCode
    ) {
      fail('INVENTORY_FILE_INVALID', 'inventory contains an invalid store code');
    }
    return storeCode;
  });
  if (new Set(storeCodes).size !== EXPECTED_STORE_COUNT) {
    fail('INVENTORY_FILE_INVALID', 'inventory store codes must be unique');
  }
  return Object.freeze(storeCodes);
}

function integer(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail('DATABASE_RESULT_INVALID', `${field} is not a safe count`);
  }
  return number;
}

function sortedStoreCodeArray(value, expectedCount) {
  if (
    !Array.isArray(value)
    || value.length !== expectedCount
    || value.some((storeCode) => (
      typeof storeCode !== 'string'
      || !/^[A-Z0-9_-]{1,24}$/.test(storeCode)
    ))
    || new Set(value).size !== value.length
  ) {
    fail('DATABASE_RESULT_INVALID', 'active store identities are invalid');
  }
  const sorted = [...value].sort();
  if (sorted.some((storeCode, index) => storeCode !== value[index])) {
    fail('DATABASE_RESULT_INVALID', 'active store identities are not sorted');
  }
  return Object.freeze([...value]);
}

async function queryLegacySafety(client, storeCodes) {
  const result = await client.query(
    `/* warehouse-store-inventory:legacy-safety */
     WITH legacy AS (
       SELECT
         s.store_id,
         s.store_code,
         s.store_name,
         s.cooperation_mode,
         s.platform_shop_id,
         s.legal_entity_name
       FROM dim.store AS s
       WHERE s.is_active = true
         AND NOT (s.store_code = ANY($1::text[]))
     )
     SELECT
       COUNT(*) FILTER (
         WHERE
           legacy.platform_shop_id IS NOT NULL
           OR legacy.legal_entity_name IS NOT NULL
           OR legacy.store_name <> legacy.store_code
           OR legacy.cooperation_mode <> 'FULL_MANAGED'
           OR EXISTS (
             SELECT 1
             FROM raw.openapi_fetch_batch AS fetch
             WHERE fetch.store_id = legacy.store_id
           )
           OR EXISTS (
             SELECT 1
             FROM dim.full_sku AS sku
             WHERE sku.store_id = legacy.store_id
           )
           OR EXISTS (
             SELECT 1
             FROM fact.full_sku_sales_snapshot AS sale
             WHERE sale.store_id = legacy.store_id
           )
           OR EXISTS (
             SELECT 1
             FROM mart.full_store_sales_latest AS store_mart
             WHERE store_mart.store_id = legacy.store_id
           )
           OR EXISTS (
             SELECT 1
             FROM mart.full_product_sales_latest AS product_mart
             WHERE product_mart.store_id = legacy.store_id
           )
           OR EXISTS (
             SELECT 1
             FROM ops.permission_probe AS probe
             WHERE probe.store_id = legacy.store_id
               AND probe.outcome <> 'PENDING'
           )
       )::text AS blocked_legacy_count,
       (
         SELECT COUNT(*)::text
         FROM ops.permission_probe AS pending_probe
         JOIN legacy AS pending_legacy
           ON pending_legacy.store_id = pending_probe.store_id
         WHERE pending_probe.outcome = 'PENDING'
       ) AS preserved_pending_probe_count
     FROM legacy`,
    [storeCodes],
  );
  const row = result.rows?.[0] || {};
  return Object.freeze({
    blockedLegacyCount: integer(
      row.blocked_legacy_count,
      'blockedLegacyCount',
    ),
    preservedPendingProbeCount: integer(
      row.preserved_pending_probe_count,
      'preservedPendingProbeCount',
    ),
  });
}

async function queryBaseline(client, storeCodes) {
  const result = await client.query(
    `/* warehouse-store-inventory:baseline */
     SELECT
       COUNT(*) FILTER (WHERE is_active = true)::text AS previous_active_count,
       COUNT(*) FILTER (WHERE store_code = ANY($1::text[]))::text
         AS existing_expected_count,
       COUNT(*) FILTER (
         WHERE is_active = true
           AND store_code = ANY($1::text[])
       )::text AS active_expected_count,
       COUNT(*) FILTER (
         WHERE is_active = true
           AND NOT (store_code = ANY($1::text[]))
       )::text AS legacy_active_count,
       COALESCE(
         array_agg(store_code ORDER BY store_code)
           FILTER (WHERE is_active = true),
         ARRAY[]::text[]
       ) AS active_store_codes
     FROM dim.store`,
    [storeCodes],
  );
  const row = result.rows?.[0] || {};
  const previousActiveCount = integer(
    row.previous_active_count,
    'previousActiveCount',
  );
  return Object.freeze({
    previousActiveCount,
    existingExpectedCount: integer(
      row.existing_expected_count,
      'existingExpectedCount',
    ),
    activeExpectedCount: integer(
      row.active_expected_count,
      'activeExpectedCount',
    ),
    legacyActiveCount: integer(
      row.legacy_active_count,
      'legacyActiveCount',
    ),
    activeStoreCodes: sortedStoreCodeArray(
      row.active_store_codes,
      previousActiveCount,
    ),
  });
}

async function upsertExpectedStores(client, storeCodes) {
  await client.query(
    `/* warehouse-store-inventory:upsert-expected */
     INSERT INTO dim.store (
       store_code,
       store_name,
       cooperation_mode,
       is_active,
       last_seen_at
     )
     SELECT
       expected.store_code,
       expected.store_code,
       'FULL_MANAGED',
       true,
       clock_timestamp()
     FROM unnest($1::text[]) WITH ORDINALITY AS expected(store_code, position)
     ORDER BY expected.position
     ON CONFLICT (store_code) DO UPDATE SET
       store_name = EXCLUDED.store_name,
       cooperation_mode = 'FULL_MANAGED',
       is_active = true,
       last_seen_at = clock_timestamp()`,
    [storeCodes],
  );
}

async function deactivateLegacyStores(client, storeCodes) {
  const result = await client.query(
    `/* warehouse-store-inventory:deactivate-legacy */
     UPDATE dim.store
     SET
       is_active = false,
       last_seen_at = clock_timestamp()
     WHERE is_active = true
       AND NOT (store_code = ANY($1::text[]))`,
    [storeCodes],
  );
  return integer(result.rowCount, 'deactivatedLegacyCount');
}

async function verifyPostcondition(client, storeCodes) {
  const result = await client.query(
    `/* warehouse-store-inventory:postcondition */
     SELECT
       COUNT(*) FILTER (WHERE is_active = true)::text AS active_count,
       COUNT(*) FILTER (
         WHERE is_active = true
           AND store_code = ANY($1::text[])
       )::text AS expected_active_count,
       COUNT(*) FILTER (
         WHERE is_active = true
           AND NOT (store_code = ANY($1::text[]))
       )::text AS unexpected_active_count
     FROM dim.store`,
    [storeCodes],
  );
  const row = result.rows?.[0] || {};
  const counts = Object.freeze({
    activeCount: integer(row.active_count, 'activeCount'),
    expectedActiveCount: integer(
      row.expected_active_count,
      'expectedActiveCount',
    ),
    unexpectedActiveCount: integer(
      row.unexpected_active_count,
      'unexpectedActiveCount',
    ),
  });
  if (
    counts.activeCount !== EXPECTED_STORE_COUNT
    || counts.expectedActiveCount !== EXPECTED_STORE_COUNT
    || counts.unexpectedActiveCount !== 0
  ) {
    fail(
      'POSTCONDITION_FAILED',
      'active warehouse store inventory does not exactly match the expected set',
    );
  }
  return counts;
}

function summary({
  apply,
  baseline,
  deactivatedLegacyCount,
  planHash,
  safety,
  postcondition,
}) {
  return Object.freeze({
    ok: true,
    mode: apply ? 'applied' : 'dry-run',
    expectedStoreCount: EXPECTED_STORE_COUNT,
    previousActiveStoreCount: baseline.previousActiveCount,
    insertedStoreCount: EXPECTED_STORE_COUNT - baseline.existingExpectedCount,
    reactivatedStoreCount:
      baseline.existingExpectedCount - baseline.activeExpectedCount,
    deactivatedLegacyStoreCount: deactivatedLegacyCount,
    preservedPendingProbeCount: safety.preservedPendingProbeCount,
    activeStoreCount: postcondition.activeCount,
    planHash,
  });
}

export function createWarehouseStoreInventoryPlanHash({
  storeCodes,
  baseline,
  safety,
}) {
  const payload = [
    'shein-fm-warehouse-store-inventory-plan-v1',
    storeCodes,
    [
      baseline.previousActiveCount,
      baseline.existingExpectedCount,
      baseline.activeExpectedCount,
      baseline.legacyActiveCount,
    ],
    baseline.activeStoreCodes,
    [
      safety.blockedLegacyCount,
      safety.preservedPendingProbeCount,
    ],
  ];
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
}

export async function migrateFullManagedWarehouseStoreInventory({
  pool,
  storeCodes,
  apply = false,
  planHash = null,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('pool.connect is required');
  }
  if (
    !Array.isArray(storeCodes)
    || storeCodes.length !== EXPECTED_STORE_COUNT
    || new Set(storeCodes).size !== EXPECTED_STORE_COUNT
  ) {
    throw new TypeError('exactly 24 unique storeCodes are required');
  }
  if (apply && (typeof planHash !== 'string' || !/^[0-9a-f]{64}$/.test(planHash))) {
    fail('PLAN_HASH_REQUIRED', 'a canonical dry-run plan hash is required');
  }

  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(
      `/* warehouse-store-inventory:lock-timeout */
       SET LOCAL lock_timeout TO '10s'`,
    );
    await client.query(
      `/* warehouse-store-inventory:statement-timeout */
       SET LOCAL statement_timeout TO '60s'`,
    );
    await client.query(
      `/* warehouse-store-inventory:lock */
       SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [LOCK_NAME],
    );
    await client.query(
      `/* warehouse-store-inventory:table-locks */
       LOCK TABLE
         dim.store,
         raw.openapi_fetch_batch,
         dim.full_sku,
         fact.full_sku_sales_snapshot,
         mart.full_store_sales_latest,
         mart.full_product_sales_latest,
         ops.permission_probe
       IN SHARE ROW EXCLUSIVE MODE`,
    );

    const safety = await queryLegacySafety(client, storeCodes);
    if (safety.blockedLegacyCount !== 0) {
      fail(
        'LEGACY_STORE_HAS_PROTECTED_STATE',
        'legacy active stores contain protected identity or business history',
      );
    }

    const baseline = await queryBaseline(client, storeCodes);
    const currentPlanHash = createWarehouseStoreInventoryPlanHash({
      storeCodes,
      baseline,
      safety,
    });
    if (apply && planHash !== currentPlanHash) {
      fail(
        'PLAN_HASH_MISMATCH',
        'the locked database plan differs from the approved dry-run',
      );
    }
    await upsertExpectedStores(client, storeCodes);
    const deactivatedLegacyCount = await deactivateLegacyStores(client, storeCodes);
    if (deactivatedLegacyCount !== baseline.legacyActiveCount) {
      fail(
        'CONCURRENT_INVENTORY_CHANGE',
        'legacy active store count changed during the transaction',
      );
    }
    const postcondition = await verifyPostcondition(client, storeCodes);
    const result = summary({
      apply,
      baseline,
      deactivatedLegacyCount,
      planHash: currentPlanHash,
      safety,
      postcondition,
    });

    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

function safeFailure(error) {
  const code = String(error?.code || '');
  return {
    ok: false,
    errorCode: /^[A-Z0-9_]{3,80}$/.test(code)
      ? code
      : 'WAREHOUSE_STORE_INVENTORY_MIGRATION_FAILED',
  };
}

export async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  poolFactory = (databaseUrl) => new Pool({
    connectionString: databaseUrl,
    max: 1,
  }),
} = {}) {
  let pool;
  try {
    const args = parseArguments(argv, environment);
    const storeCodes = await readInventory(args.inventoryFile);
    pool = poolFactory(args.databaseUrl);
    const result = await migrateFullManagedWarehouseStoreInventory({
      pool,
      storeCodes,
      apply: args.apply,
      planHash: args.planHash,
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify(safeFailure(error))}\n`);
    return 1;
  } finally {
    await pool?.end?.().catch(() => {});
  }
}

export function isMainModule(
  entryPath = process.argv[1],
  moduleUrl = import.meta.url,
) {
  if (!entryPath) return false;
  const resolvedEntryPath = path.resolve(entryPath);
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(resolvedEntryPath) === realpathSync(modulePath);
  } catch {
    return resolvedEntryPath === modulePath;
  }
}

if (isMainModule()) {
  process.exitCode = await main();
}
