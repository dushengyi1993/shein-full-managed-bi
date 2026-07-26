import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createCanonicalProduct,
  createCanonicalVariant,
  recordIdentifierObservations,
  recordProductIdentityDecision,
  recordProductMatchCandidate,
} from '../../src/warehouse/identity-repository.mjs';

class FakeClient {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
    this.released = false;
  }

  async query(sql, values = []) {
    this.calls.push({ sql, values });
    const response = await this.handler?.(sql, values, this);
    return response ?? { rows: [], rowCount: 0 };
  }

  release() {
    this.released = true;
  }
}

function pool(client) {
  return { async connect() { return client; } };
}

function row(rows) {
  return { rows, rowCount: rows.length };
}

test('creates one global canonical product transactionally with parameterized SQL', async () => {
  const client = new FakeClient((sql) => {
    if (sql.includes('INSERT INTO dim.canonical_product')) {
      return row([{ canonical_product_id: 41, source_payload_fingerprint: 'unused' }]);
    }
    return undefined;
  });

  const result = await createCanonicalProduct(pool(client), {
    canonicalProductKey: 'AIRFRYER:DLPA4',
    displayName: "DL's 6L fryer",
    profile: {
      brand: 'DL',
      category: 'Air Fryer',
      model: 'DL-PA4',
      supplierCode: 'DL-PA4',
      coreAttributes: { material: 'ABS' },
    },
  });

  assert.deepEqual(result, {
    canonicalProductId: 41,
    created: true,
  });
  assert.equal(client.calls[0].sql, 'BEGIN');
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
  assert.equal(client.released, true);
  const insert = client.calls.find(({ sql }) => sql.includes('INSERT INTO dim.canonical_product'));
  assert.equal(insert.values[0], 'AIRFRYER:DLPA4');
  assert.equal(insert.values[1], "DL's 6L fryer");
  assert.doesNotMatch(insert.sql, /DL's 6L fryer|AIRFRYER:DLPA4/);
  assert.doesNotMatch(insert.sql, /\bstore_id\b/);
  assert.equal(insert.values[6], 'DLPA4');
  assert.match(insert.values[8], /^[a-f0-9]{64}$/);
});

test('keys a global variant within its canonical product rather than within a store', async () => {
  const client = new FakeClient((sql) => {
    if (sql.includes('FROM dim.canonical_product')) {
      return row([{ canonical_product_id: 41, source_payload_fingerprint: 'f'.repeat(64) }]);
    }
    if (sql.includes('INSERT INTO dim.canonical_variant')) {
      return row([{ canonical_variant_id: 42, source_payload_fingerprint: 'unused' }]);
    }
    return undefined;
  });
  const result = await createCanonicalVariant(pool(client), {
    canonicalProductKey: 'AIRFRYER:DLPA4',
    canonicalVariantKey: 'AIRFRYER:DLPA4:EU:6L',
    displayName: 'DL PA4 6L EU',
    profile: { voltage: '220V', plug: 'EU', capacity: '6L' },
    variantAttributes: { color: 'white' },
  });
  assert.deepEqual(result, {
    canonicalVariantId: 42,
    created: true,
  });
  const insert = client.calls.find(({ sql }) => sql.includes('INSERT INTO dim.canonical_variant'));
  assert.match(insert.sql, /ON CONFLICT \(canonical_product_id, canonical_variant_key\)/);
  assert.doesNotMatch(insert.sql, /\bstore_id\b/);
  assert.equal(insert.values[0], 41);
  assert.equal(insert.values[1], 'AIRFRYER:DLPA4:EU:6L');
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
});

test('keeps identifier raw values byte-for-byte separate from normalized comparison values', async () => {
  let fingerprint;
  const client = new FakeClient((sql, values) => {
    if (sql.includes('JOIN dim.full_sku')) {
      return row([{ store_id: 7, full_sku_id: 70 }]);
    }
    if (sql.includes('INSERT INTO raw.identifier_observation')) {
      fingerprint = values[9];
      return row([]);
    }
    if (sql.includes('SELECT payload_fingerprint')) {
      return row([{ payload_fingerprint: fingerprint }]);
    }
    return undefined;
  });

  const result = await recordIdentifierObservations(pool(client), {
    storeCode: 'DL',
    platformSkuId: 'SKU-001',
    observations: [{
      observationKey: 'catalog-7:SKU-001:model',
      identifierType: 'MODEL',
      rawValue: ' DL-pa4 / 6L ',
      sourceSystem: 'SHEIN_OPENAPI',
      sourceField: 'model',
      evidence: { traceId: 'safe-trace' },
      observedAt: '2026-07-26T12:00:00.000Z',
    }],
  });

  assert.deepEqual(result, {
    storeCode: 'DL',
    platformSkuId: 'SKU-001',
    observationCount: 1,
    createdCount: 0,
  });
  const insert = client.calls.find(({ sql }) => sql.includes('INSERT INTO raw.identifier_observation'));
  assert.equal(insert.values[4], ' DL-pa4 / 6L ');
  assert.equal(insert.values[5], 'DLPA46L');
  assert.match(insert.sql, /ON CONFLICT \(store_id, observation_key\) DO NOTHING/);
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
});

test('fails closed and rolls back when an observation idempotency key drifts', async () => {
  const client = new FakeClient((sql) => {
    if (sql.includes('JOIN dim.full_sku')) {
      return row([{ store_id: 7, full_sku_id: 70 }]);
    }
    if (sql.includes('INSERT INTO raw.identifier_observation')) return row([]);
    if (sql.includes('SELECT payload_fingerprint')) {
      return row([{ payload_fingerprint: '0'.repeat(64) }]);
    }
    return undefined;
  });

  await assert.rejects(
    () => recordIdentifierObservations(pool(client), {
      storeCode: 'DL',
      platformSkuId: 'SKU-001',
      observations: [{
        observationKey: 'same-key',
        identifierType: 'BARCODE',
        rawValue: '6901234567890',
        sourceSystem: 'SHEIN_OPENAPI',
        sourceField: 'barcode',
        observedAt: '2026-07-26T12:00:00.000Z',
      }],
    }),
    /drifted payload/,
  );
  assert.equal(client.calls.some(({ sql }) => sql === 'ROLLBACK'), true);
  assert.equal(client.calls.some(({ sql }) => sql === 'COMMIT'), false);
  assert.equal(client.released, true);
});

test('records a scored candidate and auto-confirms it through an append-only decision', async () => {
  const candidateClient = new FakeClient((sql) => {
    if (sql.includes('JOIN dim.full_sku')) {
      return row([{ store_id: 7, full_sku_id: 70 }]);
    }
    if (sql.includes('FROM dim.canonical_product')) {
      return row([{ canonical_product_id: 80, source_payload_fingerprint: 'f'.repeat(64) }]);
    }
    if (sql.includes('INSERT INTO ops.product_match_candidate')) {
      return row([{ product_match_candidate_id: 90 }]);
    }
    return undefined;
  });
  const candidate = await recordProductMatchCandidate(pool(candidateClient), {
    storeCode: 'DL',
    platformSkuId: 'SKU-001',
    canonicalProductKey: 'AIRFRYER:DLPA4',
    candidateKey: 'candidate:SKU-001:DLPA4:v1',
    sourceProfile: { barcode: '6901234567892', model: 'DL-PA4' },
    targetProfile: { barcode: '6901234567892', model: 'DLPA4' },
    evaluatedAt: '2026-07-26T12:05:00.000Z',
  });
  assert.equal(candidate.evaluation.recommendation, 'CONFIRMED');
  assert.equal(candidate.evaluation.score, 0.95);

  const decisionClient = new FakeClient((sql) => {
    if (sql.includes('FROM ops.product_match_candidate AS c')) {
      return row([{
        product_match_candidate_id: 90,
        store_id: 7,
        full_sku_id: 70,
        canonical_product_id: 80,
        canonical_variant_id: null,
        score: '0.95000',
        recommendation: 'CONFIRMED',
        strong_evidence_types: ['BARCODE', 'MODEL'],
        hard_conflicts: [],
      }]);
    }
    if (sql.includes('INSERT INTO ops.product_identity_decision')) {
      return row([{ product_identity_decision_id: 100 }]);
    }
    if (sql.includes('UPDATE dim.full_sku_canonical_assignment')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO dim.full_sku_canonical_assignment')) {
      return row([{ full_sku_canonical_assignment_id: 110 }]);
    }
    return undefined;
  });
  const decision = await recordProductIdentityDecision(pool(decisionClient), {
    storeCode: 'DL',
    candidateKey: 'candidate:SKU-001:DLPA4:v1',
    decisionKey: 'decision:SKU-001:DLPA4:v1',
    decisionOutcome: 'CONFIRMED',
    decisionSource: 'AUTO',
    actorKey: 'identity-engine:v1',
    rationale: 'Threshold and independent evidence gates passed.',
    decidedAt: '2026-07-26T12:06:00.000Z',
  });

  assert.equal(decision.productIdentityDecisionId, 100);
  assert.equal(decision.fullSkuCanonicalAssignmentId, 110);
  const calls = decisionClient.calls.map(({ sql }) => sql);
  assert.ok(
    calls.findIndex((sql) => sql.includes('INSERT INTO ops.product_identity_decision')) <
      calls.findIndex((sql) => sql.includes('INSERT INTO dim.full_sku_canonical_assignment')),
  );
  assert.equal(calls.some((sql) => sql.includes("assignment_status = 'SUPERSEDED'")), true);
  assert.equal(decisionClient.calls.at(-1).sql, 'COMMIT');
});

test('hard conflicts block human and automatic confirmation before an audit decision insert', async () => {
  const client = new FakeClient((sql) => {
    if (sql.includes('FROM ops.product_match_candidate AS c')) {
      return row([{
        product_match_candidate_id: 90,
        store_id: 7,
        full_sku_id: 70,
        canonical_product_id: 80,
        canonical_variant_id: null,
        score: '1.00000',
        recommendation: 'BLOCKED',
        strong_evidence_types: ['BARCODE', 'MODEL'],
        hard_conflicts: [{ field: 'voltage', source: '110V', target: '220V' }],
      }]);
    }
    return undefined;
  });
  await assert.rejects(
    () => recordProductIdentityDecision(pool(client), {
      storeCode: 'DL',
      candidateKey: 'blocked',
      decisionKey: 'do-not-merge',
      decisionOutcome: 'CONFIRMED',
      decisionSource: 'HUMAN',
      actorKey: 'EMP-001',
      rationale: 'Attempted override',
      decidedAt: '2026-07-26T12:06:00.000Z',
    }),
    /cannot be overridden/,
  );
  assert.equal(
    client.calls.some(({ sql }) => sql.includes('INSERT INTO ops.product_identity_decision')),
    false,
  );
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
});

test('migration keeps canonical identities global while source evidence and assignments stay store-scoped', async () => {
  const sql = await readFile(
    new URL('../../db/migrations/0004_product_identity_and_access.sql', import.meta.url),
    'utf8',
  );
  for (const table of [
    'dim.canonical_product',
    'dim.canonical_variant',
    'raw.identifier_observation',
    'ops.product_match_candidate',
    'ops.product_identity_decision',
    'dim.full_sku_canonical_assignment',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')}`));
  }
  assert.match(sql, /UNIQUE \(canonical_product_key\)/);
  assert.match(sql, /UNIQUE \(canonical_product_id, canonical_variant_key\)/);
  assert.match(sql, /UNIQUE \(store_id, observation_key\)/);
  assert.doesNotMatch(
    sql.match(/CREATE TABLE IF NOT EXISTS dim\.canonical_product \([\s\S]*?\n\);/)?.[0] || '',
    /\bstore_id\b/,
  );
  assert.match(
    sql,
    /uq_dim_full_sku_canonical_assignment_current[\s\S]*WHERE assignment_status = 'CONFIRMED' AND valid_to IS NULL/,
  );
  assert.match(sql, /trg_raw_identifier_observation_append_only/);
  assert.match(
    sql,
    /score >= 0\.95[\s\S]*distinct_identity_evidence_count\(strong_evidence_types\) >= 2/,
  );
  assert.doesNotMatch(sql, /\bDROP TABLE\b|\bTRUNCATE\b/);
});
