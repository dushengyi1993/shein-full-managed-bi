/**
 * Linux-only, gated, one-store-at-a-time browser session for the isolated
 * WebAPI experiment.
 *
 * Everything external is injected: the process spawner, the filesystem probes,
 * the lock manager and the CDP client factory. On Windows, without the explicit
 * production gate, without the Linux browser dependencies, or without the
 * canonical Profile directory, the guard fails *before* any process could be
 * created.
 *
 * The session never reads a cookie, a storage entry or a response header. Its
 * only capability is "evaluate one expression in the already-authenticated
 * page". Cleanup is deterministic and idempotent, kills only the two PIDs it
 * started itself, and is exposed as `close` so the CLI owns signal handling.
 */

import {
  WEBAPI_ORIGIN,
} from './endpoint-allowlist.mjs';
import {
  assertRealProfileLaunchAllowed,
  resolveProfileKey,
  WEBAPI_PROFILE_ROOT,
  WEBAPI_EXPERIMENT_GATE_PATH,
  REQUIRED_LINUX_DEPENDENCIES,
  WEBAPI_STORE_CODES,
} from './profile-guard.mjs';
import { createCdpClient } from './cdp-client.mjs';
import { TRANSPORT_REJECT_CODES } from './page-transport.mjs';

/**
 * Deterministic, bounded, loopback-only allocation per canonical store.
 *
 * A fixed pair per store keeps the runtime reproducible and auditable, and the
 * per-Profile lock already guarantees only one session per store exists.
 */
export const STORE_RUNTIME_SLOTS = Object.freeze({
  DL5477: Object.freeze({ debuggingPort: 39_541, display: ':941' }),
  MZ2406: Object.freeze({ debuggingPort: 39_542, display: ':942' }),
});

export const SESSION_REJECT_CODES = Object.freeze({
  STORE_NOT_ALLOWED: 'WEBAPI_SESSION_STORE_NOT_ALLOWED',
  DEPENDENCIES_MISSING: 'WEBAPI_SESSION_DEPENDENCIES_MISSING',
  LAUNCH_BLOCKED: 'WEBAPI_SESSION_LAUNCH_BLOCKED',
  DISPLAY_START_FAILED: 'WEBAPI_SESSION_DISPLAY_START_FAILED',
  BROWSER_START_FAILED: 'WEBAPI_SESSION_BROWSER_START_FAILED',
  DEBUGGER_UNAVAILABLE: 'WEBAPI_SESSION_DEBUGGER_UNAVAILABLE',
  NAVIGATION_FAILED: 'WEBAPI_SESSION_NAVIGATION_FAILED',
  ORIGIN_MISMATCH: 'WEBAPI_SESSION_ORIGIN_MISMATCH',
  IDENTITY_UNPROVEN: 'WEBAPI_SESSION_IDENTITY_UNPROVEN',
  AUTH_EXPIRED: 'WEBAPI_SESSION_AUTH_EXPIRED',
});

export const SESSION_STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  BLOCKED: 'BLOCKED',
  UNKNOWN: 'UNKNOWN',
});

export const SESSION_DEFAULT_LIMITS = Object.freeze({
  debuggerReadyMs: 25_000,
  debuggerPollMs: 500,
  navigationSettleMs: 6_000,
  identityTimeoutMs: 15_000,
  terminateGraceMs: 4_000,
});

export class WebApiSessionError extends Error {
  constructor(code, storeCode = null) {
    super(`webapi experiment session refused: ${code}`);
    this.name = 'WebApiSessionError';
    this.code = code;
    this.storeCode = storeCode;
  }
}

/**
 * Minimal honest identity proof.
 *
 * The experiment runtime cannot read `dim.store` and must not expose an account
 * value, so the page is asked three yes/no questions and returns booleans only:
 * same origin, not on a login/expired view, and the store alias' last four
 * digits appear somewhere in the rendered text.
 */
