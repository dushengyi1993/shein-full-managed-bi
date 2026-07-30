#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BATCH_FILE = '/srv/shein-fm/secrets/store-login/batch.json';
const DEFAULT_ORIGIN = 'https://fm.dushengyi.cc';

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function createBatch({
  now = new Date(),
  expiresHours = 168,
  randomBytes = crypto.randomBytes,
} = {}) {
  const token = randomBytes(32).toString('base64url');
  return Object.freeze({
    token,
    record: Object.freeze({
      version: 1,
      tokenHash: sha256(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.valueOf() + expiresHours * 3_600_000).toISOString(),
      revokedAt: null,
    }),
  });
}

function parseArgs(argv) {
  const args = {
    batchFile: process.env.FULL_FM_STORE_LOGIN_BATCH_FILE || DEFAULT_BATCH_FILE,
    publicOrigin: process.env.FULL_FM_PUBLIC_ORIGIN || DEFAULT_ORIGIN,
    expiresHours: 168,
  };
  for (const token of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(token);
    if (!match) throw new Error('STORE_LOGIN_BATCH_ARGUMENT_INVALID');
    if (match[1] === 'batch-file') args.batchFile = path.resolve(match[2]);
    else if (match[1] === 'public-origin') args.publicOrigin = new URL(match[2]).origin;
    else if (match[1] === 'expires-hours') {
      args.expiresHours = Math.max(1, Math.min(336, Number(match[2])));
    } else throw new Error('STORE_LOGIN_BATCH_ARGUMENT_INVALID');
  }
  if (!Number.isFinite(args.expiresHours)) throw new Error('STORE_LOGIN_BATCH_ARGUMENT_INVALID');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const batch = createBatch({ expiresHours: args.expiresHours });
  await fs.mkdir(path.dirname(args.batchFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    args.batchFile,
    `${JSON.stringify(batch.record, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await fs.chmod(args.batchFile, 0o600);
  console.log(JSON.stringify({
    ok: true,
    expiresAt: batch.record.expiresAt,
    url: `${args.publicOrigin}/store-login#token=${batch.token}`,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, errorCode: error?.message || 'STORE_LOGIN_BATCH_FAILED' }));
    process.exitCode = 1;
  });
}
