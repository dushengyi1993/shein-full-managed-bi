import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES,
  applyProductIdentityResolutionPlan,
  prepareProductIdentityResolutionPlan,
} from '../../src/warehouse/product-identity-resolution-repository.mjs';
import {
  normalizeIdentifierValue,
} from '../../src/domain/product-identity.mjs';

const OBSERVATION_RUN_ID = 'identity-observation-20260727';
const AUDIT_RUN_ID = 'identity-resolution-20260727';
const NOW = '2026-07-27T08:00:00.000Z';

function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function universeRow({
  storeId,
  storeCode,
  fullSkuId,
  platformSpuId,
  platformSkcId,
  platformSkuId,
}) {
  return {
    store_id: storeId,
    store_code: storeCode,
    full_sku_id: fullSkuId,
    platform_spu_id: platformSpuId,
    platform_skc_id: platformSkcId,
    platform_sku_id: platformSkuId,
    assignment_id: null,
    assignment_key: null,
    assignment_canonical_product_id: null,
    assignment_decision_id: null,
    assignment_identity_scope: null,
    assignment_identity_component_key: null,
    assignment_observation_run_id: null,
    assignment_plan_hash: null,
  };
}

function observation({
  id,
  set,
  identifierType,
  rawValue,
  identityScope,
  sourceValueKey,
  evidence = {},
}) {
  return {
    identifier_observation_id: id,
    observation_store_id: set.storeId,
    observation_full_sku_id: set.fullSkuId,
    observation_fetch_batch_id: set.fetchBatchId,
    observation_set_id: set.setId,
    identifier_type: identifierType,
    raw_value: rawValue,
    normalized_value: identifierType === 'IMAGE_REFERENCE'
      ? null
      : normalizeIdentifierValue(identifierType, rawValue),
    evidence,
    identity_scope: identityScope,
    scope_key: identityScope === 'PRODUCT'
      ? `SPU:${set.platformSpuId}`
      : `SKU:${set.platformSkuId}`,
    source_value_key: sourceValueKey,
    payload_fingerprint: hash(`member:${id}`),
  };
}

function sealedSetRows({
  setId,
  storeId,
  fullSkuId,
  fetchBatchId,
  platformSpuId,
  platformSkcId,
  platformSkuId,
  model = 'MODEL-X',
  memberCountOverride,
}) {
  const set = {
    setId,
    storeId,
    fullSkuId,
    fetchBatchId,
    platformSpuId,
    platformSkcId,
    platformSkuId,
  };
  const members = [
    observation({
      id: setId * 100 + 1,
      set,
      identifierType: 'PLATFORM_SPU',
      rawValue: platformSpuId,
      identityScope: 'PRODUCT',
      sourceValueKey: 'product.platform_spu',
    }),
    observation({
      id: setId * 100 + 2,
      set,
      identifierType: 'PLATFORM_SKC',
      rawValue: platformSkcId,
      identityScope: 'VARIANT',
      sourceValueKey: 'variant.platform_skc',
    }),
    observation({
      id: setId * 100 + 3,
      set,
      identifierType: 'PLATFORM_SKU',
      rawValue: platformSkuId,
      identityScope: 'VARIANT',
      sourceValueKey: 'variant.platform_sku',
    }),
    observation({
      id: setId * 100 + 4,
      set,
      identifierType: 'SUPPLIER_CODE',
      rawValue: 'SUPPLIER-1',
      identityScope: 'PRODUCT',
      sourceValueKey: 'product.supplier_code',
      evidence: { sourceLayer: 'SPU', strongEvidence: false },
    }),
    observation({
      id: setId * 100 + 5,
      set,
      identifierType: 'BRAND',
      rawValue: 'ACME',
      identityScope: 'PRODUCT',
      sourceValueKey: 'product.brand_code',
      evidence: { strongEvidence: false },
    }),
    observation({
      id: setId * 100 + 6,
      set,
      identifierType: 'CATEGORY',
      rawValue: 'AIR FRYER',
      identityScope: 'PRODUCT',
      sourceValueKey: 'product.category_id',
      evidence: { strongEvidence: false },
    }),
    observation({
      id: setId * 100 + 7,
      set,
      identifierType: 'MODEL',
      rawValue: model,
      identityScope: 'PRODUCT',
      sourceValueKey: `product.attribute:1000546:${hash(model).slice(0, 24)}`,
      evidence: {
        attributeId: '1000546',
        classification: 'MODEL',
        strongEvidence: true,
      },
    }),
    observation({
      id: setId * 100 + 8,
      set,
      identifierType: 'BARCODE',
      rawValue: '6901234567892',
      identityScope: 'VARIANT',
      sourceValueKey: `variant.barcode:${hash('6901234567892').slice(0, 24)}`,
      evidence: {
        barcodeStandard: 'EAN',
        barcodeType: 'EAN13',
        gtinCheckDigitValid: true,
        strongEvidence: true,
      },
    }),
  ];
  return members.map((member) => ({
    identity_observation_set_id: setId,
    store_id: storeId,
    full_sku_id: fullSkuId,
    source_fetch_batch_id: fetchBatchId,
    observation_run_id: OBSERVATION_RUN_ID,
    set_status: 'SEALED',
    member_count: memberCountOverride ?? members.length,
    platform_spu_id: platformSpuId,
    platform_skc_id: platformSkcId,
    platform_sku_id: platformSkuId,
    set_payload_fingerprint: hash(`set:${setId}`),
    ...member,
  }));
}

