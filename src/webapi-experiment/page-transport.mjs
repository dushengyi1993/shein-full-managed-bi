/**
 * Page-context transport for the isolated WebAPI experiment.
 *
 * The request is performed by the already-authenticated page itself, so the
 * browser attaches its own credentials and this process never reads, exports,
 * serializes or logs a cookie, a storage entry or a request header.
 *
 * The transport closes over one endpoint code. The adapter-supplied method, url
 * and body are compared against the allow-list result for that endpoint, so a
 * caller cannot smuggle in an arbitrary URL, path, method or header.
 */

import {
  WEBAPI_ORIGIN,
  assertReadOnlyMethod,
  describeEndpoint,
  resolveEndpointUrl,
} from './endpoint-allowlist.mjs';
import { validateEndpointRequest } from './schema.mjs';

export const TRANSPORT_REJECT_CODES = Object.freeze({
  SESSION_MISSING: 'WEBAPI_TRANSPORT_SESSION_MISSING',
  METHOD_MISMATCH: 'WEBAPI_TRANSPORT_METHOD_MISMATCH',
  URL_MISMATCH: 'WEBAPI_TRANSPORT_URL_MISMATCH',
  BODY_MISMATCH: 'WEBAPI_TRANSPORT_BODY_MISMATCH',
  HEADER_NOT_ALLOWED: 'WEBAPI_TRANSPORT_HEADER_NOT_ALLOWED',
  ORIGIN_MISMATCH: 'WEBAPI_TRANSPORT_ORIGIN_MISMATCH',
  RESPONSE_TOO_LARGE: 'WEBAPI_TRANSPORT_RESPONSE_TOO_LARGE',
  RESPONSE_NOT_JSON: 'WEBAPI_TRANSPORT_RESPONSE_NOT_JSON',
  RESPONSE_SHAPE_INVALID: 'WEBAPI_TRANSPORT_RESPONSE_SHAPE_INVALID',
  BUSINESS_STATUS_FAILED: 'WEBAPI_TRANSPORT_BUSINESS_STATUS_FAILED',
  AUTH_EXPIRED: 'WEBAPI_TRANSPORT_AUTH_EXPIRED',
  EVALUATE_FAILED: 'WEBAPI_TRANSPORT_EVALUATE_FAILED',
});

export const TRANSPORT_DEFAULT_LIMITS = Object.freeze({
  maxResponseBytes: 512 * 1024,
  requestTimeoutMs: 20_000,
  evaluateTimeoutMs: 25_000,
});

/** HTTP statuses that mean "the persistent login is no longer usable". */
const AUTH_EXPIRED_STATUSES = Object.freeze([401, 403]);

export class WebApiTransportError extends Error {
  constructor(code) {
    super(`webapi experiment transport refused: ${code}`);
    this.name = 'WebApiTransportError';
    this.code = code;
  }
}

function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Build the single in-page expression.
 *
 * The url, method and body are injected as JSON literals of *already validated*
 * values, so no caller string is ever concatenated into executable text. The
 * page returns status, byte length and bounded text only — never headers.
 *
 * `credentials: 'include'` is what keeps the credential inside the browser: the
 * page attaches its own session and no credential value crosses into Node.
 */
export function buildPageFetchExpression({
  origin,
  url,
  method,
  body,
  maxResponseBytes,
  requestTimeoutMs,
}) {
  const originLiteral = JSON.stringify(origin);
  const urlLiteral = JSON.stringify(url);
  const methodLiteral = JSON.stringify(method);
  const bodyLiteral = body === null || body === undefined ? 'null' : JSON.stringify(body);
  return `(async () => {
  try {
    const expectedOrigin = ${originLiteral};
    if (location.origin !== expectedOrigin) {
      return { sameOrigin: false, httpStatus: null, byteLength: 0, bodyText: null };
    }
    const requestBody = ${bodyLiteral};
    const response = await fetch(${urlLiteral}, {
      method: ${methodLiteral},
      credentials: 'include',
      headers: requestBody === null
        ? undefined
        : { 'Content-Type': 'application/json;Charset=utf-8' },
      body: requestBody === null ? undefined : JSON.stringify(requestBody),
      signal: AbortSignal.timeout(${Number(requestTimeoutMs)}),
    });
    const text = await response.text();
    const byteLength = text.length;
    return {
      sameOrigin: true,
      httpStatus: response.status,
      byteLength,
      bodyText: byteLength > ${Number(maxResponseBytes)} ? null : text,
    };
  } catch (error) {
    return { sameOrigin: true, httpStatus: null, byteLength: 0, bodyText: null, failed: true };
  }
})()`;
}

/**
 * @param {object} input
 * @param {{evaluate: Function}} input.session
 * @param {string} input.endpointCode allow-listed endpoint code
 * @param {object} [input.request] the same request the adapter will validate
 * @param {object} [input.limits]
 * @returns {(call: {method: string, url: string, body: unknown}) => Promise<{httpStatus: number, body: unknown}>}
 */
