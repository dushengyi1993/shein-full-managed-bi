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
  WEBAPI_HOME_URL,
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
import { fullManagedRuntimeSlot } from '../config/full-managed-stores.mjs';
import {
  DEFAULT_FULL_MANAGED_LOGIN_IDENTITY_ALIASES_FILE,
  fullManagedLoginIdentityMarkers,
  loadFullManagedLoginIdentityAliases,
} from '../config/full-managed-login-identities.mjs';
import { createCdpClient } from './cdp-client.mjs';
import { TRANSPORT_REJECT_CODES } from './page-transport.mjs';

const LOGIN_IDENTITY_ALIASES = loadFullManagedLoginIdentityAliases(
  process.env.FULL_FM_WEBAPI_IDENTITY_ALIASES_FILE
    || DEFAULT_FULL_MANAGED_LOGIN_IDENTITY_ALIASES_FILE,
);

/**
 * Deterministic, bounded, loopback-only allocation per canonical store.
 *
 * A fixed pair per store keeps the runtime reproducible and auditable, and the
 * per-Profile lock already guarantees only one session per store exists.
 */
export const STORE_RUNTIME_SLOTS = Object.freeze(Object.fromEntries(
  WEBAPI_STORE_CODES.map((storeCode) => [storeCode, fullManagedRuntimeSlot(storeCode)]),
));

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
  displayReadyMs: 500,
  debuggerReadyMs: 25_000,
  debuggerPollMs: 500,
  navigationSettleMs: 6_000,
  identityStabilityMs: 6_000,
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
 * same origin, not on a login/expired view, and one configured identity marker
 * appears somewhere in the rendered text.
 */
