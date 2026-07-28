import { BACKFILL_MODES, assertExecuteAuthorization } from './plan.mjs';
import { CAPABILITY_STATUSES } from './capability-catalog.mjs';
import {
  WINDOW_EXECUTION_STATUSES,
  WINDOW_QUALITY_STATUSES,
  evaluateWindowOutcome,
  nextCheckpointState,
} from './quality-gate.mjs';

export const RUN_STATUSES = Object.freeze({
  PLANNED: 'PLANNED',
  RUNNING: 'RUNNING',
  PARTIAL: 'PARTIAL',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

const SANITIZED_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,60}$/;

export class BackfillRunError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BackfillRunError';
    this.code = code;
    this.details = details;
  }
}

function sanitizedCode(value, fallback) {
  const candidate = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return SANITIZED_CODE_PATTERN.test(candidate) ? candidate : fallback;
}

const NULL_REPOSITORY = Object.freeze({
  async openRun() { return { backfillRunId: null }; },
  async loadCompletedWindowKeys() { return []; },
  async loadCheckpoints() { return []; },
  async commitWindowOutcome() { return { persisted: false, checkpointAdvanced: false }; },
  async recordWindowOutcome() { return { persisted: false }; },
  async closeRun() { return { closed: false }; },
});

/**
 * Execute or rehearse a bounded backfill plan.
 *
 * Dry-run is the default and never touches an adapter, a network client or the
 * warehouse. Execute requires the reviewed plan hash plus explicit store and
 * domain allow-lists, resumes only incomplete verified windows, and advances a
 * checkpoint only after persistence and every quality gate succeed.
 */
