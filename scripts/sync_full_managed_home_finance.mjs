#!/usr/bin/env node

import { Pool } from 'pg';

import {
  fullManagedStoreCallBlock,
  loadFullManagedConfig,
} from '../src/openapi/full-managed-config.mjs';
import {
  fetchFinanceWindow,
  financeWindows,
} from '../src/openapi/finance-reports.mjs';
import { SheinOpenApiClient } from '../src/openapi/shein-client.mjs';
import { createFinanceHomeRepository } from '../src/warehouse/finance-home-repository.mjs';
import { normalizeFullManagedStoreCode } from '../src/config/full-managed-stores.mjs';

function parseArgs(argv) {
  const args = {
    stores: [],
    from: null,
    to: null,
    config: process.env.FULL_BI_OPENAPI_CONFIG_FILE,
    execute: false,
  };
  for (const token of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) throw new Error('FINANCE_CLI_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'execute' && value === undefined) args.execute = true;
    else if (name === 'stores' && value) {
      args.stores = [...new Set(value.split(',').map((item) => item.trim().toUpperCase()))];
    } else if (name === 'from' && value) args.from = value;
    else if (name === 'to' && value) args.to = value;
    else if (name === 'config' && value) args.config = value;
    else throw new Error('FINANCE_CLI_ARGUMENT_INVALID');
  }
  if (
    !args.config
    || !args.from
    || !args.to
    || args.stores.length === 0
    || args.stores.some((store) => !normalizeFullManagedStoreCode(store))
  ) {
    throw new Error('FINANCE_CLI_SCOPE_REQUIRED');
  }
  return args;
}

function safeCode(error, fallback = 'FINANCE_SYNC_FAILED') {
  const code = String(error?.code ?? fallback).toUpperCase();
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : fallback;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const windows = financeWindows({ startDate: args.from, endDate: args.to });
  if (!args.execute) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'DRY_RUN',
      stores: args.stores,
      from: args.from,
      to: args.to,
      windowCount: windows.length,
      networkCalls: 0,
      databaseConnections: 0,
    }, null, 2));
    return;
  }

  const databaseUrl = process.env.FULL_BI_DATABASE_URL;
  if (!databaseUrl) throw new Error('FINANCE_DATABASE_URL_MISSING');
  const config = await loadFullManagedConfig(args.config);
  const byCode = new Map(config.stores.map((store) => [store.storeCode, store]));
  const stores = args.stores.map((storeCode) => {
    const store = byCode.get(storeCode);
    if (!store || fullManagedStoreCallBlock(store)) {
      throw new Error('FINANCE_STORE_NOT_ELIGIBLE');
    }
    return store;
  });
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: 'shein_fm_home_finance',
  });
  const repository = createFinanceHomeRepository({ pool });
  const results = [];
  try {
    for (const store of stores) {
      const client = new SheinOpenApiClient({
        baseUrl: config.baseUrl,
        openKeyId: store.openKeyId,
        secretKey: store.secretKey,
        timeoutMs: config.timeoutMs,
        allowFakeBaseUrl: config.allowFakeBaseUrl,
      });
      for (const window of windows) {
        const observedAt = new Date().toISOString();
        try {
          const fetched = await fetchFinanceWindow(client, window);
          const loaded = await repository.replaceWindow({
            storeCode: store.storeCode,
            ...window,
            ...fetched,
            observedAt,
            completedAt: new Date().toISOString(),
          });
          results.push({
            storeCode: store.storeCode,
            ...window,
            ok: true,
            reportCount: fetched.reports.length,
            detailCount: fetched.details.length,
            ...loaded,
          });
        } catch (error) {
          const errorCode = safeCode(error);
          await repository.recordFailure({
            storeCode: store.storeCode,
            ...window,
            observedAt,
            completedAt: new Date().toISOString(),
            sanitizedErrorCode: errorCode,
          });
          results.push({
            storeCode: store.storeCode,
            ...window,
            ok: false,
            errorCode,
          });
        }
      }
    }
  } finally {
    await pool.end();
  }
  const failed = results.filter(({ ok }) => !ok).length;
  console.log(JSON.stringify({
    ok: failed === 0,
    storeCount: stores.length,
    windowCount: windows.length,
    failedWindows: failed,
    results,
  }, null, 2));
  if (failed > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, errorCode: safeCode(error) }));
  process.exitCode = 1;
});
