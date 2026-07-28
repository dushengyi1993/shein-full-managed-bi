#!/usr/bin/env node

/**
 * Deterministic backfill planner. Read-only and side-effect free.
 *
 * It never opens a database connection, never touches an adapter and never
 * performs a network request. Its only output is a safe plan summary plus the
 * plan hash an operator can review and later approve for one execute run.
 */

import { buildBackfillPlan, BackfillPlanError } from '../src/backfill/plan.mjs';
import {
  BACKFILL_DOMAIN_CATALOG,
  BACKFILL_DOMAINS,
  CAPABILITY_STATUSES,
} from '../src/backfill/capability-catalog.mjs';
import {
  BackfillCliError,
  PLAN_FLAGS,
  parseCliArguments,
  planRequestFromFlags,
  printSafeJson,
  sanitizedFailure,
} from '../src/backfill/cli-support.mjs';

export function buildPlanReport(argv = []) {
  const flags = parseCliArguments(argv, { allowedFlags: PLAN_FLAGS });
  const plan = buildBackfillPlan(planRequestFromFlags(flags));

  const blockers = [...new Set(
    plan.domains
      .map((domain) => BACKFILL_DOMAIN_CATALOG[domain])
      .filter((entry) => entry.capabilityStatus !== CAPABILITY_STATUSES.VERIFIED)
      .map((entry) => ({
        domain: entry.domain,
        capabilityStatus: entry.capabilityStatus,
        blockedReasonCode: entry.blockedReasonCode,
      }))
      .map((entry) => JSON.stringify(entry)),
  )].map((item) => JSON.parse(item));

  return {
    ok: true,
    mode: 'DRY_RUN',
    planVersion: plan.planVersion,
    planHash: plan.planHash,
    storeCount: plan.storeCodes.length,
    domains: [...plan.domains],
    from: plan.from,
    to: plan.to,
    windowSpanDays: plan.windowSpanDays,
    concurrency: plan.concurrency,
    maxAttempts: plan.maxAttempts,
    summary: {
      plannedWindowCount: plan.summary.plannedWindowCount,
      executableWindowCount: plan.summary.executableWindowCount,
      blockedWindowCount: plan.summary.blockedWindowCount,
      byCapability: { ...plan.summary.byCapability },
      blockedReasonCodes: [...plan.summary.blockedReasonCodes],
    },
    // Unproven capabilities end as explicit blockers, never as empty success.
    blockers,
    knownDomains: [...BACKFILL_DOMAINS],
    note: 'Dry-run plan only. Nothing was fetched, written or promoted.',
  };
}

async function main(argv) {
  try {
    printSafeJson(buildPlanReport(argv));
    return 0;
  } catch (error) {
    if (error instanceof BackfillPlanError || error instanceof BackfillCliError) {
      printSafeJson(sanitizedFailure(error), (line) => process.stderr.write(line));
      return 2;
    }
    printSafeJson(sanitizedFailure(error), (line) => process.stderr.write(line));
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
  || process.argv[1]?.endsWith('plan_full_managed_backfill.mjs')) {
  process.exitCode = await main(process.argv.slice(2));
}
