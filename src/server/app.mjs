import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDashboardData } from './dashboard-data.mjs';

const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
});

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
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

  return async function requestHandler(request, response) {
    setSecurityHeaders(response);
    const method = request.method || 'GET';

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
      sendJson(
        response,
        200,
        { status: 'ok', service: 'full-managed-bi-local', readOnly: true },
        method,
      );
      return;
    }

    if (url.pathname === '/api/dashboard') {
      try {
        const dashboard = await loadDashboardData(dataFile);
        sendJson(response, 200, dashboard, method);
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
  return createServer(createRequestHandler(options));
}