export function createPageContextTransport({
  session,
  endpointCode,
  request = {},
  limits = TRANSPORT_DEFAULT_LIMITS,
} = {}) {
  if (!session || typeof session.evaluate !== 'function') {
    throw new WebApiTransportError(TRANSPORT_REJECT_CODES.SESSION_MISSING);
  }
  const resolvedLimits = { ...TRANSPORT_DEFAULT_LIMITS, ...limits };
  // Resolved once, from the allow-list only, before any evaluation happens.
  const endpoint = describeEndpoint(endpointCode);
  const expectedMethod = assertReadOnlyMethod(endpoint.method);
  const expectedRequest = validateEndpointRequest(endpointCode, request);
  const expectedUrl = resolveEndpointUrl(endpointCode, request);
  const expectedBodyJson = stableJson(expectedRequest.body ?? null);

  return async function pageContextTransport(call = {}) {
    // The adapter is trusted to compute these from the same allow-list, but the
    // comparison makes a divergent or hostile caller impossible to serve.
    if (String(call.method ?? '') !== expectedMethod) {
      throw new WebApiTransportError(TRANSPORT_REJECT_CODES.METHOD_MISMATCH);
    }
    if (String(call.url ?? '') !== expectedUrl) {
      throw new WebApiTransportError(TRANSPORT_REJECT_CODES.URL_MISMATCH);
    }
    if (stableJson(call.body ?? null) !== expectedBodyJson) {
      throw new WebApiTransportError(TRANSPORT_REJECT_CODES.BODY_MISMATCH);
    }
    if (call.headers !== undefined || call.header !== undefined) {
      throw new WebApiTransportError(TRANSPORT_REJECT_CODES.HEADER_NOT_ALLOWED);
    }

    let evaluated;
    try {
      evaluated = await session.evaluate(
        buildPageFetchExpression({
          origin: WEBAPI_ORIGIN,
          url: expectedUrl,
          method: expectedMethod,
          body: expectedRequest.body ?? null,
          maxResponseBytes: resolvedLimits.maxResponseBytes,
          requestTimeoutMs: resolvedLimits.requestTimeoutMs,
        }),
        { timeoutMs: resolvedLimits.evaluateTimeoutMs },
      );
    } catch {
      throw new WebApiTransportError(TRANSPORT_REJECT_CODES.EVALUATE_FAILED);
    }

    if (evaluated?.sameOrigin !== true) {
      throw new WebApiTransportError(TRANSPORT_REJECT_CODES.ORIGIN_MISMATCH);
    }
    if (evaluated?.failed === true || !Number.isSafeInteger(evaluated?.httpStatus)) {
      throw new WebApiTransportError(TRANSPORT_REJECT_CODES.EVALUATE_FAILED);
    }
    if (AUTH_EXPIRED_STATUSES.includes(evaluated.httpStatus)) {
      // Sanitized code only: no SHEIN message, no body, no header.
      throw new WebApiTransportError(TRANSPORT_REJECT_CODES.AUTH_EXPIRED);
    }
    const byteLength = Number.isSafeInteger(evaluated.byteLength) ? evaluated.byteLength : 0;
    if (byteLength > resolvedLimits.maxResponseBytes || evaluated.bodyText === null) {
      // Bounded before parsing: an oversize payload is never materialised.
      throw new WebApiTransportError(TRANSPORT_REJECT_CODES.RESPONSE_TOO_LARGE);
    }

    let parsed;
    try {
      parsed = JSON.parse(String(evaluated.bodyText));
    } catch {
      throw new WebApiTransportError(TRANSPORT_REJECT_CODES.RESPONSE_NOT_JSON);
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new WebApiTransportError(TRANSPORT_REJECT_CODES.RESPONSE_SHAPE_INVALID);
    }
    // Several SHEIN WebAPI routes return HTTP 200 even when the page session is
    // no longer authorized. Inspect the top-level business status before the
    // adapter sees the envelope, but never carry the platform message or body
    // into the error. Code 20302 is the evidenced login-expired status.
    const businessStatus = parsed.code ?? parsed.status;
    if (businessStatus !== null && businessStatus !== undefined) {
      const statusText = String(businessStatus).trim();
      if (statusText === '20302') {
        throw new WebApiTransportError(TRANSPORT_REJECT_CODES.AUTH_EXPIRED);
      }
      if (statusText !== '' && statusText !== '0') {
        throw new WebApiTransportError(TRANSPORT_REJECT_CODES.BUSINESS_STATUS_FAILED);
      }
    }
    // The adapter owns all further shape validation, fingerprinting and the
    // decision to reject an unexpected envelope.
    return { httpStatus: evaluated.httpStatus, body: parsed };
  };
}
