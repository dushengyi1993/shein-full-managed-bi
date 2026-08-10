import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';
import { ORDER_MANAGEMENT_SESSION_PAGES } from '../../src/webapi-history/order-management-contracts.mjs';
import {
  buildV4CollectionPlan,
  V4_COLLECTION_PAGE_ENDPOINT_CODES,
  V4_COLLECTION_STATISTICS_TYPES,
  V4_COLLECTION_WORK_ITEM_CODES,
  v4EndpointRequestFingerprint,
  v4EndpointRequestSchemaHash,
  v4WorkItemWindow,
} from '../../src/warehouse/v4-collection-plan.mjs';
import {
  ACTIVE_ORDER_MANAGEMENT_ARTIFACT_NAME,
  LIVE_ORDER_MANAGEMENT_SESSION_ARTIFACT_NAME,
  main as v4CollectionMain,
  parseV4CollectionArgs,
  runV4Collection,
} from '../../scripts/run_full_managed_v4_collection.mjs';

const NOW = new Date('2026-08-11T04:00:00.000Z');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

const PAGE_IDS = Object.freeze(Object.keys(ORDER_MANAGEMENT_SESSION_PAGES));

function fakeRepository({ failInsertAt = null, mismatchReadback = false } = {}) {
  const calls = {
    createCollectionRun: [],
    transitionRun: [],
    beginAttempt: [],
    transitionAttempt: [],
    recordPageEvidence: [],
    recordCapabilityObservation: [],
    finalizeCoverage: [],
    insertTypedFacts: [],
  };
  let attemptSeq = 0;
  let insertSeq = 0;
  return {
    calls,
    async createCollectionRun(input) {
      calls.createCollectionRun.push(input);
      return { collectionRunId: 1, runStatus: 'PLANNED', replayed: false };
    },
    async transitionRun(input) {
      calls.transitionRun.push(input);
      return { collectionRunId: 1, runStatus: input.status };
    },
    async beginAttempt(input) {
      calls.beginAttempt.push(input);
      attemptSeq += 1;
      return {
        collectionAttemptId: attemptSeq,
        attemptStatus: 'PLANNED',
        attemptKey: sha256(`attempt-${attemptSeq}`),
        replayed: false,
      };
    },
    async transitionAttempt(input) {
      calls.transitionAttempt.push(input);
      return { collectionAttemptId: 1, attemptStatus: input.status };
    },
    async recordPageEvidence(input) {
      calls.recordPageEvidence.push(input);
      return { pageEvidenceId: 1, pageKey: sha256('page'), payloadHash: input.payloadHash, replayed: false };
    },
    async recordCapabilityObservation(input) {
      calls.recordCapabilityObservation.push(input);
      return { capabilityObservationId: 1, businessMaterialized: false, replayed: false };
    },
    async finalizeCoverage(input) {
      calls.finalizeCoverage.push(input);
      return {
        coverageId: 1,
        expectedStoreCount: 25,
        completedStoreCount: 25,
        partialStoreCount: 0,
        unknownStoreCount: 0,
        rowCount: 175,
        replayed: false,
      };
    },
    async insertTypedFacts(input) {
      calls.insertTypedFacts.push(input);
      insertSeq += 1;
      if (failInsertAt !== null && insertSeq === failInsertAt) {
        const error = new Error('simulated persistence failure');
        error.code = 'V4_COLLECTION_READBACK_MISMATCH';
        throw error;
      }
      return {
        pageId: input.pageId,
        storeCode: input.storeCode,
        endpointCode: input.endpointCode,
        pageEvidenceId: 1,
        pageKey: sha256('typed-page'),
        payloadHash: input.sourcePayloadHash,
        acceptedRowCount: input.rows.length,
        rejectedRowCount: 0,
        insertedRowCount: input.rows.length,
        replayedRowCount: 0,
        rejectedCodes: [],
        readback: {
          rowCount: mismatchReadback ? input.rows.length - 1 : input.rows.length,
          payloadHashesMatch: !mismatchReadback,
          expectedRowCount: input.rows.length,
        },
      };
    },
  };
}

/**
 * Fake sync: emits one hook per store x page and one per store x statistics
 * type, writes the candidate snapshot, and returns the sync result shape the
 * runner consumes.  `skipStore` simulates a store whose session never opened
 * (no hooks, failed gates); `failStatisticsType` marks one stats call failed;
 * `throwAfter` makes the sync throw after collecting the first store.
 */
