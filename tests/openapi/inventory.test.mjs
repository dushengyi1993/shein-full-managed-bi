import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchFullManagedInventory } from '../../src/openapi/inventory.mjs';

function stockResponse({ warehouseInventoryList, totalInventoryQuantity = 10 } = {}) {
  return {
    code: '0',
    info: [{
      goodsInventory: [{
        spuName: 'SPU-1',
        skcName: 'SKC-1',
        skuList: [{
          skuCode: 'SKU-1',
          totalInventoryQuantity,
          totalLockedQuantity: 1,
          totalTempLockQuantity: 0,
          totalUsableInventory: 9,
          totalOutOfStockQty: 2,
          totalTransitQuantity: 3,
          warehouseInventoryList,
        }],
      }],
    }],
  };
}

test('stock-query requires exactly one identifier dimension and at most 100 values', async () => {
  const client = { async request() { throw new Error('should not call'); } };
  await assert.rejects(
    () => fetchFullManagedInventory(client, {
      skuCodeList: ['SKU'],
      skcNameList: ['SKC'],
      invType: 'PI',
    }),
    /exactly one/,
  );
  await assert.rejects(
    () => fetchFullManagedInventory(client, {
      skuCodeList: Array.from({ length: 101 }, (_, index) => `SKU-${index}`),
      invType: 'PI',
    }),
    /more than 100/,
  );
});

test('stock-query reconciles aggregate totals with warehouse details', async () => {
  const calls = [];
  const client = {
    async request(path, options) {
      calls.push({ path, options });
      return {
        data: stockResponse({
          warehouseInventoryList: [{
            warehouseCode: 'WH-1',
            warehouseType: '1',
            inventoryQuantity: 10,
            lockedQuantity: 1,
            tempLockQuantity: 0,
            usableInventory: 9,
            outOfStockQty: '2',
            transitQuantity: 3,
          }],
        }),
      };
    },
  };
  const result = await fetchFullManagedInventory(client, {
    skuCodeList: ['SKU-1'],
    invType: 'PI',
    fetchedAt: '2026-07-26T12:00:00Z',
  });
  assert.equal(result.items[0].reconciliation.status, 'RECONCILED');
  assert.equal(result.shortages[0].shortageQuantity, 2);
  assert.equal(result.coverage.status, 'COMPLETE');
  assert.deepEqual(calls[0].options.body, {
    skuCodeList: ['SKU-1'],
    warehouseType: '1',
    invType: 'PI',
  });
});

test('stock-query sends the official transition warehouse selector with invType', async () => {
  const calls = [];
  const client = {
    async request(_path, options) {
      calls.push(options.body);
      return {
        data: stockResponse({
          warehouseInventoryList: [],
        }),
      };
    },
  };

  await fetchFullManagedInventory(client, {
    skuCodeList: ['SKU-1'],
    invType: 'JI',
  });
  assert.deepEqual(calls[0], {
    skuCodeList: ['SKU-1'],
    warehouseType: '3',
    invType: 'JI',
  });

  await assert.rejects(
    () => fetchFullManagedInventory(client, {
      skuCodeList: ['SKU-1'],
      invType: 'PI',
      warehouseType: 3,
    }),
    /warehouseType must be 1 when invType is PI/,
  );
});

test('missing identifiers remain partial and are never materialized as zero', async () => {
  const client = {
    async request() {
      return {
        data: stockResponse({
          warehouseInventoryList: [],
        }),
      };
    },
  };
  const result = await fetchFullManagedInventory(client, {
    skuCodeList: ['SKU-1', 'SKU-MISSING'],
    warehouseType: 3,
  });
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.coverage.missingCodes, ['SKU-MISSING']);
  assert.equal(result.items[0].reconciliation.status, 'TOTAL_ONLY');
});

test('aggregate/detail mismatches are explicit quality results', async () => {
  const client = {
    async request() {
      return {
        data: stockResponse({
          totalInventoryQuantity: 11,
          warehouseInventoryList: [{
            warehouseCode: 'WH-1',
            warehouseType: '1',
            inventoryQuantity: 10,
            lockedQuantity: 1,
            tempLockQuantity: 0,
            usableInventory: 9,
            outOfStockQty: 2,
            transitQuantity: 3,
          }],
        }),
      };
    },
  };
  const result = await fetchFullManagedInventory(client, {
    skuCodeList: ['SKU-1'],
    invType: 'PI',
  });
  assert.equal(result.items[0].reconciliation.status, 'MISMATCH');
  assert.match(result.items[0].reconciliation.explanation, /differs/);
});

test('exact SKU stock-query rejects unrequested response SKUs before persistence', async () => {
  const client = {
    async request() {
      const response = stockResponse({ warehouseInventoryList: [] });
      response.info[0].goodsInventory[0].skuList.push({
        ...response.info[0].goodsInventory[0].skuList[0],
        skuCode: 'SKU-UNEXPECTED',
      });
      return { data: response };
    },
  };
  await assert.rejects(
    () => fetchFullManagedInventory(client, {
      skuCodeList: ['SKU-1'],
      invType: 'PI',
    }),
    (error) => (
      error.code === 'UNEXPECTED_RESPONSE_IDENTIFIER'
      && error.details.unexpectedCodes.includes('SKU-UNEXPECTED')
    ),
  );
});
