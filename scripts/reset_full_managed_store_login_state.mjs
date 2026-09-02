#!/usr/bin/env node

// Controlled, auditable reset of the full-managed store-login UI state file.
//
// The dry-run produces an immutable plan: the three input byte hashes, an
// exact plannedUpdatedAt value and the SHA-256 of the exact state bytes. Apply
// must receive every value and reproduce the same bytes before any write.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  FULL_MANAGED_STORE_CODES,
  normalizeFullManagedStoreCode,
} from '../src/config/full-managed-stores.mjs';

const DEFAULT_STATE_FILE = '/srv/shein-fm/runtime/store-login/state.json';
const DEFAULT_RENEWAL_REPORT_FILE =
  '/srv/shein-fm/runtime/store-login/renewal-report.json';
const DEFAULT_RECOVERY_QUEUE_FILE =
  '/srv/shein-fm/runtime/store-login/session-recovery.json';
const RESET_LAST_ERROR = 'SESSION_RELOGIN_REQUIRED';
const STORE_LOGIN_STATUSES = ['pending', 'completed', 'needs_attention'];
const RENEWAL_STATES = ['ACTIVE', 'EXPIRED', 'BLOCKED', 'UNKNOWN'];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// Ownership changes are unavailable on Windows. The adapter keeps all call
// sites observable in tests while production Linux always invokes fs.chown.
export const nodeFileSystem = Object.freeze({
  supportsPosixMetadata: process.platform !== 'win32',
  chmod: (...args) => fs.chmod(...args),
  chown: process.platform === 'win32'
    ? async () => {}
    : (...args) => fs.chown(...args),
  open: (...args) => fs.open(...args),
  readFile: (...args) => fs.readFile(...args),
  rename: (...args) => fs.rename(...args),
  rm: (...args) => fs.rm(...args),
  stat: (...args) => fs.stat(...args),
  writeFile: (...args) => fs.writeFile(...args),
});

function fail(message, details = undefined) {
  const error = new Error(message);
  if (details !== undefined) error.details = details;
  return error;
}

function isControlledError(error) {
  return error instanceof Error && /^[A-Z0-9_]+$/.test(error.message);
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), 'utf8'));
}

export async function sha256File(file, fileSystem = nodeFileSystem) {
  return sha256Bytes(await fileSystem.readFile(file));
}

function normalizeRequiredSha256(value, missingCode, invalidCode) {
  if (value === null || value === undefined || value === '') throw fail(missingCode);
  const normalized = String(value).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw fail(invalidCode);
  return normalized;
}

function validatePlannedUpdatedAt(value, required = true) {
  if (value === null || value === undefined || value === '') {
    if (required) throw fail('PLANNED_UPDATED_AT_REQUIRED');
    return null;
  }
  if (typeof value !== 'string') throw fail('INVALID_PLANNED_UPDATED_AT');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw fail('INVALID_PLANNED_UPDATED_AT');
  }
  return value;
}

function isoFromClock(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw fail('INVALID_CLOCK_VALUE');
  return date.toISOString();
}

export function parseArguments(argv) {
  const options = {
    apply: false,
    stateFile: DEFAULT_STATE_FILE,
    renewalReportFile: DEFAULT_RENEWAL_REPORT_FILE,
    recoveryQueueFile: DEFAULT_RECOVERY_QUEUE_FILE,
    plannedUpdatedAt: null,
    expectedPlannedStateSha256: null,
    expectedStateSha256: null,
    expectedRenewalReportSha256: null,
    expectedRecoveryQueueSha256: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    const value = () => {
      index += 1;
      const next = String(argv[index] ?? '');
      if (!next) throw fail('MISSING_VALUE_FOR_ARGUMENT', { argument });
      return next;
    };
    switch (argument) {
      case '--apply':
        options.apply = true;
        break;
      case '--state-file':
        options.stateFile = value();
        break;
      case '--renewal-report-file':
        options.renewalReportFile = value();
        break;
      case '--recovery-queue-file':
        options.recoveryQueueFile = value();
        break;
      case '--planned-updated-at':
        options.plannedUpdatedAt = value();
        break;
      case '--expected-planned-state-sha256':
        options.expectedPlannedStateSha256 = value().toLowerCase();
        break;
      case '--expected-state-sha256':
        options.expectedStateSha256 = value().toLowerCase();
        break;
      case '--expected-renewal-report-sha256':
        options.expectedRenewalReportSha256 = value().toLowerCase();
        break;
      case '--expected-recovery-queue-sha256':
        options.expectedRecoveryQueueSha256 = value().toLowerCase();
        break;
      default:
        throw fail('UNKNOWN_ARGUMENT', { argument });
    }
  }
  validatePlannedUpdatedAt(options.plannedUpdatedAt, false);
  for (const [field, hash] of [
    ['expectedPlannedStateSha256', options.expectedPlannedStateSha256],
    ['expectedStateSha256', options.expectedStateSha256],
    ['expectedRenewalReportSha256', options.expectedRenewalReportSha256],
    ['expectedRecoveryQueueSha256', options.expectedRecoveryQueueSha256],
  ]) {
    if (hash !== null && !SHA256_PATTERN.test(hash)) {
      throw fail('INVALID_EXPECTED_SHA256', { field });
    }
  }
  return options;
}

