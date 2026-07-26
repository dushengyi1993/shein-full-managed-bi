import {
  payloadFingerprint,
  stableJson,
} from '../openapi/paginated-fetch.mjs';

const ENDPOINTS = Object.freeze({
  productCatalog: 'openapi-business-backend.product.query',
  productDetails: 'openapi-business-backend.product.full-detail',
  inventory: 'stock.stock-query',
  stockAdvice: 'openapi-business-backend.stock-goods-list',
  purchaseOrders: 'order.purchase-order-infos',
  deliveries: 'shipping.delivery',
});

function normalizedPublicImageUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return null;
  }
  url.hash = '';
  url.search = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'https:' && url.port === '443')
    || (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }
  return url.toString();
}

export function productImageUrlHash(value) {
  const normalizedUrl = normalizedPublicImageUrl(value);
  return normalizedUrl === null
    ? null
    : payloadFingerprint({ normalizedPublicImageUrl: normalizedUrl });
}

export const SUPPLY_DASHBOARD_SQL = Object.freeze({
  purchaseOrderStatus: `
    SELECT
      po.store_id,
      store.store_code,
      store.store_name,
      COALESCE(po.status_code, 'UNKNOWN') AS status_code,
      max(po.status_name) AS status_name,
      count(*)::bigint AS order_count,
      max(po.source_fetched_at) AS latest_source_fetched_at
    FROM fact.purchase_order AS po
    JOIN dim.store AS store ON store.store_id = po.store_id
    WHERE ($1::bigint[] IS NULL OR po.store_id = ANY($1::bigint[]))
    GROUP BY po.store_id, store.store_code, store.store_name,
             COALESCE(po.status_code, 'UNKNOWN')
    ORDER BY store.store_code, status_code`,
  deliveryMilestones: `
    WITH delivery_state AS (
      SELECT
        delivery.*,
        CASE
          WHEN delivery.received_at IS NOT NULL THEN 'RECEIVED'
          WHEN delivery.taken_at IS NOT NULL THEN 'IN_TRANSIT'
          WHEN delivery.reserved_parcel_at IS NOT NULL THEN 'PICKUP_RESERVED'
          ELSE 'CREATED'
        END AS milestone_code
      FROM fact.delivery AS delivery
      WHERE ($1::bigint[] IS NULL OR delivery.store_id = ANY($1::bigint[]))
    )
    SELECT
      delivery_state.store_id,
      store.store_code,
      store.store_name,
      delivery_state.milestone_code,
      count(*)::bigint AS delivery_count,
      sum(line_totals.delivery_quantity)::bigint AS delivery_quantity,
      COALESCE(sum(line_totals.known_delivery_quantity_line_count), 0)::bigint
        AS known_delivery_quantity_line_count,
      COALESCE(sum(line_totals.total_delivery_line_count), 0)::bigint
        AS total_delivery_line_count,
      max(delivery_state.source_fetched_at) AS latest_source_fetched_at
    FROM delivery_state
    JOIN dim.store AS store ON store.store_id = delivery_state.store_id
    LEFT JOIN (
      SELECT
        store_id,
        delivery_id,
        sum(delivery_quantity)::bigint AS delivery_quantity,
        count(delivery_quantity)::bigint AS known_delivery_quantity_line_count,
        count(*)::bigint AS total_delivery_line_count
      FROM fact.delivery_line
      WHERE is_current
      GROUP BY store_id, delivery_id
    ) AS line_totals
      ON line_totals.store_id = delivery_state.store_id
     AND line_totals.delivery_id = delivery_state.delivery_id
    GROUP BY delivery_state.store_id, store.store_code, store.store_name,
             delivery_state.milestone_code
    ORDER BY store.store_code, delivery_state.milestone_code`,
  inventory: `
    WITH ranked_batch AS (
      SELECT
        batch.*,
        row_number() OVER (
          PARTITION BY batch.store_id, batch.subtype_code
          ORDER BY batch.source_fetched_at DESC,
                   batch.supply_projection_batch_id DESC
        ) AS recency
      FROM fact.supply_projection_batch AS batch
      WHERE batch.domain_code = 'INVENTORY'
        AND ($1::bigint[] IS NULL OR batch.store_id = ANY($1::bigint[]))
    ),
    latest_batch AS (
      SELECT *
      FROM ranked_batch
      WHERE recency = 1
    )
    SELECT
      latest_batch.store_id,
      store.store_code,
      store.store_name,
      latest_batch.subtype_code AS inventory_type_code,
      latest_batch.coverage_status_code,
      latest_batch.requested_count,
      latest_batch.observed_count,
      latest_batch.member_count,
      count(snapshot.inventory_snapshot_id)::bigint AS sku_count,
      (latest_batch.member_count
       - count(snapshot.inventory_snapshot_id))::bigint AS inactive_filtered_sku_count,
      CASE
        WHEN latest_batch.coverage_status_code = 'COMPLETE'
         AND count(snapshot.inventory_snapshot_id) = latest_batch.member_count
          THEN COALESCE(sum(snapshot.total_inventory_quantity), 0)::bigint
        ELSE NULL
      END AS inventory_quantity,
      CASE
        WHEN latest_batch.coverage_status_code = 'COMPLETE'
         AND count(snapshot.inventory_snapshot_id) = latest_batch.member_count
          THEN COALESCE(sum(snapshot.total_usable_inventory), 0)::bigint
        ELSE NULL
      END AS usable_inventory,
      CASE
        WHEN latest_batch.coverage_status_code = 'COMPLETE'
         AND count(snapshot.inventory_snapshot_id) = latest_batch.member_count
         AND count(snapshot.total_transit_quantity) = latest_batch.member_count
          THEN COALESCE(sum(snapshot.total_transit_quantity), 0)::bigint
        ELSE NULL
      END AS transit_quantity,
      count(snapshot.total_transit_quantity)::bigint AS transit_known_sku_count,
      CASE
        WHEN latest_batch.coverage_status_code = 'COMPLETE'
         AND count(snapshot.inventory_snapshot_id) = latest_batch.member_count
         AND count(snapshot.total_out_of_stock_quantity) = latest_batch.member_count
          THEN count(*) FILTER (
            WHERE snapshot.total_out_of_stock_quantity > 0
          )::bigint
        ELSE NULL
      END AS shortage_sku_count,
      CASE
        WHEN latest_batch.coverage_status_code = 'COMPLETE'
         AND count(snapshot.inventory_snapshot_id) = latest_batch.member_count
         AND count(snapshot.total_out_of_stock_quantity) = latest_batch.member_count
          THEN COALESCE(sum(snapshot.total_out_of_stock_quantity), 0)::bigint
        ELSE NULL
      END AS shortage_quantity,
      count(snapshot.total_out_of_stock_quantity)::bigint AS shortage_known_sku_count,
      CASE
        WHEN latest_batch.coverage_status_code = 'COMPLETE'
         AND count(snapshot.inventory_snapshot_id) = latest_batch.member_count
          THEN count(*) FILTER (
            WHERE snapshot.reconciliation_status = 'MISMATCH'
          )::bigint
        ELSE NULL
      END AS reconciliation_mismatch_count,
      latest_batch.source_fetch_batch_id,
      latest_batch.source_fetched_at AS latest_source_fetched_at
    FROM latest_batch
    JOIN dim.store AS store ON store.store_id = latest_batch.store_id
    LEFT JOIN fact.supply_projection_member AS membership
      ON membership.store_id = latest_batch.store_id
     AND membership.supply_projection_batch_id
         = latest_batch.supply_projection_batch_id
    LEFT JOIN dim.full_sku AS sku
      ON sku.store_id = membership.store_id
     AND sku.platform_sku_id = membership.sku_code
     AND sku.is_active
    LEFT JOIN fact.inventory_snapshot AS snapshot
      ON snapshot.store_id = latest_batch.store_id
     AND snapshot.source_fetch_batch_id = latest_batch.source_fetch_batch_id
     AND snapshot.inventory_type_code = latest_batch.subtype_code
     AND snapshot.sku_code = membership.sku_code
     AND sku.full_sku_id IS NOT NULL
    GROUP BY
      latest_batch.supply_projection_batch_id,
      latest_batch.store_id,
      latest_batch.subtype_code,
      latest_batch.coverage_status_code,
      latest_batch.requested_count,
      latest_batch.observed_count,
      latest_batch.member_count,
      latest_batch.source_fetch_batch_id,
      latest_batch.source_fetched_at,
      store.store_code,
      store.store_name
    ORDER BY store.store_code, latest_batch.subtype_code`,
  stockAdvice: `
    WITH ranked_batch AS (
      SELECT
        batch.*,
        row_number() OVER (
          PARTITION BY batch.store_id, batch.subtype_code
          ORDER BY batch.source_fetched_at DESC,
                   batch.supply_projection_batch_id DESC
        ) AS recency
      FROM fact.supply_projection_batch AS batch
      WHERE batch.domain_code = 'STOCK_ADVICE'
        AND ($1::bigint[] IS NULL OR batch.store_id = ANY($1::bigint[]))
    ),
    latest_batch AS (
      SELECT *
      FROM ranked_batch
      WHERE recency = 1
    )
    SELECT
      latest_batch.store_id,
      store.store_code,
      store.store_name,
      latest_batch.coverage_status_code,
      latest_batch.requested_count,
      latest_batch.observed_count,
      latest_batch.member_count,
      count(advice.stock_advice_snapshot_id)::bigint AS total_sku_count,
      (latest_batch.member_count
       - count(advice.stock_advice_snapshot_id))::bigint AS inactive_filtered_sku_count,
      count(advice.advised_order_quantity)::bigint AS advised_order_known_sku_count,
      CASE
        WHEN latest_batch.coverage_status_code = 'COMPLETE'
         AND count(advice.stock_advice_snapshot_id) = latest_batch.member_count
         AND count(advice.advised_order_quantity) = latest_batch.member_count
          THEN count(*) FILTER (
            WHERE advice.advised_order_quantity > 0
          )::bigint
        ELSE NULL
      END AS advised_sku_count,
      CASE
        WHEN latest_batch.coverage_status_code = 'COMPLETE'
         AND count(advice.stock_advice_snapshot_id) = latest_batch.member_count
         AND count(advice.advised_order_quantity) = latest_batch.member_count
          THEN COALESCE(sum(advice.advised_order_quantity), 0)::bigint
        ELSE NULL
      END AS advised_order_quantity,
      count(advice.planned_urgent_quantity)::bigint
        AS planned_urgent_known_sku_count,
      CASE
        WHEN latest_batch.coverage_status_code = 'COMPLETE'
         AND count(advice.stock_advice_snapshot_id) = latest_batch.member_count
         AND count(advice.planned_urgent_quantity) = latest_batch.member_count
          THEN COALESCE(sum(advice.planned_urgent_quantity), 0)::bigint
        ELSE NULL
      END AS planned_urgent_quantity,
      count(*) FILTER (
        WHERE advice.stock_warning_observed
      )::bigint AS warning_known_sku_count,
      CASE
        WHEN latest_batch.coverage_status_code = 'COMPLETE'
         AND count(advice.stock_advice_snapshot_id) = latest_batch.member_count
         AND count(*) FILTER (
           WHERE advice.stock_warning_observed
         ) = latest_batch.member_count
          THEN count(*) FILTER (
            WHERE advice.stock_warning_observed
              AND advice.stock_warning_is_warning
          )::bigint
        ELSE NULL
      END AS warning_sku_count,
      latest_batch.source_fetch_batch_id,
      latest_batch.source_fetched_at AS latest_source_fetched_at
    FROM latest_batch
    JOIN dim.store AS store ON store.store_id = latest_batch.store_id
    LEFT JOIN fact.supply_projection_member AS membership
      ON membership.store_id = latest_batch.store_id
     AND membership.supply_projection_batch_id
         = latest_batch.supply_projection_batch_id
    LEFT JOIN dim.full_sku AS sku
      ON sku.store_id = membership.store_id
     AND sku.platform_sku_id = membership.sku_code
     AND sku.is_active
    LEFT JOIN fact.stock_advice_snapshot AS advice
      ON advice.store_id = latest_batch.store_id
     AND advice.source_fetch_batch_id = latest_batch.source_fetch_batch_id
     AND advice.sku_code = membership.sku_code
     AND sku.full_sku_id IS NOT NULL
    GROUP BY
      latest_batch.supply_projection_batch_id,
      latest_batch.store_id,
      latest_batch.coverage_status_code,
      latest_batch.requested_count,
      latest_batch.observed_count,
      latest_batch.member_count,
      latest_batch.source_fetch_batch_id,
      latest_batch.source_fetched_at,
      store.store_code,
      store.store_name
    ORDER BY store.store_code`,
});

