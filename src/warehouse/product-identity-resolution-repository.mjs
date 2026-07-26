import { createHash } from 'node:crypto';

import {
  buildGlobalProductIdentityResolutionPlan,
} from '../domain/product-identity-resolution-plan.mjs';
import {
  isValidGtin,
  normalizeIdentifierValue,
} from '../domain/product-identity.mjs';

const OBSERVATION_RUN_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;
const AUDIT_RUN_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ATTRIBUTE_ID_PATTERN = /^[0-9]{1,32}$/;
const OFFICIAL_MODEL_ATTRIBUTE_ID = '1000546';
const DEFAULT_MATCHER_VERSION = 'observed-matcher-v1';
const DEFAULT_POLICY_VERSION = 'strict-global-clique-v1';
const DEFAULT_ACTOR_PREFIX = 'resolution';
const HARD_ATTRIBUTE_TYPES = new Set([
  'VOLTAGE',
  'PLUG',
  'CAPACITY',
  'DIMENSIONS',
]);
const FORBIDDEN_PLANNER_TEXT = (
  /(?:https?:\/\/|authorization|bearer\s+|x-api-key|access[_-]?token|client[_-]?secret|signature|cookie)/i
);

export const PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES = Object.freeze({
  invalidInput: 'INVALID_INPUT',
  evidenceCoverageMismatch: 'EVIDENCE_COVERAGE_MISMATCH',
  evidenceSetInvalid: 'EVIDENCE_SET_INVALID',
  evidenceMemberCountMismatch: 'EVIDENCE_MEMBER_COUNT_MISMATCH',
  evidenceHierarchyMismatch: 'EVIDENCE_HIERARCHY_MISMATCH',
  planHashMismatch: 'PLAN_HASH_MISMATCH',
  skuLockMismatch: 'SKU_LOCK_MISMATCH',
  idempotencyDrift: 'IDEMPOTENCY_DRIFT',
  existingMappingConflict: 'EXISTING_MAPPING_CONFLICT',
});

class ProductIdentityResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductIdentityResolutionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductIdentityResolutionError(code, message);
}

function requirePool(pool) {
  if (!pool || typeof pool.connect !== 'function') {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.invalidInput,
      'A database pool is required.',
    );
  }
  return pool;
}

function safeIdentifier(value, label, pattern = OBSERVATION_RUN_PATTERN) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.invalidInput,
      `${label} is invalid.`,
    );
  }
  return value;
}

function safeVersion(value, label, fallback) {
  const candidate = value ?? fallback;
  if (
    typeof candidate !== 'string'
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
  ) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.invalidInput,
      `${label} is invalid.`,
    );
  }
  return candidate;
}

function safeFingerprint(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.invalidInput,
      `${label} must be a lowercase SHA-256 fingerprint.`,
    );
  }
  return value;
}

function safeInstant(value, label, fallback = null) {
  const candidate = value ?? fallback;
  const parsed = candidate instanceof Date ? candidate : new Date(candidate);
  if (!candidate || Number.isNaN(parsed.valueOf())) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.invalidInput,
      `${label} must be a valid timestamp.`,
    );
  }
  return parsed.toISOString();
}

function normalizedOptions(input = {}) {
  const observationRunId = safeIdentifier(
    input.observationRunId,
    'observationRunId',
  );
  const auditRunId = safeIdentifier(
    input.runId ?? `resolve:${fingerprint(observationRunId).slice(0, 32)}`,
    'runId',
    AUDIT_RUN_PATTERN,
  );
  return Object.freeze({
    observationRunId,
    auditRunId,
    now: safeInstant(input.now, 'now', new Date()),
    matcherVersion: safeVersion(
      input.matcherVersion,
      'matcherVersion',
      DEFAULT_MATCHER_VERSION,
    ),
    policyVersion: safeVersion(
      input.policyVersion,
      'policyVersion',
      DEFAULT_POLICY_VERSION,
    ),
  });
}

function stableValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function fingerprint(value) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function databaseJson(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function exactJson(left, right) {
  return stableJson(databaseJson(left, left)) === stableJson(right);
}

function exactInstant(left, right) {
  if (left === undefined || left === null) return false;
  const parsed = new Date(left);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === right;
}

function rowCount(result) {
  if (Number.isInteger(result?.rowCount)) return result.rowCount;
  return Array.isArray(result?.rows) ? result.rows.length : 0;
}

async function inTransaction(pool, beginSql, work) {
  requirePool(pool);
  const client = await pool.connect();
  try {
    await client.query(beginSql);
    await client.query("SET LOCAL lock_timeout TO '10s'");
    await client.query("SET LOCAL statement_timeout TO '120s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original evidence or write failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

function requiredDatabaseId(value, code, message) {
  const result = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(result)) fail(code, message);
  return result;
}

function optionalPlannerText(value, maximum = 2_000) {
  if (value === undefined || value === null) return null;
  const result = String(value).normalize('NFKC').trim();
  if (
    !result
    || result.length > maximum
    || FORBIDDEN_PLANNER_TEXT.test(result)
  ) {
    return null;
  }
  return result;
}

function assignmentFingerprint(row, ignoredPlanHash = null) {
  if (row.assignment_id === undefined || row.assignment_id === null) return null;
  if (ignoredPlanHash && row.assignment_plan_hash === ignoredPlanHash) return null;
  return fingerprint({
    assignmentId: String(row.assignment_id),
    assignmentKey: row.assignment_key,
    canonicalProductId: String(row.assignment_canonical_product_id),
    decisionId: String(row.assignment_decision_id),
    identityComponentKey: row.assignment_identity_component_key,
    identityScope: row.assignment_identity_scope,
    observationRunId: row.assignment_observation_run_id,
    planHash: row.assignment_plan_hash,
  });
}

async function readActiveSkuUniverse(client, { ignoredPlanHash = null } = {}) {
  const result = await client.query(
    `SELECT
         store.store_id,
         store.store_code,
         sku.full_sku_id,
         sku.platform_spu_id,
         sku.platform_skc_id,
         sku.platform_sku_id,
         assignment.full_sku_canonical_assignment_id AS assignment_id,
         assignment.assignment_key,
         assignment.canonical_product_id AS assignment_canonical_product_id,
         assignment.product_identity_decision_id AS assignment_decision_id,
         assignment.identity_scope AS assignment_identity_scope,
         assignment.identity_component_key AS assignment_identity_component_key,
         assignment.observation_run_id AS assignment_observation_run_id,
         assignment.plan_hash AS assignment_plan_hash
       FROM dim.full_sku AS sku
       JOIN dim.store AS store
         ON store.store_id = sku.store_id
       LEFT JOIN dim.full_sku_canonical_assignment AS assignment
         ON assignment.store_id = sku.store_id
        AND assignment.full_sku_id = sku.full_sku_id
        AND assignment.assignment_status = 'CONFIRMED'
        AND assignment.valid_to IS NULL
      WHERE store.cooperation_mode = 'FULL_MANAGED'
        AND store.is_active = true
        AND sku.is_active = true
      ORDER BY store.store_code, sku.platform_sku_id, sku.full_sku_id`,
  );
  const universe = [];
  const keys = new Set();
  for (const row of result.rows ?? []) {
    const storeId = requiredDatabaseId(
      row.store_id,
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceHierarchyMismatch,
      'The active SKU universe contains an invalid store id.',
    );
    const fullSkuId = requiredDatabaseId(
      row.full_sku_id,
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceHierarchyMismatch,
      'The active SKU universe contains an invalid SKU id.',
    );
    const key = `${storeId}:${fullSkuId}`;
    if (keys.has(key)) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceCoverageMismatch,
        'The active SKU universe contains duplicate rows.',
      );
    }
    keys.add(key);
    const storeCode = optionalPlannerText(row.store_code, 128)?.toUpperCase();
    const platformSkuId = optionalPlannerText(row.platform_sku_id, 512);
    const platformSkcId = optionalPlannerText(row.platform_skc_id, 512);
    const rawPlatformSpuId = row.platform_spu_id;
    const platformSpuId = rawPlatformSpuId === null
      || rawPlatformSpuId === undefined
      || String(rawPlatformSpuId).trim() === ''
      ? null
      : optionalPlannerText(rawPlatformSpuId, 512);
    if (
      !storeCode
      || !/^[A-Z0-9_-]+$/.test(storeCode)
      || !platformSkuId
      || !platformSkcId
      || (
        rawPlatformSpuId !== null
        && rawPlatformSpuId !== undefined
        && String(rawPlatformSpuId).trim() !== ''
        && !platformSpuId
      )
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceHierarchyMismatch,
        'An active SKU has an unsafe store, SPU, SKC or SKU identifier.',
      );
    }
    universe.push(Object.freeze({
      key,
      storeId,
      storeCode,
      fullSkuId,
      platformSpuId,
      platformSkcId,
      platformSkuId,
      assignment: row.assignment_id === undefined || row.assignment_id === null
        ? null
        : Object.freeze({
          assignmentId: String(row.assignment_id),
          assignmentKey: row.assignment_key,
          canonicalProductId: String(row.assignment_canonical_product_id),
          decisionId: String(row.assignment_decision_id),
          identityScope: row.assignment_identity_scope,
          identityComponentKey: row.assignment_identity_component_key,
          observationRunId: row.assignment_observation_run_id,
          planHash: row.assignment_plan_hash,
        }),
      assignmentFingerprint: assignmentFingerprint(row, ignoredPlanHash),
    }));
  }
  return universe;
}

async function readSealedEvidenceRows(client, observationRunId) {
  const result = await client.query(
    `SELECT
         evidence_set.identity_observation_set_id,
         evidence_set.store_id,
         evidence_set.full_sku_id,
         evidence_set.source_fetch_batch_id,
         evidence_set.observation_run_id,
         evidence_set.status AS set_status,
         evidence_set.member_count,
         evidence_set.platform_spu_id,
         evidence_set.platform_skc_id,
         evidence_set.platform_sku_id,
         evidence_set.set_payload_fingerprint,
         observation.identifier_observation_id,
         observation.store_id AS observation_store_id,
         observation.full_sku_id AS observation_full_sku_id,
         observation.source_fetch_batch_id AS observation_fetch_batch_id,
         observation.identity_observation_set_id AS observation_set_id,
         observation.identifier_type,
         observation.raw_value,
         observation.normalized_value,
         observation.evidence,
         observation.identity_scope,
         observation.scope_key,
         observation.source_value_key,
         observation.payload_fingerprint
       FROM raw.product_identity_observation_set AS evidence_set
       JOIN dim.full_sku AS sku
         ON sku.store_id = evidence_set.store_id
        AND sku.full_sku_id = evidence_set.full_sku_id
       JOIN dim.store AS store
         ON store.store_id = evidence_set.store_id
       LEFT JOIN raw.identifier_observation AS observation
         ON observation.identity_observation_set_id =
              evidence_set.identity_observation_set_id
      WHERE evidence_set.observation_run_id = $1
      ORDER BY
         evidence_set.store_id,
         evidence_set.full_sku_id,
         evidence_set.identity_observation_set_id,
         observation.source_value_key,
         observation.identifier_observation_id`,
    [observationRunId],
  );
  return result.rows ?? [];
}

function evidenceObject(value) {
  const parsed = databaseJson(value, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      'An identifier observation has invalid evidence metadata.',
    );
  }
  return parsed;
}

function normalizedMember(row, evidenceSet) {
  const identifierObservationId = requiredDatabaseId(
    row.identifier_observation_id,
    PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
    'An identifier observation id is invalid.',
  );
  if (
    String(row.observation_store_id) !== evidenceSet.storeId
    || String(row.observation_full_sku_id) !== evidenceSet.fullSkuId
    || String(row.observation_fetch_batch_id) !== evidenceSet.sourceFetchBatchId
    || String(row.observation_set_id) !== evidenceSet.setId
  ) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceHierarchyMismatch,
      'An identifier observation is attached to the wrong evidence envelope.',
    );
  }
  const identifierType = optionalPlannerText(row.identifier_type, 64)?.toUpperCase();
  const rawValue = typeof row.raw_value === 'string' ? row.raw_value : null;
  const sourceValueKey = optionalPlannerText(row.source_value_key, 512);
  const identityScope = optionalPlannerText(row.identity_scope, 32)?.toUpperCase();
  const scopeKey = optionalPlannerText(row.scope_key, 512);
  if (!identifierType || !rawValue || !sourceValueKey || !identityScope || !scopeKey) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      'An identifier observation is missing required metadata.',
    );
  }
  const expectedScopeKey = identityScope === 'PRODUCT'
    ? `SPU:${evidenceSet.platformSpuId}`
    : identityScope === 'VARIANT'
      ? `SKU:${evidenceSet.platformSkuId}`
      : null;
  if (!expectedScopeKey || scopeKey !== expectedScopeKey) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceHierarchyMismatch,
      'An identifier observation has an invalid product or variant scope.',
    );
  }
  const metadata = evidenceObject(row.evidence);
  if (identifierType === 'IMAGE_REFERENCE') {
    if (row.normalized_value !== null && row.normalized_value !== undefined) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
        'Image references cannot become normalized identity values.',
      );
    }
    return Object.freeze({
      identifierObservationId,
      identifierType,
      rawValue,
      normalizedValue: null,
      sourceValueKey,
      identityScope,
      scopeKey,
      evidence: metadata,
    });
  }
  const expectedNormalizedValue = normalizeIdentifierValue(identifierType, rawValue);
  if (
    !expectedNormalizedValue
    || row.normalized_value !== expectedNormalizedValue
  ) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      'An identifier observation normalized value failed exact readback.',
    );
  }
  return Object.freeze({
    identifierObservationId,
    identifierType,
    rawValue,
    normalizedValue: expectedNormalizedValue,
    sourceValueKey,
    identityScope,
    scopeKey,
    evidence: metadata,
  });
}