function baseFixture({ includeMissingHierarchy = false } = {}) {
  const universe = [
    universeRow({
      storeId: 1,
      storeCode: 'DL',
      fullSkuId: 11,
      platformSpuId: 'DL-SPU-1',
      platformSkcId: 'DL-SKC-1',
      platformSkuId: 'DL-SKU-1',
    }),
    universeRow({
      storeId: 2,
      storeCode: 'CX',
      fullSkuId: 21,
      platformSpuId: 'CX-SPU-1',
      platformSkcId: 'CX-SKC-1',
      platformSkuId: 'CX-SKU-1',
    }),
  ];
  if (includeMissingHierarchy) {
    universe.push(universeRow({
      storeId: 1,
      storeCode: 'DL',
      fullSkuId: 12,
      platformSpuId: null,
      platformSkcId: 'DL-SKC-MISSING',
      platformSkuId: 'DL-SKU-MISSING',
    }));
  }
  return {
    universe,
    evidenceRows: [
      ...sealedSetRows({
        setId: 101,
        storeId: 1,
        fullSkuId: 11,
        fetchBatchId: 1001,
        platformSpuId: 'DL-SPU-1',
        platformSkcId: 'DL-SKC-1',
        platformSkuId: 'DL-SKU-1',
      }),
      ...sealedSetRows({
        setId: 201,
        storeId: 2,
        fullSkuId: 21,
        fetchBatchId: 2001,
        platformSpuId: 'CX-SPU-1',
        platformSkcId: 'CX-SKC-1',
        platformSkuId: 'CX-SKU-1',
      }),
    ],
  };
}

function cloneMap(map) {
  return new Map([...map.entries()].map(([key, value]) => [
    key,
    structuredClone(value),
  ]));
}

class FakeResolutionDatabase {
  constructor(fixture = baseFixture()) {
    this.universe = structuredClone(fixture.universe);
    this.evidenceRows = structuredClone(fixture.evidenceRows);
    this.calls = [];
    this.releaseCount = 0;
    this.nextIds = {
      canonical: 1,
      provenance: 1,
      candidate: 1,
      evidence: 1,
      decision: 1,
      assignment: 1,
    };
    this.canonical = new Map();
    this.provenance = new Map();
    this.candidates = new Map();
    this.candidateEvidence = new Map();
    this.decisions = new Map();
    this.assignments = new Map();
    this.transactionSnapshot = null;
  }

