#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

import {
  fullManagedStoreCallBlock,
  loadFullManagedConfig,
  summarizeFullManagedConfig,
} from '../src/openapi/full-managed-config.mjs';
import { SheinOpenApiClient } from '../src/openapi/shein-client.mjs';
import {
  classifySalesProbeError,
  fetchFullManagedSkuInventory,
  fetchFullManagedSkuSales,
  QUERY_SKU_SALES_PATH,
} from '../src/openapi/full-managed-sales.mjs';
import {
  loadFullManagedSalesSync,
  MIXED_STATISTICS_DATES_CODE,
  MIXED_STATISTICS_DATES_MESSAGE,
  persistPermissionProbe,
  SalesDataQualityError,
} from '../src/warehouse/full-managed-sales-repository.mjs';
import {
  atomicWriteJson,
  materializeDashboardFromDatabase,
} from '../src/warehouse/dashboard-materializer.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--all') {
      result.all = true;
      continue;
    }
    if (['--config', '--database-url', '--stores', '--run-id', '--dashboard-out'].includes(flag)) {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
        throw new Error(`${flag} requires a value.`);
      }
      result[flag.slice(2)] = value.trim();
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  if (result.all && result.stores) throw new Error('--all cannot be combined with --stores.');
  return result;
}

function defaultRunId() {
  return `sync-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

function selectStores(stores, requested) {
  const requestedCodes = requested
    ? new Set(requested.split(',').map((value) => value.trim()).filter(Boolean))
    : null;
  const selected = stores.filter((store) => !requestedCodes || requestedCodes.has(store.storeCode));
  if (requestedCodes) {
    const missing = [...requestedCodes].filter((code) => !selected.some(({ storeCode }) => storeCode === code));
    if (missing.length) throw new Error(`Unknown store code(s): ${missing.join(', ')}`);
  }
  if (selected.length === 0) throw new Error('No full-managed stores were selected.');
  return selected;
}

export function failedProbe(storeCode, error) {
  if (
    error instanceof SalesDataQualityError
    && error.code === MIXED_STATISTICS_DATES_CODE
  ) {
    const statisticsDateCount = Number.isSafeInteger(error?.details?.statisticsDateCount)
      && error.details.statisticsDateCount >= 2
      ? error.details.statisticsDateCount
      : null;
    return {
      outcome: 'GRANTED',
      probedAt: new Date().toISOString(),
      httpStatus: 200,
      platformErrorCode: MIXED_STATISTICS_DATES_CODE,
      platformMessage: MIXED_STATISTICS_DATES_MESSAGE,
      evidence: {
        endpointReached: QUERY_SKU_SALES_PATH,
        salesEndpointExercised: true,
        statisticsDateAvailable: true,
        dataLoadable: false,
        dataQualityStatus: 'BLOCKED',
        dataQualityReason: MIXED_STATISTICS_DATES_CODE,
        statisticsDateCount,
      },
    };
  }
  return {
    outcome: classifySalesProbeError(error),
    probedAt: new Date().toISOString(),
    httpStatus: error?.details?.httpStatus ?? null,
    platformErrorCode: error?.details?.platformCode ?? error?.code ?? 'SYNC_ERROR',
    platformMessage: String(error?.details?.platformMessage ?? error?.message ?? 'Unknown sync error').slice(0, 240),
    evidence: { endpointReached: error?.details?.path ?? null, salesEndpointExercised: false, storeCode },
  };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export function failedResult(storeCode, probe) {
  const qualityBlocked = (
    probe.outcome === 'GRANTED'
    && probe.evidence?.dataQualityReason === MIXED_STATISTICS_DATES_CODE
  );
  return {
    storeCode,
    status: qualityBlocked ? 'quality_blocked' : probe.outcome.toLowerCase(),
    errorCode: probe.platformErrorCode,
  };
}

export function summarizeSyncResults(results) {
  const loaded = results.filter(({ status }) => status === 'loaded').length;
  const errors = results.filter(({ status }) => status === 'error').length;
  const qualityBlocked = results.filter(({ status }) => status === 'quality_blocked').length;
  return {
    loaded,
    errors,
    qualityBlocked,
    ok: errors === 0 && qualityBlocked === 0,
    exitCode: errors > 0 || qualityBlocked > 0 ? 2 : 0,
  };
}

export async function fetchAndLoadSalesWithDateRetry({
  client,
  store,
  storeRunId,
  permissionPackageCode,
  inventory,
  pool,
  maximumAttempts = 3,
  clock = () => new Date(),
  fetchSales = fetchFullManagedSkuSales,
  loadSales = loadFullManagedSalesSync,
} = {}) {
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 3) {
    throw new TypeError('maximumAttempts must be an integer from 1 to 3');
  }
  let lastError = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const sales = await fetchSales(client, {
      storeCode: store.storeCode,
      skuCodes: inventory.items.map(({ skuCode }) => skuCode),
      fetchedAt: clock(),
    });
    try {
      const loaded = await loadSales(pool, {
        store,
        runId: storeRunId,
        permissionPackageCode,
        inventory,
        sales,
      });
      return {
        ...loaded,
        statisticsDateRetryCount: attempt - 1,
      };
    } catch (error) {
      lastError = error;
      const rollover = (
        error instanceof SalesDataQualityError
        && error.code === MIXED_STATISTICS_DATES_CODE
      );
      if (!rollover || attempt === maximumAttempts) throw error;
    }
  }
  throw lastError ?? new Error('sales date retry ended without a result');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadFullManagedConfig(args.config);
  const databaseUrl = args['database-url'] ?? process.env.FULL_BI_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('FULL_BI_DATABASE_URL is required.');
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const baseRunId = args['run-id'] ?? defaultRunId();
  const results = [];
  try {
    for (const store of selectStores(config.stores, args.stores)) {
      const storeRunId = `${baseRunId}:${store.storeCode}`;
      const reason = fullManagedStoreCallBlock(store);
      if (reason) {
        const probe = {
          outcome: 'PENDING',
          probedAt: new Date().toISOString(),
          httpStatus: null,
          platformErrorCode: reason,
          platformMessage: 'Store is not eligible for a real OpenAPI call until application approval, store authorization, credentials, and enabled state all agree.',
          evidence: { endpointReached: null, salesEndpointExercised: false, storeCode: store.storeCode },
        };
        await persistPermissionProbe(pool, {
          store, runId: storeRunId, permissionPackageCode: config.permissionPackageCode, probe,
        });
        results.push({ storeCode: store.storeCode, status: 'pending', skuCount: null });
        continue;
      }
      try {
        const client = new SheinOpenApiClient({
          baseUrl: config.baseUrl,
          openKeyId: store.openKeyId,
          secretKey: store.secretKey,
          timeoutMs: config.timeoutMs,
          allowFakeBaseUrl: config.allowFakeBaseUrl,
        });
        const inventory = await fetchFullManagedSkuInventory(client, { pageSize: config.pageSize });
        if (inventory.items.length === 0) {
          const probe = {
            outcome: 'PENDING',
            probedAt: new Date().toISOString(),
            httpStatus: 200,
            platformErrorCode: 'NO_SKU_FOR_SALES_PROBE',
            platformMessage: 'No SKU is available; query-sku-sales was not exercised.',
            evidence: { endpointReached: '/open-api/goods/number-list', salesEndpointExercised: false },
          };
          await persistPermissionProbe(pool, {
            store, runId: storeRunId, permissionPackageCode: config.permissionPackageCode, probe,
          });
          results.push({ storeCode: store.storeCode, status: 'pending', skuCount: 0 });
          continue;
        }
        const loaded = await fetchAndLoadSalesWithDateRetry({
          client,
          store,
          storeRunId,
          permissionPackageCode: config.permissionPackageCode,
          inventory,
          pool,
        });
        results.push({
          storeCode: store.storeCode,
          status: loaded.qualityStatus === 'UNANCHORED_NONZERO'
            ? 'quality_blocked'
            : 'loaded',
          ...loaded,
        });
      } catch (error) {
        const probe = failedProbe(store.storeCode, error);
        await persistPermissionProbe(pool, {
          store, runId: storeRunId, permissionPackageCode: config.permissionPackageCode, probe,
        });
        results.push(failedResult(store.storeCode, probe));
      }
    }

    const dashboardOut = args['dashboard-out'] ?? process.env.FULL_BI_DATA_FILE;
    if (dashboardOut) {
      const dashboard = await materializeDashboardFromDatabase(pool, { storeCatalog: config.stores });
      await atomicWriteJson(dashboardOut, dashboard);
    }
  } finally {
    await pool.end();
  }

  const summary = summarizeSyncResults(results);
  console.log(JSON.stringify({
    ok: summary.ok,
    config: summarizeFullManagedConfig(config),
    loadedStores: summary.loaded,
    qualityBlockedStores: summary.qualityBlocked,
    results,
  }, null, 2));
  if (summary.exitCode !== 0) process.exitCode = summary.exitCode;
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error.message).slice(0, 400) }, null, 2));
    process.exitCode = 1;
  });
}
