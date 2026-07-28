import { createHash } from 'node:crypto';

import {
  WEBAPI_REQUEST_SHAPES,
  WEBAPI_RESPONSE_SHAPES,
  WebApiContractError,
  describeEndpoint,
} from './endpoint-allowlist.mjs';

/**
 * Shape and fingerprint helpers.
 *
 * `schemaShape` keeps only key names and value *types*, so a schema hash never
 * embeds a business value. `payloadFingerprint` is an opaque digest used to tell
 * two payloads apart without persisting either of them.
 */

function stableStringify(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function schemaShape(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    const memberShapes = [...new Set(value.map((item) => stableStringify(schemaShape(item))))]
      .sort();
    return { array: memberShapes };
  }
  if (typeof value === 'object') {
    const shape = {};
    for (const key of Object.keys(value).sort()) {
      shape[key] = schemaShape(value[key]);
    }
    return shape;
  }
  return typeof value;
}

export function schemaHash(value) {
  return createHash('sha256').update(stableStringify(schemaShape(value)), 'utf8').digest('hex');
}

export function payloadFingerprint(value) {
  return createHash('sha256').update(stableStringify(value ?? null), 'utf8').digest('hex');
}

function requireIntegerArray(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new WebApiContractError(
      'WEBAPI_REQUEST_SHAPE_INVALID',
      `${field} must be a bounded non-empty integer array`,
      { field },
    );
  }
  for (const item of value) {
    if (!Number.isSafeInteger(item) || item <= 0 || item > 1_000_000) {
      throw new WebApiContractError(
        'WEBAPI_REQUEST_SHAPE_INVALID',
        `${field} must contain positive platform metric ids`,
        { field },
      );
    }
  }
  return [...value];
}

export function validateEndpointRequest(endpointCode, request = {}) {
  const endpoint = describeEndpoint(endpointCode);
  switch (endpoint.requestShape) {
    case WEBAPI_REQUEST_SHAPES.NONE:
      return Object.freeze({ shape: endpoint.requestShape, body: null });
    case WEBAPI_REQUEST_SHAPES.EMPTY_OBJECT:
      return Object.freeze({ shape: endpoint.requestShape, body: Object.freeze({}) });
    case WEBAPI_REQUEST_SHAPES.TEMPLATE_TYPE_QUERY: {
      const templateType = request?.templateType;
      if (!Number.isSafeInteger(templateType) || templateType < 0 || templateType > 9999) {
        throw new WebApiContractError(
          'WEBAPI_TEMPLATE_TYPE_INVALID',
          'templateType must be a small non-negative integer',
        );
      }
      return Object.freeze({ shape: endpoint.requestShape, body: null, templateType });
    }
    case WEBAPI_REQUEST_SHAPES.META_INDEX_IDS:
      return Object.freeze({
        shape: endpoint.requestShape,
        body: Object.freeze({
          metaIndexIds: requireIntegerArray(request?.metaIndexIds, 'metaIndexIds'),
        }),
      });
    case WEBAPI_REQUEST_SHAPES.META_INDEX_IDS_WITH_TEMPLATE: {
      const templateType = request?.templateType;
      if (!Number.isSafeInteger(templateType) || templateType < 0 || templateType > 9999) {
        throw new WebApiContractError(
          'WEBAPI_TEMPLATE_TYPE_INVALID',
          'templateType must be a small non-negative integer',
        );
      }
      return Object.freeze({
        shape: endpoint.requestShape,
        body: Object.freeze({
          metaIndexIds: requireIntegerArray(request?.metaIndexIds, 'metaIndexIds'),
          templateType,
        }),
      });
    }
    default:
      throw new WebApiContractError(
        'WEBAPI_REQUEST_SHAPE_INVALID',
        'unhandled request shape',
      );
  }
}

function requireList(response, endpointCode) {
  const list = Array.isArray(response) ? response : response?.list ?? response?.data;
  if (!Array.isArray(list)) {
    throw new WebApiContractError(
      'WEBAPI_RESPONSE_SHAPE_INVALID',
      'response must expose a bounded list',
      { endpointCode },
    );
  }
  if (list.length > 500) {
    throw new WebApiContractError(
      'WEBAPI_RESPONSE_TOO_LARGE',
      'response list exceeds the experiment bound',
      { endpointCode },
    );
  }
  return list;
}

