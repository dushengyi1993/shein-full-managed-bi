import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createEncryptedWebApiSessionStore,
  createEphemeralWebApiSessionStore,
  decodeWebApiSessionKey,
} from '../../src/webapi-session/encrypted-session-store.mjs';
import {
  cookieHeaderForUrl,
  mergeSetCookieHeaders,
} from '../../src/webapi-session/cookie-jar.mjs';
import {
  createFullHomeHttpTransport,
  openFullHomeHttpSession,
} from '../../src/webapi-session/http-home-transport.mjs';
import { exportAuthenticatedWebApiSession } from '../../src/webapi-session/profile-session-exporter.mjs';
import { STORE_RUNTIME_SLOTS } from '../../src/webapi-experiment/browser-session.mjs';

const KEY = Buffer.alloc(32, 7);
const NOW = new Date('2026-08-06T12:00:00.000Z');

function bundle(storeCode = 'DL5477') {
  return {
    version: 1,
    storeCode,
    origin: 'https://sso.geiwohuo.com',
    userAgent: 'session-http-test-agent',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    identityProvenAt: NOW.toISOString(),
    lastVerifiedAt: null,
    cookies: [
      {
        name: 'private_auth',
        value: 'private-value-not-on-disk',
        domain: '.geiwohuo.com',
        path: '/',
        expires: NOW.valueOf() / 1000 + 86_400,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ],
  };
}

test('encrypted session store atomically hides credentials and rejects tampering', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fm-session-store-'));
  try {
    const store = createEncryptedWebApiSessionStore({ directory, key: KEY });
    await store.write('DL5477', bundle());
    const file = path.join(directory, 'DL5477.session.enc.json');
    const encrypted = await readFile(file, 'utf8');
    assert.doesNotMatch(encrypted, /private_auth|private-value-not-on-disk/);
    assert.deepEqual(await store.read('DL5477'), {
      ...bundle(),
      cookies: [{ ...bundle().cookies[0], hostOnly: false, order: 0 }],
    });
    const envelope = JSON.parse(encrypted);
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(store.read('DL5477'), { code: 'WEBAPI_SESSION_DECRYPT_FAILED' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('key decoding accepts exactly 256 bits', () => {
  assert.equal(decodeWebApiSessionKey(KEY.toString('base64')).length, 32);
  assert.equal(decodeWebApiSessionKey(KEY.toString('hex')).length, 32);
  assert.throws(() => decodeWebApiSessionKey(Buffer.alloc(31).toString('base64')), {
    code: 'WEBAPI_SESSION_KEY_INVALID',
  });
});

test('cookie jar applies scope, expiry and server rotation', () => {
  const scoped = {
    ...bundle(),
    cookies: [
      ...bundle().cookies,
      { name: 'sbn_only', value: '1', domain: 'sso.geiwohuo.com', path: '/sbn', secure: true },
      { name: 'expired', value: 'gone', domain: '.geiwohuo.com', path: '/', expires: 1 },
    ],
  };
  const header = cookieHeaderForUrl(
    scoped,
    'https://sso.geiwohuo.com/sbn/index/get_update_time',
    NOW,
  );
  assert.match(header, /^sbn_only=1; private_auth=/);
  assert.doesNotMatch(header, /expired/);
  const rotated = mergeSetCookieHeaders(scoped, 'https://sso.geiwohuo.com/sbn/index', [
    'private_auth=renewed; Domain=.geiwohuo.com; Path=/; Secure; HttpOnly; SameSite=Lax',
    'sbn_only=; Path=/sbn; Max-Age=0; Secure',
  ], NOW);
  const nextHeader = cookieHeaderForUrl(
    rotated,
    'https://sso.geiwohuo.com/sbn/index/get_update_time',
    NOW,
  );
  assert.equal(nextHeader, 'private_auth=renewed');
});

test('HTTP transport sends a fixed same-origin request and persists rotated state', async () => {
  let stored = bundle();
  const store = {
    async read() { return stored; },
    async write(storeCode, next) {
      assert.equal(storeCode, 'DL5477');
      stored = next;
    },
  };
  const calls = [];
  const session = await openFullHomeHttpSession({
    storeCode: 'DL5477',
    sessionStore: store,
    clock: () => new Date(NOW),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        status: 200,
        headers: {
          getSetCookie: () => ['private_auth=rotated; Domain=.geiwohuo.com; Path=/; Secure; HttpOnly'],
        },
        async text() { return '{"code":"0","info":[]}'; },
      };
    },
  });
  const result = await createFullHomeHttpTransport({ session })(
    'UPDATE_TIME',
    { pageCode: 'Index', areaCd: 'cn' },
  );
  assert.equal(result.httpStatus, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://sso.geiwohuo.com/sbn/common/get_update_time');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.Origin, 'https://sso.geiwohuo.com');
  assert.match(calls[0].options.headers.Cookie, /private_auth=/);
  await session.close();
  assert.equal(stored.cookies.find(({ name }) => name === 'private_auth').value, 'rotated');
  assert.equal(stored.lastVerifiedAt, NOW.toISOString());
});

test('HTTP transport rejects redirects as expired authentication', async () => {
  const store = { async read() { return bundle(); }, async write() {} };
  const session = await openFullHomeHttpSession({
    storeCode: 'DL5477',
    sessionStore: store,
    fetchImpl: async () => ({
      status: 302,
      headers: { getSetCookie: () => [] },
      async text() { return ''; },
    }),
  });
  await assert.rejects(
    createFullHomeHttpTransport({ session })('UPDATE_TIME', {}),
    { code: 'HOME_AUTH_EXPIRED' },
  );
  await session.close();
});

test('dual-read candidates remain memory-only until an explicit promotion', async () => {
  const candidate = createEphemeralWebApiSessionStore(bundle(), 'DL5477');
  const persistentWrites = [];
  const persistent = {
    async write(storeCode, next) { persistentWrites.push({ storeCode, next }); },
  };
  const session = await openFullHomeHttpSession({
    storeCode: 'DL5477',
    sessionStore: candidate,
    clock: () => new Date(NOW),
    fetchImpl: async () => ({
      status: 200,
      headers: {
        getSetCookie: () => ['private_auth=candidate-only; Domain=.geiwohuo.com; Path=/; Secure'],
      },
      async text() { return '{"code":"0","info":[]}'; },
    }),
  });
  await createFullHomeHttpTransport({ session })('UPDATE_TIME', {});
  await session.close();
  assert.equal(persistentWrites.length, 0);
  assert.equal(
    candidate.snapshot().cookies.find(({ name }) => name === 'private_auth').value,
    'candidate-only',
  );
  await persistent.write('DL5477', candidate.snapshot());
  assert.equal(persistentWrites.length, 1);
});

class FakeSocket extends EventTarget {
  constructor(url, onSend) {
    super();
    this.url = url;
    this.onSend = onSend;
    setTimeout(() => this.dispatchEvent(new Event('open')), 0);
  }

  send(value) {
    const response = this.onSend(JSON.parse(value));
    setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify(response),
    })), 0);
  }

  close() {
    this.dispatchEvent(new Event('close'));
  }
}

