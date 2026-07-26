import { createHash } from 'node:crypto';

import {
  evaluateProductIdentityMatch,
  normalizeIdentifierValue,
  normalizeProductIdentityProfile,
} from '../domain/product-identity.mjs';

const STORE_CODE_PATTERN = /^[A-Z0-9_-]+$/;
const DECISION_OUTCOMES = new Set(['CONFIRMED', 'REJECTED', 'DEFERRED', 'UNASSIGNED']);
const DECISION_SOURCES = new Set(['AUTO', 'HUMAN', 'SYSTEM']);

function requiredText(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function storeCode(value) {
  const result = requiredText(value, 'storeCode').toUpperCase();
  if (!STORE_CODE_PATTERN.test(result)) throw new TypeError('storeCode is invalid.');
  return result;
}

function instant(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid timestamp.`);
  return date.toISOString();
}

function jsonObject(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function canonicalize(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function stableIdentityJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function identityFingerprint(value) {
  return createHash('sha256').update(stableIdentityJson(value), 'utf8').digest('hex');
}

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original domain/database error.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function requireStoreSku(client, code, platformSkuId) {
  const result = await client.query(
    `SELECT s.store_id, sku.full_sku_id
       FROM dim.store AS s
       JOIN dim.full_sku AS sku
         ON sku.store_id = s.store_id
      WHERE s.store_code = $1
        AND sku.platform_sku_id = $2
        AND s.is_active = true
      FOR SHARE OF s, sku`,
    [code, platformSkuId],
  );
  if (result.rowCount !== 1) {
    throw new Error(`SKU ${platformSkuId} was not found in active store ${code}.`);
  }
  return result.rows[0];
}

async function requireCanonicalProduct(client, canonicalProductKey) {
  const result = await client.query(
    `SELECT canonical_product_id, source_payload_fingerprint
       FROM dim.canonical_product
      WHERE canonical_product_key = $1
      FOR SHARE`,
    [canonicalProductKey],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Global canonical product ${canonicalProductKey} was not found.`);
  }
  return result.rows[0];
}

