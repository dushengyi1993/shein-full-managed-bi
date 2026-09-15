#!/usr/bin/env node
import {
  createSheinOpenApiConnectRelay,
  SHEIN_OPENAPI_CONNECT_AUTHORITIES,
} from '../src/openapi/connect-relay.mjs';

const LISTEN_HOST = '127.0.0.1';
const DEFAULT_LISTEN_PORT = 18_080;

function parseAuthorities(value) {
  if (value === undefined || value === '') return SHEIN_OPENAPI_CONNECT_AUTHORITIES;
  const entries = String(value).split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (entries.length === 0) throw new TypeError('relay authorities must not be empty');
  for (const entry of entries) {
    if (!/^[a-z0-9.-]+:\d{1,5}$/i.test(entry)) {
      throw new TypeError('relay authority must be a host:port pair');
    }
  }
  return [...new Set(entries.map((entry) => entry.toLowerCase()))];
}

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_LISTEN_PORT;
  if (!/^\d+$/.test(value)) throw new TypeError('relay port must be an integer');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('relay port must be an integer from 1 to 65535');
  }
  return port;
}

const listenPort = parsePort(process.env.SHEIN_FM_OPENAPI_RELAY_PORT);
const allowedAuthorities = parseAuthorities(process.env.SHEIN_FM_OPENAPI_RELAY_AUTHORITIES);
const relay = createSheinOpenApiConnectRelay({ allowedAuthorities });
const { server } = relay;
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceTimer = setTimeout(() => {
    relay.destroySockets();
    process.exitCode = 1;
  }, 5_000);
  forceTimer.unref();
  server.close(() => {
    clearTimeout(forceTimer);
    process.stdout.write(JSON.stringify({ ok: true, event: 'stopped', signal }) + '\n');
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.once('error', (error) => {
  process.stderr.write(JSON.stringify({
    ok: false,
    errorCode: 'OPENAPI_RELAY_LISTEN_FAILED',
    code: typeof error?.code === 'string' ? error.code : null,
  }) + '\n');
  process.exitCode = 1;
});

server.listen(listenPort, LISTEN_HOST, () => {
  process.stdout.write(JSON.stringify({
    ok: true,
    event: 'listening',
    host: LISTEN_HOST,
    port: listenPort,
    authority: relay.allowedAuthorities[0],
    authorities: relay.allowedAuthorities,
  }) + '\n');
});
