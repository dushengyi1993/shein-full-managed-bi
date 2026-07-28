/**
 * Exclusive locks for the isolated WebAPI experiment.
 *
 * Two locks are always taken together, global first:
 *   1. a global lock, so only one experiment runs on the host at a time;
 *   2. a per-canonical-Profile lock, so one store's Profile can never be opened
 *      twice or by two stores at once.
 *
 * Every filesystem call is injected. Lock errors and lock output carry only a
 * sanitized code and the canonical store code, never a directory path and never
 * a Profile key.
 */

import { WEBAPI_STORE_CODES } from './profile-guard.mjs';

export const LOCK_REJECT_CODES = Object.freeze({
  STORE_NOT_ALLOWED: 'WEBAPI_LOCK_STORE_NOT_ALLOWED',
  DEPENDENCIES_MISSING: 'WEBAPI_LOCK_DEPENDENCIES_MISSING',
  GLOBAL_HELD: 'WEBAPI_LOCK_GLOBAL_HELD',
  PROFILE_HELD: 'WEBAPI_LOCK_PROFILE_HELD',
  NOT_OWNER: 'WEBAPI_LOCK_NOT_OWNER',
  WRITE_FAILED: 'WEBAPI_LOCK_WRITE_FAILED',
});

export const GLOBAL_LOCK_NAME = 'webapi-experiment.global.lock';

export class WebApiLockError extends Error {
  constructor(code, storeCode = null) {
    // The message is deliberately generic: no path, no Profile key, no owner
    // identity. Callers report the code.
    super(`webapi experiment lock refused: ${code}`);
    this.name = 'WebApiLockError';
    this.code = code;
    this.storeCode = storeCode;
  }
}

function lockFileName(storeCode) {
  return `webapi-experiment.${storeCode.toLowerCase()}.lock`;
}

/**
 * A stale lock may only be reclaimed when absence of the owner is provable.
 *
 * That means: the recorded owner pid is a plausible integer, it is not this
 * process, and the injected `isProcessAlive` probe reports it as gone. An
 * unparsable or still-live record is never reclaimed.
 */
function isProvablyStale(record, { pid, isProcessAlive }) {
  if (!record || typeof record !== 'object') return false;
  const ownerPid = record.ownerPid;
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
  if (ownerPid === pid) return false;
  if (typeof isProcessAlive !== 'function') return false;
  let alive = true;
  try {
    alive = isProcessAlive(ownerPid) === true;
  } catch {
    // An unreadable probe result is treated as "still alive": fail closed.
    return false;
  }
  return alive === false;
}

/**
 * @param {object} deps
 * @param {{writeFileExclusive: Function, readFile: Function, remove: Function, mkdir: Function}} deps.fs
 * @param {number} deps.pid
 * @param {(pid: number) => boolean} deps.isProcessAlive
 * @param {() => Date} [deps.clock]
 * @param {string} deps.lockDirectory
 */
export function createExperimentLockManager({
  fs,
  pid,
  isProcessAlive,
  clock = () => new Date(),
  lockDirectory,
} = {}) {
  if (
    !fs
    || typeof fs.writeFileExclusive !== 'function'
    || typeof fs.readFile !== 'function'
    || typeof fs.remove !== 'function'
    || typeof fs.mkdir !== 'function'
    || !Number.isSafeInteger(pid)
    || typeof isProcessAlive !== 'function'
    || typeof lockDirectory !== 'string'
    || lockDirectory === ''
  ) {
    throw new WebApiLockError(LOCK_REJECT_CODES.DEPENDENCIES_MISSING);
  }

  const joinLockPath = (name) => `${lockDirectory.replace(/[/\\]+$/, '')}/${name}`;

  async function claim(name, storeCode, heldCode) {
    const path = joinLockPath(name);
    const record = {
      ownerPid: pid,
      storeCode,
      acquiredAt: clock().toISOString(),
    };
    const serialized = `${JSON.stringify(record)}\n`;
    try {
      await fs.writeFileExclusive(path, serialized);
      return path;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw new WebApiLockError(LOCK_REJECT_CODES.WRITE_FAILED, storeCode);
      }
    }
    // The lock exists. Reclaim it only when the previous owner is provably gone.
    let existing = null;
    try {
      existing = JSON.parse(String(await fs.readFile(path)));
    } catch {
      existing = null;
    }
    if (!isProvablyStale(existing, { pid, isProcessAlive })) {
      throw new WebApiLockError(heldCode, storeCode);
    }
    try {
      await fs.remove(path);
      await fs.writeFileExclusive(path, serialized);
    } catch {
      // Another process won the reclaim race; treat the lock as held.
      throw new WebApiLockError(heldCode, storeCode);
    }
    return path;
  }

  /**
   * Release a lock only when this process still owns it, so a reclaimed lock
   * belonging to somebody else is never deleted.
   */
  async function releaseOwned(path) {
    let record = null;
    try {
      record = JSON.parse(String(await fs.readFile(path)));
    } catch {
      // Already gone, or unreadable: nothing this process may safely delete.
      return false;
    }
    if (record?.ownerPid !== pid) return false;
    try {
      await fs.remove(path);
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    /**
     * Acquire the global lock and then the canonical Profile lock.
     *
     * @returns {Promise<{storeCode: string, release: () => Promise<{released: boolean}>}>}
     */
    async acquire(storeCode) {
      const canonical = String(storeCode ?? '').trim().toUpperCase();
      if (!WEBAPI_STORE_CODES.includes(canonical)) {
        throw new WebApiLockError(LOCK_REJECT_CODES.STORE_NOT_ALLOWED, null);
      }
      await fs.mkdir(lockDirectory);
      const globalPath = await claim(
        GLOBAL_LOCK_NAME,
        canonical,
        LOCK_REJECT_CODES.GLOBAL_HELD,
      );
      let profilePath;
      try {
        profilePath = await claim(
          lockFileName(canonical),
          canonical,
          LOCK_REJECT_CODES.PROFILE_HELD,
        );
      } catch (error) {
        // Never leave the global lock behind when the Profile lock is refused.
        await releaseOwned(globalPath);
        throw error;
      }

      let released = false;
      return Object.freeze({
        storeCode: canonical,
        async release() {
          if (released) return { released: false };
          released = true;
          // Reverse acquisition order.
          const profileReleased = await releaseOwned(profilePath);
          const globalReleased = await releaseOwned(globalPath);
          return { released: profileReleased && globalReleased };
        },
      });
    },
  });
}
