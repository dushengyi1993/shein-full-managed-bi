import crypto from 'node:crypto';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const STORE_CODES = /^[A-Z0-9_-]{1,24}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BATCH_STATUSES = new Set(['ACTIVE', 'COMPLETED', 'REVOKED']);
const STORE_STATUSES = new Set([
  'NOT_STARTED',
  'AUTHORIZING',
  'REVIEW_REQUIRED',
  'APPROVED',
  'REJECTED',
  'ERROR',
]);
const STATE_STATUSES = new Set(['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED']);

export class AuthorizationStoreError extends Error {
  constructor(code, message, { persistState = false } = {}) {
    super(message);
    this.name = 'AuthorizationStoreError';
    this.code = code;
    this.persistState = persistState;
  }
}

function fail(code, message, options) {
  throw new AuthorizationStoreError(code, message, options);
}

function blankState() {
  return {
    schemaVersion: 1,
    batches: [],
    states: [],
  };
}

function iso(value, name) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_STATE_FILE', `${name} must be a date`);
  return date.toISOString();
}

function validateStateFile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    fail('INVALID_STATE_FILE', 'authorization state file has an incompatible schema');
  }
  if (!Array.isArray(value.batches) || !Array.isArray(value.states)) {
    fail('INVALID_STATE_FILE', 'authorization state file is missing collections');
  }
  for (const batch of value.batches) {
    if (
      !batch ||
      typeof batch !== 'object' ||
      !SHA256.test(String(batch.tokenHash || '')) ||
      !BATCH_STATUSES.has(batch.status) ||
      !Array.isArray(batch.stores)
    ) {
      fail('INVALID_STATE_FILE', 'authorization state file contains an invalid batch');
    }
    iso(batch.createdAt, 'batch.createdAt');
    iso(batch.expiresAt, 'batch.expiresAt');
    for (const store of batch.stores) {
      if (
        !STORE_CODES.test(String(store.storeCode || '')) ||
        !STORE_STATUSES.has(store.status) ||
        !Number.isSafeInteger(store.attemptCount) ||
        store.attemptCount < 0
      ) {
        fail('INVALID_STATE_FILE', 'authorization state file contains an invalid store');
      }
    }
  }
  for (const state of value.states) {
    if (
      !SHA256.test(String(state.stateHash || '')) ||
      !STATE_STATUSES.has(state.status) ||
      !STORE_CODES.test(String(state.storeCode || ''))
    ) {
      fail('INVALID_STATE_FILE', 'authorization state file contains an invalid state');
    }
    iso(state.createdAt, 'state.createdAt');
    iso(state.expiresAt, 'state.expiresAt');
  }
  return value;
}

