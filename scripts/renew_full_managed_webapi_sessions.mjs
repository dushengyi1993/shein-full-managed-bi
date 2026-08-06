#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { FULL_MANAGED_STORE_CODES } from '../src/config/full-managed-stores.mjs';
import { buildIndexUpdateTimeRequest } from '../src/webapi-history/home-contracts.mjs';
import { createEncryptedWebApiSessionStoreFromEnvironment } from '../src/webapi-session/encrypted-session-store.mjs';
import {
  createFullHomeHttpTransport,
  openFullHomeHttpSession,
} from '../src/webapi-session/http-home-transport.mjs';

const ENABLED_FILE = '/srv/shein-fm/runtime/store-login/renewal.enabled';
const STATE_FILE = '/srv/shein-fm/runtime/store-login/state.json';
const REPORT_FILE = '/srv/shein-fm/runtime/store-login/renewal-report.json';
export const RECOVERY_QUEUE_FILE = '/srv/shein-fm/runtime/store-login/session-recovery.json';

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
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

function safeCode(error) {
  return String(error?.code ?? error?.message ?? 'SESSION_HTTP_RENEWAL_FAILED')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 80);
}

function stateForCode(code) {
  if (['HOME_AUTH_EXPIRED', 'WEBAPI_SESSION_NOT_FOUND'].includes(code)) return 'EXPIRED';
  if (code.includes('STORE_MISMATCH') || code.includes('IDENTITY')) return 'BLOCKED';
  return 'UNKNOWN';
}

async function main() {
  if (!(await exists(ENABLED_FILE))) throw new Error('SESSION_RENEWAL_GATE_MISSING');
  const loginState = await readJson(STATE_FILE);
  const completed = FULL_MANAGED_STORE_CODES.filter(
    (storeCode) => loginState?.stores?.[storeCode]?.status === 'completed',
  );
  if (completed.length === 0) throw new Error('NO_COMPLETED_LOGIN_PROFILES');
  const sessionStore = await createEncryptedWebApiSessionStoreFromEnvironment();
  const results = [];
  const recoveryStores = [];
  for (const storeCode of completed) {
    let session = null;
    try {
      session = await openFullHomeHttpSession({ storeCode, sessionStore });
      await createFullHomeHttpTransport({ session })(
        'UPDATE_TIME',
        buildIndexUpdateTimeRequest(),
      );
      await session.close();
      session = null;
      results.push({
        storeCode,
        state: 'ACTIVE',
        renewed: true,
        transport: 'SESSION_HTTP',
      });
    } catch (error) {
      const errorCode = safeCode(error);
      recoveryStores.push(storeCode);
      results.push({
        storeCode,
        state: stateForCode(errorCode),
        renewed: false,
        transport: 'SESSION_HTTP',
        recoveryQueued: true,
        errorCode,
      });
    } finally {
      await session?.close?.().catch(() => {});
    }
  }
  const generatedAt = new Date().toISOString();
  const report = {
    version: 2,
    generatedAt,
    completedProfileCount: completed.length,
    activeCount: results.filter((item) => item.state === 'ACTIVE').length,
    recoveryQueuedCount: recoveryStores.length,
    results,
  };
  await atomicWriteJson(REPORT_FILE, report);
  if (recoveryStores.length > 0) {
    await atomicWriteJson(RECOVERY_QUEUE_FILE, {
      version: 1,
      generatedAt,
      reason: 'HTTP_SESSION_VALIDATION_FAILED',
      stores: recoveryStores,
    });
  } else {
    await fs.rm(RECOVERY_QUEUE_FILE, { force: true });
  }
  console.log(JSON.stringify(report));
  if (report.activeCount !== completed.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    errorCode: safeCode(error),
  }));
  process.exitCode = 1;
});