  result(rows = []) {
    return { rows, rowCount: rows.length };
  }

  snapshot() {
    return {
      canonical: cloneMap(this.canonical),
      provenance: cloneMap(this.provenance),
      candidates: cloneMap(this.candidates),
      candidateEvidence: cloneMap(this.candidateEvidence),
      decisions: cloneMap(this.decisions),
      assignments: cloneMap(this.assignments),
      nextIds: { ...this.nextIds },
    };
  }

  restore(snapshot) {
    Object.assign(this, snapshot);
  }

  currentAssignment(storeId, fullSkuId) {
    return [...this.assignments.values()].find((row) => (
      String(row.store_id) === String(storeId)
      && String(row.full_sku_id) === String(fullSkuId)
      && row.assignment_status === 'CONFIRMED'
      && row.valid_to === null
    )) ?? null;
  }

  activeUniverseRows() {
    return this.universe.map((row) => {
      const assignment = this.currentAssignment(row.store_id, row.full_sku_id);
      if (!assignment) return { ...row };
      return {
        ...row,
        assignment_id: assignment.full_sku_canonical_assignment_id,
        assignment_key: assignment.assignment_key,
        assignment_canonical_product_id: assignment.canonical_product_id,
        assignment_decision_id: assignment.product_identity_decision_id,
        assignment_identity_scope: assignment.identity_scope,
        assignment_identity_component_key: assignment.identity_component_key,
        assignment_observation_run_id: assignment.observation_run_id,
        assignment_plan_hash: assignment.plan_hash,
      };
    });
  }

  bulkInsert(values, table, keyOf, idName, idCounter) {
    const created = [];
    for (const input of JSON.parse(values[0])) {
      const key = keyOf(input);
      if (table.has(key)) continue;
      const row = {
        ...input,
        [idName]: this.nextIds[idCounter],
      };
      this.nextIds[idCounter] += 1;
      table.set(key, row);
      created.push(row);
    }
    return created;
  }