function safeEqualHex(left, right) {
  if (!SHA256.test(String(left || '')) || !SHA256.test(String(right || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function findBatchByHash(state, tokenHash) {
  return state.batches.find((batch) => safeEqualHex(batch.tokenHash, tokenHash));
}

function findStore(batch, storeCode) {
  return batch?.stores.find((store) => store.storeCode === storeCode);
}

function publicBatch(batch, now) {
  const isExpired = Date.parse(batch.expiresAt) <= now.getTime();
  const stores = batch.stores.map((store) => ({
    storeCode: store.storeCode,
    status: isExpired && store.status === 'AUTHORIZING' ? 'ERROR' : store.status,
    attemptCount: store.attemptCount,
    authorizedAt: store.authorizedAt || null,
    reviewedAt: store.reviewedAt || null,
    lastErrorCode: store.lastErrorCode || null,
  }));
  return {
    batchId: batch.batchId,
    label: batch.label,
    status: isExpired ? 'EXPIRED' : batch.status,
    createdAt: batch.createdAt,
    expiresAt: batch.expiresAt,
    stores,
  };
}

function reviewBatch(batch, now) {
  const safe = publicBatch(batch, now);
  return {
    ...safe,
    stores: safe.stores.map((store, index) => ({
      ...store,
      supplierId: batch.stores[index].supplierId || null,
    })),
  };
}

function pruneStates(state, now) {
  const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  state.states = state.states.filter((item) => (
    item.status === 'PENDING' ||
    item.status === 'PROCESSING' ||
    Date.parse(item.createdAt) >= cutoff
  ));
}

export class FileAuthorizationStore {
  #queue = Promise.resolve();

  constructor({ file }) {
    if (!file) throw new TypeError('authorization state file is required');
    this.file = path.resolve(file);
  }

  async #read() {
    try {
      return validateStateFile(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return blankState();
      if (error instanceof AuthorizationStoreError) throw error;
      fail('INVALID_STATE_FILE', 'authorization state file could not be read');
    }
  }

  async #write(state) {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => {});
    let existingMetadata = null;
    try {
      existingMetadata = await lstat(this.file);
      if (!existingMetadata.isFile() || existingMetadata.isSymbolicLink()) {
        fail('INVALID_STATE_FILE', 'authorization state path must be a regular file');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const mode = existingMetadata && process.platform !== 'win32'
      ? existingMetadata.mode & 0o777
      : 0o600;
    const temporary = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode,
    });
    if (existingMetadata && process.platform !== 'win32') {
      await chown(temporary, existingMetadata.uid, existingMetadata.gid);
    }
    await chmod(temporary, mode).catch(() => {});
    await rename(temporary, this.file);
    await chmod(this.file, mode).catch(() => {});
  }

  async #withFileLock(operation) {
    const lockFile = `${this.file}.lock`;
    const deadline = Date.now() + 5_000;
    let handle;
    let ownedLockMetadata;
    while (!handle) {
      try {
        handle = await open(lockFile, 'wx', 0o600);
        ownedLockMetadata = await handle.stat();
        await handle.writeFile(`${JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        })}\n`, 'utf8');
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let metadata;
        try {
          metadata = await lstat(lockFile);
        } catch (inspectError) {
          if (inspectError?.code === 'ENOENT') continue;
          throw inspectError;
        }
        if (Date.now() - metadata.mtimeMs > 30_000) {
          const stale = `${lockFile}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
          try {
            await rename(lockFile, stale);
            await unlink(stale);
          } catch (staleError) {
            if (!['ENOENT', 'EACCES', 'EPERM'].includes(staleError?.code)) throw staleError;
          }
          continue;
        }
        if (Date.now() >= deadline) {
          fail('AUTHORIZATION_STATE_BUSY', 'authorization state is busy');
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      let currentLockMetadata;
      try {
        currentLockMetadata = await lstat(lockFile);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (
        currentLockMetadata &&
        ownedLockMetadata &&
        currentLockMetadata.dev === ownedLockMetadata.dev &&
        currentLockMetadata.ino === ownedLockMetadata.ino
      ) {
        await unlink(lockFile);
      }
    }
  }

  async #mutate(operation) {
    const task = this.#queue.then(() => this.#withFileLock(async () => {
      const state = await this.#read();
      let result;
      try {
        result = await operation(state);
      } catch (error) {
        if (error?.persistState === true) await this.#write(state);
        throw error;
      }
      await this.#write(state);
      return structuredClone(result);
    }));
    this.#queue = task.catch(() => {});
    return task;
  }

  async #snapshot(operation) {
    await this.#queue.catch(() => {});
    return structuredClone(await operation(await this.#read()));
  }

  async createBatch({
    batchId,
    label,
    tokenHash,
    storeCodes,
    createdAt,
    expiresAt,
  }) {
    if (!batchId || !SHA256.test(tokenHash)) throw new TypeError('invalid authorization batch');
    if (!Array.isArray(storeCodes) || storeCodes.length === 0) {
      throw new TypeError('storeCodes must be a non-empty array');
    }
    const normalizedCodes = [...new Set(storeCodes.map((value) => String(value).toUpperCase()))];
    if (normalizedCodes.length !== storeCodes.length || normalizedCodes.some((code) => !STORE_CODES.test(code))) {
      throw new TypeError('storeCodes must be unique valid store codes');
    }
    const now = new Date(createdAt);
    const expiry = new Date(expiresAt);
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(expiry.getTime()) || expiry <= now) {
      throw new TypeError('authorization batch dates are invalid');
    }
    return this.#mutate((state) => {
      for (const batch of state.batches) {
        if (batch.status === 'ACTIVE') batch.status = 'REVOKED';
      }
      const batch = {
        batchId: String(batchId),
        label: String(label || '全托店铺授权').slice(0, 80),
        tokenHash,
        status: 'ACTIVE',
        createdAt: now.toISOString(),
        expiresAt: expiry.toISOString(),
        completedAt: null,
        stores: normalizedCodes.map((storeCode) => ({
          storeCode,
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
        })),
      };
      state.batches.push(batch);
      pruneStates(state, now);
      return publicBatch(batch, now);
    });
  }

  async getBatchByTokenHash(tokenHash, now = new Date()) {
    return this.#snapshot((state) => {
      const batch = findBatchByHash(state, tokenHash);
      if (!batch) fail('INVALID_BATCH_TOKEN', 'authorization batch was not found');
      return publicBatch(batch, now);
    });
  }

  async listBatches(now = new Date()) {
    return this.#snapshot((state) => state.batches
      .map((batch) => publicBatch(batch, now))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  async listReviewBatches(now = new Date()) {
    return this.#snapshot((state) => state.batches
      .map((batch) => reviewBatch(batch, now))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  async beginState({
    tokenHash,
    storeCode,
    stateHash,
    createdAt,
    expiresAt,
    maxAttempts = 6,
  }) {
    const normalizedStoreCode = String(storeCode || '').toUpperCase();
    if (!SHA256.test(tokenHash) || !SHA256.test(stateHash) || !STORE_CODES.test(normalizedStoreCode)) {
      throw new TypeError('invalid authorization state request');
    }
    const now = new Date(createdAt);
    const expiry = new Date(expiresAt);
    return this.#mutate((state) => {
      const batch = findBatchByHash(state, tokenHash);
      if (!batch || batch.status !== 'ACTIVE') {
        fail('INVALID_BATCH_TOKEN', 'authorization batch is unavailable');
      }
      if (Date.parse(batch.expiresAt) <= now.getTime()) {
        fail('BATCH_EXPIRED', 'authorization batch has expired');
      }
      const store = findStore(batch, normalizedStoreCode);
      if (!store) fail('STORE_NOT_IN_BATCH', 'store is not part of this batch');
      if (['REVIEW_REQUIRED', 'APPROVED'].includes(store.status)) {
        fail('STORE_ALREADY_RECEIVED', 'store authorization has already been received');
      }
      if (store.attemptCount >= maxAttempts) {
        fail('STORE_ATTEMPT_LIMIT', 'store authorization attempt limit reached');
      }
      for (const pending of state.states) {
        if (
          pending.batchId === batch.batchId &&
          pending.storeCode === normalizedStoreCode &&
          ['PENDING', 'PROCESSING'].includes(pending.status)
        ) {
          pending.status = 'EXPIRED';
          pending.completedAt = now.toISOString();
          pending.failureCode = 'SUPERSEDED';
        }
      }
      state.states.push({
        stateHash,
        batchId: batch.batchId,
        storeCode: normalizedStoreCode,
        status: 'PENDING',
        createdAt: now.toISOString(),
        expiresAt: expiry.toISOString(),
        processingAt: null,
        completedAt: null,
        failureCode: null,
      });
      store.status = 'AUTHORIZING';
      store.attemptCount += 1;
      store.lastErrorCode = null;
      pruneStates(state, now);
      return {
        batchId: batch.batchId,
        storeCode: normalizedStoreCode,
        expiresAt: expiry.toISOString(),
      };
    });
  }

  async claimState({ stateHash, claimedAt }) {
    if (!SHA256.test(stateHash)) throw new TypeError('invalid state hash');
    const now = new Date(claimedAt);
    return this.#mutate((state) => {
      const item = state.states.find((candidate) => safeEqualHex(candidate.stateHash, stateHash));
      if (!item) fail('INVALID_AUTHORIZATION_STATE', 'authorization state was not found');
      if (item.status !== 'PENDING') {
        fail(
          item.status === 'SUCCEEDED' ? 'AUTHORIZATION_STATE_REPLAYED' : 'AUTHORIZATION_STATE_UNAVAILABLE',
          'authorization state is no longer available',
        );
      }
      if (Date.parse(item.expiresAt) <= now.getTime()) {
        item.status = 'EXPIRED';
        item.completedAt = now.toISOString();
        item.failureCode = 'STATE_EXPIRED';
        const batch = state.batches.find((candidate) => candidate.batchId === item.batchId);
        const store = findStore(batch, item.storeCode);
        if (store && store.status === 'AUTHORIZING') {
          store.status = 'ERROR';
          store.lastErrorCode = 'STATE_EXPIRED';
        }
        fail(
          'AUTHORIZATION_STATE_EXPIRED',
          'authorization state has expired',
          { persistState: true },
        );
      }
      const batch = state.batches.find((candidate) => candidate.batchId === item.batchId);
      if (!batch || batch.status !== 'ACTIVE' || Date.parse(batch.expiresAt) <= now.getTime()) {
        fail('BATCH_EXPIRED', 'authorization batch has expired');
      }
      item.status = 'PROCESSING';
      item.processingAt = now.toISOString();
      return {
        batchId: item.batchId,
        storeCode: item.storeCode,
        stateCreatedAt: item.createdAt,
      };
    });
  }

  async completeState({
    stateHash,
    completedAt,
    identity,
    receiptFile,
    credentialFingerprint,
  }) {
    const now = new Date(completedAt);
    return this.#mutate((state) => {
      const item = state.states.find((candidate) => safeEqualHex(candidate.stateHash, stateHash));
      if (!item || item.status !== 'PROCESSING') {
        fail('AUTHORIZATION_STATE_UNAVAILABLE', 'authorization state is not processing');
      }
      const batch = state.batches.find((candidate) => candidate.batchId === item.batchId);
      const store = findStore(batch, item.storeCode);
      if (!batch || !store) fail('INVALID_STATE_FILE', 'authorization state lost its store');
      if (batch.status !== 'ACTIVE' || Date.parse(batch.expiresAt) <= now.getTime()) {
        item.status = 'FAILED';
        item.completedAt = now.toISOString();
        item.failureCode = 'BATCH_EXPIRED';
        fail('BATCH_EXPIRED', 'authorization batch has expired', { persistState: true });
      }
      for (const candidateBatch of state.batches) {
        for (const candidateStore of candidateBatch.stores) {
          if (
            candidateStore.storeCode === store.storeCode
            || !['REVIEW_REQUIRED', 'APPROVED'].includes(candidateStore.status)
          ) {
            continue;
          }
          if (String(candidateStore.supplierId) === String(identity.supplierId)) {
            fail(
              'SUPPLIER_ID_ALREADY_BOUND',
              'supplier id is already bound to a different store',
            );
          }
          if (candidateStore.credentialFingerprint === credentialFingerprint) {
            fail(
              'CREDENTIAL_ALREADY_BOUND',
              'store credential is already bound to a different store',
            );
          }
        }
      }
      item.status = 'SUCCEEDED';
      item.completedAt = now.toISOString();
      store.status = 'REVIEW_REQUIRED';
      store.authorizedAt = now.toISOString();
      store.reviewedAt = null;
      store.platformStoreName = identity.platformStoreName || null;
      store.supplierId = identity.supplierId;
      store.accountNo = identity.accountNo || null;
      store.receiptFile = path.basename(receiptFile);
      store.credentialFingerprint = credentialFingerprint;
      store.lastErrorCode = null;
      if (batch.stores.every((candidate) => ['REVIEW_REQUIRED', 'APPROVED'].includes(candidate.status))) {
        batch.status = 'COMPLETED';
        batch.completedAt = now.toISOString();
      }
      return {
        batchId: batch.batchId,
        storeCode: store.storeCode,
        status: store.status,
        authorizedAt: store.authorizedAt,
        platformStoreName: store.platformStoreName,
        supplierId: store.supplierId,
        accountNo: store.accountNo,
      };
    });
  }

  async failState({ stateHash, failedAt, failureCode }) {
    const now = new Date(failedAt);
    const safeFailureCode = String(failureCode || 'AUTHORIZATION_FAILED')
      .replace(/[^A-Z0-9_]/g, '_')
      .slice(0, 80);
    return this.#mutate((state) => {
      const item = state.states.find((candidate) => safeEqualHex(candidate.stateHash, stateHash));
      if (!item) return { status: 'IGNORED' };
      if (item.status === 'SUCCEEDED') return { status: 'IGNORED' };
      item.status = 'FAILED';
      item.completedAt = now.toISOString();
      item.failureCode = safeFailureCode;
      const batch = state.batches.find((candidate) => candidate.batchId === item.batchId);
      const store = findStore(batch, item.storeCode);
      if (store && store.status === 'AUTHORIZING') {
        store.status = 'ERROR';
        store.lastErrorCode = safeFailureCode;
      }
      return { status: 'FAILED', storeCode: item.storeCode };
    });
  }

  async approveStore({ batchId, storeCode, supplierId, reviewedAt }) {
    const now = new Date(reviewedAt);
    const normalizedStoreCode = String(storeCode || '').toUpperCase();
    return this.#mutate((state) => {
      const batch = state.batches.find((candidate) => candidate.batchId === batchId);
      const store = findStore(batch, normalizedStoreCode);
      if (!store || store.status !== 'REVIEW_REQUIRED') {
        fail('STORE_NOT_REVIEWABLE', 'store is not awaiting review');
      }
      if (String(store.supplierId) !== String(supplierId)) {
        fail('SUPPLIER_ID_MISMATCH', 'supplier id confirmation does not match');
      }
      store.status = 'APPROVED';
      store.reviewedAt = now.toISOString();
      store.receiptFile = null;
      return publicBatch(batch, now);
    });
  }

  async rollbackStoreApproval({
    batchId,
    storeCode,
    supplierId,
    reviewedAt,
    receiptFile,
    credentialFingerprint,
  }) {
    const normalizedStoreCode = String(storeCode || '').toUpperCase();
    const expectedReviewedAt = new Date(reviewedAt).toISOString();
    const safeReceiptFile = path.basename(String(receiptFile || ''));
    return this.#mutate((state) => {
      const batch = state.batches.find((candidate) => candidate.batchId === batchId);
      const store = findStore(batch, normalizedStoreCode);
      if (
        !store
        || store.status !== 'APPROVED'
        || String(store.supplierId) !== String(supplierId)
        || store.reviewedAt !== expectedReviewedAt
        || store.receiptFile !== null
        || store.credentialFingerprint !== credentialFingerprint
        || !safeReceiptFile
        || safeReceiptFile !== receiptFile
      ) {
        fail('APPROVAL_ROLLBACK_CONFLICT', 'approved store no longer matches rollback preconditions');
      }
      store.status = 'REVIEW_REQUIRED';
      store.reviewedAt = null;
      store.receiptFile = safeReceiptFile;
      return publicBatch(batch, new Date(reviewedAt));
    });
  }

  async rejectStore({ batchId, storeCode, supplierId, reviewedAt }) {
    const now = new Date(reviewedAt);
    const normalizedStoreCode = String(storeCode || '').toUpperCase();
    if (
      !batchId
      || !STORE_CODES.test(normalizedStoreCode)
      || !Number.isFinite(now.getTime())
    ) {
      throw new TypeError('invalid store rejection request');
    }
    return this.#mutate((state) => {
      const matchingBatches = state.batches.filter((candidate) => candidate.batchId === batchId);
      const matchingStores = matchingBatches.length === 1
        ? matchingBatches[0].stores.filter((candidate) => candidate.storeCode === normalizedStoreCode)
        : [];
      const batch = matchingBatches.length === 1 ? matchingBatches[0] : null;
      const store = matchingStores.length === 1 ? matchingStores[0] : null;
      if (!batch || !store || store.status !== 'REVIEW_REQUIRED') {
        fail('STORE_NOT_REVIEWABLE', 'store is not awaiting review');
      }
      if (String(store.supplierId) !== String(supplierId)) {
        fail('SUPPLIER_ID_MISMATCH', 'supplier id confirmation does not match');
      }

      store.status = 'REJECTED';
      store.reviewedAt = now.toISOString();
      store.lastErrorCode = 'MANUAL_REVIEW_REJECTED';

      const hasAnotherActiveBatch = state.batches.some((candidate) => (
        candidate !== batch && candidate.status === 'ACTIVE'
      ));
      if (
        batch.status === 'COMPLETED'
        && !hasAnotherActiveBatch
        && Date.parse(batch.expiresAt) > now.getTime()
      ) {
        batch.status = 'ACTIVE';
        batch.completedAt = null;
      }

      return publicBatch(batch, now);
    });
  }
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}
