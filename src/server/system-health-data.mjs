import { readFile } from 'node:fs/promises';

const STORE_CODE_PATTERN = /^[A-Z0-9]{2,12}$/;
const SAFE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const SAFE_CODE_PATTERN = /^[A-Z0-9_:-]{1,80}$/;
const RELEASE_PATTERN = /^[a-f0-9]{40}$/;
const UNIT_STATES = new Set(['healthy', 'running', 'scheduled', 'attention', 'unknown']);
const LOGIN_STATES = new Set(['completed', 'pending', 'needs_attention', 'unknown']);
const SESSION_STATES = new Set(['ACTIVE', 'EXPIRED', 'BLOCKED', 'UNKNOWN']);
const DISK_STATES = new Set(['ok', 'warning', 'critical', 'unknown']);

export class SystemHealthDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SystemHealthDataError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SystemHealthDataError(code, message);
}

function record(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('SYSTEM_HEALTH_INVALID', `${field} 结构无效`);
  }
  return value;
}

function array(value, field, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail('SYSTEM_HEALTH_INVALID', `${field} 结构无效`);
  }
  return value;
}

function text(value, field, maximum, { nullable = false, pattern = null } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    fail('SYSTEM_HEALTH_INVALID', `${field} 无效`);
  }
  if (pattern && !pattern.test(value)) fail('SYSTEM_HEALTH_INVALID', `${field} 无效`);
  return value;
}

function nullableText(value, field, maximum, pattern = null) {
  return text(value, field, maximum, { nullable: true, pattern });
}

function instant(value, field, nullable = false) {
  if (nullable && value === null) return null;
  const raw = text(value, field, 80);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.valueOf())) fail('SYSTEM_HEALTH_INVALID', `${field} 时间无效`);
  return parsed.toISOString();
}

function count(value, field, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('SYSTEM_HEALTH_INVALID', `${field} 数量无效`);
  }
  return value;
}

function normalizeUnit(input, index) {
  const row = record(input, `units[${index}]`);
  const state = text(row.state, `units[${index}].state`, 24);
  if (!UNIT_STATES.has(state)) fail('SYSTEM_HEALTH_INVALID', 'unit state 无效');
  const kind = text(row.kind, `units[${index}].kind`, 16);
  if (!['daemon', 'job'].includes(kind)) fail('SYSTEM_HEALTH_INVALID', 'unit kind 无效');
  const exitStatus = row.exitStatus === null
    ? null
    : count(row.exitStatus, `units[${index}].exitStatus`);
  return Object.freeze({
    key: text(row.key, `units[${index}].key`, 64, { pattern: SAFE_KEY_PATTERN }),
    label: text(row.label, `units[${index}].label`, 80),
    kind,
    critical: row.critical === true,
    route: text(row.route, `units[${index}].route`, 32, { pattern: SAFE_KEY_PATTERN }),
    state,
    serviceUnit: text(row.serviceUnit, `units[${index}].serviceUnit`, 120),
    timerUnit: nullableText(row.timerUnit, `units[${index}].timerUnit`, 120),
    activeState: text(row.activeState, `units[${index}].activeState`, 40),
    subState: text(row.subState, `units[${index}].subState`, 40),
    result: text(row.result, `units[${index}].result`, 40),
    exitStatus,
    timerState: nullableText(row.timerState, `units[${index}].timerState`, 40),
    lastRunAt: row.lastRunAt === null
      ? null
      : instant(row.lastRunAt, `units[${index}].lastRunAt`),
    nextRunAt: row.nextRunAt === null
      ? null
      : instant(row.nextRunAt, `units[${index}].nextRunAt`),
  });
}

function normalizeLogin(input) {
  const source = record(input, 'profiles.login');
  const seen = new Set();
  const rows = array(source.rows, 'profiles.login.rows', 64).map((inputRow, index) => {
    const row = record(inputRow, `profiles.login.rows[${index}]`);
    const storeCode = text(
      row.storeCode,
      `profiles.login.rows[${index}].storeCode`,
      12,
      { pattern: STORE_CODE_PATTERN },
    );
    if (seen.has(storeCode)) fail('SYSTEM_HEALTH_INVALID', '登录状态店铺重复');
    seen.add(storeCode);
    const status = text(row.status, `profiles.login.rows[${index}].status`, 40);
    if (!LOGIN_STATES.has(status)) fail('SYSTEM_HEALTH_INVALID', '登录状态无效');
    return Object.freeze({
      storeCode,
      status,
      verified: row.verified === true,
      completedAt: row.completedAt === null
        ? null
        : instant(row.completedAt, `profiles.login.rows[${index}].completedAt`),
    });
  });
  return Object.freeze({
    updatedAt: source.updatedAt === null ? null : instant(source.updatedAt, 'profiles.login.updatedAt'),
    rows: Object.freeze(rows),
  });
}

