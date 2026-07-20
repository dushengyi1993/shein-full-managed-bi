import crypto from 'node:crypto';

const SALES_CAPABILITY = 'FULL_MANAGED_SKU_SALES';
const NUMBER_LIST_ENDPOINT = 'goods.number-list';
const SKU_SALES_ENDPOINT = 'goods.query-sku-sales';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function requireSafeRunId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,120}$/.test(value)) {
    throw new TypeError('runId must be 8-120 safe identifier characters');
  }
  return value;
}

function midnightShanghai(date) {
  return new Date(`${date}T00:00:00.000+08:00`);
}

function addUtcDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

export function salesWindows(statisticsDate) {
  if (typeof statisticsDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(statisticsDate)) {
    throw new TypeError('statisticsDate must be YYYY-MM-DD');
  }
  const dayStart = midnightShanghai(statisticsDate);
  const localParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(dayStart);
  const localValues = Object.fromEntries(localParts.map(({ type, value }) => [type, value]));
  const localDate = `${localValues.year}-${localValues.month}-${localValues.day}`;
  if (Number.isNaN(dayStart.valueOf()) || localDate !== statisticsDate) {
    throw new TypeError('statisticsDate must be a valid calendar date');
  }
  const nextDay = addUtcDays(dayStart, 1);
  return Object.freeze({
    today: [dayStart, nextDay],
    yesterday: [addUtcDays(dayStart, -1), dayStart],
    last7Days: [addUtcDays(dayStart, -6), nextDay],
    last30Days: [addUtcDays(dayStart, -29), nextDay],
  });
}

function safeStore(store) {
  return {
    storeCode: store.storeCode,
    storeName: store.storeName ?? store.storeCode,
    legalEntityName: store.legalEntityName ?? null,
    platformShopId: store.platformShopId ?? null,
  };
}

async function upsertStore(client, store) {
  const safe = safeStore(store);
  const result = await client.query(
    `INSERT INTO dim.store (
       store_code, store_name, legal_entity_name, platform_shop_id,
       cooperation_mode, is_active, last_seen_at
     ) VALUES ($1, $2, $3, $4, 'FULL_MANAGED', true, clock_timestamp())
     ON CONFLICT (store_code) DO UPDATE SET
       store_name = EXCLUDED.store_name,
       legal_entity_name = EXCLUDED.legal_entity_name,
       platform_shop_id = COALESCE(EXCLUDED.platform_shop_id, dim.store.platform_shop_id),
       is_active = true,
       last_seen_at = clock_timestamp()
     RETURNING store_id`,
    [safe.storeCode, safe.storeName, safe.legalEntityName, safe.platformShopId],
  );
  return result.rows[0].store_id;
}

async function upsertRawBatch(client, {
  storeId,
  capabilityCode,
  endpointCode,
  idempotencyKey,
  requestPayload,
  responsePayload,
  recordCount,
  metricWindowStart = null,
  metricWindowEnd = null,
  status = 'SUCCEEDED',
  httpStatus = 200,
  errorCode = null,
  errorMessage = null,
}) {
  const requestFingerprint = sha256(stableJson(requestPayload));
  const result = await client.query(
    `INSERT INTO raw.openapi_fetch_batch (
       store_id, capability_code, endpoint_code, idempotency_key,
       request_fingerprint, metric_window_start, metric_window_end,
       status, http_status, response_record_count, request_payload,
       response_payload, error_code, error_message, completed_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, clock_timestamp()
     )
     ON CONFLICT (store_id, idempotency_key) DO UPDATE SET
       status = EXCLUDED.status,
       http_status = EXCLUDED.http_status,
       response_record_count = EXCLUDED.response_record_count,
       response_payload = EXCLUDED.response_payload,
       error_code = EXCLUDED.error_code,
       error_message = EXCLUDED.error_message,
       completed_at = EXCLUDED.completed_at
     WHERE raw.openapi_fetch_batch.request_fingerprint = EXCLUDED.request_fingerprint
     RETURNING fetch_batch_id`,
    [
      storeId,
      capabilityCode,
      endpointCode,
      idempotencyKey,
      requestFingerprint,
      metricWindowStart,
      metricWindowEnd,
      status,
      httpStatus,
      recordCount,
      stableJson(requestPayload),
      stableJson(responsePayload),
      errorCode,
      errorMessage,
    ],
  );
  if (result.rows.length !== 1) {
    throw new Error(`Idempotency key ${idempotencyKey} was reused with a different request fingerprint.`);
  }
  return result.rows[0].fetch_batch_id;
}

