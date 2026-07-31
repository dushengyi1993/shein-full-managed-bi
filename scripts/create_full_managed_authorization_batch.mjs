#!/usr/bin/env node

import crypto from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileAuthorizationStore, sha256 } from '../src/authorization/file-store.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    stateFile: process.env.FULL_AUTH_STATE_FILE
      || path.join(projectRoot, 'state', 'full-managed-authorization.json'),
    output: path.join(projectRoot, 'state', 'full-managed-authorization-batch.secret.json'),
    origin: process.env.FULL_AUTH_PUBLIC_ORIGIN || 'https://fm.dushengyi.cc',
    storesFile: path.join(projectRoot, 'config', 'stores.example.json'),
    entitiesFile: path.join(projectRoot, 'config', 'full-managed-legal-entities.json'),
    includeEntities: '',
    validHours: 24,
    label: '24 家全托店铺授权',
  };
  const names = new Set([
    '--state-file',
    '--output',
    '--origin',
    '--stores-file',
    '--entities-file',
    '--include-entities',
    '--valid-hours',
    '--label',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!names.has(name) || index + 1 >= argv.length) throw new Error(`Unknown or incomplete argument: ${name}`);
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    args[key] = argv[index + 1];
    index += 1;
  }
  args.stateFile = path.resolve(args.stateFile);
  args.output = path.resolve(args.output);
  args.storesFile = path.resolve(args.storesFile);
  args.validHours = Number(args.validHours);
  if (!Number.isSafeInteger(args.validHours) || args.validHours < 1 || args.validHours > 168) {
    throw new RangeError('--valid-hours must be an integer between 1 and 168.');
  }
  const origin = new URL(args.origin).origin;
  if (new URL(origin).protocol !== 'https:' && !new URL(origin).hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
    throw new Error('--origin must use HTTPS outside local development.');
  }
  args.origin = origin;
  return args;
}

async function loadStoreCodes(file) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  if (
    config?.schemaVersion !== 1 ||
    config?.cooperationMode !== 'FULL_MANAGED' ||
    !Array.isArray(config.stores)
  ) {
    throw new Error('Store inventory is not an isolated full-managed store file.');
  }
  const storeCodes = config.stores.map(({ storeCode }) => String(storeCode || '').toUpperCase());
  if (
    storeCodes.length === 0 ||
    new Set(storeCodes).size !== storeCodes.length ||
    storeCodes.some((storeCode) => !/^[A-Z0-9_-]{1,24}$/.test(storeCode))
  ) {
    throw new Error('Store inventory contains invalid or duplicate store codes.');
  }
  return storeCodes;
}

async function loadEntityRouting(file, availableStoreCodes, includeEntities) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  if (config?.schemaVersion !== 1 || !Array.isArray(config.entities)) {
    throw new Error('Legal-entity routing file is incompatible.');
  }
  const requested = String(includeEntities || '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const requestedSet = new Set(requested);
  if (requestedSet.size !== requested.length) {
    throw new Error('--include-entities contains duplicates.');
  }
  const knownEntities = new Set(config.entities.map((entity) => String(entity.entityKey || '').toUpperCase()));
  if (requested.some((entityKey) => !knownEntities.has(entityKey))) {
    throw new Error('--include-entities contains an unknown legal entity.');
  }
  const allowedStores = new Set(availableStoreCodes);
  const routes = {};
  for (const entity of config.entities) {
    const entityKey = String(entity.entityKey || '').toUpperCase();
    if (requested.length && !requestedSet.has(entityKey)) continue;
    if (!/^[A-Z0-9_-]{1,24}$/.test(entityKey) || !Array.isArray(entity.stores)) {
      throw new Error('Legal-entity routing contains an invalid entity.');
    }
    for (const rawStoreCode of entity.stores) {
      const storeCode = String(rawStoreCode || '').toUpperCase();
      if (!allowedStores.has(storeCode) || routes[storeCode]) {
        throw new Error('Legal-entity routing contains an invalid or duplicate store.');
      }
      routes[storeCode] = entityKey;
    }
  }
  if (!Object.keys(routes).length) throw new Error('Legal-entity routing selected no stores.');
  if (!requested.length && Object.keys(routes).length !== availableStoreCodes.length) {
    throw new Error('Legal-entity routing does not cover the store inventory.');
  }
  return routes;
}

async function writeSecret(file, payload) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, file);
  await chmod(file, 0o600).catch(() => {});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const availableStoreCodes = await loadStoreCodes(args.storesFile);
  const applicationStoreCodesByStore = await loadEntityRouting(
    args.entitiesFile,
    availableStoreCodes,
    args.includeEntities,
  );
  const storeCodes = availableStoreCodes.filter(
    (storeCode) => applicationStoreCodesByStore[storeCode],
  );
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + args.validHours * 60 * 60 * 1000);
  const token = crypto.randomBytes(32).toString('base64url');
  const batchId = crypto.randomUUID();
  const store = new FileAuthorizationStore({ file: args.stateFile });
  await store.createBatch({
    batchId,
    label: args.label,
    tokenHash: sha256(token),
    storeCodes,
    applicationStoreCodesByStore,
    createdAt,
    expiresAt,
  });
  await writeSecret(args.output, {
    schemaVersion: 1,
    sensitivity: 'CONFIDENTIAL_AUTHORIZATION_LINK',
    batchId,
    label: args.label,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    handoffUrl: `${args.origin}/authorize#${token}`,
    storeCodes,
    instructions: [
      'Only send handoffUrl to the designated full-managed operator.',
      'Do not send passwords, cookies, callback URLs, screenshots containing tokens, or this file.',
      'The operator signs in only on the official SHEIN authorization domain.',
    ],
  });
  console.log(JSON.stringify({
    ok: true,
    batchId,
    storeCount: storeCodes.length,
    expiresAt: expiresAt.toISOString(),
    stateFile: args.stateFile,
    handoffFile: args.output,
    handoffUrlPrinted: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
