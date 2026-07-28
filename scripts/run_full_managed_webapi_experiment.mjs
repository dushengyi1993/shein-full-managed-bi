#!/usr/bin/env node

/**
 * WebAPI experiment runner. Dry-run by default.
 *
 * A dry-run creates no session, no transport, no repository and no database
 * connection: it only reprints the reviewed plan. Execute requires `--execute`,
 * the exact approved plan hash, and explicit `--allow-stores` / `--allow-endpoints`
 * whose sets equal the plan scope exactly. There is no environment fallback for
 * business scope; the database URL is read only after authorization succeeds and
 * is never printed.
 *
 * In execute mode the stores are processed strictly sequentially: one session is
 * opened, probed, persisted and closed before the next store begins.
 */

import {
  ExperimentPlanError,
  EXPERIMENT_MODES,
  EXPERIMENT_STAGES,
  assertExperimentExecuteAuthorization,
  buildWebApiExperimentPlan,
} from '../src/webapi-experiment/run-plan.mjs';
import {
  BackfillCliError,
  booleanFlag,
  listFlag,
  parseCliArguments,
  printSafeJson,
  requireFlag,
  sanitizedFailure,
} from '../src/backfill/cli-support.mjs';
import {
  WEBAPI_PLAN_FLAGS,
  experimentPlanRequestFromFlags,
} from './plan_full_managed_webapi_experiment.mjs';
import { resolveProfileKey } from '../src/webapi-experiment/profile-guard.mjs';
import { TRANSPORT_REJECT_CODES } from '../src/webapi-experiment/page-transport.mjs';

export const WEBAPI_EXECUTE_FLAGS = Object.freeze([
  'execute',
  'approved-plan-hash',
  'allow-stores',
  'allow-endpoints',
]);

export const WEBAPI_RUN_FLAGS = Object.freeze([...WEBAPI_PLAN_FLAGS, ...WEBAPI_EXECUTE_FLAGS]);

export const DATABASE_URL_VARIABLE = 'FULL_BI_WEBAPI_DATABASE_URL';

export function parseExperimentRunRequest(argv = []) {
  const flags = parseCliArguments(argv, { allowedFlags: WEBAPI_RUN_FLAGS });
  const execute = booleanFlag(flags, 'execute');
  const plan = buildWebApiExperimentPlan(experimentPlanRequestFromFlags(flags));
  if (!execute) {
    for (const name of WEBAPI_EXECUTE_FLAGS.filter((item) => item !== 'execute')) {
      if (flags[name] !== undefined) {
        throw new BackfillCliError(
          'CLI_EXECUTE_FLAG_WITHOUT_EXECUTE',
          `--${name} requires --execute`,
        );
      }
    }
    return { plan, mode: EXPERIMENT_MODES.DRY_RUN };
  }
  const authorization = assertExperimentExecuteAuthorization({
    plan,
    approvedPlanHash: requireFlag(flags, 'approved-plan-hash'),
    allowedStoreCodes: listFlag(flags, 'allow-stores'),
    allowedEndpointCodes: listFlag(flags, 'allow-endpoints'),
  });
  return { plan, mode: EXPERIMENT_MODES.EXECUTE, authorization };
}

export function toSafeDryRunReport(plan) {
  return {
    ok: true,
    mode: EXPERIMENT_MODES.DRY_RUN,
    planHash: plan.planHash,
    stage: plan.stage,
    storeCount: plan.summary.storeCount,
    endpointCodes: [...plan.endpointCodes],
    probeCount: plan.summary.probeCount,
    metaIndexIdCount: plan.summary.metaIndexIdCount,
    sessionsOpened: 0,
    transportsCreated: 0,
    repositoriesCreated: 0,
    databaseConnections: 0,
    note: 'Dry-run only. No browser session, transport, repository or database connection was created.',
  };
}

