#!/usr/bin/env node

import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  lstat,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileAuthorizationStore } from '../src/authorization/file-store.mjs';

const CONFIRMATION = 'SHEIN_FULL_AUTH_REJECT';
const BATCH_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STORE_CODE = /^[A-Z0-9_-]{1,24}$/;
const SUPPLIER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RECEIPT_FILE = /^[A-Za-z0-9_-]{1,160}\.secret\.json$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OTHER_ACCESS_MASK = 0o007;

class RejectionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'RejectionError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new RejectionError(code, message, options);
}

function parseArguments(argv, environment) {
  const values = new Map();
  const allowed = new Set(['--batch-id', '--store', '--supplier-id', '--confirm']);
  if (argv.length % 2 !== 0) {
    fail('INVALID_ARGUMENTS', 'arguments are incomplete or duplicated');
  }
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || values.has(name)) {
      fail('INVALID_ARGUMENTS', 'arguments are incomplete or duplicated');
    }
    values.set(name, value);
  }

  const batchId = String(values.get('--batch-id') || '').trim();
  const storeCode = String(values.get('--store') || '').trim().toUpperCase();
  const supplierId = String(values.get('--supplier-id') || '').trim();
  const confirmation = String(values.get('--confirm') || '');
  const stateFile = String(environment.FULL_AUTH_STATE_FILE || '').trim();
  const receiptDirectory = String(environment.FULL_AUTH_RECEIPT_DIRECTORY || '').trim();

  if (!BATCH_ID.test(batchId)) fail('INVALID_BATCH_ID', '--batch-id is required');
  if (!STORE_CODE.test(storeCode)) fail('INVALID_STORE', '--store is required');
  if (!SUPPLIER_ID.test(supplierId)) fail('INVALID_SUPPLIER_ID', '--supplier-id is required');
  if (confirmation !== CONFIRMATION) {
    fail('CONFIRMATION_REQUIRED', 'explicit confirmation is required');
  }
  if (!stateFile || !receiptDirectory) {
    fail('MISSING_CONFIGURATION', 'authorization state and receipt paths are required');
  }

  return Object.freeze({
    batchId,
    storeCode,
    supplierId,
    stateFile: path.resolve(stateFile),
    receiptDirectory: path.resolve(receiptDirectory),
  });
}

async function requirePrivateRegularFile(file, code) {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    fail(code, 'private file is unavailable', { cause: error });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(code, 'private path is not a regular file');
  }
  if (process.platform !== 'win32' && (metadata.mode & OTHER_ACCESS_MASK) !== 0) {
    fail(code, 'private file permissions are too broad');
  }
  return metadata;
}

async function parsePrivateJson(file, code) {
  await requirePrivateRegularFile(file, code);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail(code, 'private JSON file is invalid', { cause: error });
  }
}

async function resolvePrivateReceiptDirectory(directory) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    fail('RECEIPT_DIRECTORY_UNAVAILABLE', 'receipt directory is unavailable', {
      cause: error,
    });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('UNSAFE_RECEIPT_DIRECTORY', 'receipt path must be a direct private directory');
  }
  if (process.platform !== 'win32' && (metadata.mode & OTHER_ACCESS_MASK) !== 0) {
    fail('UNSAFE_RECEIPT_DIRECTORY', 'receipt directory permissions are too broad');
  }
  try {
    return await realpath(directory);
  } catch (error) {
    fail('RECEIPT_DIRECTORY_UNAVAILABLE', 'receipt directory cannot be resolved', {
      cause: error,
    });
  }
}

async function resolveReceipt(canonicalDirectory, filename) {
  if (!RECEIPT_FILE.test(String(filename || '')) || path.basename(filename) !== filename) {
    fail('INVALID_REVIEW_STATE', 'review state has an unsafe receipt reference');
  }
  const candidate = path.join(canonicalDirectory, filename);
  const metadata = await requirePrivateRegularFile(candidate, 'INVALID_RECEIPT');
  let canonicalCandidate;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch (error) {
    fail('INVALID_RECEIPT', 'receipt cannot be resolved', { cause: error });
  }
  if (
    path.dirname(canonicalCandidate) !== canonicalDirectory
    || canonicalCandidate !== candidate
  ) {
    fail('INVALID_RECEIPT', 'receipt must be a direct non-symlink child');
  }
  return { file: canonicalCandidate, metadata };
}

