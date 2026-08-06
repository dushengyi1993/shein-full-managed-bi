import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { projectDashboardData } from '../domain/dashboard-projection.mjs';
import { normalizeIdentifierValue } from '../domain/product-identity.mjs';
import {
  MIXED_STATISTICS_DATES_CODE,
  MIXED_STATISTICS_DATES_MESSAGE,
} from './full-managed-sales-repository.mjs';
import { readOperationsDashboard } from './operations-dashboard.mjs';

function pgInteger(value, location) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${location} is not a safe count`);
  return number;
}

function mapPermission(outcome) {
  return {
    GRANTED: 'granted',
    PENDING: 'pending',
    DENIED: 'denied',
    ERROR: 'unknown',
  }[outcome] ?? 'unknown';
}

function isLegacyMixedStatisticsDatesProbe(probe) {
  return (
    probe?.outcome === 'ERROR'
    && probe?.platform_error_code === 'SYNC_ERROR'
    && probe?.platform_message === MIXED_STATISTICS_DATES_MESSAGE
  );
}

function normalizeLatestSalesProbe(probe) {
  const legacyMixedStatisticsDates = isLegacyMixedStatisticsDatesProbe(probe);
  const evidence = probe?.evidence && typeof probe.evidence === 'object'
    ? probe.evidence
    : {};
  const statisticsDateCount = Number.isSafeInteger(evidence.statisticsDateCount)
    && evidence.statisticsDateCount >= 2
    ? evidence.statisticsDateCount
    : null;
  return {
    outcome: legacyMixedStatisticsDates ? 'GRANTED' : probe?.outcome,
    dataQualityReason: legacyMixedStatisticsDates
      ? MIXED_STATISTICS_DATES_CODE
      : evidence.dataQualityReason === MIXED_STATISTICS_DATES_CODE
        ? MIXED_STATISTICS_DATES_CODE
        : null,
    statisticsDateCount,
  };
}

function grantedSalesProbeSql(alias) {
  const message = MIXED_STATISTICS_DATES_MESSAGE.replaceAll("'", "''");
  return `(
    ${alias}.outcome = 'GRANTED'
    OR (
      ${alias}.outcome = 'ERROR'
      AND ${alias}.platform_error_code = 'SYNC_ERROR'
      AND ${alias}.platform_message = '${message}'
    )
  )`;
}

function stageStatus(completed, total, { pending = false, blocked = false } = {}) {
  if (total > 0 && completed === total) return 'complete';
  if (blocked) return 'blocked';
  if (pending || completed > 0) return 'pending';
  return 'not_started';
}

function storeSkuKey(storeCode, skuCode) {
  return `${storeCode}\u001f${skuCode}`;
}

function storeIdentifierKey(storeCode, value) {
  const normalizedStore = String(storeCode ?? '').normalize('NFKC').trim();
  const normalizedValue = String(value ?? '').normalize('NFKC').trim();
  return normalizedStore && normalizedValue
    ? `${normalizedStore}\u001f${normalizedValue}`
    : null;
}

function registerUniqueReportingAssignment(index, key, assignment) {
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, assignment);
    return;
  }
  const current = index.get(key);
  if (current?.standardGoodsCode !== assignment.standardGoodsCode) index.set(key, null);
}

export function buildReportingGoodsLookup(rows = []) {
  const lookup = {
    sku: new Map(),
    skc: new Map(),
    spu: new Map(),
    supplierCode: new Map(),
    supplierSku: new Map(),
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const assignment = {
      standardGoodsCode: row.standard_goods_code,
      standardGoodsName: row.display_name,
      modelNormalized: row.model_normalized ?? null,
      namingRule: row.naming_rule,
      confidenceBand: row.confidence_band,
      sourcePlanHash: row.source_plan_hash,
    };
    const storeCode = row.store_code;
    registerUniqueReportingAssignment(
      lookup.sku,
      storeIdentifierKey(storeCode, row.platform_sku_id),
      assignment,
    );
    registerUniqueReportingAssignment(
      lookup.skc,
      storeIdentifierKey(storeCode, row.platform_skc_id),
      assignment,
    );
    registerUniqueReportingAssignment(
      lookup.spu,
      storeIdentifierKey(storeCode, row.platform_spu_id),
      assignment,
    );
    registerUniqueReportingAssignment(
      lookup.supplierCode,
      storeIdentifierKey(storeCode, row.supplier_code),
      assignment,
    );
    registerUniqueReportingAssignment(
      lookup.supplierSku,
      storeIdentifierKey(storeCode, row.supplier_sku),
      assignment,
    );
  }
  return lookup;
}

export function resolveReportingGoodsAssignment(lookup, row = {}) {
  const storeCode = row.storeCode ?? row.store_code;
  const candidates = [
    [lookup?.sku, row.platformSkuId ?? row.platform_sku_id],
    [lookup?.skc, row.platformSkcId ?? row.platform_skc_id],
    [lookup?.spu, row.platformSpuId ?? row.platform_spu_id],
    [lookup?.supplierCode, row.supplierCode ?? row.supplier_code],
    [lookup?.supplierSku, row.supplierSku ?? row.supplier_sku],
  ];
  for (const [index, value] of candidates) {
    const key = storeIdentifierKey(storeCode, value);
    if (!key || !index?.has(key)) continue;
    const assignment = index.get(key);
    if (assignment) return assignment;
  }
  return null;
}

function platformSpuId(value) {
  if (value === null || value === undefined) return null;
  return normalizeIdentifierValue('PLATFORM_SPU', value) === null
    ? null
    : String(value).normalize('NFKC').trim();
}

/** Optional aggregate count: an absent row stays unknown instead of zero. */
function pgCount(value, location) {
  if (value === null || value === undefined) return null;
  return pgInteger(value, location);
}

function pgInstant(value) {
  if (value === null || value === undefined) return null;
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isNaN(instant.valueOf()) ? null : instant.toISOString();
}

function pgDate(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const normalized = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function pgDecimal(value, location) {
  if (value === null || value === undefined) return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${location} is not a non-negative decimal`);
  }
  return number;
}

