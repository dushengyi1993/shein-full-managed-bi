import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ORDER_MANAGEMENT_PAGE_IDS,
  loadOrderManagementData,
  OrderManagementDataError,
} from '../../src/server/order-management-data.mjs';

const OTHER_PAGES = Object.fromEntries(
  ORDER_MANAGEMENT_PAGE_IDS
    .filter((pageId) => pageId !== 'delivery-notes')
    .map((pageId) => [pageId, {
      status: 'UNAVAILABLE',
      source: 'OPENAPI_NOT_MATERIALIZED',
      latestSourceFetchedAt: null,
      reason: 'NOT_MATERIALIZED_YET',
      rows: [],
    }]),
);

function indexWithDeliveryRows(rows, overrides = {}) {
  return {
    schemaVersion: 1,
    updatedAt: '2026-08-08T08:00:00.000Z',
    promotable: true,
    coverage: {
      status: 'COMPLETE',
      expectedStoreCount: 2,
      completedStoreCount: 2,
      storeCodes: ['DL5477', 'MZ2406'],
      reason: null,
    },
    pages: {
      ...OTHER_PAGES,
      'delivery-notes': {
        status: 'AVAILABLE',
        source: 'OPENAPI_DELIVERY_NOTES',
        latestSourceFetchedAt: '2026-08-08T07:59:00.000Z',
        reason: null,
        rows,
      },
    },
    evidence: {
      pages: {
        'delivery-notes': { storeCodes: ['DL5477', 'MZ2406'] },
      },
    },
    ...overrides,
  };
}

function deliveryRow(overrides = {}) {
  return {
    id: 'DN-1001',
    storeCode: 'DL5477',
    statusCode: 'SHIPPED',
    statusName: '已发货',
    createdAt: '2026-08-08T01:00:00.000Z',
    updatedAt: '2026-08-08T07:00:00.000Z',
    primary: '送货单 1001',
    secondary: '顺丰',
    tags: ['华南仓'],
    metrics: [
      { name: 'packageCount', value: 2 },
      { name: 'packageWeight', value: 12.5 },
    ],
    facts: [{ name: 'warehouseName', value: '华南仓' }],
    details: [{ name: 'expressCompanyName', value: '顺丰' }],
    ...overrides,
  };
}

