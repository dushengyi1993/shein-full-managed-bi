import {
  HOME_HISTORY_CONTRACT_VERSION,
  sha256Json,
} from './home-contracts.mjs';
import { normalizeFullManagedStoreCode } from '../config/full-managed-stores.mjs';

const CAPABILITY_ROLE = 'sheinfm_webapi_loader';

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function instant(value, location) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError(`${location} is invalid`);
  return date.toISOString();
}

function nullableInstant(value, location) {
  return value === null || value === undefined || value === ''
    ? null
    : instant(value, location);
}

function nullableNumber(value, location, { integer = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isSafeInteger(number))) {
    throw new TypeError(`${location} is invalid`);
  }
  return number;
}

function date(value, location) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new TypeError(`${location} is invalid`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new TypeError(`${location} is invalid`);
  }
  return text;
}

function text(value, location, maximum, { nullable = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (nullable) return null;
    throw new TypeError(`${location} is required`);
  }
  const normalized = String(value).normalize('NFKC').trim();
  if (!normalized || normalized.length > maximum) throw new TypeError(`${location} is invalid`);
  return normalized;
}

function storeCode(value) {
  const normalized = text(value, 'storeCode', 24).toUpperCase();
  const canonical = normalizeFullManagedStoreCode(normalized);
  if (!canonical) throw new TypeError('storeCode is outside the configured roster');
  return canonical;
}

function sourceCodes(value) {
  const allowed = new Set([
    'WEBAPI_INDEX',
    'WEBAPI_REALTIME',
    'WEBAPI_TRADE',
    'WEBAPI_ANALYSE',
  ]);
  const values = Array.isArray(value) ? value : [value];
  const normalized = [...new Set(values.map((item) => String(item ?? '').trim()).filter(Boolean))];
  if (normalized.length < 1 || normalized.length > 8 || normalized.some((item) => !allowed.has(item))) {
    throw new TypeError('sourceCodes are invalid');
  }
  return normalized;
}

function storeDailyValues(input) {
  const row = record(input);
  const exposure = nullableNumber(row.exposureUsers, 'exposureUsers', { integer: true });
  const exposureBasis = exposure === null
    ? 'UNAVAILABLE'
    : ['STORE_DEDUP', 'BRAND_SUMMED'].includes(row.exposureBasis)
      ? row.exposureBasis
      : 'STORE_DEDUP';
  const values = [
    storeCode(row.storeCode),
    date(row.businessDate, 'businessDate'),
    row.currency === null || row.currency === undefined
      ? null
      : text(row.currency, 'currency', 3).toUpperCase(),
    nullableNumber(row.dealAmount, 'dealAmount'),
    nullableNumber(row.netDealAmount, 'netDealAmount'),
    nullableNumber(row.salesQuantity, 'salesQuantity', { integer: true }),
    nullableNumber(row.buyerCount, 'buyerCount', { integer: true }),
    nullableNumber(row.goodsDetailVisitors, 'goodsDetailVisitors', { integer: true }),
    exposure,
    exposureBasis,
    nullableNumber(row.stockingOrderCount, 'stockingOrderCount', { integer: true }),
    nullableNumber(row.urgentPurchaseOrderCount, 'urgentPurchaseOrderCount', { integer: true }),
    nullableNumber(row.paymentOrderCount, 'paymentOrderCount', { integer: true }),
    nullableNumber(row.newCustomerSalesQuantity, 'newCustomerSalesQuantity', { integer: true }),
    nullableNumber(
      row.newCustomerPaymentOrderCount,
      'newCustomerPaymentOrderCount',
      { integer: true },
    ),
    nullableInstant(row.sourceUpdatedAt, 'sourceUpdatedAt'),
    instant(row.observedAt ?? new Date(), 'observedAt'),
    HOME_HISTORY_CONTRACT_VERSION,
    sourceCodes(row.sourceCodes ?? row.sourceCode),
  ];
  const core = [values[3], values[4], values[5], values[6], values[7], values[10], values[11]];
  const quality = core.every((value) => value !== null)
    ? core.some((value) => value !== 0) ? 'COMPLETE' : 'LEGAL_ZERO'
    : 'PARTIAL';
  values.push(quality);
  return values;
}