function validateHierarchyMembers(evidenceSet) {
  const expectations = [
    ['PLATFORM_SPU', 'PRODUCT', evidenceSet.platformSpuId],
    ['PLATFORM_SKC', 'VARIANT', evidenceSet.platformSkcId],
    ['PLATFORM_SKU', 'VARIANT', evidenceSet.platformSkuId],
  ];
  for (const [identifierType, identityScope, expectedRawValue] of expectations) {
    const matches = evidenceSet.members.filter((member) => (
      member.identifierType === identifierType
      && member.identityScope === identityScope
    ));
    if (
      matches.length !== 1
      || matches[0].rawValue !== expectedRawValue
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceHierarchyMismatch,
        'A sealed evidence set disagrees with its SPU, SKC or SKU hierarchy.',
      );
    }
  }
}

function groupEvidenceSets(rows, universe, observationRunId) {
  const universeByKey = new Map(universe.map((sku) => [sku.key, sku]));
  const setsById = new Map();
  for (const row of rows) {
    const setId = requiredDatabaseId(
      row.identity_observation_set_id,
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      'A sealed evidence-set id is invalid.',
    );
    const storeId = requiredDatabaseId(
      row.store_id,
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      'A sealed evidence-set store id is invalid.',
    );
    const fullSkuId = requiredDatabaseId(
      row.full_sku_id,
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      'A sealed evidence-set SKU id is invalid.',
    );
    const sourceFetchBatchId = requiredDatabaseId(
      row.source_fetch_batch_id,
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      'A sealed evidence-set batch id is invalid.',
    );
    const sku = universeByKey.get(`${storeId}:${fullSkuId}`);
    if (!sku) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceCoverageMismatch,
        'A sealed evidence set is outside the active SKU universe.',
      );
    }
    if (
      row.observation_run_id !== observationRunId
      || row.set_status !== 'SEALED'
      || row.platform_spu_id !== sku.platformSpuId
      || row.platform_skc_id !== sku.platformSkcId
      || row.platform_sku_id !== sku.platformSkuId
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceHierarchyMismatch,
        'A sealed evidence set failed run or SKU hierarchy validation.',
      );
    }
    const setFingerprint = String(row.set_payload_fingerprint ?? '');
    if (!SHA256_PATTERN.test(setFingerprint)) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
        'A sealed evidence-set fingerprint is invalid.',
      );
    }
    let evidenceSet = setsById.get(setId);
    if (!evidenceSet) {
      evidenceSet = {
        setId,
        storeId,
        fullSkuId,
        sourceFetchBatchId,
        observationRunId,
        memberCount: Number(row.member_count),
        platformSpuId: sku.platformSpuId,
        platformSkcId: sku.platformSkcId,
        platformSkuId: sku.platformSkuId,
        setFingerprint,
        sku,
        members: [],
        memberIds: new Set(),
      };
      setsById.set(setId, evidenceSet);
    } else if (
      evidenceSet.storeId !== storeId
      || evidenceSet.fullSkuId !== fullSkuId
      || evidenceSet.sourceFetchBatchId !== sourceFetchBatchId
      || evidenceSet.setFingerprint !== setFingerprint
      || evidenceSet.memberCount !== Number(row.member_count)
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
        'A sealed evidence-set header drifted across member rows.',
      );
    }
    if (row.identifier_observation_id !== null && row.identifier_observation_id !== undefined) {
      const member = normalizedMember(row, evidenceSet);
      if (evidenceSet.memberIds.has(member.identifierObservationId)) {
        fail(
          PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
          'A sealed evidence set repeats an identifier observation.',
        );
      }
      evidenceSet.memberIds.add(member.identifierObservationId);
      evidenceSet.members.push(member);
    }
  }

  const setBySkuKey = new Map();
  for (const evidenceSet of setsById.values()) {
    if (
      !Number.isInteger(evidenceSet.memberCount)
      || evidenceSet.memberCount <= 0
      || evidenceSet.members.length !== evidenceSet.memberCount
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceMemberCountMismatch,
        'A sealed evidence set member_count failed exact readback.',
      );
    }
    validateHierarchyMembers(evidenceSet);
    if (setBySkuKey.has(evidenceSet.sku.key)) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceCoverageMismatch,
        'An active SKU has multiple sealed evidence sets in one run.',
      );
    }
    setBySkuKey.set(evidenceSet.sku.key, evidenceSet);
  }
  const excludedMissingEvidence = universe
    .filter((sku) => !setBySkuKey.has(sku.key))
    .map((sku) => Object.freeze({
      storeId: sku.storeId,
      storeCode: sku.storeCode,
      fullSkuId: sku.fullSkuId,
      platformSpuId: sku.platformSpuId,
      platformSkcId: sku.platformSkcId,
      platformSkuId: sku.platformSkuId,
      missingReason: sku.platformSpuId
        ? 'MISSING_SEALED_EVIDENCE'
        : 'MISSING_PLATFORM_SPU',
      currentAssignmentFingerprint: sku.assignmentFingerprint,
    }))
    .sort((left, right) => (
      left.storeCode.localeCompare(right.storeCode)
      || left.platformSkuId.localeCompare(right.platformSkuId)
      || compareDatabaseIds(left.fullSkuId, right.fullSkuId)
    ));
  return {
    sets: [...setsById.values()],
    setsById,
    setBySkuKey,
    excludedMissingEvidence,
  };
}

function attributeId(member) {
  const value = member?.evidence?.attributeId;
  if (value === undefined || value === null || value === '') return null;
  const result = String(value);
  if (!ATTRIBUTE_ID_PATTERN.test(result)) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      'A product attribute is missing a safe numeric attribute id.',
    );
  }
  return result;
}

function productAttributeMembers(evidenceSet) {
  const members = [];
  for (const member of evidenceSet.members) {
    if (member.identityScope !== 'PRODUCT') continue;
    const id = attributeId(member);
    if (!id) {
      if (member.identifierType === 'MODEL') {
        fail(
          PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
          'MODEL evidence requires the official model attribute id.',
        );
      }
      continue;
    }
    if (
      !member.sourceValueKey.startsWith(`product.attribute:${id}:`)
      || (member.identifierType === 'MODEL') !== (id === OFFICIAL_MODEL_ATTRIBUTE_ID)
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
        'A product attribute type or source key disagrees with its attribute id.',
      );
    }
    members.push(member);
  }
  return members.sort((left, right) => (
    attributeId(left).localeCompare(attributeId(right), 'en', { numeric: true })
    || left.normalizedValue.localeCompare(right.normalizedValue)
    || left.identifierObservationId.localeCompare(right.identifierObservationId)
  ));
}

function singleProductMember(evidenceSet, identifierType, sourceValueKey) {
  const members = evidenceSet.members
    .filter((member) => (
      member.identifierType === identifierType
      && member.identityScope === 'PRODUCT'
      && member.sourceValueKey === sourceValueKey
    ))
    .sort((left, right) => (
      left.normalizedValue.localeCompare(right.normalizedValue)
      || left.identifierObservationId.localeCompare(right.identifierObservationId)
    ));
  const values = new Set(members.map(({ normalizedValue }) => normalizedValue));
  if (values.size > 1) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      'A product-level identifier has multiple normalized values in one set.',
    );
  }
  return members[0] ?? null;
}

function officialModelMember(evidenceSet) {
  const members = productAttributeMembers(evidenceSet)
    .filter((member) => (
      member.identifierType === 'MODEL'
      && attributeId(member) === OFFICIAL_MODEL_ATTRIBUTE_ID
    ));
  const values = new Set(members.map(({ normalizedValue }) => normalizedValue));
  if (values.size > 1) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      'Official MODEL evidence has multiple normalized values in one set.',
    );
  }
  return members[0] ?? null;
}

function semanticProductSignature(evidenceSet) {
  const attributes = productAttributeMembers(evidenceSet).map((member) => ({
    attributeId: attributeId(member),
    identifierType: member.identifierType,
    normalizedValue: member.normalizedValue,
  }));
  return stableJson({
    model: officialModelMember(evidenceSet)?.normalizedValue ?? null,
    brand: singleProductMember(
      evidenceSet,
      'BRAND',
      'product.brand_code',
    )?.normalizedValue ?? null,
    category: singleProductMember(
      evidenceSet,
      'CATEGORY',
      'product.category_id',
    )?.normalizedValue ?? null,
    supplierCode: singleProductMember(
      evidenceSet,
      'SUPPLIER_CODE',
      'product.supplier_code',
    )?.normalizedValue ?? null,
    attributes,
  });
}

function plannerMember(member, standard = null) {
  if (!member) return null;
  const normalizedValue = optionalPlannerText(member.normalizedValue, 2_000);
  if (!normalizedValue) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      'An identity value is unsafe for planner normalization.',
    );
  }
  return Object.freeze({
    observationId: member.identifierObservationId,
    normalizedValue,
    sourceValueKey: member.sourceValueKey,
    standard,
  });
}

function plannerBarcodes(evidenceSet) {
  const result = [];
  for (const member of evidenceSet.members) {
    if (
      member.identifierType !== 'BARCODE'
      || member.identityScope !== 'VARIANT'
    ) {
      continue;
    }
    const standard = String(member.evidence.barcodeStandard ?? '').toUpperCase();
    const valid = isValidGtin(member.normalizedValue);
    if (
      typeof member.evidence.gtinCheckDigitValid !== 'boolean'
      || member.evidence.gtinCheckDigitValid !== valid
      || typeof member.evidence.strongEvidence !== 'boolean'
      || member.evidence.strongEvidence
        !== ((standard === 'EAN' || standard === 'UPC') && valid)
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
        'Barcode validation metadata failed exact readback.',
      );
    }
    if ((standard !== 'EAN' && standard !== 'UPC') || !valid) continue;
    result.push(plannerMember(member, Object.freeze({
      standard,
      type: 'BARCODE',
    })));
  }
  return result.sort((left, right) => (
    left.normalizedValue.localeCompare(right.normalizedValue)
    || left.observationId.localeCompare(right.observationId)
  ));
}

function plannerProfile(evidenceSet) {
  const attributes = productAttributeMembers(evidenceSet);
  const coreAttributes = attributes
    .filter((member) => attributeId(member) !== OFFICIAL_MODEL_ATTRIBUTE_ID)
    .map((member) => plannerMember(member, Object.freeze({
      attributeId: attributeId(member),
      type: member.identifierType,
    })));
  return Object.freeze({
    setId: evidenceSet.setId,
    model: plannerMember(
      officialModelMember(evidenceSet),
      Object.freeze({
        attributeId: OFFICIAL_MODEL_ATTRIBUTE_ID,
        type: 'MODEL',
      }),
    ),
    brand: plannerMember(
      singleProductMember(evidenceSet, 'BRAND', 'product.brand_code'),
      Object.freeze({ type: 'BRAND' }),
    ),
    category: plannerMember(
      singleProductMember(evidenceSet, 'CATEGORY', 'product.category_id'),
      Object.freeze({ type: 'CATEGORY' }),
    ),
    supplierCode: plannerMember(
      singleProductMember(
        evidenceSet,
        'SUPPLIER_CODE',
        'product.supplier_code',
      ),
      Object.freeze({ type: 'SUPPLIER_CODE' }),
    ),
    barcodes: Object.freeze(plannerBarcodes(evidenceSet)),
    coreAttributes: Object.freeze(coreAttributes),
    hardAttributes: Object.freeze(coreAttributes.filter(
      (member) => HARD_ATTRIBUTE_TYPES.has(member.standard.type),
    )),
  });
}

