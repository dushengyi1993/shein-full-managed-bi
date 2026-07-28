import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebApiExperimentRepository } from '../../src/webapi-experiment/repository.mjs';
import { SEMANTIC_STATUSES } from '../../src/webapi-experiment/observation.mjs';

const OBSERVED_AT = '2026-07-28T02:00:00.000Z';

function batchFor(storeCode, overrides = {}) {
  return {
    batchKey: '1'.repeat(64),
    storeCode,
    profileKey: `persistent-${storeCode.toLowerCase()}-profile`,
    endpointCode: 'HOME_DATA_OVERVIEW_DETAIL',
    httpMethod: 'POST',
    requestSchemaHash: '2'.repeat(64),
    requestFingerprint: '3'.repeat(64),
    responseSchemaHash: '4'.repeat(64),
    payloadFingerprint: '5'.repeat(64),
    requestedAt: OBSERVED_AT,
    completedAt: OBSERVED_AT,
    httpStatus: 200,
    resultStatus: 'SCHEMA_ONLY',
    observationCount: 1,
    rejectedCount: 0,
    sanitizedErrorCode: null,
    experimentGate: 'EXPERIMENT_ONLY',
    ...overrides,
  };
}

function observationFor(storeCode, overrides = {}) {
  return {
    observationKey: '6'.repeat(64),
    storeCode,
    metaIndexId: 70,
    metricCode: 'GSP000016',
    rawValueText: '12.30',
    currency: 'CNY',
    sourceUpdateTime: null,
    observedAt: OBSERVED_AT,
    businessDate: null,
    semanticStatus: SEMANTIC_STATUSES.UNMAPPED,
    ...overrides,
  };
}

/** Deterministic fake pool recording every statement in order. */
function fakePool(responder) {
  const statements = [];
  const client = {
    released: false,
    async query(text, values) {
      const normalized = String(text).replace(/\s+/g, ' ').trim();
      statements.push({ text: normalized, values });
      return responder(normalized, values) ?? { rows: [], rowCount: 0 };
    },
    release() { client.released = true; },
  };
  return {
    statements,
    client,
    async connect() { return client; },
    async query(text, values) { return client.query(text, values); },
  };
}

const ACCEPTED_ROW = Object.freeze({
  store_code: 'MZ2406',
  meta_index_id: 70,
  metric_code: 'GSP000016',
  raw_value_text: '12.30',
  currency: 'CNY',
  source_update_time: null,
  observed_at: OBSERVED_AT,
  business_date: null,
  semantic_status: 'UNMAPPED',
  sanitized_reject_code: null,
  definition_meta_index_id: null,
  definition_metric_code: null,
  definition_effective_from: null,
  definition_mapping_status: null,
});