async function upsertSku(client, storeId, item, sourceFetchBatchId) {
  const result = await client.query(
    `INSERT INTO dim.full_sku (
       store_id, platform_sku_id, platform_skc_id, supplier_sku,
       sku_name, source_fetch_batch_id, last_seen_at
     ) VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())
     ON CONFLICT (store_id, platform_sku_id) DO UPDATE SET
       platform_skc_id = EXCLUDED.platform_skc_id,
       supplier_sku = EXCLUDED.supplier_sku,
       sku_name = EXCLUDED.sku_name,
       source_fetch_batch_id = EXCLUDED.source_fetch_batch_id,
       last_seen_at = clock_timestamp()
     RETURNING full_sku_id`,
    [
      storeId,
      item.skuCode,
      item.skc ?? null,
      item.supplierSku ?? null,
      item.attribute ?? null,
      sourceFetchBatchId,
    ],
  );
  return result.rows[0].full_sku_id;
}

async function insertSnapshotFacts(client, {
  storeId,
  fullSkuId,
  fetchBatchId,
  snapshot,
}) {
  const windows = salesWindows(snapshot.statisticsDate);
  const quantities = {
    today: snapshot.salesToday,
    yesterday: snapshot.salesYesterday,
    last7Days: snapshot.sales7Days,
    last30Days: snapshot.sales30Days,
  };
  let affected = 0;
  for (const [windowCode, [windowStart, windowEnd]] of Object.entries(windows)) {
    const sourceRowKey = `${windowCode}:${snapshot.skuCode}`;
    const payloadFingerprint = sha256(stableJson({
      skuCode: snapshot.skuCode,
      statisticsDate: snapshot.statisticsDate,
      windowCode,
      quantity: quantities[windowCode],
    }));
    const values = [
      storeId,
      fullSkuId,
      fetchBatchId,
      sourceRowKey,
      payloadFingerprint,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      snapshot.fetchedAt,
      quantities[windowCode],
    ];
    const existing = await client.query(
      `SELECT sales_snapshot_id, payload_fingerprint
       FROM fact.full_sku_sales_snapshot
       WHERE (source_fetch_batch_id = $3 AND source_row_key = $4)
          OR (
            store_id = $1 AND full_sku_id = $2
            AND metric_window_start = $6 AND metric_window_end = $7
            AND snapshot_at = $8
          )
       FOR UPDATE`,
      values,
    );
    if (existing.rows.length > 0) {
      if (existing.rows.some((row) => row.payload_fingerprint !== payloadFingerprint)) {
        throw new Error(`Snapshot grain for ${snapshot.storeCode}/${snapshot.skuCode}/${windowCode} drifted.`);
      }
      affected += 1;
      continue;
    }
    const result = await client.query(
      `INSERT INTO fact.full_sku_sales_snapshot (
         store_id, full_sku_id, source_fetch_batch_id, source_row_key,
         payload_fingerprint, metric_window_start, metric_window_end,
         snapshot_at, sales_quantity
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING sales_snapshot_id`,
      values,
    );
    if (result.rows.length !== 1) {
      throw new Error(`Snapshot grain for ${snapshot.storeCode}/${snapshot.skuCode}/${windowCode} drifted.`);
    }
    affected += 1;
  }
  return affected;
}

