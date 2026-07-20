#!/usr/bin/env node

import { Pool } from 'pg';

import { loadFullManagedConfig } from '../src/openapi/full-managed-config.mjs';
import {
  atomicWriteJson,
  materializeDashboardFromDatabase,
} from '../src/warehouse/dashboard-materializer.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (['--config', '--database-url', '--out'].includes(flag)) {
      result[flag.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = args['database-url'] ?? process.env.FULL_BI_DATABASE_URL ?? process.env.DATABASE_URL;
  const output = args.out ?? process.env.FULL_BI_DATA_FILE;
  if (!databaseUrl) throw new Error('FULL_BI_DATABASE_URL is required.');
  if (!output) throw new Error('--out or FULL_BI_DATA_FILE is required.');
  const config = args.config || process.env.FULL_BI_OPENAPI_CONFIG || process.env.FULL_BI_OPENAPI_CONFIG_FILE
    ? await loadFullManagedConfig(args.config)
    : null;
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const dashboard = await materializeDashboardFromDatabase(pool, {
      storeCatalog: config?.stores ?? [],
    });
    const written = await atomicWriteJson(output, dashboard);
    console.log(JSON.stringify({
      ok: true,
      output: written,
      datasetStatus: dashboard.datasetStatus,
      updatedAt: dashboard.updatedAt,
      storeCount: dashboard.permission.totalStores,
      authorizedStores: dashboard.permission.authorizedStores,
      skuCount: dashboard.skuRanking.length,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.message).slice(0, 400) }, null, 2));
  process.exitCode = 1;
});