export const SUPPLY_SYNC_HEALTH_SQL = `
  WITH ranked AS (
    SELECT
      attempt.*,
      row_number() OVER (
        PARTITION BY
          attempt.store_id,
          attempt.domain_code,
          attempt.subtype_code,
          attempt.freshness_scope_code
        ORDER BY
          COALESCE(attempt.completed_at, attempt.started_at) DESC,
          attempt.supply_sync_attempt_event_id DESC
      ) AS recency
    FROM ops.supply_sync_attempt AS attempt
    WHERE ($1::bigint[] IS NULL OR attempt.store_id = ANY($1::bigint[]))
      AND ($2::text IS NULL OR attempt.freshness_scope_code = $2)
  )
  SELECT
    ranked.store_id,
    store.store_code,
    store.store_name,
    ranked.attempt_id,
    ranked.domain_code,
    ranked.subtype_code,
    ranked.mode_code,
    ranked.freshness_scope_code,
    ranked.window_start_at,
    ranked.window_end_at,
    ranked.requested_count,
    ranked.observed_count,
    ranked.status_code,
    ranked.error_code,
    ranked.error_reason,
    ranked.started_at,
    ranked.completed_at
  FROM ranked
  JOIN dim.store AS store ON store.store_id = ranked.store_id
  WHERE ranked.recency = 1
  ORDER BY store.store_code, ranked.domain_code, ranked.subtype_code`;

function requireRunId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,120}$/.test(value)) {
    throw new TypeError('runId must be 8-120 safe identifier characters');
  }
  return value;
}

function requireText(value, location) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${location} must be a non-empty string`);
  }
  return value.trim();
}

function isoDate(value, location) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (
    (typeof value !== 'string' && !(value instanceof Date))
    || Number.isNaN(date.valueOf())
  ) {
    throw new TypeError(`${location} must be a valid date-time`);
  }
  return date.toISOString();
}

function safeStore(store) {
  return {
    storeCode: requireText(store?.storeCode, 'store.storeCode').toUpperCase(),
    storeName: typeof store?.storeName === 'string' && store.storeName.trim()
      ? store.storeName.trim()
      : requireText(store?.storeCode, 'store.storeCode').toUpperCase(),
    legalEntityName: typeof store?.legalEntityName === 'string'
      ? store.legalEntityName.trim() || null
      : null,
    platformShopId: typeof store?.platformShopId === 'string'
      ? store.platformShopId.trim() || null
      : null,
  };
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Sales number-list is the sole dim.full_sku membership authority. Supply
    // enrichment therefore shares its lock instead of racing a retirement
    // sweep under a separate advisory lock.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('full-managed-sales-loader'))");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original */ }
    throw error;
  } finally {
    client.release();
  }
}

function safeAttemptCode(value, location) {
  const code = requireText(value, location).toUpperCase();
  if (!/^[A-Z0-9_:-]{1,80}$/.test(code)) {
    throw new TypeError(`${location} contains unsupported characters`);
  }
  return code;
}

function optionalAttemptCount(value, location) {
  if (value === undefined || value === null) return null;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`${location} must be a non-negative safe integer or null`);
  }
  return count;
}

function sanitizedAttemptError(value, location) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${location} must be text`);
  return value
    .replace(/\b(?:bearer|token|secret|password|authorization)\s*[:=]?\s*\S+/gi, '[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/(?:\+?\d[\d ().-]{6,}\d)/g, '[REDACTED_PHONE]')
    .trim()
    .slice(0, 500) || null;
}

async function attemptTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Append one immutable state event for a supply sync attempt. STARTED and one
 * terminal event share attemptId. LIVE and BACKFILL scopes are deliberately
 * separate so historical repair never refreshes the live-health clock.
 */
