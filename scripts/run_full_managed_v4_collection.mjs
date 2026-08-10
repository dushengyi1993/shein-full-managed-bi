#!/usr/bin/env node

/**
 * Full-managed v4 order-WebAPI collection runner (one-off).
 *
 * Dry-run by default: it builds the frozen plan (canonical 25-store roster,
 * exact 13-item work-item manifest, one inclusive 30-day settled Shanghai
 * window ending yesterday, retryPolicy NONE) and prints it.  A dry-run never
 * opens a database connection, never loads a session store, never touches a
 * transport and never writes a file.
 *
 * Execute requires the exact reviewed `--approved-plan-hash`.  Only then:
 *   1. a pg Pool is created from FULL_BI_WEBAPI_DATABASE_URL,
 *   2. the encrypted full-managed session store is loaded,
 *   3. one DB run is created (plan_hash, deterministic run_key, the 13-item
 *      manifest in exact frozen order) and transitioned PREFLIGHT_PASSED then
 *      RUNNING,
 *   4. one attempt per 25x13 grain is begun and moved to RUNNING,
 *   5. the existing session sync is invoked exactly once (storeConcurrency=1,
 *      no retry, statistics included) with in-memory evidence hooks that
 *      mirror every actual transport request,
 *   6. typed pages are persisted with insertTypedFacts for all 7 page ids
 *      (including value-added-services) passing the network-source payload
 *      hash, statistics calls become page evidence on their own
 *      WAYBILLS_STATISTICS_<type> attempt plus a STATISTICS_TYPE_<type>
 *      capability observation,
 *   7. attempts and the run are transitioned honestly (SUCCEEDED only when
 *      every fetched page is fully accepted; PARTIAL/FAILED otherwise; never
 *      zero-filled), coverage is finalized, and only a SUCCEEDED run may then
 *      promote the snapshot from a same-directory private staging artifact to
 *      the explicit candidate output path. A persistence failure drives every
 *      created attempt to an explicit terminal status, fails the run,
 *      finalizes coverage fail-closed and removes/quarantines staging, so the
 *      final candidate path never becomes materializable before the DB gates
 *      succeed.
 *
 * The runner never writes either dashboard live input artifact
 * (order-management.json or order-management.sessions.json), never touches
 * timers/schedulers, never retries and never persists raw response bodies.
 * Execute output is sanitized: hashes, counts and statuses only.
 */

import process from 'node:process';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile, rename, rm, unlink } from 'node:fs/promises';

import {
  ORDER_MANAGEMENT_MAX_PAGES,
  ORDER_MANAGEMENT_SESSION_PAGES,
} from '../src/webapi-history/order-management-contracts.mjs';
import {
  assertApprovedV4CollectionPlanHash,
  buildV4CollectionPlan,
  parseV4CollectionPlan,
  V4CollectionPlanError,
  V4_COLLECTION_ATTEMPT_COUNT,
  V4_COLLECTION_CONTRACT_VERSION,
  V4_COLLECTION_PAGE_ENDPOINT_CODES,
  V4_COLLECTION_RETRY_POLICY,
  V4_COLLECTION_STATISTICS_ENDPOINT_CODES,
  V4_COLLECTION_STATISTICS_TYPES,
  v4EndpointRequestFingerprint,
  v4EndpointRequestSchemaHash,
  v4WorkItemWindow,
} from '../src/warehouse/v4-collection-plan.mjs';
import { runOrderManagementSessionSync } from './sync_full_managed_order_management_sessions.mjs';

export const V4_COLLECTION_DATABASE_URL_VARIABLE = 'FULL_BI_WEBAPI_DATABASE_URL';
export const ACTIVE_ORDER_MANAGEMENT_ARTIFACT_NAME = 'order-management.json';
export const LIVE_ORDER_MANAGEMENT_SESSION_ARTIFACT_NAME = 'order-management.sessions.json';

