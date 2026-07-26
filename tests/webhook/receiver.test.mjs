import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { createFullManagedWebhookCredentialRegistry } from '../../src/webhook/credentials.mjs';
import {
  WEBHOOK_RETRY_DEDUP_WINDOW_MS,
  createFullManagedWebhookReceiver,
} from '../../src/webhook/receiver.mjs';

const FIXTURE = Object.freeze({
  appId: '100012345',
  openKeyId: 'open-dl',
  timestamp: '1720000000000',
  secret: '0123456789abcdef-extra',
  signature: 'r4Nd0OWQyM2Y0ZjYyYWY3NDE1OTQ5N2I4YmRiNmUzNDI2NTJkNGMzODlmYTdmMTk2ZDY4NWYyMTUyMTEzMTQ2ZjI4Yg==',
  ciphertext: 'TXpSQcUrdwFPjcQOIoD+gpwAvEyc+oyi/CX0XRdcB1ETG9fVEwrovGbSpnwUy5dDHZqCWTwFDz8XZjZVQCn7uXHYMDbKl1/BAt7yA4hyPFg=',
});

function registry() {
  return createFullManagedWebhookCredentialRegistry({
    cooperationMode: 'FULL_MANAGED',
    stores: [{
      storeCode: 'DL',
      enabled: true,
      appId: FIXTURE.appId,
      openKeyId: FIXTURE.openKeyId,
      secretKey: FIXTURE.secret,
    }],
  }, {
    cooperationMode: 'FULL_MANAGED',
    applications: [{
      storeCode: 'DL',
      appId: FIXTURE.appId,
      appSecretKey: FIXTURE.secret,
    }],
  });
}

function signatureFor(timestamp, randomKey = 'r4Nd0') {
  const digestHex = crypto
    .createHmac('sha256', `${FIXTURE.secret}${randomKey}`)
    .update(`${FIXTURE.appId}&${timestamp}&/api/shein/webhook/v1/events`, 'utf8')
    .digest('hex');
  return `${randomKey}${Buffer.from(digestHex, 'utf8').toString('base64')}`;
}

function headers(overrides = {}) {
  return {
    'content-type': 'application/json',
    'x-lt-appid': FIXTURE.appId,
    'x-lt-openkeyid': FIXTURE.openKeyId,
    'x-lt-eventcode': '3001450',
    'x-lt-timestamp': FIXTURE.timestamp,
    'x-lt-signature': FIXTURE.signature,
    ...overrides,
  };
}

