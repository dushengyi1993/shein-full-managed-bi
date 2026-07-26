import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FileAuthorizationStore,
  sha256,
} from '../../src/authorization/file-store.mjs';
import {
  main as rejectMain,
  rejectAuthorizationReceipt,
} from '../../scripts/reject_full_managed_authorization_receipt.mjs';

const BATCH_ID = 'batch-one';
const STORE_CODE = 'DX0571';
const SUPPLIER_ID = 'supplier-8848';
const RECEIPT_NAME = 'batch-one-DX0571-1234567890-aabbcc.secret.json';
const AUTHORIZED_AT = '2026-07-26T03:00:00.000Z';
const REVIEWED_AT = new Date('2026-07-26T04:00:00.000Z');
const APP_ID = 'private-app-id';
const OPEN_KEY_ID = 'private-open-key';
const SECRET_KEY = 'private-secret-key';
const ACCOUNT_NO = 'private-account-number';
const FINGERPRINT = sha256(`${APP_ID}:${OPEN_KEY_ID}`);

function authorizationState(overrides = {}) {
  return {
    schemaVersion: 1,
    batches: [{
      batchId: BATCH_ID,
      label: '24 家全托店铺授权',
      tokenHash: 'a'.repeat(64),
      status: 'COMPLETED',
      createdAt: '2026-07-26T02:00:00.000Z',
      expiresAt: '2099-07-27T02:00:00.000Z',
      completedAt: AUTHORIZED_AT,
      stores: [{
        storeCode: STORE_CODE,
        status: 'REVIEW_REQUIRED',
        attemptCount: 1,
        authorizedAt: AUTHORIZED_AT,
        reviewedAt: null,
        platformStoreName: 'private-platform-name',
        supplierId: SUPPLIER_ID,
        accountNo: ACCOUNT_NO,
        receiptFile: RECEIPT_NAME,
        credentialFingerprint: FINGERPRINT,
        lastErrorCode: null,
        ...overrides.store,
      }],
      ...overrides.batch,
    }],
    states: [{
      stateHash: 'b'.repeat(64),
      batchId: BATCH_ID,
      storeCode: STORE_CODE,
      status: 'SUCCEEDED',
      createdAt: '2026-07-26T02:00:00.000Z',
      expiresAt: AUTHORIZED_AT,
      processingAt: '2026-07-26T02:30:00.000Z',
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
    batchId: BATCH_ID,
    storeCode: STORE_CODE,
    applicationStoreCode: 'DL',
    appId: APP_ID,
    openKeyId: OPEN_KEY_ID,
    secretKey: SECRET_KEY,
    identity: {
      supplierId: SUPPLIER_ID,
      platformStoreName: 'private-platform-name',
      accountNo: ACCOUNT_NO,
    },
    authorizedAt: AUTHORIZED_AT,
    ...overrides,
  };
}

async function privateJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

async function fixture(overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fm-auth-reject-'));
  const receiptDirectory = path.join(directory, 'receipts');
  const stateFile = path.join(directory, 'authorization-state.secret.json');
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700).catch(() => {});
  await privateJson(stateFile, authorizationState(overrides));
  await privateJson(path.join(receiptDirectory, RECEIPT_NAME), receipt());
  return {
    directory,
    receiptDirectory,
    stateFile,
    environment: {
      FULL_AUTH_STATE_FILE: stateFile,
      FULL_AUTH_RECEIPT_DIRECTORY: receiptDirectory,
    },
  };
}

function rejectionArguments(overrides = {}) {
  return [
    '--batch-id', overrides.batchId ?? BATCH_ID,
    '--store', overrides.storeCode ?? STORE_CODE,
    '--supplier-id', overrides.supplierId ?? SUPPLIER_ID,
    '--confirm', overrides.confirmation ?? 'SHEIN_FULL_AUTH_REJECT',
  ];
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

test('rejector quarantines then deletes the receipt and preserves rejection audit fields', async () => {
  const files = await fixture();
  try {
    const result = await rejectAuthorizationReceipt({
      argv: rejectionArguments(),
      environment: files.environment,
      now: REVIEWED_AT,
      randomBytes: () => Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
    });
    assert.deepEqual(result, {
      ok: true,
      batchId: BATCH_ID,
      storeCode: STORE_CODE,
      status: 'REJECTED',
      reviewedAt: REVIEWED_AT.toISOString(),
      supplierIdConfirmed: true,
    });

    const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
    const store = state.batches[0].stores[0];
    assert.deepEqual({
      batchStatus: state.batches[0].status,
      batchCompletedAt: state.batches[0].completedAt,
      status: store.status,
      reviewedAt: store.reviewedAt,
      lastErrorCode: store.lastErrorCode,
      supplierId: store.supplierId,
      credentialFingerprint: store.credentialFingerprint,
      receiptFile: store.receiptFile,
    }, {
      batchStatus: 'ACTIVE',
      batchCompletedAt: null,
      status: 'REJECTED',
      reviewedAt: REVIEWED_AT.toISOString(),
      lastErrorCode: 'MANUAL_REVIEW_REJECTED',
      supplierId: SUPPLIER_ID,
      credentialFingerprint: FINGERPRINT,
      receiptFile: RECEIPT_NAME,
    });
    assert.deepEqual(await readdir(files.receiptDirectory), []);
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('wrong supplier, batch, or confirmation leaves state and receipt untouched', async (t) => {
  const cases = [{
    name: 'supplier',
    arguments: rejectionArguments({ supplierId: 'supplier-wrong' }),
    errorCode: 'REVIEW_RECEIPT_NOT_FOUND',
  }, {
    name: 'batch',
    arguments: rejectionArguments({ batchId: 'batch-other' }),
    errorCode: 'REVIEW_RECEIPT_NOT_FOUND',
  }, {
    name: 'confirmation',
    arguments: rejectionArguments({ confirmation: 'yes' }),
    errorCode: 'CONFIRMATION_REQUIRED',
  }];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const files = await fixture();
      try {
        const originalState = await readFile(files.stateFile, 'utf8');
        const originalReceipt = await readFile(
          path.join(files.receiptDirectory, RECEIPT_NAME),
          'utf8',
        );
        await assert.rejects(
          rejectAuthorizationReceipt({
            argv: item.arguments,
            environment: files.environment,
          }),
          (error) => error.code === item.errorCode,
        );
        assert.equal(await readFile(files.stateFile, 'utf8'), originalState);
        assert.equal(
          await readFile(path.join(files.receiptDirectory, RECEIPT_NAME), 'utf8'),
          originalReceipt,
        );
        assert.deepEqual(await readdir(files.receiptDirectory), [RECEIPT_NAME]);
      } finally {
        await rm(files.directory, { recursive: true, force: true });
      }
    });
  }
});

test('state update failure restores the exact receipt name and leaves no quarantine', async () => {
  const files = await fixture();
  try {
    const originalState = await readFile(files.stateFile, 'utf8');
    const originalReceipt = await readFile(
      path.join(files.receiptDirectory, RECEIPT_NAME),
      'utf8',
    );
    await assert.rejects(
      rejectAuthorizationReceipt({
        argv: rejectionArguments(),
        environment: files.environment,
        now: REVIEWED_AT,
        randomBytes: () => Buffer.from('ffeeddccbbaa99887766554433221100', 'hex'),
        createAuthorizationStore: () => ({
          async rejectStore() {
            const error = new Error('simulated private failure');
            error.code = 'SIMULATED_STATE_FAILURE';
            throw error;
          },
        }),
      }),
      (error) => error.code === 'REJECTION_STATE_FAILED',
    );
    assert.equal(await readFile(files.stateFile, 'utf8'), originalState);
    assert.equal(
      await readFile(path.join(files.receiptDirectory, RECEIPT_NAME), 'utf8'),
      originalReceipt,
    );
    assert.deepEqual(await readdir(files.receiptDirectory), [RECEIPT_NAME]);
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('rejector output contains only safe review fields', async () => {
  const files = await fixture();
  try {
    const stdout = capture();
    const stderr = capture();
    assert.equal(await rejectMain({
      argv: rejectionArguments(),
      environment: files.environment,
      stdout,
      stderr,
    }), 0);
    assert.equal(stderr.value, '');
    assert.deepEqual(Object.keys(JSON.parse(stdout.value)).sort(), [
      'batchId',
      'ok',
      'reviewedAt',
      'status',
      'storeCode',
      'supplierIdConfirmed',
    ]);
    for (const forbidden of [
      SUPPLIER_ID,
      RECEIPT_NAME,
      APP_ID,
      OPEN_KEY_ID,
      SECRET_KEY,
      ACCOUNT_NO,
      files.directory,
      'receiptFile',
      'credentialFingerprint',
      'accountNo',
    ]) {
      assert.equal(stdout.value.includes(forbidden), false);
    }
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('unsafe receipt basenames are refused without filesystem mutation', async () => {
  const files = await fixture({ store: { receiptFile: '../outside.secret.json' } });
  try {
    const originalState = await readFile(files.stateFile, 'utf8');
    await assert.rejects(
      rejectAuthorizationReceipt({
        argv: rejectionArguments(),
        environment: files.environment,
      }),
      (error) => error.code === 'REVIEW_RECEIPT_NOT_FOUND',
    );
    assert.equal(await readFile(files.stateFile, 'utf8'), originalState);
    assert.deepEqual(await readdir(files.receiptDirectory), [RECEIPT_NAME]);
    await assert.rejects(
      lstat(path.join(files.directory, 'outside.secret.json')),
      (error) => error.code === 'ENOENT',
    );
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('a rejected identity no longer blocks a different store authorization', async () => {
  const files = await fixture();
  try {
    const batchToken = 'replacement-batch-token';
    const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
    state.batches[0].tokenHash = sha256(batchToken);
    state.batches[0].status = 'ACTIVE';
    state.batches[0].completedAt = null;
    state.batches[0].stores.push({
      storeCode: 'FY4021',
      status: 'NOT_STARTED',
      attemptCount: 0,
      authorizedAt: null,
      reviewedAt: null,
      platformStoreName: null,
      supplierId: null,
      accountNo: null,
      receiptFile: null,
      credentialFingerprint: null,
      lastErrorCode: null,
    });
    await privateJson(files.stateFile, state);

    await rejectAuthorizationReceipt({
      argv: rejectionArguments(),
      environment: files.environment,
      now: REVIEWED_AT,
    });

    const authorizationStore = new FileAuthorizationStore({ file: files.stateFile });
    const authorizationState = 'replacement-state-token';
    await authorizationStore.beginState({
      tokenHash: sha256(batchToken),
      storeCode: 'FY4021',
      stateHash: sha256(authorizationState),
      createdAt: new Date('2026-07-26T04:01:00.000Z'),
      expiresAt: new Date('2026-07-26T04:11:00.000Z'),
    });
    await authorizationStore.claimState({
      stateHash: sha256(authorizationState),
      claimedAt: new Date('2026-07-26T04:02:00.000Z'),
    });
    const completed = await authorizationStore.completeState({
      stateHash: sha256(authorizationState),
      completedAt: new Date('2026-07-26T04:03:00.000Z'),
      identity: { supplierId: SUPPLIER_ID },
      receiptFile: 'batch-one-FY4021-1234567890-ddeeff.secret.json',
      credentialFingerprint: FINGERPRINT,
    });
    assert.equal(completed.status, 'REVIEW_REQUIRED');

    const persisted = JSON.parse(await readFile(files.stateFile, 'utf8'));
    const rejected = persisted.batches[0].stores.find(({ storeCode }) => storeCode === STORE_CODE);
    const replacement = persisted.batches[0].stores.find(({ storeCode }) => storeCode === 'FY4021');
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.supplierId, SUPPLIER_ID);
    assert.equal(rejected.credentialFingerprint, FINGERPRINT);
    assert.equal(replacement.status, 'REVIEW_REQUIRED');
    assert.equal(replacement.supplierId, SUPPLIER_ID);
    assert.equal(replacement.credentialFingerprint, FINGERPRINT);
  } finally {
    await rm(files.directory, { recursive: true, force: true });
  }
});