const RESERVED_ORDER_MANAGEMENT_ARTIFACT_NAMES = new Set([
  ACTIVE_ORDER_MANAGEMENT_ARTIFACT_NAME,
  LIVE_ORDER_MANAGEMENT_SESSION_ARTIFACT_NAME,
]);

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,80}$/;
const PAGE_ID_BY_ENDPOINT = Object.freeze(Object.fromEntries(
  Object.entries(ORDER_MANAGEMENT_SESSION_PAGES)
    .map(([pageId, endpointCode]) => [endpointCode, pageId]),
));

export class V4CollectionCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'V4CollectionCliError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new V4CollectionCliError(code, message);
}

/**
 * Sanitize an error code for the control plane.  Only the bounded
 * [A-Z][A-Z0-9_]{2,80} shape is accepted; anything else falls back.
 */
export function toSanitizedV4ErrorCode(value, fallback = 'V4_COLLECTION_FAILED') {
  const candidate = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return ERROR_CODE_PATTERN.test(candidate) ? candidate : fallback;
}

export function defaultCandidateOutput(plan) {
  return path.resolve(
    'outputs',
    `full-managed-v4-collection.candidate.${plan.planHash}.json`,
  );
}

export function parseV4CollectionArgs(argv) {
  const result = {
    execute: false,
    approvedPlanHash: null,
    planFile: null,
    output: null,
  };
  for (const token of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) fail('V4_COLLECTION_ARGUMENT_INVALID', 'invalid argument');
    const [, name, value] = match;
    if (name === 'execute' && value === undefined) result.execute = true;
    else if (name === 'approved-plan-hash' && value) result.approvedPlanHash = value;
    else if (name === 'plan-file' && value) result.planFile = value;
    else if (name === 'output' && value) result.output = value;
    else fail('V4_COLLECTION_ARGUMENT_INVALID', 'invalid argument');
  }
  if (!result.execute) {
    const executeOnlyFlags = Object.freeze({
      approvedPlanHash: 'approved-plan-hash',
      planFile: 'plan-file',
      output: 'output',
    });
    for (const [name, flag] of Object.entries(executeOnlyFlags)) {
      if (result[name] !== null) {
        fail('V4_COLLECTION_EXECUTE_FLAG_WITHOUT_EXECUTE', `--${flag} requires --execute`);
      }
    }
    return result;
  }
  if (!result.approvedPlanHash) {
    fail('V4_COLLECTION_APPROVED_PLAN_HASH_REQUIRED', '--approved-plan-hash is required with --execute');
  }
  if (!result.output) {
    fail('V4_COLLECTION_OUTPUT_REQUIRED', '--output is required with --execute');
  }
  return result;
}

/**
 * The execute-only runtime.  Every module that can touch a credential, a
 * socket or the warehouse is created only after the exact reviewed plan hash
 * has already been accepted, and only on execute.
 */
async function createV4CollectionRuntime({
  plan,
  env,
  createPool = null,
  loadSessionStore = null,
  createRepository = null,
}) {
  const databaseUrl = env[V4_COLLECTION_DATABASE_URL_VARIABLE];
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    // Reported by variable name only.  The value is never printed or logged.
    fail(
      'V4_COLLECTION_DATABASE_URL_MISSING',
      `${V4_COLLECTION_DATABASE_URL_VARIABLE} is required for an execute run`,
    );
  }
  let pool = null;
  try {
    pool = createPool
      ? await createPool()
      : await (async () => {
        const { Pool } = await import('pg');
        return new Pool({ connectionString: databaseUrl, max: 2 });
      })();
    const sessionStore = loadSessionStore
      ? await loadSessionStore()
      : await (async () => {
        const { createEncryptedWebApiSessionStoreFromEnvironment } =
          await import('../src/webapi-session/encrypted-session-store.mjs');
        return createEncryptedWebApiSessionStoreFromEnvironment();
      })();
    const repository = createRepository
      ? await createRepository({ pool })
      : await (async () => {
        const { createFullWebapiFactRepository } =
          await import('../src/warehouse/full-webapi-fact-repository.mjs');
        return createFullWebapiFactRepository({ pool });
      })();
    return { pool, sessionStore, repository, close: () => pool.end() };
  } catch (error) {
    if (pool) await pool.end().catch(() => {});
    throw error;
  }
}

