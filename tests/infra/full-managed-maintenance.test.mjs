import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FORBIDDEN_PREFIXES,
  FULL_MANAGED_ROOTS,
  MaintenanceSafetyError,
  REQUIRED_ARCHIVE_FSTYPE,
  TEST_ROOT_ENV,
  assertCosfsMount,
  assertInsideRoot,
  assertSafeChildName,
  classifyBackupName,
  isExitedProcessError,
  isPermissionError,
  parseFlags,
  partialName,
  resolveMaintenanceRoot,
  selectBackupsForArchive,
  selectBackupsForLocalRetention,
  shanghaiDayKey,
  shanghaiIsoWeekKey,
  utcDayKey,
} from '../../scripts/lib/full_managed_maintenance.mjs';
import {
  selectReleasesForPruning,
  readActiveReleaseNames,
} from '../../scripts/prune_full_managed_releases.mjs';
import {
  CRITICAL_PERCENT,
  WARNING_PERCENT,
  classifyUsage,
  parseDfOutput,
  shouldReport,
} from '../../scripts/guard_full_managed_disk.mjs';
import {
  LATEST_BATCH_SQL,
  NEVER_PRUNE,
  PROJECTION_APPEND_ONLY_TRIGGERS,
  SNAPSHOT_TARGETS,
  SUPPLY_UNITS,
  planHash,
  selectPartitionsToDrop,
} from '../../scripts/maintain_full_managed_history.mjs';

/**
 * Deterministic tests for the full-managed maintenance safety boundaries.
 *
 * Every case below runs against exported pure helpers or injected roots. No test
 * touches a production path and none performs a destructive real operation.
 */

const DAY = 86_400_000;
const BASE = Date.parse('2026-07-29T02:00:00.000Z');

function dump(name, offsetDays, { hours = 0, bytes = 1024 } = {}) {
  return {
    name,
    bytes,
    modifiedAt: BASE - offsetDays * DAY + hours * 3_600_000,
  };
}

test('Shanghai backup keys follow the local business day and ISO week', () => {
  assert.equal(shanghaiDayKey('2026-08-04T15:59:59.000Z'), '2026-08-04');
  assert.equal(shanghaiDayKey('2026-08-04T16:00:00.000Z'), '2026-08-05');
  assert.equal(shanghaiIsoWeekKey('2026-08-03T00:00:00.000Z'), '2026-W32');
});

test('local backup retention keeps two dailies, four weekly points and one deploy', () => {
  const entries = [
    dump('shein-fm-daily-20260729T021500Z.dump', 0),
    dump('shein-fm-daily-20260728T021500Z.dump', 1),
    dump('shein-fm-daily-20260722T021500Z.dump', 7),
    dump('shein-fm-daily-20260715T021500Z.dump', 14),
    dump('shein-fm-daily-20260708T021500Z.dump', 21),
    dump('shein-fm-daily-20260701T021500Z.dump', 28),
    dump('shein-fm-deploy-20260729T101500Z.dump', 0, { hours: 1 }),
    dump('shein-fm-deploy-20260720T101500Z.dump', 9),
    dump('README.txt', 0),
  ];
  const selection = selectBackupsForLocalRetention(entries, {
    retainDaily: 2,
    retainWeekly: 4,
    retainDeploy: 1,
    now: BASE,
  });
  const kept = new Set(selection.keep.map(({ name }) => name));
  assert.deepEqual(kept, new Set([
    'shein-fm-daily-20260729T021500Z.dump',
    'shein-fm-daily-20260728T021500Z.dump',
    'shein-fm-daily-20260722T021500Z.dump',
    'shein-fm-daily-20260715T021500Z.dump',
    'shein-fm-daily-20260708T021500Z.dump',
    'shein-fm-deploy-20260729T101500Z.dump',
  ]));
  assert.deepEqual(
    selection.candidates.map(({ name }) => name).sort(),
    [
      'shein-fm-daily-20260701T021500Z.dump',
      'shein-fm-deploy-20260720T101500Z.dump',
    ],
  );
  assert.equal(selection.skipped[0].name, 'README.txt');
});