function buildPlannerNodes(evidenceState) {
  const groups = new Map();
  for (const evidenceSet of evidenceState.sets) {
    const key = `${evidenceSet.storeId}\u0000${evidenceSet.platformSpuId}`;
    const sets = groups.get(key) ?? [];
    sets.push(evidenceSet);
    groups.set(key, sets);
  }
  const nodes = [];
  for (const sets of groups.values()) {
    sets.sort((left, right) => (
      left.platformSkuId.localeCompare(right.platformSkuId)
      || left.setId.localeCompare(right.setId)
    ));
    const productSignatures = new Set(sets.map(semanticProductSignature));
    if (productSignatures.size !== 1) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
        'Product-level evidence differs between SKU sets in one SPU node.',
      );
    }
    const representative = sets[0];
    const assignmentState = sets.map((evidenceSet) => ({
      fullSkuId: evidenceSet.fullSkuId,
      platformSkuId: evidenceSet.platformSkuId,
      assignmentFingerprint: evidenceSet.sku.assignmentFingerprint,
    }));
    const hasAssignment = assignmentState.some(
      ({ assignmentFingerprint: value }) => value !== null,
    );
    nodes.push(Object.freeze({
      nodeKey: fingerprint({
        storeId: representative.storeId,
        platformSpuId: representative.platformSpuId,
      }),
      storeCode: representative.sku.storeCode,
      platformSpuId: representative.platformSpuId,
      representativeSetId: representative.setId,
      sealedSkuSetRefs: Object.freeze(sets.map((evidenceSet) => Object.freeze({
        setId: evidenceSet.setId,
        platformSkuId: evidenceSet.platformSkuId,
        setFingerprint: evidenceSet.setFingerprint,
      }))),
      profile: plannerProfile(representative),
      currentAssignmentFingerprint: hasAssignment
        ? fingerprint(assignmentState)
        : null,
    }));
  }
  return nodes.sort((left, right) => (
    left.storeCode.localeCompare(right.storeCode)
    || left.nodeKey.localeCompare(right.nodeKey)
  ));
}

async function computeResolutionState(client, options, {
  ignoredPlanHash = null,
} = {}) {
  const universe = await readActiveSkuUniverse(client, { ignoredPlanHash });
  const evidenceRows = await readSealedEvidenceRows(
    client,
    options.observationRunId,
  );
  const evidenceState = groupEvidenceSets(
    evidenceRows,
    universe,
    options.observationRunId,
  );
  const nodes = buildPlannerNodes(evidenceState);
  const domainPlan = buildGlobalProductIdentityResolutionPlan({
    nodes,
    matcherVersion: options.matcherVersion,
    policyVersion: options.policyVersion,
  });
  const inputEvidenceFingerprint = fingerprint({
    coveredEvidenceFingerprint: domainPlan.inputEvidenceFingerprint,
    excludedMissingEvidence: evidenceState.excludedMissingEvidence,
  });
  const summary = Object.freeze({
    ...domainPlan.summary,
    excludedMissingEvidenceSkuCount:
      evidenceState.excludedMissingEvidence.length,
    excludedMissingHierarchySkuCount:
      evidenceState.excludedMissingEvidence.filter(
        ({ missingReason }) => missingReason === 'MISSING_PLATFORM_SPU',
      ).length,
  });
  const {
    planHash: domainPlanHash,
    inputEvidenceFingerprint: ignoredDomainInputFingerprint,
    summary: ignoredDomainSummary,
    ...domainPlanBody
  } = domainPlan;
  void ignoredDomainInputFingerprint;
  void ignoredDomainSummary;
  const planWithoutHash = {
    ...domainPlanBody,
    domainPlanHash,
    inputEvidenceFingerprint,
    excludedMissingEvidence: Object.freeze(
      [...evidenceState.excludedMissingEvidence],
    ),
    summary,
  };
  const plan = Object.freeze({
    ...planWithoutHash,
    planHash: fingerprint(planWithoutHash),
  });
  return {
    universe,
    evidenceState,
    nodes,
    plan,
  };
}

function publicPreparedPlan(options, plan) {
  return Object.freeze({
    observationRunId: options.observationRunId,
    auditRunId: options.auditRunId,
    preparedAt: options.now,
    ...plan,
  });
}

export async function prepareProductIdentityResolutionPlan(pool, input = {}) {
  const options = normalizedOptions(input);
  return inTransaction(
    pool,
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    async (client) => {
      const { plan } = await computeResolutionState(client, options);
      return publicPreparedPlan(options, plan);
    },
  );
}

function compareDatabaseIds(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText.length - rightText.length || leftText.localeCompare(rightText);
}

function requiredStateMember(map, key, message) {
  const value = map.get(String(key));
  if (!value) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      message,
    );
  }
  return value;
}

function canonicalCoreAttributes(profile) {
  const values = new Map();
  for (const member of profile.coreAttributes) {
    const id = String(member.standard?.attributeId ?? '');
    if (!ATTRIBUTE_ID_PATTERN.test(id)) continue;
    const members = values.get(id) ?? new Set();
    members.add(member.normalizedValue);
    values.set(id, members);
  }
  return Object.fromEntries(
    [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true }))
      .map(([id, members]) => [
        id,
        [...members].sort(),
      ]),
  );
}

function canonicalPayload(component, state, options) {
  const nodeByKey = new Map(state.nodes.map((node) => [node.nodeKey, node]));
  const representativeNode = requiredStateMember(
    nodeByKey,
    component.targetRepresentative.nodeKey,
    'The canonical representative node is missing from the recomputed plan.',
  );
  const profile = representativeNode.profile;
  const displayName = [
    profile.brand?.normalizedValue,
    profile.model?.normalizedValue,
  ].filter(Boolean).join(' ');
  if (!displayName) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      'A canonical component is missing a safe display identity.',
    );
  }
  const provenanceFingerprint = fingerprint({
    componentKey: component.componentKey,
    observationRunId: options.observationRunId,
    setMembers: component.setMembers.map((member) => ({
      isRepresentative: member.isRepresentative,
      nodeKey: member.nodeKey,
      setFingerprint: member.setFingerprint,
      setId: member.setId,
      storeCode: member.storeCode,
    })),
  });
  const payload = {
    canonicalProductKey: component.canonicalKey,
    displayName,
    brandNormalized: profile.brand?.normalizedValue ?? null,
    categoryNormalized: profile.category?.normalizedValue ?? null,
    modelNormalized: profile.model?.normalizedValue ?? null,
    barcodeNormalized: profile.barcodes[0]?.normalizedValue ?? null,
    supplierCodeNormalized: profile.supplierCode?.normalizedValue ?? null,
    coreAttributes: canonicalCoreAttributes(profile),
    status: 'ACTIVE',
    identityScope: 'GLOBAL',
    identityComponentKey: component.componentKey,
    evidencePolicyVersion: options.policyVersion,
    provenanceFingerprint,
  };
  return Object.freeze({
    ...payload,
    sourcePayloadFingerprint: fingerprint(payload),
  });
}

function assertCanonicalReadback(row, expected) {
  if (
    row.canonical_product_key !== expected.canonicalProductKey
    || row.display_name !== expected.displayName
    || row.brand_normalized !== expected.brandNormalized
    || row.category_normalized !== expected.categoryNormalized
    || row.model_normalized !== expected.modelNormalized
    || row.barcode_normalized !== expected.barcodeNormalized
    || row.supplier_code_normalized !== expected.supplierCodeNormalized
    || !exactJson(row.core_attributes, expected.coreAttributes)
    || row.source_payload_fingerprint !== expected.sourcePayloadFingerprint
    || row.status !== expected.status
    || row.identity_scope !== expected.identityScope
    || row.identity_component_key !== expected.identityComponentKey
    || row.evidence_policy_version !== expected.evidencePolicyVersion
    || row.provenance_fingerprint !== expected.provenanceFingerprint
  ) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
      'A canonical product key was reused with drifted resolution evidence.',
    );
  }
}

async function insertOrReadCanonicalProduct(client, component, state, options) {
  const expected = canonicalPayload(component, state, options);
  const values = [
    expected.canonicalProductKey,
    expected.displayName,
    expected.brandNormalized,
    expected.categoryNormalized,
    expected.modelNormalized,
    expected.barcodeNormalized,
    expected.supplierCodeNormalized,
    stableJson(expected.coreAttributes),
    expected.sourcePayloadFingerprint,
    expected.identityScope,
    expected.identityComponentKey,
    expected.evidencePolicyVersion,
    expected.provenanceFingerprint,
  ];
  const inserted = await client.query(
    `INSERT INTO dim.canonical_product (
         canonical_product_key,
         display_name,
         brand_normalized,
         category_normalized,
         model_normalized,
         barcode_normalized,
         supplier_code_normalized,
         core_attributes,
         source_payload_fingerprint,
         status,
         identity_scope,
         identity_component_key,
         evidence_policy_version,
         provenance_fingerprint
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
         'ACTIVE', $10, $11, $12, $13
     )
     ON CONFLICT (canonical_product_key) DO NOTHING
     RETURNING canonical_product_id`,
    values,
  );
  if (rowCount(inserted) === 1) {
    return Object.freeze({
      canonicalProductId: String(inserted.rows[0].canonical_product_id),
      created: true,
      expected,
    });
  }
  const existing = await client.query(
    `SELECT
         canonical_product_id,
         canonical_product_key,
         display_name,
         brand_normalized,
         category_normalized,
         model_normalized,
         barcode_normalized,
         supplier_code_normalized,
         core_attributes,
         source_payload_fingerprint,
         status,
         identity_scope,
         identity_component_key,
         evidence_policy_version,
         provenance_fingerprint
       FROM dim.canonical_product
      WHERE canonical_product_key = $1`,
    [expected.canonicalProductKey],
  );
  if (rowCount(existing) !== 1) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
      'A canonical product conflict could not be read back.',
    );
  }
  assertCanonicalReadback(existing.rows[0], expected);
  return Object.freeze({
    canonicalProductId: String(existing.rows[0].canonical_product_id),
    created: false,
    expected,
  });
}

function provenancePayload({
  canonicalProductId,
  component,
  setMember,
  evidenceSet,
  options,
}) {
  const payload = {
    canonicalProductId,
    identityScope: 'GLOBAL',
    identityComponentKey: component.componentKey,
    identityObservationSetId: evidenceSet.setId,
    storeId: evidenceSet.storeId,
    fullSkuId: evidenceSet.fullSkuId,
    sourceFetchBatchId: evidenceSet.sourceFetchBatchId,
    observationRunId: options.observationRunId,
    setStatus: 'SEALED',
    productNodeKey: setMember.nodeKey,
    isMatchRepresentative: setMember.isRepresentative,
    provenanceRole: setMember.setId === component.targetRepresentative.setId
      ? 'ANCHOR'
      : 'MEMBER',
  };
  return Object.freeze({
    ...payload,
    payloadFingerprint: fingerprint(payload),
  });
}

async function insertOrReadProvenance(client, expected) {
  const inserted = await client.query(
    `INSERT INTO ops.canonical_product_observation_set (
         canonical_product_id,
         identity_scope,
         identity_component_key,
         identity_observation_set_id,
         store_id,
         full_sku_id,
         source_fetch_batch_id,
         observation_run_id,
         set_status,
         product_node_key,
         is_match_representative,
         provenance_role,
         payload_fingerprint
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13
     )
     ON CONFLICT (
         canonical_product_id,
         identity_observation_set_id
     ) DO NOTHING
     RETURNING canonical_product_observation_set_id`,
    [
      expected.canonicalProductId,
      expected.identityScope,
      expected.identityComponentKey,
      expected.identityObservationSetId,
      expected.storeId,
      expected.fullSkuId,
      expected.sourceFetchBatchId,
      expected.observationRunId,
      expected.setStatus,
      expected.productNodeKey,
      expected.isMatchRepresentative,
      expected.provenanceRole,
      expected.payloadFingerprint,
    ],
  );
  if (rowCount(inserted) === 1) {
    return { created: true };
  }
  const existing = await client.query(
    `SELECT
         identity_scope,
         identity_component_key,
         store_id,
         full_sku_id,
         source_fetch_batch_id,
         observation_run_id,
         set_status,
         product_node_key,
         is_match_representative,
         provenance_role,
         payload_fingerprint
       FROM ops.canonical_product_observation_set
      WHERE canonical_product_id = $1
        AND identity_observation_set_id = $2`,
    [expected.canonicalProductId, expected.identityObservationSetId],
  );
  const row = existing.rows?.[0];
  if (
    rowCount(existing) !== 1
    || row.identity_scope !== expected.identityScope
    || row.identity_component_key !== expected.identityComponentKey
    || String(row.store_id) !== expected.storeId
    || String(row.full_sku_id) !== expected.fullSkuId
    || String(row.source_fetch_batch_id) !== expected.sourceFetchBatchId
    || row.observation_run_id !== expected.observationRunId
    || row.set_status !== expected.setStatus
    || row.product_node_key !== expected.productNodeKey
    || row.is_match_representative !== expected.isMatchRepresentative
    || row.provenance_role !== expected.provenanceRole
    || row.payload_fingerprint !== expected.payloadFingerprint
  ) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
      'Canonical product provenance drifted on idempotent readback.',
    );
  }
  return { created: false };
}

