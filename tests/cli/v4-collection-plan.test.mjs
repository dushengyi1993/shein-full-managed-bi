import assert from 'node:assert/strict';
import test from 'node:test';

import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';
import * as LIVE_ORDER_MANAGEMENT_CONTRACTS from '../../src/webapi-history/order-management-contracts.mjs';
import {
  assertApprovedV4CollectionPlanHash,
  buildV4CollectionPlan,
  parseV4CollectionPlan,
  verifyV4CollectionPlanHash,
  V4CollectionPlanError,
  V4_COLLECTION_ATTEMPT_COUNT,
  V4_COLLECTION_CONTRACT_VERSION,
  V4_COLLECTION_PAGE_ENDPOINT_CODES,
  V4_COLLECTION_PLAN_VERSION,
  V4_COLLECTION_RETRY_POLICY,
  V4_COLLECTION_STATISTICS_ENDPOINT_CODES,
  V4_COLLECTION_STATISTICS_TYPES,
  V4_COLLECTION_WINDOW_DAYS,
  V4_COLLECTION_WORK_ITEM_CODES,
  v4CollectionRequestContractManifest,
  v4EndpointRequestFingerprint,
  v4EndpointRequestSchemaHash,
  v4ShanghaiCalendarDate,
  v4WorkItemWindow,
} from '../../src/warehouse/v4-collection-plan.mjs';

const NOW = new Date('2026-08-11T04:00:00.000Z');

const EXPECTED_WORK_ITEMS = Object.freeze([
  'STOCK_RECORDS_LIST',
  'WAYBILLS_PAGE',
  'RETURN_APPLICATIONS_LIST',
  'RETURN_ORDERS_PAGE',
  'EXCEPTIONS_PAGE',
  'VALUE_ADDED_SERVICES_PAGE',
  'QUALITY_REPORTS_PAGE',
  'WAYBILLS_STATISTICS_1',
  'WAYBILLS_STATISTICS_2',
  'WAYBILLS_STATISTICS_3',
  'WAYBILLS_STATISTICS_4',
  'WAYBILLS_STATISTICS_5',
  'WAYBILLS_STATISTICS_6',
]);

/**
 * Drift-verification seam: a deep clone of the live frozen contracts with a
 * mutated endpoint table (and optional overrides, e.g. a changed
 * orderManagementRequestBody).  It simulates a changed frozen contract file
 * without editing production code, so tests can prove that any endpoint
 * method/path/body template/window field/paging/statistics or concrete
 * request-body change invalidates the plan hash.
 */
function driftedContracts(mutate, overrides = {}) {
  const endpoints = structuredClone(LIVE_ORDER_MANAGEMENT_CONTRACTS.ORDER_MANAGEMENT_ENDPOINTS);
  mutate(endpoints);
  return {
    ...LIVE_ORDER_MANAGEMENT_CONTRACTS,
    ORDER_MANAGEMENT_ENDPOINTS: endpoints,
    ...overrides,
  };
}

function manifestEntry(plan, workItemCode) {
  return plan.requestContractManifest.find((entry) => entry.workItemCode === workItemCode);
}

function driftError(dimensionName) {
  return (error) => error instanceof V4CollectionPlanError
    && error.code === 'V4_COLLECTION_REQUEST_CONTRACT_DRIFT';
}

