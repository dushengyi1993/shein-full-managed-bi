#!/usr/bin/env node

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Pool } from 'pg';

import {
  fullManagedStoreCallBlock,
  loadFullManagedConfig,
  validateFullManagedConfig,
} from '../src/openapi/full-managed-config.mjs';
import { fetchFullManagedProductSpuInfo } from '../src/openapi/product-spu-info.mjs';
import { SheinOpenApiClient } from '../src/openapi/shein-client.mjs';

const PLAN_VERSION = 'shein-fm-product-identity-evidence-plan-v1';
const DOCUMENT_VERSION = 27;
const MAPPER_VERSION = 'spu-info-v1';
const DEFAULT_LANGUAGES = Object.freeze(['zh-cn']);
const SUPPORTED_LANGUAGES = new Set([
  'de',
  'en',
  'es',
  'fr',
  'ja',
  'ko',
  'pt-br',
  'th',
  'zh-cn',
]);
const MAX_CONCURRENCY = 16;
const MAX_LIMIT = 100_000;

export class ProductIdentityEvidenceSyncError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ProductIdentityEvidenceSyncError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ProductIdentityEvidenceSyncError(code, message, options);
}

function requiredFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
    fail('INVALID_ARGUMENTS', `${flag} requires a value`);
  }
  return value.trim();
}

export function parseProductIdentityEvidenceSyncArgs(argv) {
  if (!Array.isArray(argv)) fail('INVALID_ARGUMENTS', 'argv must be an array');
  const valueFlags = new Set([
    '--config',
    '--stores',
    '--now',
    '--run-id',
    '--languages',
    '--max-concurrency',
    '--limit',
    '--approved-hash',
  ]);
  const parsed = { apply: false };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') {
      if (seen.has(flag)) fail('INVALID_ARGUMENTS', '--apply was supplied more than once');
      seen.add(flag);
      parsed.apply = true;
      continue;
    }
    if (!valueFlags.has(flag)) {
      fail('INVALID_ARGUMENTS', `Unknown argument: ${String(flag)}`);
    }
    if (seen.has(flag)) fail('INVALID_ARGUMENTS', `${flag} was supplied more than once`);
    seen.add(flag);
    parsed[flag.slice(2)] = requiredFlagValue(argv, index, flag);
    index += 1;
  }

  const approvedHash = parsed['approved-hash'];
  if (parsed.apply && !/^[0-9a-f]{64}$/.test(approvedHash ?? '')) {
    fail(
      'APPROVED_HASH_REQUIRED',
      '--apply requires an exact lowercase 64-character --approved-hash',
    );
  }
  if (!parsed.apply && approvedHash !== undefined) {
    fail('APPROVED_HASH_NOT_ALLOWED', '--approved-hash is only valid with --apply');
  }
  return Object.freeze(parsed);
}

function normalizeIsoInstant(value = new Date()) {
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    if (!Number.isNaN(copy.valueOf())) return copy.toISOString();
  }
  if (
    typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  fail('INVALID_NOW', 'now must be an ISO-8601 date-time with an explicit offset');
}

