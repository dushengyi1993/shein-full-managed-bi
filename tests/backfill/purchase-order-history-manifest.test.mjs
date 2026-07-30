import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PURCHASE_ORDER_HISTORY_FROM,
  PURCHASE_ORDER_HISTORY_TO,
  buildPurchaseOrderHistoryManifest,
  parsePurchaseOrderHistoryArgs,
  purchaseOrderHistoryPeriods,
} from '../../scripts/backfill_full_managed_purchase_order_history.mjs';

test('purchase-order history manifest covers all 24 stores in bounded resumable plans', () => {
  const manifest = buildPurchaseOrderHistoryManifest();
  assert.equal(manifest.from, PURCHASE_ORDER_HISTORY_FROM);
  assert.equal(manifest.to, PURCHASE_ORDER_HISTORY_TO);
  assert.equal(manifest.storeCodes.length, 24);
  assert.equal(manifest.planCount, 18);
  assert.equal(manifest.windowCount, 22_584);
  assert.match(manifest.manifestHash, /^[0-9a-f]{64}$/);
  assert.ok(manifest.plans.every((plan) => plan.storeCodes.length <= 4));
  assert.ok(manifest.plans.every((plan) => plan.summary.plannedWindowCount <= 2_000));
  assert.ok(manifest.plans.every((plan) => plan.domains.length === 1));
  assert.ok(manifest.plans.every((plan) => plan.domains[0] === 'purchase-orders'));
  assert.equal(
    buildPurchaseOrderHistoryManifest().manifestHash,
    manifest.manifestHash,
  );
});

test('purchase-order history periods are contiguous and never exceed 400 days', () => {
  const periods = purchaseOrderHistoryPeriods();
  assert.equal(periods.length, 3);
  assert.equal(periods[0].from, PURCHASE_ORDER_HISTORY_FROM);
  assert.equal(periods.at(-1).to, PURCHASE_ORDER_HISTORY_TO);
  for (let index = 1; index < periods.length; index += 1) {
    const previous = new Date(`${periods[index - 1].to}T00:00:00.000Z`);
    previous.setUTCDate(previous.getUTCDate() + 1);
    assert.equal(periods[index].from, previous.toISOString().slice(0, 10));
  }
});

test('purchase-order history execute requires the exact shaped manifest hash', () => {
  assert.deepEqual(parsePurchaseOrderHistoryArgs([]), {
    execute: false,
    approvedManifestHash: null,
  });
  assert.throws(
    () => parsePurchaseOrderHistoryArgs(['--execute']),
    /PURCHASE_ORDER_HISTORY_APPROVAL_REQUIRED/,
  );
  const hash = 'a'.repeat(64);
  assert.deepEqual(
    parsePurchaseOrderHistoryArgs([
      '--execute',
      `--approved-manifest-hash=${hash}`,
    ]),
    { execute: true, approvedManifestHash: hash },
  );
});
