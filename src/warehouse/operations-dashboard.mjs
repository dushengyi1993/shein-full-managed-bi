import crypto from 'node:crypto';

import {
  readFullManagedSupplyDashboard,
  readFullManagedSupplySyncHealth,
} from './supply-repository.mjs';
import { createFullManagedWebhookRepository } from './webhook-repository.mjs';

const EMPTY_SUPPLY = Object.freeze({
  status: 'pending',
  coverage: Object.freeze({ totalStores: null, domains: Object.freeze({}) }),
  purchaseOrderStatus: Object.freeze([]),
  deliveryMilestones: Object.freeze([]),
  inventory: Object.freeze([]),
  stockAdvice: Object.freeze([]),
  purchaseOrderAttention: Object.freeze([]),
  deliveryAttention: Object.freeze([]),
  inventoryRisks: Object.freeze([]),
  stockAdviceRisks: Object.freeze([]),
  attentionMeta: Object.freeze({
    purchaseOrders: Object.freeze({ total: 0, returned: 0, truncated: false }),
    deliveries: Object.freeze({ total: 0, returned: 0, truncated: false }),
    inventoryRisks: Object.freeze({ total: 0, returned: 0, truncated: false }),
    stockAdviceRisks: Object.freeze({ total: 0, returned: 0, truncated: false }),
  }),
});

const EMPTY_PLATFORM = Object.freeze({
  status: 'pending',
  health: null,
  queue: null,
  eventMeta: null,
  subscriptions: Object.freeze([]),
  events: Object.freeze([]),
});

const WEBHOOK_EVENT_MATERIALIZATION_LIMIT = 100;

