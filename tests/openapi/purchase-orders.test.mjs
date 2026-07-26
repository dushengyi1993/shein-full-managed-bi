import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchFullManagedPurchaseOrders } from '../../src/openapi/purchase-orders.mjs';

function order(number) {
  return {
    orderNo: `PO-${number}`,
    type: 99,
    typeName: 'Future type',
    status: 987,
    statusName: 'Future status',
    addTime: '2026-07-20 10:00:00',
    updateTime: '2026-07-26 11:00:00',
    jitChildOrderNos: [],
    orderExtends: [{
      skuCode: `SKU-${number}`,
      skc: `SKC-${number}`,
      supplierCode: `MODEL-${number}`,
      orderQuantity: 10,
      deliveryQuantity: 2,
      receiptQuantity: 1,
      storageQuantity: 1,
      defectiveQuantity: 0,
    }],
  };
}

test('purchase order update window is caller supplied and page size is capped at 200', async () => {
  const calls = [];
  const client = {
    async request(_path, { query }) {
      calls.push(query);
      const rows = query.pageNumber <= 2 ? [order(query.pageNumber)] : [];
      return {
        data: {
          code: '0',
          info: {
            count: 2,
            pageNo: query.pageNumber,
            pageSize: query.pageSize,
            list: rows,
          },
        },
      };
    },
  };
  const result = await fetchFullManagedPurchaseOrders(client, {
    updateTimeStart: '2026-07-20 00:00:00',
    updateTimeEnd: '2026-07-26 00:00:00',
    pageSize: 1,
  });
  assert.deepEqual(calls.map(({ pageNumber }) => pageNumber), [1, 2, 3]);
  assert.equal(result.orders[0].statusCode, '987');
  assert.equal(result.orders[0].linesComplete, true);
  assert.equal(result.orders[0].jitRelationsComplete, true);
  assert.deepEqual(result.orders[0].jitRelationScopes, ['AS_MOTHER']);
  assert.equal(result.incrementalStrategy.callerSuppliedOverlap, true);
  assert.equal(result.incrementalStrategy.overlapAppliedByModule, false);
});

test('purchase order windows over 60 days fail before the network', async () => {
  const client = { async request() { throw new Error('should not call'); } };
  await assert.rejects(
    () => fetchFullManagedPurchaseOrders(client, {
      combineTimeStart: '2026-01-01 00:00:00',
      combineTimeEnd: '2026-03-03 00:00:01',
    }),
    /cannot exceed 60 days/,
  );
});

test('purchase orders do not retain supervisor or platform operator identity', async () => {
  const client = {
    async request(_path, { query }) {
      const row = {
        ...order(1),
        orderSupervisor: 'Sensitive operator',
        addUid: 'sensitive-login',
      };
      return {
        data: {
          code: '0',
          info: {
            count: 1,
            pageNo: query.pageNumber,
            pageSize: query.pageSize,
            list: query.pageNumber === 1 ? [row] : [],
          },
        },
      };
    },
  };
  const result = await fetchFullManagedPurchaseOrders(client, { orderNos: ['PO-1'] });
  const serialized = JSON.stringify(result.orders);
  assert.doesNotMatch(serialized, /Sensitive operator|sensitive-login/);
});

test('purchase orders accept a zero-count empty sentinel after an exact multiple', async () => {
  const calls = [];
  const client = {
    async request(_path, { query }) {
      calls.push(query.pageNumber);
      const rows = query.pageNumber <= 2 ? [order(query.pageNumber)] : [];
      return {
        data: {
          code: '0',
          info: {
            count: query.pageNumber <= 2 ? 2 : 0,
            pageNo: query.pageNumber,
            pageSize: query.pageSize,
            list: rows,
          },
        },
      };
    },
  };

  const result = await fetchFullManagedPurchaseOrders(client, {
    updateTimeStart: '2026-07-20 00:00:00',
    updateTimeEnd: '2026-07-26 00:00:00',
    pageSize: 1,
  });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(result.orders.length, 2);
  assert.equal(result.terminalReason, 'EMPTY_PAGE');
});

test('purchase orders still reject a zero-count sentinel before prior coverage is complete', async () => {
  const client = {
    async request(_path, { query }) {
      const rows = query.pageNumber === 1 ? [order(1)] : [];
      return {
        data: {
          code: '0',
          info: {
            count: query.pageNumber === 1 ? 2 : 0,
            pageNo: query.pageNumber,
            pageSize: query.pageSize,
            list: rows,
          },
        },
      };
    },
  };

  await assert.rejects(
    () => fetchFullManagedPurchaseOrders(client, {
      updateTimeStart: '2026-07-20 00:00:00',
      updateTimeEnd: '2026-07-26 00:00:00',
      pageSize: 1,
    }),
    (error) => error.code === 'PAGINATION_COUNT_MISMATCH',
  );
});

test('purchase order rejects impossible Shanghai query and response dates', async () => {
  const never = { async request() { throw new Error('should not call'); } };
  await assert.rejects(
    () => fetchFullManagedPurchaseOrders(never, {
      updateTimeStart: '2026-02-30 00:00:00',
      updateTimeEnd: '2026-03-01 00:00:00',
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
            pageNo: query.pageNumber,
            pageSize: query.pageSize,
            list: query.pageNumber === 1
              ? [{ ...order(1), updateTime: '2026-02-30 11:00:00' }]
              : [],
          },
        },
      };
    },
  };
  await assert.rejects(
    () => fetchFullManagedPurchaseOrders(client, { orderNos: ['PO-1'] }),
    (error) => error.code === 'INVALID_DATE',
  );
});
