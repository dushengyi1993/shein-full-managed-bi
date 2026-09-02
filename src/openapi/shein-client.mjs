import crypto from 'node:crypto';

import {
  resolveOpenApiProxyConfig,
  selectOpenApiTransport,
} from './proxy-transport.mjs';

export const FULL_MANAGED_OPENAPI_BASE_URL = 'https://openapi.sheincorp.com';
export const FULL_MANAGED_AUTHORIZATION_HOST = 'openapi-sem.sheincorp.com';
export const CONTENT_TYPE = 'application/json;charset=UTF-8';
export const DEFAULT_AES_IV_SEED = 'space-station-default-iv';

const REAL_HOST_SUFFIXES = Object.freeze([
  '.sheincorp.com',
  '.sheincorp.cn',
  '.dotfashion.cn',
]);
const RANDOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export class SheinOpenApiError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'SheinOpenApiError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}, options = {}) {
  throw new SheinOpenApiError(code, message, details, options);
}

export function normalizeApiPath(value) {
  if (typeof value !== 'string' || value.trim() === '') fail('INVALID_PATH', 'API path is required');
  const normalized = value.trim();
  if (/^https?:\/\//i.test(normalized)) return new URL(normalized).pathname;
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function isRealSheinBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return REAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

export function isExplicitFakeBaseUrl(baseUrl) {
  try {
    const { hostname, protocol } = new URL(baseUrl);
    const host = hostname.toLowerCase();
    return ['http:', 'https:'].includes(protocol) && (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.test') ||
      host.endsWith('.invalid') ||
      host.endsWith('.example')
    );
  } catch {
    return false;
  }
}

export function assertOpenApiRuntimeAllowed(
  baseUrl,
  {
    platform = process.platform,
    allowFakeBaseUrl = false,
    cloudExecution = process.env.SHEIN_FM_CLOUD_EXECUTION,
  } = {},
) {
  if (isRealSheinBaseUrl(baseUrl)) {
    if (String(platform).toLowerCase() === 'win32') {
      fail(
        'REAL_OPENAPI_BLOCKED_ON_WINDOWS',
        'Real SHEIN OpenAPI calls are restricted to the non-Windows cloud runtime.',
      );
    }
    if (String(cloudExecution) !== '1') {
      fail(
        'REAL_OPENAPI_CLOUD_ATTESTATION_REQUIRED',
        'Real SHEIN OpenAPI calls require explicit full-managed cloud execution attestation.',
      );
    }
    return;
  }
  if (allowFakeBaseUrl && isExplicitFakeBaseUrl(baseUrl)) return;
  fail(
    'UNTRUSTED_BASE_URL',
    'A non-SHEIN base URL must be an explicit local/test fake and allowFakeBaseUrl must be true.',
  );
}

export function createRandomKey(length = 5) {
  const bytes = crypto.randomBytes(length);
  let output = '';
  for (const byte of bytes) output += RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length];
  return output;
}

export function generateSheinSignature({ openKeyId, secretKey, path, timestamp, randomKey } = {}) {
  if (typeof openKeyId !== 'string' || openKeyId === '') fail('MISSING_CREDENTIAL', 'openKeyId is required');
  if (typeof secretKey !== 'string' || secretKey === '') fail('MISSING_CREDENTIAL', 'secretKey is required');
  const apiPath = normalizeApiPath(path);
  const normalizedTimestamp = String(timestamp ?? Date.now());
  if (!/^\d{13}$/.test(normalizedTimestamp)) {
    fail('INVALID_TIMESTAMP', 'timestamp must be a 13-digit millisecond value');
  }
  const normalizedRandomKey = String(randomKey ?? createRandomKey());
  if (!/^[A-Za-z0-9]{5}$/.test(normalizedRandomKey)) {
    fail('INVALID_RANDOM_KEY', 'randomKey must contain exactly five ASCII letters or digits');
  }
  const value = `${openKeyId}&${normalizedTimestamp}&${apiPath}`;
  const hmacHex = crypto
    .createHmac('sha256', Buffer.from(`${secretKey}${normalizedRandomKey}`, 'utf8'))
    .update(value, 'utf8')
    .digest('hex');
  return {
    path: apiPath,
    timestamp: normalizedTimestamp,
    signature: `${normalizedRandomKey}${Buffer.from(hmacHex, 'utf8').toString('base64')}`,
  };
}

export function buildAuthorizationUrl({
  appId,
  redirectUrl,
  state,
  authorizationHost = FULL_MANAGED_AUTHORIZATION_HOST,
} = {}) {
  if (typeof appId !== 'string' || appId.trim() === '') {
    fail('MISSING_CREDENTIAL', 'appId is required');
  }
  let redirect;
  try {
    redirect = new URL(String(redirectUrl));
  } catch {
    fail('INVALID_REDIRECT_URL', 'redirectUrl must be an absolute URL');
  }
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.hash) {
    fail('INVALID_REDIRECT_URL', 'redirectUrl must be a credential-free HTTPS URL');
  }
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    fail('INVALID_AUTHORIZATION_STATE', 'state must be a 32-byte base64url value');
  }
  const host = String(authorizationHost || '').trim().toLowerCase();
  if (
    !host ||
    host.includes('/') ||
    !REAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    fail('INVALID_AUTHORIZATION_HOST', 'authorizationHost must be a trusted SHEIN host');
  }
  const query = new URLSearchParams({
    appid: appId.trim(),
    redirectUrl: Buffer.from(redirect.toString(), 'utf8').toString('base64'),
    state,
  });
  return `https://${host}/#/empower?${query.toString()}`;
}