function fakeSync({
  skipStore = null,
  failStatisticsType = null,
  throwAfter = false,
} = {}) {
  const syncCalls = [];
  const sync = async (options) => {
    syncCalls.push(options);
    const { storeCodes, output, window, evidence, now } = options;
    if (throwAfter) {
      const firstStore = storeCodes[0];
      for (const pageId of PAGE_IDS) {
        const endpointCode = ORDER_MANAGEMENT_SESSION_PAGES[pageId];
        await evidence.onPage({
          storeCode: firstStore,
          pageId,
          endpointCode,
          pageNumber: 1,
          pageSize: 50,
          pageRequestFingerprint: sha256(`req-${firstStore}-${endpointCode}-1`),
          responseSchemaHash: sha256(`schema-${firstStore}-${endpointCode}-1`),
          payloadHash: sha256(`payload-${firstStore}-${endpointCode}-1`),
          httpStatus: 200,
          observedAt: now.toISOString(),
          rows: [{ id: `${firstStore}-${pageId}-1` }],
        });
      }
      for (const statisticsType of V4_COLLECTION_STATISTICS_TYPES) {
        await evidence.onStatistics({
          storeCode: firstStore,
          statisticsType,
          pageRequestFingerprint: sha256(`stats-req-${firstStore}-${statisticsType}`),
          responseSchemaHash: sha256(`stats-schema-${firstStore}-${statisticsType}`),
          payloadHash: sha256(`stats-payload-${firstStore}-${statisticsType}`),
          httpStatus: 200,
          observedAt: now.toISOString(),
          ok: true,
          errorCode: null,
        });
      }
      const error = new Error('session failed');
      error.code = 'ORDER_MANAGEMENT_AUTH_EXPIRED';
      throw error;
    }
    const perStore = [];
    for (const storeCode of storeCodes) {
      const failed = storeCode === skipStore;
      const pages = {};
      for (const pageId of PAGE_IDS) {
        const endpointCode = ORDER_MANAGEMENT_SESSION_PAGES[pageId];
        if (!failed) {
          await evidence.onPage({
            storeCode,
            pageId,
            endpointCode,
            pageNumber: 1,
            pageSize: 50,
            pageRequestFingerprint: sha256(`req-${storeCode}-${endpointCode}-1`),
            responseSchemaHash: sha256(`schema-${storeCode}-${endpointCode}-1`),
            payloadHash: sha256(`payload-${storeCode}-${endpointCode}-1`),
            httpStatus: 200,
            observedAt: now.toISOString(),
            rows: [{ id: `${storeCode}-${pageId}-1` }],
          });
        }
        pages[pageId] = failed
          ? {
            gates: { ok: false, totalVerified: false, pagingVerified: false, dedupeVerified: false, contentVerified: false, storeCount: storeCodes.length },
            fetched: { failures: ['PAGE_1_FETCH_FAILED:ORDER_MANAGEMENT_AUTH_EXPIRED'], pagesFetched: 0, total: null },
          }
          : {
            gates: { ok: true, totalVerified: true, pagingVerified: true, dedupeVerified: true, contentVerified: true, storeCount: storeCodes.length },
            fetched: { failures: [], pagesFetched: 1, total: 1 },
          };
      }
      for (const statisticsType of V4_COLLECTION_STATISTICS_TYPES) {
        const fail = failed || (
          storeCode === FULL_MANAGED_STORE_CODES[0]
          && statisticsType === failStatisticsType
        );
        if (!fail) {
          await evidence.onStatistics({
            storeCode,
            statisticsType,
            pageRequestFingerprint: sha256(`stats-req-${storeCode}-${statisticsType}`),
            responseSchemaHash: sha256(`stats-schema-${storeCode}-${statisticsType}`),
            payloadHash: sha256(`stats-payload-${storeCode}-${statisticsType}`),
            httpStatus: 200,
            observedAt: now.toISOString(),
            ok: true,
            errorCode: null,
          });
        } else {
          await evidence.onStatistics({
            storeCode,
            statisticsType,
            pageRequestFingerprint: sha256(`stats-req-${storeCode}-${statisticsType}`),
            responseSchemaHash: null,
            payloadHash: null,
            httpStatus: null,
            observedAt: now.toISOString(),
            ok: false,
            errorCode: failStatisticsType === statisticsType && !failed
              ? 'ORDER_MANAGEMENT_BUSINESS_STATUS_FAILED'
              : 'ORDER_MANAGEMENT_AUTH_EXPIRED',
          });
        }
      }
      perStore.push({
        storeCode,
        ok: !failed,
        pages,
        statistics: [],
      });
    }
    const pageAggregates = Object.fromEntries(PAGE_IDS.map((pageId) => [pageId, {
      status: 'AVAILABLE',
      gates: {
        totalVerified: true,
        pagingVerified: skipStore === null,
        dedupeVerified: skipStore === null,
        contentVerified: true,
        storeCount: storeCodes.length,
      },
    }]));
    const snapshot = {
      schemaVersion: 1,
      updatedAt: now.toISOString(),
      roster: [...storeCodes],
      window: { ...window },
      pages: pageAggregates,
      evidence: { perStore },
    };
    await writeFile(output, `${JSON.stringify({ candidate: true, planHash: 'x' })}\n`);
    return { snapshot, written: output };
  };
  return { syncCalls, sync };
}

function runnerDeps(repository) {
  const closed = [];
  const pool = {
    async end() { closed.push(true); },
  };
  const sessionStore = { read: async () => null, write: async () => {} };
  const env = { ...process.env, FULL_BI_WEBAPI_DATABASE_URL: 'postgres://test/unused' };
  return {
    closed,
    env,
    createPool: async () => pool,
    loadSessionStore: async () => sessionStore,
    createRepository: async () => repository,
  };
}

function expectedAttemptKey(repository, storeCode, workItemCode) {
  const storeIndex = FULL_MANAGED_STORE_CODES.indexOf(storeCode);
  const workItemIndex = V4_COLLECTION_WORK_ITEM_CODES.indexOf(workItemCode);
  const sequence = storeIndex * V4_COLLECTION_WORK_ITEM_CODES.length + workItemIndex + 1;
  return sha256(`attempt-${sequence}`);
}

