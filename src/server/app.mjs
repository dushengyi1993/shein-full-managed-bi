import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { loadDashboardData, loadHomeHistoryData } from './dashboard-data.mjs';
import { projectDashboardForUser } from './dashboard-access.mjs';
import { HomeQueryError, queryHomeDashboard } from './home-query.mjs';
import {
  ProcurementQueryError,
  queryProcurementDashboard,
} from './procurement-query.mjs';
import {
  SalesQueryError,
  querySalesDashboard,
} from './sales-query.mjs';
import {
  InventoryQueryError,
  queryInventoryDashboard,
} from './inventory-query.mjs';
import {
  ProductQueryError,
  queryProductDashboard,
} from './product-query.mjs';
import { loadShippingOrdersData, ShippingOrdersDataError } from './shipping-orders-data.mjs';
import { queryShippingOrders, ShippingOrdersQueryError } from './shipping-orders-query.mjs';
import { loadOrderManagementData, OrderManagementDataError } from './order-management-data.mjs';
import { queryOrderManagement, OrderManagementQueryError } from './order-management-query.mjs';
import { loadProductIndexData, ProductIndexDataError } from './product-index-data.mjs';
import { queryProductIndex, ProductIndexQueryError } from './product-index-query.mjs';
import { queryReturnsDashboard, ReturnsQueryError } from './returns-query.mjs';
import {
  PlatformQueryError,
  queryPlatformDashboard,
} from './platform-query.mjs';
import {
  OpsQueryError,
  queryOpsDashboard,
} from './ops-query.mjs';
import { loadSystemHealthData, SystemHealthDataError } from './system-health-data.mjs';
import { querySystemDashboard, SystemQueryError } from './system-query.mjs';
import {
  createStoreLoginProxy,
  StoreLoginProxyError,
} from './store-login-proxy.mjs';
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

