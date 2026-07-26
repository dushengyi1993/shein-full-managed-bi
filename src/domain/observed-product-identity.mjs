import { createHash } from 'node:crypto';

import { isValidGtin } from './product-identity.mjs';

const MATCH_WEIGHTS = Object.freeze({
  barcode: 0.6,
  model: 0.35,
  supplierCode: 0.25,
  brand: 0.1,
  category: 0.1,
  curatedAttribute: 0.1,
});

const OFFICIAL_MODEL_ATTRIBUTE_ID = '1000546';
const ATTRIBUTE_ID_PATTERN = /^[0-9]{1,32}$/;
const LEGACY_ATTRIBUTE_SOURCE_KEY_PATTERN =
  /^product[.:]attribute[.:]([0-9]{1,32})(?=$|[.:])/i;

export const CURATED_PRODUCT_ATTRIBUTE_IDS = Object.freeze([
  '147',
  '160',
  '1000463',
  '1000572',
  '1000616',
  '1000838',
  '1001207',
  '1001466',
  '1001607',
  '1001755',
  '1002322',
  '1002323',
]);

const CURATED_PRODUCT_ATTRIBUTE_ID_SET = new Set(CURATED_PRODUCT_ATTRIBUTE_IDS);
const HARD_ATTRIBUTE_TYPES = Object.freeze([
  'CATEGORY',
  'VOLTAGE',
  'PLUG',
  'CAPACITY',
  'DIMENSIONS',
]);
const HARD_ATTRIBUTE_TYPE_SET = new Set(HARD_ATTRIBUTE_TYPES);
const STRONG_EVIDENCE_ORDER = Object.freeze([
  'BARCODE',
  'MODEL',
  'BRAND_CATEGORY',
  'CURATED_ATTRIBUTES',
]);
const EVIDENCE_TYPE_ORDER = new Map([
  ['BARCODE', 0],
  ['MODEL', 1],
  ['BRAND_CATEGORY', 2],
  ['SUPPLIER_CODE', 3],
  ['CURATED_ATTRIBUTES', 4],
  ['CORE_ATTRIBUTES', 5],
]);

function requiredSetId(value, label) {
  if (
    (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint')
    || String(value).trim() === ''
  ) {
    throw new TypeError(`${label}.setId is required.`);
  }
  return String(value).trim();
}

function normalizeObservationId(value, label) {
  if (
    (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint')
    || String(value).trim() === ''
  ) {
    throw new TypeError(`${label}.observationId is required.`);
  }
  return String(value).trim();
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).normalize('NFKC').trim();
  return result || null;
}

function normalizedStandard(value) {
  if (value === undefined || value === null) return Object.freeze({
    text: null,
    attributeId: null,
    type: null,
  });
  if (typeof value === 'object' && !Array.isArray(value)) {
    const rawAttributeId = value.attributeId;
    const attributeId = rawAttributeId === undefined || rawAttributeId === null
      ? null
      : optionalText(rawAttributeId);
    if (
      rawAttributeId !== undefined
      && rawAttributeId !== null
      && (!attributeId || !ATTRIBUTE_ID_PATTERN.test(attributeId))
    ) {
      throw new TypeError('standard.attributeId must be a 1-32 digit identifier.');
    }
    return Object.freeze({
      text: optionalText(value.name ?? value.standard)?.toUpperCase() ?? null,
      attributeId,
      type: optionalText(value.type ?? value.field)?.toUpperCase() ?? null,
    });
  }
  return Object.freeze({
    text: optionalText(value)?.toUpperCase() ?? null,
    attributeId: null,
    type: null,
  });
}

function normalizeMember(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an observation object.`);
  }
  const normalizedValue = optionalText(value.normalizedValue);
  if (!normalizedValue) {
    throw new TypeError(`${label}.normalizedValue is required.`);
  }
  return Object.freeze({
    observationId: normalizeObservationId(value.observationId, label),
    normalizedValue,
    sourceValueKey: optionalText(value.sourceValueKey),
    standard: normalizedStandard(value.standard),
  });
}

function normalizeMembers(value, label) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return Object.freeze(value.map((member, index) => (
    normalizeMember(member, `${label}[${index}]`)
  )));
}

function normalizeSet(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an observed identity set.`);
  }
  return Object.freeze({
    setId: requiredSetId(value.setId, label),
    model: normalizeMember(value.model, `${label}.model`),
    brand: normalizeMember(value.brand, `${label}.brand`),
    category: normalizeMember(value.category, `${label}.category`),
    supplierCode: normalizeMember(value.supplierCode, `${label}.supplierCode`),
    barcodes: normalizeMembers(value.barcodes, `${label}.barcodes`),
    coreAttributes: normalizeMembers(value.coreAttributes, `${label}.coreAttributes`),
    hardAttributes: normalizeMembers(value.hardAttributes, `${label}.hardAttributes`),
  });
}

