#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  MaintenanceSafetyError,
  TEST_ROOT_ENV,
  boundedIntegerFlag,
  emit,
  parseFlags,
  resolveMaintenanceRoot,
} from './lib/full_managed_maintenance.mjs';

const execFileAsync = promisify(execFile);

/**
 * Bounded operational-history maintenance for full-managed warehouse tables.
 *
 * Plan is the default and touches nothing. `--execute` additionally requires
 * `--plan-hash=<sha256>` matching the plan it is about to run, so an operator can
 * never execute a stale or unreviewed plan.
 *
 * Every destructive step runs inside ONE transaction: the partition drops, the
 * snapshot deletes, the projection deletes and the temporary trigger changes all
 * commit together or roll back together. `VACUUM FULL` cannot run in a
 * transaction, so it happens only after the commit and only behind an explicit
 * operator flag.
 */

/* No `--execute-safe` shortcut exists on purpose: every destructive step goes
   through plan review plus a matching --plan-hash, so nothing here can be
   automated into a timer without an operator reviewing the plan first. */
const FLAGS = [
  'execute', 'plan-hash', 'retention-days', 'partition-days-ahead',
  'reclaim', 'runtime-dir', 'lock-timeout-seconds', 'skip-window-check',
];

/** One dedicated advisory lock key for full-managed history maintenance. */
export const HISTORY_LOCK_KEY = 8_842_137_001;

/** The supply units that must be inactive before any destructive step. */
export const SUPPLY_UNITS = Object.freeze({
  service: 'shein-fm-supply-sync.service',
  timer: 'shein-fm-supply-sync.timer',
});

/**
 * The two append-only triggers guarding the projection tables.
 *
 * Runtime roles must never be able to delete a projection row. Maintenance is an
 * owner-only action that disables exactly these two triggers inside the same
 * transaction as the deletes, so a rollback restores the guard automatically and
 * no window exists where a runtime role could mutate history.
 */
export const PROJECTION_APPEND_ONLY_TRIGGERS = Object.freeze([
  { table: 'fact.supply_projection_member', trigger: 'trg_fact_supply_projection_member_append_only' },
  { table: 'fact.supply_projection_batch', trigger: 'trg_fact_supply_projection_batch_append_only' },
]);

/** Tables that must never be pruned, whatever a caller asks for. */
export const NEVER_PRUNE = Object.freeze([
  'fact.purchase_order',
  'fact.purchase_order_line',
  'fact.delivery',
  'fact.delivery_line',
  'dim.canonical_product',
  'dim.full_sku_canonical_assignment',
  'mart.full_store_sales_latest',
  'mart.full_product_sales_latest',
  'ops.webapi_session_health',
]);

/**
 * The latest accepted projection batch per (store, domain, subtype).
 *
 * This mirrors the `ranked_batch`/`latest_batch` CTE the BI read path uses, so
 * "protected" here means exactly "still reachable by a dashboard query".
 */
const LATEST_BATCH_SQL = `
  SELECT batch.store_id,
         batch.domain_code,
         batch.subtype_code,
         batch.supply_projection_batch_id,
         batch.source_fetch_batch_id
    FROM (
      SELECT batch.*,
             row_number() OVER (
               PARTITION BY batch.store_id, batch.domain_code, batch.subtype_code
               ORDER BY batch.source_fetched_at DESC, batch.supply_projection_batch_id DESC
             ) AS recency
        FROM fact.supply_projection_batch AS batch
    ) AS batch
   WHERE batch.recency = 1
`;

/**
 * Snapshot prune targets.
 *
 * Protection is keyed on the exact `source_fetch_batch_id` the read path joins
 * on, never on a timestamp. A timestamp guess would delete a row the dashboard
 * still reads whenever two batches share an instant, and would keep rows the
 * dashboard has already superseded.
 */
