import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import {
  BackfillCliError,
  assertSafeCliOutput,
  parseCliArguments,
  sanitizedFailure,
} from '../../src/backfill/cli-support.mjs';
import { buildPlanReport } from '../../scripts/plan_full_managed_backfill.mjs';
import { parseRunRequest, toSafeRunReport } from '../../scripts/run_full_managed_backfill.mjs';
import { runBackfillPlan } from '../../src/backfill/runner.mjs';
import { BACKFILL_MODES } from '../../src/backfill/plan.mjs';

const projectRoot = new URL('../../', import.meta.url);

const PLAN_ARGS = Object.freeze([
  '--stores=DL5477,MZ2406',
  '--domains=deliveries,financial-settlement',
  '--from=2026-07-01',
  '--to=2026-07-02',
  '--created-by=codex.batch2',
  '--today=2026-07-28',
]);

test('the planner CLI is deterministic and reports unproven work as blockers', () => {
  const first = buildPlanReport(PLAN_ARGS);
  const second = buildPlanReport([...PLAN_ARGS].reverse());
  assert.equal(first.planHash, second.planHash);
  assert.equal(first.mode, 'DRY_RUN');
  assert.ok(first.summary.blockedWindowCount > 0);
  assert.deepEqual(
    first.blockers.map((item) => item.blockedReasonCode),
    ['DELIVERY_HISTORY_CREATED_AT_ONLY', 'FINANCIAL_SETTLEMENT_UNVERIFIED'],
  );
  // The report exposes counts, states and hashes only, never a raw store secret.
  assert.equal(first.storeCount, 2);
  assert.doesNotThrow(() => assertSafeCliOutput(first));
});

test('the runner CLI defaults to dry-run and demands explicit execute scope', async () => {
  const dryRun = parseRunRequest(PLAN_ARGS);
  assert.equal(dryRun.mode, BACKFILL_MODES.DRY_RUN);
  assert.equal(dryRun.approvedPlanHash, undefined);

  // --execute alone is not enough: hash and both allow-lists are required.
  assert.throws(() => parseRunRequest([...PLAN_ARGS, '--execute']), BackfillCliError);
  assert.throws(
    () => parseRunRequest([...PLAN_ARGS, '--execute', `--approved-plan-hash=${dryRun.plan.planHash}`]),
    BackfillCliError,
  );
  const authorized = parseRunRequest([
    ...PLAN_ARGS,
    '--execute',
    `--approved-plan-hash=${dryRun.plan.planHash}`,
    '--allow-stores=DL5477,MZ2406',
    '--allow-domains=deliveries,financial-settlement',
  ]);
  assert.equal(authorized.mode, BACKFILL_MODES.EXECUTE);
  assert.deepEqual(authorized.allowedStoreCodes, ['DL5477', 'MZ2406']);

  const report = toSafeRunReport(await runBackfillPlan({
    plan: dryRun.plan,
    mode: BACKFILL_MODES.DRY_RUN,
  }));
  assert.equal(report.adapterInvocationCount, 0);
  assert.equal(report.checkpointAdvancedCount, 0);
  assert.doesNotThrow(() => assertSafeCliOutput(report));
});

test('CLI parsing rejects positional arguments and sanitizes failures', () => {
  assert.throws(() => parseCliArguments(['stores=DL5477']), BackfillCliError);
  assert.throws(() => parseCliArguments(['-s', 'DL5477']), BackfillCliError);
  assert.deepEqual({ ...parseCliArguments(['--execute']) }, { execute: 'true' });
  assert.deepEqual(sanitizedFailure({ code: 'plan hash mismatch!' }), {
    ok: false,
    errorCode: 'PLAN_HASH_MISMATCH_',
  });
  assert.deepEqual(sanitizedFailure(new Error('boom')), {
    ok: false,
    errorCode: 'UNEXPECTED_ERROR',
  });
});

