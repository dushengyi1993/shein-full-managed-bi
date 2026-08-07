#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FULL_MANAGED_STORE_CODES,
  normalizeFullManagedStoreCode,
} from '../src/config/full-managed-stores.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFER_EXIT_CODE = 75;
const PARTIAL_EXIT_CODE = 2;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export const COORDINATOR_TASKS = Object.freeze({
  REALTIME: 'realtime-cockpit',
  DAILY: 'daily-operations',
  SUPPLY: 'supply-daily',
  FINANCE: 'finance-daily',
  SESSION: 'session-maintenance',
});

const TASK_SET = new Set(Object.values(COORDINATOR_TASKS));
const TASK_BUDGET_MS = Object.freeze({
  [COORDINATOR_TASKS.REALTIME]: 9 * 60_000,
  [COORDINATOR_TASKS.DAILY]: 75 * 60_000,
  [COORDINATOR_TASKS.SUPPLY]: 55 * 60_000,
  [COORDINATOR_TASKS.FINANCE]: 30 * 60_000,
  [COORDINATOR_TASKS.SESSION]: 20 * 60_000,
});

function safeDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError('COORDINATOR_NOW_INVALID');
  return date;
}

function shanghaiParts(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(safeDate(value))
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value: part }) => [type, part]));
  return Object.freeze({
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  });
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function coordinatorRunId(task, now = new Date()) {
  if (!TASK_SET.has(task)) throw new TypeError('COORDINATOR_TASK_INVALID');
  const current = shanghaiParts(now);
  const suffix = task === COORDINATOR_TASKS.REALTIME
    ? `${current.date}T${String(current.hour).padStart(2, '0')}`
    : current.date;
  return `fm-${task}-${suffix}`;
}

export function parseArgs(argv) {
  const result = {
    task: null,
    execute: false,
    now: null,
    stateDir: process.env.FULL_BI_COORDINATOR_STATE_DIR ?? null,
    retryDelayMs: null,
    budgetMs: null,
  };
  for (const token of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) throw new TypeError('COORDINATOR_ARGUMENT_INVALID');
    const [, name, value] = match;
    if (name === 'execute' && value === undefined) result.execute = true;
    else if (name === 'task' && value && TASK_SET.has(value)) result.task = value;
    else if (name === 'now' && value) result.now = safeDate(value);
    else if (name === 'state-dir' && value) result.stateDir = value;
    else if (name === 'retry-delay-ms' && /^\d+$/.test(value ?? '')) {
      result.retryDelayMs = Number(value);
    } else if (name === 'budget-ms' && /^\d+$/.test(value ?? '')) {
      result.budgetMs = Number(value);
    } else throw new TypeError('COORDINATOR_ARGUMENT_INVALID');
  }
  if (!result.task) throw new TypeError('COORDINATOR_TASK_REQUIRED');
  if (result.execute && !result.stateDir) throw new TypeError('COORDINATOR_STATE_DIR_REQUIRED');
  return result;
}

function nodeStage(name, script, args, {
  lane = 'api-light',
  pressureClass = 'openapi',
  lock,
  storeArg = 'equals',
  environment = {},
} = {}) {
  return Object.freeze({
    name,
    script,
    args: Object.freeze([...args]),
    lane,
    pressureClass,
    lock,
    storeArg,
    environment: Object.freeze({ ...environment }),
  });
}

function storeCsv(stores = FULL_MANAGED_STORE_CODES) {
  return stores.join(',');
}

