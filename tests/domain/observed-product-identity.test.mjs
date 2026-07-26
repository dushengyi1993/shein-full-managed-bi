import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateObservedProductIdentityMatch,
} from '../../src/domain/observed-product-identity.mjs';

let nextObservationId = 1;

function member(normalizedValue, sourceValueKey, standard) {
  const value = {
    observationId: String(nextObservationId),
    normalizedValue,
  };
  nextObservationId += 1;
  if (sourceValueKey !== undefined) value.sourceValueKey = sourceValueKey;
  if (standard !== undefined) value.standard = standard;
  return value;
}

function observedSet(overrides = {}) {
  return {
    setId: overrides.setId ?? `set-${nextObservationId}`,
    model: null,
    brand: null,
    category: null,
    supplierCode: null,
    barcodes: [],
    coreAttributes: [],
    hardAttributes: [],
    ...overrides,
  };
}

function officialModel(value = 'DLPA4') {
  return member(
    value,
    'PRODUCT:ATTRIBUTE:1000546',
    { attributeId: '1000546' },
  );
}

function curated(attributeId, value) {
  return member(value, `PRODUCT:ATTRIBUTE:${attributeId}`);
}

test.beforeEach(() => {
  nextObservationId = 1;
});

test('confirms the valid GTIN plus official model path at exactly 0.95', () => {
  const result = evaluateObservedProductIdentityMatch(
    observedSet({
      setId: 'source',
      model: officialModel(),
      barcodes: [member('6901234567892', 'SKU:BARCODE:EAN', 'EAN')],
    }),
    observedSet({
      setId: 'target',
      model: officialModel(),
      barcodes: [member('6901234567892', 'SKU:BARCODE:EAN', 'EAN')],
    }),
  );

  assert.equal(result.recommendation, 'CONFIRMED');
  assert.equal(result.score, 0.95);
  assert.deepEqual(result.strongEvidenceTypes, ['BARCODE', 'MODEL']);
});

test('confirms valid GTIN plus brand/category and two curated attributes', () => {
  const result = evaluateObservedProductIdentityMatch(
    observedSet({
      setId: 'source',
      brand: member('DL'),
      category: member('AIR_FRYER'),
      barcodes: [member('012345678905', 'SKU:BARCODE:UPC', 'UPC')],
      coreAttributes: [
        curated('147', '220V'),
        curated('1000463', 'EU'),
      ],
    }),
    observedSet({
      setId: 'target',
      brand: member('DL'),
      category: member('AIR_FRYER'),
      barcodes: [member('012345678905', 'SKU:BARCODE:UPC', 'UPC')],
      coreAttributes: [
        curated('147', '220V'),
        curated('1000463', 'EU'),
      ],
    }),
  );

  assert.equal(result.recommendation, 'CONFIRMED');
  assert.equal(result.score, 1);
  assert.deepEqual(
    result.strongEvidenceTypes,
    ['BARCODE', 'BRAND_CATEGORY', 'CURATED_ATTRIBUTES'],
  );
});

test('confirms official model plus brand/category, supporting supplier, and two curated attributes', () => {
  const result = evaluateObservedProductIdentityMatch(
    observedSet({
      setId: 'source',
      model: officialModel(),
      brand: member('DL'),
      category: member('AIR_FRYER'),
      supplierCode: member('DLPA4'),
      coreAttributes: [
        curated('160', '6L'),
        curated('1000572', 'WHITE'),
      ],
    }),
    observedSet({
      setId: 'target',
      model: officialModel(),
      brand: member('DL'),
      category: member('AIR_FRYER'),
      supplierCode: member('DLPA4'),
      coreAttributes: [
        curated('160', '6L'),
        curated('1000572', 'WHITE'),
      ],
    }),
  );

  assert.equal(result.recommendation, 'CONFIRMED');
  assert.equal(result.score, 1);
  assert.deepEqual(
    result.strongEvidenceTypes,
    ['MODEL', 'BRAND_CATEGORY', 'CURATED_ATTRIBUTES'],
  );
  const supplierEvidence = result.matchedEvidence.find(
    ({ type }) => type === 'SUPPLIER_CODE',
  );
  assert.equal(supplierEvidence.isStrong, false);
});

test('rejects an equal barcode with an invalid GTIN check digit as evidence', () => {
  const result = evaluateObservedProductIdentityMatch(
    observedSet({
      setId: 'source',
      barcodes: [member('6901234567890', 'SKU:BARCODE:EAN', 'EAN')],
    }),
    observedSet({
      setId: 'target',
      barcodes: [member('6901234567890', 'SKU:BARCODE:EAN', 'EAN')],
    }),
  );

  assert.equal(result.recommendation, 'REVIEW_REQUIRED');
  assert.equal(result.score, 0);
  assert.deepEqual(result.strongEvidenceTypes, []);
  assert.equal(result.matchedEvidence.some(({ type }) => type === 'BARCODE'), false);
});

