import crypto from 'node:crypto';

export const FULL_MANAGED_OPENAPI_BASE_URL = 'https://openapi.sheincorp.com';
export const CONTENT_TYPE = 'application/json;charset=UTF-8';

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
  } = {}) {
    if (typeof fetchImpl !== 'function') fail('MISSING_FETCH', 'fetch implementation is required');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.openKeyId = openKeyId;
    this.secretKey = secretKey;
    this.timeoutMs = Number(timeoutMs);
    this.allowFakeBaseUrl = allowFakeBaseUrl;
    this.fetchImpl = fetchImpl;
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

    const result = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      data: parseBody(text, signed.path),
    };
    assertSuccessfulOpenApiResponse(result, signed.path);
    return result;
  }
}
