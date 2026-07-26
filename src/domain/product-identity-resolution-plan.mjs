import { createHash } from 'node:crypto';

import {
  evaluateObservedProductIdentityMatch,
} from './observed-product-identity.mjs';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STORE_CODE_PATTERN = /^[A-Z0-9_-]+$/;
const OFFICIAL_MODEL_ATTRIBUTE_ID = '1000546';
const REJECTION_REASON_ORDER = Object.freeze([
  'MISSING_EXACT_RECALL_IDENTITY',
  'OVERLAPPING_SET_MEMBERSHIP',
  'SAME_STORE_MULTIPLE_NODES',
  'INSUFFICIENT_DISTINCT_STORES',
  'INCOMPLETE_CONFIRMED_CLIQUE',
]);

function requiredText(value, label) {
  const result = String(value ?? '').normalize('NFKC').trim();
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function requiredVersion(value, label) {
  const result = requiredText(value, label);
  if (result.length > 128) throw new TypeError(`${label} is too long.`);
  return result;
}

function fingerprint(value, label, { nullable = false } = {}) {
  if (nullable && (value === undefined || value === null)) return null;
  const result = requiredText(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(result)) {
    throw new TypeError(`${label} must be a SHA-256 fingerprint.`);
  }
  return result;
}

function stableCanonicalValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableCanonicalValue);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableCanonicalValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableCanonicalValue(value));
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const member of Object.values(value)) deepFreeze(member);
  return Object.freeze(value);
}

function normalizeSetReference(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a sealed SKU set reference.`);
  }
  return Object.freeze({
    setId: requiredText(value.setId, `${label}.setId`),
    platformSkuId: requiredText(value.platformSkuId, `${label}.platformSkuId`),
    setFingerprint: fingerprint(
      value.setFingerprint,
      `${label}.setFingerprint`,
    ),
  });
}

function normalizedProfileSetId(profile, label) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError(`${label} must be an observed identity profile.`);
  }
  return requiredText(profile.setId, `${label}.setId`);
}

function normalizeNode(value, index) {
  const label = `nodes[${index}]`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a product node.`);
  }
  const storeCode = requiredText(value.storeCode, `${label}.storeCode`).toUpperCase();
  if (!STORE_CODE_PATTERN.test(storeCode)) {
    throw new TypeError(`${label}.storeCode is invalid.`);
  }
  if (!Array.isArray(value.sealedSkuSetRefs) || value.sealedSkuSetRefs.length === 0) {
    throw new TypeError(`${label}.sealedSkuSetRefs must be a non-empty array.`);
  }
  const sealedSkuSetRefs = value.sealedSkuSetRefs
    .map((member, memberIndex) => normalizeSetReference(
      member,
      `${label}.sealedSkuSetRefs[${memberIndex}]`,
    ))
    .sort((left, right) => (
      left.setId.localeCompare(right.setId)
      || left.platformSkuId.localeCompare(right.platformSkuId)
    ));
  const setIds = new Set();
  const platformSkuIds = new Set();
  for (const reference of sealedSkuSetRefs) {
    if (setIds.has(reference.setId)) {
      throw new TypeError(`${label} repeats sealed set ${reference.setId}.`);
    }
    if (platformSkuIds.has(reference.platformSkuId)) {
      throw new TypeError(`${label} repeats platform SKU ${reference.platformSkuId}.`);
    }
    setIds.add(reference.setId);
    platformSkuIds.add(reference.platformSkuId);
  }

  const representativeSetId = requiredText(
    value.representativeSetId,
    `${label}.representativeSetId`,
  );
  const profileSetId = normalizedProfileSetId(value.profile, `${label}.profile`);
  if (profileSetId !== representativeSetId) {
    throw new TypeError(`${label}.profile.setId must equal representativeSetId.`);
  }
  if (!setIds.has(representativeSetId)) {
    throw new TypeError(`${label}.representativeSetId is not a sealed SKU set.`);
  }

  return Object.freeze({
    nodeKey: requiredText(value.nodeKey, `${label}.nodeKey`),
    storeCode,
    platformSpuId: requiredText(value.platformSpuId, `${label}.platformSpuId`),
    representativeSetId,
    sealedSkuSetRefs: Object.freeze(sealedSkuSetRefs),
    profile: value.profile,
    currentAssignmentFingerprint: fingerprint(
      value.currentAssignmentFingerprint,
      `${label}.currentAssignmentFingerprint`,
      { nullable: true },
    ),
  });
}

