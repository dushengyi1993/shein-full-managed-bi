import crypto from 'node:crypto';

import { classifySkuSalesDateQuality } from '../domain/sku-sales-snapshot.mjs';

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

function requireNonEmptyCode(value, location) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${location} must be a non-empty string`);
  }
  return value.trim();
}

function addSalesCount(left, right, location) {
  if (!Number.isSafeInteger(right) || right < 0) {
    throw new TypeError(`${location} must be a non-negative safe integer`);
  }
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new RangeError(`${location} exceeds the safe integer range`);
  }
  return sum;
}

function validateSalesLoadCoverage(store, inventory, sales) {
  const storeCode = requireNonEmptyCode(store?.storeCode, 'store.storeCode');
  const inventoryCodes = new Set();
  for (let index = 0; index < inventory.items.length; index += 1) {
    const skuCode = requireNonEmptyCode(
      inventory.items[index]?.skuCode,
      `inventory.items[${index}].skuCode`,
    );
    if (inventoryCodes.has(skuCode)) {
      throw new Error('Inventory contains a duplicate SKU.');
    }
    inventoryCodes.add(skuCode);
  }

  const snapshotCodes = new Set();
  const statisticsDates = new Set();
  const fetchedAtValues = new Set();
  let datedSkuCount = 0;
  let unanchoredZeroSkuCount = 0;
  let quarantinedSkuCount = 0;
  const totals = {
    salesToday: 0,
    salesYesterday: 0,
    sales7Days: 0,
    sales30Days: 0,
  };
  for (let index = 0; index < sales.snapshots.length; index += 1) {
    const snapshot = sales.snapshots[index];
    const skuCode = requireNonEmptyCode(
      snapshot?.skuCode,
      `sales.snapshots[${index}].skuCode`,
    );
    if (snapshotCodes.has(skuCode)) {
      throw new Error('Sales snapshots contain a duplicate SKU.');
    }
    if (snapshot?.storeCode !== storeCode) {
      throw new Error('Sales snapshot store code does not match the selected store.');
    }
    snapshotCodes.add(skuCode);
    if (typeof snapshot.fetchedAt !== 'string' || Number.isNaN(new Date(snapshot.fetchedAt).valueOf())) {
      throw new TypeError(`sales.snapshots[${index}].fetchedAt must be an ISO date-time string`);
    }
    fetchedAtValues.add(new Date(snapshot.fetchedAt).toISOString());
    const dateQuality = classifySkuSalesDateQuality(snapshot);
    if (dateQuality === 'DATED') {
      datedSkuCount += 1;
      statisticsDates.add(snapshot.statisticsDate);
    } else if (dateQuality === 'LEGAL_ZERO_UNANCHORED') {
      unanchoredZeroSkuCount += 1;
    } else {
      quarantinedSkuCount += 1;
    }
    if (dateQuality === 'DATED') {
      for (const field of Object.keys(totals)) {
        totals[field] = addSalesCount(
          totals[field],
          snapshot[field],
          `sales.snapshots[${index}].${field}`,
        );
      }
    }
  }

  if (
    inventoryCodes.size !== snapshotCodes.size
    || [...inventoryCodes].some((skuCode) => !snapshotCodes.has(skuCode))
  ) {
    throw new Error('Inventory and sales snapshot SKU sets must match exactly before loading.');
  }
  if (inventoryCodes.size === 0) {
    throw new Error('Sales loading requires a non-empty stable SKU inventory.');
  }
  if (fetchedAtValues.size !== 1) {
    throw new Error('All sales batches for one store must use one fetchedAt observation time.');
  }
  if (statisticsDates.size > 1) {
    throw new Error('All dated sales batches for one store must use one statistics date.');
  }
  const [businessDate = null] = statisticsDates;
  if (businessDate !== null) salesWindows(businessDate);

  let evidencedSnapshotCount = 0;
  for (let index = 0; index < sales.batches.length; index += 1) {
    const evidence = sales.batches[index];
    if (evidence?.batchIndex !== index) {
      throw new Error('Sales batch indexes must be contiguous and zero-based.');
    }
    if (
      !Number.isSafeInteger(evidence.skuCount)
      || evidence.skuCount < 1
      || evidence.skuCount > 100
    ) {
      throw new Error('Sales batch SKU count must be an integer from 1 to 100.');
    }
    if (evidence.responseRecordCount !== evidence.skuCount) {
      throw new Error('Sales batch response count must match its requested SKU count.');
    }
    evidencedSnapshotCount += evidence.skuCount;
  }
  if (evidencedSnapshotCount !== sales.snapshots.length) {
    throw new Error('Sales batch evidence must cover every snapshot exactly once.');
  }
  let dateAnchorStatus = 'ANCHORED';
  let qualityStatus = 'VALID';
  let status = 'SUCCEEDED';
  if (quarantinedSkuCount > 0 && datedSkuCount === 0) {
    dateAnchorStatus = 'BLOCKED';
    qualityStatus = 'UNANCHORED_NONZERO';
    status = 'QUALITY_BLOCKED';
  } else if (
    datedSkuCount > 0
    && (unanchoredZeroSkuCount > 0 || quarantinedSkuCount > 0)
  ) {
    dateAnchorStatus = 'PARTIAL';
    qualityStatus = 'PARTIAL';
  } else if (datedSkuCount === 0) {
    dateAnchorStatus = 'UNANCHORED_ZERO';
    qualityStatus = 'LEGAL_ZERO_UNANCHORED';
  }
  return {
    status,
    businessDate,
    dateAnchorStatus,
    qualityStatus,
    requestedSkuCount: inventoryCodes.size,
    responseSkuCount: snapshotCodes.size,
    datedSkuCount,
    unanchoredZeroSkuCount,
    quarantinedSkuCount,
    ...totals,
  };
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
  const values = [
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
  ];
  let result = await client.query(
    `INSERT INTO raw.openapi_fetch_batch (
       store_id, capability_code, endpoint_code, idempotency_key,
       request_fingerprint, metric_window_start, metric_window_end,
       status, http_status, response_record_count, request_payload,
       response_payload, error_code, error_message, completed_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, clock_timestamp()
     )
     ON CONFLICT (store_id, idempotency_key) DO NOTHING
     RETURNING fetch_batch_id`,
    values,
  );
  if (result.rows.length === 0) {
    result = await client.query(
      `SELECT fetch_batch_id
       FROM raw.openapi_fetch_batch
       WHERE store_id = $1
         AND capability_code = $2
         AND endpoint_code = $3
         AND idempotency_key = $4
         AND request_fingerprint = $5
         AND metric_window_start IS NOT DISTINCT FROM $6::timestamptz
         AND metric_window_end IS NOT DISTINCT FROM $7::timestamptz
         AND status = $8
         AND http_status IS NOT DISTINCT FROM $9::integer
         AND response_record_count = $10
         AND request_payload = $11::jsonb
         AND response_payload = $12::jsonb
         AND error_code IS NOT DISTINCT FROM $13::text
         AND error_message IS NOT DISTINCT FROM $14::text`,
      values,
    );
  }
  if (result.rows.length !== 1) {
    throw new Error(
      `Idempotency key ${idempotencyKey} was reused with different request or response evidence.`,
    );
  }
  return result.rows[0].fetch_batch_id;
}

async function upsertSku(client, storeId, item, sourceFetchBatchId, catalogRunKey) {
  const result = await client.query(
    `INSERT INTO dim.full_sku (
       store_id, platform_sku_id, platform_skc_id, supplier_sku,
       sku_name, source_fetch_batch_id, is_active, catalog_run_key,
       retired_at, last_seen_at
     ) VALUES ($1, $2, $3, $4, $5, $6, true, $7, NULL, clock_timestamp())
     ON CONFLICT (store_id, platform_sku_id) DO UPDATE SET
       platform_skc_id = EXCLUDED.platform_skc_id,
       supplier_sku = EXCLUDED.supplier_sku,
       sku_name = EXCLUDED.sku_name,
       source_fetch_batch_id = EXCLUDED.source_fetch_batch_id,
       is_active = true,
       catalog_run_key = EXCLUDED.catalog_run_key,
       retired_at = NULL,
       last_seen_at = clock_timestamp()
     RETURNING full_sku_id`,
    [
      storeId,
      item.skuCode,
      item.skc ?? null,
      item.supplierSku ?? null,
      item.attribute ?? null,
      sourceFetchBatchId,
      catalogRunKey,
    ],
  );
  return result.rows[0].full_sku_id;
}

async function retireMissingCatalogSkus(client, storeId, catalogRunKey) {
  await client.query(
    `UPDATE dim.full_sku
     SET is_active = false,
         retired_at = COALESCE(retired_at, clock_timestamp())
     WHERE store_id = $1
       AND is_active = true
       AND catalog_run_key IS DISTINCT FROM $2`,
    [storeId, catalogRunKey],
  );
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
    const existingValues = [
      storeId,
      fullSkuId,
      fetchBatchId,
      sourceRowKey,
      payloadFingerprint,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      snapshot.fetchedAt,
    ];
    const existing = await client.query(
      `SELECT sales_snapshot_id, payload_fingerprint,
              $5::text AS requested_payload_fingerprint
       FROM fact.full_sku_sales_snapshot
       WHERE (source_fetch_batch_id = $3 AND source_row_key = $4)
          OR (
            store_id = $1 AND full_sku_id = $2
            AND metric_window_start = $6::timestamptz
            AND metric_window_end = $7::timestamptz
            AND snapshot_at = $8::timestamptz
          )`,
      existingValues,
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

async function upsertSalesSyncRun(client, {
  storeId,
  runId,
  coverage,
  sourceFetchedAt,
}) {
  const exposeTotals = coverage.status !== 'QUALITY_BLOCKED';
  const values = [
    storeId,
    runId,
    coverage.status,
    coverage.businessDate,
    coverage.dateAnchorStatus,
    coverage.qualityStatus,
    coverage.requestedSkuCount,
    coverage.responseSkuCount,
    coverage.datedSkuCount,
    coverage.unanchoredZeroSkuCount,
    coverage.quarantinedSkuCount,
    exposeTotals ? coverage.salesToday : null,
    exposeTotals ? coverage.salesYesterday : null,
    exposeTotals ? coverage.sales7Days : null,
    exposeTotals ? coverage.sales30Days : null,
    sourceFetchedAt,
  ];
  let result = await client.query(
    `INSERT INTO ops.sales_sync_run (
       store_id, run_key, status, business_date, date_anchor_status,
       quality_status, requested_sku_count, response_sku_count,
       dated_sku_count, unanchored_zero_sku_count, quarantined_sku_count,
       sales_today, sales_yesterday, sales_7_days, sales_30_days,
       source_fetched_at, completed_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8,
       $9, $10, $11,
       $12, $13, $14, $15,
       $16, clock_timestamp()
     )
     ON CONFLICT (store_id, run_key) DO NOTHING
     RETURNING sales_sync_run_id`,
    values,
  );
  if (result.rows.length === 0) {
    result = await client.query(
      `SELECT sales_sync_run_id
       FROM ops.sales_sync_run
       WHERE store_id = $1
         AND run_key = $2
         AND status = $3
         AND business_date IS NOT DISTINCT FROM $4::date
         AND date_anchor_status = $5
         AND quality_status = $6
         AND requested_sku_count = $7
         AND response_sku_count = $8
         AND dated_sku_count = $9
         AND unanchored_zero_sku_count = $10
         AND quarantined_sku_count = $11
         AND sales_today IS NOT DISTINCT FROM $12::bigint
         AND sales_yesterday IS NOT DISTINCT FROM $13::bigint
         AND sales_7_days IS NOT DISTINCT FROM $14::bigint
         AND sales_30_days IS NOT DISTINCT FROM $15::bigint
         AND source_fetched_at = $16::timestamptz`,
      values,
    );
  }
  if (result.rows.length !== 1) {
    throw new Error(`Sales run ${runId} was reused with different evidence.`);
  }
  return result.rows[0].sales_sync_run_id;
}

async function upsertSalesQualityEvents(client, {
  salesSyncRunId,
  storeId,
  coverage,
  observedAt,
}) {
  const events = [];
  if (coverage.unanchoredZeroSkuCount > 0) {
    events.push({
      code: 'SALES_DATE_UNANCHORED_ZERO',
      severity: 'INFO',
      count: coverage.unanchoredZeroSkuCount,
      details: {
        loadDecision: 'ACCEPT_ZERO_WITHOUT_DATE',
        impact: coverage.datedSkuCount > 0
          ? 'Store coverage is partial because some zero rows have no business date.'
          : 'The store is a legal zero observation, but no business date can be claimed.',
      },
    });
  }
  if (coverage.quarantinedSkuCount > 0) {
    const blocked = coverage.status === 'QUALITY_BLOCKED';
    events.push({
      code: 'SALES_DATE_UNANCHORED_NONZERO',
      severity: blocked ? 'ERROR' : 'WARNING',
      count: coverage.quarantinedSkuCount,
      details: {
        loadDecision: 'QUARANTINE',
        impact: blocked
          ? 'No dated rows were available, so the store was excluded from BI.'
          : 'Unanchored non-zero rows were excluded; dated rows remain visible as partial coverage.',
      },
    });
  }
  for (const event of events) {
    await client.query(
      `INSERT INTO ops.sales_quality_event (
         sales_sync_run_id, store_id, event_code, severity,
         affected_sku_count, details, observed_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (sales_sync_run_id, event_code) DO NOTHING`,
      [
        salesSyncRunId,
        storeId,
        event.code,
        event.severity,
        event.count,
        stableJson(event.details),
        observedAt,
      ],
    );
  }
}

async function advanceBusinessWatermark(client, {
  salesSyncRunId,
  storeId,
  coverage,
  sourceFetchedAt,
}) {
  if (coverage.status === 'QUALITY_BLOCKED' || coverage.businessDate === null) return;
  await client.query(
    `INSERT INTO ops.sales_business_watermark (
       store_id, business_date, sales_sync_run_id, coverage_status, source_fetched_at
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (store_id) DO UPDATE SET
       business_date = EXCLUDED.business_date,
       sales_sync_run_id = EXCLUDED.sales_sync_run_id,
       coverage_status = EXCLUDED.coverage_status,
       source_fetched_at = EXCLUDED.source_fetched_at,
       updated_at = clock_timestamp()
     WHERE EXCLUDED.business_date > ops.sales_business_watermark.business_date
        OR (
          EXCLUDED.business_date = ops.sales_business_watermark.business_date
          AND EXCLUDED.source_fetched_at >= ops.sales_business_watermark.source_fetched_at
        )`,
    [
      storeId,
      coverage.businessDate,
      salesSyncRunId,
      coverage.dateAnchorStatus === 'ANCHORED' ? 'COMPLETE' : 'PARTIAL',
      sourceFetchedAt,
    ],
  );
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
  JOIN dim.full_sku AS active_sku
    ON active_sku.full_sku_id = f.full_sku_id
   AND active_sku.store_id = f.store_id
   AND active_sku.is_active = true
  JOIN ops.sales_business_watermark AS watermark
    ON watermark.store_id = f.store_id
   AND watermark.source_fetched_at = f.snapshot_at
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
  JOIN dim.full_sku AS active_sku
    ON active_sku.full_sku_id = f.full_sku_id
   AND active_sku.store_id = f.store_id
   AND active_sku.is_active = true
  JOIN ops.sales_business_watermark AS watermark
    ON watermark.store_id = f.store_id
   AND watermark.source_fetched_at = f.snapshot_at
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
    statisticsDateAvailable: typeof probe.evidence?.statisticsDateAvailable === 'boolean'
      ? probe.evidence.statisticsDateAvailable
      : null,
    dataLoadable: typeof probe.evidence?.dataLoadable === 'boolean'
      ? probe.evidence.dataLoadable
      : null,
    dataQualityStatus: ['VALID', 'DEGRADED', 'BLOCKED'].includes(probe.evidence?.dataQualityStatus)
      ? probe.evidence.dataQualityStatus
      : null,
    dataQualityReason: [
      'MISSING_STATISTICS_DATE',
      'LEGAL_ZERO_UNANCHORED',
      'UNANCHORED_NONZERO',
    ].includes(probe.evidence?.dataQualityReason)
      ? probe.evidence.dataQualityReason
      : null,
  };
  const values = [
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
  ];
  let result = await client.query(
    `INSERT INTO ops.permission_probe (
       store_id, capability_code, permission_package_code, endpoint_code,
       idempotency_key, outcome, http_status, platform_error_code,
       platform_message, evidence, probed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     ON CONFLICT (store_id, idempotency_key) DO NOTHING
     RETURNING permission_probe_id`,
    values,
  );
  if (result.rows.length === 0) {
    result = await client.query(
      `SELECT permission_probe_id
         FROM ops.permission_probe
        WHERE store_id = $1
          AND capability_code = $2
          AND permission_package_code = $3
          AND endpoint_code = $4
          AND idempotency_key = $5
          AND outcome = $6
          AND http_status IS NOT DISTINCT FROM $7::integer
          AND platform_error_code IS NOT DISTINCT FROM $8::text
          AND platform_message IS NOT DISTINCT FROM $9::text
          AND evidence = $10::jsonb
          AND probed_at = $11::timestamptz`,
      values,
    );
  }
  if (result.rows.length !== 1) {
    throw new Error(
      `Permission probe ${runId} was reused with different evidence.`,
    );
  }
  return result.rows[0].permission_probe_id;
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
  const coverage = validateSalesLoadCoverage(store, inventory, sales);
  const sourceFetchedAt = new Date(sales.snapshots[0].fetchedAt).toISOString();

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
        catalogFingerprint: sha256(stableJson(
          [...inventory.items].sort(
            (left, right) => left.skuCode.localeCompare(right.skuCode),
          ),
        )),
        advertisedSkcCount: inventory.advertisedCount ?? null,
        stableSweepCount: inventory.sweepCount ?? null,
        pages: inventory.pages.map(
          ({ page, recordCount, skcCount, traceId }) => ({
            page,
            recordCount,
            skcCount: skcCount ?? null,
            traceId,
          }),
        ),
      },
      recordCount: inventory.items.length,
    });

    const skuIds = new Map();
    for (const item of inventory.items) {
      skuIds.set(
        item.skuCode,
        await upsertSku(client, storeId, item, inventoryBatchId, runId),
      );
    }
    await retireMissingCatalogSkus(client, storeId, runId);

    let factCount = 0;
    for (let index = 0, offset = 0; index < sales.batches.length; index += 1) {
      const evidence = sales.batches[index];
      const batchSnapshots = sales.snapshots.slice(offset, offset + evidence.skuCount);
      offset += evidence.skuCount;
      if (batchSnapshots.length !== evidence.skuCount) throw new Error('Sales batch evidence is incomplete.');
      const statisticsDates = [...new Set(
        batchSnapshots
          .map(({ statisticsDate }) => statisticsDate)
          .filter((statisticsDate) => statisticsDate !== null),
      )];
      if (statisticsDates.length > 1) throw new Error('One sales batch returned multiple statistics dates.');
      const representativeWindow = statisticsDates.length === 1
        ? salesWindows(statisticsDates[0]).last30Days
        : null;
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
          snapshotFingerprint: sha256(stableJson(
            [...batchSnapshots]
              .sort((left, right) => left.skuCode.localeCompare(right.skuCode))
              .map((snapshot) => ({
                skuCode: snapshot.skuCode,
                statisticsDate: snapshot.statisticsDate,
                salesToday: snapshot.salesToday,
                salesYesterday: snapshot.salesYesterday,
                sales7Days: snapshot.sales7Days,
                sales30Days: snapshot.sales30Days,
              })),
          )),
          traceId: evidence.traceId,
          message: evidence.message,
          datedRecordCount: batchSnapshots.filter(({ statisticsDate }) => statisticsDate !== null).length,
          unanchoredRecordCount: batchSnapshots.filter(({ statisticsDate }) => statisticsDate === null).length,
        },
        recordCount: evidence.responseRecordCount,
        metricWindowStart: representativeWindow?.[0].toISOString() ?? null,
        metricWindowEnd: representativeWindow?.[1].toISOString() ?? null,
      });
      for (const snapshot of batchSnapshots) {
        const fullSkuId = skuIds.get(snapshot.skuCode);
        if (!fullSkuId) throw new Error(`Sales response SKU ${snapshot.skuCode} is missing from inventory.`);
        if (snapshot.statisticsDate === null) continue;
        factCount += await insertSnapshotFacts(client, {
          storeId,
          fullSkuId,
          fetchBatchId,
          snapshot,
        });
      }
    }

    const salesSyncRunId = await upsertSalesSyncRun(client, {
      storeId,
      runId,
      coverage,
      sourceFetchedAt,
    });
    await upsertSalesQualityEvents(client, {
      salesSyncRunId,
      storeId,
      coverage,
      observedAt: sourceFetchedAt,
    });
    await advanceBusinessWatermark(client, {
      salesSyncRunId,
      storeId,
      coverage,
      sourceFetchedAt,
    });

    const isBlocked = coverage.status === 'QUALITY_BLOCKED';
    const isAnchored = coverage.dateAnchorStatus === 'ANCHORED';
    const isLegalZero = coverage.dateAnchorStatus === 'UNANCHORED_ZERO';
    const hasQuarantinedRows = coverage.quarantinedSkuCount > 0;
    await insertProbe(client, {
      storeId,
      runId,
      permissionPackageCode,
      probe: {
        outcome: 'GRANTED',
        httpStatus: 200,
        platformErrorCode: null,
        platformMessage: isBlocked
          ? 'Sales access granted; non-zero rows without dt were quarantined.'
          : hasQuarantinedRows
            ? 'Sales access granted; dated rows loaded with partial coverage and unanchored non-zero rows quarantined.'
          : isLegalZero
            ? 'Sales access granted; complete zero-sales response had no dt.'
            : coverage.dateAnchorStatus === 'PARTIAL'
              ? 'Sales access granted; dated rows loaded and unanchored zero rows recorded as partial coverage.'
              : 'Complete inventory and sales snapshot loaded.',
        evidence: {
          endpointReached: SKU_SALES_ENDPOINT,
          salesEndpointExercised: true,
          statisticsDateAvailable: isAnchored,
          dataLoadable: !isBlocked,
          dataQualityStatus: isBlocked ? 'BLOCKED' : isAnchored ? 'VALID' : 'DEGRADED',
          dataQualityReason: isBlocked
            ? 'UNANCHORED_NONZERO'
            : hasQuarantinedRows
              ? 'UNANCHORED_NONZERO'
            : isLegalZero
              ? 'LEGAL_ZERO_UNANCHORED'
              : coverage.dateAnchorStatus === 'PARTIAL'
                ? 'MISSING_STATISTICS_DATE'
                : null,
        },
        probedAt: sourceFetchedAt ?? new Date().toISOString(),
      },
    });
    await refreshFullManagedSalesMarts(client);
    const result = {
      storeCode: store.storeCode,
      skuCount: inventory.items.length,
      factCount,
      batchCount: 1 + sales.batches.length,
    };
    if (!isAnchored) {
      result.qualityStatus = coverage.qualityStatus;
      result.businessDate = coverage.businessDate;
      result.quarantinedSkuCount = coverage.quarantinedSkuCount;
      result.unanchoredZeroSkuCount = coverage.unanchoredZeroSkuCount;
    }
    return result;
  });
}
