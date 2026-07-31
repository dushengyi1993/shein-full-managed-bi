import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

import {
  FileAuthorizationStore,
  sha256,
} from '../../src/authorization/file-store.mjs';
import { generateSheinSignature } from '../../src/openapi/shein-client.mjs';
import {
  finalizeAuthorizationReceipt,
  main as finalizeMain,
  openApiFinalizationLockDirectory,
} from '../../scripts/finalize_full_managed_authorization_receipt.mjs';
import {
  createAuthorizationStatusReport,
  main as reportMain,
} from '../../scripts/report_full_managed_authorization_status.mjs';

const AUTHORIZED_AT = '2026-07-26T03:00:00.000Z';
const CREATED_AT = '2026-07-26T02:00:00.000Z';
const EXPIRES_AT = '2099-07-27T02:00:00.000Z';
const REVIEWED_AT = new Date('2026-07-26T04:00:00.000Z');
const APP_ID = 'private-app-id';
const APP_SECRET_KEY = 'private-app-secret-key';
const OPEN_KEY_ID = 'private-open-key';
const SECRET_KEY = 'private-secret-key';
const SUPPLIER_ID = 'supplier-8848';
const RECEIPT_NAME = 'batch-one-DX-1234567890-aabbcc.secret.json';
const FY_SUPPLIER_ID = 'supplier-9901';
const FY_OPEN_KEY_ID = 'private-open-key-fy';
const FY_SECRET_KEY = 'private-secret-key-fy';
const FY_RECEIPT_NAME = 'batch-one-FY-1234567890-ddeeff.secret.json';
const FINALIZER_SCRIPT = fileURLToPath(new URL(
  '../../scripts/finalize_full_managed_authorization_receipt.mjs',
  import.meta.url,
));
const fakeApiIdentities = new Map([
  [OPEN_KEY_ID, { secretKey: SECRET_KEY, supplierId: SUPPLIER_ID }],
  [FY_OPEN_KEY_ID, { secretKey: FY_SECRET_KEY, supplierId: FY_SUPPLIER_ID }],
]);
let fakeApiMode = 'ok';
const fakeApiServer = createServer(async (request, response) => {
  for await (const _chunk of request) {
    // Drain the request before responding.
  }
  if (fakeApiMode === 'http-error') {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: '503', msg: 'temporary failure' }));
    return;
  }
  const url = new URL(request.url, 'http://127.0.0.1');
  const openKeyId = String(request.headers['x-lt-openkeyid'] || '');
  const timestamp = String(request.headers['x-lt-timestamp'] || '');
  const signature = String(request.headers['x-lt-signature'] || '');
  const identity = fakeApiIdentities.get(openKeyId);
  let validSignature = false;
  if (identity && /^[A-Za-z0-9]{5}/.test(signature)) {
    try {
      validSignature = generateSheinSignature({
        openKeyId,
        secretKey: identity.secretKey,
        path: url.pathname,
        timestamp,
        randomKey: signature.slice(0, 5),
      }).signature === signature;
    } catch {
      validSignature = false;
    }
  }
  if (
    request.method !== 'POST'
    || url.pathname !== '/open-api/openapi-business-backend/query-store-info'
    || !validSignature
  ) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: '401', msg: 'invalid credential' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    code: '0',
    info: {
      supplierId: identity.supplierId,
      supplierBusinessMode: 'FULL_MANAGED',
    },
  }));
});
fakeApiServer.listen(0, '127.0.0.1');
await once(fakeApiServer, 'listening');
const fakeApiAddress = fakeApiServer.address();
const FAKE_API_BASE_URL = `http://127.0.0.1:${fakeApiAddress.port}`;
after(async () => {
  fakeApiServer.close();
  await once(fakeApiServer, 'close');
});

function authorizationState(overrides = {}) {
  return {
    schemaVersion: 1,
    batches: [{
      batchId: 'batch-one',
      label: '24 家全托店铺授权',
      tokenHash: 'a'.repeat(64),
      status: 'COMPLETED',
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      completedAt: AUTHORIZED_AT,
      stores: [{
        storeCode: 'DX',
        status: 'REVIEW_REQUIRED',
        attemptCount: 1,
        authorizedAt: AUTHORIZED_AT,
        reviewedAt: null,
        platformStoreName: 'private-platform-name',
        supplierId: SUPPLIER_ID,
        accountNo: 'private-account-number',
        receiptFile: RECEIPT_NAME,
        credentialFingerprint: sha256(`${APP_ID}:${OPEN_KEY_ID}`),
        lastErrorCode: null,
        ...overrides.store,
      }],
      ...overrides.batch,
    }],
    states: [{
      stateHash: 'b'.repeat(64),
      batchId: 'batch-one',
      storeCode: 'DX',
      status: 'SUCCEEDED',
      createdAt: CREATED_AT,
      expiresAt: AUTHORIZED_AT,
      processingAt: CREATED_AT,
      completedAt: AUTHORIZED_AT,
      failureCode: null,
    }],
  };
}

function receipt(overrides = {}) {
  return {
    schemaVersion: 1,
    cooperationMode: 'FULL_MANAGED',
    status: 'REVIEW_REQUIRED',
    batchId: 'batch-one',
    storeCode: 'DX',
    applicationStoreCode: 'DL',
    appId: APP_ID,
    openKeyId: OPEN_KEY_ID,
    secretKey: SECRET_KEY,
    encryptedSecretKey: 'private-encrypted-secret',
    identity: {
      supplierId: SUPPLIER_ID,
      platformStoreName: 'private-platform-name',
      accountNo: 'private-account-number',
      supplierBusinessMode: 'FULL_MANAGED',
    },
    authorizedAt: AUTHORIZED_AT,
    ...overrides,
  };
}