function relationForCandidate(component, candidate) {
  const relation = component.relations.find((member) => (
    (
      member.sourceNodeKey === candidate.nodeKey
      && member.targetNodeKey === candidate.targetNodeKey
    )
    || (
      member.sourceNodeKey === candidate.targetNodeKey
      && member.targetNodeKey === candidate.nodeKey
    )
  ));
  if (!relation) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
      'A planned SKU candidate is missing its product-node relation.',
    );
  }
  return relation;
}

function componentEvidenceFingerprint(component) {
  return fingerprint(component.relations.map((relation) => ({
    hardConflicts: relation.hardConflicts,
    matchedEvidence: relation.matchedEvidence,
    recommendation: relation.recommendation,
    score: relation.score,
    sourceRepresentativeSetId: relation.sourceRepresentativeSetId,
    strongEvidenceTypes: relation.strongEvidenceTypes,
    targetRepresentativeSetId: relation.targetRepresentativeSetId,
  })));
}

function candidatePayload({
  canonicalProductId,
  component,
  candidate,
  relation,
  sourceSet,
  targetSet,
  options,
  planHash,
}) {
  const payload = {
    storeId: sourceSet.storeId,
    fullSkuId: sourceSet.fullSkuId,
    canonicalProductId,
    canonicalVariantId: null,
    candidateKey: candidate.candidateKey,
    score: relation.score,
    recommendation: relation.recommendation,
    strongEvidenceTypes: relation.strongEvidenceTypes,
    matchedEvidence: relation.matchedEvidence,
    hardConflicts: relation.hardConflicts,
    evaluatedAt: options.now,
    identityScope: 'GLOBAL',
    identityComponentKey: component.componentKey,
    observationRunId: options.observationRunId,
    sourceIdentityObservationSetId: sourceSet.setId,
    sourceFetchBatchId: sourceSet.sourceFetchBatchId,
    sourceSetStatus: 'SEALED',
    targetIdentityObservationSetId: targetSet.setId,
    targetStoreId: targetSet.storeId,
    targetFullSkuId: targetSet.fullSkuId,
    targetSourceFetchBatchId: targetSet.sourceFetchBatchId,
    targetSetStatus: 'SEALED',
    matcherVersion: options.matcherVersion,
    evidencePolicyVersion: options.policyVersion,
    evidenceSetFingerprint: componentEvidenceFingerprint(component),
    planHash,
    componentProductNodeCount: component.nodeMembers.length,
    expectedRelationCount: component.relations.length,
  };
  return Object.freeze({
    ...payload,
    payloadFingerprint: fingerprint(payload),
  });
}

async function insertOrReadCandidate(client, expected) {
  const inserted = await client.query(
    `INSERT INTO ops.product_match_candidate (
         store_id,
         full_sku_id,
         canonical_product_id,
         canonical_variant_id,
         candidate_key,
         score,
         recommendation,
         strong_evidence_types,
         matched_evidence,
         hard_conflicts,
         payload_fingerprint,
         evaluated_at,
         identity_scope,
         identity_component_key,
         observation_run_id,
         source_identity_observation_set_id,
         source_fetch_batch_id,
         source_set_status,
         target_identity_observation_set_id,
         target_store_id,
         target_full_sku_id,
         target_source_fetch_batch_id,
         target_set_status,
         matcher_version,
         evidence_policy_version,
         evidence_set_fingerprint,
         plan_hash,
         component_product_node_count,
         expected_relation_count
     ) VALUES (
         $1, $2, $3, NULL, $4, $5, $6, $7::text[],
         $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21, $22,
         $23, $24, $25, $26, $27, $28
     )
     ON CONFLICT (store_id, candidate_key) DO NOTHING
     RETURNING product_match_candidate_id`,
    [
      expected.storeId,
      expected.fullSkuId,
      expected.canonicalProductId,
      expected.candidateKey,
      expected.score,
      expected.recommendation,
      expected.strongEvidenceTypes,
      stableJson(expected.matchedEvidence),
      stableJson(expected.hardConflicts),
      expected.payloadFingerprint,
      expected.evaluatedAt,
      expected.identityScope,
      expected.identityComponentKey,
      expected.observationRunId,
      expected.sourceIdentityObservationSetId,
      expected.sourceFetchBatchId,
      expected.sourceSetStatus,
      expected.targetIdentityObservationSetId,
      expected.targetStoreId,
      expected.targetFullSkuId,
      expected.targetSourceFetchBatchId,
      expected.targetSetStatus,
      expected.matcherVersion,
      expected.evidencePolicyVersion,
      expected.evidenceSetFingerprint,
      expected.planHash,
      expected.componentProductNodeCount,
      expected.expectedRelationCount,
    ],
  );
  if (rowCount(inserted) === 1) {
    return Object.freeze({
      candidateId: String(inserted.rows[0].product_match_candidate_id),
      created: true,
    });
  }
  const existing = await client.query(
    `SELECT
         product_match_candidate_id,
         full_sku_id,
         canonical_product_id,
         identity_scope,
         identity_component_key,
         observation_run_id,
         source_identity_observation_set_id,
         target_identity_observation_set_id,
         plan_hash,
         payload_fingerprint,
         evaluated_at
       FROM ops.product_match_candidate
      WHERE store_id = $1
        AND candidate_key = $2`,
    [expected.storeId, expected.candidateKey],
  );
  const row = existing.rows?.[0];
  if (
    rowCount(existing) !== 1
    || String(row.full_sku_id) !== expected.fullSkuId
    || String(row.canonical_product_id) !== expected.canonicalProductId
    || row.identity_scope !== expected.identityScope
    || row.identity_component_key !== expected.identityComponentKey
    || row.observation_run_id !== expected.observationRunId
    || String(row.source_identity_observation_set_id)
      !== expected.sourceIdentityObservationSetId
    || String(row.target_identity_observation_set_id)
      !== expected.targetIdentityObservationSetId
    || row.plan_hash !== expected.planHash
    || row.payload_fingerprint !== expected.payloadFingerprint
    || !exactInstant(row.evaluated_at, expected.evaluatedAt)
  ) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
      'A product match candidate drifted on idempotent readback.',
    );
  }
  return Object.freeze({
    candidateId: String(row.product_match_candidate_id),
    created: false,
  });
}

function observationBelongsToSet(evidenceSet, observationId) {
  return evidenceSet.memberIds.has(String(observationId));
}

function relationEvidenceRows({
  candidateId,
  canonicalProductId,
  component,
  relation,
  state,
  options,
  planHash,
}) {
  const originalSourceSet = requiredStateMember(
    state.evidenceState.setsById,
    relation.sourceRepresentativeSetId,
    'A relation source set is missing from sealed evidence.',
  );
  const originalTargetSet = requiredStateMember(
    state.evidenceState.setsById,
    relation.targetRepresentativeSetId,
    'A relation target set is missing from sealed evidence.',
  );
  const members = [
    ...relation.matchedEvidence.map((evidence) => ({
      evidence,
      evidenceKind: 'MATCH',
    })),
    ...relation.hardConflicts.map((evidence) => ({
      evidence,
      evidenceKind: 'HARD_CONFLICT',
    })),
  ];
  const rows = [];
  for (const { evidence, evidenceKind } of members) {
    if (
      !observationBelongsToSet(
        originalSourceSet,
        evidence.sourceObservationId,
      )
      || !observationBelongsToSet(
        originalTargetSet,
        evidence.targetObservationId,
      )
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceHierarchyMismatch,
        'Relational evidence cites an observation outside its representative set.',
      );
    }
    let sourceSet = originalSourceSet;
    let targetSet = originalTargetSet;
    let sourceObservationId = String(evidence.sourceObservationId);
    let targetObservationId = String(evidence.targetObservationId);
    if (compareDatabaseIds(sourceSet.setId, targetSet.setId) > 0) {
      [sourceSet, targetSet] = [targetSet, sourceSet];
      [sourceObservationId, targetObservationId] = [
        targetObservationId,
        sourceObservationId,
      ];
    }
    const base = {
      candidateId,
      canonicalProductId,
      identityScope: 'GLOBAL',
      identityComponentKey: component.componentKey,
      observationRunId: options.observationRunId,
      planHash,
      relationKey: fingerprint({
        componentKey: component.componentKey,
        sourceSetId: sourceSet.setId,
        targetSetId: targetSet.setId,
      }),
      relationSourceSetId: sourceSet.setId,
      relationSourceStoreId: sourceSet.storeId,
      relationSourceFullSkuId: sourceSet.fullSkuId,
      relationSourceFetchBatchId: sourceSet.sourceFetchBatchId,
      relationSourceSetStatus: 'SEALED',
      relationTargetSetId: targetSet.setId,
      relationTargetStoreId: targetSet.storeId,
      relationTargetFullSkuId: targetSet.fullSkuId,
      relationTargetFetchBatchId: targetSet.sourceFetchBatchId,
      relationTargetSetStatus: 'SEALED',
      sourceIdentifierObservationId: sourceObservationId,
      targetIdentifierObservationId: targetObservationId,
      evidenceKind,
      evidenceType: evidenceKind === 'HARD_CONFLICT'
        ? 'HARD_CONFLICT'
        : evidence.type,
      component: evidence.component,
      isStrong: evidence.isStrong,
      weight: evidence.weight,
      normalizedValueFingerprint: evidence.normalizedValueFingerprint,
    };
    if (
      !SHA256_PATTERN.test(base.normalizedValueFingerprint)
      || typeof base.component !== 'string'
      || !base.component
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.evidenceSetInvalid,
        'Relational evidence metadata is invalid.',
      );
    }
    rows.push(Object.freeze({
      ...base,
      payloadFingerprint: fingerprint(base),
    }));
  }
  return rows.sort((left, right) => (
    left.relationKey.localeCompare(right.relationKey)
    || left.sourceIdentifierObservationId.localeCompare(
      right.sourceIdentifierObservationId,
    )
    || left.targetIdentifierObservationId.localeCompare(
      right.targetIdentifierObservationId,
    )
    || left.component.localeCompare(right.component)
  ));
}

async function insertOrReadCandidateEvidence(client, expected) {
  const inserted = await client.query(
    `INSERT INTO ops.product_match_candidate_evidence (
         product_match_candidate_id,
         canonical_product_id,
         identity_scope,
         identity_component_key,
         observation_run_id,
         plan_hash,
         relation_key,
         relation_source_set_id,
         relation_source_store_id,
         relation_source_full_sku_id,
         relation_source_fetch_batch_id,
         relation_source_set_status,
         relation_target_set_id,
         relation_target_store_id,
         relation_target_full_sku_id,
         relation_target_fetch_batch_id,
         relation_target_set_status,
         source_identifier_observation_id,
         target_identifier_observation_id,
         evidence_kind,
         evidence_type,
         component,
         is_strong,
         weight,
         normalized_value_fingerprint,
         payload_fingerprint
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19,
         $20, $21, $22, $23, $24, $25, $26
     )
     ON CONFLICT (
         product_match_candidate_id,
         relation_key,
         source_identifier_observation_id,
         target_identifier_observation_id,
         component
     ) DO NOTHING
     RETURNING product_match_candidate_evidence_id`,
    [
      expected.candidateId,
      expected.canonicalProductId,
      expected.identityScope,
      expected.identityComponentKey,
      expected.observationRunId,
      expected.planHash,
      expected.relationKey,
      expected.relationSourceSetId,
      expected.relationSourceStoreId,
      expected.relationSourceFullSkuId,
      expected.relationSourceFetchBatchId,
      expected.relationSourceSetStatus,
      expected.relationTargetSetId,
      expected.relationTargetStoreId,
      expected.relationTargetFullSkuId,
      expected.relationTargetFetchBatchId,
      expected.relationTargetSetStatus,
      expected.sourceIdentifierObservationId,
      expected.targetIdentifierObservationId,
      expected.evidenceKind,
      expected.evidenceType,
      expected.component,
      expected.isStrong,
      expected.weight,
      expected.normalizedValueFingerprint,
      expected.payloadFingerprint,
    ],
  );
  if (rowCount(inserted) === 1) return { created: true };
  const existing = await client.query(
    `SELECT payload_fingerprint
       FROM ops.product_match_candidate_evidence
      WHERE product_match_candidate_id = $1
        AND relation_key = $2
        AND source_identifier_observation_id = $3
        AND target_identifier_observation_id = $4
        AND component = $5`,
    [
      expected.candidateId,
      expected.relationKey,
      expected.sourceIdentifierObservationId,
      expected.targetIdentifierObservationId,
      expected.component,
    ],
  );
  if (
    rowCount(existing) !== 1
    || existing.rows[0].payload_fingerprint !== expected.payloadFingerprint
  ) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
      'Candidate relational evidence drifted on idempotent readback.',
    );
  }
  return { created: false };
}

