import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CLOCK_TIMEZONE,
  clockSkewSeconds,
  futureStamps,
  localRtcForSkew,
  parseBootTimeEpoch,
  parseInitialClockEpoch,
} from '../../scripts/check_full_managed_clock_sanity.mjs';

const UNIT = 'infra/systemd/shein-fm-clock-sanity.service';

function read(relative) {
  return readFile(new URL('../../' + relative, import.meta.url), 'utf8');
}

test('boot clock jump is read from the kernel RTC seeding line', () => {
  const line = '2026-09-15T20:06:46+08:00 host kernel: rtc_cmos 00:03: setting system clock to 2026-09-15T12:06:37 UTC (1789473997)';
  assert.equal(parseInitialClockEpoch(line), 1789473997);
  assert.equal(parseInitialClockEpoch([line, line].join('\n')), 1789473997);
  assert.equal(parseInitialClockEpoch('no clock line here'), null);
  assert.equal(parseInitialClockEpoch(''), null);
});

test('the skew is measured against the true boot instant, not against now', () => {
  // Real fnOS boot: the kernel seeded 2026-09-15T12:06:37Z while the true boot
  // instant was 1789445197, i.e. exactly one +08:00 offset.
  const seeded = 1789473997;
  const bootTime = parseBootTimeEpoch('cpu  1 2 3\nbtime ' + 1789445197 + '\nprocesses 1');
  assert.equal(bootTime, 1789445197);
  assert.equal(clockSkewSeconds(seeded, bootTime), 28800);
  assert.equal(clockSkewSeconds(seeded, seeded + 18248), -18248);
  assert.equal(clockSkewSeconds(null, bootTime), null);
  assert.equal(clockSkewSeconds(seeded, null), null);
});

test('only a whole-hour boot skew changes the RTC interpretation', () => {
  assert.equal(localRtcForSkew(28800), 'yes');
  assert.equal(localRtcForSkew(-28800), 'no');
  assert.equal(localRtcForSkew(30), null);
  assert.equal(localRtcForSkew(-30), null);
  assert.equal(localRtcForSkew(Number.NaN), null);
});

test('only persistent timer stamps dated into the future are repaired', () => {
  const now = 1_800_000_000_000;
  const entries = [
    { name: 'stamp-shein-fm-system-health.timer', mtimeMs: now - 60_000 },
    { name: 'stamp-shein-fm-db-backup.timer', mtimeMs: now + 8 * 3600_000 },
    { name: 'stamp-apt-daily.timer', mtimeMs: now + 30 * 60_000 },
    { name: 'not-a-stamp', mtimeMs: now + 90 * 3600_000 },
    { name: 'stamp-broken.timer', mtimeMs: Number.NaN },
  ];
  assert.deepEqual(futureStamps(entries, now), ['stamp-shein-fm-db-backup.timer']);
});

test('clock sanity unit runs before timers, fixes nothing else and never retries itself', async () => {
  const unit = await read(UNIT);
  const lines = unit.split(/\r?\n/);
  assert.match(unit, /^Before=timers\.target$/m);
  assert.match(unit, /^DefaultDependencies=no$/m);
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^WorkingDirectory=\/opt\/shein-fm\/current$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node scripts\/check_full_managed_clock_sanity\.mjs$/m);
  assert.match(unit, /^TimeoutStartSec=45$/m);
  assert.match(unit, /^WantedBy=sysinit\.target$/m);
  assert.equal(lines.some((line) => line.startsWith('Restart=')), false);
  assert.equal(lines.some((line) => /^(User|Group)=/.test(line)), false);
  assert.equal(CLOCK_TIMEZONE, 'Asia/Shanghai');
});