function instant(value) {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

const SUPPLY_COVERAGE_GRAINS = Object.freeze({
  productCatalog: Object.freeze([
    Object.freeze({ domainCode: 'PRODUCT_CATALOG', subtypeCode: 'ALL' }),
  ]),
  productDetails: Object.freeze([
    Object.freeze({ domainCode: 'PRODUCT_DETAILS', subtypeCode: 'ALL' }),
  ]),
  inventory: Object.freeze([
    Object.freeze({ domainCode: 'INVENTORY', subtypeCode: 'PI' }),
    Object.freeze({ domainCode: 'INVENTORY', subtypeCode: 'JI' }),
  ]),
  stockAdvice: Object.freeze([
    Object.freeze({ domainCode: 'STOCK_ADVICE', subtypeCode: 'ALL' }),
  ]),
  purchaseOrders: Object.freeze([
    Object.freeze({ domainCode: 'PURCHASE_ORDERS', subtypeCode: 'ALL' }),
  ]),
  deliveries: Object.freeze([
    Object.freeze({ domainCode: 'DELIVERIES', subtypeCode: 'ALL' }),
  ]),
});

const SUPPLY_LIVE_MAX_AGE_MS = 5 * 60 * 60_000;
const SUPPLY_STARTED_TIMEOUT_MS = 45 * 60_000;

function attemptMoment(attempt) {
  return instant(attempt.completedAt ?? attempt.startedAt);
}

function latestInstant(values, selector) {
  const timestamps = values
    .map(selector)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function earliestInstant(values, selector) {
  const timestamps = values
    .map(selector)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null;
}

export async function readSupplyCoverage(client, {
  evaluatedAt = null,
  liveMaxAgeMs = SUPPLY_LIVE_MAX_AGE_MS,
  startedTimeoutMs = SUPPLY_STARTED_TIMEOUT_MS,
} = {}) {
  const storesResult = await client.query(
    `SELECT store_id, store_code
       FROM dim.store
      WHERE cooperation_mode = 'FULL_MANAGED'
        AND is_active = true
      ORDER BY store_code`,
  );
  const stores = storesResult.rows.map((row) => ({
    storeId: Number(row.store_id),
    storeCode: String(row.store_code),
  }));
  if (stores.some(({ storeId, storeCode }) => (
    !Number.isSafeInteger(storeId) || storeId < 1 || !storeCode
  ))) {
    throw new RangeError('Active full-managed store catalog is invalid');
  }
  const clock = evaluatedAt ?? (await client.query(
    'SELECT clock_timestamp() AS evaluated_at',
  )).rows?.[0]?.evaluated_at;
  const evaluated = instant(clock);
  if (!evaluated) throw new RangeError('Supply coverage evaluation clock is invalid');
  const evaluatedMs = new Date(evaluated).getTime();
  const attempts = await readFullManagedSupplySyncHealth(client, {
    storeIds: stores.map(({ storeId }) => storeId),
    freshnessScope: 'LIVE',
  });
  const byGrain = new Map(attempts.map((attempt) => [
    [
      attempt.storeId,
      attempt.domainCode,
      attempt.subtypeCode,
    ].join('\u001f'),
    attempt,
  ]));
  const domains = {};

  for (const [domainKey, grains] of Object.entries(SUPPLY_COVERAGE_GRAINS)) {
    const succeededStoreCodes = [];
    const failedStoreCodes = [];
    const missingStoreCodes = [];
    const staleStoreCodes = [];
    const inProgressStoreCodes = [];
    const successfulAttempts = [];
    const observedAttempts = [];
    const modes = new Set();

    for (const store of stores) {
      const storeAttempts = grains.map(({ domainCode, subtypeCode }) => (
        byGrain.get([store.storeId, domainCode, subtypeCode].join('\u001f')) ?? null
      ));
      const present = storeAttempts.filter(Boolean);
      observedAttempts.push(...present);
      present.forEach(({ modeCode }) => modes.add(modeCode));
      const missing = present.length !== grains.length;
      const failed = present.some(({ status }) => ['FAILED', 'PARTIAL'].includes(status));
      const started = present.some(({ status }) => status === 'STARTED');
      const stale = present.some((attempt) => {
        const moment = attemptMoment(attempt);
        if (!moment) return true;
        const age = evaluatedMs - new Date(moment).getTime();
        return attempt.status === 'STARTED'
          ? age > startedTimeoutMs
          : attempt.status === 'SUCCEEDED' && age > liveMaxAgeMs;
      });
      const allSucceeded = (
        !missing
        && storeAttempts.every(({ status }) => status === 'SUCCEEDED')
        && !stale
      );

      if (allSucceeded) {
        succeededStoreCodes.push(store.storeCode);
        successfulAttempts.push(...storeAttempts);
      } else if (failed || stale) {
        failedStoreCodes.push(store.storeCode);
        if (stale) staleStoreCodes.push(store.storeCode);
      } else if (missing) {
        missingStoreCodes.push(store.storeCode);
      } else if (started) {
        inProgressStoreCodes.push(store.storeCode);
      } else {
        failedStoreCodes.push(store.storeCode);
      }
    }

    const totalStores = stores.length;
    const succeededStores = succeededStoreCodes.length;
    const failedStores = failedStoreCodes.length;
    const missingStores = missingStoreCodes.length;
    const inProgressStores = inProgressStoreCodes.length;
    const status = totalStores > 0 && succeededStores === totalStores
      ? 'complete'
      : failedStores > 0 && succeededStores === 0
        ? 'blocked'
        : observedAttempts.length > 0
          ? 'partial'
          : 'pending';
    const mode = modes.size === 1 ? [...modes][0] : modes.size > 1 ? 'MIXED' : null;
    domains[domainKey] = Object.freeze({
      status,
      totalStores,
      observedStores: new Set(observedAttempts.map(({ storeId }) => storeId)).size,
      succeededStores,
      failedStores,
      missingStores,
      inProgressStores,
      staleStores: staleStoreCodes.length,
      succeededStoreCodes: Object.freeze(succeededStoreCodes),
      failedStoreCodes: Object.freeze(failedStoreCodes),
      missingStoreCodes: Object.freeze(missingStoreCodes),
      staleStoreCodes: Object.freeze(staleStoreCodes),
      inProgressStoreCodes: Object.freeze(inProgressStoreCodes),
      latestFetchedAt: latestInstant(observedAttempts, attemptMoment),
      watermarkStart: earliestInstant(successfulAttempts, (attempt) => attempt.window?.start),
      watermarkEnd: latestInstant(successfulAttempts, (attempt) => attempt.window?.end),
      evaluatedAt: evaluated,
      freshnessMaxAgeSeconds: Math.floor(liveMaxAgeMs / 1_000),
      mode,
      reason: status === 'complete'
        ? `${succeededStores}/${totalStores} 家店的全部必需子域均在时效内成功`
        : `${succeededStores}/${totalStores} 家店成功，${failedStores} 家失败或过期，${missingStores} 家缺少必需子域，${inProgressStores} 家同步中`,
    });
  }

  return Object.freeze({
    totalStores: stores.length,
    domains: Object.freeze(domains),
  });
}

function candidateKey(parts) {
  return crypto
    .createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u001f'), 'utf8')
    .digest('base64url')
    .slice(0, 24);
}

function candidate({
  storeCode = null,
  type,
  severity,
  title,
  reason,
  entityCode = null,
  evidenceAt = null,
}) {
  return Object.freeze({
    candidateKey: candidateKey([
      storeCode,
      type,
      entityCode,
      evidenceAt,
      reason,
    ]),
    storeCode,
    type,
    severity,
    title,
    reason,
    entityCode,
    evidenceAt,
  });
}

const ACTION_SEVERITY_WEIGHT = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
});

