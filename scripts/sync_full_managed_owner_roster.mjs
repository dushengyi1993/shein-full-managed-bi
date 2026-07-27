#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import {
  assignEmployeeToStore,
  ensureEmployeePrincipal,
} from '../src/warehouse/access-repository.mjs';
import { stableIdentityJson } from '../src/warehouse/identity-repository.mjs';

const STORE_CODE_PATTERN = /^[A-Z]{2}[0-9]{4}$/;
const KEY_PATTERN = /^FM-OWNER-[0-9]{3}$/;

function requiredText(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

export function normalizeOwnerRoster(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Roster must be an object.');
  }
  const version = requiredText(input.version, 'version');
  const effectiveAt = new Date(input.effectiveAt);
  if (!Number.isFinite(effectiveAt.getTime())) {
    throw new TypeError('effectiveAt must be a valid timestamp.');
  }
  if (!Array.isArray(input.owners) || input.owners.length === 0) {
    throw new TypeError('owners must be a non-empty array.');
  }

  const ownerKeys = new Set();
  const usernames = new Set();
  const storeCodes = new Set();
  const owners = input.owners.map((source, ownerIndex) => {
    const key = requiredText(source?.key, `owners[${ownerIndex}].key`).toUpperCase();
    const username = requiredText(
      source?.username,
      `owners[${ownerIndex}].username`,
    ).toLocaleLowerCase('en-US');
    const displayName = requiredText(
      source?.displayName,
      `owners[${ownerIndex}].displayName`,
    );
    if (!KEY_PATTERN.test(key)) throw new TypeError(`Owner key ${key} is invalid.`);
    if (ownerKeys.has(key)) throw new TypeError(`Owner key ${key} is duplicated.`);
    if (usernames.has(username)) throw new TypeError(`Owner username ${username} is duplicated.`);
    ownerKeys.add(key);
    usernames.add(username);
    if (!Array.isArray(source.storeCodes) || source.storeCodes.length === 0) {
      throw new TypeError(`Owner ${key} has no stores.`);
    }
    const normalizedStores = source.storeCodes.map((value) => requiredText(value, 'storeCode').toUpperCase());
    normalizedStores.forEach((storeCode) => {
      if (!STORE_CODE_PATTERN.test(storeCode)) {
        throw new TypeError(`Store code ${storeCode} is invalid.`);
      }
      if (storeCodes.has(storeCode)) {
        throw new TypeError(`Store code ${storeCode} has more than one owner.`);
      }
      storeCodes.add(storeCode);
    });
    return {
      key,
      username,
      displayName,
      storeCodes: normalizedStores.sort(),
    };
  }).sort((left, right) => left.key.localeCompare(right.key));

  return {
    version,
    effectiveAt: effectiveAt.toISOString(),
    owners,
    storeCodes: [...storeCodes].sort(),
  };
}

export function ownerRosterPlanHash(roster, warehouseState) {
  return createHash('sha256')
    .update(stableIdentityJson({ roster, warehouseState }), 'utf8')
    .digest('hex');
}

function parseArgs(argv) {
  const result = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') {
      result.apply = true;
      continue;
    }
    if (['--roster', '--expect-plan-hash'].includes(token)) {
      result[token.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!result.roster) throw new Error('--roster is required.');
  if (result.apply && !/^[0-9a-f]{64}$/.test(result['expect-plan-hash'] || '')) {
    throw new Error('--apply requires --expect-plan-hash.');
  }
  return result;
}

