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
      const reportGeneratedDates = new Map(
        reports.map((report) => [
          report.reportOrderNoHash,
          report.addTime.slice(0, 10),
        ]),
      );
      for (const row of details) {
        if (!reportGeneratedDates.has(row.reportOrderNoHash)) {
          throw new TypeError('finance detail references an unknown report');
        }
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE sheinfm_sales_loader');
        const existingDates = await client.query(
          `SELECT DISTINCT business_date::text AS business_date
           FROM fact.full_home_finance_detail_observation
           WHERE store_code = $1
             AND report_generated_date BETWEEN $2::date AND $3::date`,
          [storeCode, startDate, endDate],
        );
        const affectedDates = [...new Set([
          ...existingDates.rows.map((row) => row.business_date),
          ...details.map((row) => row.businessDate),
        ])].sort();
        await client.query(
          `DELETE FROM fact.full_home_finance_detail_observation
           WHERE store_code = $1
             AND report_generated_date BETWEEN $2::date AND $3::date`,
          [storeCode, startDate, endDate],
        );

        for (const row of details) {
          const observationKey = crypto.createHash('sha256')
            .update(key([storeCode, row.reportOrderNoHash, row.detailRowKeyHash]))
            .digest('hex');
          await client.query(
            `INSERT INTO fact.full_home_finance_detail_observation (
               observation_key, store_code, report_order_no_hash,
               detail_row_key_hash, report_generated_date, business_date,
               currency, direction, amount, goods_count, product_key,
               platform_sku_id, platform_skc_id, supplier_sku, unit_price,
               source_business_at, observed_at, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5::date, $6::date, $7, $8,
               $9::numeric, $10, $11, $12, $13, $14, $15::numeric,
               $16::timestamptz, $17::timestamptz, clock_timestamp()
             )
             ON CONFLICT (observation_key) DO UPDATE SET
               report_generated_date = EXCLUDED.report_generated_date,
               business_date = EXCLUDED.business_date,
               currency = EXCLUDED.currency,
               direction = EXCLUDED.direction,
               amount = EXCLUDED.amount,
               goods_count = EXCLUDED.goods_count,
               product_key = EXCLUDED.product_key,
               platform_sku_id = EXCLUDED.platform_sku_id,
               platform_skc_id = EXCLUDED.platform_skc_id,
               supplier_sku = EXCLUDED.supplier_sku,
               unit_price = EXCLUDED.unit_price,
               source_business_at = EXCLUDED.source_business_at,
               observed_at = EXCLUDED.observed_at,
               updated_at = clock_timestamp()`,
            [
              observationKey,
              storeCode,
              row.reportOrderNoHash,
              row.detailRowKeyHash,
              reportGeneratedDates.get(row.reportOrderNoHash),
              row.businessDate,
              row.currency,
              row.direction,
              amount(row.amount),
              count(row.goodsCount),
              row.productKey,
              row.platformSkuId,
              row.platformSkcId,
              row.supplierSku,
              row.unitPrice,
              row.observedBusinessAt,
              observedAt,
            ],
          );
        }

        let financeDailyRows = 0;
        let productFinanceRows = 0;
        if (affectedDates.length > 0) {
          await client.query(
            `DELETE FROM fact.full_home_product_finance_daily
             WHERE store_code = $1
               AND business_date = ANY($2::date[])`,
            [storeCode, affectedDates],
          );
          await client.query(
            `DELETE FROM fact.full_home_finance_daily
             WHERE store_code = $1
               AND business_date = ANY($2::date[])`,
            [storeCode, affectedDates],
          );
          const dailyResult = await client.query(
            `INSERT INTO fact.full_home_finance_daily (
               store_code, business_date, currency, income_amount,
               expense_amount, net_amount, goods_count, report_count,
               observed_at, updated_at
             )
             SELECT
               store_code,
               business_date,
               currency,
               SUM(CASE WHEN direction = 'IN' THEN amount ELSE 0 END),
               SUM(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END),
               SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END),
               SUM(CASE WHEN direction = 'IN' THEN goods_count ELSE 0 END),
               COUNT(DISTINCT report_order_no_hash),
               MAX(observed_at),
               clock_timestamp()
             FROM fact.full_home_finance_detail_observation
             WHERE store_code = $1
               AND business_date = ANY($2::date[])
             GROUP BY store_code, business_date, currency`,
            [storeCode, affectedDates],
          );
          const productResult = await client.query(
            `INSERT INTO fact.full_home_product_finance_daily (
               store_code, business_date, currency, product_key,
               platform_sku_id, platform_skc_id, supplier_sku,
               income_amount, expense_amount, net_amount, goods_count,
               latest_unit_price, price_observed_at, observed_at, updated_at
             )
             SELECT
               store_code,
               business_date,
               currency,
               product_key,
               MAX(platform_sku_id),
               MAX(platform_skc_id),
               MAX(supplier_sku),
               SUM(CASE WHEN direction = 'IN' THEN amount ELSE 0 END),
               SUM(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END),
               SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END),
               SUM(CASE WHEN direction = 'IN' THEN goods_count ELSE 0 END),
               (ARRAY_AGG(
                  unit_price
                  ORDER BY source_business_at DESC, observation_key DESC
                ) FILTER (WHERE unit_price IS NOT NULL))[1],
               (ARRAY_AGG(
                  source_business_at
                  ORDER BY source_business_at DESC, observation_key DESC
                ) FILTER (WHERE unit_price IS NOT NULL))[1],
               MAX(observed_at),
               clock_timestamp()
             FROM fact.full_home_finance_detail_observation
             WHERE store_code = $1
               AND business_date = ANY($2::date[])
               AND product_key IS NOT NULL
             GROUP BY store_code, business_date, currency, product_key`,
            [storeCode, affectedDates],
          );
          financeDailyRows = dailyResult.rowCount ?? 0;
          productFinanceRows = productResult.rowCount ?? 0;
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
          financeDailyRows,
          productFinanceRows,
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
