import assert from 'node:assert/strict';
import test from 'node:test';

import { readFullHomeHistory } from '../../src/warehouse/dashboard-materializer.mjs';

test('materializes nullable homepage history without inventing zero values', async () => {
  const client = {
    async query(sql) {
      if (sql.includes('to_regclass')) {
        return {
          rows: [{
            has_store_daily: true,
            has_product_daily: true,
            has_region_daily: true,
          }],
        };
      }
      if (sql.includes('FROM fact.full_home_store_daily')) {
        return {
          rows: [{
            store_code: 'DL5477',
            business_date: '2026-07-29',
            currency: 'SAR',
            deal_amount: '120.50',
            net_deal_amount: null,
            sales_quantity: '4',
            buyer_count: null,
            goods_detail_visitors: null,
            exposure_users: '50',
            exposure_basis: 'BRAND_SUMMED',
            stocking_order_count: null,
            urgent_purchase_order_count: null,
            payment_order_count: null,
            new_customer_sales_quantity: null,
            new_customer_payment_order_count: null,
            source_updated_at: null,
            observed_at: '2026-07-29T08:00:00.000Z',
            quality_status: 'PARTIAL',
            source_codes: ['WEBAPI_INDEX', 'WEBAPI_ANALYSE'],
          }],
        };
      }
      if (sql.includes('FROM fact.full_home_product_daily')) return { rows: [] };
      if (sql.includes('FROM fact.full_home_region_daily')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const result = await readFullHomeHistory({ async connect() { return client; } });

  assert.equal(result.status, 'available');
  assert.equal(result.storeDaily[0].dealAmount, 120.5);
  assert.equal(result.storeDaily[0].netDealAmount, null);
  assert.equal(result.storeDaily[0].buyerCount, null);
  assert.equal(result.storeDaily[0].salesQuantity, 4);
  assert.equal(result.coverage.storeCount, 1);
  assert.equal(result.coverage.latestObservedAt, '2026-07-29T08:00:00.000Z');
});

test('older databases expose an unavailable contract before migration 0014', async () => {
  const client = {
    async query() {
      return {
        rows: [{
          has_store_daily: false,
          has_product_daily: false,
          has_region_daily: false,
        }],
      };
    },
    release() {},
  };
  const result = await readFullHomeHistory({ async connect() { return client; } });

  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.storeDaily, []);
  assert.equal(result.coverage.latestDate, null);
});
