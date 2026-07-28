/**
 * Shared CLI argument and output helpers for the backfill control plane.
 *
 * Every value must be supplied explicitly on the command line. There is no
 * environment fallback for store codes or domains, so an operator's shell cannot
 * silently broaden the execute scope.
 */

const FLAG_PATTERN = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/;

const SECRET_SHAPED_PATTERN = new RegExp(
  [
    'cookie',
    'set-cookie',
    'authorization',
    'bearer ',
    'token',
    'password',
    'passwd',
    'secret',
    'credential',
    'session-?id',
    'csrf',
    'x-api-key',
    '/srv/shein-fm/webapi/profiles',
    '/srv/shein-fm/secrets',
    'persistent-[a-z0-9]+-profile',
  ].join('|'),
  'i',
);

export class BackfillCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackfillCliError';
    this.code = code;
  }
}

/**
 * Parse an explicit flag list.
 *
 * A repeated flag is an error rather than last-value-wins, and when the caller
 * supplies `allowedFlags` an unknown flag is rejected too. Both rules exist so a
 * typo can never silently change the executed scope.
 */
export function parseCliArguments(argv = [], { allowedFlags = null } = {}) {
  const permitted = allowedFlags === null ? null : new Set(allowedFlags);
  const flags = Object.create(null);
  const seen = new Set();
  for (const token of argv) {
    const match = FLAG_PATTERN.exec(String(token ?? ''));
    if (!match) {
      throw new BackfillCliError(
        'CLI_ARGUMENT_INVALID',
        'only explicit --flag or --flag=value arguments are accepted',
      );
    }
    const [, name, value] = match;
    if (seen.has(name)) {
      throw new BackfillCliError(
        'CLI_FLAG_DUPLICATED',
        `--${name} was supplied more than once`,
      );
    }
    if (permitted !== null && !permitted.has(name)) {
      throw new BackfillCliError(
        'CLI_FLAG_UNKNOWN',
        `--${name} is not accepted by this entrypoint`,
      );
    }
    seen.add(name);
    flags[name] = value === undefined ? 'true' : value;
  }
  return flags;
}

export function requireFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BackfillCliError('CLI_FLAG_REQUIRED', `--${name} is required`);
  }
  return value.trim();
}

export function optionalFlag(flags, name, fallback = null) {
  const value = flags[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

export function listFlag(flags, name) {
  return requireFlag(flags, name)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

export function booleanFlag(flags, name) {
  const value = flags[name];
  if (value === undefined) return false;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new BackfillCliError(
    'CLI_FLAG_NOT_BOOLEAN',
    `--${name} accepts no value, or true/false`,
  );
}

/**
 * Shared flag vocabulary. The planner and the runner both build a plan, so they
 * accept the same planning flags; the runner adds the four execute-only flags.
 */
export const PLAN_FLAGS = Object.freeze([
  'stores',
  'domains',
  'from',
  'to',
  'window-span-days',
  'concurrency',
  'max-attempts',
  'created-by',
  'today',
]);

export const EXECUTE_FLAGS = Object.freeze([
  'execute',
  'approved-plan-hash',
  'allow-stores',
  'allow-domains',
]);

export const RUN_FLAGS = Object.freeze([...PLAN_FLAGS, ...EXECUTE_FLAGS]);

/**
 * Collect the planning arguments as exact strings.
 *
 * Bounded integers are forwarded verbatim so the planner's strict validator sees
 * the operator's literal text. `Number.parseInt` would silently accept `1x`.
 */
export function planRequestFromFlags(flags) {
  return {
    storeCodes: listFlag(flags, 'stores'),
    domains: listFlag(flags, 'domains'),
    from: requireFlag(flags, 'from'),
    to: requireFlag(flags, 'to'),
    windowSpanDays: optionalFlag(flags, 'window-span-days', '1'),
    concurrency: optionalFlag(flags, 'concurrency', '1'),
    maxAttempts: optionalFlag(flags, 'max-attempts', '3'),
    createdBy: requireFlag(flags, 'created-by'),
    today: optionalFlag(flags, 'today', undefined) ?? undefined,
  };
}

/**
 * Refuse to emit anything secret-shaped.
 *
 * The CLI only ever prints counts, states, hashes and sanitized codes, and this
 * guard fails the process rather than leaking an unexpected field.
 */
export function assertSafeCliOutput(payload) {
  const text = JSON.stringify(payload);
  if (SECRET_SHAPED_PATTERN.test(text)) {
    throw new BackfillCliError(
      'CLI_OUTPUT_REDACTION_VIOLATION',
      'refusing to print potentially sensitive output',
    );
  }
  return text;
}

export function printSafeJson(payload, write = (line) => process.stdout.write(line)) {
  write(`${assertSafeCliOutput(payload)}\n`);
}

export function sanitizedFailure(error) {
  const code = String(error?.code ?? 'UNEXPECTED_ERROR')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 60);
  return { ok: false, errorCode: code === '' ? 'UNEXPECTED_ERROR' : code };
}
