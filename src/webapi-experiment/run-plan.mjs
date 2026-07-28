/**
 * Deterministic two-stage plan for the isolated WebAPI experiment.
 *
 * Stage CATALOG may only contain the three endpoints that carry no metric value.
 * It proves reachability, response schema hashes and the set of platform metric
 * ids. Stage METRIC_DETAIL may only contain the two value endpoints and requires
 * explicit, bounded `metaIndexIds` that a human reviewed after a catalog run;
 * nothing is discovered and executed in the same plan.
 *
 * The plan hash covers the requested scope only, never the mode, the operator or
 * a timestamp, so a reviewed dry-run hash authorizes exactly one execute run.
 */

import { canonicalHash } from '../backfill/canonical.mjs';
import {
  WEBAPI_ENDPOINTS,
  WEBAPI_REQUEST_SHAPES,
  describeEndpoint,
} from './endpoint-allowlist.mjs';
import { WEBAPI_STORE_CODES } from './profile-guard.mjs';

export const EXPERIMENT_PLAN_VERSION = 'webapi-experiment-plan.v1';

export const EXPERIMENT_STAGES = Object.freeze({
  CATALOG: 'CATALOG',
  METRIC_DETAIL: 'METRIC_DETAIL',
});

export const EXPERIMENT_MODES = Object.freeze({
  DRY_RUN: 'DRY_RUN',
  EXECUTE: 'EXECUTE',
});

export const CATALOG_ENDPOINT_CODES = Object.freeze(
  Object.values(WEBAPI_ENDPOINTS)
    .filter((endpoint) => endpoint.carriesMetricValues === false)
    .map((endpoint) => endpoint.endpointCode)
    .sort(),
);

export const METRIC_DETAIL_ENDPOINT_CODES = Object.freeze(
  Object.values(WEBAPI_ENDPOINTS)
    .filter((endpoint) => endpoint.carriesMetricValues === true)
    .map((endpoint) => endpoint.endpointCode)
    .sort(),
);

export const EXPERIMENT_PLAN_LIMITS = Object.freeze({
  maxStores: WEBAPI_STORE_CODES.length,
  maxEndpoints: 5,
  minMetaIndexIds: 1,
  maxMetaIndexIds: 50,
  maxMetaIndexId: 1_000_000,
  maxTemplateType: 9_999,
});

const CREATED_BY_PATTERN = /^[A-Za-z0-9._:-]{3,80}$/;
const PLAN_HASH_PATTERN = /^[0-9a-f]{64}$/;

export class ExperimentPlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExperimentPlanError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ExperimentPlanError(code, message, details);
}

function normalizeStoreCodes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('EMPTY_STORE_SCOPE', 'at least one canonical store code is required');
  }
  const normalized = [...new Set(
    value.map((item) => String(item ?? '').trim().toUpperCase()).filter((item) => item !== ''),
  )].sort();
  if (normalized.length === 0) {
    fail('EMPTY_STORE_SCOPE', 'at least one canonical store code is required');
  }
  for (const storeCode of normalized) {
    if (!WEBAPI_STORE_CODES.includes(storeCode)) {
      fail('STORE_NOT_ALLOWED', 'only the two evidenced experiment stores are allowed', {
        storeCode,
      });
    }
  }
  if (normalized.length > EXPERIMENT_PLAN_LIMITS.maxStores) {
    fail('STORE_SCOPE_TOO_LARGE', 'store scope exceeds the planner bound');
  }
  return normalized;
}

function normalizeEndpointCodes(value, stage) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('EMPTY_ENDPOINT_SCOPE', 'at least one endpoint code is required');
  }
  const normalized = [...new Set(
    value.map((item) => String(item ?? '').trim().toUpperCase()).filter((item) => item !== ''),
  )].sort();
  if (normalized.length === 0) {
    fail('EMPTY_ENDPOINT_SCOPE', 'at least one endpoint code is required');
  }
  if (normalized.length > EXPERIMENT_PLAN_LIMITS.maxEndpoints) {
    fail('ENDPOINT_SCOPE_TOO_LARGE', 'endpoint scope exceeds the planner bound');
  }
  const allowedForStage = stage === EXPERIMENT_STAGES.CATALOG
    ? CATALOG_ENDPOINT_CODES
    : METRIC_DETAIL_ENDPOINT_CODES;
  for (const endpointCode of normalized) {
    // `describeEndpoint` throws for anything outside the evidenced allow-list.
    describeEndpoint(endpointCode);
    if (!allowedForStage.includes(endpointCode)) {
      // A value endpoint can never run in a discovery plan, and a catalog
      // endpoint can never masquerade as metric detail.
      fail('ENDPOINT_NOT_ALLOWED_FOR_STAGE', 'endpoint does not belong to this stage', {
        endpointCode,
        stage,
      });
    }
  }
  return normalized;
}

