#!/usr/bin/env node
import { lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  MaintenanceSafetyError,
  acquireMaintenanceLock,
  assertInsideRoot,
  assertSafeChildName,
  boundedIntegerFlag,
  emit,
  isExitedProcessError,
  isPermissionError,
  parseFlags,
  resolveMaintenanceRoot,
} from './lib/full_managed_maintenance.mjs';

/**
 * Prune old immutable release directories under /opt/shein-fm/releases.
 *
 * Plan is the default. The protected set is the union of:
 *   - the release `current` resolves to,
 *   - the release `previous` resolves to,
 *   - the 5 newest stable releases by directory mtime,
 *   - every release referenced by a live process working directory.
 *
 * Active-cwd protection is mandatory, not advisory: the Webhook receiver and
 * worker keep running from the release they were started under, which is often
 * older than `current`. Deleting it would pull the code out from beneath a live
 * process.
 */

/**
 * A stable release directory is named after a 40-hex Git commit hash.
 *
 * Commit hashes are not chronological, so recency must come from mtime. Sorting
 * by name would protect five arbitrary releases and delete genuinely recent
 * ones.
 */
export const RELEASE_NAME_PATTERN = /^[0-9a-f]{40}$/;

/** Preflight scratch directories: prunable, but never a "newest" release. */
export const PREFLIGHT_NAME_PATTERN = /^preflight-[0-9a-f]{8,40}$/;

const FLAGS = ['apply', 'releases-dir', 'proc-dir', 'runtime-dir', 'retain-newest'];

/**
 * Releases whose files a running process is currently executing from.
 *
 * A permission error is fatal: it means we cannot prove the release is idle, and
 * guessing would risk deleting the code beneath a live process. Only a provably
 * exited process may be skipped.
 */
export async function readActiveReleaseNames(procDir, releasesDir) {
  const active = new Map();
  let pids;
  try {
    pids = await readdir(procDir, { withFileTypes: true });
  } catch (error) {
    throw new MaintenanceSafetyError(
      'PROC_UNAVAILABLE',
      `${procDir} is unavailable (${error.code ?? 'unknown'}); cannot prove releases are idle`,
    );
  }
  for (const entry of pids) {
    if (!/^[0-9]+$/.test(entry.name)) continue;
    const cwdLink = path.posix.join(procDir, entry.name, 'cwd');
    let resolved;
    try {
      resolved = await realpath(cwdLink);
    } catch (error) {
      // The process exited between listing and inspection: safe to skip.
      if (isExitedProcessError(error)) continue;
      // Anything else, including EACCES/EPERM, is unprovable. Fail closed.
      throw new MaintenanceSafetyError(
        'PROC_CWD_UNREADABLE',
        `cannot read ${cwdLink} (${error.code ?? 'unknown'}); refusing to prune`,
      );
    }
    const normalized = resolved.replaceAll('\\', '/');
    const prefix = `${releasesDir}/`;
    if (!normalized.startsWith(prefix)) continue;
    const releaseName = normalized.slice(prefix.length).split('/')[0];
    if (releaseName === '') continue;
    const pidList = active.get(releaseName) ?? [];
    pidList.push(Number(entry.name));
    active.set(releaseName, pidList);
  }
  return active;
}

/**
 * Resolve a deployment pointer symlink to its release directory name.
 *
 * Fails closed: an unresolvable or out-of-root `current`/`previous` means we
 * cannot know which release is protected, so nothing may be deleted.
 */
