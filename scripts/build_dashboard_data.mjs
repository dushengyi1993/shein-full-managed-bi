#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

import { projectDashboardData } from '../src/domain/dashboard-projection.mjs';
import { loadFullManagedConfig } from '../src/openapi/full-managed-config.mjs';
import {
  atomicWriteJson,
  materializeDashboardFromDatabase,
} from '../src/warehouse/dashboard-materializer.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (['--snapshots', '--permissions', '--database-url', '--config', '--out'].includes(token)) {
      args[token.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!args.out) throw new Error('Missing --out.');
  args.out = path.resolve(args.out);
  if (args['database-url']) {
    if (args.snapshots || args.permissions) {
      throw new Error('--database-url cannot be combined with --snapshots or --permissions.');
    }
  } else {
    for (const key of ['snapshots', 'permissions']) {
      if (!args[key]) throw new Error(`Missing --${key} (or use --database-url).`);
      args[key] = path.resolve(args[key]);
    }
  }
  return args;
}

async function readJson(filePath, description) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${description} JSON: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let dashboard;
  if (args['database-url']) {
    const config = args.config ? await loadFullManagedConfig(args.config) : null;
    const pool = new Pool({ connectionString: args['database-url'], max: 2 });
    try {
      dashboard = await materializeDashboardFromDatabase(pool, {
        storeCatalog: config?.stores ?? [],
      });
    } finally {
      await pool.end();
    }
  } else {
    const snapshots = await readJson(args.snapshots, 'snapshot');
    const storePermissions = await readJson(args.permissions, 'permission');
    dashboard = projectDashboardData({ snapshots, storePermissions });
  }
  await atomicWriteJson(args.out, dashboard);
  console.log(JSON.stringify({
    ok: true,
    output: args.out,
    datasetStatus: dashboard.datasetStatus,
    storeCount: dashboard.permission.totalStores,
    authorizedStores: dashboard.permission.authorizedStores,
    skuCount: dashboard.skuRanking.length,
    updatedAt: dashboard.updatedAt,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