test('requires an explicit EAN or UPC standard before a valid GTIN can be strong', () => {
  for (const standard of [undefined, null, 'FUTURE_BARCODE']) {
    const result = evaluateObservedProductIdentityMatch(
      observedSet({
        setId: `source-${String(standard)}`,
        barcodes: [member('6901234567892', 'SKU:BARCODE', standard)],
      }),
      observedSet({
        setId: `target-${String(standard)}`,
        barcodes: [member('6901234567892', 'SKU:BARCODE', standard)],
      }),
    );

    assert.equal(result.score, 0);
    assert.deepEqual(result.strongEvidenceTypes, []);
    assert.equal(
      result.matchedEvidence.some(({ type }) => type === 'BARCODE'),
      false,
    );
  }
});

test('treats an equal model from a non-official source as non-strong and zero-weight', () => {
  const result = evaluateObservedProductIdentityMatch(
    observedSet({
      setId: 'source',
      model: member(
        'DLPA4',
        'PRODUCT:ATTRIBUTE:9999',
        { attributeId: '9999' },
      ),
    }),
    observedSet({
      setId: 'target',
      model: member(
        'DLPA4',
        'PRODUCT:ATTRIBUTE:9999',
        { attributeId: '9999' },
      ),
    }),
  );

  assert.equal(result.recommendation, 'REVIEW_REQUIRED');
  assert.equal(result.score, 0);
  assert.deepEqual(result.strongEvidenceTypes, []);
  assert.deepEqual(
    result.matchedEvidence.map(({ type, component, isStrong, weight }) => ({
      type,
      component,
      isStrong,
      weight,
    })),
    [{
      type: 'MODEL',
      component: 'UNVERIFIED_SOURCE',
      isStrong: false,
      weight: 0,
    }],
  );
});

test('does not infer the official model attribute from arbitrary numeric tokens', () => {
  for (const modelMember of [
    () => member('DLPA4', 'PRODUCT:ATTRIBUTE:1000546'),
    () => member('DLPA4', 'PRODUCT:ATTRIBUTE:9999', 'ATTRIBUTE:1000546'),
    () => member(
      'DLPA4',
      'PRODUCT:ATTRIBUTE:1000546',
      { attributeId: '9999', name: '1000546' },
    ),
  ]) {
    const result = evaluateObservedProductIdentityMatch(
      observedSet({ setId: 'source', model: modelMember() }),
      observedSet({ setId: 'target', model: modelMember() }),
    );

    assert.equal(result.score, 0);
    assert.deepEqual(result.strongEvidenceTypes, []);
    assert.equal(result.matchedEvidence[0].isStrong, false);
    assert.equal(result.matchedEvidence[0].component, 'UNVERIFIED_SOURCE');
  }
});

test('keeps supplier code supporting when it is the only match', () => {
  const result = evaluateObservedProductIdentityMatch(
    observedSet({ setId: 'source', supplierCode: member('DLPA4') }),
    observedSet({ setId: 'target', supplierCode: member('DLPA4') }),
  );

  assert.equal(result.recommendation, 'REVIEW_REQUIRED');
  assert.equal(result.score, 0.25);
  assert.deepEqual(result.strongEvidenceTypes, []);
  assert.equal(result.matchedEvidence[0].isStrong, false);
});

test('one curated attribute does not pass the collective strong-evidence gate', () => {
  const result = evaluateObservedProductIdentityMatch(
    observedSet({
      setId: 'source',
      brand: member('DL'),
      category: member('AIR_FRYER'),
      barcodes: [member('6901234567892', 'SKU:BARCODE:EAN', 'EAN')],
      coreAttributes: [curated('147', '220V')],
    }),
    observedSet({
      setId: 'target',
      brand: member('DL'),
      category: member('AIR_FRYER'),
      barcodes: [member('6901234567892', 'SKU:BARCODE:EAN', 'EAN')],
      coreAttributes: [curated('147', '220V')],
    }),
  );

  assert.equal(result.recommendation, 'PROPOSED');
  assert.equal(result.score, 0.9);
  assert.deepEqual(result.strongEvidenceTypes, ['BARCODE', 'BRAND_CATEGORY']);
  const curatedEvidence = result.matchedEvidence.find(
    ({ type }) => type === 'CURATED_ATTRIBUTES',
  );
  assert.equal(curatedEvidence.isStrong, false);
});

test('counts curated evidence by distinct attributeId rather than duplicate localized rows', () => {
  const result = evaluateObservedProductIdentityMatch(
    observedSet({
      setId: 'source',
      brand: member('DL'),
      category: member('AIR_FRYER'),
      barcodes: [member('6901234567892', 'SKU:BARCODE:EAN', 'EAN')],
      coreAttributes: [
        curated('147', '220V'),
        curated('147', '二百二十伏'),
      ],
    }),
    observedSet({
      setId: 'target',
      brand: member('DL'),
      category: member('AIR_FRYER'),
      barcodes: [member('6901234567892', 'SKU:BARCODE:EAN', 'EAN')],
      coreAttributes: [
        curated('147', '二百二十伏'),
        curated('147', '220V'),
      ],
    }),
  );

  assert.equal(result.recommendation, 'PROPOSED');
  assert.equal(result.score, 0.9);
  assert.deepEqual(result.strongEvidenceTypes, ['BARCODE', 'BRAND_CATEGORY']);
  assert.equal(
    result.matchedEvidence.filter(({ type }) => type === 'CURATED_ATTRIBUTES').length,
    1,
  );
  assert.equal(
    result.matchedEvidence.find(({ type }) => type === 'CURATED_ATTRIBUTES').isStrong,
    false,
  );
});