function normalizeRenewal(input) {
  const source = record(input, 'profiles.renewal');
  const seen = new Set();
  const rows = array(source.rows, 'profiles.renewal.rows', 64).map((inputRow, index) => {
    const row = record(inputRow, `profiles.renewal.rows[${index}]`);
    const storeCode = text(
      row.storeCode,
      `profiles.renewal.rows[${index}].storeCode`,
      12,
      { pattern: STORE_CODE_PATTERN },
    );
    if (seen.has(storeCode)) fail('SYSTEM_HEALTH_INVALID', '续期状态店铺重复');
    seen.add(storeCode);
    const state = text(row.state, `profiles.renewal.rows[${index}].state`, 24);
    if (!SESSION_STATES.has(state)) fail('SYSTEM_HEALTH_INVALID', '续期状态无效');
    return Object.freeze({
      storeCode,
      state,
      renewed: row.renewed === true,
      errorCode: nullableText(
        row.errorCode,
        `profiles.renewal.rows[${index}].errorCode`,
        80,
        SAFE_CODE_PATTERN,
      ),
    });
  });
  return Object.freeze({
    generatedAt: source.generatedAt === null
      ? null
      : instant(source.generatedAt, 'profiles.renewal.generatedAt'),
    completedProfileCount: count(
      source.completedProfileCount,
      'profiles.renewal.completedProfileCount',
      true,
    ),
    activeCount: count(source.activeCount, 'profiles.renewal.activeCount', true),
    rows: Object.freeze(rows),
  });
}

function normalizeDisk(input, index) {
  const row = record(input, `disks[${index}]`);
  const severity = text(row.severity, `disks[${index}].severity`, 16);
  if (!DISK_STATES.has(severity)) fail('SYSTEM_HEALTH_INVALID', '磁盘状态无效');
  const usedPercent = row.usedPercent;
  if (
    usedPercent !== null
    && (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)
  ) fail('SYSTEM_HEALTH_INVALID', '磁盘使用率无效');
  return Object.freeze({
    filesystem: text(row.filesystem, `disks[${index}].filesystem`, 40),
    checkedAt: row.checkedAt === null
      ? null
      : instant(row.checkedAt, `disks[${index}].checkedAt`),
    usedPercent,
    warningPercent: row.warningPercent === null
      ? null
      : count(row.warningPercent, `disks[${index}].warningPercent`),
    criticalPercent: row.criticalPercent === null
      ? null
      : count(row.criticalPercent, `disks[${index}].criticalPercent`),
    severity,
    observeOnly: row.observeOnly === true,
  });
}

export function normalizeSystemHealthData(input) {
  const source = record(input, 'systemHealth');
  if (source.schemaVersion !== 1 || source.readOnly !== true) {
    fail('SYSTEM_HEALTH_INVALID', '运行态版本或只读标记无效');
  }
  const releases = record(source.releases, 'releases');
  const profiles = record(source.profiles, 'profiles');
  return Object.freeze({
    schemaVersion: 1,
    generatedAt: instant(source.generatedAt, 'generatedAt'),
    readOnly: true,
    releases: Object.freeze({
      current: nullableText(releases.current, 'releases.current', 40, RELEASE_PATTERN),
      previous: nullableText(releases.previous, 'releases.previous', 40, RELEASE_PATTERN),
    }),
    units: Object.freeze(array(source.units, 'units', 32).map(normalizeUnit)),
    profiles: Object.freeze({
      login: normalizeLogin(profiles.login),
      renewal: normalizeRenewal(profiles.renewal),
    }),
    disks: Object.freeze(array(source.disks, 'disks', 4).map(normalizeDisk)),
  });
}

export async function loadSystemHealthData(file) {
  if (!file) return null;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('SYSTEM_HEALTH_UNAVAILABLE', '运行态快照不可读取');
  }
  return normalizeSystemHealthData(parsed);
}