function pgSignedDecimal(value, location) {
  if (value === null || value === undefined) return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${location} is not a decimal`);
  }
  return number;
}

const UNAVAILABLE_PRODUCT_IDENTITY_PIPELINE = Object.freeze({
  status: 'unavailable',
  basis: 'schema_unavailable',
  note: '身份归并迁移尚未在当前数据库生效，因此证据、候选、决策与标准商品数量均未知',
  evidence: Object.freeze({
    sealedSetCount: null,
    observedStoreCount: null,
    identifierMemberCount: null,
    latestSealedAt: null,
  }),
  candidates: Object.freeze({
    total: null,
    confirmed: null,
    proposed: null,
    reviewRequired: null,
    blocked: null,
    globalScope: null,
    localSingletonScope: null,
    latestEvaluatedAt: null,
  }),
  decisions: Object.freeze({ confirmedCount: null, latestDecidedAt: null }),
  assignments: Object.freeze({ currentConfirmedCount: null, latestAssignedAt: null }),
  canonical: Object.freeze({ globalActiveProductCount: null, activeVariantCount: null }),
  updatedAt: null,
});

/**
 * Read the identity pipeline as counts and timestamps only.
 *
 * No raw identifier, evidence payload, run id, fingerprint or private path
 * leaves this function: the portal only needs to say how much evidence exists
 * and how far it has progressed. A missing migration yields an explicit
 * `unavailable` contract instead of an invented zero.
 */
export async function readProductIdentityPipeline(client) {
  const schemaResult = await client.query(`
    SELECT
      to_regclass('raw.product_identity_observation_set') IS NOT NULL AS has_observation_set,
      to_regclass('ops.product_match_candidate') IS NOT NULL AS has_candidate,
      to_regclass('ops.product_identity_decision') IS NOT NULL AS has_decision,
      to_regclass('dim.full_sku_canonical_assignment') IS NOT NULL AS has_assignment,
      to_regclass('dim.canonical_product') IS NOT NULL AS has_canonical_product,
      to_regclass('dim.canonical_variant') IS NOT NULL AS has_canonical_variant,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ops' AND table_name = 'product_match_candidate'
          AND column_name = 'observation_run_id'
      ) AS has_candidate_run,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ops' AND table_name = 'product_match_candidate'
          AND column_name = 'identity_scope'
      ) AS has_candidate_scope,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'dim' AND table_name = 'full_sku_canonical_assignment'
          AND column_name = 'identity_scope'
      ) AS has_assignment_scope,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'dim' AND table_name = 'canonical_product'
          AND column_name = 'identity_scope'
      ) AS has_canonical_scope`);
  const schema = schemaResult.rows[0] ?? {};
  // raw.identifier_observation is deliberately absent: the aggregate never
  // queries raw identifier rows, and probing it would require a SELECT grant
  // that must stay denied. information_schema.columns also hides columns the
  // role cannot read, so probing an ungranted relation would report the whole
  // pipeline as unavailable even when every table and column exists.
  const ready = [
    'has_observation_set',
    'has_candidate',
    'has_decision',
    'has_assignment',
    'has_canonical_product',
    'has_canonical_variant',
    'has_candidate_run',
    'has_candidate_scope',
    'has_assignment_scope',
    'has_canonical_scope',
  ].every((key) => schema[key] === true);
  if (!ready) return UNAVAILABLE_PRODUCT_IDENTITY_PIPELINE;

  const [evidenceResult, candidateResult, decisionResult, assignmentResult, canonicalResult] =
    await Promise.all([
      // Only the newest sealed run is summarized; older runs are historical.
      client.query(`
        WITH latest_run AS (
          SELECT observation_run_id
          FROM raw.product_identity_observation_set
          WHERE status = 'SEALED'
          GROUP BY observation_run_id
          ORDER BY max(sealed_at) DESC, observation_run_id DESC
          LIMIT 1
        )
        SELECT count(*)::bigint AS sealed_set_count,
               count(DISTINCT sets.store_id)::bigint AS observed_store_count,
               coalesce(sum(sets.member_count), 0)::bigint AS identifier_member_count,
               max(sets.sealed_at) AS latest_sealed_at
        FROM latest_run
        JOIN raw.product_identity_observation_set sets
          ON sets.observation_run_id = latest_run.observation_run_id
         AND sets.status = 'SEALED'`),
      client.query(`
        WITH latest_run AS (
          SELECT observation_run_id
          FROM ops.product_match_candidate
          GROUP BY observation_run_id
          ORDER BY max(evaluated_at) DESC, observation_run_id DESC
          LIMIT 1
        )
        SELECT count(*)::bigint AS total,
               count(*) FILTER (WHERE candidate.recommendation = 'CONFIRMED')::bigint AS confirmed,
               count(*) FILTER (WHERE candidate.recommendation = 'PROPOSED')::bigint AS proposed,
               count(*) FILTER (WHERE candidate.recommendation = 'REVIEW_REQUIRED')::bigint AS review_required,
               count(*) FILTER (WHERE candidate.recommendation = 'BLOCKED')::bigint AS blocked,
               count(*) FILTER (WHERE candidate.identity_scope = 'GLOBAL')::bigint AS global_scope,
               count(*) FILTER (WHERE candidate.identity_scope = 'LOCAL_SINGLETON')::bigint AS local_scope,
               max(candidate.evaluated_at) AS latest_evaluated_at
        FROM latest_run
        JOIN ops.product_match_candidate candidate
          ON candidate.observation_run_id = latest_run.observation_run_id`),
      client.query(`
        SELECT count(*) FILTER (WHERE decision_outcome = 'CONFIRMED')::bigint AS confirmed_count,
               max(decided_at) FILTER (WHERE decision_outcome = 'CONFIRMED') AS latest_decided_at
        FROM ops.product_identity_decision`),
      client.query(`
        SELECT count(*)::bigint AS current_confirmed_count,
               max(updated_at) AS latest_assigned_at
        FROM dim.full_sku_canonical_assignment
        WHERE assignment_status = 'CONFIRMED'
          AND valid_to IS NULL
          AND identity_scope = 'GLOBAL'`),
      client.query(`
        SELECT (
                 SELECT count(*)::bigint
                 FROM dim.canonical_product
                 WHERE identity_scope = 'GLOBAL' AND status = 'ACTIVE'
               ) AS global_active_product_count,
               (
                 SELECT count(*)::bigint
                 FROM dim.canonical_variant variant
                 JOIN dim.canonical_product product
                   ON product.canonical_product_id = variant.canonical_product_id
                 WHERE variant.status = 'ACTIVE'
                   AND product.identity_scope = 'GLOBAL'
                   AND product.status = 'ACTIVE'
               ) AS active_variant_count`),
    ]);

  const evidenceRow = evidenceResult.rows[0] ?? {};
  const candidateRow = candidateResult.rows[0] ?? {};
  const decisionRow = decisionResult.rows[0] ?? {};
  const assignmentRow = assignmentResult.rows[0] ?? {};
  const canonicalRow = canonicalResult.rows[0] ?? {};
  const evidence = {
    sealedSetCount: pgCount(evidenceRow.sealed_set_count, 'pipeline.sealedSetCount'),
    observedStoreCount: pgCount(evidenceRow.observed_store_count, 'pipeline.observedStoreCount'),
    identifierMemberCount: pgCount(
      evidenceRow.identifier_member_count,
      'pipeline.identifierMemberCount',
    ),
    latestSealedAt: pgInstant(evidenceRow.latest_sealed_at),
  };
  const candidates = {
    total: pgCount(candidateRow.total, 'pipeline.candidates.total'),
    confirmed: pgCount(candidateRow.confirmed, 'pipeline.candidates.confirmed'),
    proposed: pgCount(candidateRow.proposed, 'pipeline.candidates.proposed'),
    reviewRequired: pgCount(candidateRow.review_required, 'pipeline.candidates.reviewRequired'),
    blocked: pgCount(candidateRow.blocked, 'pipeline.candidates.blocked'),
    globalScope: pgCount(candidateRow.global_scope, 'pipeline.candidates.globalScope'),
    localSingletonScope: pgCount(candidateRow.local_scope, 'pipeline.candidates.localScope'),
    latestEvaluatedAt: pgInstant(candidateRow.latest_evaluated_at),
  };
  const decisions = {
    confirmedCount: pgCount(decisionRow.confirmed_count, 'pipeline.decisions.confirmedCount'),
    latestDecidedAt: pgInstant(decisionRow.latest_decided_at),
  };
  const assignments = {
    currentConfirmedCount: pgCount(
      assignmentRow.current_confirmed_count,
      'pipeline.assignments.currentConfirmedCount',
    ),
    latestAssignedAt: pgInstant(assignmentRow.latest_assigned_at),
  };
  const canonical = {
    globalActiveProductCount: pgCount(
      canonicalRow.global_active_product_count,
      'pipeline.canonical.globalActiveProductCount',
    ),
    activeVariantCount: pgCount(
      canonicalRow.active_variant_count,
      'pipeline.canonical.activeVariantCount',
    ),
  };
  const instants = [
    evidence.latestSealedAt,
    candidates.latestEvaluatedAt,
    decisions.latestDecidedAt,
    assignments.latestAssignedAt,
  ].filter(Boolean);
  return {
    status: 'available',
    basis: 'identity_resolution_schema',
    note: '计数来自最新一次密封证据run与当前生效归并结果；不包含任何原始标识符或证据明细',
    evidence,
    candidates,
    decisions,
    assignments,
    canonical,
    updatedAt: instants.length === 0
      ? null
      : new Date(Math.max(...instants.map((value) => new Date(value).valueOf()))).toISOString(),
  };
}

export async function readDashboardProjectionInput(pool) {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionOpen = true;
    const [storesResult, snapshotsResult, skuNamesResult, trendResult] = await Promise.all([
      client.query(`
        WITH latest_probe AS (
          SELECT DISTINCT ON (store_id)
                 store_id, outcome, evidence, probed_at,
                 platform_error_code, platform_message
          FROM ops.permission_probe
          WHERE capability_code = 'FULL_MANAGED_SKU_SALES'
          ORDER BY store_id, probed_at DESC, permission_probe_id DESC
        ), latest_run AS (
          SELECT DISTINCT ON (run.store_id)
                 run.store_id, run.status, run.business_date,
                 run.date_anchor_status, run.quality_status,
                 run.requested_sku_count, run.response_sku_count,
                 run.dated_sku_count, run.unanchored_zero_sku_count,
                 run.quarantined_sku_count, run.sales_today,
                 run.sales_yesterday, run.sales_7_days, run.sales_30_days,
                 run.source_fetched_at,
                 quality.details->'affectedSkuCodes' AS quarantined_sku_codes
          FROM ops.sales_sync_run run
          LEFT JOIN ops.sales_quality_event quality
            ON quality.sales_sync_run_id = run.sales_sync_run_id
           AND quality.event_code = 'SALES_DATE_UNANCHORED_NONZERO'
          ORDER BY run.store_id, run.source_fetched_at DESC, run.sales_sync_run_id DESC
        )
        SELECT s.store_code, s.store_name, p.outcome, p.evidence, p.probed_at,
               p.platform_error_code, p.platform_message,
               r.status AS run_status,
               to_char(r.business_date, 'YYYY-MM-DD') AS business_date,
               r.date_anchor_status,
               r.quality_status, r.requested_sku_count, r.response_sku_count,
               r.dated_sku_count, r.unanchored_zero_sku_count,
               r.quarantined_sku_count, r.quarantined_sku_codes,
               r.sales_today, r.sales_yesterday,
               r.sales_7_days, r.sales_30_days, r.source_fetched_at,
               to_char(w.business_date, 'YYYY-MM-DD') AS watermark_date,
               w.coverage_status AS watermark_coverage_status,
               (${grantedSalesProbeSql('p')} AND EXISTS (
                 SELECT 1
                 FROM fact.full_sku_sales_snapshot f
                 JOIN dim.full_sku sku
                   ON sku.full_sku_id = f.full_sku_id
                  AND sku.store_id = f.store_id
                  AND sku.is_active = true
                 WHERE f.store_id = s.store_id
                   AND f.snapshot_at = w.source_fetched_at
               )) AS has_facts
        FROM dim.store s
        LEFT JOIN latest_probe p ON p.store_id = s.store_id
        LEFT JOIN latest_run r ON r.store_id = s.store_id
        LEFT JOIN ops.sales_business_watermark w ON w.store_id = s.store_id
        WHERE s.cooperation_mode = 'FULL_MANAGED' AND s.is_active = true
        ORDER BY s.store_code`),
      client.query(`
        WITH latest_probe AS (
          SELECT DISTINCT ON (store_id)
                 store_id, outcome, platform_error_code, platform_message
          FROM ops.permission_probe
          WHERE capability_code = 'FULL_MANAGED_SKU_SALES'
          ORDER BY store_id, probed_at DESC, permission_probe_id DESC
        ), latest AS (
          SELECT DISTINCT ON (f.store_id, f.full_sku_id, split_part(f.source_row_key, ':', 1))
                 f.store_id, f.full_sku_id, f.source_row_key, f.sales_quantity, f.snapshot_at
          FROM fact.full_sku_sales_snapshot f
          JOIN ops.sales_business_watermark w
            ON w.store_id = f.store_id
           AND w.source_fetched_at = f.snapshot_at
          JOIN dim.full_sku active_sku
            ON active_sku.full_sku_id = f.full_sku_id
           AND active_sku.store_id = f.store_id
           AND active_sku.is_active = true
          ORDER BY f.store_id, f.full_sku_id, split_part(f.source_row_key, ':', 1),
                   f.snapshot_at DESC, f.updated_at DESC, f.sales_snapshot_id DESC
        )
        SELECT s.store_code, sku.platform_sku_id, sku.platform_skc_id,
               sku.supplier_code, sku.supplier_sku, sku.product_key,
               COALESCE(NULLIF(sku.sku_name, ''), NULLIF(sku.product_name, ''), sku.platform_sku_id) AS display_name,
               to_char(w.business_date, 'YYYY-MM-DD') AS business_date,
               max(latest.snapshot_at) AS fetched_at,
               max(latest.sales_quantity) FILTER (WHERE split_part(latest.source_row_key, ':', 1) = 'today') AS sales_today,
               max(latest.sales_quantity) FILTER (WHERE split_part(latest.source_row_key, ':', 1) = 'yesterday') AS sales_yesterday,
               max(latest.sales_quantity) FILTER (WHERE split_part(latest.source_row_key, ':', 1) = 'last7Days') AS sales_7_days,
               max(latest.sales_quantity) FILTER (WHERE split_part(latest.source_row_key, ':', 1) = 'last30Days') AS sales_30_days,
               count(DISTINCT split_part(latest.source_row_key, ':', 1)) AS window_count
        FROM latest
        JOIN dim.store s ON s.store_id = latest.store_id
        JOIN dim.full_sku sku ON sku.full_sku_id = latest.full_sku_id
        JOIN latest_probe p
          ON p.store_id = latest.store_id
         AND ${grantedSalesProbeSql('p')}
        JOIN ops.sales_business_watermark w ON w.store_id = latest.store_id
        WHERE s.cooperation_mode = 'FULL_MANAGED'
          AND s.is_active = true
        GROUP BY s.store_code, sku.platform_sku_id, sku.platform_skc_id,
                 sku.supplier_code, sku.supplier_sku, sku.product_key,
                 sku.sku_name, sku.product_name, w.business_date
        HAVING count(DISTINCT split_part(latest.source_row_key, ':', 1)) = 4`),
      client.query(`
        SELECT s.store_code, sku.platform_sku_id, sku.platform_spu_id,
               COALESCE(NULLIF(sku.sku_name, ''), NULLIF(sku.product_name, ''), sku.platform_sku_id) AS display_name
        FROM dim.full_sku sku
        JOIN dim.store s ON s.store_id = sku.store_id
        WHERE sku.is_active = true
          AND s.cooperation_mode = 'FULL_MANAGED'
          AND s.is_active = true`),
      client.query(`
        WITH latest_probe AS (
          SELECT DISTINCT ON (store_id)
                 store_id, outcome, platform_error_code, platform_message
          FROM ops.permission_probe
          WHERE capability_code = 'FULL_MANAGED_SKU_SALES'
          ORDER BY store_id, probed_at DESC, permission_probe_id DESC
        ), daily_candidates AS (
          SELECT f.store_id, f.full_sku_id,
                 (f.metric_window_start AT TIME ZONE 'Asia/Shanghai')::date AS sales_date,
                 f.sales_quantity, f.snapshot_at, f.updated_at, f.sales_snapshot_id,
                 row_number() OVER (
                   PARTITION BY f.store_id, f.full_sku_id,
                     (f.metric_window_start AT TIME ZONE 'Asia/Shanghai')::date
                   ORDER BY f.snapshot_at DESC, f.updated_at DESC, f.sales_snapshot_id DESC
                 ) AS recency
          FROM fact.full_sku_sales_snapshot f
          JOIN latest_probe p
            ON p.store_id = f.store_id
           AND ${grantedSalesProbeSql('p')}
          LEFT JOIN ops.sales_sync_run r
            ON r.store_id = f.store_id
           AND r.source_fetched_at = f.snapshot_at
          WHERE split_part(f.source_row_key, ':', 1) IN ('today', 'yesterday')
            AND (r.sales_sync_run_id IS NULL OR r.status = 'SUCCEEDED')
        ), daily_store AS (
          SELECT store_id, sales_date, sum(sales_quantity) AS units_sold
          FROM daily_candidates
          WHERE recency = 1
          GROUP BY store_id, sales_date
        ), ranked_dates AS (
          SELECT daily_store.*,
                 dense_rank() OVER (
                   PARTITION BY store_id ORDER BY sales_date DESC
                 ) AS date_recency
          FROM daily_store
        )
        SELECT s.store_code,
               to_char(daily.sales_date, 'YYYY-MM-DD') AS sales_date,
               daily.units_sold
        FROM ranked_dates daily
        JOIN dim.store s ON s.store_id = daily.store_id
        WHERE daily.date_recency <= 30
          AND s.cooperation_mode = 'FULL_MANAGED'
          AND s.is_active = true
        ORDER BY daily.sales_date DESC, s.store_code`),
    ]);

    const canonicalTablesResult = await client.query(`
      SELECT
        to_regclass('dim.canonical_product') IS NOT NULL AS has_canonical_product,
        to_regclass('dim.full_sku_canonical_assignment') IS NOT NULL AS has_canonical_assignment,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'dim'
            AND table_name = 'canonical_product'
            AND column_name = 'identity_scope'
        ) AS has_canonical_identity_scope,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'dim'
            AND table_name = 'full_sku_canonical_assignment'
            AND column_name = 'identity_scope'
        ) AS has_assignment_identity_scope,
        to_regclass('ops.employee_principal') IS NOT NULL AS has_employee_principal,
        to_regclass('ops.employee_store_assignment') IS NOT NULL AS has_employee_assignment`);
    const hasCanonicalIdentity = (
      canonicalTablesResult.rows[0]?.has_canonical_product === true
      && canonicalTablesResult.rows[0]?.has_canonical_assignment === true
      && canonicalTablesResult.rows[0]?.has_canonical_identity_scope === true
      && canonicalTablesResult.rows[0]?.has_assignment_identity_scope === true
    );
    let canonicalAssignments = new Map();
    if (hasCanonicalIdentity) {
      const canonicalResult = await client.query(`
        SELECT s.store_code, sku.platform_sku_id,
               cp.canonical_product_id, cp.canonical_product_key, cp.display_name
        FROM dim.full_sku_canonical_assignment assignment
        JOIN dim.full_sku sku
          ON sku.full_sku_id = assignment.full_sku_id
         AND sku.store_id = assignment.store_id
        JOIN dim.store s ON s.store_id = sku.store_id
        JOIN dim.canonical_product cp
          ON cp.canonical_product_id = assignment.canonical_product_id
        WHERE assignment.assignment_status = 'CONFIRMED'
          AND assignment.valid_to IS NULL
          AND assignment.identity_scope = 'GLOBAL'
          AND cp.identity_scope = 'GLOBAL'
          AND cp.status = 'ACTIVE'
          AND sku.is_active = true`);
      canonicalAssignments = new Map(canonicalResult.rows.map((row) => [
        storeSkuKey(row.store_code, row.platform_sku_id),
        {
          canonicalProductId: String(row.canonical_product_id),
          standardProductCode: row.canonical_product_key,
          standardProductName: row.display_name,
        },
      ]));
    }
    const hasEmployeeAccess = (
      canonicalTablesResult.rows[0]?.has_employee_principal === true
      && canonicalTablesResult.rows[0]?.has_employee_assignment === true
    );
    let owners = [];
    if (hasEmployeeAccess) {
      const ownerResult = await client.query(`
        SELECT principal.principal_key, principal.display_name, store.store_code
        FROM ops.employee_store_assignment assignment
        JOIN ops.employee_principal principal
          ON principal.employee_principal_id = assignment.employee_principal_id
        JOIN dim.store store ON store.store_id = assignment.store_id
        WHERE assignment.assignment_role = 'PRIMARY'
          AND assignment.assignment_status = 'ACTIVE'
          AND assignment.valid_to IS NULL
          AND principal.status = 'ACTIVE'
          AND store.is_active = true
        ORDER BY principal.principal_key, store.store_code`);
      const byPrincipal = new Map();
      for (const row of ownerResult.rows) {
        const owner = byPrincipal.get(row.principal_key) ?? {
          key: row.principal_key,
          name: row.display_name,
          storeCodes: [],
        };
        owner.storeCodes.push(row.store_code);
        byPrincipal.set(row.principal_key, owner);
      }
      owners = [...byPrincipal.values()];
    }

    const normalizedProbes = new Map(storesResult.rows.map((row) => [
      row.store_code,
      normalizeLatestSalesProbe(row),
    ]));
    const storePermissions = storesResult.rows.map((row) => ({
      storeCode: row.store_code,
      storeName: row.store_name,
      permissionStatus: mapPermission(normalizedProbes.get(row.store_code)?.outcome),
    }));
    const snapshots = snapshotsResult.rows.map((row, index) => ({
        storeCode: row.store_code,
        skuCode: row.platform_sku_id,
        skc: row.platform_skc_id ?? null,
        supplierCode: row.supplier_code ?? null,
        supplierSku: row.supplier_sku ?? null,
        productKey: row.product_key ?? `SKU:${row.platform_sku_id}`,
        name: row.display_name ?? row.platform_sku_id,
        salesToday: pgInteger(row.sales_today, `snapshots[${index}].salesToday`),
        salesYesterday: pgInteger(row.sales_yesterday, `snapshots[${index}].salesYesterday`),
        sales7Days: pgInteger(row.sales_7_days, `snapshots[${index}].sales7Days`),
        sales30Days: pgInteger(row.sales_30_days, `snapshots[${index}].sales30Days`),
        statisticsDate: row.business_date instanceof Date
          ? row.business_date.toISOString().slice(0, 10)
          : String(row.business_date).slice(0, 10),
        fetchedAt: new Date(row.fetched_at).toISOString(),
        canonicalAssignment: canonicalAssignments.get(
          storeSkuKey(row.store_code, row.platform_sku_id),
        ) ?? null,
      }));
    const projection = {
      storePermissions,
      snapshots,
      skuNames: new Map(skuNamesResult.rows.map((row) => [
        storeSkuKey(row.store_code, row.platform_sku_id),
        row.display_name,
      ])),
      productIdentityCatalog: skuNamesResult.rows.map((row) => ({
        storeCode: row.store_code,
        skuCode: row.platform_sku_id,
        platformSpuId: platformSpuId(row.platform_spu_id),
        canonicalAssignment: canonicalAssignments.get(
          storeSkuKey(row.store_code, row.platform_sku_id),
        ) ?? null,
      })),
      salesTrend: trendResult.rows
        .map((row) => ({
          storeCode: row.store_code,
          date: row.sales_date instanceof Date
            ? row.sales_date.toISOString().slice(0, 10)
            : String(row.sales_date).slice(0, 10),
          unitsSold: pgInteger(row.units_sold, `trend.${row.sales_date}`),
        }))
        .sort((left, right) => left.date.localeCompare(right.date)),
      storeHealth: storesResult.rows.map((row) => ({
        storeCode: row.store_code,
        permissionStatus: mapPermission(normalizedProbes.get(row.store_code)?.outcome),
        probeDataQualityReason:
          normalizedProbes.get(row.store_code)?.dataQualityReason ?? null,
        probeStatisticsDateCount:
          normalizedProbes.get(row.store_code)?.statisticsDateCount ?? null,
        probeAt: row.probed_at === null || row.probed_at === undefined
          ? null
          : new Date(row.probed_at).toISOString(),
        hasFacts: row.has_facts === true,
        runStatus: row.run_status ?? null,
        businessDate: row.business_date === null || row.business_date === undefined
          ? null
          : row.business_date instanceof Date
            ? row.business_date.toISOString().slice(0, 10)
            : String(row.business_date).slice(0, 10),
        watermarkDate: row.watermark_date === null || row.watermark_date === undefined
          ? null
          : row.watermark_date instanceof Date
            ? row.watermark_date.toISOString().slice(0, 10)
            : String(row.watermark_date).slice(0, 10),
        dateAnchorStatus: row.date_anchor_status ?? null,
        qualityStatus: row.quality_status ?? null,
        requestedSkuCount: row.requested_sku_count === null || row.requested_sku_count === undefined
          ? null
          : pgInteger(row.requested_sku_count, `${row.store_code}.requestedSkuCount`),
        responseSkuCount: row.response_sku_count === null || row.response_sku_count === undefined
          ? null
          : pgInteger(row.response_sku_count, `${row.store_code}.responseSkuCount`),
        datedSkuCount: row.dated_sku_count === null || row.dated_sku_count === undefined
          ? null
          : pgInteger(row.dated_sku_count, `${row.store_code}.datedSkuCount`),
        unanchoredZeroSkuCount: row.unanchored_zero_sku_count === null
          || row.unanchored_zero_sku_count === undefined
          ? null
          : pgInteger(row.unanchored_zero_sku_count, `${row.store_code}.unanchoredZeroSkuCount`),
        quarantinedSkuCount: row.quarantined_sku_count === null
          || row.quarantined_sku_count === undefined
          ? null
          : pgInteger(row.quarantined_sku_count, `${row.store_code}.quarantinedSkuCount`),
        quarantinedSkuCodes: Array.isArray(row.quarantined_sku_codes)
          ? [...new Set(
              row.quarantined_sku_codes
                .filter((value) => typeof value === 'string' && value.trim() !== '')
                .map((value) => value.trim().slice(0, 64)),
            )].slice(0, 100)
          : [],
        unitsSold: row.sales_today === null || row.sales_today === undefined
          ? null
          : {
              today: pgInteger(row.sales_today, `${row.store_code}.salesToday`),
              yesterday: pgInteger(row.sales_yesterday, `${row.store_code}.salesYesterday`),
              last7Days: pgInteger(row.sales_7_days, `${row.store_code}.sales7Days`),
              last30Days: pgInteger(row.sales_30_days, `${row.store_code}.sales30Days`),
            },
        fetchedAt: row.source_fetched_at === null || row.source_fetched_at === undefined
          ? null
          : new Date(row.source_fetched_at).toISOString(),
      })),
      owners,
      // Read inside the same repeatable-read snapshot so pipeline counts cannot
      // disagree with the catalog and ranking rows projected above.
      productIdentityPipeline: await readProductIdentityPipeline(client),
    };
    await client.query('COMMIT');
    transactionOpen = false;
    return projection;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

function readiness({ storeHealth, storeCatalog = [] }) {
  const total = Math.max(storeHealth.length, storeCatalog.length);
  const approved = storeCatalog.filter(({ applicationStatus }) => applicationStatus === 'approved').length;
  const rejectedApplications = storeCatalog.filter(({ applicationStatus }) => applicationStatus === 'rejected').length;
  const pendingApplications = storeCatalog.filter(({ applicationStatus }) => applicationStatus === 'pending').length;
  const authorizedFromConfig = storeCatalog.filter(({ authorizationStatus }) => authorizationStatus === 'authorized').length;
  const pendingAuthorizations = storeCatalog.filter(({ authorizationStatus }) => authorizationStatus === 'pending').length;
  const granted = storeHealth.filter(({ permissionStatus }) => permissionStatus === 'granted').length;
  const denied = storeHealth.filter(({ permissionStatus }) => permissionStatus === 'denied').length;
  const pendingProbes = storeHealth.filter(({ permissionStatus }) => permissionStatus === 'pending').length;
  const facts = storeHealth.filter(
    ({ hasFacts, qualityStatus, probeDataQualityReason }) => (
      probeDataQualityReason !== MIXED_STATISTICS_DATES_CODE
      && (hasFacts || qualityStatus === 'LEGAL_ZERO_UNANCHORED')
    ),
  ).length;
  const mixedStatisticsDateStores = storeHealth.filter(
    ({ probeDataQualityReason }) => probeDataQualityReason === MIXED_STATISTICS_DATES_CODE,
  ).length;
  let applicationStatus = 'unknown';
  if (storeCatalog.length > 0) {
    applicationStatus = stageStatus(approved, total, {
      pending: pendingApplications > 0 || approved > 0,
      blocked: rejectedApplications > 0,
    });
  }
  let authorizationStatus = 'unknown';
  const authorized = Math.max(authorizedFromConfig, granted);
  if (authorized === total && total > 0) authorizationStatus = 'complete';
  else if (authorized > 0 || pendingAuthorizations > 0) authorizationStatus = 'pending';
  else if (storeCatalog.some(({ authorizationStatus: value }) => value === 'not_started')) authorizationStatus = 'not_started';
  return [
    {
      key: 'applications', label: '全托应用审核',
      status: applicationStatus,
      completed: storeCatalog.length ? approved : null, total,
      note: storeCatalog.length ? '来自全托私有配置中的当前审核状态' : '数据库不保存应用审核状态',
    },
    {
      key: 'store_authorization', label: '店铺授权',
      status: authorizationStatus,
      completed: authorized, total,
      note: '以配置授权状态或成功业务探针为证据',
    },
    {
      key: 'sales_permission', label: '销量权限包',
      status: stageStatus(granted, total, { pending: pendingProbes > 0, blocked: denied > 0 }),
      completed: granted, total,
      note: denied > 0 ? `${denied} 家探针明确拒绝` : '未成功的权限探针不会记作零销量',
    },
    {
      key: 'sales_probe', label: '接口探针',
      status: stageStatus(granted, total, { pending: pendingProbes > 0 }),
      completed: granted, total,
      note: '仅 query-sku-sales HTTP 成功且平台 code=0 才记为通过',
    },
    {
      key: 'fact_load', label: '事实入仓',
      status: stageStatus(facts, total, { pending: granted > facts }),
      completed: facts, total,
      note: mixedStatisticsDateStores > 0
        ? `${mixedStatisticsDateStores} 家本轮日切返回混合统计日期，未推进事实水位`
        : '已落入四个销量窗口，或已确认合法零值但日期未锚定的店铺数',
    },
  ];
}

const EMPTY_UNITS = Object.freeze({
  today: null,
  yesterday: null,
  last7Days: null,
  last30Days: null,
});

function sumSnapshotUnits(rows) {
  if (rows.length === 0) return { ...EMPTY_UNITS };
  const result = { today: 0, yesterday: 0, last7Days: 0, last30Days: 0 };
  const fields = [
    ['salesToday', 'today'],
    ['salesYesterday', 'yesterday'],
    ['sales7Days', 'last7Days'],
    ['sales30Days', 'last30Days'],
  ];
  for (const row of rows) {
    for (const [source, target] of fields) {
      const value = pgInteger(row[source], `${row.storeCode}/${row.skuCode}.${source}`);
      const sum = result[target] + value;
      if (!Number.isSafeInteger(sum)) throw new RangeError(`Sales total ${target} exceeds the safe integer range`);
      result[target] = sum;
    }
  }
  return result;
}

function selectUnifiedBusinessDate(snapshots) {
  const coverageByDate = new Map();
  for (const snapshot of snapshots) {
    const stores = coverageByDate.get(snapshot.statisticsDate) ?? new Set();
    stores.add(snapshot.storeCode);
    coverageByDate.set(snapshot.statisticsDate, stores);
  }
  return [...coverageByDate.entries()]
    .sort((left, right) => right[1].size - left[1].size || right[0].localeCompare(left[0]))[0]?.[0] ?? null;
}

function compareUnits(left, right) {
  const fields = ['last30Days', 'last7Days', 'today'];
  for (const field of fields) {
    const leftValue = left.unitsSold[field];
    const rightValue = right.unitsSold[field];
    const difference = (rightValue ?? -1) - (leftValue ?? -1);
    if (difference !== 0) return difference;
  }
  return String(left.code ?? left.sku ?? left.name).localeCompare(
    String(right.code ?? right.sku ?? right.name),
  );
}

function buildTrendSeries(rows) {
  const byDate = new Map();
  for (const row of rows) {
    const current = byDate.get(row.date) ?? { unitsSold: 0, stores: new Set() };
    const sum = current.unitsSold + pgInteger(row.unitsSold, `salesTrend.${row.storeCode}.${row.date}`);
    if (!Number.isSafeInteger(sum)) throw new RangeError(`Sales trend ${row.date} exceeds the safe integer range`);
    current.unitsSold = sum;
    current.stores.add(row.storeCode);
    byDate.set(row.date, current);
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({
      date,
      unitsSold: value.unitsSold,
      coveredStores: value.stores.size,
    }));
}

function buildStoreSkuRanking(snapshots, skuNames) {
  return snapshots.map((snapshot) => {
    const assignment = snapshot.canonicalAssignment;
    const mappingStatus = assignment
      ? 'CONFIRMED'
      : String(snapshot.productKey ?? '').startsWith('SKC:')
        ? 'MISSING_SPU_ID'
        : 'UNMAPPED';
    return {
      storeCode: snapshot.storeCode,
      sku: snapshot.skuCode,
      skc: snapshot.skc ?? null,
      supplierCode: snapshot.supplierCode ?? null,
      supplierSku: snapshot.supplierSku ?? null,
      productKey: snapshot.productKey ?? `SKU:${snapshot.skuCode}`,
      name: snapshot.name
        ?? skuNames.get(storeSkuKey(snapshot.storeCode, snapshot.skuCode))
        ?? skuNames.get(snapshot.skuCode)
        ?? snapshot.skuCode,
      canonicalProductId: assignment?.canonicalProductId ?? null,
      standardProductCode: assignment?.standardProductCode ?? null,
      standardProductName: assignment?.standardProductName ?? null,
      mappingStatus,
      businessDate: snapshot.statisticsDate,
      unitsSold: {
        today: snapshot.salesToday,
        yesterday: snapshot.salesYesterday,
        last7Days: snapshot.sales7Days,
        last30Days: snapshot.sales30Days,
      },
    };
  }).sort(compareUnits);
}

function buildProductRanking(snapshots) {
  const groups = new Map();
  for (const snapshot of snapshots) {
    const assignment = snapshot.canonicalAssignment;
    const identityLevel = assignment ? 'CANONICAL_CONFIRMED' : 'STORE_LOCAL_UNVERIFIED';
    const key = assignment
      ? `CANONICAL:${assignment.canonicalProductId}`
      : `STORE_PRODUCT:${snapshot.storeCode}:${snapshot.productKey ?? `SKU:${snapshot.skuCode}`}`;
    let group = groups.get(key);
    if (!group) {
      const mappingStatus = assignment
        ? 'CONFIRMED'
        : String(snapshot.productKey ?? '').startsWith('SKC:')
          ? 'MISSING_SPU_ID'
          : 'UNVERIFIED';
      group = {
        canonicalProductId: assignment?.canonicalProductId ?? null,
        standardProductCode: assignment?.standardProductCode ?? null,
        name: assignment?.standardProductName ?? snapshot.name ?? snapshot.productKey ?? snapshot.skuCode,
        storeCode: assignment ? null : snapshot.storeCode,
        productKey: assignment ? null : snapshot.productKey ?? `SKU:${snapshot.skuCode}`,
        identityLevel,
        mappingStatus,
        storeCodes: new Set(),
        rows: [],
      };
      groups.set(key, group);
    }
    group.storeCodes.add(snapshot.storeCode);
    group.rows.push(snapshot);
  }
  return [...groups.values()].map((group) => {
    const storeBreakdown = [...group.storeCodes].sort().map((storeCode) => ({
      storeCode,
      unitsSold: sumSnapshotUnits(group.rows.filter((row) => row.storeCode === storeCode)),
    }));
    return {
      canonicalProductId: group.canonicalProductId,
      standardProductCode: group.standardProductCode,
      name: group.name,
      storeCode: group.storeCode,
      productKey: group.productKey,
      identityLevel: group.identityLevel,
      mappingStatus: group.mappingStatus,
      storeCount: group.storeCodes.size,
      storeBreakdown,
      unitsSold: sumSnapshotUnits(group.rows),
    };
  }).sort(compareUnits);
}

function buildProductIdentityCoverage(catalogRows) {
  if (!Array.isArray(catalogRows)) return null;
  const rows = catalogRows;
  const totalSkus = rows.length;
  const confirmedSkus = rows.filter(
    (row) => row.canonicalAssignment !== null
      && row.canonicalAssignment !== undefined
      && platformSpuId(row.platformSpuId) !== null,
  ).length;
  const missingSpuSkus = rows.filter(
    (row) => platformSpuId(row.platformSpuId) === null,
  ).length;
  return {
    basis: 'active_catalog',
    confirmedSkus,
    totalSkus,
    unconfirmedSkus: totalSkus - confirmedSkus,
    missingSpuSkus,
    coverageRate: totalSkus === 0
      ? null
      : Number((confirmedSkus / totalSkus).toFixed(4)),
    status: totalSkus === 0
      ? 'not_started'
      : confirmedSkus === totalSkus
        ? 'complete'
        : confirmedSkus > 0
          ? 'partial'
          : 'not_started',
    note: totalSkus === 0
      ? '全量活跃商品目录中尚无SKU'
      : `全量活跃商品目录 ${confirmedSkus}/${totalSkus} 个SKU已确认；${missingSpuSkus} 个缺少平台SPU；覆盖口径不依赖销量业务日`,
  };
}

function salesCoverage({
  businessDate,
  selectedSnapshots,
  storeHealth,
  totalStores,
}) {
  const acceptedStoreCodes = new Set(selectedSnapshots.map(({ storeCode }) => storeCode));
  const legalZeroRows = storeHealth.filter(
    ({ qualityStatus }) => qualityStatus === 'LEGAL_ZERO_UNANCHORED',
  );
  for (const row of legalZeroRows) acceptedStoreCodes.add(row.storeCode);
  const coveredStores = new Set(selectedSnapshots.map(({ storeCode }) => storeCode)).size;
  const legalZeroStores = legalZeroRows.length;
  const blockedStores = storeHealth.filter(
    ({ runStatus }) => runStatus === 'QUALITY_BLOCKED',
  ).length;
  const mixedStatisticsDateRows = storeHealth.filter(
    ({ probeDataQualityReason }) => probeDataQualityReason === MIXED_STATISTICS_DATES_CODE,
  );
  const mixedStatisticsDateStores = mixedStatisticsDateRows.length;
  const partialStoreCodes = new Set([
    ...storeHealth
      .filter(({ dateAnchorStatus }) => dateAnchorStatus === 'PARTIAL')
      .map(({ storeCode }) => storeCode),
    ...mixedStatisticsDateRows.map(({ storeCode }) => storeCode),
  ]);
  const partialStores = partialStoreCodes.size;
  const quarantinedRows = storeHealth.reduce(
    (sum, row) => sum + (row.quarantinedSkuCount ?? 0),
    0,
  );
  const acceptedStores = acceptedStoreCodes.size;
  const totalRows = storeHealth.reduce(
    (sum, row) => sum + (row.responseSkuCount ?? 0),
    0,
  );
  let status = 'unknown';
  let label = '等待销量数据';
  let reason = '尚无完整、可解释的销量观测';
  if (blockedStores > 0) {
    status = 'blocked';
    label = '存在隔离数据';
    reason = `${blockedStores} 家店存在非零销量但统计日期缺失，相关行未进入BI`
      + (mixedStatisticsDateStores > 0
        ? `；另有 ${mixedStatisticsDateStores} 家本轮日切返回混合统计日期`
        : '');
  } else if (mixedStatisticsDateStores > 0 && acceptedStores === 0) {
    status = 'blocked';
    label = '日切数据待收敛';
    reason = `${mixedStatisticsDateStores} 家本轮日切返回混合统计日期；沿用上一可信水位，未混入首页`;
  } else if (businessDate === null && legalZeroStores > 0) {
    status = acceptedStores === totalStores ? 'legal_zero' : 'partial';
    label = status === 'legal_zero' ? '合法零销量' : '部分店铺为合法零销量';
    reason = '接口完整返回零值，但统计日期未锚定';
  } else if (
    acceptedStores === totalStores
    && totalStores > 0
    && legalZeroStores === 0
    && partialStores === 0
  ) {
    status = 'complete';
    label = '同日覆盖完整';
    reason = '所有店铺均使用同一业务日，或有明确合法零值观测';
  } else if (acceptedStores > 0) {
    status = 'partial';
    label = '同日覆盖不完整';
    reason = mixedStatisticsDateStores > 0
      ? `${acceptedStores}/${totalStores} 家店进入当前统一业务日；${mixedStatisticsDateStores} 家本轮日切返回混合统计日期，沿用上一可信水位且未混算`
        + (quarantinedRows > 0
          ? `；另有 ${quarantinedRows} 个非零SKU因缺少统计日期已隔离`
          : '')
      : quarantinedRows > 0
        ? `${acceptedStores}/${totalStores} 家店可用于当前口径，${quarantinedRows} 个非零SKU因缺少统计日期已隔离`
        : `${acceptedStores}/${totalStores} 家店可用于当前口径，未混合其他统计日`;
  }
  return {
    businessDate,
    coveredStores,
    legalZeroStores,
    totalStores,
    status,
    label,
    reason,
    partialStores,
    mixedStatisticsDateStores,
    quarantinedRows,
    datedRows: selectedSnapshots.length,
    totalRows,
  };
}

export function buildDashboardFromProjectionInput(input, { storeCatalog = [] } = {}) {
  const owners = Array.isArray(input.owners) ? input.owners : [];
  const ownerByStore = new Map();
  for (const owner of owners) {
    for (const storeCode of Array.isArray(owner.storeCodes) ? owner.storeCodes : []) {
      ownerByStore.set(storeCode, owner);
    }
  }
  if (!Array.isArray(input.storePermissions) || input.storePermissions.length === 0) {
    return {
      datasetStatus: 'empty',
      updatedAt: null,
      permission: {
        status: storeCatalog.length > 0 ? 'pending' : 'unknown',
        authorizedStores: 0,
        totalStores: storeCatalog.length,
      },
      businessDate: null,
      salesCoverage: {
        businessDate: null, coveredStores: 0, legalZeroStores: 0,
        totalStores: storeCatalog.length, status: 'unknown', label: '等待销量数据',
        reason: '尚无完整、可解释的销量观测',
        partialStores: 0, mixedStatisticsDateStores: 0,
        quarantinedRows: 0, datedRows: 0, totalRows: 0,
      },
      quality: {
        status: 'unavailable', label: '暂无销量数据',
        reason: '尚未形成可信销量观测', impact: '销售卡片与排行榜不展示数值',
        nextStep: '完成接口同步并检查业务日期',
      },
      unitsSold: { ...EMPTY_UNITS },
      readiness: readiness({ storeHealth: [], storeCatalog }),
      salesTrend: [],
      salesTrendByStore: [],
      owners,
      storeRanking: storeCatalog.map(({ storeCode, storeName = storeCode }) => ({
        code: storeCode,
        name: storeName,
        ownerKey: ownerByStore.get(storeCode)?.key ?? null,
        ownerName: ownerByStore.get(storeCode)?.name ?? null,
        permissionStatus: 'pending',
        businessDate: null,
        qualityStatus: 'unavailable',
        qualityReason: '尚无可信销量观测',
        unitsSold: { ...EMPTY_UNITS },
      })),
      skuRanking: [],
      storeSkuRanking: [],
      productRanking: [],
      productIdentityCoverage: buildProductIdentityCoverage(
        input.productIdentityCatalog,
      ),
      // The identity pipeline is independent of the sales business date: an
      // empty sales window must not erase real evidence and assignment counts.
      productIdentityPipeline: input.productIdentityPipeline
        ?? UNAVAILABLE_PRODUCT_IDENTITY_PIPELINE,
    };
  }
  const storeHealth = Array.isArray(input.storeHealth) ? input.storeHealth : [];
  const legalZeroStoreCodes = new Set(
    storeHealth
      .filter(({ qualityStatus }) => qualityStatus === 'LEGAL_ZERO_UNANCHORED')
      .map(({ storeCode }) => storeCode),
  );
  const blockedStoreCodes = new Set(
    storeHealth
      .filter(({ runStatus }) => runStatus === 'QUALITY_BLOCKED')
      .map(({ storeCode }) => storeCode),
  );
  const mixedStatisticsDateStoreCodes = new Set(
    storeHealth
      .filter(({ probeDataQualityReason }) => (
        probeDataQualityReason === MIXED_STATISTICS_DATES_CODE
      ))
      .map(({ storeCode }) => storeCode),
  );
  const excludedCurrentStoreCodes = new Set([
    ...legalZeroStoreCodes,
    ...blockedStoreCodes,
    ...mixedStatisticsDateStoreCodes,
  ]);
  const activeStoreCodes = new Set(
    input.storePermissions.map(({ storeCode }) => storeCode),
  );
  const snapshots = (Array.isArray(input.snapshots) ? input.snapshots : [])
    .filter(({ storeCode }) => (
      activeStoreCodes.has(storeCode)
      && !excludedCurrentStoreCodes.has(storeCode)
    ));
  const businessDate = selectUnifiedBusinessDate(snapshots);
  const selectedSnapshots = businessDate === null
    ? []
    : snapshots.filter(({ statisticsDate }) => statisticsDate === businessDate);
  const projectedSnapshots = selectedSnapshots.map((snapshot) => ({
    ...snapshot,
    skuCode: storeSkuKey(snapshot.storeCode, snapshot.skuCode),
  }));
  const dashboard = projectDashboardData({
    snapshots: projectedSnapshots,
    storePermissions: input.storePermissions,
  });
  const healthByStore = new Map(storeHealth.map((row) => [row.storeCode, row]));
  const snapshotsByStore = new Map();
  for (const snapshot of selectedSnapshots) {
    const rows = snapshotsByStore.get(snapshot.storeCode) ?? [];
    rows.push(snapshot);
    snapshotsByStore.set(snapshot.storeCode, rows);
  }
  const ranking = input.storePermissions.map((permission) => {
    const health = healthByStore.get(permission.storeCode);
    const rows = snapshotsByStore.get(permission.storeCode) ?? [];
    const legalZero = health?.qualityStatus === 'LEGAL_ZERO_UNANCHORED';
    const blocked = health?.runStatus === 'QUALITY_BLOCKED';
    const mixedStatisticsDates =
      health?.probeDataQualityReason === MIXED_STATISTICS_DATES_CODE;
    let qualityStatus = 'unavailable';
    let qualityReason = '尚无可信销量观测';
    if (mixedStatisticsDates) {
      const dateCount = health?.probeStatisticsDateCount;
      const countText = Number.isSafeInteger(dateCount)
        ? `，检测到 ${dateCount} 个统计日`
        : '';
      const watermarkText = health?.watermarkDate
        ? `沿用上一可信水位 ${health.watermarkDate}`
        : '未推进可信水位';
      const currentDateText = businessDate
        ? `，未与首页业务日 ${businessDate} 混算`
        : '，未进入首页汇总';
      qualityStatus = 'stale';
      qualityReason = `本轮日切返回混合统计日期${countText}；${watermarkText}${currentDateText}`;
    } else if (blocked) {
      qualityStatus = 'error';
      qualityReason = '非零销量缺少统计日期，相关行已隔离';
    } else if (legalZero) {
      qualityStatus = 'legal_zero';
      qualityReason = '销量完整返回为0，但统计日期未锚定';
    } else if (rows.length > 0) {
      qualityStatus = health?.dateAnchorStatus === 'PARTIAL' ? 'partial' : 'healthy';
      const quarantinedPreview = (health?.quarantinedSkuCodes ?? []).slice(0, 5);
      const quarantinedSuffix = quarantinedPreview.length > 0
        ? `：${quarantinedPreview.join('、')}${(health?.quarantinedSkuCount ?? 0) > quarantinedPreview.length ? ' 等' : ''}`
        : '';
      qualityReason = health?.dateAnchorStatus === 'PARTIAL'
        ? (health?.quarantinedSkuCount ?? 0) > 0
          ? `${health.quarantinedSkuCount} 个非零SKU缺少统计日期，已隔离${quarantinedSuffix}`
          : '部分零销量SKU缺少统计日期'
        : '销量已按统一业务日入仓';
    } else if (health?.watermarkDate && health.watermarkDate !== businessDate) {
      qualityStatus = 'stale';
      qualityReason = `店铺业务日为 ${health.watermarkDate}，未与首页 ${businessDate} 混算`;
    }
    return {
      code: permission.storeCode,
      name: permission.storeName,
      ownerKey: ownerByStore.get(permission.storeCode)?.key ?? null,
      ownerName: ownerByStore.get(permission.storeCode)?.name ?? null,
      permissionStatus: permission.permissionStatus,
      businessDate: legalZero ? null : rows.length > 0 ? businessDate : health?.watermarkDate ?? null,
      qualityStatus,
      qualityReason,
      unitsSold: legalZero && health?.unitsSold
        ? health.unitsSold
        : sumSnapshotUnits(rows),
    };
  }).sort(compareUnits);
  const coverage = salesCoverage({
    businessDate,
    selectedSnapshots,
    storeHealth,
    totalStores: input.storePermissions.length,
  });
  const acceptedObservation = coverage.coveredStores > 0 || coverage.legalZeroStores > 0;
  const latestRunTime = storeHealth
    .flatMap(({ fetchedAt, probeAt }) => [fetchedAt, probeAt])
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const storeSkuRanking = buildStoreSkuRanking(
    selectedSnapshots,
    input.skuNames instanceof Map ? input.skuNames : new Map(),
  );
  dashboard.datasetStatus = acceptedObservation ? 'live' : 'empty';
  dashboard.updatedAt = latestRunTime ?? dashboard.updatedAt;
  dashboard.businessDate = businessDate;
  dashboard.salesCoverage = coverage;
  dashboard.quality = {
    status: coverage.status === 'complete'
      ? 'healthy'
      : coverage.status === 'legal_zero'
        ? 'legal_zero'
        : coverage.status === 'blocked'
          ? 'error'
          : coverage.status === 'partial'
            ? 'partial'
            : 'unavailable',
    label: coverage.label,
    reason: coverage.reason,
    impact: coverage.status === 'complete'
      ? '销售卡片、趋势和排行榜均使用同一业务日'
      : coverage.mixedStatisticsDateStores > 0
        ? '首页仅汇总统一业务日；混合日期店保留上一可信水位，但不进入当前销售卡片和排行榜'
          + (coverage.quarantinedRows > 0
            ? '；缺少统计日期的非零SKU也未计入'
            : '')
      : coverage.quarantinedRows > 0
        ? '销售卡片、趋势和排行榜仅汇总有日期的SKU；隔离SKU未计入，当前数值不是完整总量'
      : '首页只汇总可解释的同日数据，其他店铺保持空值或单独标注',
    nextStep: coverage.status === 'blocked'
      ? coverage.mixedStatisticsDateStores > 0
        ? '等待SHEIN日切收敛后由下一轮同步重试；不要选择日期或跨日补零'
          + (coverage.quarantinedRows > 0
            ? '；同时检查被隔离SKU并等待有效dt'
            : '')
        : '检查被隔离SKU并等待SHEIN返回有效dt'
      : coverage.mixedStatisticsDateStores > 0
        ? '等待SHEIN日切收敛后由下一轮同步重试；不要选择日期或跨日补零'
          + (coverage.quarantinedRows > 0
            ? '；同时检查被隔离SKU并等待有效dt'
            : '')
      : coverage.quarantinedRows > 0
        ? '检查隔离SKU并等待SHEIN返回有效dt后重跑'
      : coverage.status === 'partial'
        ? '继续同步未覆盖店铺，不要跨日补零'
        : null,
  };
  dashboard.unitsSold = selectedSnapshots.length > 0
    ? sumSnapshotUnits(selectedSnapshots)
    : coverage.status === 'legal_zero'
      ? { today: 0, yesterday: 0, last7Days: 0, last30Days: 0 }
      : { ...EMPTY_UNITS };
  dashboard.readiness = readiness({ storeHealth, storeCatalog });
  dashboard.salesTrendByStore = Array.isArray(input.salesTrend)
    ? input.salesTrend.filter(
        ({ storeCode }) => activeStoreCodes.has(storeCode),
      )
    : [];
  dashboard.salesTrend = buildTrendSeries(dashboard.salesTrendByStore);
  dashboard.owners = owners;
  dashboard.storeRanking = ranking;
  dashboard.storeSkuRanking = storeSkuRanking;
  dashboard.skuRanking = storeSkuRanking;
  dashboard.productRanking = buildProductRanking(selectedSnapshots);
  dashboard.productIdentityCoverage = buildProductIdentityCoverage(
    input.productIdentityCatalog,
  );
  dashboard.productIdentityPipeline = input.productIdentityPipeline
    ?? UNAVAILABLE_PRODUCT_IDENTITY_PIPELINE;
  return dashboard;
}

export async function materializeDashboardFromDatabase(pool, options = {}) {
  const [projection, operations, home] = await Promise.all([
    readDashboardProjectionInput(pool),
    readOperationsDashboard(pool),
    readFullHomeHistory(pool),
  ]);
  const dashboard = buildDashboardFromProjectionInput(projection, options);
  return {
    ...dashboard,
    ...operations,
    home,
  };
}

const UNAVAILABLE_FULL_HOME_HISTORY = Object.freeze({
  status: 'unavailable',
  storeDaily: Object.freeze([]),
  productDaily: Object.freeze([]),
  regionDaily: Object.freeze([]),
  financeDaily: Object.freeze([]),
  productFinanceDaily: Object.freeze([]),
  ledgerDaily: Object.freeze([]),
  billDaily: Object.freeze([]),
  settlementPositionDaily: Object.freeze([]),
  analysisCapabilities: Object.freeze([]),
  coverage: Object.freeze({
    earliestDate: null,
    latestDate: null,
    storeCount: 0,
    storeDailyRows: 0,
    productDailyRows: 0,
    regionDailyRows: 0,
    financeDailyRows: 0,
    productFinanceDailyRows: 0,
    ledgerDailyRows: 0,
    billDailyRows: 0,
    settlementPositionDailyRows: 0,
    latestObservedAt: null,
  }),
});

/**
 * Read the additive full-managed homepage history contract.
 *
 * The materialized payload retains nullable metrics exactly: a missing source
 * value is never converted to zero. The relation probe keeps older releases
 * deployable while migration 0014 is rolling out.
 */
export async function readFullHomeHistory(pool) {
  const client = await pool.connect();
  try {
    const schemaResult = await client.query(`
      SELECT
        to_regclass('fact.full_home_store_daily') IS NOT NULL AS has_store_daily,
        to_regclass('fact.full_home_product_daily') IS NOT NULL AS has_product_daily,
        to_regclass('fact.full_home_region_daily') IS NOT NULL AS has_region_daily,
        to_regclass('fact.full_home_finance_daily') IS NOT NULL AS has_finance_daily,
        to_regclass('fact.full_home_product_finance_daily') IS NOT NULL
          AS has_product_finance_daily,
        to_regclass('fact.full_home_ledger_daily') IS NOT NULL AS has_ledger_daily,
        to_regclass('fact.full_home_bill_daily') IS NOT NULL AS has_bill_daily,
        to_regclass('fact.full_home_finance_report_observation') IS NOT NULL
          AS has_finance_report_observation,
        to_regclass('raw.webapi_home_fetch_audit') IS NOT NULL
          AS has_home_fetch_audit,
        to_regclass('dim.reporting_goods') IS NOT NULL
          AS has_reporting_goods,
        to_regclass('dim.full_sku_reporting_goods_assignment') IS NOT NULL
          AS has_reporting_goods_assignment`);
    const schema = schemaResult.rows[0] ?? {};
    if (
      schema.has_store_daily !== true
      || schema.has_product_daily !== true
      || schema.has_region_daily !== true
    ) {
      return UNAVAILABLE_FULL_HOME_HISTORY;
    }
    const reportingGoodsResult = (
      schema.has_reporting_goods === true
      && schema.has_reporting_goods_assignment === true
    )
      ? await client.query(`
          SELECT store.store_code,
                 sku.platform_sku_id, sku.platform_skc_id, sku.platform_spu_id,
                 sku.supplier_code, sku.supplier_sku,
                 goods.standard_goods_code, goods.display_name,
                 goods.model_normalized, goods.naming_rule,
                 assignment.confidence_band, assignment.source_plan_hash
          FROM dim.full_sku_reporting_goods_assignment AS assignment
          JOIN dim.full_sku AS sku
            ON sku.store_id = assignment.store_id
           AND sku.full_sku_id = assignment.full_sku_id
          JOIN dim.store AS store ON store.store_id = assignment.store_id
          JOIN dim.reporting_goods AS goods
            ON goods.reporting_goods_id = assignment.reporting_goods_id
          WHERE assignment.assignment_status = 'CONFIRMED'
            AND assignment.valid_to IS NULL
            AND goods.status = 'ACTIVE'
            AND sku.is_active = true
            AND store.is_active = true
          ORDER BY store.store_code, sku.full_sku_id`)
      : { rows: [] };
    const reportingGoodsLookup = buildReportingGoodsLookup(reportingGoodsResult.rows);

    const [
      storeResult,
      productResult,
      regionResult,
      ledgerResult,
      analysisCapabilityResult,
    ] = await Promise.all([
      client.query(`
        SELECT store_code, to_char(business_date, 'YYYY-MM-DD') AS business_date,
               currency, deal_amount, net_deal_amount, sales_quantity,
               buyer_count, goods_detail_visitors, exposure_users,
               exposure_basis, stocking_order_count,
               urgent_purchase_order_count, payment_order_count,
               new_customer_sales_quantity,
               new_customer_payment_order_count, source_updated_at,
               observed_at, quality_status, source_codes
        FROM fact.full_home_store_daily
        ORDER BY business_date, store_code`),
      client.query(`
        SELECT store_code, to_char(business_date, 'YYYY-MM-DD') AS business_date,
               product_grain, product_key, platform_spu_id, platform_skc_id,
               supplier_code, supplier_sku, display_name, sales_quantity,
               estimated_deal_amount, estimation_currency,
               unit_price_evidence, estimation_basis, price_observed_at,
               source_updated_at, observed_at
        FROM fact.full_home_product_daily
        ORDER BY business_date, store_code, product_grain, product_key`),
      client.query(`
        SELECT store_code, to_char(business_date, 'YYYY-MM-DD') AS business_date,
               region_key, region_name, sales_quantity, sales_share,
               new_customer_sales_quantity, new_customer_sales_share,
               source_updated_at, observed_at
        FROM fact.full_home_region_daily
        ORDER BY business_date, store_code,
                 sales_quantity DESC NULLS LAST, region_key`),
      schema.has_ledger_daily === true
        ? client.query(`
            SELECT
              store_code,
              to_char(business_date, 'YYYY-MM-DD') AS business_date,
              currency,
              begin_balance_count, inbound_count, outbound_count,
              end_balance_count, urgent_order_entry_count,
              prepare_order_entry_count, inbound_gain_count,
              inbound_return_count, supply_change_in_count,
              adjustment_in_count, customer_outbound_count,
              direct_customer_outbound_count,
              platform_customer_outbound_count, outbound_loss_count,
              supplier_outbound_count, inventory_clear_count,
              report_clear_count, scrap_count, supply_change_out_count,
              adjustment_out_count, customer_loss_count,
              begin_balance_amount, inbound_amount, outbound_amount,
              end_balance_amount, urgent_order_entry_amount,
              prepare_order_entry_amount, inbound_gain_amount,
              inbound_return_amount, supply_change_in_amount,
              adjustment_in_amount, customer_outbound_amount,
              direct_customer_outbound_amount,
              platform_customer_outbound_amount, outbound_loss_amount,
              supplier_outbound_amount, inventory_clear_amount,
              report_clear_amount, scrap_amount, supply_change_out_amount,
              adjustment_out_amount, customer_loss_amount,
              observed_at, quality_status
            FROM fact.full_home_ledger_daily
            ORDER BY business_date, store_code`)
        : Promise.resolve({ rows: [] }),
      schema.has_home_fetch_audit === true
        ? client.query(`
            SELECT DISTINCT ON (store_code)
              store_code,
              result_status,
              sanitized_error_code,
              observed_at
            FROM raw.webapi_home_fetch_audit
            WHERE endpoint_code = 'ANALYSE_MODEL'
            ORDER BY store_code, observed_at DESC, webapi_home_fetch_audit_id DESC`)
        : Promise.resolve({ rows: [] }),
    ]);
    const hasFinance = (
      schema.has_finance_daily === true
      && schema.has_product_finance_daily === true
    );
    const [financeResult, productFinanceResult] = hasFinance
      ? await Promise.all([
          client.query(`
            SELECT store_code, to_char(business_date, 'YYYY-MM-DD') AS business_date,
                   currency, income_amount, expense_amount, net_amount,
                   goods_count, report_count, observed_at
            FROM fact.full_home_finance_daily
            ORDER BY business_date, store_code, currency`),
          client.query(`
            SELECT store_code, to_char(business_date, 'YYYY-MM-DD') AS business_date,
                   currency, product_key, platform_sku_id, platform_skc_id,
                   supplier_sku, income_amount, expense_amount, net_amount,
                   goods_count, latest_unit_price, price_observed_at, observed_at
            FROM fact.full_home_product_finance_daily
            ORDER BY business_date, store_code, currency, product_key`),
        ])
      : [{ rows: [] }, { rows: [] }];
    const billResult = schema.has_bill_daily === true
      ? await client.query(`
          SELECT
            store_code,
            to_char(business_date, 'YYYY-MM-DD') AS business_date,
            currency, sales_amount, supplement_amount, deduction_amount,
            calculated_settlement_amount, reported_settlement_amount,
            report_count, settled_report_count, pending_report_count,
            reconciliation_status, observed_at
          FROM fact.full_home_bill_daily
          ORDER BY business_date, store_code, currency`)
      : { rows: [] };
    const settlementPositionResult = schema.has_finance_report_observation === true
      ? await client.query(`
          WITH report_intervals AS (
            SELECT
              report.store_code,
              report.currency,
              report.report_generated_date AS position_start_date,
              CASE
                WHEN report.completed_pay_at IS NULL
                  THEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
                ELSE (report.completed_pay_at AT TIME ZONE 'Asia/Shanghai')::date - 1
              END AS position_end_date,
              report.expected_settlement_amount,
              (report.estimated_pay_at AT TIME ZONE 'Asia/Shanghai')::date
                AS estimated_pay_date,
              report.observed_at
            FROM fact.full_home_finance_report_observation AS report
            WHERE report.report_generated_date <= CASE
              WHEN report.completed_pay_at IS NULL
                THEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
              ELSE (report.completed_pay_at AT TIME ZONE 'Asia/Shanghai')::date - 1
            END
          ),
          positions AS (
            SELECT
              report.store_code,
              report.currency,
              position.position_date::date AS business_date,
              report.expected_settlement_amount,
              report.estimated_pay_date,
              report.observed_at
            FROM report_intervals AS report
            CROSS JOIN LATERAL generate_series(
              report.position_start_date,
              report.position_end_date,
              interval '1 day'
            ) AS position(position_date)
          )
          SELECT
            store_code,
            to_char(business_date, 'YYYY-MM-DD') AS business_date,
            currency,
            CASE
              WHEN COUNT(expected_settlement_amount) = COUNT(*)
                THEN SUM(expected_settlement_amount)
              ELSE NULL
            END AS pending_settlement_amount,
            COUNT(*) AS pending_report_count,
            COUNT(*) FILTER (
              WHERE estimated_pay_date IS NOT NULL
                AND estimated_pay_date < business_date
            ) AS overdue_report_count,
            MIN(estimated_pay_date) AS earliest_estimated_pay_date,
            MAX(estimated_pay_date) AS latest_estimated_pay_date,
            MAX(observed_at) AS observed_at
          FROM positions
          GROUP BY store_code, business_date, currency
          ORDER BY business_date, store_code, currency`)
      : { rows: [] };

    const storeDaily = storeResult.rows.map((row, index) => ({
      storeCode: row.store_code,
      date: pgDate(row.business_date),
      currency: row.currency ?? null,
      dealAmount: pgDecimal(row.deal_amount, `home.storeDaily[${index}].dealAmount`),
      netDealAmount: pgDecimal(
        row.net_deal_amount,
        `home.storeDaily[${index}].netDealAmount`,
      ),
      salesQuantity: pgCount(
        row.sales_quantity,
        `home.storeDaily[${index}].salesQuantity`,
      ),
      buyerCount: pgCount(row.buyer_count, `home.storeDaily[${index}].buyerCount`),
      goodsDetailVisitors: pgCount(
        row.goods_detail_visitors,
        `home.storeDaily[${index}].goodsDetailVisitors`,
      ),
      exposureUsers: pgCount(
        row.exposure_users,
        `home.storeDaily[${index}].exposureUsers`,
      ),
      exposureBasis: row.exposure_basis,
      stockingOrderCount: pgCount(
        row.stocking_order_count,
        `home.storeDaily[${index}].stockingOrderCount`,
      ),
      urgentPurchaseOrderCount: pgCount(
        row.urgent_purchase_order_count,
        `home.storeDaily[${index}].urgentPurchaseOrderCount`,
      ),
      paymentOrderCount: pgCount(
        row.payment_order_count,
        `home.storeDaily[${index}].paymentOrderCount`,
      ),
      newCustomerSalesQuantity: pgCount(
        row.new_customer_sales_quantity,
        `home.storeDaily[${index}].newCustomerSalesQuantity`,
      ),
      newCustomerPaymentOrderCount: pgCount(
        row.new_customer_payment_order_count,
        `home.storeDaily[${index}].newCustomerPaymentOrderCount`,
      ),
      sourceUpdatedAt: pgInstant(row.source_updated_at),
      observedAt: pgInstant(row.observed_at),
      qualityStatus: row.quality_status,
      sourceCodes: Array.isArray(row.source_codes) ? row.source_codes : [],
    }));
    const productDaily = productResult.rows.map((row, index) => {
      const item = {
        storeCode: row.store_code,
        date: pgDate(row.business_date),
        productGrain: row.product_grain,
        productKey: row.product_key,
        platformSpuId: row.platform_spu_id ?? null,
        platformSkcId: row.platform_skc_id ?? null,
        supplierCode: row.supplier_code ?? null,
        supplierSku: row.supplier_sku ?? null,
        displayName: row.display_name ?? null,
        salesQuantity: pgCount(
          row.sales_quantity,
          `home.productDaily[${index}].salesQuantity`,
        ),
        estimatedDealAmount: pgDecimal(
          row.estimated_deal_amount,
          `home.productDaily[${index}].estimatedDealAmount`,
        ),
        estimationCurrency: row.estimation_currency ?? null,
        unitPriceEvidence: pgDecimal(
          row.unit_price_evidence,
          `home.productDaily[${index}].unitPriceEvidence`,
        ),
        estimationBasis: row.estimation_basis,
        priceObservedAt: pgInstant(row.price_observed_at),
        sourceUpdatedAt: pgInstant(row.source_updated_at),
        observedAt: pgInstant(row.observed_at),
      };
      const mapping = resolveReportingGoodsAssignment(reportingGoodsLookup, item);
      return {
        ...item,
        standardGoodsCode: mapping?.standardGoodsCode ?? null,
        standardGoodsName: mapping?.standardGoodsName ?? null,
        reportingGoodsConfidence: mapping?.confidenceBand ?? null,
        reportingGoodsPlanHash: mapping?.sourcePlanHash ?? null,
        reportingMappingStatus: mapping ? 'OWNER_CONFIRMED' : 'UNMAPPED',
      };
    });
    const regionDaily = regionResult.rows.map((row, index) => ({
      storeCode: row.store_code,
      date: pgDate(row.business_date),
      regionKey: row.region_key,
      regionName: row.region_name,
      salesQuantity: pgCount(
        row.sales_quantity,
        `home.regionDaily[${index}].salesQuantity`,
      ),
      salesShare: pgDecimal(
        row.sales_share,
        `home.regionDaily[${index}].salesShare`,
      ),
      newCustomerSalesQuantity: pgCount(
        row.new_customer_sales_quantity,
        `home.regionDaily[${index}].newCustomerSalesQuantity`,
      ),
      newCustomerSalesShare: pgDecimal(
        row.new_customer_sales_share,
        `home.regionDaily[${index}].newCustomerSalesShare`,
      ),
      sourceUpdatedAt: pgInstant(row.source_updated_at),
      observedAt: pgInstant(row.observed_at),
    }));
    const ledgerCountFields = Object.freeze([
      ['beginBalanceCount', 'begin_balance_count'],
      ['inboundCount', 'inbound_count'],
      ['outboundCount', 'outbound_count'],
      ['endBalanceCount', 'end_balance_count'],
      ['urgentOrderEntryCount', 'urgent_order_entry_count'],
      ['prepareOrderEntryCount', 'prepare_order_entry_count'],
      ['inboundGainCount', 'inbound_gain_count'],
      ['inboundReturnCount', 'inbound_return_count'],
      ['supplyChangeInCount', 'supply_change_in_count'],
      ['adjustmentInCount', 'adjustment_in_count'],
      ['customerOutboundCount', 'customer_outbound_count'],
      ['directCustomerOutboundCount', 'direct_customer_outbound_count'],
      ['platformCustomerOutboundCount', 'platform_customer_outbound_count'],
      ['outboundLossCount', 'outbound_loss_count'],
      ['supplierOutboundCount', 'supplier_outbound_count'],
      ['inventoryClearCount', 'inventory_clear_count'],
      ['reportClearCount', 'report_clear_count'],
      ['scrapCount', 'scrap_count'],
      ['supplyChangeOutCount', 'supply_change_out_count'],
      ['adjustmentOutCount', 'adjustment_out_count'],
      ['customerLossCount', 'customer_loss_count'],
    ]);
    const ledgerAmountFields = Object.freeze([
      ['beginBalanceAmount', 'begin_balance_amount'],
      ['inboundAmount', 'inbound_amount'],
      ['outboundAmount', 'outbound_amount'],
      ['endBalanceAmount', 'end_balance_amount'],
      ['urgentOrderEntryAmount', 'urgent_order_entry_amount'],
      ['prepareOrderEntryAmount', 'prepare_order_entry_amount'],
      ['inboundGainAmount', 'inbound_gain_amount'],
      ['inboundReturnAmount', 'inbound_return_amount'],
      ['supplyChangeInAmount', 'supply_change_in_amount'],
      ['adjustmentInAmount', 'adjustment_in_amount'],
      ['customerOutboundAmount', 'customer_outbound_amount'],
      ['directCustomerOutboundAmount', 'direct_customer_outbound_amount'],
      ['platformCustomerOutboundAmount', 'platform_customer_outbound_amount'],
      ['outboundLossAmount', 'outbound_loss_amount'],
      ['supplierOutboundAmount', 'supplier_outbound_amount'],
      ['inventoryClearAmount', 'inventory_clear_amount'],
      ['reportClearAmount', 'report_clear_amount'],
      ['scrapAmount', 'scrap_amount'],
      ['supplyChangeOutAmount', 'supply_change_out_amount'],
      ['adjustmentOutAmount', 'adjustment_out_amount'],
      ['customerLossAmount', 'customer_loss_amount'],
    ]);
    const ledgerDaily = ledgerResult.rows.map((row, index) => ({
      storeCode: row.store_code,
      date: pgDate(row.business_date),
      currency: row.currency ?? null,
      ...Object.fromEntries(ledgerCountFields.map(([target, source]) => [
        target,
        pgCount(row[source], `home.ledgerDaily[${index}].${target}`),
      ])),
      ...Object.fromEntries(ledgerAmountFields.map(([target, source]) => [
        target,
        pgDecimal(row[source], `home.ledgerDaily[${index}].${target}`),
      ])),
      observedAt: pgInstant(row.observed_at),
      qualityStatus: row.quality_status,
      basis: 'OFFICIAL_INVENTORY_LEDGER',
    }));
    const financeDaily = financeResult.rows.map((row, index) => ({
      storeCode: row.store_code,
      date: pgDate(row.business_date),
      currency: row.currency,
      incomeAmount: pgDecimal(
        row.income_amount,
        `home.financeDaily[${index}].incomeAmount`,
      ),
      expenseAmount: pgDecimal(
        row.expense_amount,
        `home.financeDaily[${index}].expenseAmount`,
      ),
      netAmount: pgSignedDecimal(
        row.net_amount,
        `home.financeDaily[${index}].netAmount`,
      ),
      goodsCount: pgCount(row.goods_count, `home.financeDaily[${index}].goodsCount`),
      reportCount: pgCount(
        row.report_count,
        `home.financeDaily[${index}].reportCount`,
      ),
      observedAt: pgInstant(row.observed_at),
      basis: 'FINANCE_DETAIL_BUSINESS_DATE',
    }));
    const billDaily = billResult.rows.map((row, index) => ({
      storeCode: row.store_code,
      date: pgDate(row.business_date),
      currency: row.currency,
      salesAmount: pgSignedDecimal(
        row.sales_amount,
        `home.billDaily[${index}].salesAmount`,
      ),
      supplementAmount: pgDecimal(
        row.supplement_amount,
        `home.billDaily[${index}].supplementAmount`,
      ),
      deductionAmount: pgDecimal(
        row.deduction_amount,
        `home.billDaily[${index}].deductionAmount`,
      ),
      calculatedSettlementAmount: pgSignedDecimal(
        row.calculated_settlement_amount,
        `home.billDaily[${index}].calculatedSettlementAmount`,
      ),
      reportedSettlementAmount: pgSignedDecimal(
        row.reported_settlement_amount,
        `home.billDaily[${index}].reportedSettlementAmount`,
      ),
      reportCount: pgCount(
        row.report_count,
        `home.billDaily[${index}].reportCount`,
      ),
      settledReportCount: pgCount(
        row.settled_report_count,
        `home.billDaily[${index}].settledReportCount`,
      ),
      pendingReportCount: pgCount(
        row.pending_report_count,
        `home.billDaily[${index}].pendingReportCount`,
      ),
      reconciliationStatus: row.reconciliation_status,
      observedAt: pgInstant(row.observed_at),
      basis: 'ACTUAL_SETTLEMENT_DATE',
    }));
    const settlementPositionDaily = settlementPositionResult.rows.map((row, index) => ({
      storeCode: row.store_code,
      date: pgDate(row.business_date),
      currency: row.currency,
      pendingSettlementAmount: pgSignedDecimal(
        row.pending_settlement_amount,
        `home.settlementPositionDaily[${index}].pendingSettlementAmount`,
      ),
      pendingReportCount: pgCount(
        row.pending_report_count,
        `home.settlementPositionDaily[${index}].pendingReportCount`,
      ),
      overdueReportCount: pgCount(
        row.overdue_report_count,
        `home.settlementPositionDaily[${index}].overdueReportCount`,
      ),
      earliestEstimatedPayDate: pgDate(row.earliest_estimated_pay_date),
      latestEstimatedPayDate: pgDate(row.latest_estimated_pay_date),
      observedAt: pgInstant(row.observed_at),
      basis: 'END_OF_PERIOD_PENDING_POSITION',
    }));
    const productFinanceDaily = productFinanceResult.rows.map((row, index) => {
      const item = {
        storeCode: row.store_code,
        date: pgDate(row.business_date),
        currency: row.currency,
        productKey: row.product_key,
        platformSkuId: row.platform_sku_id ?? null,
        platformSkcId: row.platform_skc_id ?? null,
        supplierSku: row.supplier_sku ?? null,
        incomeAmount: pgDecimal(
          row.income_amount,
          `home.productFinanceDaily[${index}].incomeAmount`,
        ),
        expenseAmount: pgDecimal(
          row.expense_amount,
          `home.productFinanceDaily[${index}].expenseAmount`,
        ),
        netAmount: pgSignedDecimal(
          row.net_amount,
          `home.productFinanceDaily[${index}].netAmount`,
        ),
        goodsCount: pgCount(
          row.goods_count,
          `home.productFinanceDaily[${index}].goodsCount`,
        ),
        latestUnitPrice: pgDecimal(
          row.latest_unit_price,
          `home.productFinanceDaily[${index}].latestUnitPrice`,
        ),
        priceObservedAt: pgInstant(row.price_observed_at),
        observedAt: pgInstant(row.observed_at),
        basis: 'FINANCE_DETAIL_BUSINESS_DATE',
      };
      const mapping = resolveReportingGoodsAssignment(reportingGoodsLookup, item);
      return {
        ...item,
        standardGoodsCode: mapping?.standardGoodsCode ?? null,
        standardGoodsName: mapping?.standardGoodsName ?? null,
        reportingGoodsConfidence: mapping?.confidenceBand ?? null,
        reportingGoodsPlanHash: mapping?.sourcePlanHash ?? null,
        reportingMappingStatus: mapping ? 'OWNER_CONFIRMED' : 'UNMAPPED',
      };
    });
    const analysisCapabilities = analysisCapabilityResult.rows.map((row) => ({
      storeCode: row.store_code,
      status: row.result_status === 'SUCCEEDED'
        ? 'available'
        : row.sanitized_error_code === 'HOME_ANALYSE_PERMISSION_DENIED'
          ? 'permission_denied'
          : 'attention',
      errorCode: row.sanitized_error_code ?? null,
      observedAt: pgInstant(row.observed_at),
    }));
    const allDates = [
      ...storeDaily,
      ...financeDaily,
      ...ledgerDaily,
      ...billDaily,
      ...settlementPositionDaily,
    ]
      .map(({ date }) => date)
      .filter(Boolean)
      .sort();
    const observed = [
      ...storeDaily,
      ...productDaily,
      ...regionDaily,
      ...financeDaily,
      ...productFinanceDaily,
      ...ledgerDaily,
      ...billDaily,
      ...settlementPositionDaily,
    ]
      .map(({ observedAt }) => observedAt)
      .filter(Boolean)
      .sort();
    return {
      status: storeDaily.length > 0
        || financeDaily.length > 0
        || ledgerDaily.length > 0
        || billDaily.length > 0
        || settlementPositionDaily.length > 0
        ? 'available'
        : 'empty',
      storeDaily,
      productDaily,
      regionDaily,
      financeDaily,
      productFinanceDaily,
      ledgerDaily,
      billDaily,
      settlementPositionDaily,
      analysisCapabilities,
      coverage: {
        earliestDate: allDates[0] ?? null,
        latestDate: allDates.at(-1) ?? null,
        storeCount: new Set(
          [
            ...storeDaily,
            ...financeDaily,
            ...ledgerDaily,
            ...billDaily,
            ...settlementPositionDaily,
          ]
            .map(({ storeCode }) => storeCode),
        ).size,
        storeDailyRows: storeDaily.length,
        productDailyRows: productDaily.length,
        regionDailyRows: regionDaily.length,
        financeDailyRows: financeDaily.length,
        productFinanceDailyRows: productFinanceDaily.length,
        ledgerDailyRows: ledgerDaily.length,
        billDailyRows: billDaily.length,
        settlementPositionDailyRows: settlementPositionDaily.length,
        reportingGoodsCount: new Set(
          reportingGoodsResult.rows.map(({ standard_goods_code: code }) => code),
        ).size,
        reportingGoodsAssignedSkuCount: reportingGoodsResult.rows.length,
        reportingGoodsPlanCount: new Set(
          reportingGoodsResult.rows.map(({ source_plan_hash: hash }) => hash),
        ).size,
        latestObservedAt: observed.at(-1) ?? null,
      },
    };
  } finally {
    client.release();
  }
}

export async function atomicWriteJson(filePath, value) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, resolved);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return resolved;
}

export function splitDashboardArtifacts(dashboardValue) {
  const dashboard = dashboardValue && typeof dashboardValue === 'object'
    && !Array.isArray(dashboardValue)
    ? dashboardValue
    : {};
  const home = dashboard.home && typeof dashboard.home === 'object'
    && !Array.isArray(dashboard.home)
    ? dashboard.home
    : {};
  return Object.freeze({
    core: Object.freeze({
      ...dashboard,
      home: Object.freeze({
        status: home.status ?? 'unavailable',
        coverage: home.coverage ?? {},
      }),
    }),
    home: Object.freeze({
      schemaVersion: 1,
      updatedAt: home.coverage?.latestObservedAt ?? dashboard.updatedAt ?? null,
      home,
    }),
  });
}
