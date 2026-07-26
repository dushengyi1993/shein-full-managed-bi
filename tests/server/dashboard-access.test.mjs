import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canWriteStore,
  projectDashboardForUser,
} from '../../src/server/dashboard-access.mjs';

const dashboard = Object.freeze({
  schemaVersion: 3,
  unitsSold: { today: 17, yesterday: 15, last7Days: 70, last30Days: 300 },
  salesTrend: [{ date: '2026-07-25', unitsSold: 15 }],
  storeRanking: [
    { code: 'AA1000', unitsSold: { today: 11, last30Days: 180 } },
    { code: 'BB2000', unitsSold: { today: 6, last30Days: 120 } },
  ],
  platform: {
    queue: { queued: 2 },
    subscriptions: [{ eventCode: '3001435' }],
  },
});

test('every authenticated employee receives the complete read dataset', () => {
  const projected = projectDashboardForUser(dashboard, {
    username: 'operator',
    displayName: 'Operator',
    employeeCode: 'EMP-002',
    role: 'operator',
    allStores: false,
    storeCodes: ['AA1000'],
  });

  assert.equal(projected.storeRanking.length, 2);
  assert.equal(projected.unitsSold.today, 17);
  assert.equal(projected.platform.queue.queued, 2);
  assert.deepEqual(projected.access, {
    username: 'operator',
    displayName: 'Operator',
    employeeCode: 'EMP-002',
    role: 'operator',
    roleLabel: '运营',
    readAllStores: true,
    writeEnabled: false,
    writeAuthorizationSource: 'warehouse_assignment_required',
    declaredStoreCodes: ['AA1000'],
  });
});

test('administrator read metadata still requires warehouse write authorization', () => {
  const projected = projectDashboardForUser(dashboard, {
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    allStores: true,
    storeCodes: [],
  });
  assert.equal(projected.storeRanking.length, 2);
  assert.equal(projected.access.readAllStores, true);
  assert.equal(projected.access.writeEnabled, false);
  assert.equal(projected.access.writeAuthorizationSource, 'warehouse_assignment_required');
});

test('the future write gate remains closed regardless of assignment', () => {
  const operator = {
    username: 'operator',
    employeeCode: 'EMP-002',
    role: 'operator',
    allStores: false,
    storeCodes: ['AA1000'],
  };
  assert.equal(canWriteStore(operator, 'AA1000'), false);
  assert.equal(canWriteStore(operator, 'AA1000', { writeEnabled: false }), false);
});

test('when explicitly enabled, the future write gate only accepts assigned stores', () => {
  const operator = {
    username: 'operator',
    employeeCode: 'EMP-002',
    role: 'operator',
    allStores: false,
    storeCodes: ['aa1000', 'AA1000'],
  };
  const authorization = {
    username: 'operator',
    employeeCode: 'EMP-002',
    role: 'operator',
    allStores: false,
    allowedCapabilities: ['INVENTORY_UPDATE'],
    assignments: [{ storeCode: 'AA1000', role: 'PRIMARY' }],
  };
  assert.equal(canWriteStore(
    operator,
    'AA1000',
    {
      writeEnabled: true,
      authorization,
      capability: 'INVENTORY_UPDATE',
    },
  ), true);
  assert.equal(canWriteStore(
    operator,
    'BB2000',
    {
      writeEnabled: true,
      authorization,
      capability: 'INVENTORY_UPDATE',
    },
  ), false);
  assert.equal(canWriteStore(
    { username: 'viewer', employeeCode: 'EMP-VIEW', role: 'viewer' },
    'AA1000',
    {
      writeEnabled: true,
      authorization: {
        username: 'viewer',
        employeeCode: 'EMP-VIEW',
        role: 'viewer',
        allowedCapabilities: ['INVENTORY_UPDATE'],
        assignments: [{ storeCode: 'AA1000', role: 'PRIMARY' }],
      },
      capability: 'INVENTORY_UPDATE',
    },
  ), false);
  assert.equal(canWriteStore(
    { username: 'admin', employeeCode: 'EMP-ADMIN', role: 'admin' },
    'BB2000',
    {
      writeEnabled: true,
      authorization: {
        username: 'admin',
        employeeCode: 'EMP-ADMIN',
        role: 'admin',
        allStores: true,
        allowedCapabilities: ['INVENTORY_UPDATE'],
      },
      capability: 'INVENTORY_UPDATE',
    },
  ), true);
  assert.equal(canWriteStore(operator, 'AA1000', {
    writeEnabled: true,
    authorization: {
      ...authorization,
      employeeCode: 'OTHER',
    },
    capability: 'INVENTORY_UPDATE',
  }), false);
  assert.equal(canWriteStore(operator, 'AA1000', {
    writeEnabled: true,
    authorization,
    capability: 'PRICE_UPDATE',
  }), false);
  assert.equal(canWriteStore(operator, 'AA1000', {
    writeEnabled: true,
    authorization: {
      ...authorization,
      assignments: [{ storeCode: 'AA1000', role: 'VIEWER' }],
    },
    capability: 'INVENTORY_UPDATE',
  }), false);
});

test('an employee without assignments can still read all but cannot write', () => {
  const projected = projectDashboardForUser(dashboard, {
    username: 'viewer',
    displayName: 'Viewer',
    role: 'viewer',
    allStores: false,
    storeCodes: [],
  });
  assert.equal(projected.storeRanking.length, 2);
  assert.deepEqual(projected.access.declaredStoreCodes, []);
  assert.equal(canWriteStore(
    { username: 'operator', employeeCode: 'EMP-0', role: 'operator' },
    'AA1000',
    {
      writeEnabled: true,
      authorization: {
        username: 'operator',
        employeeCode: 'EMP-0',
        role: 'operator',
        allowedCapabilities: ['INVENTORY_UPDATE'],
        assignments: [],
      },
      capability: 'INVENTORY_UPDATE',
    },
  ), false);
});
