#!/usr/bin/env node
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  MaintenanceSafetyError,
  acquireMaintenanceLock,
  assertInsideRoot,
  assertSafeChildName,
  boundedIntegerFlag,
  emit,
  parseFlags,
  resolveMaintenanceRoot,
  selectBackupsForLocalRetention,
} from './lib/full_managed_maintenance.mjs';

const FLAGS = [
  'apply', 'retain-daily', 'retain-weekly', 'retain-deploy',
  'backup-dir', 'runtime-dir',
];

async function listBackups(backupDir) {
  const entries = await readdir(backupDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith('.partial')) continue;
    const name = assertSafeChildName(entry.name);
    const absolute = assertInsideRoot(path.posix.join(backupDir, name), backupDir);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    files.push({ name, absolute, bytes: info.size, modifiedAt: info.mtimeMs });
  }
  return files;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), FLAGS);
  const apply = flags.has('apply');
  const retainDaily = boundedIntegerFlag(flags, 'retain-daily', 2, 1, 14);
  const retainWeekly = boundedIntegerFlag(flags, 'retain-weekly', 4, 0, 12);
  const retainDeploy = boundedIntegerFlag(flags, 'retain-deploy', 1, 0, 5);
  const backupDir = resolveMaintenanceRoot('dbBackups', flags.get('backup-dir'));
  const runtimeRoot = resolveMaintenanceRoot('runtime', flags.get('runtime-dir'));
  const auditDir = assertInsideRoot(
    path.posix.join(runtimeRoot, 'backup-retention'),
    runtimeRoot,
  );
  const selection = selectBackupsForLocalRetention(await listBackups(backupDir), {
    retainDaily, retainWeekly, retainDeploy,
  });
  const plan = {
    ok: true,
    mode: apply ? 'apply' : 'plan',
    policy: { retainDaily, retainWeekly, retainDeploy },
    backupDir,
    recentWeeks: selection.recentWeeks,
    keep: selection.keep.map(({ name, bytes, reason }) => ({ name, bytes, reason })),
    candidates: selection.candidates.map(({ name, bytes, reason }) => ({ name, bytes, reason })),
    skipped: selection.skipped.map(({ name, reason }) => ({ name, reason })),
  };
  if (!apply) {
    emit(plan);
    return;
  }

  await mkdir(auditDir, { recursive: true, mode: 0o700 });
  const lock = await acquireMaintenanceLock(path.posix.join(auditDir, 'retention.lock'));
  try {
    const removed = [];
    for (const candidate of selection.candidates) {
      const current = await lstat(candidate.absolute);
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new MaintenanceSafetyError('BACKUP_CHANGED', `${candidate.name} is no longer a regular file`);
      }
      if (current.size !== candidate.bytes || current.mtimeMs !== candidate.modifiedAt) {
        throw new MaintenanceSafetyError('BACKUP_CHANGED', `${candidate.name} changed after planning`);
      }
      await rm(candidate.absolute, { force: false });
      removed.push({ name: candidate.name, bytes: candidate.bytes });
    }
    const completedAt = new Date().toISOString();
    const audit = {
      ...plan,
      mode: 'apply',
      completedAt,
      removed,
      removedBytes: removed.reduce((sum, item) => sum + item.bytes, 0),
    };
    const stamp = completedAt.replace(/[-:.]/g, '').replace('Z', 'Z');
    const target = path.posix.join(auditDir, `retention-${stamp}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    emit(audit);
  } finally {
    await lock.release();
  }
}

main().catch((error) => {
  emit({
    ok: false,
    code: error instanceof MaintenanceSafetyError ? error.code : 'UNEXPECTED',
    message: error.message,
  });
  process.exitCode = 1;
});