test('CLI output refuses secret-shaped content', () => {
  for (const payload of [
    { cookie: 'a=b' },
    { note: 'Authorization: Bearer x' },
    { profile: '/srv/shein-fm/webapi/profiles/persistent-mz2406-profile' },
    { env: '/srv/shein-fm/secrets/db-migrate/runtime-role-passwords.env' },
    { profileKey: 'persistent-dl5477-profile' },
  ]) {
    assert.throws(() => assertSafeCliOutput(payload), BackfillCliError);
  }
  assert.doesNotThrow(() => assertSafeCliOutput({
    planHash: 'a'.repeat(64),
    counts: { succeeded: 1 },
    blockedReasonCodes: ['WEBAPI_EXPERIMENT_ONLY'],
  }));
});

test('backfill and experiment sources never construct a network client or spawn a process', async () => {
  const files = [
    'src/backfill/plan.mjs',
    'src/backfill/runner.mjs',
    'src/backfill/quality-gate.mjs',
    'src/backfill/cli-support.mjs',
    'src/backfill/capability-catalog.mjs',
    'src/webapi-experiment/adapter.mjs',
    'src/webapi-experiment/profile-guard.mjs',
    'scripts/plan_full_managed_backfill.mjs',
  ];
  for (const path of files) {
    const source = await readFile(new URL(path, projectRoot), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(/, path);
    assert.doesNotMatch(source, /node:child_process|spawn\(|execFile|puppeteer|playwright/, path);
    assert.doesNotMatch(source, /new Pool\(/, path);
    assert.doesNotMatch(source, /console\.log/, path);
  }
  const runner = await readFile(
    new URL('scripts/run_full_managed_backfill.mjs', projectRoot),
    'utf8',
  );
  assert.doesNotMatch(runner, /\bfetch\s*\(|node:child_process|spawn\(|execFile/, 'runner');
  assert.match(runner, /parseRunRequest\(argv\)[\s\S]*createRuntime\(/);
  assert.match(runner, /loadPg = \(\) => import\('pg'\)/);
  assert.doesNotMatch(runner, /process\.env\.DATABASE_URL/);
});

test('existing migrations stay immutable and 0012 is purely additive', async () => {
  const migrationDir = new URL('db/migrations/', projectRoot);
  const names = (await readdir(migrationDir)).sort();
  assert.ok(names.includes('0012_backfill_and_webapi_experiment.sql'));
  assert.equal(names.filter((name) => name.startsWith('0012_')).length, 1);

  const migration = await readFile(
    new URL('0012_backfill_and_webapi_experiment.sql', migrationDir),
    'utf8',
  );
  // Additive only: no DROP/ALTER/TRUNCATE against any pre-existing relation.
  assert.doesNotMatch(migration, /DROP TABLE|DROP SCHEMA|DROP COLUMN|TRUNCATE/i);
  assert.doesNotMatch(migration, /ALTER TABLE\s+(?!ops\.backfill|raw\.webapi|dim\.webapi)/i);
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  // Idempotent reruns.
  for (const relation of [
    'ops.backfill_run',
    'ops.backfill_window',
    'ops.backfill_checkpoint',
    'raw.webapi_fetch_batch',
    'raw.webapi_metric_observation',
    'dim.webapi_metric_definition',
    'ops.webapi_session_health',
  ]) {
    assert.match(
      migration,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${relation.replace('.', '\\.')}\\b`),
    );
  }
  assert.match(migration, /CREATE OR REPLACE FUNCTION ops\.reject_webapi_evidence_mutation/);
  for (const trigger of migration.matchAll(/CREATE TRIGGER (\w+)/g)) {
    assert.match(migration, new RegExp(`DROP TRIGGER IF EXISTS ${trigger[1]}`));
  }

  const verify = await readFile(
    new URL('db/verify/0012_backfill_and_webapi_experiment.sql', projectRoot),
    'utf8',
  );
  // The verification script must never commit.
  assert.match(verify, /^BEGIN;/);
  assert.match(verify, /ROLLBACK;\s*$/);
  assert.doesNotMatch(verify, /^COMMIT;/m);
  assert.match(verify, /must not exist before verified metric definitions/);
});
