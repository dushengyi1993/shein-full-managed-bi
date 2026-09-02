import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import test from 'node:test';

import {
  SHEIN_OPENAPI_CONNECT_AUTHORITY,
  createSheinOpenApiConnectRelay,
  isAllowedSheinConnectAuthority,
} from '../../src/openapi/connect-relay.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function rawRequest(port, request, predicate) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for relay response'));
    }, 2_000);
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const value = Buffer.concat(chunks);
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('CONNECT allow-list accepts only the official HTTPS authority', () => {
  assert.equal(isAllowedSheinConnectAuthority(SHEIN_OPENAPI_CONNECT_AUTHORITY), true);
  assert.equal(isAllowedSheinConnectAuthority('OPENAPI.SHEINCORP.COM:443'), true);
  for (const authority of [
    'openapi.sheincorp.com',
    'openapi.sheincorp.com:80',
    'openapi.sheincorp.com.:443',
    'evil.openapi.sheincorp.com:443',
    'openapi.sheincorp.com.evil.test:443',
    'user@openapi.sheincorp.com:443',
    ' openapi.sheincorp.com:443',
    '',
    null,
  ]) {
    assert.equal(isAllowedSheinConnectAuthority(authority), false, String(authority));
  }
});

test('allowed CONNECT tunnels bytes to the fixed dial target', async () => {
  const upstream = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])));
  });
  const upstreamPort = await listen(upstream);
  const relay = createSheinOpenApiConnectRelay({
    dialHost: '127.0.0.1',
    dialPort: upstreamPort,
  });
  const relayPort = await listen(relay.server);
  try {
    const response = await rawRequest(
      relayPort,
      `CONNECT ${SHEIN_OPENAPI_CONNECT_AUTHORITY} HTTP/1.1\r\n`
        + `Host: ${SHEIN_OPENAPI_CONNECT_AUTHORITY}\r\n\r\nPING`,
      (value) => value.includes(Buffer.from('echo:PING')),
    );
    assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 Connection Established\r\n/);
    assert.ok(response.includes(Buffer.from('echo:PING')));
  } finally {
    relay.destroySockets();
    await closeServer(relay.server);
    await closeServer(upstream);
  }
});

test('lookalike CONNECT targets are denied before an upstream connection', async () => {
  let upstreamConnections = 0;
  const upstream = net.createServer((socket) => {
    upstreamConnections += 1;
    socket.destroy();
  });
  const upstreamPort = await listen(upstream);
  const relay = createSheinOpenApiConnectRelay({
    dialHost: '127.0.0.1',
    dialPort: upstreamPort,
  });
  const relayPort = await listen(relay.server);
  try {
    const response = await rawRequest(
      relayPort,
      'CONNECT openapi.sheincorp.com.evil.test:443 HTTP/1.1\r\n'
        + 'Host: openapi.sheincorp.com.evil.test:443\r\n\r\n',
      (value) => value.includes(Buffer.from('\r\n\r\n')),
    );
    assert.match(response.toString('latin1'), /^HTTP\/1\.1 403 Forbidden\r\n/);
    assert.equal(upstreamConnections, 0);
  } finally {
    relay.destroySockets();
    await closeServer(relay.server);
    await closeServer(upstream);
  }
});

test('ordinary HTTP requests are rejected and never proxied', async () => {
  let dialAttempts = 0;
  const relay = createSheinOpenApiConnectRelay({
    connectImpl() {
      dialAttempts += 1;
      throw new Error('must not dial');
    },
  });
  const relayPort = await listen(relay.server);
  try {
    const statusCode = await new Promise((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${relayPort}/`, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject);
    });
    assert.equal(statusCode, 405);
    assert.equal(dialAttempts, 0);
  } finally {
    relay.destroySockets();
    await closeServer(relay.server);
  }
});

test('upstream dial failures return a sanitized 502', async () => {
  const relay = createSheinOpenApiConnectRelay({
    connectImpl() {
      throw new Error('sensitive internal dial detail');
    },
  });
  const relayPort = await listen(relay.server);
  try {
    const response = await rawRequest(
      relayPort,
      `CONNECT ${SHEIN_OPENAPI_CONNECT_AUTHORITY} HTTP/1.1\r\n`
        + `Host: ${SHEIN_OPENAPI_CONNECT_AUTHORITY}\r\n\r\n`,
      (value) => value.includes(Buffer.from('\r\n\r\n')),
    );
    const text = response.toString('latin1');
    assert.match(text, /^HTTP\/1\.1 502 Bad Gateway\r\n/);
    assert.doesNotMatch(text, /sensitive|dial detail/i);
  } finally {
    relay.destroySockets();
    await closeServer(relay.server);
  }
});
