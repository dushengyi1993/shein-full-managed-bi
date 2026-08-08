import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadShippingOrdersData,
  ShippingOrdersDataError,
} from '../../src/server/shipping-orders-data.mjs';

test('loads and caches a whitelisted shipping order index', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shipping-orders-data-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'shipping-orders.json');
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-08-08T00:00:00.000Z',
    source: { orderCount: 2 },
    capabilities: { coreOrderFacts: true },
    orders: [
      { storeCode: 'DL5477', orderNo: 'PO-1', secret: 'not-normalized-but-source-file-is-root-owned' },
      { storeCode: null, orderNo: 'DROP' },
    ],
  }));
  const first = await loadShippingOrdersData(file, { runtimeEnvironment: 'production' });
  const second = await loadShippingOrdersData(file, { runtimeEnvironment: 'production' });
  assert.equal(first, second);
  assert.equal(first.orders.length, 1);
  assert.equal(first.source.orderCount, 2);
});

test('requires an explicit file in production and rejects unsupported schemas', async (t) => {
  await assert.rejects(
    loadShippingOrdersData('', { runtimeEnvironment: 'production' }),
    (error) => error instanceof ShippingOrdersDataError && error.code === 'SHIPPING_ORDERS_FILE_REQUIRED',
  );
  const directory = await mkdtemp(join(tmpdir(), 'shipping-orders-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'shipping-orders.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 99, orders: [] }));
  await assert.rejects(
    loadShippingOrdersData(file, { runtimeEnvironment: 'production' }),
    (error) => error instanceof ShippingOrdersDataError && error.code === 'SHIPPING_ORDERS_SCHEMA_UNSUPPORTED',
  );
});