function nodeOrder(left, right) {
  return (
    left.storeCode.localeCompare(right.storeCode)
    || left.nodeKey.localeCompare(right.nodeKey)
    || left.platformSpuId.localeCompare(right.platformSpuId)
  );
}

function standardAttributeId(member) {
  const standard = member?.standard;
  if (!standard || typeof standard !== 'object' || Array.isArray(standard)) return null;
  return String(standard.attributeId ?? '').trim() || null;
}

function normalizedObservedValue(member) {
  const value = String(member?.normalizedValue ?? '').normalize('NFKC').trim();
  return value || null;
}

function recallIdentity(node) {
  const model = normalizedObservedValue(node.profile.model);
  const brand = normalizedObservedValue(node.profile.brand);
  const category = normalizedObservedValue(node.profile.category);
  const supplierCode = normalizedObservedValue(node.profile.supplierCode);
  if (
    standardAttributeId(node.profile.model) !== OFFICIAL_MODEL_ATTRIBUTE_ID
    || !model
    || !brand
    || !category
    || !supplierCode
  ) {
    return null;
  }
  return Object.freeze({
    key: `RECALL:${sha256(stableJson([
      model,
      brand,
      category,
      supplierCode,
    ]))}`,
  });
}

function safeNodeMember(node) {
  return Object.freeze({
    nodeKey: node.nodeKey,
    storeCode: node.storeCode,
    platformSpuId: node.platformSpuId,
    representativeSetId: node.representativeSetId,
    currentAssignmentFingerprint: node.currentAssignmentFingerprint,
  });
}

function safeSetMembers(nodes) {
  return nodes.flatMap((node) => node.sealedSkuSetRefs.map((reference) => Object.freeze({
    nodeKey: node.nodeKey,
    storeCode: node.storeCode,
    platformSpuId: node.platformSpuId,
    setId: reference.setId,
    platformSkuId: reference.platformSkuId,
    setFingerprint: reference.setFingerprint,
    isRepresentative: reference.setId === node.representativeSetId,
  }))).sort((left, right) => (
    left.storeCode.localeCompare(right.storeCode)
    || left.nodeKey.localeCompare(right.nodeKey)
    || left.setId.localeCompare(right.setId)
  ));
}

function relationFor(sourceNode, targetNode) {
  const evaluation = evaluateObservedProductIdentityMatch(
    sourceNode.profile,
    targetNode.profile,
  );
  return deepFreeze({
    sourceNodeKey: sourceNode.nodeKey,
    targetNodeKey: targetNode.nodeKey,
    sourceRepresentativeSetId: sourceNode.representativeSetId,
    targetRepresentativeSetId: targetNode.representativeSetId,
    recommendation: evaluation.recommendation,
    score: evaluation.score,
    strongEvidenceTypes: [...evaluation.strongEvidenceTypes],
    matchedEvidence: evaluation.matchedEvidence.map((member) => ({ ...member })),
    hardConflicts: evaluation.hardConflicts.map((member) => ({ ...member })),
    reason: evaluation.reason,
  });
}

function allPairRelations(nodes) {
  const relations = [];
  for (let sourceIndex = 0; sourceIndex < nodes.length; sourceIndex += 1) {
    for (
      let targetIndex = sourceIndex + 1;
      targetIndex < nodes.length;
      targetIndex += 1
    ) {
      relations.push(relationFor(nodes[sourceIndex], nodes[targetIndex]));
    }
  }
  return relations;
}

function groupCounts(nodes, relations, overlappingSetCount) {
  const stores = new Set(nodes.map(({ storeCode }) => storeCode));
  const requiredPairCount = (nodes.length * (nodes.length - 1)) / 2;
  return Object.freeze({
    nodeCount: nodes.length,
    storeCount: stores.size,
    requiredPairCount,
    comparedPairCount: relations.length,
    confirmedPairCount: relations.filter(
      ({ recommendation, hardConflicts }) => (
        recommendation === 'CONFIRMED' && hardConflicts.length === 0
      ),
    ).length,
    nonConfirmedPairCount: relations.filter(
      ({ recommendation }) => recommendation !== 'CONFIRMED',
    ).length,
    hardConflictPairCount: relations.filter(
      ({ hardConflicts }) => hardConflicts.length > 0,
    ).length,
    overlappingSetCount,
    sameStoreExcessNodeCount: nodes.length - stores.size,
  });
}

