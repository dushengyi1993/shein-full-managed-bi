import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  main,
  migrateFullManagedStoreInventory,
} from '../../scripts/migrate_full_managed_store_inventory.mjs';

const NOW = new Date('2026-07-26T08:09:10.000Z');
const CONFIRMATION = 'SHEIN_FULL_INVENTORY_MIGRATE_24';

function baseConfiguration(stores) {
  return {
    schemaVersion: 1,
    cooperationMode: 'FULL_MANAGED',
    baseUrl: 'https://openapi.sheincorp.com',
    allowFakeBaseUrl: false,
    timeoutMs: 37_000,
    pageSize: 73,
    permissionPackageCode: 'FULL_MANAGED_SKU_SALES',
    deploymentSpecific: {
      preserve: true,
      callbackOrigin: 'https://fm.example.test',
    },
    stores,
  };
}

function currentConfiguration(overrides = {}) {
  return baseConfiguration([{
    storeCode: 'OLD1',
    storeName: 'old store one',
    legalEntityName: 'old entity one',
    enabled: false,
    applicationStatus: 'approved',
    authorizationStatus: 'not_started',
    appId: null,
    openKeyId: null,
    secretKey: null,
    legacyField: 'discard with legacy inventory',
  }, {
    storeCode: 'OLD2',
    storeName: 'old store two',
    legalEntityName: 'old entity two',
    enabled: false,
    applicationStatus: 'pending',
    authorizationStatus: 'unknown',
    appId: null,
    openKeyId: null,
    secretKey: null,
    ...overrides,
  }]);
}

function inventoryTemplate() {
  return baseConfiguration(Array.from({ length: 24 }, (_, index) => {
    const suffix = String(index + 1).padStart(4, '0');
    return {
      storeCode: `T${suffix}`,
      storeName: `店铺账号 ${suffix}`,
      enabled: false,
      applicationStatus: 'approved',
      authorizationStatus: 'not_started',
      appId: null,
      openKeyId: null,
      secretKey: null,
      ignoredTemplateField: 'do-not-copy',
    };
  }));
}

async function writeJson(file, value, mode = 0o600) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(file, mode).catch(() => {});
}

async function fixture({ current = currentConfiguration(), template = inventoryTemplate() } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fm-inventory-migration-'));
  const configFile = path.join(directory, 'openapi.secret.json');
  const templateFile = path.join(directory, 'openapi.example.json');
  await writeJson(configFile, current);
  await writeJson(templateFile, template);
  return {
    directory,
    configFile,
    templateFile,
    environment: {
      FULL_BI_OPENAPI_CONFIG_FILE: configFile,
    },
  };
}

function argumentsFor(files, extra = []) {
  return ['--template', files.templateFile, ...extra];
}

function capture() {
  return {
    value: '',
    write(chunk) {
      this.value += String(chunk);
      return true;
    },
  };
}

