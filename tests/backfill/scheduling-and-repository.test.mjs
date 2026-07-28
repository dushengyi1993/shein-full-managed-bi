import assert from 'node:assert/strict';
import test from 'node:test';

import { BACKFILL_MODES, buildBackfillPlan } from '../../src/backfill/plan.mjs';
import { runBackfillPlan } from '../../src/backfill/runner.mjs';
import { createBackfillRepository } from '../../src/backfill/checkpoint-repository.mjs';
import {
  BackfillCliError,
  parseCliArguments,
  planRequestFromFlags,
} from '../../src/backfill/cli-support.mjs';
import { parseRunRequest } from '../../scripts/run_full_managed_backfill.mjs';
import { buildPlanReport } from '../../scripts/plan_full_managed_backfill.mjs';

const PLAN_ARGS = Object.freeze([
  '--stores=DL5477',
  '--domains=purchase-orders',
  '--from=2026-07-01',
  '--to=2026-07-03',
  '--created-by=codex.batch2',
  '--today=2026-07-28',
]);

function passing(businessDate, fingerprint = 'a'.repeat(64)) {
  return {
    ok: true,
    acceptedRowCount: 1,
    rejectedRowCount: 0,
    expectedPageCount: 1,
    observedPageCount: 1,
    persistedRowCount: 1,
    illegalDecimalCount: 0,
    unknownMetricCount: 0,
    schemaFingerprint: fingerprint,
    businessDates: [businessDate],
  };
}

/** Repository double that records checkpoint state per grain. */
function grainRepository() {
  const checkpoints = new Map();
  const commits = [];
  return {
    checkpoints,
    commits,
    async openRun() { return { backfillRunId: 9, resumed: false }; },
    async loadCompletedWindowKeys() { return []; },
    async loadCheckpoints() { return []; },
    async commitWindowOutcome({ window, outcome, checkpointState }) {
      commits.push({ window, outcome, checkpointState });
      const grain = `${window.storeCode}${window.domain}${window.adapterKey}`;
      if (checkpointState) checkpoints.set(grain, checkpointState);
      return {
        persisted: true,
        backfillWindowId: commits.length,
        checkpointAdvanced: checkpointState !== null,
      };
    },
    async recordWindowOutcome(input) {
      return this.commitWindowOutcome({ ...input, checkpointState: null });
    },
    async closeRun() { return { closed: true }; },
  };
}

test('same-grain windows never overlap and each observes the previous checkpoint', async () => {
  const plan = buildBackfillPlan({
    storeCodes: ['DL5477'],
    domains: ['purchase-orders'],
    from: '2026-07-01',
    to: '2026-07-03',
    concurrency: 4,
    createdBy: 'codex.batch2',
    today: '2026-07-28',
  });
  const repository = grainRepository();
  let inFlight = 0;
  let maxInFlight = 0;
  const observedCheckpoints = [];
  const order = [];

  await runBackfillPlan({
    plan,
    mode: BACKFILL_MODES.EXECUTE,
    approvedPlanHash: plan.planHash,
    allowedStoreCodes: ['DL5477'],
    allowedDomains: ['purchase-orders'],
    repository,
    adapters: {
      'openapi.purchase-orders.v1': {
        async fetchWindow({ windowStart, checkpoint }) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          order.push(windowStart);
          observedCheckpoints.push(checkpoint?.lastCompletedBusinessDate ?? null);
          await new Promise((resolve) => { setTimeout(resolve, 1); });
          inFlight -= 1;
          return passing(windowStart);
        },
      },
    },
  });

  // One grain: strictly sequential, newest-first.
  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, ['2026-07-03', '2026-07-02', '2026-07-01']);
  // The first window advanced the checkpoint, so the second observes it.
  assert.equal(observedCheckpoints[0], null);
  assert.equal(observedCheckpoints[1], '2026-07-03');
  // The third window is older than the checkpoint, so it cannot move it back.
  assert.equal(repository.commits[2].checkpointState, null);
});