function rejectedGroup({ recallKey, nodes, reasons, relations = [], overlappingSetCount = 0 }) {
  return deepFreeze({
    recallKey,
    nodeKeys: nodes.map(({ nodeKey }) => nodeKey).sort(),
    reasonCodes: REJECTION_REASON_ORDER.filter((reason) => reasons.has(reason)),
    counts: groupCounts(nodes, relations, overlappingSetCount),
  });
}

function buildSkuCandidates(componentKey, nodes) {
  const candidates = [];
  for (const sourceNode of nodes) {
    const targetNode = nodes.find(
      ({ storeCode }) => storeCode !== sourceNode.storeCode,
    );
    if (!targetNode) {
      throw new Error('A GLOBAL component cannot choose a cross-store candidate target.');
    }
    const targetReference = targetNode.sealedSkuSetRefs.find(
      ({ setId }) => setId === targetNode.representativeSetId,
    );
    for (const sourceReference of sourceNode.sealedSkuSetRefs) {
      if (sourceReference.setId === targetNode.representativeSetId) {
        throw new Error('A GLOBAL candidate source and target set must differ.');
      }
      candidates.push(deepFreeze({
        candidateKey: `GLOBAL-CANDIDATE:${sha256(stableJson([
          componentKey,
          sourceNode.nodeKey,
          sourceReference.setId,
          targetNode.nodeKey,
          targetNode.representativeSetId,
        ]))}`,
        nodeKey: sourceNode.nodeKey,
        storeCode: sourceNode.storeCode,
        platformSpuId: sourceNode.platformSpuId,
        platformSkuId: sourceReference.platformSkuId,
        sourceSetId: sourceReference.setId,
        sourceSetFingerprint: sourceReference.setFingerprint,
        targetNodeKey: targetNode.nodeKey,
        targetStoreCode: targetNode.storeCode,
        targetRepresentativeSetId: targetNode.representativeSetId,
        targetSetFingerprint: targetReference.setFingerprint,
        currentAssignmentFingerprint: sourceNode.currentAssignmentFingerprint,
      }));
    }
  }
  return candidates.sort((left, right) => (
    left.storeCode.localeCompare(right.storeCode)
    || left.nodeKey.localeCompare(right.nodeKey)
    || left.sourceSetId.localeCompare(right.sourceSetId)
  ));
}

function buildComponent(recallKey, nodes, relations) {
  const componentKey = recallKey.replace(/^RECALL:/, '');
  if (!SHA256_PATTERN.test(componentKey)) {
    throw new Error('A GLOBAL component requires a stable recall identity hash.');
  }
  const targetNode = nodes[0];
  return deepFreeze({
    componentKey,
    canonicalKey: `GLOBAL-PRODUCT:${componentKey}`,
    targetRepresentative: {
      nodeKey: targetNode.nodeKey,
      storeCode: targetNode.storeCode,
      setId: targetNode.representativeSetId,
      setFingerprint: targetNode.sealedSkuSetRefs.find(
        ({ setId }) => setId === targetNode.representativeSetId,
      ).setFingerprint,
    },
    nodeMembers: nodes.map(safeNodeMember),
    setMembers: safeSetMembers(nodes),
    relations,
    skuCandidates: buildSkuCandidates(componentKey, nodes),
  });
}

function normalizeNodes(values) {
  if (!Array.isArray(values)) throw new TypeError('nodes must be an array.');
  const nodes = values.map(normalizeNode).sort(nodeOrder);
  const nodeKeys = new Set();
  for (const node of nodes) {
    if (nodeKeys.has(node.nodeKey)) {
      throw new TypeError(`Duplicate nodeKey ${node.nodeKey}.`);
    }
    nodeKeys.add(node.nodeKey);
  }
  return nodes;
}

function overlappingSetIds(nodes) {
  const owners = new Map();
  for (const node of nodes) {
    for (const reference of node.sealedSkuSetRefs) {
      const nodeKeys = owners.get(reference.setId) ?? new Set();
      nodeKeys.add(node.nodeKey);
      owners.set(reference.setId, nodeKeys);
    }
  }
  return new Set(
    [...owners.entries()]
      .filter(([, nodeKeys]) => nodeKeys.size > 1)
      .map(([setId]) => setId),
  );
}

