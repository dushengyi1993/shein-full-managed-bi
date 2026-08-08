import assert from 'node:assert/strict';
import test from 'node:test';

import {
  materializeShippingOrdersFromDatabase,
  SHIPPING_ORDERS_SQL,
} from '../../src/warehouse/shipping-orders-materializer.mjs';

test('materializes orders, current lines and delivery references from one snapshot', async () => {
  const commands = [];
  const client = {
    async query(sql) {
      commands.push(sql);
      if (String(sql).includes("to_regclass('dim.reporting_goods')")) {
        return { rows: [{ has_reporting_goods: false, has_reporting_goods_assignment: false }] };
      }
      if (sql === SHIPPING_ORDERS_SQL.orders) {
        return { rows: [{
          purchase_order_id: 10, store_id: 7, store_code: 'DL5477', store_name: '地利',
          order_no: 'PO-1', order_type_code: '2', order_type_name: '备货',
          status_code: '1', status_name: '已下单', warehouse_code: 'W1', warehouse_name: '华南仓',
          platform_created_at: '2026-08-08T00:00:00.000Z', source_fetched_at: '2026-08-08T01:00:00.000Z',
        }] };
      }
      if (sql === SHIPPING_ORDERS_SQL.lines) {
        return { rows: [{
          purchase_order_id: 10, store_id: 7, source_line_key: 'L1', sku_code: 'SKU-1', skc_name: 'SKC-1',
          supplier_code: 'MODEL-A', order_quantity: 5, delivery_quantity: 2, receipt_quantity: 1,
          storage_quantity: 1, defective_quantity: 0, source_fetched_at: '2026-08-08T01:01:00.000Z',
        }] };
      }
      if (sql === SHIPPING_ORDERS_SQL.deliveries) {
        return { rows: [{
          store_id: 7, order_no: 'PO-1', delivery_code: 'DN-1', delivery_type_name: '送货',
          express_code: 'SF-1', express_company_name: '顺丰', sku_code: 'SKU-1', skc_name: 'SKC-1',
          delivery_quantity: 2, source_fetched_at: '2026-08-08T01:02:00.000Z',
        }] };
      }
      return { rows: [] };
    },
    release() { commands.push('RELEASE'); },
  };
  const pool = { async connect() { return client; } };
  const result = await materializeShippingOrdersFromDatabase(pool, {
    now: new Date('2026-08-08T02:00:00.000Z'),
  });

  assert.equal(result.source.orderCount, 1);
  assert.equal(result.source.lineCount, 1);
  assert.equal(result.orders[0].totals.orderQuantity, 5);
  assert.equal(result.orders[0].deliveries[0].deliveryCode, 'DN-1');
  assert.equal(result.source.latestSourceFetchedAt, '2026-08-08T01:02:00.000Z');
  assert.equal(result.capabilities.portalExtensions, false);
  assert.ok(commands.includes('COMMIT'));
  assert.equal(commands.at(-1), 'RELEASE');
});