function defaultRunId(sourceFetchedAt) {
  return `identity-evidence-${sourceFetchedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

function normalizeRunId(value, sourceFetchedAt) {
  const runId = value ?? defaultRunId(sourceFetchedAt);
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._:-]{8,70}$/.test(runId)) {
    fail('INVALID_RUN_ID', 'run-id must contain 8-70 safe identifier characters');
  }
  return runId;
}

function csvValues(value, location, normalize = (entry) => entry) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('INVALID_ARGUMENTS', `${location} must be text`);
  const values = [];
  const seen = new Set();
  for (const raw of value.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = normalize(trimmed);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      values.push(normalized);
    }
  }
  if (values.length === 0) {
    fail('INVALID_ARGUMENTS', `${location} must contain at least one value`);
  }
  return values;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeLanguages(value) {
  const languages = csvValues(
    value,
    'languages',
    (entry) => entry.toLowerCase(),
  ) ?? [...DEFAULT_LANGUAGES];
  if (languages.length > 5 || languages.some((language) => !SUPPORTED_LANGUAGES.has(language))) {
    fail('INVALID_LANGUAGES', 'languages must contain 1-5 supported goods/spu-info languages');
  }
  return Object.freeze([...languages].sort());
}

function positiveInteger(value, location, fallback, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^[1-9]\d*$/.test(String(value))) {
    fail('INVALID_ARGUMENTS', `${location} must be a positive integer`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > maximum) {
    fail('INVALID_ARGUMENTS', `${location} is outside the supported range`);
  }
  return result;
}

function selectEligibleStores(configStores, requestedValue) {
  const requested = csvValues(
    requestedValue,
    'stores',
    (entry) => entry.toUpperCase(),
  );
  const byCode = new Map(configStores.map((store) => [store.storeCode, store]));
  if (requested !== null) {
    if (requested.some((storeCode) => !byCode.has(storeCode))) {
      fail('UNKNOWN_STORE', 'one or more requested stores are not present in the config');
    }
    if (requested.some((storeCode) => fullManagedStoreCallBlock(byCode.get(storeCode)) !== null)) {
      fail('STORE_NOT_ELIGIBLE', 'one or more requested stores are not eligible for OpenAPI calls');
    }
  }

  const stores = (requested ?? [...byCode.keys()])
    .map((storeCode) => byCode.get(storeCode))
    .filter((store) => fullManagedStoreCallBlock(store) === null)
    .sort((left, right) => compareText(left.storeCode, right.storeCode));
  if (stores.length === 0) {
    fail('NO_ELIGIBLE_STORES', 'no enabled, approved and authorized store is eligible');
  }
  return Object.freeze(stores);
}

function normalizedSpuName(value) {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.trim())
  ) {
    fail('INVALID_UNIVERSE', 'the active SPU universe contains an invalid identifier');
  }
  return value.trim();
}

function normalizeUniverse(rows, storeCodes, limit) {
  if (!Array.isArray(rows)) fail('INVALID_UNIVERSE', 'the SPU universe must be an array');
  const selected = new Set(storeCodes);
  const seen = new Set();
  const universe = [];
  for (const row of rows) {
    const storeCode = String(row?.storeCode ?? row?.store_code ?? '').trim().toUpperCase();
    if (!selected.has(storeCode)) {
      fail('INVALID_UNIVERSE', 'the SPU universe returned an unselected store');
    }
    const spuName = normalizedSpuName(row?.spuName ?? row?.platform_spu_id);
    const key = `${storeCode}\u0000${spuName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    universe.push(Object.freeze({ storeCode, spuName }));
  }
  universe.sort((left, right) => (
    compareText(left.storeCode, right.storeCode)
    || compareText(left.spuName, right.spuName)
  ));
  return Object.freeze(limit === null ? universe : universe.slice(0, limit));
}

/**
 * Read the exact active full-managed store/SPU universe under one read-only
 * repeatable-read transaction. The transaction is closed before any OpenAPI
 * request or evidence repository call can begin.
 */
