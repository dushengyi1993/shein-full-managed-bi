import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchFullManagedDeliveries } from '../../src/openapi/deliveries.mjs';

function delivery(code) {
  return {
    deliveryCode: code,
    deliveryType: 42,
    deliveryTypeName: 'Future delivery type',
    addTime: '2026-07-20 12:00:00',
    sendPackage: 1,
    packageWeight: 2.5,
    consolidationInfo: {
      address: 'must not persist',
      person: 'must not persist',
      phone: 'must not persist',
      carrierName: 'Carrier',
      warehouseId: 123,
      warehouseName: 'Consolidation warehouse',
    },
    deliveryOrderDataList: [{
      orderNo: 'PO-1',
      skc: 'SKC-1',
      skuCode: 'SKU-1',
      deliveryQuantity: 5,
    }],
  };
}

test('delivery uses creation-time paging and declares rolling lookback semantics', async () => {
  const calls = [];
  const client = {
    async request(_path, { query }) {
      calls.push(query);
      return {
        data: {
          code: '0',
          info: {
            count: 1,
            list: query.page === 1 ? [delivery('DEL-1')] : [],
          },
        },
      };
    },
  };
  const result = await fetchFullManagedDeliveries(client, {
    startTime: '2026-07-01 00:00:00',
    endTime: '2026-07-26 23:59:59',
    pageSize: 1,
  });
  assert.deepEqual(calls.map(({ page }) => page), [1, 2]);
  assert.equal(result.incrementalStrategy.mode, 'ROLLING_CREATION_TIME_LOOKBACK_REQUIRED');
  assert.equal(result.incrementalStrategy.supportsUpdateTimeFilter, false);
  assert.equal(result.deliveries[0].deliveryTypeCode, '42');
  assert.equal(result.deliveries[0].linesComplete, true);
});

test('delivery mapper excludes consolidation contact, phone and address', async () => {
  const client = {
    async request(_path, { query }) {
      return {
        data: {
          code: '0',
          info: {
            count: 1,
            list: query.page === 1 ? [delivery('DEL-1')] : [],
          },
        },
      };
    },
  };
  const result = await fetchFullManagedDeliveries(client, { deliveryCode: 'DEL-1' });
  const serialized = JSON.stringify(result.deliveries);
  assert.doesNotMatch(serialized, /must not persist/);
  assert.match(serialized, /Carrier/);
});

test('delivery refuses an unbounded list query and page sizes above 200', async () => {
  const client = { async request() { throw new Error('should not call'); } };
  await assert.rejects(() => fetchFullManagedDeliveries(client), /requires deliveryCode/);
  await assert.rejects(
    () => fetchFullManagedDeliveries(client, { deliveryCode: 'D', pageSize: 201 }),
    /from 1 to 200/,
  );
});

test('delivery rejects impossible Shanghai query and response dates', async () => {
  const never = { async request() { throw new Error('should not call'); } };
  await assert.rejects(
    () => fetchFullManagedDeliveries(never, {
      startTime: '2026-02-30 00:00:00',
      endTime: '2026-03-01 00:00:00',
    }),
    /not a valid Asia\/Shanghai calendar date-time/,
  );

  const client = {
    async request(_path, { query }) {
      return {
        data: {
          code: '0',
          info: {
            count: 1,
            list: query.page === 1
              ? [{ ...delivery('DEL-1'), addTime: '2026-02-30 12:00:00' }]
              : [],
          },
        },
      };
    },
  };
  await assert.rejects(
    () => fetchFullManagedDeliveries(client, { deliveryCode: 'DEL-1' }),
    (error) => error.code === 'INVALID_DATE',
  );
});
