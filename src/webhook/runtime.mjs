import { Pool } from 'pg';

export function createWebhookPostgresPool(env = process.env) {
  const connectionString = env.FULL_BI_DATABASE_URL ?? env.DATABASE_URL;
  if (!connectionString) throw new Error('FULL_BI_DATABASE_URL is required.');
  const max = Number(env.FULL_BI_WEBHOOK_DB_POOL_MAX ?? 4);
  if (!Number.isSafeInteger(max) || max < 1 || max > 12) {
    throw new Error('FULL_BI_WEBHOOK_DB_POOL_MAX must be between 1 and 12.');
  }
  return new Pool({
    connectionString,
    max,
    application_name: env.FULL_BI_WEBHOOK_DB_APPLICATION_NAME
      ?? 'shein_fm_webhook',
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });
}

export function positiveRuntimeInteger(
  value,
  fallback,
  { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {},
) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export async function startWebhookRuntimeHeartbeat({
  repository,
  componentCode,
  instanceId,
  intervalMs = 30_000,
  ttlMs = 90_000,
  now = () => Date.now(),
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!repository?.recordRuntimeHeartbeat) {
    throw new TypeError('Webhook heartbeat repository is required.');
  }
  const interval = positiveRuntimeInteger(intervalMs, 30_000, {
    minimum: 5_000,
    maximum: 120_000,
  });
  const ttl = positiveRuntimeInteger(ttlMs, 90_000, {
    minimum: 15_000,
    maximum: 5 * 60_000,
  });
  if (ttl < interval * 2) {
    throw new RangeError('Webhook heartbeat TTL must be at least twice the interval.');
  }

  const record = (statusCode, recordTtlMs = ttl) => (
    repository.recordRuntimeHeartbeat({
      componentCode,
      instanceId,
      statusCode,
      observedAt: new Date(now()),
      ttlMs: recordTtlMs,
    })
  );
  await record('RUNNING');

  let stopped = false;
  let pending = null;
  const timer = setIntervalFn(() => {
    if (stopped || pending) return;
    pending = record('RUNNING')
      .catch((error) => {
        logger.error?.(JSON.stringify({
          event: 'webhook-runtime-heartbeat-failed',
          component: String(componentCode || '').toUpperCase(),
          errorCode: String(error?.code ?? 'WEBHOOK_HEARTBEAT_FAILED').slice(0, 80),
        }));
      })
      .finally(() => {
        pending = null;
      });
  }, interval);
  timer?.unref?.();

  return Object.freeze({
    async stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
      if (pending) await pending;
      await record('STOPPING', 1_000);
    },
  });
}
