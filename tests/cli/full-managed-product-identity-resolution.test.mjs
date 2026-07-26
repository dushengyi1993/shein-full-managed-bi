import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  main,
  parseProductIdentityResolutionArgs,
  runProductIdentityResolution,
} from '../../scripts/resolve_full_managed_product_identity.mjs';

const DATABASE_URL =
  'postgres://identity-user:database-secret@fake.invalid/full-managed';
const OBSERVATION_RUN_ID = 'identity-evidence-test-run';
const RESOLUTION_RUN_ID = 'identity-resolution-test-run';
const NOW_INPUT = '2026-07-27T10:00:00+08:00';
const NOW = '2026-07-27T02:00:00.000Z';
const PLAN_HASH = 'a'.repeat(64);

const DRY_COUNTS = Object.freeze({
  inputNodeCount: 12,
  excludedMissingEvidenceSkuCount: 3,
  acceptedComponentCount: 2,
  acceptedNodeCount: 5,
  acceptedSkuSetCount: 8,
  rejectedRecallGroupCount: 4,
  rejectedNodeCount: 7,
});

const APPLY_COUNTS = Object.freeze({
  canonicalProductCount: 2,
  provenanceCount: 8,
  candidateCount: 8,
  candidateEvidenceCount: 16,
  decisionCount: 8,
  assignmentCount: 8,
  createdCanonicalProductCount: 2,
  createdProvenanceCount: 8,
  createdCandidateCount: 8,
  createdCandidateEvidenceCount: 16,
  createdDecisionCount: 8,
  createdAssignmentCount: 8,
});

function fakePool() {
  return {
    ended: false,
    async connect() {
      throw new Error('repository mock must not connect');
    },
    async end() {
      this.ended = true;
    },
  };
}

function outputCapture() {
  return {
    value: '',
    write(chunk) {
      this.value += String(chunk);
    },
  };
}

function dryResult(overrides = {}) {
  return {
    observationRunId: OBSERVATION_RUN_ID,
    auditRunId: RESOLUTION_RUN_ID,
    preparedAt: NOW,
    planHash: PLAN_HASH,
    inputEvidenceFingerprint: 'b'.repeat(64),
    components: [{
      secretEvidence: 'MODEL-PRIVATE-9988',
      nodeKey: 'NODE-PRIVATE-8877',
    }],
    rejectedRecallGroups: [{
      rawSupplierCode: 'SUPPLIER-PRIVATE-7766',
    }],
    summary: {
      ...DRY_COUNTS,
      secretCountContext: 'BARCODE-PRIVATE-6655',
    },
    ...overrides,
  };
}

function appliedResult(overrides = {}) {
  return {
    observationRunId: OBSERVATION_RUN_ID,
    auditRunId: RESOLUTION_RUN_ID,
    preparedAt: NOW,
    planHash: PLAN_HASH,
    applied: true,
    summary: {
      ...DRY_COUNTS,
      ...APPLY_COUNTS,
      evidenceRows: ['EAN-PRIVATE-5544'],
    },
    ...overrides,
  };
}

function fixedArgs(extra = []) {
  return [
    '--observation-run-id',
    OBSERVATION_RUN_ID,
    '--now',
    NOW_INPUT,
    '--run-id',
    RESOLUTION_RUN_ID,
    ...extra,
  ];
}

test('argument parsing defaults to dry-run and fixes audit fields deterministically', () => {
  assert.deepEqual(
    parseProductIdentityResolutionArgs(fixedArgs()),
    {
      apply: false,
      observationRunId: OBSERVATION_RUN_ID,
      matcherVersion: 'observed-matcher-v1',
      policyVersion: 'strict-global-clique-v1',
      now: NOW,
      runId: RESOLUTION_RUN_ID,
      approvedHash: null,
    },
  );

  assert.deepEqual(
    parseProductIdentityResolutionArgs([
      '--observation-run-id',
      OBSERVATION_RUN_ID,
    ], {
      clock: () => new Date('2026-07-27T03:04:05.000Z'),
    }),
    {
      apply: false,
      observationRunId: OBSERVATION_RUN_ID,
      matcherVersion: 'observed-matcher-v1',
      policyVersion: 'strict-global-clique-v1',
      now: '2026-07-27T03:04:05.000Z',
      runId: 'identity-resolution-20260727030405',
      approvedHash: null,
    },
  );
});