function regionValues(input) {
  const row = record(input);
  return [
    storeCode(row.storeCode),
    date(row.businessDate, 'businessDate'),
    text(row.regionKey, 'regionKey', 80),
    text(row.regionName, 'regionName', 160),
    nullableNumber(row.salesQuantity, 'salesQuantity', { integer: true }),
    nullableNumber(row.salesShare, 'salesShare'),
    nullableNumber(row.newCustomerSalesQuantity, 'newCustomerSalesQuantity', { integer: true }),
    nullableNumber(row.newCustomerSalesShare, 'newCustomerSalesShare'),
    nullableInstant(row.sourceUpdatedAt, 'sourceUpdatedAt'),
    instant(row.observedAt ?? new Date(), 'observedAt'),
  ];
}

function productValues(input) {
  const row = record(input);
  const grain = text(row.productGrain, 'productGrain', 8).toUpperCase();
  if (!['SPU', 'SKC'].includes(grain)) throw new TypeError('productGrain is invalid');
  return [
    storeCode(row.storeCode),
    date(row.businessDate, 'businessDate'),
    grain,
    text(row.productKey, 'productKey', 160),
    text(row.platformSpuId, 'platformSpuId', 160, { nullable: true }),
    text(row.platformSkcId, 'platformSkcId', 160, { nullable: true }),
    text(row.supplierCode, 'supplierCode', 160, { nullable: true }),
    text(row.supplierSku, 'supplierSku', 160, { nullable: true }),
    text(row.displayName, 'displayName', 240, { nullable: true }),
    nullableNumber(row.salesQuantity, 'salesQuantity', { integer: true }),
    nullableInstant(row.sourceUpdatedAt, 'sourceUpdatedAt'),
    instant(row.observedAt ?? new Date(), 'observedAt'),
  ];
}

const LEDGER_COUNT_FIELDS = Object.freeze([
  'beginBalanceCount',
  'inboundCount',
  'outboundCount',
  'endBalanceCount',
  'urgentOrderEntryCount',
  'prepareOrderEntryCount',
  'inboundGainCount',
  'inboundReturnCount',
  'supplyChangeInCount',
  'adjustmentInCount',
  'customerOutboundCount',
  'directCustomerOutboundCount',
  'platformCustomerOutboundCount',
  'outboundLossCount',
  'supplierOutboundCount',
  'inventoryClearCount',
  'reportClearCount',
  'scrapCount',
  'supplyChangeOutCount',
  'adjustmentOutCount',
  'customerLossCount',
]);

const LEDGER_AMOUNT_FIELDS = Object.freeze([
  'beginBalanceAmount',
  'inboundAmount',
  'outboundAmount',
  'endBalanceAmount',
  'urgentOrderEntryAmount',
  'prepareOrderEntryAmount',
  'inboundGainAmount',
  'inboundReturnAmount',
  'supplyChangeInAmount',
  'adjustmentInAmount',
  'customerOutboundAmount',
  'directCustomerOutboundAmount',
  'platformCustomerOutboundAmount',
  'outboundLossAmount',
  'supplierOutboundAmount',
  'inventoryClearAmount',
  'reportClearAmount',
  'scrapAmount',
  'supplyChangeOutAmount',
  'adjustmentOutAmount',
  'customerLossAmount',
]);

