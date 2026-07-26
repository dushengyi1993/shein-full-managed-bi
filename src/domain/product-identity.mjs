const MATCH_WEIGHTS = Object.freeze({
  barcode: 0.6,
  model: 0.35,
  supplierCode: 0.25,
  brand: 0.1,
  category: 0.1,
  coreAttributes: 0.2,
});

export const PRODUCT_MATCH_THRESHOLDS = Object.freeze({
  autoConfirm: 0.95,
  propose: 0.75,
  minimumIndependentStrongEvidence: 2,
});

export const HARD_CONFLICT_FIELDS = Object.freeze([
  'category',
  'voltage',
  'plug',
  'capacity',
  'dimensions',
]);

const FIELD_ALIASES = Object.freeze({
  barcode: ['barcode', 'barCode', 'ean', 'ean13', 'upc', 'gtin'],
  brand: ['brand', 'brandName'],
  capacity: ['capacity', 'volume'],
  category: ['category', 'categoryName', 'categoryCode'],
  dimensions: ['dimensions', 'dimension', 'size'],
  model: ['model', 'modelNumber', 'modelNo'],
  plug: ['plug', 'plugType'],
  supplierCode: ['supplierCode', 'supplier_code', 'productNumber'],
  voltage: ['voltage', 'ratedVoltage'],
});

function valueFromProfile(profile, field) {
  const source = profile && typeof profile === 'object' ? profile : {};
  for (const key of FIELD_ALIASES[field] || [field]) {
    if (source[key] !== undefined && source[key] !== null && String(source[key]).trim()) {
      return source[key];
    }
  }
  const attributes = source.coreAttributes;
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null;
  for (const key of FIELD_ALIASES[field] || [field]) {
    if (
      attributes[key] !== undefined &&
      attributes[key] !== null &&
      String(attributes[key]).trim()
    ) {
      return attributes[key];
    }
  }
  return null;
}

function normalizeText(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value)
    .normalize('NFKC')
    .trim()
    .toLocaleUpperCase('en-US')
    .replace(/\s+/g, ' ');
  return normalized || null;
}

function normalizeCompact(value) {
  return normalizeText(value)?.replace(/[\s._/\\-]+/g, '') || null;
}

function normalizeDimension(value) {
  return normalizeText(value)
    ?.replace(/[×＊*]/g, 'X')
    .replace(/\s+/g, '')
    .replace(/厘米/g, 'CM')
    .replace(/毫米/g, 'MM') || null;
}

function normalizeVoltage(value) {
  return normalizeText(value)
    ?.replace(/[～~至]/g, '-')
    .replace(/\s+/g, '')
    .replace(/伏特|伏/g, 'V') || null;
}

function normalizeCapacity(value) {
  return normalizeText(value)
    ?.replace(/\s+/g, '')
    // Replace the longer Chinese unit first; otherwise `毫升` becomes `毫L`.
    .replace(/毫升/g, 'ML')
    .replace(/升/g, 'L') || null;
}

/**
 * Validate a GTIN-8, UPC-A/GTIN-12, GTIN-13 or GTIN-14 check digit.
 *
 * Formatting characters are intentionally rejected here. Callers that accept
 * formatted source values must normalize them before validation while keeping
 * the original source evidence separately.
 */
export function isValidGtin(value) {
  if (value === undefined || value === null) return false;
  const candidate = String(value).normalize('NFKC').trim();
  if (![8, 12, 13, 14].includes(candidate.length) || !/^\d+$/.test(candidate)) {
    return false;
  }

  const digits = [...candidate].map(Number);
  const checkDigit = digits.pop();
  const payloadTotal = digits
    .reverse()
    .reduce(
      (total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1),
      0,
    );
  return (payloadTotal + checkDigit) % 10 === 0;
}

/**
 * Normalize only for comparison. Callers must persist the source value
 * separately; normalized values are never a replacement for source evidence.
 */
export function normalizeIdentifierValue(type, value) {
  const normalizedType = String(type || '').trim().toUpperCase();
  if (['PLATFORM_SKU', 'PLATFORM_SKC', 'PLATFORM_SPU', 'BARCODE', 'MODEL'].includes(normalizedType)) {
    return normalizeCompact(value);
  }
  if (normalizedType === 'VOLTAGE') return normalizeVoltage(value);
  if (normalizedType === 'CAPACITY') return normalizeCapacity(value);
  if (['DIMENSIONS', 'SIZE'].includes(normalizedType)) return normalizeDimension(value);
  return normalizeText(value);
}

function normalizeField(field, value) {
  if (field === 'voltage') return normalizeVoltage(value);
  if (field === 'capacity') return normalizeCapacity(value);
  if (field === 'dimensions') return normalizeDimension(value);
  if (
    field === 'model'
    || field === 'barcode'
    || field === 'supplierCode'
  ) {
    return normalizeCompact(value);
  }
  return normalizeText(value);
}