export function buildCoordinatorPlan(task, now = new Date()) {
  if (!TASK_SET.has(task)) throw new TypeError('COORDINATOR_TASK_INVALID');
  const current = shanghaiParts(now);
  const yesterday = shiftDate(current.date, -1);
  const twoDaysAgo = shiftDate(current.date, -2);
  const eightDaysAgo = shiftDate(current.date, -8);
  const stores = storeCsv();
  const runId = coordinatorRunId(task, now);
  const salesEnvironment = {
    FULL_BI_OPENAPI_CONFIG_FILE:
      process.env.FULL_BI_SALES_OPENAPI_CONFIG_FILE
      ?? process.env.FULL_BI_OPENAPI_CONFIG_FILE
      ?? '',
  };
  if (task === COORDINATOR_TASKS.REALTIME) {
    return Object.freeze({
      task,
      runId,
      businessDate: current.date,
      parallel: true,
      stages: Object.freeze([
        nodeStage('home-realtime', 'scripts/sync_full_managed_home_history.mjs', [
          `--stores=${stores}`,
          `--from=${current.date}`,
          `--to=${current.date}`,
          '--retry-cdp=0',
          '--execute',
        ], {
          pressureClass: 'api-critical',
          lock: '/run/shein-fm-webapi/home-history.lock',
        }),
        nodeStage('sales-realtime', 'scripts/sync_full_managed_sales.mjs', [
          '--all',
          '--concurrency', '2',
          '--run-id', runId,
        ], {
          pressureClass: 'api-critical',
          lock: '/run/shein-fm-coordinator/sales.lock',
          storeArg: 'separate',
          environment: salesEnvironment,
        }),
      ]),
    });
  }
  if (task === COORDINATOR_TASKS.DAILY) {
    return Object.freeze({
      task,
      runId,
      businessDate: current.date,
      parallel: false,
      stages: Object.freeze([
        nodeStage('home-history', 'scripts/sync_full_managed_home_history.mjs', [
          `--stores=${stores}`,
          `--from=${twoDaysAgo}`,
          `--to=${yesterday}`,
          '--refresh-recent-days=2',
          `--require-settled-through=${yesterday}`,
          '--retry-cdp=0',
          '--execute',
        ], {
          lock: '/run/shein-fm-webapi/home-history.lock',
        }),
        nodeStage('home-ledger', 'scripts/sync_full_managed_home_ledger.mjs', [
          `--stores=${stores}`,
          `--from=${twoDaysAgo}`,
          `--to=${yesterday}`,
          '--retry-cdp=0',
          '--execute',
        ], {
          lock: '/run/shein-fm-webapi/home-ledger.lock',
        }),
      ]),
    });
  }
  if (task === COORDINATOR_TASKS.SUPPLY) {
    return Object.freeze({
      task,
      runId,
      businessDate: current.date,
      parallel: false,
      stages: Object.freeze([
        nodeStage('supply', 'scripts/sync_full_managed_supply.mjs', [
          '--run-id', runId,
          '--concurrency', '2',
        ], {
          lock: '/run/shein-fm-supply/sync.lock',
          storeArg: 'separate',
        }),
      ]),
    });
  }
  if (task === COORDINATOR_TASKS.FINANCE) {
    return Object.freeze({
      task,
      runId,
      businessDate: current.date,
      parallel: false,
      stages: Object.freeze([
        nodeStage('finance', 'scripts/sync_full_managed_home_finance.mjs', [
          `--stores=${stores}`,
          `--from=${eightDaysAgo}`,
          `--to=${twoDaysAgo}`,
          '--concurrency=2',
          '--execute',
        ], {
          lock: '/run/shein-fm-sales/home-finance-daily.lock',
          environment: salesEnvironment,
        }),
      ]),
    });
  }
  return Object.freeze({
    task,
    runId,
    businessDate: current.date,
    parallel: false,
    stages: Object.freeze([
      Object.freeze({
        name: 'session-renewal',
        script: 'scripts/renew_full_managed_webapi_sessions.mjs',
        args: Object.freeze([]),
        lane: 'api-light',
        pressureClass: 'openapi',
        lock: '/srv/shein-fm/runtime/store-login/renewal.lock',
        storeArg: null,
        environment: Object.freeze({}),
        continueOnPartial: true,
      }),
      Object.freeze({
        name: 'session-recovery',
        script: 'scripts/recover_full_managed_webapi_sessions.mjs',
        args: Object.freeze([]),
        lane: 'browser-read',
        pressureClass: 'browser',
        lock: '/srv/shein-fm/runtime/store-login/renewal.lock',
        storeArg: null,
        environment: Object.freeze({}),
        onlyAfterPartial: 'session-renewal',
      }),
      Object.freeze({
        name: 'session-final-renewal',
        script: 'scripts/renew_full_managed_webapi_sessions.mjs',
        args: Object.freeze([]),
        lane: 'api-light',
        pressureClass: 'openapi',
        lock: '/srv/shein-fm/runtime/store-login/renewal.lock',
        storeArg: null,
        environment: Object.freeze({}),
        continueOnPartial: true,
      }),
      Object.freeze({
        name: 'session-final-recovery',
        script: 'scripts/recover_full_managed_webapi_sessions.mjs',
        args: Object.freeze([]),
        lane: 'browser-read',
        pressureClass: 'browser',
        lock: '/srv/shein-fm/runtime/store-login/renewal.lock',
        storeArg: null,
        environment: Object.freeze({}),
        onlyAfterPartial: 'session-final-renewal',
      }),
      Object.freeze({
        name: 'session-final-validation',
        script: 'scripts/renew_full_managed_webapi_sessions.mjs',
        args: Object.freeze([]),
        lane: 'api-light',
        pressureClass: 'openapi',
        lock: '/srv/shein-fm/runtime/store-login/renewal.lock',
        storeArg: null,
        environment: Object.freeze({}),
      }),
    ]),
  });
}

