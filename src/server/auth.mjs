import {
  createHash,
  createHmac,
  pbkdf2 as derivePbkdf2,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const DEFAULT_COOKIE_NAME = 'fm_bi_session';
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_MAX_RATE_LIMIT_CLIENTS = 10_000;
const DEFAULT_MAX_CONCURRENT_KDFS = 8;
const MIN_SESSION_SECRET_BYTES = 32;
const MIN_PBKDF2_ITERATIONS = 100_000;
const MAX_PBKDF2_ITERATIONS = 2_000_000;
const AUTH_ROLES = Object.freeze(new Set(['admin', 'manager', 'operator', 'viewer']));
const STORE_CODE_PATTERN = /^[A-Z0-9_-]+$/;

export class AuthConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthConfigurationError';
  }
}

export class RequestBodyError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'RequestBodyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AuthConfigurationError(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function isLoopbackHost(host = '') {
  const normalized = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function isLoopbackAddress(address = '') {
  const normalized = String(address).replace(/^::ffff:/i, '');
  return isLoopbackHost(normalized);
}

function assertPrivateFile(filePath, label) {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    throw new AuthConfigurationError(`${label} could not be read.`);
  }
  if (!stats.isFile()) throw new AuthConfigurationError(`${label} must be a regular file.`);
  if (process.platform !== 'win32') {
    // Permit owner-only files and root:<service-group> 0640, but never group write/execute
    // or any access by other users.
    const unsafeBits = stats.mode & 0o037;
    if (unsafeBits !== 0) {
      throw new AuthConfigurationError(`${label} permissions are too broad.`);
    }
  }
}

function decodeValue(value, label) {
  const source = String(value || '').trim();
  if (!source) throw new AuthConfigurationError(`${label} cannot be empty.`);

  if (source.startsWith('hex:')) return Buffer.from(source.slice(4), 'hex');
  if (source.startsWith('base64:')) return Buffer.from(source.slice(7), 'base64');
  if (source.startsWith('base64url:')) return Buffer.from(source.slice(10), 'base64url');
  if (/^[a-f\d]+$/i.test(source) && source.length % 2 === 0) return Buffer.from(source, 'hex');
  return Buffer.from(source, 'base64url');
}

function sha256Credential(expectedHash) {
  const expected = decodeValue(expectedHash, 'SHA-256 hash');
  if (expected.byteLength !== 32) {
    throw new AuthConfigurationError('SHA-256 password hashes must contain 32 bytes.');
  }

  return {
    apr1Work: false,
    fingerprint: `sha256:${expected.toString('base64url')}`,
    workFactor: 0,
    async verify(password) {
      const actual = createHash('sha256').update(password, 'utf8').digest();
      return timingSafeEqual(actual, expected);
    },
  };
}

function pbkdf2Credential({ iterations, salt, hash, digest = 'sha256' }) {
  if (iterations === undefined || iterations === null || iterations === '') {
    throw new AuthConfigurationError('PBKDF2 iterations are required.');
  }
  const parsedIterations = positiveInteger(iterations, undefined, 'PBKDF2 iterations');
  if (
    parsedIterations < MIN_PBKDF2_ITERATIONS ||
    parsedIterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new AuthConfigurationError(
      `PBKDF2 iterations must be between ${MIN_PBKDF2_ITERATIONS} and ${MAX_PBKDF2_ITERATIONS}.`,
    );
  }
  if (String(digest).toLowerCase() !== 'sha256') {
    throw new AuthConfigurationError('Only PBKDF2-SHA256 password hashes are supported.');
  }

  const saltBytes = decodeValue(salt, 'PBKDF2 salt');
  const expected = decodeValue(hash, 'PBKDF2 hash');
  if (saltBytes.byteLength < 8 || expected.byteLength < 32 || expected.byteLength > 64) {
    throw new AuthConfigurationError('PBKDF2 salt or hash length is invalid.');
  }

  return {
    apr1Work: false,
    fingerprint: [
      'pbkdf2-sha256',
      parsedIterations,
      saltBytes.toString('base64url'),
      expected.toString('base64url'),
    ].join('$'),
    workFactor: parsedIterations * Math.ceil(expected.byteLength / 32),
    verify(password) {
      return new Promise((resolve, reject) => {
        derivePbkdf2(
          password,
          saltBytes,
          parsedIterations,
          expected.byteLength,
          'sha256',
          (error, actual) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(timingSafeEqual(actual, expected));
          },
        );
      });
    },
  };
}

