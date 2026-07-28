import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDashboardData } from './dashboard-data.mjs';
import { projectDashboardForUser } from './dashboard-access.mjs';
import {
  ProcurementQueryError,
  queryProcurementDashboard,
} from './procurement-query.mjs';
import { createDashboardUpdateBroker } from './dashboard-update-stream.mjs';
import {
  createAuthService,
  isSameOriginPost,
  loginPage,
  parseLoginBody,
  RequestBodyError,
} from './auth.mjs';

const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
});

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

function setSecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

function send(response, statusCode, body, contentType, method = 'GET') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', payload.byteLength);
  if (method === 'HEAD') {
    response.end();
    return;
  }
  response.end(payload);
}

function sendJson(response, statusCode, value, method) {
  response.setHeader('Cache-Control', 'no-store');
  send(
    response,
    statusCode,
    `${JSON.stringify(value)}\n`,
    'application/json; charset=utf-8',
    method,
  );
}

function redirect(response, location, method = 'GET') {
  response.statusCode = 303;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Location', location);
  response.setHeader('Content-Length', '0');
  response.end();
}

function sendLoginPage(response, method, error = '', statusCode = 200) {
  const page = loginPage({ error });
  response.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'nonce-${page.nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'same-origin');
  send(response, statusCode, page.html, 'text/html; charset=utf-8', method);
}

function requestWantsJson(request) {
  return (
    String(request.headers['content-type'] || '').toLowerCase().includes('application/json') ||
    String(request.headers.accept || '').toLowerCase().includes('application/json')
  );
}