function requireExactKeys(value, keys, notObjectCode, missingCode, unknownCode) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(notObjectCode);
  }
  const present = new Set(Object.keys(value));
  for (const key of keys) {
    if (!present.has(key)) throw fail(missingCode, { key });
  }
  for (const key of present) {
    if (!keys.includes(key)) throw fail(unknownCode, { key });
  }
}

function requireKeysWithOptional(
  value,
  requiredKeys,
  optionalKeys,
  notObjectCode,
  missingCode,
  unknownCode,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(notObjectCode);
  }
  const present = new Set(Object.keys(value));
  for (const key of requiredKeys) {
    if (!present.has(key)) throw fail(missingCode, { key });
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of present) {
    if (!allowed.has(key)) throw fail(unknownCode, { key });
  }
}

export function validateInputsForReset({ state, renewalReport, recoveryQueue }) {
  requireExactKeys(
    state,
    ['active', 'stores', 'updatedAt', 'version'],
    'STATE_NOT_OBJECT',
    'STATE_TOP_KEY_MISSING',
    'STATE_TOP_KEY_UNKNOWN',
  );
  if (
    state.active !== null &&
    (typeof state.active !== 'object' || Array.isArray(state.active))
  ) {
    throw fail('ACTIVE_FIELD_INVALID');
  }
  const stores = state.stores;
  if (!stores || typeof stores !== 'object' || Array.isArray(stores)) {
    throw fail('STATE_STORES_NOT_OBJECT');
  }
  const stateStoreCodes = Object.keys(stores);
  if (stateStoreCodes.length !== FULL_MANAGED_STORE_CODES.length) {
    throw fail('STATE_STORE_COUNT_INVALID', { count: stateStoreCodes.length });
  }
  for (const storeCode of FULL_MANAGED_STORE_CODES) {
    if (!Object.hasOwn(stores, storeCode)) {
      throw fail('STATE_STORE_NOT_CANONICAL', { storeCode });
    }
  }
  for (const storeCode of stateStoreCodes) {
    if (normalizeFullManagedStoreCode(storeCode) !== storeCode) {
      throw fail('STATE_STORE_NOT_CANONICAL', { storeCode });
    }
  }
  for (const storeCode of FULL_MANAGED_STORE_CODES) {
    const entry = stores[storeCode];
    requireExactKeys(
      entry,
      ['status', 'completedAt', 'verified', 'lastError'],
      'STATE_STORE_ENTRY_INVALID',
      'STATE_STORE_FIELD_MISSING',
      'STATE_STORE_FIELD_UNKNOWN',
    );
    if (!STORE_LOGIN_STATUSES.includes(entry.status)) {
      throw fail('STATE_STORE_STATUS_INVALID', {
        storeCode,
        status: String(entry.status),
      });
    }
  }

  requireExactKeys(
    renewalReport,
    [
      'activeCount',
      'completedProfileCount',
      'generatedAt',
      'recoveryQueuedCount',
      'results',
      'version',
    ],
    'RENEWAL_REPORT_NOT_OBJECT',
    'RENEWAL_REPORT_TOP_KEY_MISSING',
    'RENEWAL_REPORT_TOP_KEY_UNKNOWN',
  );
  if (renewalReport.completedProfileCount !== FULL_MANAGED_STORE_CODES.length) {
    throw fail('RENEWAL_COMPLETED_PROFILE_COUNT_INVALID');
  }
  const results = renewalReport.results;
  if (!Array.isArray(results) || results.length !== FULL_MANAGED_STORE_CODES.length) {
    throw fail('RENEWAL_RESULTS_COUNT_INVALID', {
      count: Array.isArray(results) ? results.length : null,
    });
  }
  const seen = new Set();
  const recoveryFlagged = new Set();
  for (const item of results) {
    requireKeysWithOptional(
      item,
      ['storeCode', 'state', 'renewed', 'transport'],
      ['recoveryQueued', 'errorCode'],
      'RENEWAL_RESULT_NOT_OBJECT',
      'RENEWAL_RESULT_FIELD_MISSING',
      'RENEWAL_RESULT_FIELD_UNKNOWN',
    );
    const storeCode = normalizeFullManagedStoreCode(item.storeCode);
    if (!storeCode || item.storeCode !== storeCode) {
      throw fail('RENEWAL_RESULT_STORE_NOT_CANONICAL', {
        storeCode: String(item.storeCode),
      });
    }
    if (seen.has(storeCode)) throw fail('RENEWAL_RESULT_DUPLICATE_STORE', { storeCode });
    seen.add(storeCode);
    if (!RENEWAL_STATES.includes(item.state)) {
      throw fail('RENEWAL_RESULT_STATE_INVALID', {
        storeCode,
        state: String(item.state),
      });
    }
    if (item.state === 'ACTIVE') {
      if (Object.hasOwn(item, 'recoveryQueued') && item.recoveryQueued !== false) {
        throw fail('ACTIVE_RENEWAL_RESULT_RECOVERY_QUEUED', { storeCode });
      }
      if (
        Object.hasOwn(item, 'errorCode') &&
        item.errorCode !== null &&
        item.errorCode !== ''
      ) {
        throw fail('ACTIVE_RENEWAL_RESULT_ERROR_CODE_PRESENT', { storeCode });
      }
      continue;
    }
    for (const key of ['recoveryQueued', 'errorCode']) {
      if (!Object.hasOwn(item, key)) {
        throw fail('RENEWAL_RESULT_FIELD_MISSING', { storeCode, key });
      }
    }
    if (item.recoveryQueued !== true) {
      throw fail('NON_ACTIVE_RENEWAL_RESULT_NOT_QUEUED', { storeCode });
    }
    if (
      typeof item.errorCode !== 'string' ||
      !/^[A-Z0-9_]{1,80}$/.test(item.errorCode)
    ) {
      throw fail('NON_ACTIVE_RENEWAL_RESULT_ERROR_CODE_INVALID', { storeCode });
    }
    recoveryFlagged.add(storeCode);
  }
  for (const storeCode of FULL_MANAGED_STORE_CODES) {
    if (!seen.has(storeCode)) throw fail('RENEWAL_RESULT_STORE_MISSING', { storeCode });
  }
  if (renewalReport.activeCount !== results.filter((item) => item.state === 'ACTIVE').length) {
    throw fail('RENEWAL_REPORT_ACTIVE_COUNT_MISMATCH');
  }
  if (renewalReport.recoveryQueuedCount !== recoveryFlagged.size) {
    throw fail('RENEWAL_REPORT_RECOVERY_COUNT_MISMATCH');
  }

  requireExactKeys(
    recoveryQueue,
    ['generatedAt', 'reason', 'stores', 'version'],
    'RECOVERY_QUEUE_NOT_OBJECT',
    'RECOVERY_QUEUE_TOP_KEY_MISSING',
    'RECOVERY_QUEUE_TOP_KEY_UNKNOWN',
  );
  if (!Array.isArray(recoveryQueue.stores)) throw fail('RECOVERY_QUEUE_STORES_NOT_ARRAY');
  const queued = new Set();
  for (const raw of recoveryQueue.stores) {
    const storeCode = normalizeFullManagedStoreCode(raw);
    if (!storeCode || raw !== storeCode) {
      throw fail('RECOVERY_QUEUE_STORE_NOT_CANONICAL', { storeCode: String(raw) });
    }
    if (queued.has(storeCode)) throw fail('RECOVERY_QUEUE_DUPLICATE_STORE', { storeCode });
    queued.add(storeCode);
  }
  if (
    queued.size !== recoveryFlagged.size ||
    [...queued].some((storeCode) => !recoveryFlagged.has(storeCode))
  ) {
    throw fail('RECOVERY_QUEUE_REPORT_MISMATCH');
  }
  return { queued };
}

