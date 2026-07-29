import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createDashboardServer } from '../../src/server/app.mjs';

const fixture = new URL('../fixtures/dashboard.json', import.meta.url);
const sessionSecret = 'product-route-session-secret-longer-than-32-bytes';

let temporaryDirectory;
let server;
let baseUrl;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cookiePair(setCookie) {
  return String(setCookie).split(';', 1)[0];
}

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'full-bi-product-route-'));
  const usersFile = join(temporaryDirectory, 'users.json');
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
      ],
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  server = createDashboardServer({
    dataFile: fixture,
    host: '127.0.0.1',
    runtimeEnvironment: 'production',
    // Production refuses insecure session cookies; the cookie is replayed by
    // hand below, so the Secure attribute does not block the loopback test.
    auth: { usersFile, sessionSecret, secureCookie: true },
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

test('unauthenticated GET and HEAD /api/products are rejected in production', async () => {
  const get = await fetch(`${baseUrl}/api/products`);
  assert.equal(get.status, 401);
  assert.equal(get.headers.get('www-authenticate'), 'Session');
  assert.match(await get.text(), /AUTH_REQUIRED/);

  // A HEAD request must not become an authentication bypass.
  const head = await fetch(`${baseUrl}/api/products`, { method: 'HEAD' });
  assert.equal(head.status, 401);
  assert.equal(head.headers.get('www-authenticate'), 'Session');

  // Validation must never run before authentication: a malformed query on an
  // unauthenticated request still answers 401, not 400.
  const malformed = await fetch(`${baseUrl}/api/products?q=a&q=b&pageSize=101`);
  assert.equal(malformed.status, 401);
  assert.match(await malformed.text(), /AUTH_REQUIRED/);
});

test('an authenticated session reads the product identity query surface read-only', async () => {
  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'operator', password: 'correct-test-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = cookiePair(login.headers.get('set-cookie'));

  const authorized = await fetch(
    `${baseUrl}/api/products?pageSize=25&pendingPage=1&canonicalPage=1`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(authorized.status, 200);
  const payload = await authorized.json();
  assert.equal(payload.readOnly, true);
  assert.equal(payload.query.pageSize, 25);
  assert.ok(Array.isArray(payload.pending.rows));
  assert.ok(Array.isArray(payload.canonical.rows));
  assert.equal(authorized.headers.get('cache-control'), 'no-store');

  const head = await fetch(`${baseUrl}/api/products`, {
    method: 'HEAD',
    headers: { Cookie: cookie },
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  // Validation still applies after authentication.
  const invalid = await fetch(`${baseUrl}/api/products?quick=DROP`, {
    headers: { Cookie: cookie },
  });
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /QUERY_PARAMETER_INVALID/);

  // Authentication does not unlock a write path on this surface.
  const mutation = await fetch(`${baseUrl}/api/products`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl },
  });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get('allow'), 'GET, HEAD');

  const crossOrigin = await fetch(`${baseUrl}/api/products`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://attacker.invalid' },
  });
  assert.equal(crossOrigin.status, 403);
  assert.match(await crossOrigin.text(), /CROSS_ORIGIN_REJECTED/);
});
