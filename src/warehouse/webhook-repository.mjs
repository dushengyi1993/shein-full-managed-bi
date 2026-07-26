import crypto from 'node:crypto';

const JOB_STATUSES = new Set([
  'QUEUED',
  'RUNNING',
  'RETRY',
  'SUCCEEDED',
  'QUARANTINED',
  'DEAD_LETTER',
]);
const SENSITIVE_KEY = /(?:secret|token|password|authorization|cookie|eventdata|ciphertext|openkey|appid)/i;

export class WebhookRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebhookRepositoryError';
    this.code = code;
  }
}

function requiredText(value, label, maximum = 512) {
  const result = String(value ?? '').trim();
  if (!result) throw new WebhookRepositoryError('WEBHOOK_VALIDATION', `${label} is required.`);
  if (result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new WebhookRepositoryError('WEBHOOK_VALIDATION', `${label} is invalid.`);
  }
  return result;
}

function optionalText(value, maximum = 512) {
  const result = String(value ?? '').trim();
  if (!result) return '';
  if (result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new WebhookRepositoryError('WEBHOOK_VALIDATION', 'Optional text is invalid.');
  }
  return result;
}

function hash(value, label) {
  const result = requiredText(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) {
    throw new WebhookRepositoryError('WEBHOOK_VALIDATION', `${label} must be SHA-256 hex.`);
  }
  return result;
}

function instant(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new WebhookRepositoryError('WEBHOOK_VALIDATION', `${label} must be a valid timestamp.`);
  }
  return date.toISOString();
}

function positiveInteger(value, label, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new WebhookRepositoryError('WEBHOOK_VALIDATION', `${label} is invalid.`);
  }
  return result;
}

function safeJson(value, label, maximumBytes = 16 * 1024) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebhookRepositoryError('WEBHOOK_VALIDATION', `${label} must be an object.`);
  }
  const queue = [value];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (seen.size > 512) {
      throw new WebhookRepositoryError('WEBHOOK_VALIDATION', `${label} is too complex.`);
    }
    for (const [key, item] of Object.entries(current)) {
      if (SENSITIVE_KEY.test(key)) {
        throw new WebhookRepositoryError('WEBHOOK_VALIDATION', `${label} contains a forbidden key.`);
      }
      if (item && typeof item === 'object') queue.push(item);
    }
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new WebhookRepositoryError('WEBHOOK_VALIDATION', `${label} is not serializable.`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new WebhookRepositoryError('WEBHOOK_VALIDATION', `${label} is too large.`);
  }
  return serialized;
}

function rowCount(result) {
  return Number(result?.rowCount ?? result?.rows?.length ?? 0);
}

