import assert from 'node:assert/strict';
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  AuthConfigurationError,
  createAuthService,
  isSameOriginPost,
} from '../../src/server/auth.mjs';
import { createDashboardServer } from '../../src/server/app.mjs';

const fixture = new URL('../fixtures/dashboard.json', import.meta.url);
const sessionSecret = 'test-only-session-secret-that-is-longer-than-32-bytes';

let temporaryDirectory;
let usersFile;
let server;
let baseUrl;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cookiePair(setCookie) {
  return String(setCookie).split(';', 1)[0];
}

async function listen(testServer) {
  await new Promise((resolve, reject) => {
    testServer.once('error', reject);
    testServer.listen(0, '127.0.0.1', resolve);
  });
  const { port } = testServer.address();
  return `http://127.0.0.1:${port}`;
}

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'full-bi-auth-'));
  usersFile = join(temporaryDirectory, 'users.json');
  const salt = randomBytes(16);
  const pbkdf2Hash = pbkdf2Sync('pbkdf2-test-password', salt, 100_000, 32, 'sha256');
  await writeFile(
    usersFile,
    `${JSON.stringify({
      users: [
        {
          username: 'operator',
          displayName: 'Test Operator',
          role: 'admin',
          passwordSha256: sha256('correct-test-password'),
        },
        {
          username: 'store-viewer',
          displayName: 'Store Viewer',
          role: 'viewer',
          employeeCode: 'EMP-001',
          storeCodes: ['DL4412', 'CX1234', 'dl4412'],
          passwordSha256: sha256('viewer-test-password'),
        },
        {
          username: 'pbkdf2-user',
          passwordHash: `pbkdf2:sha256:100000:${salt.toString('hex')}:${pbkdf2Hash.toString('hex')}`,
        },
        {
          username: 'apr1-user',
          htpasswdHash: '$apr1$fmTest01$TI6iLkqTkwAJQQ/USv/Bb1',
        },
      ],
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  server = createDashboardServer({
    dataFile: fixture,
    host: '127.0.0.1',
    runtimeEnvironment: 'production',
    auth: {
      usersFile,
      sessionSecret,
      secureCookie: true,
    },
  });
  baseUrl = await listen(server);
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test('fails closed without authentication in production or on a non-loopback listener', () => {
  assert.throws(
    () => createDashboardServer({ runtimeEnvironment: 'production', host: '127.0.0.1' }),
    AuthConfigurationError,
  );
  assert.throws(
    () => createDashboardServer({ runtimeEnvironment: 'development', host: '0.0.0.0' }),
    AuthConfigurationError,
  );
  assert.throws(
    () => createDashboardServer({ runtimeEnvironment: 'development', host: '127.999.0.1' }),
    AuthConfigurationError,
  );
  assert.throws(
    () => createDashboardServer({
      runtimeEnvironment: 'production',
      host: '127.0.0.1',
      auth: { usersFile, sessionSecret, secureCookie: true },
    }),
    /FULL_BI_DATA_FILE is required in production/,
  );
  assert.doesNotThrow(() => {
    const localServer = createDashboardServer({
      runtimeEnvironment: 'development',
      host: '127.0.0.1',
    });
    localServer.close();
  });
});

test('rejects incomplete authentication settings and weak session secrets', () => {
  assert.throws(
    () => createAuthService({ usersFile, host: '127.0.0.1' }),
    /Both an authentication users file and a session secret/,
  );
  assert.throws(
    () => createAuthService({ usersFile, sessionSecret: 'too-short', host: '127.0.0.1' }),
    /at least 32 bytes/,
  );
  assert.throws(
    () => createAuthService({
      usersFile,
      sessionSecret,
      runtimeEnvironment: 'production',
      secureCookie: false,
    }),
    /cannot be disabled in production/,
  );
  assert.throws(
    () => createAuthService({
      usersFile,
      sessionSecret,
      host: '0.0.0.0',
      trustProxy: true,
    }),
    /only be trusted on a loopback listener/,
  );
});

test('rejects ambiguous or incomplete password hash records during startup', async () => {
  const invalidUsersFile = join(temporaryDirectory, 'invalid-users.json');
  const cases = [
    {
      username: 'missing-iterations',
      passwordHash: {
        algorithm: 'pbkdf2-sha256',
        salt: `hex:${'ab'.repeat(16)}`,
        hash: `hex:${'cd'.repeat(32)}`,
      },
    },
    {
      username: 'ambiguous',
      passwordSha256: sha256('test-password'),
      passwordHash: `sha256:${sha256('test-password')}`,
    },
    {
      username: 'invalid-apr1',
      htpasswdHash: '$apr1$salt$too-short',
    },
    {
      username: 'ambiguous-apr1',
      passwordSha256: sha256('test-password'),
      htpasswdHash: '$apr1$fmTest01$TI6iLkqTkwAJQQ/USv/Bb1',
    },
  ];

  for (const record of cases) {
    await writeFile(invalidUsersFile, JSON.stringify({ users: [record] }), 'utf8');
    if (process.platform !== 'win32') await chmod(invalidUsersFile, 0o600);
    assert.throws(
      () => createAuthService({ usersFile: invalidUsersFile, sessionSecret }),
      AuthConfigurationError,
    );
  }
});

test('loads the session HMAC secret from a private file', async () => {
  const secretFile = join(temporaryDirectory, 'session-secret');
  await writeFile(secretFile, `${sessionSecret}\n`, { encoding: 'utf8', mode: 0o600 });
  const auth = createAuthService({ usersFile, sessionSecretFile: secretFile });
  assert.equal(auth.enabled, true);
  assert.throws(
    () => createAuthService({ usersFile, sessionSecret, sessionSecretFile: secretFile }),
    /value or file, not both/,
  );
});

test('rejects group-writable or world-readable credential files on POSIX', async (context) => {
  if (process.platform === 'win32') {
    context.skip('POSIX permission bits are not available on Windows');
    return;
  }
  const exposedUsersFile = join(temporaryDirectory, 'exposed-users.json');
  await writeFile(
    exposedUsersFile,
    JSON.stringify({ users: [{ username: 'operator', passwordSha256: sha256('password') }] }),
    'utf8',
  );
  await chmod(exposedUsersFile, 0o644);
  assert.throws(
    () => createAuthService({ usersFile: exposedUsersFile, sessionSecret }),
    /could not be read/,
  );
});

test('rejects tampered and expired HMAC session tokens', async () => {
  const auth = createAuthService({
    usersFile,
    sessionSecret,
    sessionTtlSeconds: 1,
    secureCookie: false,
  });
  const now = Date.now();
  const login = await auth.authenticate(
    { socket: { remoteAddress: '127.0.0.1' } },
    'operator',
    'correct-test-password',
    now,
  );
  assert.equal(login.ok, true);
  const token = cookiePair(login.cookie).split('=', 2)[1];
  const tamperedToken = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.deepEqual(auth.verifyToken(token, now), {
    username: 'operator',
    displayName: 'Test Operator',
    employeeCode: 'operator',
    role: 'admin',
    allStores: true,
    storeCodes: [],
  });
  assert.equal(auth.verifyToken(tamperedToken, now), null);
  assert.equal(auth.verifyToken(token, now + 2_000), null);
});

test('keeps health public while redirecting pages and rejecting unauthenticated APIs', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);

  const page = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/login');
  assert.equal(page.headers.get('cache-control'), 'no-store');

  const api = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(api.status, 401);
  assert.equal(api.headers.get('www-authenticate'), 'Session');
  assert.match(await api.text(), /AUTH_REQUIRED/);

  const events = await fetch(`${baseUrl}/api/events`);
  assert.equal(events.status, 401);
  assert.equal(events.headers.get('www-authenticate'), 'Session');
  assert.match(await events.text(), /AUTH_REQUIRED/);

  const sales = await fetch(`${baseUrl}/api/sales`);
  assert.equal(sales.status, 401);
  assert.equal(sales.headers.get('www-authenticate'), 'Session');
  assert.match(await sales.text(), /AUTH_REQUIRED/);

  const login = await fetch(`${baseUrl}/login`);
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  assert.equal(login.headers.get('referrer-policy'), 'same-origin');
  assert.match(login.headers.get('content-security-policy'), /style-src 'nonce-/);
  const html = await login.text();
  assert.match(html, /全托运营驾驶舱/);
  assert.match(html, /action="\/api\/login"/);
  assert.doesNotMatch(html, /correct-test-password/);
});

test('requires a same-origin POST and enforces the login request body limit', async () => {
  const missingOrigin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'correct-test-password' }),
  });
  assert.equal(missingOrigin.status, 403);
  assert.match(await missingOrigin.text(), /CROSS_ORIGIN_REJECTED/);

  const nullOrigin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'null',
    },
    body: new URLSearchParams({
      username: 'operator',
      password: 'correct-test-password',
    }),
  });
  assert.equal(nullOrigin.status, 403);
  assert.match(await nullOrigin.text(), /CROSS_ORIGIN_REJECTED/);

  const wrongOrigin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' },
    body: JSON.stringify({ username: 'operator', password: 'correct-test-password' }),
  });
  assert.equal(wrongOrigin.status, 403);

  const oversized = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'operator', password: 'x'.repeat(17_000) }),
  });
  assert.equal(oversized.status, 413);
  assert.match(await oversized.text(), /BODY_TOO_LARGE/);
});

test('logs in with a legacy SHA-256 hash, authorizes APIs, and logs out safely', async () => {
  const invalid = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'operator', password: 'wrong-test-password' }),
  });
  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), {
    error: { code: 'INVALID_CREDENTIALS', message: '账号或密码错误' },
  });

  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'operator', password: 'correct-test-password' }),
  });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), {
    ok: true,
    user: {
      username: 'operator',
      displayName: 'Test Operator',
      employeeCode: 'operator',
      role: 'admin',
      allStores: true,
      storeCodes: [],
    },
  });
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /^fm_bi_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);
  assert.doesNotMatch(setCookie, /correct-test-password/);
  const cookie = cookiePair(setCookie);

  const dashboard = await fetch(`${baseUrl}/api/dashboard`, { headers: { Cookie: cookie } });
  assert.equal(dashboard.status, 200);
  assert.equal((await dashboard.json()).schemaVersion, 4);

  const crossOriginLogout = await fetch(`${baseUrl}/api/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://attacker.invalid' },
  });
  assert.equal(crossOriginLogout.status, 403);

  const crossOriginMutation = await fetch(`${baseUrl}/api/dashboard`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://attacker.invalid' },
  });
  assert.equal(crossOriginMutation.status, 403);

  const logout = await fetch(`${baseUrl}/api/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl },
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);

  const afterLogout = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Cookie: cookiePair(logout.headers.get('set-cookie')) },
  });
  assert.equal(afterLogout.status, 401);
});

test('normalizes employee write assignments while allowing unassigned read-only users', async () => {
  const auth = createAuthService({
    usersFile,
    sessionSecret,
    secureCookie: false,
  });
  const login = await auth.authenticate(
    { socket: { remoteAddress: '127.0.0.1' } },
    'store-viewer',
    'viewer-test-password',
  );
  assert.equal(login.ok, true);
  assert.deepEqual(login.user, {
    username: 'store-viewer',
    displayName: 'Store Viewer',
    employeeCode: 'EMP-001',
    role: 'viewer',
    allStores: false,
    storeCodes: ['CX1234', 'DL4412'],
  });

  const invalidUsersFile = join(temporaryDirectory, 'unscoped-viewer.json');
  await writeFile(
    invalidUsersFile,
    JSON.stringify({
      users: [{
        username: 'unscoped',
        role: 'viewer',
        passwordSha256: sha256('password'),
      }],
    }),
    'utf8',
  );
  if (process.platform !== 'win32') await chmod(invalidUsersFile, 0o600);
  const unscopedAuth = createAuthService({
    usersFile: invalidUsersFile,
    sessionSecret,
    secureCookie: false,
  });
  const unscopedLogin = await unscopedAuth.authenticate(
    { socket: { remoteAddress: '127.0.0.1' } },
    'unscoped',
    'password',
  );
  assert.equal(unscopedLogin.ok, true);
  assert.deepEqual(unscopedLogin.user.storeCodes, []);
});

test('accepts PBKDF2-SHA256 passwordHash credentials', async () => {
  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'pbkdf2-user', password: 'pbkdf2-test-password' }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /^fm_bi_session=/);
  const payload = await login.json();
  assert.equal(payload.user.role, 'viewer');
  assert.equal(payload.user.allStores, false);
});

test('verifies a strict Apache APR1 htpasswd vector without shell commands', async () => {
  const rejected = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'apr1-user', password: 'wrong-synthetic-password' }),
  });
  assert.equal(rejected.status, 401);

  const accepted = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'apr1-user', password: 'synthetic-test-password' }),
  });
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get('set-cookie'), /^fm_bi_session=/);
});

test('rate-limits repeated failed login attempts per client', async () => {
  const limitedServer = createDashboardServer({
    dataFile: fixture,
    host: '127.0.0.1',
    runtimeEnvironment: 'production',
    auth: {
      usersFile,
      sessionSecret,
      rateLimitMaxAttempts: 2,
      rateLimitWindowMs: 60_000,
      secureCookie: true,
    },
  });
  const limitedBaseUrl = await listen(limitedServer);

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${limitedBaseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: limitedBaseUrl },
        body: JSON.stringify({ username: 'operator', password: `wrong-${attempt}` }),
      });
      assert.equal(response.status, 401);
    }

    const blocked = await fetch(`${limitedBaseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: limitedBaseUrl },
      body: JSON.stringify({ username: 'operator', password: 'correct-test-password' }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '60');
    assert.match(await blocked.text(), /LOGIN_RATE_LIMITED/);
  } finally {
    await new Promise((resolve) => limitedServer.close(resolve));
  }
});

