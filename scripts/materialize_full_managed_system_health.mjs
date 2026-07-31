#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import {
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { FULL_MANAGED_STORE_CODES } from '../src/config/full-managed-stores.mjs';

const execFile = promisify(execFileCallback);

const DEFAULT_OUTPUT_FILE = '/srv/shein-fm/runtime/dashboard/system-health.json';
const LOGIN_STATE_FILE = '/srv/shein-fm/runtime/store-login/state.json';
const RENEWAL_REPORT_FILE = '/srv/shein-fm/runtime/store-login/renewal-report.json';
const ROOT_DISK_FILE = '/srv/shein-fm/runtime/disk-guard.json';
const DATA_DISK_FILE = '/srv/shein-fm/runtime/disk-guard-data.json';
const CURRENT_RELEASE = '/opt/shein-fm/current';
const PREVIOUS_RELEASE = '/opt/shein-fm/previous';

const STORE_CODE_PATTERN = /^[A-Z0-9]{2,12}$/;
const SAFE_CODE_PATTERN = /^[A-Z0-9_:-]{1,80}$/;
const LOGIN_STATES = new Set(['completed', 'pending', 'needs_attention']);
const SESSION_STATES = new Set(['ACTIVE', 'EXPIRED', 'BLOCKED', 'UNKNOWN']);

export const SYSTEM_UNIT_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: 'database',
    label: '数据仓库',
    service: 'shein-fm-db.service',
    kind: 'daemon',
    critical: true,
    route: 'system',
  }),
  Object.freeze({
    key: 'portal',
    label: 'BI 门户',
    service: 'shein-fm-portal.service',
    kind: 'daemon',
    critical: true,
    route: 'system',
  }),
  Object.freeze({
    key: 'authorization',
    label: '开放平台授权台',
    service: 'shein-fm-authorization.service',
    kind: 'daemon',
    critical: false,
    route: 'system',
  }),
  Object.freeze({
    key: 'storeLogin',
    label: '店铺登录维护',
    service: 'shein-fm-store-login.service',
    kind: 'daemon',
    critical: false,
    route: 'system',
  }),
  Object.freeze({
    key: 'webhookReceiver',
    label: 'Webhook 接收',
    service: 'shein-fm-webhook-receiver.service',
    kind: 'daemon',
    critical: true,
    route: 'platform',
  }),
  Object.freeze({
    key: 'webhookWorker',
    label: 'Webhook 处理',
    service: 'shein-fm-webhook-worker.service',
    kind: 'daemon',
    critical: true,
    route: 'platform',
  }),
  Object.freeze({
    key: 'dashboardMaterialize',
    label: 'Dashboard 物化',
    service: 'shein-fm-dashboard-materialize.service',
    timer: 'shein-fm-dashboard-materialize.timer',
    kind: 'job',
    critical: true,
    route: 'system',
  }),
  Object.freeze({
    key: 'salesSync',
    label: '销量同步',
    service: 'shein-fm-sales-sync.service',
    timer: 'shein-fm-sales-sync.timer',
    kind: 'job',
    critical: true,
    route: 'sales',
  }),
  Object.freeze({
    key: 'supplySync',
    label: '供应链同步',
    service: 'shein-fm-supply-sync.service',
    timer: 'shein-fm-supply-sync.timer',
    kind: 'job',
    critical: true,
    route: 'inventory',
  }),
  Object.freeze({
    key: 'sessionRenewal',
    label: 'Profile 续期',
    service: 'shein-fm-session-renewal.service',
    timer: 'shein-fm-session-renewal.timer',
    kind: 'job',
    critical: false,
    route: 'system',
  }),
  Object.freeze({
    key: 'databaseBackup',
    label: '数据库备份',
    service: 'shein-fm-db-backup.service',
    timer: 'shein-fm-db-backup.timer',
    kind: 'job',
    critical: true,
    route: 'system',
  }),
  Object.freeze({
    key: 'diskGuard',
    label: '磁盘守卫',
    service: 'shein-fm-disk-guard.service',
    timer: 'shein-fm-disk-guard.timer',
    kind: 'job',
    critical: true,
    route: 'system',
  }),
]);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeInstant(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.valueOf()) ? null : instant.toISOString();
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeText(value, maximum = 160) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

export function parseSystemctlShow(value) {
  const result = Object.create(null);
  for (const line of String(value || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const content = line.slice(separator + 1);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) continue;
    result[key] = content.slice(0, 240);
  }
  return result;
}

/**
 * systemctl renders Shanghai timestamps as `Sat 2026-08-01 02:46:08 CST`.
 * JavaScript interprets CST as North American Central time, so parse the fixed
 * production shape explicitly instead of accepting a six-hour time shift.
 */
export function systemdTimestampToIso(value) {
  const text = safeText(value, 100);
  if (!text || text === 'n/a') return null;
  const match = text.match(
    /^[A-Za-z]{3}\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(CST|UTC)$/,
  );
  if (!match) return safeInstant(text);
  const [, year, month, day, hour, minute, second, zone] = match;
  const offsetHours = zone === 'CST' ? 8 : 0;
  return new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - offsetHours,
    Number(minute),
    Number(second),
  )).toISOString();
}

