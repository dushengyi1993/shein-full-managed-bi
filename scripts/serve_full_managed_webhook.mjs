#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadFullManagedWebhookCredentialRegistry } from '../src/webhook/credentials.mjs';
import { createFullManagedWebhookReceiver } from '../src/webhook/receiver.mjs';
import {
  createWebhookPostgresPool,
  positiveRuntimeInteger,
  startWebhookRuntimeHeartbeat,
} from '../src/webhook/runtime.mjs';
import { createFullManagedWebhookRepository } from '../src/warehouse/webhook-repository.mjs';

export async function runFullManagedWebhookReceiver({ env = process.env } = {}) {
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
  const service = createFullManagedWebhookReceiver({
    repository,
    credentialRegistry,
  });
  const host = env.FULL_BI_WEBHOOK_HOST ?? '127.0.0.1';
  const port = positiveRuntimeInteger(env.FULL_BI_WEBHOOK_PORT, 8793, {
    minimum: 1,
    maximum: 65_535,
  });
  const address = await service.start({ host, port });
  let heartbeat;
  try {
    heartbeat = await startWebhookRuntimeHeartbeat({
      repository,
      componentCode: 'RECEIVER',
      instanceId: env.FULL_BI_WEBHOOK_INSTANCE_ID ?? `${os.hostname()}:${process.pid}`,
      intervalMs: env.FULL_BI_WEBHOOK_HEARTBEAT_INTERVAL_MS,
      ttlMs: env.FULL_BI_WEBHOOK_HEARTBEAT_TTL_MS,
    });
  } catch (error) {
    await service.stop();
    await repository.close();
    throw error;
  }
  console.log(JSON.stringify({
    ok: true,
    service: 'shein-fm-webhook-receiver',
    host,
    port: address.port,
    credentialCoverage: credentialRegistry.summary,
  }));

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({
      event: 'webhook-receiver-shutdown',
      signal,
    }));
    await heartbeat.stop().catch((error) => {
      console.error(JSON.stringify({
        event: 'webhook-receiver-heartbeat-stop-failed',
        errorCode: String(error?.code ?? 'WEBHOOK_HEARTBEAT_STOP_FAILED').slice(0, 80),
      }));
    });
    await service.stop();
    await repository.close();
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  return { service, repository, heartbeat };
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runFullManagedWebhookReceiver().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      service: 'shein-fm-webhook-receiver',
      error: 'Receiver failed to start.',
      errorCode: String(error?.code ?? 'WEBHOOK_START_FAILED').slice(0, 80),
    }));
    process.exitCode = 1;
  });
}
