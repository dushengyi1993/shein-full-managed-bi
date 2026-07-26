import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateProductIdentityMatch,
  isValidGtin,
  normalizeIdentifierValue,
  normalizeProductIdentityProfile,
} from '../../src/domain/product-identity.mjs';

test('normalizes comparison values without destroying the caller source value', () => {
  const source = ' DL-pa4 / 6L ';
  assert.equal(normalizeIdentifierValue('MODEL', source), 'DLPA46L');
  assert.equal(source, ' DL-pa4 / 6L ');
  assert.equal(normalizeIdentifierValue('VOLTAGE', '220 ～ 240 伏'), '220-240V');
  assert.equal(normalizeIdentifierValue('DIMENSIONS', '20 × 30 × 40 厘米'), '20X30X40CM');
  assert.equal(normalizeIdentifierValue('CAPACITY', '500毫升'), '500ML');
});

test('validates GTIN-8, GTIN-12, GTIN-13 and GTIN-14 check digits', () => {
  for (const gtin of [
    '96385074',
    '036000291452',
    '6901234567892',
    '10012345000017',
  ]) {
    assert.equal(isValidGtin(gtin), true, gtin);
  }
  for (const invalid of [
    '96385075',
    '036000291453',
    '6901234567890',
    '10012345000018',
    '69012345-67892',
    '123456789',
    'not-a-barcode',
  ]) {
    assert.equal(isValidGtin(invalid), false, invalid);
  }
});

test('normalizes hard fields from core attributes and keeps other core evidence deterministic', () => {
  const normalized = normalizeProductIdentityProfile({
    brandName: ' D&L ',
    modelNo: 'DL-01',
    coreAttributes: {
      voltage: '220 V',
      Color: 'white',
      Material: ' ABS ',
    },
  });
  assert.equal(normalized.brand, 'D&L');
  assert.equal(normalized.model, 'DL01');
  assert.equal(normalized.voltage, '220V');
  assert.deepEqual(normalized.coreAttributes, { COLOR: 'WHITE', MATERIAL: 'ABS' });
});

test('auto-confirms only at 0.95 with two independent strong evidence types', () => {
  const match = evaluateProductIdentityMatch(
    { barcode: '6901234567892', model: 'DL-01' },
    { barcode: '6901234567892', model: 'DL01' },
  );
  assert.equal(match.score, 0.95);
  assert.equal(match.recommendation, 'CONFIRMED');
  assert.deepEqual(match.strongEvidenceTypes, ['BARCODE', 'MODEL']);
});

test('proposes a 0.75 model, brand, category and core-attribute candidate for review', () => {
  const source = {
    model: 'PA4-6L',
    brand: 'DL',
    category: 'Air Fryer',
    coreAttributes: { color: 'white', material: 'ABS' },
  };
  const match = evaluateProductIdentityMatch(source, structuredClone(source));
  assert.equal(match.score, 0.75);
  assert.equal(match.recommendation, 'PROPOSED');
  assert.deepEqual(match.strongEvidenceTypes, ['MODEL', 'BRAND_CATEGORY']);
});

test('hard category, voltage, plug, capacity or dimensions conflicts always block', () => {
  for (const [field, left, right] of [
    ['category', 'AIR FRYER', 'KETTLE'],
    ['voltage', '110V', '220V'],
    ['plug', 'EU', 'US'],
    ['capacity', '5L', '6L'],
    ['dimensions', '20x30x40cm', '21x30x40cm'],
  ]) {
    const match = evaluateProductIdentityMatch(
      { barcode: '6901234567892', model: 'DL01', [field]: left },
      { barcode: '6901234567892', model: 'DL01', [field]: right },
    );
    assert.equal(match.recommendation, 'BLOCKED', field);
    assert.equal(match.hardConflicts[0].field, field);
  }
});

test('does not automate weak or sparse evidence', () => {
  const match = evaluateProductIdentityMatch(
    { brand: 'DL', category: 'AIR FRYER' },
    { brand: 'DL', category: 'AIR FRYER' },
  );
  assert.equal(match.score, 0.2);
  assert.equal(match.recommendation, 'REVIEW_REQUIRED');
});

test('valid barcode plus brand/category can clear the gate while supplier code stays auxiliary', () => {
  const source = {
    supplierCode: ' DL-PA4/6L ',
    barcode: '6901234567892',
    brand: 'DL',
    category: 'Air Fryer',
  };
  const match = evaluateProductIdentityMatch(source, {
    supplier_code: 'DLPA46L',
    barcode: '6901234567892',
    brandName: 'dl',
    categoryName: 'air fryer',
  });
  assert.equal(match.score, 1);
  assert.equal(match.recommendation, 'CONFIRMED');
  assert.deepEqual(match.strongEvidenceTypes, [
    'BARCODE',
    'BRAND_CATEGORY',
  ]);
});

test('supplier code alone remains below the automatic threshold', () => {
  const match = evaluateProductIdentityMatch(
    { supplierCode: 'MODEL-1' },
    { supplierCode: 'MODEL1' },
  );
  assert.equal(match.score, 0.25);
  assert.equal(match.recommendation, 'REVIEW_REQUIRED');
  assert.deepEqual(match.strongEvidenceTypes, []);
});

test('an identical invalid barcode never contributes barcode evidence', () => {
  const match = evaluateProductIdentityMatch(
    { barcode: '6901234567890', model: 'DL-01' },
    { barcode: '6901234567890', model: 'DL01' },
  );
  assert.equal(match.score, 0.35);
  assert.equal(match.recommendation, 'REVIEW_REQUIRED');
  assert.deepEqual(match.strongEvidenceTypes, ['MODEL']);
  assert.equal(
    match.matchedEvidence.some((evidence) => evidence.type === 'BARCODE'),
    false,
  );
});

test('generic core attributes add auxiliary score but never impersonate strong evidence', () => {
  const source = {
    barcode: '6901234567892',
    supplierCode: 'DL-PA4-6L',
    coreAttributes: {
      color: 'white',
      material: 'ABS',
    },
  };
  const match = evaluateProductIdentityMatch(source, structuredClone(source));
  assert.equal(match.score, 1);
  assert.equal(match.recommendation, 'REVIEW_REQUIRED');
  assert.deepEqual(match.strongEvidenceTypes, ['BARCODE']);
  assert.deepEqual(
    match.matchedEvidence.find((evidence) => evidence.type === 'CORE_ATTRIBUTES')
      ?.matchedKeys,
    ['COLOR', 'MATERIAL'],
  );
});
