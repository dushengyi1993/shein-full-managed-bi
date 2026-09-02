import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import test from 'node:test';

import {
  SheinOpenApiClient,
} from '../../src/openapi/shein-client.mjs';
import {
  SHEIN_FM_OPENAPI_PROXY_URL,
  SHEIN_FM_OPENAPI_PROXY_REQUIRED,
  isOfficialOpenApiBaseUrl,
  resolveOpenApiProxyConfig,
  resolveOpenApiProxyRequired,
  selectOpenApiTransport,
} from '../../src/openapi/proxy-transport.mjs';

const OFFICIAL_BASE_URL = 'https://openapi.sheincorp.com';

async function startConnectProbe() {
  const connects = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const requestLine = buffer.slice(0, buffer.indexOf('\r\n'));
      if (!requestLine.startsWith('CONNECT ')) return;
      connects.push(requestLine);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      setTimeout(() => socket.destroy(), 50);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port, connects };
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    for (const socket of server.connections ?? []) socket.destroy();
  });
}

test('proxy is disabled for unset, null, or blank configuration values', () => {
  assert.equal(resolveOpenApiProxyConfig(undefined), null);
  assert.equal(resolveOpenApiProxyConfig(null), null);
  assert.equal(resolveOpenApiProxyConfig(''), null);
  assert.equal(resolveOpenApiProxyConfig('   '), null);
});

test('proxy-required flag accepts only explicit 0/1 values and fails closed', () => {
  for (const value of [undefined, null, '', '   ', '0', ' 0 ']) {
    assert.equal(resolveOpenApiProxyRequired(value), false);
  }
  assert.equal(resolveOpenApiProxyRequired('1'), true);
  assert.equal(resolveOpenApiProxyRequired(' 1 '), true);

  for (const value of [true, 1, 'true', 'yes', '2', '-1']) {
    assert.throws(
      () => resolveOpenApiProxyRequired(value),
      (error) => error.code === 'INVALID_PROXY_CONFIG'
        && error.details?.reason === 'INVALID_REQUIRED_FLAG',
    );
  }
});

test('required proxy fails before network while fake origins remain scoped out', async () => {
  const probe = await startConnectProbe();
  try {
    assert.throws(
      () => new SheinOpenApiClient({
        baseUrl: OFFICIAL_BASE_URL,
        platform: 'linux',
        cloudExecution: '1',
        proxyUrl: '',
        proxyRequired: '1',
      }),
      (error) => error.code === 'OPENAPI_PROXY_REQUIRED'
        && error.details?.reason === 'PROXY_NOT_CONFIGURED',
    );
    assert.equal(probe.connects.length, 0);

    const directFetch = async () => new Response(
      JSON.stringify({ code: 0, msg: 'OK', info: {} }),
      { status: 200 },
    );
    const fake = new SheinOpenApiClient({
      baseUrl: 'https://fake.test',
      openKeyId: 'test-open-key',
      secretKey: 'test-secret-key',
      allowFakeBaseUrl: true,
      platform: 'linux',
      proxyUrl: '',
      proxyRequired: '1',
      fetchImpl: directFetch,
    });
    assert.equal(fake.fetchImpl, directFetch);
    assert.equal(fake.dispatcher, undefined);
  } finally {
    await closeServer(probe.server);
  }
});

test('accepts credential-free http(s) loopback proxy URLs and normalizes them', () => {
  assert.deepEqual(resolveOpenApiProxyConfig('http://127.0.0.1:8080'), {
    uri: 'http://127.0.0.1:8080',
  });
  assert.deepEqual(resolveOpenApiProxyConfig('https://127.0.0.1:8443/'), {
    uri: 'https://127.0.0.1:8443',
  });
  assert.deepEqual(resolveOpenApiProxyConfig('http://localhost:8080'), {
    uri: 'http://localhost:8080',
  });
  assert.deepEqual(resolveOpenApiProxyConfig('http://127.9.8.7:8080'), {
    uri: 'http://127.9.8.7:8080',
  });
  assert.deepEqual(resolveOpenApiProxyConfig('http://[::1]:8080'), {
    uri: 'http://[::1]:8080',
  });
});

test('unsafe proxy configurations fail closed without echoing the value', () => {
  const secret = 'do-not-leak-this-secret';
  const invalidValues = [
    'http://user:do-not-leak-this-secret@127.0.0.1:8080',
    'ftp://127.0.0.1:21',
    'socks5://127.0.0.1:1080',
    'http://192.168.1.5:8080',
    'http://openapi.sheincorp.com:8080',
    'http://127.0.0.1:0',
    'http://127.0.0.1:8080?token=abc',
    'http://127.0.0.1:8080#fragment',
    'http://127.0.0.1:8080/upstream',
    'http://127.0.0.1:70000',
    'not a url',
    12345,
    true,
  ];
  for (const value of invalidValues) {
    assert.throws(
      () => resolveOpenApiProxyConfig(value),
      (error) => error.code === 'INVALID_PROXY_CONFIG',
    );
  }

  assert.throws(
    () => resolveOpenApiProxyConfig('http://user:do-not-leak-this-secret@127.0.0.1:8080'),
    (error) => {
      const serialized = JSON.stringify(error);
      return !String(error.message).includes(secret) && !serialized.includes(secret);
    },
  );
  assert.throws(
    () => new SheinOpenApiClient({
      baseUrl: OFFICIAL_BASE_URL,
      proxyUrl: 'http://user:do-not-leak-this-secret@127.0.0.1:8080',
    }),
    (error) => {
      const serialized = JSON.stringify(error);
      return error.code === 'INVALID_PROXY_CONFIG' && !serialized.includes(secret);
    },
  );
});

