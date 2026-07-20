import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SheinOpenApiClient,
  SheinOpenApiError,
  assertOpenApiRuntimeAllowed,
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
