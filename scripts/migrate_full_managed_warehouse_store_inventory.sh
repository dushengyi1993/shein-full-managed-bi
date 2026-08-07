#!/usr/bin/env bash
set -Eeuo pipefail

umask 077
PATH=/usr/bin:/bin
export PATH
unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS NODE_PATH

if [[ "${EUID}" -ne 0 ]]; then
  printf '%s\n' '{"ok":false,"errorCode":"ROOT_REQUIRED"}' >&2
  exit 1
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
credentials_file="/srv/shein-fm/secrets/postgres.env"

if [[ "$(/usr/bin/systemctl is-active shein-fm-home-realtime.service 2>/dev/null || true)" != "inactive" ]] \
  || [[ "$(/usr/bin/systemctl is-active shein-fm-home-realtime.timer 2>/dev/null || true)" != "inactive" ]] \
  || [[ "$(/usr/bin/systemctl is-enabled shein-fm-home-realtime.timer 2>/dev/null || true)" != "disabled" ]]; then
  printf '%s\n' '{"ok":false,"errorCode":"REALTIME_COORDINATOR_MUST_BE_DISABLED"}' >&2
  exit 1
fi

exec /usr/bin/env -i PATH=/usr/bin:/bin \
  /usr/bin/node - \
  "${credentials_file}" \
  "${project_root}/scripts/migrate_full_managed_warehouse_store_inventory.mjs" \
  "$@" <<'NODE'
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

function fail(errorCode = 'DATABASE_OWNER_CREDENTIALS_UNSAFE') {
  process.stderr.write(`${JSON.stringify({ ok: false, errorCode })}\n`);
  process.exit(1);
}

try {
  const credentialsFile = process.argv[2];
  const migrationScript = process.argv[3];
  const migrationArguments = process.argv.slice(4);
  for (const directory of ['/srv', '/srv/shein-fm', '/srv/shein-fm/secrets']) {
    const metadata = fs.lstatSync(directory);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.uid !== 0
      || (metadata.mode & 0o022) !== 0
    ) fail();
  }

  const descriptor = fs.openSync(
    credentialsFile,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  let document;
  try {
    const metadata = fs.fstatSync(descriptor);
    if (
      !metadata.isFile()
      || metadata.uid !== 0
      || (metadata.mode & 0o027) !== 0
    ) fail();
    document = fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }

  const allowed = new Set([
    'POSTGRES_DB',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'SHEIN_FM_APP_DB_PASSWORD',
  ]);
  const values = new Map();
  for (const line of document.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Z0-9_]+)=([^\r\n]*)$/.exec(line);
    if (!match || !allowed.has(match[1]) || values.has(match[1])) fail();
    values.set(match[1], match[2]);
  }

  const database = values.get('POSTGRES_DB') || '';
  const username = values.get('POSTGRES_USER') || '';
  const password = values.get('POSTGRES_PASSWORD') || '';
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(database)
    || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(username)
    || password.length < 16
    || password.length > 4096
  ) fail();

  const url = new URL('postgresql://127.0.0.1:54330/');
  url.username = username;
  url.password = password;
  url.pathname = `/${database}`;

  const child = spawnSync(
    '/usr/bin/node',
    [migrationScript, ...migrationArguments],
    {
      stdio: 'inherit',
      env: {
        PATH: '/usr/bin:/bin',
        NODE_ENV: 'production',
        DATABASE_URL: url.href,
      },
    },
  );
  if (child.error || child.signal || !Number.isInteger(child.status)) {
    fail('WAREHOUSE_MIGRATION_LAUNCH_FAILED');
  }
  process.exit(child.status);
} catch {
  fail();
}
NODE
