#!/usr/bin/env node

/**
 * Backfill runner CLI. Dry-run by default.
 *
 * Execute requires all of `--execute`, `--approved-plan-hash`,
 * `--allow-stores` and `--allow-domains`. A dry-run never opens a database
 * connection, never registers an adapter and therefore cannot perform any
 * external request.
 */

import {
  buildBackfillPlan,
  assertExecuteAuthorization,
  BackfillPlanError,
  BACKFILL_MODES,
} from '../src/backfill/plan.mjs';
import { runBackfillPlan, BackfillRunError } from '../src/backfill/runner.mjs';
import {
  BackfillCliError,
  RUN_FLAGS,
  booleanFlag,
  listFlag,
  parseCliArguments,
  planRequestFromFlags,
  printSafeJson,
  requireFlag,
  sanitizedFailure,
} from '../src/backfill/cli-support.mjs';

export function parseRunRequest(argv = []) {
  const flags = parseCliArguments(argv, { allowedFlags: RUN_FLAGS });
  const execute = booleanFlag(flags, 'execute');
  const plan = buildBackfillPlan(planRequestFromFlags(flags));
  if (!execute) {
    for (const name of ['approved-plan-hash', 'allow-stores', 'allow-domains']) {
      if (flags[name] !== undefined) {
        throw new BackfillCliError(
          'CLI_EXECUTE_FLAG_WITHOUT_EXECUTE',
          `--${name} requires --execute`,
        );
      }
    }
    return { plan, mode: BACKFILL_MODES.DRY_RUN };
  }
  // Scope must be restated explicitly; nothing is inferred from the plan or from
  // the environment. Authorization is checked here so a wrong hash or a scope
  // mismatch fails before the deliberate not-wired blocker.
  const approvedPlanHash = requireFlag(flags, 'approved-plan-hash');
  const allowedStoreCodes = listFlag(flags, 'allow-stores');
  const allowedDomains = listFlag(flags, 'allow-domains');
  const authorization = assertExecuteAuthorization({
    plan,
    approvedPlanHash,
    allowedStoreCodes,
    allowedDomains,
  });
  return {
    plan,
    mode: BACKFILL_MODES.EXECUTE,
    approvedPlanHash,
    allowedStoreCodes,
    allowedDomains,
    authorization,
  };
}

export function toSafeRunReport(result) {
  return {
    ok: result.runStatus !== 'FAILED',
    mode: result.mode,
    planHash: result.planHash,
    runStatus: result.runStatus,
    adapterInvocationCount: result.adapterInvocationCount,
    counts: { ...result.counts },
    checkpointAdvancedCount: result.checkpointAdvancedCount,
    blockedReasonCodes: [...result.blockedReasonCodes],
    windows: result.windows.map((window) => ({
      storeCode: window.storeCode,
      domain: window.domain,
      adapterKey: window.adapterKey,
      capabilityStatus: window.capabilityStatus,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      windowKey: window.windowKey,
      executionStatus: window.executionStatus,
      qualityStatus: window.qualityStatus,
      sanitizedErrorCode: window.sanitizedErrorCode,
      attemptCount: window.attemptCount,
      checkpointAdvanced: window.checkpointAdvanced,
    })),
    note: result.mode === BACKFILL_MODES.DRY_RUN
      ? 'Dry-run only. No adapter, connection or external request was created.'
      : 'Execute run. Only verified, incomplete windows were attempted.',
  };
}

async function main(argv) {
  try {
    const request = parseRunRequest(argv);
    if (request.mode === BACKFILL_MODES.DRY_RUN) {
      const result = await runBackfillPlan({ plan: request.plan, mode: request.mode });
      printSafeJson(toSafeRunReport(result));
      return 0;
    }
    // A real execute run needs an injected repository and verified adapters. This
    // batch deliberately ships none, so the CLI fails closed instead of
    // pretending an empty success.
    printSafeJson(
      { ok: false, errorCode: 'BACKFILL_EXECUTE_ADAPTERS_NOT_WIRED' },
      (line) => process.stderr.write(line),
    );
    return 3;
  } catch (error) {
    if (
      error instanceof BackfillPlanError
      || error instanceof BackfillCliError
      || error instanceof BackfillRunError
    ) {
      printSafeJson(sanitizedFailure(error), (line) => process.stderr.write(line));
      return 2;
    }
    printSafeJson(sanitizedFailure(error), (line) => process.stderr.write(line));
    return 1;
  }
}

if (process.argv[1]?.endsWith('run_full_managed_backfill.mjs')) {
  process.exitCode = await main(process.argv.slice(2));
}
