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

test('materializes the latest per-store analysis capability without exposing platform bodies', async () => {
  const client = {
    async query(sql) {
      if (sql.includes('to_regclass')) {
        return {
          rows: [{
            has_store_daily: true,
            has_product_daily: true,
            has_region_daily: true,
            has_home_fetch_audit: true,
          }],
        };
      }
      if (sql.includes('FROM fact.full_home_store_daily')) return { rows: [] };
      if (sql.includes('FROM fact.full_home_product_daily')) return { rows: [] };
      if (sql.includes('FROM fact.full_home_region_daily')) return { rows: [] };
      if (sql.includes('FROM raw.webapi_home_fetch_audit')) {
        return {
          rows: [{
            store_code: 'WY9025',
            result_status: 'FAILED',
            sanitized_error_code: 'HOME_ANALYSE_PERMISSION_DENIED',
            observed_at: '2026-08-05T01:45:43.000Z',
            response_body: 'must-not-project',
          }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const result = await readFullHomeHistory({ async connect() { return client; } });
  assert.deepEqual(result.analysisCapabilities, [{
    storeCode: 'WY9025',
    status: 'permission_denied',
    errorCode: 'HOME_ANALYSE_PERMISSION_DENIED',
    observedAt: '2026-08-05T01:45:43.000Z',
  }]);
  assert.doesNotMatch(JSON.stringify(result), /must-not-project/);
});

test('materializes signed finance facts without relabeling ledger dates as order dates', async () => {
  const client = {
    async query(sql) {
      if (sql.includes('to_regclass')) {
        return {
          rows: [{
            has_store_daily: true,
            has_product_daily: true,
            has_region_daily: true,
            has_finance_daily: true,
            has_product_finance_daily: true,
          }],
        };
      }
      if (sql.includes('FROM fact.full_home_store_daily')) return { rows: [] };
      if (sql.includes('FROM fact.full_home_product_daily')) return { rows: [] };
      if (sql.includes('FROM fact.full_home_region_daily')) return { rows: [] };
      if (sql.includes('FROM fact.full_home_finance_daily')) {
        return { rows: [{
          store_code: 'MZ2406',
          business_date: '2026-07-28',
          currency: 'SAR',
          income_amount: '80.50',
          expense_amount: '100.00',
          net_amount: '-19.50',
          goods_count: '2',
          report_count: '1',
          observed_at: '2026-07-29T08:00:00.000Z',
        }] };
      }
      if (sql.includes('FROM fact.full_home_product_finance_daily')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const result = await readFullHomeHistory({ async connect() { return client; } });

  assert.equal(result.status, 'available');
  assert.equal(result.financeDaily[0].netAmount, -19.5);
  assert.equal(result.financeDaily[0].basis, 'FINANCE_DETAIL_BUSINESS_DATE');
  assert.equal(result.coverage.earliestDate, '2026-07-28');
  assert.equal(result.coverage.storeCount, 1);
});

test('materializes ledger shipment and merchant bill as separate homepage facts', async () => {
  const client = {
    async query(sql) {
      if (sql.includes('to_regclass')) {
        return { rows: [{
          has_store_daily: true,
          has_product_daily: true,
          has_region_daily: true,
          has_finance_daily: false,
           has_product_finance_daily: false,
           has_ledger_daily: true,
           has_bill_daily: true,
           has_finance_report_observation: true,
        }] };
      }
      if (sql.includes('FROM fact.full_home_store_daily')) return { rows: [] };
      if (sql.includes('FROM fact.full_home_product_daily')) return { rows: [] };
      if (sql.includes('FROM fact.full_home_region_daily')) return { rows: [] };
      if (sql.includes('FROM fact.full_home_ledger_daily')) {
        return { rows: [{
          store_code: 'MZ2406',
          business_date: '2026-08-01',
          currency: null,
          begin_balance_count: '5247',
          inbound_count: '521',
          outbound_count: '546',
          end_balance_count: '5222',
          customer_outbound_count: '521',
          supplier_outbound_count: '25',
          begin_balance_amount: '215645.94',
          inbound_amount: '16914.60',
          outbound_amount: '17533.47',
          end_balance_amount: '212213.16',
          observed_at: '2026-08-02T02:00:00.000Z',
          quality_status: 'COMPLETE',
        }] };
      }
       if (sql.includes('FROM fact.full_home_bill_daily')) {
        return { rows: [{
          store_code: 'MZ2406',
          business_date: '2026-08-01',
          currency: 'CNY',
          sales_amount: '16631.27',
          supplement_amount: '0.00',
          deduction_amount: '207.09',
          calculated_settlement_amount: '16424.18',
          reported_settlement_amount: '16424.18',
          report_count: '2',
          settled_report_count: '2',
          pending_report_count: '0',
          reconciliation_status: 'MATCHED',
          observed_at: '2026-08-02T02:10:00.000Z',
         }] };
       }
       if (sql.includes('FROM fact.full_home_finance_report_observation AS report')) {
         return { rows: [{
           store_code: 'MZ2406',
           business_date: '2026-08-01',
           currency: 'CNY',
           pending_settlement_amount: '18950.20',
           pending_report_count: '4',
           overdue_report_count: '1',
           earliest_estimated_pay_date: '2026-08-02',
           latest_estimated_pay_date: '2026-08-10',
           observed_at: '2026-08-02T02:12:00.000Z',
         }] };
       }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const result = await readFullHomeHistory({ async connect() { return client; } });
  assert.equal(result.ledgerDaily[0].outboundCount, 546);
  assert.equal(result.ledgerDaily[0].customerOutboundCount, 521);
  assert.equal(result.billDaily[0].salesAmount, 16631.27);
  assert.equal(result.billDaily[0].deductionAmount, 207.09);
  assert.equal(result.billDaily[0].reconciliationStatus, 'MATCHED');
  assert.equal(result.billDaily[0].basis, 'ACTUAL_SETTLEMENT_DATE');
  assert.equal(result.settlementPositionDaily[0].pendingSettlementAmount, 18950.2);
  assert.equal(result.settlementPositionDaily[0].pendingReportCount, 4);
  assert.equal(result.settlementPositionDaily[0].overdueReportCount, 1);
  assert.equal(
    result.settlementPositionDaily[0].basis,
    'END_OF_PERIOD_PENDING_POSITION',
  );
});