function decisionPayload(candidateContext, options, planHash) {
  const { expected, candidateId } = candidateContext;
  const payload = {
    storeId: expected.storeId,
    candidateId,
    decisionKey: `GLOBAL-DECISION:${fingerprint({
      candidateKey: expected.candidateKey,
      planHash,
    })}`,
    decisionOutcome: 'CONFIRMED',
    decisionSource: 'AUTO',
    actorKey: `${DEFAULT_ACTOR_PREFIX}:${options.auditRunId}`,
    rationale: 'Approved deterministic strict-global-clique resolution plan.',
    decidedAt: options.now,
    fullSkuId: expected.fullSkuId,
    canonicalProductId: expected.canonicalProductId,
    identityScope: expected.identityScope,
    identityComponentKey: expected.identityComponentKey,
    sourceIdentityObservationSetId: expected.sourceIdentityObservationSetId,
    observationRunId: options.observationRunId,
    planHash,
  };
  return Object.freeze({
    ...payload,
    payloadFingerprint: fingerprint(payload),
  });
}

async function insertOrReadDecision(client, expected) {
  const inserted = await client.query(
    `INSERT INTO ops.product_identity_decision (
         store_id,
         product_match_candidate_id,
         decision_key,
         decision_outcome,
         decision_source,
         actor_key,
         rationale,
         payload_fingerprint,
         decided_at,
         full_sku_id,
         canonical_product_id,
         identity_scope,
         identity_component_key,
         source_identity_observation_set_id,
         observation_run_id,
         plan_hash
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15, $16
     )
     ON CONFLICT (store_id, decision_key) DO NOTHING
     RETURNING product_identity_decision_id`,
    [
      expected.storeId,
      expected.candidateId,
      expected.decisionKey,
      expected.decisionOutcome,
      expected.decisionSource,
      expected.actorKey,
      expected.rationale,
      expected.payloadFingerprint,
      expected.decidedAt,
      expected.fullSkuId,
      expected.canonicalProductId,
      expected.identityScope,
      expected.identityComponentKey,
      expected.sourceIdentityObservationSetId,
      expected.observationRunId,
      expected.planHash,
    ],
  );
  if (rowCount(inserted) === 1) {
    return Object.freeze({
      decisionId: String(inserted.rows[0].product_identity_decision_id),
      created: true,
    });
  }
  const existing = await client.query(
    `SELECT
         product_identity_decision_id,
         product_match_candidate_id,
         full_sku_id,
         canonical_product_id,
         identity_scope,
         identity_component_key,
         source_identity_observation_set_id,
         observation_run_id,
         plan_hash,
         payload_fingerprint,
         actor_key,
         decided_at
       FROM ops.product_identity_decision
      WHERE store_id = $1
        AND decision_key = $2`,
    [expected.storeId, expected.decisionKey],
  );
  const row = existing.rows?.[0];
  if (
    rowCount(existing) !== 1
    || String(row.product_match_candidate_id) !== expected.candidateId
    || String(row.full_sku_id) !== expected.fullSkuId
    || String(row.canonical_product_id) !== expected.canonicalProductId
    || row.identity_scope !== expected.identityScope
    || row.identity_component_key !== expected.identityComponentKey
    || String(row.source_identity_observation_set_id)
      !== expected.sourceIdentityObservationSetId
    || row.observation_run_id !== expected.observationRunId
    || row.plan_hash !== expected.planHash
    || row.payload_fingerprint !== expected.payloadFingerprint
    || row.actor_key !== expected.actorKey
    || !exactInstant(row.decided_at, expected.decidedAt)
  ) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
      'A product identity decision drifted on idempotent readback.',
    );
  }
  return Object.freeze({
    decisionId: String(row.product_identity_decision_id),
    created: false,
  });
}

function assignmentKey(candidateContext, planHash) {
  return `GLOBAL-ASSIGNMENT:${fingerprint({
    candidateKey: candidateContext.expected.candidateKey,
    planHash,
  })}`;
}

function assertNoDifferentMappings(candidateContexts, planHash) {
  for (const context of candidateContexts) {
    const assignment = context.sourceSet.sku.assignment;
    if (!assignment) continue;
    if (
      assignment.assignmentKey !== assignmentKey(context, planHash)
      || assignment.identityScope !== 'GLOBAL'
      || assignment.identityComponentKey
        !== context.expected.identityComponentKey
      || assignment.observationRunId
        !== context.expected.observationRunId
      || assignment.planHash !== planHash
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.existingMappingConflict,
        'An affected SKU already has a different confirmed canonical mapping.',
      );
    }
  }
}

function assignmentPayload(candidateContext, decisionContext, options, planHash) {
  const { expected, candidateId } = candidateContext;
  const payload = {
    storeId: expected.storeId,
    fullSkuId: expected.fullSkuId,
    canonicalProductId: expected.canonicalProductId,
    canonicalVariantId: null,
    decisionId: decisionContext.decisionId,
    assignmentKey: assignmentKey(candidateContext, planHash),
    assignmentStatus: 'CONFIRMED',
    confidence: expected.score,
    evidence: {
      candidateKey: expected.candidateKey,
      evidenceSetFingerprint: expected.evidenceSetFingerprint,
      planHash,
      strongEvidenceTypes: expected.strongEvidenceTypes,
    },
    validFrom: options.now,
    candidateId,
    identityObservationSetId: expected.sourceIdentityObservationSetId,
    identityScope: expected.identityScope,
    identityComponentKey: expected.identityComponentKey,
    observationRunId: options.observationRunId,
    planHash,
    decisionOutcome: 'CONFIRMED',
  };
  return Object.freeze(payload);
}

async function insertOrReadAssignment(client, expected) {
  const inserted = await client.query(
    `INSERT INTO dim.full_sku_canonical_assignment (
         store_id,
         full_sku_id,
         canonical_product_id,
         canonical_variant_id,
         product_identity_decision_id,
         assignment_key,
         assignment_status,
         confidence,
         evidence,
         valid_from,
         product_match_candidate_id,
         identity_observation_set_id,
         identity_scope,
         identity_component_key,
         observation_run_id,
         plan_hash,
         decision_outcome
     ) VALUES (
         $1, $2, $3, NULL, $4, $5, $6, $7, $8::jsonb,
         $9, $10, $11, $12, $13, $14, $15, $16
     )
     ON CONFLICT (store_id, assignment_key) DO NOTHING
     RETURNING full_sku_canonical_assignment_id`,
    [
      expected.storeId,
      expected.fullSkuId,
      expected.canonicalProductId,
      expected.decisionId,
      expected.assignmentKey,
      expected.assignmentStatus,
      expected.confidence,
      stableJson(expected.evidence),
      expected.validFrom,
      expected.candidateId,
      expected.identityObservationSetId,
      expected.identityScope,
      expected.identityComponentKey,
      expected.observationRunId,
      expected.planHash,
      expected.decisionOutcome,
    ],
  );
  if (rowCount(inserted) === 1) return { created: true };
  const existing = await client.query(
    `SELECT
         full_sku_id,
         canonical_product_id,
         canonical_variant_id,
         product_identity_decision_id,
         assignment_status,
         confidence,
         evidence,
         valid_from,
         valid_to,
         product_match_candidate_id,
         identity_observation_set_id,
         identity_scope,
         identity_component_key,
         observation_run_id,
         plan_hash,
         decision_outcome
       FROM dim.full_sku_canonical_assignment
      WHERE store_id = $1
        AND assignment_key = $2`,
    [expected.storeId, expected.assignmentKey],
  );
  const row = existing.rows?.[0];
  if (
    rowCount(existing) !== 1
    || String(row.full_sku_id) !== expected.fullSkuId
    || String(row.canonical_product_id) !== expected.canonicalProductId
    || row.canonical_variant_id !== null
    || String(row.product_identity_decision_id) !== expected.decisionId
    || row.assignment_status !== expected.assignmentStatus
    || Number(row.confidence) !== Number(expected.confidence)
    || !exactJson(row.evidence, expected.evidence)
    || !exactInstant(row.valid_from, expected.validFrom)
    || row.valid_to !== null
    || String(row.product_match_candidate_id) !== expected.candidateId
    || String(row.identity_observation_set_id)
      !== expected.identityObservationSetId
    || row.identity_scope !== expected.identityScope
    || row.identity_component_key !== expected.identityComponentKey
    || row.observation_run_id !== expected.observationRunId
    || row.plan_hash !== expected.planHash
    || row.decision_outcome !== expected.decisionOutcome
  ) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
      'A canonical SKU assignment drifted on idempotent readback.',
    );
  }
  return { created: false };
}

function chunks(values, size = 1_000) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function canonicalDatabaseRow(expected) {
  return {
    canonical_product_key: expected.canonicalProductKey,
    display_name: expected.displayName,
    brand_normalized: expected.brandNormalized,
    category_normalized: expected.categoryNormalized,
    model_normalized: expected.modelNormalized,
    barcode_normalized: expected.barcodeNormalized,
    supplier_code_normalized: expected.supplierCodeNormalized,
    core_attributes: expected.coreAttributes,
    source_payload_fingerprint: expected.sourcePayloadFingerprint,
    status: expected.status,
    identity_scope: expected.identityScope,
    identity_component_key: expected.identityComponentKey,
    evidence_policy_version: expected.evidencePolicyVersion,
    provenance_fingerprint: expected.provenanceFingerprint,
  };
}

async function bulkInsertOrReadCanonicalProducts(client, entries) {
  if (entries.length === 0) {
    return { byComponentKey: new Map(), createdCount: 0 };
  }
  const byCanonicalKey = new Map(
    entries.map((entry) => [entry.expected.canonicalProductKey, entry]),
  );
  const inserted = await client.query(
    `WITH input AS (
         SELECT *
           FROM jsonb_populate_recordset(
             NULL::dim.canonical_product,
             $1::jsonb
           )
     )
     INSERT INTO dim.canonical_product (
         canonical_product_key,
         display_name,
         brand_normalized,
         category_normalized,
         model_normalized,
         barcode_normalized,
         supplier_code_normalized,
         core_attributes,
         source_payload_fingerprint,
         status,
         identity_scope,
         identity_component_key,
         evidence_policy_version,
         provenance_fingerprint
     )
     SELECT
         canonical_product_key,
         display_name,
         brand_normalized,
         category_normalized,
         model_normalized,
         barcode_normalized,
         supplier_code_normalized,
         core_attributes,
         source_payload_fingerprint,
         status,
         identity_scope,
         identity_component_key,
         evidence_policy_version,
         provenance_fingerprint
       FROM input
      ORDER BY canonical_product_key
     ON CONFLICT (canonical_product_key) DO NOTHING
     RETURNING canonical_product_key`,
    [stableJson(entries.map(({ expected }) => canonicalDatabaseRow(expected)))],
  );
  const createdKeys = new Set(
    (inserted.rows ?? []).map(({ canonical_product_key: key }) => key),
  );
  const readback = await client.query(
    `SELECT
         canonical_product_id,
         canonical_product_key,
         display_name,
         brand_normalized,
         category_normalized,
         model_normalized,
         barcode_normalized,
         supplier_code_normalized,
         core_attributes,
         source_payload_fingerprint,
         status,
         identity_scope,
         identity_component_key,
         evidence_policy_version,
         provenance_fingerprint
       FROM dim.canonical_product
      WHERE canonical_product_key = ANY($1::text[])
      ORDER BY canonical_product_key`,
    [[...byCanonicalKey.keys()].sort()],
  );
  if (rowCount(readback) !== entries.length) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
      'Canonical products could not be read back as one exact set.',
    );
  }
  const byComponentKey = new Map();
  for (const row of readback.rows ?? []) {
    const entry = byCanonicalKey.get(row.canonical_product_key);
    if (!entry) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
        'Canonical product readback returned an unexpected key.',
      );
    }
    assertCanonicalReadback(row, entry.expected);
    byComponentKey.set(entry.component.componentKey, Object.freeze({
      canonicalProductId: String(row.canonical_product_id),
      created: createdKeys.has(row.canonical_product_key),
      expected: entry.expected,
    }));
  }
  return {
    byComponentKey,
    createdCount: createdKeys.size,
  };
}