test('dry-run makes zero database, session, sync and file calls', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-runner-dry-'));
  const plan = buildV4CollectionPlan({ now: NOW });
  const result = await runV4Collection({
    plan,
    execute: false,
    now: NOW,
    env: { ...process.env, FULL_BI_WEBAPI_DATABASE_URL: 'postgres://test' },
    createPool: async () => { throw new Error('MUST_NOT_CREATE_POOL'); },
    loadSessionStore: async () => { throw new Error('MUST_NOT_LOAD_SESSION_STORE'); },
    sync: async () => { throw new Error('MUST_NOT_SYNC'); },
  });
  assert.equal(result.mode, 'DRY_RUN');
  assert.equal(result.ok, true);
  assert.equal(result.plan.planHash, plan.planHash);
  assert.ok(result.candidateOutput.endsWith(`full-managed-v4-collection.candidate.${plan.planHash}.json`));
  assert.equal(existsSync(result.candidateOutput), false);
  assert.equal(existsSync(path.join(directory, 'nothing.json')), false);
});

test('a wrong approved plan hash fails before any side effect', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-runner-wronghash-'));
  const output = path.join(directory, 'candidate.json');
  const plan = buildV4CollectionPlan({ now: NOW });
  await assert.rejects(
    () => runV4Collection({
      plan,
      execute: true,
      approvedPlanHash: 'f'.repeat(64),
      output,
      now: NOW,
      env: { ...process.env, FULL_BI_WEBAPI_DATABASE_URL: 'postgres://test' },
      createPool: async () => { throw new Error('MUST_NOT_CREATE_POOL'); },
      loadSessionStore: async () => { throw new Error('MUST_NOT_LOAD_SESSION_STORE'); },
      sync: async () => { throw new Error('MUST_NOT_SYNC'); },
    }),
    (error) => error.code === 'V4_COLLECTION_PLAN_HASH_MISMATCH',
  );
  assert.equal(existsSync(output), false);
});

