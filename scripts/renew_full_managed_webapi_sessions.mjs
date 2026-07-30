#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { FULL_MANAGED_STORE_CODES } from '../src/config/full-managed-stores.mjs';
import {
  SESSION_STATES,
  sessionStateForFailure,
} from '../src/webapi-experiment/browser-session.mjs';
import { createLinuxExperimentRuntime } from '../src/webapi-experiment/linux-runtime.mjs';

const ENABLED_FILE = '/srv/shein-fm/runtime/store-login/renewal.enabled';
const STATE_FILE = '/srv/shein-fm/runtime/store-login/state.json';
const REPORT_FILE = '/srv/shein-fm/runtime/store-login/renewal-report.json';
const GATE_FILE = '/srv/shein-fm/runtime/webapi-experiment.enabled';

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function main() {
  if (!(await exists(ENABLED_FILE))) throw new Error('SESSION_RENEWAL_GATE_MISSING');
  const loginState = await readJson(STATE_FILE);
  const completed = FULL_MANAGED_STORE_CODES.filter(
    (storeCode) => loginState?.stores?.[storeCode]?.status === 'completed',
  );
  if (completed.length === 0) throw new Error('NO_COMPLETED_LOGIN_PROFILES');
  const databaseUrl = process.env.FULL_BI_WEBAPI_DATABASE_URL;
  if (!databaseUrl) throw new Error('HOME_WEBAPI_DATABASE_URL_MISSING');
  const runtime = await createLinuxExperimentRuntime({
    databaseUrl,
    gatePath: GATE_FILE,
  });
  const results = [];
  try {
    for (const storeCode of completed) {
      let session = null;
      try {
        session = await runtime.deps.openSession({
          storeCode,
          allowSavedCredentialLogin: true,
        });
        results.push({ storeCode, state: SESSION_STATES.ACTIVE, renewed: true });
      } catch (error) {
        results.push({
          storeCode,
          state: sessionStateForFailure(error?.code),
          renewed: false,
          errorCode: String(error?.code || 'SESSION_RENEWAL_FAILED').slice(0, 80),
        });
      } finally {
        await session?.close().catch(() => {});
      }
    }
  } finally {
    await runtime.close().catch(() => {});
  }
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    completedProfileCount: completed.length,
    activeCount: results.filter((item) => item.state === SESSION_STATES.ACTIVE).length,
    results,
  };
  await fs.mkdir(path.dirname(REPORT_FILE), { recursive: true, mode: 0o700 });
  await fs.writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (report.activeCount !== completed.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    errorCode: String(error?.message || 'SESSION_RENEWAL_FAILED').slice(0, 80),
  }));
  process.exitCode = 1;
});
