import { CAPABILITY_STATUSES } from './capability-catalog.mjs';

export const WINDOW_EXECUTION_STATUSES = Object.freeze({
  PLANNED: 'PLANNED',
  BLOCKED: 'BLOCKED',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
});

export const WINDOW_QUALITY_STATUSES = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  PASSED: 'PASSED',
  MISSING_PAGE: 'MISSING_PAGE',
  SCHEMA_DRIFT: 'SCHEMA_DRIFT',
  MIXED_BUSINESS_DATE: 'MIXED_BUSINESS_DATE',
  ILLEGAL_DECIMAL: 'ILLEGAL_DECIMAL',
  UNKNOWN_METRIC: 'UNKNOWN_METRIC',
  REJECTED_ROWS: 'REJECTED_ROWS',
  COVERAGE_GAP: 'COVERAGE_GAP',
  ADAPTER_ERROR: 'ADAPTER_ERROR',
});

const SCHEMA_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SANITIZED_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,60}$/;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function unitCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function businessDate(value) {
  if (typeof value !== 'string' || !BUSINESS_DATE_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function outcome(executionStatus, qualityStatus, sanitizedErrorCode, extra = {}) {
  return Object.freeze({
    executionStatus,
    qualityStatus,
    sanitizedErrorCode: sanitizedErrorCode ?? null,
    checkpointAdvanceable: executionStatus === WINDOW_EXECUTION_STATUSES.SUCCEEDED
      && qualityStatus === WINDOW_QUALITY_STATUSES.PASSED,
    acceptedRowCount: extra.acceptedRowCount ?? null,
    rejectedRowCount: extra.rejectedRowCount ?? null,
    expectedPageCount: extra.expectedPageCount ?? null,
    observedPageCount: extra.observedPageCount ?? null,
    schemaFingerprint: extra.schemaFingerprint ?? null,
    sourceBusinessWatermark: extra.sourceBusinessWatermark ?? null,
  });
}

/**
 * Fail-closed quality gate for one backfill window.
 *
 * Every branch that is not a proven, complete, single-business-date,
 * fingerprint-stable, fully persisted result returns
 * `checkpointAdvanceable: false`. A checkpoint therefore cannot move on a
 * failure, a missing page, mixed statistics dates, schema drift, an illegal
 * decimal, an unknown metric, a rejected row or a persistence gap.
 */
export function evaluateWindowOutcome({ window, result, checkpoint } = {}) {
  if (!window || typeof window !== 'object') {
    throw new TypeError('evaluateWindowOutcome requires a planned window');
  }
  if (window.capabilityStatus !== CAPABILITY_STATUSES.VERIFIED) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.BLOCKED,
      WINDOW_QUALITY_STATUSES.UNKNOWN,
      window.blockedReasonCode ?? 'CAPABILITY_NOT_VERIFIED',
    );
  }
  if (!result || typeof result !== 'object') {
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.ADAPTER_ERROR,
      'ADAPTER_RESULT_MISSING',
    );
  }

  const acceptedRowCount = unitCount(result.acceptedRowCount);
  const rejectedRowCount = unitCount(result.rejectedRowCount);
  const expectedPageCount = unitCount(result.expectedPageCount);
  const observedPageCount = unitCount(result.observedPageCount);
  const persistedRowCount = unitCount(result.persistedRowCount);
  const schemaFingerprint = typeof result.schemaFingerprint === 'string'
    ? result.schemaFingerprint
    : null;
  const rawBusinessDates = Array.isArray(result.businessDates) ? result.businessDates : [];
  const businessDates = [...new Set(rawBusinessDates.map(businessDate).filter(Boolean))];
  const explicitWatermark = businessDate(result.sourceBusinessWatermark);
  const sourceBusinessWatermark = explicitWatermark
    ?? (businessDates.length === 1 ? businessDates[0] : null);
  const counts = {
    acceptedRowCount,
    rejectedRowCount,
    expectedPageCount,
    observedPageCount,
    schemaFingerprint,
    sourceBusinessWatermark,
  };

  if (result.ok === false || result.adapterError) {
    const code = typeof result.sanitizedErrorCode === 'string'
      && SANITIZED_CODE_PATTERN.test(result.sanitizedErrorCode)
      ? result.sanitizedErrorCode
      : 'ADAPTER_ERROR';
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.ADAPTER_ERROR,
      code,
      counts,
    );
  }
  if (
    acceptedRowCount === null
    || rejectedRowCount === null
    || expectedPageCount === null
    || observedPageCount === null
    || persistedRowCount === null
  ) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.COVERAGE_GAP,
      'INCOMPLETE_ADAPTER_COUNTS',
      counts,
    );
  }
  if (observedPageCount !== expectedPageCount) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.PARTIAL,
      WINDOW_QUALITY_STATUSES.MISSING_PAGE,
      'PAGE_COVERAGE_INCOMPLETE',
      counts,
    );
  }
  if (
    expectedPageCount > window.maxPagesPerWindow
    || acceptedRowCount + rejectedRowCount > window.maxRowsPerWindow
  ) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.COVERAGE_GAP,
      'WINDOW_BOUND_EXCEEDED',
      counts,
    );
  }
  if (schemaFingerprint === null || !SCHEMA_FINGERPRINT_PATTERN.test(schemaFingerprint)) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.SCHEMA_DRIFT,
      'SCHEMA_FINGERPRINT_MISSING',
      counts,
    );
  }
  if (
    checkpoint
    && typeof checkpoint.schemaFingerprint === 'string'
    && checkpoint.schemaFingerprint !== ''
    && checkpoint.schemaFingerprint !== schemaFingerprint
  ) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.SCHEMA_DRIFT,
      'SCHEMA_FINGERPRINT_DRIFT',
      counts,
    );
  }
  if (rawBusinessDates.some((item) => businessDate(item) === null)) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.MIXED_BUSINESS_DATE,
      'INVALID_BUSINESS_DATE_IN_WINDOW',
      { ...counts, sourceBusinessWatermark: null },
    );
  }
  if (businessDates.length > 1) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.MIXED_BUSINESS_DATE,
      'MIXED_BUSINESS_DATE_IN_WINDOW',
      { ...counts, sourceBusinessWatermark: null },
    );
  }
  if (
    explicitWatermark !== null
    && businessDates.length === 1
    && explicitWatermark !== businessDates[0]
  ) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.MIXED_BUSINESS_DATE,
      'BUSINESS_WATERMARK_MISMATCH',
      { ...counts, sourceBusinessWatermark: null },
    );
  }
  if (unitCount(result.illegalDecimalCount) === null || result.illegalDecimalCount > 0) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.ILLEGAL_DECIMAL,
      'ILLEGAL_DECIMAL_VALUE',
      counts,
    );
  }
  if (unitCount(result.unknownMetricCount) === null || result.unknownMetricCount > 0) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.UNKNOWN_METRIC,
      'UNKNOWN_METRIC_IN_WINDOW',
      counts,
    );
  }
  if (rejectedRowCount > 0) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.PARTIAL,
      WINDOW_QUALITY_STATUSES.REJECTED_ROWS,
      'ROWS_REJECTED_BY_CONTRACT',
      counts,
    );
  }
  if (persistedRowCount !== acceptedRowCount) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.COVERAGE_GAP,
      'PERSISTED_ROW_COUNT_MISMATCH',
      counts,
    );
  }
  if (sourceBusinessWatermark === null) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.COVERAGE_GAP,
      'SOURCE_BUSINESS_WATERMARK_MISSING',
      counts,
    );
  }
  if (
    sourceBusinessWatermark < window.windowStart
    || sourceBusinessWatermark >= window.windowEnd
  ) {
    return outcome(
      WINDOW_EXECUTION_STATUSES.FAILED,
      WINDOW_QUALITY_STATUSES.MIXED_BUSINESS_DATE,
      'BUSINESS_DATE_OUTSIDE_WINDOW',
      counts,
    );
  }
  return outcome(
    WINDOW_EXECUTION_STATUSES.SUCCEEDED,
    WINDOW_QUALITY_STATUSES.PASSED,
    null,
    counts,
  );
}