test('execute with the exact hash drives the full 25x13 run and only the candidate snapshot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-runner-success-'));
  const output = path.join(directory, 'candidate.json');
  const plan = buildV4CollectionPlan({ now: NOW });
  const repository = fakeRepository();
  const { syncCalls, sync } = fakeSync({});
  const deps = runnerDeps(repository);
  const result = await runV4Collection({
    plan,
    execute: true,
    approvedPlanHash: plan.planHash,
    output,
    now: NOW,
    env: deps.env,
    createPool: deps.createPool,
    loadSessionStore: deps.loadSessionStore,
    createRepository: deps.createRepository,
    sync,
  });

  assert.equal(result.ok, true);
  assert.equal(result.runStatus, 'SUCCEEDED');
  assert.equal(result.snapshotWritten, output);
  assert.deepEqual(result.attemptSummary, {
    total: 325,
    succeeded: 325,
    partial: 0,
    failed: 0,
    expected: 325,
  });
  assert.deepEqual(result.statisticsObservations, { verified: 150, failed: 0 });

  // One run with the frozen plan and the exact ordered manifest.
  assert.equal(repository.calls.createCollectionRun.length, 1);
  assert.deepEqual(repository.calls.createCollectionRun[0], {
    contractVersion: 1,
    planHash: plan.planHash,
    runKey: plan.runKey,
    storeCodes: FULL_MANAGED_STORE_CODES,
    endpointCodes: V4_COLLECTION_WORK_ITEM_CODES,
    windowStart: plan.window.startDate,
    windowEnd: plan.window.endDate,
    retryPolicy: 'NONE',
  });
  assert.deepEqual(
    repository.calls.transitionRun.map((call) => call.status),
    ['PREFLIGHT_PASSED', 'RUNNING', 'SUCCEEDED'],
  );

  // 325 attempts, one per store x work item, all begun then RUNNING.
  assert.equal(repository.calls.beginAttempt.length, 325);
  assert.equal(repository.calls.transitionAttempt.length, 650);
  assert.ok(repository.calls.transitionAttempt
    .slice(0, 325).every((call) => call.status === 'RUNNING'));
  const onceOnly = new Set(['EXCEPTIONS_PAGE', 'VALUE_ADDED_SERVICES_PAGE']);
  for (const storeCode of FULL_MANAGED_STORE_CODES) {
    for (const workItemCode of V4_COLLECTION_WORK_ITEM_CODES) {
      const begun = repository.calls.beginAttempt.find((call) => (
        call.storeCode === storeCode && call.endpointCode === workItemCode
      ));
      assert.ok(begun, `${storeCode}/${workItemCode} attempt missing`);
      assert.equal(begun.runKey, plan.runKey);
      assert.equal(begun.requestSchemaHash, v4EndpointRequestSchemaHash(workItemCode));
      const window = v4WorkItemWindow({ workItemCode, window: plan.window });
      assert.equal(begun.requestFingerprint, v4EndpointRequestFingerprint({ workItemCode, window }));
      assert.equal(begun.windowStart, window?.startDate ?? null);
      assert.equal(begun.windowEnd, window?.endDate ?? null);
      assert.equal(begun.expectedRowCount, null);
      assert.equal(begun.initialStatus, 'PLANNED');
      const expectedKey = expectedAttemptKey(repository, storeCode, workItemCode);
      assert.ok(repository.calls.transitionAttempt.some((call) => (
        call.attemptKey === expectedKey && call.status === 'RUNNING'
      )));
      const terminal = repository.calls.transitionAttempt.find((call) => (
        call.attemptKey === expectedKey && call.status !== 'RUNNING'
      ));
      assert.equal(terminal.status, 'SUCCEEDED', `${storeCode}/${workItemCode} should succeed`);
    }
  }
  assert.ok(onceOnly.size === 2);

  // The sync was invoked exactly once with serial stores, no retry, stats on.
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].storeConcurrency, 1);
  assert.equal(syncCalls[0].includeStatistics, true);
  // The sync wrote a same-directory private staging artifact, never the final
  // candidate path; the runner promotes it only after every DB gate passed.
  assert.ok(syncCalls[0].output.startsWith(`${output}.staging-`));
  assert.equal(path.dirname(syncCalls[0].output), directory);
  assert.deepEqual(syncCalls[0].window, plan.window);
  assert.deepEqual(syncCalls[0].pageIds, PAGE_IDS);
  assert.equal(syncCalls[0].maxPages, 100);
  assert.equal(typeof syncCalls[0].evidence.onPage, 'function');
  assert.equal(typeof syncCalls[0].evidence.onStatistics, 'function');

  // All 7 typed pages are persisted through insertTypedFacts with the
  // network-source payload hash (including value-added-services).
  assert.equal(repository.calls.insertTypedFacts.length, 175);
  for (const call of repository.calls.insertTypedFacts) {
    assert.ok(PAGE_IDS.includes(call.pageId));
    assert.equal(call.endpointCode, ORDER_MANAGEMENT_SESSION_PAGES[call.pageId]);
    assert.equal(call.pageNumber, 1);
    assert.equal(call.pageSize, 50);
    assert.equal(call.attemptKey, expectedAttemptKey(repository, call.storeCode, call.endpointCode));
    assert.equal(call.sourcePayloadHash, sha256(`payload-${call.storeCode}-${call.endpointCode}-1`));
    assert.equal(call.httpStatus, 200);
    assert.equal(call.observedAt, NOW.toISOString());
    assert.deepEqual(call.rows, [{ id: `${call.storeCode}-${call.pageId}-1` }]);
  }
  const vasCalls = repository.calls.insertTypedFacts.filter((call) => call.pageId === 'value-added-services');
  assert.equal(vasCalls.length, 25);

  // Statistics: page evidence + capability observation per type.
  assert.equal(repository.calls.recordPageEvidence.length, 150);
  for (const statisticsType of V4_COLLECTION_STATISTICS_TYPES) {
    const workItemCode = `WAYBILLS_STATISTICS_${statisticsType}`;
    const evidenceCalls = repository.calls.recordPageEvidence.filter((call) => (
      call.endpointCode === workItemCode
    ));
    assert.equal(evidenceCalls.length, 25);
    for (const call of evidenceCalls) {
      assert.equal(call.pageNumber, 1);
      assert.equal(call.pageSize, 1);
      assert.equal(call.rowCount, 1);
      assert.equal(call.rejectedRowCount, 0);
      assert.equal(call.fetchStatus, 'SUCCEEDED');
      assert.equal(
        call.payloadHash,
        sha256(`stats-payload-${call.storeCode}-${statisticsType}`),
      );
      assert.equal(
        call.attemptKey,
        expectedAttemptKey(repository, call.storeCode, workItemCode),
      );
    }
    const observations = repository.calls.recordCapabilityObservation.filter((call) => (
      call.capabilityCode === `STATISTICS_TYPE_${statisticsType}`
    ));
    assert.equal(observations.length, 25);
    for (const call of observations) {
      assert.equal(call.endpointCode, 'WAYBILLS_STATISTICS');
      assert.equal(call.capabilityStatus, 'VERIFIED');
      assert.equal(call.sanitizedErrorCode, null);
      assert.equal(
        call.payloadHash,
        sha256(`stats-payload-${call.storeCode}-${statisticsType}`),
      );
    }
  }
  assert.equal(repository.calls.recordCapabilityObservation.length, 150);

  // Coverage finalized after the terminal run.
  assert.equal(repository.calls.finalizeCoverage.length, 1);
  assert.deepEqual(repository.calls.finalizeCoverage[0], {
    runKey: plan.runKey,
    pagingVerified: true,
    dedupeVerified: true,
    reasonCode: null,
  });

  // Only the candidate snapshot exists; the active artifact was never written.
  assert.equal(existsSync(output), true);
  assert.equal(existsSync(syncCalls[0].output), false);
  const candidate = JSON.parse(await (await import('node:fs/promises')).readFile(output, 'utf8'));
  assert.equal(candidate.candidate, true);
  assert.equal(existsSync(path.join(directory, ACTIVE_ORDER_MANAGEMENT_ARTIFACT_NAME)), false);
  assert.deepEqual(deps.closed, [true]);
});