function failedResult(service) {
  const result = String(service.Result || '').toLowerCase();
  const exitStatus = Number(service.ExecMainStatus);
  return (
    service.ActiveState === 'failed'
    || ['exit-code', 'signal', 'timeout', 'watchdog', 'resources'].includes(result)
    || (Number.isSafeInteger(exitStatus) && exitStatus > 0)
  );
}

export function projectUnit(definition, serviceInput, timerInput = null) {
  const service = record(serviceInput);
  const timer = record(timerInput);
  const serviceActive = safeText(service.ActiveState, 40) || 'unknown';
  const timerActive = definition.timer
    ? (safeText(timer.ActiveState, 40) || 'unknown')
    : null;
  const running = ['active', 'activating', 'reloading'].includes(serviceActive);
  const failed = failedResult(service);
  let state = 'unknown';

  if (failed) state = 'attention';
  else if (definition.kind === 'daemon') state = serviceActive === 'active' ? 'healthy' : 'attention';
  else if (running) state = 'running';
  else if (timerActive === 'active' && ['success', ''].includes(String(service.Result || ''))) {
    state = 'healthy';
  } else if (timerActive === 'active') {
    state = 'scheduled';
  } else if (service.LoadState === 'not-found' || timer.LoadState === 'not-found') {
    state = 'unknown';
  } else {
    state = definition.critical ? 'attention' : 'scheduled';
  }

  const exitStatus = Number(service.ExecMainStatus);
  return Object.freeze({
    key: definition.key,
    label: definition.label,
    kind: definition.kind,
    critical: definition.critical,
    route: definition.route,
    state,
    serviceUnit: definition.service,
    timerUnit: definition.timer || null,
    activeState: serviceActive,
    subState: safeText(service.SubState, 40) || 'unknown',
    result: safeText(service.Result, 40) || 'unknown',
    exitStatus: Number.isSafeInteger(exitStatus) && exitStatus >= 0 ? exitStatus : null,
    timerState: timerActive,
    lastRunAt: systemdTimestampToIso(
      timer.LastTriggerUSec
      || service.InactiveEnterTimestamp
      || service.ActiveEnterTimestamp
      || service.StateChangeTimestamp,
    ),
    nextRunAt: systemdTimestampToIso(timer.NextElapseUSecRealtime),
  });
}

export function sanitizeLoginState(input) {
  const source = record(input);
  const stores = record(source.stores);
  const rows = FULL_MANAGED_STORE_CODES.map((storeCode) => {
    const item = record(stores[storeCode]);
    const rawStatus = safeText(item.status, 40).toLowerCase();
    return Object.freeze({
      storeCode,
      status: LOGIN_STATES.has(rawStatus) ? rawStatus : 'unknown',
      verified: item.verified === true,
      completedAt: safeInstant(item.completedAt),
    });
  });
  return Object.freeze({
    updatedAt: safeInstant(source.updatedAt),
    rows: Object.freeze(rows),
  });
}

export function sanitizeRenewalReport(input) {
  const source = record(input);
  const seen = new Set();
  const rows = [];
  for (const rawItem of Array.isArray(source.results) ? source.results : []) {
    const item = record(rawItem);
    const storeCode = safeText(item.storeCode, 12).toUpperCase();
    if (
      !STORE_CODE_PATTERN.test(storeCode)
      || !FULL_MANAGED_STORE_CODES.includes(storeCode)
      || seen.has(storeCode)
    ) continue;
    seen.add(storeCode);
    const rawState = safeText(item.state, 24).toUpperCase();
    const rawCode = safeText(item.errorCode, 80).toUpperCase();
    rows.push(Object.freeze({
      storeCode,
      state: SESSION_STATES.has(rawState) ? rawState : 'UNKNOWN',
      renewed: item.renewed === true,
      errorCode: rawCode && SAFE_CODE_PATTERN.test(rawCode)
        ? rawCode
        : (item.renewed === true ? null : 'SESSION_RENEWAL_FAILED'),
    }));
  }
  rows.sort((left, right) => left.storeCode.localeCompare(right.storeCode));
  return Object.freeze({
    generatedAt: safeInstant(source.generatedAt),
    completedProfileCount: safeCount(source.completedProfileCount),
    activeCount: safeCount(source.activeCount),
    rows: Object.freeze(rows),
  });
}

export function sanitizeDiskStatus(input) {
  const source = record(input);
  const usedPercent = Number(source.usedPercent);
  const warningPercent = Number(source.warningPercent);
  const criticalPercent = Number(source.criticalPercent);
  const severity = ['ok', 'warning', 'critical'].includes(source.severity)
    ? source.severity
    : 'unknown';
  return Object.freeze({
    filesystem: safeText(source.filesystem, 40) || 'unknown',
    checkedAt: safeInstant(source.checkedAt),
    usedPercent: Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100
      ? Math.round(usedPercent * 10) / 10
      : null,
    warningPercent: Number.isFinite(warningPercent) ? warningPercent : null,
    criticalPercent: Number.isFinite(criticalPercent) ? criticalPercent : null,
    severity,
    observeOnly: source.observeOnly === true,
  });
}