test('reserves rate-limit capacity before concurrent password checks start', async () => {
  const limitedServer = createDashboardServer({
    dataFile: fixture,
    host: '127.0.0.1',
    runtimeEnvironment: 'production',
    auth: {
      usersFile,
      sessionSecret,
      rateLimitMaxAttempts: 2,
      rateLimitWindowMs: 60_000,
      secureCookie: true,
    },
  });
  const limitedBaseUrl = await listen(limitedServer);

  try {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, attempt) => fetch(`${limitedBaseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: limitedBaseUrl },
        body: JSON.stringify({ username: 'pbkdf2-user', password: `wrong-concurrent-${attempt}` }),
      })),
    );
    const statuses = responses.map((response) => response.status).sort();
    assert.deepEqual(statuses, [401, 401, 429, 429, 429, 429, 429, 429]);
  } finally {
    await new Promise((resolve) => limitedServer.close(resolve));
  }
});

test('uses trusted proxy client addresses only on a loopback listener', async () => {
  assert.equal(isSameOriginPost({
    headers: {
      host: 'fm.dushengyi.cc',
      origin: 'https://fm.dushengyi.cc',
      'x-forwarded-proto': 'https',
    },
    socket: { remoteAddress: '127.0.0.1' },
  }, { trustProxy: true }), true);

  const proxyServer = createDashboardServer({
    dataFile: fixture,
    host: '127.0.0.1',
    runtimeEnvironment: 'production',
    auth: {
      usersFile,
      sessionSecret,
      rateLimitMaxAttempts: 1,
      trustProxy: true,
      secureCookie: true,
    },
  });
  const proxyBaseUrl = await listen(proxyServer);

  try {
    const failed = await fetch(`${proxyBaseUrl}/api/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: proxyBaseUrl,
        'X-Forwarded-For': '198.51.100.10',
      },
      body: JSON.stringify({ username: 'operator', password: 'wrong' }),
    });
    assert.equal(failed.status, 401);

    const differentClient = await fetch(`${proxyBaseUrl}/api/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: proxyBaseUrl,
        'X-Forwarded-For': '203.0.113.20',
      },
      body: JSON.stringify({ username: 'operator', password: 'correct-test-password' }),
    });
    assert.equal(differentClient.status, 200);
  } finally {
    await new Promise((resolve) => proxyServer.close(resolve));
  }
});

test('bounds rate-limit clients and concurrent password KDF work', async () => {
  const boundedServer = createDashboardServer({
    dataFile: fixture,
    host: '127.0.0.1',
    runtimeEnvironment: 'production',
    auth: {
      usersFile,
      sessionSecret,
      trustProxy: true,
      secureCookie: true,
      maxRateLimitClients: 8,
      maxConcurrentKdfs: 2,
      rateLimitMaxAttempts: 5,
      rateLimitWindowMs: 60_000,
    },
  });
  const boundedBaseUrl = await listen(boundedServer);

  try {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) => fetch(`${boundedBaseUrl}/api/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: boundedBaseUrl,
          'X-Forwarded-For': `198.51.100.${index + 1}`,
        },
        body: JSON.stringify({ username: 'pbkdf2-user', password: `wrong-bounded-${index}` }),
      })),
    );
    const statuses = responses.map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 401).length, 2);
    assert.equal(statuses.filter((status) => status === 503).length, 6);
  } finally {
    await new Promise((resolve) => boundedServer.close(resolve));
  }
});

test('fails closed when the rate-limit client map reaches its hard capacity', async () => {
  const capacityServer = createDashboardServer({
    dataFile: fixture,
    host: '127.0.0.1',
    runtimeEnvironment: 'production',
    auth: {
      usersFile,
      sessionSecret,
      trustProxy: true,
      secureCookie: true,
      maxRateLimitClients: 2,
      rateLimitMaxAttempts: 5,
      rateLimitWindowMs: 60_000,
    },
  });
  const capacityBaseUrl = await listen(capacityServer);

  async function failedLogin(clientAddress) {
    return fetch(`${capacityBaseUrl}/api/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: capacityBaseUrl,
        'X-Forwarded-For': clientAddress,
      },
      body: JSON.stringify({ username: 'operator', password: 'wrong-capacity' }),
    });
  }

  try {
    assert.equal((await failedLogin('198.51.100.1')).status, 401);
    assert.equal((await failedLogin('198.51.100.2')).status, 401);
    const blocked = await failedLogin('198.51.100.3');
    assert.equal(blocked.status, 429);
    assert.match(await blocked.text(), /LOGIN_RATE_LIMITED/);
  } finally {
    await new Promise((resolve) => capacityServer.close(resolve));
  }
});