function pageGatesOf(syncResult, storeCode, pageId) {
  const storeEvidence = syncResult?.snapshot?.evidence?.perStore
    ?.find((entry) => entry.storeCode === storeCode);
  return storeEvidence?.pages?.[pageId] ?? null;
}

/**
 * Run the frozen plan.  Dry-run returns the plan with zero side effects.
 * Execute first proves the approved hash, then drives the DB run, the 325
 * attempts, one sync invocation with in-memory evidence hooks, honest
 * transitions and finalizeCoverage, writing only the candidate snapshot path.
 */
export async function runV4Collection({
  plan = null,
  execute = false,
  approvedPlanHash = null,
  output = null,
  now = new Date(),
  env = process.env,
  createPool = null,
  loadSessionStore = null,
  createRepository = null,
  sync = runOrderManagementSessionSync,
} = {}) {
  const builtPlan = plan ?? buildV4CollectionPlan({ now });
  const candidateOutput = path.resolve(output ?? defaultCandidateOutput(builtPlan));
  if (!execute) {
    return Object.freeze({
      ok: true,
      mode: 'DRY_RUN',
      plan: builtPlan,
      candidateOutput,
    });
  }
  // Authorization is proven before any pool, session store, transport or file
  // can exist.
  assertApprovedV4CollectionPlanHash(builtPlan, approvedPlanHash);
  if (RESERVED_ORDER_MANAGEMENT_ARTIFACT_NAMES.has(path.basename(candidateOutput))) {
    fail(
      'V4_COLLECTION_OUTPUT_IS_ACTIVE_ARTIFACT',
      'candidate output must never be a live order-management dashboard artifact',
    );
  }

  const runtime = await createV4CollectionRuntime({
    plan: builtPlan,
    env,
    createPool,
    loadSessionStore,
    createRepository,
  });
  try {
    const { sessionStore, repository } = runtime;
    const { planHash, runKey } = builtPlan;
    // The final candidate path only becomes materializable after every DB
    // gate (persistence, terminal run, coverage) has succeeded. The sync
    // writes a same-directory private staging artifact instead; promotion is
    // a rename at the very end, and failure removes or quarantines staging.
    const stagingOutput = path.join(
      path.dirname(candidateOutput),
      `${path.basename(candidateOutput)}.staging-${crypto.randomBytes(4).toString('hex')}`,
    );
    const removeStaging = async () => {
      try {
        await unlink(stagingOutput);
      } catch {
        // The staging name never equals the final candidate path, so an
        // undeletable leftover is quarantined by naming.
      }
    };
    const promoteStaging = async () => {
      try {
        await rename(stagingOutput, candidateOutput);
      } catch (error) {
        // Windows refuses rename onto an existing file; POSIX replaces it.
        // Replacing the previous candidate of the exact same plan is the
        // intended one-off replay semantic.
        if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
        await rm(candidateOutput, { force: true });
        await rename(stagingOutput, candidateOutput);
      }
    };
    const grainKey = (storeCode, workItemCode) => `${storeCode}\u001f${workItemCode}`;
    const evidence = {
      pages: [],
      statistics: [],
      async onPage(entry) {
        evidence.pages.push(entry);
      },
      async onStatistics(entry) {
        evidence.statistics.push(entry);
      },
    };
    const attempts = new Map();
    let syncResult = null;
    let syncError = null;
    try {
      await repository.createCollectionRun({
        contractVersion: V4_COLLECTION_CONTRACT_VERSION,
        planHash,
        runKey,
        storeCodes: builtPlan.storeCodes,
        endpointCodes: builtPlan.workItemCodes,
        windowStart: builtPlan.window.startDate,
        windowEnd: builtPlan.window.endDate,
        retryPolicy: V4_COLLECTION_RETRY_POLICY,
      });
      await repository.transitionRun({ runKey, status: 'PREFLIGHT_PASSED' });
      await repository.transitionRun({ runKey, status: 'RUNNING' });
      for (const storeCode of builtPlan.storeCodes) {
        for (const workItemCode of builtPlan.workItemCodes) {
          const window = v4WorkItemWindow({
            workItemCode,
            window: builtPlan.window,
          });
          const opened = await repository.beginAttempt({
            runKey,
            storeCode,
            endpointCode: workItemCode,
            requestSchemaHash: v4EndpointRequestSchemaHash(workItemCode),
            requestFingerprint: v4EndpointRequestFingerprint({
              workItemCode,
              window,
            }),
            windowStart: window?.startDate ?? null,
            windowEnd: window?.endDate ?? null,
            expectedRowCount: null,
            initialStatus: 'PLANNED',
          });
          attempts.set(grainKey(storeCode, workItemCode), opened.attemptKey);
          await repository.transitionAttempt({
            attemptKey: opened.attemptKey,
            status: 'RUNNING',
          });
        }
      }
      // Exactly one sync invocation: serial stores, no retry, statistics on.
      syncResult = await sync({
        storeCodes: builtPlan.storeCodes,
        output: stagingOutput,
        window: builtPlan.window,
        pageIds: Object.keys(ORDER_MANAGEMENT_SESSION_PAGES),
        includeStatistics: true,
        storeConcurrency: 1,
        sessionStore,
        evidence,
        now,
        maxPages: ORDER_MANAGEMENT_MAX_PAGES,
      });
    } catch (error) {
      syncError = error;
    }

    const outcomes = new Map();
    const terminalAttempt = async ({
      storeCode,
      workItemCode,
      status,
      observedRowCount = null,
      observedPageCount = null,
      sanitizedErrorCode = null,
    }) => {
      const attemptKey = attempts.get(grainKey(storeCode, workItemCode));
      if (!attemptKey) return;
      await repository.transitionAttempt({
        attemptKey,
        status,
        observedRowCount,
        observedPageCount,
        sanitizedErrorCode,
      });
      outcomes.set(grainKey(storeCode, workItemCode), status);
    };

    try {
      // Typed page attempts: all 7 pages, including value-added-services.
      for (const storeCode of builtPlan.storeCodes) {
        for (const endpointCode of V4_COLLECTION_PAGE_ENDPOINT_CODES) {
          const pageId = PAGE_ID_BY_ENDPOINT[endpointCode];
          const entries = evidence.pages.filter((entry) => (
            entry.storeCode === storeCode && entry.endpointCode === endpointCode
          ));
          const gates = pageGatesOf(syncResult, storeCode, pageId);
          const inserted = [];
          for (const entry of entries) {
            inserted.push(await repository.insertTypedFacts({
              pageId,
              storeCode,
              endpointCode,
              attemptKey: attempts.get(grainKey(storeCode, endpointCode)),
              pageNumber: entry.pageNumber,
              pageSize: entry.pageSize,
              pageRequestFingerprint: entry.pageRequestFingerprint,
              responseSchemaHash: entry.responseSchemaHash,
              sourcePayloadHash: entry.payloadHash,
              httpStatus: entry.httpStatus,
              observedAt: entry.observedAt,
              rows: entry.rows,
            }));
          }
          const pagesFetched = gates?.fetched?.pagesFetched ?? null;
          const failures = gates?.fetched?.failures ?? [];
          const allPagesAccepted = entries.length > 0
            && entries.length === pagesFetched
            && inserted.every((result) => (
              result.rejectedRowCount === 0
              && result.readback?.payloadHashesMatch === true
              && result.readback?.rowCount === result.readback?.expectedRowCount
            ));
          const gatesOk = gates?.gates?.ok === true && failures.length === 0;
          if (gatesOk && allPagesAccepted) {
            await terminalAttempt({
              storeCode,
              workItemCode: endpointCode,
              status: 'SUCCEEDED',
              observedRowCount: inserted.reduce((sum, result) => sum + result.acceptedRowCount, 0),
              observedPageCount: inserted.length,
            });
          } else if (inserted.length > 0) {
            await terminalAttempt({
              storeCode,
              workItemCode: endpointCode,
              status: 'PARTIAL',
              observedRowCount: inserted.reduce((sum, result) => sum + result.acceptedRowCount, 0),
              observedPageCount: inserted.length,
            });
          } else {
            await terminalAttempt({
              storeCode,
              workItemCode: endpointCode,
              status: 'FAILED',
              sanitizedErrorCode: toSanitizedV4ErrorCode(
                failures[0] ?? syncError?.code,
                'V4_COLLECTION_PAGE_NOT_FETCHED',
              ),
            });
          }
        }
      }

      // Statistics work items: page evidence + capability observation on
      // success.  SUCCEEDED is only provable when the whole sync invocation
      // completed; a mid-run sync failure leaves fetched statistics as
      // PARTIAL (real evidence, success unprovable) and unfetched ones as
      // FAILED, with no invented observation either way.
      for (const storeCode of builtPlan.storeCodes) {
        for (const statisticsType of V4_COLLECTION_STATISTICS_TYPES) {
          const workItemCode = `WAYBILLS_STATISTICS_${statisticsType}`;
          const entry = evidence.statistics.find((candidate) => (
            candidate.storeCode === storeCode && candidate.statisticsType === statisticsType
          ));
          if (entry?.ok === true) {
            await repository.recordPageEvidence({
              storeCode,
              endpointCode: workItemCode,
              attemptKey: attempts.get(grainKey(storeCode, workItemCode)),
              pageNumber: 1,
              pageSize: 1,
              pageRequestFingerprint: entry.pageRequestFingerprint,
              responseSchemaHash: entry.responseSchemaHash,
              payloadHash: entry.payloadHash,
              httpStatus: entry.httpStatus,
              observedAt: entry.observedAt,
              rowCount: 1,
              rejectedRowCount: 0,
              fetchStatus: 'SUCCEEDED',
            });
            await repository.recordCapabilityObservation({
              runKey,
              storeCode,
              endpointCode: 'WAYBILLS_STATISTICS',
              capabilityCode: `STATISTICS_TYPE_${statisticsType}`,
              capabilityStatus: 'VERIFIED',
              payloadHash: entry.payloadHash,
              observedAt: entry.observedAt,
              sourceUpdatedAt: null,
              sanitizedErrorCode: null,
            });
            await terminalAttempt({
              storeCode,
              workItemCode,
              status: syncResult === null ? 'PARTIAL' : 'SUCCEEDED',
              observedRowCount: 1,
              observedPageCount: 1,
            });
          } else {
            await terminalAttempt({
              storeCode,
              workItemCode,
              status: 'FAILED',
              sanitizedErrorCode: toSanitizedV4ErrorCode(
                entry?.errorCode ?? syncError?.code,
                'V4_COLLECTION_STATISTICS_NOT_FETCHED',
              ),
            });
          }
        }
      }
    } catch (error) {
      // A persistence failure must not leave the run open forever. While the
      // ledger is reachable, every created attempt is driven to an explicit
      // terminal status, the run fails honestly, coverage is finalized
      // fail-closed and the staging artifact is removed. Each cleanup step is
      // best-effort; the original error is rethrown so the report stays
      // honest.
      syncError = error;
      const sanitizedErrorCode = toSanitizedV4ErrorCode(
        error?.code,
        'V4_COLLECTION_PERSIST_FAILED',
      );
      for (const [grain, attemptKey] of attempts) {
        if (outcomes.has(grain)) continue;
        try {
          await repository.transitionAttempt({
            attemptKey,
            status: 'FAILED',
            sanitizedErrorCode,
          });
          outcomes.set(grain, 'FAILED');
        } catch {
          // Ledger unreachable; the original error remains the record.
        }
      }
      try {
        await repository.transitionRun({
          runKey,
          status: 'FAILED',
          sanitizedErrorCode,
        });
      } catch {
        // The run is already terminal or the ledger is unreachable; either way
        // the database remains the honest record.
      }
      try {
        await repository.finalizeCoverage({
          runKey,
          pagingVerified: false,
          dedupeVerified: false,
          reasonCode: sanitizedErrorCode,
        });
      } catch {
        // Coverage is enforced fail-closed by the ledger guard when reachable.
      }
      await removeStaging();
      throw error;
    }

    const statuses = [...outcomes.values()];
    const succeededCount = statuses.filter((status) => status === 'SUCCEEDED').length;
    const partialCount = statuses.filter((status) => status === 'PARTIAL').length;
    const failedCount = statuses.filter((status) => status === 'FAILED').length;
    const totalAttempts = attempts.size;
    const runStatus = totalAttempts > 0 && succeededCount === totalAttempts
      ? 'SUCCEEDED'
      : succeededCount > 0
        ? 'PARTIAL'
        : 'FAILED';
    try {
      await repository.transitionRun({
        runKey,
        status: runStatus,
        sanitizedErrorCode: runStatus === 'FAILED'
          ? toSanitizedV4ErrorCode(syncError?.code, 'V4_COLLECTION_NO_ATTEMPT_SUCCEEDED')
          : null,
      });
    } catch (error) {
      syncError = error;
      throw error;
    }

    const pageResults = syncResult?.snapshot?.pages ?? null;
    const pagingVerified = pageResults !== null
      && Object.values(pageResults).every((page) => page?.gates?.pagingVerified === true);
    const dedupeVerified = pageResults !== null
      && Object.values(pageResults).every((page) => page?.gates?.dedupeVerified === true);
    const reasonCode = runStatus === 'SUCCEEDED'
      ? null
      : runStatus === 'PARTIAL'
        ? 'V4_COLLECTION_PARTIAL_COVERAGE'
        : 'V4_COLLECTION_INCOMPLETE_COVERAGE';
    let coverage = null;
    try {
      coverage = await repository.finalizeCoverage({
        runKey,
        pagingVerified,
        dedupeVerified,
        reasonCode,
      });
    } catch (error) {
      syncError = error;
      throw error;
    }

    // All DB gates have passed. Only now may the candidate path become
    // materializable, and only when the sync invocation itself completed and
    // every one of the 325 attempts reached SUCCEEDED. A PARTIAL/FAILED run,
    // a failed sync invocation or any persistence error leaves no final
    // candidate artifact; staging is removed (or quarantined by name).
    let snapshotWritten = null;
    if (syncError === null && syncResult?.written && runStatus === 'SUCCEEDED') {
      try {
        await promoteStaging();
        snapshotWritten = candidateOutput;
      } catch (error) {
        syncError = error;
        await removeStaging();
        throw error;
      }
    } else {
      await removeStaging();
    }

    const statisticsVerified = evidence.statistics.filter((entry) => entry.ok === true).length;
    return Object.freeze({
      ok: runStatus === 'SUCCEEDED',
      mode: 'EXECUTE',
      planHash,
      runKey,
      runStatus,
      candidateOutput,
      snapshotWritten,
      coverage,
      attemptSummary: Object.freeze({
        total: totalAttempts,
        succeeded: succeededCount,
        partial: partialCount,
        failed: failedCount,
        expected: V4_COLLECTION_ATTEMPT_COUNT,
      }),
      statisticsObservations: Object.freeze({
        verified: statisticsVerified,
        failed: evidence.statistics.length - statisticsVerified,
      }),
      note: 'Candidate snapshot is published only for SUCCEEDED runs. Live order-management artifacts were never touched.',
    });
  } finally {
    await Promise.resolve(runtime.close()).catch(() => {});
  }
}

