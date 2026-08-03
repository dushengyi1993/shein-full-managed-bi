import http from 'node:http';

import {
  WEBHOOK_CALLBACK_PATH,
  WEBHOOK_MAX_SKEW_MS,
  assertCanonicalWebhookCiphertext,
  computeWebhookIdempotencyKey,
  sha256Hex,
  verifyFullManagedWebhookSignature,
} from './crypto.mjs';
import { resolveFullManagedWebhookEvent } from './event-registry.mjs';
import {
  WEBHOOK_MAX_BODY_BYTES,
  assertSingletonSecurityHeaders,
  extractEncryptedEventData,
  normalizeWebhookHeaders,
  readWebhookBody,
} from './payload.mjs';

export const WEBHOOK_INGRESS_BUDGET_MS = 1_200;
export const WEBHOOK_DB_STATEMENT_TIMEOUT_MS = 800;
export const WEBHOOK_RETRY_DEDUP_WINDOW_MS = 10 * 60_000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function publicErrorStatus(error) {
  if (error?.statusCode === 413) return 413;
  if (
    error?.code === 'WEBHOOK_IDENTITY_UNKNOWN'
    || error?.code === 'WEBHOOK_IDENTITY_MISMATCH'
    || error?.code === 'WEBHOOK_SIGNATURE_REJECTED'
  ) {
    return 401;
  }
  if (
    error?.code === 'WEBHOOK_INGRESS_DEADLINE'
    || error?.code === 'WEBHOOK_STORAGE_UNAVAILABLE'
  ) {
    return 503;
  }
  return 400;
}

function safeLogError(error) {
  const code = String(error?.code ?? 'WEBHOOK_INVALID').toUpperCase();
  return {
    code: /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'WEBHOOK_INVALID',
    category: publicErrorStatus(error) >= 500 ? 'availability' : 'rejected',
  };
}

function responseBody(status, extra = {}) {
  if (status === 200) return { ok: true, ...extra };
  if (status === 401) return { ok: false, error: 'Webhook authentication failed' };
  if (status === 413) return { ok: false, error: 'Webhook body is too large' };
  if (status === 503) return { ok: false, error: 'Webhook receiver temporarily unavailable' };
  return { ok: false, error: 'Invalid webhook request' };
}

function writeJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function beforeDeadline(promise, deadlineAt) {
  const remaining = Math.floor(deadlineAt - Date.now());
  if (remaining <= 0) {
    return Promise.reject(Object.assign(new Error('Webhook ingress budget expired.'), {
      code: 'WEBHOOK_INGRESS_DEADLINE',
      statusCode: 503,
    }));
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(
      new Error('Webhook ingress budget expired.'),
      { code: 'WEBHOOK_INGRESS_DEADLINE', statusCode: 503 },
    )), remaining);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

