const SANITIZED_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,60}$/;

function sanitized(value) {
  if (value === null || value === undefined) return null;
  const candidate = String(value).trim().toUpperCase();
  return SANITIZED_CODE_PATTERN.test(candidate) ? candidate : 'UNSPECIFIED_ERROR';
}

function timestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
  }
  return null;
}

function dateText(value) {
  if (value instanceof Date) {
    // node-postgres parses a PostgreSQL DATE as local midnight. Converting that
    // value to UTC first moves it to the previous calendar day on the
    // Asia/Shanghai production host and makes an exact plan replay look like
    // scope drift. Read the local calendar fields instead; DATE has no timezone.
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value ?? '').slice(0, 10);
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const result = await callback(client);
    await client.query('COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function upsertWindow(client, {
  backfillRunId,
  window,
  outcome,
  attemptCount,
}) {
  const result = await client.query(
    `INSERT INTO ops.backfill_window (
         backfill_run_id, store_code, domain, adapter_key,
         window_start, window_end, window_key, capability_status,
         execution_status, quality_status, attempt_count,
         accepted_row_count, rejected_row_count,
         expected_page_count, observed_page_count,
         source_business_watermark, schema_fingerprint, sanitized_error_code
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18
     )
     ON CONFLICT (
       backfill_run_id, store_code, domain, adapter_key, window_start, window_end
     )
     DO UPDATE SET
         execution_status = EXCLUDED.execution_status,
         quality_status = EXCLUDED.quality_status,
         attempt_count = ops.backfill_window.attempt_count + EXCLUDED.attempt_count,
         accepted_row_count = EXCLUDED.accepted_row_count,
         rejected_row_count = EXCLUDED.rejected_row_count,
         expected_page_count = EXCLUDED.expected_page_count,
         observed_page_count = EXCLUDED.observed_page_count,
         source_business_watermark = EXCLUDED.source_business_watermark,
         schema_fingerprint = EXCLUDED.schema_fingerprint,
         sanitized_error_code = EXCLUDED.sanitized_error_code,
         updated_at = clock_timestamp()
     RETURNING backfill_window_id`,
    [
      backfillRunId,
      window.storeCode,
      window.domain,
      window.adapterKey,
      window.windowStart,
      window.windowEnd,
      window.windowKey,
      window.capabilityStatus,
      outcome.executionStatus,
      outcome.qualityStatus,
      attemptCount ?? 0,
      outcome.acceptedRowCount,
      outcome.rejectedRowCount,
      outcome.expectedPageCount,
      outcome.observedPageCount,
      outcome.sourceBusinessWatermark,
      outcome.schemaFingerprint,
      sanitized(outcome.sanitizedErrorCode),
    ],
  );
  return Number(result.rows[0].backfill_window_id);
}

/**
 * Persistence for the backfill control plane.
 *
 * A successful window and its optional forward checkpoint projection commit in
 * one transaction. A crash can therefore never leave a window marked complete
 * while losing the checkpoint update that belonged to the same transaction.
 */
