#!/usr/bin/env node

import crypto from 'node:crypto';
import {
  constants,
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FileAuthorizationStore,
  sha256,
} from '../src/authorization/file-store.mjs';
import { verifiedIdentity } from '../src/authorization/service.mjs';
import { validateFullManagedConfig } from '../src/openapi/full-managed-config.mjs';
import { SheinOpenApiClient } from '../src/openapi/shein-client.mjs';

const CONFIRMATION = 'SHEIN_FULL_AUTH_APPROVE';
const STORE_CODE = /^[A-Z0-9_-]{1,24}$/;
const SUPPLIER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RECEIPT_FILE = /^[A-Za-z0-9_-]{1,160}\.secret\.json$/;
const PRIVATE_FILE_FORBIDDEN_MODE = 0o027;
const LOCK_DIRECTORY_SUFFIX = '.finalize.lock';
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_NONCE = /^[0-9a-f]{32}$/;
const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 5 * 60 * 1000;
const STORE_INFO_PATH = '/open-api/openapi-business-backend/query-store-info';

class FinalizationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'FinalizationError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new FinalizationError(code, message, options);
}

function cleanRequiredString(value, {
  code = 'INVALID_RECEIPT',
  maximum = 256,
} = {}) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(code, 'required private value is invalid');
  }
  return value;
}

function parseArguments(argv, environment) {
  const values = new Map();
  const allowed = new Set([
    '--store',
    '--supplier-id',
    '--confirm',
    '--openapi-config',
    '--identity-map',
    '--application-file',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || values.has(name)) {
      fail('INVALID_ARGUMENTS', 'arguments are incomplete or duplicated');
    }
    values.set(name, value);
  }
  const storeCode = String(values.get('--store') || '').trim().toUpperCase();
  const supplierId = String(values.get('--supplier-id') || '').trim();
  const confirmation = String(values.get('--confirm') || '');
  const stateFile = String(environment.FULL_AUTH_STATE_FILE || '').trim();
  const receiptDirectory = String(environment.FULL_AUTH_RECEIPT_DIRECTORY || '').trim();
  const openapiConfig = String(
    values.get('--openapi-config') || environment.FULL_BI_OPENAPI_CONFIG_FILE || '',
  ).trim();
  const identityMap = String(
    values.get('--identity-map') || environment.FULL_AUTH_IDENTITY_MAP_FILE || '',
  ).trim();
  const applicationFile = String(
    values.get('--application-file') || environment.FULL_AUTH_APPLICATION_FILE || '',
  ).trim();

  if (!STORE_CODE.test(storeCode)) fail('INVALID_STORE', '--store is required');
  if (!SUPPLIER_ID.test(supplierId)) fail('INVALID_SUPPLIER_ID', '--supplier-id is required');
  if (confirmation !== CONFIRMATION) fail('CONFIRMATION_REQUIRED', 'explicit confirmation is required');
  if (!identityMap) {
    fail('IDENTITY_MAP_REQUIRED', '--identity-map or FULL_AUTH_IDENTITY_MAP_FILE is required');
  }
  if (!applicationFile) {
    fail(
      'APPLICATION_FILE_REQUIRED',
      '--application-file or FULL_AUTH_APPLICATION_FILE is required',
    );
  }
  if (!stateFile || !receiptDirectory || !openapiConfig) {
    fail('MISSING_CONFIGURATION', 'authorization and OpenAPI paths are required');
  }

  return Object.freeze({
    storeCode,
    supplierId,
    stateFile: path.resolve(stateFile),
    receiptDirectory: path.resolve(receiptDirectory),
    openapiConfig: path.resolve(openapiConfig),
    identityMap: path.resolve(identityMap),
    applicationFile: path.resolve(applicationFile),
  });
}