export function resetStoreLoginState({
  state,
  renewalReport,
  recoveryQueue,
  plannedUpdatedAt,
}) {
  const { queued } = validateInputsForReset({ state, renewalReport, recoveryQueue });
  if (state.active !== null) throw fail('ACTIVE_SESSION_PRESENT');
  const exactUpdatedAt = validatePlannedUpdatedAt(plannedUpdatedAt);
  const resultsByStore = new Map(
    renewalReport.results.map((item) => [item.storeCode, item]),
  );
  const plan = { storeCodes: [], unchangedStoreCodes: [] };
  const nextStores = {};
  for (const storeCode of FULL_MANAGED_STORE_CODES) {
    const entry = state.stores[storeCode];
    const result = resultsByStore.get(storeCode);
    const requiresRelogin = result.state !== 'ACTIVE' || queued.has(storeCode);
    if (!requiresRelogin) {
      nextStores[storeCode] = {
        status: entry.status,
        completedAt: entry.completedAt,
        verified: entry.verified,
        lastError: entry.lastError,
      };
      plan.unchangedStoreCodes.push(storeCode);
      continue;
    }
    nextStores[storeCode] = {
      status: 'pending',
      completedAt: null,
      verified: false,
      lastError: RESET_LAST_ERROR,
    };
    plan.storeCodes.push(storeCode);
  }
  return {
    nextState: {
      active: null,
      stores: nextStores,
      updatedAt: exactUpdatedAt,
      version: state.version,
    },
    plan,
  };
}

