import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { normalizeFullManagedStoreCode } from '../config/full-managed-stores.mjs';
import { HOME_WEBAPI_ORIGIN } from '../webapi-history/home-contracts.mjs';

export const WEBAPI_SESSION_FORMAT_VERSION = 1;
export const DEFAULT_WEBAPI_SESSION_DIRECTORY = '/srv/shein-fm/runtime/webapi-sessions';
export const DEFAULT_WEBAPI_SESSION_KEY_CREDENTIAL = 'webapi_session_key';

const SESSION_ALGORITHM = 'aes-256-gcm';
const SESSION_AAD_PREFIX = 'shein-fm:webapi-session:v1:';
const MAX_COOKIE_COUNT = 512;
const MAX_COOKIE_VALUE_BYTES = 16 * 1024;

export class EncryptedWebApiSessionError extends Error {
  constructor(code) {
    super(`encrypted WebAPI session refused: ${code}`);
    this.name = 'EncryptedWebApiSessionError';
    this.code = code;
  }
}

function fail(code) {
  throw new EncryptedWebApiSessionError(code);
}

function canonicalStoreCode(value) {
  const canonical = normalizeFullManagedStoreCode(String(value ?? '').trim().toUpperCase());
  if (!canonical) fail('WEBAPI_SESSION_STORE_NOT_ALLOWED');
  return canonical;
}

function isoTimestamp(value, code) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) fail(code);
  return date.toISOString();
}

function allowedCookieDomain(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/^\./, '');
  return normalized === 'geiwohuo.com' || normalized.endsWith('.geiwohuo.com');
}

function normalizedCookie(input, index) {
  const name = String(input?.name ?? '');
  const value = String(input?.value ?? '');
  const domain = String(input?.domain ?? '').trim().toLowerCase();
  const cookiePath = String(input?.path ?? '/');
  if (
    !name
    || name.length > 256
    || /[\u0000-\u0020\u007f()<>@,;:\\"/\[\]?={}]/.test(name)
  ) fail('WEBAPI_SESSION_COOKIE_INVALID');
  if (Buffer.byteLength(value, 'utf8') > MAX_COOKIE_VALUE_BYTES) {
    fail('WEBAPI_SESSION_COOKIE_INVALID');
  }
  if (!allowedCookieDomain(domain) || !cookiePath.startsWith('/')) {
    fail('WEBAPI_SESSION_COOKIE_SCOPE_INVALID');
  }
  let expires = null;
  if (input?.expires !== null && input?.expires !== undefined && Number(input.expires) > 0) {
    expires = Number(input.expires);
    if (!Number.isFinite(expires)) fail('WEBAPI_SESSION_COOKIE_INVALID');
  }
  const sameSite = ['Strict', 'Lax', 'None'].includes(input?.sameSite)
    ? input.sameSite
    : null;
  return Object.freeze({
    name,
    value,
    domain,
    path: cookiePath,
    expires,
    httpOnly: input?.httpOnly === true,
    secure: input?.secure !== false,
    sameSite,
    hostOnly: input?.hostOnly === true || !domain.startsWith('.'),
    order: Number.isSafeInteger(input?.order) ? input.order : index,
  });
}

export function normalizeWebApiSessionBundle(input, expectedStoreCode = null) {
  const storeCode = canonicalStoreCode(input?.storeCode ?? expectedStoreCode);
  if (expectedStoreCode && storeCode !== canonicalStoreCode(expectedStoreCode)) {
    fail('WEBAPI_SESSION_STORE_MISMATCH');
  }
  if (String(input?.origin ?? '') !== HOME_WEBAPI_ORIGIN) {
    fail('WEBAPI_SESSION_ORIGIN_INVALID');
  }
  const userAgent = String(input?.userAgent ?? '').trim();
  if (!userAgent || userAgent.length > 1024 || /[\r\n]/.test(userAgent)) {
    fail('WEBAPI_SESSION_USER_AGENT_INVALID');
  }
  if (!Array.isArray(input?.cookies) || input.cookies.length > MAX_COOKIE_COUNT) {
    fail('WEBAPI_SESSION_COOKIE_SET_INVALID');
  }
  const cookies = input.cookies.map(normalizedCookie);
  if (cookies.length === 0) fail('WEBAPI_SESSION_COOKIE_SET_EMPTY');
  const createdAt = isoTimestamp(input?.createdAt, 'WEBAPI_SESSION_CREATED_AT_INVALID');
  const updatedAt = isoTimestamp(input?.updatedAt, 'WEBAPI_SESSION_UPDATED_AT_INVALID');
  const identityProvenAt = isoTimestamp(
    input?.identityProvenAt,
    'WEBAPI_SESSION_IDENTITY_PROOF_INVALID',
  );
  return Object.freeze({
    version: WEBAPI_SESSION_FORMAT_VERSION,
    storeCode,
    origin: HOME_WEBAPI_ORIGIN,
    userAgent,
    createdAt,
    updatedAt,
    identityProvenAt,
    lastVerifiedAt: input?.lastVerifiedAt
      ? isoTimestamp(input.lastVerifiedAt, 'WEBAPI_SESSION_LAST_VERIFIED_INVALID')
      : null,
    cookies: Object.freeze(cookies),
  });
}

export function decodeWebApiSessionKey(value) {
  const text = String(value ?? '').trim();
  let key = null;
  if (/^[a-f0-9]{64}$/i.test(text)) key = Buffer.from(text, 'hex');
  else {
    try {
      const decoded = Buffer.from(text, 'base64');
      if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === text.replace(/=+$/, '')) {
        key = decoded;
      }
    } catch {
      key = null;
    }
  }
  if (!key || key.length !== 32) fail('WEBAPI_SESSION_KEY_INVALID');
  return key;
}