test('store inventory migration defaults to a validated dry-run with no backup or mutation', async () => {
  const files = await fixture();
  try {
    const original = await readFile(files.configFile, 'utf8');
    const result = await migrateFullManagedStoreInventory({
      argv: argumentsFor(files),
      environment: files.environment,
      now: NOW,
    });

    assert.deepEqual(result, {
      ok: true,
      mode: 'dry-run',
      previousStoreCount: 2,
      storeCount: 24,
      enabledStoreCount: 0,
      credentialsConfigured: 0,
      applicationStatus: 'approved',
      authorizationStatus: 'not_started',
      backupCreated: false,
    });
    assert.equal(await readFile(files.configFile, 'utf8'), original);
    assert.equal(
      (await readdir(files.directory)).some((name) => name.includes('.backup-')),
      false,
    );
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('confirmed migration backs up and atomically installs exact 24-store identities', async () => {
  const files = await fixture();
  try {
    const original = await readFile(files.configFile, 'utf8');
    const result = await migrateFullManagedStoreInventory({
      argv: argumentsFor(files, ['--confirm', CONFIRMATION]),
      environment: files.environment,
      now: NOW,
      randomBytes: () => Buffer.from('aabbccddeeff', 'hex'),
    });
    assert.deepEqual(result, {
      ok: true,
      mode: 'applied',
      previousStoreCount: 2,
      storeCount: 24,
      enabledStoreCount: 0,
      credentialsConfigured: 0,
      applicationStatus: 'approved',
      authorizationStatus: 'not_started',
      backupCreated: true,
    });

    const updated = JSON.parse(await readFile(files.configFile, 'utf8'));
    const template = inventoryTemplate();
    assert.deepEqual(updated.deploymentSpecific, {
      preserve: true,
      callbackOrigin: 'https://fm.example.test',
    });
    assert.equal(updated.timeoutMs, 37_000);
    assert.equal(updated.pageSize, 73);
    assert.equal(updated.stores.length, 24);
    assert.deepEqual(
      updated.stores.map(({ storeCode, storeName }) => ({
        storeCode,
        storeName,
      })),
      template.stores.map(({ storeCode, storeName }) => ({
        storeCode,
        storeName,
      })),
    );
    for (const store of updated.stores) {
      assert.deepEqual(store, {
        storeCode: store.storeCode,
        storeName: store.storeName,
        enabled: false,
        applicationStatus: 'approved',
        authorizationStatus: 'not_started',
        appId: null,
        openKeyId: null,
        secretKey: null,
      });
    }

    const backups = (await readdir(files.directory))
      .filter((name) => name.startsWith('openapi.secret.json.backup-'));
    assert.deepEqual(backups, ['openapi.secret.json.backup-20260726080910000-aabbccddeeff']);
    assert.equal(await readFile(path.join(files.directory, backups[0]), 'utf8'), original);
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('migration rejects any legacy credential before creating a backup', async () => {
  for (const credential of [
    { appId: 'existing-app' },
    { openKeyId: 'existing-open-key' },
    { secretKey: 'existing-secret' },
  ]) {
    const files = await fixture({
      current: currentConfiguration(credential),
    });
    try {
      const original = await readFile(files.configFile, 'utf8');
      await assert.rejects(
        migrateFullManagedStoreInventory({
          argv: argumentsFor(files, ['--confirm', CONFIRMATION]),
          environment: files.environment,
          now: NOW,
        }),
        (error) => error.code === 'EXISTING_CREDENTIALS',
      );
      assert.equal(await readFile(files.configFile, 'utf8'), original);
      assert.equal(
        (await readdir(files.directory)).some((name) => name.includes('.backup-')),
        false,
      );
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  }
});

test('wrong confirmation and incomplete 24-store identity fail closed without mutation', async () => {
  const files = await fixture();
  try {
    const original = await readFile(files.configFile, 'utf8');
    await assert.rejects(
      migrateFullManagedStoreInventory({
        argv: argumentsFor(files, ['--confirm', 'yes']),
        environment: files.environment,
      }),
      (error) => error.code === 'CONFIRMATION_REQUIRED',
    );

    const template = inventoryTemplate();
    delete template.stores[3].storeName;
    await writeJson(files.templateFile, template);
    await assert.rejects(
      migrateFullManagedStoreInventory({
        argv: argumentsFor(files, ['--confirm', CONFIRMATION]),
        environment: files.environment,
      }),
      (error) => error.code === 'INVALID_TEMPLATE_IDENTITY',
    );
    assert.equal(await readFile(files.configFile, 'utf8'), original);
    assert.equal(
      (await readdir(files.directory)).some((name) => name.includes('.backup-')),
      false,
    );
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('CLI output is a redacted summary and never exposes paths or inventory identities', async () => {
  const files = await fixture();
  try {
    const stdout = capture();
    const stderr = capture();
    assert.equal(await main({
      argv: argumentsFor(files),
      environment: files.environment,
      stdout,
      stderr,
    }), 0);
    assert.equal(stderr.value, '');
    assert.deepEqual(JSON.parse(stdout.value), {
      ok: true,
      mode: 'dry-run',
      previousStoreCount: 2,
      storeCount: 24,
      enabledStoreCount: 0,
      credentialsConfigured: 0,
      applicationStatus: 'approved',
      authorizationStatus: 'not_started',
      backupCreated: false,
    });
    for (const forbidden of [
      files.directory,
      files.configFile,
      files.templateFile,
      'T0001',
      '店铺账号',
      'callbackOrigin',
    ]) {
      assert.equal(stdout.value.includes(forbidden), false);
    }
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('confirmed migration preserves POSIX owner, group and 0640 mode on target and backup', {
  skip: process.platform === 'win32' ? 'POSIX ownership and modes are unavailable on Windows' : false,
}, async () => {
  const files = await fixture();
  try {
    await chmod(files.configFile, 0o640);
    const before = await stat(files.configFile);
    await migrateFullManagedStoreInventory({
      argv: argumentsFor(files, ['--confirm', CONFIRMATION]),
      environment: files.environment,
      now: NOW,
      randomBytes: () => Buffer.from('102030405060', 'hex'),
    });

    const after = await stat(files.configFile);
    const backup = await stat(path.join(
      files.directory,
      'openapi.secret.json.backup-20260726080910000-102030405060',
    ));
    for (const metadata of [after, backup]) {
      assert.equal(metadata.mode & 0o777, 0o640);
      assert.equal(metadata.uid, before.uid);
      assert.equal(metadata.gid, before.gid);
    }
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});
