import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateProductIdentityMatch,
  normalizeIdentifierValue,
  normalizeProductIdentityProfile,
} from '../../src/domain/product-identity.mjs';

test('normalizes comparison values without destroying the caller source value', () => {
  const source = ' DL-pa4 / 6L ';
  assert.equal(normalizeIdentifierValue('MODEL', source), 'DLPA46L');
  assert.equal(source, ' DL-pa4 / 6L ');
  assert.equal(normalizeIdentifierValue('VOLTAGE', '220 ～ 240 伏'), '220-240V');
  assert.equal(normalizeIdentifierValue('DIMENSIONS', '20 × 30 × 40 厘米'), '20X30X40CM');
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
    { barcode: '6901234567890', model: 'DL-01' },
    { barcode: '6901234567890', model: 'DL01' },
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
  assert.deepEqual(match.strongEvidenceTypes, ['MODEL', 'BRAND_CATEGORY', 'CORE_ATTRIBUTES']);
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
      { barcode: '6901234567890', model: 'DL01', [field]: left },
      { barcode: '6901234567890', model: 'DL01', [field]: right },
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
