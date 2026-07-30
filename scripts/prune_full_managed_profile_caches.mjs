#!/usr/bin/env node
import { lstat, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  FULL_MANAGED_STORE_CODES,
  fullManagedProfileKey,
} from '../src/config/full-managed-stores.mjs';

import {
  MaintenanceSafetyError,
  acquireMaintenanceLock,
  assertInsideRoot,
  emit,
  isExitedProcessError,
  parseFlags,
  resolveMaintenanceRoot,
  sha256File,
} from './lib/full_managed_maintenance.mjs';

/**
 * Remove regenerable Chrome cache directories from idle full-managed WebAPI
 * Profiles.
 *
 * Plan is the default. The tool never kills a process: if a lease exists or a
 * browser still references the Profile, it refuses and exits non-zero.
 */

/** The only Profiles this tool may ever touch. */
export const CANONICAL_PROFILES = Object.freeze(
  FULL_MANAGED_STORE_CODES.map((storeCode) => fullManagedProfileKey(storeCode)),
);

/**
 * Exact regenerable directories, relative to a Profile root.
 *
 * This is an allow-list, not a pattern: an unknown directory is never removed,
 * so a future Chrome version cannot silently expose new state to deletion.
 */
export const REGENERABLE_CACHE_DIRS = Object.freeze([
  'cache',
  'component_crx_cache',
  'Profile 1/Cache',
  'Profile 1/Code Cache',
  'Profile 1/GPUCache',
  'Profile 1/Service Worker/CacheStorage',
]);

/**
 * Login state that must survive cache pruning.
 *
 * Fingerprinted before and after an apply run so the operator has positive
 * evidence that authenticated session state was not disturbed.
 */
export const PROTECTED_LOGIN_STATE = Object.freeze([
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
]);

const FLAGS = ['apply', 'profiles-dir', 'locks-dir', 'proc-dir', 'runtime-dir'];

/**
 * Any entry of any type in the lock directory blocks pruning.
 *
 * A subdirectory, symlink or socket in the lock directory is still evidence that
 * something is coordinating on it. Only recognized, parseable lease files are
 * described in detail; everything else is reported as unparseable so the caller
 * fails closed rather than silently ignoring it.
 */
export async function readLeaseState(locksDir) {
  let entries;
  try {
    entries = await readdir(locksDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { leases: [], unparseable: [] };
    throw error;
  }
  const leases = [];
  const unparseable = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      // A directory or symlink here is not something we can reason about.
      unparseable.push(entry.name);
      continue;
    }
    if (!entry.name.endsWith('.json') && !entry.name.endsWith('.lock')) {
      unparseable.push(entry.name);
      continue;
    }
    const absolute = path.posix.join(locksDir, entry.name);
    try {
      const parsed = JSON.parse(await readFile(absolute, 'utf8'));
      leases.push({ name: entry.name, profile: parsed?.profile ?? null });
    } catch {
      unparseable.push(entry.name);
    }
  }
  return { leases, unparseable };
}

/**
 * Processes holding a --user-data-dir under the full-managed profile root.
 *
 * A permission error is fatal: we cannot prove the Profile is idle, and pruning
 * a live Profile's cache can corrupt the running browser. Only a provably exited
 * process may be skipped.
 */
export async function readProfileProcesses(procDir, profilesDir) {
  const holders = [];
  let pids;
  try {
    pids = await readdir(procDir, { withFileTypes: true });
  } catch (error) {
    throw new MaintenanceSafetyError(
      'PROC_UNAVAILABLE',
      `${procDir} is unavailable (${error.code ?? 'unknown'}); cannot prove the Profile is idle`,
    );
  }
  for (const entry of pids) {
    if (!/^[0-9]+$/.test(entry.name)) continue;
    const cmdlinePath = path.posix.join(procDir, entry.name, 'cmdline');
    let cmdline;
    try {
      cmdline = await readFile(cmdlinePath, 'utf8');
    } catch (error) {
      if (isExitedProcessError(error)) continue;
      throw new MaintenanceSafetyError(
        'PROC_CMDLINE_UNREADABLE',
        `cannot read ${cmdlinePath} (${error.code ?? 'unknown'}); refusing to prune`,
      );
    }
    const argv = cmdline.split('\0').filter((token) => token !== '');
    if (argv.length === 0) continue;
    const joined = argv.join(' ');
    if (!joined.includes(profilesDir)) continue;
    // Any browser or Xvfb process referencing the profile root blocks pruning.
    holders.push({ pid: Number(entry.name), argv: argv.slice(0, 2) });
  }
  return holders;
}

/**
 * Recursively fingerprint one protected path.
 *
 * Local Storage, IndexedDB and Sessions are directories holding LevelDB files.
 * Recording only directory presence would not detect a mutated or deleted file
 * inside them, so every contained file contributes its relative path, size and
 * SHA-256.
 */
