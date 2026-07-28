import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BACKFILL_MODES,
  BackfillPlanError,
  assertExecuteAuthorization,
  buildBackfillPlan,
} from '../../src/backfill/plan.mjs';
import { runBackfillPlan } from '../../src/backfill/runner.mjs';
import {
  CAPABILITY_STATUSES,
  EXECUTABLE_BACKFILL_DOMAINS,
} from '../../src/backfill/capability-catalog.mjs';
import {
  WINDOW_EXECUTION_STATUSES,
  WINDOW_QUALITY_STATUSES,
  evaluateWindowOutcome,
  nextCheckpointState,
} from '../../src/backfill/quality-gate.mjs';

const BASE = Object.freeze({
  storeCodes: ['DL5477', 'MZ2406'],
  domains: ['deliveries', 'purchase-orders'],
  from: '2026-07-01',
  to: '2026-07-03',
  createdBy: 'codex.batch2',
  today: '2026-07-28',
});

function passingResult(overrides = {}) {
  return {
    ok: true,
    acceptedRowCount: 5,
    rejectedRowCount: 0,
    expectedPageCount: 2,
    observedPageCount: 2,
    persistedRowCount: 5,
    illegalDecimalCount: 0,
    unknownMetricCount: 0,
    schemaFingerprint: 'a'.repeat(64),
    businessDates: ['2026-07-02'],
    ...overrides,
  };
}

function recordingRepository({
  completedWindowKeys = [],
  checkpoints = [],
  windowAttemptCounts = [],
} = {}) {
  const calls = { openRun: 0, commits: [], closed: [] };
  return {
    calls,
    async openRun() {
      calls.openRun += 1;
      return { backfillRunId: 41, resumed: calls.openRun > 1 };
    },
    async loadCompletedWindowKeys() { return completedWindowKeys; },
    async loadWindowAttemptCounts() { return windowAttemptCounts; },
    async loadCheckpoints() { return checkpoints; },
    async commitWindowOutcome({ window, outcome, checkpointState, attemptCount }) {
      calls.commits.push({ window, outcome, checkpointState, attemptCount });
      return {
        persisted: true,
        backfillWindowId: calls.commits.length,
        checkpointAdvanced: checkpointState !== null,
      };
    },
    async recordWindowOutcome(input) {
      return this.commitWindowOutcome({ ...input, checkpointState: null });
    },
    async closeRun(input) { calls.closed.push(input); return { closed: true }; },
  };
}

test('plan hash is deterministic across store and domain input ordering', () => {
  const first = buildBackfillPlan(BASE);
  const second = buildBackfillPlan({
    ...BASE,
    storeCodes: ['mz2406', 'DL5477', 'DL5477'],
    domains: ['purchase-orders', 'deliveries'],
  });
  assert.equal(first.planHash, second.planHash);
  assert.deepEqual(first.windows.map((w) => w.windowKey), second.windows.map((w) => w.windowKey));
  assert.match(first.planHash, /^[0-9a-f]{64}$/);

  // A different scope must produce a different hash.
  assert.notEqual(
    first.planHash,
    buildBackfillPlan({ ...BASE, to: '2026-07-04' }).planHash,
  );
});

test('windows are planned newest-first, non-overlapping and half-open', () => {
  const plan = buildBackfillPlan({ ...BASE, domains: ['purchase-orders'], storeCodes: ['DL5477'] });
  const starts = plan.windows.map((window) => window.windowStart);
  assert.deepEqual(starts, ['2026-07-03', '2026-07-02', '2026-07-01']);
  for (const window of plan.windows) {
    assert.ok(window.windowStart < window.windowEnd);
  }
  // windowEnd is exclusive, so window N ends exactly where window N+1 begins.
  assert.equal(plan.windows[0].windowEnd, '2026-07-04');
  assert.equal(plan.windows[1].windowEnd, '2026-07-03');
});

test('planner enforces explicit scope and bounded inputs', () => {
  assert.throws(() => buildBackfillPlan({ ...BASE, storeCodes: [] }), /EMPTY_STORE_SCOPE|store/i);
  assert.throws(() => buildBackfillPlan({ ...BASE, storeCodes: ['DL'] }), BackfillPlanError);
  assert.throws(() => buildBackfillPlan({ ...BASE, domains: ['nope'] }), BackfillPlanError);
  assert.throws(() => buildBackfillPlan({ ...BASE, to: '2027-01-01' }), BackfillPlanError);
  assert.throws(() => buildBackfillPlan({ ...BASE, createdBy: '' }), BackfillPlanError);
  assert.throws(() => buildBackfillPlan({ ...BASE, concurrency: 99 }), BackfillPlanError);
});