test('a non-whitelisted core attribute never becomes strong or adds score', () => {
  const result = evaluateObservedProductIdentityMatch(
    observedSet({
      setId: 'source',
      coreAttributes: [member('ABS', 'PRODUCT:ATTRIBUTE:9999')],
    }),
    observedSet({
      setId: 'target',
      coreAttributes: [member('ABS', 'PRODUCT:ATTRIBUTE:9999')],
    }),
  );

  assert.equal(result.score, 0);
  assert.deepEqual(result.strongEvidenceTypes, []);
  assert.deepEqual(
    result.matchedEvidence.map(({ type, isStrong, weight }) => ({
      type,
      isStrong,
      weight,
    })),
    [{ type: 'CORE_ATTRIBUTES', isStrong: false, weight: 0 }],
  );
});

test('blocks a hard attribute conflict even when an automatic path otherwise passes', () => {
  const result = evaluateObservedProductIdentityMatch(
    observedSet({
      setId: 'source',
      model: officialModel(),
      barcodes: [member('6901234567892', 'SKU:BARCODE:EAN', 'EAN')],
      hardAttributes: [member('110V', 'VARIANT:VOLTAGE')],
    }),
    observedSet({
      setId: 'target',
      model: officialModel(),
      barcodes: [member('6901234567892', 'SKU:BARCODE:EAN', 'EAN')],
      hardAttributes: [member('220V', 'VARIANT:VOLTAGE')],
    }),
  );

  assert.equal(result.recommendation, 'BLOCKED');
  assert.equal(result.hardConflicts.length, 1);
  assert.deepEqual(
    Object.keys(result.hardConflicts[0]),
    [
      'sourceObservationId',
      'targetObservationId',
      'type',
      'component',
      'isStrong',
      'weight',
      'normalizedValueFingerprint',
    ],
  );
  assert.equal(result.hardConflicts[0].component, 'VOLTAGE');
});

test('input member order does not affect the result', () => {
  const source = observedSet({
    setId: 'source',
    brand: member('DL'),
    category: member('AIR_FRYER'),
    barcodes: [
      member('012345678905', 'SKU:BARCODE:UPC', 'UPC'),
      member('6901234567892', 'SKU:BARCODE:EAN', 'EAN'),
    ],
    coreAttributes: [
      curated('1000463', 'EU'),
      curated('147', '220V'),
      member('ABS', 'PRODUCT:ATTRIBUTE:9999'),
    ],
  });
  const target = observedSet({
    setId: 'target',
    brand: member('DL'),
    category: member('AIR_FRYER'),
    barcodes: [
      member('6901234567892', 'SKU:BARCODE:EAN', 'EAN'),
      member('012345678905', 'SKU:BARCODE:UPC', 'UPC'),
    ],
    coreAttributes: [
      member('ABS', 'PRODUCT:ATTRIBUTE:9999'),
      curated('147', '220V'),
      curated('1000463', 'EU'),
    ],
  });

  const first = evaluateObservedProductIdentityMatch(source, target);
  const second = evaluateObservedProductIdentityMatch(
    {
      ...source,
      barcodes: [...source.barcodes].reverse(),
      coreAttributes: [...source.coreAttributes].reverse(),
    },
    {
      ...target,
      barcodes: [...target.barcodes].reverse(),
      coreAttributes: [...target.coreAttributes].reverse(),
    },
  );

  assert.deepEqual(second, first);
});

test('does not mutate inputs or reveal any normalized source value', () => {
  const secretValues = [
    'PRIVATE-MODEL-77',
    'SECRET-BRAND',
    'SECRET-CATEGORY',
    'PRIVATE-SUPPLIER-88',
    '220V-SECRET',
  ];
  const source = observedSet({
    setId: 'source',
    model: member(secretValues[0], 'PRODUCT:ATTRIBUTE:9999'),
    brand: member(secretValues[1]),
    category: member(secretValues[2]),
    supplierCode: member(secretValues[3]),
    coreAttributes: [curated('147', secretValues[4])],
  });
  const target = structuredClone(source);
  target.setId = 'target';
  const beforeSource = structuredClone(source);
  const beforeTarget = structuredClone(target);

  const result = evaluateObservedProductIdentityMatch(source, target);

  assert.deepEqual(source, beforeSource);
  assert.deepEqual(target, beforeTarget);
  const serialized = JSON.stringify(result);
  for (const secret of secretValues) assert.equal(serialized.includes(secret), false);
  for (const evidence of result.matchedEvidence) {
    assert.match(evidence.normalizedValueFingerprint, /^[0-9a-f]{64}$/);
    assert.equal('normalizedValue' in evidence, false);
  }
});
