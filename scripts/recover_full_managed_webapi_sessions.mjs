#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { FULL_MANAGED_STORE_CODES } from '../src/config/full-managed-stores.mjs';
import {
  buildIndexUpdateTimeRequest,
  sha256Json,
} from '../src/webapi-history/home-contracts.mjs';
import { createFullHomePageTransport } from '../src/webapi-history/page-transport.mjs';
import { createLinuxExperimentRuntime } from '../src/webapi-experiment/linux-runtime.mjs';
import {
  createEncryptedWebApiSessionStoreFromEnvironment,
  createEphemeralWebApiSessionStore,
} from '../src/webapi-session/encrypted-session-store.mjs';
import { exportAuthenticatedWebApiSession } from '../src/webapi-session/profile-session-exporter.mjs';
import {
  createFullHomeHttpTransport,
  openFullHomeHttpSession,
} from '../src/webapi-session/http-home-transport.mjs';
const GATE_PATH = '/srv/shein-fm/runtime/webapi-history.enabled';
const RECOVERY_QUEUE_FILE = '/srv/shein-fm/runtime/store-login/session-recovery.json';
const REPORT_FILE = '/srv/shein-fm/runtime/store-login/session-recovery-report.json';
const MAX_STORES_PER_RUN = 3;

function safeCode(error) {
  return String(error?.code ?? error?.message ?? 'SESSION_RECOVERY_FAILED')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 80);
}

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temporary, file);
}

async function main() {
  const queue = JSON.parse(await fs.readFile(RECOVERY_QUEUE_FILE, 'utf8'));
  const queued = [...new Set((Array.isArray(queue?.stores) ? queue.stores : [])
    .map((value) => String(value).trim().toUpperCase()))]
    .filter((storeCode) => FULL_MANAGED_STORE_CODES.includes(storeCode));
  if (queued.length === 0) {
    await fs.rm(RECOVERY_QUEUE_FILE, { force: true });
    console.log(JSON.stringify({ ok: true, status: 'EMPTY', recoveredStoreCount: 0 }));
    return;
  }
  const databaseUrl = process.env.FULL_BI_WEBAPI_DATABASE_URL;
  if (!databaseUrl) throw new Error('HOME_WEBAPI_DATABASE_URL_MISSING');
  const sessionStore = await createEncryptedWebApiSessionStoreFromEnvironment();
  const runtime = await createLinuxExperimentRuntime({ databaseUrl, gatePath: GATE_PATH });
  const selected = queued.slice(0, MAX_STORES_PER_RUN);
  const results = [];
  try {
    for (const storeCode of selected) {
      let browserSession = null;
      let httpSession = null;
      try {
        browserSession = await runtime.deps.openSession({
          storeCode,
          allowSavedCredentialLogin: true,
        });
        const request = buildIndexUpdateTimeRequest();
        const pageResponse = await createFullHomePageTransport({ session: browserSession })(
          'UPDATE_TIME',
          request,
        );
        const bundle = await exportAuthenticatedWebApiSession({
          session: browserSession,
          storeCode,
        });
        const candidateStore = createEphemeralWebApiSessionStore(bundle, storeCode);
        httpSession = await openFullHomeHttpSession({
          storeCode,
          sessionStore: candidateStore,
        });
        const httpResponse = await createFullHomeHttpTransport({ session: httpSession })(
          'UPDATE_TIME',
          request,
        );
        await httpSession.close();
        httpSession = null;
        if (sha256Json(pageResponse.body) !== sha256Json(httpResponse.body)) {
          throw Object.assign(new Error('WEBAPI_SESSION_DUAL_READ_MISMATCH'), {
            code: 'WEBAPI_SESSION_DUAL_READ_MISMATCH',
          });
        }
        await sessionStore.write(storeCode, candidateStore.snapshot());
        results.push({
          storeCode,
          ok: true,
          recovered: true,
          dualReadMatched: true,
        });
      } catch (error) {
        results.push({ storeCode, ok: false, recovered: false, errorCode: safeCode(error) });
      } finally {
        await httpSession?.close?.().catch(() => {});
        await browserSession?.close?.().catch(() => {});
      }
    }
  } finally {
    await runtime.close().catch(() => {});
  }
  const succeeded = new Set(results.filter((row) => row.ok).map((row) => row.storeCode));
  const remaining = queued.filter((storeCode) => !succeeded.has(storeCode));
  const generatedAt = new Date().toISOString();
  if (remaining.length > 0) {
    await atomicWriteJson(RECOVERY_QUEUE_FILE, {
      version: 1,
      generatedAt,
      reason: 'HTTP_SESSION_RECOVERY_PENDING',
      stores: remaining,
    });
  } else {
    await fs.rm(RECOVERY_QUEUE_FILE, { force: true });
  }
  const report = {
    version: 1,
    generatedAt,
    ok: remaining.length === 0,
    attemptedStoreCount: selected.length,
    recoveredStoreCount: succeeded.size,
    remainingStoreCount: remaining.length,
    results,
  };
  await atomicWriteJson(REPORT_FILE, report);
  console.log(JSON.stringify(report));
  if (remaining.length > 0) process.exitCode = 2;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/recover_full_managed_webapi_sessions.mjs')) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, errorCode: safeCode(error) }));
    process.exitCode = 1;
  });
}