export function buildIdentityProofExpression({ origin, aliasDigits, identityMarkers }) {
  const originLiteral = JSON.stringify(origin);
  const markers = Array.isArray(identityMarkers)
    ? identityMarkers
    : [aliasDigits];
  const markersLiteral = JSON.stringify(
    [...new Set(markers.map((value) => String(value || '').trim()).filter(Boolean))],
  );
  return `(() => {
  try {
    const expectedOrigin = ${originLiteral};
    const identityMarkers = ${markersLiteral};
    const sameOrigin = location.origin === expectedOrigin;
    const href = String(location.href || '');
    const text = String(document.body && document.body.innerText || '');
    const onLoginView = /\\/login\\//i.test(href) || /\\u767b\\u5f55/.test(text);
    const aliasPresent = identityMarkers.length > 0
      && identityMarkers.some((marker) => text.indexOf(marker) !== -1);
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

export function buildSavedCredentialAccountBoxExpression() {
  return `(() => {
  try {
    const account = Array.from(document.querySelectorAll('input')).find((item) => {
      const type = String(item.type || '').toLowerCase();
      return type === 'text' || type === 'email' || type === 'tel';
    });
    if (!account) return { found: false, x: 0, y: 0 };
    const rect = account.getBoundingClientRect();
    const found = rect.width > 0 && rect.height > 0;
    return {
      found,
      x: found ? rect.left + rect.width / 2 : 0,
      y: found ? rect.top + rect.height / 2 : 0,
    };
  } catch {
    return { found: false, x: 0, y: 0 };
  }
})()`;
}

/**
 * Saved-credential renewal is deliberately boolean-only: it may ask Chrome
 * whether the username and password fields are already populated and click the
 * visible submit button, but it never reads or returns either value.
 */
export function buildSavedCredentialSubmitExpression() {
  return `(() => {
  try {
    const inputs = Array.from(document.querySelectorAll('input'));
    const password = inputs.find((item) => String(item.type || '').toLowerCase() === 'password');
    const account = inputs.find((item) => {
      const type = String(item.type || '').toLowerCase();
      return type === 'text' || type === 'email' || type === 'tel';
    });
    const accountReady = Boolean(account && String(account.value || '').length > 0);
    const passwordReady = Boolean(password && String(password.value || '').length > 0);
    const submit = document.querySelector('button[type="submit"], input[type="submit"]')
      || Array.from(document.querySelectorAll('button')).find((item) => /登录|登錄|login/i.test(String(item.innerText || '')));
    const submitReady = Boolean(submit && !submit.disabled);
    if (accountReady && passwordReady && submitReady) submit.click();
    return { accountReady, passwordReady, submitReady, clicked: accountReady && passwordReady && submitReady };
  } catch {
    return { accountReady: false, passwordReady: false, submitReady: false, clicked: false };
  }
})()`;
}

function chromeArguments({ profileDirectory, debuggingPort }) {
  return [
    `--user-data-dir=${profileDirectory}`,
    `--disk-cache-dir=${profileDirectory}/cache`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debuggingPort}`,
    '--profile-directory=Profile 1',
    '--password-store=basic',
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
 * @param {string} input.storeCode canonical store code from the 25-store roster
 * @param {object} input.deps injected runtime
 * @returns {Promise<{storeCode: string, sessionState: string, evaluate: Function, close: Function}>}
 */
export async function openExperimentSession({
  storeCode,
  deps,
  gatePath = WEBAPI_EXPERIMENT_GATE_PATH,
  allowSavedCredentialLogin = false,
  identityAliases = LOGIN_IDENTITY_ALIASES,
} = {}) {
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
    gateExists: await pathExists(gatePath),
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
    // Xvfb returns a process handle before its Unix socket is necessarily ready.
    // A short bounded settle avoids racing Chrome against display startup.
    await sleep(resolvedLimits.displayReadyMs);

    browserProcess = await spawn(
      'chrome',
      chromeArguments({ profileDirectory, debuggingPort: slot.debuggingPort }),
      {
        display: slot.display,
        // Chrome 148 writes crashpad and desktop-integration state below HOME.
        // Keep those writes inside the canonical, store-owned Profile instead
        // of widening permissions on the service root.
        homeDirectory: profileDirectory,
      },
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

    // The only navigation target is the allow-listed full-managed home route.
    // Navigating to the bare origin can briefly render stale cached content
    // before the SPA redirects to an expired-login view.
    try {
      await cdp.send('Page.navigate', { url: WEBAPI_HOME_URL });
    } catch {
      throw new WebApiSessionError(SESSION_REJECT_CODES.NAVIGATION_FAILED, canonical);
    }
    await sleep(resolvedLimits.navigationSettleMs);

    let proof = await cdp.evaluate(
      buildIdentityProofExpression({
        origin: WEBAPI_ORIGIN,
        identityMarkers: fullManagedLoginIdentityMarkers(canonical, identityAliases),
      }),
      { timeoutMs: resolvedLimits.identityTimeoutMs },
    );
    if (
      proof?.sameOrigin === true
      && proof?.onLoginView !== true
    ) {
      // The account badge is rendered after the shell on some otherwise valid
      // Profiles. Recheck once after the bounded stability delay whether the
      // first proof was positive or still waiting for that badge; a genuinely
      // wrong account remains blocked by the second proof below.
      await sleep(resolvedLimits.identityStabilityMs);
      proof = await cdp.evaluate(
        buildIdentityProofExpression({
          origin: WEBAPI_ORIGIN,
          identityMarkers: fullManagedLoginIdentityMarkers(canonical, identityAliases),
        }),
        { timeoutMs: resolvedLimits.identityTimeoutMs },
      );
    }
    if (proof?.sameOrigin !== true) {
      throw new WebApiSessionError(SESSION_REJECT_CODES.ORIGIN_MISMATCH, canonical);
    }
    if (proof?.onLoginView === true && allowSavedCredentialLogin === true) {
      const accountBox = await cdp.evaluate(
        buildSavedCredentialAccountBoxExpression(),
        { timeoutMs: resolvedLimits.identityTimeoutMs },
      );
      if (
        accountBox?.found === true
        && Number.isFinite(accountBox.x)
        && Number.isFinite(accountBox.y)
      ) {
        await cdp.savedCredentialGesture('focus', {
          x: accountBox.x,
          y: accountBox.y,
        });
        await sleep(800);
        await cdp.savedCredentialGesture('next');
        await sleep(500);
        await cdp.savedCredentialGesture('confirm');
        await sleep(500);
        await sleep(1_200);
      }
      const renewal = await cdp.evaluate(
        buildSavedCredentialSubmitExpression(),
        { timeoutMs: resolvedLimits.identityTimeoutMs },
      );
      if (renewal?.clicked === true) {
        await sleep(8_000);
        proof = await cdp.evaluate(
          buildIdentityProofExpression({
            origin: WEBAPI_ORIGIN,
            identityMarkers: fullManagedLoginIdentityMarkers(canonical, identityAliases),
          }),
          { timeoutMs: resolvedLimits.identityTimeoutMs },
        );
      }
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
