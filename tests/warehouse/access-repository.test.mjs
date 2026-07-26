import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assignEmployeeToStore,
  endEmployeeStoreAssignment,
  ensureEmployeePrincipal,
  listEmployeeStoreScope,
} from '../../src/warehouse/access-repository.mjs';

class FakeClient {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
    this.released = false;
  }

  async query(sql, values = []) {
    this.calls.push({ sql, values });
    const result = await this.handler?.(sql, values, this);
    return result ?? { rows: [], rowCount: 0 };
  }

  release() {
    this.released = true;
  }
}

function pool(client) {
  return { async connect() { return client; } };
}

function row(rows) {
  return { rows, rowCount: rows.length };
}

function principal(overrides = {}) {
  return {
    employee_principal_id: 21,
    principal_key: 'EMP-001',
    employee_code: 'EMP-001',
    username: 'alice',
    display_name: 'Alice',
    system_role: 'OPERATOR',
    status: 'ACTIVE',
    ...overrides,
  };
}

test('creates an employee principal transactionally and normalizes the login role', async () => {
  const client = new FakeClient((sql) => {
    if (sql.includes('INSERT INTO ops.employee_principal')) {
      return row([{ employee_principal_id: 21 }]);
    }
    return undefined;
  });
  const result = await ensureEmployeePrincipal(pool(client), {
    principalKey: 'EMP-001',
    employeeCode: 'EMP-001',
    username: 'Alice',
    displayName: 'Alice',
    systemRole: 'operator',
  });
  assert.deepEqual(result, {
    employeePrincipalId: 21,
    principalKey: 'EMP-001',
    created: true,
  });
  const insert = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.employee_principal'));
  assert.deepEqual(insert.values, [
    'EMP-001', 'EMP-001', 'alice', 'Alice', 'OPERATOR', 'ACTIVE',
  ]);
  assert.equal(client.calls[0].sql, 'BEGIN');
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
  assert.equal(client.released, true);
});

test('rejects a principal-key retry whose identity fields drifted', async () => {
  const client = new FakeClient((sql) => {
    if (sql.includes('INSERT INTO ops.employee_principal')) return row([]);
    if (sql.includes('FROM ops.employee_principal')) {
      return row([principal({ display_name: 'Different employee' })]);
    }
    return undefined;
  });
  await assert.rejects(
    () => ensureEmployeePrincipal(pool(client), {
      principalKey: 'EMP-001',
      employeeCode: 'EMP-001',
      username: 'alice',
      displayName: 'Alice',
      systemRole: 'OPERATOR',
    }),
    /drifted identity data/,
  );
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
});

