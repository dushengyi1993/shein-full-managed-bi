import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFullManagedWebhookRepository,
} from '../../src/warehouse/webhook-repository.mjs';

function result(rows = []) {
  return { rows, rowCount: rows.length };
}

class FakeClient {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
    this.released = false;
  }

  async query(sql, values = []) {
    this.calls.push({ sql, values });
    return this.handler?.(sql, values, this) ?? result();
  }

  release() {
    this.released = true;
  }
}

class FakePool {
  constructor(handler) {
    this.handler = handler;
    this.directCalls = [];
    this.clients = [];
  }

  async connect() {
    const client = new FakeClient(this.handler);
    this.clients.push(client);
    return client;
  }

  async query(sql, values = []) {
    this.directCalls.push({ sql, values });
    return this.handler?.(sql, values, null) ?? result();
  }
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const CIPHERTEXT = 'QUJDRA==';

function receiptInput(overrides = {}) {
  return {
    idempotencyKey: HASH_A,
    appKeyHash: HASH_B,
    openKeyHash: HASH_C,
    eventCode: '3001450',
    eventPath: '/product_document_audit_status_notice',
    storeCode: 'DL',
    deliveryScope: 'STORE',
    platformTimestamp: '2026-07-26T12:00:00.000Z',
    cipherSha256: HASH_D,
    ciphertext: CIPHERTEXT,
    safeProjection: {
      schemaVersion: 1,
      knownEvent: true,
      eventFamily: 'product_audit',
      deliveryScope: 'STORE',
      appScopedOnly: false,
    },
    statementTimeoutMs: 800,
    ...overrides,
  };
}

function existingReceipt(overrides = {}) {
  return {
    receipt_id: 7,
    app_key_hash: HASH_B,
    open_key_hash: HASH_C,
    event_code: '3001450',
    event_path: '/product_document_audit_status_notice',
    store_id: 9,
    delivery_scope: 'STORE',
    cipher_sha256: HASH_D,
    ...overrides,
  };
}

test('stores the immutable receipt and job inside one transaction before success', async () => {
  const pool = new FakePool((sql) => {
    if (sql.includes('FROM dim.store')) return result([{ store_id: 9 }]);
    if (sql.includes('INSERT INTO raw.webhook_receipt')) return result([{ receipt_id: 7 }]);
    if (sql.includes('INSERT INTO ops.webhook_job')) return result([{ job_id: 11 }]);
    return result();
  });
  const repository = createFullManagedWebhookRepository({ pool });
  const stored = await repository.storeReceiptAndJob(receiptInput());
  assert.deepEqual(stored, { receiptId: '7', duplicate: false });
  const calls = pool.clients[0].calls;
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[1].sql, /set_config\('statement_timeout'/);
  assert.equal(calls[1].values[0], '800ms');
  const storeLookup = calls.find(({ sql }) => sql.includes('FROM dim.store'));
  assert.doesNotMatch(storeLookup.sql, /\bFOR (?:UPDATE|SHARE)\b/);
  const receiptInsert = calls.find(({ sql }) => sql.includes('INSERT INTO raw.webhook_receipt'));
  assert.match(receiptInsert.sql, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
  assert.match(receiptInsert.sql, /RETURNING receipt_id/);
  assert.equal(
    calls.some(({ sql }) => sql.includes('FROM raw.webhook_receipt') && sql.includes('FOR UPDATE')),
    false,
  );
  assert.equal(
    calls.findIndex(({ sql }) => sql.includes('INSERT INTO raw.webhook_receipt'))
      < calls.findIndex(({ sql }) => sql.includes('INSERT INTO ops.webhook_job')),
    true,
  );
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.equal(pool.clients[0].released, true);
});

test('an idempotent duplicate only increments its receipt counter', async () => {
  const pool = new FakePool((sql) => {
    if (sql.includes('FROM dim.store')) return result([{ store_id: 9 }]);
    if (sql.includes('INSERT INTO raw.webhook_receipt')) return result();
    if (sql.includes('FROM raw.webhook_receipt') && sql.includes('FOR UPDATE')) {
      return result([existingReceipt()]);
    }
    if (sql.includes('UPDATE raw.webhook_receipt')) return { rows: [], rowCount: 1 };
    return result();
  });
  const repository = createFullManagedWebhookRepository({ pool });
  assert.deepEqual(
    await repository.storeReceiptAndJob(receiptInput({
      // A retry is signed again and may have a later delivery timestamp.
      platformTimestamp: '2026-07-26T12:00:20.000Z',
    })),
    { receiptId: '7', duplicate: true },
  );
  const calls = pool.clients[0].calls;
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO ops.webhook_job')), false);
  assert.equal(calls.some(({ sql }) => sql.includes('duplicate_count + 1')), true);
  assert.equal(
    calls.findIndex(({ sql }) => sql.includes('INSERT INTO raw.webhook_receipt'))
      < calls.findIndex(({ sql }) => sql.includes('FROM raw.webhook_receipt') && sql.includes('FOR UPDATE')),
    true,
  );
});

test('a conflicting delivery with the same idempotency key fails closed without a job or duplicate count', async () => {
  const pool = new FakePool((sql) => {
    if (sql.includes('FROM dim.store')) return result([{ store_id: 9 }]);
    if (sql.includes('INSERT INTO raw.webhook_receipt')) return result();
    if (sql.includes('FROM raw.webhook_receipt') && sql.includes('FOR UPDATE')) {
      return result([existingReceipt({ event_path: '/different_event' })]);
    }
    return result();
  });
  const repository = createFullManagedWebhookRepository({ pool });

  await assert.rejects(
    () => repository.storeReceiptAndJob(receiptInput()),
    (error) => error?.code === 'WEBHOOK_IDEMPOTENCY_COLLISION',
  );

  const calls = pool.clients[0].calls;
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO ops.webhook_job')), false);
  assert.equal(calls.some(({ sql }) => sql.includes('duplicate_count + 1')), false);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('two competing first deliveries use one receipt/job and one locked duplicate readback', async () => {
  let receiptExists = false;
  let jobInsertCount = 0;
  let duplicateUpdateCount = 0;
  const pool = new FakePool((sql) => {
    if (sql.includes('FROM dim.store')) return result([{ store_id: 9 }]);
    if (sql.includes('INSERT INTO raw.webhook_receipt')) {
      if (!receiptExists) {
        receiptExists = true;
        return result([{ receipt_id: 7 }]);
      }
      return result();
    }
    if (sql.includes('FROM raw.webhook_receipt') && sql.includes('FOR UPDATE')) {
      return result([existingReceipt()]);
    }
    if (sql.includes('INSERT INTO ops.webhook_job')) {
      jobInsertCount += 1;
      return result([{ job_id: 11 }]);
    }
    if (sql.includes('UPDATE raw.webhook_receipt')) {
      duplicateUpdateCount += 1;
      return { rows: [], rowCount: 1 };
    }
    return result();
  });
  const repository = createFullManagedWebhookRepository({ pool });

  const deliveries = await Promise.all([
    repository.storeReceiptAndJob(receiptInput()),
    repository.storeReceiptAndJob(receiptInput()),
  ]);

  assert.deepEqual(
    deliveries.sort((left, right) => Number(left.duplicate) - Number(right.duplicate)),
    [
      { receiptId: '7', duplicate: false },
      { receiptId: '7', duplicate: true },
    ],
  );
  assert.equal(jobInsertCount, 1);
  assert.equal(duplicateUpdateCount, 1);
  const loserCalls = pool.clients.find((client) => (
    client.calls.some(({ sql }) => sql.includes('FROM raw.webhook_receipt') && sql.includes('FOR UPDATE'))
  )).calls;
  assert.equal(
    loserCalls.findIndex(({ sql }) => sql.includes('INSERT INTO raw.webhook_receipt'))
      < loserCalls.findIndex(({ sql }) => sql.includes('FROM raw.webhook_receipt') && sql.includes('FOR UPDATE')),
    true,
  );
});

test('distinct bounded-occurrence keys persist separate receipts and jobs for identical ciphertext', async () => {
  let nextReceiptId = 7;
  let nextJobId = 11;
  const receiptIds = new Map();
  const pool = new FakePool((sql, values) => {
    if (sql.includes('FROM dim.store')) return result([{ store_id: 9 }]);
    if (sql.includes('INSERT INTO raw.webhook_receipt')) {
      const idempotencyKey = values[0];
      if (receiptIds.has(idempotencyKey)) return result();
      const receiptId = nextReceiptId++;
      receiptIds.set(idempotencyKey, receiptId);
      return result([{ receipt_id: receiptId }]);
    }
    if (sql.includes('INSERT INTO ops.webhook_job')) {
      return result([{ job_id: nextJobId++ }]);
    }
    return result();
  });
  const repository = createFullManagedWebhookRepository({ pool });

  assert.deepEqual(await repository.storeReceiptAndJob(receiptInput({
    idempotencyKey: HASH_A,
    platformTimestamp: '2026-07-26T12:00:00.000Z',
  })), { receiptId: '7', duplicate: false });
  assert.deepEqual(await repository.storeReceiptAndJob(receiptInput({
    idempotencyKey: HASH_E,
    platformTimestamp: '2026-07-26T12:10:00.000Z',
  })), { receiptId: '8', duplicate: false });

  assert.equal(receiptIds.size, 2);
  assert.equal(
    pool.clients.flatMap(({ calls }) => calls)
      .filter(({ sql }) => sql.includes('INSERT INTO ops.webhook_job')).length,
    2,
  );
});

test('claims work with FOR UPDATE SKIP LOCKED and a bounded eight-attempt lease', async () => {
  const pool = new FakePool((sql) => {
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      return result([{
        job_id: 11,
        receipt_id: 7,
        idempotency_key: HASH_A,
        status: 'RUNNING',
        attempt_count: 2,
        max_attempts: 8,
        lease_owner: 'worker-a',
        lease_expires_at: '2026-07-26T12:02:00.000Z',
        app_key_hash: HASH_B,
        open_key_hash: HASH_C,
        event_code: '3001450',
        event_path: '/product_document_audit_status_notice',
        delivery_scope: 'STORE',
        platform_timestamp: '2026-07-26T12:00:00.000Z',
        cipher_sha256: HASH_D,
        ciphertext: CIPHERTEXT,
        safe_projection: { knownEvent: true },
        received_at: '2026-07-26T12:00:01.000Z',
        store_code: 'DL',
      }]);
    }
    return result();
  });
  const repository = createFullManagedWebhookRepository({ pool });
  const job = await repository.claimNextJob({
    workerId: 'worker-a',
    leaseMs: 120_000,
  });
  assert.equal(job.jobId, '11');
  assert.equal(job.attemptCount, 2);
  const sql = pool.clients[0].calls.find(({ sql }) => sql.includes('SKIP LOCKED')).sql;
  assert.match(sql, /attempt_count < max_attempts/);
  assert.match(sql, /status = 'DEAD_LETTER'/);
  assert.equal(pool.clients[0].calls.at(-1).sql, 'COMMIT');
});

test('completes normalized event, directive, authorization gate and job atomically', async () => {
  const pool = new FakePool((sql) => {
    if (sql.includes('SELECT job.job_id')) {
      return result([{ job_id: 11, receipt_id: 7, store_id: 9 }]);
    }
    if (sql.includes('INSERT INTO ops.operational_event')) {
      return result([{ operational_event_id: 15 }]);
    }
    if (sql.includes('INSERT INTO ops.webhook_hydration_directive')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO ops.webhook_store_gate')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE ops.webhook_job')) return result([{ job_id: 11 }]);
    return result();
  });
  const repository = createFullManagedWebhookRepository({ pool });
  const completed = await repository.completeJob({
    jobId: 11,
    workerId: 'worker-a',
    normalized: {
      eventCode: '3001503',
      eventPath: '/authorization_change_notice',
      eventFamily: 'authorization_change',
      businessType: 'STORE',
      businessKey: null,
      occurredAt: null,
      action: 'authorization_change',
      status: 'REVOKED',
      severity: 'P0',
      deliveryScope: 'STORE',
      appScopedOnly: false,
      identifiers: {},
      metrics: {},
    },
    hydrationDirective: {
      directiveType: 'AUTHORIZATION_PROBE',
      capabilityCode: 'AUTHORIZATION_PROBE',
      lookup: {},
    },
    closeAuthorizationGate: true,
  });
  assert.deepEqual(completed, {
    operationalEventId: '15',
    status: 'SUCCEEDED',
    gateClosed: true,
    hydrationQueued: true,
  });
  const calls = pool.clients[0].calls;
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls.some(({ sql }) => sql.includes('AUTHORIZATION_CHANGE_EVENT')), true);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('read models expose only normalized events, subscription fingerprints and queue health', async () => {
  const pool = new FakePool((sql) => {
    if (sql.includes('FROM ops.operational_event AS event')) {
      return result([{
        operational_event_id: 15,
        event_code: '3001435',
        event_path: '/purchase_order_notice',
        event_family: 'purchase_order',
        business_type: 'PURCHASE_ORDER',
        business_key: 'PO-1',
        occurred_at: '2026-07-26T12:00:00.000Z',
        action: 'purchase_order',
        platform_status: 'CREATED',
        severity: 'P2',
        delivery_scope: 'STORE',
        safe_projection: { businessKey: 'PO-1' },
        created_at: '2026-07-26T12:00:01.000Z',
        store_code: 'DL',
      }]);
    }
    if (sql.includes('FROM ops.webhook_subscription_state')) {
      return result([{
        app_fingerprint: 'abcdef123456',
        event_code: '3001435',
        desired_state: 'ACTIVE',
        observed_state: 'ACTIVE',
        callback_validated: true,
        checked_at: '2026-07-26T12:00:00.000Z',
        updated_at: '2026-07-26T12:00:00.000Z',
      }]);
    }
    if (sql.includes("status = 'QUEUED'")) {
      return result([{
        queued: '2',
        running: '1',
        retry: '3',
        dead_letter: '0',
        expired_leases: '0',
        oldest_ready_at: '2026-07-26T12:00:00.000Z',
        last_received_at: '2026-07-26T12:01:00.000Z',
        last_processed_at: '2026-07-26T12:00:30.000Z',
        hydration_pending: '4',
        blocked_stores: '1',
      }]);
    }
    return result();
  });
  const repository = createFullManagedWebhookRepository({ pool });
  const events = await repository.listOperationalEvents({
    allowedStores: ['DL'],
  });
  assert.equal(events[0].businessKey, 'PO-1');
  assert.equal(Object.hasOwn(events[0], 'ciphertext'), false);
  const subscriptions = await repository.listSubscriptionState();
  assert.equal(subscriptions[0].appFingerprint, 'abcdef123456');
  assert.equal(Object.hasOwn(subscriptions[0], 'appKeyHash'), false);
  const health = await repository.getQueueHealth();
  assert.deepEqual(health, {
    queued: 2,
    running: 1,
    retry: 3,
    deadLetter: 0,
    expiredLeases: 0,
    oldestReadyAt: '2026-07-26T12:00:00.000Z',
    lastReceivedAt: '2026-07-26T12:01:00.000Z',
    lastProcessedAt: '2026-07-26T12:00:30.000Z',
    hydrationPending: 4,
    blockedStores: 1,
  });
});

test('records append-only webhook runtime heartbeats with deterministic evidence', async () => {
  const pool = new FakePool((sql) => {
    if (sql.includes('INSERT INTO ops.webhook_runtime_heartbeat')) {
      return result([{ webhook_runtime_heartbeat_id: 41 }]);
    }
    return result();
  });
  const repository = createFullManagedWebhookRepository({ pool });
  const heartbeat = await repository.recordRuntimeHeartbeat({
    componentCode: 'receiver',
    instanceId: 'host-a:123',
    statusCode: 'running',
    observedAt: '2026-07-26T12:00:00.000Z',
    ttlMs: 90_000,
  });

  assert.deepEqual(heartbeat, {
    heartbeatId: '41',
    componentCode: 'RECEIVER',
    statusCode: 'RUNNING',
    observedAt: '2026-07-26T12:00:00.000Z',
    expiresAt: '2026-07-26T12:01:30.000Z',
    created: true,
  });
  const calls = pool.clients[0].calls;
  assert.equal(calls[0].sql, 'BEGIN');
  const insert = calls.find(({ sql }) => sql.includes('INSERT INTO ops.webhook_runtime_heartbeat'));
  assert.match(insert.values[5], /^[0-9a-f]{64}$/);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('an exact heartbeat replay uses SELECT-only readback for append-only evidence', async () => {
  const pool = new FakePool((sql) => {
    if (sql.includes('INSERT INTO ops.webhook_runtime_heartbeat')) return result();
    if (sql.includes('FROM ops.webhook_runtime_heartbeat')) {
      return result([{
        webhook_runtime_heartbeat_id: 41,
        component_code: 'RECEIVER',
        instance_id: 'host-a:123',
        status_code: 'RUNNING',
        observed_at: '2026-07-26T12:00:00.000Z',
        expires_at: '2026-07-26T12:01:30.000Z',
      }]);
    }
    return result();
  });
  const repository = createFullManagedWebhookRepository({ pool });

  assert.deepEqual(await repository.recordRuntimeHeartbeat({
    componentCode: 'receiver',
    instanceId: 'host-a:123',
    statusCode: 'running',
    observedAt: '2026-07-26T12:00:00.000Z',
    ttlMs: 90_000,
  }), {
    heartbeatId: '41',
    componentCode: 'RECEIVER',
    statusCode: 'RUNNING',
    observedAt: '2026-07-26T12:00:00.000Z',
    expiresAt: '2026-07-26T12:01:30.000Z',
    created: false,
  });

  const readback = pool.clients[0].calls.find(
    ({ sql }) => sql.includes('FROM ops.webhook_runtime_heartbeat'),
  );
  assert.doesNotMatch(readback.sql, /\bFOR (?:UPDATE|SHARE)\b/);
  assert.equal(pool.clients[0].calls.at(-1).sql, 'COMMIT');
});

test('runtime health requires fresh receiver and worker heartbeats', async () => {
  const pool = new FakePool((sql) => {
    if (sql.includes('WITH components(component_code)')) {
      return result([
        {
          component_code: 'RECEIVER',
          instance_id: 'host-a:123',
          status_code: 'RUNNING',
          observed_at: '2026-07-26T12:00:20.000Z',
          expires_at: '2026-07-26T12:01:50.000Z',
          evaluated_at: '2026-07-26T12:01:00.000Z',
        },
        {
          component_code: 'WORKER',
          instance_id: 'host-a:124',
          status_code: 'RUNNING',
          observed_at: '2026-07-26T11:58:00.000Z',
          expires_at: '2026-07-26T11:59:30.000Z',
          evaluated_at: '2026-07-26T12:01:00.000Z',
        },
      ]);
    }
    return result();
  });
  const repository = createFullManagedWebhookRepository({ pool });

  assert.deepEqual(await repository.getRuntimeHealth(), {
    ok: false,
    evaluatedAt: '2026-07-26T12:01:00.000Z',
    receiver: {
      status: 'RUNNING',
      lastSeenAt: '2026-07-26T12:00:20.000Z',
      expiresAt: '2026-07-26T12:01:50.000Z',
      fresh: true,
    },
    worker: {
      status: 'RUNNING',
      lastSeenAt: '2026-07-26T11:58:00.000Z',
      expiresAt: '2026-07-26T11:59:30.000Z',
      fresh: false,
    },
  });
});
