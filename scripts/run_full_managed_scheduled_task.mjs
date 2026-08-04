#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { FULL_MANAGED_STORE_CODES } from '../src/config/full-managed-stores.mjs';

export const OPENAPI_SCHEDULE_LOCK_ID = '8842137002';
export const HOME_DAILY_BATCH_SIZE = 5;
export const HOME_DAILY_BATCH_BY_HOUR = Object.freeze({
  5: 0,
  6: 1,
  7: 2,
  9: 3,
  10: 4,
});

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
    hourCycle: 'h23',
  }).formatToParts(date)
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value: part }) => [type, part]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
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
    shanghaiHour: current.hour,
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

function dailyBatch({ batch, shanghaiHour }) {
  const resolved = batch ?? HOME_DAILY_BATCH_BY_HOUR[shanghaiHour];
  const batchIndex = parseInteger(resolved, 'SCHEDULE_BATCH', 0, 4);
  const start = batchIndex * HOME_DAILY_BATCH_SIZE;
  const stores = FULL_MANAGED_STORE_CODES.slice(start, start + HOME_DAILY_BATCH_SIZE);
  if (stores.length !== HOME_DAILY_BATCH_SIZE) throw new Error('SCHEDULE_BATCH_INCOMPLETE');
  return { batchIndex, stores };
}

function command(script, args) {
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([script, ...args]),
  });
}

export function buildScheduledPlan({ task, batch = null, now = new Date() } = {}) {
  if (!TASKS.has(task)) throw new TypeError('SCHEDULE_TASK_REQUIRED');
  const dates = scheduledDates(now);
  const allStores = storeCsv();
  if (task === 'home-realtime') {
    return Object.freeze({
      task,
      dates,
      stores: FULL_MANAGED_STORE_CODES,
      openApiLease: false,
      commands: Object.freeze([command('scripts/sync_full_managed_home_history.mjs', [
        `--stores=${allStores}`,
        `--from=${dates.today}`,
        `--to=${dates.today}`,
        '--no-products',
        '--execute',
      ])]),
    });
  }
  if (task === 'home-daily-batch') {
    const selected = dailyBatch({ batch, shanghaiHour: dates.shanghaiHour });
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
          '--execute',
        ]),
        command('scripts/sync_full_managed_home_ledger.mjs', [
          `--stores=${stores}`,
          `--from=${dates.twoDaysAgo}`,
          `--to=${dates.yesterday}`,
          '--execute',
        ]),
      ]),
    });
  }
  if (task === 'home-daily-retry') {
    return Object.freeze({
      task,
      dates,
      stores: FULL_MANAGED_STORE_CODES,
      openApiLease: false,
      commands: Object.freeze([
        command('scripts/sync_full_managed_home_history.mjs', [
          `--stores=${allStores}`,
          `--from=${dates.twoDaysAgo}`,
          `--to=${dates.yesterday}`,
          `--require-settled-through=${dates.yesterday}`,
          '--execute',
        ]),
        command('scripts/sync_full_managed_home_ledger.mjs', [
          `--stores=${allStores}`,
          `--from=${dates.twoDaysAgo}`,
          `--to=${dates.yesterday}`,
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
        `--from=${dates.fourDaysAgo}`,
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

export async function runPlan(plan, runner = runCommand) {
  let firstFailure = 0;
  for (const entry of plan.commands) {
    const exitCode = await runner(entry);
    if (exitCode !== 0 && firstFailure === 0) firstFailure = exitCode;
  }
  return firstFailure;
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
  const plan = buildScheduledPlan({
    task: args.task,
    batch: args.batch,
    now: args.now ?? new Date(),
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
  const exitCode = plan.openApiLease
    ? await withOpenApiLease(() => runPlan(plan))
    : await runPlan(plan);
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