test('a new batch and its observations commit atomically inside one role transaction', async () => {
  const pool = fakePool((text) => {
    if (text.startsWith('INSERT INTO raw.webapi_fetch_batch')) {
      return { rows: [{ webapi_fetch_batch_id: 21 }], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO raw.webapi_metric_observation')) {
      return { rows: [{ webapi_metric_observation_id: 31 }], rowCount: 1 };
    }
    if (text.includes('COUNT(*) FILTER')) {
      return { rows: [{ observation_count: 1, rejected_count: 0 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const result = await createWebApiExperimentRepository({ pool }).recordExperimentResult({
    batch: batchFor('MZ2406'),
    observations: [observationFor('MZ2406')],
    rejected: [],
  });
  assert.deepEqual(result, {
    webapiFetchBatchId: 21,
    replayed: false,
    observationCount: 1,
    rejectedCount: 0,
  });
  const order = pool.statements.map((item) => item.text);
  assert.equal(order[0], 'BEGIN');
  assert.equal(order[1], 'SET LOCAL ROLE sheinfm_webapi_loader');
  assert.equal(order.at(-1), 'COMMIT');
  assert.ok(!order.includes('ROLLBACK'));
  assert.equal(pool.client.released, true);
  // The decimal travels as text and is cast by PostgreSQL, never by JavaScript.
  const insert = pool.statements.find((item) => item.text.startsWith('INSERT INTO raw.webapi_metric_observation'));
  assert.match(insert.text, /\$6::text, \(\$6::text\)::numeric/);
  assert.equal(insert.values[5], '12.30');
  assert.equal(typeof insert.values[5], 'string');
});

test('an exact batch and observation replay is accepted as a readback', async () => {
  const pool = fakePool((text) => {
    if (text.startsWith('INSERT INTO')) return { rows: [], rowCount: 0 };
    if (text.includes('FROM raw.webapi_fetch_batch')) {
      const batch = batchFor('MZ2406');
      return {
        rows: [{
          batch_key: batch.batchKey,
          store_code: batch.storeCode,
          profile_key: batch.profileKey,
          endpoint_code: batch.endpointCode,
          http_method: batch.httpMethod,
          request_schema_hash: batch.requestSchemaHash,
          request_fingerprint: batch.requestFingerprint,
          response_schema_hash: batch.responseSchemaHash,
          payload_fingerprint: batch.payloadFingerprint,
          requested_at: batch.requestedAt,
          completed_at: batch.completedAt,
          http_status: batch.httpStatus,
          result_status: batch.resultStatus,
          observation_count: 1,
          rejected_count: 0,
          sanitized_error_code: null,
          experiment_gate: batch.experimentGate,
          webapi_fetch_batch_id: 21,
        }],
        rowCount: 1,
      };
    }
    if (text.includes('FROM raw.webapi_metric_observation') && text.includes('observation_key = $2')) {
      return { rows: [{ ...ACCEPTED_ROW }], rowCount: 1 };
    }
    if (text.includes('COUNT(*) FILTER')) {
      return { rows: [{ observation_count: 1, rejected_count: 0 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const result = await createWebApiExperimentRepository({ pool }).recordExperimentResult({
    batch: batchFor('MZ2406'),
    observations: [observationFor('MZ2406')],
    rejected: [],
  });
  assert.equal(result.replayed, true);
  assert.equal(result.webapiFetchBatchId, 21);
  assert.equal(pool.statements.at(-1).text, 'COMMIT');
});

test('the same batch metadata with a drifted observation rolls the transaction back', async () => {
  // Trailing-zero drift only: the numeric mirror would compare equal, the exact
  // source text must not.
  for (const driftedText of ['12.3', '12.300', '-0']) {
    const pool = fakePool((text) => {
      if (text.startsWith('INSERT INTO raw.webapi_fetch_batch')) {
        return { rows: [{ webapi_fetch_batch_id: 21 }], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO raw.webapi_metric_observation')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM raw.webapi_metric_observation') && text.includes('observation_key = $2')) {
        return { rows: [{ ...ACCEPTED_ROW, raw_value_text: driftedText }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    await assert.rejects(
      () => createWebApiExperimentRepository({ pool }).recordExperimentResult({
        batch: batchFor('MZ2406'),
        observations: [observationFor('MZ2406')],
        rejected: [],
      }),
      (error) => error.code === 'WEBAPI_OBSERVATION_REPLAY_DRIFT',
      driftedText,
    );
    assert.ok(pool.statements.some((item) => item.text === 'ROLLBACK'), driftedText);
    assert.ok(!pool.statements.some((item) => item.text === 'COMMIT'), driftedText);
  }
});

test('a missing observation readback under a reused key fails closed', async () => {
  const pool = fakePool((text) => {
    if (text.startsWith('INSERT INTO raw.webapi_fetch_batch')) {
      return { rows: [{ webapi_fetch_batch_id: 21 }], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO raw.webapi_metric_observation')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(
    () => createWebApiExperimentRepository({ pool }).recordExperimentResult({
      batch: batchFor('MZ2406'),
      observations: [observationFor('MZ2406')],
      rejected: [],
    }),
    (error) => error.code === 'WEBAPI_OBSERVATION_READBACK_MISSING',
  );
  assert.ok(pool.statements.some((item) => item.text === 'ROLLBACK'));
});

test('a DL observation under an MZ batch is rejected before any statement runs', async () => {
  const pool = fakePool(() => ({ rows: [{ webapi_fetch_batch_id: 21 }], rowCount: 1 }));
  await assert.rejects(
    () => createWebApiExperimentRepository({ pool }).recordExperimentResult({
      batch: batchFor('MZ2406'),
      observations: [observationFor('DL5477')],
      rejected: [],
    }),
    (error) => error.code === 'WEBAPI_OBSERVATION_STORE_MISMATCH',
  );
  // No transaction was opened at all.
  assert.deepEqual(pool.statements, []);

  // A non-canonical store/Profile pair is refused just as early.
  await assert.rejects(
    () => createWebApiExperimentRepository({ pool }).recordExperimentResult({
      batch: batchFor('MZ2406', { profileKey: 'persistent-dl5477-profile' }),
      observations: [observationFor('MZ2406')],
      rejected: [],
    }),
    (error) => error.code === 'WEBAPI_REPOSITORY_INPUT_INVALID',
  );
});

test('a count mismatch between batch metadata and evidence rows fails closed', async () => {
  const pool = fakePool(() => ({ rows: [], rowCount: 0 }));
  await assert.rejects(
    () => createWebApiExperimentRepository({ pool }).recordExperimentResult({
      batch: batchFor('MZ2406', { observationCount: 2 }),
      observations: [observationFor('MZ2406')],
      rejected: [],
    }),
    (error) => error.code === 'WEBAPI_BATCH_COUNT_MISMATCH',
  );
  assert.deepEqual(pool.statements, []);
});

test('a readback count mismatch after insert rolls back', async () => {
  const pool = fakePool((text) => {
    if (text.startsWith('INSERT INTO raw.webapi_fetch_batch')) {
      return { rows: [{ webapi_fetch_batch_id: 21 }], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO raw.webapi_metric_observation')) {
      return { rows: [{ webapi_metric_observation_id: 31 }], rowCount: 1 };
    }
    if (text.includes('COUNT(*) FILTER')) {
      return { rows: [{ observation_count: 2, rejected_count: 0 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(
    () => createWebApiExperimentRepository({ pool }).recordExperimentResult({
      batch: batchFor('MZ2406'),
      observations: [observationFor('MZ2406')],
      rejected: [],
    }),
    (error) => error.code === 'WEBAPI_OBSERVATION_READBACK_MISMATCH',
  );
  assert.ok(pool.statements.some((item) => item.text === 'ROLLBACK'));
});

test('only UNMAPPED observations may be persisted in this batch', async () => {
  const pool = fakePool((text) => {
    if (text.startsWith('INSERT INTO raw.webapi_fetch_batch')) {
      return { rows: [{ webapi_fetch_batch_id: 21 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(
    () => createWebApiExperimentRepository({ pool }).recordExperimentResult({
      batch: batchFor('MZ2406'),
      observations: [observationFor('MZ2406', {
        semanticStatus: SEMANTIC_STATUSES.VERIFIED,
      })],
      rejected: [],
    }),
    (error) => error.code === 'WEBAPI_SEMANTIC_STATUS_NOT_ALLOWED',
  );
  assert.ok(pool.statements.some((item) => item.text === 'ROLLBACK'));
});

test('a rejected row stores a sanitized reason and no raw payload', async () => {
  const pool = fakePool((text) => {
    if (text.startsWith('INSERT INTO raw.webapi_fetch_batch')) {
      return { rows: [{ webapi_fetch_batch_id: 22 }], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO raw.webapi_metric_observation')) {
      return { rows: [{ webapi_metric_observation_id: 32 }], rowCount: 1 };
    }
    if (text.includes('COUNT(*) FILTER')) {
      return { rows: [{ observation_count: 0, rejected_count: 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const result = await createWebApiExperimentRepository({ pool }).recordExperimentResult({
    batch: batchFor('DL5477', { observationCount: 0, rejectedCount: 1 }),
    observations: [],
    rejected: [{
      observationKey: '7'.repeat(64),
      storeCode: 'DL5477',
      metaIndexId: 71,
      metricCode: 'GSP000017',
      observedAt: OBSERVED_AT,
      sanitizedRejectCode: 'DECIMAL_NON_CANONICAL',
    }],
  });
  assert.equal(result.rejectedCount, 1);
  const insert = pool.statements.find((item) => item.text.startsWith('INSERT INTO raw.webapi_metric_observation'));
  assert.match(insert.text, /NULL, NULL, \$6, 'REJECTED', \$7/);
  assert.equal(insert.values.at(-1), 'DECIMAL_NON_CANONICAL');
  assert.ok(!insert.values.includes('12.30'));
});

test('session health binds the validated session state in its own column', async () => {
  const pool = fakePool(() => ({ rows: [], rowCount: 1 }));
  const result = await createWebApiExperimentRepository({ pool }).recordSessionHealth({
    storeCode: 'DL5477',
    profileKey: 'persistent-dl5477-profile',
    observedAt: OBSERVED_AT,
    sessionState: 'ACTIVE',
    lastSuccessAt: OBSERVED_AT,
    responseSchemaHash: 'a'.repeat(64),
    latencyMs: 1200,
    consecutiveFailureCount: 0,
    sanitizedErrorCode: null,
  });
  assert.deepEqual(result, { recorded: true });

  const insert = pool.statements.find((item) => item.text.includes('ops.webapi_session_health'));
  // Nine declared columns, nine placeholders and nine bound values must agree,
  // with the session state in position 4.
  assert.equal((insert.text.match(/\$\d+/g) || []).length, 9);
  assert.equal(insert.values.length, 9);
  assert.equal(insert.values[3], 'ACTIVE');
  assert.equal(insert.values[0], 'DL5477');
  assert.equal(insert.values[1], 'persistent-dl5477-profile');
  assert.equal(insert.values[7], 0);
  assert.equal(insert.values[8], null);
  assert.equal(pool.statements[1].text, 'SET LOCAL ROLE sheinfm_webapi_loader');
});

test('session health refuses an unknown state or a non-canonical store pair', async () => {
  const pool = fakePool(() => ({ rows: [], rowCount: 1 }));
  const repository = createWebApiExperimentRepository({ pool });
  await assert.rejects(() => repository.recordSessionHealth({
    storeCode: 'DL5477',
    profileKey: 'persistent-dl5477-profile',
    observedAt: OBSERVED_AT,
    sessionState: 'HEALTHY',
  }), TypeError);
  await assert.rejects(() => repository.recordSessionHealth({
    storeCode: 'DL5477',
    profileKey: 'persistent-mz2406-profile',
    observedAt: OBSERVED_AT,
    sessionState: 'ACTIVE',
  }), (error) => error.code === 'WEBAPI_REPOSITORY_INPUT_INVALID');
  assert.deepEqual(pool.statements, []);
});

test('the repository requires a pool that can open a transaction', () => {
  assert.throws(() => createWebApiExperimentRepository({}), TypeError);
  assert.throws(
    () => createWebApiExperimentRepository({ pool: { query: async () => ({ rows: [] }) } }),
    TypeError,
  );
});