test('argument parsing requires observation-run-id and an exact apply hash', () => {
  assert.throws(
    () => parseProductIdentityResolutionArgs([]),
    ({ code }) => code === 'OBSERVATION_RUN_ID_REQUIRED',
  );
  assert.throws(
    () => parseProductIdentityResolutionArgs([
      '--observation-run-id',
      OBSERVATION_RUN_ID,
      '--apply',
    ]),
    ({ code }) => code === 'APPROVED_HASH_REQUIRED',
  );
  assert.throws(
    () => parseProductIdentityResolutionArgs([
      '--observation-run-id',
      OBSERVATION_RUN_ID,
      '--approved-hash',
      PLAN_HASH,
    ]),
    ({ code }) => code === 'APPROVED_HASH_NOT_ALLOWED',
  );
  assert.throws(
    () => parseProductIdentityResolutionArgs(fixedArgs([
      '--apply',
      '--approved-hash',
      PLAN_HASH.toUpperCase(),
    ])),
    ({ code }) => code === 'APPROVED_HASH_REQUIRED',
  );
});

test('argument parsing rejects database URLs, duplicates and malformed audit fields', () => {
  assert.throws(
    () => parseProductIdentityResolutionArgs([
      '--observation-run-id',
      OBSERVATION_RUN_ID,
      '--database-url',
      DATABASE_URL,
    ]),
    ({ code }) => code === 'INVALID_ARGUMENTS',
  );
  assert.throws(
    () => parseProductIdentityResolutionArgs([
      '--observation-run-id',
      OBSERVATION_RUN_ID,
      '--observation-run-id',
      OBSERVATION_RUN_ID,
    ]),
    ({ code }) => code === 'INVALID_ARGUMENTS',
  );
  assert.throws(
    () => parseProductIdentityResolutionArgs([
      '--observation-run-id',
      OBSERVATION_RUN_ID,
      '--now',
      '2026-07-27',
    ]),
    ({ code }) => code === 'INVALID_NOW',
  );
  assert.throws(
    () => parseProductIdentityResolutionArgs([
      '--observation-run-id',
      OBSERVATION_RUN_ID,
      '--run-id',
      'unsafe run id',
    ]),
    ({ code }) => code === 'INVALID_RUN_ID',
  );
});

test('dry-run calls only prepare API and emits an evidence-free allowlist', async () => {
  let prepareCalls = 0;
  let applyCalls = 0;
  const pool = fakePool();
  const stdout = outputCapture();
  const stderr = outputCapture();
  const repository = {
    async prepareProductIdentityResolutionPlan(receivedPool, input) {
      prepareCalls += 1;
      assert.equal(receivedPool, pool);
      assert.deepEqual(input, {
        observationRunId: OBSERVATION_RUN_ID,
        matcherVersion: 'observed-matcher-v1',
        policyVersion: 'strict-global-clique-v1',
        now: NOW,
        runId: RESOLUTION_RUN_ID,
      });
      return dryResult();
    },
    async applyProductIdentityResolutionPlan() {
      applyCalls += 1;
      throw new Error('dry-run must not apply');
    },
  };

  const exitCode = await main({
    argv: fixedArgs(),
    environment: {
      FULL_BI_DATABASE_URL: DATABASE_URL,
      DATABASE_URL: 'postgres://must-not-be-used',
      FULL_BI_OPENAPI_CONFIG: 'must-not-be-used',
    },
    stdout,
    stderr,
    poolFactory(databaseUrl) {
      assert.equal(databaseUrl, DATABASE_URL);
      return pool;
    },
    repository,
  });

  assert.equal(exitCode, 0);
  assert.equal(prepareCalls, 1);
  assert.equal(applyCalls, 0);
  assert.equal(pool.ended, true);
  assert.equal(stderr.value, '');
  const output = JSON.parse(stdout.value);
  assert.deepEqual(output, {
    ok: true,
    mode: 'dry-run',
    observationRunId: OBSERVATION_RUN_ID,
    runId: RESOLUTION_RUN_ID,
    evaluatedAt: NOW,
    matcherVersion: 'observed-matcher-v1',
    policyVersion: 'strict-global-clique-v1',
    planHash: PLAN_HASH,
    ...DRY_COUNTS,
  });
  for (const secret of [
    'MODEL-PRIVATE-9988',
    'NODE-PRIVATE-8877',
    'SUPPLIER-PRIVATE-7766',
    'BARCODE-PRIVATE-6655',
    'b'.repeat(64),
    'database-secret',
  ]) {
    assert.equal(stdout.value.includes(secret), false);
    assert.equal(stderr.value.includes(secret), false);
  }
});