test('a store with no evidence stays FAILED and the run becomes PARTIAL with a reason code', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-runner-partial-'));
  const output = path.join(directory, 'candidate.json');
  const plan = buildV4CollectionPlan({ now: NOW });
  const repository = fakeRepository();
  const { syncCalls, sync } = fakeSync({ skipStore: 'DX2420' });
  const deps = runnerDeps(repository);
  const result = await runV4Collection({
    plan,
    execute: true,
    approvedPlanHash: plan.planHash,
    output,
    now: NOW,
    env: deps.env,
    createPool: deps.createPool,
    loadSessionStore: deps.loadSessionStore,
    createRepository: deps.createRepository,
    sync,
  });

  assert.equal(result.ok, false);
  assert.equal(result.runStatus, 'PARTIAL');
  assert.equal(result.snapshotWritten, null);
  assert.deepEqual(result.attemptSummary, {
    total: 325,
    succeeded: 312,
    partial: 0,
    failed: 13,
    expected: 325,
  });
  assert.deepEqual(
    repository.calls.transitionRun.map((call) => call.status),
    ['PREFLIGHT_PASSED', 'RUNNING', 'PARTIAL'],
  );
  assert.equal(repository.calls.finalizeCoverage.length, 1);
  assert.equal(repository.calls.finalizeCoverage[0].pagingVerified, false);
  assert.equal(repository.calls.finalizeCoverage[0].dedupeVerified, false);
  assert.equal(repository.calls.finalizeCoverage[0].reasonCode, 'V4_COLLECTION_PARTIAL_COVERAGE');

  // The failed store's 13 attempts never claim success and never carry counts.
  for (const workItemCode of V4_COLLECTION_WORK_ITEM_CODES) {
    const key = expectedAttemptKey(repository, 'DX2420', workItemCode);
    const terminal = repository.calls.transitionAttempt.find((call) => (
      call.attemptKey === key && call.status !== 'RUNNING'
    ));
    assert.equal(terminal.status, 'FAILED');
    assert.equal(terminal.observedRowCount, null);
    assert.equal(terminal.observedPageCount, null);
    assert.ok(terminal.sanitizedErrorCode);
  }
  assert.ok(!repository.calls.insertTypedFacts.some((call) => call.storeCode === 'DX2420'));
  assert.ok(!repository.calls.recordPageEvidence.some((call) => call.storeCode === 'DX2420'));
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(syncCalls[0].output), false);
});

test('a mid-run sync failure persists only real evidence and never zero-fills', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-runner-throw-'));
  const output = path.join(directory, 'candidate.json');
  const plan = buildV4CollectionPlan({ now: NOW });
  const repository = fakeRepository();
  const { syncCalls, sync } = fakeSync({ throwAfter: true });
  const deps = runnerDeps(repository);
  const result = await runV4Collection({
    plan,
    execute: true,
    approvedPlanHash: plan.planHash,
    output,
    now: NOW,
    env: deps.env,
    createPool: deps.createPool,
    loadSessionStore: deps.loadSessionStore,
    createRepository: deps.createRepository,
    sync,
  });

  assert.equal(result.ok, false);
  assert.equal(result.runStatus, 'FAILED');
  assert.equal(result.snapshotWritten, null);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(syncCalls[0].output), false);
  assert.equal(result.attemptSummary.total, 325);
  assert.equal(result.attemptSummary.succeeded, 0);

  // Store 1 has real evidence: persisted but PARTIAL (paging unprovable).
  for (const pageId of PAGE_IDS) {
    const endpointCode = ORDER_MANAGEMENT_SESSION_PAGES[pageId];
    const terminal = repository.calls.transitionAttempt.find((call) => (
      call.attemptKey === expectedAttemptKey(repository, 'CX4412', endpointCode)
        && call.status !== 'RUNNING'
    ));
    assert.equal(terminal.status, 'PARTIAL');
    assert.equal(terminal.observedPageCount, 1);
    assert.equal(terminal.observedRowCount, 1);
  }
  assert.equal(repository.calls.insertTypedFacts.length, 7);
  assert.equal(repository.calls.recordPageEvidence.length, 6);
  // Store 1's statistics attempts carry real evidence but never claim
  // SUCCEEDED while the sync invocation itself failed.
  for (const statisticsType of V4_COLLECTION_STATISTICS_TYPES) {
    const terminal = repository.calls.transitionAttempt.find((call) => (
      call.attemptKey === expectedAttemptKey(repository, 'CX4412', `WAYBILLS_STATISTICS_${statisticsType}`)
        && call.status !== 'RUNNING'
    ));
    assert.equal(terminal.status, 'PARTIAL');
    assert.equal(terminal.observedRowCount, 1);
    assert.equal(terminal.observedPageCount, 1);
  }
  // The other 24 stores: honest FAILED attempts, never zero-filled.
  for (const storeCode of FULL_MANAGED_STORE_CODES.slice(1)) {
    for (const workItemCode of V4_COLLECTION_WORK_ITEM_CODES) {
      const terminal = repository.calls.transitionAttempt.find((call) => (
        call.attemptKey === expectedAttemptKey(repository, storeCode, workItemCode)
          && call.status !== 'RUNNING'
      ));
      assert.equal(terminal.status, 'FAILED');
      assert.equal(terminal.observedRowCount, null);
      assert.equal(terminal.observedPageCount, null);
    }
  }
  assert.deepEqual(
    repository.calls.transitionRun.map((call) => call.status),
    ['PREFLIGHT_PASSED', 'RUNNING', 'FAILED'],
  );
  assert.equal(repository.calls.finalizeCoverage[0].reasonCode, 'V4_COLLECTION_INCOMPLETE_COVERAGE');
  assert.equal(repository.calls.finalizeCoverage[0].pagingVerified, false);
  assert.equal(repository.calls.finalizeCoverage[0].dedupeVerified, false);
  assert.deepEqual(deps.closed, [true]);
});