test('official origin detection is exact and fails safe for lookalikes', () => {
  assert.equal(isOfficialOpenApiBaseUrl(OFFICIAL_BASE_URL), true);
  assert.equal(isOfficialOpenApiBaseUrl(OFFICIAL_BASE_URL + '/open-api/test'), true);
  assert.equal(isOfficialOpenApiBaseUrl('https://openapi.sheincorp.com:443/'), true);
  assert.equal(isOfficialOpenApiBaseUrl('https://evil.openapi.sheincorp.com'), false);
  assert.equal(isOfficialOpenApiBaseUrl('https://openapi.sheincorp.com.evil.net'), false);
  assert.equal(isOfficialOpenApiBaseUrl('http://openapi.sheincorp.com'), false);
  assert.equal(isOfficialOpenApiBaseUrl('https://other.sheincorp.com'), false);
  assert.equal(isOfficialOpenApiBaseUrl('https://fake.test'), false);
  assert.equal(isOfficialOpenApiBaseUrl('not a url'), false);
});

test('selects a proxy transport only for the official SHEIN OpenAPI origin', async () => {
  const injectedFetch = globalThis.fetch;
  const proxyConfig = { uri: 'http://127.0.0.1:8080' };

  const disabled = selectOpenApiTransport({
    baseUrl: OFFICIAL_BASE_URL, proxyConfig: null, fetchImpl: injectedFetch,
  });
  assert.equal(disabled.fetchImpl, injectedFetch);
  assert.equal(disabled.dispatcher, undefined);
  assert.equal(disabled.proxied, false);

  const proxied = selectOpenApiTransport({
    baseUrl: OFFICIAL_BASE_URL, proxyConfig, fetchImpl: injectedFetch,
  });
  assert.notEqual(proxied.fetchImpl, injectedFetch);
  assert.notEqual(proxied.dispatcher, undefined);
  assert.equal(proxied.proxied, true);

  for (const baseUrl of [
    'https://fake.test',
    'https://other.sheincorp.com',
    'https://evil.openapi.sheincorp.com',
  ]) {
    const scopedOut = selectOpenApiTransport({ baseUrl, proxyConfig, fetchImpl: injectedFetch });
    assert.equal(scopedOut.fetchImpl, injectedFetch, baseUrl);
    assert.equal(scopedOut.dispatcher, undefined, baseUrl);
    assert.equal(scopedOut.proxied, false, baseUrl);
  }
  await proxied.dispatcher.close();
});

test('request() carries the dispatcher so only the official host CONNECTs through the local proxy', async () => {
  const probe = await startConnectProbe();
  let client;
  try {
    client = new SheinOpenApiClient({
      baseUrl: OFFICIAL_BASE_URL,
      openKeyId: 'test-open-key',
      secretKey: 'test-secret-key',
      platform: 'linux',
      cloudExecution: '1',
      proxyUrl: `http://127.0.0.1:${probe.port}`,
      proxyRequired: '1',
      timeoutMs: 3_000,
    });
    await assert.rejects(
      () => client.request('/open-api/test', {
        timestamp: '1752570849017',
        randomKey: 'Ab123',
      }),
      (error) => error.code === 'NETWORK_ERROR',
    );
    assert.ok(probe.connects.length >= 1, 'expected at least one CONNECT through the probe');
    for (const line of probe.connects) {
      assert.equal(line, 'CONNECT openapi.sheincorp.com:443 HTTP/1.1');
    }
  } finally {
    await client?.dispatcher?.close();
    await closeServer(probe.server);
  }
});

test('getByToken() also routes through the configured proxy dispatcher', async () => {
  const probe = await startConnectProbe();
  let client;
  try {
    client = new SheinOpenApiClient({
      baseUrl: OFFICIAL_BASE_URL,
      platform: 'linux',
      cloudExecution: '1',
      proxyUrl: `http://127.0.0.1:${probe.port}`,
      proxyRequired: '1',
      timeoutMs: 3_000,
    });
    await assert.rejects(
      () => client.getByToken({
        appId: 'test-app',
        appSecretKey: '0123456789abcdef-app-secret-suffix',
        tempToken: 'temporary-token-123',
        timestamp: '1752570849017',
        randomKey: 'Ab123',
      }),
      (error) => error.code === 'NETWORK_ERROR',
    );
    assert.ok(probe.connects.length >= 1, 'expected at least one CONNECT through the probe');
    for (const line of probe.connects) {
      assert.equal(line, 'CONNECT openapi.sheincorp.com:443 HTTP/1.1');
    }
  } finally {
    await client?.dispatcher?.close();
    await closeServer(probe.server);
  }
});