function md5Buffer(value) {
  return createHash('md5').update(value).digest();
}

function apacheApr1(password, salt) {
  const magic = '$apr1$';
  const passwordBytes = Buffer.from(String(password), 'utf8');
  const saltBytes = Buffer.from(salt, 'ascii');
  let context = Buffer.concat([passwordBytes, Buffer.from(magic, 'ascii'), saltBytes]);
  const alternate = md5Buffer(Buffer.concat([passwordBytes, saltBytes, passwordBytes]));

  for (let remaining = passwordBytes.length; remaining > 0; remaining -= 16) {
    context = Buffer.concat([context, alternate.subarray(0, Math.min(16, remaining))]);
  }
  for (let value = passwordBytes.length; value > 0; value >>= 1) {
    context = Buffer.concat([
      context,
      Buffer.from([value & 1 ? 0 : (passwordBytes[0] || 0)]),
    ]);
  }

  let digest = md5Buffer(context);
  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    const parts = [];
    if (iteration & 1) parts.push(passwordBytes); else parts.push(digest);
    if (iteration % 3) parts.push(saltBytes);
    if (iteration % 7) parts.push(passwordBytes);
    if (iteration & 1) parts.push(digest); else parts.push(passwordBytes);
    digest = md5Buffer(Buffer.concat(parts));
  }

  const alphabet = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  function encode64(value, length) {
    let encoded = '';
    let remaining = value;
    for (let index = 0; index < length; index += 1) {
      encoded += alphabet[remaining & 0x3f];
      remaining >>= 6;
    }
    return encoded;
  }

  const encoded =
    encode64((digest[0] << 16) | (digest[6] << 8) | digest[12], 4) +
    encode64((digest[1] << 16) | (digest[7] << 8) | digest[13], 4) +
    encode64((digest[2] << 16) | (digest[8] << 8) | digest[14], 4) +
    encode64((digest[3] << 16) | (digest[9] << 8) | digest[15], 4) +
    encode64((digest[4] << 16) | (digest[10] << 8) | digest[5], 4) +
    encode64(digest[11], 2);
  return `${magic}${salt}$${encoded}`;
}

function apacheApr1Credential(value) {
  const expectedText = String(value || '');
  const match = /^\$apr1\$([./0-9A-Za-z]{1,8})\$([./0-9A-Za-z]{22})$/.exec(expectedText);
  if (!match) {
    throw new AuthConfigurationError('htpasswdHash must be a valid Apache APR1 hash.');
  }
  const expected = Buffer.from(expectedText, 'ascii');
  const salt = match[1];
  return {
    apr1Work: true,
    fingerprint: `apr1:${expectedText}`,
    workFactor: 0,
    async verify(password) {
      const actual = Buffer.from(apacheApr1(password, salt), 'ascii');
      return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
    },
  };
}

function parsePasswordHash(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const algorithm = String(value.algorithm || value.algo || '').toLowerCase();
    if (algorithm === 'pbkdf2-sha256' || algorithm === 'pbkdf2_sha256') {
      return pbkdf2Credential(value);
    }
    if (algorithm === 'sha256') return sha256Credential(value.hash);
    throw new AuthConfigurationError('Unsupported passwordHash algorithm.');
  }

  const source = String(value || '').trim();
  const dollarParts = source.split('$');
  if (
    dollarParts.length === 4 &&
    ['pbkdf2-sha256', 'pbkdf2_sha256'].includes(dollarParts[0].toLowerCase())
  ) {
    return pbkdf2Credential({
      iterations: dollarParts[1],
      salt: dollarParts[2],
      hash: dollarParts[3],
    });
  }

  const colonParts = source.split(':');
  if (
    colonParts.length === 5 &&
    colonParts[0].toLowerCase() === 'pbkdf2' &&
    colonParts[1].toLowerCase() === 'sha256'
  ) {
    return pbkdf2Credential({
      iterations: colonParts[2],
      salt: colonParts[3],
      hash: colonParts[4],
    });
  }

  if (source.toLowerCase().startsWith('sha256$')) {
    return sha256Credential(source.slice('sha256$'.length));
  }
  if (source.toLowerCase().startsWith('sha256:')) {
    return sha256Credential(source.slice('sha256:'.length));
  }
  if (/^[a-f\d]{64}$/i.test(source)) return sha256Credential(source);

  throw new AuthConfigurationError('Unsupported passwordHash format.');
}

