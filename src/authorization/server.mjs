import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthorizationServiceError, AUTHORIZATION_CALLBACK_PATH } from './service.mjs';
import { AuthorizationStoreError } from './file-store.mjs';

const DEFAULT_WEB_ROOT = fileURLToPath(new URL('./web/', import.meta.url));
const MAX_BODY_BYTES = 4_096;
const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
});
const STATIC_ROUTES = Object.freeze({
  '/authorize': 'index.html',
  '/authorize/': 'index.html',
  '/authorize/app.js': 'app.js',
  '/authorize/styles.css': 'styles.css',
  '/authorize/opening': 'opening.html',
  '/authorize/result': 'result.html',
});

function setSecurityHeaders(response) {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function send(response, statusCode, body, contentType, method = 'GET') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.statusCode = statusCode;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', payload.byteLength);
  if (method === 'HEAD') {
    response.end();
    return;
  }
  response.end(payload);
}

function sendJson(response, statusCode, value, method = 'GET') {
  response.setHeader('Cache-Control', 'no-store');
  send(response, statusCode, `${JSON.stringify(value)}\n`, 'application/json; charset=utf-8', method);
}

function redirect(response, location) {
  response.statusCode = 303;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Location', location);
  response.setHeader('Content-Length', '0');
  response.end();
}

function errorCode(error) {
  if (error instanceof AuthorizationServiceError || error instanceof AuthorizationStoreError) {
    return error.code;
  }
  if (error?.code === 'INVALID_CALLBACK_PARAMETERS') return error.code;
  return 'AUTHORIZATION_UNAVAILABLE';
}

function publicMessage(code) {
  const messages = {
    AUTHORIZATION_SESSION_REQUIRED: '请使用管理员发送的完整授权链接重新进入。',
    INVALID_BATCH_TOKEN: '授权链接无效，请联系管理员重新获取。',
    BATCH_EXPIRED: '授权链接已过期，请联系管理员重新生成。',
    STORE_NOT_IN_BATCH: '目标店铺不在本次授权清单中。',
    STORE_ALREADY_RECEIVED: '该店铺的授权已收到，正在等待管理员核验。',
    STORE_ATTEMPT_LIMIT: '该店铺尝试次数过多，请联系管理员。',
  };
  return messages[code] || '授权服务暂时不可用，请稍后重试。';
}

function statusCodeFor(code) {
  if (['AUTHORIZATION_SESSION_REQUIRED', 'INVALID_BATCH_TOKEN'].includes(code)) return 401;
  if (['BATCH_EXPIRED', 'STORE_ALREADY_RECEIVED', 'STORE_ATTEMPT_LIMIT'].includes(code)) return 409;
  if (['STORE_NOT_IN_BATCH', 'INVALID_STORE_CODE'].includes(code)) return 404;
  return 503;
}

function callbackResult(error) {
  const code = errorCode(error);
  if (code === 'AUTHORIZATION_STATE_EXPIRED' || code === 'BATCH_EXPIRED') return 'expired';
  if (code === 'AUTHORIZATION_STATE_REPLAYED') return 'already_received';
  if (
    [
      'APPLICATION_ID_MISMATCH',
      'RETURNED_STATE_MISMATCH',
      'STORE_IDENTITY_MISSING',
      'STORE_IDENTITY_MISMATCH',
      'SUPPLIER_ID_ALREADY_BOUND',
      'CREDENTIAL_ALREADY_BOUND',
    ].includes(code)
  ) {
    return 'identity_check_failed';
  }
  if (
    [
      'INVALID_AUTHORIZATION_STATE',
      'INVALID_TEMP_TOKEN',
      'INVALID_CALLBACK_PARAMETERS',
      'AUTHORIZATION_STATE_UNAVAILABLE',
    ].includes(code)
  ) {
    return 'invalid';
  }
  return 'retry';
}