export const REFRESH_STORE_MART_SQL = `
DELETE FROM mart.full_store_sales_latest;
WITH ranked AS (
  SELECT f.*,
         row_number() OVER (
           PARTITION BY f.store_id, f.full_sku_id, f.metric_window_start, f.metric_window_end
           ORDER BY f.snapshot_at DESC, f.updated_at DESC, f.sales_snapshot_id DESC
         ) AS recency
  FROM fact.full_sku_sales_snapshot AS f
), latest AS (
  SELECT * FROM ranked WHERE recency = 1
)
INSERT INTO mart.full_store_sales_latest (
  store_id, metric_window_start, metric_window_end, latest_snapshot_at,
  sales_quantity, sku_count, product_count, source_fact_count,
  source_max_fact_updated_at, refreshed_at
)
SELECT
  latest.store_id,
  latest.metric_window_start,
  latest.metric_window_end,
  max(latest.snapshot_at),
  sum(latest.sales_quantity),
  count(DISTINCT latest.full_sku_id)::integer,
  count(DISTINCT sku.product_key)::integer,
  count(*)::integer,
  max(latest.updated_at),
  clock_timestamp()
FROM latest
JOIN dim.full_sku AS sku ON sku.full_sku_id = latest.full_sku_id
GROUP BY latest.store_id, latest.metric_window_start, latest.metric_window_end`;

export const REFRESH_PRODUCT_MART_SQL = `
DELETE FROM mart.full_product_sales_latest;
WITH ranked AS (
  SELECT f.*,
         row_number() OVER (
           PARTITION BY f.store_id, f.full_sku_id, f.metric_window_start, f.metric_window_end
           ORDER BY f.snapshot_at DESC, f.updated_at DESC, f.sales_snapshot_id DESC
         ) AS recency
  FROM fact.full_sku_sales_snapshot AS f
), latest AS (
  SELECT * FROM ranked WHERE recency = 1
)
INSERT INTO mart.full_product_sales_latest (
  store_id, product_key, platform_spu_id, platform_skc_id, product_name,
  metric_window_start, metric_window_end, latest_snapshot_at,
  sales_quantity, sku_count, source_fact_count,
  source_max_fact_updated_at, refreshed_at
)
SELECT
  latest.store_id,
  sku.product_key,
  max(sku.platform_spu_id),
  max(sku.platform_skc_id),
  max(sku.product_name),
  latest.metric_window_start,
  latest.metric_window_end,
  max(latest.snapshot_at),
  sum(latest.sales_quantity),
  count(DISTINCT latest.full_sku_id)::integer,
  count(*)::integer,
  max(latest.updated_at),
  clock_timestamp()
FROM latest
JOIN dim.full_sku AS sku ON sku.full_sku_id = latest.full_sku_id
GROUP BY latest.store_id, sku.product_key, latest.metric_window_start, latest.metric_window_end`;

export async function refreshFullManagedSalesMarts(client) {
  await client.query(REFRESH_STORE_MART_SQL);
  await client.query(REFRESH_PRODUCT_MART_SQL);
}

async function insertProbe(client, {
  storeId,
  runId,
  permissionPackageCode,
  probe,
}) {
  const safeEvidence = {
    endpointReached: probe.evidence?.endpointReached ?? null,
    salesEndpointExercised: probe.evidence?.salesEndpointExercised === true,
  };
  await client.query(
    `INSERT INTO ops.permission_probe (
       store_id, capability_code, permission_package_code, endpoint_code,
       idempotency_key, outcome, http_status, platform_error_code,
       platform_message, evidence, probed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     ON CONFLICT (store_id, idempotency_key) DO NOTHING`,
    [
      storeId,
      SALES_CAPABILITY,
      permissionPackageCode,
      SKU_SALES_ENDPOINT,
      `${runId}:probe`,
      probe.outcome,
      probe.httpStatus ?? null,
      probe.platformErrorCode ?? null,
      probe.platformMessage ?? null,
      stableJson(safeEvidence),
      probe.probedAt,
    ],
  );
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('full-managed-sales-loader'))");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function persistPermissionProbe(pool, {
  store,
  runId,
  permissionPackageCode,
  probe,
}) {
  requireSafeRunId(runId);
  return transaction(pool, async (client) => {
    const storeId = await upsertStore(client, store);
    await insertProbe(client, { storeId, runId, permissionPackageCode, probe });
    return { storeCode: store.storeCode, outcome: probe.outcome };
  });
}

