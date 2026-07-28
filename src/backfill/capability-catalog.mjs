/**
 * Capability catalog for historical backfill.
 *
 * A domain may only execute when the repository already owns a proven,
 * verified adapter contract. Everything else stays an explicit business
 * blocker: it is planned, recorded and reported, but it never reaches an
 * adapter, a network client or a checkpoint.
 */

export const CAPABILITY_STATUSES = Object.freeze({
  VERIFIED: 'VERIFIED',
  UNVERIFIED: 'UNVERIFIED',
  UNSUPPORTED: 'UNSUPPORTED',
  EXPERIMENT_ONLY: 'EXPERIMENT_ONLY',
});

export const WINDOW_GRAINS = Object.freeze({
  DIMENSION: 'DIMENSION',
  WINDOW_SNAPSHOT: 'WINDOW_SNAPSHOT',
  BUSINESS_DATE: 'BUSINESS_DATE',
});

const DOMAIN_ENTRIES = Object.freeze([
  {
    domain: 'store-identity',
    adapterKey: 'openapi.store-identity.v1',
    capabilityStatus: CAPABILITY_STATUSES.VERIFIED,
    windowGrain: WINDOW_GRAINS.DIMENSION,
    maxWindowSpanDays: 31,
    maxPagesPerWindow: 50,
    maxRowsPerWindow: 50_000,
    maxAttempts: 3,
    dailyHistoryReconstructable: false,
    blockedReasonCode: null,
    note: 'Store dimension membership comes from the existing verified OpenAPI store contract.',
  },
  {
    domain: 'product-identity',
    adapterKey: 'openapi.product-identity.v1',
    capabilityStatus: CAPABILITY_STATUSES.VERIFIED,
    windowGrain: WINDOW_GRAINS.DIMENSION,
    maxWindowSpanDays: 31,
    maxPagesPerWindow: 200,
    maxRowsPerWindow: 200_000,
    maxAttempts: 3,
    dailyHistoryReconstructable: false,
    blockedReasonCode: null,
    note: 'Reuses the existing product catalog, detail and identity evidence repositories.',
  },
  {
    domain: 'sales-window-snapshot',
    adapterKey: 'openapi.sales-window-snapshot.v1',
    capabilityStatus: CAPABILITY_STATUSES.VERIFIED,
    windowGrain: WINDOW_GRAINS.WINDOW_SNAPSHOT,
    maxWindowSpanDays: 1,
    maxPagesPerWindow: 200,
    maxRowsPerWindow: 200_000,
    maxAttempts: 3,
    // The four rolling windows are snapshot facts. They can never be divided
    // into a per-day history, so this domain only ever refreshes the existing
    // window grain for the observation date.
    dailyHistoryReconstructable: false,
    blockedReasonCode: null,
    note: 'Four-window SKU sales snapshots refresh the existing window grain only.',
  },
  {
    domain: 'purchase-orders',
    adapterKey: 'openapi.purchase-orders.v1',
    capabilityStatus: CAPABILITY_STATUSES.VERIFIED,
    windowGrain: WINDOW_GRAINS.BUSINESS_DATE,
    maxWindowSpanDays: 7,
    maxPagesPerWindow: 200,
    maxRowsPerWindow: 200_000,
    maxAttempts: 3,
    dailyHistoryReconstructable: true,
    blockedReasonCode: null,
    note: 'Reuses the verified supply purchase-order pagination and reconciliation gate.',
  },
  {
    domain: 'deliveries',
    adapterKey: 'openapi.deliveries.v1',
    capabilityStatus: CAPABILITY_STATUSES.VERIFIED,
    windowGrain: WINDOW_GRAINS.BUSINESS_DATE,
    maxWindowSpanDays: 7,
    maxPagesPerWindow: 200,
    maxRowsPerWindow: 200_000,
    maxAttempts: 3,
    dailyHistoryReconstructable: true,
    blockedReasonCode: null,
    note: 'Reuses the verified supply delivery pagination and reconciliation gate.',
  },
  {
    domain: 'financial-settlement',
    adapterKey: 'openapi.financial-settlement.v0',
    capabilityStatus: CAPABILITY_STATUSES.UNVERIFIED,
    windowGrain: WINDOW_GRAINS.BUSINESS_DATE,
    maxWindowSpanDays: 7,
    maxPagesPerWindow: 0,
    maxRowsPerWindow: 0,
    maxAttempts: 0,
    dailyHistoryReconstructable: false,
    blockedReasonCode: 'FINANCIAL_SETTLEMENT_UNVERIFIED',
    note: 'Endpoint, permission package, pagination and money caliber are not verified yet.',
  },
  {
    domain: 'inventory-history',
    adapterKey: 'openapi.inventory-history.v0',
    capabilityStatus: CAPABILITY_STATUSES.UNSUPPORTED,
    windowGrain: WINDOW_GRAINS.BUSINESS_DATE,
    maxWindowSpanDays: 1,
    maxPagesPerWindow: 0,
    maxRowsPerWindow: 0,
    maxAttempts: 0,
    dailyHistoryReconstructable: false,
    blockedReasonCode: 'INVENTORY_HISTORY_UNSUPPORTED',
    note: 'Inventory history cannot be rebuilt from a current snapshot; it accumulates forward only.',
  },
  {
    domain: 'webhook-history',
    adapterKey: 'webhook.history.v0',
    capabilityStatus: CAPABILITY_STATUSES.UNSUPPORTED,
    windowGrain: WINDOW_GRAINS.BUSINESS_DATE,
    maxWindowSpanDays: 1,
    maxPagesPerWindow: 0,
    maxRowsPerWindow: 0,
    maxAttempts: 0,
    dailyHistoryReconstructable: false,
    blockedReasonCode: 'WEBHOOK_HISTORY_UNSUPPORTED',
    note: 'Pre-subscription platform events do not exist; only periodic OpenAPI reconciliation applies.',
  },
  {
    domain: 'webapi-home-snapshot',
    adapterKey: 'webapi.home-snapshot.v0',
    capabilityStatus: CAPABILITY_STATUSES.EXPERIMENT_ONLY,
    windowGrain: WINDOW_GRAINS.WINDOW_SNAPSHOT,
    maxWindowSpanDays: 1,
    maxPagesPerWindow: 0,
    maxRowsPerWindow: 0,
    maxAttempts: 0,
    dailyHistoryReconstructable: false,
    blockedReasonCode: 'WEBAPI_EXPERIMENT_ONLY',
    note: 'Isolated read-only experiment. It never enters a formal fact, mart or dashboard value.',
  },
]);

export const BACKFILL_DOMAIN_CATALOG = Object.freeze(
  Object.fromEntries(DOMAIN_ENTRIES.map((entry) => [entry.domain, Object.freeze(entry)])),
);

export const BACKFILL_DOMAINS = Object.freeze(
  DOMAIN_ENTRIES.map((entry) => entry.domain).sort(),
);

export const EXECUTABLE_BACKFILL_DOMAINS = Object.freeze(
  DOMAIN_ENTRIES
    .filter((entry) => entry.capabilityStatus === CAPABILITY_STATUSES.VERIFIED)
    .map((entry) => entry.domain)
    .sort(),
);

export function describeBackfillDomain(domain) {
  return BACKFILL_DOMAIN_CATALOG[domain] ?? null;
}

export function isExecutableCapability(capabilityStatus) {
  return capabilityStatus === CAPABILITY_STATUSES.VERIFIED;
}
