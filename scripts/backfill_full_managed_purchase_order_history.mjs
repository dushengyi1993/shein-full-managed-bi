#!/usr/bin/env node

import { canonicalHash } from '../src/backfill/canonical.mjs';
import { buildBackfillPlan, BACKFILL_MODES } from '../src/backfill/plan.mjs';
import { runBackfillPlan } from '../src/backfill/runner.mjs';
import { FULL_MANAGED_STORE_CODES } from '../src/config/full-managed-stores.mjs';
import { createBackfillExecuteRuntime } from './run_full_managed_backfill.mjs';

export const PURCHASE_ORDER_HISTORY_FROM = '2024-01-01';
export const PURCHASE_ORDER_HISTORY_TO = '2026-07-30';
export const PURCHASE_ORDER_HISTORY_MANIFEST_VERSION = 'purchase-order-history.v2';
export const PURCHASE_ORDER_HISTORY_CREATED_BY = 'codex-full-managed-history-20260730';
export const PURCHASE_ORDER_HISTORY_STORE_BATCH_SIZE = 4;
export const PURCHASE_ORDER_HISTORY_PERIOD_DAYS = 400;
export const PURCHASE_ORDER_HISTORY_CONCURRENCY = 2;

function date(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError('PURCHASE_ORDER_HISTORY_DATE_INVALID');
  }
  return parsed;
}

function iso(value) {
  return value.toISOString().slice(0, 10);
}

function addDays(value, days) {
  return new Date(value.valueOf() + days * 86_400_000);
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export function purchaseOrderHistoryPeriods({
  from = PURCHASE_ORDER_HISTORY_FROM,
  to = PURCHASE_ORDER_HISTORY_TO,
  maximumDays = PURCHASE_ORDER_HISTORY_PERIOD_DAYS,
} = {}) {
  if (!Number.isSafeInteger(maximumDays) || maximumDays < 1 || maximumDays > 400) {
    throw new TypeError('PURCHASE_ORDER_HISTORY_PERIOD_INVALID');
  }
  const first = date(from);
  const last = date(to);
  if (first > last) throw new TypeError('PURCHASE_ORDER_HISTORY_RANGE_INVALID');
  const result = [];
  let cursor = first;
  while (cursor <= last) {
    const candidate = addDays(cursor, maximumDays - 1);
    const end = candidate > last ? last : candidate;
    result.push(Object.freeze({ from: iso(cursor), to: iso(end) }));
    cursor = addDays(end, 1);
  }
  return Object.freeze(result);
}

export function buildPurchaseOrderHistoryManifest({
  storeCodes = FULL_MANAGED_STORE_CODES,
  from = PURCHASE_ORDER_HISTORY_FROM,
  to = PURCHASE_ORDER_HISTORY_TO,
} = {}) {
  const stores = [...new Set(storeCodes.map((value) => String(value).trim().toUpperCase()))].sort();
  const periods = purchaseOrderHistoryPeriods({ from, to });
  const plans = [];
  for (const period of periods) {
    for (const storeBatch of chunks(stores, PURCHASE_ORDER_HISTORY_STORE_BATCH_SIZE)) {
      plans.push(buildBackfillPlan({
        storeCodes: storeBatch,
        domains: ['purchase-orders'],
        from: period.from,
        to: period.to,
        windowSpanDays: 1,
        concurrency: PURCHASE_ORDER_HISTORY_CONCURRENCY,
        maxAttempts: 3,
        createdBy: PURCHASE_ORDER_HISTORY_CREATED_BY,
        today: PURCHASE_ORDER_HISTORY_TO,
      }));
    }
  }
  const manifestBody = {
    version: PURCHASE_ORDER_HISTORY_MANIFEST_VERSION,
    from,
    to,
    storeCodes: stores,
    planHashes: plans.map((plan) => plan.planHash),
  };
  return Object.freeze({
    ...manifestBody,
    manifestHash: canonicalHash(manifestBody),
    planCount: plans.length,
    windowCount: plans.reduce((total, plan) => total + plan.summary.plannedWindowCount, 0),
    plans: Object.freeze(plans),
  });
}

export function parsePurchaseOrderHistoryArgs(argv = []) {
  const values = new Map();
  for (const token of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match || values.has(match[1]) || !['execute', 'approved-manifest-hash'].includes(match[1])) {
      throw new TypeError('PURCHASE_ORDER_HISTORY_ARGUMENT_INVALID');
    }
    values.set(match[1], match[2] ?? 'true');
  }
  const execute = values.get('execute') === 'true';
  if (!execute && values.has('approved-manifest-hash')) {
    throw new TypeError('PURCHASE_ORDER_HISTORY_APPROVAL_WITHOUT_EXECUTE');
  }
  if (execute && !/^[0-9a-f]{64}$/.test(values.get('approved-manifest-hash') ?? '')) {
    throw new TypeError('PURCHASE_ORDER_HISTORY_APPROVAL_REQUIRED');
  }
  return Object.freeze({
    execute,
    approvedManifestHash: values.get('approved-manifest-hash') ?? null,
  });
}

