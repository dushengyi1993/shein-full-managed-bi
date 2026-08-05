#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { FULL_MANAGED_STORE_CODES } from '../src/config/full-managed-stores.mjs';

export const OPENAPI_SCHEDULE_LOCK_ID = '8842137002';
export const HOME_DAILY_BATCH_SIZE = 5;
export const HOME_REALTIME_BATCH_BY_MINUTE = Object.freeze({
  2: 0,
  32: 1,
});
export const HOME_REALTIME_BATCHES = Object.freeze([
  Object.freeze(FULL_MANAGED_STORE_CODES.slice(0, 12)),
  Object.freeze(FULL_MANAGED_STORE_CODES.slice(12)),
]);
export const HOME_DAILY_BATCH_BY_SLOT = Object.freeze({
  '03:45': 0,
  '04:15': 1,
  '04:45': 2,
  '05:15': 3,
  '05:45': 4,
});

function storesForDailyBatch(batchIndex) {
  const start = batchIndex * HOME_DAILY_BATCH_SIZE;
  const stores = FULL_MANAGED_STORE_CODES.slice(start, start + HOME_DAILY_BATCH_SIZE);
  if (stores.length !== HOME_DAILY_BATCH_SIZE) throw new Error('SCHEDULE_BATCH_INCOMPLETE');
  return stores;
}

export function selectRetryStoresFromMarkerPayloads(payloads, businessDate) {
  if (!Array.isArray(payloads)) throw new TypeError('SCHEDULE_MARKERS_INVALID');
  const completed = new Set();
  for (const payload of payloads) {
    if (
      payload?.task === 'home-daily-batch'
      && payload.businessDate === businessDate
      && Number.isSafeInteger(payload.batch)
      && payload.batch >= 0
      && payload.batch <= 4
      && payload.status === 'SUCCEEDED'
    ) {
      completed.add(payload.batch);
    }
  }
  return Object.freeze(
    [...Array(5).keys()]
      .filter((batchIndex) => !completed.has(batchIndex))
      .flatMap(storesForDailyBatch),
  );
}

const TASKS = new Set([
  'home-realtime',
  'home-daily-batch',
  'home-daily-retry',
  'finance-daily',
  'sales-hourly',
  'supply-daily',
]);

function safeDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('SCHEDULE_NOW_INVALID');
  return date;
}

function shanghaiParts(value) {
  const date = safeDate(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value: part }) => [type, part]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function scheduledDates(now = new Date()) {
  const current = shanghaiParts(now);
  return Object.freeze({
    today: current.date,
    yesterday: shiftDate(current.date, -1),
    twoDaysAgo: shiftDate(current.date, -2),
    fourDaysAgo: shiftDate(current.date, -4),
    eightDaysAgo: shiftDate(current.date, -8),
    shanghaiHour: current.hour,
    shanghaiMinute: current.minute,
  });
}