export function resolveWebApiSessionKeyFile({ env = process.env } = {}) {
  if (env.FULL_FM_WEBAPI_SESSION_KEY_FILE) {
    return String(env.FULL_FM_WEBAPI_SESSION_KEY_FILE);
  }
  if (env.CREDENTIALS_DIRECTORY) {
    return path.join(String(env.CREDENTIALS_DIRECTORY), DEFAULT_WEBAPI_SESSION_KEY_CREDENTIAL);
  }
  fail('WEBAPI_SESSION_KEY_FILE_MISSING');
}

export async function loadWebApiSessionKey({ keyFile, reader = fs.readFile } = {}) {
  const resolved = keyFile || resolveWebApiSessionKeyFile();
  let encoded;
  try {
    encoded = await reader(resolved, 'utf8');
  } catch {
    fail('WEBAPI_SESSION_KEY_READ_FAILED');
  }
  return decodeWebApiSessionKey(encoded);
}

function sessionFileName(storeCode) {
  return `${canonicalStoreCode(storeCode)}.session.enc.json`;
}

function aadFor(storeCode) {
  return Buffer.from(`${SESSION_AAD_PREFIX}${canonicalStoreCode(storeCode)}`, 'utf8');
}

function encryptBundle(bundle, key, randomBytes = crypto.randomBytes) {
  const iv = randomBytes(12);
  const cipher = crypto.createCipheriv(SESSION_ALGORITHM, key, iv);
  cipher.setAAD(aadFor(bundle.storeCode));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(bundle), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Object.freeze({
    version: WEBAPI_SESSION_FORMAT_VERSION,
    algorithm: 'A256GCM',
    storeCode: bundle.storeCode,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

function decryptEnvelope(envelope, key, expectedStoreCode) {
  const storeCode = canonicalStoreCode(envelope?.storeCode);
  if (storeCode !== canonicalStoreCode(expectedStoreCode)) {
    fail('WEBAPI_SESSION_STORE_MISMATCH');
  }
  if (envelope?.version !== WEBAPI_SESSION_FORMAT_VERSION || envelope?.algorithm !== 'A256GCM') {
    fail('WEBAPI_SESSION_ENVELOPE_INVALID');
  }
  try {
    const iv = Buffer.from(String(envelope.iv ?? ''), 'base64');
    const tag = Buffer.from(String(envelope.tag ?? ''), 'base64');
    const ciphertext = Buffer.from(String(envelope.ciphertext ?? ''), 'base64');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      fail('WEBAPI_SESSION_ENVELOPE_INVALID');
    }
    const decipher = crypto.createDecipheriv(SESSION_ALGORITHM, key, iv);
    decipher.setAAD(aadFor(storeCode));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return normalizeWebApiSessionBundle(JSON.parse(plaintext.toString('utf8')), storeCode);
  } catch (error) {
    if (error instanceof EncryptedWebApiSessionError) throw error;
    fail('WEBAPI_SESSION_DECRYPT_FAILED');
  }
}

export function createEncryptedWebApiSessionStore({
  directory = DEFAULT_WEBAPI_SESSION_DIRECTORY,
  key,
  fileSystem = fs,
  randomBytes = crypto.randomBytes,
} = {}) {
  const encryptionKey = Buffer.isBuffer(key) ? Buffer.from(key) : decodeWebApiSessionKey(key);
  if (encryptionKey.length !== 32) fail('WEBAPI_SESSION_KEY_INVALID');
  const root = path.resolve(String(directory));

  async function read(storeCode) {
    const canonical = canonicalStoreCode(storeCode);
    let envelope;
    try {
      envelope = JSON.parse(await fileSystem.readFile(path.join(root, sessionFileName(canonical)), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') fail('WEBAPI_SESSION_NOT_FOUND');
      if (error instanceof EncryptedWebApiSessionError) throw error;
      fail('WEBAPI_SESSION_READ_FAILED');
    }
    return decryptEnvelope(envelope, encryptionKey, canonical);
  }

  async function write(storeCode, input) {
    const canonical = canonicalStoreCode(storeCode);
    const bundle = normalizeWebApiSessionBundle(input, canonical);
    const envelope = encryptBundle(bundle, encryptionKey, randomBytes);
    await fileSystem.mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      root,
      `.${sessionFileName(canonical)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    const destination = path.join(root, sessionFileName(canonical));
    try {
      await fileSystem.writeFile(temporary, `${JSON.stringify(envelope)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await fileSystem.chmod?.(temporary, 0o600);
      await fileSystem.rename(temporary, destination);
    } catch {
      if (typeof fileSystem.rm === 'function') {
        await fileSystem.rm(temporary, { force: true }).catch(() => {});
      }
      fail('WEBAPI_SESSION_WRITE_FAILED');
    }
    return Object.freeze({
      storeCode: canonical,
      updatedAt: bundle.updatedAt,
      identityProvenAt: bundle.identityProvenAt,
    });
  }

  async function has(storeCode) {
    try {
      await fileSystem.access(path.join(root, sessionFileName(storeCode)));
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({ root, read, write, has });
}

/**
 * Hold one exported candidate only in process memory while browser/HTTP parity
 * is proved. Callers may promote `snapshot()` into the encrypted persistent
 * store only after every gate succeeds. This prevents a failed dual-read from
 * replacing the last known-good session on disk.
 */
export function createEphemeralWebApiSessionStore(input, expectedStoreCode) {
  let bundle = normalizeWebApiSessionBundle(input, expectedStoreCode);
  return Object.freeze({
    async read(storeCode) {
      return normalizeWebApiSessionBundle(bundle, storeCode);
    },
    async write(storeCode, next) {
      bundle = normalizeWebApiSessionBundle(next, storeCode);
      return Object.freeze({ storeCode: bundle.storeCode, updatedAt: bundle.updatedAt });
    },
    snapshot() {
      return normalizeWebApiSessionBundle(bundle, expectedStoreCode);
    },
  });
}

export async function createEncryptedWebApiSessionStoreFromEnvironment({
  directory = process.env.FULL_FM_WEBAPI_SESSION_DIRECTORY
    || DEFAULT_WEBAPI_SESSION_DIRECTORY,
  keyFile,
  fileSystem = fs,
} = {}) {
  const key = await loadWebApiSessionKey({
    keyFile: keyFile || resolveWebApiSessionKeyFile(),
    reader: fileSystem.readFile.bind(fileSystem),
  });
  return createEncryptedWebApiSessionStore({ directory, key, fileSystem });
}
