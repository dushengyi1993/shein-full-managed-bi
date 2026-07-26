import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256Hex } from './crypto.mjs';

function requiredText(value, label, maximum = 2048) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required.`);
  if (result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}

function normalizedStoreCode(value) {
  const storeCode = requiredText(value, 'storeCode').toUpperCase();
  if (!/^[A-Z0-9_-]{1,32}$/.test(storeCode)) throw new Error('storeCode is invalid.');
  return storeCode;
}

function addUnique(map, key, value, label) {
  if (!map.has(key)) {
    map.set(key, value);
    return;
  }
  if (map.get(key) !== value) throw new Error(`${label} does not map uniquely.`);
}

/**
 * Build an in-memory credential registry from two independently controlled
 * secret files:
 *   - storeConfig: each authorized store's appId + openKeyId
 *   - applicationConfig: the owning application's appSecretKey
 *
 * A store's `secretKey` signs ordinary OpenAPI requests and is deliberately
 * ignored here. Webhook verification/decryption uses the application secret.
 * The registry exposes only hashes in durable receipt inputs.
 */
export function createFullManagedWebhookCredentialRegistry(
  storeConfig,
  applicationConfig,
) {
  if (
    !storeConfig
    || storeConfig.cooperationMode !== 'FULL_MANAGED'
    || !Array.isArray(storeConfig.stores)
  ) {
    throw new Error('A FULL_MANAGED store configuration is required.');
  }
  if (
    !applicationConfig
    || applicationConfig.cooperationMode !== 'FULL_MANAGED'
    || !Array.isArray(applicationConfig.applications)
    || !applicationConfig.applications.length
  ) {
    throw new Error('A FULL_MANAGED webhook application configuration is required.');
  }
  const appsById = new Map();
  const appsByHash = new Map();
  const storesByOpenKey = new Map();
  const storesByOpenKeyHash = new Map();
  const storesByCode = new Map();
  let enabledStoreCount = 0;

  for (const row of applicationConfig.applications) {
    const appId = requiredText(row?.appId, 'application.appId', 256);
    const appSecretKey = requiredText(
      row?.appSecretKey,
      'application.appSecretKey',
    );
    const appKeyHash = sha256Hex(appId);
    const existingApp = appsById.get(appId);
    if (existingApp) {
      throw new Error(
        existingApp.appSecretKey === appSecretKey
          ? 'Webhook application appears more than once.'
          : 'One app id has conflicting webhook secrets.',
      );
    }
    const app = {
      appId,
      appSecretKey,
      appKeyHash,
      storeCodes: new Set(),
    };
    appsById.set(appId, app);
    addUnique(appsByHash, appKeyHash, app, 'app key hash');
  }

  for (const row of storeConfig.stores) {
    if (row?.enabled === false) continue;
    const storeCode = normalizedStoreCode(row?.storeCode);
    if (
      row?.applicationStatus !== undefined
      && row.applicationStatus !== 'approved'
    ) {
      throw new Error(`Enabled store ${storeCode} has no approved application.`);
    }
    if (
      row?.authorizationStatus !== undefined
      && row.authorizationStatus !== 'authorized'
    ) {
      throw new Error(`Enabled store ${storeCode} is not authorized.`);
    }
    const appId = requiredText(row?.appId, `${storeCode}.appId`, 256);
    const openKeyId = requiredText(row?.openKeyId, `${storeCode}.openKeyId`, 512);
    const app = appsById.get(appId);
    if (!app) {
      throw new Error(`Store ${storeCode} references an unknown webhook application.`);
    }
    if (storesByCode.has(storeCode)) {
      throw new Error(`Store ${storeCode} appears more than once.`);
    }
    app.storeCodes.add(storeCode);
    const appKeyHash = app.appKeyHash;
    const openKeyHash = sha256Hex(openKeyId);
    const store = Object.freeze({
      storeCode,
      appId,
      appKeyHash,
      openKeyId,
      openKeyHash,
    });
    storesByCode.set(storeCode, store);
    addUnique(storesByOpenKey, openKeyId, store, 'openKeyId');
    addUnique(storesByOpenKeyHash, openKeyHash, store, 'openKey hash');
    enabledStoreCount += 1;
  }
  if (!appsById.size || !enabledStoreCount) {
    throw new Error('No enabled full-managed store has complete webhook credentials.');
  }
  for (const app of appsById.values()) {
    if (!app.storeCodes.size) {
      throw new Error('Webhook application has no enabled authorized store.');
    }
  }

  function resolveIngress(headers = {}) {
    const appId = String(headers['x-lt-appid'] ?? '').trim();
    const openKeyId = String(headers['x-lt-openkeyid'] ?? '').trim();
    const app = appId ? appsById.get(appId) : null;
    const store = openKeyId ? storesByOpenKey.get(openKeyId) : null;
    if (appId && !app) throw Object.assign(new Error('Unknown webhook application.'), {
      code: 'WEBHOOK_IDENTITY_UNKNOWN',
    });
    if (!appId && !store) throw Object.assign(new Error('Unknown webhook identity.'), {
      code: 'WEBHOOK_IDENTITY_UNKNOWN',
    });
    const effectiveApp = app ?? appsById.get(store.appId);
    if (!effectiveApp) throw Object.assign(new Error('Webhook application is unavailable.'), {
      code: 'WEBHOOK_IDENTITY_UNKNOWN',
    });
    if (store && store.appId !== effectiveApp.appId) {
      throw Object.assign(new Error('Webhook app and OpenKey do not match.'), {
        code: 'WEBHOOK_IDENTITY_MISMATCH',
      });
    }

    // A known app with an unknown OpenKey is SHEIN's app-level subscription
    // test. It is accepted only as APP_ONLY and is never assigned to a store.
    const appScopedOnly = !store;
    return Object.freeze({
      appId: effectiveApp.appId,
      appSecretKey: effectiveApp.appSecretKey,
      appKeyHash: effectiveApp.appKeyHash,
      openKeyId,
      openKeyHash: openKeyId ? sha256Hex(openKeyId) : '',
      storeCode: store?.storeCode ?? null,
      deliveryScope: appScopedOnly ? 'APP_ONLY' : 'STORE',
      appScopedOnly,
    });
  }

  function resolveStored({ appKeyHash, openKeyHash, deliveryScope, storeCode }) {
    const app = appsByHash.get(requiredText(appKeyHash, 'appKeyHash'));
    if (!app) throw Object.assign(new Error('Stored webhook application is no longer configured.'), {
      code: 'WEBHOOK_IDENTITY_DRIFT',
    });
    if (deliveryScope === 'APP_ONLY') {
      return Object.freeze({
        appSecretKey: app.appSecretKey,
        appKeyHash: app.appKeyHash,
        storeCode: null,
        appScopedOnly: true,
      });
    }
    const store = storesByOpenKeyHash.get(requiredText(openKeyHash, 'openKeyHash'));
    if (!store || store.appId !== app.appId || store.storeCode !== storeCode) {
      throw Object.assign(new Error('Stored webhook store identity no longer matches configuration.'), {
        code: 'WEBHOOK_IDENTITY_DRIFT',
      });
    }
    return Object.freeze({
      appSecretKey: app.appSecretKey,
      appKeyHash: app.appKeyHash,
      storeCode: store.storeCode,
      appScopedOnly: false,
    });
  }

  return Object.freeze({
    resolveIngress,
    resolveStored,
    summary: Object.freeze({
      appCount: appsById.size,
      enabledStoreCount,
      sharedApp: appsById.size === 1,
    }),
  });
}

export async function loadFullManagedWebhookCredentialRegistry(
  {
    storeConfigFile = process.env.FULL_BI_OPENAPI_CONFIG_FILE
      ?? process.env.FULL_BI_OPENAPI_CONFIG,
    applicationFile = process.env.FULL_BI_WEBHOOK_APPLICATION_FILE,
  } = {},
) {
  if (!storeConfigFile) throw new Error('FULL_BI_OPENAPI_CONFIG_FILE is required.');
  if (!applicationFile) throw new Error('FULL_BI_WEBHOOK_APPLICATION_FILE is required.');
  const [storeConfig, applicationConfig] = await Promise.all([
    readFile(path.resolve(storeConfigFile), 'utf8').then(JSON.parse),
    readFile(path.resolve(applicationFile), 'utf8').then(JSON.parse),
  ]);
  return createFullManagedWebhookCredentialRegistry(
    storeConfig,
    applicationConfig,
  );
}
