#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const STORE_PATTERN = /^[A-Z0-9_-]{2,24}$/;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function requiredText(value, label) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function nullableText(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  return text || null;
}

function validInstant(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid timestamp.`);
  return date.toISOString();
}

export function normalizeReportingGoodsManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Manifest must be an object.');
  }
  if (input.schemaVersion !== 1) throw new TypeError('Manifest schemaVersion must be 1.');
  const planHash = requiredText(input.planHash, 'planHash');
  if (!HASH_PATTERN.test(planHash)) throw new TypeError('planHash is invalid.');
  if (!Array.isArray(input.groups) || input.groups.length === 0) {
    throw new TypeError('groups must be a non-empty array.');
  }
  if (!Array.isArray(input.assignments) || input.assignments.length === 0) {
    throw new TypeError('assignments must be a non-empty array.');
  }
  if (!Array.isArray(input.excluded)) throw new TypeError('excluded must be an array.');

  const groupByCode = new Map();
  const groups = input.groups.map((value, index) => {
    const standardGoodsCode = requiredText(value?.standardGoodsCode, `groups[${index}].standardGoodsCode`);
    const displayName = requiredText(value?.displayName, `groups[${index}].displayName`);
    const modelNormalized = nullableText(value?.modelNormalized);
    const namingRule = requiredText(value?.namingRule, `groups[${index}].namingRule`);
    const confidenceBand = requiredText(value?.confidenceBand, `groups[${index}].confidenceBand`);
    const groupFingerprint = requiredText(value?.groupFingerprint, `groups[${index}].groupFingerprint`);
    const assignmentCount = Number(value?.assignmentCount);
    const categories = Array.isArray(value?.categories)
      ? value.categories.map((category, categoryIndex) => requiredText(
        category,
        `groups[${index}].categories[${categoryIndex}]`,
      ))
      : [];
    if (!['MODEL_PLUS_SHEIN_LEAF', 'PURE_CHINESE'].includes(namingRule)) {
      throw new TypeError(`groups[${index}].namingRule is invalid.`);
    }
    if (!['HIGH', 'MEDIUM', 'LOW'].includes(confidenceBand)) {
      throw new TypeError(`groups[${index}].confidenceBand is invalid.`);
    }
    if (!HASH_PATTERN.test(groupFingerprint)) {
      throw new TypeError(`groups[${index}].groupFingerprint is invalid.`);
    }
    if (!Number.isSafeInteger(assignmentCount) || assignmentCount < 1) {
      throw new TypeError(`groups[${index}].assignmentCount is invalid.`);
    }
    if (namingRule === 'PURE_CHINESE' && !/^\p{Script=Han}+$/u.test(standardGoodsCode)) {
      throw new TypeError(`Pure-Chinese standard goods code is invalid: ${standardGoodsCode}`);
    }
    if (
      namingRule === 'MODEL_PLUS_SHEIN_LEAF'
      && (!modelNormalized || !standardGoodsCode.startsWith(modelNormalized) || !/\p{Script=Han}/u.test(standardGoodsCode))
    ) {
      throw new TypeError(`Modeled standard goods code is invalid: ${standardGoodsCode}`);
    }
    if (groupByCode.has(standardGoodsCode)) {
      throw new TypeError(`Standard goods code is duplicated: ${standardGoodsCode}`);
    }
    const group = {
      standardGoodsCode,
      displayName,
      modelNormalized,
      namingRule,
      confidenceBand,
      categories,
      groupFingerprint,
      assignmentCount,
    };
    groupByCode.set(standardGoodsCode, group);
    return group;
  });

  const seenSkus = new Set();
  const assignments = input.assignments.map((value, index) => {
    const storeCode = requiredText(value?.storeCode, `assignments[${index}].storeCode`).toUpperCase();
    const fullSkuId = requiredText(value?.fullSkuId, `assignments[${index}].fullSkuId`);
    const standardGoodsCode = requiredText(
      value?.standardGoodsCode,
      `assignments[${index}].standardGoodsCode`,
    );
    const confidenceBand = requiredText(value?.confidenceBand, `assignments[${index}].confidenceBand`);
    const groupFingerprint = requiredText(
      value?.groupFingerprint,
      `assignments[${index}].groupFingerprint`,
    );
    const assignmentKey = requiredText(value?.assignmentKey, `assignments[${index}].assignmentKey`);
    if (!STORE_PATTERN.test(storeCode) || !/^[1-9][0-9]*$/.test(fullSkuId)) {
      throw new TypeError(`assignments[${index}] store/SKU identity is invalid.`);
    }
    if (!HASH_PATTERN.test(groupFingerprint) || !HASH_PATTERN.test(assignmentKey)) {
      throw new TypeError(`assignments[${index}] fingerprint is invalid.`);
    }
    const expectedAssignmentKey = sha256({
      namespace: 'full-managed-reporting-goods-v1',
      planHash,
      storeCode,
      fullSkuId,
    });
    if (assignmentKey !== expectedAssignmentKey) {
      throw new TypeError(`assignments[${index}].assignmentKey does not match the plan.`);
    }
    const group = groupByCode.get(standardGoodsCode);
    if (!group) throw new TypeError(`Assignment references unknown group: ${standardGoodsCode}`);
    if (group.groupFingerprint !== groupFingerprint || group.confidenceBand !== confidenceBand) {
      throw new TypeError(`Assignment group contract drifted: ${storeCode}:${fullSkuId}`);
    }
    const skuKey = `${storeCode}:${fullSkuId}`;
    if (seenSkus.has(skuKey)) throw new TypeError(`SKU is assigned more than once: ${skuKey}`);
    seenSkus.add(skuKey);
    return {
      storeCode,
      fullSkuId,
      platformSkuId: nullableText(value?.platformSkuId),
      platformSkcId: nullableText(value?.platformSkcId),
      platformSpuId: nullableText(value?.platformSpuId),
      standardGoodsCode,
      confidenceBand,
      groupFingerprint,
      assignmentKey,
    };
  });

  for (const group of groups) {
    const actualCount = assignments.filter(
      ({ standardGoodsCode }) => standardGoodsCode === group.standardGoodsCode,
    ).length;
    if (actualCount !== group.assignmentCount) {
      throw new TypeError(`Assignment count drifted for ${group.standardGoodsCode}.`);
    }
  }

  const excluded = input.excluded.map((value, index) => {
    const storeCode = requiredText(value?.storeCode, `excluded[${index}].storeCode`).toUpperCase();
    const fullSkuId = requiredText(value?.fullSkuId, `excluded[${index}].fullSkuId`);
    if (seenSkus.has(`${storeCode}:${fullSkuId}`)) {
      throw new TypeError(`Excluded SKU is also assigned: ${storeCode}:${fullSkuId}`);
    }
    return {
      storeCode,
      fullSkuId,
      platformSkuId: nullableText(value?.platformSkuId),
      platformSkcId: nullableText(value?.platformSkcId),
      platformSpuId: nullableText(value?.platformSpuId),
      reason: requiredText(value?.reason, `excluded[${index}].reason`),
    };
  });

  const normalized = {
    schemaVersion: 1,
    sourceGeneratedAt: validInstant(input.sourceGeneratedAt, 'sourceGeneratedAt'),
    approvedAt: validInstant(input.approvedAt, 'approvedAt'),
    approvalActor: requiredText(input.approvalActor, 'approvalActor'),
    approvalText: requiredText(input.approvalText, 'approvalText'),
    namingPolicy: input.namingPolicy,
    groups,
    assignments,
    excluded,
  };
  const recalculated = sha256({
    ...normalized,
    assignments: normalized.assignments.map(({ assignmentKey, ...assignment }) => assignment),
  });
  if (recalculated !== planHash) throw new TypeError('Manifest plan hash does not match its content.');
  return { ...normalized, planHash };
}

function warehouseFingerprint(rows) {
  return sha256(rows.map((row) => ({
    fullSkuId: String(row.full_sku_id),
    storeCode: row.store_code,
    platformSkuId: row.platform_sku_id ?? null,
    platformSkcId: row.platform_skc_id ?? null,
    platformSpuId: row.platform_spu_id ?? null,
    isActive: row.is_active === true,
    currentStandardGoodsCode: row.current_standard_goods_code ?? null,
  })));
}

async function readWarehouseState(client, manifest, { forUpdate = false } = {}) {
  const ids = manifest.assignments.map(({ fullSkuId }) => fullSkuId);
  const result = await client.query(
    `SELECT sku.full_sku_id, store.store_code,
            sku.platform_sku_id, sku.platform_skc_id, sku.platform_spu_id,
            sku.is_active,
            goods.standard_goods_code AS current_standard_goods_code
       FROM dim.full_sku AS sku
       JOIN dim.store AS store ON store.store_id = sku.store_id
       LEFT JOIN dim.full_sku_reporting_goods_assignment AS assignment
         ON assignment.store_id = sku.store_id
        AND assignment.full_sku_id = sku.full_sku_id
        AND assignment.assignment_status = 'CONFIRMED'
        AND assignment.valid_to IS NULL
       LEFT JOIN dim.reporting_goods AS goods
         ON goods.reporting_goods_id = assignment.reporting_goods_id
      WHERE sku.full_sku_id = ANY($1::bigint[])
      ORDER BY sku.full_sku_id${forUpdate ? ' FOR UPDATE OF sku' : ''}`,
    [ids],
  );
  if (result.rows.length !== manifest.assignments.length) {
    throw new Error(
      `Manifest references ${manifest.assignments.length} SKUs but warehouse returned ${result.rows.length}.`,
    );
  }
  const byId = new Map(result.rows.map((row) => [String(row.full_sku_id), row]));
  for (const assignment of manifest.assignments) {
    const row = byId.get(assignment.fullSkuId);
    if (!row || row.store_code !== assignment.storeCode || row.is_active !== true) {
      throw new Error(`SKU scope drifted: ${assignment.storeCode}:${assignment.fullSkuId}`);
    }
    for (const [field, column] of [
      ['platformSkuId', 'platform_sku_id'],
      ['platformSkcId', 'platform_skc_id'],
      ['platformSpuId', 'platform_spu_id'],
    ]) {
      if (assignment[field] && String(row[column] ?? '') !== assignment[field]) {
        throw new Error(`SKU platform identity drifted: ${assignment.storeCode}:${assignment.fullSkuId}`);
      }
    }
  }
  return result.rows;
}

export function reportingGoodsExecutionHash(manifest, warehouseRows) {
  return sha256({
    manifestPlanHash: manifest.planHash,
    warehouseFingerprint: warehouseFingerprint(warehouseRows),
  });
}

export function reportingGoodsPlanSummary(manifest, warehouseRows) {
  const desiredById = new Map(manifest.assignments.map((assignment) => [
    assignment.fullSkuId,
    assignment.standardGoodsCode,
  ]));
  const unchanged = warehouseRows.filter((row) => (
    row.current_standard_goods_code === desiredById.get(String(row.full_sku_id))
  )).length;
  const changed = warehouseRows.filter((row) => (
    row.current_standard_goods_code
    && row.current_standard_goods_code !== desiredById.get(String(row.full_sku_id))
  )).length;
  return {
    ok: true,
    mode: 'dry-run',
    manifestPlanHash: manifest.planHash,
    planHash: reportingGoodsExecutionHash(manifest, warehouseRows),
    groupCount: manifest.groups.length,
    assignmentCount: manifest.assignments.length,
    excludedSkuCount: manifest.excluded.length,
    unchangedAssignmentCount: unchanged,
    changedAssignmentCount: changed,
    newAssignmentCount: manifest.assignments.length - unchanged - changed,
  };
}

async function insertImportRun(client, manifest) {
  const result = await client.query(
    `INSERT INTO ops.reporting_goods_import_run (
         plan_hash, manifest_version, approval_actor, approval_text,
         source_generated_at, approved_at, group_count, assignment_count,
         excluded_sku_count, result_status, applied_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'APPLIED', clock_timestamp())
       ON CONFLICT (plan_hash) DO NOTHING
       RETURNING plan_hash`,
    [
      manifest.planHash,
      manifest.schemaVersion,
      manifest.approvalActor,
      manifest.approvalText,
      manifest.sourceGeneratedAt,
      manifest.approvedAt,
      manifest.groups.length,
      manifest.assignments.length,
      manifest.excluded.length,
    ],
  );
  if (result.rowCount === 1) return;
  const existing = await client.query(
    `SELECT result_status, group_count, assignment_count, excluded_sku_count
       FROM ops.reporting_goods_import_run
      WHERE plan_hash = $1`,
    [manifest.planHash],
  );
  const row = existing.rows[0];
  if (
    row?.result_status !== 'APPLIED'
    || Number(row.group_count) !== manifest.groups.length
    || Number(row.assignment_count) !== manifest.assignments.length
    || Number(row.excluded_sku_count) !== manifest.excluded.length
  ) {
    throw new Error('Existing reporting-goods import run conflicts with the manifest.');
  }
}

async function upsertReportingGoods(client, manifest) {
  await client.query(
    `WITH desired AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS item(
         standard_goods_code text,
         display_name text,
         model_normalized text,
         naming_rule text,
         group_fingerprint text
       )
     )
     INSERT INTO dim.reporting_goods (
       standard_goods_code, display_name, model_normalized, naming_rule,
       source_plan_hash, source_group_fingerprint, status
     )
     SELECT standard_goods_code, display_name, model_normalized, naming_rule,
            $2, group_fingerprint, 'ACTIVE'
     FROM desired
     ON CONFLICT (standard_goods_code) DO NOTHING`,
    [JSON.stringify(manifest.groups.map((group) => ({
      standard_goods_code: group.standardGoodsCode,
      display_name: group.displayName,
      model_normalized: group.modelNormalized,
      naming_rule: group.namingRule,
      group_fingerprint: group.groupFingerprint,
    }))), manifest.planHash],
  );
  const result = await client.query(
    `SELECT standard_goods_code, display_name, model_normalized, naming_rule, status
       FROM dim.reporting_goods
      WHERE standard_goods_code = ANY($1::text[])
      ORDER BY standard_goods_code`,
    [manifest.groups.map(({ standardGoodsCode }) => standardGoodsCode)],
  );
  if (result.rows.length !== manifest.groups.length) {
    throw new Error('Reporting-goods readback count does not match the manifest.');
  }
  const desired = new Map(manifest.groups.map((group) => [group.standardGoodsCode, group]));
  for (const row of result.rows) {
    const group = desired.get(row.standard_goods_code);
    if (
      !group
      || row.display_name !== group.displayName
      || (row.model_normalized ?? null) !== group.modelNormalized
      || row.naming_rule !== group.namingRule
      || row.status !== 'ACTIVE'
    ) {
      throw new Error(`Existing reporting goods drifted: ${row.standard_goods_code}`);
    }
  }
}

async function applyAssignments(client, manifest) {
  const desiredJson = JSON.stringify(manifest.assignments.map((assignment) => ({
    full_sku_id: assignment.fullSkuId,
    standard_goods_code: assignment.standardGoodsCode,
    confidence_band: assignment.confidenceBand,
    group_fingerprint: assignment.groupFingerprint,
    assignment_key: assignment.assignmentKey,
    platform_sku_id: assignment.platformSkuId,
    platform_skc_id: assignment.platformSkcId,
    platform_spu_id: assignment.platformSpuId,
  })));
  const superseded = await client.query(
    `WITH desired AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS item(
         full_sku_id bigint,
         standard_goods_code text
       )
     )
     UPDATE dim.full_sku_reporting_goods_assignment AS assignment
        SET assignment_status = 'SUPERSEDED',
            superseded_by_plan_hash = $2::character(64),
            valid_to = clock_timestamp(),
            updated_at = clock_timestamp()
       FROM desired
       JOIN dim.reporting_goods AS goods
         ON goods.standard_goods_code = desired.standard_goods_code
      WHERE assignment.full_sku_id = desired.full_sku_id
        AND assignment.assignment_status = 'CONFIRMED'
        AND assignment.valid_to IS NULL
        AND assignment.reporting_goods_id <> goods.reporting_goods_id
     RETURNING assignment.full_sku_reporting_goods_assignment_id`,
    [desiredJson, manifest.planHash],
  );
  const inserted = await client.query(
    `WITH desired AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS item(
         full_sku_id bigint,
         standard_goods_code text,
         confidence_band text,
         group_fingerprint text,
         assignment_key text,
         platform_sku_id text,
         platform_skc_id text,
         platform_spu_id text
       )
     )
     INSERT INTO dim.full_sku_reporting_goods_assignment (
       store_id, full_sku_id, reporting_goods_id, assignment_key,
       assignment_status, confidence_band, source_plan_hash,
       source_group_fingerprint, approval_actor, approval_text,
       evidence, valid_from
     )
     SELECT sku.store_id, sku.full_sku_id, goods.reporting_goods_id,
            desired.assignment_key::character(64), 'CONFIRMED', desired.confidence_band,
            $2::character(64), desired.group_fingerprint::character(64), $3, $4,
            jsonb_build_object(
              'scope', 'BI_REPORTING_ONLY',
              'platformSkuId', desired.platform_sku_id,
              'platformSkcId', desired.platform_skc_id,
              'platformSpuId', desired.platform_spu_id
            ),
            clock_timestamp()
       FROM desired
       JOIN dim.full_sku AS sku ON sku.full_sku_id = desired.full_sku_id
       JOIN dim.reporting_goods AS goods
         ON goods.standard_goods_code = desired.standard_goods_code
       LEFT JOIN dim.full_sku_reporting_goods_assignment AS current_assignment
         ON current_assignment.store_id = sku.store_id
        AND current_assignment.full_sku_id = sku.full_sku_id
        AND current_assignment.assignment_status = 'CONFIRMED'
        AND current_assignment.valid_to IS NULL
      WHERE current_assignment.full_sku_reporting_goods_assignment_id IS NULL
     ON CONFLICT (assignment_key) DO NOTHING
     RETURNING full_sku_reporting_goods_assignment_id`,
    [desiredJson, manifest.planHash, manifest.approvalActor, manifest.approvalText],
  );
  return { inserted: inserted.rowCount, superseded: superseded.rowCount };
}

async function verifyApplied(client, manifest) {
  const result = await client.query(
    `SELECT sku.full_sku_id, goods.standard_goods_code
       FROM dim.full_sku_reporting_goods_assignment AS assignment
       JOIN dim.full_sku AS sku
         ON sku.store_id = assignment.store_id
        AND sku.full_sku_id = assignment.full_sku_id
       JOIN dim.reporting_goods AS goods
         ON goods.reporting_goods_id = assignment.reporting_goods_id
      WHERE assignment.assignment_status = 'CONFIRMED'
        AND assignment.valid_to IS NULL
        AND sku.full_sku_id = ANY($1::bigint[])
      ORDER BY sku.full_sku_id`,
    [manifest.assignments.map(({ fullSkuId }) => fullSkuId)],
  );
  const expected = new Map(manifest.assignments.map((assignment) => [
    assignment.fullSkuId,
    assignment.standardGoodsCode,
  ]));
  if (result.rows.length !== manifest.assignments.length) {
    throw new Error('Current assignment readback count does not match the manifest.');
  }
  for (const row of result.rows) {
    if (expected.get(String(row.full_sku_id)) !== row.standard_goods_code) {
      throw new Error(`Assignment readback drifted for SKU ${row.full_sku_id}.`);
    }
  }
  return result.rows.length;
}

export async function applyReportingGoodsManifest(pool, manifest, approvedHash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('shein-fm-reporting-goods-import', 0))`);
    const warehouseRows = await readWarehouseState(client, manifest, { forUpdate: true });
    const executionHash = reportingGoodsExecutionHash(manifest, warehouseRows);
    if (executionHash !== approvedHash) {
      throw new Error('Reporting-goods execution plan changed after dry-run.');
    }
    await insertImportRun(client, manifest);
    await upsertReportingGoods(client, manifest);
    const changed = await applyAssignments(client, manifest);
    const verifiedAssignments = await verifyApplied(client, manifest);
    await client.query('COMMIT');
    return {
      ok: true,
      mode: 'applied',
      manifestPlanHash: manifest.planHash,
      planHash: executionHash,
      groupCount: manifest.groups.length,
      verifiedAssignments,
      excludedSkuCount: manifest.excluded.length,
      insertedAssignments: changed.inserted,
      supersededAssignments: changed.superseded,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function rollbackReportingGoodsManifest(pool, manifest, approvedHash) {
  if (approvedHash !== manifest.planHash) throw new Error('Rollback requires the exact manifest plan hash.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('shein-fm-reporting-goods-import', 0))`);
    const revoked = await client.query(
      `UPDATE dim.full_sku_reporting_goods_assignment
          SET assignment_status = 'REVOKED',
              superseded_by_plan_hash = NULL,
              valid_to = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE source_plan_hash = $1
          AND assignment_status = 'CONFIRMED'
          AND valid_to IS NULL
      RETURNING full_sku_reporting_goods_assignment_id`,
      [manifest.planHash],
    );
    const restored = await client.query(
      `UPDATE dim.full_sku_reporting_goods_assignment AS assignment
          SET assignment_status = 'CONFIRMED',
              superseded_by_plan_hash = NULL,
              valid_to = NULL,
              updated_at = clock_timestamp()
        WHERE assignment.superseded_by_plan_hash = $1
          AND assignment.assignment_status = 'SUPERSEDED'
          AND NOT EXISTS (
            SELECT 1
            FROM dim.full_sku_reporting_goods_assignment AS current_assignment
            WHERE current_assignment.store_id = assignment.store_id
              AND current_assignment.full_sku_id = assignment.full_sku_id
              AND current_assignment.assignment_status = 'CONFIRMED'
              AND current_assignment.valid_to IS NULL
          )
      RETURNING assignment.full_sku_reporting_goods_assignment_id`,
      [manifest.planHash],
    );
    const run = await client.query(
      `UPDATE ops.reporting_goods_import_run
          SET result_status = 'ROLLED_BACK', rolled_back_at = clock_timestamp()
        WHERE plan_hash = $1 AND result_status = 'APPLIED'
      RETURNING plan_hash`,
      [manifest.planHash],
    );
    if (run.rowCount !== 1) throw new Error('Applied import run was not available for rollback.');
    await client.query('COMMIT');
    return {
      ok: true,
      mode: 'rolled-back',
      planHash: manifest.planHash,
      revoked: revoked.rowCount,
      restored: restored.rowCount,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function parseArgs(argv) {
  const result = { apply: false, rollback: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply' || token === '--rollback') {
      result[token.slice(2)] = true;
      continue;
    }
    if (['--manifest', '--approved-hash'].includes(token)) {
      result[token.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!result.manifest) throw new Error('--manifest is required.');
  if (result.apply && result.rollback) throw new Error('--apply and --rollback are mutually exclusive.');
  if ((result.apply || result.rollback) && !HASH_PATTERN.test(result['approved-hash'] || '')) {
    throw new Error('A valid --approved-hash is required for apply or rollback.');
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(await readFile(args.manifest, 'utf8'));
  const manifest = normalizeReportingGoodsManifest(raw);
  const databaseUrl = process.env.FULL_BI_DATABASE_URL;
  if (!databaseUrl) throw new Error('FULL_BI_DATABASE_URL is required.');
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    if (args.rollback) {
      process.stdout.write(`${JSON.stringify(
        await rollbackReportingGoodsManifest(pool, manifest, args['approved-hash']),
        null,
        2,
      )}\n`);
      return;
    }
    if (args.apply) {
      process.stdout.write(`${JSON.stringify(
        await applyReportingGoodsManifest(pool, manifest, args['approved-hash']),
        null,
        2,
      )}\n`);
      return;
    }
    const client = await pool.connect();
    try {
      const warehouseRows = await readWarehouseState(client, manifest);
      process.stdout.write(`${JSON.stringify(
        reportingGoodsPlanSummary(manifest, warehouseRows),
        null,
        2,
      )}\n`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === executedPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message).slice(0, 500) })}\n`);
    process.exitCode = 1;
  });
}