export function extractLastJsonDocument(value) {
  const text = String(value ?? '').trim();
  for (let index = text.lastIndexOf('{'); index >= 0; index = text.lastIndexOf('{', index - 1)) {
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // A pretty-printed document can contain many nested opening braces. Keep
      // scanning backwards until its real root is reached.
    }
  }
  return null;
}

function uniqueStoreCodes(values) {
  return [...new Set(values
    .map((value) => String(value ?? '').trim().toUpperCase())
    .filter((value) => FULL_MANAGED_STORE_CODES.includes(value)))];
}

function homeRetryStores(summary) {
  if (summary?.requiresRetry !== true) return [];
  return uniqueStoreCodes((summary.results ?? [])
    .filter((row) => (
      row?.sessionErrorCode
      || row?.storeDaily?.ok === false
      || row?.realtime?.ok === false
      || row?.shopDaily?.ok === false
      || row?.productDaily?.ok === false
      || row?.tradeDaily?.ok === false
      || row?.regionDaily?.ok === false
    ))
    .map(({ storeCode }) => storeCode));
}

export function classifyStageResult(stageName, exitCode, summary) {
  if (exitCode === 0) return Object.freeze({ complete: true, retryStores: [] });
  if (exitCode === DEFER_EXIT_CODE) {
    return Object.freeze({ complete: false, deferred: true, retryStores: [] });
  }
  if (exitCode !== PARTIAL_EXIT_CODE) {
    return Object.freeze({ complete: false, fatal: true, retryStores: [] });
  }
  let retryStores = [];
  if (stageName === 'home-history' || stageName === 'home-realtime') {
    retryStores = homeRetryStores(summary);
  } else if (stageName === 'home-ledger') {
    retryStores = uniqueStoreCodes((summary?.results ?? [])
      .filter(({ ok }) => ok === false)
      .map(({ storeCode }) => storeCode));
  }
  else if (stageName === 'sales-realtime') {
    const results = Array.isArray(summary?.results) ? summary.results : [];
    retryStores = uniqueStoreCodes(results
      .filter(({ status }) => status === 'error')
      .map(({ storeCode }) => storeCode));
    const terminalDetails = results
      .filter(({ status }) => !['loaded', 'error'].includes(status))
      .map(({ storeCode, status, errorCode }) => ({
        warning: status === 'quality_blocked'
          ? 'TERMINAL_DATA_QUALITY_GAP'
          : 'TERMINAL_CAPABILITY_GAP',
        storeCode: normalizeFullManagedStoreCode(storeCode),
        errorCode: /^[A-Z0-9_]{3,64}$/.test(String(errorCode ?? ''))
          ? String(errorCode)
          : 'UNCLASSIFIED_PARTIAL',
      }))
      .filter(({ storeCode }) => storeCode !== null);
    if (retryStores.length === 0 && terminalDetails.length > 0) {
      return Object.freeze({
        complete: true,
        terminalPartial: true,
        retryStores,
        terminalWarnings: [...new Set(terminalDetails.map(({ warning }) => warning))],
        terminalDetails,
      });
    }
  } else if (stageName === 'supply') {
    retryStores = uniqueStoreCodes((summary?.results ?? [])
      .filter(({ status }) => ['partial', 'error'].includes(status))
      .map(({ storeCode }) => storeCode));
  } else if (stageName === 'finance') {
    retryStores = uniqueStoreCodes((summary?.stores ?? [])
      .filter(({ failedWindows }) => Number(failedWindows) > 0)
      .map(({ storeCode }) => storeCode));
  } else if (stageName === 'session-final-validation') {
    return Object.freeze({ complete: false, retryStores: [] });
  } else if (stageName === 'session-renewal' || stageName === 'session-final-renewal') {
    return Object.freeze({
      complete: true,
      needsRecovery: true,
      retryStores: [],
    });
  } else if (stageName === 'session-recovery' || stageName === 'session-final-recovery') {
    return Object.freeze({ complete: false, retryStores: [] });
  }
  return Object.freeze({
    complete: retryStores.length === 0,
    terminalPartial: retryStores.length === 0,
    retryStores,
  });
}

