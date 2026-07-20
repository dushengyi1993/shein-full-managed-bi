#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { projectDashboardData } from '../src/domain/dashboard-projection.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (['--snapshots', '--permissions', '--out'].includes(token)) {
      args[token.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  for (const key of ['snapshots', 'permissions', 'out']) {
    if (!args[key]) throw new Error(`Missing --${key}.`);
    args[key] = path.resolve(args[key]);
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
  const snapshots = await readJson(args.snapshots, 'snapshot');
  const storePermissions = await readJson(args.permissions, 'permission');
  const dashboard = projectDashboardData({ snapshots, storePermissions });
  await writeFile(args.out, `${JSON.stringify(dashboard, null, 2)}\n`, 'utf8');
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
