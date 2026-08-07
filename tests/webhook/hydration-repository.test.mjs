import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWebhookHydrationRepository,
  webhookHydrationRetryDelayMs,
} from '../../src/webhook/hydration-repository.mjs';

test('claims only supported directives with bounded leases', async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      return {
        rows: [{
          hydration_directive_id: 11,
          store_code: 'DL5477',
          directive_type: 'DELIVERY_READBACK',
          capability_code: 'DELIVERY_READBACK',
          lookup_projection: { businessKey: 'DEL-1' },
          attempt_count: 2,
        }],
      };
    },
  };
  const repository = createWebhookHydrationRepository({ pool });
  const rows = await repository.claimBatch({
    workerId: 'worker-1',
    leaseMs: 60_000,
    limit: 20,
  });
  assert.equal(rows[0].storeCode, 'DL5477');
  assert.equal(rows[0].lookup.businessKey, 'DEL-1');
  assert.match(queries[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(queries[0].values[2], [
    'PURCHASE_ORDER_READBACK',
    'DELIVERY_READBACK',
  ]);
});

test('completion and retry require the exact lease owner', async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      return { rowCount: values[0].length, rows: [] };
    },
  };
  const repository = createWebhookHydrationRepository({ pool });
  await repository.complete(['1', '2'], { workerId: 'worker-1' });
  await repository.fail(['3'], {
    workerId: 'worker-1',
    attemptCount: 2,
    errorCode: 'WEBHOOK_READBACK_NOT_READY',
    retryDelayMs: 20_000,
  });
  assert.match(queries[0].sql, /state = 'SUCCEEDED'/);
  assert.match(queries[0].sql, /lease_owner = \$2/);
  assert.match(queries[1].sql, /WHEN \$3 = 'RETRY'/);
  assert.equal(queries[1].values[2], 'RETRY');
  assert.equal(webhookHydrationRetryDelayMs(1), 10_000);
  assert.equal(webhookHydrationRetryDelayMs(20), 60 * 60_000);
});
