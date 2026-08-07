import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SESSION_REJECT_CODES,
  SESSION_STATES,
  STORE_RUNTIME_SLOTS,
  buildIdentityProofExpression,
  buildSavedCredentialAccountBoxExpression,
  openExperimentSession,
  sessionStateForFailure,
} from '../../src/webapi-experiment/browser-session.mjs';
import {
  GLOBAL_LOCK_NAME,
  LOCK_REJECT_CODES,
  WebApiLockError,
  createExperimentLockManager,
} from '../../src/webapi-experiment/profile-lock.mjs';
import {
  LAUNCH_REJECT_CODES,
  WEBAPI_EXPERIMENT_GATE_PATH,
  WEBAPI_PROFILE_ROOT,
} from '../../src/webapi-experiment/profile-guard.mjs';
import {
  WEBAPI_HOME_URL,
  WEBAPI_ORIGIN,
} from '../../src/webapi-experiment/endpoint-allowlist.mjs';
import { TRANSPORT_REJECT_CODES } from '../../src/webapi-experiment/page-transport.mjs';
import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';

/** In-memory filesystem for lock tests. Nothing touches a real path. */
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async mkdir() { return true; },
    async writeFileExclusive(path, contents) {
      if (files.has(path)) {
        const error = new Error('exists');
        error.code = 'EEXIST';
        throw error;
      }
      files.set(path, contents);
      return true;
    },
    async readFile(path) {
      if (!files.has(path)) throw new Error('missing');
      return files.get(path);
    },
    async remove(path) {
      files.delete(path);
      return true;
    },
  };
}

function lockManager(fs, { pid = 4242, alive = () => true } = {}) {
  return createExperimentLockManager({
    fs,
    pid,
    isProcessAlive: alive,
    lockDirectory: '/srv/shein-fm/runtime/locks',
    clock: () => new Date('2026-07-28T00:00:00.000Z'),
  });
}

/** Session doubles. No process is spawned and no socket is opened. */
function sessionDeps(overrides = {}) {
  const spawned = [];
  const terminated = [];
  const evaluated = [];
  const commands = [];
  const cdp = {
    async send(method, params) {
      commands.push({ method, params });
      return {};
    },
    async evaluate(expression) {
      evaluated.push(String(expression));
      return {
        sameOrigin: true,
        onLoginView: false,
        aliasPresent: true,
        textLength: 1200,
      };
    },
    close() { commands.push({ method: 'close' }); },
  };
  return {
    spawned,
    terminated,
    evaluated,
    commands,
    deps: {
      platform: 'linux',
      async spawn(command, args, options) {
        spawned.push({ command, args, options });
        return { pid: 1000 + spawned.length };
      },
      async pathExists() { return true; },
      async which(name) { return name; },
      async httpJson() { return { Browser: 'ok' }; },
      createWebSocket() { return { addEventListener() {}, send() {}, close() {} }; },
      lockManager: {
        async acquire(storeCode) {
          return { storeCode, async release() { return { released: true }; } };
        },
      },
      async terminate(pid, options) { terminated.push({ pid, options }); },
      async sleep() {},
      cdpFactory: async () => cdp,
      limits: { navigationSettleMs: 0, debuggerPollMs: 1, debuggerReadyMs: 50 },
      ...overrides,
    },
  };
}

test('the runtime slot allocation is deterministic and loopback-bounded per store', () => {
  assert.deepEqual(Object.keys(STORE_RUNTIME_SLOTS).sort(), [...FULL_MANAGED_STORE_CODES].sort());
  const ports = Object.values(STORE_RUNTIME_SLOTS).map((slot) => slot.debuggingPort);
  assert.equal(new Set(ports).size, FULL_MANAGED_STORE_CODES.length);
  for (const port of ports) {
    assert.ok(Number.isSafeInteger(port) && port > 1024 && port < 65_535, String(port));
    assert.ok(port > 60_999, `${port} must remain outside Linux's default ephemeral range`);
  }
});

test('a non-Linux platform fails before any process could be spawned', async () => {
  for (const platform of ['win32', 'darwin', '', undefined]) {
    const { spawned, deps } = sessionDeps({ platform });
    await assert.rejects(
      () => openExperimentSession({ storeCode: 'DL5477', deps }),
      (error) => error.code === LAUNCH_REJECT_CODES.PLATFORM_UNSUPPORTED,
      String(platform),
    );
    assert.deepEqual(spawned, [], 'no process may be spawned on a non-Linux host');
  }
});