function normalizedValueFingerprint(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedPairFingerprint(sourceValues, targetValues) {
  return normalizedValueFingerprint(JSON.stringify({
    source: [...sourceValues].sort(),
    target: [...targetValues].sort(),
  }));
}

function stableMemberOrder(left, right) {
  return (
    left.normalizedValue.localeCompare(right.normalizedValue)
    || left.observationId.localeCompare(right.observationId)
  );
}

function exactPair(source, target) {
  if (!source || !target || source.normalizedValue !== target.normalizedValue) return null;
  return Object.freeze({ source, target });
}

function isOfficialModel(member) {
  return member?.standard.attributeId === OFFICIAL_MODEL_ATTRIBUTE_ID;
}

function barcodeStandardIsEligible(member) {
  const standard = member.standard.text ?? member.standard.type;
  return standard === 'EAN' || standard === 'UPC';
}

function matchingBarcodePair(sourceMembers, targetMembers) {
  const source = [...sourceMembers]
    .filter((member) => (
      barcodeStandardIsEligible(member)
      && isValidGtin(member.normalizedValue)
    ))
    .sort(stableMemberOrder);
  const target = [...targetMembers]
    .filter((member) => (
      barcodeStandardIsEligible(member)
      && isValidGtin(member.normalizedValue)
    ))
    .sort(stableMemberOrder);
  for (const sourceMember of source) {
    const targetMember = target.find(
      (member) => member.normalizedValue === sourceMember.normalizedValue,
    );
    if (targetMember) return Object.freeze({ source: sourceMember, target: targetMember });
  }
  return null;
}

function safeEvidence({
  source,
  target,
  type,
  component,
  isStrong,
  weight,
}) {
  return Object.freeze({
    sourceObservationId: source.observationId,
    targetObservationId: target.observationId,
    type,
    component,
    isStrong,
    weight,
    normalizedValueFingerprint: normalizedValueFingerprint(source.normalizedValue),
  });
}

function memberAttributeId(member) {
  if (member?.standard.attributeId) return member.standard.attributeId;
  const match = member?.sourceValueKey?.match(
    LEGACY_ATTRIBUTE_SOURCE_KEY_PATTERN,
  );
  return match?.[1] ?? null;
}

function pairAttributes(sourceMembers, targetMembers) {
  const targetByKey = new Map();
  for (const member of [...targetMembers].sort(stableMemberOrder)) {
    const attributeId = memberAttributeId(member);
    const fieldKey = attributeId
      ? `ATTRIBUTE:${attributeId}`
      : member.sourceValueKey
        ? `SOURCE:${member.sourceValueKey}`
        : null;
    if (!fieldKey) continue;
    const key = `${fieldKey}\u0000${member.normalizedValue}`;
    const members = targetByKey.get(key) ?? [];
    members.push(member);
    targetByKey.set(key, members);
  }

  const pairs = [];
  for (const source of [...sourceMembers].sort(stableMemberOrder)) {
    const attributeId = memberAttributeId(source);
    const fieldKey = attributeId
      ? `ATTRIBUTE:${attributeId}`
      : source.sourceValueKey
        ? `SOURCE:${source.sourceValueKey}`
        : null;
    if (!fieldKey) continue;
    const key = `${fieldKey}\u0000${source.normalizedValue}`;
    const candidates = targetByKey.get(key);
    if (!candidates?.length) continue;
    pairs.push(Object.freeze({
      source,
      target: candidates.shift(),
      attributeId,
      fieldKey,
    }));
  }
  return pairs.sort((left, right) => (
    (left.attributeId ?? left.fieldKey).localeCompare(
      right.attributeId ?? right.fieldKey,
      'en',
      { numeric: true },
    )
    || stableMemberOrder(left.source, right.source)
    || stableMemberOrder(left.target, right.target)
  ));
}

function hardAttributeType(member) {
  const candidates = [
    member.standard.type,
    member.standard.text,
    member.sourceValueKey,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const tokens = candidate
      .normalize('NFKC')
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter(Boolean);
    const matched = tokens.find((token) => HARD_ATTRIBUTE_TYPE_SET.has(token));
    if (matched) return matched;
  }
  return null;
}

function hardValuesByType(set) {
  const values = new Map(HARD_ATTRIBUTE_TYPES.map((type) => [type, []]));
  if (set.category) values.get('CATEGORY').push(set.category);
  for (const member of set.hardAttributes) {
    const type = hardAttributeType(member);
    if (type) values.get(type).push(member);
  }
  for (const members of values.values()) members.sort(stableMemberOrder);
  return values;
}

function hardConflicts(sourceSet, targetSet) {
  const sourceByType = hardValuesByType(sourceSet);
  const targetByType = hardValuesByType(targetSet);
  const conflicts = [];
  for (const type of HARD_ATTRIBUTE_TYPES) {
    const sourceMembers = sourceByType.get(type);
    const targetMembers = targetByType.get(type);
    if (sourceMembers.length === 0 || targetMembers.length === 0) continue;
    const sourceValues = [...new Set(sourceMembers.map(({ normalizedValue }) => normalizedValue))];
    const targetValues = [...new Set(targetMembers.map(({ normalizedValue }) => normalizedValue))];
    if (
      sourceValues.length === targetValues.length
      && sourceValues.every((value, index) => value === targetValues[index])
    ) {
      continue;
    }
    const source = sourceMembers.find(
      ({ normalizedValue }) => !targetValues.includes(normalizedValue),
    ) ?? sourceMembers[0];
    const target = targetMembers.find(
      ({ normalizedValue }) => !sourceValues.includes(normalizedValue),
    ) ?? targetMembers[0];
    conflicts.push(Object.freeze({
      sourceObservationId: source.observationId,
      targetObservationId: target.observationId,
      type: 'HARD_CONFLICT',
      component: type,
      isStrong: false,
      weight: 0,
      normalizedValueFingerprint: normalizedPairFingerprint(sourceValues, targetValues),
    }));
  }
  return conflicts;
}

function evidenceOrder(left, right) {
  return (
    (EVIDENCE_TYPE_ORDER.get(left.type) ?? 99)
      - (EVIDENCE_TYPE_ORDER.get(right.type) ?? 99)
    || left.component.localeCompare(right.component, 'en', { numeric: true })
    || left.sourceObservationId.localeCompare(right.sourceObservationId)
    || left.targetObservationId.localeCompare(right.targetObservationId)
  );
}

function roundedScore(value) {
  return Math.min(1, Number(value.toFixed(6)));
}

/**
 * Match two sealed product-identity observation sets.
 *
 * Only persisted observation identifiers and hashes of normalized values are
 * returned. The matcher never echoes source values and never accepts an
 * unobserved target profile.
 */
export function evaluateObservedProductIdentityMatch(sourceInput, targetInput) {
  const source = normalizeSet(sourceInput, 'source');
  const target = normalizeSet(targetInput, 'target');
  const evidence = [];
  const strongEvidence = new Set();
  let score = 0;

  const barcodePair = matchingBarcodePair(source.barcodes, target.barcodes);
  if (barcodePair) {
    score += MATCH_WEIGHTS.barcode;
    strongEvidence.add('BARCODE');
    evidence.push(safeEvidence({
      ...barcodePair,
      type: 'BARCODE',
      component: 'GTIN',
      isStrong: true,
      weight: MATCH_WEIGHTS.barcode,
    }));
  }

  const modelPair = exactPair(source.model, target.model);
  const officialModelMatch = Boolean(
    modelPair
    && isOfficialModel(modelPair.source)
    && isOfficialModel(modelPair.target),
  );
  if (modelPair) {
    const modelWeight = officialModelMatch ? MATCH_WEIGHTS.model : 0;
    score += modelWeight;
    if (officialModelMatch) strongEvidence.add('MODEL');
    evidence.push(safeEvidence({
      ...modelPair,
      type: 'MODEL',
      component: officialModelMatch
        ? `ATTRIBUTE:${OFFICIAL_MODEL_ATTRIBUTE_ID}`
        : 'UNVERIFIED_SOURCE',
      isStrong: officialModelMatch,
      weight: modelWeight,
    }));
  }

  const brandPair = exactPair(source.brand, target.brand);
  const categoryPair = exactPair(source.category, target.category);
  const brandCategoryMatch = Boolean(brandPair && categoryPair);
  if (brandCategoryMatch) strongEvidence.add('BRAND_CATEGORY');
  if (brandPair) {
    score += MATCH_WEIGHTS.brand;
    evidence.push(safeEvidence({
      ...brandPair,
      type: 'BRAND_CATEGORY',
      component: 'BRAND',
      isStrong: brandCategoryMatch,
      weight: MATCH_WEIGHTS.brand,
    }));
  }
  if (categoryPair) {
    score += MATCH_WEIGHTS.category;
    evidence.push(safeEvidence({
      ...categoryPair,
      type: 'BRAND_CATEGORY',
      component: 'CATEGORY',
      isStrong: brandCategoryMatch,
      weight: MATCH_WEIGHTS.category,
    }));
  }

  const supplierPair = exactPair(source.supplierCode, target.supplierCode);
  if (supplierPair) {
    score += MATCH_WEIGHTS.supplierCode;
    evidence.push(safeEvidence({
      ...supplierPair,
      type: 'SUPPLIER_CODE',
      component: 'SUPPLIER_CODE',
      isStrong: false,
      weight: MATCH_WEIGHTS.supplierCode,
    }));
  }

  const attributePairs = pairAttributes(source.coreAttributes, target.coreAttributes);
  const curatedPairsByAttributeId = new Map();
  for (const pair of attributePairs) {
    if (
      CURATED_PRODUCT_ATTRIBUTE_ID_SET.has(pair.attributeId)
      && !curatedPairsByAttributeId.has(pair.attributeId)
    ) {
      curatedPairsByAttributeId.set(pair.attributeId, pair);
    }
  }
  const curatedPairs = [...curatedPairsByAttributeId.values()];
  const curatedGatePassed = curatedPairs.length >= 2;
  if (curatedGatePassed) strongEvidence.add('CURATED_ATTRIBUTES');
  for (let index = 0; index < curatedPairs.length; index += 1) {
    const pair = curatedPairs[index];
    const weight = index < 2 ? MATCH_WEIGHTS.curatedAttribute : 0;
    score += weight;
    evidence.push(safeEvidence({
      source: pair.source,
      target: pair.target,
      type: 'CURATED_ATTRIBUTES',
      component: `ATTRIBUTE:${pair.attributeId}`,
      isStrong: curatedGatePassed,
      weight,
    }));
  }
  for (const pair of attributePairs.filter(
    ({ attributeId }) => !CURATED_PRODUCT_ATTRIBUTE_ID_SET.has(attributeId),
  )) {
    evidence.push(safeEvidence({
      source: pair.source,
      target: pair.target,
      type: 'CORE_ATTRIBUTES',
      component: pair.attributeId
        ? `ATTRIBUTE:${pair.attributeId}`
        : 'UNCLASSIFIED',
      isStrong: false,
      weight: 0,
    }));
  }

  const conflicts = hardConflicts(source, target);
  score = roundedScore(score);
  const strongEvidenceTypes = STRONG_EVIDENCE_ORDER.filter(
    (type) => strongEvidence.has(type),
  );
  const approvedAutomaticPath = (
    (barcodePair && officialModelMatch)
    || (barcodePair && brandCategoryMatch && curatedGatePassed)
    || (
      officialModelMatch
      && brandCategoryMatch
      && supplierPair
      && curatedGatePassed
    )
  );

  let recommendation = 'REVIEW_REQUIRED';
  let reason = 'Evidence is below the review proposal threshold.';
  if (conflicts.length > 0) {
    recommendation = 'BLOCKED';
    reason = 'A hard observed product-identity attribute conflicts.';
  } else if (
    approvedAutomaticPath
    && score >= 0.95
    && strongEvidenceTypes.length >= 2
  ) {
    recommendation = 'CONFIRMED';
    reason = 'An approved automatic observed-identity path passed.';
  } else if (score >= 0.75 && score < 0.95) {
    recommendation = 'PROPOSED';
    reason = 'Evidence reached the review proposal band.';
  } else if (score >= 0.95) {
    reason = 'Score is high but no approved automatic observed-identity path passed.';
  }

  return Object.freeze({
    recommendation,
    score,
    strongEvidenceTypes: Object.freeze(strongEvidenceTypes),
    matchedEvidence: Object.freeze(evidence.sort(evidenceOrder)),
    hardConflicts: Object.freeze(conflicts),
    reason,
  });
}
