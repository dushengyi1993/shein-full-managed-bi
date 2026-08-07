import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TRANSPORT_REJECT_CODES,
  buildPageFetchExpression,
  createPageContextTransport,
} from '../../src/webapi-experiment/page-transport.mjs';
import {
  WEBAPI_ORIGIN,
  resolveEndpointUrl,
} from '../../src/webapi-experiment/endpoint-allowlist.mjs';
import {
  createCdpClient,
  CDP_ALLOWED_METHODS,
  CdpClientError,
} from '../../src/webapi-experiment/cdp-client.mjs';

const DETAIL_REQUEST = Object.freeze({ metaIndexIds: [70] });
const DETAIL_URL = resolveEndpointUrl('HOME_DATA_OVERVIEW_DETAIL', DETAIL_REQUEST);

/** Session double: records every evaluated expression, opens no browser. */
function fakeSession(reply) {
  const expressions = [];
  return {
    expressions,
    async evaluate(expression) {
      expressions.push(String(expression));
      return typeof reply === 'function' ? reply(String(expression)) : reply;
    },
  };
}

function okReply(body) {
  const text = JSON.stringify(body);
  return { sameOrigin: true, httpStatus: 200, byteLength: text.length, bodyText: text };
}

test('the transport performs exactly one page-context fetch and returns parsed JSON', async () => {
  const session = fakeSession(okReply({ list: [{ metaIndexId: 70, code: 'GSP000016', count: '1' }] }));
  const transport = createPageContextTransport({
    session,
    endpointCode: 'HOME_DATA_OVERVIEW_DETAIL',
    request: DETAIL_REQUEST,
  });
  const result = await transport({ method: 'POST', url: DETAIL_URL, body: { metaIndexIds: [70] } });
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.body.list[0], { metaIndexId: 70, code: 'GSP000016', count: '1' });
  assert.equal(session.expressions.length, 1);

  const expression = session.expressions[0];
  // The credential stays inside the browser: the page attaches it, and no
  // cookie, storage or header value is read by this process.
  assert.match(expression, /credentials: 'include'/);
  assert.match(expression, new RegExp(JSON.stringify(DETAIL_URL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(expression, /document\.cookie|localStorage|sessionStorage|getAllCookies/);
  assert.doesNotMatch(expression, /response\.headers|getAllResponseHeaders/);
});

test('a caller cannot supply an arbitrary url, path, method, body or header', async () => {
  const session = fakeSession(okReply({ list: [] }));
  const transport = createPageContextTransport({
    session,
    endpointCode: 'HOME_DATA_OVERVIEW_DETAIL',
    request: DETAIL_REQUEST,
  });
  const valid = { method: 'POST', url: DETAIL_URL, body: { metaIndexIds: [70] } };

  await assert.rejects(() => transport({ ...valid, url: 'https://evil.example/x' }),
    (error) => error.code === TRANSPORT_REJECT_CODES.URL_MISMATCH);
  await assert.rejects(() => transport({ ...valid, url: `${WEBAPI_ORIGIN}/sso/homePage/other` }),
    (error) => error.code === TRANSPORT_REJECT_CODES.URL_MISMATCH);
  await assert.rejects(() => transport({ ...valid, method: 'DELETE' }),
    (error) => error.code === TRANSPORT_REJECT_CODES.METHOD_MISMATCH);
  await assert.rejects(() => transport({ ...valid, method: 'GET' }),
    (error) => error.code === TRANSPORT_REJECT_CODES.METHOD_MISMATCH);
  await assert.rejects(() => transport({ ...valid, body: { metaIndexIds: [70, 71] } }),
    (error) => error.code === TRANSPORT_REJECT_CODES.BODY_MISMATCH);
  await assert.rejects(
    () => transport({ ...valid, headers: { Cookie: 'a=b' } }),
    (error) => error.code === TRANSPORT_REJECT_CODES.HEADER_NOT_ALLOWED,
  );
  // Nothing above reached the page.
  assert.equal(session.expressions.length, 0);

  // An endpoint outside the evidenced allow-list cannot even build a transport.
  assert.throws(
    () => createPageContextTransport({ session, endpointCode: 'HOME_TREND_HISTORY' }),
    (error) => error.code === 'WEBAPI_ENDPOINT_NOT_ALLOWED',
  );
});

test('oversize, non-JSON, cross-origin and expired responses fail closed with sanitized codes', async () => {
  const build = (reply) => createPageContextTransport({
    session: fakeSession(reply),
    endpointCode: 'HOME_DATA_OVERVIEW_DETAIL',
    request: DETAIL_REQUEST,
    limits: { maxResponseBytes: 32 },
  });
  const call = { method: 'POST', url: DETAIL_URL, body: { metaIndexIds: [70] } };

  // The page already refused to return the text, so nothing is parsed.
  await assert.rejects(
    () => build({ sameOrigin: true, httpStatus: 200, byteLength: 4096, bodyText: null })(call),
    (error) => error.code === TRANSPORT_REJECT_CODES.RESPONSE_TOO_LARGE,
  );
  await assert.rejects(
    () => build({ sameOrigin: true, httpStatus: 200, byteLength: 5, bodyText: 'not json' })(call),
    (error) => error.code === TRANSPORT_REJECT_CODES.RESPONSE_NOT_JSON,
  );
  await assert.rejects(
    () => build({ sameOrigin: true, httpStatus: 200, byteLength: 2, bodyText: '12' })(call),
    (error) => error.code === TRANSPORT_REJECT_CODES.RESPONSE_SHAPE_INVALID,
  );
  await assert.rejects(
    () => build({ sameOrigin: false })(call),
    (error) => error.code === TRANSPORT_REJECT_CODES.ORIGIN_MISMATCH,
  );
  for (const httpStatus of [401, 403]) {
    await assert.rejects(
      () => build({ sameOrigin: true, httpStatus, byteLength: 2, bodyText: '{}' })(call),
      (error) => error.code === TRANSPORT_REJECT_CODES.AUTH_EXPIRED,
      String(httpStatus),
    );
  }
  await assert.rejects(
    () => build({ sameOrigin: true, httpStatus: null, failed: true })(call),
    (error) => error.code === TRANSPORT_REJECT_CODES.EVALUATE_FAILED,
  );
  // No SHEIN message, body text or header ever appears in an error.
  const error = await build({ sameOrigin: true, httpStatus: 403, byteLength: 2, bodyText: '{}' })(call)
    .then(() => null, (thrown) => thrown);
  assert.doesNotMatch(error.message, /cookie|token|Bearer|\{/i);
});

test('HTTP 200 business status rejects expired and failed envelopes without platform text', async () => {
  const build = (body) => createPageContextTransport({
    session: fakeSession(okReply(body)),
    endpointCode: 'HOME_DATA_OVERVIEW_DETAIL',
    request: DETAIL_REQUEST,
  });
  const call = { method: 'POST', url: DETAIL_URL, body: { metaIndexIds: [70] } };

  await assert.rejects(
    () => build({ code: 20302, msg: 'sensitive platform text' })(call),
    (error) => error.code === TRANSPORT_REJECT_CODES.AUTH_EXPIRED
      && !error.message.includes('sensitive platform text'),
  );
  await assert.rejects(
    () => build({ status: '50001', message: 'internal platform detail' })(call),
    (error) => error.code === TRANSPORT_REJECT_CODES.BUSINESS_STATUS_FAILED
      && !error.message.includes('internal platform detail'),
  );
  await assert.doesNotReject(
    () => build({ code: 0, list: [] })(call),
  );
  await assert.doesNotReject(
    () => build({ list: [] })(call),
  );
});

test('the in-page expression verifies origin and bounds the returned text', () => {
  const expression = buildPageFetchExpression({
    origin: WEBAPI_ORIGIN,
    url: DETAIL_URL,
    method: 'POST',
    body: { metaIndexIds: [70] },
    maxResponseBytes: 1024,
    requestTimeoutMs: 5000,
  });
  assert.match(expression, /location\.origin !== expectedOrigin/);
  assert.match(expression, /byteLength > 1024 \? null : text/);
  assert.match(expression, /AbortSignal\.timeout\(5000\)/);
  // Only a content type is set, and only when a body exists.
  assert.match(expression, /'Content-Type': 'application\/json;Charset=utf-8'/);
  assert.doesNotMatch(expression, /Authorization|Cookie:/i);
});

/** CDP doubles: no socket, no port, no browser. */
function fakeCdpDeps({ messages = [], failMethod = null } = {}) {
  const sent = [];
  const listeners = new Map();
  const socket = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
      if (type === 'open') setTimeout(() => listener(), 0);
    },
    send(raw) {
      const message = JSON.parse(raw);
      sent.push(message);
      const reply = failMethod === message.method
        ? { id: message.id, error: { message: 'refused' } }
        : { id: message.id, result: messages.shift() ?? {} };
      setTimeout(() => {
        for (const listener of listeners.get('message') ?? []) {
          listener({ data: JSON.stringify(reply) });
        }
      }, 0);
    },
    close() {},
  };
  return {
    sent,
    port: 62_041,
    httpJson: async () => ([{
      type: 'page',
      url: `${WEBAPI_ORIGIN}/#/home`,
      webSocketDebuggerUrl: 'ws://127.0.0.1:62041/devtools/page/1',
    }]),
    createWebSocket: () => socket,
  };
}

test('the CDP client allows only four methods and rejects credential domains', async () => {
  const deps = fakeCdpDeps({ messages: [{}, { result: { value: { ok: true } } }] });
  const client = await createCdpClient(deps);
  assert.deepEqual([...CDP_ALLOWED_METHODS], [
    'Runtime.enable', 'Runtime.evaluate', 'Page.navigate', 'Page.getNavigationHistory',
  ]);
  const value = await client.evaluate('1');
  assert.deepEqual(value, { ok: true });
  assert.equal(deps.sent[0].method, 'Runtime.enable');
  assert.equal(deps.sent[1].params.awaitPromise, true);
  assert.equal(deps.sent[1].params.returnByValue, true);

  for (const method of [
    'Network.getAllCookies', 'Storage.getCookies', 'Browser.setDownloadBehavior',
    'DOMStorage.getDOMStorageItems', 'Fetch.enable', 'Runtime.callFunctionOn', 'Page.captureScreenshot',
  ]) {
    assert.throws(() => client.send(method), CdpClientError, method);
  }
  client.close();
  await assert.rejects(() => client.send('Runtime.evaluate'),
    (error) => error.code === 'CDP_SOCKET_CLOSED');
});

test('saved credential gestures are exact and Input remains unavailable to general callers', async () => {
  const deps = fakeCdpDeps({ messages: Array.from({ length: 8 }, () => ({})) });
  const client = await createCdpClient(deps);
  await client.savedCredentialGesture('focus', { x: 320, y: 240 });
  await client.savedCredentialGesture('next');
  await client.savedCredentialGesture('confirm');
  assert.deepEqual(
    deps.sent.slice(1).map((entry) => `${entry.method}:${entry.params.type}:${entry.params.key || ''}`),
    [
      'Input.dispatchMouseEvent:mouseMoved:',
      'Input.dispatchMouseEvent:mousePressed:',
      'Input.dispatchMouseEvent:mouseReleased:',
      'Input.dispatchKeyEvent:keyDown:ArrowDown',
      'Input.dispatchKeyEvent:keyUp:ArrowDown',
      'Input.dispatchKeyEvent:keyDown:Enter',
      'Input.dispatchKeyEvent:keyUp:Enter',
    ],
  );
  assert.throws(
    () => client.send('Input.dispatchKeyEvent'),
    (error) => error.code === 'CDP_METHOD_DOMAIN_FORBIDDEN',
  );
  await assert.rejects(
    () => client.savedCredentialGesture('focus', { x: -1, y: 20 }),
    (error) => error.code === 'CDP_SAVED_CREDENTIAL_POINT_INVALID',
  );
  await assert.rejects(
    () => client.savedCredentialGesture('type-password'),
    (error) => error.code === 'CDP_SAVED_CREDENTIAL_GESTURE_INVALID',
  );
  client.close();
});

test('the CDP client refuses a non-loopback target and a rejected command', async () => {
  await assert.rejects(
    () => createCdpClient({
      ...fakeCdpDeps(),
      httpJson: async () => ([{
        type: 'page',
        url: 'https://example.com',
        webSocketDebuggerUrl: 'ws://10.0.0.5:62041/devtools/page/1',
      }]),
    }),
    (error) => error.code === 'CDP_PAGE_TARGET_NOT_LOOPBACK',
  );
  await assert.rejects(
    () => createCdpClient({ ...fakeCdpDeps(), httpJson: async () => ([]) }),
    (error) => error.code === 'CDP_PAGE_TARGET_MISSING',
  );
  await assert.rejects(() => createCdpClient({ ...fakeCdpDeps(), port: 80 }),
    (error) => error.code === 'CDP_PORT_INVALID');
  const failing = await createCdpClient(fakeCdpDeps({ failMethod: 'Page.navigate' }));
  await assert.rejects(() => failing.send('Page.navigate', { url: WEBAPI_ORIGIN }),
    (error) => error.code === 'CDP_COMMAND_REJECTED');
  failing.close();
});