test('fixed roots stay full-managed and never reach a semi-managed path', () => {
  assert.equal(FULL_MANAGED_ROOTS.archive, '/lhcos-data/shein-fm-archive');
  assert.equal(FULL_MANAGED_ROOTS.releases, '/opt/shein-fm/releases');
  assert.equal(FULL_MANAGED_ROOTS.profiles, '/srv/shein-fm/webapi/profiles');
  assert.ok(FORBIDDEN_PREFIXES.includes('/lhcos-data/shein-bi-archive'));
  assert.ok(FORBIDDEN_PREFIXES.includes('/opt/shein-bi'));

  // The semi-managed archive is refused even when it is passed as the root.
  assert.throws(
    () => assertInsideRoot('/lhcos-data/shein-bi-archive/x.dump', '/lhcos-data/shein-bi-archive'),
    (error) => error.code === 'PATH_SEMI_MANAGED',
  );
  assert.throws(
    () => assertInsideRoot('/opt/shein-bi/releases/r1', '/opt/shein-bi/releases'),
    (error) => error.code === 'PATH_SEMI_MANAGED',
  );
});

test('path guards reject traversal, escapes and the bare root', () => {
  const root = FULL_MANAGED_ROOTS.releases;
  assert.equal(assertInsideRoot(`${root}/2026-07-01T00-00-00Z`, root), `${root}/2026-07-01T00-00-00Z`);
  // Traversal is normalized before comparison, so this really does escape.
  assert.throws(
    () => assertInsideRoot(`${root}/../../etc/passwd`, root),
    (error) => error.code === 'PATH_OUTSIDE_ROOT',
  );
  assert.throws(
    () => assertInsideRoot('/opt/shein-fm/releases-evil/r1', root),
    (error) => error.code === 'PATH_OUTSIDE_ROOT',
  );
  // The root itself is never a deletion candidate.
  assert.throws(
    () => assertInsideRoot(root, root),
    (error) => error.code === 'PATH_OUTSIDE_ROOT',
  );
  assert.throws(() => assertInsideRoot('', root), (error) => error.code === 'PATH_EMPTY');
  assert.throws(
    () => assertInsideRoot(`${root}/a\0b`, root),
    (error) => error.code === 'PATH_NUL',
  );

  for (const unsafe of ['', '.', '..', 'a/b', '../x', 'a b', 'x;rm', 'ünïcode']) {
    assert.throws(
      () => assertSafeChildName(unsafe),
      MaintenanceSafetyError,
      `expected rejection for ${JSON.stringify(unsafe)}`,
    );
  }
  assert.equal(assertSafeChildName('shein-fm-daily-20260729T021500Z.dump'),
    'shein-fm-daily-20260729T021500Z.dump');
});

test('only database dumps are cleanup candidates', () => {
  assert.deepEqual(classifyBackupName('shein-fm-20260729T021500Z.dump'),
    { kind: 'database', variant: 'scheduled' });
  assert.deepEqual(classifyBackupName('shein-fm-daily-20260729T021500Z.dump'),
    { kind: 'database', variant: 'daily' });
  assert.deepEqual(classifyBackupName('shein-fm-deploy-20260729T101500Z.dump'),
    { kind: 'database', variant: 'deploy' });
  assert.deepEqual(classifyBackupName('pre-v8-rollout.dump'),
    { kind: 'database', variant: 'pre-deploy' });

  // Edge and config backups must never be classified as prunable.
  for (const name of [
    'edge-nginx-20260729.tar.gz',
    'shein-fm-config-20260729.json',
    'notes.txt',
    'shein-bi-20260729T021500Z.dump',
  ]) {
    assert.equal(classifyBackupName(name).kind, 'other', name);
  }
});