test('v4 plan freezes the canonical 25-store roster and the exact 13-item manifest', () => {
  const plan = buildV4CollectionPlan({ now: NOW });
  assert.deepEqual(plan.storeCodes, FULL_MANAGED_STORE_CODES);
  assert.equal(plan.storeCodes.length, 25);
  assert.deepEqual(plan.workItemCodes, EXPECTED_WORK_ITEMS);
  assert.equal(plan.workItemCodes.length, 13);
  assert.deepEqual(plan.pageEndpointCodes, [
    'STOCK_RECORDS_LIST',
    'WAYBILLS_PAGE',
    'RETURN_APPLICATIONS_LIST',
    'RETURN_ORDERS_PAGE',
    'EXCEPTIONS_PAGE',
    'VALUE_ADDED_SERVICES_PAGE',
    'QUALITY_REPORTS_PAGE',
  ]);
  assert.deepEqual(plan.statisticsEndpointCodes, [
    'WAYBILLS_STATISTICS_1',
    'WAYBILLS_STATISTICS_2',
    'WAYBILLS_STATISTICS_3',
    'WAYBILLS_STATISTICS_4',
    'WAYBILLS_STATISTICS_5',
    'WAYBILLS_STATISTICS_6',
  ]);
  assert.deepEqual(plan.statisticsTypes, [1, 2, 3, 4, 5, 6]);
  assert.equal(plan.retryPolicy, 'NONE');
  assert.equal(plan.contractVersion, 1);
  assert.equal(plan.summary.storeCount, 25);
  assert.equal(plan.summary.workItemCount, 13);
  assert.equal(plan.summary.attemptCount, 325);
  assert.equal(V4_COLLECTION_ATTEMPT_COUNT, 325);
  // The ordered per-work-item request-contract manifest is part of the plan.
  assert.equal(plan.requestContractManifest.length, 13);
  assert.deepEqual(
    plan.requestContractManifest.map((entry) => entry.workItemCode),
    EXPECTED_WORK_ITEMS,
  );
});

test('v4 plan window is exactly 30 inclusive settled Shanghai days ending yesterday', () => {
  const plan = buildV4CollectionPlan({ now: NOW });
  assert.equal(v4ShanghaiCalendarDate(NOW), '2026-08-11');
  assert.deepEqual(plan.window, { startDate: '2026-07-12', endDate: '2026-08-10' });
  const days = (value) => Math.round(Date.parse(`${value}T00:00:00.000Z`) / 86_400_000);
  assert.equal(days(plan.window.endDate) - days(plan.window.startDate) + 1, 30);
  assert.equal(plan.windowDays, V4_COLLECTION_WINDOW_DAYS);
  assert.equal(plan.windowDays, 30);
});

test('v4 plan hash is deterministic canonical JSON over all executable inputs', () => {
  const first = buildV4CollectionPlan({ now: NOW });
  const second = buildV4CollectionPlan({ now: NOW });
  assert.equal(first.planHash, second.planHash);
  assert.match(first.planHash, /^[0-9a-f]{64}$/);
  // A later calendar day shifts the settled window and therefore the hash.
  const tomorrow = buildV4CollectionPlan({ now: new Date('2026-08-12T04:00:00.000Z') });
  assert.notEqual(tomorrow.planHash, first.planHash);
  assert.deepEqual(tomorrow.window, { startDate: '2026-07-13', endDate: '2026-08-11' });
});

test('v4 runKey is deterministic from the plan hash', () => {
  const plan = buildV4CollectionPlan({ now: NOW });
  const replay = buildV4CollectionPlan({ now: NOW });
  assert.equal(plan.runKey, replay.runKey);
  assert.match(plan.runKey, /^[0-9a-f]{64}$/);
  const other = buildV4CollectionPlan({ now: new Date('2026-08-12T04:00:00.000Z') });
  assert.notEqual(plan.runKey, other.runKey);
  assert.notEqual(plan.runKey, plan.planHash);
});

