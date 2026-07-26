import { identityFingerprint } from './identity-repository.mjs';

const STORE_CODE_PATTERN = /^[A-Z0-9_-]+$/;
const SYSTEM_ROLES = new Set(['ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER']);
const ASSIGNMENT_ROLES = new Set(['PRIMARY', 'SUPPORT', 'VIEWER']);
const PRINCIPAL_STATUSES = new Set(['ACTIVE', 'DISABLED']);

function requiredText(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function normalizedStoreCode(value) {
  const result = requiredText(value, 'storeCode').toUpperCase();
  if (!STORE_CODE_PATTERN.test(result)) throw new TypeError('storeCode is invalid.');
  return result;
}

function normalizedInstant(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid timestamp.`);
  return date.toISOString();
}

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Keep the first failure as the useful error.
    }
    throw error;
  } finally {
    client.release();
  }
}

function sameNullable(left, right) {
  return (left ?? null) === (right ?? null);
}

function assertPrincipalSame(existing, expected) {
  if (
    existing.principal_key !== expected.principalKey ||
    !sameNullable(existing.employee_code, expected.employeeCode) ||
    existing.username !== expected.username ||
    existing.display_name !== expected.displayName ||
    existing.system_role !== expected.systemRole ||
    existing.status !== expected.status
  ) {
    throw new Error('Employee principal key was retried with drifted identity data.');
  }
}

export async function ensureEmployeePrincipal(pool, input) {
  const principal = {
    principalKey: requiredText(input?.principalKey, 'principalKey'),
    employeeCode: input?.employeeCode
      ? requiredText(input.employeeCode, 'employeeCode')
      : null,
    username: requiredText(input?.username, 'username').toLocaleLowerCase('en-US'),
    displayName: requiredText(input?.displayName, 'displayName'),
    systemRole: requiredText(input?.systemRole, 'systemRole').toUpperCase(),
    status: requiredText(input?.status ?? 'ACTIVE', 'status').toUpperCase(),
  };
  if (!SYSTEM_ROLES.has(principal.systemRole)) throw new TypeError('systemRole is invalid.');
  if (!PRINCIPAL_STATUSES.has(principal.status)) throw new TypeError('status is invalid.');

  return inTransaction(pool, async (client) => {
    const inserted = await client.query(
      `INSERT INTO ops.employee_principal (
           principal_key, employee_code, username, display_name, system_role, status
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (principal_key) DO NOTHING
       RETURNING employee_principal_id`,
      [
        principal.principalKey,
        principal.employeeCode,
        principal.username,
        principal.displayName,
        principal.systemRole,
        principal.status,
      ],
    );
    if (inserted.rowCount === 1) {
      return {
        employeePrincipalId: inserted.rows[0].employee_principal_id,
        principalKey: principal.principalKey,
        created: true,
      };
    }
    const existing = await client.query(
      `SELECT employee_principal_id, principal_key, employee_code, username,
              display_name, system_role, status
         FROM ops.employee_principal
        WHERE principal_key = $1
        FOR SHARE`,
      [principal.principalKey],
    );
    if (existing.rowCount !== 1) {
      throw new Error('Employee principal conflict could not be read back.');
    }
    assertPrincipalSame(existing.rows[0], principal);
    return {
      employeePrincipalId: existing.rows[0].employee_principal_id,
      principalKey: principal.principalKey,
      created: false,
    };
  });
}

async function requireStore(client, storeCode) {
  const result = await client.query(
    `SELECT store_id
       FROM dim.store
      WHERE store_code = $1
        AND is_active = true
      FOR SHARE`,
    [storeCode],
  );
  if (result.rowCount !== 1) throw new Error(`Active store ${storeCode} was not found.`);
  return result.rows[0].store_id;
}

async function requirePrincipal(client, principalKey, { active = true } = {}) {
  const result = await client.query(
    `SELECT employee_principal_id, principal_key, username, display_name,
            employee_code, system_role, status
       FROM ops.employee_principal
      WHERE principal_key = $1
        AND ($2::boolean = false OR status = 'ACTIVE')
      FOR SHARE`,
    [principalKey, active],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Employee principal ${principalKey} was not found or is disabled.`);
  }
  return result.rows[0];
}

