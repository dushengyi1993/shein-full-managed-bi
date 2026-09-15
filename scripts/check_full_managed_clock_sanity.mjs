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
import path from 'node:path';
import { promisify } from 'node:util';
import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

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

// The kernel seeds the clock from the RTC as if it were UTC. A whole-hour
// positive jump therefore means the hypervisor handed us local time and the RTC
// must be read as local; a negative jump means it really was UTC.
export function localRtcForJump(jumpSeconds) {
  if (!Number.isFinite(jumpSeconds)) return null;
  if (jumpSeconds >= WHOLE_HOUR_SECONDS) return 'yes';
  if (jumpSeconds <= -WHOLE_HOUR_SECONDS) return 'no';
  return null;
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
  const initialEpoch = journal === null ? null : parseInitialClockEpoch(journal);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const jumpSeconds = initialEpoch === null ? null : initialEpoch - nowSeconds;
  const desiredLocalRtc = ntpSynced ? localRtcForJump(jumpSeconds) : null;
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
    jumpSeconds,
    localRtc,
    localRtcChanged,
    repairedStamps,
  }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({
      ok: false,
      event: 'clock-sanity-failed',
      errorCode: String(error?.code ?? 'CLOCK_SANITY_FAILED').slice(0, 80),
    }) + '\n');
    process.exitCode = 1;
  });
}