async function optionalCanonicalVariant(
  client,
  canonicalProductId,
  canonicalVariantKey,
) {
  if (!canonicalVariantKey) return null;
  const result = await client.query(
    `SELECT canonical_variant_id, canonical_product_id, source_payload_fingerprint
       FROM dim.canonical_variant
      WHERE canonical_product_id = $1
        AND canonical_variant_key = $2
      FOR SHARE`,
    [canonicalProductId, canonicalVariantKey],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Canonical variant ${canonicalVariantKey} was not found under the product.`);
  }
  return result.rows[0];
}

function assertFingerprint(existing, expected, label) {
  if (existing !== expected) {
    throw new Error(`${label} idempotency key was retried with drifted payload.`);
  }
}

export async function createCanonicalProduct(pool, input) {
  const canonicalProductKey = requiredText(input?.canonicalProductKey, 'canonicalProductKey');
  const displayName = requiredText(input?.displayName, 'displayName');
  const normalized = normalizeProductIdentityProfile(input?.profile);
  const source = {
    canonicalProductKey,
    displayName,
    brand: normalized.brand,
    category: normalized.category,
    model: normalized.model,
    barcode: normalized.barcode,
    supplierCode: normalized.supplierCode,
    coreAttributes: normalized.coreAttributes,
  };
  const fingerprint = identityFingerprint(source);

  return inTransaction(pool, async (client) => {
    const inserted = await client.query(
       `INSERT INTO dim.canonical_product (
           canonical_product_key, display_name,
           brand_normalized, category_normalized, model_normalized,
           barcode_normalized, supplier_code_normalized, core_attributes,
           source_payload_fingerprint
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       ON CONFLICT (canonical_product_key) DO NOTHING
       RETURNING canonical_product_id, source_payload_fingerprint`,
      [
        canonicalProductKey,
        displayName,
        normalized.brand,
        normalized.category,
        normalized.model,
        normalized.barcode,
        normalized.supplierCode,
        JSON.stringify(normalized.coreAttributes),
        fingerprint,
      ],
    );
    if (inserted.rowCount === 1) {
      return {
        canonicalProductId: inserted.rows[0].canonical_product_id,
        created: true,
      };
    }

    const existing = await requireCanonicalProduct(client, canonicalProductKey);
    assertFingerprint(existing.source_payload_fingerprint, fingerprint, 'Canonical product');
    return {
      canonicalProductId: existing.canonical_product_id,
      created: false,
    };
  });
}

export async function createCanonicalVariant(pool, input) {
  const canonicalProductKey = requiredText(input?.canonicalProductKey, 'canonicalProductKey');
  const canonicalVariantKey = requiredText(input?.canonicalVariantKey, 'canonicalVariantKey');
  const displayName = requiredText(input?.displayName, 'displayName');
  const normalized = normalizeProductIdentityProfile(input?.profile);
  const variantAttributes = jsonObject(input?.variantAttributes, 'variantAttributes');
  const source = {
    canonicalProductKey,
    canonicalVariantKey,
    displayName,
    variantAttributes,
    voltage: normalized.voltage,
    plug: normalized.plug,
    capacity: normalized.capacity,
    dimensions: normalized.dimensions,
  };
  const fingerprint = identityFingerprint(source);

  return inTransaction(pool, async (client) => {
    const product = await requireCanonicalProduct(client, canonicalProductKey);
    const inserted = await client.query(
      `INSERT INTO dim.canonical_variant (
           canonical_product_id, canonical_variant_key, display_name,
           variant_attributes, voltage_normalized, plug_normalized,
           capacity_normalized, dimensions_normalized, source_payload_fingerprint
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
       ON CONFLICT (canonical_product_id, canonical_variant_key) DO NOTHING
       RETURNING canonical_variant_id, source_payload_fingerprint`,
      [
        product.canonical_product_id,
        canonicalVariantKey,
        displayName,
        JSON.stringify(variantAttributes),
        normalized.voltage,
        normalized.plug,
        normalized.capacity,
        normalized.dimensions,
        fingerprint,
      ],
    );
    if (inserted.rowCount === 1) {
      return {
        canonicalVariantId: inserted.rows[0].canonical_variant_id,
        created: true,
      };
    }

    const existing = await optionalCanonicalVariant(
      client,
      product.canonical_product_id,
      canonicalVariantKey,
    );
    assertFingerprint(existing.source_payload_fingerprint, fingerprint, 'Canonical variant');
    return {
      canonicalVariantId: existing.canonical_variant_id,
      created: false,
    };
  });
}

function normalizeObservation(value) {
  const observationKey = requiredText(value?.observationKey, 'observationKey');
  const identifierType = requiredText(value?.identifierType, 'identifierType').toUpperCase();
  const rawValue = value?.rawValue;
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    throw new TypeError('rawValue must be a non-empty source string.');
  }
  const sourceSystem = requiredText(value?.sourceSystem, 'sourceSystem');
  const sourceField = requiredText(value?.sourceField, 'sourceField');
  const observedAt = instant(value?.observedAt, 'observedAt');
  const evidence = jsonObject(value?.evidence, 'evidence');
  const normalizedValue = normalizeIdentifierValue(identifierType, rawValue);
  const sourceFetchBatchId = value?.sourceFetchBatchId ?? null;
  if (
    sourceFetchBatchId !== null &&
    (!Number.isSafeInteger(sourceFetchBatchId) || sourceFetchBatchId <= 0)
  ) {
    throw new TypeError('sourceFetchBatchId must be a positive integer when supplied.');
  }
  const fingerprint = identityFingerprint({
    observationKey,
    identifierType,
    rawValue,
    normalizedValue,
    sourceSystem,
    sourceField,
    sourceFetchBatchId,
    evidence,
    observedAt,
  });
  return {
    observationKey,
    identifierType,
    rawValue,
    normalizedValue,
    sourceSystem,
    sourceField,
    sourceFetchBatchId,
    evidence,
    observedAt,
    fingerprint,
  };
}

export async function recordIdentifierObservations(pool, input) {
  const code = storeCode(input?.storeCode);
  const platformSkuId = requiredText(input?.platformSkuId, 'platformSkuId');
  if (!Array.isArray(input?.observations) || input.observations.length === 0) {
    throw new TypeError('observations must be a non-empty array.');
  }
  const observations = input.observations.map(normalizeObservation);
  const keys = new Set();
  for (const observation of observations) {
    if (keys.has(observation.observationKey)) {
      throw new TypeError(`Duplicate observationKey ${observation.observationKey}.`);
    }
    keys.add(observation.observationKey);
  }

  return inTransaction(pool, async (client) => {
    const sku = await requireStoreSku(client, code, platformSkuId);
    let created = 0;
    for (const observation of observations) {
      const inserted = await client.query(
        `INSERT INTO raw.identifier_observation (
             store_id, full_sku_id, observation_key, identifier_type,
             raw_value, normalized_value, source_system, source_field,
             source_fetch_batch_id, payload_fingerprint, evidence, observed_at
         ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12
         )
         ON CONFLICT (store_id, observation_key) DO NOTHING
         RETURNING identifier_observation_id, payload_fingerprint`,
        [
          sku.store_id,
          sku.full_sku_id,
          observation.observationKey,
          observation.identifierType,
          observation.rawValue,
          observation.normalizedValue,
          observation.sourceSystem,
          observation.sourceField,
          observation.sourceFetchBatchId,
          observation.fingerprint,
          JSON.stringify(observation.evidence),
          observation.observedAt,
        ],
      );
      if (inserted.rowCount === 1) {
        created += 1;
        continue;
      }
      const existing = await client.query(
        `SELECT payload_fingerprint
           FROM raw.identifier_observation
          WHERE store_id = $1
            AND observation_key = $2`,
        [sku.store_id, observation.observationKey],
      );
      if (existing.rowCount !== 1) {
        throw new Error('Identifier observation conflict could not be read back.');
      }
      assertFingerprint(
        existing.rows[0].payload_fingerprint,
        observation.fingerprint,
        'Identifier observation',
      );
    }
    return {
      storeCode: code,
      platformSkuId,
      observationCount: observations.length,
      createdCount: created,
    };
  });
}

export async function recordProductMatchCandidate(pool, input) {
  const code = storeCode(input?.storeCode);
  const platformSkuId = requiredText(input?.platformSkuId, 'platformSkuId');
  const canonicalProductKey = requiredText(input?.canonicalProductKey, 'canonicalProductKey');
  const canonicalVariantKey = input?.canonicalVariantKey
    ? requiredText(input.canonicalVariantKey, 'canonicalVariantKey')
    : null;
  const candidateKey = requiredText(input?.candidateKey, 'candidateKey');
  const evaluatedAt = instant(input?.evaluatedAt, 'evaluatedAt');
  const evaluation = evaluateProductIdentityMatch(input?.sourceProfile, input?.targetProfile);

  return inTransaction(pool, async (client) => {
    const sku = await requireStoreSku(client, code, platformSkuId);
    const product = await requireCanonicalProduct(client, canonicalProductKey);
    const variant = await optionalCanonicalVariant(
      client,
      product.canonical_product_id,
      canonicalVariantKey,
    );
    const fingerprint = identityFingerprint({
      candidateKey,
      storeCode: code,
      platformSkuId,
      canonicalProductKey,
      canonicalVariantKey,
      evaluation,
      evaluatedAt,
    });
    const inserted = await client.query(
      `INSERT INTO ops.product_match_candidate (
           store_id, full_sku_id, canonical_product_id, canonical_variant_id,
           candidate_key, score, recommendation, strong_evidence_types,
           matched_evidence, hard_conflicts, payload_fingerprint, evaluated_at
       ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::text[],
           $9::jsonb, $10::jsonb, $11, $12
       )
       ON CONFLICT (store_id, candidate_key) DO NOTHING
       RETURNING product_match_candidate_id, payload_fingerprint`,
      [
        sku.store_id,
        sku.full_sku_id,
        product.canonical_product_id,
        variant?.canonical_variant_id ?? null,
        candidateKey,
        evaluation.score,
        evaluation.recommendation,
        evaluation.strongEvidenceTypes,
        JSON.stringify(evaluation.matchedEvidence),
        JSON.stringify(evaluation.hardConflicts),
        fingerprint,
        evaluatedAt,
      ],
    );

    let candidateId;
    let created = false;
    if (inserted.rowCount === 1) {
      candidateId = inserted.rows[0].product_match_candidate_id;
      created = true;
    } else {
      const existing = await client.query(
        `SELECT product_match_candidate_id, payload_fingerprint
           FROM ops.product_match_candidate
          WHERE store_id = $1
            AND candidate_key = $2`,
        [sku.store_id, candidateKey],
      );
      if (existing.rowCount !== 1) {
        throw new Error('Product match candidate conflict could not be read back.');
      }
      assertFingerprint(
        existing.rows[0].payload_fingerprint,
        fingerprint,
        'Product match candidate',
      );
      candidateId = existing.rows[0].product_match_candidate_id;
    }
    return {
      storeCode: code,
      productMatchCandidateId: candidateId,
      created,
      evaluation,
    };
  });
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function assertConfirmationAllowed(candidate, decisionSource) {
  const conflicts = parseJsonArray(candidate.hard_conflicts);
  if (conflicts.length > 0 || candidate.recommendation === 'BLOCKED') {
    throw new Error('Hard product identity conflicts cannot be overridden.');
  }
  if (decisionSource !== 'AUTO') return;
  const strongEvidence = Array.isArray(candidate.strong_evidence_types)
    ? candidate.strong_evidence_types
    : [];
  if (
    candidate.recommendation !== 'CONFIRMED' ||
    Number(candidate.score) < 0.95 ||
    strongEvidence.length < 2
  ) {
    throw new Error('Automatic confirmation gate was not satisfied.');
  }
}

export async function recordProductIdentityDecision(pool, input) {
  const code = storeCode(input?.storeCode);
  const candidateKey = requiredText(input?.candidateKey, 'candidateKey');
  const decisionKey = requiredText(input?.decisionKey, 'decisionKey');
  const decisionOutcome = requiredText(input?.decisionOutcome, 'decisionOutcome').toUpperCase();
  const decisionSource = requiredText(input?.decisionSource, 'decisionSource').toUpperCase();
  const actorKey = requiredText(input?.actorKey, 'actorKey');
  const rationale = requiredText(input?.rationale, 'rationale');
  const decidedAt = instant(input?.decidedAt, 'decidedAt');
  if (!DECISION_OUTCOMES.has(decisionOutcome)) {
    throw new TypeError('decisionOutcome is invalid.');
  }
  if (!DECISION_SOURCES.has(decisionSource)) {
    throw new TypeError('decisionSource is invalid.');
  }
  const assignmentKey = decisionOutcome === 'CONFIRMED'
    ? requiredText(input?.assignmentKey ?? `${decisionKey}:assignment`, 'assignmentKey')
    : null;

  return inTransaction(pool, async (client) => {
    const candidateResult = await client.query(
      `SELECT c.product_match_candidate_id, c.store_id, c.full_sku_id,
              c.canonical_product_id, c.canonical_variant_id, c.score,
              c.recommendation, c.strong_evidence_types, c.hard_conflicts
         FROM ops.product_match_candidate AS c
         JOIN dim.store AS s
           ON s.store_id = c.store_id
        WHERE s.store_code = $1
          AND c.candidate_key = $2
        FOR UPDATE OF c`,
      [code, candidateKey],
    );
    if (candidateResult.rowCount !== 1) {
      throw new Error(`Product match candidate ${candidateKey} was not found in store ${code}.`);
    }
    const candidate = candidateResult.rows[0];
    if (decisionOutcome === 'CONFIRMED') {
      assertConfirmationAllowed(candidate, decisionSource);
    }

    const fingerprint = identityFingerprint({
      storeCode: code,
      candidateKey,
      decisionKey,
      decisionOutcome,
      decisionSource,
      actorKey,
      rationale,
      decidedAt,
      assignmentKey,
    });
    const inserted = await client.query(
      `INSERT INTO ops.product_identity_decision (
           store_id, product_match_candidate_id, decision_key,
           decision_outcome, decision_source, actor_key, rationale,
           payload_fingerprint, decided_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (store_id, decision_key) DO NOTHING
       RETURNING product_identity_decision_id, payload_fingerprint`,
      [
        candidate.store_id,
        candidate.product_match_candidate_id,
        decisionKey,
        decisionOutcome,
        decisionSource,
        actorKey,
        rationale,
        fingerprint,
        decidedAt,
      ],
    );

    let decisionId;
    if (inserted.rowCount === 1) {
      decisionId = inserted.rows[0].product_identity_decision_id;
    } else {
      const existing = await client.query(
        `SELECT product_identity_decision_id, payload_fingerprint
           FROM ops.product_identity_decision
          WHERE store_id = $1
            AND decision_key = $2`,
        [candidate.store_id, decisionKey],
      );
      if (existing.rowCount !== 1) {
        throw new Error('Product identity decision conflict could not be read back.');
      }
      assertFingerprint(
        existing.rows[0].payload_fingerprint,
        fingerprint,
        'Product identity decision',
      );
      return {
        storeCode: code,
        productIdentityDecisionId: existing.rows[0].product_identity_decision_id,
        decisionOutcome,
        created: false,
      };
    }

    let assignmentId = null;
    if (decisionOutcome === 'CONFIRMED') {
      await client.query(
        `UPDATE dim.full_sku_canonical_assignment
            SET assignment_status = 'SUPERSEDED',
                valid_to = $3
          WHERE store_id = $1
            AND full_sku_id = $2
            AND assignment_status = 'CONFIRMED'
            AND valid_to IS NULL`,
        [candidate.store_id, candidate.full_sku_id, decidedAt],
      );
      const assignment = await client.query(
        `INSERT INTO dim.full_sku_canonical_assignment (
             store_id, full_sku_id, canonical_product_id, canonical_variant_id,
             product_identity_decision_id, assignment_key, assignment_status,
             confidence, evidence, valid_from
         ) VALUES (
             $1, $2, $3, $4, $5, $6, 'CONFIRMED', $7, $8::jsonb, $9
         )
         RETURNING full_sku_canonical_assignment_id`,
        [
          candidate.store_id,
          candidate.full_sku_id,
          candidate.canonical_product_id,
          candidate.canonical_variant_id,
          decisionId,
          assignmentKey,
          Number(candidate.score),
          JSON.stringify({
            candidateKey,
            recommendation: candidate.recommendation,
            strongEvidenceTypes: candidate.strong_evidence_types,
          }),
          decidedAt,
        ],
      );
      assignmentId = assignment.rows[0].full_sku_canonical_assignment_id;
    } else if (decisionOutcome === 'UNASSIGNED') {
      await client.query(
        `UPDATE dim.full_sku_canonical_assignment
            SET assignment_status = 'REVOKED',
                valid_to = $3
          WHERE store_id = $1
            AND full_sku_id = $2
            AND assignment_status = 'CONFIRMED'
            AND valid_to IS NULL`,
        [candidate.store_id, candidate.full_sku_id, decidedAt],
      );
    }

    return {
      storeCode: code,
      productIdentityDecisionId: decisionId,
      fullSkuCanonicalAssignmentId: assignmentId,
      decisionOutcome,
      created: true,
    };
  });
}
