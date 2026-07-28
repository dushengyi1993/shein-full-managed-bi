#!/usr/bin/env node

/**
 * Backfill runner CLI. Dry-run by default.
 *
 * Execute requires all of `--execute`, `--approved-plan-hash`,
 * `--allow-stores` and `--allow-domains`. A dry-run never opens a database
 * connection, never loads the private OpenAPI configuration, never creates an
 * adapter and therefore cannot perform any external request.
 *
 * Exactly one domain can execute: `purchase-orders` by OpenAPI `updateTime`.
 * Its runtime — the private configuration, the dedicated supply database URL,
 * the checkpoint pool and the adapter — is dynamically imported and constructed
 * only after `assertExecuteAuthorization` has already accepted the exact plan
 * hash and the exact store and domain allow-lists.
 */

import {
  buildBackfillPlan,
  assertExecuteAuthorization,
  BackfillPlanError,
  BACKFILL_MODES,
} from '../src/backfill/plan.mjs';
import { runBackfillPlan, BackfillRunError } from '../src/backfill/runner.mjs';
import { EXECUTABLE_BACKFILL_DOMAIN } from '../src/backfill/capability-catalog.mjs';
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

/**
 * Deployment prerequisites, read by name only and never printed.
 *
 * The backfill delegates to the existing supply sync, so it reuses that
 * service's existing private conventions verbatim: the same full-managed OpenAPI
 * configuration file variables, and the same `FULL_BI_DATABASE_URL` key that the
 * supply `database.env` already provides.
 *
 * The generic `DATABASE_URL` fallback that `sync_full_managed_supply.mjs`
 * tolerates is deliberately *not* accepted here. A backfill execute run writes
 * the control-plane ledger and advances checkpoints, so a shell that happens to
 * export `DATABASE_URL` must not be able to aim it at another database.
 */
export const OPENAPI_CONFIG_VARIABLES = Object.freeze([
  'FULL_BI_OPENAPI_CONFIG',
  'FULL_BI_OPENAPI_CONFIG_FILE',
]);

export const SUPPLY_DATABASE_URL_VARIABLE = 'FULL_BI_DATABASE_URL';

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

/**
 * Build the execute-only runtime.
 *
 * Called strictly after `assertExecuteAuthorization` has accepted the reviewed
 * plan hash and the exact allow-lists. Every module that can touch a credential,
 * a socket or the warehouse is imported here, dynamically, so a dry-run never
 * loads it at all.
 *
 * Only `openapi.purchase-orders.v1` is registered. Any other adapter key stays
 * absent, so a blocked domain that somehow reached the adapter lookup would be
 * reported as `ADAPTER_NOT_REGISTERED` rather than executed. The config and the
 * adapter are built only when the plan actually contains an executable window,
 * so a blocked-only execute run records its blocker rows without ever loading a
 * credential.
 */