function rawPathHasTraversal(requestUrl = '/') {
  const rawPath = requestUrl.split(/[?#]/, 1)[0];
  let decoded = rawPath;

  try {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return true;
  }

  if (decoded.includes('\0')) return true;
  const pathWithForwardSlashes = decoded.replaceAll('\\', '/');
  return pathWithForwardSlashes.split('/').includes('..');
}

function staticFilePath(pathname, webRoot) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const requestedPath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const root = resolve(webRoot);
  const candidate = resolve(root, requestedPath);
  const candidateRelativeToRoot = relative(root, candidate);

  if (
    candidateRelativeToRoot === '' ||
    candidateRelativeToRoot === '..' ||
    candidateRelativeToRoot.startsWith(`..${sep}`) ||
    isAbsolute(candidateRelativeToRoot)
  ) {
    return null;
  }

  return candidate;
}

export function createRequestHandler(options = {}) {
  const dataFile = options.dataFile;
  const webRoot = options.webRoot || DEFAULT_WEB_ROOT;
  const updateBroker = options.updateBroker || null;
  const runtimeEnvironment = options.runtimeEnvironment || options.auth?.runtimeEnvironment || 'development';
  const auth = options.authService || createAuthService({
    ...(options.auth || {}),
    host: options.host || options.auth?.host,
    runtimeEnvironment,
  });
  if (String(runtimeEnvironment).toLowerCase() === 'production' && !dataFile) {
    throw new TypeError('FULL_BI_DATA_FILE is required in production.');
  }

  return async function requestHandler(request, response) {
    setSecurityHeaders(response);
    const method = request.method || 'GET';

    if (rawPathHasTraversal(request.url)) {
      sendJson(
        response,
        400,
        { error: { code: 'INVALID_PATH', message: '请求路径无效' } },
        method,
      );
      return;
    }

    let url;
    try {
      url = new URL(request.url || '/', 'http://127.0.0.1');
    } catch {
      sendJson(
        response,
        400,
        { error: { code: 'INVALID_URL', message: '请求地址无效' } },
        method,
      );
      return;
    }

    if (url.pathname === '/health') {
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持' } }, method);
        return;
      }
      sendJson(
        response,
        200,
        { status: 'ok', service: 'shein-full-managed-bi', readOnly: true },
        method,
      );
      return;
    }

    if (url.pathname === '/ready') {
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持' } }, method);
        return;
      }
      try {
        const dashboard = await loadDashboardData(dataFile, { runtimeEnvironment });
        sendJson(response, 200, {
          status: 'ready',
          service: 'shein-full-managed-bi',
          datasetStatus: dashboard.dataset.status,
          updatedAt: dashboard.updatedAt,
        }, method);
      } catch {
        sendJson(response, 503, {
          status: 'not_ready',
          service: 'shein-full-managed-bi',
        }, method);
      }
      return;
    }

    if (url.pathname === '/login') {
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持' } }, method);
        return;
      }
      if (!auth.enabled) {
        redirect(response, '/', method);
        return;
      }
      if (auth.authenticateRequest(request)) {
        redirect(response, '/', method);
        return;
      }
      sendLoginPage(response, method);
      return;
    }

    if (url.pathname === '/api/login') {
      if (!auth.enabled) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '页面不存在' } }, method);
        return;
      }
      if (method !== 'POST') {
        response.setHeader('Allow', 'POST');
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持' } }, method);
        return;
      }
      if (!isSameOriginPost(request, auth)) {
        sendJson(response, 403, { error: { code: 'CROSS_ORIGIN_REJECTED', message: '请求来源无效' } }, method);
        return;
      }

      try {
        const body = await parseLoginBody(request, auth.maxBodyBytes);
        const result = await auth.authenticate(request, body.username, body.password);
        if (result.busy) {
          response.setHeader('Retry-After', String(result.retryAfterSeconds));
          sendJson(response, 503, { error: { code: 'AUTH_BUSY', message: '登录服务繁忙，请稍后再试' } }, method);
          return;
        }
        if (result.rateLimited) {
          response.setHeader('Retry-After', String(result.retryAfterSeconds));
          sendJson(response, 429, { error: { code: 'LOGIN_RATE_LIMITED', message: '登录尝试过多，请稍后再试' } }, method);
          return;
        }
        if (!result.ok) {
          if (body.json || requestWantsJson(request)) {
            sendJson(response, 401, { error: { code: 'INVALID_CREDENTIALS', message: '账号或密码错误' } }, method);
          } else {
            sendLoginPage(response, method, '账号或密码错误', 401);
          }
          return;
        }

        response.setHeader('Set-Cookie', result.cookie);
        if (body.json || requestWantsJson(request)) {
          sendJson(response, 200, { ok: true, user: result.user }, method);
        } else {
          redirect(response, '/', method);
        }
      } catch (error) {
        if (error instanceof RequestBodyError) {
          sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } }, method);
          return;
        }
        sendJson(response, 500, { error: { code: 'AUTH_UNAVAILABLE', message: '登录服务暂不可用' } }, method);
      }
      return;
    }

    const signedInUser = auth.enabled ? auth.authenticateRequest(request) : null;
    if (auth.enabled && !signedInUser) {
      if (url.pathname.startsWith('/api/')) {
        response.setHeader('WWW-Authenticate', 'Session');
        sendJson(response, 401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } }, method);
      } else {
        redirect(response, '/login', method);
      }
      return;
    }

    if (auth.enabled && method === 'POST' && !isSameOriginPost(request, auth)) {
      sendJson(response, 403, { error: { code: 'CROSS_ORIGIN_REJECTED', message: '请求来源无效' } }, method);
      return;
    }

    if (url.pathname === '/api/events') {
      if (method !== 'GET') {
        response.setHeader('Allow', 'GET');
        sendJson(response, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: '更新流仅支持 GET' },
        }, method);
        return;
      }
      if (!updateBroker) {
        sendJson(response, 503, {
          error: { code: 'UPDATE_STREAM_UNAVAILABLE', message: '数据更新流暂不可用' },
        }, method);
        return;
      }
      updateBroker.open(request, response);
      return;
    }

    if (url.pathname === '/api/logout') {
      if (!auth.enabled) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '页面不存在' } }, method);
        return;
      }
      if (method !== 'POST') {
        response.setHeader('Allow', 'POST');
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持' } }, method);
        return;
      }
      response.setHeader('Set-Cookie', auth.clearCookie());
      sendJson(response, 200, { ok: true }, method);
      return;
    }

    if (url.pathname === '/api/me') {
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持' } }, method);
        return;
      }
      sendJson(response, 200, {
        user: signedInUser || {
          username: null,
          displayName: '本地开发',
          employeeCode: null,
          role: 'viewer',
          allStores: false,
          storeCodes: [],
        },
      }, method);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      sendJson(
        response,
        405,
        { error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持只读请求' } },
        method,
      );
      return;
    }

    if (url.pathname === '/api/dashboard') {
      try {
        const dashboard = await loadDashboardData(dataFile);
        sendJson(response, 200, projectDashboardForUser(dashboard, signedInUser), method);
      } catch {
        sendJson(
          response,
          503,
          {
            error: {
              code: 'DASHBOARD_DATA_UNAVAILABLE',
              message: '看板数据暂不可用',
            },
          },
          method,
        );
      }
      return;
    }

    if (url.pathname === '/api/procurement') {
      try {
        const dashboard = await loadDashboardData(dataFile);
        const projected = projectDashboardForUser(dashboard, signedInUser);
        sendJson(
          response,
          200,
          queryProcurementDashboard(projected, url.searchParams),
          method,
        );
      } catch (error) {
        if (error instanceof ProcurementQueryError) {
          sendJson(response, error.statusCode, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        sendJson(response, 503, {
          error: {
            code: 'PROCUREMENT_DATA_UNAVAILABLE',
            message: '采购单查询暂不可用',
          },
        }, method);
      }
      return;
    }

    const filePath = staticFilePath(url.pathname, webRoot);
    if (!filePath) {
      sendJson(
        response,
        400,
        { error: { code: 'INVALID_PATH', message: '请求路径无效' } },
        method,
      );
      return;
    }

    try {
      const content = await readFile(filePath);
      response.setHeader('Cache-Control', 'no-cache');
      send(
        response,
        200,
        content,
        CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
        method,
      );
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        sendJson(
          response,
          404,
          { error: { code: 'NOT_FOUND', message: '页面不存在' } },
          method,
        );
        return;
      }

      sendJson(
        response,
        500,
        { error: { code: 'STATIC_READ_FAILED', message: '页面暂不可用' } },
        method,
      );
    }
  };
}

export function createDashboardServer(options = {}) {
  const ownedUpdateBroker = options.updateBroker
    ? null
    : (
      typeof options.dataFile === 'string' && options.dataFile.trim() !== ''
        ? createDashboardUpdateBroker({
            dataFile: options.dataFile,
            pollIntervalMs: options.updatePollIntervalMs,
            heartbeatIntervalMs: options.updateHeartbeatIntervalMs,
          })
        : null
    );
  const server = createServer(createRequestHandler({
    ...options,
    updateBroker: options.updateBroker || ownedUpdateBroker,
  }));
  if (ownedUpdateBroker) {
    const closeHttpServer = server.close.bind(server);
    // Active SSE responses keep Node's HTTP server open. End owned subscribers
    // before asking the HTTP server to drain, otherwise systemd shutdown can
    // wait for a stream whose normal lifetime is intentionally unbounded.
    server.close = (callback) => {
      ownedUpdateBroker.close();
      return closeHttpServer(callback);
    };
  }
  return server;
}