test('assigns a PRIMARY owner under a store lock and ends the previous current primary', async () => {
  const client = new FakeClient((sql, values) => {
    if (sql.includes('FROM dim.store')) return row([{ store_id: 7 }]);
    if (sql.includes('FROM ops.employee_principal')) {
      return row([values[0] === 'MANAGER-1'
        ? principal({
          employee_principal_id: 22,
          principal_key: 'MANAGER-1',
          username: 'manager',
          display_name: 'Manager',
          system_role: 'MANAGER',
        })
        : principal()]);
    }
    if (sql.includes('SELECT employee_store_assignment_id, payload_fingerprint')) return row([]);
    if (sql.includes('UPDATE ops.employee_store_assignment')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO ops.employee_store_assignment')) {
      return row([{ employee_store_assignment_id: 31 }]);
    }
    return undefined;
  });
  const result = await assignEmployeeToStore(pool(client), {
    storeCode: 'dl',
    principalKey: 'EMP-001',
    assignmentKey: 'DL:PRIMARY:20260726:EMP-001',
    assignmentRole: 'primary',
    assignedByPrincipalKey: 'MANAGER-1',
    reason: 'Employee ownership roster',
    validFrom: '2026-07-26T13:00:00.000Z',
  });
  assert.deepEqual(result, {
    employeeStoreAssignmentId: 31,
    storeCode: 'DL',
    principalKey: 'EMP-001',
    assignmentRole: 'PRIMARY',
    created: true,
    endedAssignmentCount: 1,
  });
  assert.equal(
    client.calls.some(({ sql, values }) =>
      sql === 'SELECT pg_advisory_xact_lock($1)' && values[0] === 7),
    true,
  );
  const ended = client.calls.find(({ sql }) => sql.includes('UPDATE ops.employee_store_assignment'));
  assert.match(ended.sql, /assignment_role = 'PRIMARY'/);
  assert.equal(ended.values[5], 'Replaced by assignment DL:PRIMARY:20260726:EMP-001: Employee ownership roster');
  const inserted = client.calls.find(({ sql }) => sql.includes('INSERT INTO ops.employee_store_assignment'));
  assert.match(inserted.values[6], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(inserted.sql, /Employee ownership roster|EMP-001/);
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
});

test('an identical employee-store assignment retry is a no-op before temporal rows change', async () => {
  let suppliedFingerprint;
  const firstClient = new FakeClient((sql, values) => {
    if (sql.includes('FROM dim.store')) return row([{ store_id: 7 }]);
    if (sql.includes('FROM ops.employee_principal')) return row([principal()]);
    if (sql.includes('SELECT employee_store_assignment_id, payload_fingerprint')) return row([]);
    if (sql.includes('UPDATE ops.employee_store_assignment')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO ops.employee_store_assignment')) {
      suppliedFingerprint = values[6];
      return row([{ employee_store_assignment_id: 31 }]);
    }
    return undefined;
  });
  const input = {
    storeCode: 'DL',
    principalKey: 'EMP-001',
    assignmentKey: 'DL:SUPPORT:EMP-001:v1',
    assignmentRole: 'SUPPORT',
    reason: 'Support coverage',
    validFrom: '2026-07-26T13:00:00.000Z',
  };
  await assignEmployeeToStore(pool(firstClient), input);

  const retryClient = new FakeClient((sql) => {
    if (sql.includes('FROM dim.store')) return row([{ store_id: 7 }]);
    if (sql.includes('FROM ops.employee_principal')) return row([principal()]);
    if (sql.includes('SELECT employee_store_assignment_id, payload_fingerprint')) {
      return row([{
        employee_store_assignment_id: 31,
        payload_fingerprint: suppliedFingerprint,
      }]);
    }
    return undefined;
  });
  const result = await assignEmployeeToStore(pool(retryClient), input);
  assert.equal(result.created, false);
  assert.equal(
    retryClient.calls.some(({ sql }) => sql.includes('UPDATE ops.employee_store_assignment')),
    false,
  );
  assert.equal(
    retryClient.calls.some(({ sql }) => sql.includes('INSERT INTO ops.employee_store_assignment')),
    false,
  );
});

test('ending an assignment is idempotent and preserves the end actor and reason', async () => {
  const endedAt = '2026-07-26T14:00:00.000Z';
  const client = new FakeClient((sql, values) => {
    if (sql.includes('FROM dim.store')) return row([{ store_id: 7 }]);
    if (sql.includes('FROM ops.employee_principal')) {
      return row([principal({
        employee_principal_id: 22,
        principal_key: 'MANAGER-1',
        username: 'manager',
        display_name: 'Manager',
        system_role: 'MANAGER',
      })]);
    }
    if (sql.includes('SELECT employee_store_assignment_id, assignment_status')) {
      return row([{
        employee_store_assignment_id: 31,
        assignment_status: 'ACTIVE',
        valid_to: null,
        ended_by_principal_id: null,
        ended_reason: null,
      }]);
    }
    if (sql.includes('UPDATE ops.employee_store_assignment')) {
      assert.deepEqual(values, [7, 31, endedAt, 22, 'Roster handoff']);
      return row([{ employee_store_assignment_id: 31 }]);
    }
    return undefined;
  });
  const result = await endEmployeeStoreAssignment(pool(client), {
    storeCode: 'DL',
    assignmentKey: 'DL:SUPPORT:EMP-001:v1',
    endedAt,
    endedByPrincipalKey: 'MANAGER-1',
    endedReason: 'Roster handoff',
  });
  assert.deepEqual(result, {
    employeeStoreAssignmentId: 31,
    storeCode: 'DL',
    ended: true,
  });
  assert.equal(client.calls.at(-1).sql, 'COMMIT');

  const retryClient = new FakeClient((sql) => {
    if (sql.includes('FROM dim.store')) return row([{ store_id: 7 }]);
    if (sql.includes('FROM ops.employee_principal')) {
      return row([principal({
        employee_principal_id: 22,
        principal_key: 'MANAGER-1',
        username: 'manager',
        display_name: 'Manager',
        system_role: 'MANAGER',
      })]);
    }
    if (sql.includes('SELECT employee_store_assignment_id, assignment_status')) {
      return row([{
        employee_store_assignment_id: 31,
        assignment_status: 'ENDED',
        valid_to: endedAt,
        ended_by_principal_id: 22,
        ended_reason: 'Roster handoff',
      }]);
    }
    return undefined;
  });
  const retry = await endEmployeeStoreAssignment(pool(retryClient), {
    storeCode: 'DL',
    assignmentKey: 'DL:SUPPORT:EMP-001:v1',
    endedAt,
    endedByPrincipalKey: 'MANAGER-1',
    endedReason: 'Roster handoff',
  });
  assert.equal(retry.ended, false);
  assert.equal(
    retryClient.calls.some(({ sql }) => sql.includes('UPDATE ops.employee_store_assignment')),
    false,
  );
});

test('lists only active assigned stores for a non-admin principal', async () => {
  const client = new FakeClient((sql) => {
    if (sql.includes('FROM ops.employee_principal')) return row([principal()]);
    if (sql.includes('FROM ops.employee_store_assignment AS a')) {
      return row([
        { store_code: 'CX4412', assignment_role: 'PRIMARY' },
        { store_code: 'DL7397', assignment_role: 'SUPPORT' },
      ]);
    }
    return undefined;
  });
  const scope = await listEmployeeStoreScope(pool(client), { principalKey: 'EMP-001' });
  assert.equal(scope.readAllStores, true);
  assert.deepEqual(scope.assignedStoreCodes, ['CX4412', 'DL7397']);
  assert.deepEqual(scope.writableStoreCodes, ['CX4412', 'DL7397']);
  assert.deepEqual(scope.allowedCapabilities, []);
  assert.deepEqual(scope.assignments, [
    { storeCode: 'CX4412', role: 'PRIMARY', canWriteStore: true },
    { storeCode: 'DL7397', role: 'SUPPORT', canWriteStore: true },
  ]);
  assert.equal(scope.allStores, false);
  assert.equal(scope.role, 'operator');
  assert.equal(client.released, true);
  const lookup = client.calls.find(({ sql }) => sql.includes('FROM ops.employee_store_assignment AS a'));
  assert.match(lookup.sql, /assignment_status = 'ACTIVE'[\s\S]*valid_to IS NULL/);
  assert.deepEqual(lookup.values, [21]);
});

test('migration enforces one current PRIMARY owner and retains temporal audit rows', async () => {
  const sql = await readFile(
    new URL('../../db/migrations/0004_product_identity_and_access.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ops\.employee_principal/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ops\.employee_store_assignment/);
  assert.match(
    sql,
    /uq_ops_employee_store_assignment_current_primary[\s\S]*assignment_role = 'PRIMARY'[\s\S]*valid_to IS NULL/,
  );
  assert.match(sql, /ended_by_principal_id/);
  assert.match(sql, /ended_reason/);
  assert.match(
    sql,
    /UNIQUE \(store_id, assignment_key\)/,
  );
  assert.doesNotMatch(sql, /\bDELETE FROM ops\.employee_store_assignment\b/);
});
