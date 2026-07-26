import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SheinOpenApiClient,
  SheinOpenApiError,
  assertOpenApiRuntimeAllowed,
  buildAuthorizationUrl,
  decryptSheinSecretKey,
  encryptSheinSecretKeyForTest,
  generateSheinSignature,
} from '../../src/openapi/shein-client.mjs';

test('matches the fixed official-rule signature vector used by the production client', () => {
  const signed = generateSheinSignature({
    openKeyId: 'OPENKEY',
    secretKey: 'SECRET',
    path: '/open-api/order/purchase-order-info',
    timestamp: '1740709414000',
    randomKey: 'test1',
  });
  assert.equal(
    signed.signature,
    'test1M2QxNDU4ZDcyMjcxOGFiMWU4Y2ExMDlmZGY5MDBmMTM3ZGE2Y2Y4YmU3OTA1YTZmYmE2NjM2MzRjNjQ5ZDAwZQ==',
  );
});

test('blocks real SHEIN calls unless both non-Windows and explicitly cloud-attested', () => {
  assert.throws(
    () => assertOpenApiRuntimeAllowed('https://openapi.sheincorp.com', {
      platform: 'win32', cloudExecution: '1',
    }),
    (error) => error instanceof SheinOpenApiError && error.code === 'REAL_OPENAPI_BLOCKED_ON_WINDOWS',
  );
  assert.throws(
    () => assertOpenApiRuntimeAllowed('https://openapi.sheincorp.com', { platform: 'linux' }),
    (error) => error instanceof SheinOpenApiError
      && error.code === 'REAL_OPENAPI_CLOUD_ATTESTATION_REQUIRED',
  );
  assert.doesNotThrow(
    () => assertOpenApiRuntimeAllowed('https://openapi.sheincorp.com', {
      platform: 'linux', cloudExecution: '1',
    }),
  );
});

test('only permits an explicit local/test fake base URL when opted in', () => {
  assert.throws(
    () => assertOpenApiRuntimeAllowed('http://127.0.0.1:9999', { platform: 'win32' }),
    (error) => error.code === 'UNTRUSTED_BASE_URL',
  );
  assert.doesNotThrow(() => assertOpenApiRuntimeAllowed('http://127.0.0.1:9999', {
    platform: 'win32',
    allowFakeBaseUrl: true,
  }));
  assert.throws(
    () => assertOpenApiRuntimeAllowed('https://attacker.example.net', {
      platform: 'linux',
      allowFakeBaseUrl: true,
    }),
    (error) => error.code === 'UNTRUSTED_BASE_URL',
  );
});

test('signs GET query path, sends no body and requires HTTP plus platform success', async () => {
  let captured;
  const client = new SheinOpenApiClient({
    baseUrl: 'https://fake.test',
    openKeyId: 'open-key',
    secretKey: 'secret-key',
    allowFakeBaseUrl: true,
    platform: 'win32',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ code: 0, msg: 'OK', info: {} }), { status: 200 });
    },
  });
  await client.request('/open-api/goods/number-list', {
    method: 'GET', query: { page: 1, per_page: 100, type: 1 }, timestamp: '1752570849017', randomKey: 'Ab123',
  });
  assert.match(captured.url, /page=1/);
  assert.equal(captured.init.body, undefined);
  assert.equal(captured.init.headers['x-lt-openKeyId'], 'open-key');
  assert.ok(captured.init.headers['x-lt-signature'].startsWith('Ab123'));

  const platformFailure = new SheinOpenApiClient({
    baseUrl: 'https://fake.test', openKeyId: 'x', secretKey: 'y', allowFakeBaseUrl: true,
    fetchImpl: async () => new Response(JSON.stringify({ code: '4001', msg: 'permission pending' }), { status: 200 }),
  });
  await assert.rejects(
    () => platformFailure.request('/open-api/test'),
    (error) => error.code === 'PLATFORM_ERROR' && error.details.platformCode === '4001',
  );
});

test('timeout remains active while response body is consumed', async () => {
  const client = new SheinOpenApiClient({
    baseUrl: 'https://fake.test',
    openKeyId: 'x',
    secretKey: 'y',
    allowFakeBaseUrl: true,
    timeoutMs: 10,
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
        return '{}';
      },
    }),
  });
  await assert.rejects(
    () => client.request('/open-api/test'),
    (error) => error.code === 'REQUEST_TIMEOUT',
  );
});

test('builds a trusted SHEIN authorization URL with an encoded HTTPS callback and state', () => {
  const state = 's'.repeat(43);
  const redirectUrl = 'https://fm.dushengyi.cc/openapi/authorize/callback';
  const value = buildAuthorizationUrl({
    appId: 'full-managed-app',
    redirectUrl,
    state,
  });
  const url = new URL(value);

  assert.equal(url.origin, 'https://openapi-sem.sheincorp.com');
  assert.equal(url.pathname, '/');
  assert.equal(url.search, '');
  assert.match(url.hash, /^#\/empower\?/);

  const parameters = new URLSearchParams(url.hash.split('?', 2)[1]);
  assert.equal(parameters.get('appid'), 'full-managed-app');
  assert.equal(
    Buffer.from(parameters.get('redirectUrl'), 'base64').toString('utf8'),
    redirectUrl,
  );
  assert.equal(parameters.get('state'), state);
  assert.deepEqual([...parameters.keys()].sort(), ['appid', 'redirectUrl', 'state']);
});

test('get-by-token uses x-lt-appid and decrypts the returned AES store secret', async () => {
  const appId = 'full-managed-app';
  const appSecretKey = '0123456789abcdef-app-secret-suffix';
  const state = 'z'.repeat(43);
  const plainSecretKey = 'store-secret-from-platform';
  const encryptedSecretKey = encryptSheinSecretKeyForTest(plainSecretKey, appSecretKey);
  let captured;
  const client = new SheinOpenApiClient({
    baseUrl: 'https://fake.test',
    allowFakeBaseUrl: true,
    platform: 'win32',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        code: 0,
        msg: 'OK',
        traceId: 'trace-auth-test',
        info: {
          appid: appId,
          state,
          supplierId: 'supplier-100',
          supplierBusinessMode: 'FULL_MANAGED',
          openKeyId: 'store-open-key',
          secretKey: encryptedSecretKey,
        },
      }), { status: 200 });
    },
  });

  const result = await client.getByToken({
    appId,
    appSecretKey,
    tempToken: 'temporary-token-123',
    timestamp: '1752570849017',
    randomKey: 'Ab123',
  });

  assert.equal(captured.url, 'https://fake.test/open-api/auth/get-by-token');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['x-lt-appid'], appId);
  assert.equal(captured.init.headers['x-lt-openKeyId'], undefined);
  assert.ok(captured.init.headers['x-lt-signature'].startsWith('Ab123'));
  assert.deepEqual(JSON.parse(captured.init.body), { tempToken: 'temporary-token-123' });
  assert.equal(result.secretKey, plainSecretKey);
  assert.equal(result.encryptedSecretKey, encryptedSecretKey);
  assert.equal(result.openKeyId, 'store-open-key');
  assert.equal(result.supplierId, 'supplier-100');
  assert.equal(
    decryptSheinSecretKey(encryptedSecretKey, appSecretKey),
    plainSecretKey,
  );
});
