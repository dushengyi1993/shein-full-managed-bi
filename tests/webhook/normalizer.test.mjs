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