function safeProbeProjection(entry) {
  return {
    storeCode: entry.storeCode,
    endpointCode: entry.endpointCode,
    resultStatus: entry.resultStatus,
    httpStatus: entry.httpStatus ?? null,
    requestSchemaHash: entry.requestSchemaHash ?? null,
    responseSchemaHash: entry.responseSchemaHash ?? null,
    payloadFingerprint: entry.payloadFingerprint ?? null,
    observationCount: entry.observationCount ?? 0,
    rejectedCount: entry.rejectedCount ?? 0,
    // Opaque platform ids only; a catalog stage needs them to plan stage B.
    discoveredMetaIndexIds: entry.discoveredMetaIndexIds ?? [],
    // Bounded field paths and JavaScript types only; never response values.
    responseSchemaPaths: entry.responseSchemaPaths ?? [],
    sanitizedErrorCode: entry.sanitizedErrorCode ?? null,
    persisted: entry.persisted === true,
  };
}

function probeLatencyMs(batch) {
  const started = Date.parse(String(batch?.requestedAt ?? ''));
  const completed = Date.parse(String(batch?.completedAt ?? ''));
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return null;
  return Math.max(0, Math.min(600_000, completed - started));
}

/**
 * Execute one authorized plan.
 *
 * Every external capability is injected so this function is testable without a
 * process, a socket or a database.
 */
export async function runExperimentPlan({
  plan,
  authorization,
  deps,
} = {}) {
  const {
    openSession,
    createTransport,
    createAdapter,
    repository,
    clock = () => new Date(),
    sessionStateForFailure,
    onSessionOpened = () => {},
  } = deps ?? {};
  for (const dependency of [openSession, createTransport, createAdapter]) {
    if (typeof dependency !== 'function') {
      throw new BackfillCliError('CLI_RUNTIME_DEPENDENCIES_MISSING', 'runtime dependencies missing');
    }
  }
  if (!repository || typeof repository.recordExperimentResult !== 'function') {
    throw new BackfillCliError('CLI_REPOSITORY_MISSING', 'an experiment repository is required');
  }

  const probes = [];
  let sessionsOpened = 0;
  let healthAppends = 0;

  // Strictly sequential: one canonical Profile is open at any moment.
  for (const storeCode of plan.storeCodes) {
    let session = null;
    let activeEndpointCode = null;
    try {
      session = await openSession({ storeCode });
      sessionsOpened += 1;
      onSessionOpened(session);
      if (typeof repository.recordSessionHealth === 'function') {
        await repository.recordSessionHealth({
          storeCode,
          profileKey: session.profileKey,
          observedAt: clock().toISOString(),
          sessionState: session.sessionState,
          consecutiveFailureCount: 0,
        });
        healthAppends += 1;
      }
      for (const probe of plan.probes.filter((item) => item.storeCode === storeCode)) {
        activeEndpointCode = probe.endpointCode;
        // One transport per endpoint: it closes over that endpoint's validated
        // method, url and body, so a probe cannot reach another route.
        const transport = createTransport({
          session,
          endpointCode: probe.endpointCode,
          request: probe.request,
        });
        const probeAdapter = createAdapter({ storeCode, session, transport });
        const result = await probeAdapter.probeEndpoint(probe.endpointCode, probe.request);
        // Persistence is the repository's only entry point; nothing else writes.
        const persistence = await repository.recordExperimentResult({
          batch: result.batch,
          observations: result.observations,
          rejected: result.rejected,
        });
        probes.push(safeProbeProjection({
          ...result.batch,
          discoveredMetaIndexIds: result.discoveredMetaIndexIds ?? [],
          responseSchemaPaths: result.responseSchemaPaths ?? [],
          persisted: persistence?.webapiFetchBatchId !== undefined,
        }));
        const succeeded = result.batch.resultStatus === 'SCHEMA_ONLY';
        const authExpired = result.batch.sanitizedErrorCode
          === TRANSPORT_REJECT_CODES.AUTH_EXPIRED;
        if (typeof repository.recordSessionHealth === 'function') {
          await repository.recordSessionHealth({
            storeCode,
            profileKey: session.profileKey,
            observedAt: clock().toISOString(),
            sessionState: authExpired ? 'EXPIRED' : 'ACTIVE',
            lastSuccessAt: succeeded ? result.batch.completedAt : null,
            responseSchemaHash: succeeded ? result.batch.responseSchemaHash : null,
            latencyMs: probeLatencyMs(result.batch),
            consecutiveFailureCount: succeeded ? 0 : 1,
            sanitizedErrorCode: succeeded ? null : result.batch.sanitizedErrorCode,
          });
          healthAppends += 1;
        }
        if (authExpired) break;
        activeEndpointCode = null;
      }
    } catch (error) {
      const failureCode = sanitizedFailure(error).errorCode;
      if (typeof repository.recordSessionHealth === 'function') {
        try {
          await repository.recordSessionHealth({
            storeCode,
            profileKey: session?.profileKey ?? resolveProfileKey(storeCode),
            observedAt: clock().toISOString(),
            sessionState: typeof sessionStateForFailure === 'function'
              ? sessionStateForFailure(error?.code)
              : 'UNKNOWN',
            consecutiveFailureCount: 1,
            sanitizedErrorCode: failureCode,
          });
          healthAppends += 1;
        } catch {
          // A health append must never mask the original failure.
        }
      }
      probes.push({
        storeCode,
        endpointCode: activeEndpointCode,
        resultStatus: 'BLOCKED',
        httpStatus: null,
        requestSchemaHash: null,
        responseSchemaHash: null,
        payloadFingerprint: null,
        observationCount: 0,
        rejectedCount: 0,
        discoveredMetaIndexIds: [],
        responseSchemaPaths: [],
        sanitizedErrorCode: failureCode,
        persisted: false,
      });
    } finally {
      // Always clean up, on success and on every failure path.
      if (session && typeof session.close === 'function') {
        try {
          await session.close();
        } catch {
          /* the session was already torn down */
        }
      }
    }
  }

  return Object.freeze({
    ok: probes.every((probe) => probe.resultStatus === 'SCHEMA_ONLY'),
    mode: EXPERIMENT_MODES.EXECUTE,
    planHash: plan.planHash,
    stage: plan.stage,
    authorizedStoreCount: authorization?.allowedStoreCodes?.length ?? 0,
    sessionsOpened,
    healthAppends,
    probes: Object.freeze(probes),
    note: plan.stage === EXPERIMENT_STAGES.CATALOG
      ? 'Catalog stage: technical metric ids and schema hashes only.'
      : 'Metric detail stage: observations remain UNMAPPED in the experiment tables.',
  });
}