  async query(sql, values = []) {
    this.calls.push({ sql, values });
    if (sql.startsWith('BEGIN')) {
      this.transactionSnapshot = this.snapshot();
      return this.result();
    }
    if (sql === 'ROLLBACK') {
      this.restore(this.transactionSnapshot);
      this.transactionSnapshot = null;
      return this.result();
    }
    if (sql === 'COMMIT') {
      this.transactionSnapshot = null;
      return this.result();
    }
    if (
      sql.startsWith('SET LOCAL')
      || sql.includes('pg_advisory_xact_lock')
    ) {
      return this.result();
    }
    if (
      sql.includes('FROM dim.full_sku AS sku')
      && sql.includes('LEFT JOIN dim.full_sku_canonical_assignment')
    ) {
      return this.result(this.activeUniverseRows());
    }
    if (sql.includes('FROM raw.product_identity_observation_set AS evidence_set')) {
      return this.result(structuredClone(this.evidenceRows));
    }
    if (
      sql.includes('FROM dim.full_sku')
      && sql.includes('FOR UPDATE')
    ) {
      return this.result(
        values[0].map((fullSkuId) => ({ full_sku_id: fullSkuId })),
      );
    }
    if (
      sql.includes('INSERT INTO dim.canonical_product')
      && sql.includes('jsonb_populate_recordset')
    ) {
      const created = this.bulkInsert(
        values,
        this.canonical,
        (row) => row.canonical_product_key,
        'canonical_product_id',
        'canonical',
      );
      return this.result(created.map((row) => ({
        canonical_product_key: row.canonical_product_key,
      })));
    }
    if (
      sql.includes('FROM dim.canonical_product')
      && sql.includes('canonical_product_key = ANY')
    ) {
      return this.result(values[0].map((key) => this.canonical.get(key)).filter(Boolean));
    }
    if (
      sql.includes('INSERT INTO ops.canonical_product_observation_set')
      && sql.includes('jsonb_populate_recordset')
    ) {
      const created = this.bulkInsert(
        values,
        this.provenance,
        (row) => `${row.canonical_product_id}:${row.identity_observation_set_id}`,
        'canonical_product_observation_set_id',
        'provenance',
      );
      return this.result(created.map((row) => ({
        canonical_product_id: row.canonical_product_id,
        identity_observation_set_id: row.identity_observation_set_id,
      })));
    }
    if (
      sql.includes('FROM ops.canonical_product_observation_set AS provenance')
      && !sql.includes('AS provenance_count')
    ) {
      const keys = JSON.parse(values[0]).map(
        (row) => `${row.canonical_product_id}:${row.identity_observation_set_id}`,
      );
      return this.result(keys.map((key) => this.provenance.get(key)).filter(Boolean));
    }
    if (
      sql.includes('INSERT INTO ops.product_match_candidate')
      && !sql.includes('product_match_candidate_evidence')
      && sql.includes('jsonb_populate_recordset')
    ) {
      const created = this.bulkInsert(
        values,
        this.candidates,
        (row) => `${row.store_id}:${row.candidate_key}`,
        'product_match_candidate_id',
        'candidate',
      );
      return this.result(created.map((row) => ({
        store_id: row.store_id,
        candidate_key: row.candidate_key,
      })));
    }
    if (
      sql.includes('FROM ops.product_match_candidate AS candidate')
      && !sql.includes('product_match_candidate_evidence')
    ) {
      const keys = JSON.parse(values[0]).map(
        (row) => `${row.store_id}:${row.candidate_key}`,
      );
      return this.result(keys.map((key) => this.candidates.get(key)).filter(Boolean));
    }
    if (
      sql.includes('INSERT INTO ops.product_match_candidate_evidence')
      && sql.includes('jsonb_populate_recordset')
    ) {
      const keyOf = (row) => [
        row.product_match_candidate_id,
        row.relation_key,
        row.source_identifier_observation_id,
        row.target_identifier_observation_id,
        row.component,
      ].join(':');
      const created = this.bulkInsert(
        values,
        this.candidateEvidence,
        keyOf,
        'product_match_candidate_evidence_id',
        'evidence',
      );
      return this.result(created.map((row) => ({
        product_match_candidate_id: row.product_match_candidate_id,
        relation_key: row.relation_key,
        source_identifier_observation_id: row.source_identifier_observation_id,
        target_identifier_observation_id: row.target_identifier_observation_id,
        component: row.component,
      })));
    }
    if (sql.includes('FROM ops.product_match_candidate_evidence AS evidence')) {
      const keyOf = (row) => [
        row.product_match_candidate_id,
        row.relation_key,
        row.source_identifier_observation_id,
        row.target_identifier_observation_id,
        row.component,
      ].join(':');
      return this.result(
        JSON.parse(values[0])
          .map((row) => this.candidateEvidence.get(keyOf(row)))
          .filter(Boolean),
      );
    }
    if (
      sql.includes('INSERT INTO ops.product_identity_decision')
      && sql.includes('jsonb_populate_recordset')
    ) {
      const created = this.bulkInsert(
        values,
        this.decisions,
        (row) => `${row.store_id}:${row.decision_key}`,
        'product_identity_decision_id',
        'decision',
      );
      return this.result(created.map((row) => ({
        store_id: row.store_id,
        decision_key: row.decision_key,
      })));
    }
    if (sql.includes('FROM ops.product_identity_decision AS decision')) {
      const keys = JSON.parse(values[0]).map(
        (row) => `${row.store_id}:${row.decision_key}`,
      );
      return this.result(keys.map((key) => this.decisions.get(key)).filter(Boolean));
    }
    if (
      sql.includes('INSERT INTO dim.full_sku_canonical_assignment')
      && sql.includes('jsonb_populate_recordset')
    ) {
      const created = this.bulkInsert(
        values,
        this.assignments,
        (row) => `${row.store_id}:${row.assignment_key}`,
        'full_sku_canonical_assignment_id',
        'assignment',
      );
      return this.result(created.map((row) => ({
        store_id: row.store_id,
        assignment_key: row.assignment_key,
      })));
    }
    if (
      sql.includes('FROM dim.full_sku_canonical_assignment AS assignment')
      && sql.includes('jsonb_to_recordset')
    ) {
      const keys = JSON.parse(values[0]).map(
        (row) => `${row.store_id}:${row.assignment_key}`,
      );
      return this.result(keys.map((key) => this.assignments.get(key)).filter(Boolean));
    }
    if (sql.includes('AS canonical_product_count')) {
      const componentKeys = new Set(values[1]);
      const planHash = values[2];
      const canonicalIds = new Set(
        [...this.canonical.values()]
          .filter((row) => componentKeys.has(row.identity_component_key))
          .map((row) => String(row.canonical_product_id)),
      );
      return this.result([{
        canonical_product_count: canonicalIds.size,
        provenance_count: [...this.provenance.values()].filter((row) => (
          canonicalIds.has(String(row.canonical_product_id))
          && row.observation_run_id === values[0]
        )).length,
        candidate_count: [...this.candidates.values()].filter(
          (row) => row.plan_hash === planHash,
        ).length,
        candidate_evidence_count: [...this.candidateEvidence.values()].filter(
          (row) => row.plan_hash === planHash,
        ).length,
        decision_count: [...this.decisions.values()].filter(
          (row) => row.plan_hash === planHash,
        ).length,
        assignment_count: [...this.assignments.values()].filter(
          (row) => row.plan_hash === planHash,
        ).length,
      }]);
    }
    if (
      sql.includes('FROM dim.full_sku_canonical_assignment')
      && sql.includes('assignment_status =')
      && sql.includes('full_sku_id = ANY')
    ) {
      const ids = new Set(values[0].map(String));
      return this.result(
        [...this.assignments.values()]
          .filter((row) => (
            ids.has(String(row.full_sku_id))
            && row.assignment_status === 'CONFIRMED'
            && row.valid_to === null
          ))
          .sort((left, right) => Number(left.full_sku_id) - Number(right.full_sku_id)),
      );
    }
    throw new Error(`Unexpected fake query: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
  }

  release() {
    this.releaseCount += 1;
  }
}

function pool(database) {
  return {
    async connect() {
      return database;
    },
  };
}

function options(overrides = {}) {
  return {
    observationRunId: OBSERVATION_RUN_ID,
    runId: AUDIT_RUN_ID,
    now: NOW,
    matcherVersion: 'observed-matcher-v1',
    policyVersion: 'strict-global-clique-v1',
    ...overrides,
  };
}

test('prepare uses a repeatable-read read-only snapshot and returns a complete zero-gap plan', async () => {
  const database = new FakeResolutionDatabase();
  const result = await prepareProductIdentityResolutionPlan(
    pool(database),
    options(),
  );

  assert.equal(result.summary.inputNodeCount, 2);
  assert.equal(result.summary.acceptedComponentCount, 1);
  assert.equal(result.summary.excludedMissingEvidenceSkuCount, 0);
  assert.equal(result.summary.excludedMissingHierarchySkuCount, 0);
  assert.equal(result.auditRunId, AUDIT_RUN_ID);
  assert.equal(result.preparedAt, NOW);
  assert.match(result.planHash, /^[0-9a-f]{64}$/);
  assert.equal(
    database.calls[0].sql,
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
  assert.equal(database.calls.at(-1).sql, 'COMMIT');
  assert.equal(
    database.calls.some(({ sql }) => /\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(sql)),
    false,
  );
});

test('missing platform SPU is explicitly excluded and changes the outer plan hash', async () => {
  const completeDatabase = new FakeResolutionDatabase();
  const complete = await prepareProductIdentityResolutionPlan(
    pool(completeDatabase),
    options(),
  );
  const partialDatabase = new FakeResolutionDatabase(
    baseFixture({ includeMissingHierarchy: true }),
  );
  const partial = await prepareProductIdentityResolutionPlan(
    pool(partialDatabase),
    options(),
  );

  assert.equal(partial.summary.excludedMissingEvidenceSkuCount, 1);
  assert.equal(partial.summary.excludedMissingHierarchySkuCount, 1);
  assert.equal(partial.excludedMissingEvidence.length, 1);
  assert.deepEqual(
    partial.excludedMissingEvidence[0],
    {
      storeId: '1',
      storeCode: 'DL',
      fullSkuId: '12',
      platformSpuId: null,
      platformSkcId: 'DL-SKC-MISSING',
      platformSkuId: 'DL-SKU-MISSING',
      missingReason: 'MISSING_PLATFORM_SPU',
      currentAssignmentFingerprint: null,
    },
  );
  assert.notEqual(partial.planHash, complete.planHash);
  assert.equal(
    partial.components.some(({ setMembers }) => (
      setMembers.some(({ platformSkuId }) => platformSkuId === 'DL-SKU-MISSING')
    )),
    false,
  );
});

test('a BUILDING set in the selected run fails closed instead of becoming a missing-evidence exclusion', async () => {
  const fixture = baseFixture();
  fixture.evidenceRows[0].set_status = 'BUILDING';
  const database = new FakeResolutionDatabase(fixture);

  await assert.rejects(
    prepareProductIdentityResolutionPlan(pool(database), options()),
    ({ code }) => (
      code === PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceHierarchyMismatch
    ),
  );

  const evidenceRead = database.calls.find(({ sql }) => (
    sql.includes('FROM raw.product_identity_observation_set AS evidence_set')
  ));
  assert.ok(evidenceRead);
  assert.doesNotMatch(
    evidenceRead.sql,
    /evidence_set\.status\s*=\s*'SEALED'/,
    'the selected run must expose non-sealed sets to fail-closed validation',
  );
});

test('apply bulk-writes in ordered phases, post-commit reads back, and exact replay is idempotent', async () => {
  const database = new FakeResolutionDatabase();
  const prepared = await prepareProductIdentityResolutionPlan(
    pool(database),
    options(),
  );
  const first = await applyProductIdentityResolutionPlan(
    pool(database),
    options({ approvedHash: prepared.planHash }),
  );
  const second = await applyProductIdentityResolutionPlan(
    pool(database),
    options({ approvedHash: prepared.planHash }),
  );

  assert.equal(first.applied, true);
  assert.equal(first.auditRunId, AUDIT_RUN_ID);
  assert.equal(first.preparedAt, NOW);
  assert.equal(first.appliedAt, NOW);
  assert.equal(first.summary.canonicalProductCount, 1);
  assert.equal(first.summary.provenanceCount, 2);
  assert.equal(first.summary.candidateCount, 2);
  assert.equal(first.summary.decisionCount, 2);
  assert.equal(first.summary.assignmentCount, 2);
  assert.equal(first.summary.createdCanonicalProductCount, 1);
  assert.equal(second.summary.createdCanonicalProductCount, 0);
  assert.equal(second.summary.createdProvenanceCount, 0);
  assert.equal(second.summary.createdCandidateCount, 0);
  assert.equal(second.summary.createdCandidateEvidenceCount, 0);
  assert.equal(second.summary.createdDecisionCount, 0);
  assert.equal(second.summary.createdAssignmentCount, 0);

  const normalized = database.calls.map(({ sql }) => sql.replace(/\s+/g, ' '));
  const insertOrder = [
    'INSERT INTO dim.canonical_product',
    'INSERT INTO ops.canonical_product_observation_set',
    'INSERT INTO ops.product_match_candidate (',
    'INSERT INTO ops.product_match_candidate_evidence',
    'INSERT INTO ops.product_identity_decision',
    'INSERT INTO dim.full_sku_canonical_assignment',
  ].map((needle) => normalized.findIndex((sql) => sql.includes(needle)));
  assert.deepEqual([...insertOrder].sort((left, right) => left - right), insertOrder);
  assert.equal(insertOrder.every((index) => index >= 0), true);
  assert.equal(
    normalized.some((sql) => sql.includes('jsonb_populate_recordset')),
    true,
  );
  assert.equal(
    normalized.some(
      (sql) => sql.includes('BEGIN ISOLATION LEVEL SERIALIZABLE'),
    ),
    true,
  );
  assert.equal(
    normalized.some(
      (sql) => sql.includes('full-managed-product-identity-resolution'),
    ),
    true,
  );
  assert.equal(
    normalized.filter(
      (sql) => sql.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
    ).length >= 3,
    true,
    'prepare plus both post-commit readbacks use independent read-only transactions',
  );
  for (const row of database.candidateEvidence.values()) {
    assert.ok(
      Number(row.relation_source_set_id) < Number(row.relation_target_set_id),
    );
    assert.equal(
      String(row.source_identifier_observation_id).startsWith(
        String(row.relation_source_set_id),
      ),
      true,
      'swapping relation set order must also swap its observation ids',
    );
    assert.equal(
      String(row.target_identifier_observation_id).startsWith(
        String(row.relation_target_set_id),
      ),
      true,
    );
  }
});

test('apply rejects a stale approved hash before any write', async () => {
  const database = new FakeResolutionDatabase();
  await assert.rejects(
    () => applyProductIdentityResolutionPlan(
      pool(database),
      options({ approvedHash: 'f'.repeat(64) }),
    ),
    (error) => error.code
      === PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.planHashMismatch,
  );
  assert.equal(
    database.calls.some(({ sql }) => sql.includes('INSERT INTO')),
    false,
  );
  assert.equal(database.calls.at(-1).sql, 'ROLLBACK');
});

test('an existing different current mapping fails closed and rolls back every staged phase', async () => {
  const database = new FakeResolutionDatabase();
  database.assignments.set('1:existing-assignment', {
    full_sku_canonical_assignment_id: 700,
    store_id: '1',
    full_sku_id: '11',
    canonical_product_id: '999',
    product_identity_decision_id: '998',
    assignment_key: 'existing-assignment',
    assignment_status: 'CONFIRMED',
    identity_scope: 'GLOBAL',
    identity_component_key: 'e'.repeat(64),
    observation_run_id: 'older-observation-run',
    plan_hash: 'd'.repeat(64),
    valid_to: null,
  });
  const prepared = await prepareProductIdentityResolutionPlan(
    pool(database),
    options(),
  );

  await assert.rejects(
    () => applyProductIdentityResolutionPlan(
      pool(database),
      options({ approvedHash: prepared.planHash }),
    ),
    (error) => error.code
      === PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.existingMappingConflict,
  );
  assert.equal(database.canonical.size, 0);
  assert.equal(database.provenance.size, 0);
  assert.equal(database.candidates.size, 0);
  assert.equal(database.assignments.size, 1);
  assert.equal(database.calls.at(-1).sql, 'ROLLBACK');
});

test('member-count and hierarchy drift are rejected without planner guessing', async () => {
  const memberCountFixture = baseFixture();
  memberCountFixture.evidenceRows = memberCountFixture.evidenceRows.map((row) => (
    row.identity_observation_set_id === 101
      ? { ...row, member_count: 99 }
      : row
  ));
  await assert.rejects(
    () => prepareProductIdentityResolutionPlan(
      pool(new FakeResolutionDatabase(memberCountFixture)),
      options(),
    ),
    (error) => error.code
      === PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceMemberCountMismatch,
  );

  const hierarchyFixture = baseFixture();
  hierarchyFixture.evidenceRows[0].raw_value = 'WRONG-SPU';
  hierarchyFixture.evidenceRows[0].normalized_value = normalizeIdentifierValue(
    'PLATFORM_SPU',
    'WRONG-SPU',
  );
  await assert.rejects(
    () => prepareProductIdentityResolutionPlan(
      pool(new FakeResolutionDatabase(hierarchyFixture)),
      options(),
    ),
    (error) => error.code
      === PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceHierarchyMismatch,
  );
});

test('MODEL, barcode and single-value product fields are normalized fail-closed', async () => {
  const wrongModelFixture = baseFixture();
  const modelRows = wrongModelFixture.evidenceRows.filter(
    ({ identifier_type: type }) => type === 'MODEL',
  );
  for (const row of modelRows) {
    row.evidence.attributeId = '9999';
    row.source_value_key = `product.attribute:9999:${hash('wrong').slice(0, 24)}`;
  }
  await assert.rejects(
    () => prepareProductIdentityResolutionPlan(
      pool(new FakeResolutionDatabase(wrongModelFixture)),
      options(),
    ),
    (error) => error.code
      === PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
  );

  const invalidBarcodeFixture = baseFixture();
  for (const row of invalidBarcodeFixture.evidenceRows.filter(
    ({ identifier_type: type }) => type === 'BARCODE',
  )) {
    row.raw_value = '6901234567890';
    row.normalized_value = '6901234567890';
    row.evidence.gtinCheckDigitValid = false;
    row.evidence.strongEvidence = false;
  }
  const invalidBarcodePlan = await prepareProductIdentityResolutionPlan(
    pool(new FakeResolutionDatabase(invalidBarcodeFixture)),
    options(),
  );
  assert.equal(invalidBarcodePlan.summary.acceptedComponentCount, 0);
  assert.equal(
    invalidBarcodePlan.rejectedRecallGroups[0].reasonCodes.includes(
      'INCOMPLETE_CONFIRMED_CLIQUE',
    ),
    true,
  );

  const ambiguousBrandFixture = baseFixture();
  const template = ambiguousBrandFixture.evidenceRows.find(
    (row) => (
      row.identity_observation_set_id === 101
      && row.identifier_type === 'BRAND'
    ),
  );
  ambiguousBrandFixture.evidenceRows.push({
    ...structuredClone(template),
    identifier_observation_id: 10199,
    raw_value: 'OTHER-BRAND',
    normalized_value: normalizeIdentifierValue('BRAND', 'OTHER-BRAND'),
    source_value_key: 'product.brand_code',
  });
  for (const row of ambiguousBrandFixture.evidenceRows.filter(
    ({ identity_observation_set_id: setId }) => setId === 101,
  )) {
    row.member_count = 9;
  }
  await assert.rejects(
    () => prepareProductIdentityResolutionPlan(
      pool(new FakeResolutionDatabase(ambiguousBrandFixture)),
      options(),
    ),
    (error) => error.code
      === PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
  );
});

test('excluded missing-evidence assignment state participates in the outer plan hash', async () => {
  const fixture = baseFixture({ includeMissingHierarchy: true });
  const withoutAssignment = await prepareProductIdentityResolutionPlan(
    pool(new FakeResolutionDatabase(fixture)),
    options(),
  );
  const database = new FakeResolutionDatabase(fixture);
  database.assignments.set('1:missing-existing', {
    full_sku_canonical_assignment_id: 900,
    store_id: '1',
    full_sku_id: '12',
    canonical_product_id: '901',
    product_identity_decision_id: '902',
    assignment_key: 'missing-existing',
    assignment_status: 'CONFIRMED',
    identity_scope: 'GLOBAL',
    identity_component_key: 'a'.repeat(64),
    observation_run_id: 'older-observation-run',
    plan_hash: 'b'.repeat(64),
    valid_to: null,
  });
  const withAssignment = await prepareProductIdentityResolutionPlan(
    pool(database),
    options(),
  );

  assert.match(
    withAssignment.excludedMissingEvidence[0].currentAssignmentFingerprint,
    /^[0-9a-f]{64}$/,
  );
  assert.notEqual(withAssignment.planHash, withoutAssignment.planHash);
});