export function openApiFinalizationLockDirectory(openapiConfig) {
  return `${path.resolve(openapiConfig)}${LOCK_DIRECTORY_SUFFIX}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function readLockOwner(lockDirectory) {
  const ownerFile = path.join(lockDirectory, LOCK_OWNER_FILE);
  let metadata;
  try {
    metadata = await lstat(ownerFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('UNSAFE_FINALIZATION_LOCK', 'finalization lock owner cannot be inspected', {
      cause: error,
    });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail('UNSAFE_FINALIZATION_LOCK', 'finalization lock owner is not a regular file');
  }
  try {
    const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
    if (
      owner?.schemaVersion !== 1
      || !Number.isSafeInteger(owner.pid)
      || owner.pid < 1
      || !LOCK_NONCE.test(String(owner.nonce || ''))
      || !Number.isFinite(Date.parse(owner.createdAt))
    ) {
      return null;
    }
    return owner;
  } catch {
    return null;
  }
}

async function removeKnownLockDirectory(lockDirectory) {
  await unlink(path.join(lockDirectory, LOCK_OWNER_FILE)).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await rmdir(lockDirectory);
}

async function cleanupIsolatedLockDirectory(lockDirectory) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await removeKnownLockDirectory(lockDirectory);
      return true;
    } catch (error) {
      if (!['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) return false;
      await delay(10 * (attempt + 1));
    }
  }
  return false;
}

async function renameLockDirectory(source, destination) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(error?.code) || attempt === 9) throw error;
      await delay(10 * (attempt + 1));
    }
  }
}

async function reapStaleLock(lockDirectory, staleMilliseconds) {
  let metadata;
  try {
    metadata = await lstat(lockDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    fail('FINALIZATION_LOCK_UNAVAILABLE', 'finalization lock cannot be inspected', {
      cause: error,
    });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('UNSAFE_FINALIZATION_LOCK', 'finalization lock path is not a regular directory');
  }
  const owner = await readLockOwner(lockDirectory);
  const oldEnough = Date.now() - metadata.mtimeMs > staleMilliseconds;
  const ownerExited = owner !== null && !processIsAlive(owner.pid);
  if (!oldEnough && !ownerExited) return false;

  const quarantine = `${lockDirectory}.stale-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    await renameLockDirectory(lockDirectory, quarantine);
  } catch (error) {
    if (['ENOENT', 'EEXIST'].includes(error?.code)) return true;
    fail('FINALIZATION_LOCK_UNAVAILABLE', 'stale finalization lock cannot be isolated', {
      cause: error,
    });
  }
  // The stale lock is already outside the canonical lock path. Unknown
  // contents are deliberately left for an administrator instead of being
  // recursively deleted.
  await cleanupIsolatedLockDirectory(quarantine);
  return true;
}

async function createLockOwner(lockDirectory, owner) {
  const ownerFile = path.join(lockDirectory, LOCK_OWNER_FILE);
  let handle;
  try {
    handle = await open(ownerFile, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(ownerFile).catch(() => {});
    await rmdir(lockDirectory).catch(() => {});
    fail('FINALIZATION_LOCK_UNAVAILABLE', 'finalization lock owner cannot be created', {
      cause: error,
    });
  }
}

async function acquireOpenApiFinalizationLock(openapiConfig, {
  waitMilliseconds = LOCK_WAIT_MS,
  staleMilliseconds = LOCK_STALE_MS,
} = {}) {
  const lockDirectory = openApiFinalizationLockDirectory(openapiConfig);
  if (path.dirname(lockDirectory) !== path.dirname(path.resolve(openapiConfig))) {
    fail('UNSAFE_FINALIZATION_LOCK', 'finalization lock escaped its configuration directory');
  }
  const deadline = Date.now() + waitMilliseconds;
  while (true) {
    const nonce = crypto.randomBytes(16).toString('hex');
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      await createLockOwner(lockDirectory, {
        schemaVersion: 1,
        pid: process.pid,
        nonce,
        createdAt: new Date().toISOString(),
      });
      return Object.freeze({ lockDirectory, nonce });
    } catch (error) {
      if (error instanceof FinalizationError) throw error;
      if (error?.code !== 'EEXIST') {
        fail('FINALIZATION_LOCK_UNAVAILABLE', 'finalization lock cannot be created', {
          cause: error,
        });
      }
    }

    if (await reapStaleLock(lockDirectory, staleMilliseconds)) continue;
    if (Date.now() >= deadline) {
      fail('FINALIZATION_LOCK_TIMEOUT', 'another finalization still owns the configuration lock');
    }
    await delay(25 + (crypto.randomBytes(1)[0] % 50));
  }
}