test('v4 plan request-contract manifest binds the exact frozen request contracts in order', () => {
  const plan = buildV4CollectionPlan({ now: NOW });
  const manifest = plan.requestContractManifest;
  assert.equal(manifest.length, V4_COLLECTION_WORK_ITEM_CODES.length);
  assert.deepEqual(
    manifest.map((entry) => entry.workItemCode),
    V4_COLLECTION_WORK_ITEM_CODES,
  );
  for (const workItemCode of V4_COLLECTION_WORK_ITEM_CODES) {
    const entry = manifestEntry(plan, workItemCode);
    const window = v4WorkItemWindow({ workItemCode, window: plan.window });
    assert.equal(entry.requestSchemaHash, v4EndpointRequestSchemaHash(workItemCode));
    assert.equal(
      entry.requestFingerprint,
      v4EndpointRequestFingerprint({ workItemCode, window }),
    );
    assert.match(entry.requestSchemaHash, /^[0-9a-f]{64}$/);
    assert.match(entry.requestFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(entry));
  }
  for (const workItemCode of V4_COLLECTION_PAGE_ENDPOINT_CODES) {
    const entry = manifestEntry(plan, workItemCode);
    const endpoint = LIVE_ORDER_MANAGEMENT_CONTRACTS.ORDER_MANAGEMENT_ENDPOINTS[workItemCode];
    assert.equal(entry.method, endpoint.method);
    assert.equal(entry.path, endpoint.path);
    assert.deepEqual(entry.bodyTemplate, endpoint.bodyTemplate);
    assert.deepEqual(entry.windowFields, endpoint.windowFields);
    assert.equal(entry.pageKey, endpoint.pageKey);
    assert.equal(entry.pageSizeKey, endpoint.pageSizeKey);
    assert.equal(entry.defaultPageSize, endpoint.defaultPageSize);
    assert.equal(entry.pageSizeValue, endpoint.pageSizeValue ?? null);
  }
  for (const workItemCode of V4_COLLECTION_STATISTICS_ENDPOINT_CODES) {
    const entry = manifestEntry(plan, workItemCode);
    const endpoint = LIVE_ORDER_MANAGEMENT_CONTRACTS.ORDER_MANAGEMENT_ENDPOINTS.WAYBILLS_STATISTICS;
    assert.equal(entry.method, endpoint.method);
    assert.equal(entry.path, endpoint.path);
    assert.deepEqual(entry.windowFields, endpoint.windowFields);
    assert.equal(entry.statisticsType, Number(workItemCode.slice('WAYBILLS_STATISTICS_'.length)));
    assert.deepEqual(entry.statisticsTypes, V4_COLLECTION_STATISTICS_TYPES);
  }
});

test('v4 plan parse round-trips and rejects tampered plans', () => {
  const plan = buildV4CollectionPlan({ now: NOW });
  const parsed = parseV4CollectionPlan(JSON.parse(JSON.stringify(plan)));
  assert.equal(parsed.planHash, plan.planHash);
  assert.equal(parsed.runKey, plan.runKey);
  assert.deepEqual(parsed.window, plan.window);
  assert.deepEqual(parsed.requestContractManifest, plan.requestContractManifest);

  const tamperedWindow = JSON.parse(JSON.stringify(plan));
  tamperedWindow.window.endDate = '2026-08-09';
  assert.throws(
    () => parseV4CollectionPlan(tamperedWindow),
    (error) => error instanceof V4CollectionPlanError
      && error.code === 'V4_COLLECTION_WINDOW_SPAN_INVALID',
  );

  const tamperedWorkItems = JSON.parse(JSON.stringify(plan));
  tamperedWorkItems.workItemCodes = [...plan.workItemCodes].reverse();
  assert.throws(
    () => parseV4CollectionPlan(tamperedWorkItems),
    (error) => error instanceof V4CollectionPlanError
      && error.code === 'V4_COLLECTION_MANIFEST_MISMATCH',
  );

  const tamperedRoster = JSON.parse(JSON.stringify(plan));
  tamperedRoster.storeCodes = [...plan.storeCodes].slice(0, 24);
  assert.throws(
    () => parseV4CollectionPlan(tamperedRoster),
    (error) => error instanceof V4CollectionPlanError
      && error.code === 'V4_COLLECTION_ROSTER_MISMATCH',
  );

  const tamperedHash = JSON.parse(JSON.stringify(plan));
  tamperedHash.planHash = 'f'.repeat(64);
  assert.throws(
    () => parseV4CollectionPlan(tamperedHash),
    (error) => error instanceof V4CollectionPlanError
      && error.code === 'V4_COLLECTION_PLAN_HASH_MISMATCH',
  );

  const tamperedRunKey = JSON.parse(JSON.stringify(plan));
  tamperedRunKey.runKey = 'e'.repeat(64);
  assert.throws(
    () => parseV4CollectionPlan(tamperedRunKey),
    (error) => error instanceof V4CollectionPlanError
      && error.code === 'V4_COLLECTION_RUN_KEY_MISMATCH',
  );

  const wrongRetry = JSON.parse(JSON.stringify(plan));
  wrongRetry.retryPolicy = 'RETRY_3';
  assert.throws(
    () => parseV4CollectionPlan(wrongRetry),
    (error) => error instanceof V4CollectionPlanError
      && error.code === 'V4_COLLECTION_RETRY_POLICY_INVALID',
  );

  // The manifest is part of the hash input: a persisted plan that lost the
  // manifest (older tooling) is re-validated by recomputation plus the hash
  // gate, and stays exactly the same plan.
  const stripped = JSON.parse(JSON.stringify(plan));
  delete stripped.requestContractManifest;
  const reparsed = parseV4CollectionPlan(stripped);
  assert.equal(reparsed.planHash, plan.planHash);
  assert.equal(reparsed.runKey, plan.runKey);
  assert.deepEqual(reparsed.requestContractManifest, plan.requestContractManifest);

  // Any manifest drift fails closed: wrong schema hash, reordered entries,
  // changed contract fields or an extra entry.
  const tamperedSchemaHash = JSON.parse(JSON.stringify(plan));
  tamperedSchemaHash.requestContractManifest[0].requestSchemaHash = 'f'.repeat(64);
  assert.throws(
    () => parseV4CollectionPlan(tamperedSchemaHash),
    driftError('schema hash'),
  );

  const tamperedOrder = JSON.parse(JSON.stringify(plan));
  tamperedOrder.requestContractManifest.reverse();
  assert.throws(
    () => parseV4CollectionPlan(tamperedOrder),
    driftError('manifest order'),
  );

  const tamperedPath = JSON.parse(JSON.stringify(plan));
  tamperedPath.requestContractManifest[1].path = '/clms/waybill/page-drifted';
  assert.throws(
    () => parseV4CollectionPlan(tamperedPath),
    driftError('manifest path'),
  );

  const extraEntry = JSON.parse(JSON.stringify(plan));
  extraEntry.requestContractManifest.push({ ...extraEntry.requestContractManifest[0] });
  assert.throws(
    () => parseV4CollectionPlan(extraEntry),
    driftError('extra manifest entry'),
  );
});

