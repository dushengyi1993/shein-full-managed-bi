#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadFullManagedWebhookCredentialRegistry } from '../src/webhook/credentials.mjs';
import {
  createWebhookPostgresPool,
  positiveRuntimeInteger,
  startWebhookRuntimeHeartbeat,
} from '../src/webhook/runtime.mjs';
import { createFullManagedWebhookWorker } from '../src/webhook/worker.mjs';
import { createFullManagedWebhookRepository } from '../src/warehouse/webhook-repository.mjs';

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runFullManagedWebhookWorker({ env = process.env } = {}) {
  const credentialRegistry = await loadFullManagedWebhookCredentialRegistry(
    {
      storeConfigFile: env.FULL_BI_OPENAPI_CONFIG_FILE
        ?? env.FULL_BI_OPENAPI_CONFIG,
      applicationFile: env.FULL_BI_WEBHOOK_APPLICATION_FILE,
    },
  );
  const pool = createWebhookPostgresPool(env);
  const repository = createFullManagedWebhookRepository({ pool });
  const health = await repository.health();
  if (!health.ok) {
    await repository.close();
    throw new Error('Full-managed webhook database migration is not ready.');
  }
  const pollMs = positiveRuntimeInteger(env.FULL_BI_WEBHOOK_WORKER_POLL_MS, 1_000, {
    minimum: 100,
    maximum: 10_000,
  });
  const leaseMs = positiveRuntimeInteger(env.FULL_BI_WEBHOOK_WORKER_LEASE_MS, 120_000, {
    minimum: 5_000,
    maximum: 15 * 60_000,
  });
  const worker = createFullManagedWebhookWorker({
    repository,
    credentialRegistry,
    leaseMs,
  });
  const heartbeat = await startWebhookRuntimeHeartbeat({
    repository,
    componentCode: 'WORKER',
    instanceId: env.FULL_BI_WEBHOOK_INSTANCE_ID ?? `${os.hostname()}:${process.pid}`,
    intervalMs: env.FULL_BI_WEBHOOK_HEARTBEAT_INTERVAL_MS,
    ttlMs: env.FULL_BI_WEBHOOK_HEARTBEAT_TTL_MS,
  }).catch(async (error) => {
    await repository.close();
    throw error;
  });
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    worker.stop();
    console.log(JSON.stringify({
      event: 'webhook-worker-shutdown',
      signal,
    }));
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  console.log(JSON.stringify({
    ok: true,
    service: 'shein-fm-webhook-worker',
    credentialCoverage: credentialRegistry.summary,
  }));

  while (!stopping) {
    const result = await worker.processOne();
    if (!result.claimed) await wait(pollMs);
  }
  while (worker.processing) await wait(25);
  await heartbeat.stop().catch((error) => {
    console.error(JSON.stringify({
      event: 'webhook-worker-heartbeat-stop-failed',
      errorCode: String(error?.code ?? 'WEBHOOK_HEARTBEAT_STOP_FAILED').slice(0, 80),
    }));
  });
  await repository.close();
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runFullManagedWebhookWorker().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      service: 'shein-fm-webhook-worker',
      error: 'Worker failed.',
      errorCode: String(error?.code ?? 'WEBHOOK_WORKER_FAILED').slice(0, 80),
    }));
    process.exitCode = 1;
  });
}
