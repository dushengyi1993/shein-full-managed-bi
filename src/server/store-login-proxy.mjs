import { normalizeFullManagedStoreCode } from '../config/full-managed-stores.mjs';

const ACTIONS = Object.freeze({
  status: Object.freeze({ method: 'GET', path: '/api/store-login/status' }),
  start: Object.freeze({ method: 'POST', path: '/api/store-login/start' }),
  finish: Object.freeze({ method: 'POST', path: '/api/store-login/finish' }),
  close: Object.freeze({ method: 'POST', path: '/api/store-login/close' }),
});

export class StoreLoginProxyError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = 'StoreLoginProxyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new StoreLoginProxyError(code, message, statusCode);
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || 'http://127.0.0.1:8794'));
  } catch {
    throw new TypeError('store-login internal URL is invalid');
  }
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.port
  ) {
    throw new TypeError('store-login internal URL must be an explicit loopback HTTP origin');
  }
  return url.origin;
}

function normalizeToken(value) {
  const token = String(value || '').trim();
  if (
    Buffer.byteLength(token, 'utf8') < 32
    || Buffer.byteLength(token, 'utf8') > 512
    || /[\u0000-\u001f\u007f]/.test(token)
  ) {
    throw new TypeError('store-login internal token is invalid');
  }
  return token;
}

function requestBody(action, input) {
  if (action === 'close') return {};
  const storeCode = normalizeFullManagedStoreCode(input?.storeCode);
  if (!storeCode) fail('STORE_INVALID', '店铺不在全托登录清单中', 400);
  return { storeCode };
}

function validateResponse(action, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.ok !== true) {
    fail('STORE_LOGIN_RESPONSE_INVALID', '登录维护服务返回了无效结果');
  }
  if (action === 'status') {
    if (
      !Number.isSafeInteger(body.total)
      || !Number.isSafeInteger(body.completed)
      || !Array.isArray(body.stores)
    ) {
      fail('STORE_LOGIN_RESPONSE_INVALID', '登录维护状态结构无效');
    }
  }
  if (action === 'start') {
    const openUrl = String(body.openUrl || '');
    if (!/^\/store-login\/session\/[A-Za-z0-9%_-]+#token=[A-Za-z0-9_-]+$/.test(openUrl)) {
      fail('STORE_LOGIN_RESPONSE_INVALID', '登录窗口地址无效');
    }
  }
  return body;
}

export function createStoreLoginProxy({
  baseUrl = 'http://127.0.0.1:8794',
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60_000,
} = {}) {
  const origin = normalizeBaseUrl(baseUrl);
  const internalToken = normalizeToken(token);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new RangeError('store-login timeout must be between 1000 and 120000 ms');
  }

  async function request(action, input = {}) {
    const contract = ACTIONS[action];
    if (!contract) throw new TypeError('unknown store-login proxy action');
    const options = {
      method: contract.method,
      headers: {
        Accept: 'application/json',
        'X-FM-Internal-Token': internalToken,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (contract.method === 'POST') {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(requestBody(action, input));
    }
    let response;
    try {
      response = await fetchImpl(`${origin}${contract.path}`, options);
    } catch {
      fail('STORE_LOGIN_UNAVAILABLE', '登录维护服务暂不可用', 503);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const upstreamCode = String(body?.error || '');
      const safeCode = /^[A-Z0-9_]{3,80}$/.test(upstreamCode)
        ? upstreamCode
        : 'STORE_LOGIN_UPSTREAM_FAILED';
      fail(safeCode, '登录维护操作未完成', response.status >= 400 && response.status < 500
        ? response.status
        : 502);
    }
    return validateResponse(action, body);
  }

  return Object.freeze({
    status: () => request('status'),
    start: (storeCode) => request('start', { storeCode }),
    finish: (storeCode) => request('finish', { storeCode }),
    close: () => request('close'),
  });
}