export async function recordFullManagedSupplySyncAttempt(pool, {
  store,
  attemptId,
  domain,
  subtype = null,
  mode,
  freshnessScope = null,
  window = null,
  requestedCount = null,
  observedCount = null,
  status,
  errorCode = null,
  errorReason = null,
  sourceFetchBatchId = null,
  startedAt,
  completedAt = null,
} = {}) {
  requireRunId(attemptId);
  if (!Object.hasOwn(ENDPOINTS, domain)) {
    throw new TypeError(`Unknown supply domain ${domain}`);
  }
  const domainCode = domain.replaceAll(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  const subtypeCode = safeAttemptCode(
    subtype ?? (domain === 'inventory' ? '' : 'ALL'),
    'subtype',
  );
  if (domain === 'inventory' && !['PI', 'VI', 'JI'].includes(subtypeCode)) {
    throw new TypeError('inventory subtype must be PI, VI or JI');
  }
  const modeCode = safeAttemptCode(mode, 'mode');
  const scopeCode = safeAttemptCode(
    freshnessScope ?? (modeCode === 'BACKFILL' ? 'BACKFILL' : 'LIVE'),
    'freshnessScope',
  );
  if (!['LIVE', 'BACKFILL'].includes(scopeCode)) {
    throw new TypeError('freshnessScope must be LIVE or BACKFILL');
  }
  const statusCode = safeAttemptCode(status, 'status');
  if (!['STARTED', 'SUCCEEDED', 'PARTIAL', 'FAILED'].includes(statusCode)) {
    throw new TypeError('status must be STARTED, SUCCEEDED, PARTIAL or FAILED');
  }
  const started = isoDate(startedAt, 'startedAt');
  const completed = completedAt === null || completedAt === undefined
    ? null
    : isoDate(completedAt, 'completedAt');
  if (
    (statusCode === 'STARTED' && completed !== null)
    || (statusCode !== 'STARTED' && completed === null)
    || (completed !== null && completed < started)
  ) {
    throw new TypeError('attempt status and started/completed timestamps are inconsistent');
  }
  const startWindow = window?.start === undefined || window?.start === null
    ? null
    : isoDate(window.start, 'window.start');
  const endWindow = window?.end === undefined || window?.end === null
    ? null
    : isoDate(window.end, 'window.end');
  if ((startWindow === null) !== (endWindow === null) || (
    endWindow !== null && endWindow < startWindow
  )) {
    throw new TypeError('window.start and window.end must form an ordered pair');
  }
  const requested = optionalAttemptCount(requestedCount, 'requestedCount');
  const observed = optionalAttemptCount(observedCount, 'observedCount');
  if (requested !== null && observed !== null && observed > requested) {
    throw new TypeError('observedCount cannot exceed requestedCount');
  }
  if (
    statusCode === 'SUCCEEDED'
    && requested !== null
    && observed !== null
    && observed !== requested
  ) {
    throw new TypeError('SUCCEEDED requires observedCount to equal requestedCount');
  }
  const safeErrorCode = statusCode === 'PARTIAL' && !errorCode
    ? 'PARTIAL_COVERAGE'
    : sanitizedAttemptError(errorCode, 'errorCode');
  const safeErrorReason = statusCode === 'PARTIAL' && !errorReason
    ? 'The platform response did not cover every requested identifier.'
    : sanitizedAttemptError(errorReason, 'errorReason');
  if (
    (['PARTIAL', 'FAILED'].includes(statusCode)
      && (!safeErrorCode || !safeErrorReason))
    || (!['PARTIAL', 'FAILED'].includes(statusCode)
      && (safeErrorCode || safeErrorReason))
  ) {
    throw new TypeError('only PARTIAL/FAILED attempts require a sanitized error code and reason');
  }
  const batchId = sourceFetchBatchId === null || sourceFetchBatchId === undefined
    ? null
    : optionalAttemptCount(sourceFetchBatchId, 'sourceFetchBatchId');
  if (batchId !== null && batchId < 1) {
    throw new TypeError('sourceFetchBatchId must be positive');
  }
  const event = {
    attemptId,
    domainCode,
    subtypeCode,
    modeCode,
    scopeCode,
    startWindow,
    endWindow,
    requested,
    observed,
    statusCode,
    safeErrorCode,
    safeErrorReason,
    batchId,
    started,
    completed,
  };
  const fingerprint = payloadFingerprint(event);

  return attemptTransaction(pool, async (client) => {
    const storeId = await upsertStore(client, store, started);
    const inserted = await client.query(
      `INSERT INTO ops.supply_sync_attempt (
         store_id, attempt_id, domain_code, subtype_code, mode_code,
         freshness_scope_code, window_start_at, window_end_at,
         requested_count, observed_count, status_code,
         error_code, error_reason, source_fetch_batch_id,
         request_fingerprint, started_at, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11,
         $12, $13, $14,
         $15, $16, $17
       )
       ON CONFLICT DO NOTHING
       RETURNING supply_sync_attempt_event_id`,
      [
        storeId,
        attemptId,
        domainCode,
        subtypeCode,
        modeCode,
        scopeCode,
        startWindow,
        endWindow,
        requested,
        observed,
        statusCode,
        safeErrorCode,
        safeErrorReason,
        batchId,
        fingerprint,
        started,
        completed,
      ],
    );
    if ((inserted.rowCount ?? inserted.rows.length) > 0) {
      return Object.freeze({
        attemptEventId: inserted.rows[0]?.supply_sync_attempt_event_id ?? null,
        ...event,
      });
    }
    const existing = await client.query(
      `SELECT supply_sync_attempt_event_id, request_fingerprint
       FROM ops.supply_sync_attempt
       WHERE store_id = $1
         AND domain_code = $2
         AND subtype_code = $3
         AND attempt_id = $4
         AND status_code = $5`,
      [storeId, domainCode, subtypeCode, attemptId, statusCode],
    );
    if (
      existing.rows.length !== 1
      || existing.rows[0].request_fingerprint !== fingerprint
    ) {
      throw new Error(
        `Supply attempt ${attemptId}/${domainCode}/${subtypeCode} replay drifted`,
      );
    }
    return Object.freeze({
      attemptEventId: existing.rows[0].supply_sync_attempt_event_id,
      ...event,
    });
  });
}

async function upsertStore(client, store, sourceFetchedAt) {
  const safe = safeStore(store);
  const result = await client.query(
    `INSERT INTO dim.store (
       store_code, store_name, legal_entity_name, platform_shop_id,
       cooperation_mode, first_seen_at, last_seen_at
     ) VALUES ($1, $2, $3, $4, 'FULL_MANAGED', $5, $5)
     ON CONFLICT (store_code) DO UPDATE SET
       store_name = EXCLUDED.store_name,
       legal_entity_name = COALESCE(EXCLUDED.legal_entity_name, dim.store.legal_entity_name),
       platform_shop_id = COALESCE(EXCLUDED.platform_shop_id, dim.store.platform_shop_id),
       last_seen_at = GREATEST(dim.store.last_seen_at, EXCLUDED.last_seen_at)
     WHERE EXCLUDED.last_seen_at >= dim.store.last_seen_at
     RETURNING store_id`,
    [
      safe.storeCode,
      safe.storeName,
      safe.legalEntityName,
      safe.platformShopId,
      sourceFetchedAt,
    ],
  );
  if (result.rows.length > 0) return result.rows[0].store_id;
  const existing = await client.query(
    'SELECT store_id FROM dim.store WHERE store_code = $1',
    [safe.storeCode],
  );
  if (existing.rows.length !== 1) throw new Error(`Store ${safe.storeCode} could not be resolved`);
  return existing.rows[0].store_id;
}

async function upsertRawBatch(client, {
  storeId,
  runId,
  domain,
  requestEvidence,
  recordCount,
  sourceFetchedAt,
}) {
  const endpointCode = ENDPOINTS[domain];
  if (!endpointCode) throw new TypeError(`Unknown supply domain ${domain}`);
  const capabilityCode = (
    `FULL_MANAGED_${domain.replaceAll(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`
  );
  const idempotencyKey = `${runId}:${domain}`;
  const requestFingerprint = payloadFingerprint(requestEvidence ?? {});
  const responseEvidence = { recordCount };
  const requestPayload = stableJson(requestEvidence ?? {});
  const responsePayload = stableJson(responseEvidence);
  const result = await client.query(
    `INSERT INTO raw.openapi_fetch_batch (
       store_id, capability_code, endpoint_code, idempotency_key,
       request_fingerprint, status, http_status, response_record_count,
       request_payload, response_payload, started_at, completed_at
     ) VALUES (
       $1, $2, $3, $4, $5, 'SUCCEEDED', 200, $6,
       $7::jsonb, $8::jsonb, $9, $9
     )
     ON CONFLICT (store_id, idempotency_key) DO NOTHING
     RETURNING fetch_batch_id`,
    [
      storeId,
      capabilityCode,
      endpointCode,
      idempotencyKey,
      requestFingerprint,
      recordCount,
      requestPayload,
      responsePayload,
      sourceFetchedAt,
    ],
  );
  if (result.rows.length > 0) return result.rows[0].fetch_batch_id;
  const existing = await client.query(
    `SELECT
       fetch_batch_id, capability_code, endpoint_code,
       request_fingerprint, response_record_count,
       request_payload, response_payload, started_at, completed_at
     FROM raw.openapi_fetch_batch
     WHERE store_id = $1 AND idempotency_key = $2`,
    [storeId, idempotencyKey],
  );
  if (existing.rows.length !== 1) throw new Error(`Raw batch ${domain} could not be resolved`);
  const row = existing.rows[0];
  const exactReplay = (
    row.capability_code === capabilityCode
    && row.endpoint_code === endpointCode
    && row.request_fingerprint === requestFingerprint
    && Number(row.response_record_count) === recordCount
    && stableJson(row.request_payload) === requestPayload
    && stableJson(row.response_payload) === responsePayload
    && isoDate(row.started_at, 'raw batch started_at') === sourceFetchedAt
    && isoDate(row.completed_at, 'raw batch completed_at') === sourceFetchedAt
  );
  if (!exactReplay) {
    throw new Error(
      `Raw batch ${domain} idempotency key was reused with non-identical source evidence`,
    );
  }
  return row.fetch_batch_id;
}

async function upsertPageEvidence(client, {
  storeId,
  fetchBatchId,
  endpointCode,
  pages,
  requestEvidence,
  sourceFetchedAt,
}) {
  for (const page of pages ?? []) {
    const pageNumber = Number(page.page ?? page.batchIndex + 1);
    const pageSize = Number(page.pageSize ?? page.skuCount ?? page.recordCount);
    const recordCount = Number(page.recordCount ?? page.responseCount ?? page.skuCount ?? 0);
    if (
      !Number.isSafeInteger(pageNumber)
      || pageNumber < 1
      || !Number.isSafeInteger(pageSize)
      || pageSize < 1
      || !Number.isSafeInteger(recordCount)
      || recordCount < 0
      || recordCount > pageSize
    ) {
      throw new TypeError('page evidence contains invalid page/count metadata');
    }
    const requestHash = page.requestFingerprint ?? payloadFingerprint({
      requestEvidence,
      page: pageNumber,
      pageSize,
    });
    const responseHash = page.responseFingerprint ?? payloadFingerprint({
      page: pageNumber,
      recordCount,
    });
    const metadata = stableJson({ terminalEvidence: recordCount < pageSize });
    const inserted = await client.query(
      `INSERT INTO raw.openapi_fetch_page (
         store_id, source_fetch_batch_id, endpoint_code,
         page_number, page_size, response_record_count,
         request_fingerprint, response_fingerprint,
         source_fetched_at, sanitized_metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (store_id, source_fetch_batch_id, endpoint_code, page_number)
       DO NOTHING
       RETURNING openapi_fetch_page_id`,
      [
        storeId,
        fetchBatchId,
        endpointCode,
        pageNumber,
        pageSize,
        recordCount,
        requestHash,
        responseHash,
        sourceFetchedAt,
        metadata,
      ],
    );
    if ((inserted.rowCount ?? inserted.rows.length) > 0) continue;
    const existing = await client.query(
      `SELECT
         page_size, response_record_count,
         request_fingerprint, response_fingerprint,
         source_fetched_at, sanitized_metadata
       FROM raw.openapi_fetch_page
       WHERE store_id = $1
         AND source_fetch_batch_id = $2
         AND endpoint_code = $3
         AND page_number = $4`,
      [storeId, fetchBatchId, endpointCode, pageNumber],
    );
    if (existing.rows.length !== 1) {
      throw new Error(`Raw page ${endpointCode}#${pageNumber} could not be resolved`);
    }
    const row = existing.rows[0];
    const exactReplay = (
      Number(row.page_size) === pageSize
      && Number(row.response_record_count) === recordCount
      && row.request_fingerprint === requestHash
      && row.response_fingerprint === responseHash
      && isoDate(row.source_fetched_at, 'raw page source_fetched_at') === sourceFetchedAt
      && stableJson(row.sanitized_metadata) === metadata
    );
    if (!exactReplay) {
      throw new Error(
        `Raw page ${endpointCode}#${pageNumber} was replayed with non-identical evidence`,
      );
    }
  }
}

function stableCatalogFingerprint(products) {
  return payloadFingerprint(
    [...products]
      .map((product) => ({
        spuName: product.spuName,
        skcName: product.skcName,
        skuCodes: [...product.skuCodes].sort(),
      }))
      .sort((left, right) => (
        String(left.skcName).localeCompare(String(right.skcName))
        || String(left.spuName).localeCompare(String(right.spuName))
      )),
  );
}

function requireStableCatalog(productCatalog) {
  if (
    productCatalog?.stable !== true
    || !Array.isArray(productCatalog.products)
    || !Array.isArray(productCatalog.sweeps)
    || productCatalog.sweeps.length < 2
  ) {
    throw new Error(
      'Product catalog enrichment requires two consecutive identical complete sweeps',
    );
  }
  const skuCodes = [];
  for (const [productIndex, product] of productCatalog.products.entries()) {
    if (!Array.isArray(product?.skuCodes)) {
      throw new TypeError(`productCatalog.products[${productIndex}].skuCodes must be an array`);
    }
    skuCodes.push(...product.skuCodes);
  }
  if (new Set(skuCodes).size !== skuCodes.length) {
    throw new Error('Stable product catalog contains duplicate SKU membership evidence');
  }
  const fingerprint = stableCatalogFingerprint(productCatalog.products);
  const productCount = productCatalog.products.length;
  const skuCount = skuCodes.length;
  const lastTwo = productCatalog.sweeps.slice(-2);
  const stableEvidence = lastTwo.every((sweep) => (
    sweep.catalogFingerprint === fingerprint
    && Number(sweep.productCount) === productCount
    && Number(sweep.skuCount) === skuCount
    && ['EMPTY_PAGE', 'SHORT_PAGE'].includes(sweep.terminalReason)
  ));
  if (
    productCatalog.catalogFingerprint !== fingerprint
    || Number(productCatalog.productCount) !== productCount
    || Number(productCatalog.skuCount) !== skuCount
    || !stableEvidence
  ) {
    throw new Error('Product catalog stable-sweep evidence does not match its payload');
  }
  return { fingerprint, productCount, skuCount };
}

async function enrichCatalog(client, {
  storeId,
  fetchBatchId,
  sourceFetchedAt,
  productCatalog,
}) {
  let enrichedCount = 0;
  let unresolvedCount = 0;
  for (const product of productCatalog?.products ?? []) {
    for (const skuCode of product.skuCodes) {
      const result = await client.query(
        `UPDATE dim.full_sku
         SET platform_skc_id = COALESCE($3, platform_skc_id),
             platform_spu_id = COALESCE($4, platform_spu_id),
             supply_catalog_source_fetch_batch_id = $5,
             supply_catalog_source_fetched_at = $6
         WHERE store_id = $1
           AND platform_sku_id = $2
           AND (
             supply_catalog_source_fetched_at IS NULL
             OR supply_catalog_source_fetched_at <= $6
           )
         RETURNING full_sku_id`,
        [
          storeId,
          skuCode,
          product.skcName,
          product.spuName,
          fetchBatchId,
          sourceFetchedAt,
        ],
      );
      if ((result.rowCount ?? result.rows.length) > 0) enrichedCount += 1;
      else {
        const existing = await client.query(
          `SELECT full_sku_id
           FROM dim.full_sku
           WHERE store_id = $1 AND platform_sku_id = $2`,
          [storeId, skuCode],
        );
        // A newer prior enrichment is resolved; a missing sales-authority SKU
        // is deliberately not inserted by the supply domain.
        if (existing.rows.length === 1) enrichedCount += 1;
        else unresolvedCount += 1;
      }
    }
  }
  return { enrichedCount, unresolvedCount };
}

async function enrichProductDetails(client, {
  storeId,
  fetchBatchId,
  sourceFetchedAt,
  productDetails,
}) {
  let enrichedCount = 0;
  let unresolvedCount = 0;
  for (const detail of productDetails.details) {
    const mainImageUrlHash = productImageUrlHash(detail.mainImageUrl);
    const result = await client.query(
      `UPDATE dim.full_sku
       SET platform_skc_id = COALESCE($3, platform_skc_id),
           platform_spu_id = COALESCE($4, platform_spu_id),
           supplier_sku = COALESCE($5, supplier_sku),
           supplier_code = COALESCE($6, supplier_code),
           product_name = COALESCE($7, product_name),
           category_id = COALESCE($8, category_id),
           category_name = COALESCE($9, category_name),
           product_type_id = COALESCE($10, product_type_id),
           brand_code = COALESCE($11, brand_code),
           main_image_url_hash = COALESCE($12, main_image_url_hash),
           dimension_length = COALESCE($13, dimension_length),
           dimension_width = COALESCE($14, dimension_width),
           dimension_height = COALESCE($15, dimension_height),
           dimension_weight = COALESCE($16, dimension_weight),
           stop_purchase_code = COALESCE($17, stop_purchase_code),
           detail_source_fetch_batch_id = $18,
           detail_source_fetched_at = $19
       WHERE store_id = $1
         AND platform_sku_id = $2
         AND (
           detail_source_fetched_at IS NULL
           OR detail_source_fetched_at <= $19
         )
       RETURNING full_sku_id`,
      [
        storeId,
        detail.skuCode,
        detail.skcName,
        detail.spuName,
        detail.supplierSku,
        detail.supplierCode,
        detail.productName,
        detail.categoryId,
        detail.categoryName,
        detail.productTypeId,
        detail.brandCode,
        mainImageUrlHash,
        detail.dimensions?.length ?? null,
        detail.dimensions?.width ?? null,
        detail.dimensions?.height ?? null,
        detail.dimensions?.weight ?? null,
        detail.stopPurchaseCode,
        fetchBatchId,
        sourceFetchedAt,
      ],
    );
    if ((result.rowCount ?? result.rows.length) > 0) enrichedCount += 1;
    else {
      const existing = await client.query(
        `SELECT full_sku_id
         FROM dim.full_sku
         WHERE store_id = $1 AND platform_sku_id = $2`,
        [storeId, detail.skuCode],
      );
      if (existing.rows.length === 1) enrichedCount += 1;
      else unresolvedCount += 1;
    }
  }
  return { enrichedCount, unresolvedCount };
}

async function upsertWarehouse(client, {
  storeId,
  fetchBatchId,
  sourceFetchedAt,
  warehouseCode,
  warehouseTypeCode,
  warehouseName = null,
}) {
  const fingerprint = payloadFingerprint({ warehouseCode, warehouseTypeCode, warehouseName });
  const result = await client.query(
    `INSERT INTO dim.full_warehouse (
       store_id, warehouse_code, warehouse_type_code, warehouse_name,
       source_fetch_batch_id, payload_fingerprint, source_fetched_at,
       first_seen_at, last_seen_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)
     ON CONFLICT (store_id, warehouse_code, warehouse_type_code) DO UPDATE SET
       warehouse_name = COALESCE(EXCLUDED.warehouse_name, dim.full_warehouse.warehouse_name),
       source_fetch_batch_id = EXCLUDED.source_fetch_batch_id,
       payload_fingerprint = EXCLUDED.payload_fingerprint,
       source_fetched_at = EXCLUDED.source_fetched_at,
       last_seen_at = EXCLUDED.last_seen_at
     WHERE EXCLUDED.source_fetched_at >= dim.full_warehouse.source_fetched_at
     RETURNING full_warehouse_id`,
    [
      storeId,
      requireText(warehouseCode, 'warehouseCode'),
      requireText(warehouseTypeCode, 'warehouseTypeCode'),
      warehouseName,
      fetchBatchId,
      fingerprint,
      sourceFetchedAt,
    ],
  );
  if (result.rows.length > 0) return result.rows[0].full_warehouse_id;
  const existing = await client.query(
    `SELECT full_warehouse_id
     FROM dim.full_warehouse
     WHERE store_id = $1 AND warehouse_code = $2 AND warehouse_type_code = $3`,
    [storeId, warehouseCode, warehouseTypeCode],
  );
  if (existing.rows.length !== 1) throw new Error(`Warehouse ${warehouseCode} could not be resolved`);
  return existing.rows[0].full_warehouse_id;
}

function normalizeProjectionCoverage(coverage, memberCount, domain) {
  if (!coverage || !['COMPLETE', 'PARTIAL'].includes(coverage.status)) {
    throw new TypeError(`${domain} coverage.status must be COMPLETE or PARTIAL`);
  }
  const requestedCount = coverage.requestedCount === null
    || coverage.requestedCount === undefined
    ? null
    : Number(coverage.requestedCount);
  const observedCount = coverage.observedCount === null
    || coverage.observedCount === undefined
    ? memberCount
    : Number(coverage.observedCount);
  if (
    (requestedCount !== null
      && (!Number.isSafeInteger(requestedCount) || requestedCount < 0))
    || !Number.isSafeInteger(observedCount)
    || observedCount < 0
    || (requestedCount !== null && observedCount > requestedCount)
    || (coverage.status === 'PARTIAL' && requestedCount === null)
  ) {
    throw new TypeError(`${domain} coverage counts are inconsistent`);
  }
  return Object.freeze({
    status: coverage.status,
    requestedCount,
    observedCount,
    memberCount,
  });
}

async function recordProjectionBatch(client, {
  storeId,
  domain,
  subtype,
  coverage,
  fetchBatchId,
  sourceFetchedAt,
  members,
  authorityFingerprint = null,
}) {
  const canonicalMembers = canonicalRowSet(members);
  const memberSkuCodes = canonicalMembers.map(({ skuCode }) => skuCode);
  if (
    memberSkuCodes.some((skuCode) => typeof skuCode !== 'string' || skuCode === '')
    || new Set(memberSkuCodes).size !== memberSkuCodes.length
    || coverage.memberCount !== memberSkuCodes.length
  ) {
    throw new Error(`${domain}/${subtype} projection membership is inconsistent`);
  }
  const fingerprint = payloadFingerprint({
    domain,
    subtype,
    coverage,
    authorityFingerprint,
    members: canonicalMembers,
  });
  const inserted = await client.query(
    `INSERT INTO fact.supply_projection_batch (
       store_id, domain_code, subtype_code, coverage_status_code,
       requested_count, observed_count, member_count,
       source_fetch_batch_id, payload_fingerprint, source_fetched_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT DO NOTHING
     RETURNING supply_projection_batch_id`,
    [
      storeId,
      domain,
      subtype,
      coverage.status,
      coverage.requestedCount,
      coverage.observedCount,
      coverage.memberCount,
      fetchBatchId,
      fingerprint,
      sourceFetchedAt,
    ],
  );
  let projectionBatchId = inserted.rows[0]?.supply_projection_batch_id ?? null;
  if (!projectionBatchId) {
    const existing = await client.query(
      `SELECT
         supply_projection_batch_id, coverage_status_code,
         requested_count, observed_count, member_count,
         source_fetch_batch_id, payload_fingerprint, source_fetched_at
       FROM fact.supply_projection_batch
       WHERE store_id = $1
         AND domain_code = $2
         AND subtype_code = $3
         AND (
           source_fetch_batch_id = $4
           OR source_fetched_at = $5
         )`,
      [storeId, domain, subtype, fetchBatchId, sourceFetchedAt],
    );
    if (existing.rows.length !== 1) {
      throw new Error(`${domain}/${subtype} projection batch could not be resolved`);
    }
    const row = existing.rows[0];
    if (
      row.coverage_status_code !== coverage.status
      || (row.requested_count === null ? null : Number(row.requested_count))
        !== coverage.requestedCount
      || Number(row.observed_count) !== coverage.observedCount
      || Number(row.member_count) !== coverage.memberCount
      || row.payload_fingerprint !== fingerprint
      || isoDate(row.source_fetched_at, 'projection source_fetched_at') !== sourceFetchedAt
    ) {
      throw new Error(`${domain}/${subtype} projection batch replay drifted`);
    }
    projectionBatchId = row.supply_projection_batch_id;
  }

  for (const skuCode of memberSkuCodes) {
    const memberFingerprint = payloadFingerprint({
      domain,
      subtype,
      projectionBatchId,
      skuCode,
    });
    const memberResult = await client.query(
      `INSERT INTO fact.supply_projection_member (
         store_id, supply_projection_batch_id, sku_code,
         source_fetch_batch_id, payload_fingerprint, source_fetched_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING supply_projection_member_id`,
      [
        storeId,
        projectionBatchId,
        skuCode,
        fetchBatchId,
        memberFingerprint,
        sourceFetchedAt,
      ],
    );
    if ((memberResult.rowCount ?? memberResult.rows.length) > 0) continue;
    const existingMember = await client.query(
      `SELECT source_fetch_batch_id, payload_fingerprint, source_fetched_at
       FROM fact.supply_projection_member
       WHERE store_id = $1
         AND supply_projection_batch_id = $2
         AND sku_code = $3`,
      [storeId, projectionBatchId, skuCode],
    );
    const row = existingMember.rows[0];
    if (
      existingMember.rows.length !== 1
      || row.payload_fingerprint !== memberFingerprint
      || isoDate(row.source_fetched_at, 'projection member source_fetched_at')
        !== sourceFetchedAt
    ) {
      throw new Error(`${domain}/${subtype}/${skuCode} projection member replay drifted`);
    }
  }
  return projectionBatchId;
}

async function insertReconciliation(client, {
  storeId,
  fetchBatchId,
  sourceFetchedAt,
  skuCode,
  inventoryType,
  reconciliation,
}) {
  for (const check of reconciliation.checks) {
    const keyInput = {
      domain: 'INVENTORY',
      skuCode,
      inventoryType,
      metric: check.metric,
      sourceFetchedAt,
    };
    const key = payloadFingerprint(keyInput);
    const fingerprint = payloadFingerprint({ ...keyInput, ...check });
    await client.query(
      `INSERT INTO ops.reconciliation_result (
         store_id, reconciliation_key, domain_code, entity_key, metric_code,
         status_code, aggregate_quantity, detail_quantity, difference_quantity,
         explanation, details, source_fetch_batch_id,
         payload_fingerprint, source_fetched_at
       ) VALUES (
         $1, $2, 'INVENTORY', $3, $4,
         $5, $6, $7, $8,
         $9, $10::jsonb, $11,
         $12, $13
       )
       ON CONFLICT (store_id, reconciliation_key) DO UPDATE SET
         status_code = EXCLUDED.status_code,
         aggregate_quantity = EXCLUDED.aggregate_quantity,
         detail_quantity = EXCLUDED.detail_quantity,
         difference_quantity = EXCLUDED.difference_quantity,
         explanation = EXCLUDED.explanation,
         details = EXCLUDED.details,
         source_fetch_batch_id = EXCLUDED.source_fetch_batch_id,
         payload_fingerprint = EXCLUDED.payload_fingerprint,
         source_fetched_at = EXCLUDED.source_fetched_at
       WHERE EXCLUDED.source_fetched_at >= ops.reconciliation_result.source_fetched_at`,
      [
        storeId,
        key,
        `${inventoryType}:${skuCode}`,
        check.metric,
        check.status,
        check.aggregate,
        check.warehouseSum,
        check.aggregate === null || check.warehouseSum === null
          ? null
          : check.aggregate - check.warehouseSum,
        reconciliation.explanation,
        stableJson({ reconciliationStatus: reconciliation.status }),
        fetchBatchId,
        fingerprint,
        sourceFetchedAt,
      ],
    );
  }
}

async function readActiveSkuCodes(client, storeId) {
  const result = await client.query(
    `SELECT platform_sku_id
     FROM dim.full_sku
     WHERE store_id = $1 AND is_active
     ORDER BY platform_sku_id`,
    [storeId],
  );
  return result.rows.map(({ platform_sku_id: skuCode }) => (
    requireText(skuCode, 'dim.full_sku.platform_sku_id')
  ));
}

async function loadInventory(client, {
  storeId,
  fetchBatchId,
  inventory,
  sourceFetchedAt,
}) {
  if (inventory.queryDimension !== 'SKU' || !Array.isArray(inventory.requestedCodes)) {
    throw new Error('Current inventory projection requires an exact requested SKU set');
  }
  const requestedSet = new Set(inventory.requestedCodes);
  const itemBySku = new Map(inventory.items.map((item) => [item.skuCode, item]));
  if (
    requestedSet.size !== inventory.requestedCodes.length
    || itemBySku.size !== inventory.items.length
    || [...itemBySku.keys()].some((skuCode) => !requestedSet.has(skuCode))
  ) {
    throw new Error('Inventory projection contains duplicate or unrequested observed SKUs');
  }
  const activeSkuCodes = await readActiveSkuCodes(client, storeId);
  const missingActiveSkuCodes = activeSkuCodes.filter((skuCode) => (
    !requestedSet.has(skuCode) || !itemBySku.has(skuCode)
  ));
  const members = activeSkuCodes
    .filter((skuCode) => itemBySku.has(skuCode))
    .map((skuCode) => itemBySku.get(skuCode));
  const coverage = Object.freeze({
    status: missingActiveSkuCodes.length === 0 ? 'COMPLETE' : 'PARTIAL',
    requestedCount: activeSkuCodes.length,
    observedCount: members.length,
    memberCount: members.length,
  });
  await recordProjectionBatch(client, {
    storeId,
    domain: 'INVENTORY',
    subtype: requireText(inventory.inventoryType, 'inventory.inventoryType').toUpperCase(),
    coverage,
    fetchBatchId,
    sourceFetchedAt,
    members,
    authorityFingerprint: payloadFingerprint(activeSkuCodes),
  });
  let warehouseCount = 0;
  for (const item of inventory.items) {
    const sourceRowKey = `${inventory.inventoryType}:${item.skuCode}`;
    const fingerprint = payloadFingerprint(item);
    const result = await client.query(
      `INSERT INTO fact.inventory_snapshot (
         store_id, sku_code, skc_name, spu_name, inventory_type_code,
         total_inventory_quantity, total_locked_quantity,
         total_temp_lock_quantity, total_usable_inventory,
         total_out_of_stock_quantity, total_transit_quantity,
         reconciliation_status, source_fetch_batch_id, source_row_key,
         payload_fingerprint, source_fetched_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11,
         $12, $13, $14,
         $15, $16
       )
       ON CONFLICT (store_id, sku_code, inventory_type_code, source_fetched_at)
       DO NOTHING
       RETURNING inventory_snapshot_id`,
      [
        storeId,
        item.skuCode,
        item.skcName,
        item.spuName,
        inventory.inventoryType,
        item.totalInventoryQuantity,
        item.totalLockedQuantity,
        item.totalTempLockQuantity,
        item.totalUsableInventory,
        item.totalOutOfStockQty,
        item.totalTransitQuantity,
        item.reconciliation.status,
        fetchBatchId,
        sourceRowKey,
        fingerprint,
        sourceFetchedAt,
      ],
    );
    let inventorySnapshotId = result.rows[0]?.inventory_snapshot_id ?? null;
    if (!inventorySnapshotId) {
      const existing = await client.query(
        `SELECT inventory_snapshot_id, payload_fingerprint, source_fetched_at
         FROM fact.inventory_snapshot
         WHERE store_id = $1
           AND sku_code = $2
           AND inventory_type_code = $3
           AND source_fetched_at = $4`,
        [storeId, item.skuCode, inventory.inventoryType, sourceFetchedAt],
      );
      const row = existing.rows[0];
      if (
        existing.rows.length !== 1
        || row.payload_fingerprint !== fingerprint
        || isoDate(row.source_fetched_at, 'inventory source_fetched_at')
          !== sourceFetchedAt
      ) {
        throw new Error(`Inventory snapshot ${item.skuCode} replay drifted`);
      }
      inventorySnapshotId = row.inventory_snapshot_id;
    }
    for (const warehouse of item.warehouses) {
      const warehouseId = await upsertWarehouse(client, {
        storeId,
        fetchBatchId,
        sourceFetchedAt,
        warehouseCode: warehouse.warehouseCode,
        warehouseTypeCode: warehouse.warehouseTypeCode,
      });
      const warehouseFingerprint = payloadFingerprint(warehouse);
      await client.query(
        `INSERT INTO fact.warehouse_inventory_snapshot (
           store_id, inventory_snapshot_id, full_warehouse_id,
           inventory_quantity, locked_quantity, temp_lock_quantity,
           usable_inventory, out_of_stock_quantity, transit_quantity,
           source_fetch_batch_id, payload_fingerprint, source_fetched_at
         ) VALUES (
           $1, $2, $3,
           $4, $5, $6,
           $7, $8, $9,
           $10, $11, $12
         )
         ON CONFLICT (store_id, inventory_snapshot_id, full_warehouse_id)
         DO UPDATE SET
           inventory_quantity = EXCLUDED.inventory_quantity,
           locked_quantity = EXCLUDED.locked_quantity,
           temp_lock_quantity = EXCLUDED.temp_lock_quantity,
           usable_inventory = EXCLUDED.usable_inventory,
           out_of_stock_quantity = EXCLUDED.out_of_stock_quantity,
           transit_quantity = EXCLUDED.transit_quantity,
           source_fetch_batch_id = EXCLUDED.source_fetch_batch_id,
           payload_fingerprint = EXCLUDED.payload_fingerprint,
           source_fetched_at = EXCLUDED.source_fetched_at
         WHERE EXCLUDED.source_fetched_at >= fact.warehouse_inventory_snapshot.source_fetched_at`,
        [
          storeId,
          inventorySnapshotId,
          warehouseId,
          warehouse.inventoryQuantity,
          warehouse.lockedQuantity,
          warehouse.tempLockQuantity,
          warehouse.usableInventory,
          warehouse.outOfStockQty,
          warehouse.transitQuantity,
          fetchBatchId,
          warehouseFingerprint,
          sourceFetchedAt,
        ],
      );
      warehouseCount += 1;
    }
    await insertReconciliation(client, {
      storeId,
      fetchBatchId,
      sourceFetchedAt,
      skuCode: item.skuCode,
      inventoryType: inventory.inventoryType,
      reconciliation: item.reconciliation,
    });
    if ((item.totalOutOfStockQty ?? 0) > 0) {
      const eventInput = {
        skuCode: item.skuCode,
        inventoryType: inventory.inventoryType,
        sourceFetchedAt,
      };
      const eventKey = payloadFingerprint(eventInput);
      await client.query(
        `INSERT INTO fact.shortage_event (
           store_id, event_key, sku_code, inventory_type_code,
           shortage_quantity, event_status_code, source_fetch_batch_id,
           payload_fingerprint, source_fetched_at
         ) VALUES ($1, $2, $3, $4, $5, 'OBSERVED', $6, $7, $8)
         ON CONFLICT (store_id, event_key) DO UPDATE SET
           shortage_quantity = EXCLUDED.shortage_quantity,
           event_status_code = EXCLUDED.event_status_code,
           source_fetch_batch_id = EXCLUDED.source_fetch_batch_id,
           payload_fingerprint = EXCLUDED.payload_fingerprint,
           source_fetched_at = EXCLUDED.source_fetched_at
         WHERE EXCLUDED.source_fetched_at >= fact.shortage_event.source_fetched_at`,
        [
          storeId,
          eventKey,
          item.skuCode,
          inventory.inventoryType,
          item.totalOutOfStockQty,
          fetchBatchId,
          payloadFingerprint({ ...eventInput, shortageQuantity: item.totalOutOfStockQty }),
          sourceFetchedAt,
        ],
      );
    }
  }
  return {
    inventoryCount: inventory.items.length,
    warehouseInventoryCount: warehouseCount,
    inventoryCoverageStatus: coverage.status,
    inventoryRequestedCount: coverage.requestedCount,
    inventoryObservedCount: coverage.observedCount,
    inventoryMissingActiveSkuCount: missingActiveSkuCodes.length,
  };
}

function occurrenceKeyFactory() {
  const counts = new Map();
  return (identity) => {
    const serialized = stableJson(identity);
    const occurrence = counts.get(serialized) ?? 0;
    counts.set(serialized, occurrence + 1);
    return payloadFingerprint({ identity, occurrence });
  };
}

function canonicalRowSet(rows) {
  return [...rows].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

async function loadPurchaseOrders(client, {
  storeId,
  fetchBatchId,
  purchaseOrders,
  sourceFetchedAt,
}) {
  let lineCount = 0;
  let retiredLineCount = 0;
  let relationCount = 0;
  let retiredRelationCount = 0;
  let staleOrderCount = 0;
  const relationScopeSnapshots = new Map();
  const relationCandidates = new Map();
  for (const order of purchaseOrders.orders) {
    if (!Array.isArray(order.lines) || order.linesComplete !== true) {
      throw new Error(`Purchase order ${order.orderNo} does not declare a complete line set`);
    }
    if (
      !Array.isArray(order.jitRelations)
      || !Array.isArray(order.jitRelationScopes ?? [])
      || (
        order.jitRelationsComplete === true
        && order.jitRelationScopes.length === 0
      )
    ) {
      throw new Error(`Purchase order ${order.orderNo} has invalid JIT relation evidence`);
    }
    const effectiveSourceTime = isoDate(
      order.sourceUpdatedAt ?? order.fetchedAt ?? sourceFetchedAt,
      `purchase order ${order.orderNo} source time`,
    );
    const fingerprint = payloadFingerprint({
      ...order,
      fetchedAt: undefined,
      lines: canonicalRowSet(order.lines),
      jitRelations: canonicalRowSet(order.jitRelations ?? []),
    });
    const locked = await client.query(
      `SELECT purchase_order_id, payload_fingerprint, source_fetched_at
       FROM fact.purchase_order
       WHERE store_id = $1 AND order_no = $2
       FOR UPDATE`,
      [storeId, order.orderNo],
    );
    const existing = locked.rows[0] ?? null;
    const existingSourceTime = existing
      ? isoDate(existing.source_fetched_at, 'purchase order existing source_fetched_at')
      : null;
    if (existingSourceTime && existingSourceTime > effectiveSourceTime) {
      staleOrderCount += 1;
      continue;
    }
    if (
      existingSourceTime === effectiveSourceTime
      && existing.payload_fingerprint !== fingerprint
    ) {
      throw new Error(
        `Purchase order ${order.orderNo} changed at an identical source timestamp`,
      );
    }
    const result = await client.query(
      `INSERT INTO fact.purchase_order (
         store_id, order_no, order_type_code, order_type_name,
         status_code, status_name, prepare_type_code, prepare_type_name,
         category_code, category_name, currency_code,
         warehouse_code, warehouse_name, jit_role_code,
         platform_created_at, platform_updated_at,
         requested_delivery_at, requested_receipt_at,
         delivered_at, received_at, stored_at,
         source_fetch_batch_id, payload_fingerprint, source_fetched_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10, $11,
         $12, $13, $14,
         $15, $16,
         $17, $18,
         $19, $20, $21,
         $22, $23, $24
       )
       ON CONFLICT (store_id, order_no) DO UPDATE SET
         order_type_code = EXCLUDED.order_type_code,
         order_type_name = EXCLUDED.order_type_name,
         status_code = EXCLUDED.status_code,
         status_name = EXCLUDED.status_name,
         prepare_type_code = EXCLUDED.prepare_type_code,
         prepare_type_name = EXCLUDED.prepare_type_name,
         category_code = EXCLUDED.category_code,
         category_name = EXCLUDED.category_name,
         currency_code = EXCLUDED.currency_code,
         warehouse_code = EXCLUDED.warehouse_code,
         warehouse_name = EXCLUDED.warehouse_name,
         jit_role_code = EXCLUDED.jit_role_code,
         platform_created_at = EXCLUDED.platform_created_at,
         platform_updated_at = EXCLUDED.platform_updated_at,
         requested_delivery_at = EXCLUDED.requested_delivery_at,
         requested_receipt_at = EXCLUDED.requested_receipt_at,
         delivered_at = EXCLUDED.delivered_at,
         received_at = EXCLUDED.received_at,
         stored_at = EXCLUDED.stored_at,
         source_fetch_batch_id = EXCLUDED.source_fetch_batch_id,
         payload_fingerprint = EXCLUDED.payload_fingerprint,
         source_fetched_at = EXCLUDED.source_fetched_at
       WHERE EXCLUDED.source_fetched_at > fact.purchase_order.source_fetched_at
       RETURNING purchase_order_id`,
      [
        storeId,
        order.orderNo,
        order.orderTypeCode,
        order.orderTypeName,
        order.statusCode,
        order.statusName,
        order.prepareTypeCode,
        order.prepareTypeName,
        order.categoryCode,
        order.categoryName,
        order.currencyCode,
        order.warehouseCode,
        order.warehouseName,
        order.jitRoleCode,
        order.createdAt,
        order.sourceUpdatedAt,
        order.requestedDeliveryAt,
        order.requestedReceiptAt,
        order.deliveredAt,
        order.receivedAt,
        order.storedAt,
        fetchBatchId,
        fingerprint,
        effectiveSourceTime,
      ],
    );
    let purchaseOrderId = result.rows[0]?.purchase_order_id ?? existing?.purchase_order_id;
    if (!purchaseOrderId) {
      const existing = await client.query(
        'SELECT purchase_order_id FROM fact.purchase_order WHERE store_id = $1 AND order_no = $2',
        [storeId, order.orderNo],
      );
      purchaseOrderId = existing.rows[0]?.purchase_order_id;
    }
    if (!purchaseOrderId) throw new Error(`Purchase order ${order.orderNo} could not be resolved`);

    const retired = await client.query(
      `UPDATE fact.purchase_order_line
       SET is_current = false,
           retired_at = $3
       WHERE store_id = $1
         AND purchase_order_id = $2
         AND is_current
         AND source_fetched_at <= $3
       RETURNING purchase_order_line_id`,
      [storeId, purchaseOrderId, effectiveSourceTime],
    );
    retiredLineCount += retired.rowCount ?? retired.rows.length;

    const lineKey = occurrenceKeyFactory();
    for (const line of order.lines) {
      const sourceLineKey = lineKey({
        skuCode: line.skuCode,
        skc: line.skc,
        supplierCode: line.supplierCode,
        supplierSku: line.supplierSku,
      });
      const lineResult = await client.query(
        `INSERT INTO fact.purchase_order_line (
           store_id, purchase_order_id, source_line_key,
           sku_code, skc_name, supplier_code, supplier_sku, variant_name,
           need_quantity, order_quantity, delivery_quantity,
           receipt_quantity, storage_quantity, defective_quantity,
           request_delivery_quantity, no_request_delivery_quantity,
           already_delivery_quantity, source_fetch_batch_id,
           payload_fingerprint, source_fetched_at, is_current, retired_at
         ) VALUES (
           $1, $2, $3,
           $4, $5, $6, $7, $8,
           $9, $10, $11,
           $12, $13, $14,
           $15, $16,
           $17, $18,
           $19, $20, true, NULL
         )
         ON CONFLICT (
           store_id, purchase_order_id, source_line_key, source_fetched_at
         ) DO UPDATE SET
           is_current = true,
           retired_at = NULL
         WHERE fact.purchase_order_line.payload_fingerprint
               = EXCLUDED.payload_fingerprint
         RETURNING purchase_order_line_id`,
        [
          storeId,
          purchaseOrderId,
          sourceLineKey,
          line.skuCode,
          line.skc,
          line.supplierCode,
          line.supplierSku,
          line.variantName,
          line.needQuantity,
          line.orderQuantity,
          line.deliveryQuantity,
          line.receiptQuantity,
          line.storageQuantity,
          line.defectiveQuantity,
          line.requestDeliveryQuantity,
          line.noRequestDeliveryQuantity,
          line.alreadyDeliveryQuantity,
          fetchBatchId,
          payloadFingerprint(line),
          effectiveSourceTime,
        ],
      );
      if ((lineResult.rowCount ?? lineResult.rows.length) === 0) {
        throw new Error(
          `Purchase order ${order.orderNo} line evidence changed at an identical source timestamp`,
        );
      }
      lineCount += 1;
    }
    if (order.jitRelationsComplete === true) {
      for (const relation of order.jitRelations) {
        const relationKey = stableJson(relation);
        relationCandidates.set(relationKey, relation);
      }
      for (const direction of order.jitRelationScopes) {
        if (!['AS_MOTHER', 'AS_CHILD'].includes(direction)) {
          throw new Error(`Purchase order ${order.orderNo} has an unknown JIT relation scope`);
        }
        const relationKeys = order.jitRelations
          .filter((relation) => (
            direction === 'AS_MOTHER'
              ? relation.motherOrderNo === order.orderNo
              : relation.childOrderNo === order.orderNo
          ))
          .map((relation) => stableJson(relation))
          .sort();
        const scopeKey = `${order.orderNo}:${direction}`;
        const prior = relationScopeSnapshots.get(scopeKey);
        if (prior && stableJson(prior.relationKeys) !== stableJson(relationKeys)) {
          throw new Error(`Purchase order ${order.orderNo} returned conflicting JIT scopes`);
        }
        relationScopeSnapshots.set(scopeKey, {
          orderNo: order.orderNo,
          direction,
          relationKeys,
        });
      }
    }
  }

  const finalRelations = [];
  for (const [relationKey, relation] of relationCandidates) {
    const coveringSnapshots = [
      relationScopeSnapshots.get(`${relation.motherOrderNo}:AS_MOTHER`),
      relationScopeSnapshots.get(`${relation.childOrderNo}:AS_CHILD`),
    ].filter(Boolean);
    const decisions = coveringSnapshots.map(({ relationKeys }) => (
      relationKeys.includes(relationKey)
    ));
    if (decisions.includes(true) && decisions.includes(false)) {
      throw new Error(
        `JIT relation ${relation.motherOrderNo}->${relation.childOrderNo} is contradictory`,
      );
    }
    if (decisions.includes(true)) finalRelations.push(relation);
  }

  for (const snapshot of relationScopeSnapshots.values()) {
    const relationColumn = snapshot.direction === 'AS_MOTHER'
      ? 'mother_order_no'
      : 'child_order_no';
    const retiredRelations = await client.query(
      `UPDATE fact.purchase_order_jit_relation
       SET is_current = false,
           retired_at = $3
       WHERE store_id = $1
         AND is_current
         AND ${relationColumn} = $2
         AND source_fetched_at <= $3
       RETURNING purchase_order_jit_relation_id`,
      [storeId, snapshot.orderNo, sourceFetchedAt],
    );
    retiredRelationCount += retiredRelations.rowCount ?? retiredRelations.rows.length;
  }
  for (const relation of canonicalRowSet(finalRelations)) {
    const relationResult = await client.query(
        `INSERT INTO fact.purchase_order_jit_relation (
           store_id, mother_order_no, child_order_no,
           source_fetch_batch_id, payload_fingerprint, source_fetched_at,
           is_current, retired_at
         ) VALUES ($1, $2, $3, $4, $5, $6, true, NULL)
         ON CONFLICT (
           store_id, mother_order_no, child_order_no, source_fetched_at
         ) DO UPDATE SET
           is_current = true,
           retired_at = NULL
         WHERE fact.purchase_order_jit_relation.payload_fingerprint
               = EXCLUDED.payload_fingerprint
         RETURNING purchase_order_jit_relation_id`,
        [
          storeId,
          relation.motherOrderNo,
          relation.childOrderNo,
          fetchBatchId,
          payloadFingerprint(relation),
          sourceFetchedAt,
        ],
      );
    if ((relationResult.rowCount ?? relationResult.rows.length) === 0) {
      throw new Error(
        `JIT relation ${relation.motherOrderNo}->${relation.childOrderNo} replay drifted`,
      );
    }
    relationCount += 1;
  }
  return {
    purchaseOrderCount: purchaseOrders.orders.length,
    purchaseOrderLineCount: lineCount,
    purchaseOrderLineRetiredCount: retiredLineCount,
    stalePurchaseOrderCount: staleOrderCount,
    jitRelationCount: relationCount,
    jitRelationRetiredCount: retiredRelationCount,
  };
}

async function loadDeliveries(client, {
  storeId,
  fetchBatchId,
  deliveries,
  sourceFetchedAt,
}) {
  let lineCount = 0;
  let retiredLineCount = 0;
  let staleDeliveryCount = 0;
  for (const delivery of deliveries.deliveries) {
    if (!Array.isArray(delivery.lines) || delivery.linesComplete !== true) {
      throw new Error(`Delivery ${delivery.deliveryCode} does not declare a complete line set`);
    }
    const effectiveSourceTime = isoDate(
      delivery.fetchedAt ?? sourceFetchedAt,
      `delivery ${delivery.deliveryCode} source time`,
    );
    const fingerprint = payloadFingerprint({
      ...delivery,
      fetchedAt: undefined,
      lines: canonicalRowSet(delivery.lines),
      consolidation: undefined,
    });
    const locked = await client.query(
      `SELECT delivery_id, payload_fingerprint, source_fetched_at
       FROM fact.delivery
       WHERE store_id = $1 AND delivery_code = $2
       FOR UPDATE`,
      [storeId, delivery.deliveryCode],
    );
    const existing = locked.rows[0] ?? null;
    const existingSourceTime = existing
      ? isoDate(existing.source_fetched_at, 'delivery existing source_fetched_at')
      : null;
    if (existingSourceTime && existingSourceTime > effectiveSourceTime) {
      staleDeliveryCount += 1;
      continue;
    }
    if (
      existingSourceTime === effectiveSourceTime
      && existing.payload_fingerprint !== fingerprint
    ) {
      throw new Error(
        `Delivery ${delivery.deliveryCode} changed at an identical source timestamp`,
      );
    }
    const result = await client.query(
      `INSERT INTO fact.delivery (
         store_id, delivery_code, delivery_type_code, delivery_type_name,
         logistics_label_print_flag_code, express_code,
         express_company_code, express_company_name,
         package_count, package_weight, warehouse_code, warehouse_name,
         platform_created_at, reserved_parcel_at, taken_at,
         expected_receipt_at, received_at,
         source_fetch_batch_id, payload_fingerprint, source_fetched_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6,
         $7, $8,
         $9, $10, $11, $12,
         $13, $14, $15,
         $16, $17,
         $18, $19, $20
       )
       ON CONFLICT (store_id, delivery_code) DO UPDATE SET
         delivery_type_code = EXCLUDED.delivery_type_code,
         delivery_type_name = EXCLUDED.delivery_type_name,
         logistics_label_print_flag_code = EXCLUDED.logistics_label_print_flag_code,
         express_code = EXCLUDED.express_code,
         express_company_code = EXCLUDED.express_company_code,
         express_company_name = EXCLUDED.express_company_name,
         package_count = EXCLUDED.package_count,
         package_weight = EXCLUDED.package_weight,
         warehouse_code = EXCLUDED.warehouse_code,
         warehouse_name = EXCLUDED.warehouse_name,
         platform_created_at = EXCLUDED.platform_created_at,
         reserved_parcel_at = EXCLUDED.reserved_parcel_at,
         taken_at = EXCLUDED.taken_at,
         expected_receipt_at = EXCLUDED.expected_receipt_at,
         received_at = EXCLUDED.received_at,
         source_fetch_batch_id = EXCLUDED.source_fetch_batch_id,
         payload_fingerprint = EXCLUDED.payload_fingerprint,
         source_fetched_at = EXCLUDED.source_fetched_at
       WHERE EXCLUDED.source_fetched_at > fact.delivery.source_fetched_at
       RETURNING delivery_id`,
      [
        storeId,
        delivery.deliveryCode,
        delivery.deliveryTypeCode,
        delivery.deliveryTypeName,
        delivery.logisticsLabelPrintFlagCode,
        delivery.expressCode,
        delivery.expressCompanyCode,
        delivery.expressCompanyName,
        delivery.packageCount,
        delivery.packageWeight,
        delivery.warehouseCode,
        delivery.warehouseName,
        delivery.createdAt,
        delivery.reservedParcelAt,
        delivery.takenAt,
        delivery.expectedReceiptAt,
        delivery.receivedAt,
        fetchBatchId,
        fingerprint,
        effectiveSourceTime,
      ],
    );
    let deliveryId = result.rows[0]?.delivery_id ?? existing?.delivery_id;
    if (!deliveryId) {
      const existing = await client.query(
        'SELECT delivery_id FROM fact.delivery WHERE store_id = $1 AND delivery_code = $2',
        [storeId, delivery.deliveryCode],
      );
      deliveryId = existing.rows[0]?.delivery_id;
    }
    if (!deliveryId) throw new Error(`Delivery ${delivery.deliveryCode} could not be resolved`);
    const retired = await client.query(
      `UPDATE fact.delivery_line
       SET is_current = false,
           retired_at = $3
       WHERE store_id = $1
         AND delivery_id = $2
         AND is_current
         AND source_fetched_at <= $3
       RETURNING delivery_line_id`,
      [storeId, deliveryId, effectiveSourceTime],
    );
    retiredLineCount += retired.rowCount ?? retired.rows.length;
    const lineKey = occurrenceKeyFactory();
    for (const line of delivery.lines) {
      const sourceLineKey = lineKey({
        orderNo: line.orderNo,
        skc: line.skc,
        skuCode: line.skuCode,
      });
      const lineResult = await client.query(
        `INSERT INTO fact.delivery_line (
           store_id, delivery_id, source_line_key,
           order_no, skc_name, sku_code, delivery_quantity,
           source_fetch_batch_id, payload_fingerprint, source_fetched_at,
           is_current, retired_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, NULL)
         ON CONFLICT (
           store_id, delivery_id, source_line_key, source_fetched_at
         ) DO UPDATE SET
           is_current = true,
           retired_at = NULL
         WHERE fact.delivery_line.payload_fingerprint
               = EXCLUDED.payload_fingerprint
         RETURNING delivery_line_id`,
        [
          storeId,
          deliveryId,
          sourceLineKey,
          line.orderNo,
          line.skc,
          line.skuCode,
          line.deliveryQuantity,
          fetchBatchId,
          payloadFingerprint(line),
          effectiveSourceTime,
        ],
      );
      if ((lineResult.rowCount ?? lineResult.rows.length) === 0) {
        throw new Error(
          `Delivery ${delivery.deliveryCode} line evidence changed at an identical source timestamp`,
        );
      }
      lineCount += 1;
    }
  }
  return {
    deliveryCount: deliveries.deliveries.length,
    deliveryLineCount: lineCount,
    deliveryLineRetiredCount: retiredLineCount,
    staleDeliveryCount,
  };
}

async function loadStockAdvice(client, {
  storeId,
  fetchBatchId,
  stockAdvice,
  sourceFetchedAt,
}) {
  const upstreamCoverage = normalizeProjectionCoverage(
    stockAdvice.coverage,
    stockAdvice.advice.length,
    'stockAdvice',
  );
  const activeSkuCodes = await readActiveSkuCodes(client, storeId);
  const activeSkuSet = new Set(activeSkuCodes);
  const members = stockAdvice.advice.filter(({ skuCode }) => activeSkuSet.has(skuCode));
  const adjustedObservedCount = upstreamCoverage.requestedCount === null
    ? members.length
    : Math.min(upstreamCoverage.observedCount, members.length);
  const coverage = Object.freeze({
    ...upstreamCoverage,
    status: upstreamCoverage.status === 'COMPLETE'
      && upstreamCoverage.requestedCount !== null
      && adjustedObservedCount !== upstreamCoverage.requestedCount
      ? 'PARTIAL'
      : upstreamCoverage.status,
    observedCount: adjustedObservedCount,
    memberCount: members.length,
  });
  await recordProjectionBatch(client, {
    storeId,
    domain: 'STOCK_ADVICE',
    subtype: 'ALL',
    coverage,
    fetchBatchId,
    sourceFetchedAt,
    members,
    authorityFingerprint: payloadFingerprint(activeSkuCodes),
  });
  for (const advice of stockAdvice.advice) {
    const effectiveSourceTime = advice.fetchedAt ?? sourceFetchedAt;
    const adviceFingerprint = payloadFingerprint(advice);
    const result = await client.query(
      `INSERT INTO fact.stock_advice_snapshot (
         store_id, sku_code, skc_name, spu_name, supplier_code,
         predicted_daily_sales, pending_order_quantity,
         pending_delivery_quantity, pending_shelf_quantity,
         transit_quantity, stock_quantity, advised_order_quantity,
         placed_order_quantity, planned_urgent_quantity,
         supply_status_code, shelf_status_code, stock_warning_status_code,
         stock_warning_observed, stock_warning_is_warning,
         source_fetch_batch_id, source_row_key,
         payload_fingerprint, source_fetched_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7,
         $8, $9,
         $10, $11, $12,
         $13, $14,
         $15, $16, $17,
         $18, $19,
         $20, $21,
         $22, $23
       )
       ON CONFLICT (store_id, sku_code, source_fetched_at) DO NOTHING
       RETURNING stock_advice_snapshot_id`,
      [
        storeId,
        advice.skuCode,
        advice.skcName,
        advice.spuName,
        advice.supplierCode,
        advice.predictedDailySales,
        advice.pendingOrderQuantity,
        advice.pendingDeliveryQuantity,
        advice.pendingShelfQuantity,
        advice.transitQuantity,
        advice.stockQuantity,
        advice.advisedOrderQuantity,
        advice.placedOrderQuantity,
        advice.plannedUrgentQuantity,
        advice.productStatuses?.supplyStatus?.code ?? null,
        advice.productStatuses?.shelfStatus?.code ?? null,
        advice.productStatuses?.stockWarningStatus?.code ?? null,
        advice.productStatuses?.stockWarningStatus?.observed === true,
        advice.productStatuses?.stockWarningStatus?.isWarning ?? null,
        fetchBatchId,
        advice.skuCode,
        adviceFingerprint,
        effectiveSourceTime,
      ],
    );
    if ((result.rowCount ?? result.rows.length) === 0) {
      const existing = await client.query(
        `SELECT payload_fingerprint, source_fetched_at
         FROM fact.stock_advice_snapshot
         WHERE store_id = $1
           AND sku_code = $2
           AND source_fetched_at = $3`,
        [storeId, advice.skuCode, effectiveSourceTime],
      );
      const row = existing.rows[0];
      if (
        existing.rows.length !== 1
        || row.payload_fingerprint !== adviceFingerprint
        || isoDate(row.source_fetched_at, 'stock advice source_fetched_at')
          !== isoDate(effectiveSourceTime, 'stock advice source time')
      ) {
        throw new Error(`Stock advice ${advice.skuCode} replay drifted`);
      }
    }
  }
  return {
    stockAdviceCount: stockAdvice.advice.length,
    stockAdviceCoverageStatus: coverage.status,
    stockAdviceRequestedCount: coverage.requestedCount,
    stockAdviceObservedCount: coverage.observedCount,
  };
}

/**
 * Persist any subset of supply domains in one store-scoped transaction.
 * Existing rows are only updated when the incoming source observation is not
 * older. No absence in a response causes a delete or zero-value invention.
 */
export async function loadFullManagedSupplySnapshot(pool, {
  store,
  runId,
  sourceFetchedAt = new Date(),
  productCatalog = null,
  productDetails = null,
  inventory = null,
  stockAdvice = null,
  purchaseOrders = null,
  deliveries = null,
} = {}) {
  requireRunId(runId);
  const observationTime = isoDate(sourceFetchedAt, 'sourceFetchedAt');
  const catalogEvidence = productCatalog ? requireStableCatalog(productCatalog) : null;
  return transaction(pool, async (client) => {
    const storeId = await upsertStore(client, store, observationTime);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`full-managed-catalog:${storeId}`],
    );
    const counts = {};

    if (productCatalog) {
      const fetchBatchId = await upsertRawBatch(client, {
        storeId,
        runId,
        domain: 'productCatalog',
        requestEvidence: {
          filters: productCatalog.filters ?? {},
          stableSweepCount: productCatalog.sweepCount,
          stableSweeps: productCatalog.sweeps.map((sweep) => ({
            productCount: sweep.productCount,
            skuCount: sweep.skuCount,
            catalogFingerprint: sweep.catalogFingerprint,
            terminalReason: sweep.terminalReason,
          })),
          sourcePayloadFingerprint: catalogEvidence.fingerprint,
        },
        recordCount: catalogEvidence.productCount,
        sourceFetchedAt: observationTime,
      });
      await upsertPageEvidence(client, {
        storeId,
        fetchBatchId,
        endpointCode: ENDPOINTS.productCatalog,
        pages: productCatalog.pages,
        requestEvidence: { filters: productCatalog.filters ?? {} },
        sourceFetchedAt: observationTime,
      });
      const catalogCounts = await enrichCatalog(client, {
        storeId,
        fetchBatchId,
        sourceFetchedAt: observationTime,
        productCatalog,
      });
      counts.catalogSkuCount = catalogEvidence.skuCount;
      counts.catalogEnrichedSkuCount = catalogCounts.enrichedCount;
      counts.catalogUnresolvedSkuCount = catalogCounts.unresolvedCount;
    }

    if (productDetails) {
      const fetchBatchId = await upsertRawBatch(client, {
        storeId,
        runId,
        domain: 'productDetails',
        requestEvidence: {
          batchCount: productDetails.batches.length,
          sourcePayloadFingerprint: payloadFingerprint(productDetails.details),
        },
        recordCount: productDetails.details.length,
        sourceFetchedAt: observationTime,
      });
      await upsertPageEvidence(client, {
        storeId,
        fetchBatchId,
        endpointCode: ENDPOINTS.productDetails,
        pages: productDetails.batches,
        requestEvidence: { batchCount: productDetails.batches.length },
        sourceFetchedAt: observationTime,
      });
      const detailCounts = await enrichProductDetails(client, {
        storeId,
        fetchBatchId,
        sourceFetchedAt: observationTime,
        productDetails,
      });
      counts.productDetailCount = productDetails.details.length;
      counts.productDetailEnrichedCount = detailCounts.enrichedCount;
      counts.productDetailUnresolvedCount = detailCounts.unresolvedCount;
    }

    if (inventory) {
      const fetchBatchId = await upsertRawBatch(client, {
        storeId,
        runId,
        domain: 'inventory',
        requestEvidence: {
          queryDimension: inventory.queryDimension,
          inventoryType: inventory.inventoryType,
          requestFingerprint: inventory.requestFingerprint,
          sourcePayloadFingerprint: payloadFingerprint({
            items: inventory.items,
            coverage: inventory.coverage,
          }),
        },
        recordCount: inventory.items.length,
        sourceFetchedAt: observationTime,
      });
      Object.assign(counts, await loadInventory(client, {
        storeId,
        fetchBatchId,
        inventory,
        sourceFetchedAt: observationTime,
      }));
    }

    if (stockAdvice) {
      const fetchBatchId = await upsertRawBatch(client, {
        storeId,
        runId,
        domain: 'stockAdvice',
        requestEvidence: {
          requestFingerprint: stockAdvice.requestFingerprint,
          sourcePayloadFingerprint: payloadFingerprint({
            advice: stockAdvice.advice,
            coverage: stockAdvice.coverage,
          }),
        },
        recordCount: stockAdvice.advice.length,
        sourceFetchedAt: observationTime,
      });
      await upsertPageEvidence(client, {
        storeId,
        fetchBatchId,
        endpointCode: ENDPOINTS.stockAdvice,
        pages: stockAdvice.pages,
        requestEvidence: { requestFingerprint: stockAdvice.requestFingerprint },
        sourceFetchedAt: observationTime,
      });
      Object.assign(counts, await loadStockAdvice(client, {
        storeId,
        fetchBatchId,
        stockAdvice,
        sourceFetchedAt: observationTime,
      }));
    }

    if (purchaseOrders) {
      const fetchBatchId = await upsertRawBatch(client, {
        storeId,
        runId,
        domain: 'purchaseOrders',
        requestEvidence: {
          requestFingerprint: purchaseOrders.requestFingerprint,
          incrementalStrategy: purchaseOrders.incrementalStrategy,
          sourcePayloadFingerprint: payloadFingerprint(purchaseOrders.orders),
        },
        recordCount: purchaseOrders.orders.length,
        sourceFetchedAt: observationTime,
      });
      await upsertPageEvidence(client, {
        storeId,
        fetchBatchId,
        endpointCode: ENDPOINTS.purchaseOrders,
        pages: purchaseOrders.pages,
        requestEvidence: { requestFingerprint: purchaseOrders.requestFingerprint },
        sourceFetchedAt: observationTime,
      });
      Object.assign(counts, await loadPurchaseOrders(client, {
        storeId,
        fetchBatchId,
        purchaseOrders,
        sourceFetchedAt: observationTime,
      }));
    }

    if (deliveries) {
      const fetchBatchId = await upsertRawBatch(client, {
        storeId,
        runId,
        domain: 'deliveries',
        requestEvidence: {
          requestFingerprint: deliveries.requestFingerprint,
          incrementalStrategy: deliveries.incrementalStrategy,
          sourcePayloadFingerprint: payloadFingerprint(deliveries.deliveries),
        },
        recordCount: deliveries.deliveries.length,
        sourceFetchedAt: observationTime,
      });
      await upsertPageEvidence(client, {
        storeId,
        fetchBatchId,
        endpointCode: ENDPOINTS.deliveries,
        pages: deliveries.pages,
        requestEvidence: { requestFingerprint: deliveries.requestFingerprint },
        sourceFetchedAt: observationTime,
      });
      Object.assign(counts, await loadDeliveries(client, {
        storeId,
        fetchBatchId,
        deliveries,
        sourceFetchedAt: observationTime,
      }));
    }

    return Object.freeze({
      storeCode: safeStore(store).storeCode,
      sourceFetchedAt: observationTime,
      ...counts,
    });
  });
}