function sendJson(response, statusCode, value, method, request = null) {
  response.setHeader('Cache-Control', 'no-store');
  const payload = Buffer.from(`${JSON.stringify(value)}\n`);
  const acceptsGzip = /\bgzip\b/i.test(String(request?.headers?.['accept-encoding'] || ''));
  if (acceptsGzip && payload.byteLength >= 1024) {
    const compressed = gzipSync(payload, { level: 6 });
    response.setHeader('Content-Encoding', 'gzip');
    response.setHeader('Vary', 'Accept-Encoding');
    send(response, statusCode, compressed, 'application/json; charset=utf-8', method);
    return;
  }
  send(response, statusCode, payload, 'application/json; charset=utf-8', method);
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

async function readSmallJson(request, maximumBytes = 8_192) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > maximumBytes) {
      const error = new Error('请求内容过大');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
  }
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    const error = new Error('请求内容格式无效');
    error.code = 'INVALID_JSON';
    throw error;
  }
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
  const homeDataFile = options.homeDataFile;
  const shippingOrdersFile = options.shippingOrdersFile;
  const orderManagementFile = options.orderManagementFile;
  const productIndexFile = options.productIndexFile;
  const systemHealthFile = options.systemHealthFile;
  const webRoot = options.webRoot || DEFAULT_WEB_ROOT;
  const updateBroker = options.updateBroker || null;
  const runtimeEnvironment = options.runtimeEnvironment || options.auth?.runtimeEnvironment || 'development';
  const auth = options.authService || createAuthService({
    ...(options.auth || {}),
    host: options.host || options.auth?.host,
    runtimeEnvironment,
  });
  const storeLoginProxy = options.storeLoginProxy || (
    options.storeLogin?.token
      ? createStoreLoginProxy(options.storeLogin)
      : null
  );
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

    if (auth.enabled && url.pathname !== '/api/logout') {
      const refreshedCookie = auth.refreshCookieForRequest(request);
      if (refreshedCookie) response.setHeader('Set-Cookie', refreshedCookie);
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

    const storeLoginRoute = /^\/api\/system\/store-login\/(status|start|finish|close)$/.exec(
      url.pathname,
    );
    if (storeLoginRoute) {
      if (signedInUser?.role !== 'admin') {
        sendJson(response, 403, {
          error: { code: 'ADMIN_REQUIRED', message: '仅系统管理员可维护店铺登录态' },
        }, method);
        return;
      }
      if (!storeLoginProxy) {
        sendJson(response, 503, {
          error: { code: 'STORE_LOGIN_UNAVAILABLE', message: '登录维护中心暂不可用' },
        }, method);
        return;
      }
      const action = storeLoginRoute[1];
      const expectedMethod = action === 'status' ? 'GET' : 'POST';
      if (method !== expectedMethod) {
        response.setHeader('Allow', expectedMethod);
        sendJson(response, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持' },
        }, method);
        return;
      }
      try {
        const body = method === 'POST' ? await readSmallJson(request) : {};
        const result = action === 'status'
          ? await storeLoginProxy.status()
          : action === 'start'
            ? await storeLoginProxy.start(body.storeCode)
            : action === 'finish'
              ? await storeLoginProxy.finish(body.storeCode)
              : await storeLoginProxy.close();
        sendJson(response, 200, result, method);
      } catch (error) {
        if (error instanceof StoreLoginProxyError) {
          sendJson(response, error.statusCode, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        const code = error?.code === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INVALID_REQUEST';
        sendJson(response, code === 'BODY_TOO_LARGE' ? 413 : 400, {
          error: { code, message: error?.message || '登录维护请求无效' },
        }, method);
      }
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
        const forceRefresh = url.searchParams.get('refresh') === '1';
        const dashboard = await loadDashboardData(dataFile, {
          runtimeEnvironment,
          forceRefresh,
        });
        sendJson(
          response,
          200,
          projectDashboardForUser(dashboard, signedInUser),
          method,
          request,
        );
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

    if (url.pathname === '/api/home') {
      try {
        const forceRefresh = url.searchParams.get('refresh') === '1';
        const [dashboard, history] = await Promise.all([
          loadDashboardData(dataFile, { runtimeEnvironment, forceRefresh }),
          loadHomeHistoryData(homeDataFile || dataFile, {
            runtimeEnvironment,
            forceRefresh,
          }),
        ]);
        const projected = projectDashboardForUser(dashboard, signedInUser);
        sendJson(
          response,
          200,
          queryHomeDashboard(projected, history, url.searchParams),
          method,
          request,
        );
      } catch (error) {
        if (error instanceof HomeQueryError) {
          sendJson(response, error.statusCode, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        sendJson(response, 503, {
          error: {
            code: 'HOME_DATA_UNAVAILABLE',
            message: '首页经营数据暂不可用',
          },
        }, method);
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

    if (url.pathname === '/api/sales') {
      try {
        const dashboard = await loadDashboardData(dataFile);
        const projected = projectDashboardForUser(dashboard, signedInUser);
        sendJson(
          response,
          200,
          querySalesDashboard(projected, url.searchParams),
          method,
        );
      } catch (error) {
        if (error instanceof SalesQueryError) {
          sendJson(response, error.statusCode, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        sendJson(response, 503, {
          error: {
            code: 'SALES_DATA_UNAVAILABLE',
            message: '销量查询暂不可用',
          },
        }, method);
      }
      return;
    }

    if (url.pathname === '/api/inventory') {
      try {
        const dashboard = await loadDashboardData(dataFile);
        const projected = projectDashboardForUser(dashboard, signedInUser);
        sendJson(
          response,
          200,
          queryInventoryDashboard(projected, url.searchParams),
          method,
        );
      } catch (error) {
        if (error instanceof InventoryQueryError) {
          sendJson(response, error.statusCode, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        sendJson(response, 503, {
          error: {
            code: 'INVENTORY_DATA_UNAVAILABLE',
            message: '库存与备货查询暂不可用',
          },
        }, method);
      }
      return;
    }

    if (url.pathname === '/api/products') {
      try {
        const dashboard = await loadDashboardData(dataFile);
        const projected = projectDashboardForUser(dashboard, signedInUser);
        sendJson(
          response,
          200,
          queryProductDashboard(projected, url.searchParams),
          method,
        );
      } catch (error) {
        if (error instanceof ProductQueryError) {
          sendJson(response, error.statusCode, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        sendJson(response, 503, {
          error: {
            code: 'PRODUCT_DATA_UNAVAILABLE',
            message: '商品身份查询暂不可用',
          },
        }, method);
      }
      return;
    }

    if (url.pathname === '/api/fulfilment') {
      try {
        const forceRefresh = url.searchParams.get('refresh') === '1';
        const [dashboard, shippingOrders] = await Promise.all([
          loadDashboardData(dataFile, { runtimeEnvironment, forceRefresh }),
          loadShippingOrdersData(shippingOrdersFile, { runtimeEnvironment, forceRefresh }),
        ]);
        const projected = projectDashboardForUser(dashboard, signedInUser);
        sendJson(
          response,
          200,
          queryShippingOrders(projected, shippingOrders, url.searchParams),
          method,
          request,
        );
      } catch (error) {
        if (error instanceof ShippingOrdersQueryError) {
          sendJson(response, error.statusCode, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        if (error instanceof ShippingOrdersDataError) {
          sendJson(response, 503, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        sendJson(response, 503, {
          error: {
            code: 'FULFILMENT_DATA_UNAVAILABLE',
            message: '发货订单查询暂不可用',
          },
        }, method);
      }
      return;
    }

    if (url.pathname === '/api/returns') {
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        sendJson(response, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持' },
        }, method);
        return;
      }
      try {
        const [dashboard, orderManagement] = await Promise.all([
          loadDashboardData(dataFile),
          loadOrderManagementData(orderManagementFile, { runtimeEnvironment }),
        ]);
        const projected = projectDashboardForUser(dashboard, signedInUser);
        sendJson(
          response,
          200,
          queryReturnsDashboard(projected, orderManagement, url.searchParams),
          method,
          request,
        );
      } catch (error) {
        if (error instanceof ReturnsQueryError) {
          sendJson(response, error.statusCode, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        if (error instanceof OrderManagementDataError) {
          sendJson(response, 503, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        sendJson(response, 503, {
          error: {
            code: 'RETURNS_DATA_UNAVAILABLE',
            message: '退货与质量查询暂不可用',
          },
        }, method);
      }
      return;
    }

    if (url.pathname === '/api/product-index') {
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        sendJson(response, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持' },
        }, method);
        return;
      }
      try {
        const index = await loadProductIndexData(productIndexFile, { runtimeEnvironment });
        sendJson(
          response,
          200,
          queryProductIndex(index, url.searchParams),
          method,
          request,
        );
      } catch (error) {
        if (error instanceof ProductIndexQueryError) {
          sendJson(response, error.statusCode, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        if (error instanceof ProductIndexDataError) {
          sendJson(response, 503, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        sendJson(response, 503, {
          error: {
            code: 'PRODUCT_INDEX_UNAVAILABLE',
            message: '商品管理数据暂不可用',
          },
        }, method);
      }
      return;
    }

    if (url.pathname === '/api/orders') {
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        sendJson(response, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不受支持' },
        }, method);
        return;
      }
      try {
        const orderManagement = await loadOrderManagementData(orderManagementFile, {
          runtimeEnvironment,
        });
        sendJson(
          response,
          200,
          queryOrderManagement(orderManagement, url.searchParams),
          method,
          request,
        );
      } catch (error) {
        if (error instanceof OrderManagementQueryError) {
          sendJson(response, error.statusCode, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        if (error instanceof OrderManagementDataError) {
          sendJson(response, 503, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        sendJson(response, 503, {
          error: {
            code: 'ORDER_MANAGEMENT_DATA_UNAVAILABLE',
            message: '订单管理查询暂不可用',
          },
        }, method);
      }
      return;
    }

    if (url.pathname === '/api/platform') {
      try {
        const dashboard = await loadDashboardData(dataFile);
        const projected = projectDashboardForUser(dashboard, signedInUser);
        sendJson(
          response,
          200,
          queryPlatformDashboard(projected, url.searchParams),
          method,
        );
      } catch (error) {
        if (error instanceof PlatformQueryError) {
          sendJson(response, error.statusCode, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        sendJson(response, 503, {
          error: {
            code: 'PLATFORM_DATA_UNAVAILABLE',
            message: '平台动态查询暂不可用',
          },
        }, method);
      }
      return;
    }

    if (url.pathname === '/api/ops') {
      try {
        const dashboard = await loadDashboardData(dataFile);
        const projected = projectDashboardForUser(dashboard, signedInUser);
        sendJson(
          response,
          200,
          queryOpsDashboard(projected, url.searchParams),
          method,
        );
      } catch (error) {
        if (error instanceof OpsQueryError) {
          sendJson(response, error.statusCode, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        sendJson(response, 503, {
          error: {
            code: 'OPS_DATA_UNAVAILABLE',
            message: '运营待办查询暂不可用',
          },
        }, method);
      }
      return;
    }

    if (url.pathname === '/api/system') {
      try {
        const [dashboard, systemHealth] = await Promise.all([
          loadDashboardData(dataFile),
          loadSystemHealthData(systemHealthFile),
        ]);
        const projected = projectDashboardForUser(dashboard, signedInUser);
        sendJson(
          response,
          200,
          querySystemDashboard(projected, systemHealth, url.searchParams),
          method,
          request,
        );
      } catch (error) {
        if (error instanceof SystemQueryError) {
          sendJson(response, error.statusCode, {
            error: { code: error.code, message: error.message },
          }, method);
          return;
        }
        if (error instanceof SystemHealthDataError) {
          sendJson(response, 503, {
            error: { code: error.code, message: '系统运行态快照暂不可用' },
          }, method);
          return;
        }
        sendJson(response, 503, {
          error: {
            code: 'SYSTEM_DATA_UNAVAILABLE',
            message: '系统管理查询暂不可用',
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