test('ingress returns success only after storing receipt and job with no decrypted body', async () => {
  let persisted;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const repository = {
    async storeReceiptAndJob(input) {
      persisted = input;
      await blocked;
      return { receiptId: '1', duplicate: false };
    },
  };
  const receiver = createFullManagedWebhookReceiver({
    repository,
    credentialRegistry: registry(),
    now: () => Number(FIXTURE.timestamp),
  });
  let settled = false;
  const operation = receiver.ingest({
    headers: headers(),
    rawBody: JSON.stringify({ eventData: FIXTURE.ciphertext }),
  }).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  const result = await operation;
  assert.equal(result.ok, true);
  assert.equal(result.quarantined, false);
  assert.equal(persisted.storeCode, 'DL');
  assert.equal(persisted.statementTimeoutMs <= 800, true);
  assert.equal(persisted.ciphertext, FIXTURE.ciphertext);
  const serialized = JSON.stringify(persisted);
  for (const forbidden of [
    FIXTURE.appId,
    FIXTURE.openKeyId,
    FIXTURE.secret,
    'SKC-001',
    'audit_state',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('technical tests remain appScopedOnly without a guessed store', async () => {
  let persisted;
  const receiver = createFullManagedWebhookReceiver({
    repository: {
      async storeReceiptAndJob(input) {
        persisted = input;
        return { receiptId: '2', duplicate: false };
      },
    },
    credentialRegistry: registry(),
    now: () => Number(FIXTURE.timestamp),
  });
  const result = await receiver.ingest({
    headers: headers({ 'x-lt-openkeyid': 'platform-synthetic-open-key' }),
    rawBody: JSON.stringify({ eventData: FIXTURE.ciphertext }),
  });
  assert.equal(result.appScopedOnly, true);
  assert.equal(persisted.storeCode, null);
  assert.equal(persisted.deliveryScope, 'APP_ONLY');
});

test('unknown events are accepted into quarantine instead of business routing', async () => {
  let persisted;
  const receiver = createFullManagedWebhookReceiver({
    repository: {
      async storeReceiptAndJob(input) {
        persisted = input;
        return { receiptId: '3', duplicate: false };
      },
    },
    credentialRegistry: registry(),
    now: () => Number(FIXTURE.timestamp),
  });
  const result = await receiver.ingest({
    headers: headers({ 'x-lt-eventcode': 'consumer_order_push_notice' }),
    rawBody: JSON.stringify({ eventData: FIXTURE.ciphertext }),
  });
  assert.equal(result.quarantined, true);
  assert.equal(persisted.safeProjection.knownEvent, false);
  assert.equal(persisted.safeProjection.eventFamily, 'unknown');
});

test('all event families deduplicate identical ciphertext only within a bounded delivery window', async () => {
  const persisted = [];
  const receiptByKey = new Map();
  let currentNow = Number(FIXTURE.timestamp);
  const receiver = createFullManagedWebhookReceiver({
    repository: {
      async storeReceiptAndJob(input) {
        persisted.push(input);
        const existing = receiptByKey.get(input.idempotencyKey);
        if (existing) return { receiptId: existing, duplicate: true };
        const receiptId = String(receiptByKey.size + 1);
        receiptByKey.set(input.idempotencyKey, receiptId);
        return { receiptId, duplicate: false };
      },
    },
    credentialRegistry: registry(),
    now: () => currentNow,
  });
  const windowStart = Math.floor(
    Number(FIXTURE.timestamp) / WEBHOOK_RETRY_DEDUP_WINDOW_MS,
  ) * WEBHOOK_RETRY_DEDUP_WINDOW_MS;
  const firstTimestamp = windowStart + 60_000;
  const retryTimestamp = windowStart + 120_000;
  const laterOccurrenceTimestamp = windowStart + WEBHOOK_RETRY_DEDUP_WINDOW_MS + 60_000;
  const deliver = async (timestamp) => {
    currentNow = timestamp;
    return receiver.ingest({
      headers: headers({
        'x-lt-timestamp': String(timestamp),
        'x-lt-signature': signatureFor(String(timestamp)),
      }),
      rawBody: JSON.stringify({ eventData: FIXTURE.ciphertext }),
    });
  };

  assert.equal((await deliver(firstTimestamp)).duplicate, false);
  assert.equal((await deliver(retryTimestamp)).duplicate, true);
  assert.equal((await deliver(laterOccurrenceTimestamp)).duplicate, false);

  // 3001450 is a normal product event, proving the window is no longer
  // authorization-change-only.
  assert.equal(persisted.every(({ eventCode }) => eventCode === '3001450'), true);
  assert.equal(persisted[0].idempotencyKey, persisted[1].idempotencyKey);
  assert.notEqual(persisted[0].idempotencyKey, persisted[2].idempotencyKey);
  assert.equal(receiptByKey.size, 2);
});

test('duplicated security headers and a stale timestamp fail before persistence', async () => {
  let calls = 0;
  const receiver = createFullManagedWebhookReceiver({
    repository: {
      async storeReceiptAndJob() {
        calls += 1;
      },
    },
    credentialRegistry: registry(),
    now: () => Number(FIXTURE.timestamp) + 300_001,
  });
  await assert.rejects(
    () => receiver.ingest({
      headers: headers({ 'x-lt-signature': `${FIXTURE.signature}, duplicate` }),
      rawBody: JSON.stringify({ eventData: FIXTURE.ciphertext }),
    }),
    /duplicated/,
  );
  await assert.rejects(
    () => receiver.ingest({
      headers: headers(),
      rawBody: JSON.stringify({ eventData: FIXTURE.ciphertext }),
    }),
    (error) => error.code === 'WEBHOOK_SIGNATURE_REJECTED',
  );
  assert.equal(calls, 0);
});