export async function createBackfillExecuteRuntime({
  plan,
  env = process.env,
  clock = () => new Date(),
  // Injected only by tests. The defaults are the real dynamic imports, so
  // production wiring cannot diverge from what the tests exercise.
  loadPg = () => import('pg'),
  loadCheckpointRepository = () => import('../src/backfill/checkpoint-repository.mjs'),
  loadOpenApiConfigModule = () => import('../src/openapi/full-managed-config.mjs'),
  loadSupplySyncModule = () => import('./sync_full_managed_supply.mjs'),
  loadPurchaseOrderAdapterModule = () => import('../src/backfill/purchase-order-adapter.mjs'),
} = {}) {
  if (!plan || !Array.isArray(plan.windows)) {
    throw new BackfillCliError('CLI_EXECUTE_PLAN_MISSING', 'execute requires a built plan');
  }
  const executableWindows = plan.windows.filter((window) => window.executable);
  const executableDomains = [...new Set(
    executableWindows.map((window) => window.domain),
  )].sort();
  // Checked before any credential or connection exists: a plan that could
  // execute anything but purchase orders is refused outright.
  if (executableDomains.some((domain) => domain !== EXECUTABLE_BACKFILL_DOMAIN)) {
    throw new BackfillCliError(
      'BACKFILL_EXECUTABLE_DOMAIN_UNEXPECTED',
      'only purchase-orders may execute a historical backfill',
    );
  }
  const databaseUrl = env[SUPPLY_DATABASE_URL_VARIABLE];
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    // Reported by variable name only. The value is never printed or logged.
    throw new BackfillCliError(
      'BACKFILL_SUPPLY_DATABASE_URL_MISSING',
      `${SUPPLY_DATABASE_URL_VARIABLE} is required for an execute run`,
    );
  }
  const executableStoreCodes = [...new Set(
    executableWindows.map((window) => window.storeCode),
  )].sort();
  // Read by name only; the resolved path never enters output or an error. This is
  // validated before the pool exists so a missing prerequisite costs no
  // connection.
  const configPath = OPENAPI_CONFIG_VARIABLES
    .map((name) => env[name])
    .find((value) => typeof value === 'string' && value.trim() !== '');
  if (executableStoreCodes.length > 0 && configPath === undefined) {
    throw new BackfillCliError(
      'BACKFILL_OPENAPI_CONFIG_MISSING',
      `one of ${OPENAPI_CONFIG_VARIABLES.join(' or ')} is required for an execute run`,
    );
  }

  const { Pool } = await loadPg();
  const { createBackfillRepository } = await loadCheckpointRepository();
  // One small dedicated pool for the control-plane ledger.
  const pools = [new Pool({ connectionString: databaseUrl, max: 2 })];

  async function close() {
    // Every pool closes, even if an earlier close throws.
    const failures = [];
    for (const pool of pools.splice(0)) {
      try {
        await pool.end();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }

  try {
    const repository = createBackfillRepository({ pool: pools[0] });
    const adapters = {};
    // A blocked-only execute run still records its blocker rows, but it never
    // loads the private configuration and never builds an adapter.
    if (executableStoreCodes.length > 0) {
      const { loadFullManagedConfig } = await loadOpenApiConfigModule();
      const { runSupplySync } = await loadSupplySyncModule();
      const {
        createPurchaseOrderBackfillAdapter,
        PURCHASE_ORDER_BACKFILL_ADAPTER_KEY,
      } = await loadPurchaseOrderAdapterModule();
      const config = await loadFullManagedConfig(configPath);
      adapters[PURCHASE_ORDER_BACKFILL_ADAPTER_KEY] = createPurchaseOrderBackfillAdapter({
        runSupplySync,
        config,
        databaseUrl,
        allowedStoreCodes: executableStoreCodes,
        clock,
      });
    }

    return Object.freeze({
      adapters: Object.freeze(adapters),
      repository,
      adapterKeys: Object.freeze(Object.keys(adapters).sort()),
      executableStoreCodes: Object.freeze(executableStoreCodes),
      close,
    });
  } catch (error) {
    // The pool exists already, so it must not leak when wiring fails.
    await close().catch(() => {});
    throw error;
  }
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
      : 'Execute run. Only verified, incomplete purchase-order windows were attempted.',
  };
}

/**
 * CLI entrypoint.
 *
 * Dry-run stays exactly as before: it builds the plan, rehearses it and prints
 * counts. No runtime is created, so no pool, credential, adapter or request can
 * exist on that path.
 *
 * Execute creates the runtime only after authorization, runs the plan against the
 * real repository and the single purchase-order adapter, and always closes the
 * runtime — on success, on a run failure and on an unexpected throw.
 */
export async function main(argv, {
  env = process.env,
  clock = () => new Date(),
  createRuntime = createBackfillExecuteRuntime,
  runPlan = runBackfillPlan,
  writeOut = (line) => process.stdout.write(line),
  writeError = (line) => process.stderr.write(line),
} = {}) {
  let runtime = null;
  try {
    const request = parseRunRequest(argv);
    if (request.mode === BACKFILL_MODES.DRY_RUN) {
      const result = await runPlan({ plan: request.plan, mode: request.mode });
      printSafeJson(toSafeRunReport(result), writeOut);
      return 0;
    }
    // Authorization already succeeded, so the deployment prerequisites may now be
    // read. Their values never reach output or an error message.
    runtime = await createRuntime({ plan: request.plan, env, clock });
    const result = await runPlan({
      plan: request.plan,
      mode: request.mode,
      approvedPlanHash: request.approvedPlanHash,
      allowedStoreCodes: request.allowedStoreCodes,
      allowedDomains: request.allowedDomains,
      adapters: runtime.adapters,
      repository: runtime.repository,
      clock,
      createdBy: request.plan.createdBy,
    });
    const report = toSafeRunReport(result);
    // An execute run that produced a blocked, partial or failed window is not a
    // success: the exit code says so rather than the operator having to read JSON.
    printSafeJson(report, report.ok ? writeOut : writeError);
    return report.ok && result.runStatus === 'SUCCEEDED' ? 0 : 5;
  } catch (error) {
    if (
      error instanceof BackfillPlanError
      || error instanceof BackfillCliError
      || error instanceof BackfillRunError
    ) {
      printSafeJson(sanitizedFailure(error), writeError);
      return 2;
    }
    printSafeJson(sanitizedFailure(error), writeError);
    return 1;
  } finally {
    if (runtime) {
      // A close failure must not mask the run outcome already reported above.
      await Promise.resolve(runtime.close()).catch(() => {});
    }
  }
}

if (process.argv[1]?.endsWith('run_full_managed_backfill.mjs')) {
  process.exitCode = await main(process.argv.slice(2));
}
