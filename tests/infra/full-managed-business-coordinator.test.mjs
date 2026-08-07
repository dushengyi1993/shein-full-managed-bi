import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCoordinatorPlan,
  classifyStageResult,
  COORDINATOR_TASKS,
  coordinatorRunId,
  extractLastJsonDocument,
  runCoordinator,
} from '../../scripts/run_full_managed_business_coordinator.mjs';
import { markReadyCoordinatorsPublished } from '../../scripts/mark_full_managed_coordinators_published.mjs';
import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';

test('realtime coordinator owns one hourly run and two internal source stages', () => {
  const now = new Date('2026-08-07T20:02:00+08:00');
  const plan = buildCoordinatorPlan(COORDINATOR_TASKS.REALTIME, now);
  assert.equal(plan.runId, 'fm-realtime-cockpit-2026-08-07T20');
  assert.equal(plan.parallel, true);
  assert.deepEqual(plan.stages.map(({ name }) => name), [
    'home-realtime',
    'sales-realtime',
  ]);
  assert.match(plan.stages[0].args[0], new RegExp(FULL_MANAGED_STORE_CODES.join(',')));
  assert.ok(plan.stages[1].args.includes('2'));
});

test('daily operations is one 25-store run instead of five public batches', () => {
  const plan = buildCoordinatorPlan(
    COORDINATOR_TASKS.DAILY,
    new Date('2026-08-07T05:45:00+08:00'),
  );
  assert.equal(plan.parallel, false);
  assert.deepEqual(plan.stages.map(({ name }) => name), ['home-history', 'home-ledger']);
  for (const stage of plan.stages) {
    assert.ok(stage.args.includes(`--stores=${FULL_MANAGED_STORE_CODES.join(',')}`));
  }
  assert.ok(plan.stages[0].args.includes('--require-settled-through=2026-08-06'));
});

test('coordinator run ids are deterministic at the correct business grain', () => {
  const now = new Date('2026-08-07T20:02:00+08:00');
  assert.equal(coordinatorRunId(COORDINATOR_TASKS.REALTIME, now), 'fm-realtime-cockpit-2026-08-07T20');
  assert.equal(coordinatorRunId(COORDINATOR_TASKS.SUPPLY, now), 'fm-supply-daily-2026-08-07');
});

test('session maintenance ends with a 25-store HTTP validation after targeted recovery', () => {
  const plan = buildCoordinatorPlan(
    COORDINATOR_TASKS.SESSION,
    new Date('2026-08-07T00:30:00+08:00'),
  );
  assert.deepEqual(plan.stages.map(({ name }) => name), [
    'session-renewal',
    'session-recovery',
    'session-final-renewal',
    'session-final-recovery',
    'session-final-validation',
  ]);
  assert.equal(plan.stages[1].onlyAfterPartial, 'session-renewal');
  assert.equal(plan.stages[3].onlyAfterPartial, 'session-final-renewal');
  assert.equal(classifyStageResult('session-final-renewal', 2, {}).needsRecovery, true);
  assert.equal(classifyStageResult('session-final-recovery', 2, {}).complete, false);
  assert.equal(classifyStageResult('session-final-validation', 2, {}).complete, false);
});

test('last JSON extractor ignores pressure-gate evidence before the business summary', () => {
  assert.deepEqual(extractLastJsonDocument([
    '{"ok":true,"status":"READY"}',
    '{',
    '  "ok": false,',
    '  "results": [{"storeCode":"DL5477","status":"error"}]',
    '}',
  ].join('\n')), {
    ok: false,
    results: [{ storeCode: 'DL5477', status: 'error' }],
  });
});

test('terminal sales quality gaps do not cause endless retries', () => {
  assert.deepEqual(classifyStageResult('sales-realtime', 2, {
    results: [{ storeCode: 'DL5477', status: 'quality_blocked' }],
  }), {
    complete: true,
    terminalPartial: true,
    retryStores: [],
  });
  assert.deepEqual(classifyStageResult('sales-realtime', 2, {
    results: [{ storeCode: 'DL5477', status: 'error' }],
  }).retryStores, ['DL5477']);
});

test('one run retries only failed stores and becomes ready exactly once', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'fm-coordinator-'));
  let nowMs = Date.parse('2026-08-07T12:02:00.000Z');
  const attempts = [];
  const plan = buildCoordinatorPlan(
    COORDINATOR_TASKS.REALTIME,
    new Date('2026-08-07T20:02:00+08:00'),
  );
  const result = await runCoordinator(plan, {
    stateDir,
    budgetMs: 60_000,
    retryDelayMs: 1,
    clock: () => new Date(nowMs),
    sleep: async (delay) => { nowMs += delay; },
    runStage: async (stage, stores) => {
      attempts.push({ stage: stage.name, stores });
      if (stage.name === 'sales-realtime' && attempts.filter(({ stage: name }) => name === stage.name).length === 1) {
        return {
          exitCode: 2,
          summary: { results: [{ storeCode: 'MZ2406', status: 'error' }] },
        };
      }
      return { exitCode: 0, summary: { ok: true } };
    },
  });
  assert.equal(result.status, 'READY_TO_PUBLISH');
  assert.deepEqual(attempts.filter(({ stage }) => stage === 'sales-realtime').map(({ stores }) => stores), [
    null,
    ['MZ2406'],
  ]);
  const state = JSON.parse(await readFile(
    path.join(stateDir, 'fm-realtime-cockpit-2026-08-07T20.json'),
    'utf8',
  ));
  assert.equal(state.status, 'READY_TO_PUBLISH');
  assert.equal(state.stages['sales-realtime'].attempts, 2);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(
      stateDir,
      'fm-realtime-cockpit-2026-08-07T20.json',
    ))).mode & 0o777, 0o660);
  }
});