async function main(argv) {
  let runtime = null;
  let signalHandler = null;
  try {
    const request = parseExperimentRunRequest(argv);
    if (request.mode === EXPERIMENT_MODES.DRY_RUN) {
      printSafeJson(toSafeDryRunReport(request.plan));
      return 0;
    }
    // Authorization succeeded, so the deployment prerequisite may now be read.
    // Its value is never printed and never enters an error message.
    const databaseUrl = process.env[DATABASE_URL_VARIABLE];
    if (!databaseUrl) {
      printSafeJson(
        { ok: false, errorCode: 'WEBAPI_DATABASE_URL_MISSING' },
        (line) => process.stderr.write(line),
      );
      return 3;
    }
    const { createLinuxExperimentRuntime } = await import(
      '../src/webapi-experiment/linux-runtime.mjs'
    );
    runtime = await createLinuxExperimentRuntime({ databaseUrl });
    signalHandler = () => {
      runtime?.close().catch(() => {});
    };
    process.once('SIGINT', signalHandler);
    process.once('SIGTERM', signalHandler);
    const result = await runExperimentPlan({
      plan: request.plan,
      authorization: request.authorization,
      deps: runtime.deps,
    });
    printSafeJson(result, result.ok
      ? undefined
      : (line) => process.stderr.write(line));
    return result.ok ? 0 : 5;
  } catch (error) {
    printSafeJson(sanitizedFailure(error), (line) => process.stderr.write(line));
    return error instanceof ExperimentPlanError || error instanceof BackfillCliError ? 2 : 1;
  } finally {
    if (signalHandler) {
      process.removeListener('SIGINT', signalHandler);
      process.removeListener('SIGTERM', signalHandler);
    }
    if (runtime) await runtime.close().catch(() => {});
  }
}

if (process.argv[1]?.endsWith('run_full_managed_webapi_experiment.mjs')) {
  process.exitCode = await main(process.argv.slice(2));
}