export async function loadFullManagedSalesSync(pool, {
  store,
  runId,
  permissionPackageCode,
  inventory,
  sales,
}) {
  requireSafeRunId(runId);
  if (!Array.isArray(inventory?.items) || !Array.isArray(inventory?.pages)) {
    throw new TypeError('inventory result is invalid');
  }
  if (!Array.isArray(sales?.snapshots) || !Array.isArray(sales?.batches)) {
    throw new TypeError('sales result is invalid');
  }
  if (sales.snapshots.length !== inventory.items.length) {
    throw new Error('Every inventory SKU must have exactly one complete sales snapshot before loading.');
  }

  return transaction(pool, async (client) => {
    const storeId = await upsertStore(client, store);
    const inventoryBatchId = await upsertRawBatch(client, {
      storeId,
      capabilityCode: 'FULL_MANAGED_SKU_IDENTITY',
      endpointCode: NUMBER_LIST_ENDPOINT,
      idempotencyKey: `${runId}:number-list`,
      requestPayload: {
        type: 1,
        pageSize: inventory.pages[0]?.perPage ?? null,
        pageCount: inventory.pages.length,
      },
      responsePayload: {
        code: '0',
        recordCount: inventory.items.length,
        pages: inventory.pages.map(({ page, recordCount, traceId }) => ({ page, recordCount, traceId })),
      },
      recordCount: inventory.items.length,
    });

    const skuIds = new Map();
    for (const item of inventory.items) {
      skuIds.set(item.skuCode, await upsertSku(client, storeId, item, inventoryBatchId));
    }

    let factCount = 0;
    for (let index = 0, offset = 0; index < sales.batches.length; index += 1) {
      const evidence = sales.batches[index];
      const batchSnapshots = sales.snapshots.slice(offset, offset + evidence.skuCount);
      offset += evidence.skuCount;
      if (batchSnapshots.length !== evidence.skuCount) throw new Error('Sales batch evidence is incomplete.');
      const statisticsDates = [...new Set(batchSnapshots.map(({ statisticsDate }) => statisticsDate))];
      if (statisticsDates.length !== 1) throw new Error('One sales batch returned multiple statistics dates.');
      const representativeWindow = salesWindows(statisticsDates[0]).last30Days;
      const fetchBatchId = await upsertRawBatch(client, {
        storeId,
        capabilityCode: SALES_CAPABILITY,
        endpointCode: SKU_SALES_ENDPOINT,
        idempotencyKey: `${runId}:sku-sales:${index}`,
        requestPayload: {
          batchIndex: index,
          skuCount: evidence.skuCount,
          skuSetFingerprint: sha256(stableJson(batchSnapshots.map(({ skuCode }) => skuCode).sort())),
        },
        responsePayload: {
          code: '0',
          recordCount: evidence.responseRecordCount,
          traceId: evidence.traceId,
          message: evidence.message,
        },
        recordCount: evidence.responseRecordCount,
        metricWindowStart: representativeWindow[0].toISOString(),
        metricWindowEnd: representativeWindow[1].toISOString(),
      });
      for (const snapshot of batchSnapshots) {
        const fullSkuId = skuIds.get(snapshot.skuCode);
        if (!fullSkuId) throw new Error(`Sales response SKU ${snapshot.skuCode} is missing from inventory.`);
        factCount += await insertSnapshotFacts(client, {
          storeId,
          fullSkuId,
          fetchBatchId,
          snapshot,
        });
      }
    }

    await insertProbe(client, {
      storeId,
      runId,
      permissionPackageCode,
      probe: {
        outcome: 'GRANTED',
        httpStatus: 200,
        platformErrorCode: null,
        platformMessage: 'Complete inventory and sales snapshot loaded.',
        evidence: { endpointReached: SKU_SALES_ENDPOINT, salesEndpointExercised: true },
        probedAt: sales.snapshots[0]?.fetchedAt ?? new Date().toISOString(),
      },
    });
    await refreshFullManagedSalesMarts(client);
    return {
      storeCode: store.storeCode,
      skuCount: inventory.items.length,
      factCount,
      batchCount: 1 + sales.batches.length,
    };
  });
}
