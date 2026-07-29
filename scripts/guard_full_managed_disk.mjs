#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  MaintenanceSafetyError,
  TEST_ROOT_ENV,
  boundedIntegerFlag,
  emit,
  parseFlags,
  resolveMaintenanceRoot,
} from './lib/full_managed_maintenance.mjs';

const execFileAsync = promisify(execFile);

/**
 * Root filesystem pressure guard.
 *
 * This tool observes and reports only: it never scans, prunes or deletes
 * anything. Warning at 75% is journal-visible but exits 0; critical at 85% exits
 * non-zero so the systemd unit is visibly failed for ops. A cooldown keeps a
 * sustained warning from writing a journal line every 15 minutes, while a
 * severity change always reports immediately.
 */

export const WARNING_PERCENT = 75;
export const CRITICAL_PERCENT = 85;
const FLAGS = ['runtime-dir', 'filesystem', 'cooldown-minutes', 'df-output'];

/**
 * Parse `df -P -k <fs>` output.
 *
 * The percentage matches df's own `Use%`, which is used / (used + available).
 * Dividing by the raw total would silently under-report pressure, because ext4
 * reserves ~5% of blocks for root: at df 86% a used/total ratio reads ~82%, so a
 * critical filesystem would still be classified as a warning.
 */
export function parseDfOutput(output) {
  const lines = String(output ?? '').trim().split('\n');
  if (lines.length < 2) {
    throw new MaintenanceSafetyError('DF_UNPARSEABLE', 'df produced no data row');
  }
  const columns = lines[lines.length - 1].trim().split(/\s+/);
  if (columns.length < 6) {
    throw new MaintenanceSafetyError('DF_UNPARSEABLE', 'df data row is malformed');
  }
  const totalKb = Number(columns[1]);
  const usedKb = Number(columns[2]);
  const availableKb = Number(columns[3]);
  if (![totalKb, usedKb, availableKb].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new MaintenanceSafetyError('DF_UNPARSEABLE', 'df reported non-numeric sizes');
  }
  if (totalKb === 0) {
    throw new MaintenanceSafetyError('DF_UNPARSEABLE', 'df reported a zero-size filesystem');
  }
  const capacityKb = usedKb + availableKb;
  if (capacityKb === 0) {
    throw new MaintenanceSafetyError('DF_UNPARSEABLE', 'df reported zero usable capacity');
  }
  const usedPercent = Math.round((usedKb / capacityKb) * 1000) / 10;
  return { totalKb, usedKb, availableKb, capacityKb, usedPercent };
}

export function classifyUsage(usedPercent) {
  if (usedPercent >= CRITICAL_PERCENT) return 'critical';
  if (usedPercent >= WARNING_PERCENT) return 'warning';
  return 'ok';
}

/** Report on a severity change, or once per cooldown while it persists. */
export function shouldReport(previous, severity, now, cooldownMinutes) {
  if (severity === 'ok') return previous?.severity !== 'ok';
  if (!previous || previous.severity !== severity) return true;
  const last = Date.parse(previous.reportedAt ?? '');
  if (!Number.isFinite(last)) return true;
  return now - last >= cooldownMinutes * 60_000;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), FLAGS);
  // The runtime override is only honoured under the explicit test-root guard.
  const runtimeDir = resolveMaintenanceRoot('runtime', flags.get('runtime-dir'));
  const filesystem = flags.has('filesystem') ? flags.get('filesystem') : '/';
  const cooldownMinutes = boundedIntegerFlag(flags, 'cooldown-minutes', 60, 0, 1440);

  let output;
  if (flags.has('df-output')) {
    // Injected df output is a test hook: without the guard a production run
    // could be fed a fabricated reading.
    if (!process.env[TEST_ROOT_ENV]) {
      throw new MaintenanceSafetyError(
        'OVERRIDE_FORBIDDEN',
        `--df-output requires ${TEST_ROOT_ENV}`,
      );
    }
    output = flags.get('df-output');
  } else {
    ({ stdout: output } = await execFileAsync('df', ['-P', '-k', filesystem]));
  }

  const usage = parseDfOutput(output);
  const severity = classifyUsage(usage.usedPercent);
  const now = Date.now();
  const statusPath = path.posix.join(runtimeDir, 'disk-guard.json');

  let previous = null;
  try {
    previous = JSON.parse(await readFile(statusPath, 'utf8'));
  } catch {
    previous = null;
  }
  const report = shouldReport(previous, severity, now, cooldownMinutes);
  const status = {
    schemaVersion: 1,
    filesystem,
    checkedAt: new Date(now).toISOString(),
    totalKb: usage.totalKb,
    usedKb: usage.usedKb,
    availableKb: usage.availableKb,
    capacityKb: usage.capacityKb,
    usedPercent: usage.usedPercent,
    warningPercent: WARNING_PERCENT,
    criticalPercent: CRITICAL_PERCENT,
    severity,
    // Preserve the instant the current severity was last announced so the
    // cooldown survives a restart.
    reportedAt: report ? new Date(now).toISOString() : previous?.reportedAt ?? null,
    observeOnly: true,
  };

  await mkdir(runtimeDir, { recursive: true, mode: 0o755 });
  // Atomic replace so a concurrent reader never sees a partial status file.
  const temporary = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, statusPath);

  // Respect the cooldown in the journal too: a sustained warning writes the
  // status file every run but only speaks when `shouldReport` allows it.
  if (report) emit({ ok: severity !== 'critical', ...status });
  if (severity === 'critical') {
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('guard_full_managed_disk.mjs')) {
  main().catch((error) => {
    emit({
      ok: false,
      code: error instanceof MaintenanceSafetyError ? error.code : 'UNEXPECTED',
      message: error.message,
    });
    process.exitCode = 1;
  });
}