function selectReviewableStore(state, { batchId, storeCode, supplierId }) {
  if (
    !state
    || typeof state !== 'object'
    || Array.isArray(state)
    || state.schemaVersion !== 1
    || !Array.isArray(state.batches)
  ) {
    fail('INVALID_STATE_FILE', 'authorization state file is invalid');
  }
  const batches = state.batches.filter((batch) => batch?.batchId === batchId);
  const stores = batches.length === 1 && Array.isArray(batches[0].stores)
    ? batches[0].stores.filter((store) => store?.storeCode === storeCode)
    : [];
  const store = stores.length === 1 ? stores[0] : null;
  if (
    batches.length !== 1
    || !store
    || store.status !== 'REVIEW_REQUIRED'
    || String(store.supplierId) !== supplierId
    || !RECEIPT_FILE.test(String(store.receiptFile || ''))
    || path.basename(store.receiptFile) !== store.receiptFile
    || !SHA256.test(String(store.credentialFingerprint || ''))
  ) {
    fail('REVIEW_RECEIPT_NOT_FOUND', 'exactly one matching review receipt is required');
  }
  return store;
}

function validateReceiptIdentity(receipt, { batchId, storeCode, supplierId }) {
  if (
    !receipt
    || typeof receipt !== 'object'
    || Array.isArray(receipt)
    || receipt.schemaVersion !== 1
    || receipt.cooperationMode !== 'FULL_MANAGED'
    || receipt.status !== 'REVIEW_REQUIRED'
    || receipt.batchId !== batchId
    || receipt.storeCode !== storeCode
    || String(receipt.identity?.supplierId) !== supplierId
  ) {
    fail('INVALID_RECEIPT', 'receipt identity does not match the rejection request');
  }
}

