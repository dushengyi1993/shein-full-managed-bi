/**
 * Read-only WebAPI endpoint allow-list.
 *
 * Only the five already-evidenced full-managed homepage read endpoints may be
 * requested. There is no generic request builder, no path parameter and no
 * write method, so an unevidenced route cannot be reached from this module.
 */

export const WEBAPI_ORIGIN = 'https://sso.geiwohuo.com';

export const WEBAPI_REQUEST_SHAPES = Object.freeze({
  NONE: 'NONE',
  TEMPLATE_TYPE_QUERY: 'TEMPLATE_TYPE_QUERY',
  META_INDEX_IDS: 'META_INDEX_IDS',
  META_INDEX_IDS_WITH_TEMPLATE: 'META_INDEX_IDS_WITH_TEMPLATE',
  EMPTY_OBJECT: 'EMPTY_OBJECT',
});

export const WEBAPI_RESPONSE_SHAPES = Object.freeze({
  META_INDEX_CATALOG: 'META_INDEX_CATALOG',
  REALTIME_METRIC_LIST: 'REALTIME_METRIC_LIST',
  OPERATION_METRIC_LIST: 'OPERATION_METRIC_LIST',
  PERMISSION_DESCRIPTOR: 'PERMISSION_DESCRIPTOR',
});

const ENDPOINTS = Object.freeze([
  Object.freeze({
    endpointCode: 'HOME_DATA_OVERVIEW_LIST',
    method: 'GET',
    path: '/sso/homePage/dataOverview/list',
    requestShape: WEBAPI_REQUEST_SHAPES.NONE,
    responseShape: WEBAPI_RESPONSE_SHAPES.META_INDEX_CATALOG,
    carriesMetricValues: false,
  }),
  Object.freeze({
    endpointCode: 'HOME_TEMPLATE_LIST',
    method: 'GET',
    path: '/sso/homePage/v2/list',
    requestShape: WEBAPI_REQUEST_SHAPES.TEMPLATE_TYPE_QUERY,
    responseShape: WEBAPI_RESPONSE_SHAPES.META_INDEX_CATALOG,
    carriesMetricValues: false,
  }),
  Object.freeze({
    endpointCode: 'HOME_DATA_OVERVIEW_DETAIL',
    method: 'POST',
    path: '/sso/homePage/dataOverview/v2/detail',
    requestShape: WEBAPI_REQUEST_SHAPES.META_INDEX_IDS,
    responseShape: WEBAPI_RESPONSE_SHAPES.REALTIME_METRIC_LIST,
    carriesMetricValues: true,
  }),
  Object.freeze({
    endpointCode: 'HOME_V4_DETAIL',
    method: 'POST',
    path: '/sso/homePage/v4/detail',
    requestShape: WEBAPI_REQUEST_SHAPES.META_INDEX_IDS_WITH_TEMPLATE,
    responseShape: WEBAPI_RESPONSE_SHAPES.OPERATION_METRIC_LIST,
    carriesMetricValues: true,
  }),
  Object.freeze({
    endpointCode: 'HOME_KEY_INDICATOR_TRENDS',
    method: 'POST',
    path: '/sso/homePage/key/indicator/keyAndTrends',
    requestShape: WEBAPI_REQUEST_SHAPES.EMPTY_OBJECT,
    responseShape: WEBAPI_RESPONSE_SHAPES.PERMISSION_DESCRIPTOR,
    // Permission/navigation description only. It is not a metric value source.
    carriesMetricValues: false,
  }),
]);

export const WEBAPI_ENDPOINTS = Object.freeze(
  Object.fromEntries(ENDPOINTS.map((entry) => [entry.endpointCode, entry])),
);

export const WEBAPI_ENDPOINT_CODES = Object.freeze(
  ENDPOINTS.map((entry) => entry.endpointCode),
);

export const WEBAPI_ALLOWED_PATHS = Object.freeze(ENDPOINTS.map((entry) => entry.path));

export class WebApiContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WebApiContractError';
    this.code = code;
    this.details = details;
  }
}

export function describeEndpoint(endpointCode) {
  const endpoint = WEBAPI_ENDPOINTS[String(endpointCode ?? '')];
  if (!endpoint) {
    throw new WebApiContractError(
      'WEBAPI_ENDPOINT_NOT_ALLOWED',
      'endpoint is outside the evidenced read-only allow-list',
      { endpointCode: String(endpointCode ?? '') },
    );
  }
  return endpoint;
}

/**
 * Build the absolute request URL from the allow-list only.
 *
 * The caller never supplies a path. Query support is limited to the single
 * evidenced `templateType` integer.
 */
export function resolveEndpointUrl(endpointCode, request = {}) {
  const endpoint = describeEndpoint(endpointCode);
  if (endpoint.requestShape !== WEBAPI_REQUEST_SHAPES.TEMPLATE_TYPE_QUERY) {
    return `${WEBAPI_ORIGIN}${endpoint.path}`;
  }
  const templateType = request?.templateType;
  if (!Number.isSafeInteger(templateType) || templateType < 0 || templateType > 9999) {
    throw new WebApiContractError(
      'WEBAPI_TEMPLATE_TYPE_INVALID',
      'templateType must be a small non-negative integer',
    );
  }
  return `${WEBAPI_ORIGIN}${endpoint.path}?templateType=${templateType}`;
}

export function assertReadOnlyMethod(method) {
  const normalized = String(method ?? '').toUpperCase();
  if (normalized !== 'GET' && normalized !== 'POST') {
    throw new WebApiContractError(
      'WEBAPI_METHOD_NOT_ALLOWED',
      'only evidenced read GET/POST endpoints may be requested',
      { method: normalized },
    );
  }
  return normalized;
}