function ledgerRow(input) {
  const row = record(input);
  const output = {
    store_code: storeCode(row.storeCode),
    business_date: date(row.businessDate, 'businessDate'),
    currency: row.currency === null || row.currency === undefined
      ? null
      : text(row.currency, 'currency', 3).toUpperCase(),
    observed_at: instant(row.observedAt ?? new Date(), 'observedAt'),
    source_contract_version: HOME_HISTORY_CONTRACT_VERSION,
  };
  for (const field of LEDGER_COUNT_FIELDS) {
    output[field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = nullableNumber(
      row[field],
      field,
      { integer: true },
    );
  }
  for (const field of LEDGER_AMOUNT_FIELDS) {
    output[field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = nullableNumber(
      row[field],
      field,
    );
  }
  const core = [
    output.begin_balance_count,
    output.inbound_count,
    output.outbound_count,
    output.end_balance_count,
    output.customer_outbound_count,
  ];
  output.quality_status = core.every((value) => value !== null)
    ? core.some((value) => value !== 0) ? 'COMPLETE' : 'LEGAL_ZERO'
    : 'PARTIAL';
  return output;
}

async function inCapabilityTransaction(pool, work) {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    await client.query(`SET LOCAL ROLE ${CAPABILITY_ROLE}`);
    const result = await work(client);
    await client.query('COMMIT');
    open = false;
    return result;
  } catch (error) {
    if (open) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createFullHomeHistoryRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('pool with connect() is required');
  }

  async function upsertStoreDaily(rows) {
    const values = rows.map(storeDailyValues);
    if (values.length === 0) return { upserted: 0 };
    return inCapabilityTransaction(pool, async (client) => {
      for (const params of values) {
        await client.query(`
          INSERT INTO fact.full_home_store_daily (
            store_code, business_date, currency,
            deal_amount, net_deal_amount, sales_quantity, buyer_count,
            goods_detail_visitors, exposure_users, exposure_basis,
            stocking_order_count, urgent_purchase_order_count,
            payment_order_count, new_customer_sales_quantity,
            new_customer_payment_order_count, source_updated_at, observed_at,
            source_contract_version, source_codes, quality_status
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
          )
          ON CONFLICT (store_code, business_date) DO UPDATE SET
            currency = COALESCE(EXCLUDED.currency, fact.full_home_store_daily.currency),
            deal_amount = COALESCE(EXCLUDED.deal_amount, fact.full_home_store_daily.deal_amount),
            net_deal_amount = COALESCE(
              EXCLUDED.net_deal_amount,
              fact.full_home_store_daily.net_deal_amount
            ),
            sales_quantity = CASE
              -- The daily index is the settled operating truth and may replace
              -- the previous day's hourly realtime subtotal.
              WHEN 'WEBAPI_INDEX' = ANY(EXCLUDED.source_codes)
                THEN COALESCE(
                  EXCLUDED.sales_quantity,
                  fact.full_home_store_daily.sales_quantity
                )
              -- Realtime is authoritative only until a settled daily-index row
              -- exists for the same store/date.
              WHEN 'WEBAPI_REALTIME' = ANY(EXCLUDED.source_codes)
                   AND NOT (
                     'WEBAPI_INDEX' = ANY(
                       fact.full_home_store_daily.source_codes
                     )
                   )
                THEN COALESCE(
                  EXCLUDED.sales_quantity,
                  fact.full_home_store_daily.sales_quantity
                )
              -- Brand-summed analysis is useful as a fallback but must never
              -- overwrite the store-level index or realtime quantity.
              WHEN 'WEBAPI_ANALYSE' = ANY(EXCLUDED.source_codes)
                   AND fact.full_home_store_daily.source_codes
                     && ARRAY['WEBAPI_INDEX', 'WEBAPI_REALTIME']::text[]
                THEN fact.full_home_store_daily.sales_quantity
              ELSE COALESCE(
                EXCLUDED.sales_quantity,
                fact.full_home_store_daily.sales_quantity
              )
            END,
            buyer_count = COALESCE(EXCLUDED.buyer_count, fact.full_home_store_daily.buyer_count),
            goods_detail_visitors = COALESCE(
              EXCLUDED.goods_detail_visitors,
              fact.full_home_store_daily.goods_detail_visitors
            ),
            exposure_users = COALESCE(
              EXCLUDED.exposure_users,
              fact.full_home_store_daily.exposure_users
            ),
            exposure_basis = CASE
              WHEN EXCLUDED.exposure_users IS NULL
                THEN fact.full_home_store_daily.exposure_basis
              ELSE EXCLUDED.exposure_basis
            END,
            stocking_order_count = COALESCE(
              EXCLUDED.stocking_order_count,
              fact.full_home_store_daily.stocking_order_count
            ),
            urgent_purchase_order_count = COALESCE(
              EXCLUDED.urgent_purchase_order_count,
              fact.full_home_store_daily.urgent_purchase_order_count
            ),
            payment_order_count = CASE
              WHEN 'WEBAPI_TRADE' = ANY(EXCLUDED.source_codes)
                THEN COALESCE(
                  EXCLUDED.payment_order_count,
                  fact.full_home_store_daily.payment_order_count
                )
              WHEN 'WEBAPI_ANALYSE' = ANY(EXCLUDED.source_codes)
                   AND 'WEBAPI_TRADE' = ANY(
                     fact.full_home_store_daily.source_codes
                   )
                THEN fact.full_home_store_daily.payment_order_count
              ELSE COALESCE(
                EXCLUDED.payment_order_count,
                fact.full_home_store_daily.payment_order_count
              )
            END,
            new_customer_sales_quantity = COALESCE(
              EXCLUDED.new_customer_sales_quantity,
              fact.full_home_store_daily.new_customer_sales_quantity
            ),
            new_customer_payment_order_count = COALESCE(
              EXCLUDED.new_customer_payment_order_count,
              fact.full_home_store_daily.new_customer_payment_order_count
            ),
            source_updated_at = GREATEST(
              EXCLUDED.source_updated_at,
              fact.full_home_store_daily.source_updated_at
            ),
            observed_at = GREATEST(
              EXCLUDED.observed_at,
              fact.full_home_store_daily.observed_at
            ),
            source_contract_version = GREATEST(
              EXCLUDED.source_contract_version,
              fact.full_home_store_daily.source_contract_version
            ),
            source_codes = ARRAY(
              SELECT DISTINCT code
              FROM unnest(
                CASE
                  -- Once the settled daily index arrives, the earlier hourly
                  -- subtotal is no longer the active operating basis.
                  WHEN 'WEBAPI_INDEX' = ANY(EXCLUDED.source_codes)
                    THEN array_remove(
                      fact.full_home_store_daily.source_codes,
                      'WEBAPI_REALTIME'
                    ) || EXCLUDED.source_codes
                  -- A late realtime replay must not downgrade an already
                  -- settled date back to provisional.
                  WHEN 'WEBAPI_REALTIME' = ANY(EXCLUDED.source_codes)
                       AND 'WEBAPI_INDEX' = ANY(
                         fact.full_home_store_daily.source_codes
                       )
                    THEN fact.full_home_store_daily.source_codes
                  ELSE fact.full_home_store_daily.source_codes
                    || EXCLUDED.source_codes
                END
              ) AS code
              ORDER BY code
            ),
            quality_status = CASE
              WHEN fact.full_home_store_daily.quality_status = 'COMPLETE'
                OR EXCLUDED.quality_status = 'COMPLETE'
                THEN 'COMPLETE'
              WHEN fact.full_home_store_daily.quality_status = 'LEGAL_ZERO'
                OR EXCLUDED.quality_status = 'LEGAL_ZERO'
                THEN 'LEGAL_ZERO'
              ELSE 'PARTIAL'
            END,
            updated_at = clock_timestamp()`, params);
      }
      return { upserted: values.length };
    });
  }

  async function upsertRegions(rows) {
    const values = rows.map(regionValues);
    if (values.length === 0) return { upserted: 0 };
    return inCapabilityTransaction(pool, async (client) => {
      for (const params of values) {
        await client.query(`
          INSERT INTO fact.full_home_region_daily (
            store_code, business_date, region_key, region_name,
            sales_quantity, sales_share, new_customer_sales_quantity,
            new_customer_sales_share, source_updated_at, observed_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (store_code, business_date, region_key) DO UPDATE SET
            region_name = EXCLUDED.region_name,
            sales_quantity = COALESCE(
              EXCLUDED.sales_quantity,
              fact.full_home_region_daily.sales_quantity
            ),
            sales_share = COALESCE(
              EXCLUDED.sales_share,
              fact.full_home_region_daily.sales_share
            ),
            new_customer_sales_quantity = COALESCE(
              EXCLUDED.new_customer_sales_quantity,
              fact.full_home_region_daily.new_customer_sales_quantity
            ),
            new_customer_sales_share = COALESCE(
              EXCLUDED.new_customer_sales_share,
              fact.full_home_region_daily.new_customer_sales_share
            ),
            source_updated_at = GREATEST(
              EXCLUDED.source_updated_at,
              fact.full_home_region_daily.source_updated_at
            ),
            observed_at = GREATEST(
              EXCLUDED.observed_at,
              fact.full_home_region_daily.observed_at
            ),
            updated_at = clock_timestamp()`, params);
      }
      return { upserted: values.length };
    });
  }

  async function upsertProducts(rows) {
    const values = rows.map(productValues);
    if (values.length === 0) return { upserted: 0 };
    return inCapabilityTransaction(pool, async (client) => {
      for (const params of values) {
        await client.query(`
          INSERT INTO fact.full_home_product_daily (
            store_code, business_date, product_grain, product_key,
            platform_spu_id, platform_skc_id, supplier_code, supplier_sku,
            display_name, sales_quantity, source_updated_at, observed_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (store_code, business_date, product_grain, product_key)
          DO UPDATE SET
            platform_spu_id = COALESCE(
              EXCLUDED.platform_spu_id,
              fact.full_home_product_daily.platform_spu_id
            ),
            platform_skc_id = COALESCE(
              EXCLUDED.platform_skc_id,
              fact.full_home_product_daily.platform_skc_id
            ),
            supplier_code = COALESCE(
              EXCLUDED.supplier_code,
              fact.full_home_product_daily.supplier_code
            ),
            supplier_sku = COALESCE(
              EXCLUDED.supplier_sku,
              fact.full_home_product_daily.supplier_sku
            ),
            display_name = COALESCE(
              EXCLUDED.display_name,
              fact.full_home_product_daily.display_name
            ),
            sales_quantity = COALESCE(
              EXCLUDED.sales_quantity,
              fact.full_home_product_daily.sales_quantity
            ),
            source_updated_at = GREATEST(
              EXCLUDED.source_updated_at,
              fact.full_home_product_daily.source_updated_at
            ),
            observed_at = GREATEST(
              EXCLUDED.observed_at,
              fact.full_home_product_daily.observed_at
            ),
            updated_at = clock_timestamp()`, params);
      }
      return { upserted: values.length };
    });
  }

  async function upsertLedgerDaily(rows) {
    const values = rows.map(ledgerRow);
    if (values.length === 0) return { upserted: 0 };
    return inCapabilityTransaction(pool, async (client) => {
      const result = await client.query(`
        INSERT INTO fact.full_home_ledger_daily (
          store_code, business_date, currency,
          begin_balance_count, inbound_count, outbound_count, end_balance_count,
          urgent_order_entry_count, prepare_order_entry_count,
          inbound_gain_count, inbound_return_count, supply_change_in_count,
          adjustment_in_count, customer_outbound_count,
          direct_customer_outbound_count, platform_customer_outbound_count,
          outbound_loss_count, supplier_outbound_count, inventory_clear_count,
          report_clear_count, scrap_count, supply_change_out_count,
          adjustment_out_count, customer_loss_count,
          begin_balance_amount, inbound_amount, outbound_amount, end_balance_amount,
          urgent_order_entry_amount, prepare_order_entry_amount,
          inbound_gain_amount, inbound_return_amount, supply_change_in_amount,
          adjustment_in_amount, customer_outbound_amount,
          direct_customer_outbound_amount, platform_customer_outbound_amount,
          outbound_loss_amount, supplier_outbound_amount, inventory_clear_amount,
          report_clear_amount, scrap_amount, supply_change_out_amount,
          adjustment_out_amount, customer_loss_amount,
          observed_at, source_contract_version, quality_status
        )
        SELECT
          x.store_code, x.business_date, x.currency,
          x.begin_balance_count, x.inbound_count, x.outbound_count,
          x.end_balance_count, x.urgent_order_entry_count,
          x.prepare_order_entry_count, x.inbound_gain_count,
          x.inbound_return_count, x.supply_change_in_count,
          x.adjustment_in_count, x.customer_outbound_count,
          x.direct_customer_outbound_count, x.platform_customer_outbound_count,
          x.outbound_loss_count, x.supplier_outbound_count,
          x.inventory_clear_count, x.report_clear_count, x.scrap_count,
          x.supply_change_out_count, x.adjustment_out_count,
          x.customer_loss_count, x.begin_balance_amount, x.inbound_amount,
          x.outbound_amount, x.end_balance_amount, x.urgent_order_entry_amount,
          x.prepare_order_entry_amount, x.inbound_gain_amount,
          x.inbound_return_amount, x.supply_change_in_amount,
          x.adjustment_in_amount, x.customer_outbound_amount,
          x.direct_customer_outbound_amount, x.platform_customer_outbound_amount,
          x.outbound_loss_amount, x.supplier_outbound_amount,
          x.inventory_clear_amount, x.report_clear_amount, x.scrap_amount,
          x.supply_change_out_amount, x.adjustment_out_amount,
          x.customer_loss_amount, x.observed_at, x.source_contract_version,
          x.quality_status
        FROM jsonb_to_recordset($1::jsonb) AS x(
          store_code text,
          business_date date,
          currency character(3),
          begin_balance_count bigint,
          inbound_count bigint,
          outbound_count bigint,
          end_balance_count bigint,
          urgent_order_entry_count bigint,
          prepare_order_entry_count bigint,
          inbound_gain_count bigint,
          inbound_return_count bigint,
          supply_change_in_count bigint,
          adjustment_in_count bigint,
          customer_outbound_count bigint,
          direct_customer_outbound_count bigint,
          platform_customer_outbound_count bigint,
          outbound_loss_count bigint,
          supplier_outbound_count bigint,
          inventory_clear_count bigint,
          report_clear_count bigint,
          scrap_count bigint,
          supply_change_out_count bigint,
          adjustment_out_count bigint,
          customer_loss_count bigint,
          begin_balance_amount numeric,
          inbound_amount numeric,
          outbound_amount numeric,
          end_balance_amount numeric,
          urgent_order_entry_amount numeric,
          prepare_order_entry_amount numeric,
          inbound_gain_amount numeric,
          inbound_return_amount numeric,
          supply_change_in_amount numeric,
          adjustment_in_amount numeric,
          customer_outbound_amount numeric,
          direct_customer_outbound_amount numeric,
          platform_customer_outbound_amount numeric,
          outbound_loss_amount numeric,
          supplier_outbound_amount numeric,
          inventory_clear_amount numeric,
          report_clear_amount numeric,
          scrap_amount numeric,
          supply_change_out_amount numeric,
          adjustment_out_amount numeric,
          customer_loss_amount numeric,
          observed_at timestamptz,
          source_contract_version smallint,
          quality_status text
        )
        ON CONFLICT (store_code, business_date) DO UPDATE SET
          currency = COALESCE(EXCLUDED.currency, fact.full_home_ledger_daily.currency),
          begin_balance_count = COALESCE(
            EXCLUDED.begin_balance_count,
            fact.full_home_ledger_daily.begin_balance_count
          ),
          inbound_count = COALESCE(
            EXCLUDED.inbound_count,
            fact.full_home_ledger_daily.inbound_count
          ),
          outbound_count = COALESCE(
            EXCLUDED.outbound_count,
            fact.full_home_ledger_daily.outbound_count
          ),
          end_balance_count = COALESCE(
            EXCLUDED.end_balance_count,
            fact.full_home_ledger_daily.end_balance_count
          ),
          urgent_order_entry_count = COALESCE(
            EXCLUDED.urgent_order_entry_count,
            fact.full_home_ledger_daily.urgent_order_entry_count
          ),
          prepare_order_entry_count = COALESCE(
            EXCLUDED.prepare_order_entry_count,
            fact.full_home_ledger_daily.prepare_order_entry_count
          ),
          inbound_gain_count = COALESCE(
            EXCLUDED.inbound_gain_count,
            fact.full_home_ledger_daily.inbound_gain_count
          ),
          inbound_return_count = COALESCE(
            EXCLUDED.inbound_return_count,
            fact.full_home_ledger_daily.inbound_return_count
          ),
          supply_change_in_count = COALESCE(
            EXCLUDED.supply_change_in_count,
            fact.full_home_ledger_daily.supply_change_in_count
          ),
          adjustment_in_count = COALESCE(
            EXCLUDED.adjustment_in_count,
            fact.full_home_ledger_daily.adjustment_in_count
          ),
          customer_outbound_count = COALESCE(
            EXCLUDED.customer_outbound_count,
            fact.full_home_ledger_daily.customer_outbound_count
          ),
          direct_customer_outbound_count = COALESCE(
            EXCLUDED.direct_customer_outbound_count,
            fact.full_home_ledger_daily.direct_customer_outbound_count
          ),
          platform_customer_outbound_count = COALESCE(
            EXCLUDED.platform_customer_outbound_count,
            fact.full_home_ledger_daily.platform_customer_outbound_count
          ),
          outbound_loss_count = COALESCE(
            EXCLUDED.outbound_loss_count,
            fact.full_home_ledger_daily.outbound_loss_count
          ),
          supplier_outbound_count = COALESCE(
            EXCLUDED.supplier_outbound_count,
            fact.full_home_ledger_daily.supplier_outbound_count
          ),
          inventory_clear_count = COALESCE(
            EXCLUDED.inventory_clear_count,
            fact.full_home_ledger_daily.inventory_clear_count
          ),
          report_clear_count = COALESCE(
            EXCLUDED.report_clear_count,
            fact.full_home_ledger_daily.report_clear_count
          ),
          scrap_count = COALESCE(
            EXCLUDED.scrap_count,
            fact.full_home_ledger_daily.scrap_count
          ),
          supply_change_out_count = COALESCE(
            EXCLUDED.supply_change_out_count,
            fact.full_home_ledger_daily.supply_change_out_count
          ),
          adjustment_out_count = COALESCE(
            EXCLUDED.adjustment_out_count,
            fact.full_home_ledger_daily.adjustment_out_count
          ),
          customer_loss_count = COALESCE(
            EXCLUDED.customer_loss_count,
            fact.full_home_ledger_daily.customer_loss_count
          ),
          begin_balance_amount = COALESCE(
            EXCLUDED.begin_balance_amount,
            fact.full_home_ledger_daily.begin_balance_amount
          ),
          inbound_amount = COALESCE(
            EXCLUDED.inbound_amount,
            fact.full_home_ledger_daily.inbound_amount
          ),
          outbound_amount = COALESCE(
            EXCLUDED.outbound_amount,
            fact.full_home_ledger_daily.outbound_amount
          ),
          end_balance_amount = COALESCE(
            EXCLUDED.end_balance_amount,
            fact.full_home_ledger_daily.end_balance_amount
          ),
          urgent_order_entry_amount = COALESCE(
            EXCLUDED.urgent_order_entry_amount,
            fact.full_home_ledger_daily.urgent_order_entry_amount
          ),
          prepare_order_entry_amount = COALESCE(
            EXCLUDED.prepare_order_entry_amount,
            fact.full_home_ledger_daily.prepare_order_entry_amount
          ),
          inbound_gain_amount = COALESCE(
            EXCLUDED.inbound_gain_amount,
            fact.full_home_ledger_daily.inbound_gain_amount
          ),
          inbound_return_amount = COALESCE(
            EXCLUDED.inbound_return_amount,
            fact.full_home_ledger_daily.inbound_return_amount
          ),
          supply_change_in_amount = COALESCE(
            EXCLUDED.supply_change_in_amount,
            fact.full_home_ledger_daily.supply_change_in_amount
          ),
          adjustment_in_amount = COALESCE(
            EXCLUDED.adjustment_in_amount,
            fact.full_home_ledger_daily.adjustment_in_amount
          ),
          customer_outbound_amount = COALESCE(
            EXCLUDED.customer_outbound_amount,
            fact.full_home_ledger_daily.customer_outbound_amount
          ),
          direct_customer_outbound_amount = COALESCE(
            EXCLUDED.direct_customer_outbound_amount,
            fact.full_home_ledger_daily.direct_customer_outbound_amount
          ),
          platform_customer_outbound_amount = COALESCE(
            EXCLUDED.platform_customer_outbound_amount,
            fact.full_home_ledger_daily.platform_customer_outbound_amount
          ),
          outbound_loss_amount = COALESCE(
            EXCLUDED.outbound_loss_amount,
            fact.full_home_ledger_daily.outbound_loss_amount
          ),
          supplier_outbound_amount = COALESCE(
            EXCLUDED.supplier_outbound_amount,
            fact.full_home_ledger_daily.supplier_outbound_amount
          ),
          inventory_clear_amount = COALESCE(
            EXCLUDED.inventory_clear_amount,
            fact.full_home_ledger_daily.inventory_clear_amount
          ),
          report_clear_amount = COALESCE(
            EXCLUDED.report_clear_amount,
            fact.full_home_ledger_daily.report_clear_amount
          ),
          scrap_amount = COALESCE(
            EXCLUDED.scrap_amount,
            fact.full_home_ledger_daily.scrap_amount
          ),
          supply_change_out_amount = COALESCE(
            EXCLUDED.supply_change_out_amount,
            fact.full_home_ledger_daily.supply_change_out_amount
          ),
          adjustment_out_amount = COALESCE(
            EXCLUDED.adjustment_out_amount,
            fact.full_home_ledger_daily.adjustment_out_amount
          ),
          customer_loss_amount = COALESCE(
            EXCLUDED.customer_loss_amount,
            fact.full_home_ledger_daily.customer_loss_amount
          ),
          observed_at = GREATEST(
            EXCLUDED.observed_at,
            fact.full_home_ledger_daily.observed_at
          ),
          source_contract_version = GREATEST(
            EXCLUDED.source_contract_version,
            fact.full_home_ledger_daily.source_contract_version
          ),
          quality_status = EXCLUDED.quality_status,
          updated_at = clock_timestamp()`,
        [JSON.stringify(values)],
      );
      return { upserted: result.rowCount ?? values.length };
    });
  }

  async function recordFetchAudit(input = {}) {
    const audit = record(input);
    const requestedStartDate = audit.requestedStartDate
      ? date(audit.requestedStartDate, 'requestedStartDate')
      : null;
    const requestedEndDate = audit.requestedEndDate
      ? date(audit.requestedEndDate, 'requestedEndDate')
      : null;
    const observedAt = instant(audit.observedAt ?? new Date(), 'observedAt');
    const completedAt = instant(audit.completedAt ?? observedAt, 'completedAt');
    const requestHash = text(
      audit.requestSha256 ?? sha256Json(audit.request ?? null),
      'requestSha256',
      64,
    );
    const fetchKey = text(
      audit.fetchKey ?? sha256Json({
        storeCode: audit.storeCode,
        endpointCode: audit.endpointCode,
        requestedStartDate,
        requestedEndDate,
        requestHash,
        observedAt,
      }),
      'fetchKey',
      64,
    );
    const params = [
      fetchKey,
      storeCode(audit.storeCode),
      text(audit.endpointCode, 'endpointCode', 40),
      requestedStartDate,
      requestedEndDate,
      requestHash,
      text(audit.responseSchemaSha256, 'responseSchemaSha256', 64, { nullable: true }),
      text(audit.responseBodySha256, 'responseBodySha256', 64, { nullable: true }),
      audit.httpStatus === null || audit.httpStatus === undefined
        ? null
        : nullableNumber(audit.httpStatus, 'httpStatus', { integer: true }),
      text(audit.resultStatus, 'resultStatus', 20),
      nullableNumber(audit.acceptedRowCount ?? 0, 'acceptedRowCount', { integer: true }),
      nullableNumber(audit.rejectedRowCount ?? 0, 'rejectedRowCount', { integer: true }),
      observedAt,
      completedAt,
      text(audit.sanitizedErrorCode, 'sanitizedErrorCode', 80, { nullable: true }),
    ];
    return inCapabilityTransaction(pool, async (client) => {
      const result = await client.query(`
        INSERT INTO raw.webapi_home_fetch_audit (
          fetch_key, store_code, endpoint_code,
          requested_start_date, requested_end_date, request_sha256,
          response_schema_sha256, response_body_sha256, http_status,
          result_status, accepted_row_count, rejected_row_count,
          observed_at, completed_at, sanitized_error_code
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
        )
        ON CONFLICT (fetch_key) DO NOTHING
        RETURNING webapi_home_fetch_audit_id`, params);
      return {
        inserted: result.rowCount === 1,
        webapiHomeFetchAuditId:
          result.rows[0]?.webapi_home_fetch_audit_id ?? null,
      };
    });
  }

  async function successfulDailyDates({
    storeCode: inputStoreCode,
    endpointCode,
    startDate,
    endDate,
  } = {}) {
    const store = storeCode(inputStoreCode);
    const endpoint = text(endpointCode, 'endpointCode', 40);
    const start = date(startDate, 'startDate');
    const end = date(endDate, 'endDate');
    if (start > end) throw new TypeError('history date range is invalid');
    return inCapabilityTransaction(pool, async (client) => {
      const result = await client.query(`
        SELECT requested_start_date::text AS business_date
        FROM raw.webapi_home_fetch_audit
        WHERE store_code = $1
          AND endpoint_code = $2
          AND requested_start_date >= $3::date
          AND requested_end_date <= $4::date
          AND requested_start_date = requested_end_date
          AND result_status = 'SUCCEEDED'
        GROUP BY requested_start_date
        ORDER BY requested_start_date`, [store, endpoint, start, end]);
      return new Set(result.rows.map((row) => row.business_date));
    });
  }

  async function terminalUnsupportedDailyDates({
    storeCode: inputStoreCode,
    endpointCode,
    startDate,
    endDate,
  } = {}) {
    const store = storeCode(inputStoreCode);
    const endpoint = text(endpointCode, 'endpointCode', 40);
    const start = date(startDate, 'startDate');
    const end = date(endDate, 'endDate');
    if (start > end) throw new TypeError('history date range is invalid');
    return inCapabilityTransaction(pool, async (client) => {
      const result = await client.query(`
        SELECT failed.requested_start_date::text AS business_date
        FROM raw.webapi_home_fetch_audit AS failed
        WHERE failed.store_code = $1
          AND failed.endpoint_code = $2
          AND failed.requested_start_date >= $3::date
          AND failed.requested_end_date <= $4::date
          AND failed.requested_start_date = failed.requested_end_date
          AND failed.result_status = 'FAILED'
          AND failed.sanitized_error_code = 'HOME_BUSINESS_STATUS_FAILED'
          AND NOT EXISTS (
            SELECT 1
            FROM raw.webapi_home_fetch_audit AS succeeded
            WHERE succeeded.store_code = failed.store_code
              AND succeeded.endpoint_code = failed.endpoint_code
              AND succeeded.requested_start_date = failed.requested_start_date
              AND succeeded.requested_end_date = failed.requested_end_date
              AND succeeded.result_status = 'SUCCEEDED'
          )
        GROUP BY failed.requested_start_date
        ORDER BY failed.requested_start_date`, [store, endpoint, start, end]);
      return new Set(result.rows.map((row) => row.business_date));
    });
  }

  return Object.freeze({
    upsertStoreDaily,
    upsertRegions,
    upsertProducts,
    upsertLedgerDaily,
    recordFetchAudit,
    successfulDailyDates,
    terminalUnsupportedDailyDates,
  });
}