function assertAssignmentFingerprint(existing, fingerprint) {
  if (existing.payload_fingerprint !== fingerprint) {
    throw new Error('Employee-store assignment key was retried with drifted payload.');
  }
}

export async function assignEmployeeToStore(pool, input) {
  const code = normalizedStoreCode(input?.storeCode);
  const principalKey = requiredText(input?.principalKey, 'principalKey');
  const assignmentKey = requiredText(input?.assignmentKey, 'assignmentKey');
  const assignmentRole = requiredText(input?.assignmentRole, 'assignmentRole').toUpperCase();
  const assignedByPrincipalKey = input?.assignedByPrincipalKey
    ? requiredText(input.assignedByPrincipalKey, 'assignedByPrincipalKey')
    : null;
  const reason = requiredText(input?.reason, 'reason');
  const validFrom = normalizedInstant(input?.validFrom, 'validFrom');
  if (!ASSIGNMENT_ROLES.has(assignmentRole)) {
    throw new TypeError('assignmentRole is invalid.');
  }
  const fingerprint = identityFingerprint({
    storeCode: code,
    principalKey,
    assignmentKey,
    assignmentRole,
    assignedByPrincipalKey,
    reason,
    validFrom,
  });

  return inTransaction(pool, async (client) => {
    const storeId = await requireStore(client, code);
    await client.query('SELECT pg_advisory_xact_lock($1)', [storeId]);
    const principal = await requirePrincipal(client, principalKey);
    const actor = assignedByPrincipalKey
      ? await requirePrincipal(client, assignedByPrincipalKey)
      : null;

    const retry = await client.query(
      `SELECT employee_store_assignment_id, payload_fingerprint
         FROM ops.employee_store_assignment
        WHERE store_id = $1
          AND assignment_key = $2
        FOR UPDATE`,
      [storeId, assignmentKey],
    );
    if (retry.rowCount === 1) {
      assertAssignmentFingerprint(retry.rows[0], fingerprint);
      return {
        employeeStoreAssignmentId: retry.rows[0].employee_store_assignment_id,
        storeCode: code,
        principalKey,
        assignmentRole,
        created: false,
        endedAssignmentCount: 0,
      };
    }

    const ended = await client.query(
      `UPDATE ops.employee_store_assignment
          SET assignment_status = 'ENDED',
              valid_to = $4,
              ended_by_principal_id = $5,
              ended_reason = $6
        WHERE store_id = $1
          AND assignment_status = 'ACTIVE'
          AND valid_to IS NULL
          AND (
              employee_principal_id = $2
              OR ($3 = 'PRIMARY' AND assignment_role = 'PRIMARY')
          )`,
      [
        storeId,
        principal.employee_principal_id,
        assignmentRole,
        validFrom,
        actor?.employee_principal_id ?? null,
        `Replaced by assignment ${assignmentKey}: ${reason}`,
      ],
    );

    const inserted = await client.query(
      `INSERT INTO ops.employee_store_assignment (
           store_id, employee_principal_id, assignment_key, assignment_role,
           assignment_status, assigned_by_principal_id, reason,
           payload_fingerprint, valid_from
       ) VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, $7, $8)
       RETURNING employee_store_assignment_id`,
      [
        storeId,
        principal.employee_principal_id,
        assignmentKey,
        assignmentRole,
        actor?.employee_principal_id ?? null,
        reason,
        fingerprint,
        validFrom,
      ],
    );
    return {
      employeeStoreAssignmentId: inserted.rows[0].employee_store_assignment_id,
      storeCode: code,
      principalKey,
      assignmentRole,
      created: true,
      endedAssignmentCount: ended.rowCount,
    };
  });
}