async function writeTempIndex(t, value) {
  const directory = await mkdtemp(join(tmpdir(), 'order-management-data-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'order-management.json');
  await writeFile(file, JSON.stringify(value));
  return file;
}

test('loads and caches a contract-valid order-management index', async (t) => {
  const file = await writeTempIndex(t, indexWithDeliveryRows([deliveryRow()]));
  const first = await loadOrderManagementData(file, { runtimeEnvironment: 'production' });
  const second = await loadOrderManagementData(file, { runtimeEnvironment: 'production' });
  assert.equal(first, second);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.coverage.status, 'COMPLETE');
  assert.equal(first.coverage.completedStoreCount, 2);
  assert.equal(first.pageCoverage['delivery-notes'].status, 'COMPLETE');
  assert.equal(first.pageCoverage['delivery-notes'].completedStoreCount, 2);
  assert.deepEqual(first.pageCoverage['delivery-notes'].storeCodes, ['DL5477', 'MZ2406']);
  assert.equal(first.promotable, true);
  assert.deepEqual(Object.keys(first.pages), ORDER_MANAGEMENT_PAGE_IDS);
  assert.deepEqual(first.pages['delivery-notes'].rows.map((row) => row.id), ['DN-1001']);
  assert.equal(Object.isFrozen(first.pages['delivery-notes'].rows[0]), true);
  assert.equal(first.pages.waybills.status, 'UNAVAILABLE');
  assert.equal(first.pages.waybills.reason, 'NOT_MATERIALIZED_YET');
});

test('requires an explicit file in production and rejects unsupported schemas', async (t) => {
  await assert.rejects(
    loadOrderManagementData('', { runtimeEnvironment: 'production' }),
    (error) => error instanceof OrderManagementDataError && error.code === 'ORDER_MANAGEMENT_FILE_REQUIRED',
  );
  const file = await writeTempIndex(t, indexWithDeliveryRows([], { schemaVersion: 99 }));
  await assert.rejects(
    loadOrderManagementData(file, { runtimeEnvironment: 'production' }),
    (error) => error instanceof OrderManagementDataError && error.code === 'ORDER_MANAGEMENT_SCHEMA_UNSUPPORTED',
  );
});

test('rejects indexes that violate the shared contract', async (t) => {
  const unknownPage = indexWithDeliveryRows([deliveryRow()]);
  unknownPage.pages['not-a-page'] = unknownPage.pages['delivery-notes'];
  const unknownPageFile = await writeTempIndex(t, unknownPage);
  await assert.rejects(
    loadOrderManagementData(unknownPageFile, { runtimeEnvironment: 'production' }),
    (error) => error instanceof OrderManagementDataError && error.code === 'ORDER_MANAGEMENT_SCHEMA_INVALID',
  );

  const missingPage = indexWithDeliveryRows([deliveryRow()]);
  delete missingPage.pages['delivery-notes'];
  const missingPageFile = await writeTempIndex(t, missingPage);
  await assert.rejects(
    loadOrderManagementData(missingPageFile, { runtimeEnvironment: 'production' }),
    (error) => error instanceof OrderManagementDataError && error.code === 'ORDER_MANAGEMENT_SCHEMA_INVALID',
  );

  const invalidStatus = indexWithDeliveryRows([deliveryRow()]);
  invalidStatus.pages['delivery-notes'].status = 'UNKNOWN';
  const invalidStatusFile = await writeTempIndex(t, invalidStatus);
  await assert.rejects(
    loadOrderManagementData(invalidStatusFile, { runtimeEnvironment: 'production' }),
    (error) => error instanceof OrderManagementDataError && error.code === 'ORDER_MANAGEMENT_SCHEMA_INVALID',
  );

  const missingPromotable = indexWithDeliveryRows([deliveryRow()]);
  delete missingPromotable.promotable;
  const missingPromotableFile = await writeTempIndex(t, missingPromotable);
  await assert.rejects(
    loadOrderManagementData(missingPromotableFile, { runtimeEnvironment: 'production' }),
    (error) => error instanceof OrderManagementDataError && error.code === 'ORDER_MANAGEMENT_SCHEMA_INVALID',
  );
});

test('rejects non-allowlisted metric names and numeric PII values instead of forwarding them', async (t) => {
  const unknownName = indexWithDeliveryRows([deliveryRow({
    metrics: [{ name: 'secretField', value: 1 }],
  })]);
  const unknownNameFile = await writeTempIndex(t, unknownName);
  await assert.rejects(
    loadOrderManagementData(unknownNameFile, { runtimeEnvironment: 'production' }),
    (error) => error instanceof OrderManagementDataError && error.code === 'ORDER_MANAGEMENT_SCHEMA_INVALID',
  );

  const numericPii = indexWithDeliveryRows([deliveryRow({
    facts: [{ name: 'warehouseName', value: '13800138000' }],
  })]);
  const numericPiiFile = await writeTempIndex(t, numericPii);
  await assert.rejects(
    loadOrderManagementData(numericPiiFile, { runtimeEnvironment: 'production' }),
    (error) => error instanceof OrderManagementDataError && error.code === 'ORDER_MANAGEMENT_SCHEMA_INVALID',
  );
});

test('rejects the whole index when status or tags carry sensitive text', async (t) => {
  const index = indexWithDeliveryRows([
    deliveryRow(),
    deliveryRow({
      id: 'DN-9001',
      storeCode: 'MZ2406',
      tags: ['13800138000'],
    }),
    deliveryRow({
      id: 'DN-9002',
      storeCode: 'MZ2406',
      createdAt: '2026-08-08T02:00:00.000Z',
    }),
  ]);
  const file = await writeTempIndex(t, index);
  await assert.rejects(
    loadOrderManagementData(file, { runtimeEnvironment: 'production' }),
    (error) => error instanceof OrderManagementDataError
      && error.code === 'ORDER_MANAGEMENT_SCHEMA_INVALID',
  );
});

test('returns an unavailable empty index in development without a file and never fabricates rows', async () => {
  const loaded = await loadOrderManagementData('', { runtimeEnvironment: 'development' });
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.coverage.status, 'UNAVAILABLE');
  assert.equal(loaded.coverage.completedStoreCount, 0);
  assert.deepEqual(loaded.coverage.storeCodes, []);
  assert.deepEqual(loaded.pages, {});
  assert.equal(loaded.coverage.reason, 'ORDER_MANAGEMENT_FILE_NOT_CONFIGURED');
});