function fairlyOrderActionCandidates(candidates) {
  const severityOrdered = [...candidates].sort(
    (left, right) => (
      (ACTION_SEVERITY_WEIGHT[right.severity] ?? 0)
      - (ACTION_SEVERITY_WEIGHT[left.severity] ?? 0)
    ),
  );
  const deduplicated = [];
  const seen = new Set();
  for (const item of severityOrdered) {
    const key = [
      item.storeCode ?? '',
      item.type,
      item.entityCode ?? '',
    ].join('\u001f');
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(item);
  }

  const severityGroups = new Map();
  for (const item of deduplicated) {
    const weight = ACTION_SEVERITY_WEIGHT[item.severity] ?? 0;
    if (!severityGroups.has(weight)) severityGroups.set(weight, new Map());
    const typeGroups = severityGroups.get(weight);
    if (!typeGroups.has(item.type)) typeGroups.set(item.type, []);
    typeGroups.get(item.type).push(item);
  }

  const fairlyOrdered = [];
  const weights = [...severityGroups.keys()].sort((left, right) => right - left);
  for (const weight of weights) {
    const typeGroups = severityGroups.get(weight);
    let remaining = true;
    while (remaining) {
      remaining = false;
      for (const rows of typeGroups.values()) {
        const item = rows.shift();
        if (!item) continue;
        fairlyOrdered.push(item);
        remaining = true;
      }
    }
  }
  return fairlyOrdered;
}

