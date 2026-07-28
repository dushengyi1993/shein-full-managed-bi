#!/usr/bin/env node

/**
 * Deterministic WebAPI experiment planner. Read-only and side-effect free.
 *
 * It never opens a database connection, never starts a process, never creates a
 * browser session and never performs a network request. Its only output is a
 * safe plan summary plus the plan hash an operator reviews and later supplies
 * verbatim to authorize exactly one execute run.
 */

import {
  ExperimentPlanError,
  EXPERIMENT_STAGES,
  CATALOG_ENDPOINT_CODES,
  METRIC_DETAIL_ENDPOINT_CODES,
  buildWebApiExperimentPlan,
} from '../src/webapi-experiment/run-plan.mjs';
import {
  BackfillCliError,
  parseCliArguments,
  printSafeJson,
  requireFlag,
  optionalFlag,
  listFlag,
  sanitizedFailure,
} from '../src/backfill/cli-support.mjs';

export const WEBAPI_PLAN_FLAGS = Object.freeze([
  'stage',
  'stores',
  'endpoints',
  'meta-index-ids',
  'template-type',
  'created-by',
]);

export function experimentPlanRequestFromFlags(flags) {
  const stage = requireFlag(flags, 'stage').toUpperCase();
  const metaIndexIds = optionalFlag(flags, 'meta-index-ids', null);
  return {
    stage,
    storeCodes: listFlag(flags, 'stores'),
    endpointCodes: listFlag(flags, 'endpoints'),
    // Forwarded as literal text so the planner's strict validator sees exactly
    // what the operator typed.
    metaIndexIds: metaIndexIds === null
      ? []
      : metaIndexIds.split(',').map((item) => item.trim()).filter((item) => item !== ''),
    templateType: optionalFlag(flags, 'template-type', null),
    createdBy: requireFlag(flags, 'created-by'),
  };
}

export function buildExperimentPlanReport(argv = []) {
  const flags = parseCliArguments(argv, { allowedFlags: WEBAPI_PLAN_FLAGS });
  const plan = buildWebApiExperimentPlan(experimentPlanRequestFromFlags(flags));
  return {
    ok: true,
    mode: 'DRY_RUN',
    planVersion: plan.planVersion,
    planHash: plan.planHash,
    stage: plan.stage,
    storeCount: plan.summary.storeCount,
    endpointCodes: [...plan.endpointCodes],
    metaIndexIdCount: plan.summary.metaIndexIdCount,
    templateType: plan.templateType,
    probeCount: plan.summary.probeCount,
    carriesMetricValues: plan.summary.carriesMetricValues,
    stageContract: {
      catalogEndpointCodes: [...CATALOG_ENDPOINT_CODES],
      metricDetailEndpointCodes: [...METRIC_DETAIL_ENDPOINT_CODES],
    },
    note: plan.stage === EXPERIMENT_STAGES.CATALOG
      ? 'Catalog discovery plan. It proves reachability, schema hashes and technical metric ids only.'
      : 'Metric detail plan. Observations stay UNMAPPED; no label, caliber or formal fact is produced.',
  };
}

async function main(argv) {
  try {
    printSafeJson(buildExperimentPlanReport(argv));
    return 0;
  } catch (error) {
    printSafeJson(sanitizedFailure(error), (line) => process.stderr.write(line));
    return error instanceof ExperimentPlanError || error instanceof BackfillCliError ? 2 : 1;
  }
}

if (process.argv[1]?.endsWith('plan_full_managed_webapi_experiment.mjs')) {
  process.exitCode = await main(process.argv.slice(2));
}