test('retention keeps the newest dump per UTC day plus three extras', () => {
  // A deployment burst: four dumps today, one per day before that.
  const entries = [
    dump('shein-fm-deploy-20260729T090000Z.dump', 0, { hours: 7 }),
    dump('shein-fm-deploy-20260729T080000Z.dump', 0, { hours: 6 }),
    dump('shein-fm-deploy-20260729T070000Z.dump', 0, { hours: 5 }),
    dump('shein-fm-daily-20260729T021500Z.dump', 0),
    dump('shein-fm-daily-20260728T021500Z.dump', 1),
    dump('shein-fm-daily-20260727T021500Z.dump', 2),
    dump('shein-fm-daily-20260726T021500Z.dump', 3),
    dump('shein-fm-daily-20260725T021500Z.dump', 4),
    dump('shein-fm-daily-20260724T021500Z.dump', 5),
    dump('shein-fm-daily-20260723T021500Z.dump', 6),
    dump('shein-fm-daily-20260722T021500Z.dump', 7),
    dump('shein-fm-daily-20260721T021500Z.dump', 8),
    { name: 'edge-nginx-20260701.tar.gz', bytes: 10, modifiedAt: BASE - 30 * DAY },
  ];
  // `now` is pinned so the calendar window is deterministic.
  const selection = selectBackupsForArchive(entries, { now: BASE });

  // Seven retained calendar days, newest first.
  assert.equal(selection.retainedDays.length, 7);
  assert.equal(selection.retainedDays[0], '2026-07-29');
  assert.equal(selection.retainedDays.at(-1), '2026-07-23');

  const keptNames = selection.keep.map((entry) => entry.name).sort();
  // The newest dump of today wins its day; the other three same-day dumps are
  // the three "newest additional" retained copies.
  assert.ok(keptNames.includes('shein-fm-deploy-20260729T090000Z.dump'));
  assert.ok(keptNames.includes('shein-fm-deploy-20260729T080000Z.dump'));
  assert.ok(keptNames.includes('shein-fm-deploy-20260729T070000Z.dump'));
  assert.ok(keptNames.includes('shein-fm-daily-20260729T021500Z.dump'));
  assert.equal(selection.keep.length, 7 + 3);

  const candidateNames = selection.candidates.map((entry) => entry.name);
  assert.deepEqual(candidateNames, [
    'shein-fm-daily-20260722T021500Z.dump',
    'shein-fm-daily-20260721T021500Z.dump',
  ]);
  assert.ok(selection.candidates.every((entry) => entry.reason === 'expired-beyond-retention'));

  // The edge backup is skipped, never a candidate.
  assert.deepEqual(selection.skipped.map((entry) => entry.name), ['edge-nginx-20260701.tar.gz']);
  assert.ok(!candidateNames.includes('edge-nginx-20260701.tar.gz'));
});

test('retention never deletes everything when only one dump exists', () => {
  const selection = selectBackupsForArchive([
    dump('shein-fm-daily-20260729T021500Z.dump', 0),
  ], { now: BASE });
  assert.equal(selection.candidates.length, 0);
  assert.equal(selection.keep.length, 1);
});

test('a dump older than the calendar window expires even when backups are sparse', () => {
  // The only dumps are 19 and 24 days old. Grouping by "days that contain a
  // dump" would keep both forever; a calendar window expires both, while the
  // three newest-additional slots still hold a short recovery tail.
  const selection = selectBackupsForArchive([
    dump('shein-fm-daily-20260710T021500Z.dump', 19),
    dump('shein-fm-daily-20260705T021500Z.dump', 24),
  ], { now: BASE, retainExtra: 1 });
  assert.deepEqual(selection.retainedDays[0], '2026-07-29');
  assert.deepEqual(
    selection.keep.map((entry) => entry.name),
    ['shein-fm-daily-20260710T021500Z.dump'],
  );
  assert.equal(selection.keep[0].reason, 'newest-additional');
  assert.deepEqual(
    selection.candidates.map((entry) => entry.name),
    ['shein-fm-daily-20260705T021500Z.dump'],
  );
});

