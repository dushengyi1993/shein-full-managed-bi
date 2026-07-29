import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Fixed full-managed roots.
 *
 * These are the only roots a production run may ever touch. Overrides exist for
 * hermetic tests and are gated behind one explicit environment guard; see
 * `resolveMaintenanceRoot`.
 */
export const FULL_MANAGED_ROOTS = Object.freeze({
  backups: '/srv/shein-fm/backups',
  dbBackups: '/srv/shein-fm/backups/db',
  archive: '/lhcos-data/shein-fm-archive',
  releases: '/opt/shein-fm/releases',
  profiles: '/srv/shein-fm/webapi/profiles',
  runtime: '/srv/shein-fm/runtime',
  webapiLocks: '/srv/shein-fm/runtime/webapi-locks',
  proc: '/proc',
});

/** Paths that must never be touched, whatever a caller passes in. */
export const FORBIDDEN_PREFIXES = Object.freeze([
  '/opt/shein-bi',
  '/srv/shein-bi',
  '/lhcos-data/shein-bi-archive',
]);

/**
 * The single environment guard that unlocks root overrides.
 *
 * Without it every `--backup-dir` / `--archive-dir` / `--releases-dir` /
 * `--profiles-dir` / `--locks-dir` / `--proc-dir` / `--runtime-dir` flag is
 * refused, so a production invocation cannot be pointed at /tmp or /etc.
 */
export const TEST_ROOT_ENV = 'SHEIN_FM_MAINTENANCE_TEST_ROOT';

/** The COS archive must be a real cosfs mount, never a stray local directory. */
export const REQUIRED_ARCHIVE_FSTYPE = 'fuse.cosfs';

export class MaintenanceSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MaintenanceSafetyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MaintenanceSafetyError(code, message);
}

/** POSIX-normalize without touching the filesystem, so tests stay hermetic. */
export function normalizePosix(value) {
  const raw = String(value ?? '');
  if (raw === '') fail('PATH_EMPTY', 'path must not be empty');
  if (raw.includes('\0')) fail('PATH_NUL', 'path must not contain NUL');
  return path.posix.normalize(raw.replaceAll('\\', '/'));
}

/**
 * Assert a resolved path sits strictly inside one root.
 *
 * The root itself is rejected: every destructive caller deletes children only,
 * so accepting the root would allow removing the whole tree.
 */
export function assertInsideRoot(candidate, root) {
  const normalizedRoot = normalizePosix(root);
  const normalized = normalizePosix(candidate);
  for (const forbidden of FORBIDDEN_PREFIXES) {
    if (normalized === forbidden || normalized.startsWith(`${forbidden}/`)) {
      fail('PATH_SEMI_MANAGED', `refusing semi-managed path ${normalized}`);
    }
  }
  if (!normalized.startsWith(`${normalizedRoot}/`)) {
    fail('PATH_OUTSIDE_ROOT', `${normalized} is outside ${normalizedRoot}`);
  }
  const relative = normalized.slice(normalizedRoot.length + 1);
  if (relative === '' || relative.split('/').includes('..')) {
    fail('PATH_TRAVERSAL', `${normalized} escapes ${normalizedRoot}`);
  }
  return normalized;
}

/**
 * Resolve one maintenance root, honouring an override only under the test guard.
 *
 * Production roots are genuinely fixed: passing `--archive-dir=/tmp/x` without
 * `SHEIN_FM_MAINTENANCE_TEST_ROOT` is refused outright, and with the guard set
 * the override must still resolve strictly beneath that test root.
 */
export function resolveMaintenanceRoot(kind, override, {
  env = process.env,
} = {}) {
  if (!Object.hasOwn(FULL_MANAGED_ROOTS, kind)) {
    fail('ROOT_KIND_UNKNOWN', `unknown maintenance root ${kind}`);
  }
  const fixed = FULL_MANAGED_ROOTS[kind];
  if (override === undefined || override === null || override === '') return fixed;

  const testRoot = String(env[TEST_ROOT_ENV] ?? '');
  if (testRoot === '') {
    fail(
      'OVERRIDE_FORBIDDEN',
      `refusing --${kind} override: ${TEST_ROOT_ENV} is not set, so roots are fixed`,
    );
  }
  const normalizedTestRoot = normalizePosix(testRoot);
  // Absolute only, never relative. A POSIX root starts with `/`; a Windows
  // developer fixture starts with a drive letter. Both are accepted so hermetic
  // tests run on either platform, while a relative value is still refused.
  const isAbsolute = normalizedTestRoot.startsWith('/')
    || /^[A-Za-z]:\//.test(normalizedTestRoot);
  if (!isAbsolute) {
    fail('TEST_ROOT_RELATIVE', `${TEST_ROOT_ENV} must be an absolute path`);
  }
  // The override must live strictly beneath the declared test root, so a guard
  // set for one fixture cannot be reused to reach an unrelated directory.
  return assertInsideRoot(override, normalizedTestRoot);
}

