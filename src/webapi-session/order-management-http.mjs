import {
  ORDER_MANAGEMENT_ENDPOINTS,
  ORDER_MANAGEMENT_TRANSPORT_LIMITS,
  ORDER_MANAGEMENT_WEBAPI_ORIGIN,
  orderManagementEndpointUrl,
} from '../webapi-history/order-management-contracts.mjs';
import {
  cookieHeaderForUrl,
  mergeSetCookieHeaders,
  responseSetCookieHeaders,
  sessionExpirySummary,
} from './cookie-jar.mjs';
import { normalizeWebApiSessionBundle } from './encrypted-session-store.mjs';

const ORDER_MANAGEMENT_REFERER = `${ORDER_MANAGEMENT_WEBAPI_ORIGIN}/#/pfmp/order-management/delivery/order/list`;

export class OrderManagementTransportError extends Error {
  constructor(code) {
    super(`order-management session HTTP refused: ${code}`);
    this.name = 'OrderManagementTransportError';
    this.code = code;
  }
}

function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function businessSuccess(body) {
  const code = body?.code;
  return code === undefined || code === null || code === 0 || code === '0';
}

function businessCode(body) {
  const code = body?.code ?? body?.error?.code;
  return String(code ?? '').trim().toUpperCase();
}

function authExpired(body) {
  const message = `${body?.msg ?? ''} ${body?.message ?? ''}`;
  return /\u672a\u767b\u5f55|\u767b\u5f55\u5931\u6548|login|unauthori[sz]ed|expired/i.test(message)
    || businessCode(body) === '20302';
}

function parseBodyText(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new OrderManagementTransportError('ORDER_MANAGEMENT_RESPONSE_NOT_JSON');
  }
  if (authExpired(parsed)) throw new OrderManagementTransportError('ORDER_MANAGEMENT_AUTH_EXPIRED');
  if (!businessSuccess(parsed)) {
    throw new OrderManagementTransportError('ORDER_MANAGEMENT_BUSINESS_STATUS_FAILED');
  }
  return parsed;
}

function pathValue(source, path) {
  let cursor = source;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, key)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * Open a session-scoped HTTP channel restricted to the fixed POST endpoints
 * of the order-management contract on sso.geiwohuo.com.
 */