test('utc day grouping is stable across a Shanghai day boundary', () => {
  // 2026-07-29T00:30+08:00 is still 2026-07-28 in UTC; retention is documented
  // as UTC so grouping must not silently follow the local zone.
  assert.equal(utcDayKey('2026-07-28T16:30:00.000Z'), '2026-07-28');
  assert.equal(utcDayKey('2026-07-29T00:30:00.000Z'), '2026-07-29');
  assert.throws(() => utcDayKey('not-a-date'), (error) => error.code === 'INSTANT_INVALID');
});

test('flag parsing rejects unknown, duplicate and malformed arguments', () => {
  const flags = parseFlags(['--apply', '--retain-days=7'], ['apply', 'retain-days']);
  assert.equal(flags.get('apply'), '');
  assert.equal(flags.get('retain-days'), '7');

  assert.throws(() => parseFlags(['--nope'], ['apply']), (error) => error.code === 'ARG_UNKNOWN');
  assert.throws(
    () => parseFlags(['--apply', '--apply'], ['apply']),
    (error) => error.code === 'ARG_DUPLICATED',
  );
  assert.throws(() => parseFlags(['apply'], ['apply']), (error) => error.code === 'ARG_INVALID');
  // A bare `-rf` style argument is never silently accepted.
  assert.throws(() => parseFlags(['-rf'], ['apply']), (error) => error.code === 'ARG_INVALID');
});

/** A 40-hex release name, as produced by a Git commit hash. */
function hex(seed) {
  return String(seed).repeat(40).slice(0, 40);
}

test('release recency comes from mtime, because commit hashes are not ordered', () => {
  /* Production release directories are named after 40-hex commit hashes. Sorting
     those lexicographically has nothing to do with deployment order, so a
     name-sorted "newest five" would protect arbitrary releases and delete
     genuinely recent ones. Here the newest release sorts LAST by name and the
     oldest sorts FIRST, so a name-ordered implementation fails this test. */
  const releases = [
    { name: hex('a'), kind: 'release', modifiedAt: BASE - 40 * DAY },
    { name: hex('f'), kind: 'release', modifiedAt: BASE },
    { name: hex('b'), kind: 'release', modifiedAt: BASE - 1 * DAY },
    { name: hex('e'), kind: 'release', modifiedAt: BASE - 2 * DAY },
    { name: hex('c'), kind: 'release', modifiedAt: BASE - 3 * DAY },
    { name: hex('d'), kind: 'release', modifiedAt: BASE - 4 * DAY },
    { name: hex('9'), kind: 'release', modifiedAt: BASE - 30 * DAY },
  ];
  const selection = selectReleasesForPruning({
    releases,
    currentName: hex('f'),
    previousName: hex('b'),
    // The webhook receiver and worker still run from a much older release.
    activeNames: new Map([[hex('9'), [4021, 4022]]]),
    retainNewest: 5,
  });

  const protectedNames = selection.protected.map((entry) => entry.name);
  // The five newest by mtime: f, b, e, c, d.
  for (const seed of ['f', 'b', 'e', 'c', 'd']) {
    assert.ok(protectedNames.includes(hex(seed)), `${seed} must be protected`);
  }
  // Active-cwd protection is mandatory: this release is 30 days old and well
  // outside the newest five, so only the live process check can save it.
  assert.ok(protectedNames.includes(hex('9')));
  const active = selection.protected.find((entry) => entry.name === hex('9'));
  assert.ok(active.reasons.some((reason) => reason.startsWith('active-process-cwd:4021,4022')));

  // Only the genuinely idle oldest release is a candidate.
  assert.deepEqual(selection.candidates, [hex('a')]);
});

test('preflight temp dirs are prunable but never occupy a newest-five slot', () => {
  const releases = [
    { name: hex('f'), kind: 'release', modifiedAt: BASE - 10 * DAY },
    { name: hex('e'), kind: 'release', modifiedAt: BASE - 11 * DAY },
    // Newest by mtime, but a scratch directory must not protect a real release
    // out of the retention window.
    { name: 'preflight-deadbeef', kind: 'preflight', modifiedAt: BASE },
  ];
  const selection = selectReleasesForPruning({
    releases,
    currentName: hex('f'),
    previousName: null,
    activeNames: new Map(),
    retainNewest: 2,
  });
  const protectedNames = selection.protected.map((entry) => entry.name);
  assert.ok(protectedNames.includes(hex('f')));
  assert.ok(protectedNames.includes(hex('e')));
  assert.deepEqual(selection.candidates, ['preflight-deadbeef']);
});

