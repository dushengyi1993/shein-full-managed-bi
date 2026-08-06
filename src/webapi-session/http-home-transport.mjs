import {
  HOME_ENDPOINTS,
  HOME_WEBAPI_ORIGIN,
  endpointUrl,
} from '../webapi-history/home-contracts.mjs';
import {
  FullHomeTransportError,
  HOME_TRANSPORT_LIMITS,
} from '../webapi-history/page-transport.mjs';
import {
  cookieHeaderForUrl,
  mergeSetCookieHeaders,
  responseSetCookieHeaders,
  sessionExpirySummary,
} from './cookie-jar.mjs';
import { normalizeWebApiSessionBundle } from './encrypted-session-store.mjs';

const HOME_REFERER = `${HOME_WEBAPI_ORIGIN}/#/gsp/home`;

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

function parseBodyText(bodyText, endpointCode) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new FullHomeTransportError('HOME_RESPONSE_NOT_JSON');
  }
  if (authExpired(parsed)) throw new FullHomeTransportError('HOME_AUTH_EXPIRED');
  if (!businessSuccess(parsed)) {
    if (endpointCode === 'ANALYSE_MODEL' && businessCode(parsed) === 'SSO100010') {
      throw new FullHomeTransportError('HOME_ANALYSE_PERMISSION_DENIED');
    }
    throw new FullHomeTransportError('HOME_BUSINESS_STATUS_FAILED');
  }
  return parsed;
}

export async function openFullHomeHttpSession({
  storeCode,
  sessionStore,
  fetchImpl = fetch,
  clock = () => new Date(),
  limits = HOME_TRANSPORT_LIMITS,
} = {}) {
  if (!sessionStore || typeof sessionStore.read !== 'function' || typeof sessionStore.write !== 'function') {
    throw new FullHomeTransportError('HOME_HTTP_SESSION_STORE_MISSING');
  }
  const canonical = String(storeCode ?? '').trim().toUpperCase();
  let bundle = normalizeWebApiSessionBundle(await sessionStore.read(canonical), canonical);
  const resolvedLimits = { ...HOME_TRANSPORT_LIMITS, ...limits };
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
    if (closed) throw new FullHomeTransportError('HOME_HTTP_SESSION_CLOSED');
    const endpoint = HOME_ENDPOINTS[String(endpointCode ?? '')];
    if (!endpoint) throw new FullHomeTransportError('HOME_ENDPOINT_NOT_ALLOWED');
    if (endpoint.method !== 'POST') throw new FullHomeTransportError('HOME_METHOD_NOT_ALLOWED');
    const url = endpointUrl(endpointCode);
    const cookieHeader = cookieHeaderForUrl(bundle, url, clock());
    if (!cookieHeader) throw new FullHomeTransportError('HOME_AUTH_EXPIRED');
    let response;
    try {
      response = await fetchImpl(url, {
        method: endpoint.method,
        redirect: 'manual',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Content-Type': 'application/json;Charset=utf-8',
          Origin: HOME_WEBAPI_ORIGIN,
          Referer: HOME_REFERER,
          'User-Agent': bundle.userAgent,
          Cookie: cookieHeader,
        },
        body: stableJson(body),
        signal: AbortSignal.timeout(resolvedLimits.requestTimeoutMs),
      });
    } catch {
      throw new FullHomeTransportError('HOME_FETCH_FAILED');
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
      throw new FullHomeTransportError('HOME_AUTH_EXPIRED');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new FullHomeTransportError('HOME_HTTP_STATUS_FAILED');
    }
    let bodyText;
    try {
      bodyText = await response.text();
    } catch {
      throw new FullHomeTransportError('HOME_FETCH_FAILED');
    }
    const byteLength = Buffer.byteLength(bodyText, 'utf8');
    if (byteLength > resolvedLimits.maxResponseBytes) {
      throw new FullHomeTransportError('HOME_RESPONSE_TOO_LARGE');
    }
    const parsed = parseBodyText(bodyText, endpointCode);
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

export function createFullHomeHttpTransport({ session } = {}) {
  if (!session || typeof session.request !== 'function') {
    throw new FullHomeTransportError('HOME_HTTP_SESSION_MISSING');
  }
  return (endpointCode, body) => session.request(endpointCode, body);
}