export async function resolveDeploymentPointer(releasesDir, pointerPath, { required }) {
  let resolved;
  try {
    resolved = await realpath(pointerPath);
  } catch (error) {
    if (!required && isExitedProcessError(error)) return null;
    throw new MaintenanceSafetyError(
      'POINTER_UNRESOLVED',
      `cannot resolve ${pointerPath} (${error.code ?? 'unknown'})`,
    );
  }
  const normalized = resolved.replaceAll('\\', '/');
  const prefix = `${releasesDir}/`;
  if (!normalized.startsWith(prefix)) {
    throw new MaintenanceSafetyError(
      'POINTER_OUTSIDE_ROOT',
      `${pointerPath} resolves outside ${releasesDir}`,
    );
  }
  const name = normalized.slice(prefix.length).split('/')[0];
  if (name === '') {
    throw new MaintenanceSafetyError(
      'POINTER_OUTSIDE_ROOT',
      `${pointerPath} resolves to the releases root`,
    );
  }
  return name;
}

/**
 * Pure selection so retention is unit-testable without a filesystem.
 *
 * `releases` entries carry `{ name, modifiedAt, kind }`. Only `kind === 'release'`
 * entries compete for the newest-N slots; preflight scratch directories are
 * always prunable once unreferenced.
 */
export function selectReleasesForPruning({
  releases,
  currentName,
  previousName,
  activeNames,
  retainNewest = 5,
}) {
  const known = new Map(releases.map((entry) => [entry.name, entry]));
  // Newest first by mtime, with a deterministic name tie-break.
  const stableByRecency = releases
    .filter((entry) => entry.kind === 'release')
    .sort((left, right) => (
      right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name)
    ));

  const protectedReasons = new Map();
  const protect = (name, reason) => {
    if (!name || !known.has(name)) return;
    const reasons = protectedReasons.get(name) ?? [];
    reasons.push(reason);
    protectedReasons.set(name, reasons);
  };
  protect(currentName, 'current');
  protect(previousName, 'previous');
  for (const entry of stableByRecency.slice(0, retainNewest)) {
    protect(entry.name, 'newest-retained');
  }
  for (const [name, pids] of activeNames) {
    protect(name, `active-process-cwd:${[...pids].sort((a, b) => a - b).join(',')}`);
  }

  const candidates = [...stableByRecency, ...releases.filter((entry) => entry.kind === 'preflight')]
    .filter((entry) => !protectedReasons.has(entry.name))
    .map((entry) => entry.name);
  return {
    protected: [...protectedReasons].map(([name, reasons]) => ({ name, reasons })),
    candidates,
  };
}

