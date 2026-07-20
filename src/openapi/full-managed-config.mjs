import { readFile } from 'node:fs/promises';
import path from 'node:path';

const APPLICATION_STATUSES = new Set(['approved', 'pending', 'rejected', 'unknown']);
const AUTHORIZATION_STATUSES = new Set(['authorized', 'pending', 'not_started', 'unknown']);

export class FullManagedConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FullManagedConfigError';
    this.code = code;
    this.details = details;
  }
}

export function fullManagedStoreCallBlock(store) {
  if (!store?.enabled) return 'STORE_DISABLED';
  if (store.applicationStatus !== 'approved') return 'APPLICATION_NOT_APPROVED';
  if (store.authorizationStatus !== 'authorized') return 'STORE_NOT_AUTHORIZED';
  if (!store.appId || !store.openKeyId || !store.secretKey) return 'CREDENTIALS_MISSING';
  return null;
}

function fail(code, message, details = {}) {
  throw new FullManagedConfigError(code, message, details);
}

function record(value, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_CONFIG', `${location} must be an object`, { location });
  }
  return value;
}

function string(value, location, { required = false, pattern, maximum = 256 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('MISSING_CONFIG_VALUE', `${location} is required`, { location });
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    fail('INVALID_CONFIG', `${location} must be a non-empty string`, { location });
  }
  const normalized = value.trim();
  if (normalized.length > maximum || (pattern && !pattern.test(normalized))) {
    fail('INVALID_CONFIG', `${location} has an invalid value`, { location });
  }
  return normalized;
}

function status(value, location, allowed, fallback = 'unknown') {
  const normalized = string(value, location) ?? fallback;
  if (!allowed.has(normalized)) {
    fail('INVALID_CONFIG', `${location} has an unsupported status`, { location });
  }
  return normalized;
}

function positiveInteger(value, location, fallback) {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    fail('INVALID_CONFIG', `${location} must be a positive integer`, { location });
  }
  return normalized;
}

function validateBaseUrl(value) {
  const baseUrl = string(value, 'baseUrl', { required: true, maximum: 512 });
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    fail('INVALID_CONFIG', 'baseUrl must be an absolute HTTP(S) URL', { location: 'baseUrl' });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail('INVALID_CONFIG', 'baseUrl must be a credential-free HTTP(S) origin', { location: 'baseUrl' });
  }
  return url.toString().replace(/\/$/, '');
}

/** Validate an isolated full-managed configuration without mutating it. */
export function validateFullManagedConfig(input) {
  const config = record(input, 'config');
  if (config.schemaVersion !== 1) {
    fail('INVALID_CONFIG', 'schemaVersion must be 1', { location: 'schemaVersion' });
  }
  if (config.cooperationMode !== 'FULL_MANAGED') {
    fail('INVALID_CONFIG', 'cooperationMode must be FULL_MANAGED', { location: 'cooperationMode' });
  }
  if (!Array.isArray(config.stores) || config.stores.length === 0) {
    fail('INVALID_CONFIG', 'stores must be a non-empty array', { location: 'stores' });
  }

  const seen = new Set();
  const stores = config.stores.map((rawStore, index) => {
    const location = `stores[${index}]`;
    const store = record(rawStore, location);
    const storeCode = string(store.storeCode, `${location}.storeCode`, {
      required: true,
      pattern: /^[A-Z0-9_-]+$/,
      maximum: 24,
    });
    if (seen.has(storeCode)) {
      fail('DUPLICATE_STORE', `duplicate storeCode ${storeCode}`, { location: `${location}.storeCode` });
    }
    seen.add(storeCode);

    if (typeof store.enabled !== 'boolean') {
      fail('INVALID_CONFIG', `${location}.enabled must be boolean`, { location: `${location}.enabled` });
    }

    const appId = string(store.appId, `${location}.appId`, { required: store.enabled });
    const openKeyId = string(store.openKeyId, `${location}.openKeyId`, { required: store.enabled });
    const secretKey = string(store.secretKey, `${location}.secretKey`, {
      required: store.enabled,
      maximum: 2048,
    });

    return Object.freeze({
      storeCode,
      storeName: string(store.storeName, `${location}.storeName`, { maximum: 80 }) ?? storeCode,
      legalEntityName: string(store.legalEntityName, `${location}.legalEntityName`, { maximum: 160 }),
      platformShopId: string(store.platformShopId, `${location}.platformShopId`),
      enabled: store.enabled,
      appId,
      openKeyId,
      secretKey,
      applicationStatus: status(
        store.applicationStatus,
        `${location}.applicationStatus`,
        APPLICATION_STATUSES,
      ),
      authorizationStatus: status(
        store.authorizationStatus,
        `${location}.authorizationStatus`,
        AUTHORIZATION_STATUSES,
      ),
    });
  });

  return Object.freeze({
    schemaVersion: 1,
    cooperationMode: 'FULL_MANAGED',
    baseUrl: validateBaseUrl(config.baseUrl),
    allowFakeBaseUrl: config.allowFakeBaseUrl === true,
    timeoutMs: positiveInteger(config.timeoutMs, 'timeoutMs', 20_000),
    pageSize: Math.min(100, positiveInteger(config.pageSize, 'pageSize', 100)),
    permissionPackageCode: string(config.permissionPackageCode, 'permissionPackageCode', {
      required: true,
      maximum: 80,
    }),
    stores: Object.freeze(stores),
  });
}

export async function loadFullManagedConfig(
  filePath = process.env.FULL_BI_OPENAPI_CONFIG ?? process.env.FULL_BI_OPENAPI_CONFIG_FILE,
) {
  if (!filePath) {
    fail(
      'MISSING_CONFIG_PATH',
      'Set FULL_BI_OPENAPI_CONFIG to an ignored *.secret.json or *.local.json file.',
    );
  }
  const resolved = path.resolve(filePath);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8'));
  } catch (error) {
    fail('CONFIG_READ_FAILED', `Unable to read full-managed OpenAPI configuration: ${error.message}`, {
      file: resolved,
    });
  }
  return validateFullManagedConfig(parsed);
}

/** Safe for logs: intentionally excludes every credential and platform identifier. */
export function summarizeFullManagedConfig(config) {
  const validated = validateFullManagedConfig(config);
  return {
    cooperationMode: validated.cooperationMode,
    baseUrlHost: new URL(validated.baseUrl).host,
    storeCount: validated.stores.length,
    enabledStoreCount: validated.stores.filter(({ enabled }) => enabled).length,
    stores: validated.stores.map(({ storeCode, enabled, applicationStatus, authorizationStatus }) => ({
      storeCode,
      enabled,
      applicationStatus,
      authorizationStatus,
      credentialsConfigured: enabled,
    })),
  };
}
