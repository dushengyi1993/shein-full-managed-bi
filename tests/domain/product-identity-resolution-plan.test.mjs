import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGlobalProductIdentityResolutionPlan,
} from '../../src/domain/product-identity-resolution-plan.mjs';

let observationId = 1;

function hash(label) {
  return Buffer.from(label, 'utf8')
    .toString('hex')
    .padEnd(64, '0')
    .slice(0, 64);
}

function member(normalizedValue, sourceValueKey, standard) {
  const value = {
    observationId: String(observationId),
    normalizedValue,
  };
  observationId += 1;
  if (sourceValueKey !== undefined) value.sourceValueKey = sourceValueKey;
  if (standard !== undefined) value.standard = standard;
  return value;
}

function profile(setId, {
  model = 'DLPA4',
  brand = 'DL',
  category = 'AIR_FRYER',
  supplierCode = 'DLPA4',
  barcode = '6901234567892',
  includeBarcode = true,
} = {}) {
  return {
    setId,
    model: member(
      model,
      'PRODUCT:ATTRIBUTE:1000546',
      { attributeId: '1000546' },
    ),
    brand: member(brand),
    category: member(category),
    supplierCode: member(supplierCode),
    barcodes: includeBarcode
      ? [member(barcode, 'SKU:BARCODE:EAN', 'EAN')]
      : [],
    coreAttributes: [],
    hardAttributes: [],
  };
}

function node({
  nodeKey,
  storeCode,
  setId,
  platformSpuId = `${storeCode}-SPU`,
  platformSkuIds = [`${storeCode}-SKU-1`],
  profileOverrides = {},
  setIdOverrides,
  currentAssignmentFingerprint = null,
} = {}) {
  const setIds = setIdOverrides ?? platformSkuIds.map(
    (_, index) => (index === 0 ? setId : `${setId}-${index + 1}`),
  );
  return {
    nodeKey,
    storeCode,
    platformSpuId,
    representativeSetId: setId,
    sealedSkuSetRefs: platformSkuIds.map((platformSkuId, index) => ({
      setId: setIds[index],
      platformSkuId,
      setFingerprint: hash(`${nodeKey}:set:${setIds[index]}`),
    })),
    profile: profile(setId, profileOverrides),
    currentAssignmentFingerprint,
  };
}

function plan(nodes, overrides = {}) {
  return buildGlobalProductIdentityResolutionPlan({
    nodes,
    matcherVersion: overrides.matcherVersion ?? 'observed-matcher-v1',
    policyVersion: overrides.policyVersion ?? 'strict-global-clique-v1',
  });
}

test.beforeEach(() => {
  observationId = 1;
});