test('unverified, unsupported and experiment-only domains plan as explicit blockers', () => {
  const plan = buildBackfillPlan({
    ...BASE,
    storeCodes: ['DL5477'],
    domains: [
      'financial-settlement',
      'inventory-history',
      'webhook-history',
      'webapi-home-snapshot',
    ],
  });
  assert.equal(plan.summary.executableWindowCount, 0);
  assert.ok(plan.summary.blockedWindowCount > 0);
  assert.deepEqual(plan.summary.blockedReasonCodes, [
    'FINANCIAL_SETTLEMENT_UNVERIFIED',
    'INVENTORY_HISTORY_UNSUPPORTED',
    'WEBAPI_EXPERIMENT_ONLY',
    'WEBHOOK_HISTORY_UNSUPPORTED',
  ]);
  for (const window of plan.windows) {
    assert.equal(window.executable, false);
    assert.equal(window.maxAttempts, 0);
  }
});

test('blocked ranges use the fewest 31-day ledger chunks instead of daily fan-out', () => {
  const plan = buildBackfillPlan({
    ...BASE,
    storeCodes: ['DL5477'],
    domains: ['deliveries'],
    from: '2026-05-01',
    to: '2026-07-04',
  });
  assert.equal(plan.summary.blockedWindowChunkDays, 31);
  assert.equal(plan.summary.blockedWindowCountPerStoreDomain, 3);
  assert.equal(plan.summary.blockedWindowCount, 3);
  assert.deepEqual(
    plan.windows.map(({ windowStart, windowEnd }) => ({ windowStart, windowEnd })),
    [
      { windowStart: '2026-06-04', windowEnd: '2026-07-05' },
      { windowStart: '2026-05-04', windowEnd: '2026-06-04' },
      { windowStart: '2026-05-01', windowEnd: '2026-05-04' },
    ],
  );
  for (const window of plan.windows) {
    const start = new Date(`${window.windowStart}T00:00:00.000Z`);
    const end = new Date(`${window.windowEnd}T00:00:00.000Z`);
    assert.ok((end - start) / 86_400_000 <= 31);
    assert.equal(window.executable, false);
  }
});

test('four-window sales snapshots are blocked because they are not historical', () => {
  const plan = buildBackfillPlan({
    ...BASE,
    storeCodes: ['DL5477'],
    domains: ['sales-window-snapshot'],
  });
  for (const window of plan.windows) {
    assert.equal(window.capabilityStatus, CAPABILITY_STATUSES.UNSUPPORTED);
    assert.equal(window.blockedReasonCode, 'SALES_WINDOW_SNAPSHOT_NOT_HISTORICAL');
    assert.equal(window.dailyHistoryReconstructable, false);
    assert.equal(window.windowGrain, 'WINDOW_SNAPSHOT');
  }
  assert.deepEqual(EXECUTABLE_BACKFILL_DOMAINS.includes('financial-settlement'), false);
  assert.deepEqual(EXECUTABLE_BACKFILL_DOMAINS, ['purchase-orders']);
});

test('execute authorization requires the exact hash and explicit allow-lists', () => {
  const plan = buildBackfillPlan(BASE);
  assert.throws(
    () => assertExecuteAuthorization({ plan, approvedPlanHash: 'b'.repeat(64), allowedStoreCodes: BASE.storeCodes, allowedDomains: BASE.domains }),
    /PLAN_HASH_MISMATCH|hash/i,
  );
  assert.throws(
    () => assertExecuteAuthorization({ plan, approvedPlanHash: plan.planHash, allowedStoreCodes: ['DL5477'], allowedDomains: BASE.domains }),
    /STORE_NOT_AUTHORIZED|store/i,
  );
  assert.throws(
    () => assertExecuteAuthorization({ plan, approvedPlanHash: plan.planHash, allowedStoreCodes: BASE.storeCodes, allowedDomains: ['deliveries'] }),
    /DOMAIN_NOT_AUTHORIZED|domain/i,
  );
  const authorization = assertExecuteAuthorization({
    plan,
    approvedPlanHash: plan.planHash,
    allowedStoreCodes: BASE.storeCodes,
    allowedDomains: BASE.domains,
  });
  assert.equal(authorization.planHash, plan.planHash);
});