export function createFullManagedWebhookReceiver({
  repository,
  credentialRegistry,
  callbackPath = WEBHOOK_CALLBACK_PATH,
  maxBodyBytes = WEBHOOK_MAX_BODY_BYTES,
  maxSkewMs = WEBHOOK_MAX_SKEW_MS,
  ingressBudgetMs = WEBHOOK_INGRESS_BUDGET_MS,
  statementTimeoutMs = WEBHOOK_DB_STATEMENT_TIMEOUT_MS,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (!repository?.storeReceiptAndJob) throw new TypeError('Webhook repository is required.');
  if (!credentialRegistry?.resolveIngress) throw new TypeError('Webhook credential registry is required.');
  const budget = boundedInteger(ingressBudgetMs, 1_200, 250, 1_200);
  const databaseTimeout = boundedInteger(statementTimeoutMs, 800, 50, 800);
  const bodyLimit = boundedInteger(maxBodyBytes, WEBHOOK_MAX_BODY_BYTES, 1, WEBHOOK_MAX_BODY_BYTES);
  const skewLimit = boundedInteger(maxSkewMs, WEBHOOK_MAX_SKEW_MS, 0, WEBHOOK_MAX_SKEW_MS);
  const counters = {
    accepted: 0,
    duplicates: 0,
    appScopedOnly: 0,
    quarantined: 0,
    rejected: 0,
  };

  async function ingest({
    headers: inputHeaders,
    contentType,
    rawBody,
    startedAt: suppliedStartedAt,
  } = {}) {
    const startedAt = Number.isFinite(Number(suppliedStartedAt))
      ? Number(suppliedStartedAt)
      : Date.now();
    const deadlineAt = startedAt + budget;
    const headers = normalizeWebhookHeaders(inputHeaders);
    assertSingletonSecurityHeaders(headers);
    const identity = credentialRegistry.resolveIngress(headers);
    const ciphertext = extractEncryptedEventData({
      contentType: contentType ?? headers['content-type'],
      rawBody,
      maxBodyBytes: bodyLimit,
    });
    assertCanonicalWebhookCiphertext(ciphertext);
    const verification = verifyFullManagedWebhookSignature({
      appId: headers['x-lt-appid'],
      openKeyId: headers['x-lt-openkeyid'],
      timestamp: headers['x-lt-timestamp'],
      signature: headers['x-lt-signature'],
      appSecretKey: identity.appSecretKey,
      callbackPath,
      nowMs: now(),
      maxSkewMs: skewLimit,
    });
    if (!verification.ok) {
      throw Object.assign(new Error('Webhook signature was rejected.'), {
        code: 'WEBHOOK_SIGNATURE_REJECTED',
        statusCode: 401,
      });
    }

    const event = resolveFullManagedWebhookEvent(headers['x-lt-eventcode']);
    const cipherSha256 = sha256Hex(ciphertext);
    const platformTimestamp = new Date(verification.platformTimestampMs).toISOString();
    // Delivery is at least once, not exactly once. Collapse deterministic
    // ciphertext retries only inside one bounded signed-delivery window.
    // The same payload in a later window is a new receipt/job so a legitimate
    // repeated business event is never suppressed forever. A retry crossing a
    // window boundary may be processed again, so downstream work stays
    // idempotent.
    const deliveryOccurrence = String(
      Math.floor(verification.platformTimestampMs / WEBHOOK_RETRY_DEDUP_WINDOW_MS),
    );
    const idempotencyKey = computeWebhookIdempotencyKey({
      appKeyHash: identity.appKeyHash,
      openKeyHash: identity.openKeyHash,
      eventCode: event.eventCode,
      eventPath: event.eventPath,
      deliveryOccurrence,
      cipherSha256,
    });
    const safeProjection = {
      schemaVersion: 1,
      knownEvent: event.family !== 'unknown',
      eventFamily: event.family,
      deliveryScope: identity.deliveryScope,
      appScopedOnly: identity.appScopedOnly,
    };
    const remaining = Math.floor(deadlineAt - Date.now() - 50);
    if (remaining < 50) {
      throw Object.assign(new Error('Webhook ingress budget expired.'), {
        code: 'WEBHOOK_INGRESS_DEADLINE',
        statusCode: 503,
      });
    }
    let stored;
    try {
      stored = await beforeDeadline(repository.storeReceiptAndJob({
        idempotencyKey,
        appKeyHash: identity.appKeyHash,
        openKeyHash: identity.openKeyHash,
        eventCode: event.eventCode,
        eventPath: event.eventPath,
        storeCode: identity.storeCode,
        deliveryScope: identity.deliveryScope,
        platformTimestamp,
        cipherSha256,
        ciphertext,
        safeProjection,
        statementTimeoutMs: Math.min(databaseTimeout, remaining),
      }), deadlineAt);
    } catch (error) {
      if (error?.code === 'WEBHOOK_INGRESS_DEADLINE') throw error;
      throw Object.assign(new Error('Webhook durable storage is unavailable.'), {
        code: 'WEBHOOK_STORAGE_UNAVAILABLE',
        statusCode: 503,
        cause: error,
      });
    }
    counters.accepted += 1;
    if (stored.duplicate) counters.duplicates += 1;
    if (identity.appScopedOnly) counters.appScopedOnly += 1;
    if (event.family === 'unknown') counters.quarantined += 1;
    return Object.freeze({
      ok: true,
      duplicate: Boolean(stored.duplicate),
      appScopedOnly: identity.appScopedOnly,
      quarantined: event.family === 'unknown',
    });
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/healthz' && !url.search) {
      if (request.method !== 'GET') {
        writeJson(response, 405, { ok: false, error: 'Method not allowed' });
        return;
      }
      const database = await repository.health?.().catch(() => ({ ok: false }));
      writeJson(response, database?.ok === false ? 503 : 200, {
        ok: database?.ok !== false,
        service: 'shein-fm-webhook-receiver',
        counters,
      });
      return;
    }
    if (
      request.method === 'GET'
      && url.pathname === callbackPath
      && !url.search
    ) {
      writeJson(response, 200, {
        ok: true,
        service: 'shein-fm-webhook-receiver',
        callback: true,
      });
      return;
    }
    if (
      request.method !== 'POST'
      || url.pathname !== callbackPath
      || url.search
    ) {
      writeJson(response, 404, { ok: false, error: 'Not found' });
      return;
    }
    const requestStartedAt = Date.now();
    try {
      const rawBody = await beforeDeadline(
        readWebhookBody(request, bodyLimit),
        requestStartedAt + budget,
      );
      const result = await ingest({
        headers: request.headers,
        contentType: request.headers['content-type'],
        rawBody,
        startedAt: requestStartedAt,
      });
      writeJson(response, 200, responseBody(200, {
        duplicate: result.duplicate,
        quarantined: result.quarantined,
      }));
    } catch (error) {
      counters.rejected += 1;
      const status = publicErrorStatus(error);
      logger.warn?.(JSON.stringify({
        event: 'webhook-ingress-rejected',
        status,
        ...safeLogError(error),
      }));
      if (!response.headersSent && !response.destroyed) {
        writeJson(response, status, responseBody(status));
      }
    }
  });
  server.requestTimeout = Math.min(1_300, budget + 100);
  server.headersTimeout = server.requestTimeout;
  server.keepAliveTimeout = 2_000;
  server.maxHeadersCount = 40;

  return Object.freeze({
    server,
    counters,
    ingest,
    async start({ host = '127.0.0.1', port = 8793 } = {}) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  });
}
