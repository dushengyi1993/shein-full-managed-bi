#!/usr/bin/env node

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
} from '../src/openapi/full-managed-sales.mjs';
import {
  loadFullManagedSalesSync,
  persistPermissionProbe,
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

function failedProbe(storeCode, error) {
  return {
    outcome: classifySalesProbeError(error),
    probedAt: new Date().toISOString(),
    httpStatus: error?.details?.httpStatus ?? null,
    platformErrorCode: error?.details?.platformCode ?? error?.code ?? 'SYNC_ERROR',
    platformMessage: String(error?.details?.platformMessage ?? error?.message ?? 'Unknown sync error').slice(0, 240),
    evidence: { endpointReached: error?.details?.path ?? null, salesEndpointExercised: false, storeCode },
  };
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
        const fetchedAt = new Date();
        const sales = await fetchFullManagedSkuSales(client, {
          storeCode: store.storeCode,
          skuCodes: inventory.items.map(({ skuCode }) => skuCode),
          fetchedAt,
        });
        const loaded = await loadFullManagedSalesSync(pool, {
          store,
          runId: storeRunId,
          permissionPackageCode: config.permissionPackageCode,
          inventory,
          sales,
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
        results.push({ storeCode: store.storeCode, status: probe.outcome.toLowerCase(), errorCode: probe.platformErrorCode });
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

  const loaded = results.filter(({ status }) => status === 'loaded').length;
  const errors = results.filter(({ status }) => status === 'error').length;
  const qualityBlocked = results.filter(({ status }) => status === 'quality_blocked').length;
  console.log(JSON.stringify({
    ok: errors === 0 && qualityBlocked === 0,
    config: summarizeFullManagedConfig(config),
    loadedStores: loaded,
    qualityBlockedStores: qualityBlocked,
    results,
  }, null, 2));
  if (errors > 0 || qualityBlocked > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.message).slice(0, 400) }, null, 2));
  process.exitCode = 1;
});