export function buildReadOnlyActionPool(supply, platform) {
  const candidates = [];
  for (const row of supply.purchaseOrderAttention ?? []) {
    if (!String(row.attentionCode ?? '').endsWith('_OVERDUE')) continue;
    candidates.push(candidate({
      storeCode: row.storeCode,
      type: 'PURCHASE_ORDER_OVERDUE',
      severity: row.severity ?? 'critical',
      title: '处理逾期采购单',
      reason: `${row.orderNo}：${row.attentionLabel ?? '采购单已超过计划节点'}。`,
      entityCode: row.orderNo,
      evidenceAt: row.latestSourceFetchedAt,
    }));
  }
  for (const row of supply.deliveryAttention ?? []) {
    if (!String(row.attentionCode ?? '').endsWith('_OVERDUE')) continue;
    candidates.push(candidate({
      storeCode: row.storeCode,
      type: 'DELIVERY_OVERDUE',
      severity: row.severity ?? 'critical',
      title: '处理逾期送货单',
      reason: `${row.deliveryCode}：${row.attentionLabel ?? '送货单已超过计划节点'}。`,
      entityCode: row.deliveryCode,
      evidenceAt: row.latestSourceFetchedAt,
    }));
  }
  for (const row of supply.inventoryRisks ?? []) {
    if (!Number.isSafeInteger(row.shortageQuantity) || row.shortageQuantity <= 0) continue;
    candidates.push(candidate({
      storeCode: row.storeCode,
      type: 'SKU_SHORTAGE_REVIEW',
      severity: row.severity ?? 'critical',
      title: '处理SKU缺货',
      reason: `${row.skuCode}（${row.inventoryTypeCode}）平台缺货数量为 ${row.shortageQuantity}。`,
      entityCode: `${row.inventoryTypeCode}:${row.skuCode}`,
      evidenceAt: row.latestSourceFetchedAt,
    }));
  }
  for (const row of supply.stockAdviceRisks ?? []) {
    if (
      Number.isSafeInteger(row.plannedUrgentQuantity)
      && row.plannedUrgentQuantity > 0
    ) {
      candidates.push(candidate({
        storeCode: row.storeCode,
        type: 'SKU_URGENT_SUPPLY_REVIEW',
        severity: row.severity ?? 'critical',
        title: '处理SKU急采',
        reason: `${row.skuCode} 的平台计划急采数量为 ${row.plannedUrgentQuantity}。`,
        entityCode: row.skuCode,
        evidenceAt: row.latestSourceFetchedAt,
      }));
    } else if (row.stockWarningIsWarning === true) {
      candidates.push(candidate({
        storeCode: row.storeCode,
        type: 'SKU_STOCK_WARNING_REVIEW',
        severity: row.severity ?? 'high',
        title: '复核SKU库存预警',
        reason: `${row.skuCode} 返回平台库存预警。`,
        entityCode: row.skuCode,
        evidenceAt: row.latestSourceFetchedAt,
      }));
    } else if (
      Number.isSafeInteger(row.advisedOrderQuantity)
      && row.advisedOrderQuantity > 0
    ) {
      candidates.push(candidate({
        storeCode: row.storeCode,
        type: 'SKU_RESTOCK_ADVICE_REVIEW',
        severity: row.severity ?? 'medium',
        title: '复核SKU建议备货',
        reason: `${row.skuCode} 的平台建议备货数量为 ${row.advisedOrderQuantity}。`,
        entityCode: row.skuCode,
        evidenceAt: row.latestSourceFetchedAt,
      }));
    }
  }
  for (const [domain, coverage] of Object.entries(supply.coverage?.domains ?? {})) {
    for (const storeCode of coverage.failedStoreCodes ?? []) {
      candidates.push(candidate({
        storeCode,
        type: 'SUPPLY_SYNC_FAILURE_REVIEW',
        severity: 'high',
        title: '复核供应链同步失败',
        reason: `${domain} 最新只读批次失败或仅部分完成。`,
        entityCode: domain,
        evidenceAt: coverage.latestFetchedAt,
      }));
    }
    for (const storeCode of coverage.missingStoreCodes ?? []) {
      candidates.push(candidate({
        storeCode,
        type: 'SUPPLY_COVERAGE_REVIEW',
        severity: 'medium',
        title: '补齐供应链数据覆盖',
        reason: `${domain} 尚无该店成功或失败批次证据，不能按零展示。`,
        entityCode: domain,
        evidenceAt: coverage.latestFetchedAt,
      }));
    }
  }
  for (const row of supply.inventory ?? []) {
    if (Number.isSafeInteger(row.shortageSkuCount) && row.shortageSkuCount > 0) {
      candidates.push(candidate({
        storeCode: row.storeCode,
        type: 'SHORTAGE_REVIEW',
        severity: 'high',
        title: '复核缺货商品',
        reason: `${row.shortageSkuCount} 个SKU有平台缺货观测，缺货数量${
          Number.isSafeInteger(row.shortageQuantity) ? `为 ${row.shortageQuantity}` : '尚未完整返回'
        }。`,
        entityCode: row.inventoryTypeCode,
        evidenceAt: row.latestSourceFetchedAt,
      }));
    }
    if (
      Number.isSafeInteger(row.reconciliationMismatchCount)
      && row.reconciliationMismatchCount > 0
    ) {
      candidates.push(candidate({
        storeCode: row.storeCode,
        type: 'INVENTORY_RECONCILIATION',
        severity: 'high',
        title: '核对库存分项',
        reason: `${row.reconciliationMismatchCount} 个库存快照的仓库分项与汇总不一致。`,
        entityCode: row.inventoryTypeCode,
        evidenceAt: row.latestSourceFetchedAt,
      }));
    }
  }
  for (const row of supply.stockAdvice ?? []) {
    if (Number.isSafeInteger(row.warningSkuCount) && row.warningSkuCount > 0) {
      candidates.push(candidate({
        storeCode: row.storeCode,
        type: 'STOCK_WARNING_REVIEW',
        severity: 'high',
        title: '复核平台库存预警',
        reason: `${row.warningSkuCount} 个SKU返回库存预警状态。`,
        evidenceAt: row.latestSourceFetchedAt,
      }));
    }
    if (Number.isSafeInteger(row.advisedSkuCount) && row.advisedSkuCount > 0) {
      candidates.push(candidate({
        storeCode: row.storeCode,
        type: 'RESTOCK_ADVICE_REVIEW',
        severity: 'medium',
        title: '复核平台建议备货',
        reason: `${row.advisedSkuCount} 个SKU有建议备货量，建议总量${
          Number.isSafeInteger(row.advisedOrderQuantity)
            ? `为 ${row.advisedOrderQuantity}`
            : '尚未完整返回'
        }。`,
        evidenceAt: row.latestSourceFetchedAt,
      }));
    }
    if (
      Number.isSafeInteger(row.plannedUrgentQuantity)
      && row.plannedUrgentQuantity > 0
    ) {
      candidates.push(candidate({
        storeCode: row.storeCode,
        type: 'URGENT_SUPPLY_REVIEW',
        severity: 'medium',
        title: '复核急采计划',
        reason: `平台计划急采数量为 ${row.plannedUrgentQuantity}。`,
        evidenceAt: row.latestSourceFetchedAt,
      }));
    }
  }
  if (Number.isSafeInteger(platform.queue?.deadLetter) && platform.queue.deadLetter > 0) {
    candidates.push(candidate({
      type: 'WEBHOOK_DEAD_LETTER',
      severity: 'high',
      title: '处理Webhook死信',
      reason: `${platform.queue.deadLetter} 个Webhook任务进入死信队列。`,
      evidenceAt: platform.queue.lastProcessedAt ?? platform.queue.lastReceivedAt,
    }));
  }
  if (
    Number.isSafeInteger(platform.queue?.blockedStores)
    && platform.queue.blockedStores > 0
  ) {
    candidates.push(candidate({
      type: 'AUTHORIZATION_GATE_REVIEW',
      severity: 'high',
      title: '复核授权变化封闸',
      reason: `${platform.queue.blockedStores} 家店因授权变化处于封闸状态。`,
      evidenceAt: platform.queue.lastProcessedAt ?? platform.queue.lastReceivedAt,
    }));
  }
  const fairlyOrdered = fairlyOrderActionCandidates(candidates);
  const returnedCandidates = fairlyOrdered.slice(0, 100);
  return Object.freeze({
    mode: 'observe_only',
    writeEnabled: false,
    candidates: Object.freeze(returnedCandidates),
    meta: Object.freeze({
      total: fairlyOrdered.length,
      returned: returnedCandidates.length,
      truncated: fairlyOrdered.length > returnedCandidates.length,
    }),
  });
}

