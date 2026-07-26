#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileAuthorizationStore } from '../src/authorization/file-store.mjs';

function requiredEnvironment(name, environment) {
  const value = String(environment[name] || '').trim();
  if (!value) {
    const error = new Error(`${name} is required`);
    error.code = 'MISSING_CONFIGURATION';
    throw error;
  }
  return value;
}

/**
 * Produce the only representation this command is allowed to print.
 * File names, account numbers, platform names, hashes and credentials are
 * intentionally not copied from the authorization store.
 */
export function sanitizeAuthorizationBatches(batches) {
  return batches.map((batch) => ({
    batchId: batch.batchId,
    status: batch.status,
    createdAt: batch.createdAt,
    expiresAt: batch.expiresAt,
    stores: batch.stores.map((store) => ({
      storeCode: store.storeCode,
      status: store.status,
      supplierId: store.supplierId ?? null,
      authorizedAt: store.authorizedAt ?? null,
      reviewedAt: store.reviewedAt ?? null,
    })),
  }));
}

export async function createAuthorizationStatusReport({
  environment = process.env,
  now = new Date(),
} = {}) {
  const stateFile = path.resolve(requiredEnvironment('FULL_AUTH_STATE_FILE', environment));
  const store = new FileAuthorizationStore({ file: stateFile });
  const batches = await store.listReviewBatches(now);
  return {
    ok: true,
    batches: sanitizeAuthorizationBatches(batches),
  };
}

function safeFailure(error) {
  const allowed = new Set([
    'INVALID_STATE_FILE',
    'MISSING_CONFIGURATION',
  ]);
  return {
    ok: false,
    errorCode: allowed.has(error?.code) ? error.code : 'AUTHORIZATION_STATUS_UNAVAILABLE',
  };
}

export async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (argv.length > 0) {
    stderr.write(`${JSON.stringify({ ok: false, errorCode: 'INVALID_ARGUMENTS' })}\n`);
    return 2;
  }
  try {
    const report = await createAuthorizationStatusReport({ environment });
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify(safeFailure(error))}\n`);
    return 1;
  }
}

function isMainModule(entryPath = process.argv[1], moduleUrl = import.meta.url) {
  if (!entryPath) return false;
  const resolvedEntryPath = path.resolve(entryPath);
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(resolvedEntryPath) === realpathSync(modulePath);
  } catch {
    return resolvedEntryPath === modulePath;
  }
}

if (isMainModule()) {
  process.exitCode = await main();
}