test('release pruning records every protection reason for one release', () => {
  const selection = selectReleasesForPruning({
    releases: [
      { name: hex('3'), kind: 'release', modifiedAt: BASE },
      { name: hex('2'), kind: 'release', modifiedAt: BASE - DAY },
      { name: hex('1'), kind: 'release', modifiedAt: BASE - 2 * DAY },
    ],
    currentName: hex('3'),
    previousName: hex('2'),
    activeNames: new Map([[hex('3'), [99]]]),
    retainNewest: 1,
  });
  const current = selection.protected.find((entry) => entry.name === hex('3'));
  assert.deepEqual(current.reasons, ['current', 'newest-retained', 'active-process-cwd:99']);
  // With retainNewest=1 only hex('1') is unprotected; hex('2') is previous.
  assert.deepEqual(selection.candidates, [hex('1')]);
});

test('production roots are fixed unless the explicit test guard is set', () => {
  // Without the guard an override is refused outright, so a production
  // invocation cannot be pointed at /tmp or /etc.
  for (const kind of ['dbBackups', 'archive', 'releases', 'profiles', 'runtime', 'proc']) {
    assert.equal(resolveMaintenanceRoot(kind, undefined, { env: {} }), FULL_MANAGED_ROOTS[kind]);
    assert.throws(
      () => resolveMaintenanceRoot(kind, '/tmp/attacker', { env: {} }),
      (error) => error.code === 'OVERRIDE_FORBIDDEN',
      kind,
    );
  }
  assert.throws(
    () => resolveMaintenanceRoot('archive', '/etc', { env: {} }),
    (error) => error.code === 'OVERRIDE_FORBIDDEN',
  );

  // With the guard the override must still resolve strictly beneath it.
  const env = { [TEST_ROOT_ENV]: '/tmp/fm-fixture' };
  assert.equal(
    resolveMaintenanceRoot('archive', '/tmp/fm-fixture/archive', { env }),
    '/tmp/fm-fixture/archive',
  );
  assert.throws(
    () => resolveMaintenanceRoot('archive', '/tmp/elsewhere', { env }),
    (error) => error.code === 'PATH_OUTSIDE_ROOT',
  );
  // The guard cannot be used to reach a semi-managed path either.
  assert.throws(
    () => resolveMaintenanceRoot('archive', '/opt/shein-bi/x', { env: { [TEST_ROOT_ENV]: '/opt' } }),
    (error) => error.code === 'PATH_SEMI_MANAGED',
  );
  assert.throws(
    () => resolveMaintenanceRoot('archive', 'relative/path', { env: { [TEST_ROOT_ENV]: 'rel' } }),
    (error) => error.code === 'TEST_ROOT_RELATIVE',
  );
  assert.throws(
    () => resolveMaintenanceRoot('nonsense', undefined, { env: {} }),
    (error) => error.code === 'ROOT_KIND_UNKNOWN',
  );
});

test('the COS archive must be a real cosfs mount before anything is copied', async () => {
  // An unmounted /lhcos-data looks like an empty local directory: the copy would
  // succeed onto the root disk, verification would pass, and the only real copy
  // of the dump would then be deleted while freeing no space.
  await assert.rejects(
    () => assertCosfsMount('/lhcos-data/shein-fm-archive', {
      runFindmnt: async () => 'ext4\n',
    }),
    (error) => error.code === 'ARCHIVE_NOT_COSFS',
  );
  await assert.rejects(
    () => assertCosfsMount('/lhcos-data/shein-fm-archive', {
      runFindmnt: async () => '\n',
    }),
    (error) => error.code === 'ARCHIVE_NOT_COSFS',
  );
  await assert.rejects(
    () => assertCosfsMount('/lhcos-data/shein-fm-archive', {
      runFindmnt: async () => { throw new Error('findmnt: not found'); },
    }),
    (error) => error.code === 'ARCHIVE_MOUNT_UNKNOWN',
  );
  assert.equal(
    await assertCosfsMount('/lhcos-data/shein-fm-archive', {
      runFindmnt: async () => 'fuse.cosfs\n',
    }),
    'fuse.cosfs',
  );
  assert.equal(REQUIRED_ARCHIVE_FSTYPE, 'fuse.cosfs');
});

