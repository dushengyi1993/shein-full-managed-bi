import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FullManagedConfigError,
  fullManagedStoreCallBlock,
  loadFullManagedConfig,
  summarizeFullManagedConfig,
  validateFullManagedConfig,
} from '../../src/openapi/full-managed-config.mjs';

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    cooperationMode: 'FULL_MANAGED',
    baseUrl: 'https://openapi.sheincorp.com',
    permissionPackageCode: 'SALES',
    stores: [{
      storeCode: 'DL',
      enabled: true,
      appId: 'app-private',
      openKeyId: 'open-private',
      secretKey: 'secret-private',
      applicationStatus: 'approved',
      authorizationStatus: 'authorized',
    }],
    ...overrides,
  };
}

test('validates isolated full-managed app and store credentials', () => {
  const validated = validateFullManagedConfig(config());
  assert.equal(validated.cooperationMode, 'FULL_MANAGED');
  assert.equal(validated.stores[0].openKeyId, 'open-private');
  assert.equal(validated.timeoutMs, 20_000);
  assert.equal(validated.pageSize, 100);
});

test('permits real store calls only after approval and store authorization agree', () => {
  const approved = validateFullManagedConfig(config()).stores[0];
  assert.equal(fullManagedStoreCallBlock(approved), null);
  assert.equal(fullManagedStoreCallBlock({ ...approved, enabled: false }), 'STORE_DISABLED');
  assert.equal(
    fullManagedStoreCallBlock({ ...approved, applicationStatus: 'pending' }),
    'APPLICATION_NOT_APPROVED',
  );
  assert.equal(
    fullManagedStoreCallBlock({ ...approved, authorizationStatus: 'pending' }),
    'STORE_NOT_AUTHORIZED',
  );
});

test('requires every enabled store to have app, open key and secret key', () => {
  for (const field of ['appId', 'openKeyId', 'secretKey']) {
    const input = config();
    delete input.stores[0][field];
    assert.throws(
      () => validateFullManagedConfig(input),
      (error) => error instanceof FullManagedConfigError && error.code === 'MISSING_CONFIG_VALUE',
    );
  }
});

test('rejects semi-managed mode and duplicate store identities', () => {
  assert.throws(
    () => validateFullManagedConfig(config({ cooperationMode: 'SEMI_MANAGED' })),
    /FULL_MANAGED/,
  );
  const input = config();
  input.stores.push({ ...input.stores[0] });
  assert.throws(
    () => validateFullManagedConfig(input),
    (error) => error.code === 'DUPLICATE_STORE',
  );
});

test('safe configuration summary never serializes a credential or platform shop id', () => {
  const input = config();
  input.stores[0].platformShopId = 'shop-private';
  const serialized = JSON.stringify(summarizeFullManagedConfig(input));
  for (const secret of ['app-private', 'open-private', 'secret-private', 'shop-private']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(serialized, /"credentialsConfigured":true/);
});

test('loads the systemd-compatible FULL_BI_OPENAPI_CONFIG_FILE alias', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fm-config-'));
  const file = path.join(directory, 'openapi.secret.json');
  const previousPrimary = process.env.FULL_BI_OPENAPI_CONFIG;
  const previousAlias = process.env.FULL_BI_OPENAPI_CONFIG_FILE;
  try {
    await writeFile(file, JSON.stringify(config()), 'utf8');
    delete process.env.FULL_BI_OPENAPI_CONFIG;
    process.env.FULL_BI_OPENAPI_CONFIG_FILE = file;
    assert.equal((await loadFullManagedConfig()).stores[0].storeCode, 'DL');
  } finally {
    if (previousPrimary === undefined) delete process.env.FULL_BI_OPENAPI_CONFIG;
    else process.env.FULL_BI_OPENAPI_CONFIG = previousPrimary;
    if (previousAlias === undefined) delete process.env.FULL_BI_OPENAPI_CONFIG_FILE;
    else process.env.FULL_BI_OPENAPI_CONFIG_FILE = previousAlias;
    await rm(directory, { recursive: true, force: true });
  }
});