export function buildSystemHealthSnapshot({
  generatedAt,
  units,
  loginState,
  renewalReport,
  disks,
  currentRelease,
  previousRelease,
}) {
  return Object.freeze({
    schemaVersion: 1,
    generatedAt: safeInstant(generatedAt) || new Date().toISOString(),
    readOnly: true,
    releases: Object.freeze({
      current: /^[a-f0-9]{40}$/.test(currentRelease) ? currentRelease : null,
      previous: /^[a-f0-9]{40}$/.test(previousRelease) ? previousRelease : null,
    }),
    units: Object.freeze(Array.isArray(units) ? units : []),
    profiles: Object.freeze({
      login: sanitizeLoginState(loginState),
      renewal: sanitizeRenewalReport(renewalReport),
    }),
    disks: Object.freeze((Array.isArray(disks) ? disks : []).map(sanitizeDiskStatus)),
  });
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function releaseName(link) {
  try {
    const target = await readlink(link);
    const name = path.posix.basename(target);
    return /^[a-f0-9]{40}$/.test(name) ? name : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function systemctlShow(unit) {
  try {
    const { stdout } = await execFile('/usr/bin/systemctl', [
      'show',
      unit,
      '--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,ActiveEnterTimestamp,InactiveEnterTimestamp,StateChangeTimestamp,LastTriggerUSec,NextElapseUSecRealtime',
      '--no-pager',
    ], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
    });
    return parseSystemctlShow(stdout);
  } catch {
    return Object.freeze({
      LoadState: 'unknown',
      ActiveState: 'unknown',
      SubState: 'unknown',
      Result: 'query-failed',
      ExecMainStatus: '',
    });
  }
}

export async function collectSystemHealthSnapshot({ now = new Date() } = {}) {
  const unitRows = await Promise.all(SYSTEM_UNIT_DEFINITIONS.map(async (definition) => {
    const [service, timer] = await Promise.all([
      systemctlShow(definition.service),
      definition.timer ? systemctlShow(definition.timer) : Promise.resolve(null),
    ]);
    return projectUnit(definition, service, timer);
  }));
  const [
    loginState,
    renewalReport,
    rootDisk,
    dataDisk,
    currentRelease,
    previousRelease,
  ] = await Promise.all([
    readJsonOrNull(LOGIN_STATE_FILE),
    readJsonOrNull(RENEWAL_REPORT_FILE),
    readJsonOrNull(ROOT_DISK_FILE),
    readJsonOrNull(DATA_DISK_FILE),
    releaseName(CURRENT_RELEASE),
    releaseName(PREVIOUS_RELEASE),
  ]);
  return buildSystemHealthSnapshot({
    generatedAt: now.toISOString(),
    units: unitRows,
    loginState,
    renewalReport,
    disks: [rootDisk, dataDisk].filter(Boolean),
    currentRelease,
    previousRelease,
  });
}

function outputPath(raw) {
  const value = path.posix.resolve(raw || DEFAULT_OUTPUT_FILE);
  const root = '/srv/shein-fm/runtime/dashboard';
  if (value !== root && !value.startsWith(`${root}/`)) {
    throw new Error('SYSTEM_HEALTH_OUTPUT_OUTSIDE_DASHBOARD');
  }
  return value;
}

export async function main() {
  if (process.argv.slice(2).length > 0) {
    throw new Error('UNSUPPORTED_ARGUMENT');
  }
  if (process.platform !== 'linux') {
    throw new Error('SYSTEM_HEALTH_LINUX_REQUIRED');
  }
  const file = outputPath(process.env.FULL_BI_SYSTEM_HEALTH_FILE);
  const temporary = `${file}.${process.pid}.next`;
  const snapshot = await collectSystemHealthSnapshot();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o644,
      flag: 'wx',
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  const attention = snapshot.units.filter((unit) => unit.state === 'attention').length;
  const activeProfiles = snapshot.profiles.renewal.rows.filter(
    (row) => row.state === 'ACTIVE',
  ).length;
  console.log(JSON.stringify({
    ok: true,
    generatedAt: snapshot.generatedAt,
    unitCount: snapshot.units.length,
    attentionUnitCount: attention,
    loginProfileCount: snapshot.profiles.login.rows.length,
    renewedActiveCount: activeProfiles,
    diskCount: snapshot.disks.length,
  }));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      errorCode: SAFE_CODE_PATTERN.test(String(error?.message || ''))
        ? String(error.message)
        : 'SYSTEM_HEALTH_MATERIALIZE_FAILED',
    }));
    process.exitCode = 1;
  });
}
