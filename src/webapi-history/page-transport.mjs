import {
  HOME_ENDPOINTS,
  HOME_WEBAPI_ORIGIN,
  endpointUrl,
} from './home-contracts.mjs';
import { retryableCdpCode } from './retry-policy.mjs';

export const HOME_TRANSPORT_LIMITS = Object.freeze({
  requestTimeoutMs: 60_000,
  evaluateTimeoutMs: 70_000,
  maxResponseBytes: 8 * 1024 * 1024,
});

export class FullHomeTransportError extends Error {
  constructor(code) {
    super(`full homepage transport refused: ${code}`);
    this.name = 'FullHomeTransportError';
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

function pageFetchExpression({
  url,
  method,
  body,
  requestTimeoutMs,
  maxResponseBytes,
}) {
  return `(async () => {
    try {
      const expectedOrigin = ${JSON.stringify(HOME_WEBAPI_ORIGIN)};
      if (location.origin !== expectedOrigin) {
        return { sameOrigin: false, status: null, byteLength: 0, bodyText: null };
      }
      const response = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        credentials: 'include',
        headers: { 'Content-Type': 'application/json;Charset=utf-8' },
        body: ${JSON.stringify(stableJson(body))},
        signal: AbortSignal.timeout(${Number(requestTimeoutMs)}),
      });
      const text = await response.text();
      return {
        sameOrigin: true,
        status: response.status,
        byteLength: text.length,
        bodyText: text.length > ${Number(maxResponseBytes)} ? null : text,
      };
    } catch {
      return {
        sameOrigin: true,
        status: null,
        byteLength: 0,
        bodyText: null,
        failed: true,
      };
    }
  })()`;
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
  return /未登录|登录失效|login|unauthori[sz]ed|expired/i.test(message);
}

export function createFullHomePageTransport({
  session,
  limits = HOME_TRANSPORT_LIMITS,
} = {}) {
  if (!session || typeof session.evaluate !== 'function') {
    throw new FullHomeTransportError('HOME_TRANSPORT_SESSION_MISSING');
  }
  const resolved = { ...HOME_TRANSPORT_LIMITS, ...limits };

  return async function request(endpointCode, body = {}) {
    const endpoint = HOME_ENDPOINTS[String(endpointCode ?? '')];
    if (!endpoint) throw new FullHomeTransportError('HOME_ENDPOINT_NOT_ALLOWED');
    if (endpoint.method !== 'POST') {
      throw new FullHomeTransportError('HOME_METHOD_NOT_ALLOWED');
    }
    const url = endpointUrl(endpointCode);
    let result;
    try {
      result = await session.evaluate(
        pageFetchExpression({
          url,
          method: endpoint.method,
          body,
          requestTimeoutMs: resolved.requestTimeoutMs,
          maxResponseBytes: resolved.maxResponseBytes,
        }),
        { timeoutMs: resolved.evaluateTimeoutMs },
      );
    } catch (error) {
      if (retryableCdpCode(error?.code)) {
        throw new FullHomeTransportError(error.code);
      }
      throw new FullHomeTransportError('HOME_EVALUATE_FAILED');
    }
    if (result?.sameOrigin !== true) {
      throw new FullHomeTransportError('HOME_ORIGIN_MISMATCH');
    }
    if (result?.failed === true || !Number.isSafeInteger(result?.status)) {
      throw new FullHomeTransportError('HOME_FETCH_FAILED');
    }
    if ([401, 403].includes(result.status)) {
      throw new FullHomeTransportError('HOME_AUTH_EXPIRED');
    }
    if (result.status < 200 || result.status >= 300) {
      throw new FullHomeTransportError('HOME_HTTP_STATUS_FAILED');
    }
    if (
      !Number.isSafeInteger(result.byteLength)
      || result.byteLength < 0
      || result.byteLength > resolved.maxResponseBytes
      || typeof result.bodyText !== 'string'
    ) {
      throw new FullHomeTransportError('HOME_RESPONSE_TOO_LARGE');
    }
    let parsed;
    try {
      parsed = JSON.parse(result.bodyText);
    } catch {
      throw new FullHomeTransportError('HOME_RESPONSE_NOT_JSON');
    }
    if (authExpired(parsed)) {
      throw new FullHomeTransportError('HOME_AUTH_EXPIRED');
    }
    if (!businessSuccess(parsed)) {
      if (
        endpointCode === 'ANALYSE_MODEL'
        && businessCode(parsed) === 'SSO100010'
      ) {
        throw new FullHomeTransportError('HOME_ANALYSE_PERMISSION_DENIED');
      }
      throw new FullHomeTransportError('HOME_BUSINESS_STATUS_FAILED');
    }
    return Object.freeze({
      httpStatus: result.status,
      byteLength: result.byteLength,
      body: parsed,
    });
  };
}
