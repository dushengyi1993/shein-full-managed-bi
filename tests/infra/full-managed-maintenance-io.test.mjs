import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  CANONICAL_PROFILES,
  PROTECTED_LOGIN_STATE,
  REGENERABLE_CACHE_DIRS,
  fingerprintLoginState,
  readLeaseState,
  readProfileProcesses,
} from '../../scripts/prune_full_managed_profile_caches.mjs';
import { TEST_ROOT_ENV } from '../../scripts/lib/full_managed_maintenance.mjs';

const execFileAsync = promisify(execFile);
// `URL.pathname` percent-encodes spaces and keeps a leading slash on Windows
// drive paths, so the repository path must go through fileURLToPath.
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Filesystem-level tests for the destructive maintenance tools.
 *
 * Root overrides are only honoured under `SHEIN_FM_MAINTENANCE_TEST_ROOT`, and
 * every injected path below resolves strictly beneath that one temporary root.
 * No production path is referenced and no production data is ever touched.
 */

let workspace;

before(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'fm-maintenance-io-'));
});

after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

function posix(value) {
  return value.replaceAll('\\', '/');
}

/** Run a maintenance script under the test-root guard and capture its JSON. */
async function runScript(script, args, { guard = true } = {}) {
  const env = { ...process.env };
  if (guard) env[TEST_ROOT_ENV] = posix(workspace);
  else delete env[TEST_ROOT_ENV];
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(projectRoot, 'scripts', script), ...args],
      { cwd: projectRoot, env },
    );
    const line = stdout.trim().split('\n').at(-1);
    return { exitCode: 0, result: line ? JSON.parse(line) : null };
  } catch (error) {
    const stdout = String(error.stdout ?? '').trim();
    return {
      exitCode: error.code ?? 1,
      result: stdout === '' ? null : JSON.parse(stdout.split('\n').at(-1)),
    };
  }
}

async function makeBackupFixture(name) {
  const root = path.join(workspace, name);
  const backups = path.join(root, 'db');
  const archive = path.join(root, 'archive');
  const runtime = path.join(root, 'runtime');
  await mkdir(backups, { recursive: true });
  await mkdir(archive, { recursive: true });
  await mkdir(runtime, { recursive: true });
  return { backups, archive, runtime };
}

const DAY = 86_400_000;

/** Write a dump with an explicit mtime so retention is deterministic. */
async function writeDump(dir, name, contents, ageDays) {
  const target = path.join(dir, name);
  await writeFile(target, contents);
  const when = new Date(Date.now() - ageDays * DAY);
  await utimes(target, when, when);
  return target;
}

/** Archive arguments; `--skip-mount-check` is itself guard-gated. */
function archiveArgs({ backups, archive, runtime }, extra = []) {
  return [
    `--backup-dir=${posix(backups)}`,
    `--archive-dir=${posix(archive)}`,
    `--runtime-dir=${posix(runtime)}`,
    ...extra,
  ];
}

test('root overrides are refused without the explicit test guard', async () => {
  const fixture = await makeBackupFixture('guard-refused');
  await writeDump(fixture.backups, 'shein-fm-daily-20260729T021500Z.dump', 'today', 0);

  // Exactly how a production run would be attacked: point the tool at a
  // temporary directory. Without the guard env the override must be refused.
  const { exitCode, result } = await runScript(
    'archive_full_managed_backups.mjs',
    archiveArgs(fixture),
    { guard: false },
  );
  assert.equal(exitCode, 1);
  assert.equal(result.code, 'OVERRIDE_FORBIDDEN');

  // The same refusal applies to the release and profile tools.
  const releases = await runScript('prune_full_managed_releases.mjs', [
    `--releases-dir=${posix(path.join(workspace, 'guard-refused'))}`,
  ], { guard: false });
  assert.equal(releases.result.code, 'OVERRIDE_FORBIDDEN');
  const profiles = await runScript('prune_full_managed_profile_caches.mjs', [
    `--profiles-dir=${posix(path.join(workspace, 'guard-refused'))}`,
  ], { guard: false });
  assert.equal(profiles.result.code, 'OVERRIDE_FORBIDDEN');
});

