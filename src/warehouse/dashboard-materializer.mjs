import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { projectDashboardData } from '../domain/dashboard-projection.mjs';
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

function stageStatus(completed, total, { pending = false, blocked = false } = {}) {
  if (total > 0 && completed === total) return 'complete';
  if (blocked) return 'blocked';
  if (pending || completed > 0) return 'pending';
  return 'not_started';
}

function storeSkuKey(storeCode, skuCode) {
  return `${storeCode}\u001f${skuCode}`;
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
          SELECT DISTINCT ON (store_id) store_id, outcome, evidence, probed_at
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
               (p.outcome = 'GRANTED' AND EXISTS (
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
          SELECT DISTINCT ON (store_id) store_id, outcome
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
        JOIN latest_probe p ON p.store_id = latest.store_id AND p.outcome = 'GRANTED'
        JOIN ops.sales_business_watermark w ON w.store_id = latest.store_id
        WHERE s.cooperation_mode = 'FULL_MANAGED'
          AND s.is_active = true
        GROUP BY s.store_code, sku.platform_sku_id, sku.platform_skc_id,
                 sku.supplier_code, sku.supplier_sku, sku.product_key,
                 sku.sku_name, sku.product_name, w.business_date
        HAVING count(DISTINCT split_part(latest.source_row_key, ':', 1)) = 4`),
      client.query(`
        SELECT s.store_code, sku.platform_sku_id,
               COALESCE(NULLIF(sku.sku_name, ''), NULLIF(sku.product_name, ''), sku.platform_sku_id) AS display_name
        FROM dim.full_sku sku
        JOIN dim.store s ON s.store_id = sku.store_id
        WHERE sku.is_active = true
          AND s.cooperation_mode = 'FULL_MANAGED'
          AND s.is_active = true`),
      client.query(`
        WITH latest_probe AS (
          SELECT DISTINCT ON (store_id) store_id, outcome
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
          JOIN latest_probe p ON p.store_id = f.store_id AND p.outcome = 'GRANTED'
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

    const storePermissions = storesResult.rows.map((row) => ({
      storeCode: row.store_code,
      storeName: row.store_name,
      permissionStatus: mapPermission(row.outcome),
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
        permissionStatus: mapPermission(row.outcome),
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
    ({ hasFacts, qualityStatus }) => hasFacts || qualityStatus === 'LEGAL_ZERO_UNANCHORED',
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
      note: '已落入四个销量窗口，或已确认合法零值但日期未锚定的店铺数',
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
  const partialStores = storeHealth.filter(
    ({ dateAnchorStatus }) => dateAnchorStatus === 'PARTIAL',
  ).length;
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
    reason = `${blockedStores} 家店存在非零销量但统计日期缺失，相关行未进入BI`;
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
    reason = quarantinedRows > 0
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
        partialStores: 0, quarantinedRows: 0, datedRows: 0, totalRows: 0,
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
  const excludedCurrentStoreCodes = new Set([
    ...legalZeroStoreCodes,
    ...blockedStoreCodes,
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
    let qualityStatus = 'unavailable';
    let qualityReason = '尚无可信销量观测';
    if (blocked) {
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
    .map(({ fetchedAt }) => fetchedAt)
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
      : coverage.quarantinedRows > 0
        ? '销售卡片、趋势和排行榜仅汇总有日期的SKU；隔离SKU未计入，当前数值不是完整总量'
      : '首页只汇总可解释的同日数据，其他店铺保持空值或单独标注',
    nextStep: coverage.status === 'blocked'
      ? '检查被隔离SKU并等待SHEIN返回有效dt'
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
  return dashboard;
}

export async function materializeDashboardFromDatabase(pool, options = {}) {
  const dashboard = buildDashboardFromProjectionInput(
    await readDashboardProjectionInput(pool),
    options,
  );
  const operations = await readOperationsDashboard(pool);
  return {
    ...dashboard,
    ...operations,
  };
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
