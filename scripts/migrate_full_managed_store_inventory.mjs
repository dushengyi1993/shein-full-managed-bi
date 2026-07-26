#!/usr/bin/env node

import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  chmod,
  chown,
  constants,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateFullManagedConfig } from '../src/openapi/full-managed-config.mjs';

const CONFIRMATION = 'SHEIN_FULL_INVENTORY_MIGRATE_24';
const EXPECTED_STORE_COUNT = 24;
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE = path.resolve(
  SCRIPT_DIRECTORY,
  '../config/shein_openapi.example.json',
);

class StoreInventoryMigrationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'StoreInventoryMigrationError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new StoreInventoryMigrationError(code, message, options);
}

function parseArguments(argv, environment) {
  const values = new Map();
  const allowed = new Set(['--openapi-config', '--template', '--confirm']);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || values.has(name)) {
      fail('INVALID_ARGUMENTS', 'arguments are incomplete or duplicated');
    }
    values.set(name, value);
  }

  const openapiConfig = String(
    values.get('--openapi-config')
      || environment.FULL_BI_OPENAPI_CONFIG_FILE
      || environment.FULL_BI_OPENAPI_CONFIG
      || '',
  ).trim();
  const template = String(values.get('--template') || DEFAULT_TEMPLATE).trim();
  const suppliedConfirmation = values.get('--confirm');

  if (!openapiConfig) {
    fail('MISSING_CONFIGURATION', 'OpenAPI configuration path is required');
  }
  if (!template) {
    fail('MISSING_TEMPLATE', 'store inventory template path is required');
  }
  if (suppliedConfirmation !== undefined && suppliedConfirmation !== CONFIRMATION) {
    fail('CONFIRMATION_REQUIRED', 'explicit confirmation is invalid');
  }

  return Object.freeze({
    openapiConfig: path.resolve(openapiConfig),
    template: path.resolve(template),
    apply: suppliedConfirmation === CONFIRMATION,
  });
}

async function requireRegularFile(file, code) {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    fail(code, 'required file is unavailable', { cause: error });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(code, 'required path is not a regular file');
  }
  return metadata;
}

async function parseJsonFile(file, code) {
  await requireRegularFile(file, code);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail(code, 'required JSON file is invalid', { cause: error });
  }
}

function hasCredentialMaterial(store) {
  return ['appId', 'openKeyId', 'secretKey']
    .some((field) => store?.[field] !== undefined
      && store[field] !== null
      && store[field] !== '');
}

function requireUncredentialedCurrentConfig(config) {
  if (config.stores.some(hasCredentialMaterial)) {
    fail(
      'EXISTING_CREDENTIALS',
      'migration refuses to discard an existing store credential',
    );
  }
}

function cleanIdentity(value, field, maximum) {
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || value.trim().length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail('INVALID_TEMPLATE_IDENTITY', `${field} is required in the inventory template`);
  }
  return value.trim();
}

function buildStoreInventory(template) {
  let validated;
  try {
    validated = validateFullManagedConfig(template);
  } catch (error) {
    fail('INVALID_TEMPLATE', 'inventory template failed validation', { cause: error });
  }
  if (validated.stores.length !== EXPECTED_STORE_COUNT) {
    fail('INVALID_STORE_COUNT', 'inventory template must contain exactly 24 stores');
  }

  return template.stores.map((store, index) => ({
    storeCode: cleanIdentity(store.storeCode, `stores[${index}].storeCode`, 24),
    storeName: cleanIdentity(store.storeName, `stores[${index}].storeName`, 80),
    enabled: false,
    applicationStatus: 'approved',
    authorizationStatus: 'not_started',
    appId: null,
    openKeyId: null,
    secretKey: null,
  }));
}

function buildMigratedConfiguration(current, template) {
  let validatedCurrent;
  try {
    validatedCurrent = validateFullManagedConfig(current);
  } catch (error) {
    fail('INVALID_OPENAPI_CONFIG', 'current OpenAPI configuration failed validation', {
      cause: error,
    });
  }
  requireUncredentialedCurrentConfig(current);

  const stores = buildStoreInventory(template);
  const migrated = {
    ...structuredClone(current),
    stores,
  };
  try {
    validateFullManagedConfig(migrated);
  } catch (error) {
    fail('INVALID_MIGRATION_RESULT', 'migrated configuration failed validation', {
      cause: error,
    });
  }
  return {
    migrated,
    previousStoreCount: validatedCurrent.stores.length,
  };
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
    fail('ATOMIC_WRITE_FAILED', 'OpenAPI configuration replacement failed', { cause: error });
  }
}

function safeSummary({ apply, previousStoreCount, backupCreated }) {
  return {
    ok: true,
    mode: apply ? 'applied' : 'dry-run',
    previousStoreCount,
    storeCount: EXPECTED_STORE_COUNT,
    enabledStoreCount: 0,
    credentialsConfigured: 0,
    applicationStatus: 'approved',
    authorizationStatus: 'not_started',
    backupCreated,
  };
}

export async function migrateFullManagedStoreInventory({
  argv = process.argv.slice(2),
  environment = process.env,
  now = new Date(),
  randomBytes = crypto.randomBytes,
} = {}) {
  const args = parseArguments(argv, environment);
  const targetMetadata = await requireRegularFile(
    args.openapiConfig,
    'INVALID_OPENAPI_CONFIG',
  );
  const [current, template] = await Promise.all([
    parseJsonFile(args.openapiConfig, 'INVALID_OPENAPI_CONFIG'),
    parseJsonFile(args.template, 'INVALID_TEMPLATE'),
  ]);
  const { migrated, previousStoreCount } = buildMigratedConfiguration(current, template);

  if (!args.apply) {
    return safeSummary({
      apply: false,
      previousStoreCount,
      backupCreated: false,
    });
  }

  await createBackup(args.openapiConfig, targetMetadata, now, randomBytes);
  await atomicWrite(
    args.openapiConfig,
    `${JSON.stringify(migrated, null, 2)}\n`,
    targetMetadata,
  );
  return safeSummary({
    apply: true,
    previousStoreCount,
    backupCreated: true,
  });
}

function safeFailure(error) {
  const value = String(error?.code || '');
  const errorCode = /^[A-Z0-9_]{3,80}$/.test(value)
    ? value
    : 'STORE_INVENTORY_MIGRATION_FAILED';
  return { ok: false, errorCode };
}

export async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const result = await migrateFullManagedStoreInventory({ argv, environment });
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
