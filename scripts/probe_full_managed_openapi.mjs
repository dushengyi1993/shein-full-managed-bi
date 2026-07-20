#!/usr/bin/env node

import { Pool } from 'pg';

import {
  fullManagedStoreCallBlock,
  loadFullManagedConfig,
  summarizeFullManagedConfig,
} from '../src/openapi/full-managed-config.mjs';
import { SheinOpenApiClient } from '../src/openapi/shein-client.mjs';
import { probeFullManagedSalesPermission } from '../src/openapi/full-managed-sales.mjs';
import { persistPermissionProbe } from '../src/warehouse/full-managed-sales-repository.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--all') {
      result.all = true;
      continue;
    }
    if (['--config', '--database-url', '--stores', '--run-id'].includes(flag)) {
      result[flag.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  if (result.all && result.stores) throw new Error('--all cannot be combined with --stores.');
  return result;
}

function defaultRunId() {
  return `probe-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

function selectStores(stores, requested) {
  if (!requested) return stores;
  const codes = new Set(requested.split(',').map((value) => value.trim()).filter(Boolean));
  const selected = stores.filter(({ storeCode }) => codes.has(storeCode));
  const missing = [...codes].filter((code) => !selected.some(({ storeCode }) => storeCode === code));
  if (missing.length) throw new Error(`Unknown store code(s): ${missing.join(', ')}`);
  return selected;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadFullManagedConfig(args.config);
  const databaseUrl = args['database-url'] ?? process.env.FULL_BI_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('FULL_BI_DATABASE_URL is required to persist probe evidence.');
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const baseRunId = args['run-id'] ?? defaultRunId();
  const results = [];
  try {
    for (const store of selectStores(config.stores, args.stores)) {
      let probe;
      const reason = fullManagedStoreCallBlock(store);
      if (reason) {
        probe = {
          outcome: 'PENDING',
          probedAt: new Date().toISOString(),
          httpStatus: null,
          platformErrorCode: reason,
          platformMessage: 'Store is not eligible for a real OpenAPI call until application approval, store authorization, credentials, and enabled state all agree.',
          evidence: { endpointReached: null, salesEndpointExercised: false },
        };
      } else {
        const client = new SheinOpenApiClient({
          baseUrl: config.baseUrl,
          openKeyId: store.openKeyId,
          secretKey: store.secretKey,
          timeoutMs: config.timeoutMs,
          allowFakeBaseUrl: config.allowFakeBaseUrl,
        });
        probe = await probeFullManagedSalesPermission(client, { storeCode: store.storeCode });
      }
      await persistPermissionProbe(pool, {
        store,
        runId: `${baseRunId}:${store.storeCode}`,
        permissionPackageCode: config.permissionPackageCode,
        probe,
      });
      results.push({ storeCode: store.storeCode, outcome: probe.outcome, probedAt: probe.probedAt });
    }
  } finally {
    await pool.end();
  }
  const counts = Object.fromEntries(
    ['GRANTED', 'PENDING', 'DENIED', 'ERROR'].map((outcome) => [
      outcome,
      results.filter((result) => result.outcome === outcome).length,
    ]),
  );
  console.log(JSON.stringify({
    ok: counts.ERROR === 0,
    config: summarizeFullManagedConfig(config),
    counts,
    results,
  }, null, 2));
  if (counts.ERROR > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.message).slice(0, 400) }, null, 2));
  process.exitCode = 1;
});
