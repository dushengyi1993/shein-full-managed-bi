#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

const DEFAULT_MATCHER_VERSION = 'observed-matcher-v1';
const DEFAULT_POLICY_VERSION = 'strict-global-clique-v1';
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DRY_RUN_COUNT_FIELDS = Object.freeze([
  'inputNodeCount',
  'excludedMissingEvidenceSkuCount',
  'acceptedComponentCount',
  'acceptedNodeCount',
  'acceptedSkuSetCount',
  'rejectedRecallGroupCount',
  'rejectedNodeCount',
]);
const APPLY_COUNT_FIELDS = Object.freeze([
  'canonicalProductCount',
  'provenanceCount',
  'candidateCount',
  'candidateEvidenceCount',
  'decisionCount',
  'assignmentCount',
  'createdCanonicalProductCount',
  'createdProvenanceCount',
  'createdCandidateCount',
  'createdCandidateEvidenceCount',
  'createdDecisionCount',
  'createdAssignmentCount',
]);
const SAFE_ERROR_CODES = new Set([
  'INVALID_ARGUMENTS',
  'OBSERVATION_RUN_ID_REQUIRED',
  'INVALID_NOW',
  'INVALID_RUN_ID',
  'INVALID_VERSION',
  'APPROVED_HASH_REQUIRED',
  'APPROVED_HASH_NOT_ALLOWED',
  'FULL_BI_DATABASE_URL_REQUIRED',
  'REPOSITORY_RESULT_INVALID',
  'RESOLUTION_REPOSITORY_INVALID',
  'INVALID_INPUT',
  'EVIDENCE_COVERAGE_MISMATCH',
  'EVIDENCE_SET_INVALID',
  'EVIDENCE_MEMBER_COUNT_MISMATCH',
  'EVIDENCE_HIERARCHY_MISMATCH',
  'PLAN_HASH_MISMATCH',
  'SKU_LOCK_MISMATCH',
  'IDEMPOTENCY_DRIFT',
  'EXISTING_MAPPING_CONFLICT',
]);

export class ProductIdentityResolutionCliError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ProductIdentityResolutionCliError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ProductIdentityResolutionCliError(code, message, options);
}

function requiredFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || value.startsWith('--')
  ) {
    fail('INVALID_ARGUMENTS', `${flag} requires a value`);
  }
  return value.trim();
}

function normalizeIsoInstant(value) {
  if (
    typeof value !== 'string'
    || !ISO_INSTANT_PATTERN.test(value)
  ) {
    fail(
      'INVALID_NOW',
      'now must be an ISO-8601 date-time with an explicit offset',
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    fail(
      'INVALID_NOW',
      'now must be an ISO-8601 date-time with an explicit offset',
    );
  }
  return parsed.toISOString();
}

function normalizeClockInstant(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString();
  }
  return normalizeIsoInstant(String(value ?? ''));
}