function parseUserAccess(record, username) {
  const roleSource = record.role === undefined || record.role === null
    ? 'viewer'
    : String(record.role).trim().toLowerCase();
  if (!AUTH_ROLES.has(roleSource)) {
    throw new AuthConfigurationError(
      `Authentication user ${username} has an unsupported role.`,
    );
  }

  const allStores = roleSource === 'admin';
  const storeCodesSource = record.storeCodes ?? record.stores ?? [];
  if (!Array.isArray(storeCodesSource)) {
    throw new AuthConfigurationError(
      `Authentication user ${username} storeCodes must be an array.`,
    );
  }
  const storeCodes = [...new Set(storeCodesSource.map((value) => String(value).trim().toUpperCase()))]
    .filter(Boolean);
  if (storeCodes.some((value) => !STORE_CODE_PATTERN.test(value))) {
    throw new AuthConfigurationError(
      `Authentication user ${username} contains an invalid store code.`,
    );
  }
  const employeeCode = record.employeeCode === undefined || record.employeeCode === null
    ? username
    : String(record.employeeCode).trim();
  if (
    !employeeCode
    || employeeCode.length > 128
    || /[\u0000-\u001f\u007f]/.test(employeeCode)
  ) {
    throw new AuthConfigurationError(
      `Authentication user ${username} has an invalid employeeCode.`,
    );
  }

  return Object.freeze({
    role: roleSource,
    allStores,
    storeCodes: Object.freeze(allStores ? [] : storeCodes.sort()),
    employeeCode,
  });
}

function parseUsers(usersFile) {
  let source;
  try {
    assertPrivateFile(usersFile, 'Authentication users file');
    source = JSON.parse(readFileSync(usersFile, 'utf8'));
  } catch (error) {
    throw new AuthConfigurationError(
      error instanceof SyntaxError
        ? 'Authentication users file is not valid JSON.'
        : 'Authentication users file could not be read.',
    );
  }

  const records = Array.isArray(source) ? source : source?.users;
  if (!Array.isArray(records) || records.length === 0) {
    throw new AuthConfigurationError('Authentication users file must contain a non-empty users array.');
  }

  const users = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object' || record.active === false) continue;
    const username = String(record.username || '').trim();
    if (!username || username.length > 128 || /[\u0000-\u001f\u007f]/.test(username)) {
      throw new AuthConfigurationError('Authentication users file contains an invalid username.');
    }
    const key = username.toLocaleLowerCase('en-US');
    if (users.has(key)) {
      throw new AuthConfigurationError('Authentication users file contains a duplicate username.');
    }

    const credentialFields = [
      record.passwordSha256 !== undefined && 'passwordSha256',
      record.passwordHash !== undefined && 'passwordHash',
      record.htpasswdHash !== undefined && 'htpasswdHash',
    ].filter(Boolean);
    if (credentialFields.length !== 1) {
      throw new AuthConfigurationError(
        'Each authentication user must have exactly one supported password hash.',
      );
    }

    let credential;
    if (credentialFields[0] === 'passwordSha256') {
      credential = sha256Credential(record.passwordSha256);
    } else if (credentialFields[0] === 'passwordHash') {
      credential = parsePasswordHash(record.passwordHash);
    } else {
      credential = apacheApr1Credential(record.htpasswdHash);
    }

    const access = parseUserAccess(record, username);
    const credentialTag = createHash('sha256')
      .update(
        `${username}\0${credential.fingerprint}\0${JSON.stringify(access)}`,
        'utf8',
      )
      .digest('base64url')
      .slice(0, 22);
    users.set(key, {
      username,
      displayName: String(record.displayName || username).slice(0, 128),
      ...access,
      credential,
      credentialTag,
    });
  }

  if (users.size === 0) {
    throw new AuthConfigurationError('Authentication users file has no active users.');
  }
  return users;
}

