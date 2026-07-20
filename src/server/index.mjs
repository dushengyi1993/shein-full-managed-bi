import { createDashboardServer } from './app.mjs';

const host = process.env.FULL_BI_HOST || '127.0.0.1';
const parsedPort = Number.parseInt(process.env.FULL_BI_PORT || '3100', 10);
const runtimeEnvironment = process.env.NODE_ENV || 'development';

if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
  throw new RangeError('FULL_BI_PORT must be an integer between 0 and 65535.');
}

function optionalPositiveInteger(name) {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function optionalBoolean(name) {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new TypeError(`${name} must be true/false or 1/0.`);
}

const server = createDashboardServer({
  dataFile: process.env.FULL_BI_DATA_FILE,
  host,
  runtimeEnvironment,
  auth: {
    usersFile: process.env.FULL_BI_AUTH_USERS_FILE || process.env.FULL_BI_AUTH_FILE,
    sessionSecret: process.env.FULL_BI_SESSION_SECRET,
    sessionSecretFile: process.env.FULL_BI_SESSION_SECRET_FILE,
    sessionTtlSeconds: optionalPositiveInteger('FULL_BI_SESSION_TTL_SECONDS'),
    rateLimitMaxAttempts: optionalPositiveInteger('FULL_BI_AUTH_MAX_ATTEMPTS'),
    rateLimitWindowMs: optionalPositiveInteger('FULL_BI_AUTH_WINDOW_MS'),
    maxBodyBytes: optionalPositiveInteger('FULL_BI_AUTH_MAX_BODY_BYTES'),
    maxRateLimitClients: optionalPositiveInteger('FULL_BI_AUTH_MAX_CLIENTS'),
    maxConcurrentKdfs: optionalPositiveInteger('FULL_BI_AUTH_MAX_CONCURRENT_KDFS'),
    secureCookie: optionalBoolean('FULL_BI_COOKIE_SECURE'),
    trustProxy: optionalBoolean('FULL_BI_TRUST_PROXY'),
    publicOrigin: process.env.FULL_BI_PUBLIC_ORIGIN,
  },
});

server.requestTimeout = optionalPositiveInteger('FULL_BI_REQUEST_TIMEOUT_MS') || 15_000;
server.headersTimeout = Math.min(
  optionalPositiveInteger('FULL_BI_HEADERS_TIMEOUT_MS') || 10_000,
  server.requestTimeout,
);
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

server.listen(parsedPort, host, () => {
  const address = server.address();
  const activePort = typeof address === 'object' && address ? address.port : parsedPort;
  console.log(`Full-managed BI is available at http://${host}:${activePort}`);
});

function shutdown(signal) {
  server.close((error) => {
    if (error) {
      console.error(`Failed to stop after ${signal}:`, error);
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