function provenanceDatabaseRow(expected) {
  return {
    canonical_product_id: expected.canonicalProductId,
    identity_scope: expected.identityScope,
    identity_component_key: expected.identityComponentKey,
    identity_observation_set_id: expected.identityObservationSetId,
    store_id: expected.storeId,
    full_sku_id: expected.fullSkuId,
    source_fetch_batch_id: expected.sourceFetchBatchId,
    observation_run_id: expected.observationRunId,
    set_status: expected.setStatus,
    product_node_key: expected.productNodeKey,
    is_match_representative: expected.isMatchRepresentative,
    provenance_role: expected.provenanceRole,
    payload_fingerprint: expected.payloadFingerprint,
  };
}

function compositeKey(...values) {
  return values.map(String).join('\u0000');
}

async function bulkInsertOrReadProvenance(client, expectedRows) {
  if (expectedRows.length === 0) return { createdCount: 0 };
  const byKey = new Map(expectedRows.map((expected) => [
    compositeKey(
      expected.canonicalProductId,
      expected.identityObservationSetId,
    ),
    expected,
  ]));
  const input = expectedRows.map(provenanceDatabaseRow);
  const inserted = await client.query(
    `WITH input AS (
         SELECT *
           FROM jsonb_populate_recordset(
             NULL::ops.canonical_product_observation_set,
             $1::jsonb
           )
     )
     INSERT INTO ops.canonical_product_observation_set (
         canonical_product_id,
         identity_scope,
         identity_component_key,
         identity_observation_set_id,
         store_id,
         full_sku_id,
         source_fetch_batch_id,
         observation_run_id,
         set_status,
         product_node_key,
         is_match_representative,
         provenance_role,
         payload_fingerprint
     )
     SELECT
         canonical_product_id,
         identity_scope,
         identity_component_key,
         identity_observation_set_id,
         store_id,
         full_sku_id,
         source_fetch_batch_id,
         observation_run_id,
         set_status,
         product_node_key,
         is_match_representative,
         provenance_role,
         payload_fingerprint
       FROM input
      ORDER BY canonical_product_id, identity_observation_set_id
     ON CONFLICT (
         canonical_product_id,
         identity_observation_set_id
     ) DO NOTHING
     RETURNING canonical_product_id, identity_observation_set_id`,
    [stableJson(input)],
  );
  const created = new Set((inserted.rows ?? []).map((row) => compositeKey(
    row.canonical_product_id,
    row.identity_observation_set_id,
  )));
  const readback = await client.query(
    `WITH input AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS value(
             canonical_product_id bigint,
             identity_observation_set_id bigint
           )
     )
     SELECT
         provenance.canonical_product_id,
         provenance.identity_observation_set_id,
         provenance.identity_scope,
         provenance.identity_component_key,
         provenance.store_id,
         provenance.full_sku_id,
         provenance.source_fetch_batch_id,
         provenance.observation_run_id,
         provenance.set_status,
         provenance.product_node_key,
         provenance.is_match_representative,
         provenance.provenance_role,
         provenance.payload_fingerprint
       FROM ops.canonical_product_observation_set AS provenance
       JOIN input
         ON input.canonical_product_id = provenance.canonical_product_id
        AND input.identity_observation_set_id =
             provenance.identity_observation_set_id
      ORDER BY
         provenance.canonical_product_id,
         provenance.identity_observation_set_id`,
    [stableJson(input.map((row) => ({
      canonical_product_id: row.canonical_product_id,
      identity_observation_set_id: row.identity_observation_set_id,
    })))],
  );
  if (rowCount(readback) !== expectedRows.length) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
      'Canonical provenance could not be read back as one exact set.',
    );
  }
  for (const row of readback.rows ?? []) {
    const expected = byKey.get(compositeKey(
      row.canonical_product_id,
      row.identity_observation_set_id,
    ));
    if (
      !expected
      || row.identity_scope !== expected.identityScope
      || row.identity_component_key !== expected.identityComponentKey
      || String(row.store_id) !== expected.storeId
      || String(row.full_sku_id) !== expected.fullSkuId
      || String(row.source_fetch_batch_id) !== expected.sourceFetchBatchId
      || row.observation_run_id !== expected.observationRunId
      || row.set_status !== expected.setStatus
      || row.product_node_key !== expected.productNodeKey
      || row.is_match_representative !== expected.isMatchRepresentative
      || row.provenance_role !== expected.provenanceRole
      || row.payload_fingerprint !== expected.payloadFingerprint
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
        'Canonical provenance drifted on bulk readback.',
      );
    }
  }
  return { createdCount: created.size };
}

function candidateDatabaseRow(expected) {
  return {
    store_id: expected.storeId,
    full_sku_id: expected.fullSkuId,
    canonical_product_id: expected.canonicalProductId,
    canonical_variant_id: null,
    candidate_key: expected.candidateKey,
    score: expected.score,
    recommendation: expected.recommendation,
    strong_evidence_types: expected.strongEvidenceTypes,
    matched_evidence: expected.matchedEvidence,
    hard_conflicts: expected.hardConflicts,
    payload_fingerprint: expected.payloadFingerprint,
    evaluated_at: expected.evaluatedAt,
    identity_scope: expected.identityScope,
    identity_component_key: expected.identityComponentKey,
    observation_run_id: expected.observationRunId,
    source_identity_observation_set_id:
      expected.sourceIdentityObservationSetId,
    source_fetch_batch_id: expected.sourceFetchBatchId,
    source_set_status: expected.sourceSetStatus,
    target_identity_observation_set_id:
      expected.targetIdentityObservationSetId,
    target_store_id: expected.targetStoreId,
    target_full_sku_id: expected.targetFullSkuId,
    target_source_fetch_batch_id: expected.targetSourceFetchBatchId,
    target_set_status: expected.targetSetStatus,
    matcher_version: expected.matcherVersion,
    evidence_policy_version: expected.evidencePolicyVersion,
    evidence_set_fingerprint: expected.evidenceSetFingerprint,
    plan_hash: expected.planHash,
    component_product_node_count: expected.componentProductNodeCount,
    expected_relation_count: expected.expectedRelationCount,
  };
}

async function bulkInsertOrReadCandidates(client, contexts) {
  if (contexts.length === 0) return { createdCount: 0 };
  const byKey = new Map(contexts.map((context) => [
    compositeKey(context.expected.storeId, context.expected.candidateKey),
    context,
  ]));
  const input = contexts.map(({ expected }) => candidateDatabaseRow(expected));
  const inserted = await client.query(
    `WITH input AS (
         SELECT *
           FROM jsonb_populate_recordset(
             NULL::ops.product_match_candidate,
             $1::jsonb
           )
     )
     INSERT INTO ops.product_match_candidate (
         store_id,
         full_sku_id,
         canonical_product_id,
         canonical_variant_id,
         candidate_key,
         score,
         recommendation,
         strong_evidence_types,
         matched_evidence,
         hard_conflicts,
         payload_fingerprint,
         evaluated_at,
         identity_scope,
         identity_component_key,
         observation_run_id,
         source_identity_observation_set_id,
         source_fetch_batch_id,
         source_set_status,
         target_identity_observation_set_id,
         target_store_id,
         target_full_sku_id,
         target_source_fetch_batch_id,
         target_set_status,
         matcher_version,
         evidence_policy_version,
         evidence_set_fingerprint,
         plan_hash,
         component_product_node_count,
         expected_relation_count
     )
     SELECT
         store_id,
         full_sku_id,
         canonical_product_id,
         canonical_variant_id,
         candidate_key,
         score,
         recommendation,
         strong_evidence_types,
         matched_evidence,
         hard_conflicts,
         payload_fingerprint,
         evaluated_at,
         identity_scope,
         identity_component_key,
         observation_run_id,
         source_identity_observation_set_id,
         source_fetch_batch_id,
         source_set_status,
         target_identity_observation_set_id,
         target_store_id,
         target_full_sku_id,
         target_source_fetch_batch_id,
         target_set_status,
         matcher_version,
         evidence_policy_version,
         evidence_set_fingerprint,
         plan_hash,
         component_product_node_count,
         expected_relation_count
       FROM input
      ORDER BY store_id, candidate_key
     ON CONFLICT (store_id, candidate_key) DO NOTHING
     RETURNING store_id, candidate_key`,
    [stableJson(input)],
  );
  const created = new Set((inserted.rows ?? []).map((row) => compositeKey(
    row.store_id,
    row.candidate_key,
  )));
  const readback = await client.query(
    `WITH input AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS value(
             store_id bigint,
             candidate_key text
           )
     )
     SELECT
         candidate.product_match_candidate_id,
         candidate.store_id,
         candidate.candidate_key,
         candidate.full_sku_id,
         candidate.canonical_product_id,
         candidate.identity_scope,
         candidate.identity_component_key,
         candidate.observation_run_id,
         candidate.source_identity_observation_set_id,
         candidate.target_identity_observation_set_id,
         candidate.plan_hash,
         candidate.payload_fingerprint,
         candidate.evaluated_at
       FROM ops.product_match_candidate AS candidate
       JOIN input
         ON input.store_id = candidate.store_id
        AND input.candidate_key = candidate.candidate_key
      ORDER BY candidate.store_id, candidate.candidate_key`,
    [stableJson(input.map((row) => ({
      store_id: row.store_id,
      candidate_key: row.candidate_key,
    })))],
  );
  if (rowCount(readback) !== contexts.length) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
      'Candidates could not be read back as one exact set.',
    );
  }
  for (const row of readback.rows ?? []) {
    const key = compositeKey(row.store_id, row.candidate_key);
    const context = byKey.get(key);
    const expected = context?.expected;
    if (
      !expected
      || String(row.full_sku_id) !== expected.fullSkuId
      || String(row.canonical_product_id) !== expected.canonicalProductId
      || row.identity_scope !== expected.identityScope
      || row.identity_component_key !== expected.identityComponentKey
      || row.observation_run_id !== expected.observationRunId
      || String(row.source_identity_observation_set_id)
        !== expected.sourceIdentityObservationSetId
      || String(row.target_identity_observation_set_id)
        !== expected.targetIdentityObservationSetId
      || row.plan_hash !== expected.planHash
      || row.payload_fingerprint !== expected.payloadFingerprint
      || !exactInstant(row.evaluated_at, expected.evaluatedAt)
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
        'A candidate drifted on bulk readback.',
      );
    }
    context.candidateId = String(row.product_match_candidate_id);
    context.created = created.has(key);
  }
  return { createdCount: created.size };
}

function candidateEvidenceDatabaseRow(expected) {
  return {
    product_match_candidate_id: expected.candidateId,
    canonical_product_id: expected.canonicalProductId,
    identity_scope: expected.identityScope,
    identity_component_key: expected.identityComponentKey,
    observation_run_id: expected.observationRunId,
    plan_hash: expected.planHash,
    relation_key: expected.relationKey,
    relation_source_set_id: expected.relationSourceSetId,
    relation_source_store_id: expected.relationSourceStoreId,
    relation_source_full_sku_id: expected.relationSourceFullSkuId,
    relation_source_fetch_batch_id: expected.relationSourceFetchBatchId,
    relation_source_set_status: expected.relationSourceSetStatus,
    relation_target_set_id: expected.relationTargetSetId,
    relation_target_store_id: expected.relationTargetStoreId,
    relation_target_full_sku_id: expected.relationTargetFullSkuId,
    relation_target_fetch_batch_id: expected.relationTargetFetchBatchId,
    relation_target_set_status: expected.relationTargetSetStatus,
    source_identifier_observation_id:
      expected.sourceIdentifierObservationId,
    target_identifier_observation_id:
      expected.targetIdentifierObservationId,
    evidence_kind: expected.evidenceKind,
    evidence_type: expected.evidenceType,
    component: expected.component,
    is_strong: expected.isStrong,
    weight: expected.weight,
    normalized_value_fingerprint: expected.normalizedValueFingerprint,
    payload_fingerprint: expected.payloadFingerprint,
  };
}

function candidateEvidenceKey(row) {
  return compositeKey(
    row.product_match_candidate_id ?? row.candidateId,
    row.relation_key ?? row.relationKey,
    row.source_identifier_observation_id
      ?? row.sourceIdentifierObservationId,
    row.target_identifier_observation_id
      ?? row.targetIdentifierObservationId,
    row.component,
  );
}

