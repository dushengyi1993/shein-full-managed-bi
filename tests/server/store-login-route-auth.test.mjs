import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createDashboardServer } from '../../src/server/app.mjs';

const fixture = new URL('../fixtures/dashboard.json', import.meta.url);
const sessionSecret = 'store-login-route-session-secret-longer-than-32-bytes';

let temporaryDirectory;
let server;
let baseUrl;
let calls;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cookiePair(setCookie) {
  return String(setCookie).split(';', 1)[0];
}

async function login(username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return cookiePair(response.headers.get('set-cookie'));
}

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'full-bi-store-login-route-'));
  const usersFile = join(temporaryDirectory, 'users.json');
  await writeFile(usersFile, `${JSON.stringify({
    users: [
      {
        username: 'admin',
        role: 'admin',
        passwordSha256: sha256('admin-password'),
      },
      {
        username: 'viewer',
        role: 'viewer',
        passwordSha256: sha256('viewer-password'),
      },
    ],
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  calls = [];
  const storeLoginProxy = {
    status: async () => ({
      ok: true,
      total: 25,
      completed: 24,
      allCompleted: false,
      active: null,
      stores: [{ storeCode: 'NM7418', status: 'pending' }],
    }),
    start: async (storeCode) => {
      calls.push(['start', storeCode]);
      return {
        ok: true,
        storeCode,
        openUrl: '/store-login/session/fm-login-test#token=session_token',
      };
    },
    finish: async (storeCode) => {
      calls.push(['finish', storeCode]);
      return { ok: true, storeCode, verified: true };
    },
    close: async () => {
      calls.push(['close']);
      return { ok: true };
    },
  };
  server = createDashboardServer({
    dataFile: fixture,
    host: '127.0.0.1',
    runtimeEnvironment: 'production',
    auth: { usersFile, sessionSecret, secureCookie: true },
    storeLoginProxy,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test('login maintenance requires an authenticated administrator', async () => {
  assert.equal((await fetch(`${baseUrl}/api/system/store-login/status`)).status, 401);
  const viewerCookie = await login('viewer', 'viewer-password');
  const viewer = await fetch(`${baseUrl}/api/system/store-login/status`, {
    headers: { Cookie: viewerCookie },
  });
  assert.equal(viewer.status, 403);
  assert.match(await viewer.text(), /ADMIN_REQUIRED/);
});

test('administrator can read status and open one canonical store with CSRF protection', async () => {
  const adminCookie = await login('admin', 'admin-password');
  const status = await fetch(`${baseUrl}/api/system/store-login/status`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).total, 25);

  const crossOrigin = await fetch(`${baseUrl}/api/system/store-login/start`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      Origin: 'https://attacker.invalid',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ storeCode: 'NM7418' }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.match(await crossOrigin.text(), /CROSS_ORIGIN_REJECTED/);

  const start = await fetch(`${baseUrl}/api/system/store-login/start`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      Origin: baseUrl,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ storeCode: 'nm7418' }),
  });
  assert.equal(start.status, 200);
  assert.equal((await start.json()).storeCode, 'nm7418');
  assert.deepEqual(calls, [['start', 'nm7418']]);
});