test('a failed statistics type fails only that attempt and records no invented observation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-runner-statsfail-'));
  const output = path.join(directory, 'candidate.json');
  const plan = buildV4CollectionPlan({ now: NOW });
  const repository = fakeRepository();
  const { sync } = fakeSync({ failStatisticsType: 3 });
  const deps = runnerDeps(repository);
  const result = await runV4Collection({
    plan,
    execute: true,
    approvedPlanHash: plan.planHash,
    output,
    now: NOW,
    env: deps.env,
    createPool: deps.createPool,
    loadSessionStore: deps.loadSessionStore,
    createRepository: deps.createRepository,
    sync,
  });

  assert.equal(result.runStatus, 'PARTIAL');
  assert.equal(result.attemptSummary.succeeded, 324);
  assert.equal(result.attemptSummary.failed, 1);
  assert.equal(result.statisticsObservations.verified, 149);
  assert.equal(result.statisticsObservations.failed, 1);

  const failedKey = expectedAttemptKey(repository, 'CX4412', 'WAYBILLS_STATISTICS_3');
  const terminal = repository.calls.transitionAttempt.find((call) => (
    call.attemptKey === failedKey && call.status !== 'RUNNING'
  ));
  assert.equal(terminal.status, 'FAILED');
  assert.equal(terminal.observedRowCount, null);
  assert.equal(terminal.observedPageCount, null);
  assert.equal(terminal.sanitizedErrorCode, 'ORDER_MANAGEMENT_BUSINESS_STATUS_FAILED');
  assert.ok(!repository.calls.recordPageEvidence.some((call) => (
    call.storeCode === 'CX4412' && call.endpointCode === 'WAYBILLS_STATISTICS_3'
  )));
  assert.ok(!repository.calls.recordCapabilityObservation.some((call) => (
    call.storeCode === 'CX4412' && call.capabilityCode === 'STATISTICS_TYPE_3'
  )));
  // Every other stats attempt still succeeded with evidence.
  assert.equal(repository.calls.recordPageEvidence.length, 149);
  assert.equal(repository.calls.recordCapabilityObservation.length, 149);
  assert.equal(repository.calls.finalizeCoverage[0].reasonCode, 'V4_COLLECTION_PARTIAL_COVERAGE');
});

test('the candidate output can never be the active order-management.json artifact', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-runner-promote-'));
  const plan = buildV4CollectionPlan({ now: NOW });
  const activePath = path.join(directory, ACTIVE_ORDER_MANAGEMENT_ARTIFACT_NAME);
  await assert.rejects(
    () => runV4Collection({
      plan,
      execute: true,
      approvedPlanHash: plan.planHash,
      output: activePath,
      now: NOW,
      env: { ...process.env, FULL_BI_WEBAPI_DATABASE_URL: 'postgres://test' },
      createPool: async () => { throw new Error('MUST_NOT_CREATE_POOL'); },
      sync: async () => { throw new Error('MUST_NOT_SYNC'); },
    }),
    (error) => error.code === 'V4_COLLECTION_OUTPUT_IS_ACTIVE_ARTIFACT',
  );
  assert.equal(existsSync(activePath), false);
});

test('the candidate output can never be the live order-management.sessions.json input artifact', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-runner-session-live-'));
  const plan = buildV4CollectionPlan({ now: NOW });
  const liveSessionPath = path.join(directory, LIVE_ORDER_MANAGEMENT_SESSION_ARTIFACT_NAME);
  await assert.rejects(
    () => runV4Collection({
      plan,
      execute: true,
      approvedPlanHash: plan.planHash,
      output: liveSessionPath,
      now: NOW,
      env: { ...process.env, FULL_BI_WEBAPI_DATABASE_URL: 'postgres://test' },
      createPool: async () => { throw new Error('MUST_NOT_CREATE_POOL'); },
      sync: async () => { throw new Error('MUST_NOT_SYNC'); },
    }),
    (error) => error.code === 'V4_COLLECTION_OUTPUT_IS_ACTIVE_ARTIFACT',
  );
  assert.equal(existsSync(liveSessionPath), false);
});

test('CLI argument parsing is strict about execute-only flags', () => {
  const plan = buildV4CollectionPlan({ now: NOW });
  const args = parseV4CollectionArgs(['--execute', `--approved-plan-hash=${plan.planHash}`, `--output=/tmp/candidate.json`]);
  assert.equal(args.execute, true);
  assert.equal(args.approvedPlanHash, plan.planHash);
  assert.equal(args.output, '/tmp/candidate.json');
  assert.throws(
    () => parseV4CollectionArgs(['--approved-plan-hash=abc']),
    (error) => error.code === 'V4_COLLECTION_EXECUTE_FLAG_WITHOUT_EXECUTE',
  );
  assert.throws(
    () => parseV4CollectionArgs(['--execute']),
    (error) => error.code === 'V4_COLLECTION_APPROVED_PLAN_HASH_REQUIRED',
  );
  assert.throws(
    () => parseV4CollectionArgs(['--execute', '--approved-plan-hash=abc']),
    (error) => error.code === 'V4_COLLECTION_OUTPUT_REQUIRED',
  );
  assert.throws(
    () => parseV4CollectionArgs(['--execute', '--approved-plan-hash=abc', '--output=/tmp/c.json', '--unknown=x']),
    (error) => error.code === 'V4_COLLECTION_ARGUMENT_INVALID',
  );
});

