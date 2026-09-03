#!/usr/bin/env node

import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BATCH_FILE = '/srv/shein-fm/secrets/store-login/batch.json';
const REQUIRED_BATCH_MODE = 0o640;
const REQUIRED_DIRECTORY_MODE = 0o750;
const BACKUP_MODE = 0o600;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BATCH_KEYS = Object.freeze([
  'version',
  'tokenHash',
  'createdAt',
  'expiresAt',
  'revokedAt',
]);

function fail(code) {
  const error = new Error(code);
  error.controlled = true;
  return error;
}

function isControlledError(error) {
  return error?.controlled === true && /^[A-Z0-9_]+$/.test(String(error.message));
}

export function controlledErrorCode(error, fallback) {
  return isControlledError(error) ? error.message : fallback;
}

export function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function exactIso(value, errorCode) {
  if (typeof value !== 'string') throw fail(errorCode);
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw fail(errorCode);
  }
  return value;
}

function isoFromClock(now) {
  let value;
  try {
    value = now();
  } catch {
    throw fail('CLOCK_INVALID');
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw fail('CLOCK_INVALID');
  return date.toISOString();
}

export function validateBatchRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('BATCH_SCHEMA_INVALID');
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== BATCH_KEYS.length
    || keys.some((key, index) => key !== [...BATCH_KEYS].sort()[index])
  ) {
    throw fail('BATCH_SCHEMA_INVALID');
  }
  if (value.version !== 1) throw fail('BATCH_SCHEMA_INVALID');
  if (typeof value.tokenHash !== 'string' || !SHA256_PATTERN.test(value.tokenHash)) {
    throw fail('BATCH_SCHEMA_INVALID');
  }
  const createdAt = exactIso(value.createdAt, 'BATCH_SCHEMA_INVALID');
  const expiresAt = exactIso(value.expiresAt, 'BATCH_SCHEMA_INVALID');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw fail('BATCH_SCHEMA_INVALID');
  if (value.revokedAt !== null) {
    exactIso(value.revokedAt, 'BATCH_SCHEMA_INVALID');
    if (Date.parse(value.revokedAt) < Date.parse(createdAt)) {
      throw fail('BATCH_SCHEMA_INVALID');
    }
  }
  return value;
}

function topLevelObjectKeys(text) {
  const keys = [];
  let objectDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') {
      objectDepth += 1;
      continue;
    }
    if (character === '}') {
      objectDepth -= 1;
      continue;
    }
    if (character !== '"') continue;
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index] === '"') break;
      index += 1;
    }
    if (index >= text.length) throw fail('BATCH_SCHEMA_INVALID');
    let next = index + 1;
    while (/\s/.test(text[next] ?? '')) next += 1;
    if (objectDepth === 1 && text[next] === ':') {
      try {
        keys.push(JSON.parse(text.slice(start, index + 1)));
      } catch {
        throw fail('BATCH_SCHEMA_INVALID');
      }
    }
  }
  return keys;
}