export function createBackfillRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('createBackfillRepository requires a pg pool');
  }

  return Object.freeze({
    async openRun(request) {
      const startedAt = timestamp(request.startedAt);
      if (startedAt === null) {
        const error = new TypeError('openRun requires a valid start instant');
        error.code = 'BACKFILL_RUN_START_INSTANT_INVALID';
        throw error;
      }
      return withTransaction(pool, async (client) => {
        const inserted = await client.query(
          // created_at and started_at are the same validated instant. Letting the
          // column default fire would stamp a later clock_timestamp() and could
          // violate ck_ops_backfill_run_timeline (started_at >= created_at).
          `INSERT INTO ops.backfill_run (
               plan_hash, mode, status, requested_domains, requested_store_codes,
               requested_from, requested_to, window_span_days,
               planned_window_count, created_by, created_at, started_at
           )
           VALUES ($1, 'EXECUTE', 'RUNNING', $2, $3, $4, $5, $6, $7, $8, $9, $9)
           ON CONFLICT (plan_hash) WHERE mode = 'EXECUTE' DO NOTHING
           RETURNING backfill_run_id, status`,
          [
            request.planHash,
            request.requestedDomains,
            request.requestedStoreCodes,
            request.requestedFrom,
            request.requestedTo,
            request.windowSpanDays,
            request.plannedWindowCount,
            request.createdBy,
            startedAt,
          ],
        );
        if (inserted.rows.length === 1) {
          return {
            backfillRunId: Number(inserted.rows[0].backfill_run_id),
            resumed: false,
            status: inserted.rows[0].status,
          };
        }
        const existing = await client.query(
          `SELECT backfill_run_id, status, requested_domains,
                  requested_store_codes, requested_from, requested_to,
                  window_span_days, planned_window_count, created_by
             FROM ops.backfill_run
            WHERE plan_hash = $1
              AND mode = 'EXECUTE'
            FOR UPDATE`,
          [request.planHash],
        );
        if (existing.rows.length !== 1) {
          const error = new Error('execute run conflict readback is missing');
          error.code = 'BACKFILL_RUN_READBACK_MISSING';
          throw error;
        }
        const row = existing.rows[0];
        const sameScope = (
          JSON.stringify(row.requested_domains) === JSON.stringify(request.requestedDomains)
          && JSON.stringify(row.requested_store_codes) === JSON.stringify(request.requestedStoreCodes)
          && dateText(row.requested_from) === request.requestedFrom
          && dateText(row.requested_to) === request.requestedTo
          && Number(row.window_span_days) === request.windowSpanDays
          && Number(row.planned_window_count) === request.plannedWindowCount
        );
        if (!sameScope) {
          const error = new Error('execute run plan hash was replayed with scope drift');
          error.code = 'BACKFILL_RUN_REPLAY_DRIFT';
          throw error;
        }
        return {
          backfillRunId: Number(row.backfill_run_id),
          resumed: true,
          status: row.status,
        };
      });
    },

    async loadCompletedWindowKeys({ planHash }) {
      const result = await pool.query(
        `SELECT w.window_key
           FROM ops.backfill_window AS w
           JOIN ops.backfill_run AS r ON r.backfill_run_id = w.backfill_run_id
          WHERE r.plan_hash = $1
            AND r.mode = 'EXECUTE'
            AND w.execution_status = 'SUCCEEDED'
            AND w.quality_status = 'PASSED'`,
        [planHash],
      );
      return result.rows.map((row) => row.window_key);
    },

    async loadCheckpoints({ storeCodes, domains }) {
      const result = await pool.query(
        `SELECT store_code, domain, adapter_key, last_completed_business_date,
                last_source_cursor, schema_fingerprint, quality_status,
                capability_status
           FROM ops.backfill_checkpoint
          WHERE store_code = ANY($1)
            AND domain = ANY($2)`,
        [storeCodes, domains],
      );
      return result.rows.map((row) => ({
        storeCode: row.store_code,
        domain: row.domain,
        adapterKey: row.adapter_key,
        lastCompletedBusinessDate: dateText(row.last_completed_business_date),
        lastSourceCursor: row.last_source_cursor,
        schemaFingerprint: row.schema_fingerprint,
        qualityStatus: row.quality_status,
        capabilityStatus: row.capability_status,
      }));
    },

    async commitWindowOutcome({
      backfillRunId,
      window,
      outcome,
      attemptCount,
      checkpointState = null,
    }) {
      return withTransaction(pool, async (client) => {
        const backfillWindowId = await upsertWindow(client, {
          backfillRunId,
          window,
          outcome,
          attemptCount,
        });
        let checkpointAdvanced = false;
        if (checkpointState !== null) {
          const checkpoint = await client.query(
            `INSERT INTO ops.backfill_checkpoint (
                 store_code, domain, adapter_key,
                 last_completed_business_date, last_source_cursor,
                 last_successful_run_id, last_successful_window_id,
                 schema_fingerprint, quality_status, capability_status,
                 last_successful_window_execution_status
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PASSED', 'VERIFIED', 'SUCCEEDED')
             ON CONFLICT (store_code, domain, adapter_key)
             DO UPDATE SET
                 last_completed_business_date = EXCLUDED.last_completed_business_date,
                 last_source_cursor = EXCLUDED.last_source_cursor,
                 last_successful_run_id = EXCLUDED.last_successful_run_id,
                 last_successful_window_id = EXCLUDED.last_successful_window_id,
                 schema_fingerprint = EXCLUDED.schema_fingerprint,
                 quality_status = 'PASSED',
                 capability_status = 'VERIFIED',
                 last_successful_window_execution_status = 'SUCCEEDED',
                 updated_at = clock_timestamp()
             WHERE ops.backfill_checkpoint.last_completed_business_date
                     < EXCLUDED.last_completed_business_date
             RETURNING backfill_checkpoint_id`,
            [
              checkpointState.storeCode,
              checkpointState.domain,
              checkpointState.adapterKey,
              checkpointState.lastCompletedBusinessDate,
              checkpointState.lastSourceCursor,
              checkpointState.lastSuccessfulRunId,
              backfillWindowId,
              checkpointState.schemaFingerprint,
            ],
          );
          checkpointAdvanced = checkpoint.rows.length === 1;
        }
        return {
          persisted: true,
          backfillWindowId,
          checkpointAdvanced,
        };
      });
    },

    async recordWindowOutcome(input) {
      return this.commitWindowOutcome({ ...input, checkpointState: null });
    },

    async closeRun({ backfillRunId, status, completedAt, sanitizedErrorCode }) {
      const closedAt = timestamp(completedAt);
      if (closedAt === null) {
        const error = new TypeError('closeRun requires a valid completion instant');
        error.code = 'BACKFILL_RUN_COMPLETION_INSTANT_INVALID';
        throw error;
      }
      const result = await pool.query(
        `UPDATE ops.backfill_run
            SET status = $2,
                completed_at = $3,
                sanitized_error_code = $4
          WHERE backfill_run_id = $1
            AND mode = 'EXECUTE'
          RETURNING backfill_run_id`,
        [backfillRunId, status, closedAt, sanitized(sanitizedErrorCode)],
      );
      // Exactly one execute run must close. Zero rows means the run id was wrong
      // or the row is not an EXECUTE run, which is a fail-closed condition.
      if (result.rows.length !== 1) {
        const error = new Error('execute run could not be closed');
        error.code = 'BACKFILL_RUN_CLOSE_MISSING';
        throw error;
      }
      return { closed: true, backfillRunId: Number(result.rows[0].backfill_run_id) };
    },
  });
}