export async function readActiveFullManagedSpuUniverse(pool, {
  storeCodes,
  limit = null,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('pool.connect is required');
  }
  if (!Array.isArray(storeCodes) || storeCodes.length === 0) {
    throw new TypeError('storeCodes must be a non-empty array');
  }
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionStarted = true;
    const result = await client.query(
      `/* product-identity-evidence:active-spu-universe */
       SELECT DISTINCT
         store.store_code,
         sku.platform_spu_id
       FROM dim.store AS store
       JOIN dim.full_sku AS sku ON sku.store_id = store.store_id
       WHERE store.store_code = ANY($1::text[])
         AND store.cooperation_mode = 'FULL_MANAGED'
         AND store.is_active = true
         AND sku.is_active = true
         AND sku.platform_spu_id IS NOT NULL
         AND BTRIM(sku.platform_spu_id) <> ''
       ORDER BY store.store_code, sku.platform_spu_id`,
      [storeCodes],
    );
    const universe = normalizeUniverse(result?.rows, storeCodes, limit);
    await client.query('COMMIT');
    transactionStarted = false;
    return universe;
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createProductIdentityEvidencePlanHash({
  runId,
  sourceFetchedAt,
  languages,
  limit,
  universe,
} = {}) {
  const payload = [
    PLAN_VERSION,
    DOCUMENT_VERSION,
    MAPPER_VERSION,
    runId,
    sourceFetchedAt,
    languages,
    limit,
    universe.map(({ storeCode, spuName }) => [storeCode, spuName]),
  ];
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
}

function safeErrorCode(error, fallback) {
  const candidate = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  return /^[A-Z0-9_]{3,80}$/.test(candidate) ? candidate : fallback;
}

function skuCount(spuInfo) {
  if (!Array.isArray(spuInfo?.skcs)) return 0;
  return spuInfo.skcs.reduce(
    (total, skc) => total + (Array.isArray(skc?.skus) ? skc.skus.length : 0),
    0,
  );
}

function safeRepositoryCount(value, fallback, location) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    const error = new TypeError(`${location} must be a non-negative integer`);
    error.code = 'INVALID_REPOSITORY_RESULT';
    throw error;
  }
  return result;
}

async function defaultRecordObservation(pool, input) {
  const {
    recordProductIdentitySpuObservation,
  } = await import('../src/warehouse/product-identity-evidence-repository.mjs');
  return recordProductIdentitySpuObservation(pool, input);
}

const DEFAULT_OPERATIONS = Object.freeze({
  readUniverse: readActiveFullManagedSpuUniverse,
  fetchSpuInfo: fetchFullManagedProductSpuInfo,
  recordObservation: defaultRecordObservation,
});

