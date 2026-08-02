#!/usr/bin/env node

import { Pool } from 'pg';

import { createLinuxExperimentRuntime } from '../src/webapi-experiment/linux-runtime.mjs';
import { createFullHomePageTransport } from '../src/webapi-history/page-transport.mjs';
import { createFullHomeHistoryRepository } from '../src/webapi-history/repository.mjs';
import { runFullHomeHistorySync } from '../src/webapi-history/sync.mjs';
import { normalizeFullManagedStoreCode } from '../src/config/full-managed-stores.mjs';

export const HOME_HISTORY_GATE_PATH = '/srv/shein-fm/runtime/webapi-history.enabled';

function parseArgs(argv) {
  const result = {
    stores: [],
    from: null,
    to: null,
    execute: false,
    includeProducts: true,
    refreshRecentSettledDays: 0,
  };
  for (const token of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) throw new Error('HOME_CLI_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'execute' && value === undefined) result.execute = true;
    else if (name === 'no-products' && value === undefined) result.includeProducts = false;
    else if (name === 'stores' && value) {
      result.stores = [...new Set(value.split(',').map((item) => item.trim().toUpperCase()))];
    } else if (name === 'from' && value) result.from = value;
    else if (name === 'to' && value) result.to = value;
    else if (name === 'refresh-recent-days' && /^\d{1,2}$/.test(value ?? '')) {
      result.refreshRecentSettledDays = Number(value);
      if (result.refreshRecentSettledDays > 30) {
        throw new Error('HOME_CLI_ARGUMENT_INVALID');
      }
    } else throw new Error('HOME_CLI_ARGUMENT_INVALID');
  }
  if (result.stores.length === 0 || !result.from || !result.to) {
    throw new Error('HOME_CLI_SCOPE_REQUIRED');
  }
  if (result.stores.some((store) => !normalizeFullManagedStoreCode(store))) {
    throw new Error('HOME_CLI_STORE_NOT_ALLOWED');
  }
  return result;
}

function dryRunReport(args) {
  return {
    ok: true,
    mode: 'DRY_RUN',
    stores: args.stores,
    from: args.from,
    to: args.to,
    includeProducts: args.includeProducts,
    refreshRecentSettledDays: args.refreshRecentSettledDays,
    includeTradeOverview: true,
    includeRegionRank: true,
    dailyDimensionResume: true,
    browserSessionsOpened: 0,
    databaseConnections: 0,
    note: 'Add --execute only after the exact store/date scope has been reviewed.',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.execute) {
    console.log(JSON.stringify(dryRunReport(args), null, 2));
    return;
  }
  const databaseUrl = process.env.FULL_BI_WEBAPI_DATABASE_URL;
  if (!databaseUrl) throw new Error('HOME_WEBAPI_DATABASE_URL_MISSING');
  const runtime = await createLinuxExperimentRuntime({
    databaseUrl,
    gatePath: HOME_HISTORY_GATE_PATH,
  });
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: 'shein_fm_home_history',
  });
  try {
    const repository = createFullHomeHistoryRepository({ pool });
    const result = await runFullHomeHistorySync({
      storeCodes: args.stores,
      startDate: args.from,
      endDate: args.to,
      includeProducts: args.includeProducts,
      refreshRecentSettledDays: args.refreshRecentSettledDays,
      openSession: runtime.deps.openSession,
      transportFactory: ({ session }) => createFullHomePageTransport({ session }),
      repository,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.complete) process.exitCode = 2;
  } finally {
    await runtime.close().catch(() => {});
    await pool.end().catch(() => {});
  }
}

main().catch((error) => {
  const code = String(error?.code ?? error?.message ?? 'HOME_HISTORY_SYNC_FAILED')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 80);
  console.error(JSON.stringify({
    ok: false,
    errorCode: code || 'HOME_HISTORY_SYNC_FAILED',
  }));
  process.exitCode = 1;
});