test('missing gate, dependency or Profile fails before any process could be spawned', async () => {
  const cases = [
    [{ async pathExists(path) { return path !== WEBAPI_EXPERIMENT_GATE_PATH; } },
      LAUNCH_REJECT_CODES.GATE_MISSING],
    [{ async which(name) { return name === 'chrome' ? name : null; } },
      LAUNCH_REJECT_CODES.DEPENDENCY_MISSING],
    [{ async pathExists(path) { return !path.startsWith(WEBAPI_PROFILE_ROOT); } },
      LAUNCH_REJECT_CODES.PROFILE_MISSING],
  ];
  for (const [override, expected] of cases) {
    const { spawned, deps } = sessionDeps(override);
    await assert.rejects(
      () => openExperimentSession({ storeCode: 'MZ2406', deps }),
      (error) => error.code === expected,
      expected,
    );
    assert.deepEqual(spawned, [], expected);
  }
  // A non-canonical store never reaches the guard at all.
  for (const storeCode of ['DL', 'MZ', 'ZZ0000', '']) {
    const { spawned, deps } = sessionDeps();
    await assert.rejects(() => openExperimentSession({ storeCode, deps }));
    assert.deepEqual(spawned, [], storeCode);
  }
});

test('a successful session navigates only to the allow-listed origin and proves identity', async () => {
  const { spawned, commands, evaluated, deps } = sessionDeps();
  const session = await openExperimentSession({ storeCode: 'DL5477', deps });
  assert.equal(session.storeCode, 'DL5477');
  assert.equal(session.profileKey, 'persistent-dl5477-profile');
  assert.equal(session.sessionState, SESSION_STATES.ACTIVE);
  assert.equal(session.identityProven, true);
  assert.equal(typeof session.evaluate, 'function');
  assert.equal(typeof session.close, 'function');

  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].command, 'Xvfb');
  assert.equal(spawned[1].command, 'chrome');
  const chromeArgs = spawned[1].args.join(' ');
  assert.match(chromeArgs, /--user-data-dir=\/srv\/shein-fm\/webapi\/profiles\/persistent-dl5477-profile/);
  assert.match(chromeArgs, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(chromeArgs, new RegExp(`--remote-debugging-port=${STORE_RUNTIME_SLOTS.DL5477.debuggingPort}`));
  assert.match(chromeArgs, /--disable-dev-shm-usage/);
  assert.equal(
    spawned[1].options.homeDirectory,
    '/srv/shein-fm/webapi/profiles/persistent-dl5477-profile',
  );

  const navigations = commands.filter((entry) => entry.method === 'Page.navigate');
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].params.url, WEBAPI_HOME_URL);
  // The identity proof asks yes/no questions and reads no credential.
  assert.equal(evaluated.length, 2);
  assert.doesNotMatch(evaluated[0], /document\.cookie|localStorage|sessionStorage/);
});

test('a slowly rendered account badge is rechecked before identity is rejected', async () => {
  let evaluation = 0;
  const { deps } = sessionDeps({
    cdpFactory: async () => ({
      async send() { return {}; },
      async evaluate() {
        evaluation += 1;
        return {
          sameOrigin: true,
          onLoginView: false,
          aliasPresent: evaluation >= 2,
          textLength: evaluation >= 2 ? 1200 : 80,
        };
      },
      close() {},
    }),
  });

  const session = await openExperimentSession({ storeCode: 'CX4412', deps });
  assert.equal(session.identityProven, true);
  assert.equal(evaluation, 2);
  await session.close();
});

test('an ambiguous SPA shell is polled until its late login form is ready', async () => {
  let evaluation = 0;
  const sleeps = [];
  const { deps } = sessionDeps({
    async sleep(milliseconds) { sleeps.push(milliseconds); },
    cdpFactory: async () => ({
      async send() { return {}; },
      async savedCredentialGesture() { return { completed: true }; },
      async evaluate() {
        evaluation += 1;
        if (evaluation <= 2) {
          return { sameOrigin: true, onLoginView: false, aliasPresent: false, textLength: 20 };
        }
        if (evaluation === 3) {
          return { sameOrigin: true, onLoginView: true, aliasPresent: false, textLength: 100 };
        }
        if (evaluation === 4) return { found: true, x: 320, y: 240 };
        if (evaluation === 5) {
          return { accountReady: true, passwordReady: true, submitReady: true, clicked: true };
        }
        return { sameOrigin: true, onLoginView: false, aliasPresent: true, textLength: 1200 };
      },
      close() {},
    }),
  });

  const session = await openExperimentSession({
    storeCode: 'CX2816',
    deps,
    allowSavedCredentialLogin: true,
  });
  assert.equal(session.identityProven, true);
  assert.equal(evaluation, 6);
  assert.equal(sleeps.includes(2_000), true);
  await session.close();
});

