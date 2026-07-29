import assert from 'node:assert/strict';
import test from 'node:test';

import { readProductIdentityPipeline } from '../../src/warehouse/dashboard-materializer.mjs';

// raw.identifier_observation is intentionally absent: the aggregate never reads
// raw identifier rows, so the materializer role has no SELECT on it and probing
// it would report the pipeline unavailable.
const READY_SCHEMA = Object.freeze({
  has_observation_set: true,
  has_candidate: true,
  has_decision: true,
  has_assignment: true,
  has_canonical_product: true,
  has_canonical_variant: true,
  has_candidate_run: true,
  has_candidate_scope: true,
  has_assignment_scope: true,
  has_canonical_scope: true,
});

/**
 * Minimal client seam: the reader issues one schema probe and then five
 * aggregate queries, so the stub answers by matching the query text and records
 * every statement for inspection.
 */
function stubClient(schema, results = {}) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (sql.includes('to_regclass')) return { rows: [schema] };
      if (sql.includes('sealed_set_count')) return { rows: [results.evidence ?? {}] };
      if (sql.includes('review_required')) return { rows: [results.candidates ?? {}] };
      // `current_confirmed_count` also contains `confirmed_count`, so the more
      // specific assignment match has to be tested first.
      if (sql.includes('current_confirmed_count')) return { rows: [results.assignments ?? {}] };
      if (sql.includes('confirmed_count')) return { rows: [results.decisions ?? {}] };
      if (sql.includes('global_active_product_count')) return { rows: [results.canonical ?? {}] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('a missing identity migration yields an explicit unavailable contract', async () => {
  for (const missing of [
    'has_observation_set',
    'has_candidate',
    'has_decision',
    'has_assignment',
    'has_canonical_product',
    'has_canonical_variant',
    'has_candidate_run',
    'has_candidate_scope',
    'has_assignment_scope',
    'has_canonical_scope',
  ]) {
    const client = stubClient({ ...READY_SCHEMA, [missing]: false });
    const pipeline = await readProductIdentityPipeline(client);
    assert.equal(pipeline.status, 'unavailable', missing);
    assert.equal(pipeline.basis, 'schema_unavailable', missing);
    // Unknown never degrades into an invented zero.
    assert.equal(pipeline.evidence.sealedSetCount, null, missing);
    assert.equal(pipeline.evidence.observedStoreCount, null, missing);
    assert.equal(pipeline.evidence.identifierMemberCount, null, missing);
    assert.equal(pipeline.candidates.total, null, missing);
    assert.equal(pipeline.decisions.confirmedCount, null, missing);
    assert.equal(pipeline.assignments.currentConfirmedCount, null, missing);
    assert.equal(pipeline.canonical.globalActiveProductCount, null, missing);
    assert.equal(pipeline.updatedAt, null, missing);
    // Only the schema probe runs; no aggregate query is attempted.
    assert.equal(client.queries.length, 1, missing);
  }

  const empty = await readProductIdentityPipeline(stubClient({}));
  assert.equal(empty.status, 'unavailable');
  assert.match(empty.note, /未知/);
});

test('an available pipeline maps the five aggregates into counts and timestamps', async () => {
  const client = stubClient(READY_SCHEMA, {
    evidence: {
      sealed_set_count: 10_012,
      observed_store_count: 24,
      identifier_member_count: 364_545,
      latest_sealed_at: new Date('2026-07-29T01:00:00.000Z'),
    },
    candidates: {
      total: 482,
      confirmed: 482,
      proposed: 0,
      review_required: 0,
      blocked: 0,
      global_scope: 482,
      local_scope: 0,
      latest_evaluated_at: new Date('2026-07-29T01:10:00.000Z'),
    },
    decisions: {
      confirmed_count: 482,
      latest_decided_at: new Date('2026-07-29T01:20:00.000Z'),
    },
    assignments: {
      current_confirmed_count: 482,
      latest_assigned_at: new Date('2026-07-29T01:30:00.000Z'),
    },
    canonical: { global_active_product_count: 66, active_variant_count: 66 },
  });
  const pipeline = await readProductIdentityPipeline(client);

  assert.equal(pipeline.status, 'available');
  assert.equal(pipeline.basis, 'identity_resolution_schema');
  assert.deepEqual(pipeline.evidence, {
    sealedSetCount: 10_012,
    observedStoreCount: 24,
    identifierMemberCount: 364_545,
    latestSealedAt: '2026-07-29T01:00:00.000Z',
  });
  assert.deepEqual(pipeline.candidates, {
    total: 482,
    confirmed: 482,
    proposed: 0,
    reviewRequired: 0,
    blocked: 0,
    globalScope: 482,
    localSingletonScope: 0,
    latestEvaluatedAt: '2026-07-29T01:10:00.000Z',
  });
  assert.deepEqual(pipeline.decisions, {
    confirmedCount: 482,
    latestDecidedAt: '2026-07-29T01:20:00.000Z',
  });
  assert.deepEqual(pipeline.assignments, {
    currentConfirmedCount: 482,
    latestAssignedAt: '2026-07-29T01:30:00.000Z',
  });
  assert.deepEqual(pipeline.canonical, {
    globalActiveProductCount: 66,
    activeVariantCount: 66,
  });
  // updatedAt is the newest stage timestamp, not a clock read.
  assert.equal(pipeline.updatedAt, '2026-07-29T01:30:00.000Z');

  const [, ...aggregates] = client.queries;
  assert.equal(aggregates.length, 5);
  // Evidence and candidates are bounded to the newest run only.
  const evidenceQuery = aggregates.find((sql) => sql.includes('sealed_set_count'));
  assert.match(evidenceQuery, /status = 'SEALED'/);
  assert.match(evidenceQuery, /ORDER BY max\(sealed_at\) DESC/);
  assert.match(evidenceQuery, /LIMIT 1/);
  const candidateQuery = aggregates.find((sql) => sql.includes('review_required'));
  assert.match(candidateQuery, /GROUP BY observation_run_id/);
  assert.match(candidateQuery, /ORDER BY max\(evaluated_at\) DESC/);
  assert.match(candidateQuery, /LIMIT 1/);
  // Only current GLOBAL confirmed assignments count as merged identity.
  const assignmentQuery = aggregates.find((sql) => sql.includes('current_confirmed_count'));
  assert.match(assignmentQuery, /assignment_status = 'CONFIRMED'/);
  assert.match(assignmentQuery, /valid_to IS NULL/);
  assert.match(assignmentQuery, /identity_scope = 'GLOBAL'/);
});

test('the projection carries no raw identifier, run id, fingerprint or evidence payload', async () => {
  const client = stubClient(READY_SCHEMA, {
    evidence: {
      sealed_set_count: 3,
      observed_store_count: 2,
      identifier_member_count: 9,
      latest_sealed_at: new Date('2026-07-29T01:00:00.000Z'),
      // Columns the SQL never selects; a future drift must still not leak them.
      observation_run_id: 'RUN-2026-07-29-SECRET',
      set_payload_fingerprint: 'a'.repeat(64),
      raw_value: 'GTIN-0000000000000',
    },
    candidates: { total: 3, confirmed: 1, matched_evidence: [{ type: 'BARCODE' }] },
    decisions: { confirmed_count: 1 },
    assignments: { current_confirmed_count: 1 },
    canonical: { global_active_product_count: 1, active_variant_count: 0 },
  });
  const pipeline = await readProductIdentityPipeline(client);

  assert.deepEqual(Object.keys(pipeline).sort(), [
    'assignments', 'basis', 'candidates', 'canonical',
    'decisions', 'evidence', 'note', 'status', 'updatedAt',
  ]);
  const serialized = JSON.stringify(pipeline);
  assert.doesNotMatch(serialized, /RUN-2026-07-29-SECRET/);
  assert.doesNotMatch(serialized, /a{64}/);
  assert.doesNotMatch(serialized, /GTIN-0000000000000/);
  assert.doesNotMatch(serialized, /fingerprint|payload|rawValue|raw_value|matchedEvidence/i);
  assert.doesNotMatch(serialized, /observationRunId|observation_run_id/);
  // A canonical product without a variant is legal and stays zero, not null.
  assert.equal(pipeline.canonical.activeVariantCount, 0);
});

test('an absent aggregate row stays unknown instead of becoming zero', async () => {
  const client = stubClient(READY_SCHEMA, {
    evidence: { sealed_set_count: null, latest_sealed_at: null },
    candidates: {},
    decisions: {},
    assignments: {},
    canonical: {},
  });
  const pipeline = await readProductIdentityPipeline(client);
  assert.equal(pipeline.status, 'available');
  assert.equal(pipeline.evidence.sealedSetCount, null);
  assert.equal(pipeline.evidence.latestSealedAt, null);
  assert.equal(pipeline.candidates.total, null);
  assert.equal(pipeline.decisions.confirmedCount, null);
  assert.equal(pipeline.assignments.currentConfirmedCount, null);
  assert.equal(pipeline.canonical.globalActiveProductCount, null);
  assert.equal(pipeline.updatedAt, null);
});

test('a negative or non-integer aggregate fails closed instead of being coerced', async () => {
  await assert.rejects(
    () => readProductIdentityPipeline(stubClient(READY_SCHEMA, {
      evidence: { sealed_set_count: -1 },
    })),
    TypeError,
  );
  await assert.rejects(
    () => readProductIdentityPipeline(stubClient(READY_SCHEMA, {
      evidence: { sealed_set_count: 1.5 },
    })),
    TypeError,
  );
});
