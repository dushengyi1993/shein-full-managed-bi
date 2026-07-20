/**
 * Project validated, flat SKU sales snapshots into the local BI portal shape.
 *
 * Snapshot history is first reduced to one latest record per (store, SKU).
 * Older observations therefore never inflate current rolling-window totals.
 */

const PERMISSION_STATUSES = new Set([
  'granted',
  'partial',
  'pending',
  'denied',
  'unknown',
]);

const SALES_FIELDS = Object.freeze([
  ['salesToday', 'today'],
  ['salesYesterday', 'yesterday'],
  ['sales7Days', 'last7Days'],
  ['sales30Days', 'last30Days'],
]);

export class DashboardProjectionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DashboardProjectionError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new DashboardProjectionError(code, message, details);
}

function record(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_FIELD', `${path} must be an object`, { path, value });
  }

  return value;
}

function nonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('INVALID_FIELD', `${path} must be a non-empty string`, { path, value });
  }

  return value.trim();
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value)) {
    fail('INVALID_SALES_COUNT', `${path} must be a safe integer`, { path, value });
  }

  if (value < 0) {
    fail('NEGATIVE_SALES_COUNT', `${path} cannot be negative`, { path, value });
  }

  return value;
}

function statisticsDate(value, path) {
  const normalized = nonEmptyString(value, path);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) {
    fail('INVALID_STATISTICS_DATE', `${path} must use YYYY-MM-DD format`, {
      path,
      value,
    });
  }

  const [, year, month, day] = match;
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    fail('INVALID_STATISTICS_DATE', `${path} is not a valid calendar date`, {
      path,
      value,
    });
  }

  return normalized;
}

function fetchedAt(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('INVALID_FETCHED_AT', `${path} must be an ISO date-time string`, {
      path,
      value,
    });
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    fail('INVALID_FETCHED_AT', `${path} must be a valid date-time`, { path, value });
  }

  return date.toISOString();
}

function normalizePermissions(storePermissions) {
  if (!Array.isArray(storePermissions) || storePermissions.length === 0) {
    fail('INVALID_STORE_PERMISSIONS', 'storePermissions must be a non-empty array');
  }

  const seen = new Set();
  return storePermissions.map((rawPermission, index) => {
    const path = `storePermissions[${index}]`;
    const permission = record(rawPermission, path);
    const storeCode = nonEmptyString(permission.storeCode, `${path}.storeCode`);
    const storeName = permission.storeName === undefined || permission.storeName === null
      ? storeCode
      : nonEmptyString(permission.storeName, `${path}.storeName`);
    const permissionStatus = nonEmptyString(
      permission.permissionStatus,
      `${path}.permissionStatus`,
    );

    if (!PERMISSION_STATUSES.has(permissionStatus)) {
      fail('INVALID_PERMISSION_STATUS', `${path}.permissionStatus is unsupported`, {
        path: `${path}.permissionStatus`,
        value: permissionStatus,
      });
    }

    if (seen.has(storeCode)) {
      fail('DUPLICATE_STORE_PERMISSION', `duplicate permission state for store ${storeCode}`, {
        storeCode,
      });
    }
    seen.add(storeCode);

    return { storeCode, storeName, permissionStatus };
  });
}

function normalizeSnapshots(snapshots, permittedStoreCodes) {
  if (!Array.isArray(snapshots)) {
    fail('INVALID_SNAPSHOTS', 'snapshots must be an array', { value: snapshots });
  }

  return snapshots.map((rawSnapshot, index) => {
    const path = `snapshots[${index}]`;
    const snapshot = record(rawSnapshot, path);
    const storeCode = nonEmptyString(snapshot.storeCode, `${path}.storeCode`);
    const skuCode = nonEmptyString(snapshot.skuCode, `${path}.skuCode`);

    if (!permittedStoreCodes.has(storeCode)) {
      fail('UNKNOWN_SNAPSHOT_STORE', `snapshot store ${storeCode} has no permission state`, {
        storeCode,
        path: `${path}.storeCode`,
      });
    }

    const normalized = {
      storeCode,
      skuCode,
      statisticsDate: statisticsDate(snapshot.statisticsDate, `${path}.statisticsDate`),
      fetchedAt: fetchedAt(snapshot.fetchedAt, `${path}.fetchedAt`),
    };

    for (const [sourceField] of SALES_FIELDS) {
      normalized[sourceField] = nonNegativeInteger(
        snapshot[sourceField],
        `${path}.${sourceField}`,
      );
    }

    return normalized;
  });
}

function isNewer(candidate, current) {
  return (
    candidate.statisticsDate > current.statisticsDate ||
    (
      candidate.statisticsDate === current.statisticsDate &&
      candidate.fetchedAt > current.fetchedAt
    )
  );
}