test('the identity proof returns booleans only and never an identity value', () => {
  const expression = buildIdentityProofExpression({ origin: WEBAPI_ORIGIN, aliasDigits: '5477' });
  assert.match(expression, /sameOrigin: sameOrigin === true/);
  assert.match(expression, /onLoginView: onLoginView === true/);
  assert.match(expression, /aliasPresent: aliasPresent === true/);
  // The rendered text is never returned, only its length and three booleans.
  assert.doesNotMatch(expression, /return[^;]*text\s*[,}]/);
  assert.doesNotMatch(expression, /document\.cookie|localStorage/);
});

test('a late login redirect still uses saved credentials without reading a value', async () => {
  const commands = [];
  const gestures = [];
  const evaluated = [];
  const sleeps = [];
  let evaluation = 0;
  const { deps } = sessionDeps({
    async sleep(milliseconds) { sleeps.push(milliseconds); },
    cdpFactory: async () => ({
      async send(method, params) {
        commands.push({ method, params });
        return {};
      },
      async savedCredentialGesture(stage, point) {
        gestures.push({ stage, point });
        return { completed: true };
      },
      async evaluate(expression) {
        evaluated.push(String(expression));
        evaluation += 1;
        if (evaluation === 1) {
          return { sameOrigin: true, onLoginView: false, aliasPresent: true, textLength: 1200 };
        }
        if (evaluation === 2) {
          return { sameOrigin: true, onLoginView: true, aliasPresent: false, textLength: 100 };
        }
        if (evaluation === 3) return { found: true, x: 320, y: 240 };
        if (evaluation === 4) {
          return {
            accountReady: true,
            passwordReady: true,
            submitReady: true,
            clicked: true,
          };
        }
        if (evaluation < 7) {
          return { sameOrigin: true, onLoginView: true, aliasPresent: false, textLength: 100 };
        }
        return { sameOrigin: true, onLoginView: false, aliasPresent: true, textLength: 1200 };
      },
      close() {},
    }),
  });
  const session = await openExperimentSession({
    storeCode: 'NM7397',
    deps,
    allowSavedCredentialLogin: true,
    identityAliases: { NM7397: ['test-subaccount-7343'] },
  });
  assert.equal(session.identityProven, true);
  assert.match(evaluated[0], /test-subaccount-7343/);
  assert.match(evaluated[2], /getBoundingClientRect/);
  assert.doesNotMatch(evaluated.join('\n'), /document\.cookie|localStorage|sessionStorage/);
  assert.deepEqual(gestures, [
    { stage: 'focus', point: { x: 320, y: 240 } },
    { stage: 'next', point: undefined },
    { stage: 'confirm', point: undefined },
  ]);
  assert.deepEqual(commands.filter((entry) => entry.method.startsWith('Input.')), []);
  assert.deepEqual(sleeps.slice(-3), [2_000, 2_000, 2_000]);
  assert.equal(sleeps.includes(8_000), false);
  await session.close();
});

test('saved credential verification polls to a bounded deadline before expiring', async () => {
  const sleeps = [];
  let evaluation = 0;
  const { deps } = sessionDeps({
    async sleep(milliseconds) { sleeps.push(milliseconds); },
    limits: {
      navigationSettleMs: 0,
      debuggerPollMs: 1,
      debuggerReadyMs: 50,
      savedCredentialVerifyMs: 6_000,
      savedCredentialPollMs: 2_000,
    },
    cdpFactory: async () => ({
      async send() { return {}; },
      async savedCredentialGesture() { return { completed: true }; },
      async evaluate() {
        evaluation += 1;
        if (evaluation === 1) {
          return { sameOrigin: true, onLoginView: true, aliasPresent: false, textLength: 100 };
        }
        if (evaluation === 2) return { found: true, x: 320, y: 240 };
        if (evaluation === 3) {
          return {
            accountReady: true,
            passwordReady: true,
            submitReady: true,
            clicked: true,
          };
        }
        return { sameOrigin: true, onLoginView: true, aliasPresent: false, textLength: 100 };
      },
      close() {},
    }),
  });

  await assert.rejects(
    () => openExperimentSession({
      storeCode: 'DL5477',
      deps,
      allowSavedCredentialLogin: true,
    }),
    (error) => error.code === SESSION_REJECT_CODES.AUTH_EXPIRED,
  );
  assert.equal(evaluation, 6);
  assert.deepEqual(sleeps.slice(-3), [2_000, 2_000, 2_000]);
});