function metadataFromStat(stat) {
  return {
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode) & 0o777,
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameReadSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameOwnerAndMode(left, right) {
  return left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
}

export const nodeFileSystem = Object.freeze({
  constants: fsConstants,
  supportsDirectoryFsync: process.platform !== 'win32',
  lstat: (...args) => fs.lstat(...args),
  open: (...args) => fs.open(...args),
  readFile: (...args) => fs.readFile(...args),
  rename: (...args) => fs.rename(...args),
  rm: (...args) => fs.rm(...args),
});

function readOnlyFlags(fileSystem) {
  return (fileSystem.constants?.O_RDONLY ?? fsConstants.O_RDONLY)
    | (fileSystem.constants?.O_NOFOLLOW ?? fsConstants.O_NOFOLLOW ?? 0);
}

async function lstatRegular(file, fileSystem) {
  let stat;
  try {
    stat = await fileSystem.lstat(file);
  } catch {
    throw fail('BATCH_FILE_UNREADABLE');
  }
  if (stat.isSymbolicLink()) throw fail('BATCH_FILE_SYMLINK');
  if (!stat.isFile()) throw fail('BATCH_FILE_NOT_REGULAR');
  return stat;
}

export async function readBatchInput(file, fileSystem = nodeFileSystem) {
  const pathStat = await lstatRegular(file, fileSystem);
  let handle;
  let bytes;
  let before;
  let after;
  try {
    handle = await fileSystem.open(file, readOnlyFlags(fileSystem));
    const beforeStat = await handle.stat();
    if (!beforeStat.isFile()) throw fail('BATCH_FILE_NOT_REGULAR');
    before = metadataFromStat(beforeStat);
    if (!sameIdentity(metadataFromStat(pathStat), before)) {
      throw fail('BATCH_FILE_DRIFT');
    }
    bytes = await handle.readFile();
    const afterStat = await handle.stat();
    if (!afterStat.isFile()) throw fail('BATCH_FILE_NOT_REGULAR');
    after = metadataFromStat(afterStat);
    if (!sameReadSnapshot(before, after)) throw fail('BATCH_FILE_DRIFT');
  } catch (error) {
    if (isControlledError(error)) throw error;
    if (error?.code === 'ELOOP') throw fail('BATCH_FILE_SYMLINK');
    throw fail('BATCH_FILE_UNREADABLE');
  } finally {
    await handle?.close().catch(() => {});
  }

  const finalPathStat = await lstatRegular(file, fileSystem);
  if (!sameReadSnapshot(after, metadataFromStat(finalPathStat))) {
    throw fail('BATCH_FILE_DRIFT');
  }

  const text = bytes.toString('utf8');
  const rawKeys = topLevelObjectKeys(text);
  if (rawKeys.length !== BATCH_KEYS.length || new Set(rawKeys).size !== rawKeys.length) {
    throw fail('BATCH_SCHEMA_INVALID');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw fail('BATCH_SCHEMA_INVALID');
  }
  validateBatchRecord(value);
  return {
    bytes,
    digest: sha256Bytes(bytes),
    metadata: after,
    value,
  };
}

function serializeRecord(record) {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function buildPlan(input, plannedRevokedAt) {
  const alreadyRevoked = input.value.revokedAt !== null;
  if (alreadyRevoked) {
    return {
      alreadyRevoked: true,
      inputSha256: input.digest,
      metadata: input.metadata,
      plannedBytes: input.bytes,
      plannedRevokedAt: input.value.revokedAt,
      plannedSha256: input.digest,
    };
  }
  const exactRevokedAt = exactIso(plannedRevokedAt, 'PLANNED_REVOKED_AT_INVALID');
  if (Date.parse(exactRevokedAt) < Date.parse(input.value.createdAt)) {
    throw fail('PLANNED_REVOKED_AT_INVALID');
  }
  const next = { ...input.value, revokedAt: exactRevokedAt };
  const plannedBytes = serializeRecord(next);
  return {
    alreadyRevoked: false,
    inputSha256: input.digest,
    metadata: input.metadata,
    plannedBytes,
    plannedRevokedAt: exactRevokedAt,
    plannedSha256: sha256Bytes(plannedBytes),
  };
}

export async function planRevocation({
  batchFile = process.env.FULL_FM_STORE_LOGIN_BATCH_FILE || DEFAULT_BATCH_FILE,
  plannedRevokedAt = null,
  now = () => new Date(),
  fileSystem = nodeFileSystem,
} = {}) {
  const input = await readBatchInput(batchFile, fileSystem);
  const exactRevokedAt = input.value.revokedAt !== null
    ? input.value.revokedAt
    : plannedRevokedAt === null
      ? isoFromClock(now)
      : plannedRevokedAt;
  return buildPlan(input, exactRevokedAt);
}

function normalizeExpectedHash(value, missingCode) {
  if (value === null || value === undefined || value === '') throw fail(missingCode);
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw fail('EXPECTED_SHA256_INVALID');
  }
  return value;
}

function assertRoot(currentUid) {
  let uid;
  try {
    uid = currentUid();
  } catch {
    throw fail('ROOT_REQUIRED');
  }
  if (uid !== 0) throw fail('ROOT_REQUIRED');
}

function assertApplyMetadata(metadata) {
  if (metadata.uid !== 0) throw fail('BATCH_OWNER_INVALID');
  if (!Number.isSafeInteger(metadata.gid) || metadata.gid <= 0) {
    throw fail('BATCH_GROUP_INVALID');
  }
  if (metadata.mode !== REQUIRED_BATCH_MODE) throw fail('BATCH_MODE_INVALID');
}

export async function assertRootOwnedBatchForWrite({
  batchFile,
  metadata,
  currentUid = () => process.getuid?.(),
  fileSystem = nodeFileSystem,
}) {
  assertRoot(currentUid);
  assertApplyMetadata(metadata);
  let directoryStat;
  try {
    directoryStat = await fileSystem.lstat(path.dirname(batchFile));
  } catch {
    throw fail('BATCH_DIRECTORY_INVALID');
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw fail('BATCH_DIRECTORY_INVALID');
  }
  const directoryMetadata = metadataFromStat(directoryStat);
  if (
    directoryMetadata.uid !== 0
    || directoryMetadata.gid !== metadata.gid
    || directoryMetadata.mode !== REQUIRED_DIRECTORY_MODE
  ) {
    throw fail('BATCH_DIRECTORY_INVALID');
  }
}

function randomArtifactId(randomId) {
  let value;
  try {
    value = String(randomId());
  } catch {
    throw fail('RANDOM_ID_INVALID');
  }
  if (!/^[0-9a-f]{12,64}$/.test(value)) throw fail('RANDOM_ID_INVALID');
  return value;
}

async function syncDirectory(directory, fileSystem) {
  if (fileSystem.supportsDirectoryFsync === false) return;
  let handle;
  try {
    handle = await fileSystem.open(directory, fileSystem.constants?.O_RDONLY ?? fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(String(error?.code))) return;
    throw fail('DIRECTORY_FSYNC_FAILED');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readArtifact(file, fileSystem) {
  let bytes;
  let stat;
  try {
    [bytes, stat] = await Promise.all([
      fileSystem.readFile(file),
      fileSystem.lstat(file),
    ]);
  } catch {
    throw fail('ARTIFACT_READBACK_FAILED');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw fail('ARTIFACT_READBACK_FAILED');
  return { bytes, metadata: metadataFromStat(stat) };
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
  let handle;
  let created = false;
  try {
    handle = await fileSystem.open(file, 'wx', BACKUP_MODE);
    created = true;
    await handle.writeFile(bytes);
    await handle.chown(uid, gid);
    await handle.chmod(mode);
    await handle.sync();
    const stat = await handle.stat();
    if (!stat.isFile()) throw fail(`${kind}_CREATE_FAILED`);
    const metadata = metadataFromStat(stat);
    if (metadata.uid !== uid || metadata.gid !== gid || metadata.mode !== mode) {
      throw fail(`${kind}_METADATA_MISMATCH`);
    }
    await handle.close();
    handle = null;
    const readback = await readArtifact(file, fileSystem);
    if (sha256Bytes(readback.bytes) !== sha256Bytes(bytes)) {
      throw fail(`${kind}_HASH_MISMATCH`);
    }
    if (
      readback.metadata.uid !== uid
      || readback.metadata.gid !== gid
      || readback.metadata.mode !== mode
    ) {
      throw fail(`${kind}_METADATA_MISMATCH`);
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    let cleanupFailed = false;
    if (created) {
      try {
        await fileSystem.rm(file, { force: true });
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw fail(`${kind}_CLEANUP_FAILED`);
    if (isControlledError(error)) throw error;
    if (error?.code === 'EEXIST') throw fail(`${kind}_ALREADY_EXISTS`);
    throw fail(`${kind}_CREATE_FAILED`);
  }
}

async function removeArtifact(file, directory, fileSystem) {
  try {
    await fileSystem.rm(file, { force: true });
    await syncDirectory(directory, fileSystem);
  } catch {
    throw fail('ARTIFACT_CLEANUP_FAILED');
  }
}

async function verifyUnchanged(file, expected, fileSystem) {
  const current = await readBatchInput(file, fileSystem);
  if (
    current.digest !== expected.digest
    || !sameReadSnapshot(current.metadata, expected.metadata)
  ) {
    throw fail('BATCH_INPUT_DRIFT');
  }
  return current;
}

async function verifyExactFile(file, expectedDigest, expectedMetadata, fileSystem) {
  const current = await readBatchInput(file, fileSystem);
  if (current.digest !== expectedDigest) throw fail('POST_WRITE_HASH_MISMATCH');
  if (!sameOwnerAndMode(current.metadata, expectedMetadata)) {
    throw fail('POST_WRITE_METADATA_MISMATCH');
  }
  return current;
}

async function restoreInPlace(file, bytes, metadata, fileSystem) {
  const flags = (fileSystem.constants?.O_WRONLY ?? fsConstants.O_WRONLY)
    | (fileSystem.constants?.O_TRUNC ?? fsConstants.O_TRUNC)
    | (fileSystem.constants?.O_NOFOLLOW ?? fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await fileSystem.open(file, flags);
    await handle.writeFile(bytes);
    await handle.chown(metadata.uid, metadata.gid);
    await handle.chmod(metadata.mode);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function restoreOriginal({
  batchFile,
  original,
  fileSystem,
  randomId,
}) {
  const directory = path.dirname(batchFile);
  const restoreTemp = path.join(
    directory,
    `.${path.basename(batchFile)}.${process.pid}.${randomArtifactId(randomId)}.restore.tmp`,
  );
  let restorePrepared = false;
  let cleanupFailed = false;
  try {
    await writeExclusiveOwnedFile({
      file: restoreTemp,
      bytes: original.bytes,
      uid: original.metadata.uid,
      gid: original.metadata.gid,
      mode: original.metadata.mode,
      kind: 'RESTORE_TEMP',
      fileSystem,
    });
    restorePrepared = true;
    await fileSystem.rename(restoreTemp, batchFile);
    restorePrepared = false;
    await syncDirectory(directory, fileSystem);
    await verifyExactFile(batchFile, original.digest, original.metadata, fileSystem);
    return;
  } catch {
    try {
      await fileSystem.rm(restoreTemp, { force: true });
    } catch {
      cleanupFailed = true;
    }
  }

  try {
    await restoreInPlace(batchFile, original.bytes, original.metadata, fileSystem);
    await syncDirectory(directory, fileSystem);
    await verifyExactFile(batchFile, original.digest, original.metadata, fileSystem);
    if (cleanupFailed) throw fail('BATCH_ROLLBACK_FAILED');
  } catch {
    throw fail('BATCH_ROLLBACK_FAILED');
  }
}

function rolledBackCode(error, rollbackSucceeded) {
  const base = isControlledError(error) ? error.message : 'POST_WRITE_VERIFICATION_FAILED';
  return `${base}_${rollbackSucceeded ? 'ROLLED_BACK' : 'ROLLBACK_FAILED'}`;
}

export async function replaceBatchAtomically({
  batchFile,
  original,
  replacementBytes,
  replacementSha256,
  randomId = () => crypto.randomBytes(8).toString('hex'),
  now = () => new Date(),
  fileSystem = nodeFileSystem,
}) {
  if (
    !Buffer.isBuffer(replacementBytes)
    || !SHA256_PATTERN.test(String(replacementSha256))
    || sha256Bytes(replacementBytes) !== replacementSha256
  ) {
    throw fail('REPLACEMENT_BYTES_INVALID');
  }

  // Consume the clock and random names before the first write.
  const timestamp = isoFromClock(now).replace(/[:.]/g, '-');
  const directory = path.dirname(batchFile);
  const backupBasename = `${path.basename(batchFile)}.${timestamp}.${randomArtifactId(randomId)}.bak`;
  const backupFile = path.join(directory, backupBasename);
  const tempFile = path.join(
    directory,
    `.${path.basename(batchFile)}.${process.pid}.${randomArtifactId(randomId)}.tmp`,
  );
  let backupCreated = false;
  let tempCreated = false;
  let replaced = false;

  try {
    await verifyUnchanged(batchFile, original, fileSystem);
    await writeExclusiveOwnedFile({
      file: backupFile,
      bytes: original.bytes,
      uid: original.metadata.uid,
      gid: original.metadata.gid,
      mode: BACKUP_MODE,
      kind: 'BACKUP',
      fileSystem,
    });
    backupCreated = true;
    await syncDirectory(directory, fileSystem);

    await writeExclusiveOwnedFile({
      file: tempFile,
      bytes: replacementBytes,
      uid: original.metadata.uid,
      gid: original.metadata.gid,
      mode: original.metadata.mode,
      kind: 'TEMP',
      fileSystem,
    });
    tempCreated = true;

    // Last operation before rename: exact content, inode, owner, group, mode and timestamps.
    await verifyUnchanged(batchFile, original, fileSystem);
    try {
      await fileSystem.rename(tempFile, batchFile);
    } catch {
      throw fail('BATCH_ATOMIC_RENAME_FAILED');
    }
    tempCreated = false;
    replaced = true;
    await syncDirectory(directory, fileSystem);
    await verifyExactFile(batchFile, replacementSha256, original.metadata, fileSystem);
  } catch (error) {
    let cleanupFailed = false;
    if (tempCreated) {
      try {
        await fileSystem.rm(tempFile, { force: true });
      } catch {
        cleanupFailed = true;
      }
    }
    if (replaced) {
      let rollbackSucceeded = false;
      try {
        await restoreOriginal({ batchFile, original, fileSystem, randomId });
        rollbackSucceeded = true;
      } catch {
        rollbackSucceeded = false;
      }
      throw fail(rolledBackCode(error, rollbackSucceeded));
    }
    if (backupCreated) {
      try {
        await removeArtifact(backupFile, directory, fileSystem);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw fail('ARTIFACT_CLEANUP_FAILED');
    throw error;
  }

  return { backupBasename };
}

export async function applyRevocation({
  batchFile = process.env.FULL_FM_STORE_LOGIN_BATCH_FILE || DEFAULT_BATCH_FILE,
  plannedRevokedAt,
  expectedInputSha256,
  expectedPlannedSha256,
  currentUid = () => process.getuid?.(),
  randomId = () => crypto.randomBytes(8).toString('hex'),
  now = () => new Date(),
  fileSystem = nodeFileSystem,
} = {}) {
  assertRoot(currentUid);
  const exactRevokedAt = exactIso(plannedRevokedAt, 'PLANNED_REVOKED_AT_REQUIRED');
  const expectedInput = normalizeExpectedHash(
    expectedInputSha256,
    'EXPECTED_INPUT_SHA256_REQUIRED',
  );
  const expectedPlanned = normalizeExpectedHash(
    expectedPlannedSha256,
    'EXPECTED_PLANNED_SHA256_REQUIRED',
  );
  const original = await readBatchInput(batchFile, fileSystem);
  await assertRootOwnedBatchForWrite({
    batchFile,
    metadata: original.metadata,
    currentUid,
    fileSystem,
  });
  const plan = buildPlan(original, exactRevokedAt);
  if (plan.alreadyRevoked) throw fail('BATCH_ALREADY_REVOKED');
  if (plan.inputSha256 !== expectedInput) throw fail('BATCH_INPUT_DRIFT');
  if (plan.plannedSha256 !== expectedPlanned) throw fail('PLANNED_SHA256_MISMATCH');

  const { backupBasename } = await replaceBatchAtomically({
    batchFile,
    original,
    replacementBytes: plan.plannedBytes,
    replacementSha256: plan.plannedSha256,
    randomId,
    now,
    fileSystem,
  });

  return {
    ...plan,
    backupBasename,
  };
}

function takeValue(argv, index, argument) {
  const value = String(argv[index + 1] ?? '');
  if (!value || value.startsWith('--')) throw fail('ARGUMENT_VALUE_MISSING');
  return { value, nextIndex: index + 1 };
}

export function parseArguments(argv) {
  const options = {
    apply: false,
    batchFile: process.env.FULL_FM_STORE_LOGIN_BATCH_FILE || DEFAULT_BATCH_FILE,
    plannedRevokedAt: null,
    expectedInputSha256: null,
    expectedPlannedSha256: null,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (argument.includes('=')) throw fail('ARGUMENT_EQUALS_FORBIDDEN');
    if (!argument.startsWith('--')) throw fail('UNKNOWN_ARGUMENT');
    if (seen.has(argument)) throw fail('ARGUMENT_DUPLICATE');
    seen.add(argument);
    if (argument === '--apply') {
      options.apply = true;
      continue;
    }
    const taken = takeValue(argv, index, argument);
    index = taken.nextIndex;
    if (argument === '--batch-file') options.batchFile = path.resolve(taken.value);
    else if (argument === '--planned-revoked-at') options.plannedRevokedAt = taken.value;
    else if (argument === '--expected-input-sha256') options.expectedInputSha256 = taken.value;
    else if (argument === '--expected-planned-sha256') options.expectedPlannedSha256 = taken.value;
    else throw fail('UNKNOWN_ARGUMENT');
  }
  if (!options.apply && (options.expectedInputSha256 || options.expectedPlannedSha256)) {
    throw fail('APPLY_ARGUMENT_WITHOUT_APPLY');
  }
  if (options.plannedRevokedAt !== null) {
    exactIso(options.plannedRevokedAt, 'PLANNED_REVOKED_AT_INVALID');
  }
  if (options.expectedInputSha256 !== null) {
    normalizeExpectedHash(options.expectedInputSha256, 'EXPECTED_INPUT_SHA256_REQUIRED');
  }
  if (options.expectedPlannedSha256 !== null) {
    normalizeExpectedHash(options.expectedPlannedSha256, 'EXPECTED_PLANNED_SHA256_REQUIRED');
  }
  return options;
}

function publicResult(result, mode, backupBasename = null) {
  return {
    ok: true,
    mode,
    alreadyRevoked: result.alreadyRevoked,
    plannedRevokedAt: result.plannedRevokedAt,
    inputSha256: result.inputSha256,
    plannedSha256: result.plannedSha256,
    owner: {
      uid: result.metadata.uid,
      gid: result.metadata.gid,
      mode: result.metadata.mode.toString(8).padStart(4, '0'),
    },
    ...(backupBasename === null ? {} : { backupBasename }),
  };
}

function printResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.apply) {
    const result = await planRevocation({
      batchFile: options.batchFile,
      plannedRevokedAt: options.plannedRevokedAt,
    });
    printResult(publicResult(result, 'dry-run'));
    return;
  }
  const result = await applyRevocation({
    batchFile: options.batchFile,
    plannedRevokedAt: options.plannedRevokedAt,
    expectedInputSha256: options.expectedInputSha256,
    expectedPlannedSha256: options.expectedPlannedSha256,
  });
  printResult(publicResult(result, 'apply', result.backupBasename));
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/revoke_full_managed_store_login_batch.mjs')) {
  main().catch((error) => {
    printResult({
      ok: false,
      errorCode: controlledErrorCode(error, 'STORE_LOGIN_BATCH_REVOKE_FAILED'),
    });
    process.exitCode = 1;
  });
}
