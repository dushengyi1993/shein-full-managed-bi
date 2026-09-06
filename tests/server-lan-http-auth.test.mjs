import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { before, after, test } from 'node:test';
import { AuthConfigurationError, createAuthService } from '../src/server/auth.mjs';
import { createDashboardServer } from '../src/server/app.mjs';

const origin = 'http://192.168.1.79';
const password = randomBytes(24).toString('hex');
let directory;
let options;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fm-lan-auth-'));
  const usersFile = join(directory, 'users.json');
  await writeFile(usersFile, JSON.stringify({ users: [{
    username: 'lan-test', role: 'admin',
    passwordSha256: createHash('sha256').update(password).digest('hex'),
  }] }), { mode: 0o600 });
  options = {
    usersFile, sessionSecret: randomBytes(32).toString('hex'),
    runtimeEnvironment: 'production', host: '127.0.0.1',
    allowLanHttp: true, trustProxy: true, secureCookie: false, publicOrigin: origin,
  };
});

after(async () => {
  if (directory) {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});

test('production remains fail closed unless explicitly opted in', () => {
  for (const allowLanHttp of [undefined, false, 'true', 1]) {
    assert.throws(() => createAuthService({ ...options, allowLanHttp }), /cannot be disabled in production/);
  }
  assert.throws(() => createAuthService({ ...options, allowLanHttp: false, secureCookie: true }), /exact HTTP\(S\) origin/);
  const publicAuth = createAuthService({ ...options, allowLanHttp: false, secureCookie: true, publicOrigin: 'https://fm.dushengyi.cc' });
  assert.equal(publicAuth.cookieName, 'fm_bi_session');
  assert.ok(publicAuth.clearCookie().includes('; Secure'));
  assert.throws(() => createAuthService({ ...options, usersFile: undefined, sessionSecret: undefined }), /Authentication is required/);
  assert.throws(() => createAuthService({ ...options, sessionSecret: 'short' }), /at least 32 bytes/);
});

test('LAN exception requires every guard and a dedicated cookie', () => {
  const invalid = [
    { host: '0.0.0.0' }, { host: '192.168.1.79' }, { host: '127.999.0.1' },
    { trustProxy: false }, { trustProxy: 'true' }, { secureCookie: true },
    { secureCookie: undefined }, { runtimeEnvironment: 'development' },
    { cookieName: 'fm_bi_session' },
  ];
  for (const change of invalid) {
    assert.throws(() => createAuthService({ ...options, ...change }), AuthConfigurationError);
  }
  for (const publicOrigin of [
    '', 'http://example.com', 'http://8.8.8.8', 'http://127.0.0.1',
    'http://169.254.1.1', 'http://100.64.0.1', 'http://172.15.1.1', 'http://172.32.1.1',
    'http://192.169.1.1', 'https://192.168.1.79', 'http://192.168.1.79/',
    'http://user@192.168.1.79', 'http://192.168.1.79/path', 'http://192.168.1.79?x=1',
    'http://192.168.1.79#x', 'http://192.168.001.79', 'http://3232235855',
    'http://0xc0a8014f', 'http://[::1]', ' http://192.168.1.79', 'http://192.168.1.79:80',
  ]) {
    assert.throws(() => createAuthService({ ...options, publicOrigin }), AuthConfigurationError, publicOrigin);
  }
  for (const publicOrigin of [origin, 'http://10.0.0.1', 'http://172.16.0.1', 'http://172.31.255.255', 'http://192.168.1.79:8080']) {
    const auth = createAuthService({ ...options, publicOrigin });
    assert.equal(auth.cookieName, 'fm_bi_lan_session');
    assert.equal(auth.publicOrigin, publicOrigin);
  }
});

test('HTTP login, isolated cookie, authenticated data and logout lifecycle', async () => {
  const server = createDashboardServer({
    host: options.host, runtimeEnvironment: 'production', auth: options,
    dataFile: new URL('./fixtures/dashboard.json', import.meta.url),
  });
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, requestOrigin, cookie, suppliedPassword = password) => fetch(base + route, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', Host: '192.168.1.79',
        'X-Forwarded-Proto': 'http', 'X-Forwarded-For': '192.168.1.10',
        ...(requestOrigin === undefined ? {} : { Origin: requestOrigin }),
        ...(cookie ? { Cookie: cookie } : {}),
      }, body: JSON.stringify({ username: 'lan-test', password: suppliedPassword }),
    });
    assert.equal((await fetch(base + '/api/dashboard')).status, 401);
    for (const badOrigin of [undefined, 'null', 'http://192.168.1.80', 'https://192.168.1.79', 'http://evil.example']) {
      assert.equal((await post('/api/login', badOrigin)).status, 403);
    }
    assert.equal((await post('/api/login', origin, undefined, 'wrong-test-password')).status, 401);
    const login = await post('/api/login', origin);
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    // Boolean assertions avoid printing session values on failures.
    assert.ok(setCookie?.startsWith('fm_bi_lan_session='));
    for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) assert.ok(setCookie.includes(attribute));
    assert.ok(!setCookie.includes('Secure') && !setCookie.includes('Domain='));
    const cookie = setCookie.split(';', 1)[0];
    const dashboard = await fetch(base + '/api/dashboard', { headers: { Cookie: cookie } });
    assert.equal(dashboard.status, 200);
    assert.ok(await dashboard.json());
    const me = await fetch(base + '/api/me', { headers: { Cookie: cookie } });
    assert.equal((await me.json()).user.role, 'admin');
    assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookie.replace('fm_bi_lan_session=', 'fm_bi_session=') } })).status, 401);
    assert.equal((await post('/api/logout', 'http://evil.example', cookie)).status, 403);
    assert.equal((await post('/api/dashboard', 'http://evil.example', cookie)).status, 403);
    const logout = await post('/api/logout', origin, cookie);
    assert.equal(logout.status, 200);
    assert.equal(logout.headers.get('set-cookie'), 'fm_bi_lan_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    // Simulate browser applying the expiry; existing stateless logout semantics stay unchanged.
    assert.equal((await fetch(base + '/api/dashboard')).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test('LAN unit explicitly opts in without changing production or sandbox boundaries', async () => {
  const unit = await readFile(new URL('../infra/systemd/shein-fm-lan-portal.service', import.meta.url), 'utf8');
  for (const line of [
    'Environment=NODE_ENV=production', 'Environment=FULL_BI_ALLOW_LAN_HTTP=true',
    'Environment=FULL_BI_COOKIE_SECURE=false', `Environment=FULL_BI_PUBLIC_ORIGIN=${origin}`,
    'Environment=FULL_BI_HOST=127.0.0.1', 'Environment=FULL_BI_PORT=8787',
    'Environment=FULL_BI_TRUST_PROXY=true', 'ProtectSystem=strict',
    'LoadCredential=store_login_internal_token:/srv/shein-fm/secrets/store-login/internal.token',
    'ReadOnlyPaths=/srv/shein-fm/runtime/dashboard/dashboard.json',
  ]) assert.ok(unit.split(/\r?\n/).includes(line), line);
  const entry = await readFile(new URL('../src/server/index.mjs', import.meta.url), 'utf8');
  assert.ok(entry.includes("allowLanHttp: process.env.FULL_BI_ALLOW_LAN_HTTP === 'true'"));
});