function metadataFromStat(stat) {
  return {
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    // Preserve POSIX rwx permission bits. Windows stat includes synthetic
    // platform bits outside this mask; production Linux state is mode 0600.
    mode: Number(stat.mode) & 0o777,
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
  };
}

function sameFileReadSnapshot(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

function sameOwnerAndMode(left, right) {
  return left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readJsonInput(file, fileSystem) {
  let handle = null;
  let bytes;
  let metadata;
  try {
    handle = await fileSystem.open(file, 'r');
    const before = metadataFromStat(await handle.stat());
    bytes = await handle.readFile();
    const after = metadataFromStat(await handle.stat());
    if (!sameFileReadSnapshot(before, after)) throw fail('INPUT_CHANGED_DURING_READ');
    metadata = after;
  } catch (error) {
    if (isControlledError(error)) throw error;
    throw fail('INPUT_FILE_UNREADABLE', {
      code: String(error?.code ?? 'UNKNOWN'),
    });
  } finally {
    await handle?.close().catch(() => {});
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw fail('INPUT_FILE_NOT_JSON');
  }
  return { bytes, digest: sha256Bytes(bytes), value: parsed, metadata };
}

function serializeNextState(nextState) {
  return JSON.stringify(nextState, null, 2) + '\n';
}

async function readInputs({ stateFile, renewalReportFile, recoveryQueueFile, fileSystem }) {
  const [stateInput, renewalInput, queueInput] = await Promise.all([
    readJsonInput(stateFile, fileSystem),
    readJsonInput(renewalReportFile, fileSystem),
    readJsonInput(recoveryQueueFile, fileSystem),
  ]);
  return { stateInput, renewalInput, queueInput };
}

function buildPlan({ stateInput, renewalInput, queueInput, plannedUpdatedAt }) {
  const { nextState, plan } = resetStoreLoginState({
    state: stateInput.value,
    renewalReport: renewalInput.value,
    recoveryQueue: queueInput.value,
    plannedUpdatedAt,
  });
  const plannedStateJson = serializeNextState(nextState);
  return {
    inputSha256: {
      state: stateInput.digest,
      renewalReport: renewalInput.digest,
      recoveryQueue: queueInput.digest,
    },
    plannedUpdatedAt,
    plannedStateJson,
    plannedStateSha256: sha256Text(plannedStateJson),
    plan,
  };
}

export async function planReset({
  stateFile = DEFAULT_STATE_FILE,
  renewalReportFile = DEFAULT_RENEWAL_REPORT_FILE,
  recoveryQueueFile = DEFAULT_RECOVERY_QUEUE_FILE,
  plannedUpdatedAt = null,
  now = () => new Date(),
  fileSystem = nodeFileSystem,
} = {}) {
  const exactUpdatedAt = plannedUpdatedAt === null
    ? isoFromClock(now)
    : validatePlannedUpdatedAt(plannedUpdatedAt);
  const inputs = await readInputs({
    stateFile,
    renewalReportFile,
    recoveryQueueFile,
    fileSystem,
  });
  return buildPlan({ ...inputs, plannedUpdatedAt: exactUpdatedAt });
}

async function verifyInputSnapshot({
  stateFile,
  renewalReportFile,
  recoveryQueueFile,
  stateInput,
  renewalInput,
  queueInput,
  fileSystem,
}) {
  const [stateBytes, renewalBytes, queueBytes, stateStat] = await Promise.all([
    fileSystem.readFile(stateFile),
    fileSystem.readFile(renewalReportFile),
    fileSystem.readFile(recoveryQueueFile),
    fileSystem.stat(stateFile),
  ]);
  if (
    sha256Bytes(stateBytes) !== stateInput.digest ||
    sha256Bytes(renewalBytes) !== renewalInput.digest ||
    sha256Bytes(queueBytes) !== queueInput.digest
  ) {
    throw fail('INPUT_SHA256_DRIFT');
  }
  const currentMetadata = metadataFromStat(stateStat);
  if (
    !sameFileIdentity(currentMetadata, stateInput.metadata) ||
    !sameOwnerAndMode(currentMetadata, stateInput.metadata)
  ) {
    throw fail('STATE_METADATA_DRIFT');
  }
}

function randomArtifactId(randomId) {
  const value = String(randomId());
  if (!/^[0-9a-f]{8,64}$/.test(value)) throw fail('INVALID_RANDOM_ID');
  return value;
}

async function writeExclusiveOwnedFile({
  file,
  bytes,
  uid,
  gid,
  mode,
  kind,
  fileSystem,
}) {
  let handle = null;
  let created = false;
  try {
    handle = await fileSystem.open(file, 'wx', mode);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    // chown can clear special permission bits, so chmod must follow it.
    await fileSystem.chown(file, uid, gid);
    await fileSystem.chmod(file, mode);
    const [written, stat] = await Promise.all([
      fileSystem.readFile(file),
      fileSystem.stat(file),
    ]);
    const metadata = metadataFromStat(stat);
    if (sha256Bytes(written) !== sha256Bytes(bytes)) {
      throw fail(kind + '_FILE_HASH_MISMATCH');
    }
    if (
      fileSystem.supportsPosixMetadata !== false &&
      (metadata.uid !== uid || metadata.gid !== gid || metadata.mode !== mode)
    ) {
      throw fail(kind + '_FILE_METADATA_MISMATCH');
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await fileSystem.rm(file, { force: true }).catch(() => {});
    if (isControlledError(error)) throw error;
    if (error?.code === 'EEXIST') throw fail(kind + '_FILE_ALREADY_EXISTS');
    throw fail(kind + '_FILE_CREATE_FAILED', {
      code: String(error?.code ?? 'UNKNOWN'),
    });
  }
}

async function atomicReplaceState({
  stateFile,
  bytes,
  metadata,
  fileSystem,
  randomId,
  beforeRename = null,
  onRenamed = null,
}) {
  const temporary = path.join(
    path.dirname(stateFile),
    '.' + path.basename(stateFile) + '.' + process.pid + '.' +
      randomArtifactId(randomId) + '.tmp',
  );
  let prepared = false;
  try {
    await writeExclusiveOwnedFile({
      file: temporary,
      bytes,
      uid: metadata.uid,
      gid: metadata.gid,
      mode: metadata.mode,
      kind: 'TEMP',
      fileSystem,
    });
    prepared = true;
    if (beforeRename) await beforeRename();
    try {
      await fileSystem.rename(temporary, stateFile);
    } catch (error) {
      throw fail('STATE_ATOMIC_RENAME_FAILED', {
        code: String(error?.code ?? 'UNKNOWN'),
      });
    }
    prepared = false;
    if (onRenamed) onRenamed();
  } finally {
    if (prepared) await fileSystem.rm(temporary, { force: true }).catch(() => {});
  }
}

async function verifyWrittenState({ stateFile, expectedDigest, metadata, fileSystem }) {
  const [bytes, stat] = await Promise.all([
    fileSystem.readFile(stateFile),
    fileSystem.stat(stateFile),
  ]);
  if (sha256Bytes(bytes) !== expectedDigest) throw fail('POST_WRITE_HASH_MISMATCH');
  if (!sameOwnerAndMode(metadataFromStat(stat), metadata)) {
    throw fail('POST_WRITE_METADATA_MISMATCH');
  }
}

async function restoreOriginalState({
  stateFile,
  originalBytes,
  originalDigest,
  metadata,
  fileSystem,
  randomId,
}) {
  try {
    await atomicReplaceState({
      stateFile,
      bytes: originalBytes,
      metadata,
      fileSystem,
      randomId,
    });
    await verifyWrittenState({
      stateFile,
      expectedDigest: originalDigest,
      metadata,
      fileSystem,
    });
    return;
  } catch {
    // Emergency fallback: if the rollback rename itself cannot complete, try
    // restoring in place, then restore owner/mode and verify every property.
  }
  try {
    await fileSystem.writeFile(stateFile, originalBytes);
    await fileSystem.chown(stateFile, metadata.uid, metadata.gid);
    await fileSystem.chmod(stateFile, metadata.mode);
    await verifyWrittenState({
      stateFile,
      expectedDigest: originalDigest,
      metadata,
      fileSystem,
    });
  } catch (error) {
    throw fail('STATE_ROLLBACK_FAILED', {
      code: String(error?.code ?? error?.message ?? 'UNKNOWN'),
    });
  }
}

function rollbackResultCode(errorCode, rollbackSucceeded) {
  if (!rollbackSucceeded) return errorCode + '_ROLLBACK_FAILED';
  return errorCode + '_ROLLED_BACK';
}

export async function applyReset({
  stateFile = DEFAULT_STATE_FILE,
  renewalReportFile = DEFAULT_RENEWAL_REPORT_FILE,
  recoveryQueueFile = DEFAULT_RECOVERY_QUEUE_FILE,
  plannedUpdatedAt,
  expectedPlannedStateSha256,
  expectedSha256 = {},
  now = () => new Date(),
  randomId = () => crypto.randomBytes(8).toString('hex'),
  fileSystem = nodeFileSystem,
} = {}) {
  const exactUpdatedAt = validatePlannedUpdatedAt(plannedUpdatedAt);
  const expectedPlanHash = normalizeRequiredSha256(
    expectedPlannedStateSha256,
    'EXPECTED_PLANNED_STATE_SHA256_REQUIRED',
    'INVALID_EXPECTED_PLANNED_STATE_SHA256',
  );
  const expectedInputHashes = {
    state: normalizeRequiredSha256(
      expectedSha256?.state,
      'EXPECTED_SHA256_REQUIRED',
      'INVALID_EXPECTED_SHA256',
    ),
    renewalReport: normalizeRequiredSha256(
      expectedSha256?.renewalReport,
      'EXPECTED_SHA256_REQUIRED',
      'INVALID_EXPECTED_SHA256',
    ),
    recoveryQueue: normalizeRequiredSha256(
      expectedSha256?.recoveryQueue,
      'EXPECTED_SHA256_REQUIRED',
      'INVALID_EXPECTED_SHA256',
    ),
  };

  const inputs = await readInputs({
    stateFile,
    renewalReportFile,
    recoveryQueueFile,
    fileSystem,
  });
  const planResult = buildPlan({ ...inputs, plannedUpdatedAt: exactUpdatedAt });
  for (const field of ['state', 'renewalReport', 'recoveryQueue']) {
    if (planResult.inputSha256[field] !== expectedInputHashes[field]) {
      throw fail('INPUT_SHA256_DRIFT', { field });
    }
  }
  if (planResult.plannedStateSha256 !== expectedPlanHash) {
    throw fail('PLANNED_STATE_SHA256_MISMATCH');
  }

  const verifyCurrentInputs = () => verifyInputSnapshot({
    stateFile,
    renewalReportFile,
    recoveryQueueFile,
    ...inputs,
    fileSystem,
  });
  await verifyCurrentInputs();

  const timestamp = isoFromClock(now).replace(/[:.]/g, '-');
  const backupBasename = path.basename(stateFile) + '.' + timestamp + '.' +
    randomArtifactId(randomId) + '.bak';
  const backupFile = path.join(path.dirname(stateFile), backupBasename);
  let backupCreated = false;
  let stateReplaced = false;
  try {
    await writeExclusiveOwnedFile({
      file: backupFile,
      bytes: inputs.stateInput.bytes,
      uid: inputs.stateInput.metadata.uid,
      gid: inputs.stateInput.metadata.gid,
      mode: 0o600,
      kind: 'BACKUP',
      fileSystem,
    });
    backupCreated = true;

    await atomicReplaceState({
      stateFile,
      bytes: Buffer.from(planResult.plannedStateJson, 'utf8'),
      metadata: inputs.stateInput.metadata,
      fileSystem,
      randomId,
      // This is the last operation before rename and detects content, owner,
      // mode or inode drift across all three immutable plan inputs.
      beforeRename: verifyCurrentInputs,
      onRenamed: () => { stateReplaced = true; },
    });
    await verifyWrittenState({
      stateFile,
      expectedDigest: planResult.plannedStateSha256,
      metadata: inputs.stateInput.metadata,
      fileSystem,
    });
  } catch (error) {
    if (stateReplaced) {
      let rollbackSucceeded = false;
      try {
        await restoreOriginalState({
          stateFile,
          originalBytes: inputs.stateInput.bytes,
          originalDigest: inputs.stateInput.digest,
          metadata: inputs.stateInput.metadata,
          fileSystem,
          randomId,
        });
        rollbackSucceeded = true;
      } catch {
        rollbackSucceeded = false;
      }
      const errorCode = isControlledError(error)
        ? error.message
        : 'POST_WRITE_VERIFICATION_FAILED';
      throw fail(rollbackResultCode(errorCode, rollbackSucceeded));
    }
    if (backupCreated) {
      await fileSystem.rm(backupFile, { force: true }).catch(() => {});
    }
    throw error;
  }

  return {
    backupFile,
    backupBasename,
    inputSha256: planResult.inputSha256,
    plannedUpdatedAt: planResult.plannedUpdatedAt,
    plannedStateSha256: planResult.plannedStateSha256,
    writtenStateSha256: planResult.plannedStateSha256,
    plan: planResult.plan,
  };
}

function printResult(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const shared = {
    stateFile: options.stateFile,
    renewalReportFile: options.renewalReportFile,
    recoveryQueueFile: options.recoveryQueueFile,
  };
  if (!options.apply) {
    const result = await planReset({
      ...shared,
      plannedUpdatedAt: options.plannedUpdatedAt,
    });
    printResult({
      ok: true,
      mode: 'dry-run',
      resettableStoreCount: result.plan.storeCodes.length,
      preservedStoreCount: result.plan.unchangedStoreCodes.length,
      storeCodes: result.plan.storeCodes,
      unchangedStoreCodes: result.plan.unchangedStoreCodes,
      inputSha256: result.inputSha256,
      plannedUpdatedAt: result.plannedUpdatedAt,
      plannedStateSha256: result.plannedStateSha256,
    });
    return;
  }
  const result = await applyReset({
    ...shared,
    plannedUpdatedAt: options.plannedUpdatedAt,
    expectedPlannedStateSha256: options.expectedPlannedStateSha256,
    expectedSha256: {
      state: options.expectedStateSha256,
      renewalReport: options.expectedRenewalReportSha256,
      recoveryQueue: options.expectedRecoveryQueueSha256,
    },
  });
  printResult({
    ok: true,
    mode: 'apply',
    resettableStoreCount: result.plan.storeCodes.length,
    preservedStoreCount: result.plan.unchangedStoreCodes.length,
    storeCodes: result.plan.storeCodes,
    unchangedStoreCodes: result.plan.unchangedStoreCodes,
    inputSha256: result.inputSha256,
    plannedUpdatedAt: result.plannedUpdatedAt,
    plannedStateSha256: result.plannedStateSha256,
    backupBasename: result.backupBasename,
  });
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/reset_full_managed_store_login_state.mjs')) {
  main().catch((error) => {
    // Never echo input values, file paths, profiles or session material.
    printResult({
      ok: false,
      errorCode: String(error?.message ?? 'STORE_LOGIN_STATE_RESET_FAILED'),
    });
    process.exitCode = 1;
  });
}