test('proxy configuration never bypasses the Windows or cloud-execution gates', async () => {
  const probe = await startConnectProbe();
  let blockedOnWindows;
  let missingAttestation;
  try {
    blockedOnWindows = new SheinOpenApiClient({
      baseUrl: OFFICIAL_BASE_URL,
      openKeyId: 'test-open-key',
      secretKey: 'test-secret-key',
      platform: 'win32',
      cloudExecution: '1',
      proxyUrl: `http://127.0.0.1:${probe.port}`,
    });
    await assert.rejects(
      () => blockedOnWindows.request('/open-api/test'),
      (error) => error.code === 'REAL_OPENAPI_BLOCKED_ON_WINDOWS',
    );

    missingAttestation = new SheinOpenApiClient({
      baseUrl: OFFICIAL_BASE_URL,
      openKeyId: 'test-open-key',
      secretKey: 'test-secret-key',
      platform: 'linux',
      cloudExecution: undefined,
      proxyUrl: `http://127.0.0.1:${probe.port}`,
    });
    await assert.rejects(
      () => missingAttestation.request('/open-api/test'),
      (error) => error.code === 'REAL_OPENAPI_CLOUD_ATTESTATION_REQUIRED',
    );

    assert.equal(probe.connects.length, 0, 'gates must reject before any proxy connection');
  } finally {
    await blockedOnWindows?.dispatcher?.close();
    await missingAttestation?.dispatcher?.close();
    await closeServer(probe.server);
  }
});

test('non-official base URLs keep the injected fetch and never receive a dispatcher', async () => {
  let captured;
  const client = new SheinOpenApiClient({
    baseUrl: 'https://fake.test',
    openKeyId: 'test-open-key',
    secretKey: 'test-secret-key',
    allowFakeBaseUrl: true,
    platform: 'win32',
    proxyUrl: 'http://127.0.0.1:8080',
    proxyRequired: '1',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ code: 0, msg: 'OK', info: {} }), { status: 200 });
    },
  });
  await client.request('/open-api/test', { timestamp: '1752570849017', randomKey: 'Ab123' });
  assert.equal(client.dispatcher, undefined);
  assert.equal(captured.init.dispatcher, undefined);
});

test('creating a proxied OpenAPI client never changes ordinary global fetch', async () => {
  const proxyProbe = await startConnectProbe();
  const directServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('direct-ok');
  });
  directServer.listen(0, '127.0.0.1');
  await once(directServer, 'listening');
  let client;
  try {
    client = new SheinOpenApiClient({
      baseUrl: OFFICIAL_BASE_URL,
      platform: 'linux',
      cloudExecution: '1',
      proxyUrl: `http://127.0.0.1:${proxyProbe.port}`,
      proxyRequired: '1',
    });
    const address = directServer.address();
    const response = await globalThis.fetch(`http://127.0.0.1:${address.port}/ordinary`);
    assert.equal(await response.text(), 'direct-ok');
    assert.equal(proxyProbe.connects.length, 0);
  } finally {
    await client?.dispatcher?.close();
    await closeServer(directServer);
    await closeServer(proxyProbe.server);
  }
});

test('constructor reads SHEIN_FM_OPENAPI_PROXY_URL only as an explicit opt-in', async () => {
  const previous = process.env[SHEIN_FM_OPENAPI_PROXY_URL];
  const previousRequired = process.env[SHEIN_FM_OPENAPI_PROXY_REQUIRED];
  try {
    delete process.env[SHEIN_FM_OPENAPI_PROXY_URL];
    delete process.env[SHEIN_FM_OPENAPI_PROXY_REQUIRED];
    const disabled = new SheinOpenApiClient({
      baseUrl: OFFICIAL_BASE_URL, platform: 'linux', cloudExecution: '1',
    });
    assert.equal(disabled.dispatcher, undefined);

    process.env[SHEIN_FM_OPENAPI_PROXY_URL] = 'http://127.0.0.1:8080';
    process.env[SHEIN_FM_OPENAPI_PROXY_REQUIRED] = '1';
    const enabled = new SheinOpenApiClient({
      baseUrl: OFFICIAL_BASE_URL, platform: 'linux', cloudExecution: '1',
    });
    assert.notEqual(enabled.dispatcher, undefined);
    await enabled.dispatcher.close();
  } finally {
    if (previous === undefined) delete process.env[SHEIN_FM_OPENAPI_PROXY_URL];
    else process.env[SHEIN_FM_OPENAPI_PROXY_URL] = previous;
    if (previousRequired === undefined) delete process.env[SHEIN_FM_OPENAPI_PROXY_REQUIRED];
    else process.env[SHEIN_FM_OPENAPI_PROXY_REQUIRED] = previousRequired;
  }
});
