import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadSystemHealthData,
  normalizeSystemHealthData,
  SystemHealthDataError,
} from '../../src/server/system-health-data.mjs';
import { querySystemDashboard, SystemQueryError } from '../../src/server/system-query.mjs';

function coverage({
  succeeded = ['DL5477', 'MZ2406'],
  failed = [],
  missing = [],
  stale = [],
  running = [],
} = {}) {
  return {
    status: failed.length || missing.length || stale.length ? 'partial' : 'complete',
    succeededStores: succeeded.length,
    failedStores: failed.length,
    missingStores: missing.length,
    staleStores: stale.length,
    inProgressStores: running.length,
    totalStores: succeeded.length + failed.length + missing.length + stale.length + running.length,
    succeededStoreCodes: succeeded,
    failedStoreCodes: failed,
    missingStoreCodes: missing,
    staleStoreCodes: stale,
    inProgressStoreCodes: running,
    latestFetchedAt: '2026-08-01T00:45:00.000Z',
    evaluatedAt: '2026-08-01T00:46:00.000Z',
    freshnessMaxAgeSeconds: 18_000,
    mode: 'INCREMENTAL',
    reason: 'fixture',
  };
}

function dashboardFixture() {
  return {
    updatedAt: '2026-08-01T00:47:00.000Z',
    owners: [
      { key: 'owner-dl', name: '刘广洪', shortName: '广洪', storeCodes: ['DL5477'] },
      { key: 'owner-mz', name: '吴薇', shortName: '吴薇', storeCodes: ['MZ2406'] },
    ],
    supply: {
      coverage: {
        domains: {
          productCatalog: coverage(),
          productDetails: coverage(),
          inventory: coverage(),
          stockAdvice: coverage({ succeeded: ['DL5477'], failed: ['MZ2406'] }),
          purchaseOrders: coverage(),
          deliveries: coverage(),
        },
      },
    },
    platform: {
      health: {
        ok: true,
        warehouseReady: true,
        evaluatedAt: '2026-08-01T00:47:00.000Z',
      },
    },
    actionPool: { mode: 'observe_only', writeEnabled: false },
    system: {
      schemaReadiness: {
        supplyReady: true,
        webhookReady: true,
      },
      writeActionsEnabled: false,
    },
    permission: { status: 'granted', authorizedStores: 2, totalStores: 2 },
    readiness: [{
      key: 'sales_permission',
      label: '销量权限包',
      status: 'complete',
      completed: 2,
      total: 2,
      note: 'fixture',
    }],
  };
}

function runtimeFixture() {
  return normalizeSystemHealthData({
    schemaVersion: 1,
    generatedAt: '2026-08-01T00:48:00.000Z',
    readOnly: true,
    releases: {
      current: 'a'.repeat(40),
      previous: 'b'.repeat(40),
    },
    units: [
      {
        key: 'portal',
        label: 'BI 门户',
        kind: 'daemon',
        critical: true,
        route: 'system',
        state: 'healthy',
        serviceUnit: 'shein-fm-portal.service',
        timerUnit: null,
        activeState: 'active',
        subState: 'running',
        result: 'success',
        exitStatus: 0,
        timerState: null,
        lastRunAt: '2026-08-01T00:40:00.000Z',
        nextRunAt: null,
      },
      {
        key: 'sessionRenewal',
        label: 'Profile 续期',
        kind: 'job',
        critical: false,
        route: 'system',
        state: 'attention',
        serviceUnit: 'shein-fm-session-renewal.service',
        timerUnit: 'shein-fm-session-renewal.timer',
        activeState: 'failed',
        subState: 'failed',
        result: 'exit-code',
        exitStatus: 2,
        timerState: 'active',
        lastRunAt: '2026-07-31T07:33:31.000Z',
        nextRunAt: '2026-08-01T03:29:10.000Z',
      },
    ],
    profiles: {
      login: {
        updatedAt: '2026-07-31T08:16:54.000Z',
        rows: [
          {
            storeCode: 'DL5477',
            status: 'completed',
            verified: true,
            completedAt: '2026-07-31T08:00:00.000Z',
          },
          {
            storeCode: 'MZ2406',
            status: 'completed',
            verified: true,
            completedAt: '2026-07-31T08:00:00.000Z',
          },
        ],
      },
      renewal: {
        generatedAt: '2026-07-31T07:33:27.000Z',
        completedProfileCount: 2,
        activeCount: 1,
        rows: [
          {
            storeCode: 'DL5477',
            state: 'ACTIVE',
            renewed: true,
            errorCode: null,
          },
          {
            storeCode: 'MZ2406',
            state: 'EXPIRED',
            renewed: false,
            errorCode: 'WEBAPI_SESSION_AUTH_EXPIRED',
          },
        ],
      },
    },
    disks: [
      {
        filesystem: '/',
        checkedAt: '2026-08-01T00:47:30.000Z',
        usedPercent: 47.2,
        warningPercent: 75,
        criticalPercent: 85,
        severity: 'ok',
        observeOnly: true,
      },
      {
        filesystem: '/data',
        checkedAt: '2026-08-01T00:47:30.000Z',
        usedPercent: 27.6,
        warningPercent: 75,
        criticalPercent: 85,
        severity: 'ok',
        observeOnly: true,
      },
    ],
  });
}

