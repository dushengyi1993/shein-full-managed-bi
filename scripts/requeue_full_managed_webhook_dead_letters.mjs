#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

const REPLAYABLE_EVENT_CODES = Object.freeze(['3001435', '3001441']);
const REPLAYABLE_ERROR_CODES = Object.freeze([
  'WEBHOOK_PAYLOAD_INVALID',
  'WEBHOOK_PROCESSING_FAILED',
]);

export async function requeueWebhookDeadLetters({
  databaseUrl,
  execute = false,
  poolFactory = (connectionString) => new Pool({ connectionString, max: 1 }),
} = {}) {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new TypeError('FULL_BI_DATABASE_URL is required.');
  }
  const pool = poolFactory(databaseUrl);
  try {
    const candidate = await pool.query(`
      SELECT count(*)::integer AS candidate_count
        FROM ops.webhook_job job
        JOIN raw.webhook_receipt receipt ON receipt.receipt_id = job.receipt_id
        LEFT JOIN ops.operational_event event ON event.receipt_id = receipt.receipt_id
       WHERE job.status IN ('DEAD_LETTER', 'RETRY')
         AND receipt.event_code = ANY($1::text[])
         AND job.last_error_code = ANY($2::text[])
         AND event.operational_event_id IS NULL
    `, [REPLAYABLE_EVENT_CODES, REPLAYABLE_ERROR_CODES]);
    const candidateCount = Number(candidate.rows?.[0]?.candidate_count ?? 0);
    if (!execute || candidateCount === 0) {
      return Object.freeze({ ok: true, execute, candidateCount, requeuedCount: 0 });
    }
    const requeued = await pool.query(`
      WITH candidates AS (
        SELECT job.job_id
          FROM ops.webhook_job job
          JOIN raw.webhook_receipt receipt ON receipt.receipt_id = job.receipt_id
          LEFT JOIN ops.operational_event event ON event.receipt_id = receipt.receipt_id
         WHERE job.status IN ('DEAD_LETTER', 'RETRY')
           AND receipt.event_code = ANY($1::text[])
           AND job.last_error_code = ANY($2::text[])
           AND event.operational_event_id IS NULL
         FOR UPDATE OF job
      )
      UPDATE ops.webhook_job job
         SET status = 'RETRY',
             attempt_count = 0,
             available_at = clock_timestamp(),
             lease_owner = '',
             lease_expires_at = NULL,
             last_error_code = '',
             last_error_message = '',
             completed_at = NULL,
             updated_at = clock_timestamp()
        FROM candidates
       WHERE job.job_id = candidates.job_id
      RETURNING job.job_id
    `, [REPLAYABLE_EVENT_CODES, REPLAYABLE_ERROR_CODES]);
    return Object.freeze({
      ok: true,
      execute: true,
      candidateCount,
      requeuedCount: requeued.rowCount,
    });
  } finally {
    await pool.end();
  }
}

export function isReplayEntrypoint(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    const candidate = argv1 instanceof URL ? fileURLToPath(argv1) : argv1;
    return realpathSync(path.resolve(candidate)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isReplayEntrypoint()) {
  requeueWebhookDeadLetters({
    databaseUrl: process.env.FULL_BI_DATABASE_URL ?? process.env.DATABASE_URL,
    execute: process.argv.includes('--execute'),
  })
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error) => {
      console.error(JSON.stringify({
        ok: false,
        errorCode: String(error?.code ?? 'WEBHOOK_REPLAY_FAILED').slice(0, 80),
        error: 'Webhook dead-letter replay failed.',
      }));
      process.exitCode = 1;
    });
}

export { REPLAYABLE_ERROR_CODES, REPLAYABLE_EVENT_CODES };
