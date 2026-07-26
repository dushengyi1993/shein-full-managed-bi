import assert from 'node:assert/strict';
import test from 'node:test';

import { createFullManagedWebhookCredentialRegistry } from '../../src/webhook/credentials.mjs';
import { sha256Hex } from '../../src/webhook/crypto.mjs';
import {
  createFullManagedWebhookWorker,
  webhookRetryDelayMs,
} from '../../src/webhook/worker.mjs';

const SECRET = '0123456789abcdef-extra';
const CIPHERTEXT = 'TXpSQcUrdwFPjcQOIoD+gpwAvEyc+oyi/CX0XRdcB1ETG9fVEwrovGbSpnwUy5dDHZqCWTwFDz8XZjZVQCn7uXHYMDbKl1/BAt7yA4hyPFg=';

function registry() {
  return createFullManagedWebhookCredentialRegistry({
    cooperationMode: 'FULL_MANAGED',
    stores: [{
      storeCode: 'DL',
      enabled: true,
      appId: '100012345',
      openKeyId: 'open-dl',
      secretKey: SECRET,
    }],
  }, {
    cooperationMode: 'FULL_MANAGED',
    applications: [{
      storeCode: 'DL',
      appId: '100012345',
      appSecretKey: SECRET,
    }],
  });
}

function job(overrides = {}) {
  return {
    jobId: '11',
    receiptId: '7',
    status: 'RUNNING',
    attemptCount: 1,
    maxAttempts: 8,
    appKeyHash: sha256Hex('100012345'),
    openKeyHash: sha256Hex('open-dl'),
    eventCode: '3001450',
    eventPath: '/product_document_audit_status_notice',
    storeCode: 'DL',
    deliveryScope: 'STORE',
    platformTimestamp: '2024-07-03T09:46:40.000Z',
    cipherSha256: sha256Hex(CIPHERTEXT),
    ciphertext: CIPHERTEXT,
    receivedAt: '2026-07-26T12:00:00.000Z',
    ...overrides,
  };
}

test('worker alone decrypts and emits normalized event plus a read-only directive', async () => {
  let completed;
  const repository = {
    async claimNextJob() {
      return job();
    },
    async completeJob(input) {
      completed = input;
      return {
        status: 'SUCCEEDED',
        hydrationQueued: Boolean(input.hydrationDirective),
      };
    },
    async failJob() {
      assert.fail('valid event must not be released');
    },
  };
  const worker = createFullManagedWebhookWorker({
    repository,
    credentialRegistry: registry(),
    workerId: 'test-worker',
  });
  const result = await worker.processOne();
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(completed.normalized.eventFamily, 'product_audit');
  assert.equal(completed.normalized.businessKey, 'SKC-001');
  assert.equal(completed.hydrationDirective.directiveType, 'PRODUCT_READBACK');
  assert.equal(completed.closeAuthorizationGate, false);
  assert.equal(Object.hasOwn(completed, 'payload'), false);
});

test('authorization event closes the gate and only emits a probe directive', async () => {
  let completed;
  const worker = createFullManagedWebhookWorker({
    repository: {
      async claimNextJob() {
        return job({
          eventCode: '3001503',
          eventPath: '/authorization_change_notice',
        });
      },
      async completeJob(input) {
        completed = input;
        return { status: 'SUCCEEDED' };
      },
      async failJob() {
        assert.fail('authorization event must be processable');
      },
    },
    credentialRegistry: registry(),
    workerId: 'test-worker',
  });
  await worker.processOne();
  assert.equal(completed.closeAuthorizationGate, true);
  assert.equal(completed.hydrationDirective.directiveType, 'AUTHORIZATION_PROBE');
  assert.equal(completed.normalized.businessKey, null);
});

test('unknown events are quarantined without decryption or credential resolution', async () => {
  let completed;
  const worker = createFullManagedWebhookWorker({
    repository: {
      async claimNextJob() {
        return job({
          eventCode: '9999999',
          eventPath: '/unknown_event',
          ciphertext: 'not-base64-and-not-decryptable',
          cipherSha256: '0'.repeat(64),
        });
      },
      async completeJob(input) {
        completed = input;
        return { status: 'QUARANTINED' };
      },
      async failJob() {
        assert.fail('unknown events must be quarantined');
      },
    },
    credentialRegistry: {
      resolveStored() {
        assert.fail('unknown events must not resolve credentials');
      },
    },
    workerId: 'test-worker',
  });
  const result = await worker.processOne();
  assert.equal(result.status, 'QUARANTINED');
  assert.equal(completed.quarantined, true);
  assert.equal(completed.normalized.eventFamily, 'unknown');
});

test('worker failures use bounded exponential backoff and sanitized errors', async () => {
  let failure;
  const worker = createFullManagedWebhookWorker({
    repository: {
      async claimNextJob() {
        return job({ cipherSha256: '0'.repeat(64), attemptCount: 3 });
      },
      async completeJob() {
        assert.fail('corrupt ciphertext must not complete');
      },
      async failJob(input) {
        failure = input;
        return { status: 'RETRY', attemptCount: 3 };
      },
    },
    credentialRegistry: registry(),
    workerId: 'test-worker',
    logger: { error() {} },
  });
  const result = await worker.processOne();
  assert.equal(result.errorCode, 'WEBHOOK_CIPHERTEXT_CORRUPT');
  assert.equal(failure.retryDelayMs, 20_000);
  assert.equal(failure.errorMessage.includes(CIPHERTEXT), false);
  assert.equal(webhookRetryDelayMs(20), 60 * 60_000);
});
