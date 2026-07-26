import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileAuthorizationStore, sha256 } from '../../src/authorization/file-store.mjs';
import { createAuthorizationServer } from '../../src/authorization/server.mjs';
import { createFullManagedAuthorizationService } from '../../src/authorization/service.mjs';

const TOKEN = Buffer.alloc(32, 21).toString('base64url');
const PUBLIC_ORIGIN = 'http://127.0.0.1';

async function listen(context, authorizationService, options = {}) {
  const server = createAuthorizationServer({ authorizationService, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('moves a fragment token into an HttpOnly session cookie without returning it in content', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'fm-authorization-http-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileAuthorizationStore({ file: join(directory, 'state.secret.json') });
  await store.createBatch({
    batchId: 'batch-http-test',
    label: 'HTTP test batch',
    tokenHash: sha256(TOKEN),
    storeCodes: ['DL'],
    createdAt: new Date('2026-07-26T00:00:00.000Z'),
    expiresAt: new Date('2026-07-27T00:00:00.000Z'),
  });
  const service = createFullManagedAuthorizationService({
    store,
    applicationFile: join(directory, 'unused-application.secret.json'),
    receiptDirectory: join(directory, 'receipts'),
    publicOrigin: PUBLIC_ORIGIN,
    secureCookie: false,
    now: () => new Date('2026-07-26T01:00:00.000Z'),
  });
  const baseUrl = await listen(context, service);

  const page = await fetch(`${baseUrl}/authorize#${TOKEN}`);
  const pageText = await page.text();
  assert.equal(page.status, 200);
  assert.doesNotMatch(pageText, new RegExp(TOKEN));
  assert.equal(page.headers.get('set-cookie'), null);

  const session = await fetch(`${baseUrl}/authorize/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: PUBLIC_ORIGIN,
    },
    body: JSON.stringify({ token: TOKEN }),
  });
  const sessionText = await session.text();
  const setCookie = session.headers.get('set-cookie');
  assert.equal(session.status, 200);
  assert.match(setCookie, /^fm_full_authz=/);
  assert.match(setCookie, /Path=\/authorize/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.doesNotMatch(sessionText, new RegExp(TOKEN));

  const stateBefore = JSON.parse(
    await readFile(join(directory, 'state.secret.json'), 'utf8'),
  );
  const crossOrigin = await fetch(`${baseUrl}/authorize/start/DL`, {
    method: 'POST',
    headers: {
      Cookie: setCookie.split(';', 1)[0],
      Origin: 'https://attacker.invalid',
    },
  });
  assert.equal(crossOrigin.status, 403);
  assert.match(await crossOrigin.text(), /CROSS_ORIGIN_REJECTED/);
  const stateAfter = JSON.parse(
    await readFile(join(directory, 'state.secret.json'), 'utf8'),
  );
  assert.deepEqual(stateAfter.states, stateBefore.states);
});

test('rejects duplicate callback parameters before exchange', async (context) => {
  let completeCalls = 0;
  const baseUrl = await listen(context, {
    publicOrigin: 'https://fm.test',
    async complete() {
      completeCalls += 1;
      return { storeCode: 'DL' };
    },
  });
  const state = 's'.repeat(43);
  const response = await fetch(
    `${baseUrl}/openapi/authorize/callback?state=${state}&state=${state}&tempToken=temporary-token`,
    { redirect: 'manual' },
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/authorize/result?status=invalid');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), '');
  assert.equal(completeCalls, 0);
  assert.doesNotMatch(response.headers.get('location'), /temporary-token|state=/);
});

test('successful callback redirects to a scrubbed result URL without leaking callback secrets', async (context) => {
  const received = [];
  const baseUrl = await listen(context, {
    publicOrigin: 'https://fm.test',
    async complete(parameters) {
      received.push(parameters);
      return { storeCode: 'DL' };
    },
  });
  const state = 's'.repeat(43);
  const tempToken = 'temporary-token-for-http-test';
  const response = await fetch(
    `${baseUrl}/openapi/authorize/callback?state=${state}&tempToken=${tempToken}`,
    { redirect: 'manual' },
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/authorize/result?status=received&store=DL');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await response.text(), '');
  assert.deepEqual(received, [{ state, tempToken }]);
  assert.doesNotMatch(response.headers.get('location'), new RegExp(`${state}|${tempToken}`));
});

test('bounds concurrent callback work and rejects excess requests before exchange', async (context) => {
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let completeCalls = 0;
  const baseUrl = await listen(context, {
    publicOrigin: 'https://fm.test',
    async complete() {
      completeCalls += 1;
      markStarted();
      await blocked;
      return { storeCode: 'DL' };
    },
  }, { maximumConcurrentCallbacks: 1 });
  const state = 's'.repeat(43);
  const first = fetch(
    `${baseUrl}/openapi/authorize/callback?state=${state}&tempToken=temporary-token-one`,
    { redirect: 'manual' },
  );
  await started;

  const excess = await fetch(
    `${baseUrl}/openapi/authorize/callback?state=${state}&tempToken=temporary-token-two`,
    { redirect: 'manual' },
  );
  assert.equal(excess.status, 303);
  assert.equal(excess.headers.get('location'), '/authorize/result?status=busy');
  assert.equal(completeCalls, 1);

  releaseFirst();
  assert.equal((await first).status, 303);
});