/** Select one latest snapshot for every store/SKU pair. */
export function selectLatestSkuSalesSnapshots(snapshots, storePermissions) {
  const permissions = normalizePermissions(storePermissions);
  const permittedStoreCodes = new Set(permissions.map(({ storeCode }) => storeCode));
  const normalizedSnapshots = normalizeSnapshots(snapshots, permittedStoreCodes);
  const byStore = new Map();

  for (const snapshot of normalizedSnapshots) {
    let bySku = byStore.get(snapshot.storeCode);
    if (!bySku) {
      bySku = new Map();
      byStore.set(snapshot.storeCode, bySku);
    }

    const current = bySku.get(snapshot.skuCode);
    if (!current || isNewer(snapshot, current)) {
      bySku.set(snapshot.skuCode, snapshot);
    }
  }

  return [...byStore.values()].flatMap((bySku) => [...bySku.values()]);
}

function addSafeInteger(left, right, path) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    fail('SALES_COUNT_OVERFLOW', `${path} exceeds the safe integer range`, {
      path,
      left,
      right,
    });
  }
  return sum;
}

function aggregateUnits(snapshots, { includeYesterday = false } = {}) {
  if (snapshots.length === 0) {
    const missing = {
      today: null,
      last7Days: null,
      last30Days: null,
    };
    if (includeYesterday) {
      return {
        today: null,
        yesterday: null,
        last7Days: null,
        last30Days: null,
      };
    }
    return missing;
  }

  const totals = {
    today: 0,
    yesterday: 0,
    last7Days: 0,
    last30Days: 0,
  };

  for (const snapshot of snapshots) {
    for (const [sourceField, targetField] of SALES_FIELDS) {
      totals[targetField] = addSafeInteger(
        totals[targetField],
        snapshot[sourceField],
        `unitsSold.${targetField}`,
      );
    }
  }

  if (includeYesterday) return totals;
  return {
    today: totals.today,
    last7Days: totals.last7Days,
    last30Days: totals.last30Days,
  };
}

function rankValue(value) {
  return Number.isSafeInteger(value) ? value : -1;
}

function compareRanking(left, right, tieBreaker) {
  return (
    rankValue(right.unitsSold.last30Days) - rankValue(left.unitsSold.last30Days) ||
    rankValue(right.unitsSold.last7Days) - rankValue(left.unitsSold.last7Days) ||
    rankValue(right.unitsSold.today) - rankValue(left.unitsSold.today) ||
    tieBreaker(left, right)
  );
}

function aggregatePermissionStatus(permissions) {
  const authorizedStores = permissions.filter(
    ({ permissionStatus }) => permissionStatus === 'granted',
  ).length;

  let status;
  if (authorizedStores === permissions.length) {
    status = 'granted';
  } else if (
    authorizedStores > 0 ||
    permissions.some(({ permissionStatus }) => permissionStatus === 'partial')
  ) {
    status = 'partial';
  } else if (permissions.some(({ permissionStatus }) => permissionStatus === 'pending')) {
    status = 'pending';
  } else if (permissions.every(({ permissionStatus }) => permissionStatus === 'denied')) {
    status = 'denied';
  } else {
    status = 'unknown';
  }

  return {
    status,
    authorizedStores,
    totalStores: permissions.length,
  };
}

/**
 * Produce the input shape consumed by `src/server/dashboard-data.mjs`.
 *
 * Stores without a snapshot remain visible with null unit counts. No missing
 * observation is interpreted as zero.
 */
export function projectDashboardData({ snapshots, storePermissions } = {}) {
  const permissions = normalizePermissions(storePermissions);
  const latestSnapshots = selectLatestSkuSalesSnapshots(snapshots, permissions);
  const snapshotsByStore = new Map();
  const snapshotsBySku = new Map();

  for (const snapshot of latestSnapshots) {
    const storeRows = snapshotsByStore.get(snapshot.storeCode) ?? [];
    storeRows.push(snapshot);
    snapshotsByStore.set(snapshot.storeCode, storeRows);

    const skuRows = snapshotsBySku.get(snapshot.skuCode) ?? [];
    skuRows.push(snapshot);
    snapshotsBySku.set(snapshot.skuCode, skuRows);
  }

  const storeRanking = permissions
    .map(({ storeCode, storeName, permissionStatus }) => ({
      code: storeCode,
      name: storeName,
      permissionStatus,
      unitsSold: aggregateUnits(snapshotsByStore.get(storeCode) ?? []),
    }))
    .sort((left, right) => compareRanking(left, right, (a, b) => a.code.localeCompare(b.code)));

  const skuRanking = [...snapshotsBySku.entries()]
    .map(([skuCode, rows]) => ({
      sku: skuCode,
      unitsSold: aggregateUnits(rows),
    }))
    .sort((left, right) => compareRanking(left, right, (a, b) => a.sku.localeCompare(b.sku)));

  const updatedAt = latestSnapshots.length === 0
    ? null
    : latestSnapshots.reduce(
        (latest, snapshot) => (snapshot.fetchedAt > latest ? snapshot.fetchedAt : latest),
        latestSnapshots[0].fetchedAt,
      );

  return {
    datasetStatus: latestSnapshots.length > 0 ? 'live' : 'empty',
    updatedAt,
    permission: aggregatePermissionStatus(permissions),
    unitsSold: aggregateUnits(latestSnapshots, { includeYesterday: true }),
    storeRanking,
    skuRanking,
  };
}