function repositoryPoolForClient(client) {
  return Object.freeze({
    connect: async () => client,
    query: (...args) => client.query(...args),
  });
}

function readiness(row) {
  const supplyReady = [
    row.purchase_order_ready,
    row.delivery_ready,
    row.inventory_ready,
    row.stock_advice_ready,
  ].every((value) => value === true);
  const webhookReady = [
    row.webhook_receipt_ready,
    row.webhook_job_ready,
    row.operational_event_ready,
    row.subscription_state_ready,
  ].every((value) => value === true);
  return Object.freeze({
    supplyReady,
    webhookReady,
    productIdentityReady: row.product_identity_ready === true,
    employeeAccessReady: row.employee_access_ready === true,
  });
}

/**
 * Materialize read-only operational summaries from one repeatable-read
 * snapshot. Missing migrations are represented as pending domains, not zeros.
 */
export async function readOperationsDashboard(pool) {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionOpen = true;
    const schemaResult = await client.query(`
      SELECT
        to_regclass('fact.purchase_order') IS NOT NULL AS purchase_order_ready,
        to_regclass('fact.delivery') IS NOT NULL AS delivery_ready,
        to_regclass('fact.inventory_snapshot') IS NOT NULL AS inventory_ready,
        to_regclass('fact.stock_advice_snapshot') IS NOT NULL AS stock_advice_ready,
        to_regclass('raw.webhook_receipt') IS NOT NULL AS webhook_receipt_ready,
        to_regclass('ops.webhook_job') IS NOT NULL AS webhook_job_ready,
        to_regclass('ops.operational_event') IS NOT NULL AS operational_event_ready,
        to_regclass('ops.webhook_subscription_state') IS NOT NULL AS subscription_state_ready,
        (
          to_regclass('dim.canonical_product') IS NOT NULL
          AND to_regclass('dim.full_sku_canonical_assignment') IS NOT NULL
          AND to_regclass('ops.canonical_product_observation_set') IS NOT NULL
          AND to_regclass('ops.product_match_candidate_evidence') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'dim'
              AND table_name = 'canonical_product'
              AND column_name = 'identity_scope'
          )
          AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'dim'
              AND table_name = 'full_sku_canonical_assignment'
              AND column_name = 'identity_scope'
          )
        ) AS product_identity_ready,
        to_regclass('ops.employee_store_assignment') IS NOT NULL AS employee_access_ready`);
    const schemaReadiness = readiness(schemaResult.rows[0] ?? {});

    let supply = EMPTY_SUPPLY;
    if (schemaReadiness.supplyReady) {
      const rows = await readFullManagedSupplyDashboard(client);
      const coverage = await readSupplyCoverage(client);
      supply = Object.freeze({ status: 'available', coverage, ...rows });
    }

    let platform = EMPTY_PLATFORM;
    if (schemaReadiness.webhookReady) {
      const repository = createFullManagedWebhookRepository({
        pool: repositoryPoolForClient(client),
      });
      const eventRows = await repository.listOperationalEvents({
        allowedStores: '*',
        // One look-ahead row proves whether the bounded Dashboard slice was
        // truncated without materializing an unbounded event history.
        limit: WEBHOOK_EVENT_MATERIALIZATION_LIMIT + 1,
        includeTechnical: true,
        includeUnknown: false,
      });
      const events = eventRows.slice(0, WEBHOOK_EVENT_MATERIALIZATION_LIMIT);
      const subscriptions = await repository.listSubscriptionState();
      const queue = await repository.getQueueHealth();
      const schemaHealth = await repository.health();
      const runtimeHealth = await repository.getRuntimeHealth();
      platform = Object.freeze({
        status: 'available',
        health: Object.freeze({
          warehouseReady: schemaHealth.ok === true,
          ...runtimeHealth,
        }),
        queue: Object.freeze(queue),
        eventMeta: Object.freeze({
          returned: events.length,
          limit: WEBHOOK_EVENT_MATERIALIZATION_LIMIT,
          truncated: eventRows.length > WEBHOOK_EVENT_MATERIALIZATION_LIMIT,
        }),
        subscriptions: Object.freeze(subscriptions),
        events: Object.freeze(events),
      });
    }

    const actionPool = buildReadOnlyActionPool(supply, platform);
    await client.query('COMMIT');
    transactionOpen = false;
    return Object.freeze({
      supply,
      platform,
      actionPool,
      system: Object.freeze({
        schemaReadiness,
        writeActionsEnabled: false,
      }),
    });
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
