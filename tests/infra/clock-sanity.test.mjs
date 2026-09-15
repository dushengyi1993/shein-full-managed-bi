import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CLOCK_TIMEZONE,
  futureStamps,
  localRtcForJump,
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

test('only a whole-hour boot jump changes the RTC interpretation', () => {
  assert.equal(localRtcForJump(28800), 'yes');
  assert.equal(localRtcForJump(-28800), 'no');
  assert.equal(localRtcForJump(30), null);
  assert.equal(localRtcForJump(-30), null);
  assert.equal(localRtcForJump(Number.NaN), null);
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
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/shein-fm\/current\/scripts\/check_full_managed_clock_sanity\.mjs$/m);
  assert.match(unit, /^TimeoutStartSec=45$/m);
  assert.match(unit, /^WantedBy=sysinit\.target$/m);
  assert.equal(lines.some((line) => line.startsWith('Restart=')), false);
  assert.equal(lines.some((line) => /^(User|Group)=/.test(line)), false);
  assert.equal(CLOCK_TIMEZONE, 'Asia/Shanghai');
});