test('saved credential selection retries when Chrome has only painted a preview', async () => {
  let evaluation = 0;
  const gestures = [];
  const { deps } = sessionDeps({
    limits: {
      navigationSettleMs: 0,
      debuggerPollMs: 1,
      debuggerReadyMs: 50,
      savedCredentialVerifyMs: 6_000,
      savedCredentialPollMs: 2_000,
    },
    cdpFactory: async () => ({
      async send() { return {}; },
      async savedCredentialGesture(stage) {
        gestures.push(stage);
        return { completed: true };
      },
      async evaluate() {
        evaluation += 1;
        if (evaluation === 1) {
          return { sameOrigin: true, onLoginView: true, aliasPresent: false, textLength: 100 };
        }
        if (evaluation === 2 || evaluation === 4) return { found: true, x: 320, y: 240 };
        if (evaluation === 3) {
          return { accountReady: false, passwordReady: false, submitReady: true, clicked: false };
        }
        if (evaluation === 5) {
          return { accountReady: true, passwordReady: true, submitReady: true, clicked: true };
        }
        return { sameOrigin: true, onLoginView: false, aliasPresent: true, textLength: 1200 };
      },
      close() {},
    }),
  });

  const session = await openExperimentSession({
    storeCode: 'MZ2406',
    deps,
    allowSavedCredentialLogin: true,
  });
  assert.equal(session.identityProven, true);
  assert.deepEqual(gestures, ['focus', 'next', 'confirm', 'focus', 'next', 'confirm']);
  await session.close();
});

test('the saved credential account probe returns coordinates and never a field value', () => {
  const expression = buildSavedCredentialAccountBoxExpression();
  assert.match(expression, /getBoundingClientRect/);
  assert.doesNotMatch(expression, /\.value|password|document\.cookie|localStorage/);
});

test('origin mismatch, login view and a wrong account all fail closed and clean up', async () => {
  const cases = [
    [{ sameOrigin: false, onLoginView: false, aliasPresent: true },
      SESSION_REJECT_CODES.ORIGIN_MISMATCH, SESSION_STATES.BLOCKED],
    [{ sameOrigin: true, onLoginView: true, aliasPresent: true },
      SESSION_REJECT_CODES.AUTH_EXPIRED, SESSION_STATES.EXPIRED],
    [{ sameOrigin: true, onLoginView: false, aliasPresent: false },
      SESSION_REJECT_CODES.IDENTITY_UNPROVEN, SESSION_STATES.BLOCKED],
  ];
  for (const [proof, expectedCode, expectedState] of cases) {
    const released = [];
    const { terminated, deps } = sessionDeps({
      cdpFactory: async () => ({
        async send() { return {}; },
        async evaluate() { return proof; },
        close() {},
      }),
      lockManager: {
        async acquire(storeCode) {
          return { storeCode, async release() { released.push(storeCode); return { released: true }; } };
        },
      },
    });
    await assert.rejects(
      () => openExperimentSession({ storeCode: 'DL5477', deps }),
      (error) => error.code === expectedCode,
      expectedCode,
    );
    // Both tracked PIDs are signalled and the lock is returned.
    assert.deepEqual(terminated.map((entry) => entry.pid), [1002, 1001], expectedCode);
    assert.deepEqual(released, ['DL5477'], expectedCode);
    assert.equal(sessionStateForFailure(expectedCode), expectedState);
  }
  assert.equal(
    sessionStateForFailure(TRANSPORT_REJECT_CODES.AUTH_EXPIRED),
    SESSION_STATES.EXPIRED,
  );
});

test('close is idempotent, ordered and signals only the tracked PIDs', async () => {
  const released = [];
  const { terminated, deps } = sessionDeps({
    lockManager: {
      async acquire(storeCode) {
        return { storeCode, async release() { released.push(storeCode); return { released: true }; } };
      },
    },
  });
  const session = await openExperimentSession({ storeCode: 'MZ2406', deps });
  assert.deepEqual(await session.close(), { closed: true });
  // Chrome first, then Xvfb: reverse of launch order.
  assert.deepEqual(terminated.map((entry) => entry.pid), [1002, 1001]);
  assert.deepEqual(released, ['MZ2406']);
  // A second close is a no-op: no extra signal, no double release.
  assert.deepEqual(await session.close(), { closed: false });
  assert.equal(terminated.length, 2);
  assert.equal(released.length, 1);
});

test('a debugger that never becomes ready fails closed after cleanup', async () => {
  const { terminated, deps } = sessionDeps({
    async httpJson() { throw new Error('refused'); },
  });
  await assert.rejects(
    () => openExperimentSession({ storeCode: 'DL5477', deps }),
    (error) => error.code === SESSION_REJECT_CODES.DEBUGGER_UNAVAILABLE,
  );
  assert.deepEqual(terminated.map((entry) => entry.pid), [1002, 1001]);
});