test('only a provably exited process may be skipped when probing /proc', () => {
  // A permission error means we cannot prove idleness, so callers must fail
  // closed rather than treat it as "no such process".
  assert.equal(isExitedProcessError({ code: 'ENOENT' }), true);
  assert.equal(isExitedProcessError({ code: 'ESRCH' }), true);
  assert.equal(isExitedProcessError({ code: 'EACCES' }), false);
  assert.equal(isExitedProcessError({ code: 'EPERM' }), false);
  assert.equal(isPermissionError({ code: 'EACCES' }), true);
  assert.equal(isPermissionError({ code: 'EPERM' }), true);
  assert.equal(isPermissionError({ code: 'ENOENT' }), false);
});

test('each maintenance tool takes its own lock so none can deadlock the backup', () => {
  // The archive, release and profile tools must never contend on the database
  // backup lock; a shared lock would deadlock the backup that invokes archiving.
  const locks = [
    'db-backup.lock',
    'backup-archive.lock',
    'release-prune.lock',
    'profile-cache-prune.lock',
  ];
  assert.equal(new Set(locks).size, locks.length);

  // Partial names are unique per run, so two runs never fight over one temp.
  const first = partialName('/lhcos-data/shein-fm-archive/x.dump', { pid: 111 });
  const second = partialName('/lhcos-data/shein-fm-archive/x.dump', { pid: 222 });
  assert.notEqual(first, second);
  assert.match(first, /\.111\.[0-9a-f]{12}\.partial$/);
  assert.match(second, /\.222\.[0-9a-f]{12}\.partial$/);
});

test('release pruning fails closed when process state cannot be read', async () => {
  // Without /proc there is no way to prove a release is idle.
  await assert.rejects(
    () => readActiveReleaseNames('/nonexistent-proc-for-test', '/opt/shein-fm/releases'),
    (error) => error.code === 'PROC_UNAVAILABLE',
  );
});

test('disk guard derives usage and classifies both thresholds', () => {
  assert.equal(WARNING_PERCENT, 75);
  assert.equal(CRITICAL_PERCENT, 85);

  // Real production reading: df reports 86%. ext4 reserves ~5% of blocks for
  // root, so used/total is only ~82.3% and would classify a critical
  // filesystem as a mere warning. The guard must match df's own Use%, which is
  // used / (used + available).
  const usage = parseDfOutput([
    'Filesystem     1024-blocks     Used Available Capacity Mounted on',
    '/dev/vda1         82836484 68150000  10486784      86% /',
  ].join('\n'));
  assert.equal(usage.totalKb, 82_836_484);
  assert.equal(usage.usedKb, 68_150_000);
  assert.equal(usage.capacityKb, 78_636_784);
  assert.equal(usage.usedPercent, 86.7);
  // The old used/total form produced 82.3 and hid this from ops.
  assert.notEqual(usage.usedPercent, 82.3);
  assert.equal(classifyUsage(usage.usedPercent), 'critical');

  assert.equal(classifyUsage(74.9), 'ok');
  assert.equal(classifyUsage(75), 'warning');
  assert.equal(classifyUsage(84.9), 'warning');
  assert.equal(classifyUsage(85), 'critical');
  assert.equal(classifyUsage(99.9), 'critical');

  for (const bad of ['', 'header only', 'Filesystem x\n/dev/vda1 abc def ghi 1% /']) {
    assert.throws(() => parseDfOutput(bad), (error) => error.code === 'DF_UNPARSEABLE');
  }
  assert.throws(
    () => parseDfOutput('h\n/dev/vda1 0 0 0 0% /'),
    (error) => error.code === 'DF_UNPARSEABLE',
  );
});