test('a persisted waiting run receives a fresh bounded budget when resumed', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'fm-coordinator-resume-'));
  const plan = buildCoordinatorPlan(
    COORDINATOR_TASKS.SESSION,
    new Date('2026-08-07T00:30:00+08:00'),
  );
  const stateFile = path.join(stateDir, 'fm-session-maintenance-2026-08-07.json');
  await writeFile(stateFile, JSON.stringify({
    schemaVersion: 1,
    task: plan.task,
    runId: plan.runId,
    businessDate: plan.businessDate,
    status: 'WAITING_PLATFORM',
    startedAt: '2026-08-06T16:30:00.000Z',
    updatedAt: '2026-08-06T16:55:00.000Z',
    readyAt: null,
    publishedAt: null,
    stages: {
      'session-renewal': {
        status: 'COMPLETE',
        attempts: 1,
        needsRecovery: true,
        completedAt: '2026-08-06T16:31:00.000Z',
      },
      'session-recovery': {
        status: 'WAITING',
        attempts: 4,
        pendingStores: [],
        lastExitCode: 2,
      },
    },
  }));
  const attempts = [];
  const result = await runCoordinator(plan, {
    stateDir,
    budgetMs: 60_000,
    clock: () => new Date('2026-08-07T14:00:00.000Z'),
    sleep: async () => {},
    runStage: async (stage) => {
      attempts.push(stage.name);
      return { exitCode: 0, summary: { ok: true } };
    },
  });
  assert.deepEqual(attempts, [
    'session-recovery',
    'session-final-renewal',
    'session-final-validation',
  ]);
  assert.equal(result.status, 'READY_TO_PUBLISH');
  assert.equal(result.startedAt, '2026-08-06T16:30:00.000Z');
  assert.equal(result.stages['session-recovery'].attempts, 5);
});

test('a published run resumes when a newer coordinator plan adds required stages', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'fm-coordinator-upgrade-'));
  const plan = buildCoordinatorPlan(
    COORDINATOR_TASKS.SESSION,
    new Date('2026-08-07T00:30:00+08:00'),
  );
  const stateFile = path.join(stateDir, 'fm-session-maintenance-2026-08-07.json');
  await writeFile(stateFile, JSON.stringify({
    schemaVersion: 1,
    task: plan.task,
    runId: plan.runId,
    businessDate: plan.businessDate,
    status: 'PUBLISHED',
    startedAt: '2026-08-06T16:30:00.000Z',
    updatedAt: '2026-08-06T16:40:00.000Z',
    readyAt: '2026-08-06T16:38:00.000Z',
    publishedAt: '2026-08-06T16:40:00.000Z',
    stages: {
      'session-renewal': { status: 'COMPLETE', attempts: 1, needsRecovery: true },
      'session-recovery': { status: 'COMPLETE', attempts: 2 },
    },
  }));
  const attempts = [];
  const result = await runCoordinator(plan, {
    stateDir,
    budgetMs: 60_000,
    clock: () => new Date('2026-08-07T14:00:00.000Z'),
    sleep: async () => {},
    runStage: async (stage) => {
      attempts.push(stage.name);
      return { exitCode: 0, summary: { ok: true } };
    },
  });
  assert.deepEqual(attempts, ['session-final-renewal', 'session-final-validation']);
  assert.equal(result.status, 'READY_TO_PUBLISH');
});

test('materializer marks only runs that were ready before its snapshot began', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fm-publish-'));
  const root = path.join(directory, 'coordinator');
  const stateDirectory = path.join(root, 'realtime');
  await mkdir(stateDirectory, { recursive: true });
  const earlier = path.join(stateDirectory, 'earlier.json');
  const later = path.join(stateDirectory, 'later.json');
  await Promise.all([
    writeFile(earlier, JSON.stringify({
      runId: 'fm-realtime-cockpit-2026-08-07T19',
      status: 'READY_TO_PUBLISH',
      readyAt: '2026-08-07T11:00:00.000Z',
    })),
    writeFile(later, JSON.stringify({
      runId: 'fm-realtime-cockpit-2026-08-07T20',
      status: 'READY_TO_PUBLISH',
      readyAt: '2026-08-07T12:00:01.000Z',
    })),
  ]);
  const dashboardFiles = [path.join(directory, 'dashboard.json')];
  await writeFile(dashboardFiles[0], '{"ok":true}\n');
  const result = await markReadyCoordinatorsPublished({
    root,
    dashboardFiles,
    now: new Date('2026-08-07T12:00:05.000Z'),
    readyThrough: new Date('2026-08-07T12:00:00.000Z'),
  });
  assert.deepEqual(result.marked, ['fm-realtime-cockpit-2026-08-07T19']);
  assert.equal(JSON.parse(await readFile(earlier, 'utf8')).status, 'PUBLISHED');
  assert.equal(JSON.parse(await readFile(later, 'utf8')).status, 'READY_TO_PUBLISH');
});