function fingerprint(parts) {
  return crypto
    .createHash('sha256')
    .update(parts.join('\u001f'), 'utf8')
    .digest('hex');
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

function mapJob(row) {
  if (!row) return null;
  return {
    jobId: String(row.job_id),
    receiptId: String(row.receipt_id),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
    appKeyHash: row.app_key_hash,
    openKeyHash: row.open_key_hash ?? '',
    eventCode: row.event_code ?? '',
    eventPath: row.event_path ?? '',
    storeCode: row.store_code ?? null,
    deliveryScope: row.delivery_scope,
    platformTimestamp: new Date(row.platform_timestamp).toISOString(),
    cipherSha256: row.cipher_sha256,
    ciphertext: row.ciphertext,
    safeProjection: typeof row.safe_projection === 'string'
      ? JSON.parse(row.safe_projection)
      : row.safe_projection,
    receivedAt: new Date(row.received_at).toISOString(),
  };
}

export function createFullManagedWebhookRepository({ pool } = {}) {
  if (!pool?.connect) throw new TypeError('A PostgreSQL pool is required.');

  async function storeReceiptAndJob(input = {}) {
    const idempotencyKey = hash(input.idempotencyKey, 'idempotencyKey');
    const appKeyHash = hash(input.appKeyHash, 'appKeyHash');
    const openKeyHash = input.openKeyHash ? hash(input.openKeyHash, 'openKeyHash') : '';
    const cipherSha256 = hash(input.cipherSha256, 'cipherSha256');
    const eventCode = optionalText(input.eventCode, 40);
    const eventPath = optionalText(input.eventPath, 180);
    if (!eventCode && !eventPath) {
      throw new WebhookRepositoryError(
        'WEBHOOK_VALIDATION',
        'eventCode or eventPath is required.',
      );
    }
    const storeCode = input.storeCode ? requiredText(input.storeCode, 'storeCode', 32) : null;
    const deliveryScope = requiredText(input.deliveryScope, 'deliveryScope', 16).toUpperCase();
    if (!['STORE', 'APP_ONLY'].includes(deliveryScope)) {
      throw new WebhookRepositoryError('WEBHOOK_VALIDATION', 'deliveryScope is invalid.');
    }
    if ((deliveryScope === 'STORE') !== Boolean(storeCode)) {
      throw new WebhookRepositoryError(
        'WEBHOOK_VALIDATION',
        'Store delivery scope and storeCode disagree.',
      );
    }
    const platformTimestamp = instant(input.platformTimestamp, 'platformTimestamp');
    const ciphertext = requiredText(input.ciphertext, 'ciphertext', 2 * 1024 * 1024);
    const projection = safeJson(input.safeProjection, 'safeProjection', 4 * 1024);
    const statementTimeoutMs = positiveInteger(
      input.statementTimeoutMs ?? 800,
      'statementTimeoutMs',
      { minimum: 50, maximum: 800 },
    );

    return transaction(pool, async (client) => {
      await client.query(
        "SELECT set_config('statement_timeout', $1::text, true)",
        [`${statementTimeoutMs}ms`],
      );
      let storeId = null;
      if (storeCode) {
        const store = await client.query(
          `SELECT store_id
             FROM dim.store
            WHERE store_code = $1
              AND is_active = true`,
          [storeCode],
        );
        if (rowCount(store) !== 1) {
          throw new WebhookRepositoryError(
            'WEBHOOK_STORE_UNAVAILABLE',
            'The webhook store is not active in the warehouse.',
          );
        }
        storeId = store.rows[0].store_id;
      }

      const receipt = await client.query(
        `INSERT INTO raw.webhook_receipt (
           idempotency_key, app_key_hash, open_key_hash, event_code, event_path,
           store_id, delivery_scope, platform_timestamp, cipher_sha256,
           ciphertext, safe_projection
         ) VALUES (
           $1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
           $6, $7, $8::timestamptz, $9, $10, $11::jsonb
         )
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING receipt_id`,
        [
          idempotencyKey,
          appKeyHash,
          openKeyHash,
          eventCode,
          eventPath,
          storeId,
          deliveryScope,
          platformTimestamp,
          cipherSha256,
          ciphertext,
          projection,
        ],
      );
      if (rowCount(receipt) === 0) {
        const existing = await client.query(
          `SELECT receipt_id, app_key_hash, open_key_hash, event_code, event_path,
                  store_id, delivery_scope, cipher_sha256
             FROM raw.webhook_receipt
            WHERE idempotency_key = $1
            FOR UPDATE`,
          [idempotencyKey],
        );
        if (rowCount(existing) !== 1) {
          throw new WebhookRepositoryError(
            'WEBHOOK_STORAGE_FAILED',
            'Webhook receipt conflict could not be read back.',
          );
        }
        const row = existing.rows[0];
        if (
          row.app_key_hash !== appKeyHash
          || (row.open_key_hash ?? '') !== openKeyHash
          || (row.event_code ?? '') !== eventCode
          || (row.event_path ?? '') !== eventPath
          || String(row.store_id ?? '') !== String(storeId ?? '')
          || row.delivery_scope !== deliveryScope
          || row.cipher_sha256 !== cipherSha256
        ) {
          throw new WebhookRepositoryError(
            'WEBHOOK_IDEMPOTENCY_COLLISION',
            'Webhook idempotency key was reused with different immutable data.',
          );
        }
        const duplicate = await client.query(
          `UPDATE raw.webhook_receipt
              SET duplicate_count = duplicate_count + 1,
                  last_duplicate_at = clock_timestamp()
            WHERE receipt_id = $1`,
          [row.receipt_id],
        );
        if (rowCount(duplicate) !== 1) {
          throw new WebhookRepositoryError(
            'WEBHOOK_STORAGE_FAILED',
            'Webhook duplicate evidence was not persisted.',
          );
        }
        return { receiptId: String(row.receipt_id), duplicate: true };
      }
      if (rowCount(receipt) !== 1) {
        throw new WebhookRepositoryError(
          'WEBHOOK_STORAGE_FAILED',
          'Webhook receipt was not persisted.',
        );
      }
      const receiptId = receipt.rows[0].receipt_id;
      const job = await client.query(
        `INSERT INTO ops.webhook_job (receipt_id, status, max_attempts)
         VALUES ($1, 'QUEUED', 8)
         RETURNING job_id`,
        [receiptId],
      );
      if (rowCount(job) !== 1) {
        throw new WebhookRepositoryError(
          'WEBHOOK_STORAGE_FAILED',
          'Webhook job was not persisted.',
        );
      }
      return { receiptId: String(receiptId), duplicate: false };
    });
  }

  async function claimNextJob({ workerId, leaseMs = 120_000 } = {}) {
    const owner = requiredText(workerId, 'workerId', 200);
    const lease = positiveInteger(leaseMs, 'leaseMs', {
      minimum: 5_000,
      maximum: 15 * 60_000,
    });
    return transaction(pool, async (client) => {
      const result = await client.query(
        `WITH exhausted AS (
           UPDATE ops.webhook_job
              SET status = 'DEAD_LETTER',
                  lease_owner = '',
                  lease_expires_at = NULL,
                  completed_at = clock_timestamp(),
                  last_error_code = 'WEBHOOK_LEASE_EXHAUSTED',
                  last_error_message = 'Worker lease expired after the final processing attempt.',
                  updated_at = clock_timestamp()
            WHERE status = 'RUNNING'
              AND lease_expires_at <= clock_timestamp()
              AND attempt_count >= max_attempts
            RETURNING job_id
         ),
         candidate AS (
           SELECT job_id
             FROM ops.webhook_job
            WHERE (
                    status IN ('QUEUED', 'RETRY')
                    AND available_at <= clock_timestamp()
                    AND attempt_count < max_attempts
                  )
               OR (
                    status = 'RUNNING'
                    AND lease_expires_at <= clock_timestamp()
                    AND attempt_count < max_attempts
                  )
            ORDER BY available_at, job_id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         ),
         claimed AS (
           UPDATE ops.webhook_job AS job
              SET status = 'RUNNING',
                  lease_owner = $1,
                  lease_expires_at = clock_timestamp()
                    + ($2::bigint * interval '1 millisecond'),
                  attempt_count = job.attempt_count + 1,
                  updated_at = clock_timestamp()
             FROM candidate
            WHERE job.job_id = candidate.job_id
            RETURNING job.*
         )
         SELECT claimed.*, receipt.idempotency_key, receipt.app_key_hash,
                receipt.open_key_hash, receipt.event_code, receipt.event_path,
                receipt.delivery_scope, receipt.platform_timestamp,
                receipt.cipher_sha256, receipt.ciphertext,
                receipt.safe_projection, receipt.received_at,
                store.store_code
           FROM claimed
           JOIN raw.webhook_receipt AS receipt
             ON receipt.receipt_id = claimed.receipt_id
           LEFT JOIN dim.store AS store
             ON store.store_id = receipt.store_id`,
        [owner, lease],
      );
      return mapJob(result.rows?.[0]);
    });
  }

  async function renewJobLease({ jobId, workerId, leaseMs = 120_000 } = {}) {
    const result = await pool.query(
      `UPDATE ops.webhook_job
          SET lease_expires_at = clock_timestamp()
                + ($3::bigint * interval '1 millisecond'),
              updated_at = clock_timestamp()
        WHERE job_id = $1
          AND status = 'RUNNING'
          AND lease_owner = $2
        RETURNING job_id`,
      [
        positiveInteger(jobId, 'jobId'),
        requiredText(workerId, 'workerId', 200),
        positiveInteger(leaseMs, 'leaseMs', {
          minimum: 5_000,
          maximum: 15 * 60_000,
        }),
      ],
    );
    if (rowCount(result) !== 1) {
      throw new WebhookRepositoryError(
        'WEBHOOK_LEASE_LOST',
        'Webhook worker no longer owns the job lease.',
      );
    }
    return true;
  }

  async function completeJob({
    jobId,
    workerId,
    normalized,
    hydrationDirective = null,
    closeAuthorizationGate = false,
    quarantined = false,
  } = {}) {
    const identifier = positiveInteger(jobId, 'jobId');
    const owner = requiredText(workerId, 'workerId', 200);
    const normalizedJson = safeJson(normalized, 'normalized', 32 * 1024);
    const directiveJson = hydrationDirective
      ? safeJson(hydrationDirective, 'hydrationDirective', 8 * 1024)
      : null;
    return transaction(pool, async (client) => {
      const lease = await client.query(
        `SELECT job.job_id, job.receipt_id, receipt.store_id
           FROM ops.webhook_job AS job
           JOIN raw.webhook_receipt AS receipt
             ON receipt.receipt_id = job.receipt_id
          WHERE job.job_id = $1
            AND job.status = 'RUNNING'
            AND job.lease_owner = $2
            AND job.lease_expires_at > clock_timestamp()
          FOR UPDATE OF job`,
        [identifier, owner],
      );
      if (rowCount(lease) !== 1) {
        throw new WebhookRepositoryError(
          'WEBHOOK_LEASE_LOST',
          'Webhook worker no longer owns the job lease.',
        );
      }
      const { receipt_id: receiptId, store_id: storeId } = lease.rows[0];
      if (closeAuthorizationGate && !storeId) {
        throw new WebhookRepositoryError(
          'WEBHOOK_GATE_SCOPE_INVALID',
          'An app-only webhook may not change a store gate.',
        );
      }

      const event = await client.query(
        `INSERT INTO ops.operational_event (
           receipt_id, store_id, event_code, event_path, event_family,
           business_type, business_key, occurred_at, action, platform_status,
           severity, delivery_scope, safe_projection
         )
         SELECT receipt.receipt_id, receipt.store_id,
                NULLIF($2, ''), NULLIF($3, ''), $4, $5, NULLIF($6, ''),
                $7::timestamptz, $8, NULLIF($9, ''), $10,
                receipt.delivery_scope, $11::jsonb
           FROM raw.webhook_receipt AS receipt
          WHERE receipt.receipt_id = $1
         ON CONFLICT (receipt_id) DO UPDATE
           SET safe_projection = EXCLUDED.safe_projection,
               updated_at = clock_timestamp()
         RETURNING operational_event_id`,
        [
          receiptId,
          optionalText(normalized.eventCode, 40),
          optionalText(normalized.eventPath, 180),
          requiredText(normalized.eventFamily, 'normalized.eventFamily', 80),
          requiredText(normalized.businessType, 'normalized.businessType', 80),
          optionalText(normalized.businessKey, 240),
          normalized.occurredAt ? instant(normalized.occurredAt, 'normalized.occurredAt') : null,
          requiredText(normalized.action, 'normalized.action', 80),
          optionalText(normalized.status, 80),
          requiredText(normalized.severity, 'normalized.severity', 8),
          normalizedJson,
        ],
      );
      const operationalEventId = event.rows[0].operational_event_id;

      if (hydrationDirective) {
        await client.query(
          `INSERT INTO ops.webhook_hydration_directive (
             operational_event_id, store_id, directive_type,
             capability_code, lookup_projection, state
           ) VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING')
           ON CONFLICT (operational_event_id) DO NOTHING`,
          [
            operationalEventId,
            storeId,
            requiredText(hydrationDirective.directiveType, 'directiveType', 100),
            requiredText(hydrationDirective.capabilityCode, 'capabilityCode', 100),
            safeJson(hydrationDirective.lookup ?? {}, 'hydrationDirective.lookup', 4 * 1024),
          ],
        );
      }

      if (closeAuthorizationGate) {
        await client.query(
          `INSERT INTO ops.webhook_store_gate (
             store_id, gate_key, state, reason_code, source_operational_event_id,
             blocked_at, recovery_requires_probe
           ) VALUES (
             $1, 'AUTHORIZATION', 'BLOCKED', 'AUTHORIZATION_CHANGE_EVENT',
             $2, clock_timestamp(), true
           )
           ON CONFLICT (store_id, gate_key) DO UPDATE
             SET state = 'BLOCKED',
                 reason_code = 'AUTHORIZATION_CHANGE_EVENT',
                 source_operational_event_id = EXCLUDED.source_operational_event_id,
                 blocked_at = clock_timestamp(),
                 reopened_at = NULL,
                 last_probe_id = NULL,
                 recovery_requires_probe = true,
                 updated_at = clock_timestamp()`,
          [storeId, operationalEventId],
        );
      }

      const finalStatus = quarantined ? 'QUARANTINED' : 'SUCCEEDED';
      const completed = await client.query(
        `UPDATE ops.webhook_job
            SET status = $3,
                lease_owner = '',
                lease_expires_at = NULL,
                completed_at = clock_timestamp(),
                updated_at = clock_timestamp(),
                last_error_code = '',
                last_error_message = ''
          WHERE job_id = $1
            AND status = 'RUNNING'
            AND lease_owner = $2
          RETURNING job_id`,
        [identifier, owner, finalStatus],
      );
      if (rowCount(completed) !== 1) {
        throw new WebhookRepositoryError(
          'WEBHOOK_LEASE_LOST',
          'Webhook job could not be completed under its lease.',
        );
      }
      return {
        operationalEventId: String(operationalEventId),
        status: finalStatus,
        gateClosed: Boolean(closeAuthorizationGate),
        hydrationQueued: Boolean(hydrationDirective),
      };
    });
  }

  async function failJob({
    jobId,
    workerId,
    errorCode = 'WEBHOOK_PROCESSING_FAILED',
    errorMessage = 'Webhook processing failed.',
    retryDelayMs,
  } = {}) {
    const delay = positiveInteger(retryDelayMs, 'retryDelayMs', {
      minimum: 1_000,
      maximum: 60 * 60_000,
    });
    const result = await pool.query(
      `UPDATE ops.webhook_job
          SET status = CASE
                WHEN attempt_count >= max_attempts THEN 'DEAD_LETTER'
                ELSE 'RETRY'
              END,
              available_at = CASE
                WHEN attempt_count >= max_attempts THEN available_at
                ELSE clock_timestamp() + ($3::bigint * interval '1 millisecond')
              END,
              lease_owner = '',
              lease_expires_at = NULL,
              completed_at = CASE
                WHEN attempt_count >= max_attempts THEN clock_timestamp()
                ELSE NULL
              END,
              last_error_code = $4,
              last_error_message = $5,
              updated_at = clock_timestamp()
        WHERE job_id = $1
          AND status = 'RUNNING'
          AND lease_owner = $2
        RETURNING status, attempt_count`,
      [
        positiveInteger(jobId, 'jobId'),
        requiredText(workerId, 'workerId', 200),
        delay,
        requiredText(errorCode, 'errorCode', 80),
        requiredText(errorMessage, 'errorMessage', 300),
      ],
    );
    if (rowCount(result) !== 1) {
      throw new WebhookRepositoryError(
        'WEBHOOK_LEASE_LOST',
        'Webhook job could not be released under its lease.',
      );
    }
    return {
      status: result.rows[0].status,
      attemptCount: Number(result.rows[0].attempt_count),
    };
  }

  async function upsertSubscriptionState({
    appKeyHash,
    eventCode,
    desiredState,
    observedState,
    callbackValidated = false,
    checkedAt,
  } = {}) {
    const desired = requiredText(desiredState, 'desiredState', 20).toUpperCase();
    const observed = requiredText(observedState, 'observedState', 20).toUpperCase();
    const result = await pool.query(
      `INSERT INTO ops.webhook_subscription_state (
         app_key_hash, event_code, desired_state, observed_state,
         callback_validated, checked_at
       ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
       ON CONFLICT (app_key_hash, event_code) DO UPDATE
         SET desired_state = EXCLUDED.desired_state,
             observed_state = EXCLUDED.observed_state,
             callback_validated = EXCLUDED.callback_validated,
             checked_at = EXCLUDED.checked_at,
             updated_at = clock_timestamp()
       RETURNING app_key_hash, event_code, desired_state, observed_state,
                 callback_validated, checked_at`,
      [
        hash(appKeyHash, 'appKeyHash'),
        requiredText(eventCode, 'eventCode', 40),
        desired,
        observed,
        Boolean(callbackValidated),
        instant(checkedAt, 'checkedAt'),
      ],
    );
    return result.rows[0] ?? null;
  }

  async function reopenAuthorizationGateFromProbe({
    storeCode,
    permissionProbeId,
  } = {}) {
    const result = await pool.query(
      `SELECT *
         FROM ops.reopen_webhook_authorization_gate_after_probe($1, $2)`,
      [
        requiredText(storeCode, 'storeCode', 32),
        positiveInteger(permissionProbeId, 'permissionProbeId'),
      ],
    );
    return result.rows[0] ?? null;
  }

  async function listOperationalEvents({
    allowedStores = [],
    limit = 100,
    includeTechnical = false,
    includeUnknown = false,
  } = {}) {
    const maximum = positiveInteger(limit, 'limit', { minimum: 1, maximum: 500 });
    const values = [];
    const clauses = [];
    if (allowedStores === '*') {
      clauses.push('TRUE');
    } else {
      const stores = Array.isArray(allowedStores)
        ? [...new Set(allowedStores.map((value) => optionalText(value, 32).toUpperCase()).filter(Boolean))]
        : [];
      if (!stores.length) return [];
      values.push(stores);
      clauses.push(`store.store_code = ANY($${values.length}::text[])`);
    }
    if (!includeTechnical) clauses.push("event.delivery_scope = 'STORE'");
    if (!includeUnknown) clauses.push("event.event_family <> 'unknown'");
    values.push(maximum);
    const result = await pool.query(
      `SELECT event.operational_event_id, event.event_code, event.event_path,
              event.event_family, event.business_type, event.business_key,
              event.occurred_at, event.action, event.platform_status,
              event.severity, event.delivery_scope, event.safe_projection,
              event.created_at, store.store_code
         FROM ops.operational_event AS event
         LEFT JOIN dim.store AS store
           ON store.store_id = event.store_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY event.created_at DESC, event.operational_event_id DESC
        LIMIT $${values.length}`,
      values,
    );
    return (result.rows ?? []).map((row) => ({
      operationalEventId: String(row.operational_event_id),
      eventCode: row.event_code ?? '',
      eventPath: row.event_path ?? '',
      eventFamily: row.event_family,
      businessType: row.business_type,
      businessKey: row.business_key ?? '',
      occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
      action: row.action,
      status: row.platform_status ?? '',
      severity: row.severity,
      deliveryScope: row.delivery_scope,
      storeCode: row.store_code ?? null,
      safeProjection: typeof row.safe_projection === 'string'
        ? JSON.parse(row.safe_projection)
        : row.safe_projection,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async function listSubscriptionState({ eventCodes = [] } = {}) {
    const codes = Array.isArray(eventCodes)
      ? [...new Set(eventCodes.map((value) => optionalText(value, 40)).filter(Boolean))]
      : [];
    const result = await pool.query(
      `SELECT substring(app_key_hash FROM 1 FOR 12) AS app_fingerprint,
              event_code, desired_state, observed_state,
              callback_validated, checked_at, updated_at
         FROM ops.webhook_subscription_state
        WHERE ($1::text[] IS NULL OR event_code = ANY($1::text[]))
        ORDER BY app_fingerprint, event_code`,
      [codes.length ? codes : null],
    );
    return (result.rows ?? []).map((row) => ({
      appFingerprint: row.app_fingerprint,
      eventCode: row.event_code,
      desiredState: row.desired_state,
      observedState: row.observed_state,
      callbackValidated: Boolean(row.callback_validated),
      checkedAt: new Date(row.checked_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async function getQueueHealth() {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::bigint FROM ops.webhook_job WHERE status = 'QUEUED') AS queued,
         (SELECT count(*)::bigint FROM ops.webhook_job WHERE status = 'RUNNING') AS running,
         (SELECT count(*)::bigint FROM ops.webhook_job WHERE status = 'RETRY') AS retry,
         (SELECT count(*)::bigint FROM ops.webhook_job WHERE status = 'DEAD_LETTER') AS dead_letter,
         (SELECT count(*)::bigint
            FROM ops.webhook_job
           WHERE status = 'RUNNING'
             AND lease_expires_at <= clock_timestamp()) AS expired_leases,
         (SELECT min(available_at)
            FROM ops.webhook_job
           WHERE status IN ('QUEUED', 'RETRY')) AS oldest_ready_at,
         (SELECT max(received_at) FROM raw.webhook_receipt) AS last_received_at,
         (SELECT max(created_at) FROM ops.operational_event) AS last_processed_at,
         (SELECT count(*)::bigint
            FROM ops.webhook_hydration_directive
           WHERE state IN ('PENDING', 'RETRY')) AS hydration_pending,
         (SELECT count(*)::bigint
            FROM ops.webhook_store_gate
           WHERE state = 'BLOCKED') AS blocked_stores`,
    );
    const row = result.rows?.[0] ?? {};
    const asIso = (value) => value ? new Date(value).toISOString() : null;
    return {
      queued: Number(row.queued ?? 0),
      running: Number(row.running ?? 0),
      retry: Number(row.retry ?? 0),
      deadLetter: Number(row.dead_letter ?? 0),
      expiredLeases: Number(row.expired_leases ?? 0),
      oldestReadyAt: asIso(row.oldest_ready_at),
      lastReceivedAt: asIso(row.last_received_at),
      lastProcessedAt: asIso(row.last_processed_at),
      hydrationPending: Number(row.hydration_pending ?? 0),
      blockedStores: Number(row.blocked_stores ?? 0),
    };
  }

  async function recordRuntimeHeartbeat(input = {}) {
    const componentCode = requiredText(
      input.componentCode,
      'componentCode',
      16,
    ).toUpperCase();
    if (!['RECEIVER', 'WORKER'].includes(componentCode)) {
      throw new WebhookRepositoryError(
        'WEBHOOK_VALIDATION',
        'componentCode is invalid.',
      );
    }
    const instanceId = requiredText(input.instanceId, 'instanceId', 160);
    const statusCode = requiredText(
      input.statusCode ?? 'RUNNING',
      'statusCode',
      16,
    ).toUpperCase();
    if (!['RUNNING', 'STOPPING'].includes(statusCode)) {
      throw new WebhookRepositoryError(
        'WEBHOOK_VALIDATION',
        'statusCode is invalid.',
      );
    }
    const observedAt = instant(input.observedAt ?? new Date(), 'observedAt');
    const ttlMs = positiveInteger(input.ttlMs ?? 90_000, 'ttlMs', {
      minimum: 1_000,
      maximum: 5 * 60_000,
    });
    const expiresAt = new Date(new Date(observedAt).getTime() + ttlMs).toISOString();
    const eventFingerprint = fingerprint([
      componentCode,
      instanceId,
      statusCode,
      observedAt,
      expiresAt,
    ]);

    return transaction(pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO ops.webhook_runtime_heartbeat (
             component_code, instance_id, status_code, observed_at,
             expires_at, event_fingerprint
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_fingerprint) DO NOTHING
         RETURNING webhook_runtime_heartbeat_id`,
        [
          componentCode,
          instanceId,
          statusCode,
          observedAt,
          expiresAt,
          eventFingerprint,
        ],
      );
      if (rowCount(inserted) === 1) {
        return {
          heartbeatId: String(inserted.rows[0].webhook_runtime_heartbeat_id),
          componentCode,
          statusCode,
          observedAt,
          expiresAt,
          created: true,
        };
      }
      const existing = await client.query(
        `SELECT webhook_runtime_heartbeat_id, component_code, instance_id,
                status_code, observed_at, expires_at
           FROM ops.webhook_runtime_heartbeat
          WHERE event_fingerprint = $1`,
        [eventFingerprint],
      );
      if (rowCount(existing) !== 1) {
        throw new WebhookRepositoryError(
          'WEBHOOK_HEARTBEAT_REPLAY_MISSING',
          'Webhook runtime heartbeat replay could not be read back.',
        );
      }
      const row = existing.rows[0];
      if (
        row.component_code !== componentCode
        || row.instance_id !== instanceId
        || row.status_code !== statusCode
        || instant(row.observed_at, 'stored observedAt') !== observedAt
        || instant(row.expires_at, 'stored expiresAt') !== expiresAt
      ) {
        throw new WebhookRepositoryError(
          'WEBHOOK_HEARTBEAT_COLLISION',
          'Webhook runtime heartbeat fingerprint collided with drifted evidence.',
        );
      }
      return {
        heartbeatId: String(row.webhook_runtime_heartbeat_id),
        componentCode,
        statusCode,
        observedAt,
        expiresAt,
        created: false,
      };
    });
  }

  async function getRuntimeHealth() {
    const result = await pool.query(
      `WITH components(component_code) AS (
         VALUES ('RECEIVER'::text), ('WORKER'::text)
       )
       SELECT component.component_code,
              heartbeat.instance_id,
              heartbeat.status_code,
              heartbeat.observed_at,
              heartbeat.expires_at,
              clock_timestamp() AS evaluated_at
         FROM components AS component
         LEFT JOIN LATERAL (
           SELECT instance_id, status_code, observed_at, expires_at
             FROM ops.webhook_runtime_heartbeat
            WHERE component_code = component.component_code
            ORDER BY observed_at DESC, webhook_runtime_heartbeat_id DESC
            LIMIT 1
         ) AS heartbeat ON true
        ORDER BY component.component_code`,
    );
    const components = {};
    let evaluatedAt = null;
    for (const row of result.rows ?? []) {
      evaluatedAt = instant(row.evaluated_at, 'evaluatedAt');
      const key = String(row.component_code || '').toLowerCase();
      if (!['receiver', 'worker'].includes(key)) continue;
      if (!row.observed_at || !row.expires_at || !row.status_code) {
        components[key] = null;
        continue;
      }
      const observedAt = instant(row.observed_at, 'runtime observedAt');
      const expiresAt = instant(row.expires_at, 'runtime expiresAt');
      const evaluatedMs = new Date(evaluatedAt).getTime();
      const observedMs = new Date(observedAt).getTime();
      components[key] = {
        status: row.status_code,
        lastSeenAt: observedAt,
        expiresAt,
        fresh: (
          row.status_code === 'RUNNING'
          && new Date(expiresAt).getTime() > evaluatedMs
          && observedMs <= evaluatedMs + 30_000
        ),
      };
    }
    const receiver = components.receiver ?? null;
    const worker = components.worker ?? null;
    return {
      ok: receiver && worker ? receiver.fresh && worker.fresh : null,
      evaluatedAt,
      receiver,
      worker,
    };
  }

  async function health() {
    const result = await pool.query(
      `SELECT
         to_regclass('raw.webhook_receipt') IS NOT NULL AS receipt_ready,
         to_regclass('ops.webhook_job') IS NOT NULL AS job_ready,
         to_regclass('ops.operational_event') IS NOT NULL AS event_ready`,
    );
    const row = result.rows?.[0] ?? {};
    return {
      ok: row.receipt_ready === true && row.job_ready === true && row.event_ready === true,
    };
  }

  return Object.freeze({
    storeReceiptAndJob,
    claimNextJob,
    renewJobLease,
    completeJob,
    failJob,
    upsertSubscriptionState,
    reopenAuthorizationGateFromProbe,
    listOperationalEvents,
    listSubscriptionState,
    getQueueHealth,
    recordRuntimeHeartbeat,
    getRuntimeHealth,
    health,
    close: () => pool.end?.(),
  });
}

export { JOB_STATUSES as FULL_MANAGED_WEBHOOK_JOB_STATUSES };
