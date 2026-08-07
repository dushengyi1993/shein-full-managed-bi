import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isHydrationEntrypoint,
  runWebhookHydration,
} from '../../scripts/run_full_managed_webhook_hydration.mjs';

test('groups exact webhook lookups by store and closes directives after readback', async () => {
  const completed = [];
  const failed = [];
  const syncCalls = [];
  let claimCount = 0;
  const pool = { async end() {} };
  const summary = await runWebhookHydration({
    env: {
      FULL_BI_DATABASE_URL: 'postgres://fake.invalid/database',
      FULL_BI_OPENAPI_CONFIG_FILE: '/secret/config.json',
    },
    poolFactory: () => pool,
    configLoader: async () => ({ stores: [] }),
    repositoryFactory: () => ({
      async claimBatch() {
        claimCount += 1;
        if (claimCount > 1) return [];
        return [{
          directiveId: '1',
          storeCode: 'DL5477',
          directiveType: 'PURCHASE_ORDER_READBACK',
          lookup: { businessKey: 'PO-1', businessKeys: ['PO-1', 'PO-2'] },
          attemptCount: 1,
        }, {
          directiveId: '2',
          storeCode: 'DL5477',
          directiveType: 'DELIVERY_READBACK',
          lookup: { businessKey: 'DEL-1' },
          attemptCount: 1,
        }];
      },
      async complete(ids) { completed.push(ids); },
      async fail(ids, options) { failed.push({ ids, options }); },
    }),
    async sync(input) {
      syncCalls.push(input);
      return {
        ok: true,
        results: [{
          storeCode: 'DL5477',
          domains: [
            { domain: 'purchase-orders', recordCount: 2 },
            { domain: 'deliveries', recordCount: 1 },
          ],
        }],
      };
    },
  });
  assert.deepEqual(completed, [['1', '2']]);
  assert.deepEqual(failed, []);
  assert.equal(syncCalls[0].stores, 'DL5477');
  assert.equal(syncCalls[0].purchaseOrderNos, 'PO-1,PO-2');
  assert.equal(syncCalls[0].deliveryCodes, 'DEL-1');
  assert.deepEqual(summary, {
    ok: true,
    claimed: 2,
    succeeded: 2,
    retrying: 0,
    groups: 1,
  });
});

test('keeps a directive retryable until the exact OpenAPI row is visible', async () => {
  const failures = [];
  let claimCount = 0;
  const summary = await runWebhookHydration({
    env: {
      FULL_BI_DATABASE_URL: 'postgres://fake.invalid/database',
      FULL_BI_OPENAPI_CONFIG_FILE: '/secret/config.json',
    },
    poolFactory: () => ({ async end() {} }),
    configLoader: async () => ({ stores: [] }),
    repositoryFactory: () => ({
      async claimBatch() {
        claimCount += 1;
        return claimCount === 1 ? [{
          directiveId: '3',
          storeCode: 'MZ2406',
          directiveType: 'DELIVERY_READBACK',
          lookup: { businessKey: 'DEL-LATE' },
          attemptCount: 1,
        }] : [];
      },
      async complete() { assert.fail('missing exact readback must not complete'); },
      async fail(ids, options) { failures.push({ ids, options }); },
    }),
    async sync() {
      return {
        ok: true,
        results: [{
          storeCode: 'MZ2406',
          domains: [{ domain: 'deliveries', recordCount: 0 }],
        }],
      };
    },
  });
  assert.equal(summary.retrying, 1);
  assert.deepEqual(failures[0].ids, ['3']);
  assert.equal(failures[0].options.errorCode, 'WEBHOOK_READBACK_NOT_READY');
});

test('hydration CLI recognizes its real entrypoint and refuses unrelated paths', () => {
  assert.equal(isHydrationEntrypoint(new URL(
    '../../scripts/run_full_managed_webhook_hydration.mjs',
    import.meta.url,
  )), true);
  assert.equal(isHydrationEntrypoint(new URL(import.meta.url)), false);
});