function normalizeMetaIndexIds(value, stage) {
  if (stage === EXPERIMENT_STAGES.CATALOG) {
    if (value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0)) {
      fail('CATALOG_REJECTS_META_INDEX_IDS', 'a catalog plan must not request metric ids');
    }
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || value.length === 0) {
    // Stage B is only reachable after a human reviewed catalog output.
    fail(
      'METRIC_DETAIL_REQUIRES_META_INDEX_IDS',
      'metric detail requires explicit reviewed metaIndexIds',
    );
  }
  const normalized = [...new Set(value.map((item) => {
    if (typeof item === 'number') return item;
    const text = String(item ?? '').trim();
    if (!/^[1-9][0-9]*$/.test(text)) return Number.NaN;
    return Number(text);
  }))].sort((left, right) => left - right);
  for (const metaIndexId of normalized) {
    if (
      !Number.isSafeInteger(metaIndexId)
      || metaIndexId <= 0
      || metaIndexId > EXPERIMENT_PLAN_LIMITS.maxMetaIndexId
    ) {
      fail('META_INDEX_ID_INVALID', 'metaIndexIds must be bounded positive integers');
    }
  }
  if (
    normalized.length < EXPERIMENT_PLAN_LIMITS.minMetaIndexIds
    || normalized.length > EXPERIMENT_PLAN_LIMITS.maxMetaIndexIds
  ) {
    fail('META_INDEX_ID_COUNT_INVALID', 'metaIndexId count exceeds the planner bound');
  }
  return Object.freeze(normalized);
}

function endpointNeedsTemplateType(endpointCode) {
  const shape = describeEndpoint(endpointCode).requestShape;
  return shape === WEBAPI_REQUEST_SHAPES.TEMPLATE_TYPE_QUERY
    || shape === WEBAPI_REQUEST_SHAPES.META_INDEX_IDS_WITH_TEMPLATE;
}

function normalizeTemplateType(value, endpointCodes) {
  const required = endpointCodes.some(endpointNeedsTemplateType);
  if (!required) {
    if (value !== undefined && value !== null && String(value) !== '') {
      fail('TEMPLATE_TYPE_NOT_REQUIRED', 'no requested endpoint accepts a templateType');
    }
    return null;
  }
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    fail('TEMPLATE_TYPE_REQUIRED', 'templateType is required by a requested endpoint');
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > EXPERIMENT_PLAN_LIMITS.maxTemplateType) {
    fail('TEMPLATE_TYPE_INVALID', 'templateType must be a small non-negative integer');
  }
  return parsed;
}

/** The exact request each probe will make, derived from the stage contract. */
function buildProbeRequest(endpointCode, { metaIndexIds, templateType }) {
  const shape = describeEndpoint(endpointCode).requestShape;
  if (shape === WEBAPI_REQUEST_SHAPES.TEMPLATE_TYPE_QUERY) {
    return { templateType };
  }
  if (shape === WEBAPI_REQUEST_SHAPES.META_INDEX_IDS) {
    return { metaIndexIds: [...metaIndexIds] };
  }
  if (shape === WEBAPI_REQUEST_SHAPES.META_INDEX_IDS_WITH_TEMPLATE) {
    return { metaIndexIds: [...metaIndexIds], templateType };
  }
  return {};
}

/**
 * Build a deterministic, bounded experiment plan.
 *
 * @returns {Readonly<object>} frozen plan with `planHash` and ordered probes
 */