export const SNAPSHOT_TARGETS = Object.freeze([
  {
    key: 'inventorySnapshot',
    table: 'fact.inventory_snapshot',
    // Inventory is subtype specific: the read path joins inventory_type_code to
    // the batch subtype, so a PI batch must not protect a JI row.
    protectedPredicate: `
      EXISTS (
        SELECT 1 FROM latest_batch
         WHERE latest_batch.store_id = target.store_id
           AND latest_batch.domain_code = 'INVENTORY'
           AND latest_batch.source_fetch_batch_id = target.source_fetch_batch_id
           AND latest_batch.subtype_code = target.inventory_type_code
      )`,
  },
  {
    key: 'stockAdviceSnapshot',
    table: 'fact.stock_advice_snapshot',
    protectedPredicate: `
      EXISTS (
        SELECT 1 FROM latest_batch
         WHERE latest_batch.store_id = target.store_id
           AND latest_batch.domain_code = 'STOCK_ADVICE'
           AND latest_batch.source_fetch_batch_id = target.source_fetch_batch_id
      )`,
  },
]);

/**
 * Canonical plan hash.
 *
 * The hash covers the exact candidate scope: retention window, cutoff, the
 * partitions to drop, and each target's candidate row count plus a fingerprint of
 * the identities being deleted. Row-count drift therefore invalidates the hash,
 * which is the point: if the candidate set changed between plan and execute, the
 * operator must re-review rather than silently delete a different set.
 */