test('accepts a complete cross-store clique and emits safe relations plus every SKU target', () => {
  const result = plan([
    node({
      nodeKey: 'DL:SPU-1',
      storeCode: 'DL',
      setId: 'set-dl-1',
      platformSkuIds: ['DL-SKU-1', 'DL-SKU-2'],
    }),
    node({
      nodeKey: 'CX:SPU-1',
      storeCode: 'CX',
      setId: 'set-cx-1',
      platformSkuIds: ['CX-SKU-1', 'CX-SKU-2'],
    }),
  ]);

  assert.equal(result.components.length, 1);
  assert.equal(result.rejectedRecallGroups.length, 0);
  assert.match(result.planHash, /^[0-9a-f]{64}$/);
  const component = result.components[0];
  assert.match(component.componentKey, /^[0-9a-f]{64}$/);
  assert.match(component.canonicalKey, /^GLOBAL-PRODUCT:[0-9a-f]{64}$/);
  assert.equal(component.nodeMembers.length, 2);
  assert.equal(component.setMembers.length, 4);
  assert.equal(component.relations.length, 1);
  assert.equal(component.relations[0].recommendation, 'CONFIRMED');
  assert.deepEqual(
    component.relations[0].strongEvidenceTypes,
    ['BARCODE', 'MODEL', 'BRAND_CATEGORY'],
  );
  assert.equal(component.skuCandidates.length, 4);
  for (const candidate of component.skuCandidates) {
    assert.notEqual(candidate.storeCode, candidate.targetStoreCode);
    assert.notEqual(candidate.sourceSetId, candidate.targetRepresentativeSetId);
    assert.match(candidate.sourceSetFingerprint, /^[0-9a-f]{64}$/);
    assert.match(candidate.targetSetFingerprint, /^[0-9a-f]{64}$/);
  }
  for (const evidence of component.relations[0].matchedEvidence) {
    assert.equal('normalizedValue' in evidence, false);
    assert.match(evidence.normalizedValueFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(evidence.sourceObservationId);
    assert.ok(evidence.targetObservationId);
  }
});

test('input node, set and evidence order do not change the plan or hash', () => {
  const nodes = [
    node({
      nodeKey: 'DL:SPU-1',
      storeCode: 'DL',
      setId: 'set-dl-1',
      platformSkuIds: ['DL-SKU-1', 'DL-SKU-2'],
    }),
    node({
      nodeKey: 'CX:SPU-1',
      storeCode: 'CX',
      setId: 'set-cx-1',
      platformSkuIds: ['CX-SKU-1', 'CX-SKU-2'],
    }),
  ];
  const first = plan(nodes);
  const reordered = structuredClone(nodes).reverse();
  for (const value of reordered) {
    value.sealedSkuSetRefs.reverse();
    value.profile.barcodes.reverse();
  }
  const second = plan(reordered);

  assert.deepEqual(second, first);
  assert.equal(second.planHash, first.planHash);
});

test('three-store expansion keeps recall-derived keys while cross-store SKU targets stay deterministic', () => {
  const anchor = node({
    nodeKey: 'AA:SPU-1',
    storeCode: 'AA',
    setId: 'set-aa-1',
    platformSkuIds: ['AA-SKU-1', 'AA-SKU-2', 'AA-SKU-3'],
  });
  const cx = node({
    nodeKey: 'CX:SPU-1',
    storeCode: 'CX',
    setId: 'set-cx-1',
  });
  const dl = node({
    nodeKey: 'DL:SPU-1',
    storeCode: 'DL',
    setId: 'set-dl-1',
  });
  const twoStore = plan([anchor, cx]);
  const threeStore = plan([dl, anchor, cx]);
  const reordered = plan([cx, dl, anchor]);

  assert.equal(threeStore.components.length, 1);
  assert.equal(
    threeStore.components[0].componentKey,
    twoStore.components[0].componentKey,
  );
  assert.equal(
    threeStore.components[0].canonicalKey,
    twoStore.components[0].canonicalKey,
  );
  assert.notEqual(threeStore.planHash, twoStore.planHash);
  assert.deepEqual(reordered, threeStore);

  const component = threeStore.components[0];
  assert.equal(component.targetRepresentative.storeCode, 'AA');
  const anchorCandidates = component.skuCandidates.filter(
    ({ storeCode }) => storeCode === 'AA',
  );
  assert.equal(anchorCandidates.length, 3);
  assert.equal(
    anchorCandidates.every(({ targetStoreCode }) => targetStoreCode === 'CX'),
    true,
  );
  for (const candidate of component.skuCandidates) {
    assert.notEqual(candidate.storeCode, candidate.targetStoreCode);
    assert.notEqual(candidate.sourceSetId, candidate.targetRepresentativeSetId);
  }
});

test('set, assignment, matcher and policy fingerprints all participate in planHash', () => {
  const nodes = [
    node({ nodeKey: 'DL:SPU-1', storeCode: 'DL', setId: 'set-dl-1' }),
    node({ nodeKey: 'CX:SPU-1', storeCode: 'CX', setId: 'set-cx-1' }),
  ];
  const baseline = plan(nodes);

  const changedSet = structuredClone(nodes);
  changedSet[0].sealedSkuSetRefs[0].setFingerprint = hash('changed-set');
  assert.notEqual(plan(changedSet).planHash, baseline.planHash);

  const changedAssignment = structuredClone(nodes);
  changedAssignment[0].currentAssignmentFingerprint = hash('assignment');
  assert.notEqual(plan(changedAssignment).planHash, baseline.planHash);

  assert.notEqual(
    plan(nodes, { matcherVersion: 'observed-matcher-v2' }).planHash,
    baseline.planHash,
  );
  assert.notEqual(
    plan(nodes, { policyVersion: 'strict-global-clique-v2' }).planHash,
    baseline.planHash,
  );
});

test('rejected-node set and assignment fingerprints still participate in planHash', () => {
  const nodes = [
    node({ nodeKey: 'DL:SPU-1', storeCode: 'DL', setId: 'set-dl-1' }),
  ];
  const baseline = plan(nodes);
  assert.equal(baseline.components.length, 0);

  const changedSet = structuredClone(nodes);
  changedSet[0].sealedSkuSetRefs[0].setFingerprint = hash('rejected-set-change');
  assert.notEqual(plan(changedSet).planHash, baseline.planHash);

  const changedAssignment = structuredClone(nodes);
  changedAssignment[0].currentAssignmentFingerprint = hash('rejected-assignment-change');
  assert.notEqual(plan(changedAssignment).planHash, baseline.planHash);
});

test('rejects an entire three-node recall group when any pair is not confirmed', () => {
  const result = plan([
    node({ nodeKey: 'DL:SPU-1', storeCode: 'DL', setId: 'set-dl-1' }),
    node({ nodeKey: 'CX:SPU-1', storeCode: 'CX', setId: 'set-cx-1' }),
    node({
      nodeKey: 'AA:SPU-1',
      storeCode: 'AA',
      setId: 'set-aa-1',
      profileOverrides: { includeBarcode: false },
    }),
  ]);

  assert.equal(result.components.length, 0);
  assert.equal(result.rejectedRecallGroups.length, 1);
  const rejected = result.rejectedRecallGroups[0];
  assert.deepEqual(rejected.reasonCodes, ['INCOMPLETE_CONFIRMED_CLIQUE']);
  assert.deepEqual(rejected.counts, {
    nodeCount: 3,
    storeCount: 3,
    requiredPairCount: 3,
    comparedPairCount: 3,
    confirmedPairCount: 1,
    nonConfirmedPairCount: 2,
    hardConflictPairCount: 0,
    overlappingSetCount: 0,
    sameStoreExcessNodeCount: 0,
  });
  assert.equal(result.summary.acceptedNodeCount, 0);
  assert.equal(result.summary.rejectedNodeCount, 3);
});

test('same-store duplicate nodes reject the whole recall group without pair slicing', () => {
  const result = plan([
    node({ nodeKey: 'DL:SPU-1', storeCode: 'DL', setId: 'set-dl-1' }),
    node({ nodeKey: 'DL:SPU-2', storeCode: 'DL', setId: 'set-dl-2' }),
    node({ nodeKey: 'CX:SPU-1', storeCode: 'CX', setId: 'set-cx-1' }),
  ]);

  assert.equal(result.components.length, 0);
  assert.equal(result.rejectedRecallGroups.length, 1);
  assert.deepEqual(
    result.rejectedRecallGroups[0].reasonCodes,
    ['SAME_STORE_MULTIPLE_NODES'],
  );
  assert.equal(result.rejectedRecallGroups[0].counts.comparedPairCount, 0);
  assert.equal(result.rejectedRecallGroups[0].counts.sameStoreExcessNodeCount, 1);
});

test('overlapping sealed set membership rejects the whole group as ambiguous', () => {
  const first = node({
    nodeKey: 'DL:SPU-1',
    storeCode: 'DL',
    setId: 'shared-set',
  });
  const second = node({
    nodeKey: 'CX:SPU-1',
    storeCode: 'CX',
    setId: 'shared-set',
  });
  const result = plan([first, second]);

  assert.equal(result.components.length, 0);
  assert.deepEqual(
    result.rejectedRecallGroups[0].reasonCodes,
    ['OVERLAPPING_SET_MEMBERSHIP'],
  );
  assert.equal(result.rejectedRecallGroups[0].counts.overlappingSetCount, 1);
  assert.equal(result.rejectedRecallGroups[0].counts.comparedPairCount, 0);
});

test('requires at least two stores and all four exact recall fields', () => {
  const result = plan([
    node({ nodeKey: 'DL:SPU-1', storeCode: 'DL', setId: 'set-dl-1' }),
    node({
      nodeKey: 'CX:SPU-1',
      storeCode: 'CX',
      setId: 'set-cx-1',
      profileOverrides: { supplierCode: 'OTHER-SUPPLIER' },
    }),
    node({
      nodeKey: 'AA:SPU-1',
      storeCode: 'AA',
      setId: 'set-aa-1',
      profileOverrides: { model: '' },
    }),
  ]);

  assert.equal(result.components.length, 0);
  assert.equal(result.rejectedRecallGroups.length, 3);
  assert.equal(
    result.rejectedRecallGroups.some(
      ({ reasonCodes }) => reasonCodes.includes('MISSING_EXACT_RECALL_IDENTITY'),
    ),
    true,
  );
  assert.equal(
    result.rejectedRecallGroups.filter(
      ({ reasonCodes }) => reasonCodes.includes('INSUFFICIENT_DISTINCT_STORES'),
    ).length,
    2,
  );
});

test('never emits normalized identity values', () => {
  const secrets = {
    model: 'MODEL-PRIVATE-9988',
    brand: 'BRAND-PRIVATE-8877',
    category: 'CATEGORY-PRIVATE-7766',
    supplierCode: 'SUPPLIER-PRIVATE-6655',
  };
  const result = plan([
    node({
      nodeKey: 'DL:SPU-1',
      storeCode: 'DL',
      setId: 'set-dl-1',
      profileOverrides: secrets,
    }),
    node({
      nodeKey: 'CX:SPU-1',
      storeCode: 'CX',
      setId: 'set-cx-1',
      profileOverrides: secrets,
    }),
  ]);

  const serialized = JSON.stringify(result);
  for (const secret of Object.values(secrets)) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('rejects malformed representative and fingerprint evidence instead of guessing', () => {
  const malformedRepresentative = node({
    nodeKey: 'DL:SPU-1',
    storeCode: 'DL',
    setId: 'set-dl-1',
  });
  malformedRepresentative.profile.setId = 'other-set';
  assert.throws(
    () => plan([malformedRepresentative]),
    /profile\.setId must equal representativeSetId/,
  );

  const malformedFingerprint = node({
    nodeKey: 'CX:SPU-1',
    storeCode: 'CX',
    setId: 'set-cx-1',
  });
  malformedFingerprint.sealedSkuSetRefs[0].setFingerprint = 'not-a-hash';
  assert.throws(
    () => plan([malformedFingerprint]),
    /must be a SHA-256 fingerprint/,
  );
});