async function releaseOpenApiFinalizationLock(lock) {
  const owner = await readLockOwner(lock.lockDirectory);
  if (!owner || owner.pid !== process.pid || owner.nonce !== lock.nonce) {
    fail('FINALIZATION_LOCK_OWNERSHIP_LOST', 'finalization lock ownership could not be verified');
  }
  const releasedDirectory = `${lock.lockDirectory}.released-${process.pid}-${lock.nonce}`;
  try {
    await renameLockDirectory(lock.lockDirectory, releasedDirectory);
  } catch (error) {
    fail('FINALIZATION_LOCK_RELEASE_FAILED', 'finalization lock could not be isolated for release', {
      cause: error,
    });
  }
  const releasedOwner = await readLockOwner(releasedDirectory);
  if (!releasedOwner || releasedOwner.pid !== process.pid || releasedOwner.nonce !== lock.nonce) {
    fail('FINALIZATION_LOCK_OWNERSHIP_LOST', 'released finalization lock owner is invalid');
  }
  // The canonical lock was released by the verified atomic rename. Windows
  // scanners can briefly retain directory handles, so isolated cleanup is
  // retried and may be left for later without reopening the critical section.
  await cleanupIsolatedLockDirectory(releasedDirectory);
}

async function withOpenApiFinalizationLock(openapiConfig, operation, lockOptions) {
  const lock = await acquireOpenApiFinalizationLock(openapiConfig, lockOptions);
  let operationError = null;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseOpenApiFinalizationLock(lock);
    } catch (releaseError) {
      if (!operationError) throw releaseError;
      operationError.lockReleaseError = releaseError;
    }
  }
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
  if (process.platform !== 'win32' && (metadata.mode & PRIVATE_FILE_FORBIDDEN_MODE) !== 0) {
    fail(code, 'private file permissions are too broad');
  }
  return metadata;
}

async function requirePrivateDirectory(directory, code) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    fail(code, 'private directory is unavailable', { cause: error });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(code, 'private path is not a regular directory');
  }
  if (process.platform !== 'win32' && (metadata.mode & PRIVATE_FILE_FORBIDDEN_MODE) !== 0) {
    fail(code, 'private directory permissions are too broad');
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

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function parseIdentityMap(value) {
  if (
    !hasExactKeys(value, ['bindings', 'cooperationMode', 'schemaVersion'])
    || value.schemaVersion !== 1
    || value.cooperationMode !== 'FULL_MANAGED'
    || !Array.isArray(value.bindings)
    || value.bindings.length < 1
  ) {
    fail('INVALID_IDENTITY_MAP', 'identity map schema is invalid');
  }
  const byStoreCode = new Map();
  const supplierIds = new Set();
  for (const binding of value.bindings) {
    if (!hasExactKeys(binding, ['platformSupplierId', 'storeCode'])) {
      fail('INVALID_IDENTITY_MAP', 'identity map binding schema is invalid');
    }
    const storeCode = String(binding.storeCode ?? '');
    const supplierId = String(binding.platformSupplierId ?? '');
    if (
      !STORE_CODE.test(storeCode)
      || storeCode !== storeCode.trim().toUpperCase()
      || !SUPPLIER_ID.test(supplierId)
      || supplierId !== supplierId.trim()
      || byStoreCode.has(storeCode)
      || supplierIds.has(supplierId)
    ) {
      fail('INVALID_IDENTITY_MAP', 'identity map bindings must be exact and unique');
    }
    byStoreCode.set(storeCode, supplierId);
    supplierIds.add(supplierId);
  }
  return byStoreCode;
}

async function expectedSupplierIdForStore(identityMapFile, storeCode, candidateSupplierId) {
  const identityMap = parseIdentityMap(
    await parsePrivateJson(identityMapFile, 'INVALID_IDENTITY_MAP'),
  );
  const expectedSupplierId = identityMap.get(storeCode);
  if (!expectedSupplierId) {
    fail('IDENTITY_BINDING_NOT_FOUND', 'target store is absent from the identity map');
  }
  if (expectedSupplierId !== candidateSupplierId) {
    fail('IDENTITY_BINDING_MISMATCH', 'candidate supplier id does not match the identity map');
  }
  return expectedSupplierId;
}

async function expectedApplicationId(applicationFile) {
  const value = await parsePrivateJson(applicationFile, 'INVALID_APPLICATION_FILE');
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== 1
    || value.cooperationMode !== 'FULL_MANAGED'
    || !Array.isArray(value.applications)
  ) {
    fail('INVALID_APPLICATION_FILE', 'application credential file schema is invalid');
  }
  const matches = value.applications.filter(
    (application) => String(application?.storeCode || '').trim().toUpperCase() === 'DL',
  );
  if (matches.length !== 1) {
    fail('INVALID_APPLICATION_FILE', 'application credential file must contain one DL app');
  }
  const application = matches[0];
  const appId = cleanRequiredString(application.appId, {
    code: 'INVALID_APPLICATION_FILE',
    maximum: 256,
  });
  cleanRequiredString(application.appSecretKey, {
    code: 'INVALID_APPLICATION_FILE',
    maximum: 2048,
  });
  if (
    String(application.storeCode) !== 'DL'
    || appId !== appId.trim()
    || application.appSecretKey !== String(application.appSecretKey).trim()
  ) {
    fail('INVALID_APPLICATION_FILE', 'DL application credentials are not canonical');
  }
  return appId;
}