function openApiConfig() {
  return {
    schemaVersion: 1,
    cooperationMode: 'FULL_MANAGED',
    baseUrl: FAKE_API_BASE_URL,
    allowFakeBaseUrl: true,
    timeoutMs: 20_000,
    pageSize: 100,
    permissionPackageCode: 'FULL_MANAGED_SKU_SALES',
    customTopLevelSetting: { preserved: true },
    stores: [{
      storeCode: 'DL',
      storeName: 'DL',
      enabled: false,
      applicationStatus: 'approved',
      authorizationStatus: 'not_started',
      appId: APP_ID,
      openKeyId: null,
      secretKey: null,
      customStoreSetting: 'keep-dl',
    }, {
      storeCode: 'DX',
      storeName: 'DX',
      enabled: false,
      applicationStatus: 'approved',
      authorizationStatus: 'not_started',
      appId: null,
      openKeyId: null,
      secretKey: null,
      platformShopId: 'platform-shop-existing',
      customStoreSetting: 'keep-dx',
    }],
  };
}

function identityMap(bindings = [{
  storeCode: 'DX',
  platformSupplierId: SUPPLIER_ID,
}, {
  storeCode: 'FY',
  platformSupplierId: FY_SUPPLIER_ID,
}]) {
  return {
    schemaVersion: 1,
    cooperationMode: 'FULL_MANAGED',
    bindings,
  };
}

function applicationConfig(applications = [{
  storeCode: 'DL',
  appName: 'DL 全托应用',
  appId: APP_ID,
  appSecretKey: APP_SECRET_KEY,
  materializedAt: '2026-07-26T01:00:00.000Z',
}]) {
  return {
    schemaVersion: 1,
    cooperationMode: 'FULL_MANAGED',
    applications,
  };
}

async function privateJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fm-auth-cli-'));
  const receiptDirectory = path.join(directory, 'receipts');
  const stateFile = path.join(directory, 'authorization-state.secret.json');
  const configFile = path.join(directory, 'openapi.secret.json');
  const identityMapFile = path.join(directory, 'identity-map.secret.json');
  const applicationFile = path.join(directory, 'application.secret.json');
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700).catch(() => {});
  await privateJson(stateFile, authorizationState());
  await privateJson(path.join(receiptDirectory, RECEIPT_NAME), receipt());
  await privateJson(configFile, openApiConfig());
  await privateJson(identityMapFile, identityMap());
  await privateJson(applicationFile, applicationConfig());
  return {
    directory,
    receiptDirectory,
    stateFile,
    configFile,
    identityMapFile,
    applicationFile,
    environment: {
      FULL_AUTH_STATE_FILE: stateFile,
      FULL_AUTH_RECEIPT_DIRECTORY: receiptDirectory,
      FULL_BI_OPENAPI_CONFIG_FILE: configFile,
      FULL_AUTH_IDENTITY_MAP_FILE: identityMapFile,
      FULL_AUTH_APPLICATION_FILE: applicationFile,
    },
  };
}

async function concurrentFixture() {
  const files = await fixture();
  const state = authorizationState();
  state.batches[0].stores.push({
    ...structuredClone(state.batches[0].stores[0]),
    storeCode: 'FY',
    supplierId: FY_SUPPLIER_ID,
    receiptFile: FY_RECEIPT_NAME,
    credentialFingerprint: sha256(`${APP_ID}:${FY_OPEN_KEY_ID}`),
  });
  state.states.push({
    ...structuredClone(state.states[0]),
    stateHash: 'c'.repeat(64),
    storeCode: 'FY',
  });
  await privateJson(files.stateFile, state);
  await privateJson(path.join(files.receiptDirectory, FY_RECEIPT_NAME), receipt({
    storeCode: 'FY',
    openKeyId: FY_OPEN_KEY_ID,
    secretKey: FY_SECRET_KEY,
    identity: {
      supplierId: FY_SUPPLIER_ID,
      platformStoreName: 'private-platform-name-fy',
      accountNo: 'private-account-number-fy',
      supplierBusinessMode: 'FULL_MANAGED',
    },
  }));
  const config = openApiConfig();
  config.stores.push({
    storeCode: 'FY',
    storeName: 'FY',
    enabled: false,
    applicationStatus: 'approved',
    authorizationStatus: 'not_started',
    appId: null,
    openKeyId: null,
    secretKey: null,
    platformShopId: 'platform-shop-existing-fy',
  });
  await privateJson(files.configFile, config);
  return files;
}

async function holdOpenApiLock(configFile) {
  const lockDirectory = openApiFinalizationLockDirectory(configFile);
  await mkdir(lockDirectory, { mode: 0o700 });
  await privateJson(path.join(lockDirectory, 'owner.json'), {
    schemaVersion: 1,
    pid: process.pid,
    nonce: 'd'.repeat(32),
    createdAt: new Date().toISOString(),
  });
  return async () => {
    await unlink(path.join(lockDirectory, 'owner.json')).catch(() => {});
    await rmdir(lockDirectory).catch(() => {});
  };
}