async function mapWithConcurrency(items, maximumConcurrency, handler) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(maximumConcurrency, Math.max(1, items.length)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await handler(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function plannedStoreRows(stores, universe) {
  const counts = new Map(stores.map(({ storeCode }) => [storeCode, 0]));
  for (const { storeCode } of universe) counts.set(storeCode, counts.get(storeCode) + 1);
  return stores.map(({ storeCode }) => Object.freeze({
    storeCode,
    plannedSpuCount: counts.get(storeCode),
  }));
}

function dryRunSummary({
  runId,
  sourceFetchedAt,
  languages,
  maximumConcurrency,
  limit,
  stores,
  universe,
  planHash,
}) {
  return Object.freeze({
    ok: true,
    mode: 'dry-run',
    networkRequests: 0,
    evidenceWrites: 0,
    runId,
    sourceFetchedAt,
    documentVersion: DOCUMENT_VERSION,
    mapperVersion: MAPPER_VERSION,
    languages,
    maximumConcurrency,
    limit,
    selectedStoreCount: stores.length,
    plannedSpuCount: universe.length,
    planHash,
    stores: Object.freeze(plannedStoreRows(stores, universe)),
  });
}

function appliedSummary({
  runId,
  sourceFetchedAt,
  languages,
  maximumConcurrency,
  limit,
  stores,
  universe,
  planHash,
  taskResults,
}) {
  const byStore = new Map(stores.map(({ storeCode }) => [
    storeCode,
    {
      storeCode,
      plannedSpuCount: 0,
      succeeded: 0,
      failed: 0,
      observedSkuCount: 0,
      unresolvedSkuCount: 0,
      errors: new Map(),
    },
  ]));
  for (const { storeCode } of universe) byStore.get(storeCode).plannedSpuCount += 1;
  for (const result of taskResults) {
    const row = byStore.get(result.storeCode);
    if (result.ok) {
      row.succeeded += 1;
      row.observedSkuCount += result.observedSkuCount;
      row.unresolvedSkuCount += result.unresolvedSkuCount;
    } else {
      row.failed += 1;
      row.errors.set(result.errorCode, (row.errors.get(result.errorCode) ?? 0) + 1);
    }
  }
  const storeRows = stores.map(({ storeCode }) => {
    const row = byStore.get(storeCode);
    return Object.freeze({
      storeCode,
      plannedSpuCount: row.plannedSpuCount,
      succeeded: row.succeeded,
      failed: row.failed,
      observedSkuCount: row.observedSkuCount,
      unresolvedSkuCount: row.unresolvedSkuCount,
      errorCounts: Object.freeze(
        [...row.errors]
          .sort(([left], [right]) => compareText(left, right))
          .map(([errorCode, count]) => Object.freeze({ errorCode, count })),
      ),
    });
  });
  const totals = storeRows.reduce(
    (result, row) => ({
      succeeded: result.succeeded + row.succeeded,
      failed: result.failed + row.failed,
      observedSkuCount: result.observedSkuCount + row.observedSkuCount,
      unresolvedSkuCount: result.unresolvedSkuCount + row.unresolvedSkuCount,
    }),
    { succeeded: 0, failed: 0, observedSkuCount: 0, unresolvedSkuCount: 0 },
  );
  return Object.freeze({
    ok: totals.failed === 0,
    mode: 'applied',
    runId,
    sourceFetchedAt,
    documentVersion: DOCUMENT_VERSION,
    mapperVersion: MAPPER_VERSION,
    languages,
    maximumConcurrency,
    limit,
    selectedStoreCount: stores.length,
    plannedSpuCount: universe.length,
    planHash,
    succeeded: totals.succeeded,
    failed: totals.failed,
    observedSkuCount: totals.observedSkuCount,
    unresolvedSkuCount: totals.unresolvedSkuCount,
    stores: Object.freeze(storeRows),
  });
}

export async function runProductIdentityEvidenceSync({
  config,
  databaseUrl,
  stores,
  now = new Date(),
  runId,
  languages,
  maxConcurrency,
  limit,
  apply = false,
  approvedHash = null,
  poolFactory = (connectionString) => new Pool({ connectionString, max: 4 }),
  clientFactory = (options) => new SheinOpenApiClient(options),
  operations: operationOverrides = {},
} = {}) {
  const validatedConfig = validateFullManagedConfig(config);
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    fail('DATABASE_URL_REQUIRED', 'FULL_BI_DATABASE_URL is required');
  }
  if (typeof apply !== 'boolean') fail('INVALID_ARGUMENTS', 'apply must be boolean');
  if (apply && !/^[0-9a-f]{64}$/.test(approvedHash ?? '')) {
    fail('APPROVED_HASH_REQUIRED', 'apply requires an exact approved hash');
  }
  if (!apply && approvedHash !== null && approvedHash !== undefined) {
    fail('APPROVED_HASH_NOT_ALLOWED', 'approved hash is only valid for apply');
  }

  const sourceFetchedAt = normalizeIsoInstant(now);
  const normalizedRunId = normalizeRunId(runId, sourceFetchedAt);
  const normalizedLanguages = normalizeLanguages(languages);
  const maximumConcurrency = positiveInteger(
    maxConcurrency,
    'max-concurrency',
    4,
    MAX_CONCURRENCY,
  );
  const normalizedLimit = positiveInteger(limit, 'limit', null, MAX_LIMIT);
  const selectedStores = selectEligibleStores(validatedConfig.stores, stores);
  const selectedStoreCodes = selectedStores.map(({ storeCode }) => storeCode);
  const operations = { ...DEFAULT_OPERATIONS, ...operationOverrides };

  if (
    typeof operations.readUniverse !== 'function'
    || typeof operations.fetchSpuInfo !== 'function'
    || typeof operations.recordObservation !== 'function'
  ) {
    fail('INVALID_OPERATIONS', 'sync operations are incomplete');
  }

  const pool = await poolFactory(databaseUrl);
  if (!pool || typeof pool.end !== 'function') {
    fail('INVALID_POOL', 'poolFactory must return a pool with end()');
  }

  try {
    const rawUniverse = await operations.readUniverse(pool, {
      storeCodes: selectedStoreCodes,
      limit: normalizedLimit,
    });
    const universe = normalizeUniverse(rawUniverse, selectedStoreCodes, normalizedLimit);
    const planHash = createProductIdentityEvidencePlanHash({
      runId: normalizedRunId,
      sourceFetchedAt,
      languages: normalizedLanguages,
      limit: normalizedLimit,
      universe,
    });

    if (!apply) {
      return dryRunSummary({
        runId: normalizedRunId,
        sourceFetchedAt,
        languages: normalizedLanguages,
        maximumConcurrency,
        limit: normalizedLimit,
        stores: selectedStores,
        universe,
        planHash,
      });
    }
    if (approvedHash !== planHash) {
      fail(
        'PLAN_HASH_MISMATCH',
        'the current active SPU universe differs from the approved dry-run',
      );
    }

    const clients = new Map();
    for (const store of selectedStores) {
      try {
        clients.set(store.storeCode, {
          client: clientFactory({
            baseUrl: validatedConfig.baseUrl,
            openKeyId: store.openKeyId,
            secretKey: store.secretKey,
            timeoutMs: validatedConfig.timeoutMs,
            allowFakeBaseUrl: validatedConfig.allowFakeBaseUrl,
          }),
          errorCode: null,
        });
      } catch (error) {
        clients.set(store.storeCode, {
          client: null,
          errorCode: safeErrorCode(error, 'CLIENT_CONSTRUCTION_FAILED'),
        });
      }
    }

    const taskResults = await mapWithConcurrency(
      universe,
      maximumConcurrency,
      async ({ storeCode, spuName }) => {
        const clientState = clients.get(storeCode);
        if (!clientState?.client) {
          return Object.freeze({
            ok: false,
            storeCode,
            errorCode: clientState?.errorCode ?? 'CLIENT_CONSTRUCTION_FAILED',
          });
        }
        try {
          // This adapter is the only allowed network operation. It is hard-bound
          // to POST /open-api/goods/spu-info and contains no SHEIN write path.
          const spuInfo = await operations.fetchSpuInfo(clientState.client, {
            spuName,
            languageList: normalizedLanguages,
          });
          // The OpenAPI call has completed before the repository starts its own
          // short evidence transaction; no warehouse transaction spans network.
          const recorded = await operations.recordObservation(pool, {
            storeCode,
            runId: normalizedRunId,
            sourceFetchedAt,
            documentVersion: DOCUMENT_VERSION,
            mapperVersion: MAPPER_VERSION,
            spuInfo,
          });
          return Object.freeze({
            ok: true,
            storeCode,
            observedSkuCount: safeRepositoryCount(
              recorded?.observedSkuCount,
              skuCount(spuInfo),
              'observedSkuCount',
            ),
            unresolvedSkuCount: safeRepositoryCount(
              recorded?.unresolvedSkuCount,
              0,
              'unresolvedSkuCount',
            ),
          });
        } catch (error) {
          return Object.freeze({
            ok: false,
            storeCode,
            errorCode: safeErrorCode(error, 'SPU_EVIDENCE_SYNC_FAILED'),
          });
        }
      },
    );

    return appliedSummary({
      runId: normalizedRunId,
      sourceFetchedAt,
      languages: normalizedLanguages,
      maximumConcurrency,
      limit: normalizedLimit,
      stores: selectedStores,
      universe,
      planHash,
      taskResults,
    });
  } finally {
    await pool.end();
  }
}

async function main() {
  const args = parseProductIdentityEvidenceSyncArgs(process.argv.slice(2));
  const config = await loadFullManagedConfig(args.config);
  const databaseUrl = process.env.FULL_BI_DATABASE_URL;
  const summary = await runProductIdentityEvidenceSync({
    config,
    databaseUrl,
    stores: args.stores,
    now: args.now ?? new Date(),
    runId: args['run-id'],
    languages: args.languages,
    maxConcurrency: args['max-concurrency'],
    limit: args.limit,
    apply: args.apply,
    approvedHash: args['approved-hash'] ?? null,
  });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 2;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      errorCode: safeErrorCode(error, 'PRODUCT_IDENTITY_EVIDENCE_SYNC_FAILED'),
      error: 'Full-managed read-only product identity evidence sync did not complete.',
    }));
    process.exitCode = 1;
  });
}
