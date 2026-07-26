import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createFullManagedWebhookCredentialRegistry,
  loadFullManagedWebhookCredentialRegistry,
} from '../../src/webhook/credentials.mjs';

function config() {
  return {
    cooperationMode: 'FULL_MANAGED',
    stores: [
      {
        storeCode: 'DL',
        enabled: true,
        appId: 'shared-app',
        openKeyId: 'open-dl',
        secretKey: 'shared-secret',
      },
      {
        storeCode: 'CX4412',
        enabled: true,
        appId: 'shared-app',
        openKeyId: 'open-cx',
        secretKey: 'shared-secret',
      },
    ],
  };
}

function applicationConfig(overrides = {}) {
  return {
    cooperationMode: 'FULL_MANAGED',
    applications: [{
      storeCode: 'DL',
      appId: 'shared-app',
      appSecretKey: 'shared-app-secret',
    }],
    ...overrides,
  };
}

test('one app maps each known OpenKey to exactly one store', () => {
  const input = config();
  input.stores[0].secretKey = 'store-secret-dl';
  input.stores[1].secretKey = 'different-store-secret-cx';
  const registry = createFullManagedWebhookCredentialRegistry(
    input,
    applicationConfig(),
  );
  const identity = registry.resolveIngress({
    'x-lt-appid': 'shared-app',
    'x-lt-openkeyid': 'open-cx',
  });
  assert.equal(identity.storeCode, 'CX4412');
  assert.equal(identity.deliveryScope, 'STORE');
  assert.equal(identity.appScopedOnly, false);
  assert.equal(identity.appSecretKey, 'shared-app-secret');
  assert.notEqual(identity.appSecretKey, input.stores[1].secretKey);
  assert.deepEqual(registry.summary, {
    appCount: 1,
    enabledStoreCount: 2,
    sharedApp: true,
  });
  assert.equal(JSON.stringify(registry.summary).includes('shared-app'), false);
});

test('unknown OpenKey under a signed known app is appScopedOnly and never guesses a store', () => {
  const registry = createFullManagedWebhookCredentialRegistry(
    config(),
    applicationConfig(),
  );
  const identity = registry.resolveIngress({
    'x-lt-appid': 'shared-app',
    'x-lt-openkeyid': 'synthetic-platform-test-key',
  });
  assert.equal(identity.storeCode, null);
  assert.equal(identity.deliveryScope, 'APP_ONLY');
  assert.equal(identity.appScopedOnly, true);
});

test('unknown apps and cross-app OpenKey mismatches fail closed', () => {
  const input = config();
  input.stores.push({
    storeCode: 'NM7397',
    enabled: true,
    appId: 'another-app',
    openKeyId: 'open-nm',
    secretKey: 'another-secret',
  });
  const applications = applicationConfig();
  applications.applications.push({
    storeCode: 'NM',
    appId: 'another-app',
    appSecretKey: 'another-app-secret',
  });
  const registry = createFullManagedWebhookCredentialRegistry(input, applications);
  assert.throws(
    () => registry.resolveIngress({
      'x-lt-appid': 'unknown-app',
      'x-lt-openkeyid': 'open-dl',
    }),
    (error) => error.code === 'WEBHOOK_IDENTITY_UNKNOWN',
  );
  assert.throws(
    () => registry.resolveIngress({
      'x-lt-appid': 'another-app',
      'x-lt-openkeyid': 'open-dl',
    }),
    (error) => error.code === 'WEBHOOK_IDENTITY_MISMATCH',
  );
});

test('duplicate OpenKey configuration is rejected before serving traffic', () => {
  const input = config();
  input.stores[1].openKeyId = input.stores[0].openKeyId;
  assert.throws(
    () => createFullManagedWebhookCredentialRegistry(input),
    /FULL_MANAGED webhook application configuration/,
  );
  assert.throws(
    () => createFullManagedWebhookCredentialRegistry(input, applicationConfig()),
    /does not map uniquely/,
  );
});

test('loads store authorization and webhook application secrets from separate files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fm-webhook-credentials-'));
  const storeFile = path.join(directory, 'openapi.secret.json');
  const applicationFile = path.join(directory, 'application.secret.json');
  const stores = config();
  stores.stores[0].secretKey = 'ordinary-openapi-store-secret';
  try {
    await Promise.all([
      writeFile(storeFile, JSON.stringify(stores), 'utf8'),
      writeFile(applicationFile, JSON.stringify(applicationConfig()), 'utf8'),
    ]);
    const registry = await loadFullManagedWebhookCredentialRegistry({
      storeConfigFile: storeFile,
      applicationFile,
    });
    const identity = registry.resolveIngress({
      'x-lt-appid': 'shared-app',
      'x-lt-openkeyid': 'open-dl',
    });
    assert.equal(identity.appSecretKey, 'shared-app-secret');
    assert.notEqual(identity.appSecretKey, stores.stores[0].secretKey);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