test('disk guard reports on severity change and then respects the cooldown', () => {
  const now = Date.parse('2026-07-29T02:00:00.000Z');
  // First observation of a warning always reports.
  assert.equal(shouldReport(null, 'warning', now, 60), true);
  // A sustained warning inside the cooldown stays quiet.
  const recent = { severity: 'warning', reportedAt: new Date(now - 30 * 60_000).toISOString() };
  assert.equal(shouldReport(recent, 'warning', now, 60), false);
  // Once the cooldown elapses it reports again.
  const stale = { severity: 'warning', reportedAt: new Date(now - 61 * 60_000).toISOString() };
  assert.equal(shouldReport(stale, 'warning', now, 60), true);
  // Escalation is never suppressed by a cooldown.
  assert.equal(shouldReport(recent, 'critical', now, 60), true);
  // Recovery is announced once, then stays quiet.
  assert.equal(shouldReport(recent, 'ok', now, 60), true);
  assert.equal(shouldReport({ severity: 'ok', reportedAt: null }, 'ok', now, 60), false);
  // A corrupt timestamp must not suppress reporting.
  assert.equal(shouldReport({ severity: 'warning', reportedAt: 'x' }, 'warning', now, 60), true);
});

test('history maintenance drops only partitions strictly older than the cutoff', () => {
  const partitions = [
    'reconciliation_daily_detail_20260701',
    'reconciliation_daily_detail_20260714',
    'reconciliation_daily_detail_20260715',
    'reconciliation_daily_detail_20260716',
    'reconciliation_daily_detail_20260729',
    // Not a daily detail partition; must never be selected.
    'reconciliation_daily_summary',
    'some_other_table',
  ];
  const dropped = selectPartitionsToDrop(partitions, '2026-07-15');
  assert.deepEqual(dropped, [
    'reconciliation_daily_detail_20260701',
    'reconciliation_daily_detail_20260714',
  ]);
  // The cutoff day itself is retained, so a mid-run boundary cannot lose today.
  assert.ok(!dropped.includes('reconciliation_daily_detail_20260715'));
  assert.ok(!dropped.some((name) => !name.startsWith('reconciliation_daily_detail_')));
});

test('the plan hash covers the exact candidate scope, including row counts', () => {
  const base = {
    schemaVersion: 2,
    retentionDays: 14,
    cutoff: '2026-07-15',
    partitionsToDrop: ['reconciliation_daily_detail_20260701'],
    targets: [{
      key: 'inventorySnapshot',
      table: 'fact.inventory_snapshot',
      candidateRows: 10,
      candidateFingerprint: 'a'.repeat(64),
    }],
    reclaim: false,
  };
  const original = planHash(base);
  assert.match(original, /^[0-9a-f]{64}$/);

  /* A changed candidate count MUST invalidate the hash. Ignoring row-count drift
     would let an operator review a 10-row plan and then execute a 999-row
     deletion under the same hash. */
  assert.notEqual(planHash({
    ...base,
    targets: [{ ...base.targets[0], candidateRows: 999 }],
  }), original);
  // A different candidate identity set also invalidates it, even at equal count.
  assert.notEqual(planHash({
    ...base,
    targets: [{ ...base.targets[0], candidateFingerprint: 'b'.repeat(64) }],
  }), original);

  // Partition order is normalized, so plan output ordering is not significant.
  assert.equal(planHash({
    ...base,
    partitionsToDrop: ['reconciliation_daily_detail_20260701'].reverse(),
  }), original);

  // Every other real decision invalidates the hash too.
  assert.notEqual(planHash({ ...base, retentionDays: 7 }), original);
  assert.notEqual(planHash({ ...base, cutoff: '2026-07-01' }), original);
  assert.notEqual(planHash({ ...base, reclaim: true }), original);
  assert.notEqual(planHash({ ...base, partitionsToDrop: [] }), original);
  assert.notEqual(planHash({
    ...base,
    targets: [{ ...base.targets[0], table: 'fact.delivery' }],
  }), original);
});