function boundedDiagnosticText(value, maximum = 240) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value
    .replace(/[A-Za-z0-9._~-]{24,}/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function boundedDiagnosticCode(value, fallback = 'ERROR') {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(text) ? text : fallback;
}

export function authorizationCallbackDiagnostic(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && chain.length < 4 && !seen.has(current)) {
    seen.add(current);
    const details = current.details && typeof current.details === 'object'
      ? current.details
      : {};
    chain.push({
      code: boundedDiagnosticCode(current.code || current.name),
      httpStatus: Number.isInteger(details.httpStatus) ? details.httpStatus : null,
      platformCode: details.platformCode === null || details.platformCode === undefined
        ? null
        : boundedDiagnosticCode(
          String(details.platformCode),
          'UNKNOWN_PLATFORM_CODE',
        ),
      platformMessage: boundedDiagnosticText(details.platformMessage),
      traceId: details.traceId === null || details.traceId === undefined
        ? null
        : boundedDiagnosticCode(details.traceId, 'UNSAFE_TRACE_ID'),
    });
    current = current.cause;
  }
  return Object.freeze(chain);
}

function logCallbackFailure(logger, error) {
  try {
    logger?.error?.(JSON.stringify({
      event: 'authorization_callback_failed',
      diagnostic: authorizationCallbackDiagnostic(error),
    }));
  } catch {
    // Logging must never alter the authorization result or expose callback input.
  }
}

