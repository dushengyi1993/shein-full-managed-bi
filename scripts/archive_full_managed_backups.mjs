#!/usr/bin/env node
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  FULL_MANAGED_ROOTS,
  MaintenanceSafetyError,
  acquireMaintenanceLock,
  assertCosfsMount,
  assertInsideRoot,
  assertSafeChildName,
  boundedIntegerFlag,
  emit,
  parseFlags,
  partialName,
  resolveMaintenanceRoot,
  selectBackupsForArchive,
  sha256File,
} from './lib/full_managed_maintenance.mjs';

/**
 * Archive expired full-managed database dumps to the mounted COS namespace and
 * only then delete the exact local source.
 *
 * Plan is the default. `--apply` performs mount proof -> copy -> verify size ->
 * verify SHA-256 -> write manifest -> delete source, in that order. Any failure
 * leaves the local dump untouched, so a broken COS mount can never cause data
 * loss. Exact replay is idempotent.
 */

const FLAGS = [
  'apply', 'retain-days', 'retain-extra',
  'backup-dir', 'archive-dir', 'runtime-dir', 'skip-mount-check',
];

async function listBackups(backupDir) {
  const entries = await readdir(backupDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    // A symlink in the backup directory is never followed or deleted.
    if (!entry.isFile()) continue;
    // Ignore our own in-flight partials.
    if (entry.name.endsWith('.partial')) continue;
    if (entry.name.endsWith('.manifest.json')) continue;
    const name = assertSafeChildName(entry.name);
    const absolute = assertInsideRoot(path.posix.join(backupDir, name), backupDir);
    const info = await stat(absolute);
    files.push({ name, absolute, bytes: info.size, modifiedAt: info.mtimeMs });
  }
  return files;
}

/** Copy through a uniquely named temporary so two runs never collide. */
async function archiveOne(candidate, archiveDir) {
  const targetName = assertSafeChildName(candidate.name);
  const target = assertInsideRoot(path.posix.join(archiveDir, targetName), archiveDir);
  const sourceHash = await sha256File(candidate.absolute);

  let alreadyArchived = false;
  try {
    const existing = await stat(target);
    if (existing.size === candidate.bytes && await sha256File(target) === sourceHash) {
      alreadyArchived = true;
    } else {
      // A same-named object with different content is a real conflict.
      throw new MaintenanceSafetyError(
        'ARCHIVE_CONFLICT',
        `${targetName} already exists in the archive with different content`,
      );
    }
  } catch (error) {
    if (error instanceof MaintenanceSafetyError) throw error;
    if (error.code !== 'ENOENT') throw error;
  }

  if (!alreadyArchived) {
    const temporary = partialName(target);
    try {
      await copyFile(candidate.absolute, temporary);
      await rename(temporary, target);
    } catch (error) {
      // Clean up only the partial this run owns; never touch another run's.
      await rm(temporary, { force: true });
      throw error;
    }
  }

  // Verify the destination independently of the copy call.
  const verified = await stat(target);
  if (verified.size !== candidate.bytes) {
    throw new MaintenanceSafetyError(
      'ARCHIVE_SIZE_MISMATCH',
      `${targetName} archived size ${verified.size} != source ${candidate.bytes}`,
    );
  }
  const targetHash = await sha256File(target);
  if (targetHash !== sourceHash) {
    throw new MaintenanceSafetyError(
      'ARCHIVE_HASH_MISMATCH',
      `${targetName} archived sha256 does not match the source`,
    );
  }

  const manifest = {
    schemaVersion: 1,
    sourceName: candidate.name,
    bytes: candidate.bytes,
    sha256: sourceHash,
    archiveTarget: target,
    archivedAt: new Date().toISOString(),
    replayed: alreadyArchived,
  };
  await writeFile(`${target}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return manifest;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), FLAGS);
  const apply = flags.has('apply');
  const retainDays = boundedIntegerFlag(flags, 'retain-days', 7, 1, 90);
  const retainExtra = boundedIntegerFlag(flags, 'retain-extra', 3, 0, 50);

  // Root overrides are refused unless the explicit test-root guard is set, so a
  // production run cannot be pointed at /tmp or /etc.
  const backupDir = resolveMaintenanceRoot('dbBackups', flags.get('backup-dir'));
  const archiveDir = resolveMaintenanceRoot('archive', flags.get('archive-dir'));
  const runtimeDir = resolveMaintenanceRoot('runtime', flags.get('runtime-dir'));

  const entries = await listBackups(backupDir);
  const selection = selectBackupsForArchive(entries, { retainDays, retainExtra });

  if (!apply) {
    emit({
      ok: true,
      mode: 'plan',
      backupDir,
      archiveDir,
      retainedDays: selection.retainedDays,
      keep: selection.keep.map(({ name, bytes, reason }) => ({ name, bytes, reason })),
      candidates: selection.candidates.map(({ name, bytes }) => ({ name, bytes })),
      skipped: selection.skipped.map(({ name, reason }) => ({ name, reason })),
    });
    return;
  }

  /* Prove the archive really is the cosfs mount before copying anything. An
     unmounted /lhcos-data looks like an empty local directory: the copy would
     "succeed" onto the root disk, verification would pass, and the only real
     copy of the dump would then be deleted while freeing no space at all. The
     skip flag is only reachable under the test-root guard. */
  let archiveFstype = 'unchecked';
  const skipMountCheck = flags.has('skip-mount-check');
  if (skipMountCheck) {
    resolveMaintenanceRoot('archive', flags.get('archive-dir') || archiveDir);
    if (!process.env.SHEIN_FM_MAINTENANCE_TEST_ROOT) {
      throw new MaintenanceSafetyError(
        'MOUNT_CHECK_REQUIRED',
        '--skip-mount-check is only available under the maintenance test root guard',
      );
    }
  } else {
    archiveFstype = await assertCosfsMount(archiveDir);
  }

  // A dedicated lock, distinct from the database backup lock, so the two never
  // deadlock while still serializing concurrent archive runs.
  await mkdir(runtimeDir, { recursive: true, mode: 0o755 });
  const lock = await acquireMaintenanceLock(
    path.posix.join(runtimeDir, 'backup-archive.lock'),
  );
  try {
    await mkdir(archiveDir, { recursive: true, mode: 0o700 });
    const archived = [];
    for (const candidate of selection.candidates) {
      // Fail closed: the source is deleted only after the archive is verified.
      const manifest = await archiveOne(candidate, archiveDir);
      await rm(candidate.absolute, { force: false });
      archived.push(manifest);
    }
    emit({
      ok: true,
      mode: 'apply',
      backupDir,
      archiveDir,
      archiveFstype,
      retainedDays: selection.retainedDays,
      keptCount: selection.keep.length,
      archivedCount: archived.length,
      archived: archived.map(({ sourceName, bytes, sha256, replayed }) => ({
        sourceName, bytes, sha256, replayed,
      })),
    });
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