async function readRoster(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read owner roster: ${error.message}`);
  }
  return normalizeOwnerRoster(parsed);
}

async function readWarehouseState(pool, roster) {
  const client = await pool.connect();
  try {
    const stores = await client.query(
      `SELECT store_code
         FROM dim.store
        WHERE is_active = true
          AND store_code = ANY($1::text[])
        ORDER BY store_code`,
      [roster.storeCodes],
    );
    const principals = await client.query(
      `SELECT principal_key, username, display_name, system_role, status
         FROM ops.employee_principal
        WHERE principal_key = ANY($1::text[])
        ORDER BY principal_key`,
      [roster.owners.map(({ key }) => key)],
    );
    const assignments = await client.query(
      `SELECT store.store_code, principal.principal_key, assignment.assignment_role
         FROM ops.employee_store_assignment AS assignment
         JOIN dim.store AS store ON store.store_id = assignment.store_id
         JOIN ops.employee_principal AS principal
           ON principal.employee_principal_id = assignment.employee_principal_id
        WHERE assignment.assignment_role = 'PRIMARY'
          AND assignment.assignment_status = 'ACTIVE'
          AND assignment.valid_to IS NULL
          AND store.store_code = ANY($1::text[])
        ORDER BY store.store_code`,
      [roster.storeCodes],
    );
    return {
      stores: stores.rows.map(({ store_code: storeCode }) => storeCode),
      principals: principals.rows.map((row) => ({
        key: row.principal_key,
        username: row.username,
        displayName: row.display_name,
        role: row.system_role,
        status: row.status,
      })),
      assignments: assignments.rows.map((row) => ({
        storeCode: row.store_code,
        ownerKey: row.principal_key,
        role: row.assignment_role,
      })),
    };
  } finally {
    client.release();
  }
}

function desiredAssignments(roster) {
  return roster.owners.flatMap((owner) => owner.storeCodes.map((storeCode) => ({
    storeCode,
    ownerKey: owner.key,
  })));
}

function planSummary(roster, warehouseState, planHash) {
  const currentPrincipals = new Set(warehouseState.principals.map(({ key }) => key));
  const currentAssignments = new Map(
    warehouseState.assignments.map(({ storeCode, ownerKey }) => [storeCode, ownerKey]),
  );
  const desired = desiredAssignments(roster);
  return {
    ok: true,
    dryRun: true,
    planHash,
    ownerCount: roster.owners.length,
    storeCount: roster.storeCodes.length,
    activeStoreCount: warehouseState.stores.length,
    principalsToCreate: roster.owners.filter(({ key }) => !currentPrincipals.has(key)).length,
    assignmentsToChange: desired.filter(
      ({ storeCode, ownerKey }) => currentAssignments.get(storeCode) !== ownerKey,
    ).length,
  };
}

async function applyRoster(pool, roster) {
  for (const owner of roster.owners) {
    await ensureEmployeePrincipal(pool, {
      principalKey: owner.key,
      employeeCode: null,
      username: owner.username,
      displayName: owner.displayName,
      systemRole: 'OPERATOR',
      status: 'ACTIVE',
    });
  }
  for (const { storeCode, ownerKey } of desiredAssignments(roster)) {
    await assignEmployeeToStore(pool, {
      storeCode,
      principalKey: ownerKey,
      assignmentKey: `${roster.version}:${storeCode}:PRIMARY:${ownerKey}`,
      assignmentRole: 'PRIMARY',
      assignedByPrincipalKey: null,
      reason: `Full-managed owner roster ${roster.version}`,
      validFrom: roster.effectiveAt,
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.FULL_BI_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('FULL_BI_DATABASE_URL is required.');
  const roster = await readRoster(args.roster);
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const before = await readWarehouseState(pool, roster);
    if (before.stores.length !== roster.storeCodes.length) {
      throw new Error(
        `Roster has ${roster.storeCodes.length} stores but only ${before.stores.length} are active.`,
      );
    }
    const planHash = ownerRosterPlanHash(roster, before);
    const summary = planSummary(roster, before, planHash);
    if (!args.apply) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    if (planHash !== args['expect-plan-hash']) {
      throw new Error('Owner roster plan hash changed after dry-run.');
    }
    await applyRoster(pool, roster);
    const after = await readWarehouseState(pool, roster);
    const desired = desiredAssignments(roster);
    const actual = new Map(after.assignments.map(({ storeCode, ownerKey }) => [storeCode, ownerKey]));
    if (desired.some(({ storeCode, ownerKey }) => actual.get(storeCode) !== ownerKey)) {
      throw new Error('Owner roster readback did not match the requested assignments.');
    }
    console.log(JSON.stringify({
      ok: true,
      applied: true,
      planHash,
      ownerCount: roster.owners.length,
      storeCount: roster.storeCodes.length,
      verifiedAssignments: after.assignments.length,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error.message).slice(0, 400) }, null, 2));
    process.exitCode = 1;
  });
}
