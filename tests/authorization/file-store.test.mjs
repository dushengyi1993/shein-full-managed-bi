import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AuthorizationStoreError,
  FileAuthorizationStore,
  sha256,
} from '../../src/authorization/file-store.mjs';

async function temporaryStore(context) {
  const directory = await mkdtemp(join(tmpdir(), 'fm-authorization-store-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'authorization-state.secret.json');
  return {
    directory,
    file,
    store: new FileAuthorizationStore({ file }),
  };
}

async function createBatch(store, token, {
  batchId = 'batch-test',
  createdAt = new Date('2026-07-26T00:00:00.000Z'),
  expiresAt = new Date('2026-07-27T00:00:00.000Z'),
  storeCodes = ['DL'],
} = {}) {
  return store.createBatch({
    batchId,
    label: 'Test full-managed authorization',
    tokenHash: sha256(token),
    storeCodes,
    createdAt,
    expiresAt,
  });
}

test('persists only hashes for batch tokens and one-time authorization states', async (context) => {
  const { file, store } = await temporaryStore(context);
  const batchToken = Buffer.alloc(32, 1).toString('base64url');
  const state = Buffer.alloc(32, 2).toString('base64url');
  await createBatch(store, batchToken);
  await store.beginState({
    tokenHash: sha256(batchToken),
    storeCode: 'DL',
    stateHash: sha256(state),
    createdAt: new Date('2026-07-26T01:00:00.000Z'),
    expiresAt: new Date('2026-07-26T01:10:00.000Z'),
  });

  const raw = await readFile(file, 'utf8');
  const persisted = JSON.parse(raw);
  assert.doesNotMatch(raw, new RegExp(batchToken));
  assert.doesNotMatch(raw, new RegExp(state));
  assert.equal(persisted.batches[0].tokenHash, sha256(batchToken));
  assert.equal(persisted.states[0].stateHash, sha256(state));
  assert.equal(Object.hasOwn(persisted.batches[0], 'token'), false);
  assert.equal(Object.hasOwn(persisted.states[0], 'state'), false);
});

test('a multi-entity batch binds every store and callback state to its application owner', async (context) => {
  const { store } = await temporaryStore(context);
  const batchToken = Buffer.alloc(32, 21).toString('base64url');
  const state = Buffer.alloc(32, 22).toString('base64url');
  await store.createBatch({
    batchId: 'multi-entity-batch',
    label: 'Multi-entity authorization',
    tokenHash: sha256(batchToken),
    storeCodes: ['DL5477', 'CX4412'],
    applicationStoreCodesByStore: {
      DL5477: 'DL',
      CX4412: 'CX',
    },
    createdAt: new Date('2026-07-26T00:00:00.000Z'),
    expiresAt: new Date('2026-07-27T00:00:00.000Z'),
  });

  const batch = await store.getBatchByTokenHash(
    sha256(batchToken),
    new Date('2026-07-26T01:00:00.000Z'),
  );
  assert.deepEqual(
    batch.stores.map(({ storeCode, applicationStoreCode }) => ({
      storeCode,
      applicationStoreCode,
    })),
    [
      { storeCode: 'DL5477', applicationStoreCode: 'DL' },
      { storeCode: 'CX4412', applicationStoreCode: 'CX' },
    ],
  );

  await store.beginState({
    tokenHash: sha256(batchToken),
    storeCode: 'CX4412',
    stateHash: sha256(state),
    createdAt: new Date('2026-07-26T01:00:00.000Z'),
    expiresAt: new Date('2026-07-26T01:10:00.000Z'),
  });
  const claim = await store.claimState({
    stateHash: sha256(state),
    claimedAt: new Date('2026-07-26T01:01:00.000Z'),
  });
  assert.equal(claim.applicationStoreCode, 'CX');
});

test('expires old states and rejects a completed state replay', async (context) => {
  const { file, store } = await temporaryStore(context);
  const batchToken = Buffer.alloc(32, 3).toString('base64url');
  const expiredState = Buffer.alloc(32, 4).toString('base64url');
  const successfulState = Buffer.alloc(32, 5).toString('base64url');
  await createBatch(store, batchToken);

  await store.beginState({
    tokenHash: sha256(batchToken),
    storeCode: 'DL',
    stateHash: sha256(expiredState),
    createdAt: new Date('2026-07-26T01:00:00.000Z'),
    expiresAt: new Date('2026-07-26T01:10:00.000Z'),
  });
  await assert.rejects(
    () => store.claimState({
      stateHash: sha256(expiredState),
      claimedAt: new Date('2026-07-26T01:10:00.000Z'),
    }),
    (error) => error instanceof AuthorizationStoreError
      && error.code === 'AUTHORIZATION_STATE_EXPIRED',
  );

  let persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.states[0].status, 'EXPIRED');
  assert.equal(persisted.states[0].failureCode, 'STATE_EXPIRED');
  assert.equal(persisted.batches[0].stores[0].status, 'ERROR');

  await store.beginState({
    tokenHash: sha256(batchToken),
    storeCode: 'DL',
    stateHash: sha256(successfulState),
    createdAt: new Date('2026-07-26T01:11:00.000Z'),
    expiresAt: new Date('2026-07-26T01:21:00.000Z'),
  });
  await store.claimState({
    stateHash: sha256(successfulState),
    claimedAt: new Date('2026-07-26T01:12:00.000Z'),
  });
  await store.completeState({
    stateHash: sha256(successfulState),
    completedAt: new Date('2026-07-26T01:13:00.000Z'),
    identity: {
      supplierId: 'supplier-100',
      platformStoreName: 'DL Full Managed',
      accountNo: 'GS100',
    },
    receiptFile: 'batch-test-DL.secret.json',
    credentialFingerprint: sha256('app:open-key'),
  });

  await assert.rejects(
    () => store.claimState({
      stateHash: sha256(successfulState),
      claimedAt: new Date('2026-07-26T01:14:00.000Z'),
    }),
    (error) => error instanceof AuthorizationStoreError
      && error.code === 'AUTHORIZATION_STATE_REPLAYED',
  );
  persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.states[1].status, 'SUCCEEDED');
  assert.equal(persisted.batches[0].stores[0].status, 'REVIEW_REQUIRED');
  const [publicBatch] = await store.listBatches(new Date('2026-07-26T01:14:00.000Z'));
  assert.equal(Object.hasOwn(publicBatch.stores[0], 'supplierId'), false);
  assert.equal(Object.hasOwn(publicBatch.stores[0], 'platformStoreName'), false);
  assert.equal(Object.hasOwn(publicBatch.stores[0], 'accountNo'), false);
  const [reviewBatch] = await store.listReviewBatches(new Date('2026-07-26T01:14:00.000Z'));
  assert.equal(reviewBatch.stores[0].supplierId, 'supplier-100');
  assert.equal(Object.hasOwn(reviewBatch.stores[0], 'accountNo'), false);
});