function report(manifest, extra = {}) {
  return {
    ok: true,
    mode: extra.mode ?? 'DRY_RUN',
    manifestVersion: manifest.version,
    manifestHash: manifest.manifestHash,
    from: manifest.from,
    to: manifest.to,
    storeCount: manifest.storeCodes.length,
    planCount: manifest.planCount,
    windowCount: manifest.windowCount,
    ...extra,
  };
}

async function main() {
  try {
    const args = parsePurchaseOrderHistoryArgs(process.argv.slice(2));
    const manifest = buildPurchaseOrderHistoryManifest();
    if (!args.execute) {
      console.log(JSON.stringify(report(manifest), null, 2));
      return;
    }
    if (args.approvedManifestHash !== manifest.manifestHash) {
      throw new TypeError('PURCHASE_ORDER_HISTORY_MANIFEST_MISMATCH');
    }
    let completedPlans = 0;
    let adapterInvocationCount = 0;
    let checkpointAdvancedCount = 0;
    for (const plan of manifest.plans) {
      const runtime = await createBackfillExecuteRuntime({ plan });
      try {
        const result = await runBackfillPlan({
          plan,
          mode: BACKFILL_MODES.EXECUTE,
          approvedPlanHash: plan.planHash,
          allowedStoreCodes: [...plan.storeCodes],
          allowedDomains: [...plan.domains],
          adapters: runtime.adapters,
          repository: runtime.repository,
          createdBy: plan.createdBy,
        });
        adapterInvocationCount += result.adapterInvocationCount;
        checkpointAdvancedCount += result.checkpointAdvancedCount;
        if (result.runStatus !== 'SUCCEEDED') {
          console.error(JSON.stringify({
            ok: false,
            errorCode: 'PURCHASE_ORDER_HISTORY_PLAN_INCOMPLETE',
            manifestHash: manifest.manifestHash,
            planHash: plan.planHash,
            runStatus: result.runStatus,
            completedPlans,
          }));
          process.exitCode = 2;
          return;
        }
        completedPlans += 1;
        console.log(JSON.stringify({
          ok: true,
          event: 'PURCHASE_ORDER_HISTORY_PLAN_COMPLETED',
          manifestHash: manifest.manifestHash,
          planHash: plan.planHash,
          completedPlans,
          planCount: manifest.planCount,
          adapterInvocationCount: result.adapterInvocationCount,
          checkpointAdvancedCount: result.checkpointAdvancedCount,
        }));
      } finally {
        await runtime.close().catch(() => {});
      }
    }
    console.log(JSON.stringify(report(manifest, {
      mode: 'EXECUTE',
      completedPlans,
      adapterInvocationCount,
      checkpointAdvancedCount,
    }), null, 2));
  } catch (error) {
    const errorCode = String(error?.message ?? 'PURCHASE_ORDER_HISTORY_FAILED')
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_')
      .slice(0, 80);
    console.error(JSON.stringify({ ok: false, errorCode }));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('backfill_full_managed_purchase_order_history.mjs')) {
  await main();
}
