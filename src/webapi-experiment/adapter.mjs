import {
  WebApiContractError,
  assertReadOnlyMethod,
  describeEndpoint,
  resolveEndpointUrl,
} from './endpoint-allowlist.mjs';
import {
  payloadFingerprint,
  schemaHash,
  schemaPathCatalog,
  validateEndpointRequest,
  validateEndpointResponse,
} from './schema.mjs';
import { buildUnmappedObservations, assertNoFormalProjection } from './observation.mjs';
import { resolveProfileKey } from './profile-guard.mjs';
import { toSanitizedErrorCode } from './redaction.mjs';

export const EXPERIMENT_GATE_LABEL = 'EXPERIMENT_ONLY';

export const BATCH_RESULT_STATUSES = Object.freeze({
  SCHEMA_ONLY: 'SCHEMA_ONLY',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
});

export const MAX_DISCOVERED_META_INDEX_IDS = 500;

const NO_DISCOVERED_IDS = Object.freeze([]);

/**
 * Technical platform metric ids observed on a catalog endpoint.
 *
 * These are opaque integers used to plan a later, human-reviewed metric-detail
 * stage. A value endpoint always returns an empty list, and no label, caliber or
 * metric value is ever derived here.
 */
function discoveredMetaIndexIdsFor(endpoint, validatedResponse) {
  if (endpoint.carriesMetricValues !== false) return NO_DISCOVERED_IDS;
  const ids = [...new Set(
    (validatedResponse?.rows ?? [])
      .map((row) => row?.metaIndexId)
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  )].sort((left, right) => left - right);
  return Object.freeze(ids.slice(0, MAX_DISCOVERED_META_INDEX_IDS));
}

/**
 * Schema-only, dependency-injected WebAPI experiment adapter.
 *
 * The adapter owns no transport. Without an explicitly injected read-only
 * transport it cannot reach the network at all, and it reports `BLOCKED` instead
 * of pretending an empty success. It validates the request and response shapes,
 * computes safe fingerprints, applies strict Decimal validation, records every
 * metric as `UNMAPPED`, and refuses any formal projection.
 */