async function readReleaseEntries(releasesDir) {
  const entries = await readdir(releasesDir, { withFileTypes: true });
  const releases = [];
  const refused = [];
  for (const entry of entries) {
    // A symlink child is a deployment pointer, never a prune candidate.
    if (entry.isSymbolicLink()) {
      refused.push({ name: entry.name, reason: 'symlink-child' });
      continue;
    }
    if (!entry.isDirectory()) {
      refused.push({ name: entry.name, reason: 'not-a-directory' });
      continue;
    }
    let safeName;
    try {
      safeName = assertSafeChildName(entry.name);
    } catch {
      refused.push({ name: entry.name, reason: 'unsafe-name' });
      continue;
    }
    const kind = RELEASE_NAME_PATTERN.test(safeName)
      ? 'release'
      : PREFLIGHT_NAME_PATTERN.test(safeName) ? 'preflight' : null;
    if (kind === null) {
      // An unrecognized directory is never deleted, only reported.
      refused.push({ name: safeName, reason: 'unrecognized-release-name' });
      continue;
    }
    const absolute = assertInsideRoot(path.posix.join(releasesDir, safeName), releasesDir);
    const info = await stat(absolute);
    releases.push({ name: safeName, kind, modifiedAt: info.mtimeMs });
  }
  return { releases, refused };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), FLAGS);
  const apply = flags.has('apply');
  const releasesDir = resolveMaintenanceRoot('releases', flags.get('releases-dir'));
  const procDir = resolveMaintenanceRoot('proc', flags.get('proc-dir'));
  const runtimeDir = resolveMaintenanceRoot('runtime', flags.get('runtime-dir'));
  const retainNewest = boundedIntegerFlag(flags, 'retain-newest', 5, 1, 50);

  /* Compare against the canonical root. `realpath` returns a fully resolved
     path, so the root must be resolved too: if /opt/shein-fm/releases were itself
     a symlink (or, on a developer machine, an 8.3 short path), an unresolved
     prefix compare would reject a pointer that is genuinely inside the root. */
  const canonicalReleasesDir = (await realpath(releasesDir)).replaceAll('\\', '/');
  const { releases, refused } = await readReleaseEntries(releasesDir);
  const parent = path.posix.dirname(releasesDir);
  const currentPointer = path.posix.join(parent, 'current');
  const previousPointer = path.posix.join(parent, 'previous');

  // `current` must always resolve; `previous` may legitimately be absent on a
  // first deployment but must never resolve somewhere unexpected.
  const currentName = await resolveDeploymentPointer(canonicalReleasesDir, currentPointer, {
    required: true,
  });
  const previousName = await resolveDeploymentPointer(canonicalReleasesDir, previousPointer, {
    required: false,
  });
  const activeNames = await readActiveReleaseNames(procDir, canonicalReleasesDir);
  const selection = selectReleasesForPruning({
    releases,
    currentName,
    previousName,
    activeNames,
    retainNewest,
  });

  if (!apply) {
    emit({
      ok: true,
      mode: 'plan',
      releasesDir,
      currentName,
      previousName,
      activeReleases: [...activeNames].map(([name, pids]) => ({ name, pids })),
      protected: selection.protected,
      candidates: selection.candidates,
      refused,
    });
    return;
  }

  await mkdir(runtimeDir, { recursive: true, mode: 0o755 });
  const lock = await acquireMaintenanceLock(
    path.posix.join(runtimeDir, 'release-prune.lock'),
  );
  try {
    const removed = [];
    for (const name of selection.candidates) {
      /* Re-resolve the protection state immediately before each deletion. A
         deployment or a process start between planning and now can make a
         candidate protected, and acting on the stale plan would delete the live
         release. */
      const freshCurrent = await resolveDeploymentPointer(canonicalReleasesDir, currentPointer, {
        required: true,
      });
      const freshPrevious = await resolveDeploymentPointer(canonicalReleasesDir, previousPointer, {
        required: false,
      });
      const freshActive = await readActiveReleaseNames(procDir, canonicalReleasesDir);
      if (name === freshCurrent || name === freshPrevious || freshActive.has(name)) {
        throw new MaintenanceSafetyError(
          'RELEASE_BECAME_PROTECTED',
          `${name} became protected during pruning; aborting`,
        );
      }

      const target = assertInsideRoot(path.posix.join(releasesDir, name), releasesDir);
      // Never follow a symlink swapped in after the listing, and never delete
      // anything but a real directory.
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        throw new MaintenanceSafetyError('RELEASE_SYMLINK', `${name} became a symlink`);
      }
      if (!info.isDirectory()) {
        throw new MaintenanceSafetyError('RELEASE_NOT_DIRECTORY', `${name} is not a directory`);
      }
      // `realpath` output must be compared against the canonical root, not the
      // raw flag value, or a symlinked root would falsely look like an escape.
      const resolvedTarget = (await realpath(target)).replaceAll('\\', '/');
      assertInsideRoot(resolvedTarget, canonicalReleasesDir);

      await rm(target, { recursive: true, force: false });
      removed.push(name);
    }
    emit({
      ok: true,
      mode: 'apply',
      releasesDir,
      currentName,
      previousName,
      protectedCount: selection.protected.length,
      removed,
    });
  } finally {
    await lock.release();
  }
}

if (process.argv[1]?.endsWith('prune_full_managed_releases.mjs')) {
  main().catch((error) => {
    emit({
      ok: false,
      code: error instanceof MaintenanceSafetyError ? error.code : 'UNEXPECTED',
      message: error.message,
    });
    process.exitCode = 1;
  });
}
