import { fetch as undiciFetch, ProxyAgent } from 'undici';

import { SheinOpenApiError } from './shein-client.mjs';

export const SHEIN_FM_OPENAPI_PROXY_URL = 'SHEIN_FM_OPENAPI_PROXY_URL';
export const SHEIN_FM_OPENAPI_PROXY_REQUIRED = 'SHEIN_FM_OPENAPI_PROXY_REQUIRED';
export const OFFICIAL_OPENAPI_ORIGIN = 'https://openapi.sheincorp.com';

const LOOPBACK_IPV4_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function failProxy(reason) {
  throw new SheinOpenApiError(
    'INVALID_PROXY_CONFIG',
    'SHEIN_FM_OPENAPI_PROXY_URL must be an http(s) loopback proxy URL without credentials, query, hash, or path',
    { reason },
  );
}

function failRequiredProxy() {
  throw new SheinOpenApiError(
    'OPENAPI_PROXY_REQUIRED',
    'SHEIN OpenAPI proxy is required for this runtime',
    { reason: 'PROXY_NOT_CONFIGURED' },
  );
}

function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string') return false;
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (!LOOPBACK_IPV4_PATTERN.test(normalized)) return false;
  return normalized.split('.').slice(1).every((part) => Number(part) <= 255);
}

export function resolveOpenApiProxyConfig(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') failProxy('EXPECTED_STRING');
  if (value.trim() === '') return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    failProxy('INVALID_URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') failProxy('NON_HTTP_SCHEME');
  if (parsed.username !== '' || parsed.password !== '') failProxy('CREDENTIALS_PRESENT');
  if (parsed.search !== '' || parsed.hash !== '') failProxy('QUERY_OR_HASH_PRESENT');
  if (parsed.pathname !== '' && parsed.pathname !== '/') failProxy('NON_EMPTY_PATH');
  if (parsed.hostname === '') failProxy('MISSING_HOST');
  if (!isLoopbackHostname(parsed.hostname)) failProxy('NON_LOOPBACK_HOST');
  if (parsed.port !== '') {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) failProxy('INVALID_PORT');
  }
  return { uri: parsed.origin };
}

export function resolveOpenApiProxyRequired(value) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'string') failProxy('INVALID_REQUIRED_FLAG');
  const normalized = value.trim();
  if (normalized === '' || normalized === '0') return false;
  if (normalized === '1') return true;
  failProxy('INVALID_REQUIRED_FLAG');
}

export function isOfficialOpenApiBaseUrl(baseUrl) {
  try {
    return new URL(String(baseUrl)).origin === OFFICIAL_OPENAPI_ORIGIN;
  } catch {
    return false;
  }
}

export function selectOpenApiTransport({
  baseUrl,
  proxyConfig,
  proxyRequired,
  fetchImpl,
}) {
  if (!isOfficialOpenApiBaseUrl(baseUrl)) {
    return { fetchImpl, dispatcher: undefined, proxied: false };
  }
  const required = resolveOpenApiProxyRequired(proxyRequired);
  if (!proxyConfig) {
    if (required) failRequiredProxy();
    return { fetchImpl, dispatcher: undefined, proxied: false };
  }
  try {
    return {
      fetchImpl: undiciFetch,
      dispatcher: new ProxyAgent(proxyConfig.uri),
      proxied: true,
    };
  } catch (error) {
    throw new SheinOpenApiError(
      'INVALID_PROXY_CONFIG',
      'SHEIN OpenAPI proxy transport could not be initialized',
      { reason: 'TRANSPORT_INIT_FAILED' },
      { cause: error },
    );
  }
}