function normalizeStoreIds(storeIds) {
  if (storeIds === undefined || storeIds === null) return null;
  if (!Array.isArray(storeIds)) throw new TypeError('storeIds must be an array or null');
  const result = [...new Set(storeIds)];
  for (let index = 0; index < result.length; index += 1) {
    if (!Number.isSafeInteger(result[index]) || result[index] < 1) {
      throw new TypeError(`storeIds[${index}] must be a positive safe integer`);
    }
  }
  return result;
}

function safeCount(value, location) {
  if (value === null || value === undefined || value === '') {
    throw new RangeError(`${location} must be a non-negative safe integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RangeError(`${location} must be a non-negative safe integer`);
  }
  return number;
}

function optionalSafeCount(value, location) {
  if (value === null || value === undefined) return null;
  return safeCount(value, location);
}

function commonSummaryRow(row) {
  return {
    storeId: safeCount(row.store_id, 'store_id'),
    storeCode: requireText(row.store_code, 'store_code'),
    storeName: requireText(row.store_name, 'store_name'),
    latestSourceFetchedAt: row.latest_source_fetched_at === null
      ? null
      : isoDate(row.latest_source_fetched_at, 'latest_source_fetched_at'),
  };
}

export async function readFullManagedSupplySyncHealth(client, {
  storeIds = null,
  freshnessScope = 'LIVE',
} = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('client.query is required');
  }
  const scope = normalizeStoreIds(storeIds);
  const normalizedFreshnessScope = freshnessScope === null
    ? null
    : safeAttemptCode(freshnessScope, 'freshnessScope');
  if (
    normalizedFreshnessScope !== null
    && !['LIVE', 'BACKFILL'].includes(normalizedFreshnessScope)
  ) {
    throw new TypeError('freshnessScope must be LIVE, BACKFILL or null');
  }
  const result = await client.query(
    SUPPLY_SYNC_HEALTH_SQL,
    [scope, normalizedFreshnessScope],
  );
  return Object.freeze(result.rows.map((row) => Object.freeze({
    storeId: safeCount(row.store_id, 'store_id'),
    storeCode: requireText(row.store_code, 'store_code'),
    storeName: requireText(row.store_name, 'store_name'),
    attemptId: requireText(row.attempt_id, 'attempt_id'),
    domainCode: requireText(row.domain_code, 'domain_code'),
    subtypeCode: requireText(row.subtype_code, 'subtype_code'),
    modeCode: requireText(row.mode_code, 'mode_code'),
    freshnessScope: requireText(row.freshness_scope_code, 'freshness_scope_code'),
    window: row.window_start_at === null
      ? null
      : Object.freeze({
          start: isoDate(row.window_start_at, 'window_start_at'),
          end: isoDate(row.window_end_at, 'window_end_at'),
        }),
    requestedCount: optionalSafeCount(row.requested_count, 'requested_count'),
    observedCount: optionalSafeCount(row.observed_count, 'observed_count'),
    status: requireText(row.status_code, 'status_code'),
    errorCode: typeof row.error_code === 'string' ? row.error_code : null,
    errorReason: typeof row.error_reason === 'string' ? row.error_reason : null,
    startedAt: isoDate(row.started_at, 'started_at'),
    completedAt: row.completed_at === null
      ? null
      : isoDate(row.completed_at, 'completed_at'),
  })));
}

/**
 * Read-only, RBAC-scopeable supply summaries for dashboard materialization.
 * It returns quantities and operational stages only; no consumer order, GMV,
 * contact, phone or address field is selected.
 */
export async function readFullManagedSupplyDashboard(client, { storeIds = null } = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('client.query is required');
  }
  const scope = normalizeStoreIds(storeIds);
  const [
    purchaseOrderStatusResult,
    deliveryMilestonesResult,
    inventoryResult,
    stockAdviceResult,
  ] = await Promise.all([
    client.query(SUPPLY_DASHBOARD_SQL.purchaseOrderStatus, [scope]),
    client.query(SUPPLY_DASHBOARD_SQL.deliveryMilestones, [scope]),
    client.query(SUPPLY_DASHBOARD_SQL.inventory, [scope]),
    client.query(SUPPLY_DASHBOARD_SQL.stockAdvice, [scope]),
  ]);

  return Object.freeze({
    purchaseOrderStatus: purchaseOrderStatusResult.rows.map((row) => Object.freeze({
      ...commonSummaryRow(row),
      statusCode: requireText(row.status_code, 'status_code'),
      statusName: typeof row.status_name === 'string' ? row.status_name : null,
      orderCount: safeCount(row.order_count, 'order_count'),
    })),
    deliveryMilestones: deliveryMilestonesResult.rows.map((row) => Object.freeze({
      ...commonSummaryRow(row),
      milestoneCode: requireText(row.milestone_code, 'milestone_code'),
      deliveryCount: safeCount(row.delivery_count, 'delivery_count'),
      deliveryQuantity: optionalSafeCount(row.delivery_quantity, 'delivery_quantity'),
      deliveryQuantityCoverage: Object.freeze({
        knownLineCount: safeCount(
          row.known_delivery_quantity_line_count,
          'known_delivery_quantity_line_count',
        ),
        totalLineCount: safeCount(
          row.total_delivery_line_count,
          'total_delivery_line_count',
        ),
      }),
    })),
    inventory: inventoryResult.rows.map((row) => Object.freeze({
      ...commonSummaryRow(row),
      inventoryTypeCode: requireText(row.inventory_type_code, 'inventory_type_code'),
      skuCount: safeCount(row.sku_count, 'sku_count'),
      inventoryQuantity: optionalSafeCount(row.inventory_quantity, 'inventory_quantity'),
      usableInventory: optionalSafeCount(row.usable_inventory, 'usable_inventory'),
      projectionCoverage: Object.freeze({
        status: requireText(row.coverage_status_code, 'coverage_status_code'),
        requestedIdentifierCount: optionalSafeCount(
          row.requested_count,
          'requested_count',
        ),
        observedIdentifierCount: safeCount(row.observed_count, 'observed_count'),
        memberSkuCount: safeCount(row.member_count, 'member_count'),
        inactiveFilteredSkuCount: safeCount(
          row.inactive_filtered_sku_count,
          'inactive_filtered_sku_count',
        ),
      }),
      transitQuantity: optionalSafeCount(row.transit_quantity, 'transit_quantity'),
      transitCoverage: Object.freeze({
        knownSkuCount: safeCount(row.transit_known_sku_count, 'transit_known_sku_count'),
        totalSkuCount: safeCount(row.sku_count, 'sku_count'),
      }),
      shortageSkuCount: optionalSafeCount(row.shortage_sku_count, 'shortage_sku_count'),
      shortageQuantity: optionalSafeCount(row.shortage_quantity, 'shortage_quantity'),
      shortageCoverage: Object.freeze({
        knownSkuCount: safeCount(
          row.shortage_known_sku_count,
          'shortage_known_sku_count',
        ),
        totalSkuCount: safeCount(row.sku_count, 'sku_count'),
      }),
      reconciliationMismatchCount: optionalSafeCount(
        row.reconciliation_mismatch_count,
        'reconciliation_mismatch_count',
      ),
    })),
    stockAdvice: stockAdviceResult.rows.map((row) => Object.freeze({
      ...commonSummaryRow(row),
      totalSkuCount: safeCount(row.total_sku_count, 'total_sku_count'),
      projectionCoverage: Object.freeze({
        status: requireText(row.coverage_status_code, 'coverage_status_code'),
        requestedIdentifierCount: optionalSafeCount(
          row.requested_count,
          'requested_count',
        ),
        observedIdentifierCount: safeCount(row.observed_count, 'observed_count'),
        memberSkuCount: safeCount(row.member_count, 'member_count'),
        inactiveFilteredSkuCount: safeCount(
          row.inactive_filtered_sku_count,
          'inactive_filtered_sku_count',
        ),
      }),
      advisedSkuCount: optionalSafeCount(row.advised_sku_count, 'advised_sku_count'),
      advisedOrderQuantity: optionalSafeCount(
        row.advised_order_quantity,
        'advised_order_quantity',
      ),
      advisedOrderCoverage: Object.freeze({
        knownSkuCount: safeCount(
          row.advised_order_known_sku_count,
          'advised_order_known_sku_count',
        ),
        totalSkuCount: safeCount(row.total_sku_count, 'total_sku_count'),
      }),
      plannedUrgentQuantity: optionalSafeCount(
        row.planned_urgent_quantity,
        'planned_urgent_quantity',
      ),
      plannedUrgentCoverage: Object.freeze({
        knownSkuCount: safeCount(
          row.planned_urgent_known_sku_count,
          'planned_urgent_known_sku_count',
        ),
        totalSkuCount: safeCount(row.total_sku_count, 'total_sku_count'),
      }),
      warningSkuCount: optionalSafeCount(row.warning_sku_count, 'warning_sku_count'),
      warningCoverage: Object.freeze({
        knownSkuCount: safeCount(
          row.warning_known_sku_count,
          'warning_known_sku_count',
        ),
        totalSkuCount: safeCount(row.total_sku_count, 'total_sku_count'),
      }),
    })),
  });
}