test('CLI main dry-run prints a sanitized plan and returns 0 with no side effects', async () => {
  const plan = buildV4CollectionPlan({ now: NOW });
  const chunks = [];
  const exitCode = await v4CollectionMain([], {
    clock: () => NOW,
    env: { ...process.env, FULL_BI_WEBAPI_DATABASE_URL: 'postgres://test' },
    writeOut: (line) => chunks.push(line),
    writeError: () => { throw new Error('MUST_NOT_WRITE_ERROR'); },
  });
  assert.equal(exitCode, 0);
  const report = JSON.parse(chunks.join(''));
  assert.equal(report.mode, 'DRY_RUN');
  assert.equal(report.plan.planHash, plan.planHash);
  assert.equal(report.plan.workItemCodes.length, 13);
  assert.deepEqual(
    report.plan.requestContractManifest,
    JSON.parse(JSON.stringify(plan.requestContractManifest)),
  );
  assert.equal(report.plan.requestContractManifest.length, 13);
  assert.ok(!JSON.stringify(report).includes('FULL_BI_WEBAPI_DATABASE_URL'));
});

test('CLI main execute with a mismatched hash returns exit code 2', async () => {
  const chunks = [];
  const exitCode = await v4CollectionMain([
    '--execute',
    `--approved-plan-hash=${'f'.repeat(64)}`,
    '--output=/tmp/candidate.json',
  ], {
    clock: () => NOW,
    env: { ...process.env, FULL_BI_WEBAPI_DATABASE_URL: 'postgres://test' },
    writeOut: (line) => chunks.push(line),
    writeError: (line) => chunks.push(line),
  });
  assert.equal(exitCode, 2);
  const report = JSON.parse(chunks.join(''));
  assert.equal(report.ok, false);
  assert.equal(report.errorCode, 'V4_COLLECTION_PLAN_HASH_MISMATCH');
});

test('CLI failures never echo raw argv tokens, paths or secret-like values', async () => {
  const chunks = [];
  const secretToken = 'abc123secretdef456';
  const exitCode = await v4CollectionMain([
    '--execute',
    `--approved-plan-hash=${'f'.repeat(64)}`,
    '--output=/tmp/candidate.json',
    `--not-a-flag=${secretToken}`,
  ], {
    clock: () => NOW,
    env: { ...process.env, FULL_BI_WEBAPI_DATABASE_URL: 'postgres://test' },
    writeOut: (line) => chunks.push(line),
    writeError: (line) => chunks.push(line),
  });
  assert.equal(exitCode, 2);
  const report = JSON.parse(chunks.join(''));
  assert.equal(report.ok, false);
  assert.equal(report.errorCode, 'V4_COLLECTION_ARGUMENT_INVALID');
  const outputText = chunks.join('');
  assert.ok(!outputText.includes(secretToken));
  assert.ok(!outputText.includes('--not-a-flag'));
  // The plan-hash value is also never echoed by a failure.
  assert.ok(!outputText.includes('f'.repeat(64)));

  const direct = (() => {
    try {
      parseV4CollectionArgs([`--broken=${secretToken}`]);
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.equal(direct.code, 'V4_COLLECTION_ARGUMENT_INVALID');
  assert.ok(!String(direct.message).includes(secretToken));
});

test('runner never retries: exactly one sync invocation even on failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-runner-noretry-'));
  const output = path.join(directory, 'candidate.json');
  const plan = buildV4CollectionPlan({ now: NOW });
  const repository = fakeRepository();
  const { syncCalls, sync } = fakeSync({ throwAfter: true });
  const deps = runnerDeps(repository);
  await runV4Collection({
    plan,
    execute: true,
    approvedPlanHash: plan.planHash,
    output,
    now: NOW,
    env: deps.env,
    createPool: deps.createPool,
    loadSessionStore: deps.loadSessionStore,
    createRepository: deps.createRepository,
    sync,
  });
  assert.equal(syncCalls.length, 1);
});

test('a stale client clock never reaches repository state transitions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-runner-staleclock-'));
  const output = path.join(directory, 'candidate.json');
  const staleNow = new Date('2020-06-15T00:00:00.000Z');
  const plan = buildV4CollectionPlan({ now: staleNow });
  const repository = fakeRepository();
  const { syncCalls, sync } = fakeSync({});
  const deps = runnerDeps(repository);
  const result = await runV4Collection({
    plan,
    execute: true,
    approvedPlanHash: plan.planHash,
    output,
    now: staleNow,
    env: deps.env,
    createPool: deps.createPool,
    loadSessionStore: deps.loadSessionStore,
    createRepository: deps.createRepository,
    sync,
  });
  assert.equal(result.ok, true);
  assert.equal(result.runStatus, 'SUCCEEDED');
  // No client instant is forwarded to any repository state transition; the
  // database owns started_at / completed_at / as_of via clock_timestamp().
  assert.ok(repository.calls.transitionRun.every((call) => !('now' in call)));
  assert.ok(repository.calls.beginAttempt.every((call) => !('now' in call)));
  assert.ok(repository.calls.transitionAttempt.every((call) => !('now' in call)));
  assert.ok(!('asOf' in repository.calls.finalizeCoverage[0]));
  // The candidate still materializes through the same-directory staging path.
  assert.equal(existsSync(output), true);
  assert.equal(existsSync(syncCalls[0].output), false);
});