function stageArgsForStores(stage, stores) {
  if (!stage.storeArg || !Array.isArray(stores) || stores.length === 0) return [...stage.args];
  const args = [];
  for (let index = 0; index < stage.args.length; index += 1) {
    const token = stage.args[index];
    if (token === '--all') continue;
    if (token === '--stores') {
      index += 1;
      continue;
    }
    if (token.startsWith('--stores=')) continue;
    args.push(token);
  }
  if (stage.storeArg === 'separate') args.push('--stores', storeCsv(stores));
  else args.push(`--stores=${storeCsv(stores)}`);
  return args;
}

function safeStateName(runId) {
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(runId)) throw new TypeError('COORDINATOR_RUN_ID_INVALID');
  return `${runId.replaceAll(':', '_')}.json`;
}

async function atomicWriteState(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o770 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o660 });
  // systemd services run with UMask=0077. Explicitly restore the intended
  // dashboard-group contract before the atomic rename.
  await chmod(temporary, 0o660);
  await rename(temporary, file);
}

async function readState(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function boundedAppend(existing, chunk) {
  const combined = `${existing}${chunk}`;
  return combined.length <= MAX_CAPTURE_BYTES
    ? combined
    : combined.slice(combined.length - MAX_CAPTURE_BYTES);
}

export async function runStageProcess(stage, stores = null) {
  const commandArgs = [
    'scripts/run_shein_host_lane.sh',
    stage.lane,
    'fm',
    stage.pressureClass,
    '/usr/bin/flock', '-n', '-E', String(DEFER_EXIT_CODE), stage.lock,
    process.execPath,
    stage.script,
    ...stageArgsForStores(stage, stores),
  ];
  const child = spawn('/usr/bin/bash', commandArgs, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...stage.environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    stdout = boundedAppend(stdout, chunk.toString('utf8'));
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    stderr = boundedAppend(stderr, chunk.toString('utf8'));
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(Object.assign(new Error('COORDINATOR_STAGE_SIGNALLED'), { code: signal }));
      else resolve(Number.isSafeInteger(code) ? code : 1);
    });
  });
  return Object.freeze({
    exitCode,
    summary: extractLastJsonDocument(stdout) ?? extractLastJsonDocument(stderr),
  });
}

function defaultRetryDelay(task, stageName, classification) {
  if (classification.deferred) return 15_000;
  if (task === COORDINATOR_TASKS.DAILY && stageName === 'home-history') return 5 * 60_000;
  if (task === COORDINATOR_TASKS.SUPPLY) return 30_000;
  return 20_000;
}

