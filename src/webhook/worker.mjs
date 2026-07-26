import os from 'node:os';

import {
  decryptFullManagedWebhookEvent,
  sha256Hex,
} from './crypto.mjs';
import { resolveFullManagedWebhookEvent } from './event-registry.mjs';
import {
  createUnknownWebhookAuditEvent,
  normalizeFullManagedWebhookEvent,
} from './normalizer.mjs';

const SAFE_ERROR_MESSAGES = Object.freeze({
  WEBHOOK_CREDENTIAL_UNAVAILABLE: 'Webhook decryption credential is unavailable.',
  WEBHOOK_CIPHERTEXT_INVALID: 'Stored webhook ciphertext is invalid.',
  WEBHOOK_CIPHERTEXT_CORRUPT: 'Stored webhook ciphertext failed its integrity check.',
  WEBHOOK_DECRYPT_FAILED: 'Stored webhook ciphertext could not be decrypted.',
  WEBHOOK_PAYLOAD_INVALID: 'Decrypted webhook data has an invalid shape.',
  WEBHOOK_PAYLOAD_LIMIT: 'Decrypted webhook data exceeded normalization limits.',
  WEBHOOK_IDENTITY_DRIFT: 'Stored webhook identity no longer matches configuration.',
  WEBHOOK_LEASE_LOST: 'Webhook worker lost its job lease.',
  WEBHOOK_PROCESSING_FAILED: 'Webhook processing failed.',
});

function safeFailure(error) {
  const rawCode = String(error?.code ?? '').toUpperCase();
  const code = /^[A-Z0-9_]{1,80}$/.test(rawCode) && SAFE_ERROR_MESSAGES[rawCode]
    ? rawCode
    : 'WEBHOOK_PROCESSING_FAILED';
  return { code, message: SAFE_ERROR_MESSAGES[code] };
}

export function webhookRetryDelayMs(attemptCount) {
  const attempt = Number(attemptCount);
  const exponent = Number.isSafeInteger(attempt) && attempt > 0 ? attempt - 1 : 0;
  return Math.min(60 * 60_000, 5_000 * (2 ** Math.min(exponent, 10)));
}

export function createFullManagedWebhookWorker({
  repository,
  credentialRegistry,
  workerId = `${os.hostname()}:${process.pid}`,
  leaseMs = 120_000,
  logger = console,
} = {}) {
  if (!repository?.claimNextJob || !repository?.completeJob || !repository?.failJob) {
    throw new TypeError('Webhook repository is required.');
  }
  if (!credentialRegistry?.resolveStored) {
    throw new TypeError('Webhook credential registry is required.');
  }
  let processing = false;
  let stopping = false;

  async function processOne() {
    if (processing || stopping) return { claimed: false };
    processing = true;
    let job = null;
    try {
      job = await repository.claimNextJob({ workerId, leaseMs });
      if (!job) return { claimed: false };
      const event = resolveFullManagedWebhookEvent(job.eventCode || job.eventPath);

      // Unknown events are deliberately not decrypted. Their signed receipt
      // remains auditable, while no unrecognized payload field can enter Ops.
      if (event.family === 'unknown') {
        const normalized = createUnknownWebhookAuditEvent({
          event,
          storeCode: job.storeCode,
          deliveryScope: job.deliveryScope,
          receivedAt: job.receivedAt,
        });
        const outcome = await repository.completeJob({
          jobId: job.jobId,
          workerId,
          normalized,
          hydrationDirective: null,
          closeAuthorizationGate: false,
          quarantined: true,
        });
        return { claimed: true, ...outcome };
      }

      const identity = credentialRegistry.resolveStored({
        appKeyHash: job.appKeyHash,
        openKeyHash: job.openKeyHash,
        deliveryScope: job.deliveryScope,
        storeCode: job.storeCode,
      });
      if (sha256Hex(job.ciphertext) !== job.cipherSha256) {
        throw Object.assign(new Error('Stored ciphertext hash mismatch.'), {
          code: 'WEBHOOK_CIPHERTEXT_CORRUPT',
        });
      }
      const payload = decryptFullManagedWebhookEvent(
        job.ciphertext,
        identity.appSecretKey,
      );
      const normalized = normalizeFullManagedWebhookEvent({
        event,
        payload,
        storeCode: identity.storeCode,
        deliveryScope: job.deliveryScope,
        receivedAt: job.receivedAt,
      });
      const outcome = await repository.completeJob({
        jobId: job.jobId,
        workerId,
        normalized: normalized.normalized,
        hydrationDirective: normalized.hydrationDirective,
        closeAuthorizationGate: normalized.closeAuthorizationGate,
        quarantined: false,
      });
      return { claimed: true, ...outcome };
    } catch (error) {
      const safe = safeFailure(error);
      if (job) {
        const released = await repository.failJob({
          jobId: job.jobId,
          workerId,
          errorCode: safe.code,
          errorMessage: safe.message,
          retryDelayMs: webhookRetryDelayMs(job.attemptCount),
        }).catch((releaseError) => {
          logger.error?.(JSON.stringify({
            event: 'webhook-job-release-failed',
            jobId: job.jobId,
            errorCode: safeFailure(releaseError).code,
          }));
          return null;
        });
        logger.error?.(JSON.stringify({
          event: 'webhook-job-processing-failed',
          jobId: job.jobId,
          attemptCount: job.attemptCount,
          nextStatus: released?.status ?? 'LEASE_LOST',
          errorCode: safe.code,
        }));
        return {
          claimed: true,
          failed: true,
          status: released?.status ?? 'LEASE_LOST',
          errorCode: safe.code,
        };
      }
      logger.error?.(JSON.stringify({
        event: 'webhook-worker-claim-failed',
        errorCode: safe.code,
      }));
      return { claimed: false, failed: true, errorCode: safe.code };
    } finally {
      processing = false;
    }
  }

  return Object.freeze({
    processOne,
    get processing() {
      return processing;
    },
    stop() {
      stopping = true;
    },
  });
}

