import { FileAuthorizationStore } from './file-store.mjs';
import { createAuthorizationServer } from './server.mjs';
import { createFullManagedAuthorizationService } from './service.mjs';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new TypeError(`${name} is required.`);
  return value;
}

function positiveInteger(name, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function optionalBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true'].includes(String(raw).toLowerCase())) return true;
  if (['0', 'false'].includes(String(raw).toLowerCase())) return false;
  throw new TypeError(`${name} must be true/false or 1/0.`);
}

const host = process.env.FULL_AUTH_HOST || '127.0.0.1';
const port = positiveInteger('FULL_AUTH_PORT', 8789, { minimum: 1, maximum: 65_535 });
const publicOrigin = required('FULL_AUTH_PUBLIC_ORIGIN');
const store = new FileAuthorizationStore({
  file: required('FULL_AUTH_STATE_FILE'),
});
const authorizationService = createFullManagedAuthorizationService({
  store,
  applicationFile: required('FULL_AUTH_APPLICATION_FILE'),
  receiptDirectory: required('FULL_AUTH_RECEIPT_DIRECTORY'),
  publicOrigin,
  ownerStoreCode: process.env.FULL_AUTH_APPLICATION_STORE || 'DL',
  stateTtlSeconds: positiveInteger('FULL_AUTH_STATE_TTL_SECONDS', 600, {
    minimum: 60,
    maximum: 600,
  }),
  maximumStoreAttempts: positiveInteger('FULL_AUTH_MAX_STORE_ATTEMPTS', 6, {
    minimum: 1,
    maximum: 20,
  }),
  secureCookie: optionalBoolean(
    'FULL_AUTH_COOKIE_SECURE',
    new URL(publicOrigin).protocol === 'https:',
  ),
});
const server = createAuthorizationServer({ authorizationService });

server.requestTimeout = positiveInteger('FULL_AUTH_REQUEST_TIMEOUT_MS', 30_000, {
  minimum: 1_000,
  maximum: 120_000,
});
server.headersTimeout = Math.min(
  positiveInteger('FULL_AUTH_HEADERS_TIMEOUT_MS', 10_000, {
    minimum: 1_000,
    maximum: 60_000,
  }),
  server.requestTimeout,
);
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 80;

server.listen(port, host, () => {
  console.log(`Full-managed authorization broker is listening on http://${host}:${port}`);
});

function shutdown(signal) {
  server.close((error) => {
    if (error) {
      console.error(`Authorization broker failed to stop after ${signal}.`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
