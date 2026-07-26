import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEBHOOK_CALLBACK_PATH,
  computeWebhookIdempotencyKey,
  decryptFullManagedWebhookEvent,
  verifyFullManagedWebhookSignature,
} from '../../src/webhook/crypto.mjs';

const VECTOR = Object.freeze({
  appId: '100012345',
  timestamp: '1720000000000',
  secret: '0123456789abcdef-extra',
  signature: 'r4Nd0OWQyM2Y0ZjYyYWY3NDE1OTQ5N2I4YmRiNmUzNDI2NTJkNGMzODlmYTdmMTk2ZDY4NWYyMTUyMTEzMTQ2ZjI4Yg==',
  ciphertext: 'TXpSQcUrdwFPjcQOIoD+gpwAvEyc+oyi/CX0XRdcB1ETG9fVEwrovGbSpnwUy5dDHZqCWTwFDz8XZjZVQCn7uXHYMDbKl1/BAt7yA4hyPFg=',
});

test('matches the fixed SHEIN HMAC contract vector', () => {
  const result = verifyFullManagedWebhookSignature({
    appId: VECTOR.appId,
    timestamp: VECTOR.timestamp,
    signature: VECTOR.signature,
    appSecretKey: VECTOR.secret,
    callbackPath: WEBHOOK_CALLBACK_PATH,
    nowMs: Number(VECTOR.timestamp),
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'verified');
});

test('rejects a changed signature and timestamps outside the five-minute window', () => {
  assert.equal(verifyFullManagedWebhookSignature({
    appId: VECTOR.appId,
    timestamp: VECTOR.timestamp,
    signature: `${VECTOR.signature.slice(0, -1)}A`,
    appSecretKey: VECTOR.secret,
    nowMs: Number(VECTOR.timestamp),
  }).reason, 'signature_mismatch');
  assert.equal(verifyFullManagedWebhookSignature({
    appId: VECTOR.appId,
    timestamp: VECTOR.timestamp,
    signature: VECTOR.signature,
    appSecretKey: VECTOR.secret,
    nowMs: Number(VECTOR.timestamp) + 300_001,
  }).reason, 'timestamp_outside_allowed_skew');
});

test('idempotency requires a bounded occurrence and changes across delivery windows', () => {
  const evidence = {
    appKeyHash: 'a'.repeat(64),
    openKeyHash: 'b'.repeat(64),
    eventCode: '3001450',
    eventPath: '/product_document_audit_status_notice',
    cipherSha256: 'c'.repeat(64),
  };
  assert.throws(
    () => computeWebhookIdempotencyKey(evidence),
    /delivery occurrence window is required/,
  );
  assert.notEqual(
    computeWebhookIdempotencyKey({ ...evidence, deliveryOccurrence: '100' }),
    computeWebhookIdempotencyKey({ ...evidence, deliveryOccurrence: '101' }),
  );
});

test('matches the fixed AES-128-CBC/PKCS5 contract vector', () => {
  assert.deepEqual(
    decryptFullManagedWebhookEvent(VECTOR.ciphertext, VECTOR.secret),
    {
      skcName: 'SKC-001',
      audit_state: '3',
      sendTimeStamp: '1720000000000',
    },
  );
});

test('decryption failures never echo ciphertext or credentials', () => {
  assert.throws(
    () => decryptFullManagedWebhookEvent('QUFBQQ==', VECTOR.secret),
    (error) => {
      assert.equal(String(error.message).includes('QUFBQQ=='), false);
      assert.equal(String(error.message).includes(VECTOR.secret), false);
      return error.code === 'WEBHOOK_DECRYPT_FAILED';
    },
  );
});
