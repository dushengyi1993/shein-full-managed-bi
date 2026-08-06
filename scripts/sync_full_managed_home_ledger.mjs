#!/usr/bin/env node

import { Pool } from 'pg';

import { normalizeFullManagedStoreCode } from '../src/config/full-managed-stores.mjs';
import { createLinuxExperimentRuntime } from '../src/webapi-experiment/linux-runtime.mjs';
import { runFullHomeLedgerSync } from '../src/webapi-history/ledger-sync.mjs';
import { createFullHomePageTransport } from '../src/webapi-history/page-transport.mjs';
import { createFullHomeHistoryRepository } from '../src/webapi-history/repository.mjs';
import { createEncryptedWebApiSessionStoreFromEnvironment } from '../src/webapi-session/encrypted-session-store.mjs';
import {
  createFullHomeHttpTransport,
  openFullHomeHttpSession,
} from '../src/webapi-session/http-home-transport.mjs';

const HOME_HISTORY_GATE_PATH = '/srv/shein-fm/runtime/webapi-history.enabled';

export function parseArgs(argv) {
  const result = {
    stores: [],
    from: null,
    to: null,
    retryCdpCount: 0,
    transport: process.env.FULL_FM_WEBAPI_TRANSPORT || 'http',
    execute: false,
  };
  for (const token of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) throw new Error('LEDGER_CLI_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'execute' && value === undefined) result.execute = true;
    else if (name === 'stores' && value) {
      result.stores = [...new Set(value.split(',').map((item) => item.trim().toUpperCase()))];
    } else if (name === 'from' && value) result.from = value;
    else if (name === 'to' && value) result.to = value;
    else if (name === 'retry-cdp' && /^[0-2]$/.test(value ?? '')) {
      result.retryCdpCount = Number(value);
    }
    else if (name === 'transport' && ['http', 'browser'].includes(value)) {
      result.transport = value;
    }
    else throw new Error('LEDGER_CLI_ARGUMENT_INVALID');
  }
  if (
    result.stores.length === 0
    || !result.from
    || !result.to
    || result.stores.some((store) => !normalizeFullManagedStoreCode(store))
  ) {
    throw new Error('LEDGER_CLI_SCOPE_REQUIRED');
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.execute) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'DRY_RUN',
      stores: args.stores,
      from: args.from,
      to: args.to,
      maximumWindowDays: 31,
      retryCdpCount: args.retryCdpCount,
      transport: args.transport,
      browserSessionsOpened: 0,
      databaseConnections: 0,
    }, null, 2));
    return;
  }
  const databaseUrl = process.env.FULL_BI_WEBAPI_DATABASE_URL;
  if (!databaseUrl) throw new Error('LEDGER_DATABASE_URL_MISSING');
  const runtime = args.transport === 'browser'
    ? await createLinuxExperimentRuntime({
        databaseUrl,
        gatePath: HOME_HISTORY_GATE_PATH,
      })
    : null;
  const sessionStore = args.transport === 'http'
    ? await createEncryptedWebApiSessionStoreFromEnvironment()
    : null;
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: 'shein_fm_home_ledger',
  });
  try {
    const repository = createFullHomeHistoryRepository({ pool });
    const result = await runFullHomeLedgerSync({
      storeCodes: args.stores,
      startDate: args.from,
      endDate: args.to,
      retryCdpCount: args.retryCdpCount,
      openSession: args.transport === 'browser'
        ? runtime.deps.openSession
        : ({ storeCode }) => openFullHomeHttpSession({ storeCode, sessionStore }),
      transportFactory: args.transport === 'browser'
        ? ({ session }) => createFullHomePageTransport({ session })
        : ({ session }) => createFullHomeHttpTransport({ session }),
      repository,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } finally {
    if (runtime) await runtime.close().catch(() => {});
    await pool.end().catch(() => {});
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/sync_full_managed_home_ledger.mjs')) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      errorCode: String(error?.code ?? error?.message ?? 'LEDGER_SYNC_FAILED')
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_')
        .slice(0, 80),
    }));
    process.exitCode = 1;
  });
}
