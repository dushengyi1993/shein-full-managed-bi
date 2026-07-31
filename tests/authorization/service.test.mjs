import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileAuthorizationStore, sha256 } from '../../src/authorization/file-store.mjs';
import {
  AuthorizationServiceError,
  createFullManagedAuthorizationService,
} from '../../src/authorization/service.mjs';
import { encryptSheinSecretKeyForTest } from '../../src/openapi/shein-client.mjs';

const CREATED_AT = new Date('2026-07-26T02:00:00.000Z');
const BATCH_TOKEN = Buffer.alloc(32, 11).toString('base64url');
const CALLBACK_STATE = Buffer.alloc(32, 12).toString('base64url');
const APP_ID = 'full-managed-dl-app';
const APP_SECRET = '0123456789abcdef-test-app-secret';
const OPEN_KEY_ID = 'store-open-key-100';
const STORE_SECRET = 'store-secret-100';
const TEMP_TOKEN = 'temporary-token-for-service-test';

async function makeHarness(context, {
  querySupplierId = 'supplier-100',
  beforeStoreInfoResponse,
  targetStoreCode = 'DL',
  applicationStoreCode = null,
  applicationOwner = 'DL',
  appId = APP_ID,
  appSecret = APP_SECRET,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fm-authorization-service-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const applicationFile = join(directory, 'application.secret.json');
  const stateFile = join(directory, 'state.secret.json');
  const receiptDirectory = join(directory, 'receipts');
  await writeFile(applicationFile, `${JSON.stringify({
    schemaVersion: 1,
    cooperationMode: 'FULL_MANAGED',
    applications: [{
      storeCode: applicationOwner,
      appName: `${applicationOwner} Full Managed Test`,
      appId,
      appSecretKey: appSecret,
    }],
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  const store = new FileAuthorizationStore({ file: stateFile });
  await store.createBatch({
    batchId: 'batch-service-test',
    label: 'Service test batch',
    tokenHash: sha256(BATCH_TOKEN),
    storeCodes: [targetStoreCode],
    applicationStoreCodesByStore: applicationStoreCode
      ? { [targetStoreCode]: applicationStoreCode }
      : null,
    createdAt: CREATED_AT,
    expiresAt: new Date(CREATED_AT.getTime() + 86_400_000),
  });

  const calls = [];
  const encryptedSecretKey = encryptSheinSecretKeyForTest(STORE_SECRET, appSecret);
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/open-api/auth/get-by-token')) {
      return new Response(JSON.stringify({
        code: 0,
        msg: 'OK',
        info: {
          appid: appId,
          state: CALLBACK_STATE,
          supplierId: 'supplier-100',
          supplierBusinessMode: 'FULL_MANAGED',
          openKeyId: OPEN_KEY_ID,
          secretKey: encryptedSecretKey,
        },
      }), { status: 200 });
    }
    if (url.endsWith('/open-api/openapi-business-backend/query-store-info')) {
      await beforeStoreInfoResponse?.();
      return new Response(JSON.stringify({
        code: 0,
        msg: 'OK',
        info: {
          storeInfo: {
            supplierId: querySupplierId,
            storeName: 'DL Full Managed',
            accountNo: 'GS100',
          },
        },
      }), { status: 200 });
    }
    throw new Error(`Unexpected fake URL: ${url}`);
  };

  const service = createFullManagedAuthorizationService({
    store,
    applicationFile,
    receiptDirectory,
    publicOrigin: 'https://fm.test',
    baseUrl: 'https://fake.test',
    allowFakeBaseUrl: true,
    platform: 'win32',
    fetchImpl,
    now: () => new Date(CREATED_AT),
    randomBytes: () => Buffer.alloc(32, 12),
  });

  return {
    calls,
    directory,
    receiptDirectory,
    service,
    stateFile,
    store,
  };
}

async function startAuthorization(service, storeCode = 'DL') {
  const session = await service.createSession(BATCH_TOKEN);
  const cookie = session.setCookie.split(';', 1)[0];
  const started = await service.begin(cookie, storeCode);
  assert.equal(started.storeCode, storeCode);
  assert.equal(
    new URL(started.authorizationUrl).hash.includes(CALLBACK_STATE),
    true,
  );
  return { cookie, session, started };
}

test('routes a store authorization and callback through the batch legal-entity application', async (context) => {
  const harness = await makeHarness(context, {
    targetStoreCode: 'CX4412',
    applicationStoreCode: 'CX',
    applicationOwner: 'CX',
    appId: 'full-managed-cx-app',
    appSecret: '0123456789abcdef-cx-app-secret',
  });
  await startAuthorization(harness.service, 'CX4412');
  await harness.service.complete({
    state: CALLBACK_STATE,
    tempToken: TEMP_TOKEN,
  });

  const [receiptName] = await readdir(harness.receiptDirectory);
  const receipt = JSON.parse(await readFile(join(harness.receiptDirectory, receiptName), 'utf8'));
  assert.equal(receipt.storeCode, 'CX4412');
  assert.equal(receipt.applicationStoreCode, 'CX');
  assert.equal(receipt.appId, 'full-managed-cx-app');
});

async function directoryEntries(directory) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

test('exchanges the callback, verifies store identity and writes only a REVIEW_REQUIRED receipt', async (context) => {
  const harness = await makeHarness(context);
  await startAuthorization(harness.service);
  const result = await harness.service.complete({
    state: CALLBACK_STATE,
    tempToken: TEMP_TOKEN,
  });

  assert.deepEqual(result, {
    batchId: 'batch-service-test',
    storeCode: 'DL',
    status: 'REVIEW_REQUIRED',
    authorizedAt: CREATED_AT.toISOString(),
    platformStoreName: 'DL Full Managed',
    supplierId: 'supplier-100',
    accountNo: null,
  });
  assert.equal(harness.calls.length, 2);
  assert.equal(
    harness.calls[0].url,
    'https://fake.test/open-api/auth/get-by-token',
  );
  assert.equal(
    harness.calls[1].url,
    'https://fake.test/open-api/openapi-business-backend/query-store-info',
  );

  const receiptFiles = await directoryEntries(harness.receiptDirectory);
  assert.equal(receiptFiles.length, 1);
  const receipt = JSON.parse(
    await readFile(join(harness.receiptDirectory, receiptFiles[0]), 'utf8'),
  );
  assert.equal(receipt.status, 'REVIEW_REQUIRED');
  assert.equal(receipt.storeCode, 'DL');
  assert.equal(receipt.identity.supplierId, 'supplier-100');
  assert.equal(Object.hasOwn(receipt.identity, 'accountNo'), false);
  assert.equal(receipt.openKeyId, OPEN_KEY_ID);
  assert.equal(receipt.secretKey, STORE_SECRET);
  assert.equal(Object.hasOwn(receipt, 'tempToken'), false);
  assert.equal(Object.hasOwn(receipt, 'state'), false);

  const stateText = await readFile(harness.stateFile, 'utf8');
  assert.doesNotMatch(stateText, new RegExp(BATCH_TOKEN));
  assert.doesNotMatch(stateText, new RegExp(CALLBACK_STATE));
  assert.doesNotMatch(stateText, new RegExp(TEMP_TOKEN));
  assert.doesNotMatch(stateText, new RegExp(STORE_SECRET));
  const batch = await harness.service.getBatch(`fm_full_authz=${BATCH_TOKEN}`);
  assert.equal(batch.stores[0].status, 'REVIEW_REQUIRED');
});

test('supplier identity mismatch writes no receipt or credential material', async (context) => {
  const harness = await makeHarness(context, { querySupplierId: 'supplier-999' });
  await startAuthorization(harness.service);

  await assert.rejects(
    () => harness.service.complete({
      state: CALLBACK_STATE,
      tempToken: TEMP_TOKEN,
    }),
    (error) => error instanceof AuthorizationServiceError
      && error.code === 'STORE_IDENTITY_MISMATCH',
  );

  assert.deepEqual(await directoryEntries(harness.receiptDirectory), []);
  const stateText = await readFile(harness.stateFile, 'utf8');
  assert.doesNotMatch(stateText, new RegExp(OPEN_KEY_ID));
  assert.doesNotMatch(stateText, new RegExp(STORE_SECRET));
  assert.doesNotMatch(stateText, /supplier-100|supplier-999/);
  const state = JSON.parse(stateText);
  assert.equal(state.batches[0].stores[0].status, 'ERROR');
  assert.equal(state.batches[0].stores[0].lastErrorCode, 'STORE_IDENTITY_MISMATCH');
});

test('revoking a batch during exchange discards the receipt and cannot complete the old batch', async (context) => {
  let harness;
  harness = await makeHarness(context, {
    beforeStoreInfoResponse: async () => {
      await harness.store.createBatch({
        batchId: 'replacement-batch',
        label: 'Replacement',
        tokenHash: sha256(Buffer.alloc(32, 44).toString('base64url')),
        storeCodes: ['DL'],
        createdAt: new Date(CREATED_AT.getTime() + 1_000),
        expiresAt: new Date(CREATED_AT.getTime() + 86_401_000),
      });
    },
  });
  await startAuthorization(harness.service);

  await assert.rejects(
    () => harness.service.complete({
      state: CALLBACK_STATE,
      tempToken: TEMP_TOKEN,
    }),
    (error) => error instanceof AuthorizationServiceError
      && error.code === 'BATCH_EXPIRED',
  );

  assert.deepEqual(await directoryEntries(harness.receiptDirectory), []);
  const state = JSON.parse(await readFile(harness.stateFile, 'utf8'));
  assert.equal(state.batches[0].status, 'REVOKED');
  assert.equal(state.batches[0].stores[0].status, 'ERROR');
  assert.equal(state.batches[0].stores[0].lastErrorCode, 'BATCH_EXPIRED');
  assert.equal(state.states[0].status, 'FAILED');
  assert.equal(state.states[0].failureCode, 'BATCH_EXPIRED');
});