test('v4 approved-plan-hash gate is exact and fails closed', () => {
  const plan = buildV4CollectionPlan({ now: NOW });
  assert.equal(verifyV4CollectionPlanHash(plan, plan.planHash), true);
  assert.equal(verifyV4CollectionPlanHash(plan, plan.planHash.toUpperCase()), true);
  assert.equal(verifyV4CollectionPlanHash(plan, 'f'.repeat(64)), false);
  assert.deepEqual(assertApprovedV4CollectionPlanHash(plan, plan.planHash), {
    planHash: plan.planHash,
    runKey: plan.runKey,
  });
  assert.throws(
    () => assertApprovedV4CollectionPlanHash(plan, 'f'.repeat(64)),
    (error) => error instanceof V4CollectionPlanError
      && error.code === 'V4_COLLECTION_PLAN_HASH_MISMATCH',
  );
  assert.throws(
    () => assertApprovedV4CollectionPlanHash(plan, 'not-a-hash'),
    (error) => error instanceof V4CollectionPlanError
      && error.code === 'V4_COLLECTION_APPROVED_PLAN_HASH_INVALID',
  );
  assert.throws(
    () => assertApprovedV4CollectionPlanHash(plan, null),
    (error) => error instanceof V4CollectionPlanError
      && error.code === 'V4_COLLECTION_APPROVED_PLAN_HASH_INVALID',
  );
});

test('v4 work-item request schema hashes and fingerprints are deterministic and distinct', () => {
  const plan = buildV4CollectionPlan({ now: NOW });
  const seenSchemas = new Set();
  const seenFingerprints = new Set();
  for (const workItemCode of V4_COLLECTION_WORK_ITEM_CODES) {
    const window = v4WorkItemWindow({ workItemCode, window: plan.window });
    const schemaHash = v4EndpointRequestSchemaHash(workItemCode);
    const fingerprint = v4EndpointRequestFingerprint({ workItemCode, window });
    assert.match(schemaHash, /^[0-9a-f]{64}$/);
    assert.match(fingerprint, /^[0-9a-f]{64}$/);
    seenSchemas.add(schemaHash);
    seenFingerprints.add(fingerprint);
    // Deterministic under replay.
    assert.equal(v4EndpointRequestSchemaHash(workItemCode), schemaHash);
    assert.equal(
      v4EndpointRequestFingerprint({ workItemCode, window }),
      fingerprint,
    );
  }
  assert.equal(seenSchemas.size, 13);
  assert.equal(seenFingerprints.size, 13);
});

