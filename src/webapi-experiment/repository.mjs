import {
  assertSecretFreeOutput,
  safeBatchProjection,
  toSanitizedErrorCode,
} from './redaction.mjs';
import { SEMANTIC_STATUSES } from './observation.mjs';
import { isCanonicalProfileKey, resolveProfileKey } from './profile-guard.mjs';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_STATES = new Set(['ACTIVE', 'STALE', 'EXPIRED', 'BLOCKED', 'UNKNOWN']);

function isoInstant(value, field) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    const error = new TypeError(`${field} must be a valid instant`);
    error.code = 'WEBAPI_REPOSITORY_INPUT_INVALID';
    throw error;
  }
  return parsed.toISOString();
}

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    const error = new TypeError(`${field} must be a bounded integer`);
    error.code = 'WEBAPI_REPOSITORY_INPUT_INVALID';
    throw error;
  }
  return value;
}

function canonicalStore(storeCode, profileKey) {
  const normalized = String(storeCode ?? '').trim().toUpperCase();
  const expectedProfileKey = resolveProfileKey(normalized);
  if (profileKey !== expectedProfileKey || !isCanonicalProfileKey(profileKey, normalized)) {
    const error = new TypeError('store and Profile key are not the canonical pair');
    error.code = 'WEBAPI_REPOSITORY_INPUT_INVALID';
    throw error;
  }
  return normalized;
}