test('an override outside the declared test root is still refused', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'fm-outside-'));
  try {
    const { exitCode, result } = await runScript('archive_full_managed_backups.mjs', [
      `--backup-dir=${posix(outside)}`,
    ]);
    assert.equal(exitCode, 1);
    assert.equal(result.code, 'PATH_OUTSIDE_ROOT');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test('archive apply refuses to run when the destination is not a cosfs mount', async () => {
  const fixture = await makeBackupFixture('mount-required');
  await writeDump(fixture.backups, 'shein-fm-daily-20260729T021500Z.dump', 'today', 0);
  const expired = 'shein-fm-daily-20260705T021500Z.dump';
  await writeDump(fixture.backups, expired, 'expired', 24);

  // Without --skip-mount-check the tool runs findmnt against the fixture, which
  // is an ordinary local directory rather than fuse.cosfs.
  const { exitCode, result } = await runScript(
    'archive_full_managed_backups.mjs',
    archiveArgs(fixture, ['--apply', '--retain-extra=0']),
  );
  assert.equal(exitCode, 1);
  assert.ok(
    ['ARCHIVE_NOT_COSFS', 'ARCHIVE_MOUNT_UNKNOWN'].includes(result.code),
    `unexpected code ${result.code}`,
  );
  // Fail closed before any copy or delete.
  assert.ok((await readdir(fixture.backups)).includes(expired));
  assert.deepEqual(await readdir(fixture.archive), []);
});

test('archive is plan-only by default and never deletes a local dump', async () => {
  const fixture = await makeBackupFixture('plan-default');
  await writeDump(fixture.backups, 'shein-fm-daily-20260729T021500Z.dump', 'today', 0);
  await writeDump(fixture.backups, 'shein-fm-daily-20260710T021500Z.dump', 'old', 19);

  const { exitCode, result } = await runScript(
    'archive_full_managed_backups.mjs',
    // Without this the 19-day-old dump is legitimately retained as part of the
    // three newest-additional copies, and there would be no candidate at all.
    archiveArgs(fixture, ['--retain-extra=0']),
  );
  assert.equal(exitCode, 0);
  assert.equal(result.mode, 'plan');
  assert.deepEqual(result.candidates.map((entry) => entry.name),
    ['shein-fm-daily-20260710T021500Z.dump']);

  // Plan mode is inert: both dumps survive and the archive stays empty.
  assert.equal((await readdir(fixture.backups)).length, 2);
  assert.deepEqual(await readdir(fixture.archive), []);
});

test('apply archives with size and hash proof before deleting the source', async () => {
  const fixture = await makeBackupFixture('apply-verified');
  await writeDump(fixture.backups, 'shein-fm-daily-20260729T021500Z.dump', 'keep-today', 0);
  const expired = 'shein-fm-daily-20260705T021500Z.dump';
  await writeDump(fixture.backups, expired, 'expired-payload', 24);

  const { exitCode, result } = await runScript(
    'archive_full_managed_backups.mjs',
    archiveArgs(fixture, ['--apply', '--retain-extra=0', '--skip-mount-check']),
  );
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.mode, 'apply');
  assert.equal(result.archivedCount, 1);

  const archived = path.join(fixture.archive, expired);
  assert.equal((await stat(archived)).size, Buffer.byteLength('expired-payload'));
  const manifest = JSON.parse(await readFile(`${archived}.manifest.json`, 'utf8'));
  assert.equal(manifest.sourceName, expired);
  assert.equal(manifest.bytes, Buffer.byteLength('expired-payload'));
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/);

  // Only then is the local source removed; the retained dump is untouched.
  assert.deepEqual(await readdir(fixture.backups), ['shein-fm-daily-20260729T021500Z.dump']);
  // No partial object is left behind, and the run lock is released.
  assert.ok(!(await readdir(fixture.archive)).some((name) => name.endsWith('.partial')));
  assert.ok(!(await readdir(fixture.runtime)).includes('backup-archive.lock'));
});