function safePlan(plan) {
  return {
    planVersion: plan.planVersion,
    planHash: plan.planHash,
    runKey: plan.runKey,
    contractVersion: plan.contractVersion,
    retryPolicy: plan.retryPolicy,
    storeCodes: [...plan.storeCodes],
    workItemCodes: [...plan.workItemCodes],
    statisticsTypes: [...plan.statisticsTypes],
    windowDays: plan.windowDays,
    window: { ...plan.window },
    requestContractManifest: structuredClone(plan.requestContractManifest),
    summary: { ...plan.summary },
  };
}

export function toSafeDryRunReport(result) {
  return {
    ok: true,
    mode: 'DRY_RUN',
    plan: safePlan(result.plan),
    candidateOutput: result.candidateOutput,
    note: 'Dry-run only. No database connection, session store, transport or file was created.',
  };
}

export function toSafeExecuteReport(result) {
  return {
    ok: result.ok,
    mode: 'EXECUTE',
    planHash: result.planHash,
    runKey: result.runKey,
    runStatus: result.runStatus,
    candidateOutput: result.candidateOutput,
    snapshotWritten: result.snapshotWritten,
    coverage: result.coverage
      ? {
        expectedStoreCount: result.coverage.expectedStoreCount,
        completedStoreCount: result.coverage.completedStoreCount,
        partialStoreCount: result.coverage.partialStoreCount,
        unknownStoreCount: result.coverage.unknownStoreCount,
        rowCount: result.coverage.rowCount,
        replayed: result.coverage.replayed,
      }
      : null,
    attemptSummary: { ...result.attemptSummary },
    statisticsObservations: { ...result.statisticsObservations },
    note: result.note,
  };
}