function parseCookies(cookieHeader = '') {
  const cookies = new Map();
  for (const part of String(cookieHeader).split(';')) {
    const equalsIndex = part.indexOf('=');
    if (equalsIndex <= 0) continue;
    const name = part.slice(0, equalsIndex).trim();
    const value = part.slice(equalsIndex + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

function safeJsonParseBase64Url(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function clientKey(request, trustProxy) {
  if (trustProxy) {
    const forwardedFor = String(request.headers['x-forwarded-for'] || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (forwardedFor.length > 0) return forwardedFor.at(-1);
  }
  return String(request.socket?.remoteAddress || 'unknown');
}

export function createAuthService(options = {}) {
  const runtimeEnvironment = String(options.runtimeEnvironment || 'development').toLowerCase();
  const host = options.host || '127.0.0.1';
  const usersFile = String(options.usersFile || '').trim();
  const configuredSessionSecret = String(options.sessionSecret || '');
  const sessionSecretFile = String(options.sessionSecretFile || '').trim();
  if (configuredSessionSecret && sessionSecretFile) {
    throw new AuthConfigurationError('Configure a session secret value or file, not both.');
  }

  let sessionSecret = configuredSessionSecret;
  if (sessionSecretFile) {
    try {
      assertPrivateFile(sessionSecretFile, 'Session secret file');
      sessionSecret = readFileSync(sessionSecretFile, 'utf8').replace(/[\r\n]+$/, '');
    } catch {
      throw new AuthConfigurationError('Session secret file could not be read.');
    }
  }
  const hasAnyAuthSetting = Boolean(usersFile || sessionSecret || sessionSecretFile);

  if (!hasAnyAuthSetting) {
    if (runtimeEnvironment === 'production' || !isLoopbackHost(host)) {
      throw new AuthConfigurationError(
        'Authentication is required in production and for non-loopback listeners.',
      );
    }
    return Object.freeze({ enabled: false });
  }

  if (!usersFile || !sessionSecret) {
    throw new AuthConfigurationError(
      'Both an authentication users file and a session secret are required.',
    );
  }
  if (Buffer.byteLength(sessionSecret, 'utf8') < MIN_SESSION_SECRET_BYTES) {
    throw new AuthConfigurationError(
      `Session secret must be at least ${MIN_SESSION_SECRET_BYTES} bytes.`,
    );
  }

  const users = parseUsers(usersFile);
  const secretBytes = Buffer.from(sessionSecret, 'utf8');
  const cookieName = String(options.cookieName || DEFAULT_COOKIE_NAME);
  if (!/^[A-Za-z0-9_-]+$/.test(cookieName)) {
    throw new AuthConfigurationError('Session cookie name is invalid.');
  }

  const sessionTtlSeconds = positiveInteger(
    options.sessionTtlSeconds,
    DEFAULT_SESSION_TTL_SECONDS,
    'Session TTL',
  );
  const rateLimitWindowMs = positiveInteger(
    options.rateLimitWindowMs,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
    'Login rate-limit window',
  );
  const rateLimitMaxAttempts = positiveInteger(
    options.rateLimitMaxAttempts,
    DEFAULT_RATE_LIMIT_MAX_ATTEMPTS,
    'Login rate-limit attempts',
  );
  const maxBodyBytes = positiveInteger(
    options.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
    'Request body limit',
  );
  const secureCookie = options.secureCookie ?? runtimeEnvironment === 'production';
  const trustProxy = options.trustProxy === true;
  if (runtimeEnvironment === 'production' && !secureCookie) {
    throw new AuthConfigurationError('Secure session cookies cannot be disabled in production.');
  }
  if (trustProxy && !isLoopbackHost(host)) {
    throw new AuthConfigurationError('Proxy headers may only be trusted on a loopback listener.');
  }
  const configuredPublicOrigin = String(options.publicOrigin || '').trim();
  let publicOrigin = '';
  if (configuredPublicOrigin) {
    try {
      const parsedOrigin = new URL(configuredPublicOrigin);
      if (parsedOrigin.origin !== configuredPublicOrigin || !['http:', 'https:'].includes(parsedOrigin.protocol)) {
        throw new Error('invalid origin');
      }
      if (runtimeEnvironment === 'production' && parsedOrigin.protocol !== 'https:') {
        throw new Error('insecure origin');
      }
      publicOrigin = parsedOrigin.origin;
    } catch {
      throw new AuthConfigurationError('Public origin must be an exact HTTP(S) origin.');
    }
  }
  const maxRateLimitClients = positiveInteger(
    options.maxRateLimitClients,
    DEFAULT_MAX_RATE_LIMIT_CLIENTS,
    'Rate-limit client capacity',
  );
  const maxConcurrentKdfs = positiveInteger(
    options.maxConcurrentKdfs,
    DEFAULT_MAX_CONCURRENT_KDFS,
    'Concurrent password-check capacity',
  );
  const attempts = new Map();
  let lastAttemptsPruneAt = 0;
  let activeKdfs = 0;
  const dummyWorkFactor = Math.max(
    MIN_PBKDF2_ITERATIONS,
    ...[...users.values()].map((user) => user.credential.workFactor),
  );
  const dummySalt = createHash('sha256')
    .update('full-managed-bi-auth-dummy-salt', 'utf8')
    .digest()
    .subarray(0, 16);

  function runDummyPbkdf2(password, iterations) {
    if (iterations <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      derivePbkdf2(password, dummySalt, iterations, 32, 'sha256', (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  function createSession(user, now = Date.now()) {
    const issuedAt = Math.floor(now / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        u: user.username,
        c: user.credentialTag,
        iat: issuedAt,
        exp: issuedAt + sessionTtlSeconds,
      }),
      'utf8',
    ).toString('base64url');
    const signature = createHmac('sha256', secretBytes).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function sessionCookie(user, now) {
    const attributes = [
      `${cookieName}=${createSession(user, now)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${sessionTtlSeconds}`,
    ];
    if (secureCookie) attributes.push('Secure');
    return attributes.join('; ');
  }

  function clearCookie() {
    const attributes = [
      `${cookieName}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
    ];
    if (secureCookie) attributes.push('Secure');
    return attributes.join('; ');
  }

  function verifySession(token, now = Date.now()) {
    const [payload, suppliedSignature, extra] = String(token || '').split('.');
    if (!payload || !suppliedSignature || extra !== undefined) return null;

    const expectedSignature = createHmac('sha256', secretBytes).update(payload).digest();
    let suppliedSignatureBytes;
    try {
      suppliedSignatureBytes = Buffer.from(suppliedSignature, 'base64url');
    } catch {
      return null;
    }
    if (suppliedSignatureBytes.toString('base64url') !== suppliedSignature) return null;
    if (
      suppliedSignatureBytes.byteLength !== expectedSignature.byteLength ||
      !timingSafeEqual(suppliedSignatureBytes, expectedSignature)
    ) {
      return null;
    }

    const session = safeJsonParseBase64Url(payload);
    const nowSeconds = Math.floor(now / 1000);
    if (
      !session ||
      session.v !== 1 ||
      typeof session.u !== 'string' ||
      typeof session.c !== 'string' ||
      !Number.isSafeInteger(session.iat) ||
      !Number.isSafeInteger(session.exp) ||
      session.iat > nowSeconds + 60 ||
      session.exp <= nowSeconds ||
      session.exp - session.iat !== sessionTtlSeconds
    ) {
      return null;
    }

    const user = users.get(session.u.toLocaleLowerCase('en-US'));
    if (!user || user.username !== session.u || user.credentialTag !== session.c) return null;
    return {
      session,
      user,
    };
  }

  function publicUser(user) {
    return {
      username: user.username,
      displayName: user.displayName,
      employeeCode: user.employeeCode,
      role: user.role,
      allStores: user.allStores,
      storeCodes: [...user.storeCodes],
    };
  }

  function verifyToken(token, now = Date.now()) {
    const verified = verifySession(token, now);
    return verified ? publicUser(verified.user) : null;
  }

  function authenticateRequest(request, now) {
    const token = parseCookies(request.headers.cookie).get(cookieName);
    return verifyToken(token, now);
  }

  function refreshCookieForRequest(request, now = Date.now()) {
    const token = parseCookies(request.headers.cookie).get(cookieName);
    const verified = verifySession(token, now);
    if (!verified) return null;

    const nowSeconds = Math.floor(now / 1000);
    const refreshAfterSeconds = Math.max(1, Math.floor(sessionTtlSeconds / 2));
    if (nowSeconds - verified.session.iat < refreshAfterSeconds) return null;
    return sessionCookie(verified.user, now);
  }

  function pruneAttempts(now) {
    if (attempts.size < maxRateLimitClients && now - lastAttemptsPruneAt < 60_000) return;
    lastAttemptsPruneAt = now;
    for (const [key, value] of attempts) {
      if (value.resetAt <= now) attempts.delete(key);
    }
  }

  function reserveRateLimit(request, now = Date.now()) {
    pruneAttempts(now);
    const key = clientKey(request, trustProxy);
    let state = attempts.get(key);
    if (!state || state.resetAt <= now) {
      if (attempts.size >= maxRateLimitClients) {
        let earliestResetAt = now + rateLimitWindowMs;
        for (const value of attempts.values()) {
          earliestResetAt = Math.min(earliestResetAt, value.resetAt);
        }
        return {
          allowed: false,
          capacityLimited: true,
          key,
          retryAfterSeconds: Math.max(1, Math.ceil((earliestResetAt - now) / 1000)),
        };
      }
      state = { count: 0, inFlight: 0, resetAt: now + rateLimitWindowMs };
      attempts.set(key, state);
    }
    if (state.count + state.inFlight < rateLimitMaxAttempts) {
      state.inFlight += 1;
      return { allowed: true, key, state, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      key,
      state,
      retryAfterSeconds: Math.max(1, Math.ceil((state.resetAt - now) / 1000)),
    };
  }

  function completeRateLimitReservation(reservation, outcome) {
    reservation.state.inFlight = Math.max(0, reservation.state.inFlight - 1);
    if (attempts.get(reservation.key) !== reservation.state) return;
    if (outcome === 'success') {
      attempts.delete(reservation.key);
    } else if (outcome === 'failure') {
      reservation.state.count += 1;
    } else if (reservation.state.count === 0 && reservation.state.inFlight === 0) {
      attempts.delete(reservation.key);
    }
  }

  async function authenticate(request, username, password, now = Date.now()) {
    const limit = reserveRateLimit(request, now);
    if (!limit.allowed) return { ok: false, rateLimited: true, ...limit };
    if (activeKdfs >= maxConcurrentKdfs) {
      completeRateLimitReservation(limit, 'release');
      return { ok: false, busy: true, retryAfterSeconds: 1 };
    }
    activeKdfs += 1;

    const normalizedUsername = String(username || '').trim().toLocaleLowerCase('en-US');
    const suppliedPassword = typeof password === 'string' ? password : '';
    const user = users.get(normalizedUsername);
    let passwordMatches = false;
    try {
      if (user && suppliedPassword.length <= maxBodyBytes) {
        passwordMatches = await user.credential.verify(suppliedPassword);
        if (!user.credential.apr1Work) apacheApr1(suppliedPassword, 'fmDummy');
        await runDummyPbkdf2(
          suppliedPassword,
          dummyWorkFactor - user.credential.workFactor,
        );
      } else {
        // Match the configured credential work to avoid exposing valid usernames by timing.
        apacheApr1(suppliedPassword, 'fmDummy');
        await runDummyPbkdf2(suppliedPassword, dummyWorkFactor);
      }
    } catch (error) {
      completeRateLimitReservation(limit, 'release');
      throw error;
    } finally {
      activeKdfs = Math.max(0, activeKdfs - 1);
    }

    if (!user || !passwordMatches) {
      completeRateLimitReservation(limit, 'failure');
      return { ok: false, rateLimited: false };
    }

    completeRateLimitReservation(limit, 'success');
    return {
      ok: true,
      user: {
        username: user.username,
        displayName: user.displayName,
        employeeCode: user.employeeCode,
        role: user.role,
        allStores: user.allStores,
        storeCodes: [...user.storeCodes],
      },
      cookie: sessionCookie(user, now),
    };
  }

  return Object.freeze({
    enabled: true,
    authenticate,
    authenticateRequest,
    clearCookie,
    cookieName,
    maxBodyBytes,
    publicOrigin,
    refreshCookieForRequest,
    sessionCookie,
    trustProxy,
    verifyToken,
  });
}

export function isSameOriginPost(request, options = {}) {
  const origin = String(request.headers.origin || '').trim();
  const host = String(request.headers.host || '').trim();
  if (!origin || origin === 'null' || !host) return false;

  if (options.publicOrigin) {
    try {
      return new URL(origin).origin === options.publicOrigin;
    } catch {
      return false;
    }
  }

  const canTrustProxy = options.trustProxy === true && isLoopbackAddress(request.socket?.remoteAddress);
  const forwardedProto = canTrustProxy
    ? String(request.headers['x-forwarded-proto'] || '').split(',', 1)[0].trim().toLowerCase()
    : '';
  const protocol = forwardedProto === 'https' || request.socket?.encrypted ? 'https' : 'http';
  try {
    return new URL(origin).origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

export function readRequestBody(request, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    request.resume();
    throw new RequestBodyError('BODY_TOO_LARGE', '请求内容过大', 413);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let settled = false;

    function cleanup() {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      request.resume();
      reject(error);
    }

    function onData(chunk) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        fail(new RequestBodyError('BODY_TOO_LARGE', '请求内容过大', 413));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }

    function onError() {
      fail(new RequestBodyError('INVALID_BODY', '无法读取请求内容', 400));
    }

    function onAborted() {
      fail(new RequestBodyError('INVALID_BODY', '请求内容不完整', 400));
    }

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onAborted);
  });
}

export async function parseLoginBody(request, maxBytes) {
  const body = await readRequestBody(request, maxBytes);
  const contentType = String(request.headers['content-type'] || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();

  if (contentType === 'application/json') {
    try {
      const value = JSON.parse(body);
      return { username: value?.username, password: value?.password, json: true };
    } catch {
      throw new RequestBodyError('INVALID_JSON', '请求内容不是有效 JSON', 400);
    }
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(body);
    return { username: form.get('username'), password: form.get('password'), json: false };
  }
  throw new RequestBodyError('UNSUPPORTED_MEDIA_TYPE', '不支持的请求格式', 415);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function loginPage({ error = '', nonce = randomBytes(18).toString('base64url') } = {}) {
  const errorMarkup = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : '<p class="hint">请使用已配置的内部账号继续。</p>';
  return {
    nonce,
    html: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登录 · SHEIN 全托运营驾驶舱</title>
  <style nonce="${nonce}">
    :root{color-scheme:light;--ink:#1d1e1b;--muted:#686a64;--line:#d9dad3;--paper:#fdfdfb;--accent:#b64b32;--side:#171814}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f2ef;color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
    main{width:min(92vw,420px);background:var(--paper);border:1px solid var(--line);box-shadow:0 24px 70px #17181418;padding:36px} .mark{display:inline-grid;place-items:center;width:48px;height:48px;background:var(--side);color:white;font-weight:800;letter-spacing:.06em}
    h1{font-size:1.55rem;margin:22px 0 6px}.subtitle,.hint{color:var(--muted)}.subtitle{margin:0 0 28px}.hint,.error{font-size:.9rem;margin:0 0 18px}.error{color:#9c2f1d}
    label{display:block;font-size:.84rem;font-weight:700;margin:14px 0 6px}input{width:100%;border:1px solid #c8c9c2;background:white;color:var(--ink);font:inherit;padding:11px 12px;outline:none}input:focus{border-color:#275eea;box-shadow:0 0 0 3px #275eea1f}
    button{width:100%;border:0;background:var(--accent);color:white;font:700 .95rem/1 system-ui;padding:14px 16px;margin-top:24px;cursor:pointer}button:hover{background:#963b29}footer{margin-top:22px;color:var(--muted);font-size:.78rem}
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">FM</div>
    <h1>全托运营驾驶舱</h1>
    <p class="subtitle">内部系统 · 访问需要身份验证</p>
    ${errorMarkup}
    <form method="post" action="/api/login">
      <label for="username">账号</label>
      <input id="username" name="username" type="text" autocomplete="username" maxlength="128" required autofocus>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">登录</button>
    </form>
    <footer>fm.dushengyi.cc</footer>
  </main>
</body>
</html>`,
  };
}
