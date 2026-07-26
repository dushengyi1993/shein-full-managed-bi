import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DASHBOARD_DATA_FILE = fileURLToPath(
  new URL('../../tests/fixtures/dashboard.json', import.meta.url),
);

const PERMISSION_LABELS = Object.freeze({
  granted: '销量查询权限已授权',
  partial: '销量查询权限部分授权',
  pending: '销量查询权限申请中',
  denied: '销量查询权限未通过',
  unknown: '销量查询权限待确认',
});

const DATASET_LABELS = Object.freeze({
  live: '实时数据',
  empty: '暂无销量快照',
  sample: '本地示例数据',
});

const READINESS_LABELS = Object.freeze({
  complete: '已完成',
  pending: '进行中',
  not_started: '待开始',
  blocked: '受阻',
  unknown: '待确认',
});

const SALES_QUALITY_STATUSES = Object.freeze(new Set([
  'healthy',
  'partial',
  'legal_zero',
  'stale',
  'error',
  'unavailable',
]));

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, fallback = '', maxLength = 120) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function optionalNonNegativeInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function isoInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function optionalBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function unitCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function safeUnitSum(values) {
  if (!values.length || values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return null;
  }
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function isoDate(value) {
  const source = text(value, '', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source)) return null;
  const parsed = new Date(`${source}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === source
    ? source
    : null;
}

function qualityStatus(value, fallback = 'unavailable') {
  return SALES_QUALITY_STATUSES.has(value) ? value : fallback;
}

function permissionStatus(value) {
  return Object.hasOwn(PERMISSION_LABELS, value) ? value : 'unknown';
}

function readinessStatus(value) {
  return Object.hasOwn(READINESS_LABELS, value) ? value : 'unknown';
}

function normalizeUnits(value, includeYesterday = false) {
  const units = record(value);
  const normalized = {
    today: unitCount(units.today),
    last7Days: unitCount(units.last7Days),
    last30Days: unitCount(units.last30Days),
  };

  if (includeYesterday) {
    normalized.yesterday = unitCount(units.yesterday);
    return {
      today: normalized.today,
      yesterday: normalized.yesterday,
      last7Days: normalized.last7Days,
      last30Days: normalized.last30Days,
    };
  }

  return normalized;
}

function normalizeStore(item) {
  const source = record(item);
  const status = permissionStatus(source.permissionStatus);
  return {
    code: text(source.code, '未知店铺', 24),
    name: text(source.name, text(source.code, '未知店铺', 24), 80),
    ownerKey: text(source.ownerKey, '', 128) || null,
    ownerName: text(source.ownerName, '', 128) || null,
    businessDate: isoDate(source.businessDate),
    qualityStatus: qualityStatus(source.qualityStatus),
    qualityReason: text(source.qualityReason, '尚无可解释的销量观测', 240),
    unitsSold: normalizeUnits(source.unitsSold, true),
    permission: {
      status,
      label: PERMISSION_LABELS[status],
    },
  };
}

function normalizeOwner(item) {
  const source = record(item);
  const key = text(source.key ?? source.employeeCode ?? source.username, '', 128);
  if (!key) return null;
  const storeCodes = Array.isArray(source.storeCodes)
    ? [...new Set(
      source.storeCodes
        .map((value) => text(value, '', 24).toUpperCase())
        .filter(Boolean),
    )].sort()
    : [];
  return {
    key,
    name: text(source.name ?? source.displayName, key, 128),
    storeCodes,
  };
}

function normalizeSku(item) {
  const source = record(item);
  const canonicalProductId = text(source.canonicalProductId, '', 80) || null;
  const standardProductCode = text(source.standardProductCode, '', 120) || null;
  const confirmed = (
    source.mappingStatus === 'CONFIRMED'
    && canonicalProductId !== null
    && standardProductCode !== null
  );
  const unmappedStatus = source.mappingStatus === 'MISSING_SPU_ID'
    ? 'MISSING_SPU_ID'
    : 'UNMAPPED';
  return {
    storeCode: text(source.storeCode, '', 24) || null,
    sku: text(source.sku, '未知 SKU', 64),
    skc: text(source.skc, '', 80) || null,
    supplierCode: text(source.supplierCode, '', 80) || null,
    supplierSku: text(source.supplierSku, '', 120) || null,
    productKey: text(source.productKey, '', 160) || null,
    name: text(source.name, '未命名商品', 120),
    canonicalProductId: confirmed ? canonicalProductId : null,
    standardProductCode: confirmed ? standardProductCode : null,
    standardProductName: confirmed
      ? text(source.standardProductName, '', 160) || null
      : null,
    mappingStatus: confirmed ? 'CONFIRMED' : unmappedStatus,
    businessDate: isoDate(source.businessDate),
    unitsSold: normalizeUnits(source.unitsSold, true),
  };
}

function normalizeStoreBreakdown(item) {
  const source = record(item);
  const storeCode = text(source.storeCode, '', 24);
  if (!storeCode) return null;
  return {
    storeCode,
    unitsSold: normalizeUnits(source.unitsSold, true),
  };
}

function normalizeProduct(item) {
  const source = record(item);
  const storeCode = text(source.storeCode, '', 24) || null;
  const breakdownByStore = new Map();
  for (const row of Array.isArray(source.storeBreakdown) ? source.storeBreakdown : []) {
    const normalized = normalizeStoreBreakdown(row);
    if (normalized) breakdownByStore.set(normalized.storeCode, normalized);
  }
  const storeBreakdown = [...breakdownByStore.values()];
  const canonicalProductId = text(source.canonicalProductId, '', 80) || null;
  const standardProductCode = text(source.standardProductCode, '', 120) || null;
  const canonicalConfirmed = (
    source.identityLevel === 'CANONICAL_CONFIRMED'
    && canonicalProductId !== null
    && standardProductCode !== null
    && storeBreakdown.length > 0
  );
  const unmappedStatus = source.mappingStatus === 'MISSING_SPU_ID'
    ? 'MISSING_SPU_ID'
    : 'UNVERIFIED';
  if (!canonicalConfirmed && !storeCode) return null;
  const unitsSold = canonicalConfirmed
    ? Object.fromEntries(
        ['today', 'yesterday', 'last7Days', 'last30Days'].map((field) => {
          const values = storeBreakdown.map((row) => row.unitsSold[field]);
          return [field, safeUnitSum(values)];
        }),
      )
    : normalizeUnits(source.unitsSold, true);
  return {
    canonicalProductId: canonicalConfirmed ? canonicalProductId : null,
    standardProductCode: canonicalConfirmed ? standardProductCode : null,
    name: text(source.name, '未命名商品', 160),
    storeCode: canonicalConfirmed ? null : storeCode,
    storeCodes: canonicalConfirmed
      ? storeBreakdown.map(({ storeCode: code }) => code)
      : [storeCode],
    productKey: text(source.productKey, '', 160) || null,
    identityLevel: canonicalConfirmed
      ? 'CANONICAL_CONFIRMED'
      : 'STORE_LOCAL_UNVERIFIED',
    mappingStatus: canonicalConfirmed ? 'CONFIRMED' : unmappedStatus,
    storeCount: canonicalConfirmed ? storeBreakdown.length : 1,
    storeBreakdown: canonicalConfirmed ? storeBreakdown : [],
    unitsSold,
  };
}

function normalizeReadinessStage(item) {
  const source = record(item);
  const status = readinessStatus(source.status);
  const total = optionalNonNegativeInteger(source.total);
  const completedSource = optionalNonNegativeInteger(source.completed);
  const completed = total === null || completedSource === null
    ? completedSource
    : Math.min(completedSource, total);

  return {
    key: text(source.key, 'unknown', 48),
    label: text(source.label, '待确认阶段', 80),
    status,
    statusLabel: READINESS_LABELS[status],
    completed,
    total,
    note: text(source.note, '', 180),
  };
}

function normalizeSalesTrend(items) {
  if (!Array.isArray(items)) return [];

  const byDate = new Map();
  for (const item of items.slice(0, 366)) {
    const source = record(item);
    const date = isoDate(source.date);
    if (!date) continue;
    byDate.set(date, {
      date,
      unitsSold: unitCount(source.unitsSold),
      coveredStores: optionalNonNegativeInteger(source.coveredStores),
    });
  }

  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function normalizeSalesTrendByStore(items) {
  if (!Array.isArray(items)) return [];
  const byGrain = new Map();
  for (const item of items.slice(0, 24 * 366)) {
    const source = record(item);
    const storeCode = text(source.storeCode, '', 24);
    const date = isoDate(source.date);
    const unitsSold = unitCount(source.unitsSold);
    if (!storeCode || !date || unitsSold === null) continue;
    byGrain.set(`${storeCode}\u001f${date}`, { storeCode, date, unitsSold });
  }
  return [...byGrain.values()].sort(
    (left, right) => left.date.localeCompare(right.date)
      || left.storeCode.localeCompare(right.storeCode),
  );
}

function normalizeSalesCoverage(value, businessDate, totalStores) {
  const source = record(value);
  const status = ['complete', 'partial', 'legal_zero', 'blocked', 'unknown']
    .includes(source.status)
    ? source.status
    : 'unknown';
  const normalizedTotalStores = totalStores ?? optionalNonNegativeInteger(source.totalStores);
  const limitToTotal = (count) => {
    const normalized = optionalNonNegativeInteger(count);
    return normalizedTotalStores === null || normalized === null
      ? normalized
      : Math.min(normalized, normalizedTotalStores);
  };
  return {
    businessDate: isoDate(source.businessDate) ?? businessDate,
    coveredStores: limitToTotal(source.coveredStores),
    legalZeroStores: limitToTotal(source.legalZeroStores),
    totalStores: normalizedTotalStores,
    status,
    label: text(source.label, '等待销量数据', 100),
    reason: text(source.reason, '尚无完整、可解释的销量观测', 280),
    partialStores: limitToTotal(source.partialStores),
    quarantinedRows: optionalNonNegativeInteger(source.quarantinedRows),
    datedRows: optionalNonNegativeInteger(source.datedRows),
    totalRows: optionalNonNegativeInteger(source.totalRows),
  };
}

function normalizeQuality(value) {
  const source = record(value);
  return {
    status: qualityStatus(source.status),
    label: text(source.label, '暂无销量数据', 100),
    reason: text(source.reason, '尚未形成可信销量观测', 280),
    impact: text(source.impact, '销量指标不会把缺数显示为零', 280),
    nextStep: text(source.nextStep, '', 280) || null,
  };
}

function operationStatus(value) {
  return ['available', 'pending', 'partial', 'blocked', 'error'].includes(value)
    ? value
    : 'pending';
}

function normalizeCountCoverage(value, knownKey, totalKey) {
  const source = record(value);
  return {
    [knownKey]: optionalNonNegativeInteger(source[knownKey]),
    [totalKey]: optionalNonNegativeInteger(source[totalKey]),
  };
}

function normalizeOperationCommon(item) {
  const source = record(item);
  const storeCode = text(source.storeCode, '', 24).toUpperCase();
  if (!storeCode) return null;
  return {
    source,
    common: {
      storeCode,
      storeName: text(source.storeName, storeCode, 80),
      latestSourceFetchedAt: isoInstant(source.latestSourceFetchedAt),
    },
  };
}

function normalizePurchaseOrderStatus(item) {
  const normalized = normalizeOperationCommon(item);
  if (!normalized) return null;
  const { source, common } = normalized;
  const statusCode = text(source.statusCode, '', 80);
  if (!statusCode) return null;
  return {
    ...common,
    statusCode,
    statusName: text(source.statusName, '', 120) || null,
    orderCount: optionalNonNegativeInteger(source.orderCount),
  };
}

function normalizeDeliveryMilestone(item) {
  const normalized = normalizeOperationCommon(item);
  if (!normalized) return null;
  const { source, common } = normalized;
  const milestoneCode = text(source.milestoneCode, '', 80);
  if (!milestoneCode) return null;
  return {
    ...common,
    milestoneCode,
    deliveryCount: optionalNonNegativeInteger(source.deliveryCount),
    deliveryQuantity: optionalNonNegativeInteger(source.deliveryQuantity),
    deliveryQuantityCoverage: normalizeCountCoverage(
      source.deliveryQuantityCoverage,
      'knownLineCount',
      'totalLineCount',
    ),
  };
}

function normalizeInventorySummary(item) {
  const normalized = normalizeOperationCommon(item);
  if (!normalized) return null;
  const { source, common } = normalized;
  const inventoryTypeCode = text(source.inventoryTypeCode, '', 80);
  if (!inventoryTypeCode) return null;
  return {
    ...common,
    inventoryTypeCode,
    skuCount: optionalNonNegativeInteger(source.skuCount),
    inventoryQuantity: optionalNonNegativeInteger(source.inventoryQuantity),
    usableInventory: optionalNonNegativeInteger(source.usableInventory),
    transitQuantity: optionalNonNegativeInteger(source.transitQuantity),
    transitCoverage: normalizeCountCoverage(
      source.transitCoverage,
      'knownSkuCount',
      'totalSkuCount',
    ),
    shortageSkuCount: optionalNonNegativeInteger(source.shortageSkuCount),
    shortageQuantity: optionalNonNegativeInteger(source.shortageQuantity),
    shortageCoverage: normalizeCountCoverage(
      source.shortageCoverage,
      'knownSkuCount',
      'totalSkuCount',
    ),
    reconciliationMismatchCount: optionalNonNegativeInteger(
      source.reconciliationMismatchCount,
    ),
  };
}

function normalizeStockAdviceSummary(item) {
  const normalized = normalizeOperationCommon(item);
  if (!normalized) return null;
  const { source, common } = normalized;
  return {
    ...common,
    totalSkuCount: optionalNonNegativeInteger(source.totalSkuCount),
    advisedSkuCount: optionalNonNegativeInteger(source.advisedSkuCount),
    advisedOrderQuantity: optionalNonNegativeInteger(source.advisedOrderQuantity),
    advisedOrderCoverage: normalizeCountCoverage(
      source.advisedOrderCoverage,
      'knownSkuCount',
      'totalSkuCount',
    ),
    plannedUrgentQuantity: optionalNonNegativeInteger(source.plannedUrgentQuantity),
    plannedUrgentCoverage: normalizeCountCoverage(
      source.plannedUrgentCoverage,
      'knownSkuCount',
      'totalSkuCount',
    ),
    warningSkuCount: optionalNonNegativeInteger(source.warningSkuCount),
    warningCoverage: normalizeCountCoverage(
      source.warningCoverage,
      'knownSkuCount',
      'totalSkuCount',
    ),
  };
}

function normalizeDomainCoverage(item) {
  const source = record(item);
  const normalizeStoreCodes = (value) => (
    Array.isArray(value)
      ? [...new Set(
          value
            .map((item) => text(item, '', 24).toUpperCase())
            .filter(Boolean),
        )].sort()
      : []
  );
  return {
    status: ['complete', 'partial', 'pending', 'blocked', 'unknown'].includes(source.status)
      ? source.status
      : 'unknown',
    observedStores: optionalNonNegativeInteger(source.observedStores),
    succeededStores: optionalNonNegativeInteger(source.succeededStores),
    failedStores: optionalNonNegativeInteger(source.failedStores),
    missingStores: optionalNonNegativeInteger(source.missingStores),
    inProgressStores: optionalNonNegativeInteger(source.inProgressStores),
    staleStores: optionalNonNegativeInteger(source.staleStores),
    totalStores: optionalNonNegativeInteger(source.totalStores),
    latestFetchedAt: isoInstant(source.latestFetchedAt),
    evaluatedAt: isoInstant(source.evaluatedAt),
    watermarkStart: isoInstant(source.watermarkStart),
    watermarkEnd: isoInstant(source.watermarkEnd),
    freshnessMaxAgeSeconds: optionalNonNegativeInteger(source.freshnessMaxAgeSeconds),
    mode: ['BACKFILL', 'INCREMENTAL', 'MIXED'].includes(source.mode)
      ? source.mode
      : null,
    missingStoreCodes: normalizeStoreCodes(source.missingStoreCodes),
    failedStoreCodes: normalizeStoreCodes(source.failedStoreCodes),
    staleStoreCodes: normalizeStoreCodes(source.staleStoreCodes),
    inProgressStoreCodes: normalizeStoreCodes(source.inProgressStoreCodes),
    reason: text(source.reason, '', 240) || null,
  };
}

function normalizeSupply(value) {
  const source = record(value);
  const coverageSource = record(source.coverage);
  const domainsSource = record(coverageSource.domains);
  const domains = {};
  for (const key of [
    'productCatalog',
    'productDetails',
    'inventory',
    'stockAdvice',
    'purchaseOrders',
    'deliveries',
  ]) {
    domains[key] = normalizeDomainCoverage(domainsSource[key]);
  }
  return {
    status: operationStatus(source.status),
    coverage: {
      totalStores: optionalNonNegativeInteger(coverageSource.totalStores),
      domains,
    },
    purchaseOrderStatus: Array.isArray(source.purchaseOrderStatus)
      ? source.purchaseOrderStatus.map(normalizePurchaseOrderStatus).filter(Boolean)
      : [],
    deliveryMilestones: Array.isArray(source.deliveryMilestones)
      ? source.deliveryMilestones.map(normalizeDeliveryMilestone).filter(Boolean)
      : [],
    inventory: Array.isArray(source.inventory)
      ? source.inventory.map(normalizeInventorySummary).filter(Boolean)
      : [],
    stockAdvice: Array.isArray(source.stockAdvice)
      ? source.stockAdvice.map(normalizeStockAdviceSummary).filter(Boolean)
      : [],
  };
}

function normalizeQueue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = record(value);
  const queue = {
    queued: optionalNonNegativeInteger(source.queued),
    running: optionalNonNegativeInteger(source.running),
    retry: optionalNonNegativeInteger(source.retry),
    deadLetter: optionalNonNegativeInteger(source.deadLetter),
    expiredLeases: optionalNonNegativeInteger(source.expiredLeases),
    oldestReadyAt: isoInstant(source.oldestReadyAt),
    lastReceivedAt: isoInstant(source.lastReceivedAt),
    lastProcessedAt: isoInstant(source.lastProcessedAt),
    hydrationPending: optionalNonNegativeInteger(source.hydrationPending),
    blockedStores: optionalNonNegativeInteger(source.blockedStores),
  };
  return Object.values(queue).some((item) => item !== null) ? queue : null;
}

function normalizeSubscription(item) {
  const source = record(item);
  const eventCode = text(source.eventCode, '', 40);
  if (!eventCode) return null;
  return {
    appFingerprint: text(source.appFingerprint, '', 24) || null,
    eventCode,
    desiredState: text(source.desiredState, '', 40) || null,
    observedState: text(source.observedState, '', 40) || null,
    callbackValidated: optionalBoolean(source.callbackValidated),
    checkedAt: isoInstant(source.checkedAt),
    updatedAt: isoInstant(source.updatedAt),
  };
}

function normalizeSafeProjection(value) {
  const source = record(value);
  const identifiersSource = record(source.identifiers);
  const metricsSource = record(source.metrics);
  const identifiers = Object.fromEntries(
    ['spu', 'skc', 'sku', 'document']
      .map((key) => [key, text(identifiersSource[key], '', 160) || null])
      .filter(([, item]) => item !== null),
  );
  const availableQuota = optionalNonNegativeInteger(metricsSource.availableQuota);
  const metrics = availableQuota !== null
    ? { availableQuota }
    : {};
  return {
    eventLabel: text(source.eventLabel, '', 120) || null,
    deliveryScope: ['STORE', 'APP_ONLY'].includes(source.deliveryScope)
      ? source.deliveryScope
      : null,
    appScopedOnly: optionalBoolean(source.appScopedOnly),
    receivedAt: isoInstant(source.receivedAt),
    identifiers,
    metrics,
  };
}

function normalizeOperationalEvent(item) {
  const source = record(item);
  const eventCode = text(source.eventCode, '', 40);
  const eventPath = text(source.eventPath, '', 180);
  if (!eventCode && !eventPath) return null;
  return {
    eventCode: eventCode || null,
    eventPath: eventPath || null,
    eventFamily: text(source.eventFamily, '', 80) || null,
    businessType: text(source.businessType, '', 80) || null,
    businessKey: text(source.businessKey, '', 240) || null,
    occurredAt: isoInstant(source.occurredAt),
    action: text(source.action, '', 80) || null,
    status: text(source.status, '', 80) || null,
    severity: text(source.severity, '', 16) || null,
    deliveryScope: ['STORE', 'APP_ONLY'].includes(source.deliveryScope)
      ? source.deliveryScope
      : null,
    storeCode: text(source.storeCode, '', 24).toUpperCase() || null,
    safeProjection: normalizeSafeProjection(source.safeProjection),
    createdAt: isoInstant(source.createdAt),
  };
}

function normalizeWebhookRuntimeComponent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = record(value);
  const status = ['RUNNING', 'STOPPING'].includes(source.status)
    ? source.status
    : null;
  const lastSeenAt = isoInstant(source.lastSeenAt);
  const expiresAt = isoInstant(source.expiresAt);
  const fresh = optionalBoolean(source.fresh);
  if (status === null && lastSeenAt === null && expiresAt === null && fresh === null) {
    return null;
  }
  return {
    status,
    lastSeenAt,
    expiresAt,
    fresh,
  };
}

function normalizePlatform(value) {
  const source = record(value);
  const healthSource = record(source.health);
  const health = {
    ok: optionalBoolean(healthSource.ok),
    warehouseReady: optionalBoolean(healthSource.warehouseReady),
    evaluatedAt: isoInstant(healthSource.evaluatedAt),
    receiver: normalizeWebhookRuntimeComponent(healthSource.receiver),
    worker: normalizeWebhookRuntimeComponent(healthSource.worker),
  };
  const hasHealthEvidence = Object.values(health).some((item) => item !== null);
  return {
    status: operationStatus(source.status),
    health: hasHealthEvidence ? health : null,
    queue: normalizeQueue(source.queue),
    subscriptions: Array.isArray(source.subscriptions)
      ? source.subscriptions.map(normalizeSubscription).filter(Boolean).slice(0, 500)
      : [],
    events: Array.isArray(source.events)
      ? source.events.map(normalizeOperationalEvent).filter(Boolean).slice(0, 500)
      : [],
  };
}

function normalizeActionCandidate(item) {
  const source = record(item);
  const candidateKey = text(source.candidateKey, '', 80);
  const type = text(source.type, '', 80);
  if (!candidateKey || !type) return null;
  return {
    candidateKey,
    storeCode: text(source.storeCode, '', 24).toUpperCase() || null,
    type,
    severity: ['low', 'medium', 'high', 'critical'].includes(source.severity)
      ? source.severity
      : 'medium',
    title: text(source.title, '待复核运营候选', 160),
    reason: text(source.reason, '等待可追溯证据', 360),
    entityCode: text(source.entityCode, '', 160) || null,
    evidenceAt: isoInstant(source.evidenceAt),
  };
}

function normalizeActionPool(value) {
  const source = record(value);
  return {
    mode: 'observe_only',
    writeEnabled: false,
    candidates: Array.isArray(source.candidates)
      ? source.candidates.map(normalizeActionCandidate).filter(Boolean).slice(0, 1_000)
      : [],
  };
}

function normalizeSystem(value) {
  const source = record(value);
  const readinessSource = record(source.schemaReadiness);
  return {
    writeActionsEnabled: false,
    schemaReadiness: {
      supplyReady: optionalBoolean(readinessSource.supplyReady),
      webhookReady: optionalBoolean(readinessSource.webhookReady),
      productIdentityReady: optionalBoolean(readinessSource.productIdentityReady),
      employeeAccessReady: optionalBoolean(readinessSource.employeeAccessReady),
    },
  };
}

function productIdentityCoverage(value, storeSkuRanking) {
  const source = record(value);
  const sourceTotalSkus = optionalNonNegativeInteger(source.totalSkus);
  const sourceConfirmedSkus = optionalNonNegativeInteger(source.confirmedSkus);
  const sourceMissingSpuSkus = optionalNonNegativeInteger(source.missingSpuSkus);
  const hasActiveCatalogCoverage = (
    source.basis === 'active_catalog'
    && sourceTotalSkus !== null
    && sourceConfirmedSkus !== null
    && sourceMissingSpuSkus !== null
    && sourceConfirmedSkus <= sourceTotalSkus
    && sourceMissingSpuSkus <= sourceTotalSkus
    && sourceConfirmedSkus + sourceMissingSpuSkus <= sourceTotalSkus
  );
  const totalSkus = hasActiveCatalogCoverage
    ? sourceTotalSkus
    : storeSkuRanking.length;
  const confirmedSkus = hasActiveCatalogCoverage
    ? sourceConfirmedSkus
    : storeSkuRanking.filter(
      ({ mappingStatus }) => mappingStatus === 'CONFIRMED',
    ).length;
  const missingSpuSkus = hasActiveCatalogCoverage
    ? sourceMissingSpuSkus
    : storeSkuRanking.filter(
      ({ mappingStatus }) => mappingStatus === 'MISSING_SPU_ID',
    ).length;
  const basis = hasActiveCatalogCoverage ? 'active_catalog' : 'sales_ranking';
  return {
    basis,
    confirmedSkus,
    totalSkus,
    unconfirmedSkus: totalSkus - confirmedSkus,
    missingSpuSkus,
    coverageRate: totalSkus === 0
      ? null
      : Number((confirmedSkus / totalSkus).toFixed(4)),
    status: totalSkus === 0
      ? 'not_started'
      : confirmedSkus === totalSkus
        ? 'complete'
        : confirmedSkus > 0
          ? 'partial'
          : 'not_started',
    note: totalSkus === 0
      ? basis === 'active_catalog'
        ? '全量活跃商品目录中尚无SKU'
        : '当前销量排行尚无可归并SKU'
      : basis === 'active_catalog'
        ? `全量活跃商品目录 ${confirmedSkus}/${totalSkus} 个SKU已确认；${missingSpuSkus} 个缺少平台SPU；覆盖口径不依赖销量业务日`
        : `当前销量排行已确认 ${confirmedSkus}/${totalSkus} 个店铺SKU；${missingSpuSkus} 个缺少平台SPU；未确认商品保持店内隔离`,
  };
}

function sortRanking(items) {
  const rankValue = (value) => (Number.isSafeInteger(value) ? value : -1);
  return items.sort((left, right) => {
      return (
        rankValue(right.unitsSold.last30Days) - rankValue(left.unitsSold.last30Days) ||
        rankValue(right.unitsSold.last7Days) - rankValue(left.unitsSold.last7Days) ||
        rankValue(right.unitsSold.today) - rankValue(left.unitsSold.today)
      );
    });
}

export function normalizeDashboardData(input) {
  const source = record(input);
  const permissionSource = record(source.permission);
  const status = permissionStatus(permissionSource.status);
  const datasetStatus = ['live', 'empty'].includes(source.datasetStatus)
    ? source.datasetStatus
    : 'sample';
  const hasUpdatedAt = source.updatedAt !== null && source.updatedAt !== undefined;
  const updatedAt = hasUpdatedAt ? new Date(source.updatedAt) : null;
  const totalStores = optionalNonNegativeInteger(permissionSource.totalStores);
  const authorizedSource = optionalNonNegativeInteger(permissionSource.authorizedStores);
  const authorizedStores = (
    totalStores === null || authorizedSource === null
      ? authorizedSource
      : Math.min(authorizedSource, totalStores)
  );

  if (updatedAt && Number.isNaN(updatedAt.valueOf())) {
    throw new TypeError('Dashboard data must include a valid updatedAt timestamp.');
  }

  const storeRanking = Array.isArray(source.storeRanking)
    ? sortRanking(source.storeRanking.map(normalizeStore))
    : [];
  const storeSkuSource = Array.isArray(source.storeSkuRanking)
    ? source.storeSkuRanking
    : source.skuRanking;
  const storeSkuRanking = Array.isArray(storeSkuSource)
    ? sortRanking(storeSkuSource.map(normalizeSku))
    : [];
  const productRanking = Array.isArray(source.productRanking)
    ? sortRanking(source.productRanking.map(normalizeProduct).filter(Boolean))
    : [];
  const readiness = Array.isArray(source.readiness)
    ? source.readiness.slice(0, 12).map(normalizeReadinessStage)
    : [];
  const businessDate = isoDate(source.businessDate);
  const salesTrendByStore = normalizeSalesTrendByStore(source.salesTrendByStore);
  const owners = Array.isArray(source.owners)
    ? source.owners.map(normalizeOwner).filter(Boolean).slice(0, 500)
    : [];

  return {
    schemaVersion: 4,
    readOnly: true,
    dataset: {
      status: datasetStatus,
      label: DATASET_LABELS[datasetStatus],
    },
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    permission: {
      status,
      label: PERMISSION_LABELS[status],
      authorizedStores,
      totalStores,
    },
    businessDate,
    salesCoverage: normalizeSalesCoverage(
      source.salesCoverage,
      businessDate,
      totalStores,
    ),
    quality: normalizeQuality(source.quality),
    unitsSold: normalizeUnits(source.unitsSold, true),
    readiness,
    owners,
    salesTrend: normalizeSalesTrend(source.salesTrend),
    salesTrendByStore,
    storeRanking,
    storeSkuRanking,
    skuRanking: storeSkuRanking,
    productRanking,
    productIdentityCoverage: productIdentityCoverage(
      source.productIdentityCoverage,
      storeSkuRanking,
    ),
    rankingMeta: {
      store: {
        returnedCount: storeRanking.length,
        totalCount: storeRanking.length,
        truncated: false,
      },
      storeSku: {
        returnedCount: storeSkuRanking.length,
        totalCount: storeSkuRanking.length,
        truncated: false,
      },
      product: {
        returnedCount: productRanking.length,
        totalCount: productRanking.length,
        truncated: false,
      },
    },
    supply: normalizeSupply(source.supply),
    platform: normalizePlatform(source.platform),
    actionPool: normalizeActionPool(source.actionPool),
    system: normalizeSystem(source.system),
  };
}

export async function loadDashboardData(
  dataFile = process.env.FULL_BI_DATA_FILE,
  { runtimeEnvironment = process.env.NODE_ENV || 'development' } = {},
) {
  if (!dataFile && String(runtimeEnvironment).toLowerCase() === 'production') {
    throw new TypeError('FULL_BI_DATA_FILE is required in production.');
  }
  const selectedFile = dataFile || DEFAULT_DASHBOARD_DATA_FILE;
  const content = await readFile(selectedFile, 'utf8');
  return normalizeDashboardData(JSON.parse(content));
}