async function fingerprintPath(absolute, relative) {
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [{ path: relative, present: false }];
  }
  // A protected path must never be a symlink: it could redirect a later read or
  // point outside the Profile entirely.
  if (info.isSymbolicLink()) {
    throw new MaintenanceSafetyError(
      'PROTECTED_SYMLINK',
      `protected path ${relative} is a symlink`,
    );
  }
  if (info.isFile()) {
    return [{
      path: relative,
      kind: 'file',
      present: true,
      bytes: info.size,
      sha256: await sha256File(absolute),
    }];
  }
  if (!info.isDirectory()) {
    return [{ path: relative, kind: 'other', present: true }];
  }
  const collected = [{ path: relative, kind: 'directory', present: true }];
  const children = await readdir(absolute, { withFileTypes: true });
  // Deterministic order so two runs of an unchanged tree compare equal.
  for (const child of [...children].sort((left, right) => left.name.localeCompare(right.name))) {
    collected.push(...await fingerprintPath(
      path.posix.join(absolute, child.name),
      `${relative}/${child.name}`,
    ));
  }
  return collected;
}

async function fingerprintLoginState(profileDir) {
  const fingerprints = [];
  for (const relative of PROTECTED_LOGIN_STATE) {
    const absolute = assertInsideRoot(path.posix.join(profileDir, relative), profileDir);
    fingerprints.push(...await fingerprintPath(absolute, relative));
  }
  return fingerprints;
}

async function planProfile(profilesDir, profileName) {
  const profileDir = assertInsideRoot(
    path.posix.join(profilesDir, profileName),
    profilesDir,
  );
  const removable = [];
  for (const relative of REGENERABLE_CACHE_DIRS) {
    const absolute = assertInsideRoot(path.posix.join(profileDir, relative), profileDir);
    try {
      const info = await lstat(absolute);
      // Refuse a symlink: it could point at protected state or outside the root.
      if (info.isSymbolicLink()) {
        throw new MaintenanceSafetyError(
          'CACHE_SYMLINK',
          `${relative} in ${profileName} is a symlink`,
        );
      }
      if (!info.isDirectory()) continue;
      removable.push({ relative, absolute });
    } catch (error) {
      if (error instanceof MaintenanceSafetyError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { profileName, profileDir, removable };
}

/** Re-prove idleness; called before planning and again before each deletion. */
async function assertIdle(locksDir, procDir, profilesDir) {
  const leaseState = await readLeaseState(locksDir);
  if (leaseState.unparseable.length > 0) {
    throw new MaintenanceSafetyError(
      'LEASE_UNPARSEABLE',
      `unparseable WebAPI lock artifacts: ${leaseState.unparseable.join(', ')}`,
    );
  }
  if (leaseState.leases.length > 0) {
    throw new MaintenanceSafetyError(
      'LEASE_ACTIVE',
      `WebAPI lease active: ${leaseState.leases.map((item) => item.name).join(', ')}`,
    );
  }
  const holders = await readProfileProcesses(procDir, profilesDir);
  if (holders.length > 0) {
    throw new MaintenanceSafetyError(
      'PROFILE_IN_USE',
      `processes still using the profile root: ${holders.map((item) => item.pid).join(', ')}`,
    );
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), FLAGS);
  const apply = flags.has('apply');
  const profilesDir = resolveMaintenanceRoot('profiles', flags.get('profiles-dir'));
  const locksDir = resolveMaintenanceRoot('webapiLocks', flags.get('locks-dir'));
  const procDir = resolveMaintenanceRoot('proc', flags.get('proc-dir'));
  const runtimeDir = resolveMaintenanceRoot('runtime', flags.get('runtime-dir'));

  await assertIdle(locksDir, procDir, profilesDir);

  const plans = [];
  for (const profileName of CANONICAL_PROFILES) {
    try {
      await stat(path.posix.join(profilesDir, profileName));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    plans.push(await planProfile(profilesDir, profileName));
  }

  if (!apply) {
    emit({
      ok: true,
      mode: 'plan',
      profilesDir,
      idle: true,
      profiles: plans.map(({ profileName, removable }) => ({
        profileName,
        removable: removable.map(({ relative }) => relative),
      })),
      preservedLoginState: PROTECTED_LOGIN_STATE,
    });
    return;
  }

  await mkdir(runtimeDir, { recursive: true, mode: 0o755 });
  const lock = await acquireMaintenanceLock(
    path.posix.join(runtimeDir, 'profile-cache-prune.lock'),
  );
  try {
    const results = [];
    for (const plan of plans) {
      const before = await fingerprintLoginState(plan.profileDir);
      const removed = [];
      for (const target of plan.removable) {
        // Re-prove idleness immediately before every deletion: a lease may have
        // been taken since planning began.
        await assertIdle(locksDir, procDir, profilesDir);
        await rm(target.absolute, { recursive: true, force: false });
        removed.push(target.relative);
      }
      const after = await fingerprintLoginState(plan.profileDir);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new MaintenanceSafetyError(
          'LOGIN_STATE_CHANGED',
          `${plan.profileName} login state changed during cache pruning`,
        );
      }
      results.push({
        profileName: plan.profileName,
        removed,
        loginStateVerified: true,
        loginStateEntries: before.length,
      });
    }
    emit({ ok: true, mode: 'apply', profilesDir, profiles: results });
  } finally {
    await lock.release();
  }
}

if (process.argv[1]?.endsWith('prune_full_managed_profile_caches.mjs')) {
  main().catch((error) => {
    emit({
      ok: false,
      code: error instanceof MaintenanceSafetyError ? error.code : 'UNEXPECTED',
      message: error.message,
    });
    process.exitCode = 1;
  });
}

export { fingerprintLoginState };
