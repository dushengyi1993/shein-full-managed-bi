#!/usr/bin/env node

import {
  buildIndexUpdateTimeRequest,
  sha256Json,
} from '../src/webapi-history/home-contracts.mjs';
import { createFullHomePageTransport } from '../src/webapi-history/page-transport.mjs';
import { normalizeFullManagedStoreCode } from '../src/config/full-managed-stores.mjs';
import { createLinuxExperimentRuntime } from '../src/webapi-experiment/linux-runtime.mjs';
import { sessionStateForFailure } from '../src/webapi-experiment/browser-session.mjs';
import { createEncryptedWebApiSessionStoreFromEnvironment } from '../src/webapi-session/encrypted-session-store.mjs';
import { exportAuthenticatedWebApiSession } from '../src/webapi-session/profile-session-exporter.mjs';
import {
  createFullHomeHttpTransport,
  openFullHomeHttpSession,
} from '../src/webapi-session/http-home-transport.mjs';

const GATE_PATH = '/srv/shein-fm/runtime/webapi-history.enabled';

export function parseArgs(argv) {
  const result = { stores: [], execute: false };
  for (const token of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) throw new Error('WEBAPI_SESSION_BOOTSTRAP_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'execute' && value === undefined) result.execute = true;
    else if (name === 'stores' && value) {
      result.stores = [...new Set(value.split(',').map((item) => item.trim().toUpperCase()))];
    } else throw new Error('WEBAPI_SESSION_BOOTSTRAP_ARGUMENT_INVALID');
  }
  if (
    result.stores.length === 0
    || result.stores.some((storeCode) => !normalizeFullManagedStoreCode(storeCode))
  ) throw new Error('WEBAPI_SESSION_BOOTSTRAP_SCOPE_REQUIRED');
  return Object.freeze(result);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.execute) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'DRY_RUN',
      stores: args.stores,
      profileSessionsOpened: 0,
      sessionBundlesWritten: 0,
      note: 'Execution proves browser and encrypted HTTP responses are identical before promotion.',
    }, null, 2));
    return;
  }
  const databaseUrl = process.env.FULL_BI_WEBAPI_DATABASE_URL;
  if (!databaseUrl) throw new Error('HOME_WEBAPI_DATABASE_URL_MISSING');
  const sessionStore = await createEncryptedWebApiSessionStoreFromEnvironment();
  const runtime = await createLinuxExperimentRuntime({ databaseUrl, gatePath: GATE_PATH });
  const results = [];
  try {
    for (const storeCode of args.stores) {
      let browserSession = null;
      let httpSession = null;
      try {
        browserSession = await runtime.deps.openSession({
          storeCode,
          allowSavedCredentialLogin: true,
        });
        const request = buildIndexUpdateTimeRequest();
        const pageTransport = createFullHomePageTransport({ session: browserSession });
        const browserResponse = await pageTransport('UPDATE_TIME', request);
        const bundle = await exportAuthenticatedWebApiSession({
          session: browserSession,
          storeCode,
        });
        await sessionStore.write(storeCode, bundle);
        httpSession = await openFullHomeHttpSession({ storeCode, sessionStore });
        const httpResponse = await createFullHomeHttpTransport({ session: httpSession })(
          'UPDATE_TIME',
          request,
        );
        const browserBodySha256 = sha256Json(browserResponse.body);
        const httpBodySha256 = sha256Json(httpResponse.body);
        if (browserBodySha256 !== httpBodySha256) {
          throw Object.assign(new Error('WEBAPI_SESSION_DUAL_READ_MISMATCH'), {
            code: 'WEBAPI_SESSION_DUAL_READ_MISMATCH',
          });
        }
        results.push({
          storeCode,
          ok: true,
          transport: 'SESSION_HTTP',
          dualReadMatched: true,
          responseSha256: httpBodySha256,
          verifiedAt: new Date().toISOString(),
        });
      } catch (error) {
        results.push({
          storeCode,
          ok: false,
          state: sessionStateForFailure(error?.code),
          errorCode: String(error?.code ?? error?.message ?? 'WEBAPI_SESSION_BOOTSTRAP_FAILED')
            .toUpperCase()
            .replace(/[^A-Z0-9_]/g, '_')
            .slice(0, 80),
        });
      } finally {
        await httpSession?.close?.().catch(() => {});
        await browserSession?.close?.().catch(() => {});
      }
    }
  } finally {
    await runtime.close().catch(() => {});
  }
  const report = {
    ok: results.every((row) => row.ok),
    generatedAt: new Date().toISOString(),
    requestedStoreCount: args.stores.length,
    succeededStoreCount: results.filter((row) => row.ok).length,
    results,
  };
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 2;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/bootstrap_full_managed_webapi_sessions.mjs')) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      errorCode: String(error?.code ?? error?.message ?? 'WEBAPI_SESSION_BOOTSTRAP_FAILED')
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_')
        .slice(0, 80),
    }));
    process.exitCode = 1;
  });
}
