#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import { loadFullManagedConfig } from '../src/openapi/full-managed-config.mjs';
import {
  createWebhookHydrationRepository,
  webhookHydrationRetryDelayMs,
} from '../src/webhook/hydration-repository.mjs';
import { runSupplySync } from './sync_full_managed_supply.mjs';

function groups(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const values = grouped.get(row.storeCode) ?? [];
    values.push(row);
    grouped.set(row.storeCode, values);
  }
  return grouped;
}

function businessKeys(rows, type) {
  return [...new Set(rows
    .filter((row) => row.directiveType === type)
    .map((row) => String(row.lookup?.businessKey ?? '').trim())
    .filter(Boolean))];
}

function domainCount(summary, storeCode, domain) {
  const store = summary.results.find((row) => row.storeCode === storeCode);
  const result = store?.domains?.find((row) => row.domain === domain);
  return Number.isSafeInteger(result?.recordCount) ? result.recordCount : 0;
}

function errorCode(error) {
  const code = String(error?.code ?? error?.message ?? 'HYDRATION_FAILED').toUpperCase();
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'HYDRATION_FAILED';
}

export async function runWebhookHydration({
  env = process.env,
  poolFactory = (connectionString) => new Pool({ connectionString, max: 2 }),
  configLoader = loadFullManagedConfig,
  repositoryFactory = createWebhookHydrationRepository,
  sync = runSupplySync,
} = {}) {
  const databaseUrl = env.FULL_BI_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error('FULL_BI_DATABASE_URL is required.');
  const config = await configLoader(env.FULL_BI_OPENAPI_CONFIG_FILE);
  const pool = poolFactory(databaseUrl);
  const repository = repositoryFactory({ pool });
  const workerId = `${os.hostname()}:${process.pid}`;
  const summary = { claimed: 0, succeeded: 0, retrying: 0, groups: 0 };
  try {
    for (let batch = 0; batch < 10; batch += 1) {
      const claimed = await repository.claimBatch({ workerId, limit: 100 });
      if (claimed.length === 0) break;
      summary.claimed += claimed.length;
      for (const [storeCode, rows] of groups(claimed)) {
        summary.groups += 1;
        const orderNos = businessKeys(rows, 'PURCHASE_ORDER_READBACK');
        const deliveryCodes = businessKeys(rows, 'DELIVERY_READBACK');
        const validRows = rows.filter((row) => (
          (row.directiveType === 'PURCHASE_ORDER_READBACK' && orderNos.includes(row.lookup.businessKey))
          || (row.directiveType === 'DELIVERY_READBACK' && deliveryCodes.includes(row.lookup.businessKey))
        ));
        const invalidRows = rows.filter((row) => !validRows.includes(row));
        if (invalidRows.length > 0) {
          const attempt = Math.max(...invalidRows.map(({ attemptCount }) => attemptCount));
          await repository.fail(invalidRows.map(({ directiveId }) => directiveId), {
            workerId,
            attemptCount: attempt,
            errorCode: 'HYDRATION_LOOKUP_MISSING',
            retryDelayMs: webhookHydrationRetryDelayMs(attempt),
          });
          summary.retrying += invalidRows.length;
        }
        if (validRows.length === 0) continue;
        try {
          const domains = [
            orderNos.length > 0 ? 'purchase-orders' : null,
            deliveryCodes.length > 0 ? 'deliveries' : null,
          ].filter(Boolean);
          const result = await sync({
            config,
            databaseUrl,
            stores: storeCode,
            domains: domains.join(','),
            purchaseOrderNos: orderNos.join(','),
            deliveryCodes: deliveryCodes.join(','),
            runId: `webhook-${Date.now()}`,
          });
          if (!result.ok
            || (orderNos.length > 0 && domainCount(result, storeCode, 'purchase-orders') < orderNos.length)
            || (deliveryCodes.length > 0 && domainCount(result, storeCode, 'deliveries') < deliveryCodes.length)) {
            throw Object.assign(new Error('WEBHOOK_READBACK_NOT_READY'), {
              code: 'WEBHOOK_READBACK_NOT_READY',
            });
          }
          await repository.complete(validRows.map(({ directiveId }) => directiveId), { workerId });
          summary.succeeded += validRows.length;
        } catch (error) {
          const attempt = Math.max(...validRows.map(({ attemptCount }) => attemptCount));
          await repository.fail(validRows.map(({ directiveId }) => directiveId), {
            workerId,
            attemptCount: attempt,
            errorCode: errorCode(error),
            retryDelayMs: webhookHydrationRetryDelayMs(attempt),
          });
          summary.retrying += validRows.length;
        }
      }
    }
  } finally {
    await pool.end();
  }
  return Object.freeze({ ok: true, ...summary });
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runWebhookHydration()
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error) => {
      console.error(JSON.stringify({
        ok: false,
        errorCode: errorCode(error),
        error: 'Webhook read-only hydration failed.',
      }));
      process.exitCode = 1;
    });
}
