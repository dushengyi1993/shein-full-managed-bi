import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createDashboardServer } from '../../src/server/app.mjs';

const fixture = new URL('../fixtures/dashboard.json', import.meta.url);
const sessionSecret = 'fulfilment-route-session-secret-longer-than-32-bytes';

let temporaryDirectory;
let server;
let baseUrl;
let shippingOrdersFile;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cookiePair(setCookie) {
  return String(setCookie).split(';', 1)[0];
}

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'full-bi-fulfilment-route-'));
  const usersFile = join(temporaryDirectory, 'users.json');
  shippingOrdersFile = join(temporaryDirectory, 'shipping-orders.json');
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
  await writeFile(shippingOrdersFile, `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-08-08T02:00:00.000Z',
    source: {
      basis: 'OPENAPI_PURCHASE_ORDER_AND_DELIVERY',
      storeCount: 1,
      orderCount: 1,
      lineCount: 1,
    },
    capabilities: { coreOrderFacts: true, deliveryFacts: true },
    orders: [{
      storeCode: 'DL5477',
      storeName: 'DL5477',
      orderNo: 'PO-1',
      orderTypeName: '备货',
      statusName: '已下单',
      createdAt: '2026-08-08T01:00:00.000Z',
      latestSourceFetchedAt: '2026-08-08T02:00:00.000Z',
      totals: { orderQuantity: 3, deliveryQuantity: 0, defectiveQuantity: 0 },
      lines: [{ lineKey: '1', skc: 'SKC-1', orderQuantity: 3, deliveryQuantity: 0 }],
      deliveries: [],
    }],
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  server = createDashboardServer({
    dataFile: fixture,
    shippingOrdersFile,
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

test('unauthenticated GET and HEAD /api/fulfilment are rejected in production', async () => {
  const get = await fetch(`${baseUrl}/api/fulfilment`);
  assert.equal(get.status, 401);
  assert.equal(get.headers.get('www-authenticate'), 'Session');
  assert.match(await get.text(), /AUTH_REQUIRED/);

  // A HEAD request must not become an authentication bypass.
  const head = await fetch(`${baseUrl}/api/fulfilment`, { method: 'HEAD' });
  assert.equal(head.status, 401);
  assert.equal(head.headers.get('www-authenticate'), 'Session');

  // Validation must never run before authentication: a malformed query on an
  // unauthenticated request still answers 401, not 400.
  const malformed = await fetch(`${baseUrl}/api/fulfilment?q=a&q=b&pageSize=101`);
  assert.equal(malformed.status, 401);
  assert.match(await malformed.text(), /AUTH_REQUIRED/);
});

test('an authenticated session reads the fulfilment query surface read-only', async () => {
  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username: 'operator', password: 'correct-test-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = cookiePair(login.headers.get('set-cookie'));

  const authorized = await fetch(
    `${baseUrl}/api/fulfilment?pageSize=25&page=1&status=ALL&quick=ALL&orderType=STOCK_UP`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(authorized.status, 200);
  const payload = await authorized.json();
  assert.equal(payload.readOnly, true);
  assert.equal(payload.query.pageSize, 25);
  assert.ok(Array.isArray(payload.orders.rows));
  assert.equal(payload.orders.rows[0].orderNo, 'PO-1');
  assert.ok(Array.isArray(payload.filters.statuses));
  assert.equal(authorized.headers.get('cache-control'), 'no-store');

  const head = await fetch(`${baseUrl}/api/fulfilment`, {
    method: 'HEAD',
    headers: { Cookie: cookie },
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  // Validation still applies after authentication.
  const invalid = await fetch(`${baseUrl}/api/fulfilment?quick=RECEIVED`, {
    headers: { Cookie: cookie },
  });
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /QUERY_PARAMETER_INVALID/);

  const duplicate = await fetch(`${baseUrl}/api/fulfilment?status=A&status=B`, {
    headers: { Cookie: cookie },
  });
  assert.equal(duplicate.status, 400);
  assert.match(await duplicate.text(), /QUERY_PARAMETER_DUPLICATED/);

  // Authentication does not unlock a write path on this surface.
  const mutation = await fetch(`${baseUrl}/api/fulfilment`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl },
  });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get('allow'), 'GET, HEAD');

  const crossOrigin = await fetch(`${baseUrl}/api/fulfilment`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://attacker.invalid' },
  });
  assert.equal(crossOrigin.status, 403);
  assert.match(await crossOrigin.text(), /CROSS_ORIGIN_REJECTED/);
});