async function parseJsonBody(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    const error = new Error('Content-Type must be application/json');
    error.code = 'UNSUPPORTED_MEDIA_TYPE';
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('request body is too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('request body is invalid JSON');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

function sameOrigin(request, publicOrigin) {
  const origin = String(request.headers.origin || '').trim();
  if (!origin || origin === 'null') return false;
  try {
    return new URL(origin).origin === publicOrigin;
  } catch {
    return false;
  }
}

function callbackParameters(url) {
  const states = url.searchParams.getAll('state');
  const tokens = url.searchParams.getAll('tempToken');
  if (states.length !== 1 || tokens.length !== 1) {
    const error = new Error('callback must contain exactly one state and tempToken');
    error.code = 'INVALID_CALLBACK_PARAMETERS';
    throw error;
  }
  return { state: states[0], tempToken: tokens[0] };
}

async function serveStatic(response, webRoot, filename, method) {
  try {
    const content = await readFile(path.join(webRoot, filename));
    response.setHeader('Cache-Control', filename.endsWith('.html') ? 'no-store' : 'public, max-age=300');
    send(
      response,
      200,
      content,
      CONTENT_TYPES[path.extname(filename)] || 'application/octet-stream',
      method,
    );
  } catch {
    sendJson(response, 503, {
      error: { code: 'AUTHORIZATION_UI_UNAVAILABLE', message: '授权页面暂不可用。' },
    }, method);
  }
}

export function createAuthorizationRequestHandler({
  authorizationService,
  webRoot = DEFAULT_WEB_ROOT,
  maximumConcurrentCallbacks = 8,
  logger = console,
} = {}) {
  if (!authorizationService) throw new TypeError('authorizationService is required');
  if (
    !Number.isSafeInteger(maximumConcurrentCallbacks)
    || maximumConcurrentCallbacks < 1
    || maximumConcurrentCallbacks > 64
  ) {
    throw new RangeError('maximumConcurrentCallbacks must be between 1 and 64');
  }
  const publicOrigin = authorizationService.publicOrigin;
  let activeCallbacks = 0;

  return async function authorizationRequestHandler(request, response) {
    setSecurityHeaders(response);
    const method = request.method || 'GET';
    if (String(request.url || '').length > 4_096) {
      sendJson(response, 414, {
        error: { code: 'URI_TOO_LONG', message: '请求地址过长。' },
      }, method);
      return;
    }
    let url;
    try {
      url = new URL(request.url || '/', 'http://127.0.0.1');
    } catch {
      sendJson(response, 400, {
        error: { code: 'INVALID_URL', message: '请求地址无效。' },
      }, method);
      return;
    }

    if (url.pathname === '/health') {
      if (!['GET', 'HEAD'].includes(method)) {
        response.setHeader('Allow', 'GET, HEAD');
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持。' } }, method);
        return;
      }
      sendJson(response, 200, {
        status: 'ok',
        service: 'shein-full-managed-authorization',
        storesCredentialsAutomaticallyActivated: false,
      }, method);
      return;
    }

    if (url.pathname === AUTHORIZATION_CALLBACK_PATH) {
      if (method !== 'GET') {
        response.setHeader('Allow', 'GET');
        redirect(response, '/authorize/result?status=invalid');
        return;
      }
      if (activeCallbacks >= maximumConcurrentCallbacks) {
        redirect(response, '/authorize/result?status=busy');
        return;
      }
      activeCallbacks += 1;
      try {
        const parameters = callbackParameters(url);
        const result = await authorizationService.complete(parameters);
        redirect(
          response,
          `/authorize/result?status=received&store=${encodeURIComponent(result.storeCode)}`,
        );
      } catch (error) {
        logCallbackFailure(logger, error);
        redirect(response, `/authorize/result?status=${callbackResult(error)}`);
      } finally {
        activeCallbacks -= 1;
      }
      return;
    }

    if (Object.hasOwn(STATIC_ROUTES, url.pathname)) {
      if (!['GET', 'HEAD'].includes(method)) {
        response.setHeader('Allow', 'GET, HEAD');
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持。' } }, method);
        return;
      }
      await serveStatic(response, webRoot, STATIC_ROUTES[url.pathname], method);
      return;
    }

    if (url.pathname === '/authorize/session') {
      if (method !== 'POST') {
        response.setHeader('Allow', 'POST');
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持。' } }, method);
        return;
      }
      if (!sameOrigin(request, publicOrigin)) {
        sendJson(response, 403, { error: { code: 'CROSS_ORIGIN_REJECTED', message: '请求来源无效。' } }, method);
        return;
      }
      try {
        const body = await parseJsonBody(request);
        const result = await authorizationService.createSession(String(body?.token || ''));
        response.setHeader('Set-Cookie', result.setCookie);
        sendJson(response, 200, { ok: true, batch: result.batch }, method);
      } catch (error) {
        const code = errorCode(error);
        const parseCode = error?.code;
        const status = parseCode === 'UNSUPPORTED_MEDIA_TYPE'
          ? 415
          : ['BODY_TOO_LARGE', 'INVALID_JSON'].includes(parseCode)
            ? 400
            : statusCodeFor(code);
        sendJson(response, status, {
          error: {
            code: parseCode || code,
            message: parseCode ? '授权口令格式无效。' : publicMessage(code),
          },
        }, method);
      }
      return;
    }

    if (url.pathname === '/authorize/batch') {
      if (!['GET', 'HEAD'].includes(method)) {
        response.setHeader('Allow', 'GET, HEAD');
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持。' } }, method);
        return;
      }
      try {
        const batch = await authorizationService.getBatch(request.headers.cookie);
        sendJson(response, 200, { batch }, method);
      } catch (error) {
        const code = errorCode(error);
        sendJson(response, statusCodeFor(code), {
          error: { code, message: publicMessage(code) },
        }, method);
      }
      return;
    }

    const startMatch = /^\/authorize\/start\/([A-Z0-9_-]{1,24})$/.exec(url.pathname);
    if (startMatch) {
      if (method !== 'POST') {
        response.setHeader('Allow', 'POST');
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持。' } }, method);
        return;
      }
      if (!sameOrigin(request, publicOrigin)) {
        sendJson(response, 403, { error: { code: 'CROSS_ORIGIN_REJECTED', message: '请求来源无效。' } }, method);
        return;
      }
      try {
        const result = await authorizationService.begin(request.headers.cookie, startMatch[1]);
        sendJson(response, 200, result, method);
      } catch (error) {
        const code = errorCode(error);
        sendJson(response, statusCodeFor(code), {
          error: { code, message: publicMessage(code) },
        }, method);
      }
      return;
    }

    if (url.pathname === '/authorize/logout') {
      if (method !== 'POST') {
        response.setHeader('Allow', 'POST');
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持。' } }, method);
        return;
      }
      if (!sameOrigin(request, publicOrigin)) {
        sendJson(response, 403, { error: { code: 'CROSS_ORIGIN_REJECTED', message: '请求来源无效。' } }, method);
        return;
      }
      response.setHeader('Set-Cookie', authorizationService.clearCookie());
      sendJson(response, 200, { ok: true }, method);
      return;
    }

    sendJson(response, 404, {
      error: { code: 'NOT_FOUND', message: '页面不存在。' },
    }, method);
  };
}

export function createAuthorizationServer(options) {
  return createServer(createAuthorizationRequestHandler(options));
}
