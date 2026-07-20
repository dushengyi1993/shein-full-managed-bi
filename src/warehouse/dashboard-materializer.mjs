import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { projectDashboardData } from '../domain/dashboard-projection.mjs';

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

function shanghaiDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('Invalid PostgreSQL date value');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}`;
}

function stageStatus(completed, total, { pending = false, blocked = false } = {}) {
  if (total > 0 && completed === total) return 'complete';
  if (blocked) return 'blocked';
  if (pending || completed > 0) return 'pending';
  return 'not_started';
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
          SELECT DISTINCT ON (store_id) store_id, outcome, probed_at
          FROM ops.permission_probe
          WHERE capability_code = 'FULL_MANAGED_SKU_SALES'
          ORDER BY store_id, probed_at DESC, permission_probe_id DESC
        )
        SELECT s.store_code, s.store_name, p.outcome, p.probed_at,
               (p.outcome = 'GRANTED' AND EXISTS (
                 SELECT 1 FROM fact.full_sku_sales_snapshot f WHERE f.store_id = s.store_id
               )) AS has_facts
        FROM dim.store s
        LEFT JOIN latest_probe p ON p.store_id = s.store_id
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
                 f.store_id, f.full_sku_id, f.source_row_key, f.sales_quantity,
                 f.metric_window_end, f.snapshot_at
          FROM fact.full_sku_sales_snapshot f
          ORDER BY f.store_id, f.full_sku_id, split_part(f.source_row_key, ':', 1),
                   f.snapshot_at DESC, f.updated_at DESC, f.sales_snapshot_id DESC
        )
        SELECT s.store_code, sku.platform_sku_id,
               max(latest.snapshot_at) AS fetched_at,
               max(latest.metric_window_end) AS metric_window_end,
               max(latest.sales_quantity) FILTER (WHERE split_part(latest.source_row_key, ':', 1) = 'today') AS sales_today,
               max(latest.sales_quantity) FILTER (WHERE split_part(latest.source_row_key, ':', 1) = 'yesterday') AS sales_yesterday,
               max(latest.sales_quantity) FILTER (WHERE split_part(latest.source_row_key, ':', 1) = 'last7Days') AS sales_7_days,
               max(latest.sales_quantity) FILTER (WHERE split_part(latest.source_row_key, ':', 1) = 'last30Days') AS sales_30_days,
               count(DISTINCT split_part(latest.source_row_key, ':', 1)) AS window_count
        FROM latest
        JOIN dim.store s ON s.store_id = latest.store_id
        JOIN dim.full_sku sku ON sku.full_sku_id = latest.full_sku_id
        JOIN latest_probe p ON p.store_id = latest.store_id AND p.outcome = 'GRANTED'
        GROUP BY s.store_code, sku.platform_sku_id
        HAVING count(DISTINCT split_part(latest.source_row_key, ':', 1)) = 4`),
      client.query(`
        SELECT platform_sku_id, max(COALESCE(NULLIF(sku_name, ''), NULLIF(product_name, ''), platform_sku_id)) AS display_name
        FROM dim.full_sku
        GROUP BY platform_sku_id`),
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
          WHERE split_part(f.source_row_key, ':', 1) IN ('today', 'yesterday')
        )
        SELECT sales_date, sum(sales_quantity) AS units_sold
        FROM daily_candidates
        WHERE recency = 1
        GROUP BY sales_date
        ORDER BY sales_date DESC
        LIMIT 30`),
    ]);

    const storePermissions = storesResult.rows.map((row) => ({
      storeCode: row.store_code,
      storeName: row.store_name,
      permissionStatus: mapPermission(row.outcome),
    }));
    const snapshots = snapshotsResult.rows.map((row, index) => {
      const end = new Date(new Date(row.metric_window_end).getTime() - 1);
      return {
        storeCode: row.store_code,
        skuCode: row.platform_sku_id,
        salesToday: pgInteger(row.sales_today, `snapshots[${index}].salesToday`),
        salesYesterday: pgInteger(row.sales_yesterday, `snapshots[${index}].salesYesterday`),
        sales7Days: pgInteger(row.sales_7_days, `snapshots[${index}].sales7Days`),
        sales30Days: pgInteger(row.sales_30_days, `snapshots[${index}].sales30Days`),
        statisticsDate: shanghaiDate(end),
        fetchedAt: new Date(row.fetched_at).toISOString(),
      };
    });
    const projection = {
      storePermissions,
      snapshots,
      skuNames: new Map(skuNamesResult.rows.map((row) => [row.platform_sku_id, row.display_name])),
      salesTrend: trendResult.rows
        .map((row) => ({
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
      })),
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
  const facts = storeHealth.filter(({ hasFacts }) => hasFacts).length;
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
      note: '已完整落入四个销量窗口的店铺数',
    },
  ];
}

export function buildDashboardFromProjectionInput(input, { storeCatalog = [] } = {}) {
  if (!Array.isArray(input.storePermissions) || input.storePermissions.length === 0) {
    return {
      datasetStatus: 'empty',
      updatedAt: null,
      permission: {
        status: storeCatalog.length > 0 ? 'pending' : 'unknown',
        authorizedStores: 0,
        totalStores: storeCatalog.length,
      },
      unitsSold: { today: null, yesterday: null, last7Days: null, last30Days: null },
      readiness: readiness({ storeHealth: [], storeCatalog }),
      salesTrend: [],
      storeRanking: storeCatalog.map(({ storeCode, storeName = storeCode }) => ({
        code: storeCode,
        name: storeName,
        permissionStatus: 'pending',
        unitsSold: { today: null, last7Days: null, last30Days: null },
      })),
      skuRanking: [],
    };
  }
  const dashboard = projectDashboardData({
    snapshots: input.snapshots,
    storePermissions: input.storePermissions,
  });
  dashboard.readiness = readiness({ storeHealth: input.storeHealth, storeCatalog });
  dashboard.salesTrend = input.salesTrend;
  dashboard.skuRanking = dashboard.skuRanking.map((item) => ({
    ...item,
    name: input.skuNames.get(item.sku) ?? item.sku,
  }));
  return dashboard;
}

export async function materializeDashboardFromDatabase(pool, options = {}) {
  return buildDashboardFromProjectionInput(await readDashboardProjectionInput(pool), options);
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