function parseInteger(value, location, minimum, maximum) {
  if (!/^\d+$/.test(String(value ?? ''))) {
    throw new TypeError(`${location}_INVALID`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${location}_INVALID`);
  }
  return number;
}

export function parseArgs(argv) {
  const result = {
    task: null,
    batch: null,
    now: null,
    execute: false,
  };
  for (const token of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) throw new TypeError('SCHEDULE_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'execute' && value === undefined) result.execute = true;
    else if (name === 'task' && value && TASKS.has(value)) result.task = value;
    else if (name === 'batch' && value !== undefined) {
      result.batch = parseInteger(value, 'SCHEDULE_BATCH', 0, 4);
    } else if (name === 'now' && value) {
      result.now = safeDate(value);
    } else throw new TypeError('SCHEDULE_ARGUMENT_INVALID');
  }
  if (!result.task) throw new TypeError('SCHEDULE_TASK_REQUIRED');
  return result;
}

function storeCsv(stores = FULL_MANAGED_STORE_CODES) {
  return stores.join(',');
}

function dailyBatch({ batch, shanghaiHour, shanghaiMinute }) {
  const slot = `${String(shanghaiHour).padStart(2, '0')}:${String(shanghaiMinute).padStart(2, '0')}`;
  const resolved = batch ?? HOME_DAILY_BATCH_BY_SLOT[slot];
  const batchIndex = parseInteger(resolved, 'SCHEDULE_BATCH', 0, 4);
  const stores = storesForDailyBatch(batchIndex);
  return { batchIndex, stores };
}

function realtimeBatch({ batch, shanghaiMinute }) {
  const resolved = batch ?? HOME_REALTIME_BATCH_BY_MINUTE[shanghaiMinute];
  const batchIndex = parseInteger(
    resolved,
    'SCHEDULE_REALTIME_BATCH',
    0,
    HOME_REALTIME_BATCHES.length - 1,
  );
  const stores = HOME_REALTIME_BATCHES[batchIndex];
  if (!stores || stores.length === 0) throw new Error('SCHEDULE_REALTIME_BATCH_INCOMPLETE');
  return { batchIndex, stores };
}

function command(script, args, { partialExitCodes = [2] } = {}) {
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([script, ...args]),
    partialExitCodes: Object.freeze([...partialExitCodes]),
  });
}

export function buildScheduledPlan({
  task,
  batch = null,
  retryStores = null,
  now = new Date(),
} = {}) {
  if (!TASKS.has(task)) throw new TypeError('SCHEDULE_TASK_REQUIRED');
  const dates = scheduledDates(now);
  const allStores = storeCsv();
  if (task === 'home-realtime') {
    const selected = realtimeBatch({
      batch,
      shanghaiMinute: dates.shanghaiMinute,
    });
    return Object.freeze({
      task,
      dates,
      batch: selected.batchIndex,
      stores: selected.stores,
      openApiLease: false,
      commands: Object.freeze([command('scripts/sync_full_managed_home_history.mjs', [
        `--stores=${storeCsv(selected.stores)}`,
        `--from=${dates.today}`,
        `--to=${dates.today}`,
        '--no-products',
        '--retry-cdp=1',
        '--allow-partial',
        '--execute',
      ])]),
    });
  }
  if (task === 'home-daily-batch') {
    const selected = dailyBatch({
      batch,
      shanghaiHour: dates.shanghaiHour,
      shanghaiMinute: dates.shanghaiMinute,
    });
    const stores = storeCsv(selected.stores);
    return Object.freeze({
      task,
      dates,
      batch: selected.batchIndex,
      stores: Object.freeze(selected.stores),
      openApiLease: false,
      commands: Object.freeze([
        command('scripts/sync_full_managed_home_history.mjs', [
          `--stores=${stores}`,
          `--from=${dates.twoDaysAgo}`,
          `--to=${dates.yesterday}`,
          '--refresh-recent-days=2',
          `--require-settled-through=${dates.yesterday}`,
          '--retry-cdp=1',
          '--execute',
        ]),
        command('scripts/sync_full_managed_home_ledger.mjs', [
          `--stores=${stores}`,
          `--from=${dates.twoDaysAgo}`,
          `--to=${dates.yesterday}`,
          '--retry-cdp=1',
          '--execute',
        ]),
      ]),
    });
  }
  if (task === 'home-daily-retry') {
    const selectedStores = retryStores === null
      ? FULL_MANAGED_STORE_CODES
      : [...new Set(retryStores.map((store) => String(store).trim().toUpperCase()))];
    if (selectedStores.some((store) => !FULL_MANAGED_STORE_CODES.includes(store))) {
      throw new TypeError('SCHEDULE_RETRY_STORE_INVALID');
    }
    const stores = storeCsv(selectedStores);
    return Object.freeze({
      task,
      dates,
      stores: Object.freeze(selectedStores),
      openApiLease: false,
      commands: Object.freeze(selectedStores.length === 0 ? [] : [
        command('scripts/sync_full_managed_home_history.mjs', [
          `--stores=${stores}`,
          `--from=${dates.twoDaysAgo}`,
          `--to=${dates.yesterday}`,
          `--require-settled-through=${dates.yesterday}`,
          '--retry-cdp=1',
          '--execute',
        ]),
        command('scripts/sync_full_managed_home_ledger.mjs', [
          `--stores=${stores}`,
          `--from=${dates.twoDaysAgo}`,
          `--to=${dates.yesterday}`,
          '--retry-cdp=1',
          '--execute',
        ]),
      ]),
    });
  }
  if (task === 'finance-daily') {
    return Object.freeze({
      task,
      dates,
      stores: FULL_MANAGED_STORE_CODES,
      openApiLease: true,
      commands: Object.freeze([command('scripts/sync_full_managed_home_finance.mjs', [
        `--stores=${allStores}`,
        `--from=${dates.eightDaysAgo}`,
        `--to=${dates.twoDaysAgo}`,
        '--concurrency=1',
        '--no-resume',
        '--execute',
      ])]),
    });
  }
  if (task === 'sales-hourly') {
    return Object.freeze({
      task,
      dates,
      stores: FULL_MANAGED_STORE_CODES,
      openApiLease: true,
      commands: Object.freeze([command('scripts/sync_full_managed_sales.mjs', ['--all'])]),
    });
  }
  return Object.freeze({
    task,
    dates,
    stores: FULL_MANAGED_STORE_CODES,
    openApiLease: true,
    commands: Object.freeze([command('scripts/sync_full_managed_supply.mjs', [])]),
  });
}

async function runCommand(entry) {
  const child = spawn(entry.executable, entry.args, {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: process.env,
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(Object.assign(new Error('SCHEDULE_CHILD_SIGNALLED'), { code: 'SCHEDULE_CHILD_SIGNALLED' }));
        return;
      }
      resolve(Number.isSafeInteger(code) ? code : 1);
    });
  });
}

export async function runPlanWithResult(plan, runner = runCommand) {
  let firstFailure = 0;
  let partial = false;
  const commands = [];
  for (const entry of plan.commands) {
    const exitCode = await runner(entry);
    const isPartial = entry.partialExitCodes?.includes(exitCode) === true;
    const status = exitCode === 0 ? 'SUCCEEDED' : isPartial ? 'PARTIAL' : 'FAILED';
    commands.push(Object.freeze({
      script: entry.args[0],
      exitCode,
      status,
    }));
    if (isPartial) partial = true;
    else if (exitCode !== 0 && firstFailure === 0) firstFailure = exitCode;
  }
  return Object.freeze({
    exitCode: firstFailure,
    status: firstFailure !== 0 ? 'FAILED' : partial ? 'PARTIAL' : 'SUCCEEDED',
    commands: Object.freeze(commands),
  });
}

export async function runPlan(plan, runner = runCommand) {
  return (await runPlanWithResult(plan, runner)).exitCode;
}

async function writeScheduleMarker(plan, result) {
  const markerDir = process.env.FULL_BI_SCHEDULE_MARKER_DIR;
  if (!markerDir) return;
  const suffix = Number.isSafeInteger(plan.batch) ? `batch-${plan.batch}` : 'all';
  const name = `${plan.task}-${plan.dates.today}-${suffix}.json`;
  await mkdir(markerDir, { recursive: true, mode: 0o700 });
  const target = path.join(markerDir, name);
  const temporary = `${target}.${process.pid}.tmp`;
  const payload = {
    schemaVersion: 1,
    task: plan.task,
    businessDate: plan.dates.today,
    batch: plan.batch ?? null,
    status: result.status,
    completedAt: new Date().toISOString(),
    stores: Array.isArray(plan.stores) ? plan.stores : [],
    commands: result.commands ?? [],
  };
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function loadRetryStores(markerDir, businessDate) {
  if (!markerDir) return FULL_MANAGED_STORE_CODES;
  const payloads = [];
  for (let batchIndex = 0; batchIndex < 5; batchIndex += 1) {
    const marker = path.join(
      markerDir,
      `home-daily-batch-${businessDate}-batch-${batchIndex}.json`,
    );
    try {
      payloads.push(JSON.parse(await readFile(marker, 'utf8')));
    } catch {
      // Missing, truncated or invalid evidence must be retried, never guessed
      // successful from the wall clock alone.
    }
  }
  return selectRetryStoresFromMarkerPayloads(payloads, businessDate);
}

async function withOpenApiLease(work) {
  const databaseUrl = process.env.FULL_BI_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('SCHEDULE_DATABASE_URL_MISSING');
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: 'shein_fm_schedule_lease',
  });
  const client = await pool.connect();
  let acquired = false;
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [OPENAPI_SCHEDULE_LOCK_ID],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) {
      console.error(JSON.stringify({
        ok: false,
        errorCode: 'OPENAPI_SCHEDULE_BUSY',
        retryable: true,
      }));
      return 75;
    }
    return await work();
  } finally {
    if (acquired) {
      await client.query(
        'SELECT pg_advisory_unlock($1::bigint)',
        [OPENAPI_SCHEDULE_LOCK_ID],
      ).catch(() => {});
    }
    client.release();
    await pool.end();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const scheduleNow = args.now ?? new Date();
  const dates = scheduledDates(scheduleNow);
  const retryStores = args.task === 'home-daily-retry'
    ? await loadRetryStores(
        process.env.FULL_BI_SCHEDULE_MARKER_DIR,
        dates.today,
      )
    : null;
  const plan = buildScheduledPlan({
    task: args.task,
    batch: args.batch,
    retryStores,
    now: scheduleNow,
  });
  if (!args.execute) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'DRY_RUN',
      ...plan,
      commands: plan.commands.map(({ executable, args: commandArgs }) => ({
        executable,
        args: commandArgs,
      })),
    }, null, 2));
    return 0;
  }
  const leasedResult = plan.openApiLease
    ? await withOpenApiLease(() => runPlanWithResult(plan))
    : await runPlanWithResult(plan);
  if (leasedResult === 75) return 75;
  await writeScheduleMarker(plan, leasedResult);
  console.log(JSON.stringify({
    ok: leasedResult.exitCode === 0,
    schedulerStatus: leasedResult.status,
    task: plan.task,
    businessDate: plan.dates.today,
    batch: plan.batch ?? null,
    commands: leasedResult.commands,
  }));
  const exitCode = leasedResult.exitCode;
  if (exitCode !== 0) process.exitCode = exitCode;
  return exitCode;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/run_full_managed_scheduled_task.mjs')) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      errorCode: String(error?.code ?? error?.message ?? 'SCHEDULE_FAILED')
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_')
        .slice(0, 80),
    }));
    process.exitCode = 1;
  });
}