export function sanitizedV4Failure(error) {
  if (error instanceof V4CollectionPlanError || error instanceof V4CollectionCliError) {
    return {
      ok: false,
      errorCode: toSanitizedV4ErrorCode(error.code, 'V4_COLLECTION_FAILED'),
      // Fixed safe copy: the code carries the actionable detail and no raw
      // argv token, path or value ever reaches output.
      message: 'Full-managed v4 collection refused.',
    };
  }
  return {
    ok: false,
    errorCode: toSanitizedV4ErrorCode(error?.code, 'V4_COLLECTION_RUN_FAILED'),
    message: 'Full-managed v4 collection failed.',
  };
}

/**
 * CLI entrypoint.  Dry-run builds the plan and prints it; execute proves the
 * approved hash first, runs the collection, and always closes the pool.
 */
export async function main(argv, {
  env = process.env,
  clock = () => new Date(),
  run = runV4Collection,
  loadPlanFile = async (file) => parseV4CollectionPlan(JSON.parse(await readFile(file, 'utf8'))),
  writeOut = (line) => process.stdout.write(line),
  writeError = (line) => process.stderr.write(line),
} = {}) {
  try {
    const args = parseV4CollectionArgs(argv);
    const plan = args.planFile
      ? await loadPlanFile(args.planFile)
      : buildV4CollectionPlan({ now: clock() });
    const result = await run({
      plan,
      execute: args.execute,
      approvedPlanHash: args.approvedPlanHash,
      output: args.output,
      now: clock(),
      env,
    });
    if (result.mode === 'DRY_RUN') {
      writeOut(`${JSON.stringify(toSafeDryRunReport(result), null, 2)}\n`);
      return 0;
    }
    writeOut(`${JSON.stringify(toSafeExecuteReport(result), null, 2)}\n`);
    return result.ok && result.runStatus === 'SUCCEEDED' ? 0 : 5;
  } catch (error) {
    writeError(`${JSON.stringify(sanitizedV4Failure(error), null, 2)}\n`);
    return error instanceof V4CollectionPlanError || error instanceof V4CollectionCliError ? 2 : 1;
  }
}

if (process.argv[1]?.endsWith('run_full_managed_v4_collection.mjs')) {
  process.exitCode = await main(process.argv.slice(2));
}