test('a typed page whose readback cannot prove exact row count/hashes is never SUCCEEDED', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v4-runner-badreadback-'));
  const output = path.join(directory, 'candidate.json');
  const plan = buildV4CollectionPlan({ now: NOW });
  const repository = fakeRepository({ mismatchReadback: true });
  const { syncCalls, sync } = fakeSync({});
  const deps = runnerDeps(repository);
  const result = await runV4Collection({
    plan,
    execute: true,
    approvedPlanHash: plan.planHash,
    output,
    now: NOW,
    env: deps.env,
    createPool: deps.createPool,
    loadSessionStore: deps.loadSessionStore,
    createRepository: deps.createRepository,
    sync,
  });

  assert.equal(result.ok, false);
  assert.equal(result.runStatus, 'PARTIAL');
  assert.deepEqual(result.attemptSummary, {
    total: 325,
    succeeded: 150,
    partial: 175,
    failed: 0,
    expected: 325,
  });
  const terminals = repository.calls.transitionAttempt.filter((call) => call.status !== 'RUNNING');
  assert.equal(terminals.length, 325);
  // All 175 typed page attempts are PARTIAL (evidence persisted, success
  // unprovable); only the 150 statistics attempts may claim SUCCEEDED.
  for (const storeCode of FULL_MANAGED_STORE_CODES) {
    for (const endpointCode of V4_COLLECTION_PAGE_ENDPOINT_CODES) {
      const key = expectedAttemptKey(repository, storeCode, endpointCode);
      const terminal = repository.calls.transitionAttempt.find((call) => (
        call.attemptKey === key && call.status !== 'RUNNING'
      ));
      assert.equal(terminal.status, 'PARTIAL', `${storeCode}/${endpointCode} must not succeed`);
    }
    for (const statisticsType of V4_COLLECTION_STATISTICS_TYPES) {
      const key = expectedAttemptKey(repository, storeCode, `WAYBILLS_STATISTICS_${statisticsType}`);
      const terminal = repository.calls.transitionAttempt.find((call) => (
        call.attemptKey === key && call.status !== 'RUNNING'
      ));
      assert.equal(terminal.status, 'SUCCEEDED');
    }
  }
  assert.equal(repository.calls.finalizeCoverage[0].reasonCode, 'V4_COLLECTION_PARTIAL_COVERAGE');
  // Exact typed-fact readback is required for publication. Partial evidence
  // remains in the control plane, but neither staging nor a candidate survives.
  assert.equal(result.snapshotWritten, null);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(syncCalls[0].output), false);
});

for (const [label, failInsertAt, succeeded, failed] of [
  ['first', 1, 0, 325],
  ['middle', 88, 87, 238],
  ['last', 175, 174, 151],
]) {
  test(`a persistence failure at the ${label} typed insert terminalizes all 325 attempts, fails the run and finalizes coverage fail-closed`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), `v4-runner-persist-${label}-`));
    const output = path.join(directory, 'candidate.json');
    const plan = buildV4CollectionPlan({ now: NOW });
    const repository = fakeRepository({ failInsertAt });
    const { syncCalls, sync } = fakeSync({});
    const deps = runnerDeps(repository);
    await assert.rejects(
      () => runV4Collection({
        plan,
        execute: true,
        approvedPlanHash: plan.planHash,
        output,
        now: NOW,
        env: deps.env,
        createPool: deps.createPool,
        loadSessionStore: deps.loadSessionStore,
        createRepository: deps.createRepository,
        sync,
      }),
      (error) => error.code === 'V4_COLLECTION_READBACK_MISMATCH',
    );

    // Every created attempt reached an explicit terminal status: 325 RUNNING
    // transitions plus exactly 325 terminal transitions.
    assert.equal(repository.calls.transitionAttempt.length, 650);
    const terminals = repository.calls.transitionAttempt.filter((call) => call.status !== 'RUNNING');
    assert.equal(terminals.length, 325);
    assert.equal(terminals.filter((call) => call.status === 'SUCCEEDED').length, succeeded);
    assert.equal(terminals.filter((call) => call.status === 'FAILED').length, failed);
    assert.ok(terminals.every((call) => (
      call.status === 'SUCCEEDED' || call.status === 'FAILED'
    )));
    for (const storeCode of FULL_MANAGED_STORE_CODES) {
      for (const workItemCode of V4_COLLECTION_WORK_ITEM_CODES) {
        const key = expectedAttemptKey(repository, storeCode, workItemCode);
        const terminal = repository.calls.transitionAttempt.find((call) => (
          call.attemptKey === key && call.status !== 'RUNNING'
        ));
        assert.ok(terminal, `${storeCode}/${workItemCode} attempt is not terminal`);
      }
    }

    // The run fails honestly and coverage is finalized fail-closed.
    assert.deepEqual(
      repository.calls.transitionRun.map((call) => call.status),
      ['PREFLIGHT_PASSED', 'RUNNING', 'FAILED'],
    );
    assert.equal(repository.calls.transitionRun.at(-1).sanitizedErrorCode, 'V4_COLLECTION_READBACK_MISMATCH');
    assert.equal(repository.calls.finalizeCoverage.length, 1);
    assert.equal(repository.calls.finalizeCoverage[0].pagingVerified, false);
    assert.equal(repository.calls.finalizeCoverage[0].dedupeVerified, false);
    assert.equal(
      repository.calls.finalizeCoverage[0].reasonCode,
      'V4_COLLECTION_READBACK_MISMATCH',
    );

    // No final candidate artifact, no leftover staging artifact.
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(syncCalls[0].output), false);
    assert.deepEqual(deps.closed, [true]);
  });
}