function normalizedCoreAttributes(profile) {
  const attributes = profile?.coreAttributes;
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return {};
  const excluded = new Set(
    Object.values(FIELD_ALIASES).flat().map((key) => normalizeCompact(key)),
  );
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(attributes)) {
    const key = normalizeCompact(rawKey);
    if (!key || excluded.has(key)) continue;
    const value = normalizeText(rawValue);
    if (value !== null) result[key] = value;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function normalizeProductIdentityProfile(profile = {}) {
  return Object.freeze({
    barcode: normalizeField('barcode', valueFromProfile(profile, 'barcode')),
    model: normalizeField('model', valueFromProfile(profile, 'model')),
    supplierCode: normalizeField(
      'supplierCode',
      valueFromProfile(profile, 'supplierCode'),
    ),
    brand: normalizeField('brand', valueFromProfile(profile, 'brand')),
    category: normalizeField('category', valueFromProfile(profile, 'category')),
    voltage: normalizeField('voltage', valueFromProfile(profile, 'voltage')),
    plug: normalizeField('plug', valueFromProfile(profile, 'plug')),
    capacity: normalizeField('capacity', valueFromProfile(profile, 'capacity')),
    dimensions: normalizeField('dimensions', valueFromProfile(profile, 'dimensions')),
    coreAttributes: Object.freeze(normalizedCoreAttributes(profile)),
  });
}

function exactMatch(left, right, field) {
  return Boolean(left[field] && right[field] && left[field] === right[field]);
}

function compareCoreAttributes(left, right) {
  const keys = [...new Set([
    ...Object.keys(left.coreAttributes),
    ...Object.keys(right.coreAttributes),
  ])].sort();
  const comparableKeys = keys.filter(
    (key) => left.coreAttributes[key] !== undefined && right.coreAttributes[key] !== undefined,
  );
  const matchedKeys = comparableKeys.filter(
    (key) => left.coreAttributes[key] === right.coreAttributes[key],
  );
  const conflictingKeys = comparableKeys.filter(
    (key) => left.coreAttributes[key] !== right.coreAttributes[key],
  );
  const similarity = comparableKeys.length === 0 ? 0 : matchedKeys.length / comparableKeys.length;
  return { comparableKeys, matchedKeys, conflictingKeys, similarity };
}

/**
 * Evaluate whether two store-scoped SKU/product descriptions are candidates
 * for one canonical product. Platform SKU/SKC/SPU identifiers are deliberately
 * absent here because they are strong only inside one store and are handled by
 * store-scoped assignment lookups.
 */
export function evaluateProductIdentityMatch(sourceProfile, targetProfile) {
  const source = normalizeProductIdentityProfile(sourceProfile);
  const target = normalizeProductIdentityProfile(targetProfile);

  const hardConflicts = HARD_CONFLICT_FIELDS
    .filter((field) => source[field] && target[field] && source[field] !== target[field])
    .map((field) => ({
      field,
      source: source[field],
      target: target[field],
    }));

  const matchedEvidence = [];
  const strongEvidenceTypes = [];
  let score = 0;

  if (
    exactMatch(source, target, 'barcode')
    && isValidGtin(source.barcode)
    && isValidGtin(target.barcode)
  ) {
    score += MATCH_WEIGHTS.barcode;
    matchedEvidence.push({ type: 'BARCODE', weight: MATCH_WEIGHTS.barcode });
    strongEvidenceTypes.push('BARCODE');
  }
  if (exactMatch(source, target, 'model')) {
    score += MATCH_WEIGHTS.model;
    matchedEvidence.push({ type: 'MODEL', weight: MATCH_WEIGHTS.model });
    strongEvidenceTypes.push('MODEL');
  }
  if (exactMatch(source, target, 'supplierCode')) {
    score += MATCH_WEIGHTS.supplierCode;
    matchedEvidence.push({
      type: 'SUPPLIER_CODE',
      weight: MATCH_WEIGHTS.supplierCode,
    });
  }

  const brandMatch = exactMatch(source, target, 'brand');
  const categoryMatch = exactMatch(source, target, 'category');
  if (brandMatch) {
    score += MATCH_WEIGHTS.brand;
    matchedEvidence.push({ type: 'BRAND', weight: MATCH_WEIGHTS.brand });
  }
  if (categoryMatch) {
    score += MATCH_WEIGHTS.category;
    matchedEvidence.push({ type: 'CATEGORY', weight: MATCH_WEIGHTS.category });
  }
  if (brandMatch && categoryMatch) strongEvidenceTypes.push('BRAND_CATEGORY');

  const core = compareCoreAttributes(source, target);
  if (core.similarity > 0) {
    const weight = Number((MATCH_WEIGHTS.coreAttributes * core.similarity).toFixed(6));
    score += weight;
    matchedEvidence.push({
      type: 'CORE_ATTRIBUTES',
      weight,
      matchedKeys: core.matchedKeys,
      conflictingKeys: core.conflictingKeys,
    });
  }

  score = Math.min(1, Number(score.toFixed(6)));
  const independentEvidence = [...new Set(strongEvidenceTypes)];
  let recommendation = 'REVIEW_REQUIRED';
  let reason = 'Evidence is below the automatic proposal threshold.';

  if (hardConflicts.length > 0) {
    recommendation = 'BLOCKED';
    reason = 'A hard product-identity field conflicts.';
  } else if (
    score >= PRODUCT_MATCH_THRESHOLDS.autoConfirm &&
    independentEvidence.length >= PRODUCT_MATCH_THRESHOLDS.minimumIndependentStrongEvidence
  ) {
    recommendation = 'CONFIRMED';
    reason = 'Automatic confirmation threshold and independent-evidence gate passed.';
  } else if (
    score >= PRODUCT_MATCH_THRESHOLDS.propose &&
    score < PRODUCT_MATCH_THRESHOLDS.autoConfirm
  ) {
    recommendation = 'PROPOSED';
    reason = 'Candidate requires review before assignment.';
  } else if (score >= PRODUCT_MATCH_THRESHOLDS.autoConfirm) {
    reason = 'Score is high but independent strong evidence is insufficient.';
  }

  return Object.freeze({
    recommendation,
    score,
    strongEvidenceTypes: Object.freeze(independentEvidence),
    matchedEvidence: Object.freeze(matchedEvidence),
    hardConflicts: Object.freeze(hardConflicts),
    coreAttributeComparison: Object.freeze(core),
    reason,
  });
}