function spawnFinalizer(files, storeCode, supplierId, identityMapFile = files.identityMapFile) {
  const child = spawn(process.execPath, [
    FINALIZER_SCRIPT,
    '--store', storeCode,
    '--supplier-id', supplierId,
    '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
    '--identity-map', identityMapFile,
  ], {
    cwd: path.dirname(path.dirname(FINALIZER_SCRIPT)),
    env: {
      ...process.env,
      ...files.environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const started = new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, started, completion };
}

async function finishChildren(children, timeoutMilliseconds = 15_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.all(children.map(({ completion }) => completion)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('finalizer children timed out')), timeoutMilliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopChildren(children) {
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await Promise.allSettled(children.map(({ completion }) => completion));
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

test('authorization status report exposes only the approved safe field set', async () => {
  const files = await fixture();
  try {
    const report = await createAuthorizationStatusReport({
      environment: files.environment,
      now: REVIEWED_AT,
    });
    assert.deepEqual(report, {
      ok: true,
      batches: [{
        batchId: 'batch-one',
        status: 'COMPLETED',
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        stores: [{
          storeCode: 'DX',
          status: 'REVIEW_REQUIRED',
          supplierId: SUPPLIER_ID,
          authorizedAt: AUTHORIZED_AT,
          reviewedAt: null,
        }],
      }],
    });
    const serialized = JSON.stringify(report);
    for (const forbidden of [
      RECEIPT_NAME,
      'private-platform-name',
      'private-account-number',
      'a'.repeat(64),
      'b'.repeat(64),
      'tokenHash',
      'stateHash',
      'receiptFile',
      'credentialFingerprint',
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }

    const stdout = capture();
    const stderr = capture();
    assert.equal(await reportMain({
      environment: files.environment,
      stdout,
      stderr,
    }), 0);
    assert.equal(stderr.value, '');
    assert.deepEqual(JSON.parse(stdout.value), report);
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('finalizer backs up and atomically enables only the confirmed store before approval', async () => {
  const files = await fixture();
  try {
    const original = await readFile(files.configFile, 'utf8');
    const result = await finalizeAuthorizationReceipt({
      argv: [
        '--store', 'DX',
        '--supplier-id', SUPPLIER_ID,
        '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
      ],
      environment: files.environment,
      now: REVIEWED_AT,
      randomBytes: () => Buffer.from('aabbccddeeff', 'hex'),
    });
    assert.deepEqual(result, {
      ok: true,
      storeCode: 'DX',
      supplierId: SUPPLIER_ID,
      status: 'APPROVED',
      reviewedAt: REVIEWED_AT.toISOString(),
      backupCreated: true,
    });

    const updated = JSON.parse(await readFile(files.configFile, 'utf8'));
    const dx = updated.stores.find(({ storeCode }) => storeCode === 'DX');
    assert.deepEqual({
      enabled: dx.enabled,
      applicationStatus: dx.applicationStatus,
      authorizationStatus: dx.authorizationStatus,
      appId: dx.appId,
      openKeyId: dx.openKeyId,
      secretKey: dx.secretKey,
      platformShopId: dx.platformShopId,
      platformSupplierId: dx.platformSupplierId,
      customStoreSetting: dx.customStoreSetting,
    }, {
      enabled: true,
      applicationStatus: 'approved',
      authorizationStatus: 'authorized',
      appId: APP_ID,
      openKeyId: OPEN_KEY_ID,
      secretKey: SECRET_KEY,
      platformShopId: 'platform-shop-existing',
      platformSupplierId: SUPPLIER_ID,
      customStoreSetting: 'keep-dx',
    });
    assert.deepEqual(updated.customTopLevelSetting, { preserved: true });
    assert.equal(updated.stores.find(({ storeCode }) => storeCode === 'DL').customStoreSetting, 'keep-dl');

    const names = await readdir(files.directory);
    const backups = names.filter((name) => name.startsWith('openapi.secret.json.backup-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(files.directory, backups[0]), 'utf8'), original);
    if (process.platform !== 'win32') {
      const configMetadata = await stat(files.configFile);
      const backupMetadata = await stat(path.join(files.directory, backups[0]));
      assert.equal(configMetadata.mode & 0o777, 0o600);
      assert.equal(backupMetadata.mode & 0o777, 0o600);
      assert.equal(configMetadata.uid, backupMetadata.uid);
      assert.equal(configMetadata.gid, backupMetadata.gid);
    }

    const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
    assert.equal(state.batches[0].stores[0].status, 'APPROVED');
    assert.equal(state.batches[0].stores[0].reviewedAt, REVIEWED_AT.toISOString());
    assert.equal(state.batches[0].stores[0].receiptFile, null);
    assert.equal(
      state.batches[0].stores[0].credentialFingerprint,
      sha256(`${APP_ID}:${OPEN_KEY_ID}`),
    );
    await assert.rejects(
      lstat(path.join(files.receiptDirectory, RECEIPT_NAME)),
      (error) => error.code === 'ENOENT',
    );
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('finalizer accepts the exact non-DL application routed by the authorization batch', async () => {
  const files = await fixture();
  try {
    await privateJson(files.stateFile, authorizationState({
      store: { applicationStoreCode: 'DX' },
    }));
    await privateJson(
      path.join(files.receiptDirectory, RECEIPT_NAME),
      receipt({ applicationStoreCode: 'DX' }),
    );
    await privateJson(files.applicationFile, applicationConfig([{
      storeCode: 'DX',
      appName: 'DX 全托应用',
      appId: APP_ID,
      appSecretKey: APP_SECRET_KEY,
      materializedAt: '2026-07-26T01:00:00.000Z',
    }]));

    const result = await finalizeAuthorizationReceipt({
      argv: [
        '--store', 'DX',
        '--supplier-id', SUPPLIER_ID,
        '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
      ],
      environment: files.environment,
      now: REVIEWED_AT,
      platform: 'win32',
      cloudExecution: '1',
    });
    assert.equal(result.status, 'APPROVED');
    const config = JSON.parse(await readFile(files.configFile, 'utf8'));
    assert.equal(config.stores.find((store) => store.storeCode === 'DX').appId, APP_ID);
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('finalizer output never prints a credential, receipt name, or private path', async () => {
  const files = await fixture();
  try {
    const stdout = capture();
    const stderr = capture();
    assert.equal(await finalizeMain({
      argv: [
        '--store', 'DX',
        '--supplier-id', SUPPLIER_ID,
        '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
        '--openapi-config', files.configFile,
      ],
      environment: files.environment,
      stdout,
      stderr,
    }), 0);
    assert.equal(stderr.value, '');
    const output = stdout.value;
    for (const forbidden of [
      APP_ID,
      OPEN_KEY_ID,
      SECRET_KEY,
      RECEIPT_NAME,
      files.directory,
      'receipt',
      'token',
      'stateFile',
    ]) {
      assert.equal(output.includes(forbidden), false);
    }
    assert.equal(JSON.parse(output).status, 'APPROVED');
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('finalizer accepts root-service style 0640 files and preserves ownership and mode', {
  skip: process.platform === 'win32' ? 'POSIX ownership and modes are unavailable on Windows' : false,
}, async () => {
  const files = await fixture();
  try {
    const receiptFile = path.join(files.receiptDirectory, RECEIPT_NAME);
    await Promise.all([
      chmod(files.stateFile, 0o640),
      chmod(receiptFile, 0o640),
      chmod(files.configFile, 0o640),
      chmod(files.identityMapFile, 0o640),
      chmod(files.applicationFile, 0o640),
    ]);
    const before = await stat(files.configFile);
    await finalizeAuthorizationReceipt({
      argv: [
        '--store', 'DX',
        '--supplier-id', SUPPLIER_ID,
        '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
      ],
      environment: files.environment,
      now: REVIEWED_AT,
      randomBytes: () => Buffer.from('102030405060', 'hex'),
    });
    const after = await stat(files.configFile);
    assert.equal(after.mode & 0o777, 0o640);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);

    const backupName = (await readdir(files.directory))
      .find((name) => name.startsWith('openapi.secret.json.backup-'));
    const backup = await stat(path.join(files.directory, backupName));
    assert.equal(backup.mode & 0o777, 0o640);
    assert.equal(backup.uid, before.uid);
    assert.equal(backup.gid, before.gid);
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('finalizer rejects the wrong confirmation or DL application owner without mutation', async () => {
  const files = await fixture();
  try {
    const originalConfig = await readFile(files.configFile, 'utf8');
    const originalState = await readFile(files.stateFile, 'utf8');
    await assert.rejects(
      finalizeAuthorizationReceipt({
        argv: [
          '--store', 'DX',
          '--supplier-id', SUPPLIER_ID,
          '--confirm', 'yes',
        ],
        environment: files.environment,
      }),
      (error) => error.code === 'CONFIRMATION_REQUIRED',
    );
    assert.equal(await readFile(files.configFile, 'utf8'), originalConfig);
    assert.equal(await readFile(files.stateFile, 'utf8'), originalState);

    await privateJson(path.join(files.receiptDirectory, RECEIPT_NAME), receipt({
      applicationStoreCode: 'DX',
    }));
    await assert.rejects(
      finalizeAuthorizationReceipt({
        argv: [
          '--store', 'DX',
          '--supplier-id', SUPPLIER_ID,
          '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
        ],
        environment: files.environment,
      }),
      (error) => error.code === 'INVALID_RECEIPT',
    );
    assert.equal(await readFile(files.configFile, 'utf8'), originalConfig);
    assert.equal(await readFile(files.stateFile, 'utf8'), originalState);
    assert.equal(
      (await readdir(files.directory)).some((name) => name.includes('.backup-')),
      false,
    );
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('finalizer rejects supplier mismatch before backup or configuration mutation', async () => {
  const files = await fixture();
  try {
    const originalConfig = await readFile(files.configFile, 'utf8');
    await assert.rejects(
      finalizeAuthorizationReceipt({
        argv: [
          '--store', 'DX',
          '--supplier-id', 'supplier-wrong',
          '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
        ],
        environment: files.environment,
      }),
      (error) => error.code === 'REVIEW_RECEIPT_NOT_FOUND',
    );
    assert.equal(await readFile(files.configFile, 'utf8'), originalConfig);
    assert.equal(
      (await readdir(files.directory)).some((name) => name.includes('.backup-')),
      false,
    );
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('root-controlled DL application file pins the receipt app id', async (t) => {
  await t.test('missing application file', async () => {
    const files = await fixture();
    try {
      const environment = { ...files.environment };
      delete environment.FULL_AUTH_APPLICATION_FILE;
      await assert.rejects(
        finalizeAuthorizationReceipt({
          argv: [
            '--store', 'DX',
            '--supplier-id', SUPPLIER_ID,
            '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
          ],
          environment,
        }),
        (error) => error.code === 'APPLICATION_FILE_REQUIRED',
      );
      assert.equal(
        (await readdir(files.directory)).some((name) => name.includes('.backup-')),
        false,
      );
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });

  await t.test('root app id differs from receipt', async () => {
    const files = await fixture();
    try {
      await privateJson(files.applicationFile, applicationConfig([{
        storeCode: 'DL',
        appName: 'DL 全托应用',
        appId: 'root-pinned-other-app-id',
        appSecretKey: APP_SECRET_KEY,
        materializedAt: '2026-07-26T01:00:00.000Z',
      }]));
      const originalConfig = await readFile(files.configFile, 'utf8');
      const originalState = await readFile(files.stateFile, 'utf8');
      await assert.rejects(
        finalizeAuthorizationReceipt({
          argv: [
            '--store', 'DX',
            '--supplier-id', SUPPLIER_ID,
            '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
          ],
          environment: files.environment,
        }),
        (error) => error.code === 'APPLICATION_ID_MISMATCH',
      );
      assert.equal(await readFile(files.configFile, 'utf8'), originalConfig);
      assert.equal(await readFile(files.stateFile, 'utf8'), originalState);
      assert.equal(
        (await readdir(files.directory)).some((name) => name.includes('.backup-')),
        false,
      );
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });

  await t.test('duplicate DL entries', async () => {
    const files = await fixture();
    try {
      await privateJson(files.applicationFile, applicationConfig([{
        storeCode: 'DL',
        appName: 'DL one',
        appId: APP_ID,
        appSecretKey: APP_SECRET_KEY,
      }, {
        storeCode: 'dl',
        appName: 'DL two',
        appId: 'duplicate-app-id',
        appSecretKey: 'duplicate-app-secret',
      }]));
      await assert.rejects(
        finalizeAuthorizationReceipt({
          argv: [
            '--store', 'DX',
            '--supplier-id', SUPPLIER_ID,
            '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
          ],
          environment: files.environment,
        }),
        (error) => error.code === 'INVALID_APPLICATION_FILE',
      );
      assert.equal(
        (await readdir(files.directory)).some((name) => name.includes('.backup-')),
        false,
      );
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });

  await t.test('symlink application file', {
    skip: process.platform === 'win32' ? 'symlink privileges vary on Windows' : false,
  }, async () => {
    const files = await fixture();
    try {
      const link = path.join(files.directory, 'application-link.secret.json');
      await symlink(files.applicationFile, link);
      await assert.rejects(
        finalizeAuthorizationReceipt({
          argv: [
            '--store', 'DX',
            '--supplier-id', SUPPLIER_ID,
            '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
            '--application-file', link,
          ],
          environment: files.environment,
        }),
        (error) => error.code === 'INVALID_APPLICATION_FILE',
      );
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });
});

test('every finalizer private input rejects group-writable permissions', {
  skip: process.platform === 'win32' ? 'POSIX permission bits are unavailable on Windows' : false,
}, async (t) => {
  const cases = [{
    name: 'authorization state',
    target: (files) => files.stateFile,
    mode: 0o660,
    errorCode: 'INVALID_STATE_FILE',
  }, {
    name: 'receipt directory',
    target: (files) => files.receiptDirectory,
    mode: 0o770,
    errorCode: 'RECEIPT_DIRECTORY_UNAVAILABLE',
  }, {
    name: 'receipt',
    target: (files) => path.join(files.receiptDirectory, RECEIPT_NAME),
    mode: 0o660,
    errorCode: 'INVALID_RECEIPT',
  }, {
    name: 'application file',
    target: (files) => files.applicationFile,
    mode: 0o660,
    errorCode: 'INVALID_APPLICATION_FILE',
  }, {
    name: 'identity map',
    target: (files) => files.identityMapFile,
    mode: 0o660,
    errorCode: 'INVALID_IDENTITY_MAP',
  }, {
    name: 'OpenAPI config',
    target: (files) => files.configFile,
    mode: 0o660,
    errorCode: 'INVALID_OPENAPI_CONFIG',
  }];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const files = await fixture();
      try {
        const originalConfig = await readFile(files.configFile, 'utf8');
        const originalState = await readFile(files.stateFile, 'utf8');
        await chmod(item.target(files), item.mode);
        await assert.rejects(
          finalizeAuthorizationReceipt({
            argv: [
              '--store', 'DX',
              '--supplier-id', SUPPLIER_ID,
              '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
            ],
            environment: files.environment,
          }),
          (error) => error.code === item.errorCode,
        );
        assert.equal(await readFile(files.configFile, 'utf8'), originalConfig);
        assert.equal(await readFile(files.stateFile, 'utf8'), originalState);
        assert.equal(
          (await readdir(files.directory)).some((name) => name.includes('.backup-')),
          false,
        );
      } finally {
        await rm(files.directory, { recursive: true, force: true });
      }
    });
  }
});

test('identity map is a required, strict, private one-to-one approval source', async (t) => {
  await t.test('missing map', async () => {
    const files = await fixture();
    try {
      const environment = { ...files.environment };
      delete environment.FULL_AUTH_IDENTITY_MAP_FILE;
      await assert.rejects(
        finalizeAuthorizationReceipt({
          argv: [
            '--store', 'DX',
            '--supplier-id', SUPPLIER_ID,
            '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
          ],
          environment,
        }),
        (error) => error.code === 'IDENTITY_MAP_REQUIRED',
      );
      assert.equal(
        (await readdir(files.directory)).some((name) => name.includes('.backup-')),
        false,
      );
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });

  for (const [name, bindings] of [
    ['duplicate store code', [{
      storeCode: 'DX',
      platformSupplierId: SUPPLIER_ID,
    }, {
      storeCode: 'DX',
      platformSupplierId: FY_SUPPLIER_ID,
    }]],
    ['duplicate supplier id', [{
      storeCode: 'DX',
      platformSupplierId: SUPPLIER_ID,
    }, {
      storeCode: 'FY',
      platformSupplierId: SUPPLIER_ID,
    }]],
  ]) {
    await t.test(name, async () => {
      const files = await fixture();
      try {
        const originalConfig = await readFile(files.configFile, 'utf8');
        const originalState = await readFile(files.stateFile, 'utf8');
        await privateJson(files.identityMapFile, identityMap(bindings));
        await assert.rejects(
          finalizeAuthorizationReceipt({
            argv: [
              '--store', 'DX',
              '--supplier-id', SUPPLIER_ID,
              '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
            ],
            environment: files.environment,
          }),
          (error) => error.code === 'INVALID_IDENTITY_MAP',
        );
        assert.equal(await readFile(files.configFile, 'utf8'), originalConfig);
        assert.equal(await readFile(files.stateFile, 'utf8'), originalState);
        assert.equal(
          (await readdir(files.directory)).some((entry) => entry.includes('.backup-')),
          false,
        );
      } finally {
        await rm(files.directory, { recursive: true, force: true });
      }
    });
  }

  await t.test('candidate does not match expected supplier', async () => {
    const files = await fixture();
    try {
      await privateJson(files.identityMapFile, identityMap([{
        storeCode: 'DX',
        platformSupplierId: 'supplier-expected-other',
      }]));
      const originalConfig = await readFile(files.configFile, 'utf8');
      const originalState = await readFile(files.stateFile, 'utf8');
      await assert.rejects(
        finalizeAuthorizationReceipt({
          argv: [
            '--store', 'DX',
            '--supplier-id', SUPPLIER_ID,
            '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
          ],
          environment: files.environment,
        }),
        (error) => error.code === 'IDENTITY_BINDING_MISMATCH',
      );
      assert.equal(await readFile(files.configFile, 'utf8'), originalConfig);
      assert.equal(await readFile(files.stateFile, 'utf8'), originalState);
      assert.equal(
        (await readdir(files.directory)).some((entry) => entry.includes('.backup-')),
        false,
      );
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });

  await t.test('map with unknown schema fields', async () => {
    const files = await fixture();
    try {
      const map = identityMap();
      map.unexpected = true;
      await privateJson(files.identityMapFile, map);
      await assert.rejects(
        finalizeAuthorizationReceipt({
          argv: [
            '--store', 'DX',
            '--supplier-id', SUPPLIER_ID,
            '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
          ],
          environment: files.environment,
        }),
        (error) => error.code === 'INVALID_IDENTITY_MAP',
      );
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });

  await t.test('world-readable map', {
    skip: process.platform === 'win32' ? 'POSIX permission bits are unavailable on Windows' : false,
  }, async () => {
    const files = await fixture();
    try {
      await chmod(files.identityMapFile, 0o604);
      await assert.rejects(
        finalizeAuthorizationReceipt({
          argv: [
            '--store', 'DX',
            '--supplier-id', SUPPLIER_ID,
            '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
          ],
          environment: files.environment,
        }),
        (error) => error.code === 'INVALID_IDENTITY_MAP',
      );
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });

  await t.test('symlink map', {
    skip: process.platform === 'win32' ? 'symlink privileges vary on Windows' : false,
  }, async () => {
    const files = await fixture();
    try {
      const link = path.join(files.directory, 'identity-map-link.secret.json');
      await symlink(files.identityMapFile, link);
      await assert.rejects(
        finalizeAuthorizationReceipt({
          argv: [
            '--store', 'DX',
            '--supplier-id', SUPPLIER_ID,
            '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
            '--identity-map', link,
          ],
          environment: files.environment,
        }),
        (error) => error.code === 'INVALID_IDENTITY_MAP',
      );
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });
});

test('live identity verification fails closed before backup or approval', async (t) => {
  async function runFailureCase({
    prepare = async () => {},
    expectedCode,
  }) {
    const files = await fixture();
    const reset = await prepare(files);
    try {
      const originalConfig = await readFile(files.configFile, 'utf8');
      const originalState = await readFile(files.stateFile, 'utf8');
      await assert.rejects(
        finalizeAuthorizationReceipt({
          argv: [
            '--store', 'DX',
            '--supplier-id', SUPPLIER_ID,
            '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
          ],
          environment: files.environment,
        }),
        (error) => error.code === expectedCode,
      );
      assert.equal(await readFile(files.configFile, 'utf8'), originalConfig);
      assert.equal(await readFile(files.stateFile, 'utf8'), originalState);
      assert.equal(
        (await readdir(files.directory)).some((entry) => entry.includes('.backup-')),
        false,
      );
      assert.equal(
        (await lstat(path.join(files.receiptDirectory, RECEIPT_NAME))).isFile(),
        true,
      );
    } finally {
      await reset?.();
      await rm(files.directory, { recursive: true, force: true });
    }
  }

  await t.test('live query fails', () => runFailureCase({
    prepare: async () => {
      fakeApiMode = 'http-error';
      return async () => {
        fakeApiMode = 'ok';
      };
    },
    expectedCode: 'LIVE_STORE_IDENTITY_QUERY_FAILED',
  }));

  await t.test('receipt secret was changed', () => runFailureCase({
    prepare: async (files) => {
      await privateJson(path.join(files.receiptDirectory, RECEIPT_NAME), receipt({
        secretKey: 'tampered-secret-key',
      }));
    },
    expectedCode: 'LIVE_STORE_IDENTITY_QUERY_FAILED',
  }));

  await t.test('live supplier differs from expected identity', () => runFailureCase({
    prepare: async () => {
      const original = fakeApiIdentities.get(OPEN_KEY_ID);
      fakeApiIdentities.set(OPEN_KEY_ID, {
        ...original,
        supplierId: 'supplier-live-wrong',
      });
      return async () => {
        fakeApiIdentities.set(OPEN_KEY_ID, original);
      };
    },
    expectedCode: 'LIVE_STORE_IDENTITY_MISMATCH',
  }));
});

test('failure after receipt isolation restores receipt, config, and review state', async () => {
  const files = await fixture();
  try {
    const originalConfig = await readFile(files.configFile, 'utf8');
    const originalState = await readFile(files.stateFile, 'utf8');
    await assert.rejects(
      finalizeAuthorizationReceipt({
        argv: [
          '--store', 'DX',
          '--supplier-id', SUPPLIER_ID,
          '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
        ],
        environment: files.environment,
        authorizationStoreFactory(options) {
          const store = new FileAuthorizationStore(options);
          store.approveStore = async () => {
            const error = new Error('injected approval failure');
            error.code = 'INJECTED_APPROVAL_FAILURE';
            throw error;
          };
          return store;
        },
      }),
      (error) => error.code === 'FINALIZATION_TRANSACTION_FAILED',
    );
    assert.equal(await readFile(files.configFile, 'utf8'), originalConfig);
    assert.equal(await readFile(files.stateFile, 'utf8'), originalState);
    assert.equal(
      (await lstat(path.join(files.receiptDirectory, RECEIPT_NAME))).isFile(),
      true,
    );
    assert.deepEqual(
      (await readdir(files.receiptDirectory)).filter((name) => name.startsWith('.finalizing-')),
      [],
    );
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('receipt disposal failure rolls an already-approved store back to review', async () => {
  const files = await fixture();
  try {
    const originalConfig = await readFile(files.configFile, 'utf8');
    const originalState = await readFile(files.stateFile, 'utf8');
    await assert.rejects(
      finalizeAuthorizationReceipt({
        argv: [
          '--store', 'DX',
          '--supplier-id', SUPPLIER_ID,
          '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
        ],
        environment: files.environment,
        disposeIsolatedReceipt: async () => {
          const error = new Error('injected receipt disposal failure');
          error.code = 'INJECTED_DISPOSAL_FAILURE';
          throw error;
        },
      }),
      (error) => error.code === 'FINALIZATION_TRANSACTION_FAILED',
    );
    assert.equal(await readFile(files.configFile, 'utf8'), originalConfig);
    assert.equal(await readFile(files.stateFile, 'utf8'), originalState);
    assert.equal(
      (await lstat(path.join(files.receiptDirectory, RECEIPT_NAME))).isFile(),
      true,
    );
    assert.deepEqual(
      (await readdir(files.receiptDirectory)).filter((name) => name.startsWith('.finalizing-')),
      [],
    );
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('finalizer rejects supplier and open-key identities bound to another store', async (t) => {
  await t.test('platformSupplierId conflict', async () => {
    const files = await fixture();
    try {
      const config = openApiConfig();
      config.stores.find(({ storeCode }) => storeCode === 'DL').platformSupplierId = SUPPLIER_ID;
      await privateJson(files.configFile, config);
      const originalConfig = await readFile(files.configFile, 'utf8');
      const originalState = await readFile(files.stateFile, 'utf8');
      await assert.rejects(
        finalizeAuthorizationReceipt({
          argv: [
            '--store', 'DX',
            '--supplier-id', SUPPLIER_ID,
            '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
          ],
          environment: files.environment,
        }),
        (error) => error.code === 'PLATFORM_SUPPLIER_ID_ALREADY_BOUND',
      );
      assert.equal(await readFile(files.configFile, 'utf8'), originalConfig);
      assert.equal(await readFile(files.stateFile, 'utf8'), originalState);
      assert.equal(
        (await readdir(files.directory)).some((name) => name.includes('.backup-')),
        false,
      );
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });

  await t.test('openKeyId conflict', async () => {
    const files = await fixture();
    try {
      const config = openApiConfig();
      config.stores.find(({ storeCode }) => storeCode === 'DL').openKeyId = OPEN_KEY_ID;
      await privateJson(files.configFile, config);
      const originalConfig = await readFile(files.configFile, 'utf8');
      const originalState = await readFile(files.stateFile, 'utf8');
      await assert.rejects(
        finalizeAuthorizationReceipt({
          argv: [
            '--store', 'DX',
            '--supplier-id', SUPPLIER_ID,
            '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
          ],
          environment: files.environment,
        }),
        (error) => error.code === 'OPEN_KEY_ID_ALREADY_BOUND',
      );
      assert.equal(await readFile(files.configFile, 'utf8'), originalConfig);
      assert.equal(await readFile(files.stateFile, 'utf8'), originalState);
      assert.equal(
        (await readdir(files.directory)).some((name) => name.includes('.backup-')),
        false,
      );
    } finally {
      await rm(files.directory, { recursive: true, force: true });
    }
  });
});

test('stale finalization lock is isolated and safely recovered', async () => {
  const files = await fixture();
  try {
    const lockDirectory = openApiFinalizationLockDirectory(files.configFile);
    await mkdir(lockDirectory, { mode: 0o700 });
    await privateJson(path.join(lockDirectory, 'owner.json'), {
      schemaVersion: 1,
      pid: process.pid,
      nonce: 'e'.repeat(32),
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    const old = new Date('2020-01-01T00:00:00.000Z');
    await utimes(lockDirectory, old, old);
    const result = await finalizeAuthorizationReceipt({
      argv: [
        '--store', 'DX',
        '--supplier-id', SUPPLIER_ID,
        '--confirm', 'SHEIN_FULL_AUTH_APPROVE',
      ],
      environment: files.environment,
      now: REVIEWED_AT,
    });
    assert.equal(result.status, 'APPROVED');
    await assert.rejects(
      lstat(lockDirectory),
      (error) => error.code === 'ENOENT',
    );
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('two real finalizer processes preserve different stores in one configuration', async () => {
  const files = await concurrentFixture();
  const children = [];
  let releaseHeldLock = null;
  try {
    releaseHeldLock = await holdOpenApiLock(files.configFile);
    children.push(
      spawnFinalizer(files, 'DX', SUPPLIER_ID),
      spawnFinalizer(files, 'FY', FY_SUPPLIER_ID),
    );
    await Promise.all(children.map(({ started }) => started));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(children.every(({ child }) => child.exitCode === null), true);
    await releaseHeldLock();
    releaseHeldLock = null;

    const results = await finishChildren(children);
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(JSON.parse(result.stdout).status, 'APPROVED');
    }
    const config = JSON.parse(await readFile(files.configFile, 'utf8'));
    const dx = config.stores.find(({ storeCode }) => storeCode === 'DX');
    const fy = config.stores.find(({ storeCode }) => storeCode === 'FY');
    assert.deepEqual({
      enabled: dx.enabled,
      supplierId: dx.platformSupplierId,
      openKeyId: dx.openKeyId,
    }, {
      enabled: true,
      supplierId: SUPPLIER_ID,
      openKeyId: OPEN_KEY_ID,
    });
    assert.deepEqual({
      enabled: fy.enabled,
      supplierId: fy.platformSupplierId,
      openKeyId: fy.openKeyId,
    }, {
      enabled: true,
      supplierId: FY_SUPPLIER_ID,
      openKeyId: FY_OPEN_KEY_ID,
    });
    const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
    assert.deepEqual(
      state.batches[0].stores.map(({ storeCode, status }) => ({ storeCode, status })),
      [
        { storeCode: 'DX', status: 'APPROVED' },
        { storeCode: 'FY', status: 'APPROVED' },
      ],
    );
    assert.equal(
      (await readdir(files.directory))
        .filter((name) => name.startsWith('openapi.secret.json.backup-')).length,
      2,
    );
    await assert.rejects(
      lstat(openApiFinalizationLockDirectory(files.configFile)),
      (error) => error.code === 'ENOENT',
    );
  } finally {
    await releaseHeldLock?.();
    await stopChildren(children);
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('same-store finalizer race cannot roll back the successful approval', async () => {
  const files = await fixture();
  const children = [];
  let releaseHeldLock = null;
  try {
    releaseHeldLock = await holdOpenApiLock(files.configFile);
    children.push(
      spawnFinalizer(files, 'DX', SUPPLIER_ID),
      spawnFinalizer(files, 'DX', SUPPLIER_ID),
    );
    await Promise.all(children.map(({ started }) => started));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(children.every(({ child }) => child.exitCode === null), true);
    await releaseHeldLock();
    releaseHeldLock = null;

    const results = await finishChildren(children);
    const safeResults = results.map(({ code, stderr }) => ({
      code,
      errorCode: stderr ? JSON.parse(stderr).errorCode : null,
    }));
    assert.deepEqual(
      results.map(({ code }) => code).sort(),
      [0, 1],
      JSON.stringify(safeResults),
    );
    const failure = results.find(({ code }) => code === 1);
    assert.equal(JSON.parse(failure.stderr).errorCode, 'REVIEW_RECEIPT_NOT_FOUND');

    const config = JSON.parse(await readFile(files.configFile, 'utf8'));
    const dx = config.stores.find(({ storeCode }) => storeCode === 'DX');
    assert.equal(dx.enabled, true);
    assert.equal(dx.authorizationStatus, 'authorized');
    assert.equal(dx.platformSupplierId, SUPPLIER_ID);
    assert.equal(dx.openKeyId, OPEN_KEY_ID);
    const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
    assert.equal(state.batches[0].stores[0].status, 'APPROVED');
    assert.equal(
      (await readdir(files.directory))
        .filter((name) => name.startsWith('openapi.secret.json.backup-')).length,
      1,
    );
    await assert.rejects(
      lstat(openApiFinalizationLockDirectory(files.configFile)),
      (error) => error.code === 'ENOENT',
    );
  } finally {
    await releaseHeldLock?.();
    await stopChildren(children);
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('concurrent stores cannot bind the same supplier identity', async () => {
  const files = await concurrentFixture();
  const children = [];
  let releaseHeldLock = null;
  const originalFyIdentity = fakeApiIdentities.get(FY_OPEN_KEY_ID);
  try {
    const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
    state.batches[0].stores.find(({ storeCode }) => storeCode === 'FY').supplierId = SUPPLIER_ID;
    await privateJson(files.stateFile, state);
    await privateJson(path.join(files.receiptDirectory, FY_RECEIPT_NAME), receipt({
      storeCode: 'FY',
      openKeyId: FY_OPEN_KEY_ID,
      secretKey: FY_SECRET_KEY,
      identity: {
        supplierId: SUPPLIER_ID,
        platformStoreName: 'private-platform-name-fy',
        accountNo: 'private-account-number-fy',
        supplierBusinessMode: 'FULL_MANAGED',
      },
    }));
    const dxIdentityMap = path.join(files.directory, 'dx-identity-map.secret.json');
    const fyIdentityMap = path.join(files.directory, 'fy-identity-map.secret.json');
    await privateJson(dxIdentityMap, identityMap([{
      storeCode: 'DX',
      platformSupplierId: SUPPLIER_ID,
    }]));
    await privateJson(fyIdentityMap, identityMap([{
      storeCode: 'FY',
      platformSupplierId: SUPPLIER_ID,
    }]));
    fakeApiIdentities.set(FY_OPEN_KEY_ID, {
      ...originalFyIdentity,
      supplierId: SUPPLIER_ID,
    });

    releaseHeldLock = await holdOpenApiLock(files.configFile);
    children.push(
      spawnFinalizer(files, 'DX', SUPPLIER_ID, dxIdentityMap),
      spawnFinalizer(files, 'FY', SUPPLIER_ID, fyIdentityMap),
    );
    await Promise.all(children.map(({ started }) => started));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(children.every(({ child }) => child.exitCode === null), true);
    await releaseHeldLock();
    releaseHeldLock = null;

    const results = await finishChildren(children);
    const safeResults = results.map(({ code, stderr }) => ({
      code,
      errorCode: stderr ? JSON.parse(stderr).errorCode : null,
    }));
    assert.deepEqual(
      results.map(({ code }) => code).sort(),
      [0, 1],
      JSON.stringify(safeResults),
    );
    const failure = results.find(({ code }) => code === 1);
    assert.equal(JSON.parse(failure.stderr).errorCode, 'PLATFORM_SUPPLIER_ID_ALREADY_BOUND');

    const config = JSON.parse(await readFile(files.configFile, 'utf8'));
    const enabled = config.stores.filter(({ enabled }) => enabled);
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].platformSupplierId, SUPPLIER_ID);
    const finalState = JSON.parse(await readFile(files.stateFile, 'utf8'));
    assert.deepEqual(
      finalState.batches[0].stores.map(({ status }) => status).sort(),
      ['APPROVED', 'REVIEW_REQUIRED'],
    );
    assert.equal(
      (await readdir(files.directory))
        .filter((name) => name.startsWith('openapi.secret.json.backup-')).length,
      1,
    );
  } finally {
    fakeApiIdentities.set(FY_OPEN_KEY_ID, originalFyIdentity);
    await releaseHeldLock?.();
    await stopChildren(children);
    await rm(files.directory, { recursive: true, force: true });
  }
});