test('system query combines runtime, Profile, coverage and write-boundary evidence', () => {
  const result = querySystemDashboard(
    dashboardFixture(),
    runtimeFixture(),
    new URLSearchParams('owner=ALL&store=ALL'),
  );
  assert.equal(result.readOnly, true);
  assert.equal(result.scope.storeCount, 2);
  assert.equal(result.summary.services.attention, 1);
  assert.equal(result.summary.profiles.active, 1);
  assert.equal(result.summary.profiles.expired, 1);
  assert.equal(result.profiles.rows[0].storeCode, 'MZ2406');
  assert.equal(result.profiles.rows[0].actionRequired, true);
  assert.equal(result.summary.coverage.attention, 1);
  assert.equal(result.summary.disks.length, 2);
  assert.ok(result.issues.rows.some((row) => row.key === 'unit:sessionRenewal'));
  assert.ok(result.issues.rows.some((row) => row.key === 'profiles:attention'));
  assert.ok(result.issues.rows.some((row) => row.key === 'coverage:stockAdvice'));
  assert.equal(result.boundaries.actionWriteEnabled, false);
});

test('system query scopes Profile and data coverage by owner/store and filters details by q', () => {
  const selected = querySystemDashboard(
    dashboardFixture(),
    runtimeFixture(),
    new URLSearchParams('owner=owner-dl&store=DL5477'),
  );
  assert.deepEqual(selected.scope.storeCodes, ['DL5477']);
  assert.equal(selected.profiles.rows.length, 1);
  assert.equal(selected.profiles.rows[0].state, 'active');
  assert.equal(selected.summary.coverage.attention, 0);

  const searched = querySystemDashboard(
    dashboardFixture(),
    runtimeFixture(),
    new URLSearchParams('q=MZ2406'),
  );
  assert.equal(searched.profiles.rows.length, 1);
  assert.equal(searched.profiles.rows[0].storeCode, 'MZ2406');
  assert.ok(searched.issues.rows.every((row) => (
    row.affectedStoreCodes.includes('MZ2406')
    || `${row.title} ${row.detail}`.includes('MZ2406')
  )));
});

test('coverage proves successful stores from an exhaustive production partition', () => {
  const dashboard = structuredClone(dashboardFixture());
  for (const domain of Object.values(dashboard.supply.coverage.domains)) {
    delete domain.succeededStoreCodes;
  }
  const allStores = querySystemDashboard(dashboard, runtimeFixture(), new URLSearchParams());
  assert.equal(allStores.summary.coverage.complete, 5);
  assert.equal(allStores.summary.coverage.attention, 1);
  assert.equal(
    allStores.coverage.rows.find((row) => row.key === 'productCatalog').complete,
    2,
  );

  const dlOnly = querySystemDashboard(
    dashboard,
    runtimeFixture(),
    new URLSearchParams('owner=owner-dl&store=DL5477'),
  );
  assert.equal(dlOnly.summary.coverage.complete, 6);

  const unproven = structuredClone(dashboard);
  unproven.supply.coverage.domains.productCatalog.totalStores = 3;
  const failClosed = querySystemDashboard(unproven, runtimeFixture(), new URLSearchParams());
  const catalog = failClosed.coverage.rows.find((row) => row.key === 'productCatalog');
  assert.equal(catalog.status, 'unknown');
  assert.equal(catalog.unknown, 2);
});

test('missing runtime remains an explicit issue rather than fabricated healthy zeros', () => {
  const result = querySystemDashboard(dashboardFixture(), null, new URLSearchParams());
  assert.equal(result.source.runtimeAvailable, false);
  assert.equal(result.summary.services.total, 0);
  assert.equal(result.summary.profiles.active, 0);
  assert.ok(result.issues.rows.some((row) => row.key === 'runtime-missing'));
});

test('system query rejects duplicate, unknown and cross-owner scope parameters', () => {
  assert.throws(
    () => querySystemDashboard(
      dashboardFixture(),
      runtimeFixture(),
      new URLSearchParams('q=a&q=b'),
    ),
    (error) => error instanceof SystemQueryError && error.code === 'QUERY_PARAMETER_DUPLICATED',
  );
  assert.throws(
    () => querySystemDashboard(
      dashboardFixture(),
      runtimeFixture(),
      new URLSearchParams('page=999'),
    ),
    (error) => error instanceof SystemQueryError && error.code === 'QUERY_PARAMETER_UNKNOWN',
  );
  assert.throws(
    () => querySystemDashboard(
      dashboardFixture(),
      runtimeFixture(),
      new URLSearchParams('owner=owner-dl&store=MZ2406'),
    ),
    (error) => error instanceof SystemQueryError && error.code === 'STORE_SCOPE_MISMATCH',
  );
});

test('system runtime loader validates the root projection and fails closed on drift', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fm-system-health-'));
  try {
    const validFile = path.join(directory, 'valid.json');
    await writeFile(validFile, JSON.stringify(runtimeFixture()));
    const loaded = await loadSystemHealthData(validFile);
    assert.equal(loaded.readOnly, true);
    assert.equal(loaded.profiles.renewal.rows.length, 2);

    const invalidFile = path.join(directory, 'invalid.json');
    await writeFile(invalidFile, JSON.stringify({ schemaVersion: 1, readOnly: false }));
    await assert.rejects(
      loadSystemHealthData(invalidFile),
      (error) => error instanceof SystemHealthDataError
        && error.code === 'SYSTEM_HEALTH_INVALID',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