function defaultRunId(now) {
  return `identity-resolution-${now.replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

function safeIdentifier(value, label, code) {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    fail(code, `${label} must contain 8-120 safe identifier characters`);
  }
  return value;
}

function safeVersion(value, label) {
  if (typeof value !== 'string' || !SAFE_VERSION_PATTERN.test(value)) {
    fail(
      'INVALID_VERSION',
      `${label} must contain 1-128 safe version characters`,
    );
  }
  return value;
}

export function parseProductIdentityResolutionArgs(
  argv,
  { clock = () => new Date() } = {},
) {
  if (!Array.isArray(argv)) {
    fail('INVALID_ARGUMENTS', 'argv must be an array');
  }
  const valueFlags = new Set([
    '--observation-run-id',
    '--matcher-version',
    '--policy-version',
    '--now',
    '--run-id',
    '--approved-hash',
  ]);
  const parsed = { apply: false };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') {
      if (seen.has(flag)) {
        fail('INVALID_ARGUMENTS', '--apply was supplied more than once');
      }
      seen.add(flag);
      parsed.apply = true;
      continue;
    }
    if (!valueFlags.has(flag)) {
      fail('INVALID_ARGUMENTS', `Unknown argument: ${String(flag)}`);
    }
    if (seen.has(flag)) {
      fail('INVALID_ARGUMENTS', `${flag} was supplied more than once`);
    }
    seen.add(flag);
    parsed[flag.slice(2)] = requiredFlagValue(argv, index, flag);
    index += 1;
  }

  const observationRunId = safeIdentifier(
    parsed['observation-run-id'],
    'observation-run-id',
    'OBSERVATION_RUN_ID_REQUIRED',
  );
  const now = parsed.now === undefined
    ? normalizeClockInstant(clock())
    : normalizeIsoInstant(parsed.now);
  const runId = safeIdentifier(
    parsed['run-id'] ?? defaultRunId(now),
    'run-id',
    'INVALID_RUN_ID',
  );
  const matcherVersion = safeVersion(
    parsed['matcher-version'] ?? DEFAULT_MATCHER_VERSION,
    'matcher-version',
  );
  const policyVersion = safeVersion(
    parsed['policy-version'] ?? DEFAULT_POLICY_VERSION,
    'policy-version',
  );
  const approvedHash = parsed['approved-hash'];
  if (parsed.apply && !SHA256_PATTERN.test(approvedHash ?? '')) {
    fail(
      'APPROVED_HASH_REQUIRED',
      '--apply requires an exact lowercase 64-character --approved-hash',
    );
  }
  if (!parsed.apply && approvedHash !== undefined) {
    fail(
      'APPROVED_HASH_NOT_ALLOWED',
      '--approved-hash is only valid with --apply',
    );
  }

  return Object.freeze({
    apply: parsed.apply,
    observationRunId,
    matcherVersion,
    policyVersion,
    now,
    runId,
    approvedHash: approvedHash ?? null,
  });
}

function databaseUrlFromEnvironment(environment) {
  const databaseUrl = typeof environment?.FULL_BI_DATABASE_URL === 'string'
    ? environment.FULL_BI_DATABASE_URL.trim()
    : '';
  if (!databaseUrl) {
    fail(
      'FULL_BI_DATABASE_URL_REQUIRED',
      'FULL_BI_DATABASE_URL is required',
    );
  }
  return databaseUrl;
}

function safeCount(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail('REPOSITORY_RESULT_INVALID', `${label} is not a safe count`);
  }
  return number;
}

function safePlanHash(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(
      'REPOSITORY_RESULT_INVALID',
      'repository plan hash is not a SHA-256 fingerprint',
    );
  }
  return value;
}

function safeResolutionSummary(result, args) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail('REPOSITORY_RESULT_INVALID', 'repository result must be an object');
  }
  if (result.observationRunId !== args.observationRunId) {
    fail(
      'REPOSITORY_RESULT_INVALID',
      'repository returned a different observation run',
    );
  }
  if (
    result.auditRunId !== args.runId
    || result.preparedAt !== args.now
  ) {
    fail(
      'REPOSITORY_RESULT_INVALID',
      'repository returned different resolution audit fields',
    );
  }
  if (args.apply && result.applied !== true) {
    fail(
      'REPOSITORY_RESULT_INVALID',
      'repository did not confirm the apply transaction',
    );
  }
  const planHash = safePlanHash(result.planHash);
  if (args.apply && planHash !== args.approvedHash) {
    fail(
      'REPOSITORY_RESULT_INVALID',
      'repository returned a different applied plan hash',
    );
  }
  const repositorySummary = result.summary;
  if (
    !repositorySummary
    || typeof repositorySummary !== 'object'
    || Array.isArray(repositorySummary)
  ) {
    fail('REPOSITORY_RESULT_INVALID', 'repository summary must be an object');
  }

  const countFields = args.apply
    ? [...DRY_RUN_COUNT_FIELDS, ...APPLY_COUNT_FIELDS]
    : DRY_RUN_COUNT_FIELDS;
  const counts = Object.fromEntries(
    countFields.map((field) => [
      field,
      safeCount(repositorySummary[field], field),
    ]),
  );
  return Object.freeze({
    ok: true,
    mode: args.apply ? 'applied' : 'dry-run',
    observationRunId: args.observationRunId,
    runId: args.runId,
    evaluatedAt: args.now,
    matcherVersion: args.matcherVersion,
    policyVersion: args.policyVersion,
    planHash,
    ...counts,
  });
}

async function loadDefaultRepository() {
  return import('../src/warehouse/product-identity-resolution-repository.mjs');
}

function validateRepository(repository) {
  if (
    !repository
    || typeof repository.prepareProductIdentityResolutionPlan !== 'function'
    || typeof repository.applyProductIdentityResolutionPlan !== 'function'
  ) {
    fail(
      'RESOLUTION_REPOSITORY_INVALID',
      'product identity resolution repository is unavailable',
    );
  }
  return repository;
}

export async function runProductIdentityResolution({
  pool,
  args,
  repository,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('pool.connect is required');
  }
  const operations = validateRepository(repository);
  const input = {
    observationRunId: args.observationRunId,
    matcherVersion: args.matcherVersion,
    policyVersion: args.policyVersion,
    now: args.now,
    runId: args.runId,
  };
  const result = args.apply
    ? await operations.applyProductIdentityResolutionPlan(pool, {
      ...input,
      approvedHash: args.approvedHash,
    })
    : await operations.prepareProductIdentityResolutionPlan(pool, input);
  return safeResolutionSummary(result, args);
}

function safeFailure(error) {
  const code = String(error?.code ?? '');
  return Object.freeze({
    ok: false,
    errorCode: SAFE_ERROR_CODES.has(code)
      ? code
      : 'PRODUCT_IDENTITY_RESOLUTION_FAILED',
  });
}

export async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  clock = () => new Date(),
  poolFactory = (databaseUrl) => new Pool({
    connectionString: databaseUrl,
    max: 1,
  }),
  repository = null,
  repositoryLoader = loadDefaultRepository,
} = {}) {
  let pool;
  try {
    const args = parseProductIdentityResolutionArgs(argv, { clock });
    const databaseUrl = databaseUrlFromEnvironment(environment);
    const operations = repository ?? await repositoryLoader();
    pool = await poolFactory(databaseUrl);
    const summary = await runProductIdentityResolution({
      pool,
      args,
      repository: operations,
    });
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify(safeFailure(error))}\n`);
    return 1;
  } finally {
    await pool?.end?.().catch(() => {});
  }
}

export function isMainModule(
  entryPath = process.argv[1],
  moduleUrl = import.meta.url,
) {
  if (!entryPath) return false;
  const resolvedEntryPath = path.resolve(entryPath);
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(resolvedEntryPath) === realpathSync(modulePath);
  } catch {
    return resolvedEntryPath === modulePath;
  }
}

if (isMainModule()) {
  process.exitCode = await main();
}