async function confirmRejectedAudit(stateFile, args, previousStore) {
  const state = await parsePrivateJson(stateFile, 'INVALID_STATE_FILE');
  const batches = Array.isArray(state?.batches)
    ? state.batches.filter((batch) => batch?.batchId === args.batchId)
    : [];
  const stores = batches.length === 1 && Array.isArray(batches[0].stores)
    ? batches[0].stores.filter((store) => store?.storeCode === args.storeCode)
    : [];
  const store = stores.length === 1 ? stores[0] : null;
  if (
    !store
    || store.status !== 'REJECTED'
    || String(store.supplierId) !== args.supplierId
    || store.receiptFile !== previousStore.receiptFile
    || store.credentialFingerprint !== previousStore.credentialFingerprint
  ) {
    fail('REJECTION_STATE_UNCONFIRMED', 'rejected audit state could not be confirmed');
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function isolateReceipt(receipt, canonicalDirectory, randomBytes) {
  const quarantine = path.join(
    canonicalDirectory,
    `.${path.basename(receipt.file)}.reject-${process.pid}-${randomBytes(16).toString('hex')}.quarantine`,
  );
  if (path.dirname(quarantine) !== canonicalDirectory) {
    fail('UNSAFE_QUARANTINE_PATH', 'receipt quarantine path escaped its directory');
  }
  try {
    await lstat(quarantine);
    fail('QUARANTINE_COLLISION', 'receipt quarantine path already exists');
  } catch (error) {
    if (error instanceof RejectionError) throw error;
    if (error?.code !== 'ENOENT') {
      fail('QUARANTINE_UNAVAILABLE', 'receipt quarantine path cannot be inspected', {
        cause: error,
      });
    }
  }
  try {
    await rename(receipt.file, quarantine);
  } catch (error) {
    fail('RECEIPT_ISOLATION_FAILED', 'receipt could not be isolated', { cause: error });
  }
  const isolatedMetadata = await requirePrivateRegularFile(quarantine, 'INVALID_QUARANTINE');
  if (!sameFile(receipt.metadata, isolatedMetadata)) {
    fail('INVALID_QUARANTINE', 'isolated receipt identity changed');
  }
  return { file: quarantine, metadata: isolatedMetadata };
}

async function restoreReceipt(quarantine, originalFile) {
  try {
    await lstat(originalFile);
    fail('RECEIPT_ROLLBACK_CONFLICT', 'original receipt path is no longer empty');
  } catch (error) {
    if (error instanceof RejectionError) throw error;
    if (error?.code !== 'ENOENT') {
      fail('RECEIPT_ROLLBACK_FAILED', 'original receipt path cannot be inspected', {
        cause: error,
      });
    }
  }
  const isolatedMetadata = await requirePrivateRegularFile(
    quarantine.file,
    'RECEIPT_ROLLBACK_FAILED',
  );
  if (!sameFile(quarantine.metadata, isolatedMetadata)) {
    fail('RECEIPT_ROLLBACK_FAILED', 'quarantined receipt identity changed');
  }
  try {
    await rename(quarantine.file, originalFile);
  } catch (error) {
    fail('RECEIPT_ROLLBACK_FAILED', 'receipt could not be restored', { cause: error });
  }
}

async function deleteIsolatedReceipt(quarantine) {
  const metadata = await requirePrivateRegularFile(
    quarantine.file,
    'RECEIPT_DISPOSAL_FAILED',
  );
  if (!sameFile(quarantine.metadata, metadata)) {
    fail('RECEIPT_DISPOSAL_FAILED', 'quarantined receipt identity changed');
  }
  try {
    await unlink(quarantine.file);
  } catch (error) {
    fail('RECEIPT_DISPOSAL_FAILED', 'quarantined receipt could not be removed', {
      cause: error,
    });
  }
}

export async function rejectAuthorizationReceipt({
  argv = process.argv.slice(2),
  environment = process.env,
  now = new Date(),
  randomBytes = crypto.randomBytes,
  createAuthorizationStore = (file) => new FileAuthorizationStore({ file }),
} = {}) {
  const args = parseArguments(argv, environment);
  if (!Number.isFinite(now.getTime())) fail('INVALID_REVIEW_TIME', 'review time is invalid');

  await requirePrivateRegularFile(args.stateFile, 'INVALID_STATE_FILE');
  const rawState = await parsePrivateJson(args.stateFile, 'INVALID_STATE_FILE');
  const rawStore = selectReviewableStore(rawState, args);
  const receiptDirectory = await resolvePrivateReceiptDirectory(args.receiptDirectory);
  const receipt = await resolveReceipt(receiptDirectory, rawStore.receiptFile);
  validateReceiptIdentity(
    await parsePrivateJson(receipt.file, 'INVALID_RECEIPT'),
    args,
  );

  const quarantine = await isolateReceipt(receipt, receiptDirectory, randomBytes);
  const authorizationStore = createAuthorizationStore(args.stateFile);
  let rejected;
  try {
    rejected = await authorizationStore.rejectStore({
      batchId: args.batchId,
      storeCode: args.storeCode,
      supplierId: args.supplierId,
      reviewedAt: now,
    });
    await confirmRejectedAudit(args.stateFile, args, rawStore);
  } catch (error) {
    try {
      await restoreReceipt(quarantine, receipt.file);
    } catch (rollbackError) {
      fail(
        'REJECTION_FAILED_ROLLBACK_FAILED',
        'state rejection failed and the receipt could not be restored',
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    fail('REJECTION_STATE_FAILED', 'state rejection failed; receipt was restored', {
      cause: error,
    });
  }

  await deleteIsolatedReceipt(quarantine);
  const rejectedStore = rejected.stores.find((store) => store.storeCode === args.storeCode);
  return {
    ok: true,
    batchId: args.batchId,
    storeCode: args.storeCode,
    status: rejectedStore?.status === 'REJECTED' ? 'REJECTED' : 'UNKNOWN',
    reviewedAt: rejectedStore?.reviewedAt ?? now.toISOString(),
    supplierIdConfirmed: true,
  };
}

function safeFailure(error) {
  const value = String(error?.code || '');
  const errorCode = /^[A-Z0-9_]{3,80}$/.test(value) ? value : 'REJECTION_FAILED';
  return { ok: false, errorCode };
}

export async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const result = await rejectAuthorizationReceipt({ argv, environment });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