test('an archive conflict fails closed and keeps the local dump', async () => {
  const fixture = await makeBackupFixture('conflict');
  await writeDump(fixture.backups, 'shein-fm-daily-20260729T021500Z.dump', 'today', 0);
  const expired = 'shein-fm-daily-20260706T021500Z.dump';
  await writeDump(fixture.backups, expired, 'authentic-payload', 23);
  // A same-named object with different content already exists in the archive.
  await writeFile(path.join(fixture.archive, expired), 'DIFFERENT-CONTENT');

  const { exitCode, result } = await runScript(
    'archive_full_managed_backups.mjs',
    archiveArgs(fixture, ['--apply', '--retain-extra=0', '--skip-mount-check']),
  );
  assert.equal(exitCode, 1);
  assert.equal(result.code, 'ARCHIVE_CONFLICT');

  // Fail closed: the local dump must still be byte-identical.
  assert.equal(await readFile(path.join(fixture.backups, expired), 'utf8'), 'authentic-payload');
  // The lock is released even on the failure path.
  assert.ok(!(await readdir(fixture.runtime)).includes('backup-archive.lock'));
});

test('replaying an identical archive is idempotent and still removes the source', async () => {
  const fixture = await makeBackupFixture('replay');
  await writeDump(fixture.backups, 'shein-fm-daily-20260729T021500Z.dump', 'today', 0);
  const expired = 'shein-fm-daily-20260707T021500Z.dump';
  await writeDump(fixture.backups, expired, 'same-bytes', 22);
  // The archive already holds a byte-identical object from an interrupted run.
  await writeFile(path.join(fixture.archive, expired), 'same-bytes');

  const { exitCode, result } = await runScript(
    'archive_full_managed_backups.mjs',
    archiveArgs(fixture, ['--apply', '--retain-extra=0', '--skip-mount-check']),
  );
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.archived[0].replayed, true);
  assert.ok(!(await readdir(fixture.backups)).includes(expired));
});