test('dry-run invokes no adapter and touches no repository', async () => {
  const plan = buildBackfillPlan(BASE);
  let adapterCalls = 0;
  const repository = recordingRepository();
  const result = await runBackfillPlan({
    plan,
    mode: BACKFILL_MODES.DRY_RUN,
    repository,
    adapters: {
      'openapi.deliveries.v1': { async fetchWindow() { adapterCalls += 1; return passingResult(); } },
      'openapi.purchase-orders.v1': { async fetchWindow() { adapterCalls += 1; return passingResult(); } },
    },
  });
  assert.equal(adapterCalls, 0);
  assert.equal(result.adapterInvocationCount, 0);
  assert.equal(repository.calls.openRun, 0);
  assert.equal(repository.calls.commits.length, 0);
  assert.equal(result.runStatus, 'PLANNED');
  assert.equal(result.checkpointAdvancedCount, 0);
});

test('unverified, unsupported and experiment-only windows make zero adapter calls in execute mode', async () => {
  const plan = buildBackfillPlan({
    ...BASE,
    storeCodes: ['DL5477'],
    domains: ['financial-settlement', 'inventory-history', 'webapi-home-snapshot'],
  });
  let adapterCalls = 0;
  const forbidden = { async fetchWindow() { adapterCalls += 1; return passingResult(); } };
  const repository = recordingRepository();
  const result = await runBackfillPlan({
    plan,
    mode: BACKFILL_MODES.EXECUTE,
    approvedPlanHash: plan.planHash,
    allowedStoreCodes: ['DL5477'],
    allowedDomains: plan.domains,
    repository,
    adapters: {
      'openapi.financial-settlement.v0': forbidden,
      'openapi.inventory-history.v0': forbidden,
      'webapi.home-snapshot.v0': forbidden,
    },
  });
  assert.equal(adapterCalls, 0);
  assert.equal(result.adapterInvocationCount, 0);
  assert.equal(result.counts.blocked, plan.windows.length);
  assert.equal(result.counts.succeeded, 0);
  assert.equal(result.checkpointAdvancedCount, 0);
  for (const commit of repository.calls.commits) {
    assert.equal(commit.checkpointState, null);
    assert.equal(commit.outcome.executionStatus, WINDOW_EXECUTION_STATUSES.BLOCKED);
  }
});

test('same plan hash replay resumes only incomplete verified windows', async () => {
  const plan = buildBackfillPlan({ ...BASE, storeCodes: ['DL5477'], domains: ['purchase-orders'] });
  const completed = [plan.windows[0].windowKey, plan.windows[1].windowKey];
  const seen = [];
  const repository = recordingRepository({ completedWindowKeys: completed });
  const result = await runBackfillPlan({
    plan,
    mode: BACKFILL_MODES.EXECUTE,
    approvedPlanHash: plan.planHash,
    allowedStoreCodes: ['DL5477'],
    allowedDomains: ['purchase-orders'],
    repository,
    adapters: {
      'openapi.purchase-orders.v1': {
        async fetchWindow({ windowStart }) {
          seen.push(windowStart);
          return passingResult({ businessDates: [windowStart] });
        },
      },
    },
  });
  assert.deepEqual(seen, [plan.windows[2].windowStart]);
  assert.equal(result.adapterInvocationCount, 1);
  assert.equal(result.counts.skipped, 2);
  assert.equal(result.counts.succeeded, 1);
  // Only the resumed window produced a commit; replays create no duplicates.
  assert.equal(repository.calls.commits.length, 1);
  assert.equal(repository.calls.openRun, 1);
});

test('same plan replay continues the persisted attempt ordinal', async () => {
  const plan = buildBackfillPlan({
    ...BASE,
    storeCodes: ['DL5477'],
    domains: ['purchase-orders'],
    from: '2026-07-01',
    to: '2026-07-01',
  });
  const [window] = plan.windows;
  const seen = [];
  const repository = recordingRepository({
    windowAttemptCounts: [{ windowKey: window.windowKey, attemptCount: 3 }],
  });
  const result = await runBackfillPlan({
    plan,
    mode: BACKFILL_MODES.EXECUTE,
    approvedPlanHash: plan.planHash,
    allowedStoreCodes: ['DL5477'],
    allowedDomains: ['purchase-orders'],
    repository,
    adapters: {
      'openapi.purchase-orders.v1': {
        async fetchWindow({ planHash, attempt, windowStart }) {
          seen.push({ planHash, attempt });
          return passingResult({ businessDates: [windowStart] });
        },
      },
    },
  });
  assert.deepEqual(seen, [{ planHash: plan.planHash, attempt: 4 }]);
  assert.equal(result.counts.succeeded, 1);
  assert.equal(repository.calls.commits[0].attemptCount, 1);
});