export function buildIdentityProofExpression({ origin, aliasDigits }) {
  const originLiteral = JSON.stringify(origin);
  const digitsLiteral = JSON.stringify(aliasDigits);
  return `(() => {
  try {
    const expectedOrigin = ${originLiteral};
    const aliasDigits = ${digitsLiteral};
    const sameOrigin = location.origin === expectedOrigin;
    const href = String(location.href || '');
    const text = String(document.body && document.body.innerText || '');
    const onLoginView = /\\/login\\//i.test(href) || /\\u767b\\u5f55/.test(text);
    const aliasPresent = aliasDigits.length === 4 && text.indexOf(aliasDigits) !== -1;
    return {
      sameOrigin: sameOrigin === true,
      onLoginView: onLoginView === true,
      aliasPresent: aliasPresent === true,
      textLength: text.length,
    };
  } catch (error) {
    return { sameOrigin: false, onLoginView: true, aliasPresent: false, textLength: 0 };
  }
})()`;
}

function aliasDigitsFor(storeCode) {
  const digits = String(storeCode).replace(/[^0-9]/g, '');
  return digits.slice(-4);
}

function chromeArguments({ profileDirectory, debuggingPort }) {
  return [
    `--user-data-dir=${profileDirectory}`,
    `--disk-cache-dir=${profileDirectory}/cache`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debuggingPort}`,
    '--profile-directory=Profile 1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // The experiment is read-only: nothing may be written to a download path.
    '--disable-features=DownloadBubble',
  ];
}

/**
 * Open one experiment session for exactly one canonical store.
 *
 * @param {object} input
 * @param {string} input.storeCode `DL5477` or `MZ2406`
 * @param {object} input.deps injected runtime
 * @returns {Promise<{storeCode: string, sessionState: string, evaluate: Function, close: Function}>}
 */
export async function openExperimentSession({ storeCode, deps } = {}) {
  const canonical = String(storeCode ?? '').trim().toUpperCase();
  if (!WEBAPI_STORE_CODES.includes(canonical)) {
    throw new WebApiSessionError(SESSION_REJECT_CODES.STORE_NOT_ALLOWED, null);
  }
  const slot = STORE_RUNTIME_SLOTS[canonical];
  const {
    platform,
    spawn,
    pathExists,
    which,
    httpJson,
    createWebSocket,
    lockManager,
    terminate,
    sleep,
    clock = () => new Date(),
    limits = SESSION_DEFAULT_LIMITS,
    cdpFactory = createCdpClient,
  } = deps ?? {};

  for (const dependency of [
    spawn, pathExists, which, httpJson, createWebSocket, terminate, sleep,
  ]) {
    if (typeof dependency !== 'function') {
      throw new WebApiSessionError(SESSION_REJECT_CODES.DEPENDENCIES_MISSING, canonical);
    }
  }
  if (!lockManager || typeof lockManager.acquire !== 'function') {
    throw new WebApiSessionError(SESSION_REJECT_CODES.DEPENDENCIES_MISSING, canonical);
  }
  const resolvedLimits = { ...SESSION_DEFAULT_LIMITS, ...limits };

  // Platform is checked first, so a non-Linux host does not even probe the
  // filesystem for a Profile, let alone spawn anything.
  assertRealProfileLaunchAllowed({
    storeCode: canonical,
    platform,
    gateExists: true,
    availableDependencies: REQUIRED_LINUX_DEPENDENCIES,
    profileExists: true,
  });

  const profileKey = resolveProfileKey(canonical);
  const profileDirectory = `${WEBAPI_PROFILE_ROOT}/${profileKey}`;

  // Gate, dependency and Profile checks all happen before any spawn.
  const availableDependencies = [];
  for (const dependency of REQUIRED_LINUX_DEPENDENCIES) {
    if (await which(dependency)) availableDependencies.push(dependency);
  }
  assertRealProfileLaunchAllowed({
    storeCode: canonical,
    platform,
    gateExists: await pathExists(WEBAPI_EXPERIMENT_GATE_PATH),
    availableDependencies,
    profileExists: await pathExists(profileDirectory),
  });

  const lease = await lockManager.acquire(canonical);

  let displayProcess = null;
  let browserProcess = null;
  let cdp = null;
  let closed = false;

  async function close() {
    if (closed) return { closed: false };
    closed = true;
    // Deterministic reverse order; every step is independent so one failure
    // cannot strand the next. Only the two PIDs this function started are ever
    // signalled: no pattern or name matching.
    try {
      cdp?.close();
    } catch {
      /* already gone */
    }
    for (const child of [browserProcess, displayProcess]) {
      if (!child || !Number.isSafeInteger(child.pid)) continue;
      try {
        await terminate(child.pid, { graceMs: resolvedLimits.terminateGraceMs });
      } catch {
        /* the child already exited */
      }
    }
    try {
      await lease.release();
    } catch {
      /* the lock was already reclaimed */
    }
    return { closed: true };
  }

  try {
    displayProcess = await spawn('Xvfb', [slot.display, '-screen', '0', '1280x900x24'], {
      display: slot.display,
    });
    if (!displayProcess || !Number.isSafeInteger(displayProcess.pid)) {
      throw new WebApiSessionError(SESSION_REJECT_CODES.DISPLAY_START_FAILED, canonical);
    }

    browserProcess = await spawn(
      'chrome',
      chromeArguments({ profileDirectory, debuggingPort: slot.debuggingPort }),
      { display: slot.display },
    );
    if (!browserProcess || !Number.isSafeInteger(browserProcess.pid)) {
      throw new WebApiSessionError(SESSION_REJECT_CODES.BROWSER_START_FAILED, canonical);
    }

    // Bounded wait for the loopback debugging endpoint.
    const deadline = clock().valueOf() + resolvedLimits.debuggerReadyMs;
    let ready = false;
    while (clock().valueOf() < deadline) {
      try {
        await httpJson(`http://127.0.0.1:${slot.debuggingPort}/json/version`, {
          timeoutMs: resolvedLimits.debuggerPollMs * 4,
        });
        ready = true;
        break;
      } catch {
        await sleep(resolvedLimits.debuggerPollMs);
      }
    }
    if (!ready) {
      throw new WebApiSessionError(SESSION_REJECT_CODES.DEBUGGER_UNAVAILABLE, canonical);
    }

    cdp = await cdpFactory({
      port: slot.debuggingPort,
      httpJson,
      createWebSocket,
      originPattern: new RegExp(`^${WEBAPI_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    });

    // The only navigation target is the allow-listed origin.
    try {
      await cdp.send('Page.navigate', { url: WEBAPI_ORIGIN });
    } catch {
      throw new WebApiSessionError(SESSION_REJECT_CODES.NAVIGATION_FAILED, canonical);
    }
    await sleep(resolvedLimits.navigationSettleMs);

    const proof = await cdp.evaluate(
      buildIdentityProofExpression({
        origin: WEBAPI_ORIGIN,
        aliasDigits: aliasDigitsFor(canonical),
      }),
      { timeoutMs: resolvedLimits.identityTimeoutMs },
    );
    if (proof?.sameOrigin !== true) {
      throw new WebApiSessionError(SESSION_REJECT_CODES.ORIGIN_MISMATCH, canonical);
    }
    if (proof?.onLoginView === true) {
      throw new WebApiSessionError(SESSION_REJECT_CODES.AUTH_EXPIRED, canonical);
    }
    if (proof?.aliasPresent !== true) {
      // The Profile may be logged in as another account; refuse rather than
      // attribute somebody else's data to this store.
      throw new WebApiSessionError(SESSION_REJECT_CODES.IDENTITY_UNPROVEN, canonical);
    }

    return Object.freeze({
      storeCode: canonical,
      // Needed by the experiment repository's canonical store/Profile pairing
      // check. It is never printed: the CLI output projection omits it.
      profileKey,
      sessionState: SESSION_STATES.ACTIVE,
      identityProven: true,
      // Deliberately narrow: the transport may only evaluate an expression.
      evaluate: (expression, options) => cdp.evaluate(expression, options),
      close,
    });
  } catch (error) {
    await close();
    throw error;
  }
}

/** Map a session failure to the append-only health vocabulary. */
export function sessionStateForFailure(code) {
  if (
    code === SESSION_REJECT_CODES.AUTH_EXPIRED
    || code === TRANSPORT_REJECT_CODES.AUTH_EXPIRED
  ) {
    return SESSION_STATES.EXPIRED;
  }
  if (
    code === SESSION_REJECT_CODES.IDENTITY_UNPROVEN
    || code === SESSION_REJECT_CODES.ORIGIN_MISMATCH
    || code === SESSION_REJECT_CODES.LAUNCH_BLOCKED
  ) {
    return SESSION_STATES.BLOCKED;
  }
  return SESSION_STATES.UNKNOWN;
}