function selectReviewableStore(rawState, publicBatches, storeCode, supplierId) {
  const publicMatches = publicBatches.flatMap((batch) => batch.stores
    .filter((store) => (
      store.storeCode === storeCode
      && store.status === 'REVIEW_REQUIRED'
      && String(store.supplierId) === supplierId
    ))
    .map((store) => ({ batchId: batch.batchId, store })));
  if (publicMatches.length !== 1) {
    fail(
      publicMatches.length === 0 ? 'REVIEW_RECEIPT_NOT_FOUND' : 'AMBIGUOUS_REVIEW_RECEIPT',
      'exactly one reviewable authorization is required',
    );
  }

  const [{ batchId }] = publicMatches;
  const rawBatch = rawState.batches.find((batch) => batch.batchId === batchId);
  const rawStore = rawBatch?.stores?.find((store) => store.storeCode === storeCode);
  if (
    !rawStore
    || rawStore.status !== 'REVIEW_REQUIRED'
    || String(rawStore.supplierId) !== supplierId
    || !RECEIPT_FILE.test(String(rawStore.receiptFile || ''))
    || path.basename(rawStore.receiptFile) !== rawStore.receiptFile
    || typeof rawStore.authorizedAt !== 'string'
    || !/^[0-9a-f]{64}$/.test(String(rawStore.credentialFingerprint || ''))
  ) {
    fail('INVALID_REVIEW_STATE', 'review state and receipt reference do not agree');
  }
  return { batchId, rawStore };
}

async function resolveReceipt(directory, filename) {
  await requirePrivateDirectory(directory, 'RECEIPT_DIRECTORY_UNAVAILABLE');
  let canonicalDirectory;
  try {
    canonicalDirectory = await realpath(directory);
  } catch (error) {
    fail('RECEIPT_DIRECTORY_UNAVAILABLE', 'receipt directory is unavailable', { cause: error });
  }
  const candidate = path.join(canonicalDirectory, filename);
  const metadata = await requirePrivateRegularFile(candidate, 'INVALID_RECEIPT');
  let canonicalCandidate;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch (error) {
    fail('INVALID_RECEIPT', 'receipt cannot be resolved', { cause: error });
  }
  if (path.dirname(canonicalCandidate) !== canonicalDirectory || canonicalCandidate !== candidate) {
    fail('INVALID_RECEIPT', 'receipt must be a direct non-symlink child of its private directory');
  }
  return { file: canonicalCandidate, metadata };
}

function validateReceipt(receipt, {
  batchId,
  storeCode,
  supplierId,
  authorizedAt,
  credentialFingerprint,
  expectedAppId,
}) {
  if (
    !receipt
    || typeof receipt !== 'object'
    || Array.isArray(receipt)
    || receipt.schemaVersion !== 1
    || receipt.cooperationMode !== 'FULL_MANAGED'
    || receipt.status !== 'REVIEW_REQUIRED'
    || receipt.batchId !== batchId
    || receipt.storeCode !== storeCode
    || receipt.applicationStoreCode !== 'DL'
    || receipt.authorizedAt !== authorizedAt
    || String(receipt.identity?.supplierId) !== supplierId
  ) {
    fail('INVALID_RECEIPT', 'receipt identity does not match the review request');
  }
  const appId = cleanRequiredString(receipt.appId, { maximum: 256 });
  const openKeyId = cleanRequiredString(receipt.openKeyId, { maximum: 256 });
  const secretKey = cleanRequiredString(receipt.secretKey, { maximum: 2048 });
  if (sha256(`${appId}:${openKeyId}`) !== credentialFingerprint) {
    fail('INVALID_RECEIPT', 'receipt credential fingerprint does not match');
  }
  if (appId !== expectedAppId) {
    fail('APPLICATION_ID_MISMATCH', 'receipt app does not match the root-controlled DL app');
  }
  return Object.freeze({ appId, openKeyId, secretKey });
}