async function withRoleTransaction(pool, { readOnly = false } = {}, callback) {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    transactionStarted = true;
    await client.query('SET LOCAL ROLE sheinfm_webapi_loader');
    const result = await callback(client);
    await client.query('COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function normalizedBatchRow(row) {
  return {
    batchKey: row.batch_key,
    storeCode: row.store_code,
    profileKey: row.profile_key,
    endpointCode: row.endpoint_code,
    httpMethod: row.http_method,
    requestSchemaHash: row.request_schema_hash,
    requestFingerprint: row.request_fingerprint,
    responseSchemaHash: row.response_schema_hash,
    payloadFingerprint: row.payload_fingerprint,
    requestedAt: isoInstant(row.requested_at, 'requestedAt'),
    completedAt: row.completed_at === null ? null : isoInstant(row.completed_at, 'completedAt'),
    httpStatus: row.http_status,
    resultStatus: row.result_status,
    observationCount: Number(row.observation_count),
    rejectedCount: Number(row.rejected_count),
    sanitizedErrorCode: row.sanitized_error_code,
    experimentGate: row.experiment_gate,
  };
}

function assertExactReplay(existing, expected) {
  const fields = Object.keys(expected).filter(
    (field) => JSON.stringify(existing[field]) !== JSON.stringify(expected[field]),
  );
  if (fields.length > 0) {
    const error = new Error('WebAPI batch idempotency key was replayed with drift');
    error.code = 'WEBAPI_BATCH_REPLAY_DRIFT';
    error.details = { fields };
    throw error;
  }
}

const OBSERVATION_REPLAY_COLUMNS = `
  store_code, meta_index_id, metric_code, raw_value_text, currency,
  source_update_time, observed_at, business_date, semantic_status,
  sanitized_reject_code, definition_meta_index_id, definition_metric_code,
  definition_effective_from, definition_mapping_status
`;

function dateText(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function nullableInstant(value, field) {
  return value === null || value === undefined ? null : isoInstant(value, field);
}

function normalizedObservationRow(row) {
  return {
    storeCode: row.store_code,
    metaIndexId: row.meta_index_id === null ? null : Number(row.meta_index_id),
    metricCode: row.metric_code,
    // Compared as exact source text, never via the normalized numeric mirror.
    rawValueText: row.raw_value_text,
    currency: row.currency,
    sourceUpdateTime: nullableInstant(row.source_update_time, 'sourceUpdateTime'),
    observedAt: isoInstant(row.observed_at, 'observedAt'),
    businessDate: dateText(row.business_date),
    semanticStatus: row.semantic_status,
    sanitizedRejectCode: row.sanitized_reject_code,
    definitionMetaIndexId: row.definition_meta_index_id === null
      ? null
      : Number(row.definition_meta_index_id),
    definitionMetricCode: row.definition_metric_code,
    definitionEffectiveFrom: dateText(row.definition_effective_from),
    definitionMappingStatus: row.definition_mapping_status,
  };
}

function expectedAcceptedRow(observation) {
  return {
    storeCode: observation.storeCode,
    metaIndexId: observation.metaIndexId,
    metricCode: observation.metricCode,
    rawValueText: observation.rawValueText,
    currency: observation.currency ?? null,
    sourceUpdateTime: nullableInstant(observation.sourceUpdateTime, 'sourceUpdateTime'),
    observedAt: isoInstant(observation.observedAt, 'observedAt'),
    businessDate: dateText(observation.businessDate),
    semanticStatus: SEMANTIC_STATUSES.UNMAPPED,
    sanitizedRejectCode: null,
    definitionMetaIndexId: null,
    definitionMetricCode: null,
    definitionEffectiveFrom: null,
    definitionMappingStatus: null,
  };
}

function expectedRejectedRow(row) {
  return {
    storeCode: row.storeCode,
    metaIndexId: row.metaIndexId ?? null,
    metricCode: row.metricCode ?? null,
    rawValueText: null,
    currency: null,
    sourceUpdateTime: null,
    observedAt: isoInstant(row.observedAt, 'observedAt'),
    businessDate: null,
    semanticStatus: SEMANTIC_STATUSES.REJECTED,
    sanitizedRejectCode: toSanitizedErrorCode(row.sanitizedRejectCode, 'WEBAPI_ROW_REJECTED'),
    definitionMetaIndexId: null,
    definitionMetricCode: null,
    definitionEffectiveFrom: null,
    definitionMappingStatus: null,
  };
}

/**
 * A reused observation key must reproduce every immutable field exactly.
 *
 * Any drift throws, which rolls back the whole batch transaction, so a partial
 * or contradictory evidence set can never be committed.
 */
async function assertExactObservationReplay(client, batchId, observationKey, expected) {
  const readback = await client.query(
    `SELECT ${OBSERVATION_REPLAY_COLUMNS}
       FROM raw.webapi_metric_observation
      WHERE webapi_fetch_batch_id = $1
        AND observation_key = $2
      FOR SHARE`,
    [batchId, observationKey],
  );
  if (readback.rows.length !== 1) {
    const error = new Error('WebAPI observation conflict readback is missing');
    error.code = 'WEBAPI_OBSERVATION_READBACK_MISSING';
    throw error;
  }
  if (JSON.stringify(normalizedObservationRow(readback.rows[0])) !== JSON.stringify(expected)) {
    const error = new Error('WebAPI observation key was replayed with drift');
    error.code = 'WEBAPI_OBSERVATION_REPLAY_DRIFT';
    throw error;
  }
}

function validateBatch(batch) {
  const safe = { ...safeBatchProjection(batch) };
  canonicalStore(safe.storeCode, safe.profileKey);
  for (const [field, value] of [
    ['batchKey', safe.batchKey],
    ['requestSchemaHash', safe.requestSchemaHash],
    ['requestFingerprint', safe.requestFingerprint],
  ]) {
    if (!HASH_PATTERN.test(value ?? '')) {
      const error = new TypeError(`${field} must be a SHA-256 hex digest`);
      error.code = 'WEBAPI_REPOSITORY_INPUT_INVALID';
      throw error;
    }
  }
  for (const value of [safe.responseSchemaHash, safe.payloadFingerprint]) {
    if (value !== null && !HASH_PATTERN.test(value ?? '')) {
      const error = new TypeError('optional fingerprint must be a SHA-256 hex digest');
      error.code = 'WEBAPI_REPOSITORY_INPUT_INVALID';
      throw error;
    }
  }
  safe.requestedAt = isoInstant(safe.requestedAt, 'requestedAt');
  safe.completedAt = safe.completedAt === null
    ? null
    : isoInstant(safe.completedAt, 'completedAt');
  integer(safe.observationCount, 'observationCount');
  integer(safe.rejectedCount, 'rejectedCount');
  assertSecretFreeOutput(safe, 'webapi-batch-metadata');
  return safe;
}

/**
 * Isolated persistence for WebAPI experiment evidence.
 *
 * Batch metadata and its observations commit atomically. Exact replay is a
 * readback; a reused batch key with any metadata or payload fingerprint drift
 * fails closed. Decimal values remain strings until PostgreSQL casts them to
 * numeric, and neither return values nor errors contain raw metrics.
 */
export function createWebApiExperimentRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('createWebApiExperimentRepository requires a pg pool');
  }

  return Object.freeze({
    async recordExperimentResult({ batch, observations = [], rejected = [] } = {}) {
      const safe = validateBatch(batch);
      if (!Array.isArray(observations) || !Array.isArray(rejected)) {
        throw new TypeError('observations and rejected must be arrays');
      }
      if (
        observations.length !== safe.observationCount
        || rejected.length !== safe.rejectedCount
      ) {
        const error = new Error('batch counts do not match its evidence rows');
        error.code = 'WEBAPI_BATCH_COUNT_MISMATCH';
        throw error;
      }
      // Store isolation is checked before the transaction opens, so a DL row can
      // never be filed under an MZ batch even if the database key were missing.
      for (const row of [...observations, ...rejected]) {
        if (row?.storeCode !== safe.storeCode) {
          const error = new Error('observation store does not match its batch store');
          error.code = 'WEBAPI_OBSERVATION_STORE_MISMATCH';
          throw error;
        }
      }

      return withRoleTransaction(pool, {}, async (client) => {
        const inserted = await client.query(
          `INSERT INTO raw.webapi_fetch_batch (
               batch_key, store_code, profile_key, endpoint_code, http_method,
               request_schema_hash, request_fingerprint, response_schema_hash,
               payload_fingerprint, requested_at, completed_at, http_status,
               result_status, observation_count, rejected_count,
               sanitized_error_code, experiment_gate
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17
           )
           ON CONFLICT (batch_key) DO NOTHING
           RETURNING webapi_fetch_batch_id`,
          [
            safe.batchKey,
            safe.storeCode,
            safe.profileKey,
            safe.endpointCode,
            safe.httpMethod,
            safe.requestSchemaHash,
            safe.requestFingerprint,
            safe.responseSchemaHash,
            safe.payloadFingerprint,
            safe.requestedAt,
            safe.completedAt,
            safe.httpStatus,
            safe.resultStatus,
            safe.observationCount,
            safe.rejectedCount,
            safe.sanitizedErrorCode,
            safe.experimentGate,
          ],
        );

        let batchId;
        let replayed = false;
        if (inserted.rows.length > 0) {
          batchId = Number(inserted.rows[0].webapi_fetch_batch_id);
        } else {
          const readback = await client.query(
            `SELECT batch_key, store_code, profile_key, endpoint_code, http_method,
                    request_schema_hash, request_fingerprint, response_schema_hash,
                    payload_fingerprint, requested_at, completed_at, http_status,
                    result_status, observation_count, rejected_count,
                    sanitized_error_code, experiment_gate, webapi_fetch_batch_id
               FROM raw.webapi_fetch_batch
              WHERE batch_key = $1
              FOR SHARE`,
            [safe.batchKey],
          );
          if (readback.rows.length !== 1) {
            const error = new Error('WebAPI batch conflict readback is missing');
            error.code = 'WEBAPI_BATCH_READBACK_MISSING';
            throw error;
          }
          assertExactReplay(normalizedBatchRow(readback.rows[0]), safe);
          batchId = Number(readback.rows[0].webapi_fetch_batch_id);
          replayed = true;
        }

        for (const observation of observations) {
          if (observation.semanticStatus !== SEMANTIC_STATUSES.UNMAPPED) {
            const error = new Error('only UNMAPPED observations may be persisted in batch 2');
            error.code = 'WEBAPI_SEMANTIC_STATUS_NOT_ALLOWED';
            throw error;
          }
          const expected = expectedAcceptedRow(observation);
          const inserted = await client.query(
            `INSERT INTO raw.webapi_metric_observation (
                 observation_key, webapi_fetch_batch_id, store_code,
                 meta_index_id, metric_code, raw_value_text, raw_decimal_value,
                 currency, source_update_time, observed_at, business_date,
                 semantic_status
             )
             VALUES ($1, $2, $3, $4, $5, $6, $6::numeric, $7, $8, $9, $10, 'UNMAPPED')
             ON CONFLICT (webapi_fetch_batch_id, observation_key) DO NOTHING
             RETURNING webapi_metric_observation_id`,
            [
              observation.observationKey,
              batchId,
              observation.storeCode,
              observation.metaIndexId,
              observation.metricCode,
              observation.rawValueText,
              observation.currency,
              observation.sourceUpdateTime,
              observation.observedAt,
              observation.businessDate,
            ],
          );
          if (inserted.rows.length === 0) {
            // A reused observation key must be a byte-exact replay. The raw text
            // is compared directly, so "1.0", "1.00" and "-0" stay distinct even
            // though the numeric mirror would normalize them.
            await assertExactObservationReplay(client, batchId, observation.observationKey, expected);
          }
        }
        for (const row of rejected) {
          const expected = expectedRejectedRow(row);
          const inserted = await client.query(
            `INSERT INTO raw.webapi_metric_observation (
                 observation_key, webapi_fetch_batch_id, store_code,
                 meta_index_id, metric_code, raw_value_text, raw_decimal_value,
                 observed_at, semantic_status, sanitized_reject_code
             )
             VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, 'REJECTED', $7)
             ON CONFLICT (webapi_fetch_batch_id, observation_key) DO NOTHING
             RETURNING webapi_metric_observation_id`,
            [
              row.observationKey,
              batchId,
              row.storeCode,
              row.metaIndexId,
              row.metricCode,
              row.observedAt,
              expected.sanitizedRejectCode,
            ],
          );
          if (inserted.rows.length === 0) {
            await assertExactObservationReplay(client, batchId, row.observationKey, expected);
          }
        }

        const countReadback = await client.query(
          `SELECT
             COUNT(*) FILTER (WHERE semantic_status = 'UNMAPPED')::integer
               AS observation_count,
             COUNT(*) FILTER (WHERE semantic_status = 'REJECTED')::integer
               AS rejected_count
           FROM raw.webapi_metric_observation
          WHERE webapi_fetch_batch_id = $1`,
          [batchId],
        );
        const counts = countReadback.rows[0] ?? {};
        if (
          Number(counts.observation_count) !== safe.observationCount
          || Number(counts.rejected_count) !== safe.rejectedCount
        ) {
          const error = new Error('WebAPI observation readback does not match batch counts');
          error.code = 'WEBAPI_OBSERVATION_READBACK_MISMATCH';
          throw error;
        }
        return {
          webapiFetchBatchId: batchId,
          replayed,
          observationCount: safe.observationCount,
          rejectedCount: safe.rejectedCount,
        };
      });
    },

    async recordSessionHealth(health) {
      const storeCode = canonicalStore(health?.storeCode, health?.profileKey);
      const observedAt = isoInstant(health?.observedAt, 'observedAt');
      const sessionState = String(health?.sessionState ?? '').trim().toUpperCase();
      if (!SESSION_STATES.has(sessionState)) {
        throw new TypeError('sessionState is invalid');
      }
      const latencyMs = health?.latencyMs === null || health?.latencyMs === undefined
        ? null
        : integer(health.latencyMs, 'latencyMs', { max: 600_000 });
      const failureCount = integer(
        health?.consecutiveFailureCount ?? 0,
        'consecutiveFailureCount',
      );
      await withRoleTransaction(pool, {}, (client) => client.query(
        `INSERT INTO ops.webapi_session_health (
             store_code, profile_key, observed_at, session_state,
             last_success_at, response_schema_hash, latency_ms,
             consecutive_failure_count, sanitized_error_code
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          storeCode,
          health.profileKey,
          observedAt,
          // The validated session state belongs to $4; omitting it shifted every
          // later bind and made the first real health append fail.
          sessionState,
          health.lastSuccessAt ? isoInstant(health.lastSuccessAt, 'lastSuccessAt') : null,
          health.responseSchemaHash ?? null,
          latencyMs,
          failureCount,
          health.sanitizedErrorCode
            ? toSanitizedErrorCode(health.sanitizedErrorCode)
            : null,
        ],
      ));
      return { recorded: true };
    },

    async loadMetricDefinitions() {
      return withRoleTransaction(pool, { readOnly: true }, async (client) => {
        const result = await client.query(
          `SELECT meta_index_id, metric_code, effective_from, mapping_status
             FROM dim.webapi_metric_definition
            WHERE effective_to IS NULL
            ORDER BY meta_index_id, metric_code, effective_from`,
        );
        return result.rows.map((row) => ({
          metaIndexId: Number(row.meta_index_id),
          metricCode: row.metric_code,
          effectiveFrom: String(row.effective_from).slice(0, 10),
          mappingStatus: row.mapping_status,
        }));
      });
    },
  });
}