test('failed and partial windows never advance a checkpoint', async () => {
  const plan = buildBackfillPlan({ ...BASE, storeCodes: ['DL5477'], domains: ['purchase-orders'], to: '2026-07-01' });
  for (const badResult of [
    { ok: false, sanitizedErrorCode: 'UPSTREAM_TIMEOUT' },
    passingResult({ observedPageCount: 1 }),
    passingResult({ rejectedRowCount: 3 }),
    passingResult({ persistedRowCount: 2 }),
  ]) {
    const repository = recordingRepository();
    const result = await runBackfillPlan({
      plan,
      mode: BACKFILL_MODES.EXECUTE,
      approvedPlanHash: plan.planHash,
      allowedStoreCodes: ['DL5477'],
      allowedDomains: ['purchase-orders'],
      repository,
      adapters: { 'openapi.purchase-orders.v1': { async fetchWindow() { return badResult; } } },
    });
    assert.equal(result.checkpointAdvancedCount, 0);
    assert.notEqual(result.runStatus, 'SUCCEEDED');
    for (const commit of repository.calls.commits) {
      assert.equal(commit.checkpointState, null);
    }
  }
});

test('quality gate blocks every unproven condition and never advances a checkpoint', () => {
  const window = buildBackfillPlan({
    ...BASE, storeCodes: ['DL5477'], domains: ['purchase-orders'], to: '2026-07-01',
  }).windows[0];

  const cases = [
    [{ ok: false, sanitizedErrorCode: 'X' }, WINDOW_QUALITY_STATUSES.ADAPTER_ERROR],
    [passingResult({ observedPageCount: 1 }), WINDOW_QUALITY_STATUSES.MISSING_PAGE],
    [passingResult({ schemaFingerprint: null }), WINDOW_QUALITY_STATUSES.SCHEMA_DRIFT],
    [passingResult({ businessDates: ['2026-07-01', '2026-07-02'] }), WINDOW_QUALITY_STATUSES.MIXED_BUSINESS_DATE],
    [passingResult({ illegalDecimalCount: 1 }), WINDOW_QUALITY_STATUSES.ILLEGAL_DECIMAL],
    [passingResult({ unknownMetricCount: 2 }), WINDOW_QUALITY_STATUSES.UNKNOWN_METRIC],
    [passingResult({ rejectedRowCount: 1 }), WINDOW_QUALITY_STATUSES.REJECTED_ROWS],
    [passingResult({ persistedRowCount: 1 }), WINDOW_QUALITY_STATUSES.COVERAGE_GAP],
  ];
  for (const [result, expectedQuality] of cases) {
    const outcome = evaluateWindowOutcome({ window, result });
    assert.equal(outcome.qualityStatus, expectedQuality);
    assert.equal(outcome.checkpointAdvanceable, false);
    assert.equal(nextCheckpointState({ window, outcome, runId: 1 }), null);
  }

  // Schema fingerprint drift against the stored checkpoint also blocks.
  const drift = evaluateWindowOutcome({
    window,
    result: passingResult({ businessDates: [window.windowStart] }),
    checkpoint: { schemaFingerprint: 'b'.repeat(64) },
  });
  assert.equal(drift.qualityStatus, WINDOW_QUALITY_STATUSES.SCHEMA_DRIFT);
  assert.equal(drift.checkpointAdvanceable, false);

  const passed = evaluateWindowOutcome({
    window,
    result: passingResult({ businessDates: [window.windowStart] }),
  });
  assert.equal(passed.qualityStatus, WINDOW_QUALITY_STATUSES.PASSED);
  assert.equal(passed.checkpointAdvanceable, true);
  const state = nextCheckpointState({ window, outcome: passed, runId: 7 });
  assert.equal(state.lastCompletedBusinessDate, window.windowStart);
  assert.equal(state.capabilityStatus, CAPABILITY_STATUSES.VERIFIED);
  // A checkpoint may only move forward.
  assert.equal(
    nextCheckpointState({
      window,
      outcome: passed,
      checkpoint: { lastCompletedBusinessDate: '2026-12-31' },
      runId: 7,
    }),
    null,
  );
});

test('a missing adapter is an explicit blocker, not an empty success', async () => {
  const plan = buildBackfillPlan({ ...BASE, storeCodes: ['DL5477'], domains: ['purchase-orders'], to: '2026-07-01' });
  const repository = recordingRepository();
  const result = await runBackfillPlan({
    plan,
    mode: BACKFILL_MODES.EXECUTE,
    approvedPlanHash: plan.planHash,
    allowedStoreCodes: ['DL5477'],
    allowedDomains: ['purchase-orders'],
    repository,
    adapters: {},
  });
  assert.equal(result.adapterInvocationCount, 0);
  assert.deepEqual(result.blockedReasonCodes, ['ADAPTER_NOT_REGISTERED']);
  assert.equal(result.checkpointAdvancedCount, 0);
  assert.notEqual(result.runStatus, 'SUCCEEDED');
});