function updateOpenApiConfiguration(config, {
  storeCode,
  supplierId,
  credentials,
}) {
  if (
    !config
    || typeof config !== 'object'
    || Array.isArray(config)
    || !Array.isArray(config.stores)
  ) {
    fail('INVALID_OPENAPI_CONFIG', 'OpenAPI configuration is invalid');
  }
  const matches = config.stores
    .map((store, index) => ({ store, index }))
    .filter(({ store }) => store?.storeCode === storeCode);
  if (matches.length !== 1) {
    fail('INVALID_OPENAPI_CONFIG', 'target store must exist exactly once');
  }
  for (const store of config.stores) {
    if (store?.storeCode === storeCode) continue;
    if (
      String(store?.platformSupplierId || '').trim()
      && String(store.platformSupplierId).trim() === supplierId
    ) {
      fail(
        'PLATFORM_SUPPLIER_ID_ALREADY_BOUND',
        'supplier id is already bound to another store',
      );
    }
    if (
      String(store?.openKeyId || '').trim()
      && String(store.openKeyId).trim() === credentials.openKeyId
    ) {
      fail(
        'OPEN_KEY_ID_ALREADY_BOUND',
        'open key is already bound to another store',
      );
    }
  }
  const configuredAppIds = [...new Set(
    config.stores.map((store) => String(store?.appId || '').trim()).filter(Boolean),
  )];
  if (
    configuredAppIds.length > 1 ||
    (configuredAppIds.length === 1 && configuredAppIds[0] !== credentials.appId)
  ) {
    fail('APPLICATION_OWNER_MISMATCH', 'receipt app does not match the configured DL application');
  }
  const updated = structuredClone(config);
  const target = updated.stores[matches[0].index];
  Object.assign(target, {
    enabled: true,
    applicationStatus: 'approved',
    authorizationStatus: 'authorized',
    appId: credentials.appId,
    openKeyId: credentials.openKeyId,
    secretKey: credentials.secretKey,
    platformSupplierId: supplierId,
  });
  try {
    validateFullManagedConfig(updated);
  } catch (error) {
    fail('INVALID_OPENAPI_CONFIG', 'updated OpenAPI configuration failed validation', {
      cause: error,
    });
  }
  return updated;
}

async function verifyLiveStoreIdentity({
  openapiConfig,
  credentials,
  expectedSupplierId,
  fetchImpl,
  platform,
  cloudExecution,
}) {
  const client = new SheinOpenApiClient({
    baseUrl: openapiConfig.baseUrl,
    openKeyId: credentials.openKeyId,
    secretKey: credentials.secretKey,
    timeoutMs: openapiConfig.timeoutMs,
    allowFakeBaseUrl: openapiConfig.allowFakeBaseUrl === true,
    fetchImpl,
    platform,
    cloudExecution,
  });
  let response;
  try {
    response = await client.request(STORE_INFO_PATH, {
      method: 'POST',
      body: {},
    });
  } catch (error) {
    fail('LIVE_STORE_IDENTITY_QUERY_FAILED', 'live store identity query failed', {
      cause: error,
    });
  }
  try {
    return verifiedIdentity(
      { supplierId: expectedSupplierId, supplierBusinessMode: 'FULL_MANAGED' },
      response.data,
    );
  } catch (error) {
    fail('LIVE_STORE_IDENTITY_MISMATCH', 'live store identity does not match the identity map', {
      cause: error,
    });
  }
}

function backupName(file, now, randomBytes) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '');
  const suffix = randomBytes(6).toString('hex');
  return `${file}.backup-${stamp}-${suffix}`;
}

async function createBackup(file, metadata, now, randomBytes) {
  const backup = backupName(file, now, randomBytes);
  const permissionMode = metadata.mode & 0o777;
  try {
    await copyFile(file, backup, constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') {
      await chown(backup, metadata.uid, metadata.gid);
    }
    await chmod(backup, permissionMode);
  } catch (error) {
    await unlink(backup).catch(() => {});
    fail('BACKUP_FAILED', 'OpenAPI configuration backup failed', { cause: error });
  }
  return backup;
}