export function createWebApiExperimentAdapter({
  storeCode,
  transport = null,
  clock = () => new Date(),
} = {}) {
  const profileKey = resolveProfileKey(storeCode);
  const canonicalStoreCode = String(storeCode).trim().toUpperCase();

  async function probeEndpoint(endpointCode, request = {}, options = {}) {
    const endpoint = describeEndpoint(endpointCode);
    const method = assertReadOnlyMethod(endpoint.method);
    const validatedRequest = validateEndpointRequest(endpointCode, request);
    const url = resolveEndpointUrl(endpointCode, request);
    const requestedAt = clock().toISOString();
    const requestSchemaHash = schemaHash({
      method,
      path: endpoint.path,
      shape: validatedRequest.shape,
      body: validatedRequest.body,
    });
    const requestFingerprint = payloadFingerprint({
      endpointCode,
      templateType: validatedRequest.templateType ?? null,
      body: validatedRequest.body,
    });
    const batchKey = payloadFingerprint({
      storeCode: canonicalStoreCode,
      endpointCode,
      requestFingerprint,
      requestedAt,
    });

    const baseBatch = {
      batchKey,
      storeCode: canonicalStoreCode,
      profileKey,
      endpointCode,
      httpMethod: method,
      requestSchemaHash,
      requestFingerprint,
      requestedAt,
      experimentGate: EXPERIMENT_GATE_LABEL,
    };

    if (typeof transport !== 'function') {
      return Object.freeze({
        batch: Object.freeze({
          ...baseBatch,
          completedAt: null,
          httpStatus: null,
          responseSchemaHash: null,
          payloadFingerprint: null,
          resultStatus: BATCH_RESULT_STATUSES.BLOCKED,
          observationCount: 0,
          rejectedCount: 0,
          sanitizedErrorCode: 'WEBAPI_TRANSPORT_NOT_CONFIGURED',
        }),
        observations: Object.freeze([]),
        rejected: Object.freeze([]),
        illegalDecimalCount: 0,
        unknownMetricCount: 0,
        discoveredMetaIndexIds: NO_DISCOVERED_IDS,
        responseSchemaPaths: NO_DISCOVERED_IDS,
      });
    }

    let transportResult = null;
    try {
      transportResult = await transport({
        method,
        url,
        // Only the validated body shape is forwarded. No header, Cookie or token
        // is constructed, accepted or logged by this adapter.
        body: validatedRequest.body,
      });
    } catch (error) {
      return Object.freeze({
        batch: Object.freeze({
          ...baseBatch,
          completedAt: clock().toISOString(),
          httpStatus: null,
          responseSchemaHash: null,
          payloadFingerprint: null,
          resultStatus: BATCH_RESULT_STATUSES.FAILED,
          observationCount: 0,
          rejectedCount: 0,
          sanitizedErrorCode: toSanitizedErrorCode(error?.code, 'WEBAPI_TRANSPORT_FAILED'),
        }),
        observations: Object.freeze([]),
        rejected: Object.freeze([]),
        illegalDecimalCount: 0,
        unknownMetricCount: 0,
        discoveredMetaIndexIds: NO_DISCOVERED_IDS,
        responseSchemaPaths: NO_DISCOVERED_IDS,
      });
    }

    const responseSchemaPaths = schemaPathCatalog(transportResult?.body ?? null);
    const httpStatus = Number.isSafeInteger(transportResult?.httpStatus)
      ? transportResult.httpStatus
      : null;
    if (httpStatus !== 200) {
      return Object.freeze({
        batch: Object.freeze({
          ...baseBatch,
          completedAt: clock().toISOString(),
          httpStatus,
          responseSchemaHash: null,
          payloadFingerprint: null,
          resultStatus: BATCH_RESULT_STATUSES.FAILED,
          observationCount: 0,
          rejectedCount: 0,
          sanitizedErrorCode: 'WEBAPI_HTTP_STATUS_UNEXPECTED',
        }),
        observations: Object.freeze([]),
        rejected: Object.freeze([]),
        illegalDecimalCount: 0,
        unknownMetricCount: 0,
        discoveredMetaIndexIds: NO_DISCOVERED_IDS,
        responseSchemaPaths,
      });
    }

    let validatedResponse = null;
    try {
      validatedResponse = validateEndpointResponse(endpointCode, transportResult?.body);
    } catch (error) {
      return Object.freeze({
        batch: Object.freeze({
          ...baseBatch,
          completedAt: clock().toISOString(),
          httpStatus,
          responseSchemaHash: schemaHash(transportResult?.body ?? null),
          payloadFingerprint: null,
          resultStatus: BATCH_RESULT_STATUSES.FAILED,
          observationCount: 0,
          rejectedCount: 0,
          sanitizedErrorCode: toSanitizedErrorCode(error?.code, 'WEBAPI_RESPONSE_SHAPE_INVALID'),
        }),
        observations: Object.freeze([]),
        rejected: Object.freeze([]),
        illegalDecimalCount: 0,
        unknownMetricCount: 0,
        discoveredMetaIndexIds: NO_DISCOVERED_IDS,
        responseSchemaPaths,
      });
    }

    const observedAt = clock().toISOString();
    let projection;
    try {
      projection = buildUnmappedObservations({
        endpointCode,
        storeCode: canonicalStoreCode,
        rows: validatedResponse.rows,
        observedAt,
        businessDate: options.businessDate ?? null,
        definitions: options.definitions ?? [],
      });
      assertNoFormalProjection(projection.observations, {
        definitions: options.definitions ?? [],
      });
    } catch (error) {
      return Object.freeze({
        batch: Object.freeze({
          ...baseBatch,
          completedAt: observedAt,
          httpStatus,
          responseSchemaHash: schemaHash(transportResult?.body ?? null),
          payloadFingerprint: payloadFingerprint(transportResult?.body ?? null),
          resultStatus: BATCH_RESULT_STATUSES.FAILED,
          observationCount: 0,
          rejectedCount: 0,
          sanitizedErrorCode: toSanitizedErrorCode(
            error?.code,
            'WEBAPI_OBSERVATION_CONTRACT_INVALID',
          ),
        }),
        observations: Object.freeze([]),
        rejected: Object.freeze([]),
        illegalDecimalCount: 0,
        unknownMetricCount: 0,
        discoveredMetaIndexIds: NO_DISCOVERED_IDS,
        responseSchemaPaths,
      });
    }

    return Object.freeze({
      batch: Object.freeze({
        ...baseBatch,
        completedAt: observedAt,
        httpStatus,
        responseSchemaHash: schemaHash(transportResult?.body ?? null),
        payloadFingerprint: payloadFingerprint(transportResult?.body ?? null),
        resultStatus: BATCH_RESULT_STATUSES.SCHEMA_ONLY,
        observationCount: projection.observations.length,
        rejectedCount: projection.rejected.length,
        sanitizedErrorCode: null,
      }),
      observations: projection.observations,
      rejected: projection.rejected,
      illegalDecimalCount: projection.illegalDecimalCount,
      unknownMetricCount: projection.unknownMetricCount,
      // Technical ids only, so a reviewed metric-detail stage can be planned
      // explicitly. Never a label, a caliber or a metric value.
      discoveredMetaIndexIds: discoveredMetaIndexIdsFor(endpoint, validatedResponse),
      responseSchemaPaths,
    });
  }

  return Object.freeze({
    storeCode: canonicalStoreCode,
    profileKey,
    hasTransport: typeof transport === 'function',
    probeEndpoint,
    async fetchWindow() {
      // The experiment can never satisfy a formal backfill window.
      throw new WebApiContractError(
        'WEBAPI_EXPERIMENT_ONLY',
        'the WebAPI experiment cannot supply a formal backfill window',
      );
    },
  });
}