export function buildWebApiExperimentPlan(request = {}) {
  const stageToken = String(request.stage ?? '').trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(EXPERIMENT_STAGES, stageToken)) {
    fail('STAGE_INVALID', 'stage must be CATALOG or METRIC_DETAIL');
  }
  const stage = EXPERIMENT_STAGES[stageToken];
  const storeCodes = normalizeStoreCodes(request.storeCodes);
  const endpointCodes = normalizeEndpointCodes(request.endpointCodes, stage);
  const metaIndexIds = normalizeMetaIndexIds(request.metaIndexIds, stage);
  const templateType = normalizeTemplateType(request.templateType, endpointCodes);
  const createdBy = String(request.createdBy ?? '').trim();
  if (!CREATED_BY_PATTERN.test(createdBy)) {
    fail('CREATED_BY_INVALID', 'createdBy must be an explicit auditable operator key');
  }

  // Deterministic order: store, then endpoint.
  const probes = [];
  for (const storeCode of storeCodes) {
    for (const endpointCode of endpointCodes) {
      probes.push(Object.freeze({
        storeCode,
        endpointCode,
        carriesMetricValues: describeEndpoint(endpointCode).carriesMetricValues,
        request: Object.freeze(buildProbeRequest(endpointCode, { metaIndexIds, templateType })),
      }));
    }
  }

  const planHash = canonicalHash({
    planVersion: EXPERIMENT_PLAN_VERSION,
    stage,
    storeCodes,
    endpointCodes,
    metaIndexIds: [...metaIndexIds],
    templateType,
    probes: probes.map((probe) => ({
      storeCode: probe.storeCode,
      endpointCode: probe.endpointCode,
    })),
  });

  return Object.freeze({
    planVersion: EXPERIMENT_PLAN_VERSION,
    planHash,
    stage,
    createdBy,
    storeCodes: Object.freeze(storeCodes),
    endpointCodes: Object.freeze(endpointCodes),
    metaIndexIds,
    templateType,
    probes: Object.freeze(probes),
    summary: Object.freeze({
      storeCount: storeCodes.length,
      endpointCount: endpointCodes.length,
      probeCount: probes.length,
      metaIndexIdCount: metaIndexIds.length,
      carriesMetricValues: probes.some((probe) => probe.carriesMetricValues),
    }),
  });
}

function normalizedSet(value, normalize) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => normalize(String(item ?? '').trim()))
      .filter((item) => item !== ''),
  )].sort();
}

/**
 * Execute authorization requires the exact reviewed plan hash plus explicit
 * allow-lists whose sets equal the plan's own scope exactly. A superset is
 * refused as loudly as a subset, so an approval can never silently widen.
 */
export function assertExperimentExecuteAuthorization({
  plan,
  approvedPlanHash,
  allowedStoreCodes,
  allowedEndpointCodes,
} = {}) {
  if (!plan || typeof plan.planHash !== 'string') {
    fail('MISSING_PLAN', 'execute authorization requires a built plan');
  }
  const hash = String(approvedPlanHash ?? '').trim().toLowerCase();
  if (!PLAN_HASH_PATTERN.test(hash)) {
    fail('MISSING_APPROVED_PLAN_HASH', 'execute requires an explicit 64-hex plan hash');
  }
  if (hash !== plan.planHash) {
    fail('PLAN_HASH_MISMATCH', 'approved plan hash does not match the built plan');
  }
  const stores = normalizedSet(allowedStoreCodes, (item) => item.toUpperCase());
  const endpoints = normalizedSet(allowedEndpointCodes, (item) => item.toUpperCase());
  if (stores.length === 0) {
    fail('MISSING_ALLOWED_STORES', 'execute requires explicit allowed store codes');
  }
  if (endpoints.length === 0) {
    fail('MISSING_ALLOWED_ENDPOINTS', 'execute requires explicit allowed endpoint codes');
  }
  if (JSON.stringify(stores) !== JSON.stringify([...plan.storeCodes])) {
    fail('STORE_SCOPE_NOT_EXACT', 'allowed store codes must equal the plan scope exactly');
  }
  if (JSON.stringify(endpoints) !== JSON.stringify([...plan.endpointCodes])) {
    fail('ENDPOINT_SCOPE_NOT_EXACT', 'allowed endpoint codes must equal the plan scope exactly');
  }
  return Object.freeze({
    planHash: plan.planHash,
    stage: plan.stage,
    allowedStoreCodes: Object.freeze(stores),
    allowedEndpointCodes: Object.freeze(endpoints),
  });
}
