import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DASHBOARD_DATA_FILE = fileURLToPath(
  new URL('../../tests/fixtures/dashboard.json', import.meta.url),
);

const PERMISSION_LABELS = Object.freeze({
  granted: '销量查询权限已授权',
  partial: '销量查询权限部分授权',
  pending: '销量查询权限申请中',
  denied: '销量查询权限未通过',
  unknown: '销量查询权限待确认',
});

const DATASET_LABELS = Object.freeze({
  live: '实时数据',
  empty: '暂无销量快照',
  sample: '本地示例数据',
});

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, fallback = '', maxLength = 120) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function nonNegativeInteger(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function unitCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function permissionStatus(value) {
  return Object.hasOwn(PERMISSION_LABELS, value) ? value : 'unknown';
}

function normalizeUnits(value, includeYesterday = false) {
  const units = record(value);
  const normalized = {
    today: unitCount(units.today),
    last7Days: unitCount(units.last7Days),
    last30Days: unitCount(units.last30Days),
  };

  if (includeYesterday) {
    normalized.yesterday = unitCount(units.yesterday);
    return {
      today: normalized.today,
      yesterday: normalized.yesterday,
      last7Days: normalized.last7Days,
      last30Days: normalized.last30Days,
    };
  }

  return normalized;
}

function normalizeStore(item) {
  const source = record(item);
  const status = permissionStatus(source.permissionStatus);
  return {
    code: text(source.code, '未知店铺', 24),
    name: text(source.name, text(source.code, '未知店铺', 24), 80),
    unitsSold: normalizeUnits(source.unitsSold),
    permission: {
      status,
      label: PERMISSION_LABELS[status],
    },
  };
}

function normalizeSku(item) {
  const source = record(item);
  return {
    sku: text(source.sku, '未知 SKU', 64),
    name: text(source.name, '未命名商品', 120),
    unitsSold: normalizeUnits(source.unitsSold),
  };
}

function sortRanking(items) {
  const rankValue = (value) => (Number.isSafeInteger(value) ? value : -1);
  return items
    .sort((left, right) => {
      return (
        rankValue(right.unitsSold.last30Days) - rankValue(left.unitsSold.last30Days) ||
        rankValue(right.unitsSold.last7Days) - rankValue(left.unitsSold.last7Days) ||
        rankValue(right.unitsSold.today) - rankValue(left.unitsSold.today)
      );
    })
    .slice(0, 100);
}

export function normalizeDashboardData(input) {
  const source = record(input);
  const permissionSource = record(source.permission);
  const status = permissionStatus(permissionSource.status);
  const datasetStatus = ['live', 'empty'].includes(source.datasetStatus)
    ? source.datasetStatus
    : 'sample';
  const hasUpdatedAt = source.updatedAt !== null && source.updatedAt !== undefined;
  const updatedAt = hasUpdatedAt ? new Date(source.updatedAt) : null;
  const totalStores = nonNegativeInteger(permissionSource.totalStores);
  const authorizedStores = Math.min(
    nonNegativeInteger(permissionSource.authorizedStores),
    totalStores,
  );

  if (updatedAt && Number.isNaN(updatedAt.valueOf())) {
    throw new TypeError('Dashboard data must include a valid updatedAt timestamp.');
  }

  const storeRanking = Array.isArray(source.storeRanking)
    ? sortRanking(source.storeRanking.map(normalizeStore))
    : [];
  const skuRanking = Array.isArray(source.skuRanking)
    ? sortRanking(source.skuRanking.map(normalizeSku))
    : [];

  return {
    schemaVersion: 1,
    readOnly: true,
    dataset: {
      status: datasetStatus,
      label: DATASET_LABELS[datasetStatus],
    },
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    permission: {
      status,
      label: PERMISSION_LABELS[status],
      authorizedStores,
      totalStores,
    },
    unitsSold: normalizeUnits(source.unitsSold, true),
    storeRanking,
    skuRanking,
  };
}

export async function loadDashboardData(dataFile = process.env.FULL_BI_DATA_FILE) {
  const selectedFile = dataFile || DEFAULT_DASHBOARD_DATA_FILE;
  const content = await readFile(selectedFile, 'utf8');
  return normalizeDashboardData(JSON.parse(content));
}