test('apply calls only repository apply API with the approved hash and audit fields', async () => {
  let prepareCalls = 0;
  let applyCalls = 0;
  const pool = fakePool();
  const repository = {
    async prepareProductIdentityResolutionPlan() {
      prepareCalls += 1;
      throw new Error('apply must not call prepare directly');
    },
    async applyProductIdentityResolutionPlan(receivedPool, input) {
      applyCalls += 1;
      assert.equal(receivedPool, pool);
      assert.deepEqual(input, {
        observationRunId: OBSERVATION_RUN_ID,
        matcherVersion: 'observed-matcher-v1',
        policyVersion: 'strict-global-clique-v1',
        now: NOW,
        runId: RESOLUTION_RUN_ID,
        approvedHash: PLAN_HASH,
      });
      return appliedResult();
    },
  };
  const args = parseProductIdentityResolutionArgs(fixedArgs([
    '--apply',
    '--approved-hash',
    PLAN_HASH,
  ]));

  const result = await runProductIdentityResolution({
    pool,
    args,
    repository,
  });

  assert.equal(prepareCalls, 0);
  assert.equal(applyCalls, 1);
  assert.deepEqual(result, {
    ok: true,
    mode: 'applied',
    observationRunId: OBSERVATION_RUN_ID,
    runId: RESOLUTION_RUN_ID,
    evaluatedAt: NOW,
    matcherVersion: 'observed-matcher-v1',
    policyVersion: 'strict-global-clique-v1',
    planHash: PLAN_HASH,
    ...DRY_COUNTS,
    ...APPLY_COUNTS,
  });
});

test('repository must read back the exact fixed audit fields', async () => {
  const args = parseProductIdentityResolutionArgs(fixedArgs());
  await assert.rejects(
    runProductIdentityResolution({
      pool: fakePool(),
      args,
      repository: {
        async prepareProductIdentityResolutionPlan() {
          return dryResult({
            auditRunId: 'identity-resolution-different-run',
          });
        },
        async applyProductIdentityResolutionPlan() {},
      },
    }),
    ({ code }) => code === 'REPOSITORY_RESULT_INVALID',
  );
});

test('missing-evidence exclusion count is mandatory in dry-run and apply output', async () => {
  const {
    excludedMissingEvidenceSkuCount: _missingEvidenceCount,
    ...incompleteCounts
  } = DRY_COUNTS;
  const dryArgs = parseProductIdentityResolutionArgs(fixedArgs());
  await assert.rejects(
    runProductIdentityResolution({
      pool: fakePool(),
      args: dryArgs,
      repository: {
        async prepareProductIdentityResolutionPlan() {
          return dryResult({
            summary: incompleteCounts,
          });
        },
        async applyProductIdentityResolutionPlan() {},
      },
    }),
    ({ code }) => code === 'REPOSITORY_RESULT_INVALID',
  );

  const applyArgs = parseProductIdentityResolutionArgs(fixedArgs([
    '--apply',
    '--approved-hash',
    PLAN_HASH,
  ]));
  await assert.rejects(
    runProductIdentityResolution({
      pool: fakePool(),
      args: applyArgs,
      repository: {
        async prepareProductIdentityResolutionPlan() {},
        async applyProductIdentityResolutionPlan() {
          return appliedResult({
            summary: {
              ...incompleteCounts,
              ...APPLY_COUNTS,
            },
          });
        },
      },
    }),
    ({ code }) => code === 'REPOSITORY_RESULT_INVALID',
  );
});