test('a same-grain schema drift is detected because the second window sees the first fingerprint', async () => {
  const plan = buildBackfillPlan({
    storeCodes: ['DL5477'],
    domains: ['purchase-orders'],
    from: '2026-07-02',
    to: '2026-07-03',
    concurrency: 4,
    createdBy: 'codex.batch2',
    today: '2026-07-28',
  });
  const repository = grainRepository();
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
          return windowStart === '2026-07-03'
            ? passing(windowStart, 'a'.repeat(64))
            : passing(windowStart, 'b'.repeat(64));
        },
      },
    },
  });
  const drifted = result.windows.find((window) => window.windowStart === '2026-07-02');
  assert.equal(drifted.qualityStatus, 'SCHEMA_DRIFT');
  assert.equal(drifted.checkpointAdvanced, false);
  assert.equal(result.checkpointAdvancedCount, 1);
});

test('different grains still overlap up to the plan concurrency bound', async () => {
  const plan = buildBackfillPlan({
    storeCodes: ['DL5477', 'MZ2406'],
    domains: ['deliveries', 'purchase-orders'],
    from: '2026-07-03',
    to: '2026-07-03',
    concurrency: 4,
    createdBy: 'codex.batch2',
    today: '2026-07-28',
  });
  let inFlight = 0;
  let maxInFlight = 0;
  const adapter = {
    async fetchWindow({ windowStart }) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      inFlight -= 1;
      return passing(windowStart);
    },
  };
  await runBackfillPlan({
    plan,
    mode: BACKFILL_MODES.EXECUTE,
    approvedPlanHash: plan.planHash,
    allowedStoreCodes: ['DL5477', 'MZ2406'],
    allowedDomains: ['deliveries', 'purchase-orders'],
    repository: grainRepository(),
    adapters: {
      'openapi.deliveries.v1': adapter,
      'openapi.purchase-orders.v1': adapter,
    },
  });
  // Only purchase-orders is executable, so two stores yield two live grains.
  assert.equal(maxInFlight, 2);
});

/** Deterministic fake pg pool that records every statement. */
function fakePool(responder) {
  const statements = [];
  const client = {
    async query(text, values) {
      statements.push({ text: String(text).replace(/\s+/g, ' ').trim(), values });
      return responder(String(text), values) ?? { rows: [], rowCount: 0 };
    },
    release() { client.released = true; },
    released: false,
  };
  return {
    statements,
    client,
    async connect() { return client; },
    async query(text, values) { return client.query(text, values); },
  };
}

