import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFullManagedWebhookEvent } from '../../src/webhook/event-registry.mjs';
import {
  createUnknownWebhookAuditEvent,
  normalizeFullManagedWebhookEvent,
} from '../../src/webhook/normalizer.mjs';

test('normalizes purchase orders into a read-only hydration instruction', () => {
  const result = normalizeFullManagedWebhookEvent({
    event: resolveFullManagedWebhookEvent('3001435'),
    payload: {
      data: JSON.stringify({
        purchaseOrderNo: 'PO-2026-001',
        status: 'CREATED',
        updateTime: '2026-07-26 20:00:00',
      }),
    },
    storeCode: 'DL',
    deliveryScope: 'STORE',
    receivedAt: '2026-07-26T12:00:01.000Z',
  });
  assert.equal(result.normalized.businessType, 'PURCHASE_ORDER');
  assert.equal(result.normalized.businessKey, 'PO-2026-001');
  assert.equal(result.hydrationDirective.directiveType, 'PURCHASE_ORDER_READBACK');
  assert.deepEqual(result.hydrationDirective.lookup, {
    businessKey: 'PO-2026-001',
  });
  assert.equal(result.closeAuthorizationGate, false);
  assert.equal(JSON.stringify(result).includes('consumer'), false);
});

test('normalizes the production single-item purchase array contract', () => {
  const result = normalizeFullManagedWebhookEvent({
    event: resolveFullManagedWebhookEvent('3001435'),
    payload: [{
      orderNo: 'PO-PRODUCTION-1',
      noticeTypes: [1],
      orderType: 2,
      sceneType: 1,
      state: 3,
      time: 1_786_096_800_000,
      type: 4,
    }],
    storeCode: 'DL',
    deliveryScope: 'STORE',
    receivedAt: '2026-08-07T09:00:01.000Z',
  });
  assert.equal(result.normalized.businessKey, 'PO-PRODUCTION-1');
  assert.equal(result.normalized.status, '3');
  assert.equal(result.normalized.occurredAt, '2026-08-07T10:00:00.000Z');
  assert.deepEqual(result.hydrationDirective.lookup, {
    businessKey: 'PO-PRODUCTION-1',
  });
});

test('rejects multi-item webhook arrays instead of silently dropping business events', () => {
  assert.throws(() => normalizeFullManagedWebhookEvent({
    event: resolveFullManagedWebhookEvent('3001435'),
    payload: [{ orderNo: 'PO-1' }, { orderNo: 'PO-2' }],
    storeCode: 'DL',
    deliveryScope: 'STORE',
    receivedAt: '2026-08-07T09:00:01.000Z',
  }), /exactly one event/);
});

test('normalizes the production delivery JSON-string contract', () => {
  const result = normalizeFullManagedWebhookEvent({
    event: resolveFullManagedWebhookEvent('3001441'),
    payload: JSON.stringify({ delivery_code: 'DEL-PRODUCTION-1' }),
    storeCode: 'DL',
    deliveryScope: 'STORE',
    receivedAt: '2026-08-07T09:00:01.000Z',
  });
  assert.equal(result.normalized.businessKey, 'DEL-PRODUCTION-1');
  assert.deepEqual(result.hydrationDirective.lookup, {
    businessKey: 'DEL-PRODUCTION-1',
  });
});

test('authorization changes close the store gate but only request an external probe', () => {
  const result = normalizeFullManagedWebhookEvent({
    event: resolveFullManagedWebhookEvent('3001503'),
    payload: { type: 'REVOKED', openKeyId: 'must-not-persist' },
    storeCode: 'DL',
    deliveryScope: 'STORE',
    receivedAt: '2026-07-26T12:00:01.000Z',
  });
  assert.equal(result.closeAuthorizationGate, true);
  assert.equal(result.normalized.businessKey, null);
  assert.equal(result.normalized.severity, 'P0');
  assert.equal(result.hydrationDirective.directiveType, 'AUTHORIZATION_PROBE');
  assert.equal(JSON.stringify(result).includes('must-not-persist'), false);
});

test('app-level technical tests retain no business identity or side effect', () => {
  const result = normalizeFullManagedWebhookEvent({
    event: resolveFullManagedWebhookEvent('3001450'),
    payload: { skcName: 'SYNTHETIC-SKC', audit_state: '3' },
    storeCode: null,
    deliveryScope: 'APP_ONLY',
    receivedAt: '2026-07-26T12:00:01.000Z',
  });
  assert.equal(result.normalized.appScopedOnly, true);
  assert.equal(result.normalized.storeCode, null);
  assert.equal(result.normalized.businessKey, null);
  assert.deepEqual(result.normalized.identifiers, {});
  assert.equal(result.hydrationDirective, null);
  assert.equal(result.closeAuthorizationGate, false);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC-SKC'), false);
});

test('unknown events have a projection-only quarantine record', () => {
  const event = createUnknownWebhookAuditEvent({
    event: resolveFullManagedWebhookEvent('9999999'),
    storeCode: 'DL',
    deliveryScope: 'STORE',
    receivedAt: '2026-07-26T12:00:01.000Z',
  });
  assert.equal(event.eventFamily, 'unknown');
  assert.equal(event.action, 'quarantined');
  assert.deepEqual(event.identifiers, {});
});
