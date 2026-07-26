import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FULL_MANAGED_WEBHOOK_EVENTS,
  resolveFullManagedWebhookEvent,
} from '../../src/webhook/event-registry.mjs';

const EXPECTED = new Map([
  ['3000910', '/product_document_receive_status_notice'],
  ['3001449', '/product_document_audit_status_notice_all_channels'],
  ['3001450', '/product_document_audit_status_notice'],
  ['3001903', '/product_delete_audit'],
  ['3001061', '/product_quota_change_notice'],
  ['3001792', '/product_rrp_review_status_changed'],
  ['3001793', '/product_rrp_validity_changed'],
  ['3001104', '/product_compliance_change_notice'],
  ['3001435', '/purchase_order_notice'],
  ['3001441', '/delivery_modify_notice'],
  ['3001765', '/logistics_forecast_result_notice'],
  ['3001744', '/purchase_order_return_application_notice'],
  ['3001801', '/purchase_order_return_notice'],
  ['3001048', '/out_of_stock_notice'],
  ['3001503', '/authorization_change_notice'],
]);

test('registry is exactly the 15 approved full-managed events', () => {
  assert.equal(FULL_MANAGED_WEBHOOK_EVENTS.length, 15);
  assert.deepEqual(
    new Map(FULL_MANAGED_WEBHOOK_EVENTS.map((event) => [
      event.eventCode,
      event.eventPath,
    ])),
    EXPECTED,
  );
  assert.equal(FULL_MANAGED_WEBHOOK_EVENTS.some(({ eventCode }) => (
    ['3001442', '3000914', '3000848'].includes(eventCode)
  )), false);
});

test('resolves the exact numeric code or route path and quarantines everything else', () => {
  for (const [eventCode, eventPath] of EXPECTED) {
    assert.equal(resolveFullManagedWebhookEvent(eventCode).eventPath, eventPath);
    assert.equal(
      resolveFullManagedWebhookEvent(eventPath.slice(1)).eventCode,
      eventCode,
    );
  }
  const unknown = resolveFullManagedWebhookEvent('consumer_order_push_notice');
  assert.equal(unknown.family, 'unknown');
  assert.equal(unknown.known, false);
  assert.equal(resolveFullManagedWebhookEvent('<unsafe>').eventPath, '/unknown');
});