test('the global lock and the per-Profile lock are both required and both released', async () => {
  const fs = memoryFs();
  const lease = await lockManager(fs).acquire('DL5477');
  assert.equal(lease.storeCode, 'DL5477');
  assert.equal(fs.files.size, 2);
  assert.ok([...fs.files.keys()].some((path) => path.endsWith(GLOBAL_LOCK_NAME)));
  assert.ok([...fs.files.keys()].some((path) => path.endsWith('webapi-experiment.dl5477.lock')));

  // A second store cannot run while the global lock is held by a live owner.
  await assert.rejects(
    () => lockManager(fs, { pid: 5555 }).acquire('MZ2406'),
    (error) => error.code === LOCK_REJECT_CODES.GLOBAL_HELD,
  );
  assert.deepEqual(await lease.release(), { released: true });
  assert.equal(fs.files.size, 0);
  // Release is idempotent.
  assert.deepEqual(await lease.release(), { released: false });
});

test('the same Profile cannot be opened twice and the global lock is not stranded', async () => {
  const fs = memoryFs();
  const first = await lockManager(fs, { pid: 100 }).acquire('DL5477');
  // A live owner never reclaims its own lock; the global one refuses first.
  await assert.rejects(
    () => lockManager(fs, { pid: 100 }).acquire('DL5477'),
    (error) => error.code === LOCK_REJECT_CODES.GLOBAL_HELD,
  );
  // The failed attempt did not leave the global lock behind.
  assert.ok([...fs.files.keys()].some((path) => path.endsWith(GLOBAL_LOCK_NAME)));
  await first.release();
  assert.equal(fs.files.size, 0);
});

test('a stale lock is reclaimed only when the owner is provably gone', async () => {
  const held = {
    '/srv/shein-fm/runtime/locks/webapi-experiment.global.lock':
      '{"ownerPid":777,"storeCode":"MZ2406","acquiredAt":"2026-07-27T00:00:00.000Z"}',
  };
  // Owner still alive: refuse.
  await assert.rejects(
    () => lockManager(memoryFs(held), { pid: 1, alive: () => true }).acquire('DL5477'),
    (error) => error.code === LOCK_REJECT_CODES.GLOBAL_HELD,
  );
  // Unparsable record: refuse rather than guess.
  await assert.rejects(
    () => lockManager(
      memoryFs({ '/srv/shein-fm/runtime/locks/webapi-experiment.global.lock': 'not json' }),
      { pid: 1, alive: () => false },
    ).acquire('DL5477'),
    (error) => error.code === LOCK_REJECT_CODES.GLOBAL_HELD,
  );
  // A throwing probe is treated as "still alive": fail closed.
  await assert.rejects(
    () => lockManager(memoryFs(held), {
      pid: 1,
      alive: () => { throw new Error('EPERM'); },
    }).acquire('DL5477'),
    (error) => error.code === LOCK_REJECT_CODES.GLOBAL_HELD,
  );
  // Provably gone: reclaim.
  const reclaimed = await lockManager(memoryFs(held), { pid: 1, alive: () => false })
    .acquire('DL5477');
  assert.equal(reclaimed.storeCode, 'DL5477');
});

test('a lock release never deletes a lock this process does not own', async () => {
  const fs = memoryFs();
  const lease = await lockManager(fs, { pid: 100 }).acquire('MZ2406');
  // Another owner took over both records.
  for (const path of [...fs.files.keys()]) {
    fs.files.set(path, '{"ownerPid":999,"storeCode":"MZ2406","acquiredAt":"x"}');
  }
  assert.deepEqual(await lease.release(), { released: false });
  assert.equal(fs.files.size, 2, 'another owner\'s locks must survive');
});

test('lock errors never expose a path or a Profile key', async () => {
  const errors = [];
  const fs = memoryFs();
  await lockManager(fs, { pid: 100 }).acquire('DL5477');
  errors.push(await lockManager(fs, { pid: 200 }).acquire('MZ2406').catch((error) => error));
  errors.push(new WebApiLockError(LOCK_REJECT_CODES.STORE_NOT_ALLOWED));
  errors.push(await lockManager(fs, { pid: 200 }).acquire('DL').catch((error) => error));
  for (const error of errors) {
    assert.ok(error instanceof WebApiLockError);
    assert.doesNotMatch(error.message, /\/srv|persistent-|profile/i, error.message);
    assert.match(error.code, /^WEBAPI_LOCK_[A-Z_]+$/);
  }
});