function stageSnapshot(stageState) {
  return {
    status: stageState.status,
    attempts: stageState.attempts,
    pendingStores: stageState.pendingStores ?? [],
    terminalWarnings: stageState.terminalWarnings ?? [],
    terminalDetails: stageState.terminalDetails ?? [],
    completedAt: stageState.completedAt ?? null,
    lastExitCode: stageState.lastExitCode ?? null,
  };
}

export async function runCoordinator(plan, {
  stateDir,
  budgetMs = TASK_BUDGET_MS[plan.task],
  retryDelayMs = null,
  clock = () => new Date(),
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  runStage = runStageProcess,
} = {}) {
  if (!stateDir) throw new TypeError('COORDINATOR_STATE_DIR_REQUIRED');
  const stateFile = path.join(stateDir, safeStateName(plan.runId));
  const existing = await readState(stateFile);
  const publishedPlanComplete = existing?.status === 'PUBLISHED'
    && plan.stages.every((stage) => existing?.stages?.[stage.name]?.status === 'COMPLETE');
  if (publishedPlanComplete) return existing;
  const startedAt = existing?.startedAt ?? clock().toISOString();
  // A persisted run is resumable across coordinator activations. The business
  // run keeps its original startedAt/checkpoints, but every activation gets a
  // fresh bounded execution budget. Anchoring the deadline to the first ever
  // startedAt made an expired WAITING run impossible to resume after its
  // resource/platform blocker had been fixed.
  const deadline = clock().valueOf() + budgetMs;
  const state = {
    schemaVersion: 1,
    task: plan.task,
    runId: plan.runId,
    businessDate: plan.businessDate,
    status: 'RUNNING',
    startedAt,
    updatedAt: clock().toISOString(),
    readyAt: null,
    publishedAt: existing?.publishedAt ?? null,
    stages: existing?.stages ?? {},
  };
  let stateWrite = Promise.resolve();
  const persistState = () => {
    const snapshot = structuredClone(state);
    stateWrite = stateWrite.then(() => atomicWriteState(stateFile, snapshot));
    return stateWrite;
  };
  await persistState();

  const executeStage = async (stage) => {
    const prior = state.stages[stage.name] ?? {};
    if (prior.status === 'COMPLETE') return prior;
    if (stage.onlyAfterPartial) {
      const dependency = state.stages[stage.onlyAfterPartial];
      if (dependency?.needsRecovery !== true) {
        const skipped = {
          status: 'COMPLETE',
          attempts: 0,
          pendingStores: [],
          terminalWarnings: [],
          completedAt: clock().toISOString(),
        };
        state.stages[stage.name] = skipped;
        state.updatedAt = clock().toISOString();
        await persistState();
        return skipped;
      }
    }
    let pendingStores = Array.isArray(prior.pendingStores) && prior.pendingStores.length > 0
      ? prior.pendingStores
      : null;
    let attempts = Number.isSafeInteger(prior.attempts) ? prior.attempts : 0;
    const terminalWarnings = new Set(prior.terminalWarnings ?? []);
    const terminalDetails = new Map((prior.terminalDetails ?? []).map((detail) => (
      [`${detail.warning}:${detail.storeCode}:${detail.errorCode}`, detail]
    )));
    while (clock().valueOf() < deadline) {
      attempts += 1;
      state.stages[stage.name] = {
        status: 'RUNNING',
        attempts,
        pendingStores: pendingStores ?? [],
        terminalWarnings: [...terminalWarnings],
        terminalDetails: [...terminalDetails.values()],
        startedAt: prior.startedAt ?? clock().toISOString(),
      };
      state.updatedAt = clock().toISOString();
      await persistState();
      const result = await runStage(stage, pendingStores);
      const classification = classifyStageResult(stage.name, result.exitCode, result.summary);
      for (const warning of classification.terminalWarnings ?? []) terminalWarnings.add(warning);
      for (const detail of classification.terminalDetails ?? []) {
        terminalDetails.set(`${detail.warning}:${detail.storeCode}:${detail.errorCode}`, detail);
      }
      if (classification.complete) {
        const completed = {
          status: 'COMPLETE',
          attempts,
          pendingStores: [],
          needsRecovery: classification.needsRecovery === true,
          terminalWarnings: classification.terminalPartial ? [...terminalWarnings] : [],
          terminalDetails: classification.terminalPartial ? [...terminalDetails.values()] : [],
          lastExitCode: result.exitCode,
          completedAt: clock().toISOString(),
        };
        state.stages[stage.name] = completed;
        state.updatedAt = clock().toISOString();
        await persistState();
        return completed;
      }
      if (classification.fatal) {
        state.stages[stage.name] = {
          status: 'FAILED', attempts, pendingStores: [], lastExitCode: result.exitCode,
        };
        state.status = 'FAILED';
        state.updatedAt = clock().toISOString();
        await persistState();
        return state.stages[stage.name];
      }
      pendingStores = classification.retryStores.length > 0
        ? classification.retryStores
        : pendingStores;
      state.stages[stage.name] = {
        status: classification.deferred ? 'WAITING_RESOURCE' : 'RETRYING',
        attempts,
        pendingStores: pendingStores ?? [],
        terminalWarnings: [...terminalWarnings],
        terminalDetails: [...terminalDetails.values()],
        lastExitCode: result.exitCode,
      };
      state.status = classification.deferred ? 'WAITING_RESOURCE' : 'WAITING_PLATFORM';
      state.updatedAt = clock().toISOString();
      await persistState();
      await sleep(retryDelayMs ?? defaultRetryDelay(plan.task, stage.name, classification));
      state.status = 'RUNNING';
    }
    state.stages[stage.name] = {
      status: 'WAITING', attempts, pendingStores: pendingStores ?? [], lastExitCode: PARTIAL_EXIT_CODE,
    };
    state.status = 'WAITING_PLATFORM';
    state.updatedAt = clock().toISOString();
    await persistState();
    return state.stages[stage.name];
  };

  if (plan.parallel) {
    await Promise.all(plan.stages.map(executeStage));
  } else {
    for (const stage of plan.stages) {
      const result = await executeStage(stage);
      if (result.status !== 'COMPLETE') break;
    }
  }
  const complete = plan.stages.every((stage) => state.stages[stage.name]?.status === 'COMPLETE');
  if (complete) {
    state.status = 'READY_TO_PUBLISH';
    state.readyAt = clock().toISOString();
  } else if (state.status === 'RUNNING') {
    state.status = 'WAITING_PLATFORM';
  }
  state.updatedAt = clock().toISOString();
  state.stageSummary = Object.fromEntries(Object.entries(state.stages)
    .map(([name, value]) => [name, stageSnapshot(value)]));
  await persistState();
  return state;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const now = args.now ?? new Date();
  const plan = buildCoordinatorPlan(args.task, now);
  if (!args.execute) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'DRY_RUN',
      ...plan,
      stages: plan.stages.map((stage) => ({
        name: stage.name,
        lane: stage.lane,
        script: stage.script,
        args: stage.args,
      })),
    }, null, 2));
    return 0;
  }
  const result = await runCoordinator(plan, {
    stateDir: args.stateDir,
    budgetMs: args.budgetMs ?? TASK_BUDGET_MS[args.task],
    retryDelayMs: args.retryDelayMs,
  });
  console.log(JSON.stringify({
    ok: result.status === 'READY_TO_PUBLISH' || result.status === 'PUBLISHED',
    task: result.task,
    runId: result.runId,
    status: result.status,
    readyAt: result.readyAt,
    stageSummary: result.stageSummary,
  }));
  if (!['READY_TO_PUBLISH', 'PUBLISHED'].includes(result.status)) process.exitCode = PARTIAL_EXIT_CODE;
  return process.exitCode ?? 0;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/run_full_managed_business_coordinator.mjs')) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      errorCode: String(error?.code ?? error?.message ?? 'COORDINATOR_FAILED')
        .toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80),
    }));
    process.exitCode = 1;
  });
}