export async function runBackfillPlan({
  plan,
  mode = BACKFILL_MODES.DRY_RUN,
  adapters = {},
  repository = NULL_REPOSITORY,
  approvedPlanHash = null,
  allowedStoreCodes = null,
  allowedDomains = null,
  clock = () => new Date(),
  createdBy = null,
} = {}) {
  if (!plan || typeof plan.planHash !== 'string' || !Array.isArray(plan.windows)) {
    throw new BackfillRunError('MISSING_PLAN', 'a built backfill plan is required');
  }
  if (mode !== BACKFILL_MODES.DRY_RUN && mode !== BACKFILL_MODES.EXECUTE) {
    throw new BackfillRunError('INVALID_MODE', 'mode must be DRY_RUN or EXECUTE');
  }

  const isExecute = mode === BACKFILL_MODES.EXECUTE;
  let authorization = null;
  if (isExecute) {
    authorization = assertExecuteAuthorization({
      plan,
      approvedPlanHash,
      allowedStoreCodes,
      allowedDomains,
    });
  }

  const startedAt = clock();
  const runRecord = isExecute
    ? await repository.openRun({
      planHash: plan.planHash,
      mode,
      requestedDomains: [...plan.domains],
      requestedStoreCodes: [...plan.storeCodes],
      requestedFrom: plan.from,
      requestedTo: plan.to,
      windowSpanDays: plan.windowSpanDays,
      plannedWindowCount: plan.summary.plannedWindowCount,
      createdBy: createdBy ?? plan.createdBy,
      startedAt,
    })
    : { backfillRunId: null, resumed: false };

  const completedWindowKeys = new Set(
    isExecute
      ? await repository.loadCompletedWindowKeys({ planHash: plan.planHash })
      : [],
  );
  const checkpointRows = isExecute
    ? await repository.loadCheckpoints({
      storeCodes: [...plan.storeCodes],
      domains: [...plan.domains],
    })
    : [];
  const checkpointIndex = new Map(
    (Array.isArray(checkpointRows) ? checkpointRows : []).map((row) => [
      `${row.storeCode}${row.domain}${row.adapterKey}`,
      row,
    ]),
  );

  const windowResults = [];
  let adapterInvocationCount = 0;

  async function processWindow(window) {
    const checkpointKey = `${window.storeCode}${window.domain}${window.adapterKey}`;
    const checkpoint = checkpointIndex.get(checkpointKey) ?? null;

    if (window.capabilityStatus !== CAPABILITY_STATUSES.VERIFIED) {
      const blocked = {
        window,
        executionStatus: WINDOW_EXECUTION_STATUSES.BLOCKED,
        qualityStatus: WINDOW_QUALITY_STATUSES.UNKNOWN,
        sanitizedErrorCode: window.blockedReasonCode ?? 'CAPABILITY_NOT_VERIFIED',
        checkpointAdvanced: false,
        adapterInvoked: false,
        attemptCount: 0,
      };
      if (isExecute) {
        await repository.recordWindowOutcome({
          backfillRunId: runRecord.backfillRunId,
          window,
          outcome: {
            executionStatus: blocked.executionStatus,
            qualityStatus: blocked.qualityStatus,
            sanitizedErrorCode: blocked.sanitizedErrorCode,
            acceptedRowCount: null,
            rejectedRowCount: null,
            expectedPageCount: null,
            observedPageCount: null,
            schemaFingerprint: null,
            sourceBusinessWatermark: null,
          },
          attemptCount: 0,
        });
      }
      return blocked;
    }
    if (!isExecute) {
      return {
        window,
        executionStatus: WINDOW_EXECUTION_STATUSES.PLANNED,
        qualityStatus: WINDOW_QUALITY_STATUSES.UNKNOWN,
        sanitizedErrorCode: null,
        checkpointAdvanced: false,
        adapterInvoked: false,
        attemptCount: 0,
      };
    }
    if (completedWindowKeys.has(window.windowKey)) {
      return {
        window,
        executionStatus: WINDOW_EXECUTION_STATUSES.SKIPPED,
        qualityStatus: WINDOW_QUALITY_STATUSES.PASSED,
        sanitizedErrorCode: null,
        checkpointAdvanced: false,
        adapterInvoked: false,
        attemptCount: 0,
      };
    }

    const adapter = adapters[window.adapterKey];
    if (!adapter || typeof adapter.fetchWindow !== 'function') {
      const blocked = {
        window,
        executionStatus: WINDOW_EXECUTION_STATUSES.BLOCKED,
        qualityStatus: WINDOW_QUALITY_STATUSES.UNKNOWN,
        sanitizedErrorCode: 'ADAPTER_NOT_REGISTERED',
        checkpointAdvanced: false,
        adapterInvoked: false,
        attemptCount: 0,
      };
      await repository.recordWindowOutcome({
        backfillRunId: runRecord.backfillRunId,
        window,
        outcome: {
          executionStatus: blocked.executionStatus,
          qualityStatus: blocked.qualityStatus,
          sanitizedErrorCode: blocked.sanitizedErrorCode,
          acceptedRowCount: null,
          rejectedRowCount: null,
          expectedPageCount: null,
          observedPageCount: null,
          schemaFingerprint: null,
          sourceBusinessWatermark: null,
        },
        attemptCount: 0,
      });
      return blocked;
    }

    let attemptCount = 0;
    let outcome = null;
    let result = null;
    const maxAttempts = Math.max(1, window.maxAttempts || 1);
    while (attemptCount < maxAttempts) {
      attemptCount += 1;
      adapterInvocationCount += 1;
      try {
        result = await adapter.fetchWindow({
          storeCode: window.storeCode,
          domain: window.domain,
          windowStart: window.windowStart,
          windowEnd: window.windowEnd,
          windowKey: window.windowKey,
          maxPages: window.maxPagesPerWindow,
          maxRows: window.maxRowsPerWindow,
          attempt: attemptCount,
          checkpoint,
        });
      } catch (error) {
        result = {
          ok: false,
          adapterError: true,
          sanitizedErrorCode: sanitizedCode(error?.code, 'ADAPTER_THREW'),
        };
      }
      outcome = evaluateWindowOutcome({ window, result, checkpoint });
      if (outcome.checkpointAdvanceable) break;
      if (
        outcome.executionStatus !== WINDOW_EXECUTION_STATUSES.FAILED
        || outcome.qualityStatus !== WINDOW_QUALITY_STATUSES.ADAPTER_ERROR
      ) break;
    }

    const nextState = outcome.checkpointAdvanceable
      ? nextCheckpointState({
        window,
        outcome,
        checkpoint,
        runId: runRecord.backfillRunId,
      })
      : null;
    const persistence = await repository.commitWindowOutcome({
      backfillRunId: runRecord.backfillRunId,
      window,
      outcome,
      attemptCount,
      checkpointState: nextState,
    });
    if (persistence?.persisted !== true) {
      throw new BackfillRunError(
        'WINDOW_OUTCOME_NOT_PERSISTED',
        'execute window outcome was not durably persisted',
      );
    }
    const checkpointAdvanced = persistence?.checkpointAdvanced === true;
    if (checkpointAdvanced && nextState) checkpointIndex.set(checkpointKey, nextState);

    return {
      window,
      executionStatus: outcome.executionStatus,
      qualityStatus: outcome.qualityStatus,
      sanitizedErrorCode: outcome.sanitizedErrorCode,
      acceptedRowCount: outcome.acceptedRowCount,
      rejectedRowCount: outcome.rejectedRowCount,
      checkpointAdvanced,
      adapterInvoked: true,
      attemptCount,
    };
  }

  // Schedule per checkpoint grain.
  //
  // Two windows of the same store + domain + adapter share one checkpoint row,
  // so running them concurrently would let both compare against the same stale
  // checkpoint and miss a schema-fingerprint drift. Every grain is therefore
  // processed strictly sequentially in newest-first plan order, and bounded
  // concurrency applies only across different grains.
  const grainQueues = new Map();
  plan.windows.forEach((window, planIndex) => {
    const grainKey = `${window.storeCode}${window.domain}${window.adapterKey}`;
    const queue = grainQueues.get(grainKey) ?? [];
    queue.push({ window, planIndex });
    grainQueues.set(grainKey, queue);
  });

  const indexedResults = [];
  const grains = [...grainQueues.values()];
  let nextGrain = 0;
  const laneCount = Math.min(Math.max(1, plan.concurrency || 1), Math.max(1, grains.length));
  await Promise.all(Array.from({ length: laneCount }, async () => {
    for (;;) {
      const grainIndex = nextGrain;
      nextGrain += 1;
      if (grainIndex >= grains.length) return;
      for (const entry of grains[grainIndex]) {
        // Awaited one at a time: the next window of this grain observes the
        // checkpoint the previous window just advanced.
        const result = await processWindow(entry.window);
        indexedResults.push({ planIndex: entry.planIndex, result });
      }
    }
  }));

  windowResults.push(
    ...indexedResults
      .sort((left, right) => left.planIndex - right.planIndex)
      .map((item) => item.result),
  );

  const counts = {
    planned: 0,
    blocked: 0,
    skipped: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
  };
  for (const item of windowResults) {
    if (item.executionStatus === WINDOW_EXECUTION_STATUSES.PLANNED) counts.planned += 1;
    else if (item.executionStatus === WINDOW_EXECUTION_STATUSES.BLOCKED) counts.blocked += 1;
    else if (item.executionStatus === WINDOW_EXECUTION_STATUSES.SKIPPED) counts.skipped += 1;
    else if (item.executionStatus === WINDOW_EXECUTION_STATUSES.SUCCEEDED) counts.succeeded += 1;
    else if (item.executionStatus === WINDOW_EXECUTION_STATUSES.PARTIAL) counts.partial += 1;
    else counts.failed += 1;
  }

  let runStatus = RUN_STATUSES.PLANNED;
  if (isExecute) {
    if (counts.failed > 0 && counts.succeeded === 0 && counts.skipped === 0) {
      runStatus = RUN_STATUSES.FAILED;
    } else if (counts.failed > 0 || counts.partial > 0 || counts.blocked > 0) {
      runStatus = RUN_STATUSES.PARTIAL;
    } else {
      runStatus = RUN_STATUSES.SUCCEEDED;
    }
  }

  const completedAt = clock();
  if (isExecute) {
    await repository.closeRun({
      backfillRunId: runRecord.backfillRunId,
      status: runStatus,
      completedAt,
      sanitizedErrorCode: runStatus === RUN_STATUSES.SUCCEEDED
        ? null
        : windowResults.find((item) => item.sanitizedErrorCode)?.sanitizedErrorCode ?? null,
    });
  }

  return Object.freeze({
    mode,
    planHash: plan.planHash,
    backfillRunId: runRecord.backfillRunId,
    runStatus,
    authorization,
    adapterInvocationCount,
    counts: Object.freeze(counts),
    checkpointAdvancedCount: windowResults.filter((item) => item.checkpointAdvanced).length,
    blockedReasonCodes: Object.freeze([...new Set(
      windowResults
        .filter((item) => item.executionStatus === WINDOW_EXECUTION_STATUSES.BLOCKED)
        .map((item) => item.sanitizedErrorCode),
    )].sort()),
    windows: Object.freeze(windowResults.map((item) => Object.freeze({
      storeCode: item.window.storeCode,
      domain: item.window.domain,
      adapterKey: item.window.adapterKey,
      capabilityStatus: item.window.capabilityStatus,
      windowStart: item.window.windowStart,
      windowEnd: item.window.windowEnd,
      windowKey: item.window.windowKey,
      executionStatus: item.executionStatus,
      qualityStatus: item.qualityStatus,
      sanitizedErrorCode: item.sanitizedErrorCode,
      attemptCount: item.attemptCount,
      adapterInvoked: item.adapterInvoked,
      checkpointAdvanced: item.checkpointAdvanced,
      acceptedRowCount: item.acceptedRowCount ?? null,
      rejectedRowCount: item.rejectedRowCount ?? null,
    }))),
  });
}