test('v4 work-item windows: windowed pages and stats use the settled window, once-only pages are null', () => {
  const plan = buildV4CollectionPlan({ now: NOW });
  assert.deepEqual(v4WorkItemWindow({ workItemCode: 'STOCK_RECORDS_LIST', window: plan.window }), plan.window);
  assert.deepEqual(v4WorkItemWindow({ workItemCode: 'WAYBILLS_PAGE', window: plan.window }), plan.window);
  assert.deepEqual(v4WorkItemWindow({ workItemCode: 'QUALITY_REPORTS_PAGE', window: plan.window }), plan.window);
  assert.equal(v4WorkItemWindow({ workItemCode: 'EXCEPTIONS_PAGE', window: plan.window }), null);
  assert.equal(v4WorkItemWindow({ workItemCode: 'VALUE_ADDED_SERVICES_PAGE', window: plan.window }), null);
  assert.deepEqual(v4WorkItemWindow({ workItemCode: 'WAYBILLS_STATISTICS_1', window: plan.window }), plan.window);
  assert.throws(
    () => v4WorkItemWindow({ workItemCode: 'WAYBILLS_STATISTICS_1', window: null }),
    (error) => error instanceof V4CollectionPlanError
      && error.code === 'V4_COLLECTION_WINDOW_REQUIRED',
  );
  assert.throws(
    () => v4EndpointRequestSchemaHash('NOT_A_WORK_ITEM'),
    (error) => error instanceof V4CollectionPlanError
      && error.code === 'V4_COLLECTION_WORK_ITEM_UNKNOWN',
  );
});