export async function openOrderManagementHttpSession({
  storeCode,
  sessionStore,
  fetchImpl = fetch,
  clock = () => new Date(),
  limits = ORDER_MANAGEMENT_TRANSPORT_LIMITS,
} = {}) {
  if (!sessionStore || typeof sessionStore.read !== 'function' || typeof sessionStore.write !== 'function') {
    throw new OrderManagementTransportError('ORDER_MANAGEMENT_HTTP_SESSION_STORE_MISSING');
  }
  const canonical = String(storeCode ?? '').trim().toUpperCase();
  let bundle = normalizeWebApiSessionBundle(await sessionStore.read(canonical), canonical);
  const resolvedLimits = { ...ORDER_MANAGEMENT_TRANSPORT_LIMITS, ...limits };
  let commitQueue = Promise.resolve();
  let closed = false;
  let dirty = false;

  function enqueueBundleUpdate(update) {
    commitQueue = commitQueue.then(async () => {
      bundle = normalizeWebApiSessionBundle(await update(bundle), canonical);
      dirty = true;
    });
    return commitQueue;
  }

  async function request(endpointCode, body = {}) {
    if (closed) throw new OrderManagementTransportError('ORDER_MANAGEMENT_HTTP_SESSION_CLOSED');
    const endpoint = ORDER_MANAGEMENT_ENDPOINTS[String(endpointCode ?? '')];
    if (!endpoint) throw new OrderManagementTransportError('ORDER_MANAGEMENT_ENDPOINT_NOT_ALLOWED');
    if (endpoint.method !== 'POST') throw new OrderManagementTransportError('ORDER_MANAGEMENT_METHOD_NOT_ALLOWED');
    const url = orderManagementEndpointUrl(endpointCode);
    const cookieHeader = cookieHeaderForUrl(bundle, url, clock());
    if (!cookieHeader) throw new OrderManagementTransportError('ORDER_MANAGEMENT_AUTH_EXPIRED');
    let response;
    try {
      response = await fetchImpl(url, {
        method: endpoint.method,
        redirect: 'manual',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Content-Type': 'application/json;Charset=utf-8',
          Origin: ORDER_MANAGEMENT_WEBAPI_ORIGIN,
          Referer: ORDER_MANAGEMENT_REFERER,
          'User-Agent': bundle.userAgent,
          Cookie: cookieHeader,
        },
        body: stableJson(body),
        signal: AbortSignal.timeout(resolvedLimits.requestTimeoutMs),
      });
    } catch {
      throw new OrderManagementTransportError('ORDER_MANAGEMENT_FETCH_FAILED');
    }
    const setCookieValues = responseSetCookieHeaders(response.headers);
    if (setCookieValues.length > 0) {
      await enqueueBundleUpdate((current) => mergeSetCookieHeaders(
        current,
        url,
        setCookieValues,
        clock(),
      ));
    }
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) {
      throw new OrderManagementTransportError('ORDER_MANAGEMENT_AUTH_EXPIRED');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new OrderManagementTransportError('ORDER_MANAGEMENT_HTTP_STATUS_FAILED');
    }
    let bodyText;
    try {
      bodyText = await response.text();
    } catch {
      throw new OrderManagementTransportError('ORDER_MANAGEMENT_FETCH_FAILED');
    }
    const byteLength = Buffer.byteLength(bodyText, 'utf8');
    if (byteLength > resolvedLimits.maxResponseBytes) {
      throw new OrderManagementTransportError('ORDER_MANAGEMENT_RESPONSE_TOO_LARGE');
    }
    const parsed = parseBodyText(bodyText);
    await enqueueBundleUpdate((current) => ({
      ...current,
      updatedAt: clock().toISOString(),
      lastVerifiedAt: clock().toISOString(),
    }));
    return Object.freeze({
      httpStatus: response.status,
      byteLength,
      body: parsed,
    });
  }

  async function close() {
    if (closed) return { closed: false };
    closed = true;
    await commitQueue;
    if (dirty) await sessionStore.write(canonical, bundle);
    return { closed: true };
  }

  return Object.freeze({
    storeCode: canonical,
    sessionState: 'ACTIVE',
    identityProven: true,
    transportKind: 'SESSION_HTTP',
    request,
    close,
    expiry: () => sessionExpirySummary(bundle, clock()),
  });
}

/**
 * Minimal transport used by the sync pipeline: only the fixed POST endpoints
 * of the order-management contract are reachable.
 */
export function createOrderManagementHttpTransport({ session } = {}) {
  if (!session || typeof session.request !== 'function') {
    throw new OrderManagementTransportError('ORDER_MANAGEMENT_HTTP_SESSION_MISSING');
  }
  return Object.freeze({
    fetch(endpointCode, body) {
      return session.request(endpointCode, body);
    },
    close() {
      return session.close();
    },
    expiry() {
      return session.expiry();
    },
  });
}

/**
 * Resolve the verified total / rows of a response for an endpoint.  Returns
 * null when the platform response does not carry the expected shape so the
 * caller can fail the total gate closed.
 */
export function orderManagementResponseReader(endpointCode, responseBody) {
  const endpoint = ORDER_MANAGEMENT_ENDPOINTS[String(endpointCode ?? '')];
  if (!endpoint) throw new OrderManagementTransportError('ORDER_MANAGEMENT_ENDPOINT_NOT_ALLOWED');
  const body = responseBody?.body ?? responseBody;
  const total = endpoint.totalPath ? pathValue(body, endpoint.totalPath) : null;
  const rows = endpoint.rowsPath ? pathValue(body, endpoint.rowsPath) : null;
  return Object.freeze({
    total: typeof total === 'number' && Number.isSafeInteger(total) ? total : null,
    rows: Array.isArray(rows) ? rows : null,
  });
}