async function bulkInsertOrReadCandidateEvidence(client, expectedRows) {
  let createdCount = 0;
  for (const batch of chunks(expectedRows)) {
    const byKey = new Map(batch.map((expected) => [
      candidateEvidenceKey(expected),
      expected,
    ]));
    const input = batch.map(candidateEvidenceDatabaseRow);
    const inserted = await client.query(
      `WITH input AS (
           SELECT *
             FROM jsonb_populate_recordset(
               NULL::ops.product_match_candidate_evidence,
               $1::jsonb
             )
       )
       INSERT INTO ops.product_match_candidate_evidence (
           product_match_candidate_id,
           canonical_product_id,
           identity_scope,
           identity_component_key,
           observation_run_id,
           plan_hash,
           relation_key,
           relation_source_set_id,
           relation_source_store_id,
           relation_source_full_sku_id,
           relation_source_fetch_batch_id,
           relation_source_set_status,
           relation_target_set_id,
           relation_target_store_id,
           relation_target_full_sku_id,
           relation_target_fetch_batch_id,
           relation_target_set_status,
           source_identifier_observation_id,
           target_identifier_observation_id,
           evidence_kind,
           evidence_type,
           component,
           is_strong,
           weight,
           normalized_value_fingerprint,
           payload_fingerprint
       )
       SELECT
           product_match_candidate_id,
           canonical_product_id,
           identity_scope,
           identity_component_key,
           observation_run_id,
           plan_hash,
           relation_key,
           relation_source_set_id,
           relation_source_store_id,
           relation_source_full_sku_id,
           relation_source_fetch_batch_id,
           relation_source_set_status,
           relation_target_set_id,
           relation_target_store_id,
           relation_target_full_sku_id,
           relation_target_fetch_batch_id,
           relation_target_set_status,
           source_identifier_observation_id,
           target_identifier_observation_id,
           evidence_kind,
           evidence_type,
           component,
           is_strong,
           weight,
           normalized_value_fingerprint,
           payload_fingerprint
         FROM input
        ORDER BY
           product_match_candidate_id,
           relation_key,
           source_identifier_observation_id,
           target_identifier_observation_id,
           component
       ON CONFLICT (
           product_match_candidate_id,
           relation_key,
           source_identifier_observation_id,
           target_identifier_observation_id,
           component
       ) DO NOTHING
       RETURNING
           product_match_candidate_id,
           relation_key,
           source_identifier_observation_id,
           target_identifier_observation_id,
           component`,
      [stableJson(input)],
    );
    createdCount += rowCount(inserted);
    const readback = await client.query(
      `WITH input AS (
           SELECT *
             FROM jsonb_to_recordset($1::jsonb) AS value(
               product_match_candidate_id bigint,
               relation_key character(64),
               source_identifier_observation_id bigint,
               target_identifier_observation_id bigint,
               component text
             )
       )
       SELECT
           evidence.product_match_candidate_id,
           evidence.relation_key,
           evidence.source_identifier_observation_id,
           evidence.target_identifier_observation_id,
           evidence.component,
           evidence.payload_fingerprint
         FROM ops.product_match_candidate_evidence AS evidence
         JOIN input
           ON input.product_match_candidate_id =
                evidence.product_match_candidate_id
          AND input.relation_key = evidence.relation_key
          AND input.source_identifier_observation_id =
                evidence.source_identifier_observation_id
          AND input.target_identifier_observation_id =
                evidence.target_identifier_observation_id
          AND input.component = evidence.component`,
      [stableJson(input.map((row) => ({
        product_match_candidate_id: row.product_match_candidate_id,
        relation_key: row.relation_key,
        source_identifier_observation_id:
          row.source_identifier_observation_id,
        target_identifier_observation_id:
          row.target_identifier_observation_id,
        component: row.component,
      })))],
    );
    if (rowCount(readback) !== batch.length) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
        'Candidate evidence could not be read back as one exact batch.',
      );
    }
    for (const row of readback.rows ?? []) {
      const expected = byKey.get(candidateEvidenceKey(row));
      if (
        !expected
        || row.payload_fingerprint !== expected.payloadFingerprint
      ) {
        fail(
          PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
          'Candidate evidence drifted on bulk readback.',
        );
      }
    }
  }
  return { createdCount };
}

function decisionDatabaseRow(expected) {
  return {
    store_id: expected.storeId,
    product_match_candidate_id: expected.candidateId,
    decision_key: expected.decisionKey,
    decision_outcome: expected.decisionOutcome,
    decision_source: expected.decisionSource,
    actor_key: expected.actorKey,
    rationale: expected.rationale,
    payload_fingerprint: expected.payloadFingerprint,
    decided_at: expected.decidedAt,
    full_sku_id: expected.fullSkuId,
    canonical_product_id: expected.canonicalProductId,
    identity_scope: expected.identityScope,
    identity_component_key: expected.identityComponentKey,
    source_identity_observation_set_id:
      expected.sourceIdentityObservationSetId,
    observation_run_id: expected.observationRunId,
    plan_hash: expected.planHash,
  };
}

async function bulkInsertOrReadDecisions(client, contexts) {
  if (contexts.length === 0) return { createdCount: 0 };
  const byKey = new Map(contexts.map((context) => [
    compositeKey(context.expected.storeId, context.expected.decisionKey),
    context,
  ]));
  const input = contexts.map(({ expected }) => decisionDatabaseRow(expected));
  const inserted = await client.query(
    `WITH input AS (
         SELECT *
           FROM jsonb_populate_recordset(
             NULL::ops.product_identity_decision,
             $1::jsonb
           )
     )
     INSERT INTO ops.product_identity_decision (
         store_id,
         product_match_candidate_id,
         decision_key,
         decision_outcome,
         decision_source,
         actor_key,
         rationale,
         payload_fingerprint,
         decided_at,
         full_sku_id,
         canonical_product_id,
         identity_scope,
         identity_component_key,
         source_identity_observation_set_id,
         observation_run_id,
         plan_hash
     )
     SELECT
         store_id,
         product_match_candidate_id,
         decision_key,
         decision_outcome,
         decision_source,
         actor_key,
         rationale,
         payload_fingerprint,
         decided_at,
         full_sku_id,
         canonical_product_id,
         identity_scope,
         identity_component_key,
         source_identity_observation_set_id,
         observation_run_id,
         plan_hash
       FROM input
      ORDER BY store_id, decision_key
     ON CONFLICT (store_id, decision_key) DO NOTHING
     RETURNING store_id, decision_key`,
    [stableJson(input)],
  );
  const created = new Set((inserted.rows ?? []).map((row) => compositeKey(
    row.store_id,
    row.decision_key,
  )));
  const readback = await client.query(
    `WITH input AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS value(
             store_id bigint,
             decision_key text
           )
     )
     SELECT
         decision.product_identity_decision_id,
         decision.store_id,
         decision.decision_key,
         decision.product_match_candidate_id,
         decision.full_sku_id,
         decision.canonical_product_id,
         decision.identity_scope,
         decision.identity_component_key,
         decision.source_identity_observation_set_id,
         decision.observation_run_id,
         decision.plan_hash,
         decision.payload_fingerprint,
         decision.actor_key,
         decision.decided_at
       FROM ops.product_identity_decision AS decision
       JOIN input
         ON input.store_id = decision.store_id
        AND input.decision_key = decision.decision_key`,
    [stableJson(input.map((row) => ({
      store_id: row.store_id,
      decision_key: row.decision_key,
    })))],
  );
  if (rowCount(readback) !== contexts.length) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
      'Decisions could not be read back as one exact set.',
    );
  }
  for (const row of readback.rows ?? []) {
    const key = compositeKey(row.store_id, row.decision_key);
    const context = byKey.get(key);
    const expected = context?.expected;
    if (
      !expected
      || String(row.product_match_candidate_id) !== expected.candidateId
      || String(row.full_sku_id) !== expected.fullSkuId
      || String(row.canonical_product_id) !== expected.canonicalProductId
      || row.identity_scope !== expected.identityScope
      || row.identity_component_key !== expected.identityComponentKey
      || String(row.source_identity_observation_set_id)
        !== expected.sourceIdentityObservationSetId
      || row.observation_run_id !== expected.observationRunId
      || row.plan_hash !== expected.planHash
      || row.payload_fingerprint !== expected.payloadFingerprint
      || row.actor_key !== expected.actorKey
      || !exactInstant(row.decided_at, expected.decidedAt)
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
        'A decision drifted on bulk readback.',
      );
    }
    context.decisionId = String(row.product_identity_decision_id);
    context.created = created.has(key);
  }
  return { createdCount: created.size };
}

function assignmentDatabaseRow(expected) {
  return {
    store_id: expected.storeId,
    full_sku_id: expected.fullSkuId,
    canonical_product_id: expected.canonicalProductId,
    canonical_variant_id: null,
    product_identity_decision_id: expected.decisionId,
    assignment_key: expected.assignmentKey,
    assignment_status: expected.assignmentStatus,
    confidence: expected.confidence,
    evidence: expected.evidence,
    valid_from: expected.validFrom,
    valid_to: null,
    product_match_candidate_id: expected.candidateId,
    identity_observation_set_id: expected.identityObservationSetId,
    identity_scope: expected.identityScope,
    identity_component_key: expected.identityComponentKey,
    observation_run_id: expected.observationRunId,
    plan_hash: expected.planHash,
    decision_outcome: expected.decisionOutcome,
  };
}

async function bulkInsertOrReadAssignments(client, expectedRows) {
  if (expectedRows.length === 0) return { createdCount: 0 };
  const byKey = new Map(expectedRows.map((expected) => [
    compositeKey(expected.storeId, expected.assignmentKey),
    expected,
  ]));
  const input = expectedRows.map(assignmentDatabaseRow);
  const inserted = await client.query(
    `WITH input AS (
         SELECT *
           FROM jsonb_populate_recordset(
             NULL::dim.full_sku_canonical_assignment,
             $1::jsonb
           )
     )
     INSERT INTO dim.full_sku_canonical_assignment (
         store_id,
         full_sku_id,
         canonical_product_id,
         canonical_variant_id,
         product_identity_decision_id,
         assignment_key,
         assignment_status,
         confidence,
         evidence,
         valid_from,
         valid_to,
         product_match_candidate_id,
         identity_observation_set_id,
         identity_scope,
         identity_component_key,
         observation_run_id,
         plan_hash,
         decision_outcome
     )
     SELECT
         store_id,
         full_sku_id,
         canonical_product_id,
         canonical_variant_id,
         product_identity_decision_id,
         assignment_key,
         assignment_status,
         confidence,
         evidence,
         valid_from,
         valid_to,
         product_match_candidate_id,
         identity_observation_set_id,
         identity_scope,
         identity_component_key,
         observation_run_id,
         plan_hash,
         decision_outcome
       FROM input
      ORDER BY store_id, assignment_key
     ON CONFLICT (store_id, assignment_key) DO NOTHING
     RETURNING store_id, assignment_key`,
    [stableJson(input)],
  );
  const created = new Set((inserted.rows ?? []).map((row) => compositeKey(
    row.store_id,
    row.assignment_key,
  )));
  const readback = await client.query(
    `WITH input AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS value(
             store_id bigint,
             assignment_key text
           )
     )
     SELECT
         assignment.store_id,
         assignment.assignment_key,
         assignment.full_sku_id,
         assignment.canonical_product_id,
         assignment.canonical_variant_id,
         assignment.product_identity_decision_id,
         assignment.assignment_status,
         assignment.confidence,
         assignment.evidence,
         assignment.valid_from,
         assignment.valid_to,
         assignment.product_match_candidate_id,
         assignment.identity_observation_set_id,
         assignment.identity_scope,
         assignment.identity_component_key,
         assignment.observation_run_id,
         assignment.plan_hash,
         assignment.decision_outcome
       FROM dim.full_sku_canonical_assignment AS assignment
       JOIN input
         ON input.store_id = assignment.store_id
        AND input.assignment_key = assignment.assignment_key`,
    [stableJson(input.map((row) => ({
      store_id: row.store_id,
      assignment_key: row.assignment_key,
    })))],
  );
  if (rowCount(readback) !== expectedRows.length) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
      'Assignments could not be read back as one exact set.',
    );
  }
  for (const row of readback.rows ?? []) {
    const expected = byKey.get(compositeKey(
      row.store_id,
      row.assignment_key,
    ));
    if (
      !expected
      || String(row.full_sku_id) !== expected.fullSkuId
      || String(row.canonical_product_id) !== expected.canonicalProductId
      || row.canonical_variant_id !== null
      || String(row.product_identity_decision_id) !== expected.decisionId
      || row.assignment_status !== expected.assignmentStatus
      || Number(row.confidence) !== Number(expected.confidence)
      || !exactJson(row.evidence, expected.evidence)
      || !exactInstant(row.valid_from, expected.validFrom)
      || row.valid_to !== null
      || String(row.product_match_candidate_id) !== expected.candidateId
      || String(row.identity_observation_set_id)
        !== expected.identityObservationSetId
      || row.identity_scope !== expected.identityScope
      || row.identity_component_key !== expected.identityComponentKey
      || row.observation_run_id !== expected.observationRunId
      || row.plan_hash !== expected.planHash
      || row.decision_outcome !== expected.decisionOutcome
    ) {
      fail(
        PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
        'An assignment drifted on bulk readback.',
      );
    }
  }
  return { createdCount: created.size };
}