function aesKeyFromAppSecret(appSecretKey) {
  const key = Buffer.alloc(16);
  Buffer.from(String(appSecretKey), 'utf8').copy(key, 0, 0, 16);
  return key;
}

function aesIvFromSeed(ivSeed = DEFAULT_AES_IV_SEED) {
  const bytes = Buffer.from(String(ivSeed), 'utf8');
  if (bytes.byteLength < 16) fail('INVALID_AES_IV', 'ivSeed must be at least 16 bytes');
  return bytes.subarray(0, 16);
}

export function decryptSheinSecretKey(
  encryptedSecretKey,
  appSecretKey,
  { ivSeed = DEFAULT_AES_IV_SEED } = {},
) {
  if (typeof encryptedSecretKey !== 'string' || encryptedSecretKey === '') {
    fail('INVALID_ENCRYPTED_SECRET', 'encryptedSecretKey is required');
  }
  if (typeof appSecretKey !== 'string' || appSecretKey === '') {
    fail('MISSING_CREDENTIAL', 'appSecretKey is required');
  }
  try {
    const decipher = crypto.createDecipheriv(
      'aes-128-cbc',
      aesKeyFromAppSecret(appSecretKey),
      aesIvFromSeed(ivSeed),
    );
    decipher.setAutoPadding(true);
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedSecretKey, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    fail(
      'SECRET_DECRYPTION_FAILED',
      'SHEIN store secret could not be decrypted',
      {},
      { cause: error },
    );
  }
}

export function encryptSheinSecretKeyForTest(
  plainSecretKey,
  appSecretKey,
  { ivSeed = DEFAULT_AES_IV_SEED } = {},
) {
  const cipher = crypto.createCipheriv(
    'aes-128-cbc',
    aesKeyFromAppSecret(appSecretKey),
    aesIvFromSeed(ivSeed),
  );
  cipher.setAutoPadding(true);
  return Buffer.concat([
    cipher.update(String(plainSecretKey), 'utf8'),
    cipher.final(),
  ]).toString('base64');
}

function appendQuery(baseUrl, path, query) {
  const url = new URL(path, `${baseUrl.replace(/\/+$/, '')}/`);
  for (const [key, rawValue] of Object.entries(query ?? {})) {
    if (rawValue === undefined || rawValue === null) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) url.searchParams.append(key, String(value));
  }
  return url.toString();
}