async function atomicWrite(file, contents, metadata) {
  const directory = path.dirname(file);
  const permissionMode = metadata.mode & 0o777;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, 'wx', permissionMode);
    await handle.writeFile(contents, 'utf8');
    if (process.platform !== 'win32') {
      await handle.chown(metadata.uid, metadata.gid);
    }
    await handle.chmod(permissionMode);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    fail('ATOMIC_WRITE_FAILED', 'private configuration update failed', { cause: error });
  }
}

async function restoreBackup(backup, destination, metadata) {
  const contents = await readFile(backup, 'utf8');
  await atomicWrite(destination, contents, metadata);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function isolateReceipt(receipt, randomBytes) {
  const isolatedFile = path.join(
    path.dirname(receipt.file),
    `.finalizing-${process.pid}-${randomBytes(16).toString('hex')}-${path.basename(receipt.file)}`,
  );
  try {
    await lstat(isolatedFile);
    fail('RECEIPT_ISOLATION_FAILED', 'receipt isolation destination already exists');
  } catch (error) {
    if (error instanceof FinalizationError) throw error;
    if (error?.code !== 'ENOENT') {
      fail('RECEIPT_ISOLATION_FAILED', 'receipt isolation destination cannot be inspected', {
        cause: error,
      });
    }
  }
  try {
    await rename(receipt.file, isolatedFile);
  } catch (error) {
    fail('RECEIPT_ISOLATION_FAILED', 'receipt could not be atomically isolated', {
      cause: error,
    });
  }
  const isolatedMetadata = await requirePrivateRegularFile(
    isolatedFile,
    'RECEIPT_ISOLATION_FAILED',
  );
  if (!sameFile(receipt.metadata, isolatedMetadata)) {
    fail('RECEIPT_ISOLATION_FAILED', 'isolated receipt identity changed');
  }
  return { file: isolatedFile, metadata: isolatedMetadata };
}

async function restoreIsolatedReceipt(isolatedReceipt, receiptFile) {
  try {
    await lstat(receiptFile);
    fail('RECEIPT_RESTORE_FAILED', 'receipt destination unexpectedly exists');
  } catch (error) {
    if (error instanceof FinalizationError) throw error;
    if (error?.code !== 'ENOENT') {
      fail('RECEIPT_RESTORE_FAILED', 'receipt destination cannot be inspected', {
        cause: error,
      });
    }
  }
  const isolatedMetadata = await requirePrivateRegularFile(
    isolatedReceipt.file,
    'RECEIPT_RESTORE_FAILED',
  );
  if (!sameFile(isolatedReceipt.metadata, isolatedMetadata)) {
    fail('RECEIPT_RESTORE_FAILED', 'isolated receipt identity changed');
  }
  try {
    await rename(isolatedReceipt.file, receiptFile);
  } catch (error) {
    fail('RECEIPT_RESTORE_FAILED', 'isolated receipt could not be restored', {
      cause: error,
    });
  }
}

async function deleteIsolatedReceipt(isolatedReceipt) {
  const isolatedMetadata = await requirePrivateRegularFile(
    isolatedReceipt.file,
    'RECEIPT_DISPOSAL_FAILED',
  );
  if (!sameFile(isolatedReceipt.metadata, isolatedMetadata)) {
    fail('RECEIPT_DISPOSAL_FAILED', 'isolated receipt identity changed');
  }
  try {
    await unlink(isolatedReceipt.file);
  } catch (error) {
    fail('RECEIPT_DISPOSAL_FAILED', 'isolated receipt could not be removed', {
      cause: error,
    });
  }
}

export async function finalizeAuthorizationReceipt({
  argv = process.argv.slice(2),
  environment = process.env,
  now = new Date(),
  randomBytes = crypto.randomBytes,
  lockOptions,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  cloudExecution = process.env.SHEIN_FM_CLOUD_EXECUTION,
  authorizationStoreFactory = (options) => new FileAuthorizationStore(options),
  disposeIsolatedReceipt = deleteIsolatedReceipt,
} = {}) {
  const args = parseArguments(argv, environment);
  return withOpenApiFinalizationLock(args.openapiConfig, async () => {
    await requirePrivateRegularFile(args.stateFile, 'INVALID_STATE_FILE');
    const authorizationStore = authorizationStoreFactory({ file: args.stateFile });
    if (
      !authorizationStore
      || typeof authorizationStore.listReviewBatches !== 'function'
      || typeof authorizationStore.approveStore !== 'function'
      || typeof authorizationStore.rollbackStoreApproval !== 'function'
    ) {
      fail('INVALID_AUTHORIZATION_STORE', 'authorization store is incompatible');
    }
    const publicBatches = await authorizationStore.listReviewBatches(now);
    const rawState = await parsePrivateJson(args.stateFile, 'INVALID_STATE_FILE');
    const { batchId, rawStore } = selectReviewableStore(
      rawState,
      publicBatches,
      args.storeCode,
      args.supplierId,
    );
    const receiptFile = await resolveReceipt(args.receiptDirectory, rawStore.receiptFile);
    const receipt = await parsePrivateJson(receiptFile.file, 'INVALID_RECEIPT');
    const applicationId = await expectedApplicationId(args.applicationFile);
    const credentials = validateReceipt(receipt, {
      batchId,
      storeCode: args.storeCode,
      supplierId: args.supplierId,
      authorizedAt: rawStore.authorizedAt,
      credentialFingerprint: rawStore.credentialFingerprint,
      expectedAppId: applicationId,
    });
    const expectedSupplierId = await expectedSupplierIdForStore(
      args.identityMap,
      args.storeCode,
      args.supplierId,
    );

    const openapiMetadata = await requirePrivateRegularFile(
      args.openapiConfig,
      'INVALID_OPENAPI_CONFIG',
    );
    const openapiConfig = await parsePrivateJson(args.openapiConfig, 'INVALID_OPENAPI_CONFIG');
    const updatedConfig = updateOpenApiConfiguration(openapiConfig, {
      storeCode: args.storeCode,
      supplierId: args.supplierId,
      credentials,
    });
    await verifyLiveStoreIdentity({
      openapiConfig,
      credentials,
      expectedSupplierId,
      fetchImpl,
      platform,
      cloudExecution,
    });

    const isolatedReceipt = await isolateReceipt(receiptFile, randomBytes);
    let backup = null;
    let configWritten = false;
    let approvalCommitted = false;
    let approved;
    try {
      backup = await createBackup(args.openapiConfig, openapiMetadata, now, randomBytes);
      await atomicWrite(
        args.openapiConfig,
        `${JSON.stringify(updatedConfig, null, 2)}\n`,
        openapiMetadata,
      );
      configWritten = true;
      approved = await authorizationStore.approveStore({
        batchId,
        storeCode: args.storeCode,
        supplierId: args.supplierId,
        reviewedAt: now,
      });
      approvalCommitted = true;
      await disposeIsolatedReceipt(isolatedReceipt);
    } catch (error) {
      const rollbackErrors = [];
      if (approvalCommitted) {
        try {
          await authorizationStore.rollbackStoreApproval({
            batchId,
            storeCode: args.storeCode,
            supplierId: args.supplierId,
            reviewedAt: now,
            receiptFile: rawStore.receiptFile,
            credentialFingerprint: rawStore.credentialFingerprint,
          });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (configWritten && backup) {
        try {
          await restoreBackup(backup, args.openapiConfig, openapiMetadata);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      try {
        await restoreIsolatedReceipt(isolatedReceipt, receiptFile.file);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        fail('FINALIZATION_ROLLBACK_FAILED', 'finalization failed and rollback was incomplete', {
          cause: new AggregateError([error, ...rollbackErrors]),
        });
      }
      fail('FINALIZATION_TRANSACTION_FAILED', 'finalization failed and was fully rolled back', {
        cause: error,
      });
    }
    const approvedStore = approved.stores.find((store) => store.storeCode === args.storeCode);
    return {
      ok: true,
      storeCode: args.storeCode,
      supplierId: args.supplierId,
      status: approvedStore?.status === 'APPROVED' ? 'APPROVED' : 'UNKNOWN',
      reviewedAt: approvedStore?.reviewedAt ?? now.toISOString(),
      backupCreated: true,
    };
  }, lockOptions);
}

function safeFailure(error) {
  const value = String(error?.code || '');
  const errorCode = /^[A-Z0-9_]{3,80}$/.test(value) ? value : 'FINALIZATION_FAILED';
  return { ok: false, errorCode };
}

export async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  cloudExecution = process.env.SHEIN_FM_CLOUD_EXECUTION,
} = {}) {
  try {
    const result = await finalizeAuthorizationReceipt({
      argv,
      environment,
      fetchImpl,
      platform,
      cloudExecution,
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify(safeFailure(error))}\n`);
    return 1;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exitCode = await main();
}
