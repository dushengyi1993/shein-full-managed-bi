import {
  FULL_MANAGED_STORE_CODES,
  fullManagedProfileKey,
} from '../config/full-managed-stores.mjs';

/**
 * Fail-closed launch guard for the persistent browser Profiles.
 *
 * Every check runs *before* a process, a browser or a network client could be
 * created. The guard returns a description only; it never spawns anything and it
 * never reads Cookie, localStorage or any credential file.
 */

export const WEBAPI_EXPERIMENT_GATE_PATH =
  '/srv/shein-fm/runtime/webapi-experiment.enabled';

export const WEBAPI_PROFILE_ROOT = '/srv/shein-fm/webapi/profiles';

export const WEBAPI_STORE_CODES = FULL_MANAGED_STORE_CODES;

export const WEBAPI_PROFILE_KEYS = Object.freeze(Object.fromEntries(
  WEBAPI_STORE_CODES.map((storeCode) => [storeCode, fullManagedProfileKey(storeCode)]),
));

export const REQUIRED_LINUX_DEPENDENCIES = Object.freeze([
  'chrome',
  'xvfb',
]);

export const LAUNCH_REJECT_CODES = Object.freeze({
  PLATFORM_UNSUPPORTED: 'WEBAPI_LAUNCH_PLATFORM_UNSUPPORTED',
  GATE_MISSING: 'WEBAPI_LAUNCH_GATE_MISSING',
  DEPENDENCY_MISSING: 'WEBAPI_LAUNCH_DEPENDENCY_MISSING',
  STORE_NOT_ALLOWED: 'WEBAPI_LAUNCH_STORE_NOT_ALLOWED',
  PROFILE_KEY_INVALID: 'WEBAPI_LAUNCH_PROFILE_KEY_INVALID',
  PROFILE_MISSING: 'WEBAPI_LAUNCH_PROFILE_MISSING',
});

export class WebApiLaunchBlockedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebApiLaunchBlockedError';
    this.code = code;
  }
}

/**
 * Canonical store codes only. A bare `DL` or `MZ` is never accepted or derived.
 */
export function resolveProfileKey(storeCode) {
  const normalized = String(storeCode ?? '').trim().toUpperCase();
  if (!WEBAPI_STORE_CODES.includes(normalized)) {
    throw new WebApiLaunchBlockedError(
      LAUNCH_REJECT_CODES.STORE_NOT_ALLOWED,
      'store is outside the configured full-managed roster',
    );
  }
  return WEBAPI_PROFILE_KEYS[normalized];
}

export function isCanonicalProfileKey(profileKey, storeCode) {
  const normalized = String(storeCode ?? '').trim().toUpperCase();
  return WEBAPI_PROFILE_KEYS[normalized] === String(profileKey ?? '');
}

/**
 * @param {object} input
 * @param {string} input.storeCode canonical store code
 * @param {string} input.platform `process.platform`
 * @param {boolean} input.gateExists explicit production gate file presence
 * @param {string[]} input.availableDependencies resolved dependency names
 * @param {boolean} input.profileExists Profile directory presence
 * @returns {{storeCode: string, profileKey: string, profileDirectory: string}}
 */
export function assertRealProfileLaunchAllowed({
  storeCode,
  platform,
  gateExists = false,
  availableDependencies = [],
  profileExists = false,
} = {}) {
  if (String(platform ?? '') !== 'linux') {
    // Windows and macOS never own the persistent server Profiles.
    throw new WebApiLaunchBlockedError(
      LAUNCH_REJECT_CODES.PLATFORM_UNSUPPORTED,
      'the persistent Profile may only be opened on the Linux runtime host',
    );
  }
  if (gateExists !== true) {
    throw new WebApiLaunchBlockedError(
      LAUNCH_REJECT_CODES.GATE_MISSING,
      'the explicit WebAPI experiment gate is absent',
    );
  }
  const available = new Set(
    (Array.isArray(availableDependencies) ? availableDependencies : [])
      .map((item) => String(item ?? '').trim().toLowerCase()),
  );
  const missing = REQUIRED_LINUX_DEPENDENCIES.filter((item) => !available.has(item));
  if (missing.length > 0) {
    throw new WebApiLaunchBlockedError(
      LAUNCH_REJECT_CODES.DEPENDENCY_MISSING,
      'a required Linux browser dependency is unavailable',
    );
  }
  const profileKey = resolveProfileKey(storeCode);
  if (!isCanonicalProfileKey(profileKey, storeCode)) {
    throw new WebApiLaunchBlockedError(
      LAUNCH_REJECT_CODES.PROFILE_KEY_INVALID,
      'resolved Profile key is not canonical',
    );
  }
  if (profileExists !== true) {
    throw new WebApiLaunchBlockedError(
      LAUNCH_REJECT_CODES.PROFILE_MISSING,
      'the persistent Profile directory is absent',
    );
  }
  return Object.freeze({
    storeCode: String(storeCode).trim().toUpperCase(),
    profileKey,
    // Returned for the operator runbook only; the CLI never prints this value.
    profileDirectory: `${WEBAPI_PROFILE_ROOT}/${profileKey}`,
  });
}