function parseBody(text, path) {
  if (!text) fail('EMPTY_RESPONSE', `SHEIN OpenAPI returned an empty response for ${path}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail('INVALID_JSON_RESPONSE', `SHEIN OpenAPI returned invalid JSON for ${path}`, {}, { cause: error });
  }
}

export function assertSuccessfulOpenApiResponse(response, path = 'OpenAPI') {
  if (!response || response.ok !== true || !Number.isInteger(response.status)) {
    fail('HTTP_ERROR', `${path} failed at the HTTP layer`, {
      httpStatus: response?.status ?? null,
    });
  }
  const data = response.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail('INVALID_RESPONSE_SHAPE', `${path} returned a non-object response`);
  }
  if (String(data.code) !== '0') {
    fail('PLATFORM_ERROR', `${path} returned platform error ${String(data.code)}`, {
      httpStatus: response.status,
      platformCode: data.code === undefined ? null : String(data.code),
      platformMessage: typeof data.msg === 'string' ? data.msg.slice(0, 240) : null,
      traceId: typeof data.traceId === 'string' ? data.traceId.slice(0, 128) : null,
    });
  }
  return data;
}

export class SheinOpenApiClient {
  constructor({
    baseUrl = FULL_MANAGED_OPENAPI_BASE_URL,
    openKeyId,
    secretKey,
    timeoutMs = 20_000,
    allowFakeBaseUrl = false,
    fetchImpl = globalThis.fetch,
    platform = process.platform,
    cloudExecution = process.env.SHEIN_FM_CLOUD_EXECUTION,
    proxyUrl = process.env.SHEIN_FM_OPENAPI_PROXY_URL,
    proxyRequired = process.env.SHEIN_FM_OPENAPI_PROXY_REQUIRED,
  } = {}) {
    if (typeof fetchImpl !== 'function') fail('MISSING_FETCH', 'fetch implementation is required');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.openKeyId = openKeyId;
    this.secretKey = secretKey;
    this.timeoutMs = Number(timeoutMs);
    this.allowFakeBaseUrl = allowFakeBaseUrl;
    const proxyConfig = resolveOpenApiProxyConfig(proxyUrl);
    const transport = selectOpenApiTransport({
      baseUrl: this.baseUrl,
      proxyConfig,
      proxyRequired,
      fetchImpl,
    });
    this.fetchImpl = transport.fetchImpl;
    this.dispatcher = transport.dispatcher;
    this.platform = platform;
    this.cloudExecution = cloudExecution;
  }

  async request(path, { method = 'POST', query, body, timestamp, randomKey } = {}) {
    assertOpenApiRuntimeAllowed(this.baseUrl, {
      platform: this.platform,
      allowFakeBaseUrl: this.allowFakeBaseUrl,
      cloudExecution: this.cloudExecution,
    });
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      fail('INVALID_TIMEOUT', 'timeoutMs must be a positive number');
    }
    const signed = generateSheinSignature({
      openKeyId: this.openKeyId,
      secretKey: this.secretKey,
      path,
      timestamp,
      randomKey,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const upperMethod = String(method).toUpperCase();
    const init = {
      method: upperMethod,
      signal: controller.signal,
      headers: {
        'Content-Type': CONTENT_TYPE,
        'x-lt-openKeyId': String(this.openKeyId),
        'x-lt-timestamp': signed.timestamp,
        'x-lt-signature': signed.signature,
      },
    };
    if (body !== undefined && upperMethod !== 'GET') init.body = JSON.stringify(body);
    if (this.dispatcher) init.dispatcher = this.dispatcher;

    let response;
    let text;
    try {
      response = await this.fetchImpl(appendQuery(this.baseUrl, signed.path, query), init);
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        fail(
          'REQUEST_TIMEOUT',
          `SHEIN OpenAPI request timed out after ${this.timeoutMs}ms: ${signed.path}`,
          { path: signed.path, timeoutMs: this.timeoutMs },
          { cause: error },
        );
      }
      fail('NETWORK_ERROR', `SHEIN OpenAPI network request failed: ${signed.path}`, {
        path: signed.path,
      }, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    const responseMeta = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
    };
    if (responseMeta.ok !== true || !Number.isInteger(responseMeta.status)) {
      assertSuccessfulOpenApiResponse(responseMeta, signed.path);
    }
    const result = {
      ...responseMeta,
      data: parseBody(text, signed.path),
    };
    assertSuccessfulOpenApiResponse(result, signed.path);
    return result;
  }

  async getByToken({
    appId,
    appSecretKey,
    tempToken,
    timestamp,
    randomKey,
  } = {}) {
    assertOpenApiRuntimeAllowed(this.baseUrl, {
      platform: this.platform,
      allowFakeBaseUrl: this.allowFakeBaseUrl,
      cloudExecution: this.cloudExecution,
    });
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      fail('INVALID_TIMEOUT', 'timeoutMs must be a positive number');
    }
    if (typeof appId !== 'string' || appId === '') fail('MISSING_CREDENTIAL', 'appId is required');
    if (typeof appSecretKey !== 'string' || appSecretKey === '') {
      fail('MISSING_CREDENTIAL', 'appSecretKey is required');
    }
    if (typeof tempToken !== 'string' || !/^[A-Za-z0-9._~-]{8,1024}$/.test(tempToken)) {
      fail('INVALID_TEMP_TOKEN', 'tempToken has an invalid format');
    }
    const path = '/open-api/auth/get-by-token';
    const signed = generateSheinSignature({
      openKeyId: appId,
      secretKey: appSecretKey,
      path,
      timestamp,
      randomKey,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const init = {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': CONTENT_TYPE,
        'x-lt-appid': appId,
        'x-lt-timestamp': signed.timestamp,
        'x-lt-signature': signed.signature,
      },
      body: JSON.stringify({ tempToken }),
    };
    if (this.dispatcher) init.dispatcher = this.dispatcher;
    let response;
    let text;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        fail(
          'REQUEST_TIMEOUT',
          `SHEIN OpenAPI request timed out after ${this.timeoutMs}ms: ${path}`,
          { path, timeoutMs: this.timeoutMs },
          { cause: error },
        );
      }
      fail('NETWORK_ERROR', `SHEIN OpenAPI network request failed: ${path}`, {
        path,
      }, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    const responseMeta = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
    };
    if (responseMeta.ok !== true || !Number.isInteger(responseMeta.status)) {
      assertSuccessfulOpenApiResponse(responseMeta, path);
    }
    const result = {
      ...responseMeta,
      data: parseBody(text, path),
    };
    const data = assertSuccessfulOpenApiResponse(result, path);
    const info = data.info;
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      fail('INVALID_AUTHORIZATION_RESPONSE', 'get-by-token returned invalid info');
    }
    const openKeyId = String(info.openKeyId || '').trim();
    const encryptedSecretKey = String(info.secretKey || '').trim();
    const returnedAppId = String(info.appid || info.appId || '').trim();
    const returnedState = String(info.state || '').trim();
    const supplierId = String(info.supplierId ?? '').trim();
    if (!openKeyId || !encryptedSecretKey || !returnedAppId || !returnedState || !supplierId) {
      fail(
        'INVALID_AUTHORIZATION_RESPONSE',
        'get-by-token response is missing required authorization fields',
      );
    }
    const secretKey = decryptSheinSecretKey(encryptedSecretKey, appSecretKey);
    if (!secretKey) {
      fail('INVALID_AUTHORIZATION_RESPONSE', 'decrypted store secret is empty');
    }
    return Object.freeze({
      appId: returnedAppId,
      state: returnedState,
      supplierId,
      supplierSource: info.supplierSource ?? null,
      supplierBusinessMode: String(info.supplierBusinessMode || '').trim() || null,
      openKeyId,
      encryptedSecretKey,
      secretKey,
      traceId: typeof data.traceId === 'string' ? data.traceId.slice(0, 128) : null,
    });
  }
}