test('v4 plan hash is invalidated by request-contract drift without a contractVersion bump', () => {
  const baseline = buildV4CollectionPlan({ now: NOW });
  const baselineJson = JSON.parse(JSON.stringify(baseline));
  const dimensions = [
    {
      name: 'endpoint path',
      mutate: (endpoints) => {
        endpoints.WAYBILLS_PAGE.path = '/clms/waybill/page-drifted';
      },
    },
    {
      name: 'body template',
      mutate: (endpoints) => {
        endpoints.STOCK_RECORDS_LIST.bodyTemplate = {
          ...endpoints.STOCK_RECORDS_LIST.bodyTemplate,
          extraFilter: 1,
        };
      },
    },
    {
      name: 'paging key',
      mutate: (endpoints) => {
        endpoints.RETURN_APPLICATIONS_LIST.pageKey = 'pageNo';
      },
    },
    {
      name: 'page size value',
      mutate: (endpoints) => {
        endpoints.QUALITY_REPORTS_PAGE.pageSizeValue = '100';
      },
    },
    {
      name: 'window fields',
      mutate: (endpoints) => {
        endpoints.WAYBILLS_PAGE.windowFields = {
          start: 'addTimeStartDrifted',
          end: 'addTimeEnd',
        };
      },
    },
    {
      name: 'statistics types',
      mutate: (endpoints) => {
        endpoints.WAYBILLS_STATISTICS.statisticsTypes = [1, 2, 3, 4, 5, 6, 7];
      },
    },
  ];
  for (const dimension of dimensions) {
    const drifted = driftedContracts(dimension.mutate);
    const driftedPlan = buildV4CollectionPlan({ now: NOW, contracts: drifted });
    assert.notEqual(
      driftedPlan.planHash,
      baseline.planHash,
      `${dimension.name} drift must invalidate the plan hash`,
    );
    assert.equal(
      driftedPlan.contractVersion,
      V4_COLLECTION_CONTRACT_VERSION,
      'contract version must not be bumped manually',
    );
    // The approved baseline plan fails closed against the drifted contracts.
    assert.throws(
      () => parseV4CollectionPlan(baselineJson, drifted),
      driftError(dimension.name),
    );
    // A plan authorized under drifted contracts fails closed against the
    // current live contracts.
    assert.throws(
      () => parseV4CollectionPlan(JSON.parse(JSON.stringify(driftedPlan))),
      driftError(dimension.name),
    );
    // Under the same view the drifted plan still round-trips deterministically.
    const reparsed = parseV4CollectionPlan(
      JSON.parse(JSON.stringify(driftedPlan)),
      drifted,
    );
    assert.equal(reparsed.planHash, driftedPlan.planHash);
    assert.equal(reparsed.runKey, driftedPlan.runKey);
  }

  // Concrete request-body generation drift (timestamp format) also changes the
  // per-item fingerprints and therefore the plan hash.
  const liveRequestBody = LIVE_ORDER_MANAGEMENT_CONTRACTS.orderManagementRequestBody;
  const bodyDrift = driftedContracts(() => {}, {
    orderManagementRequestBody: (endpointCode, options) => {
      const body = liveRequestBody(endpointCode, options);
      const rewritten = {};
      for (const [key, value] of Object.entries(body)) {
        rewritten[key] = typeof value === 'string' ? value.replace(' ', 'T') : value;
      }
      return rewritten;
    },
  });
  const bodyDriftedPlan = buildV4CollectionPlan({ now: NOW, contracts: bodyDrift });
  assert.notEqual(bodyDriftedPlan.planHash, baseline.planHash);
  assert.notEqual(
    v4EndpointRequestFingerprint({ workItemCode: 'WAYBILLS_PAGE', window: baseline.window }, bodyDrift),
    v4EndpointRequestFingerprint({ workItemCode: 'WAYBILLS_PAGE', window: baseline.window }),
  );
  assert.throws(
    () => parseV4CollectionPlan(baselineJson, bodyDrift),
    driftError('request body generation'),
  );
  assert.throws(
    () => parseV4CollectionPlan(JSON.parse(JSON.stringify(bodyDriftedPlan))),
    driftError('request body generation'),
  );

  // The drift is targeted: only the affected work-item entry changes.
  const baselineManifest = v4CollectionRequestContractManifest({ window: baseline.window });
  const pathDrift = driftedContracts((endpoints) => {
    endpoints.WAYBILLS_PAGE.path = '/clms/waybill/page-drifted';
  });
  const pathManifest = v4CollectionRequestContractManifest({
    window: baseline.window,
    contracts: pathDrift,
  });
  const indexOf = (code) => V4_COLLECTION_WORK_ITEM_CODES.indexOf(code);
  assert.notEqual(
    pathManifest[indexOf('WAYBILLS_PAGE')].requestSchemaHash,
    baselineManifest[indexOf('WAYBILLS_PAGE')].requestSchemaHash,
  );
  for (const workItemCode of V4_COLLECTION_WORK_ITEM_CODES.filter((code) => code !== 'WAYBILLS_PAGE')) {
    assert.deepEqual(pathManifest[indexOf(workItemCode)], baselineManifest[indexOf(workItemCode)]);
  }
});

test('v4 plan is deeply frozen', () => {
  const plan = buildV4CollectionPlan({ now: NOW });
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.window));
  assert.ok(Object.isFrozen(plan.storeCodes));
  assert.ok(Object.isFrozen(plan.workItemCodes));
  assert.ok(Object.isFrozen(plan.requestContractManifest));
  assert.ok(plan.requestContractManifest.every((entry) => Object.isFrozen(entry)));
  assert.ok(Object.isFrozen(plan.summary));
  assert.throws(() => { plan.storeCodes.push('ZZ0000'); }, TypeError);
});

test('v4 plan constants are contract-consistent', () => {
  assert.equal(V4_COLLECTION_PLAN_VERSION, 'full-managed-v4-collection-plan.v2');
  assert.equal(V4_COLLECTION_CONTRACT_VERSION, 1);
  assert.equal(V4_COLLECTION_RETRY_POLICY, 'NONE');
  assert.equal(V4_COLLECTION_PAGE_ENDPOINT_CODES.length, 7);
  assert.equal(V4_COLLECTION_STATISTICS_ENDPOINT_CODES.length, 6);
  assert.equal(V4_COLLECTION_STATISTICS_TYPES.length, 6);
  assert.equal(V4_COLLECTION_WORK_ITEM_CODES.length, 13);
});
