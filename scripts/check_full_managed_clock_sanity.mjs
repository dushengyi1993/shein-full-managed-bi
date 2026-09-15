#!/usr/bin/env node
/**
 * Boot-time clock sanity for the fnOS VM.
 *
 * The fnOS host feeds the guest RTC as local time while the guest reads it as
 * UTC, so the kernel starts about one time-zone offset ahead, NTP then jumps the
 * clock back, and any timer that armed during that window keeps a next elapse
 * computed from the wrong clock (observed: the hourly home/realtime timer waited
 * until 21:02 instead of 13:02 and skipped five runs).
 *
 * This unit runs before timers.target, waits briefly for NTP so the boot jump is
 * measurable, aligns the RTC interpretation with what the hypervisor actually
 * feeds the guest, pins the timezone, and repairs persistent timer stamps that
 * were written into the future. It only ever moves stamps backwards to now and
 * never triggers a catch-up run.
 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

export const CLOCK_TIMEZONE = 'Asia/Shanghai';
export const STAMP_DIR = '/var/lib/systemd/timers';
export const STAMP_FUTURE_TOLERANCE_MS = 60 * 60 * 1000;
export const WHOLE_HOUR_SECONDS = 3600;
export const NTP_WAIT_TIMEOUT_MS = 15_000;
export const NTP_POLL_INTERVAL_MS = 1_000;

export function parseInitialClockEpoch(journalText) {
  let found = null;
  for (const match of String(journalText).matchAll(/setting system clock to [^()]*\((\d{6,})\)/g)) {
    found = Number(match[1]);
  }
  return Number.isSafeInteger(found) ? found : null;
}

export function parseBootTimeEpoch(statText) {
  const match = String(statText).match(/^btime\s+(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

// The kernel seeds the clock from the RTC as if it were UTC, so that seed
// reading differs from the true boot instant (btime) by exactly the RTC
// misinterpretation. Comparing the seed against "now" would only measure
// uptime, so the true boot instant has to come from btime, which the corrected
// clock derives from monotonic uptime.
export function clockSkewSeconds(initialClockEpoch, bootTimeEpoch) {
  if (!Number.isSafeInteger(initialClockEpoch) || !Number.isSafeInteger(bootTimeEpoch)) return null;
  return initialClockEpoch - bootTimeEpoch;
}

// A whole-hour positive skew means the hypervisor handed us local time and the
// RTC must be read as local; a negative one means it really was UTC.
export function localRtcForSkew(skewSeconds) {
  if (!Number.isFinite(skewSeconds)) return null;
  if (skewSeconds >= WHOLE_HOUR_SECONDS) return 'yes';
  if (skewSeconds <= -WHOLE_HOUR_SECONDS) return 'no';
  return null;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export function futureStamps(entries, nowMs, toleranceMs = STAMP_FUTURE_TOLERANCE_MS) {
  return entries
    .filter((entry) => typeof entry?.name === 'string'
      && entry.name.startsWith('stamp-')
      && entry.name.endsWith('.timer')
      && Number.isFinite(entry.mtimeMs)
      && entry.mtimeMs > nowMs + toleranceMs)
    .map((entry) => entry.name)
    .sort();
}

async function tryRun(file, args, timeout = 15_000) {
  try {
    const { stdout } = await run(file, args, { encoding: 'utf8', timeout });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function waitForNtp(deadlineMs) {
  for (;;) {
    const synced = await tryRun('/usr/bin/timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], 5_000);
    if (synced === 'yes') return true;
    if (Date.now() >= deadlineMs) return false;
    await new Promise((resolve) => setTimeout(resolve, NTP_POLL_INTERVAL_MS));
  }
}

async function pinTimezone() {
  const current = await tryRun('/usr/bin/timedatectl', ['show', '-p', 'Timezone', '--value'], 5_000);
  if (current === CLOCK_TIMEZONE) return false;
  await tryRun('/usr/bin/timedatectl', ['set-timezone', CLOCK_TIMEZONE], 10_000);
  try { await writeFile('/etc/timezone', CLOCK_TIMEZONE + '\n', 'utf8'); } catch { /* best effort */ }
  return true;
}

async function repairStamps(nowMs) {
  let entries = [];
  try {
    const names = await readdir(STAMP_DIR);
    entries = await Promise.all(names.map(async (name) => {
      try {
        const info = await stat(`${STAMP_DIR}/${name}`);
        return { name, mtimeMs: info.mtimeMs };
      } catch { return { name, mtimeMs: Number.NaN }; }
    }));
  } catch { return []; }
  const repaired = [];
  for (const name of futureStamps(entries, nowMs)) {
    const seconds = nowMs / 1000;
    try {
      await utimes(`${STAMP_DIR}/${name}`, seconds, seconds);
      repaired.push(name);
    } catch { /* best effort */ }
  }
  return repaired;
}

async function main() {
  const startedAt = Date.now();
  const timezonePinned = await pinTimezone();
  const ntpSynced = await waitForNtp(startedAt + NTP_WAIT_TIMEOUT_MS);
  const journal = await tryRun('/usr/bin/journalctl', ['-b', '-k', '--no-pager', '-o', 'short-iso'], 15_000);
  const procStat = await tryRun('/usr/bin/cat', ['/proc/stat'], 5_000);
  const initialEpoch = journal === null ? null : parseInitialClockEpoch(journal);
  const bootEpoch = procStat === null ? null : parseBootTimeEpoch(procStat);
  const skewSeconds = clockSkewSeconds(initialEpoch, bootEpoch);
  const desiredLocalRtc = ntpSynced ? localRtcForSkew(skewSeconds) : null;
  let localRtc = await tryRun('/usr/bin/timedatectl', ['show', '-p', 'LocalRTC', '--value'], 5_000);
  let localRtcChanged = false;
  if (desiredLocalRtc !== null && desiredLocalRtc !== localRtc) {
    await tryRun('/usr/bin/timedatectl', ['set-local-rtc', desiredLocalRtc === 'yes' ? '1' : '0'], 10_000);
    localRtc = desiredLocalRtc;
    localRtcChanged = true;
  }
  const repairedStamps = await repairStamps(Date.now());
  process.stdout.write(JSON.stringify({
    ok: true,
    event: 'clock-sanity',
    timezone: CLOCK_TIMEZONE,
    timezonePinned,
    ntpSynced,
    initialClockEpoch: initialEpoch,
    bootTimeEpoch: bootEpoch,
    skewSeconds,
    localRtc,
    localRtcChanged,
    repairedStamps,
  }) + '\n');
}

if (isEntryPoint()) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({
      ok: false,
      event: 'clock-sanity-failed',
      errorCode: String(error?.code ?? 'CLOCK_SANITY_FAILED').slice(0, 80),
    }) + '\n');
    process.exitCode = 1;
  });
}
