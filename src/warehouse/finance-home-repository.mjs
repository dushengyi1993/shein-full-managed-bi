import crypto from 'node:crypto';

function key(parts) {
  return parts.join('\u001f');
}

function amount(number) {
  return Number(number).toFixed(4);
}

function count(number) {
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError('count is invalid');
  return number;
}

function aggregate({ storeCode, reports, details }) {
  const reportCounts = new Map();
  for (const report of reports) {
    const date = report.addTime.slice(0, 10);
    const grain = key([date, report.currency]);
    reportCounts.set(grain, (reportCounts.get(grain) ?? 0) + 1);
  }
  const daily = new Map();
  const products = new Map();
  for (const row of details) {
    const dailyKey = key([row.businessDate, row.currency]);
    const current = daily.get(dailyKey) ?? {
      storeCode,
      businessDate: row.businessDate,
      currency: row.currency,
      incomeAmount: 0,
      expenseAmount: 0,
      goodsCount: 0,
      reportCount: reportCounts.get(dailyKey) ?? 0,
    };
    if (row.direction === 'IN') {
      current.incomeAmount += row.amount;
      current.goodsCount += row.goodsCount;
    } else {
      current.expenseAmount += row.amount;
    }
    daily.set(dailyKey, current);

    if (!row.productKey) continue;
    const productKey = key([
      row.businessDate,
      row.currency,
      row.productKey,
    ]);
    const product = products.get(productKey) ?? {
      storeCode,
      businessDate: row.businessDate,
      currency: row.currency,
      productKey: row.productKey,
      platformSkuId: row.platformSkuId,
      platformSkcId: row.platformSkcId,
      supplierSku: row.supplierSku,
      incomeAmount: 0,
      expenseAmount: 0,
      goodsCount: 0,
      latestUnitPrice: null,
      priceObservedAt: null,
    };
    if (row.direction === 'IN') {
      product.incomeAmount += row.amount;
      product.goodsCount += row.goodsCount;
    } else {
      product.expenseAmount += row.amount;
    }
    if (
      row.unitPrice !== null
      && (
        product.priceObservedAt === null
        || row.observedBusinessAt >= product.priceObservedAt
      )
    ) {
      product.latestUnitPrice = row.unitPrice;
      product.priceObservedAt = row.observedBusinessAt;
    }
    products.set(productKey, product);
  }
  for (const row of daily.values()) {
    row.netAmount = row.incomeAmount - row.expenseAmount;
  }
  for (const row of products.values()) {
    row.netAmount = row.incomeAmount - row.expenseAmount;
  }
  return { daily: [...daily.values()], products: [...products.values()] };
}

