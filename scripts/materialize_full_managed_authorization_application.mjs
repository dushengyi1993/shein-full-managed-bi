#!/usr/bin/env node

import crypto from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    input: path.join(projectRoot, 'config', 'full_managed_onboarding.secret.json'),
    output: path.join(projectRoot, 'state', 'full-managed-dl-application.secret.json'),
    store: 'DL',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!['--input', '--output', '--store'].includes(name) || index + 1 >= argv.length) {
      throw new Error(`Unknown or incomplete argument: ${name}`);
    }
    args[name.slice(2)] = argv[index + 1];
    index += 1;
  }
  args.input = path.resolve(args.input);
  args.output = path.resolve(args.output);
  args.store = String(args.store || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,24}$/.test(args.store)) throw new Error('--store is invalid.');
  if (!args.output.endsWith('.secret.json')) {
    throw new Error('--output must use an ignored *.secret.json filename.');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = JSON.parse(await readFile(args.input, 'utf8'));
  if (
    source?.schemaVersion !== 1 ||
    source?.cooperationMode !== 'FULL_MANAGED' ||
    !Array.isArray(source.applications)
  ) {
    throw new Error('Input is not an isolated full-managed onboarding file.');
  }
  const application = source.applications.find(
    (candidate) => String(candidate?.storeCode || '').toUpperCase() === args.store,
  );
  if (!application?.appId || !application?.appSecretKey) {
    throw new Error(`Application credentials are missing for ${args.store}.`);
  }
  const destination = {
    schemaVersion: 1,
    cooperationMode: 'FULL_MANAGED',
    applications: [{
      storeCode: args.store,
      appName: String(application.appName || '').trim() || `${args.store} 全托应用`,
      appId: application.appId,
      appSecretKey: application.appSecretKey,
      materializedAt: new Date().toISOString(),
    }],
  };
  await mkdir(path.dirname(args.output), { recursive: true, mode: 0o700 });
  const temporary = `${args.output}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(destination, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, args.output);
  await chmod(args.output, 0o600).catch(() => {});
  console.log(JSON.stringify({
    ok: true,
    applicationStoreCode: args.store,
    applicationCount: 1,
    authorizationsCopied: 0,
    output: args.output,
    credentialsPrinted: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
