import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REPLAYABLE_EVENT_CODES,
  requeueWebhookDeadLetters,
} from '../../scripts/requeue_full_managed_webhook_dead_letters.mjs';

test('dead-letter replay is dry-run by default and targets only repaired event contracts', async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      return { rows: [{ candidate_count: 268 }], rowCount: 1 };
    },
    async end() {},
  };
  const summary = await requeueWebhookDeadLetters({
    databaseUrl: 'postgres://fake.invalid/database',
    poolFactory: () => pool,
  });
  assert.deepEqual(summary, {
    ok: true,
    execute: false,
    candidateCount: 268,
    requeuedCount: 0,
  });
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].values[0], REPLAYABLE_EVENT_CODES);
  assert.match(queries[0].sql, /event\.operational_event_id IS NULL/);
});

test('execute resets only selected dead letters into a clean retry state', async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (queries.length === 1) return { rows: [{ candidate_count: 2 }], rowCount: 1 };
      return { rows: [{ job_id: 1 }, { job_id: 2 }], rowCount: 2 };
    },
    async end() {},
  };
  const summary = await requeueWebhookDeadLetters({
    databaseUrl: 'postgres://fake.invalid/database',
    execute: true,
    poolFactory: () => pool,
  });
  assert.equal(summary.requeuedCount, 2);
  assert.match(queries[1].sql, /status = 'RETRY'/);
  assert.match(queries[1].sql, /attempt_count = 0/);
  assert.match(queries[1].sql, /FOR UPDATE OF job/);
});