/** A safe child name: no separators, no dot-walking, no control characters. */
export function assertSafeChildName(name) {
  const raw = String(name ?? '');
  if (raw === '' || raw === '.' || raw === '..') {
    fail('NAME_UNSAFE', `unsafe child name ${JSON.stringify(raw)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(raw)) {
    fail('NAME_UNSAFE', `unsafe child name ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * A filesystem error that proves the subject no longer exists.
 *
 * Only these may be skipped when probing /proc: a permission error means we
 * cannot prove the process is gone, so the caller must fail closed instead.
 */
export function isExitedProcessError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ESRCH';
}

export function isPermissionError(error) {
  return error?.code === 'EACCES' || error?.code === 'EPERM';
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * Verify the archive directory really is the mounted COS filesystem.
 *
 * Without this, an unmounted /lhcos-data would look like an empty local
 * directory: the copy would "succeed" onto the root disk and the verified local
 * dump would then be deleted, losing the only copy while freeing nothing.
 */
export async function assertCosfsMount(archiveDir, {
  runFindmnt = async (target) => {
    const { stdout } = await execFileAsync(
      'findmnt', ['-T', target, '-n', '-o', 'FSTYPE'],
    );
    return stdout;
  },
} = {}) {
  let output;
  try {
    output = await runFindmnt(archiveDir);
  } catch (error) {
    fail(
      'ARCHIVE_MOUNT_UNKNOWN',
      `findmnt could not resolve ${archiveDir}: ${error.message}`,
    );
  }
  const fstype = String(output ?? '').trim();
  if (fstype !== REQUIRED_ARCHIVE_FSTYPE) {
    fail(
      'ARCHIVE_NOT_COSFS',
      `${archiveDir} FSTYPE is ${JSON.stringify(fstype)}, expected ${REQUIRED_ARCHIVE_FSTYPE}`,
    );
  }
  return fstype;
}

/**
 * Exclusive host lock held for the lifetime of one maintenance run.
 *
 * Each tool takes its own named lock, so archive/retention never contends with
 * the database backup lock and cannot deadlock against it. A lock whose owning
 * process has exited is reclaimed once; anything else fails closed.
 */
export async function acquireMaintenanceLock(lockPath, { pid = process.pid } = {}) {
  const claim = async () => {
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid, at: new Date().toISOString() })}\n`);
    await handle.close();
  };
  try {
    await claim();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let holderPid = null;
    try {
      holderPid = JSON.parse(await readFile(lockPath, 'utf8'))?.pid ?? null;
    } catch {
      holderPid = null;
    }
    let holderAlive = true;
    if (Number.isSafeInteger(holderPid) && holderPid > 0) {
      try {
        // Signal 0 probes liveness without touching the process.
        process.kill(holderPid, 0);
      } catch (signalError) {
        holderAlive = !isExitedProcessError(signalError);
      }
    }
    if (holderAlive) {
      fail('LOCK_HELD', `another maintenance run holds ${lockPath}`);
    }
    await rm(lockPath, { force: true });
    await claim();
  }
  return {
    async release() {
      await rm(lockPath, { force: true });
    },
  };
}

/** A per-run partial name so two runs never collide on the same temporary. */
export function partialName(target, { pid = process.pid } = {}) {
  return `${target}.${pid}.${createHash('sha256')
    .update(`${pid}:${target}:${Date.now()}`)
    .digest('hex')
    .slice(0, 12)}.partial`;
}

/** UTC natural day for retention grouping; documented as UTC everywhere. */
export function utcDayKey(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.valueOf())) fail('INSTANT_INVALID', 'invalid instant');
  return date.toISOString().slice(0, 10);
}

/**
 * Classify a backup file name.
 *
 * `database` files are the only cleanup candidates. Edge and config backups are
 * left alone entirely, so an unrecognized name is never deleted.
 */
export function classifyBackupName(name) {
  const raw = String(name ?? '');
  if (/^shein-fm-\d{8}T\d{6}Z\.dump$/.test(raw)) {
    return { kind: 'database', variant: 'scheduled' };
  }
  if (/^shein-fm-(daily|deploy)-\d{8}T\d{6}Z\.dump$/.test(raw)) {
    return { kind: 'database', variant: raw.includes('-deploy-') ? 'deploy' : 'daily' };
  }
  if (/^pre-[A-Za-z0-9._-]+\.dump$/.test(raw)) {
    return { kind: 'database', variant: 'pre-deploy' };
  }
  return { kind: 'other', variant: 'unmanaged' };
}

/**
 * Deterministic retention selection.
 *
 * Keep the newest database dump for each of the most recent `retainDays` UTC
 * calendar days, then keep the `retainExtra` newest dumps still unkept so an
 * in-day deployment burst retains a short tail. Everything else is an archive
 * candidate. Non-database files are never candidates.
 */
export function selectBackupsForArchive(entries, {
  retainDays = 7,
  retainExtra = 3,
  now = Date.now(),
} = {}) {
  const database = [];
  const skipped = [];
  for (const entry of entries) {
    const classification = classifyBackupName(entry.name);
    if (classification.kind !== 'database') {
      skipped.push({ ...entry, reason: 'not-a-database-backup' });
      continue;
    }
    database.push({ ...entry, variant: classification.variant });
  }
  // Newest first; the name carries a UTC stamp, but mtime is authoritative.
  const ordered = [...database].sort((left, right) => (
    right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name)
  ));
  /* The window is the most recent `retainDays` UTC *calendar* days relative to
     `now`, not the most recent days that happen to contain a dump. Using
     observed days would retain a dump indefinitely whenever backups are sparse:
     a single 19-day-old dump would still occupy a "recent day" slot and never
     expire. */
  const retainedDays = [];
  for (let offset = 0; offset < retainDays; offset += 1) {
    retainedDays.push(utcDayKey(now - offset * 86_400_000));
  }
  const windowDays = new Set(retainedDays);
  const newestPerDay = new Map();
  for (const entry of ordered) {
    const day = utcDayKey(entry.modifiedAt);
    if (!windowDays.has(day)) continue;
    if (!newestPerDay.has(day)) newestPerDay.set(day, entry);
  }
  const keep = new Map();
  for (const [day, entry] of newestPerDay) {
    keep.set(entry.name, { ...entry, reason: `newest-for-${day}` });
  }
  let extra = 0;
  for (const entry of ordered) {
    if (keep.has(entry.name)) continue;
    if (extra >= retainExtra) break;
    extra += 1;
    keep.set(entry.name, { ...entry, reason: 'newest-additional' });
  }
  const candidates = ordered
    .filter((entry) => !keep.has(entry.name))
    .map((entry) => ({ ...entry, reason: 'expired-beyond-retention' }));
  return {
    keep: [...keep.values()],
    candidates,
    skipped,
    retainedDays,
  };
}

/** Parse `--flag` style arguments with an explicit allow-list. */
export function parseFlags(argv, allowed) {
  const flags = new Map();
  for (const token of argv) {
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(String(token));
    if (!match) fail('ARG_INVALID', `unsupported argument ${JSON.stringify(token)}`);
    const [, name, value] = match;
    if (!allowed.includes(name)) fail('ARG_UNKNOWN', `unknown flag --${name}`);
    if (flags.has(name)) fail('ARG_DUPLICATED', `duplicate flag --${name}`);
    flags.set(name, value ?? '');
  }
  return flags;
}

/** Bounded integer flag with an explicit range. */
export function boundedIntegerFlag(flags, name, fallback, minimum, maximum) {
  if (!flags.has(name)) return fallback;
  const raw = flags.get(name);
  if (!/^[0-9]{1,4}$/.test(raw)) {
    fail('ARG_INVALID', `--${name} must be an integer`);
  }
  const parsed = Number(raw);
  if (parsed < minimum || parsed > maximum) {
    fail('ARG_OUT_OF_RANGE', `--${name} out of range`);
  }
  return parsed;
}

/** Print one JSON line; never accepts secrets, so nothing needs redaction. */
export function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