export function createFinanceHomeRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('pool is required');
  }

  return {
    async recordFailure({
      storeCode,
      startDate,
      endDate,
      observedAt,
      completedAt,
      sanitizedErrorCode,
    }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE sheinfm_sales_loader');
        await client.query(
          `INSERT INTO ops.full_home_finance_sync_window (
             store_code, start_date, end_date, result_status,
             report_count, detail_count, observed_at, completed_at,
             sanitized_error_code, updated_at
           ) VALUES (
             $1, $2::date, $3::date, 'FAILED', 0, 0,
             $4::timestamptz, $5::timestamptz, $6, clock_timestamp()
           )
           ON CONFLICT (store_code, start_date, end_date) DO UPDATE SET
             result_status = EXCLUDED.result_status,
             observed_at = EXCLUDED.observed_at,
             completed_at = EXCLUDED.completed_at,
             sanitized_error_code = EXCLUDED.sanitized_error_code,
             updated_at = clock_timestamp()`,
          [
            storeCode,
            startDate,
            endDate,
            observedAt,
            completedAt,
            sanitizedErrorCode,
          ],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async replaceWindow({
      storeCode,
      startDate,
      endDate,
      reports,
      details,
      observedAt,
      completedAt,
    }) {
      const projection = aggregate({ storeCode, reports, details });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE sheinfm_sales_loader');
        await client.query(
          `DELETE FROM fact.full_home_product_finance_daily
           WHERE store_code = $1 AND business_date BETWEEN $2::date AND $3::date`,
          [storeCode, startDate, endDate],
        );
        await client.query(
          `DELETE FROM fact.full_home_finance_daily
           WHERE store_code = $1 AND business_date BETWEEN $2::date AND $3::date`,
          [storeCode, startDate, endDate],
        );
        for (const row of projection.daily) {
          await client.query(
            `INSERT INTO fact.full_home_finance_daily (
               store_code, business_date, currency, income_amount,
               expense_amount, net_amount, goods_count, report_count,
               observed_at, updated_at
             ) VALUES (
               $1, $2::date, $3, $4::numeric, $5::numeric, $6::numeric,
               $7, $8, $9::timestamptz, clock_timestamp()
             )`,
            [
              row.storeCode,
              row.businessDate,
              row.currency,
              amount(row.incomeAmount),
              amount(row.expenseAmount),
              amount(row.netAmount),
              count(row.goodsCount),
              count(row.reportCount),
              observedAt,
            ],
          );
        }
        for (const row of projection.products) {
          await client.query(
            `INSERT INTO fact.full_home_product_finance_daily (
               store_code, business_date, currency, product_key,
               platform_sku_id, platform_skc_id, supplier_sku,
               income_amount, expense_amount, net_amount, goods_count,
               latest_unit_price, price_observed_at, observed_at, updated_at
             ) VALUES (
               $1, $2::date, $3, $4, $5, $6, $7,
               $8::numeric, $9::numeric, $10::numeric, $11,
               $12::numeric, $13::timestamptz, $14::timestamptz,
               clock_timestamp()
             )`,
            [
              row.storeCode,
              row.businessDate,
              row.currency,
              row.productKey,
              row.platformSkuId,
              row.platformSkcId,
              row.supplierSku,
              amount(row.incomeAmount),
              amount(row.expenseAmount),
              amount(row.netAmount),
              count(row.goodsCount),
              row.latestUnitPrice,
              row.priceObservedAt,
              observedAt,
            ],
          );
        }
        for (const row of details) {
          if (row.unitPrice === null || !row.productKey) continue;
          const observationKey = crypto.createHash('sha256')
            .update(key([storeCode, row.reportOrderNoHash, row.detailRowKeyHash]))
            .digest('hex');
          await client.query(
            `INSERT INTO fact.full_product_price_observation (
               observation_key, store_code, report_order_no_hash,
               detail_row_key_hash, platform_sku_id, supplier_sku,
               supplier_code, unit_price, amount, goods_count, currency,
               direction, second_order_type, source_business_at, observed_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, NULL, $7::numeric, $8::numeric,
               $9, $10, $11, $12, $13::timestamptz, $14::timestamptz
             )
             ON CONFLICT (observation_key) DO NOTHING`,
            [
              observationKey,
              storeCode,
              row.reportOrderNoHash,
              row.detailRowKeyHash,
              row.platformSkuId,
              row.supplierSku,
              row.unitPrice,
              amount(row.amount),
              count(row.goodsCount),
              row.currency,
              row.direction,
              row.secondOrderType,
              row.observedBusinessAt,
              observedAt,
            ],
          );
        }
        await client.query(
          `INSERT INTO ops.full_home_finance_sync_window (
             store_code, start_date, end_date, result_status,
             report_count, detail_count, observed_at, completed_at,
             sanitized_error_code, updated_at
           ) VALUES (
             $1, $2::date, $3::date, 'SUCCEEDED', $4, $5,
             $6::timestamptz, $7::timestamptz, NULL, clock_timestamp()
           )
           ON CONFLICT (store_code, start_date, end_date) DO UPDATE SET
             result_status = EXCLUDED.result_status,
             report_count = EXCLUDED.report_count,
             detail_count = EXCLUDED.detail_count,
             observed_at = EXCLUDED.observed_at,
             completed_at = EXCLUDED.completed_at,
             sanitized_error_code = NULL,
             updated_at = clock_timestamp()`,
          [
            storeCode,
            startDate,
            endDate,
            count(reports.length),
            count(details.length),
            observedAt,
            completedAt,
          ],
        );
        await client.query('COMMIT');
        return {
          financeDailyRows: projection.daily.length,
          productFinanceRows: projection.products.length,
          priceObservations: details.filter(
            ({ unitPrice, productKey }) => unitPrice !== null && productKey,
          ).length,
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