test('a held archive lock stops a concurrent run', async () => {
  const fixture = await makeBackupFixture('locked');
  await writeDump(fixture.backups, 'shein-fm-daily-20260729T021500Z.dump', 'today', 0);
  await writeDump(fixture.backups, 'shein-fm-daily-20260708T021500Z.dump', 'old', 21);
  // A live process (this test runner) already owns the lock.
  await writeFile(
    path.join(fixture.runtime, 'backup-archive.lock'),
    `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
  );

  const { exitCode, result } = await runScript(
    'archive_full_managed_backups.mjs',
    archiveArgs(fixture, ['--apply', '--retain-extra=0', '--skip-mount-check']),
  );
  assert.equal(exitCode, 1);
  assert.equal(result.code, 'LOCK_HELD');
  assert.ok((await readdir(fixture.backups)).includes('shein-fm-daily-20260708T021500Z.dump'));
});

test('the Profile allow-list covers only regenerable caches', () => {
  assert.equal(CANONICAL_PROFILES.length, 24);
  assert.ok(CANONICAL_PROFILES.includes('persistent-dl5477-profile'));
  assert.ok(CANONICAL_PROFILES.includes('persistent-mz2406-profile'));
  assert.ok(CANONICAL_PROFILES.includes('persistent-dx2420-profile'));
  assert.deepEqual(REGENERABLE_CACHE_DIRS, [
    'cache',
    'component_crx_cache',
    'Profile 1/Cache',
    'Profile 1/Code Cache',
    'Profile 1/GPUCache',
    'Profile 1/Service Worker/CacheStorage',
  ]);
  // Every protected artifact, including both Login Data For Account variants.
  for (const critical of [
    'Profile 1/Cookies',
    'Profile 1/Cookies-journal',
    'Profile 1/Login Data',
    'Profile 1/Login Data-journal',
    'Profile 1/Login Data For Account',
    'Profile 1/Login Data For Account-journal',
    'Profile 1/Web Data',
    'Profile 1/Web Data-journal',
    'Profile 1/Local Storage',
    'Profile 1/IndexedDB',
    'Profile 1/Sessions',
  ]) {
    assert.ok(PROTECTED_LOGIN_STATE.includes(critical), critical);
    assert.ok(!REGENERABLE_CACHE_DIRS.includes(critical), critical);
  }
});

test('any entry of any type in the lock directory blocks pruning', async () => {
  const base = path.join(workspace, 'lease-states');
  const cases = [
    ['lease-json', 'file', 'dl5477.json', JSON.stringify({ profile: 'x' }), 'leases'],
    ['lease-broken', 'file', 'dl5477.json', '{not json', 'unparseable'],
    ['lease-unknown-ext', 'file', 'mystery.pid', '4021', 'unparseable'],
  ];
  for (const [name, , fileName, contents, bucket] of cases) {
    const dir = path.join(base, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, fileName), contents);
    const state = await readLeaseState(posix(dir));
    assert.equal(state[bucket].length, 1, name);
  }

  // A subdirectory is still coordination evidence and must not be ignored.
  const withDir = path.join(base, 'lease-subdir');
  await mkdir(path.join(withDir, 'stale-lease.d'), { recursive: true });
  const dirState = await readLeaseState(posix(withDir));
  assert.deepEqual(dirState.unparseable, ['stale-lease.d']);

  // A missing lock directory is genuinely idle.
  assert.deepEqual(
    await readLeaseState(posix(path.join(base, 'absent'))),
    { leases: [], unparseable: [] },
  );
});

test('Profile pruning refuses when it cannot inspect processes', async () => {
  await assert.rejects(
    () => readProfileProcesses('/nonexistent-proc-for-test', '/srv/shein-fm/webapi/profiles'),
    (error) => error.code === 'PROC_UNAVAILABLE',
  );
});

test('an active lease stops Profile pruning before any deletion', async () => {
  const root = path.join(workspace, 'profiles-leased');
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'persistent-dl5477-profile');
  const cacheDir = path.join(profileDir, 'Profile 1', 'Cache');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, 'entry.bin'), 'cached');
  const cookies = path.join(profileDir, 'Profile 1', 'Cookies');
  await writeFile(cookies, 'session-state');

  const locks = path.join(root, 'locks');
  await mkdir(locks, { recursive: true });
  await writeFile(path.join(locks, 'dl5477.json'),
    JSON.stringify({ profile: 'persistent-dl5477-profile' }));

  const { exitCode, result } = await runScript('prune_full_managed_profile_caches.mjs', [
    '--apply',
    `--profiles-dir=${posix(profilesDir)}`,
    `--locks-dir=${posix(locks)}`,
    `--runtime-dir=${posix(root)}`,
  ]);
  assert.equal(exitCode, 1);
  assert.equal(result.code, 'LEASE_ACTIVE');

  // Nothing was removed, including the regenerable cache.
  assert.equal(await readFile(path.join(cacheDir, 'entry.bin'), 'utf8'), 'cached');
  assert.equal(await readFile(cookies, 'utf8'), 'session-state');
});

/** Build a complete Profile fixture with caches and protected state. */
async function makeProfileFixture(name) {
  const root = path.join(workspace, name);
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'persistent-dl5477-profile');
  for (const relative of REGENERABLE_CACHE_DIRS) {
    const target = path.join(profileDir, ...relative.split('/'));
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'entry.bin'), `cached-${relative}`);
  }
  for (const relative of [
    'Profile 1/Cookies', 'Profile 1/Login Data',
    'Profile 1/Login Data For Account-journal', 'Profile 1/Web Data',
  ]) {
    const target = path.join(profileDir, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `state-${relative}`);
  }
  // Nested LevelDB state inside the protected directories.
  for (const relative of ['Profile 1/Local Storage', 'Profile 1/IndexedDB', 'Profile 1/Sessions']) {
    const nested = path.join(profileDir, ...relative.split('/'), 'leveldb');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, '000003.log'), `db-${relative}`);
    await writeFile(path.join(nested, 'CURRENT'), 'MANIFEST-000001\n');
  }
  const unknownDir = path.join(profileDir, 'Profile 1', 'Extension State');
  await mkdir(unknownDir, { recursive: true });
  await writeFile(path.join(unknownDir, 'keep.bin'), 'unknown-state');

  const locks = path.join(root, 'locks');
  await mkdir(locks, { recursive: true });
  const fakeProc = path.join(root, 'proc');
  await mkdir(fakeProc, { recursive: true });
  return { root, profilesDir, profileDir, locks, fakeProc, unknownDir };
}

test('idle Profile pruning removes caches and preserves nested login state', async () => {
  const fixture = await makeProfileFixture('profiles-idle');

  const { exitCode, result } = await runScript('prune_full_managed_profile_caches.mjs', [
    '--apply',
    `--profiles-dir=${posix(fixture.profilesDir)}`,
    `--locks-dir=${posix(fixture.locks)}`,
    `--proc-dir=${posix(fixture.fakeProc)}`,
    `--runtime-dir=${posix(fixture.root)}`,
  ]);
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.profiles[0].loginStateVerified, true);
  assert.deepEqual(result.profiles[0].removed.sort(), [...REGENERABLE_CACHE_DIRS].sort());
  // The fingerprint covers nested files, not just the directory entries.
  assert.ok(result.profiles[0].loginStateEntries > PROTECTED_LOGIN_STATE.length);

  for (const relative of REGENERABLE_CACHE_DIRS) {
    await assert.rejects(() => stat(path.join(fixture.profileDir, ...relative.split('/'))));
  }
  for (const relative of [
    'Profile 1/Cookies', 'Profile 1/Login Data',
    'Profile 1/Login Data For Account-journal', 'Profile 1/Web Data',
  ]) {
    assert.equal(
      await readFile(path.join(fixture.profileDir, ...relative.split('/')), 'utf8'),
      `state-${relative}`,
    );
  }
  for (const relative of ['Profile 1/Local Storage', 'Profile 1/IndexedDB', 'Profile 1/Sessions']) {
    assert.equal(
      await readFile(
        path.join(fixture.profileDir, ...relative.split('/'), 'leveldb', '000003.log'),
        'utf8',
      ),
      `db-${relative}`,
    );
  }
  assert.equal(await readFile(path.join(fixture.unknownDir, 'keep.bin'), 'utf8'), 'unknown-state');
});

test('the recursive fingerprint detects a mutated nested protected file', async () => {
  const fixture = await makeProfileFixture('profiles-fingerprint');
  const before = await fingerprintLoginState(posix(fixture.profileDir));

  // Directory presence is unchanged; only a nested LevelDB file differs. A
  // presence-only fingerprint would call this identical and miss the mutation.
  const nested = path.join(
    fixture.profileDir, 'Profile 1', 'Local Storage', 'leveldb', '000003.log',
  );
  await writeFile(nested, 'db-Profile 1/Local Storage-MUTATED');
  const afterMutation = await fingerprintLoginState(posix(fixture.profileDir));
  assert.notDeepEqual(before, afterMutation);

  // Deleting a nested file is detected too.
  await rm(path.join(fixture.profileDir, 'Profile 1', 'IndexedDB', 'leveldb', 'CURRENT'));
  const afterDeletion = await fingerprintLoginState(posix(fixture.profileDir));
  assert.notDeepEqual(afterMutation, afterDeletion);

  // Every nested file contributes a path, size and hash.
  const nestedEntry = before.find((entry) => entry.path.endsWith('leveldb/000003.log'));
  assert.equal(nestedEntry.kind, 'file');
  assert.match(nestedEntry.sha256, /^[0-9a-f]{64}$/);
  assert.ok(nestedEntry.bytes > 0);
});

test('release pruning is plan-only by default and reads recency from mtime', async () => {
  const root = path.join(workspace, 'releases-plan');
  const releasesDir = path.join(root, 'releases');
  // 40-hex commit hashes: the newest sorts LAST by name, so a name-ordered
  // implementation would protect the wrong five.
  const seeds = ['a', 'f', 'b', 'e', 'c', 'd', '9'];
  const ages = [40, 0, 1, 2, 3, 4, 30];
  const names = [];
  for (const [index, seed] of seeds.entries()) {
    const name = String(seed).repeat(40).slice(0, 40);
    names.push(name);
    const dir = path.join(releasesDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'marker.txt'), name);
    const when = new Date(Date.now() - ages[index] * DAY);
    await utimes(dir, when, when);
  }
  // A preflight scratch directory: prunable, never a newest-five slot.
  const preflight = path.join(releasesDir, 'preflight-deadbeef');
  await mkdir(preflight, { recursive: true });

  const newest = String('f').repeat(40).slice(0, 40);
  const previous = String('b').repeat(40).slice(0, 40);
  await symlink(path.join(releasesDir, newest), path.join(root, 'current'), 'junction');
  await symlink(path.join(releasesDir, previous), path.join(root, 'previous'), 'junction');
  const fakeProc = path.join(root, 'proc');
  await mkdir(fakeProc, { recursive: true });

  const { exitCode, result } = await runScript('prune_full_managed_releases.mjs', [
    `--releases-dir=${posix(releasesDir)}`,
    `--proc-dir=${posix(fakeProc)}`,
    `--runtime-dir=${posix(root)}`,
  ]);
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.mode, 'plan');
  assert.equal(result.currentName, newest);
  assert.equal(result.previousName, previous);
  // Oldest two stable releases plus the preflight scratch directory.
  assert.deepEqual(result.candidates.sort(), [
    String('9').repeat(40).slice(0, 40),
    String('a').repeat(40).slice(0, 40),
    'preflight-deadbeef',
  ].sort());

  // Plan mode removed nothing.
  assert.equal((await readdir(releasesDir)).length, names.length + 1);
});

test('release pruning fails closed when current cannot be resolved', async () => {
  const root = path.join(workspace, 'releases-no-current');
  const releasesDir = path.join(root, 'releases');
  await mkdir(path.join(releasesDir, String('a').repeat(40)), { recursive: true });
  const fakeProc = path.join(root, 'proc');
  await mkdir(fakeProc, { recursive: true });

  // No `current` symlink: we cannot know which release is protected.
  const { exitCode, result } = await runScript('prune_full_managed_releases.mjs', [
    `--releases-dir=${posix(releasesDir)}`,
    `--proc-dir=${posix(fakeProc)}`,
    `--runtime-dir=${posix(root)}`,
  ]);
  assert.equal(exitCode, 1);
  assert.equal(result.code, 'POINTER_UNRESOLVED');
});

test('the post-deploy helper probes the Portal port, not the Nginx port', async () => {
  const script = await readFile(
    path.join(projectRoot, 'scripts', 'post_deploy_prune_releases.sh'),
    'utf8',
  );
  // The Portal listens on 8788; 8081 is the Nginx terminator.
  assert.match(script, /FULL_BI_HEALTH_URL:-http:\/\/127\.0\.0\.1:8788\/health/);
  assert.doesNotMatch(script, /127\.0\.0\.1:8080/);
  assert.doesNotMatch(script, /127\.0\.0\.1:8081/);
  assert.match(script, /"status":"ok"/);
});