test('snapshot protection keys on the exact batch id the read path joins', () => {
  // The BI read path selects the latest batch per (store, domain, subtype) and
  // joins snapshots by source_fetch_batch_id. Protection must use that same key:
  // a timestamp comparison would delete a row the dashboard still reads whenever
  // two batches share an instant.
  assert.match(LATEST_BATCH_SQL, /PARTITION BY batch\.store_id, batch\.domain_code, batch\.subtype_code/);
  assert.match(LATEST_BATCH_SQL, /ORDER BY batch\.source_fetched_at DESC, batch\.supply_projection_batch_id DESC/);
  assert.match(LATEST_BATCH_SQL, /WHERE batch\.recency = 1/);

  const inventory = SNAPSHOT_TARGETS.find((entry) => entry.key === 'inventorySnapshot');
  assert.match(inventory.protectedPredicate, /latest_batch\.source_fetch_batch_id = target\.source_fetch_batch_id/);
  // Inventory is subtype specific: a PI batch must not protect a JI row.
  assert.match(inventory.protectedPredicate, /latest_batch\.subtype_code = target\.inventory_type_code/);
  assert.match(inventory.protectedPredicate, /domain_code = 'INVENTORY'/);

  const advice = SNAPSHOT_TARGETS.find((entry) => entry.key === 'stockAdviceSnapshot');
  assert.match(advice.protectedPredicate, /latest_batch\.source_fetch_batch_id = target\.source_fetch_batch_id/);
  assert.match(advice.protectedPredicate, /domain_code = 'STOCK_ADVICE'/);
  // Stock advice has no subtype dimension in the read path.
  assert.doesNotMatch(advice.protectedPredicate, /inventory_type_code/);

  for (const target of SNAPSHOT_TARGETS) {
    assert.doesNotMatch(
      target.protectedPredicate,
      /latest_batch\.source_fetched_at = target\.source_fetched_at/,
      'protection must not fall back to a timestamp comparison',
    );
  }
});

test('projection pruning lifts exactly the two append-only triggers, owner only', () => {
  assert.deepEqual(PROJECTION_APPEND_ONLY_TRIGGERS, [
    {
      table: 'fact.supply_projection_member',
      trigger: 'trg_fact_supply_projection_member_append_only',
    },
    {
      table: 'fact.supply_projection_batch',
      trigger: 'trg_fact_supply_projection_batch_append_only',
    },
  ]);
  // Members are listed before batches: the member references its batch, so the
  // child must be deleted first.
  assert.equal(PROJECTION_APPEND_ONLY_TRIGGERS[0].table.endsWith('_member'), true);
  assert.equal(PROJECTION_APPEND_ONLY_TRIGGERS[1].table.endsWith('_batch'), true);
  assert.equal(new Set(PROJECTION_APPEND_ONLY_TRIGGERS.map((t) => t.trigger)).size, 2);

  // The maintenance window is proven against the real supply units.
  assert.equal(SUPPLY_UNITS.service, 'shein-fm-supply-sync.service');
  assert.equal(SUPPLY_UNITS.timer, 'shein-fm-supply-sync.timer');
});

test('history maintenance targets only high-frequency snapshots', () => {
  assert.deepEqual(SNAPSHOT_TARGETS.map((entry) => entry.table), [
    'fact.inventory_snapshot',
    'fact.stock_advice_snapshot',
  ]);
  // Business-current and login state are explicitly out of scope.
  for (const table of [
    'fact.purchase_order',
    'fact.delivery',
    'dim.canonical_product',
    'mart.full_store_sales_latest',
    'ops.webapi_session_health',
  ]) {
    assert.ok(NEVER_PRUNE.includes(table), table);
    assert.ok(!SNAPSHOT_TARGETS.some((entry) => entry.table === table), table);
  }
});
