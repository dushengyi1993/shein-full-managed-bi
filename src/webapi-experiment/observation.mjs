import { createHash } from 'node:crypto';

import { parseStrictDecimalString } from './decimal.mjs';
import { WebApiContractError, describeEndpoint } from './endpoint-allowlist.mjs';

export const SEMANTIC_STATUSES = Object.freeze({
  UNMAPPED: 'UNMAPPED',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
});

const METRIC_CODE_PATTERN = /^[A-Z]{2,8}[0-9]{4,10}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isoInstant(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function observationKey(parts) {
  return createHash('sha256').update(parts.join('\x1f'), 'utf8').digest('hex');
}

/**
 * Project validated rows into `UNMAPPED` observations.
 *
 * Nothing here assigns a business meaning. A metric without a verified,
 * versioned definition stays `UNMAPPED`; an unusable value becomes `REJECTED`
 * and its raw text is deliberately dropped so an illegal payload is never
 * persisted.
 */
export function buildUnmappedObservations({
  endpointCode,
  storeCode,
  rows,
  observedAt,
  businessDate = null,
  definitions = [],
} = {}) {
  const endpoint = describeEndpoint(endpointCode);
  const observedAtIso = isoInstant(observedAt);
  if (observedAtIso === null) {
    throw new WebApiContractError(
      'WEBAPI_OBSERVED_AT_INVALID',
      'observedAt must be a valid instant',
    );
  }
  if (businessDate !== null && !BUSINESS_DATE_PATTERN.test(String(businessDate))) {
    throw new WebApiContractError(
      'WEBAPI_BUSINESS_DATE_INVALID',
      'businessDate must use YYYY-MM-DD when provided',
    );
  }
  const verifiedDefinitions = new Set(
    (Array.isArray(definitions) ? definitions : [])
      .filter((item) => item?.mappingStatus === SEMANTIC_STATUSES.VERIFIED)
      .map((item) => `${item.metaIndexId}\x1f${item.metricCode}`),
  );

  const observations = [];
  const rejected = [];
  let illegalDecimalCount = 0;
  let unknownMetricCount = 0;

  if (!endpoint.carriesMetricValues) {
    return Object.freeze({
      observations: Object.freeze([]),
      rejected: Object.freeze([]),
      illegalDecimalCount: 0,
      unknownMetricCount: 0,
      // A catalog or permission endpoint carries no metric value at all.
      carriesMetricValues: false,
    });
  }

  for (const [rowIndex, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const metricCode = String(row?.code ?? '').trim();
    const metaIndexId = row?.metaIndexId;
    const definitionKey = `${metaIndexId}\x1f${metricCode}`;
    const hasVerifiedDefinition = verifiedDefinitions.has(definitionKey);
    if (!hasVerifiedDefinition) unknownMetricCount += 1;

    if (!METRIC_CODE_PATTERN.test(metricCode)) {
      rejected.push(Object.freeze({
        observationKey: observationKey([
          storeCode,
          endpointCode,
          String(rowIndex),
          String(metaIndexId ?? ''),
          'METRIC_CODE_SHAPE_INVALID',
        ]),
        storeCode,
        metaIndexId: Number.isSafeInteger(metaIndexId) ? metaIndexId : null,
        metricCode: null,
        semanticStatus: SEMANTIC_STATUSES.REJECTED,
        sanitizedRejectCode: 'METRIC_CODE_SHAPE_INVALID',
        observedAt: observedAtIso,
      }));
      continue;
    }

    const decimal = parseStrictDecimalString(row?.count);
    if (!decimal.ok) {
      illegalDecimalCount += 1;
      rejected.push(Object.freeze({
        observationKey: observationKey([
          storeCode,
          endpointCode,
          String(rowIndex),
          String(metaIndexId),
          metricCode,
          decimal.code,
        ]),
        storeCode,
        metaIndexId,
        metricCode,
        semanticStatus: SEMANTIC_STATUSES.REJECTED,
        sanitizedRejectCode: decimal.code,
        observedAt: observedAtIso,
      }));
      continue;
    }

    const currency = typeof row?.currency === 'string' && CURRENCY_PATTERN.test(row.currency)
      ? row.currency
      : null;

    observations.push(Object.freeze({
      observationKey: observationKey([
        storeCode,
        endpointCode,
        String(metaIndexId),
        metricCode,
      ]),
      storeCode,
      metaIndexId,
      metricCode,
      // Exact platform text. Never a JavaScript number.
      rawValueText: decimal.text,
      currency,
      sourceUpdateTime: isoInstant(row?.updateTime),
      observedAt: observedAtIso,
      businessDate,
      // Until a versioned definition is verified against the page label and the
      // interface field, the value has no business meaning.
      semanticStatus: SEMANTIC_STATUSES.UNMAPPED,
      sanitizedRejectCode: null,
    }));
  }

  return Object.freeze({
    observations: Object.freeze(observations),
    rejected: Object.freeze(rejected),
    illegalDecimalCount,
    unknownMetricCount,
    carriesMetricValues: true,
  });
}

/**
 * Refuse formal projection.
 *
 * This batch has no verified definitions and no formal realtime fact table, so
 * any attempt to promote an experiment observation into a formal fact is a
 * programming error, not a configuration option.
 */
export function assertNoFormalProjection(observations, { definitions = [] } = {}) {
  const verified = new Set(
    (Array.isArray(definitions) ? definitions : [])
      .filter((item) => item?.mappingStatus === SEMANTIC_STATUSES.VERIFIED)
      .map((item) => `${item.metaIndexId}\x1f${item.metricCode}`),
  );
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (observation?.semanticStatus === SEMANTIC_STATUSES.VERIFIED
      && !verified.has(`${observation.metaIndexId}\x1f${observation.metricCode}`)) {
      throw new WebApiContractError(
        'WEBAPI_FORMAL_PROJECTION_REFUSED',
        'a WebAPI observation cannot be VERIFIED without a versioned definition',
        { metaIndexId: observation.metaIndexId, metricCode: observation.metricCode },
      );
    }
  }
  return true;
}

export function projectableToFormalFact(observations, { definitions = [] } = {}) {
  assertNoFormalProjection(observations, { definitions });
  // Batch 2 never creates fact.full_store_realtime_metric_snapshot.
  return Object.freeze([]);
}
