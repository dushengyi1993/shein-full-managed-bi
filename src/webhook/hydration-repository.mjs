const SUPPORTED_DIRECTIVES = Object.freeze([
  'PURCHASE_ORDER_READBACK',
  'DELIVERY_READBACK',
]);

function requiredText(value, label, maximum = 200) {
  const result = String(value ?? '').trim();
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return result;
}

function integer(value, label, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
  return result;
}

function safeError(value, fallback) {
  const normalized = String(value ?? fallback).toUpperCase();
  return /^[A-Z0-9_]{1,80}$/.test(normalized) ? normalized : fallback;
}

function mapDirective(row) {
  const lookup = row.lookup_projection && typeof row.lookup_projection === 'object'
    ? row.lookup_projection
    : {};
  return Object.freeze({
    directiveId: String(row.hydration_directive_id),
    storeCode: row.store_code,
    directiveType: row.directive_type,
    capabilityCode: row.capability_code,
    lookup: Object.freeze({ ...lookup }),
    attemptCount: Number(row.attempt_count),
  });
}

export function webhookHydrationRetryDelayMs(attemptCount) {
  const attempt = integer(attemptCount, 'attemptCount', { minimum: 1, maximum: 100 });
  return Math.min(60 * 60_000, 10_000 * (2 ** Math.min(attempt - 1, 10)));
}

export function createWebhookHydrationRepository({ pool } = {}) {
  if (!pool?.query) throw new TypeError('A PostgreSQL pool is required.');

  async function claimBatch({ workerId, leaseMs = 10 * 60_000, limit = 100 } = {}) {
    const owner = requiredText(workerId, 'workerId');
    const lease = integer(leaseMs, 'leaseMs', { minimum: 30_000, maximum: 30 * 60_000 });
    const batchLimit = integer(limit, 'limit', { minimum: 1, maximum: 200 });
    const result = await pool.query(`
      WITH exhausted AS (
        UPDATE ops.webhook_hydration_directive
           SET state = 'FAILED',
               lease_owner = '',
               lease_expires_at = NULL,
               completed_at = clock_timestamp(),
               last_error_code = 'HYDRATION_ATTEMPTS_EXHAUSTED',
               last_error_message = 'Read-only hydration exhausted its bounded attempts.',
               updated_at = clock_timestamp()
         WHERE state = 'RUNNING'
           AND lease_expires_at <= clock_timestamp()
           AND attempt_count >= 8
      ), candidate AS (
        SELECT hydration_directive_id
          FROM ops.webhook_hydration_directive
         WHERE directive_type = ANY($3::text[])
           AND attempt_count < 8
           AND (
             (state IN ('PENDING', 'RETRY') AND available_at <= clock_timestamp())
             OR (state = 'RUNNING' AND lease_expires_at <= clock_timestamp())
           )
         ORDER BY available_at, hydration_directive_id
         FOR UPDATE SKIP LOCKED
         LIMIT $4
      ), claimed AS (
        UPDATE ops.webhook_hydration_directive directive
           SET state = 'RUNNING',
               attempt_count = attempt_count + 1,
               lease_owner = $1,
               lease_expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
               last_error_code = '',
               last_error_message = '',
               updated_at = clock_timestamp()
          FROM candidate
         WHERE directive.hydration_directive_id = candidate.hydration_directive_id
        RETURNING directive.*
      )
      SELECT claimed.*, store.store_code
        FROM claimed
        JOIN dim.store store ON store.store_id = claimed.store_id
       ORDER BY claimed.hydration_directive_id
    `, [owner, lease, SUPPORTED_DIRECTIVES, batchLimit]);
    return Object.freeze((result.rows ?? []).map(mapDirective));
  }

  async function complete(ids, { workerId } = {}) {
    const owner = requiredText(workerId, 'workerId');
    const identifiers = ids.map((id) => integer(id, 'directiveId'));
    if (identifiers.length === 0) return 0;
    const result = await pool.query(`
      UPDATE ops.webhook_hydration_directive
         SET state = 'SUCCEEDED',
             lease_owner = '',
             lease_expires_at = NULL,
             completed_at = clock_timestamp(),
             last_error_code = '',
             last_error_message = '',
             updated_at = clock_timestamp()
       WHERE hydration_directive_id = ANY($1::bigint[])
         AND state = 'RUNNING'
         AND lease_owner = $2
    `, [identifiers, owner]);
    if (result.rowCount !== identifiers.length) throw new Error('HYDRATION_LEASE_LOST');
    return result.rowCount;
  }

  async function fail(ids, {
    workerId,
    attemptCount,
    errorCode,
    retryDelayMs,
  } = {}) {
    const owner = requiredText(workerId, 'workerId');
    const identifiers = ids.map((id) => integer(id, 'directiveId'));
    if (identifiers.length === 0) return 0;
    const attempt = integer(attemptCount, 'attemptCount', { minimum: 1, maximum: 100 });
    const delay = integer(retryDelayMs, 'retryDelayMs', {
      minimum: 1_000,
      maximum: 60 * 60_000,
    });
    const terminal = attempt >= 8;
    const result = await pool.query(`
      UPDATE ops.webhook_hydration_directive
         SET state = $3,
             available_at = CASE
               WHEN $3 = 'RETRY'
                 THEN clock_timestamp() + ($4::bigint * interval '1 millisecond')
               ELSE available_at
             END,
             lease_owner = '',
             lease_expires_at = NULL,
             completed_at = CASE WHEN $3 = 'FAILED' THEN clock_timestamp() ELSE NULL END,
             last_error_code = $5,
             last_error_message = $6,
             updated_at = clock_timestamp()
       WHERE hydration_directive_id = ANY($1::bigint[])
         AND state = 'RUNNING'
         AND lease_owner = $2
    `, [
      identifiers,
      owner,
      terminal ? 'FAILED' : 'RETRY',
      delay,
      safeError(errorCode, 'HYDRATION_FAILED'),
      terminal
        ? 'Read-only hydration failed after bounded retries.'
        : 'Read-only hydration will retry after a bounded delay.',
    ]);
    if (result.rowCount !== identifiers.length) throw new Error('HYDRATION_LEASE_LOST');
    return result.rowCount;
  }

  return Object.freeze({ claimBatch, complete, fail });
}

export { SUPPORTED_DIRECTIVES };