test('profile exporter reads only fixed-origin cookies after browser identity proof', async () => {
  const port = STORE_RUNTIME_SLOTS.DL5477.debuggingPort;
  const requested = [];
  const result = await exportAuthenticatedWebApiSession({
    storeCode: 'DL5477',
    session: {
      storeCode: 'DL5477',
      identityProven: true,
      async evaluate(expression) {
        assert.equal(expression, 'String(navigator.userAgent || "")');
        return 'browser-agent';
      },
    },
    fetchImpl: async (url) => {
      assert.equal(url, `http://127.0.0.1:${port}/json/list`);
      return {
        ok: true,
        async text() {
          return JSON.stringify([{
            type: 'page',
            url: 'https://sso.geiwohuo.com/#/gsp/home',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1`,
          }]);
        },
      };
    },
    createWebSocket: (url) => new FakeSocket(url, (message) => {
      requested.push(message);
      return { id: 1, result: { cookies: bundle().cookies } };
    }),
    clock: () => NOW,
  });
  assert.equal(result.storeCode, 'DL5477');
  assert.equal(result.userAgent, 'browser-agent');
  assert.equal(requested.length, 1);
  assert.equal(requested[0].method, 'Network.getCookies');
  assert.ok(requested[0].params.urls.every((url) => url.startsWith('https://sso.geiwohuo.com/')));
});