function affectedFullSkuIds(plan, evidenceState) {
  const values = new Set();
  for (const component of plan.components) {
    for (const candidate of component.skuCandidates) {
      const sourceSet = requiredStateMember(
        evidenceState.setsById,
        candidate.sourceSetId,
        'A planned source set is missing from sealed evidence.',
      );
      values.add(sourceSet.fullSkuId);
    }
  }
  return [...values].sort(compareDatabaseIds);
}

async function lockAffectedSkus(client, fullSkuIds) {
  if (fullSkuIds.length === 0) return;
  const result = await client.query(
    `SELECT full_sku_id
       FROM dim.full_sku
      WHERE full_sku_id = ANY($1::bigint[])
      ORDER BY full_sku_id
      FOR UPDATE`,
    [fullSkuIds],
  );
  const locked = (result.rows ?? [])
    .map(({ full_sku_id: value }) => String(value))
    .sort(compareDatabaseIds);
  if (
    locked.length !== fullSkuIds.length
    || locked.some((value, index) => value !== fullSkuIds[index])
  ) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.skuLockMismatch,
      'The affected SKU lock set changed before apply.',
    );
  }
}

function ensureApprovedPlan(plan, approvedHash) {
  if (plan.planHash !== approvedHash) {
    fail(
      PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.planHashMismatch,
      'The approved plan hash no longer matches current sealed evidence.',
    );
  }
}

async function persistPlan(client, state, options) {
  const counters = {
    canonicalProductCount: state.plan.components.length,
    provenanceCount: state.plan.components.reduce(
      (total, component) => total + component.setMembers.length,
      0,
    ),
    candidateCount: state.plan.components.reduce(
      (total, component) => total + component.skuCandidates.length,
      0,
    ),
    candidateEvidenceCount: 0,
    decisionCount: 0,
    assignmentCount: 0,
    createdCanonicalProductCount: 0,
    createdProvenanceCount: 0,
    createdCandidateCount: 0,
    createdCandidateEvidenceCount: 0,
    createdDecisionCount: 0,
    createdAssignmentCount: 0,
  };
  const canonicalEntries = state.plan.components.map((component) => ({
    component,
    expected: canonicalPayload(component, state, options),
  }));
  const canonicalResult = await bulkInsertOrReadCanonicalProducts(
    client,
    canonicalEntries,
  );
  const canonicalByComponent = canonicalResult.byComponentKey;
  counters.createdCanonicalProductCount = canonicalResult.createdCount;

  const provenanceRows = [];
  for (const component of state.plan.components) {
    const canonical = canonicalByComponent.get(component.componentKey);
    for (const setMember of component.setMembers) {
      const evidenceSet = requiredStateMember(
        state.evidenceState.setsById,
        setMember.setId,
        'Canonical provenance references a missing sealed evidence set.',
      );
      provenanceRows.push(provenancePayload({
        canonicalProductId: canonical.canonicalProductId,
        component,
        setMember,
        evidenceSet,
        options,
      }));
    }
  }
  const provenanceResult = await bulkInsertOrReadProvenance(
    client,
    provenanceRows,
  );
  counters.createdProvenanceCount = provenanceResult.createdCount;

  const candidateContexts = [];
  for (const component of state.plan.components) {
    const canonical = canonicalByComponent.get(component.componentKey);
    for (const candidate of component.skuCandidates) {
      const sourceSet = requiredStateMember(
        state.evidenceState.setsById,
        candidate.sourceSetId,
        'A planned candidate source set is missing.',
      );
      const targetSet = requiredStateMember(
        state.evidenceState.setsById,
        candidate.targetRepresentativeSetId,
        'A planned candidate target set is missing.',
      );
      const relation = relationForCandidate(component, candidate);
      const expected = candidatePayload({
        canonicalProductId: canonical.canonicalProductId,
        component,
        candidate,
        relation,
        sourceSet,
        targetSet,
        options,
        planHash: state.plan.planHash,
      });
      candidateContexts.push({
        candidate,
        candidateId: null,
        component,
        expected,
        relation,
        sourceSet,
        targetSet,
      });
    }
  }
  const candidateResult = await bulkInsertOrReadCandidates(
    client,
    candidateContexts,
  );
  counters.createdCandidateCount = candidateResult.createdCount;
  assertNoDifferentMappings(candidateContexts, state.plan.planHash);

  for (const contextBatch of chunks(candidateContexts, 100)) {
    const expectedEvidenceRows = contextBatch.flatMap((context) => (
      context.component.relations.flatMap((relation) => (
        relationEvidenceRows({
          candidateId: context.candidateId,
          canonicalProductId: context.expected.canonicalProductId,
          component: context.component,
          relation,
          state,
          options,
          planHash: state.plan.planHash,
        })
      ))
    ));
    const evidenceResult = await bulkInsertOrReadCandidateEvidence(
      client,
      expectedEvidenceRows,
    );
    counters.candidateEvidenceCount += expectedEvidenceRows.length;
    counters.createdCandidateEvidenceCount += evidenceResult.createdCount;
  }

  const decisionContexts = candidateContexts.map((context) => ({
    candidateContext: context,
    decisionId: null,
    expected: decisionPayload(context, options, state.plan.planHash),
  }));
  const decisionResult = await bulkInsertOrReadDecisions(
    client,
    decisionContexts,
  );
  counters.decisionCount = decisionContexts.length;
  counters.createdDecisionCount = decisionResult.createdCount;

  const assignmentRows = decisionContexts.map((decisionContext) => (
    assignmentPayload(
      decisionContext.candidateContext,
      decisionContext,
      options,
      state.plan.planHash,
    )
  ));
  const assignmentResult = await bulkInsertOrReadAssignments(
    client,
    assignmentRows,
  );
  counters.assignmentCount = assignmentRows.length;
  counters.createdAssignmentCount = assignmentResult.createdCount;
  return counters;
}

function postCommitVerification(state, counters, options) {
  const assignments = [];
  for (const component of state.plan.components) {
    for (const candidate of component.skuCandidates) {
      const sourceSet = requiredStateMember(
        state.evidenceState.setsById,
        candidate.sourceSetId,
        'A committed candidate source set is missing.',
      );
      assignments.push(Object.freeze({
        storeId: sourceSet.storeId,
        fullSkuId: sourceSet.fullSkuId,
        identityComponentKey: component.componentKey,
        assignmentKey: `GLOBAL-ASSIGNMENT:${fingerprint({
          candidateKey: candidate.candidateKey,
          planHash: state.plan.planHash,
        })}`,
      }));
    }
  }
  assignments.sort((left, right) => (
    compareDatabaseIds(left.fullSkuId, right.fullSkuId)
  ));
  return Object.freeze({
    observationRunId: options.observationRunId,
    planHash: state.plan.planHash,
    componentKeys: Object.freeze(
      state.plan.components.map(({ componentKey }) => componentKey).sort(),
    ),
    counters: Object.freeze({ ...counters }),
    assignments: Object.freeze(assignments),
  });
}

async function verifyPostCommitReadback(pool, verification) {
  return inTransaction(
    pool,
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    async (client) => {
      const countsResult = await client.query(
        `SELECT
           (
             SELECT count(*)
               FROM dim.canonical_product
              WHERE identity_scope = 'GLOBAL'
                AND identity_component_key::text = ANY($2::text[])
           ) AS canonical_product_count,
           (
             SELECT count(*)
               FROM ops.canonical_product_observation_set AS provenance
               JOIN dim.canonical_product AS product
                 ON product.canonical_product_id =
                      provenance.canonical_product_id
              WHERE provenance.observation_run_id = $1
                AND product.identity_component_key::text =
                      ANY($2::text[])
           ) AS provenance_count,
           (
             SELECT count(*)
               FROM ops.product_match_candidate
              WHERE plan_hash = $3
           ) AS candidate_count,
           (
             SELECT count(*)
               FROM ops.product_match_candidate_evidence
              WHERE plan_hash = $3
           ) AS candidate_evidence_count,
           (
             SELECT count(*)
               FROM ops.product_identity_decision
              WHERE plan_hash = $3
           ) AS decision_count,
           (
             SELECT count(*)
               FROM dim.full_sku_canonical_assignment
              WHERE plan_hash = $3
           ) AS assignment_count`,
        [
          verification.observationRunId,
          verification.componentKeys,
          verification.planHash,
        ],
      );
      const counts = countsResult.rows?.[0];
      if (
        rowCount(countsResult) !== 1
        || Number(counts.canonical_product_count)
          !== verification.counters.canonicalProductCount
        || Number(counts.provenance_count)
          !== verification.counters.provenanceCount
        || Number(counts.candidate_count)
          !== verification.counters.candidateCount
        || Number(counts.candidate_evidence_count)
          !== verification.counters.candidateEvidenceCount
        || Number(counts.decision_count)
          !== verification.counters.decisionCount
        || Number(counts.assignment_count)
          !== verification.counters.assignmentCount
      ) {
        fail(
          PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
          'Committed resolution table counts failed post-commit readback.',
        );
      }
      if (verification.assignments.length === 0) return;
      const assignmentsResult = await client.query(
        `SELECT
           store_id,
           full_sku_id,
           assignment_key,
           assignment_status,
           identity_scope,
           identity_component_key,
           observation_run_id,
           plan_hash,
           valid_to
         FROM dim.full_sku_canonical_assignment
        WHERE full_sku_id = ANY($1::bigint[])
          AND assignment_status = 'CONFIRMED'
          AND valid_to IS NULL
        ORDER BY full_sku_id`,
        [verification.assignments.map(({ fullSkuId }) => fullSkuId)],
      );
      if (rowCount(assignmentsResult) !== verification.assignments.length) {
        fail(
          PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
          'Current assignments failed post-commit cardinality readback.',
        );
      }
      const expectedBySku = new Map(
        verification.assignments.map((assignment) => [
          assignment.fullSkuId,
          assignment,
        ]),
      );
      for (const row of assignmentsResult.rows ?? []) {
        const expected = expectedBySku.get(String(row.full_sku_id));
        if (
          !expected
          || String(row.store_id) !== expected.storeId
          || row.assignment_key !== expected.assignmentKey
          || row.assignment_status !== 'CONFIRMED'
          || row.identity_scope !== 'GLOBAL'
          || row.identity_component_key !== expected.identityComponentKey
          || row.observation_run_id !== verification.observationRunId
          || row.plan_hash !== verification.planHash
          || row.valid_to !== null
        ) {
          fail(
            PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.idempotencyDrift,
            'A current assignment failed exact post-commit readback.',
          );
        }
      }
    },
  );
}

export async function applyProductIdentityResolutionPlan(pool, input = {}) {
  const options = normalizedOptions(input);
  const approvedHash = safeFingerprint(input.approvedHash, 'approvedHash');
  const committed = await inTransaction(
    pool,
    'BEGIN ISOLATION LEVEL SERIALIZABLE',
    async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('full-managed-product-identity-resolution'))",
      );
      const draft = await computeResolutionState(client, options, {
        ignoredPlanHash: approvedHash,
      });
      ensureApprovedPlan(draft.plan, approvedHash);
      const draftAffectedSkuIds = affectedFullSkuIds(
        draft.plan,
        draft.evidenceState,
      );
      await lockAffectedSkus(client, draftAffectedSkuIds);
      const state = await computeResolutionState(client, options, {
        ignoredPlanHash: approvedHash,
      });
      ensureApprovedPlan(state.plan, approvedHash);
      const lockedAffectedSkuIds = affectedFullSkuIds(
        state.plan,
        state.evidenceState,
      );
      if (
        stableJson(lockedAffectedSkuIds) !== stableJson(draftAffectedSkuIds)
      ) {
        fail(
          PRODUCT_IDENTITY_RESOLUTION_ERROR_CODES.skuLockMismatch,
          'The affected SKU set changed while the plan was locked.',
        );
      }
      const counters = await persistPlan(client, state, options);
      return Object.freeze({
        result: Object.freeze({
          observationRunId: options.observationRunId,
          auditRunId: options.auditRunId,
          preparedAt: options.now,
          appliedAt: options.now,
          planHash: state.plan.planHash,
          applied: true,
          summary: Object.freeze({
            ...state.plan.summary,
            ...counters,
          }),
        }),
        verification: postCommitVerification(state, counters, options),
      });
    },
  );
  await verifyPostCommitReadback(pool, committed.verification);
  return committed.result;
}
