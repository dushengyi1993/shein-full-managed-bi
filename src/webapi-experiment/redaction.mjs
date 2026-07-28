/**
 * Isolated redaction primitives for the WebAPI experiment.
 *
 * Deliberately duplicated instead of shared with the OpenAPI/backfill layers so
 * the experiment cannot widen another component's output contract.
 */

export const SANITIZED_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,60}$/;

const FORBIDDEN_OUTPUT_PATTERNS = Object.freeze([
  /cookie/i,
  /set-cookie/i,
  /authorization/i,
  /bearer\s/i,
  /\btoken\b/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /credential/i,
  /session[-_]?id/i,
  /csrf/i,
  /x-api-key/i,
  /\/srv\/shein-fm\/webapi\/profiles/i,
  /localstorage/i,
]);

export function toSanitizedErrorCode(value, fallback = 'WEBAPI_UNSPECIFIED_ERROR') {
  const candidate = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return SANITIZED_ERROR_CODE_PATTERN.test(candidate) ? candidate : fallback;
}

/**
 * Assert that a value about to be logged, printed or persisted carries no
 * secret-shaped content. Fail closed: an unexpected shape is an error, not a
 * silent pass.
 */
export function assertSecretFreeOutput(value, context = 'webapi-output') {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const text = serialized ?? '';
  for (const pattern of FORBIDDEN_OUTPUT_PATTERNS) {
    if (pattern.test(text)) {
      const error = new Error(`refusing to emit potentially secret content in ${context}`);
      error.code = 'WEBAPI_OUTPUT_REDACTION_VIOLATION';
      throw error;
    }
  }
  return text;
}

export function safeBatchProjection(batch) {
  return Object.freeze({
    batchKey: batch.batchKey,
    storeCode: batch.storeCode,
    profileKey: batch.profileKey,
    endpointCode: batch.endpointCode,
    httpMethod: batch.httpMethod,
    httpStatus: batch.httpStatus ?? null,
    resultStatus: batch.resultStatus,
    requestSchemaHash: batch.requestSchemaHash,
    requestFingerprint: batch.requestFingerprint,
    responseSchemaHash: batch.responseSchemaHash ?? null,
    payloadFingerprint: batch.payloadFingerprint ?? null,
    requestedAt: batch.requestedAt,
    completedAt: batch.completedAt ?? null,
    observationCount: batch.observationCount ?? 0,
    rejectedCount: batch.rejectedCount ?? 0,
    sanitizedErrorCode: batch.sanitizedErrorCode ?? null,
    experimentGate: batch.experimentGate,
  });
}
