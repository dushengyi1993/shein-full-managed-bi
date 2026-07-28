import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBackfillPlan } from '../../src/backfill/plan.mjs';
import {
  createBackfillExecuteRuntime,
  main,
} from '../../scripts/run_full_managed_backfill.mjs';

const BASE_ARGS = Object.freeze([
  '--stores=DL5477',
  '--domains=purchase-orders',
  '--from=2026-07-01',
  '--to=2026-07-01',
  '--created-by=codex.batch5a',
  '--today=2026-07-28',
]);

function plan() {
  return buildBackfillPlan({
    storeCodes: ['DL5477'],
    domains: ['purchase-orders'],
    from: '2026-07-01',
    to: '2026-07-01',
    createdBy: 'codex.batch5a',
    today: '2026-07-28',
  });
}

test('dry-run never creates an execute runtime', async () => {
  let runtimeCalls = 0;
  const output = [];
  const exit = await main(BASE_ARGS, {
    createRuntime: async () => {
      runtimeCalls += 1;
      throw new Error('must not run');
    },
    writeOut: (line) => output.push(line),
    writeError: (line) => output.push(line),
  });
  assert.equal(exit, 0);
  assert.equal(runtimeCalls, 0);
  const report = JSON.parse(output.join(''));
  assert.equal(report.mode, 'DRY_RUN');
  assert.equal(report.adapterInvocationCount, 0);
});

test('wrong execute hash fails before runtime construction', async () => {
  let runtimeCalls = 0;
  const errors = [];
  const exit = await main([
    ...BASE_ARGS,
    '--execute',
    `--approved-plan-hash=${'b'.repeat(64)}`,
    '--allow-stores=DL5477',
    '--allow-domains=purchase-orders',
  ], {
    createRuntime: async () => { runtimeCalls += 1; },
    writeOut() {},
    writeError: (line) => errors.push(line),
  });
  assert.equal(exit, 2);
  assert.equal(runtimeCalls, 0);
  assert.match(errors.join(''), /PLAN_HASH_MISMATCH/);
});

test('authorized execute passes exact scope and always closes runtime', async () => {
  const built = plan();
  const events = [];
  const output = [];
  const exit = await main([
    ...BASE_ARGS,
    '--execute',
    `--approved-plan-hash=${built.planHash}`,
    '--allow-stores=DL5477',
    '--allow-domains=purchase-orders',
  ], {
    createRuntime: async ({ plan: runtimePlan }) => {
      events.push(`runtime:${runtimePlan.planHash}`);
      return {
        adapters: { 'openapi.purchase-orders.v1': {} },
        repository: { marker: 'repository' },
        async close() { events.push('close'); },
      };
    },
    runPlan: async (input) => {
      events.push(`run:${input.plan.planHash}`);
      assert.equal(input.approvedPlanHash, built.planHash);
      assert.deepEqual(input.allowedStoreCodes, ['DL5477']);
      assert.deepEqual(input.allowedDomains, ['purchase-orders']);
      assert.equal(input.repository.marker, 'repository');
      return {
        mode: 'EXECUTE',
        planHash: built.planHash,
        runStatus: 'SUCCEEDED',
        adapterInvocationCount: 1,
        counts: {
          planned: 0, blocked: 0, skipped: 0, succeeded: 1, partial: 0, failed: 0,
        },
        checkpointAdvancedCount: 1,
        blockedReasonCodes: [],
        windows: [{
          ...built.windows[0],
          executionStatus: 'SUCCEEDED',
          qualityStatus: 'PASSED',
          sanitizedErrorCode: null,
          attemptCount: 1,
          checkpointAdvanced: true,
        }],
      };
    },
    writeOut: (line) => output.push(line),
    writeError: (line) => output.push(line),
  });
  assert.equal(exit, 0);
  assert.deepEqual(events, [
    `runtime:${built.planHash}`,
    `run:${built.planHash}`,
    'close',
  ]);
  assert.equal(JSON.parse(output.join('')).runStatus, 'SUCCEEDED');
});

test('runtime loads only the purchase adapter and closes its control-plane pool', async () => {
  const events = [];
  class FakePool {
    constructor(options) {
      events.push(`pool:${options.connectionString}`);
    }
    async connect() { throw new Error('not used by wiring'); }
    async end() { events.push('pool:end'); }
  }
  const runtime = await createBackfillExecuteRuntime({
    plan: plan(),
    env: {
      FULL_BI_DATABASE_URL: 'postgresql://supply.invalid/db',
      FULL_BI_OPENAPI_CONFIG_FILE: '/private/openapi.json',
      DATABASE_URL: 'postgresql://must-not-be-used/db',
    },
    loadPg: async () => ({ Pool: FakePool }),
    loadCheckpointRepository: async () => ({
      createBackfillRepository: ({ pool }) => ({ pool }),
    }),
    loadOpenApiConfigModule: async () => ({
      async loadFullManagedConfig(path) {
        events.push(`config:${path}`);
        return { stores: [] };
      },
    }),
    loadSupplySyncModule: async () => ({ runSupplySync() {} }),
    loadPurchaseOrderAdapterModule: async () => ({
      PURCHASE_ORDER_BACKFILL_ADAPTER_KEY: 'openapi.purchase-orders.v1',
      createPurchaseOrderBackfillAdapter: () => ({ fetchWindow() {} }),
    }),
  });
  assert.deepEqual(runtime.adapterKeys, ['openapi.purchase-orders.v1']);
  assert.match(events[0], /^pool:postgresql:\/\/supply\.invalid/);
  assert.equal(events.some((item) => item.includes('must-not-be-used')), false);
  await runtime.close();
  assert.equal(events.at(-1), 'pool:end');
});
