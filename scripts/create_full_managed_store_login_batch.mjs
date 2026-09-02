#!/usr/bin/env node

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertRootOwnedBatchForWrite,
  controlledErrorCode,
  nodeFileSystem,
  readBatchInput,
  replaceBatchAtomically,
  sha256Bytes,
} from './revoke_full_managed_store_login_batch.mjs';

const DEFAULT_BATCH_FILE = '/srv/shein-fm/secrets/store-login/batch.json';
const DEFAULT_ORIGIN = 'https://fm.dushengyi.cc';

function fail(code) {
  const error = new Error(code);
  error.controlled = true;
  return error;
}

function exactDate(value, errorCode) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw fail(errorCode);
  return date;
}

function validateExpiresHours(value) {
  if (!Number.isInteger(value) || value < 1 || value > 336) {
    throw fail('STORE_LOGIN_BATCH_ARGUMENT_INVALID');
  }
  return value;
}

function normalizePublicOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail('STORE_LOGIN_BATCH_ARGUMENT_INVALID');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.origin === 'null'
  ) {
    throw fail('STORE_LOGIN_BATCH_ARGUMENT_INVALID');
  }
  return url.origin;
}

function requireRoot(currentUid) {
  let uid;
  try {
    uid = currentUid();
  } catch {
    throw fail('ROOT_REQUIRED');
  }
  if (uid !== 0) throw fail('ROOT_REQUIRED');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function buildBatchUrl(publicOrigin, token) {
  return `${normalizePublicOrigin(publicOrigin)}/store-login#token=${encodeURIComponent(token)}`;
}

export function createBatch({
  now = new Date(),
  expiresHours = 168,
  randomBytes = crypto.randomBytes,
} = {}) {
  const exactNow = exactDate(now, 'CLOCK_INVALID');
  const exactExpiresHours = validateExpiresHours(expiresHours);
  let entropy;
  try {
    entropy = randomBytes(32);
  } catch {
    throw fail('TOKEN_GENERATION_FAILED');
  }
  if (!Buffer.isBuffer(entropy) || entropy.length !== 32) {
    throw fail('TOKEN_GENERATION_FAILED');
  }
  const token = entropy.toString('base64url');
  return Object.freeze({
    token,
    record: Object.freeze({
      version: 1,
      tokenHash: sha256(token),
      createdAt: exactNow.toISOString(),
      expiresAt: new Date(
        exactNow.valueOf() + exactExpiresHours * 3_600_000,
      ).toISOString(),
      revokedAt: null,
    }),
  });
}

function serializeRecord(record) {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export async function installBatch({
  batchFile = process.env.FULL_FM_STORE_LOGIN_BATCH_FILE || DEFAULT_BATCH_FILE,
  expiresHours = 168,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  randomId = () => crypto.randomBytes(8).toString('hex'),
  currentUid = () => process.getuid?.(),
  fileSystem = nodeFileSystem,
} = {}) {
  requireRoot(currentUid);
  let clockValue;
  try {
    clockValue = now();
  } catch {
    throw fail('CLOCK_INVALID');
  }
  const exactNow = exactDate(clockValue, 'CLOCK_INVALID');
  const original = await readBatchInput(batchFile, fileSystem);
  await assertRootOwnedBatchForWrite({
    batchFile,
    metadata: original.metadata,
    currentUid,
    fileSystem,
  });
  if (original.value.revokedAt === null && Date.parse(original.value.expiresAt) > exactNow.valueOf()) {
    throw fail('ACTIVE_BATCH_REPLACEMENT_FORBIDDEN');
  }

  const batch = createBatch({
    now: exactNow,
    expiresHours,
    randomBytes,
  });
  const replacementBytes = serializeRecord(batch.record);
  const replacementSha256 = sha256Bytes(replacementBytes);
  const { backupBasename } = await replaceBatchAtomically({
    batchFile,
    original,
    replacementBytes,
    replacementSha256,
    randomId,
    now: () => exactNow,
    fileSystem,
  });
  return {
    token: batch.token,
    record: batch.record,
    backupBasename,
    owner: {
      uid: original.metadata.uid,
      gid: original.metadata.gid,
      mode: original.metadata.mode,
    },
  };
}

export function parseArguments(argv, env = process.env) {
  const options = {
    batchFile: env.FULL_FM_STORE_LOGIN_BATCH_FILE || DEFAULT_BATCH_FILE,
    publicOrigin: normalizePublicOrigin(env.FULL_FM_PUBLIC_ORIGIN || DEFAULT_ORIGIN),
    expiresHours: 168,
  };
  const seen = new Set();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(String(argument));
    if (!match || seen.has(match[1])) throw fail('STORE_LOGIN_BATCH_ARGUMENT_INVALID');
    seen.add(match[1]);
    if (match[1] === 'batch-file') options.batchFile = path.resolve(match[2]);
    else if (match[1] === 'public-origin') options.publicOrigin = normalizePublicOrigin(match[2]);
    else if (match[1] === 'expires-hours') {
      options.expiresHours = validateExpiresHours(Number(match[2]));
    } else {
      throw fail('STORE_LOGIN_BATCH_ARGUMENT_INVALID');
    }
  }
  return options;
}

function printSuccess(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await installBatch({
    batchFile: options.batchFile,
    expiresHours: options.expiresHours,
  });
  printSuccess({
    ok: true,
    expiresAt: result.record.expiresAt,
    url: buildBatchUrl(options.publicOrigin, result.token),
    backupBasename: result.backupBasename,
    owner: {
      uid: result.owner.uid,
      gid: result.owner.gid,
      mode: result.owner.mode.toString(8).padStart(4, '0'),
    },
  });
}

if (
  process.argv[1]
  && path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      errorCode: controlledErrorCode(error, 'STORE_LOGIN_BATCH_FAILED'),
    })}\n`);
    process.exitCode = 1;
  });
}