export function planHash(plan) {
  const canonical = {
    schemaVersion: plan.schemaVersion,
    retentionDays: plan.retentionDays,
    cutoff: plan.cutoff,
    partitionsToDrop: [...plan.partitionsToDrop].sort(),
    targets: plan.targets.map(({ key, table, candidateRows, candidateFingerprint }) => ({
      key, table, candidateRows, candidateFingerprint,
    })),
    reclaim: plan.reclaim,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Partitions strictly older than the retention window.
 *
 * A partition is only a candidate when its date is fully behind the cutoff, so
 * the current day is never dropped even mid-run.
 */
export function selectPartitionsToDrop(partitionNames, cutoffDay) {
  const cutoff = String(cutoffDay);
  return partitionNames
    .filter((name) => {
      const match = /^reconciliation_daily_detail_(\d{4})(\d{2})(\d{2})$/.exec(name);
      if (!match) return false;
      const [, year, month, day] = match;
      return `${year}-${month}-${day}` < cutoff;
    })
    .sort();
}

/**
 * Supply sync must be idle: a live attempt means facts are being written.
 *
 * ops.supply_sync_attempt is an append-only event log: one STARTED row and a
 * later terminal row per attempt. An attempt is still running when its STARTED
 * event has no matching SUCCEEDED / PARTIAL / FAILED event, so idleness cannot
 * be read from a single row's status.
 */
export async function assertSupplySyncIdle(client) {
  const result = await client.query(
    `SELECT count(*)::bigint AS active
       FROM ops.supply_sync_attempt AS started
      WHERE started.status_code = 'STARTED'
        AND NOT EXISTS (
          SELECT 1
            FROM ops.supply_sync_attempt AS terminal
           WHERE terminal.store_id = started.store_id
             AND terminal.domain_code = started.domain_code
             AND terminal.subtype_code = started.subtype_code
             AND terminal.attempt_id = started.attempt_id
             AND terminal.status_code IN ('SUCCEEDED', 'PARTIAL', 'FAILED')
        )`,
  );
  const active = Number(result.rows[0]?.active ?? 0);
  if (active > 0) {
    throw new MaintenanceSafetyError(
      'SUPPLY_SYNC_ACTIVE',
      `${active} supply sync attempts are still running; refusing history maintenance`,
    );
  }
}

/**
 * A real maintenance window: supply sync cannot even start.
 *
 * The append-only log check above only proves nothing is running *right now*. A
 * timer could fire mid-transaction, so execution additionally requires the
 * service to be inactive and the timer disabled, plus no other session already
 * writing to the projection tables.
 */
export async function assertMaintenanceWindow(client, {
  runSystemctl = async (args) => {
    const { stdout } = await execFileAsync('systemctl', args);
    return stdout;
  },
} = {}) {
  const probe = async (args) => {
    try {
      return String(await runSystemctl(args)).trim();
    } catch (error) {
      // `is-active`/`is-enabled` exit non-zero for inactive/disabled units, and
      // still print the state on stdout. Anything else is unprovable.
      const stdout = String(error?.stdout ?? '').trim();
      if (stdout !== '') return stdout;
      throw new MaintenanceSafetyError(
        'WINDOW_UNPROVEN',
        `systemctl ${args.join(' ')} failed: ${error.message}`,
      );
    }
  };

  const serviceState = await probe(['is-active', SUPPLY_UNITS.service]);
  if (serviceState !== 'inactive' && serviceState !== 'failed') {
    throw new MaintenanceSafetyError(
      'SUPPLY_SERVICE_ACTIVE',
      `${SUPPLY_UNITS.service} is ${serviceState}; stop it before history maintenance`,
    );
  }
  const timerState = await probe(['is-enabled', SUPPLY_UNITS.timer]);
  if (timerState === 'enabled') {
    throw new MaintenanceSafetyError(
      'SUPPLY_TIMER_ENABLED',
      `${SUPPLY_UNITS.timer} is still enabled; it could fire mid-transaction`,
    );
  }

  // No other backend may be writing the tables we are about to prune.
  const busy = await client.query(
    `SELECT count(*)::bigint AS writers
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state <> 'idle'
        AND query ~* '(inventory_snapshot|stock_advice_snapshot|supply_projection)'`,
  );
  const writers = Number(busy.rows[0]?.writers ?? 0);
  if (writers > 0) {
    throw new MaintenanceSafetyError(
      'DATABASE_BUSY',
      `${writers} other sessions are touching supply tables; refusing to prune`,
    );
  }
  return { serviceState, timerState };
}

/** Confirm we own the projection tables before touching their triggers. */
async function assertProjectionOwnership(client) {
  for (const { table, trigger } of PROJECTION_APPEND_ONLY_TRIGGERS) {
    const result = await client.query(
      `SELECT pg_get_userbyid(class.relowner) = current_user AS owned,
              EXISTS (
                SELECT 1 FROM pg_trigger
                 WHERE tgrelid = class.oid
                   AND tgname = $2
                   AND NOT tgisinternal
              ) AS has_trigger
         FROM pg_class AS class
        WHERE class.oid = $1::regclass`,
      [table, trigger],
    );
    const row = result.rows[0];
    if (!row) {
      throw new MaintenanceSafetyError('PROJECTION_TABLE_MISSING', `${table} is missing`);
    }
    if (row.owned !== true) {
      throw new MaintenanceSafetyError(
        'PROJECTION_NOT_OWNED',
        `${table} is not owned by current_user; the append-only bypass is owner only`,
      );
    }
    if (row.has_trigger !== true) {
      throw new MaintenanceSafetyError(
        'PROJECTION_TRIGGER_MISSING',
        `${table} is missing ${trigger}; refusing to assume append-only is enforced`,
      );
    }
  }
}

async function buildPlan(client, { retentionDays, reclaim }) {
  const cutoffResult = await client.query(
    // True UTC day, matching the partition boundaries.
    `SELECT (((clock_timestamp() AT TIME ZONE 'UTC')::date) - $1::integer)::text AS cutoff`,
    [retentionDays],
  );
  const cutoff = cutoffResult.rows[0].cutoff;

  const partitions = await client.query(
    `SELECT child.relname AS name
       FROM pg_inherits
       JOIN pg_class AS child ON child.oid = pg_inherits.inhrelid
      WHERE pg_inherits.inhparent = 'ops.reconciliation_daily_detail'::regclass`,
  );
  const partitionsToDrop = selectPartitionsToDrop(
    partitions.rows.map((row) => row.name),
    cutoff,
  );

  const targets = [];
  for (const target of SNAPSHOT_TARGETS) {
    // Count and fingerprint only; nothing is deleted while planning.
    const counted = await client.query(
      `WITH latest_batch AS (${LATEST_BATCH_SQL})
       SELECT count(*)::bigint AS candidate_rows,
              coalesce(
                encode(
                  sha256(
                    string_agg(
                      target.store_id || ':' || target.source_fetch_batch_id,
                      ',' ORDER BY target.store_id, target.source_fetch_batch_id
                    )::bytea
                  ),
                  'hex'
                ),
                'empty'
              ) AS candidate_fingerprint
         FROM ${target.table} AS target
        WHERE target.source_fetched_at < ($1::date)::timestamptz
          AND NOT ${target.protectedPredicate}`,
      [cutoff],
    );
    targets.push({
      key: target.key,
      table: target.table,
      candidateRows: Number(counted.rows[0]?.candidate_rows ?? 0),
      candidateFingerprint: counted.rows[0]?.candidate_fingerprint ?? 'empty',
    });
  }

  // Projection members and batches: keep the retention window plus the latest
  // batch for every (store, domain, subtype), whatever its age.
  const projection = await client.query(
    `WITH latest_batch AS (${LATEST_BATCH_SQL})
     SELECT count(*)::bigint AS candidate_rows,
            coalesce(
              encode(
                sha256(
                  string_agg(
                    batch.supply_projection_batch_id::text,
                    ',' ORDER BY batch.supply_projection_batch_id
                  )::bytea
                ),
                'hex'
              ),
              'empty'
            ) AS candidate_fingerprint
       FROM fact.supply_projection_batch AS batch
      WHERE batch.source_fetched_at < ($1::date)::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM latest_batch
           WHERE latest_batch.supply_projection_batch_id = batch.supply_projection_batch_id
        )`,
    [cutoff],
  );
  targets.push({
    key: 'supplyProjection',
    table: 'fact.supply_projection_batch',
    candidateRows: Number(projection.rows[0]?.candidate_rows ?? 0),
    candidateFingerprint: projection.rows[0]?.candidate_fingerprint ?? 'empty',
  });

  const plan = {
    schemaVersion: 2,
    retentionDays,
    cutoff,
    partitionsToDrop,
    targets,
    reclaim,
    neverPrune: NEVER_PRUNE,
  };
  return { ...plan, planHash: planHash(plan) };
}

/**
 * Every destructive step, inside the caller's transaction.
 *
 * Deletion order honours the foreign keys: warehouse rows reference their parent
 * inventory snapshot, and projection members reference their batch.
 */
async function executePlan(client, plan, { partitionDaysAhead }) {
  const actions = [];

  // Forward partitions first: writers fail closed without them.
  const created = await client.query(
    'SELECT ops.ensure_reconciliation_partitions($1::integer, 14) AS created',
    [partitionDaysAhead],
  );
  actions.push({ step: 'ensure-partitions', created: Number(created.rows[0].created) });

  // Refresh summaries for every day that still has detail, so long-term rows
  // exist before the detail partition is dropped.
  const days = await client.query(
    `SELECT DISTINCT observed_on::text AS day
       FROM ops.reconciliation_daily_detail
      ORDER BY day`,
  );
  for (const row of days.rows) {
    await client.query('SELECT ops.refresh_reconciliation_daily($1::date)', [row.day]);
  }
  actions.push({ step: 'refresh-daily-summaries', days: days.rows.length });

  // Dropping a partition returns disk immediately, unlike a DELETE.
  const dropped = [];
  for (const name of plan.partitionsToDrop) {
    if (!/^reconciliation_daily_detail_\d{8}$/.test(name)) {
      throw new MaintenanceSafetyError('PARTITION_NAME_UNSAFE', `refusing to drop ${name}`);
    }
    await client.query(`DROP TABLE IF EXISTS ops.${name}`);
    dropped.push(name);
  }
  actions.push({ step: 'drop-detail-partitions', dropped });

  /* Warehouse rows first: fk_fact_warehouse_inventory_store_snapshot references
     the inventory snapshot, so the child must go before its parent. A warehouse
     row is protected exactly when its parent inventory snapshot is protected. */
  const inventoryTarget = SNAPSHOT_TARGETS.find((item) => item.key === 'inventorySnapshot');
  const warehouseDeleted = await client.query(
    `WITH latest_batch AS (${LATEST_BATCH_SQL})
     DELETE FROM fact.warehouse_inventory_snapshot AS warehouse
      WHERE EXISTS (
        SELECT 1
          FROM fact.inventory_snapshot AS target
         WHERE target.store_id = warehouse.store_id
           AND target.inventory_snapshot_id = warehouse.inventory_snapshot_id
           AND target.source_fetched_at < ($1::date)::timestamptz
           AND NOT ${inventoryTarget.protectedPredicate}
      )`,
    [plan.cutoff],
  );

  const deleted = [{
    table: 'fact.warehouse_inventory_snapshot',
    rows: warehouseDeleted.rowCount ?? 0,
  }];
  for (const target of SNAPSHOT_TARGETS) {
    const result = await client.query(
      `WITH latest_batch AS (${LATEST_BATCH_SQL})
       DELETE FROM ${target.table} AS target
        WHERE target.source_fetched_at < ($1::date)::timestamptz
          AND NOT ${target.protectedPredicate}`,
      [plan.cutoff],
    );
    deleted.push({ table: target.table, rows: result.rowCount ?? 0 });
  }
  actions.push({ step: 'prune-snapshots', deleted });

  /* Projection pruning needs the append-only guard lifted. Ownership is proven
     first, the disable happens inside this transaction, and the matching enable
     is issued before commit. Because DDL is transactional in PostgreSQL, a
     rollback restores the trigger automatically, so no window exists in which a
     runtime role could delete a projection row. */
  await assertProjectionOwnership(client);
  for (const { table, trigger } of PROJECTION_APPEND_ONLY_TRIGGERS) {
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  }
  let projectionDeleted;
  try {
    // Members before batches: the member references its batch.
    const members = await client.query(
      `WITH latest_batch AS (${LATEST_BATCH_SQL})
       DELETE FROM fact.supply_projection_member AS member
        WHERE EXISTS (
          SELECT 1
            FROM fact.supply_projection_batch AS batch
           WHERE batch.store_id = member.store_id
             AND batch.supply_projection_batch_id = member.supply_projection_batch_id
             AND batch.source_fetched_at < ($1::date)::timestamptz
             AND NOT EXISTS (
               SELECT 1 FROM latest_batch
                WHERE latest_batch.supply_projection_batch_id
                      = batch.supply_projection_batch_id
             )
        )`,
      [plan.cutoff],
    );
    const batches = await client.query(
      `WITH latest_batch AS (${LATEST_BATCH_SQL})
       DELETE FROM fact.supply_projection_batch AS batch
        WHERE batch.source_fetched_at < ($1::date)::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM latest_batch
             WHERE latest_batch.supply_projection_batch_id = batch.supply_projection_batch_id
          )`,
      [plan.cutoff],
    );
    projectionDeleted = {
      members: members.rowCount ?? 0,
      batches: batches.rowCount ?? 0,
    };
  } finally {
    // Restore the guard on the success path; a rollback restores it anyway.
    for (const { table, trigger } of PROJECTION_APPEND_ONLY_TRIGGERS) {
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
  }
  actions.push({ step: 'prune-projections', ...projectionDeleted });
  return actions;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), FLAGS);
  const execute = flags.has('execute');
  const reclaim = flags.has('reclaim');
  const retentionDays = boundedIntegerFlag(flags, 'retention-days', 14, 7, 400);
  const partitionDaysAhead = boundedIntegerFlag(flags, 'partition-days-ahead', 120, 30, 400);
  const runtimeDir = resolveMaintenanceRoot('runtime', flags.get('runtime-dir'));
  const lockTimeoutSeconds = boundedIntegerFlag(flags, 'lock-timeout-seconds', 30, 5, 900);

  if (reclaim && !execute) {
    throw new MaintenanceSafetyError(
      'RECLAIM_REQUIRES_EXECUTE',
      '--reclaim is a maintenance-window action and requires --execute',
    );
  }
  const skipWindowCheck = flags.has('skip-window-check');
  if (skipWindowCheck && !process.env[TEST_ROOT_ENV]) {
    throw new MaintenanceSafetyError(
      'WINDOW_CHECK_REQUIRED',
      `--skip-window-check requires ${TEST_ROOT_ENV}`,
    );
  }

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.SHEIN_FM_MAINTENANCE_DATABASE_URL });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query(`SET lock_timeout = '${lockTimeoutSeconds}s'`);
    await client.query(`SET statement_timeout = '${lockTimeoutSeconds * 20}s'`);

    // A dedicated advisory lock; never blocks, so two runs cannot interleave.
    const locked = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [
      HISTORY_LOCK_KEY,
    ]);
    if (locked.rows[0].locked !== true) {
      throw new MaintenanceSafetyError(
        'LOCK_UNAVAILABLE',
        'another history maintenance run holds the advisory lock',
      );
    }

    await assertSupplySyncIdle(client);
    const plan = await buildPlan(client, { retentionDays, reclaim });

    if (!execute) {
      // Planning stays read-only and needs no maintenance window.
      emit({ ok: true, mode: 'plan', ...plan });
      return;
    }

    // An execute run must name the exact plan it reviewed.
    const supplied = flags.get('plan-hash') ?? '';
    if (!/^[0-9a-f]{64}$/.test(supplied)) {
      throw new MaintenanceSafetyError(
        'PLAN_HASH_REQUIRED',
        '--execute requires --plan-hash=<sha256> from a fresh plan run',
      );
    }
    if (supplied !== plan.planHash) {
      throw new MaintenanceSafetyError(
        'PLAN_HASH_MISMATCH',
        'the supplied plan hash does not match the current plan; re-plan and review',
      );
    }

    // Prove supply sync cannot even start before opening the transaction.
    const window = skipWindowCheck
      ? { serviceState: 'skipped', timerState: 'skipped' }
      : await assertMaintenanceWindow(client);

    // One transaction for every destructive step: partitions, snapshots,
    // projections and the temporary trigger changes commit or roll back as one.
    await client.query('BEGIN');
    transactionOpen = true;
    let actions;
    try {
      actions = await executePlan(client, plan, { partitionDaysAhead });
      await client.query('COMMIT');
      transactionOpen = false;
    } catch (error) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      throw error;
    }

    let reclaimResult = 'skipped';
    if (reclaim) {
      // VACUUM FULL cannot run inside a transaction and takes an exclusive lock,
      // so it happens only after the commit and only behind this explicit flag.
      // No timer ever schedules it.
      await client.query("SET statement_timeout = '3600s'");
      for (const target of SNAPSHOT_TARGETS) {
        await client.query(`VACUUM (FULL, ANALYZE) ${target.table}`);
      }
      await client.query('VACUUM (FULL, ANALYZE) fact.warehouse_inventory_snapshot');
      await client.query('VACUUM (FULL, ANALYZE) fact.supply_projection_member');
      await client.query('VACUUM (FULL, ANALYZE) ops.reconciliation_result');
      reclaimResult = 'completed';
    }

    const status = {
      schemaVersion: 2,
      completedAt: new Date().toISOString(),
      retentionDays,
      cutoff: plan.cutoff,
      planHash: plan.planHash,
      window,
      actions,
      reclaim: reclaimResult,
    };
    await mkdir(runtimeDir, { recursive: true, mode: 0o755 });
    const statusPath = path.posix.join(runtimeDir, 'history-maintenance.json');
    const temporary = `${statusPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o644 });
    await rename(temporary, statusPath);
    emit({ ok: true, mode: 'execute', ...status });
  } finally {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is going away; nothing was committed.
      }
    }
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [HISTORY_LOCK_KEY]);
    } catch {
      // The connection is closing anyway; the lock is session scoped.
    }
    client.release();
    await pool.end();
  }
}

export { buildPlan, executePlan, LATEST_BATCH_SQL };

if (process.argv[1]?.endsWith('maintain_full_managed_history.mjs')) {
  main().catch((error) => {
    emit({
      ok: false,
      code: error instanceof MaintenanceSafetyError ? error.code : 'UNEXPECTED',
      message: error.message,
    });
    process.exitCode = 1;
  });
}