test('a window and its forward checkpoint commit in one transaction', async () => {
  const pool = fakePool((text) => {
    if (text.includes('INSERT INTO ops.backfill_window')) {
      return { rows: [{ backfill_window_id: 5 }], rowCount: 1 };
    }
    if (text.includes('INSERT INTO ops.backfill_checkpoint')) {
      return { rows: [{ backfill_checkpoint_id: 3 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const repository = createBackfillRepository({ pool });
  const result = await repository.commitWindowOutcome({
    backfillRunId: 9,
    window: {
      storeCode: 'DL5477',
      domain: 'deliveries',
      adapterKey: 'openapi.deliveries.v1',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-02',
      windowKey: 'c'.repeat(64),
      capabilityStatus: 'VERIFIED',
    },
    outcome: {
      executionStatus: 'SUCCEEDED',
      qualityStatus: 'PASSED',
      sanitizedErrorCode: null,
      acceptedRowCount: 1,
      rejectedRowCount: 0,
      expectedPageCount: 1,
      observedPageCount: 1,
      schemaFingerprint: 'a'.repeat(64),
      sourceBusinessWatermark: '2026-07-01',
    },
    attemptCount: 1,
    checkpointState: {
      storeCode: 'DL5477',
      domain: 'deliveries',
      adapterKey: 'openapi.deliveries.v1',
      lastCompletedBusinessDate: '2026-07-01',
      lastSourceCursor: '2026-07-02',
      lastSuccessfulRunId: 9,
      schemaFingerprint: 'a'.repeat(64),
    },
  });
  assert.deepEqual(result, { persisted: true, backfillWindowId: 5, checkpointAdvanced: true });
  const order = pool.statements.map((item) => item.text.slice(0, 34));
  assert.equal(order[0], 'BEGIN');
  assert.equal(order.at(-1), 'COMMIT');
  assert.ok(order.some((text) => text.startsWith('INSERT INTO ops.backfill_window')));
  assert.ok(order.some((text) => text.startsWith('INSERT INTO ops.backfill_check')));
  assert.equal(pool.client.released, true);
});

test('repository exposes persisted attempt counts for exact plan resume', async () => {
  const pool = fakePool((text) => {
    if (text.includes('SELECT w.window_key, w.attempt_count')) {
      return {
        rows: [{ window_key: 'a'.repeat(64), attempt_count: '6' }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  assert.deepEqual(
    await createBackfillRepository({ pool }).loadWindowAttemptCounts({
      planHash: 'f'.repeat(64),
    }),
    [{ windowKey: 'a'.repeat(64), attemptCount: 6 }],
  );
});

test('a non-forward checkpoint update reports no advance and never retries', async () => {
  const pool = fakePool((text) => {
    if (text.includes('INSERT INTO ops.backfill_window')) {
      return { rows: [{ backfill_window_id: 6 }], rowCount: 1 };
    }
    // The forward-only WHERE clause matched nothing.
    if (text.includes('INSERT INTO ops.backfill_checkpoint')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const repository = createBackfillRepository({ pool });
  const result = await repository.commitWindowOutcome({
    backfillRunId: 9,
    window: {
      storeCode: 'MZ2406',
      domain: 'deliveries',
      adapterKey: 'openapi.deliveries.v1',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-02',
      windowKey: 'd'.repeat(64),
      capabilityStatus: 'VERIFIED',
    },
    outcome: {
      executionStatus: 'SUCCEEDED',
      qualityStatus: 'PASSED',
      sanitizedErrorCode: null,
      acceptedRowCount: 1,
      rejectedRowCount: 0,
      expectedPageCount: 1,
      observedPageCount: 1,
      schemaFingerprint: 'a'.repeat(64),
      sourceBusinessWatermark: '2026-07-01',
    },
    attemptCount: 1,
    checkpointState: {
      storeCode: 'MZ2406',
      domain: 'deliveries',
      adapterKey: 'openapi.deliveries.v1',
      lastCompletedBusinessDate: '2026-07-01',
      lastSourceCursor: '2026-07-02',
      lastSuccessfulRunId: 9,
      schemaFingerprint: 'a'.repeat(64),
    },
  });
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(pool.statements.at(-1).text, 'COMMIT');
});

test('a failed window statement rolls the whole transaction back', async () => {
  const pool = fakePool((text) => {
    if (text.includes('INSERT INTO ops.backfill_window')) {
      const error = new Error('constraint violation');
      error.code = '23514';
      throw error;
    }
    return { rows: [], rowCount: 0 };
  });
  const repository = createBackfillRepository({ pool });
  await assert.rejects(() => repository.commitWindowOutcome({
    backfillRunId: 9,
    window: {
      storeCode: 'DL5477',
      domain: 'deliveries',
      adapterKey: 'openapi.deliveries.v1',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-02',
      windowKey: 'e'.repeat(64),
      capabilityStatus: 'VERIFIED',
    },
    outcome: {
      executionStatus: 'FAILED',
      qualityStatus: 'ADAPTER_ERROR',
      sanitizedErrorCode: 'UPSTREAM_TIMEOUT',
      acceptedRowCount: null,
      rejectedRowCount: null,
      expectedPageCount: null,
      observedPageCount: null,
      schemaFingerprint: null,
      sourceBusinessWatermark: null,
    },
    attemptCount: 1,
    checkpointState: null,
  }));
  assert.ok(pool.statements.some((item) => item.text === 'ROLLBACK'));
  assert.ok(!pool.statements.some((item) => item.text === 'COMMIT'));
  assert.equal(pool.client.released, true);
});

test('openRun persists one instant for created_at and started_at and detects scope drift', async () => {
  const startedAt = '2026-07-28T01:00:00.000Z';
  const insertPool = fakePool((text) => {
    if (text.includes('INSERT INTO ops.backfill_run')) {
      return { rows: [{ backfill_run_id: 11, status: 'RUNNING' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const request = {
    planHash: 'f'.repeat(64),
    requestedDomains: ['deliveries'],
    requestedStoreCodes: ['DL5477'],
    requestedFrom: '2026-07-01',
    requestedTo: '2026-07-02',
    windowSpanDays: 1,
    plannedWindowCount: 2,
    createdBy: 'codex.batch2',
    startedAt,
  };
  const opened = await createBackfillRepository({ pool: insertPool }).openRun(request);
  assert.deepEqual(opened, { backfillRunId: 11, resumed: false, status: 'RUNNING' });
  const insert = insertPool.statements.find((item) => item.text.includes('INSERT INTO ops.backfill_run'));
  assert.match(insert.text, /created_at, started_at/);
  // The same bound parameter feeds both columns, so started_at >= created_at holds.
  assert.match(insert.text, /\$9, \$9\)/);
  assert.equal(insert.values.at(-1), startedAt);

  const driftPool = fakePool((text) => {
    if (text.includes('INSERT INTO ops.backfill_run')) return { rows: [], rowCount: 0 };
    if (text.includes('FROM ops.backfill_run')) {
      return {
        rows: [{
          backfill_run_id: 11,
          status: 'RUNNING',
          requested_domains: ['deliveries'],
          requested_store_codes: ['MZ2406'],
          requested_from: '2026-07-01',
          requested_to: '2026-07-02',
          window_span_days: 1,
          planned_window_count: 2,
          created_by: 'codex.batch2',
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(
    () => createBackfillRepository({ pool: driftPool }).openRun(request),
    (error) => error.code === 'BACKFILL_RUN_REPLAY_DRIFT',
  );
  assert.ok(driftPool.statements.some((item) => item.text === 'ROLLBACK'));

  const replayPool = fakePool((text) => {
    if (text.includes('INSERT INTO ops.backfill_run')) return { rows: [], rowCount: 0 };
    if (text.includes('FROM ops.backfill_run')) {
      return {
        rows: [{
          backfill_run_id: 11,
          status: 'FAILED',
          requested_domains: ['deliveries'],
          requested_store_codes: ['DL5477'],
          // node-postgres represents a DATE as local midnight, not a UTC
          // instant. Exact replay must compare its local calendar fields.
          requested_from: new Date(2026, 6, 1),
          requested_to: new Date(2026, 6, 2),
          window_span_days: 1,
          planned_window_count: 2,
          created_by: 'codex.batch2',
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  assert.deepEqual(
    await createBackfillRepository({ pool: replayPool }).openRun(request),
    { backfillRunId: 11, resumed: true, status: 'FAILED' },
  );

  await assert.rejects(
    () => createBackfillRepository({ pool: insertPool }).openRun({ ...request, startedAt: 'nope' }),
    (error) => error.code === 'BACKFILL_RUN_START_INSTANT_INVALID',
  );
});

test('closeRun requires exactly one EXECUTE row and a valid instant', async () => {
  const okPool = fakePool(() => ({ rows: [{ backfill_run_id: 11 }], rowCount: 1 }));
  const closed = await createBackfillRepository({ pool: okPool }).closeRun({
    backfillRunId: 11,
    status: 'SUCCEEDED',
    completedAt: '2026-07-28T02:00:00.000Z',
    sanitizedErrorCode: null,
  });
  assert.deepEqual(closed, { closed: true, backfillRunId: 11 });
  assert.match(okPool.statements[0].text, /mode = 'EXECUTE'/);

  const missingPool = fakePool(() => ({ rows: [], rowCount: 0 }));
  await assert.rejects(
    () => createBackfillRepository({ pool: missingPool }).closeRun({
      backfillRunId: 12,
      status: 'SUCCEEDED',
      completedAt: '2026-07-28T02:00:00.000Z',
    }),
    (error) => error.code === 'BACKFILL_RUN_CLOSE_MISSING',
  );
  await assert.rejects(
    () => createBackfillRepository({ pool: okPool }).closeRun({
      backfillRunId: 11,
      status: 'SUCCEEDED',
      completedAt: null,
    }),
    (error) => error.code === 'BACKFILL_RUN_COMPLETION_INSTANT_INVALID',
  );
});

test('bounded integer flags are validated strictly, not by parseInt', () => {
  for (const flag of [
    '--window-span-days=1x',
    '--concurrency=2.5',
    '--max-attempts= 3 4',
    '--concurrency=0x2',
    '--window-span-days=+1',
  ]) {
    assert.throws(() => buildPlanReport([...PLAN_ARGS, flag]), /INVALID_BOUND|integer/i);
  }
  const flags = parseCliArguments([...PLAN_ARGS, '--concurrency=2']);
  // The literal operator text reaches the planner's strict validator.
  assert.equal(planRequestFromFlags(flags).concurrency, '2');
  assert.equal(buildPlanReport([...PLAN_ARGS, '--concurrency=2']).concurrency, 2);
});

test('duplicate and unknown flags are rejected per entrypoint', () => {
  assert.throws(
    () => parseCliArguments(['--stores=DL5477', '--stores=MZ2406']),
    (error) => error.code === 'CLI_FLAG_DUPLICATED',
  );
  assert.throws(
    () => buildPlanReport([...PLAN_ARGS, '--allow-stores=DL5477']),
    (error) => error.code === 'CLI_FLAG_UNKNOWN',
  );
  assert.throws(
    () => buildPlanReport([...PLAN_ARGS, '--typo=1']),
    (error) => error.code === 'CLI_FLAG_UNKNOWN',
  );
  assert.throws(
    () => parseRunRequest([...PLAN_ARGS, '--nope=1']),
    (error) => error.code === 'CLI_FLAG_UNKNOWN',
  );
  assert.throws(
    () => parseRunRequest([...PLAN_ARGS, '--execute=maybe']),
    (error) => error.code === 'CLI_FLAG_NOT_BOOLEAN',
  );
  // Execute-only flags without --execute are a scope mistake, not a no-op.
  assert.throws(
    () => parseRunRequest([...PLAN_ARGS, '--allow-stores=DL5477']),
    (error) => error.code === 'CLI_EXECUTE_FLAG_WITHOUT_EXECUTE',
  );
});

test('execute mode authorizes the exact purchase-order scope', () => {
  const dryRun = parseRunRequest(PLAN_ARGS);
  assert.throws(
    () => parseRunRequest([
      ...PLAN_ARGS,
      '--execute',
      `--approved-plan-hash=${'b'.repeat(64)}`,
      '--allow-stores=DL5477',
      '--allow-domains=purchase-orders',
    ]),
    (error) => error.code === 'PLAN_HASH_MISMATCH',
  );
  assert.throws(
    () => parseRunRequest([
      ...PLAN_ARGS,
      '--execute',
      `--approved-plan-hash=${dryRun.plan.planHash}`,
      '--allow-stores=MZ2406',
      '--allow-domains=purchase-orders',
    ]),
    (error) => error.code === 'STORE_NOT_AUTHORIZED',
  );
  assert.throws(
    () => parseRunRequest([
      ...PLAN_ARGS,
      '--execute',
      `--approved-plan-hash=${dryRun.plan.planHash}`,
      '--allow-stores=DL5477',
      '--allow-domains=deliveries',
    ]),
    (error) => error.code === 'DOMAIN_NOT_AUTHORIZED',
  );
  const authorized = parseRunRequest([
    ...PLAN_ARGS,
    '--execute',
    `--approved-plan-hash=${dryRun.plan.planHash}`,
    '--allow-stores=DL5477',
    '--allow-domains=purchase-orders',
  ]);
  assert.equal(authorized.authorization.planHash, dryRun.plan.planHash);
});
