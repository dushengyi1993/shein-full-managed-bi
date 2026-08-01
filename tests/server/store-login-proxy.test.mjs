import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStoreLoginProxy,
  StoreLoginProxyError,
} from '../../src/server/store-login-proxy.mjs';

const TOKEN = 'test-only-store-login-internal-token-1234567890';

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('internal proxy keeps its bearer server-side and validates the 25-store status', async () => {
  const calls = [];
  const proxy = createStoreLoginProxy({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, {
        ok: true,
        total: 25,
        completed: 24,
        allCompleted: false,
        active: null,
        stores: [{ storeCode: 'NM7418', status: 'pending' }],
      });
    },
  });

  const result = await proxy.status();
  assert.equal(result.total, 25);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8794/api/store-login/status');
  assert.equal(calls[0].options.headers['X-FM-Internal-Token'], TOKEN);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
});

test('start accepts only a canonical store and a same-origin session path', async () => {
  const proxy = createStoreLoginProxy({
    token: TOKEN,
    fetchImpl: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), { storeCode: 'NM7418' });
      return response(200, {
        ok: true,
        storeCode: 'NM7418',
        openUrl: '/store-login/session/fm-login-123#token=abc_DEF-123',
      });
    },
  });

  assert.equal((await proxy.start('nm7418')).storeCode, 'NM7418');
  await assert.rejects(
    () => proxy.start('NM0000'),
    (error) => error instanceof StoreLoginProxyError && error.code === 'STORE_INVALID',
  );
});

test('upstream secrets and arbitrary URLs never pass through the proxy', async () => {
  const proxy = createStoreLoginProxy({
    token: TOKEN,
    fetchImpl: async () => response(200, {
      ok: true,
      storeCode: 'NM7418',
      openUrl: 'https://attacker.invalid/session#token=secret',
    }),
  });
  await assert.rejects(
    () => proxy.start('NM7418'),
    (error) => (
      error instanceof StoreLoginProxyError
      && error.code === 'STORE_LOGIN_RESPONSE_INVALID'
    ),
  );
});

test('internal URL is loopback-only', () => {
  assert.throws(
    () => createStoreLoginProxy({
      baseUrl: 'https://fm.dushengyi.cc',
      token: TOKEN,
    }),
    /loopback HTTP origin/,
  );
});