/**
 * A checkpoint may only advance forward, on a passed window, for a verified
 * capability, and never past the proven business watermark.
 */
export function nextCheckpointState({ window, outcome: windowOutcome, checkpoint, runId } = {}) {
  if (!windowOutcome?.checkpointAdvanceable) return null;
  if (window.capabilityStatus !== CAPABILITY_STATUSES.VERIFIED) return null;
  // The watermark must come from the window row itself. The database checkpoint
  // foreign key matches on the persisted source_business_watermark, so deriving a
  // substitute date here would be unprovable evidence.
  const watermark = windowOutcome.sourceBusinessWatermark;
  if (typeof watermark !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(watermark)) return null;
  if (watermark < window.windowStart || watermark >= window.windowEnd) return null;
  const current = typeof checkpoint?.lastCompletedBusinessDate === 'string'
    ? checkpoint.lastCompletedBusinessDate
    : null;
  if (current !== null && watermark <= current) return null;
  return Object.freeze({
    storeCode: window.storeCode,
    domain: window.domain,
    adapterKey: window.adapterKey,
    lastCompletedBusinessDate: watermark,
    lastSourceCursor: window.windowEnd,
    lastSuccessfulRunId: runId ?? null,
    schemaFingerprint: windowOutcome.schemaFingerprint,
    qualityStatus: WINDOW_QUALITY_STATUSES.PASSED,
    capabilityStatus: CAPABILITY_STATUSES.VERIFIED,
  });
}