export async function endEmployeeStoreAssignment(pool, input) {
  const code = normalizedStoreCode(input?.storeCode);
  const assignmentKey = requiredText(input?.assignmentKey, 'assignmentKey');
  const endedAt = normalizedInstant(input?.endedAt, 'endedAt');
  const endedReason = requiredText(input?.endedReason, 'endedReason');
  const endedByPrincipalKey = input?.endedByPrincipalKey
    ? requiredText(input.endedByPrincipalKey, 'endedByPrincipalKey')
    : null;

  return inTransaction(pool, async (client) => {
    const storeId = await requireStore(client, code);
    await client.query('SELECT pg_advisory_xact_lock($1)', [storeId]);
    const actor = endedByPrincipalKey
      ? await requirePrincipal(client, endedByPrincipalKey)
      : null;
    const existing = await client.query(
      `SELECT employee_store_assignment_id, assignment_status, valid_to,
              ended_by_principal_id, ended_reason
         FROM ops.employee_store_assignment
        WHERE store_id = $1
          AND assignment_key = $2
        FOR UPDATE`,
      [storeId, assignmentKey],
    );
    if (existing.rowCount !== 1) {
      throw new Error(`Employee-store assignment ${assignmentKey} was not found in ${code}.`);
    }
    const assignment = existing.rows[0];
    if (assignment.assignment_status === 'ENDED') {
      const existingInstant = normalizedInstant(assignment.valid_to, 'stored valid_to');
      if (
        existingInstant !== endedAt ||
        !sameNullable(assignment.ended_by_principal_id, actor?.employee_principal_id ?? null) ||
        assignment.ended_reason !== endedReason
      ) {
        throw new Error('Ended employee-store assignment was retried with drifted payload.');
      }
      return {
        employeeStoreAssignmentId: assignment.employee_store_assignment_id,
        storeCode: code,
        ended: false,
      };
    }
    const updated = await client.query(
      `UPDATE ops.employee_store_assignment
          SET assignment_status = 'ENDED',
              valid_to = $3,
              ended_by_principal_id = $4,
              ended_reason = $5
        WHERE store_id = $1
          AND employee_store_assignment_id = $2
          AND assignment_status = 'ACTIVE'
        RETURNING employee_store_assignment_id`,
      [
        storeId,
        assignment.employee_store_assignment_id,
        endedAt,
        actor?.employee_principal_id ?? null,
        endedReason,
      ],
    );
    if (updated.rowCount !== 1) throw new Error('Employee-store assignment could not be ended.');
    return {
      employeeStoreAssignmentId: updated.rows[0].employee_store_assignment_id,
      storeCode: code,
      ended: true,
    };
  });
}

export async function listEmployeeStoreScope(pool, input) {
  const principalKey = requiredText(input?.principalKey, 'principalKey');
  const client = await pool.connect();
  try {
    const principal = await requirePrincipal(client, principalKey);
    const allStores = principal.system_role === 'ADMIN';
    const stores = await client.query(
      allStores
        ? `SELECT s.store_code, 'PRIMARY'::text AS assignment_role
             FROM dim.store AS s
            WHERE s.is_active = true
            ORDER BY s.store_code`
        : `SELECT s.store_code, a.assignment_role
             FROM ops.employee_store_assignment AS a
             JOIN dim.store AS s
               ON s.store_id = a.store_id
            WHERE a.employee_principal_id = $1
              AND a.assignment_status = 'ACTIVE'
              AND a.valid_to IS NULL
              AND s.is_active = true
            ORDER BY s.store_code`,
      allStores ? [] : [principal.employee_principal_id],
    );
    const assignments = stores.rows.map((row) => ({
      storeCode: row.store_code,
      role: row.assignment_role,
      canWriteStore: (
        principal.system_role !== 'VIEWER'
        && ['PRIMARY', 'SUPPORT'].includes(row.assignment_role)
      ),
    }));
    return {
      principalKey: principal.principal_key,
      username: principal.username,
      displayName: principal.display_name,
      employeeCode: principal.employee_code,
      role: principal.system_role.toLowerCase(),
      allStores,
      readAllStores: true,
      assignedStoreCodes: assignments.map(({ storeCode }) => storeCode),
      writableStoreCodes: allStores
        ? []
        : assignments
            .filter(({ canWriteStore }) => canWriteStore)
            .map(({ storeCode }) => storeCode),
      // Action capabilities need an explicit warehouse-backed policy before
      // any executor may call canWriteStore with writeEnabled=true.
      allowedCapabilities: [],
      assignments,
    };
  } finally {
    client.release();
  }
}