/**
 * Validate the response envelope shape only.
 *
 * Field *meanings* are deliberately not interpreted: no Chinese label, metric
 * semantic or currency meaning is invented here.
 */
export function validateEndpointResponse(endpointCode, response) {
  const endpoint = describeEndpoint(endpointCode);
  if (response === null || response === undefined) {
    throw new WebApiContractError(
      'WEBAPI_RESPONSE_SHAPE_INVALID',
      'response body is required',
      { endpointCode },
    );
  }
  if (endpoint.responseShape === WEBAPI_RESPONSE_SHAPES.PERMISSION_DESCRIPTOR) {
    const descriptor = Array.isArray(response) ? response[0] : response?.data ?? response;
    if (!descriptor || typeof descriptor !== 'object') {
      throw new WebApiContractError(
        'WEBAPI_RESPONSE_SHAPE_INVALID',
        'permission descriptor must be an object',
        { endpointCode },
      );
    }
    return Object.freeze({ shape: endpoint.responseShape, rows: Object.freeze([]) });
  }

  const list = requireList(response, endpointCode);
  if (endpoint.responseShape === WEBAPI_RESPONSE_SHAPES.META_INDEX_CATALOG) {
    const seenMetaIndexIds = new Set();
    const rows = list.map((item, index) => {
      const metaIndexId = typeof item === 'object' && item !== null
        ? item.metaIndexId
        : item;
      // Bounded to match the request contract and the database check.
      if (
        !Number.isSafeInteger(metaIndexId)
        || metaIndexId <= 0
        || metaIndexId > 1_000_000
      ) {
        throw new WebApiContractError(
          'WEBAPI_RESPONSE_SHAPE_INVALID',
          'metaIndexId must be a bounded positive integer',
          { endpointCode, index },
        );
      }
      if (seenMetaIndexIds.has(metaIndexId)) {
        throw new WebApiContractError(
          'WEBAPI_RESPONSE_DUPLICATE_METRIC',
          'metaIndexId is duplicated in the response',
          { endpointCode, index },
        );
      }
      seenMetaIndexIds.add(metaIndexId);
      return Object.freeze({ metaIndexId });
    });
    return Object.freeze({ shape: endpoint.responseShape, rows: Object.freeze(rows) });
  }

  const seenMetricKeys = new Set();
  const rows = list.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new WebApiContractError(
        'WEBAPI_RESPONSE_SHAPE_INVALID',
        'metric row must be an object',
        { endpointCode, index },
      );
    }
    if (
      !Number.isSafeInteger(item.metaIndexId)
      || item.metaIndexId <= 0
      || item.metaIndexId > 1_000_000
    ) {
      throw new WebApiContractError(
        'WEBAPI_RESPONSE_SHAPE_INVALID',
        'metric row requires a bounded positive metaIndexId',
        { endpointCode, index },
      );
    }
    if (typeof item.code !== 'string' || item.code.trim() === '') {
      throw new WebApiContractError(
        'WEBAPI_RESPONSE_SHAPE_INVALID',
        'metric row requires a platform code',
        { endpointCode, index },
      );
    }
    const metricKey = `${item.metaIndexId}\x1f${item.code.trim()}`;
    if (seenMetricKeys.has(metricKey)) {
      throw new WebApiContractError(
        'WEBAPI_RESPONSE_DUPLICATE_METRIC',
        'metric row is duplicated in the response',
        { endpointCode, index },
      );
    }
    seenMetricKeys.add(metricKey);
    return Object.freeze({
      metaIndexId: item.metaIndexId,
      code: item.code.trim(),
      // `count` stays exactly as received so strict Decimal validation can run
      // downstream. It is never coerced here.
      count: item.count,
      currency: typeof item.currency === 'string' ? item.currency.trim() : null,
      updateTime: typeof item.updateTime === 'string' ? item.updateTime : null,
      cacheStartTime: typeof item.cacheStartTime === 'string' ? item.cacheStartTime : null,
    });
  });
  return Object.freeze({ shape: endpoint.responseShape, rows: Object.freeze(rows) });
}