test('main never falls back to DATABASE_URL and rejects before creating a pool', async () => {
  let poolFactoryCalls = 0;
  const stdout = outputCapture();
  const stderr = outputCapture();
  const exitCode = await main({
    argv: fixedArgs(),
    environment: {
      DATABASE_URL: DATABASE_URL,
    },
    stdout,
    stderr,
    poolFactory() {
      poolFactoryCalls += 1;
      return fakePool();
    },
    repository: {
      prepareProductIdentityResolutionPlan() {},
      applyProductIdentityResolutionPlan() {},
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(poolFactoryCalls, 0);
  assert.equal(stdout.value, '');
  assert.deepEqual(JSON.parse(stderr.value), {
    ok: false,
    errorCode: 'FULL_BI_DATABASE_URL_REQUIRED',
  });
});

test('repository failures are redacted and the pool is always closed', async () => {
  const pool = fakePool();
  const stdout = outputCapture();
  const stderr = outputCapture();
  const exitCode = await main({
    argv: fixedArgs(),
    environment: {
      FULL_BI_DATABASE_URL: DATABASE_URL,
    },
    stdout,
    stderr,
    poolFactory: () => pool,
    repository: {
      async prepareProductIdentityResolutionPlan() {
        const error = new Error(
          'private evidence MODEL-SECRET and database-secret at C:\\private\\file',
        );
        error.code = 'PLAN_HASH_MISMATCH';
        throw error;
      },
      async applyProductIdentityResolutionPlan() {},
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(pool.ended, true);
  assert.equal(stdout.value, '');
  assert.deepEqual(JSON.parse(stderr.value), {
    ok: false,
    errorCode: 'PLAN_HASH_MISMATCH',
  });
  assert.equal(stderr.value.includes('MODEL-SECRET'), false);
  assert.equal(stderr.value.includes('database-secret'), false);
  assert.equal(stderr.value.includes('C:\\private\\file'), false);
});

test('unknown upstream error codes cannot smuggle evidence into stderr', async () => {
  const stderr = outputCapture();
  const exitCode = await main({
    argv: fixedArgs(),
    environment: {
      FULL_BI_DATABASE_URL: DATABASE_URL,
    },
    stdout: outputCapture(),
    stderr,
    poolFactory: () => fakePool(),
    repository: {
      async prepareProductIdentityResolutionPlan() {
        const error = new Error('private evidence');
        error.code = 'MODEL_PRIVATE_9988';
        throw error;
      },
      async applyProductIdentityResolutionPlan() {},
    },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(stderr.value), {
    ok: false,
    errorCode: 'PRODUCT_IDENTITY_RESOLUTION_FAILED',
  });
  assert.equal(stderr.value.includes('MODEL_PRIVATE_9988'), false);
});

test('CLI source has no SHEIN network or credential-config dependency', async () => {
  const source = await readFile(
    new URL(
      '../../scripts/resolve_full_managed_product_identity.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /src\/openapi|SheinOpenApi|FULL_BI_OPENAPI/i);
  assert.doesNotMatch(source, /\bfetch\s*\(|node:https|node:http/);
  assert.doesNotMatch(source, /process\.env\.DATABASE_URL/);

  const packageDocument = JSON.parse(await readFile(
    new URL('../../package.json', import.meta.url),
    'utf8',
  ));
  assert.equal(
    packageDocument.scripts['resolve:product-identity'],
    'node scripts/resolve_full_managed_product_identity.mjs',
  );
});

test('default warehouse repository exposes both guarded resolution APIs', async () => {
  const repository = await import(
    '../../src/warehouse/product-identity-resolution-repository.mjs'
  );
  assert.equal(
    typeof repository.prepareProductIdentityResolutionPlan,
    'function',
  );
  assert.equal(
    typeof repository.applyProductIdentityResolutionPlan,
    'function',
  );
});