function inputEvidenceFingerprint(nodes) {
  return sha256(stableJson(nodes.map((node) => ({
    nodeKey: node.nodeKey,
    storeCode: node.storeCode,
    platformSpuId: node.platformSpuId,
    representativeSetId: node.representativeSetId,
    sealedSkuSetRefs: node.sealedSkuSetRefs,
    currentAssignmentFingerprint: node.currentAssignmentFingerprint,
  }))));
}

/**
 * Build a deterministic, read-only plan for strict GLOBAL product components.
 *
 * Recall values are used only as SHA-256 preimages and are never returned.
 * Only complete, cross-store, non-overlapping confirmed cliques are accepted.
 */
export function buildGlobalProductIdentityResolutionPlan({
  nodes: inputNodes,
  matcherVersion,
  policyVersion,
} = {}) {
  const normalizedMatcherVersion = requiredVersion(matcherVersion, 'matcherVersion');
  const normalizedPolicyVersion = requiredVersion(policyVersion, 'policyVersion');
  const nodes = normalizeNodes(inputNodes);
  const overlappingIds = overlappingSetIds(nodes);
  const groups = new Map();
  const rejected = [];

  for (const node of nodes) {
    const recall = recallIdentity(node);
    if (!recall) {
      rejected.push(rejectedGroup({
        recallKey: `UNRECALLED:${sha256(node.nodeKey)}`,
        nodes: [node],
        reasons: new Set(['MISSING_EXACT_RECALL_IDENTITY']),
      }));
      continue;
    }
    const members = groups.get(recall.key) ?? [];
    members.push(node);
    groups.set(recall.key, members);
  }

  const components = [];
  for (const recallKey of [...groups.keys()].sort()) {
    const groupNodes = groups.get(recallKey).sort(nodeOrder);
    const stores = new Set(groupNodes.map(({ storeCode }) => storeCode));
    const groupOverlappingSetIds = new Set(
      groupNodes.flatMap(({ sealedSkuSetRefs }) => (
        sealedSkuSetRefs.map(({ setId }) => setId)
      )).filter((setId) => overlappingIds.has(setId)),
    );
    const reasons = new Set();
    if (groupOverlappingSetIds.size > 0) {
      reasons.add('OVERLAPPING_SET_MEMBERSHIP');
    }
    if (stores.size !== groupNodes.length) {
      reasons.add('SAME_STORE_MULTIPLE_NODES');
    }
    if (stores.size < 2) {
      reasons.add('INSUFFICIENT_DISTINCT_STORES');
    }
    if (reasons.size > 0) {
      rejected.push(rejectedGroup({
        recallKey,
        nodes: groupNodes,
        reasons,
        overlappingSetCount: groupOverlappingSetIds.size,
      }));
      continue;
    }

    const relations = allPairRelations(groupNodes);
    const completeClique = relations.every((relation) => (
      relation.recommendation === 'CONFIRMED'
      && relation.hardConflicts.length === 0
    ));
    if (!completeClique) {
      rejected.push(rejectedGroup({
        recallKey,
        nodes: groupNodes,
        reasons: new Set(['INCOMPLETE_CONFIRMED_CLIQUE']),
        relations,
      }));
      continue;
    }
    components.push(buildComponent(recallKey, groupNodes, relations));
  }

  components.sort((left, right) => left.componentKey.localeCompare(right.componentKey));
  rejected.sort((left, right) => (
    left.recallKey.localeCompare(right.recallKey)
    || left.nodeKeys.join('\u0000').localeCompare(right.nodeKeys.join('\u0000'))
  ));
  const summary = Object.freeze({
    inputNodeCount: nodes.length,
    acceptedComponentCount: components.length,
    acceptedNodeCount: components.reduce(
      (total, component) => total + component.nodeMembers.length,
      0,
    ),
    acceptedSkuSetCount: components.reduce(
      (total, component) => total + component.setMembers.length,
      0,
    ),
    rejectedRecallGroupCount: rejected.length,
    rejectedNodeCount: rejected.reduce(
      (total, group) => total + group.counts.nodeCount,
      0,
    ),
  });
  const planWithoutHash = {
    matcherVersion: normalizedMatcherVersion,
    policyVersion: normalizedPolicyVersion,
    inputEvidenceFingerprint: inputEvidenceFingerprint(nodes),
    components,
    rejectedRecallGroups: rejected,
    summary,
  };
  return deepFreeze({
    ...planWithoutHash,
    planHash: sha256(stableJson(planWithoutHash)),
  });
}