test('rejects an unknown callback state without rewriting the state file', async (context) => {
  const { file, store } = await temporaryStore(context);
  const batchToken = Buffer.alloc(32, 8).toString('base64url');
  await createBatch(store, batchToken);
  const fixedTime = new Date('2026-07-25T00:00:00.000Z');
  await utimes(file, fixedTime, fixedTime);
  const before = await stat(file);

  await assert.rejects(
    () => store.claimState({
      stateHash: sha256(Buffer.alloc(32, 9).toString('base64url')),
      claimedAt: new Date('2026-07-26T01:00:00.000Z'),
    }),
    (error) => error instanceof AuthorizationStoreError
      && error.code === 'INVALID_AUTHORIZATION_STATE',
  );

  const after = await stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('rejects supplier or credential reuse across different store codes', async (context) => {
  for (const duplicate of ['supplier', 'credential']) {
    const { store } = await temporaryStore(context);
    const batchToken = Buffer.alloc(32, duplicate === 'supplier' ? 10 : 11).toString('base64url');
    const firstState = Buffer.alloc(32, 12).toString('base64url');
    const secondState = Buffer.alloc(32, 13).toString('base64url');
    await createBatch(store, batchToken, { storeCodes: ['DL', 'DX'] });

    await store.beginState({
      tokenHash: sha256(batchToken),
      storeCode: 'DL',
      stateHash: sha256(firstState),
      createdAt: new Date('2026-07-26T01:00:00.000Z'),
      expiresAt: new Date('2026-07-26T01:10:00.000Z'),
    });
    await store.claimState({
      stateHash: sha256(firstState),
      claimedAt: new Date('2026-07-26T01:01:00.000Z'),
    });
    await store.completeState({
      stateHash: sha256(firstState),
      completedAt: new Date('2026-07-26T01:02:00.000Z'),
      identity: { supplierId: 'supplier-first' },
      receiptFile: 'batch-test-DL.secret.json',
      credentialFingerprint: sha256('app:first-open-key'),
    });

    await store.beginState({
      tokenHash: sha256(batchToken),
      storeCode: 'DX',
      stateHash: sha256(secondState),
      createdAt: new Date('2026-07-26T01:03:00.000Z'),
      expiresAt: new Date('2026-07-26T01:13:00.000Z'),
    });
    await store.claimState({
      stateHash: sha256(secondState),
      claimedAt: new Date('2026-07-26T01:04:00.000Z'),
    });
    await assert.rejects(
      () => store.completeState({
        stateHash: sha256(secondState),
        completedAt: new Date('2026-07-26T01:05:00.000Z'),
        identity: {
          supplierId: duplicate === 'supplier' ? 'supplier-first' : 'supplier-second',
        },
        receiptFile: 'batch-test-DX.secret.json',
        credentialFingerprint: duplicate === 'credential'
          ? sha256('app:first-open-key')
          : sha256('app:second-open-key'),
      }),
      (error) => error instanceof AuthorizationStoreError
        && error.code === (
          duplicate === 'supplier'
            ? 'SUPPLIER_ID_ALREADY_BOUND'
            : 'CREDENTIAL_ALREADY_BOUND'
        ),
    );
  }
});

test('atomic mutations preserve an existing POSIX state file owner, group and mode', async (context) => {
  if (process.platform === 'win32') {
    context.skip('POSIX uid, gid and permission bits are not available on Windows');
    return;
  }

  const { file, store } = await temporaryStore(context);
  const firstToken = Buffer.alloc(32, 6).toString('base64url');
  const secondToken = Buffer.alloc(32, 7).toString('base64url');
  await createBatch(store, firstToken, { batchId: 'batch-metadata-first' });
  await chmod(file, 0o640);
  const before = await stat(file);

  await createBatch(store, secondToken, {
    batchId: 'batch-metadata-second',
    createdAt: new Date('2026-07-26T02:00:00.000Z'),
    expiresAt: new Date('2026-07-27T02:00:00.000Z'),
  });

  const after = await stat(file);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.equal(after.mode & 0o777, before.mode & 0o777);
  assert.equal(after.mode & 0o777, 0o640);
});
