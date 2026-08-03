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
             report_count, detail_count, adjustment_count,
             source_contract_version, observed_at, completed_at,
             sanitized_error_code, updated_at
           ) VALUES (
             $1, $2::date, $3::date, 'FAILED', 0, 0, 0, 2,
             $4::timestamptz, $5::timestamptz, $6, clock_timestamp()
           )
           ON CONFLICT (store_code, start_date, end_date) DO UPDATE SET
             result_status = EXCLUDED.result_status,
             adjustment_count = EXCLUDED.adjustment_count,
             source_contract_version = EXCLUDED.source_contract_version,
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
      adjustments = [],
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
      for (const row of adjustments) {
        if (!reportGeneratedDates.has(row.reportOrderNoHash)) {
          throw new TypeError('finance adjustment references an unknown report');
        }
      }
      const reportObservations = reports.map((report) => ({
        store_code: storeCode,
        report_order_no_hash: report.reportOrderNoHash,
        report_generated_date: report.addTime.slice(0, 10),
        report_generated_at: report.addTime,
        currency: report.currency,
        expected_settlement_amount: report.expectedSettlementAmount === null
          ? null
          : amount(report.expectedSettlementAmount),
        settlement_status: report.settlementStatus,
        completed_pay_at: report.completedPayAt,
        estimated_pay_at: report.estimatedPayAt,
        observed_at: observedAt,
      }));
      const detailObservations = details.map((row) => {
        const observationKey = crypto.createHash('sha256')
          .update(key([storeCode, row.reportOrderNoHash, row.detailRowKeyHash]))
          .digest('hex');
        return {
          observation_key: observationKey,
          store_code: storeCode,
          report_order_no_hash: row.reportOrderNoHash,
          detail_row_key_hash: row.detailRowKeyHash,
          report_generated_date: reportGeneratedDates.get(row.reportOrderNoHash),
          business_date: row.businessDate,
          currency: row.currency,
          direction: row.direction,
          amount: amount(row.amount),
          goods_count: count(row.goodsCount),
          product_key: row.productKey,
          platform_sku_id: row.platformSkuId,
          platform_skc_id: row.platformSkcId,
          supplier_sku: row.supplierSku,
          unit_price: row.unitPrice,
          source_business_at: row.observedBusinessAt,
          observed_at: observedAt,
          second_order_type: row.secondOrderType,
        };
      });
      const adjustmentObservations = adjustments.map((row) => {
        const observationKey = crypto.createHash('sha256')
          .update(key([storeCode, row.reportOrderNoHash, row.detailRowKeyHash]))
          .digest('hex');
        return {
          observation_key: observationKey,
          store_code: storeCode,
          report_order_no_hash: row.reportOrderNoHash,
          detail_row_key_hash: row.detailRowKeyHash,
          report_generated_date: reportGeneratedDates.get(row.reportOrderNoHash),
          currency: row.currency,
          direction: row.direction,
          amount: amount(row.amount),
          goods_count: count(row.goodsCount),
          category: row.category,
          product_key: row.productKey,
          platform_sku_id: row.platformSkuId,
          platform_skc_id: row.platformSkcId,
          supplier_sku: row.supplierSku,
          unit_price: row.unitPrice,
          observed_at: observedAt,
        };
      });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE sheinfm_sales_loader');
        const existingReportDates = await client.query(
          `SELECT DISTINCT report_generated_date::text AS report_generated_date
           FROM fact.full_home_finance_report_observation
           WHERE store_code = $1
             AND report_generated_date BETWEEN $2::date AND $3::date`,
          [storeCode, startDate, endDate],
        );
        const affectedReportDates = [...new Set([
          ...existingReportDates.rows.map((row) => row.report_generated_date),
          ...reports.map((report) => report.addTime.slice(0, 10)),
        ])].sort();
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
          `DELETE FROM fact.full_home_finance_adjustment_observation
           WHERE store_code = $1
             AND report_generated_date BETWEEN $2::date AND $3::date`,
          [storeCode, startDate, endDate],
        );
        await client.query(
          `DELETE FROM fact.full_home_finance_report_observation
           WHERE store_code = $1
             AND report_generated_date BETWEEN $2::date AND $3::date`,
          [storeCode, startDate, endDate],
        );
        if (reportObservations.length > 0) {
          await client.query(
            `INSERT INTO fact.full_home_finance_report_observation (
               store_code, report_order_no_hash, report_generated_date,
               report_generated_at, currency, expected_settlement_amount,
               settlement_status, completed_pay_at, estimated_pay_at,
               observed_at, updated_at
             )
             SELECT
               x.store_code, x.report_order_no_hash, x.report_generated_date,
               x.report_generated_at, x.currency, x.expected_settlement_amount,
               x.settlement_status, x.completed_pay_at, x.estimated_pay_at,
               x.observed_at, clock_timestamp()
             FROM jsonb_to_recordset($1::jsonb) AS x(
               store_code text,
               report_order_no_hash character(64),
               report_generated_date date,
               report_generated_at timestamptz,
               currency character(3),
               expected_settlement_amount numeric,
               settlement_status smallint,
               completed_pay_at timestamptz,
               estimated_pay_at timestamptz,
               observed_at timestamptz
             )
             ON CONFLICT (store_code, report_order_no_hash) DO UPDATE SET
               report_generated_date = EXCLUDED.report_generated_date,
               report_generated_at = EXCLUDED.report_generated_at,
               currency = EXCLUDED.currency,
               expected_settlement_amount = EXCLUDED.expected_settlement_amount,
               settlement_status = EXCLUDED.settlement_status,
               completed_pay_at = EXCLUDED.completed_pay_at,
               estimated_pay_at = EXCLUDED.estimated_pay_at,
               observed_at = EXCLUDED.observed_at,
               updated_at = clock_timestamp()`,
            [JSON.stringify(reportObservations)],
          );
        }
        if (adjustmentObservations.length > 0) {
          await client.query(
            `INSERT INTO fact.full_home_finance_adjustment_observation (
               observation_key, store_code, report_order_no_hash,
               detail_row_key_hash, report_generated_date, currency,
               direction, amount, goods_count, category, product_key,
               platform_sku_id, platform_skc_id, supplier_sku, unit_price,
               observed_at, updated_at
             )
             SELECT
               x.observation_key, x.store_code, x.report_order_no_hash,
               x.detail_row_key_hash, x.report_generated_date, x.currency,
               x.direction, x.amount, x.goods_count, x.category, x.product_key,
               x.platform_sku_id, x.platform_skc_id, x.supplier_sku,
               x.unit_price, x.observed_at, clock_timestamp()
             FROM jsonb_to_recordset($1::jsonb) AS x(
               observation_key character(64),
               store_code text,
               report_order_no_hash character(64),
               detail_row_key_hash character(64),
               report_generated_date date,
               currency character(3),
               direction text,
               amount numeric,
               goods_count bigint,
               category text,
               product_key text,
               platform_sku_id text,
               platform_skc_id text,
               supplier_sku text,
               unit_price numeric,
               observed_at timestamptz
             )
             ON CONFLICT (observation_key) DO UPDATE SET
               report_generated_date = EXCLUDED.report_generated_date,
               currency = EXCLUDED.currency,
               direction = EXCLUDED.direction,
               amount = EXCLUDED.amount,
               goods_count = EXCLUDED.goods_count,
               category = EXCLUDED.category,
               product_key = EXCLUDED.product_key,
               platform_sku_id = EXCLUDED.platform_sku_id,
               platform_skc_id = EXCLUDED.platform_skc_id,
               supplier_sku = EXCLUDED.supplier_sku,
               unit_price = EXCLUDED.unit_price,
               observed_at = EXCLUDED.observed_at,
               updated_at = clock_timestamp()`,
            [JSON.stringify(adjustmentObservations)],
          );
        }
        await client.query(
          `DELETE FROM fact.full_home_finance_detail_observation
           WHERE store_code = $1
             AND report_generated_date BETWEEN $2::date AND $3::date`,
          [storeCode, startDate, endDate],
        );

        if (detailObservations.length > 0) {
          await client.query(
            `INSERT INTO fact.full_home_finance_detail_observation (
               observation_key, store_code, report_order_no_hash,
               detail_row_key_hash, report_generated_date, business_date,
               currency, direction, amount, goods_count, product_key,
               platform_sku_id, platform_skc_id, supplier_sku, unit_price,
               source_business_at, observed_at, updated_at
             )
             SELECT
               x.observation_key, x.store_code, x.report_order_no_hash,
               x.detail_row_key_hash, x.report_generated_date,
               x.business_date, x.currency, x.direction, x.amount,
               x.goods_count, x.product_key, x.platform_sku_id,
               x.platform_skc_id, x.supplier_sku, x.unit_price,
               x.source_business_at, x.observed_at, clock_timestamp()
             FROM jsonb_to_recordset($1::jsonb) AS x(
               observation_key character(64),
               store_code text,
               report_order_no_hash character(64),
               detail_row_key_hash character(64),
               report_generated_date date,
               business_date date,
               currency character(3),
               direction text,
               amount numeric,
               goods_count bigint,
               product_key text,
               platform_sku_id text,
               platform_skc_id text,
               supplier_sku text,
               unit_price numeric,
               source_business_at timestamptz,
               observed_at timestamptz
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
            [JSON.stringify(detailObservations)],
          );
        }

        let financeDailyRows = 0;
        let productFinanceRows = 0;
        let billDailyRows = 0;
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
        if (affectedReportDates.length > 0) {
          await client.query(
            `DELETE FROM fact.full_home_bill_daily
             WHERE store_code = $1`,
            [storeCode],
          );
          const billResult = await client.query(
            `WITH report_sales AS (
               SELECT
                 store_code,
                 report_order_no_hash,
                 currency,
                 SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END)
                   AS sales_amount
               FROM fact.full_home_finance_detail_observation
               WHERE store_code = $1
               GROUP BY store_code, report_order_no_hash, currency
             ),
             report_adjustments AS (
               SELECT
                 store_code,
                 report_order_no_hash,
                 currency,
                 SUM(CASE WHEN direction = 'SUPPLEMENT' THEN amount ELSE 0 END)
                   AS supplement_amount,
                 SUM(CASE WHEN direction = 'DEDUCTION' THEN amount ELSE 0 END)
                   AS deduction_amount
               FROM fact.full_home_finance_adjustment_observation
               WHERE store_code = $1
               GROUP BY store_code, report_order_no_hash, currency
             ),
             report_rows AS (
               SELECT
                 report.store_code,
                 (report.completed_pay_at AT TIME ZONE 'Asia/Shanghai')::date
                   AS business_date,
                 report.currency,
                 COALESCE(sales.sales_amount, 0) AS sales_amount,
                 COALESCE(adjustment.supplement_amount, 0) AS supplement_amount,
                 COALESCE(adjustment.deduction_amount, 0) AS deduction_amount,
                 report.expected_settlement_amount,
                 report.settlement_status,
                 report.observed_at
               FROM fact.full_home_finance_report_observation AS report
               LEFT JOIN report_sales AS sales
                 ON sales.store_code = report.store_code
                AND sales.report_order_no_hash = report.report_order_no_hash
                AND sales.currency = report.currency
               LEFT JOIN report_adjustments AS adjustment
                 ON adjustment.store_code = report.store_code
                AND adjustment.report_order_no_hash = report.report_order_no_hash
                AND adjustment.currency = report.currency
               WHERE report.store_code = $1
                 AND report.settlement_status = 3
                 AND report.completed_pay_at IS NOT NULL
             ),
             daily AS (
               SELECT
                 store_code,
                 business_date,
                 currency,
                 SUM(sales_amount) AS sales_amount,
                 SUM(supplement_amount) AS supplement_amount,
                 SUM(deduction_amount) AS deduction_amount,
                 SUM(sales_amount + supplement_amount - deduction_amount)
                   AS calculated_settlement_amount,
                 CASE
                   WHEN COUNT(expected_settlement_amount) = COUNT(*)
                     THEN SUM(expected_settlement_amount)
                   ELSE NULL
                 END AS reported_settlement_amount,
                 COUNT(*) AS report_count,
                 COUNT(*) AS settled_report_count,
                 0::bigint AS pending_report_count,
                 MAX(observed_at) AS observed_at
               FROM report_rows
               GROUP BY store_code, business_date, currency
             )
             INSERT INTO fact.full_home_bill_daily (
               store_code, business_date, currency, sales_amount,
               supplement_amount, deduction_amount,
               calculated_settlement_amount, reported_settlement_amount,
               report_count, settled_report_count, pending_report_count,
               reconciliation_status, observed_at, updated_at
             )
             SELECT
               store_code, business_date, currency, sales_amount,
               supplement_amount, deduction_amount,
               calculated_settlement_amount, reported_settlement_amount,
               report_count, settled_report_count, pending_report_count,
               CASE
                 WHEN reported_settlement_amount IS NULL THEN 'UNAVAILABLE'
                 WHEN ABS(
                   calculated_settlement_amount - reported_settlement_amount
                 ) <= 0.01 THEN 'MATCHED'
                 ELSE 'MISMATCH'
               END,
               observed_at,
               clock_timestamp()
             FROM daily`,
            [storeCode],
          );
          billDailyRows = billResult.rowCount ?? 0;
        }
        const priceObservations = detailObservations.filter(
          ({ unit_price: unitPrice, product_key: productKey }) => (
            unitPrice !== null && productKey
          ),
        );
        if (priceObservations.length > 0) {
          await client.query(
            `INSERT INTO fact.full_product_price_observation (
               observation_key, store_code, report_order_no_hash,
               detail_row_key_hash, platform_sku_id, supplier_sku,
               supplier_code, unit_price, amount, goods_count, currency,
               direction, second_order_type, source_business_at, observed_at
             )
             SELECT
               x.observation_key, x.store_code, x.report_order_no_hash,
               x.detail_row_key_hash, x.platform_sku_id, x.supplier_sku,
               NULL, x.unit_price, x.amount, x.goods_count, x.currency,
               x.direction, x.second_order_type, x.source_business_at,
               x.observed_at
             FROM jsonb_to_recordset($1::jsonb) AS x(
               observation_key character(64),
               store_code text,
               report_order_no_hash character(64),
               detail_row_key_hash character(64),
               platform_sku_id text,
               supplier_sku text,
               unit_price numeric,
               amount numeric,
               goods_count bigint,
               currency character(3),
               direction text,
               second_order_type text,
               source_business_at timestamptz,
               observed_at timestamptz
             )
             ON CONFLICT (observation_key) DO NOTHING`,
            [JSON.stringify(priceObservations)],
          );
        }
        await client.query(
          `INSERT INTO ops.full_home_finance_sync_window (
             store_code, start_date, end_date, result_status,
             report_count, detail_count, adjustment_count,
             source_contract_version, observed_at, completed_at,
             sanitized_error_code, updated_at
           ) VALUES (
             $1, $2::date, $3::date, 'SUCCEEDED', $4, $5, $6, 2,
             $7::timestamptz, $8::timestamptz, NULL, clock_timestamp()
           )
           ON CONFLICT (store_code, start_date, end_date) DO UPDATE SET
             result_status = EXCLUDED.result_status,
             report_count = EXCLUDED.report_count,
             detail_count = EXCLUDED.detail_count,
             adjustment_count = EXCLUDED.adjustment_count,
             source_contract_version = EXCLUDED.source_contract_version,
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
            count(adjustments.length),
            observedAt,
            completedAt,
          ],
        );
        await client.query('COMMIT');
        return {
          financeDailyRows,
          productFinanceRows,
          billDailyRows,
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
