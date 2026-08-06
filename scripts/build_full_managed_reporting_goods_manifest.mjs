#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const STORE_PATTERN = /^[A-Z0-9_-]{2,24}$/;

function requiredText(value, label) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function confidenceBand(value) {
  const normalized = requiredText(value, 'confidence');
  const lookup = { 高: 'HIGH', 中: 'MEDIUM', 低: 'LOW' };
  if (!lookup[normalized]) throw new TypeError(`Unsupported confidence: ${normalized}`);
  return lookup[normalized];
}

function normalizeAssignment(value, label) {
  const storeCode = requiredText(value?.storeCode, `${label}.storeCode`).toUpperCase();
  const fullSkuId = requiredText(value?.fullSkuId, `${label}.fullSkuId`);
  if (!STORE_PATTERN.test(storeCode)) throw new TypeError(`${label}.storeCode is invalid.`);
  if (!/^[1-9][0-9]*$/.test(fullSkuId)) throw new TypeError(`${label}.fullSkuId is invalid.`);
  const nullable = (input) => {
    const text = String(input ?? '').normalize('NFKC').trim();
    return text || null;
  };
  return {
    storeCode,
    fullSkuId,
    platformSkuId: nullable(value?.platformSkuId),
    platformSkcId: nullable(value?.platformSkcId),
    platformSpuId: nullable(value?.platformSpuId),
  };
}

export function buildReportingGoodsManifest(proposalDocument, {
  approvedAt = new Date().toISOString(),
  approvalActor = 'owner:dushengyi',
  approvalText = '先按你这个来；无型号商品使用纯汉字标准货号，后续发现问题再改。',
} = {}) {
  if (proposalDocument?.approval?.status !== 'OWNER_CONFIRMED') {
    throw new TypeError('Proposal document is not owner-confirmed.');
  }
  const sourceGeneratedAt = new Date(proposalDocument?.summary?.sourceGeneratedAt);
  const approvalTime = new Date(approvedAt);
  if (!Number.isFinite(sourceGeneratedAt.getTime())) {
    throw new TypeError('summary.sourceGeneratedAt must be a valid timestamp.');
  }
  if (!Number.isFinite(approvalTime.getTime())) {
    throw new TypeError('approvedAt must be a valid timestamp.');
  }
  if (!Array.isArray(proposalDocument.proposals) || proposalDocument.proposals.length === 0) {
    throw new TypeError('proposals must be a non-empty array.');
  }

  const groupCodes = new Set();
  const assignmentSkus = new Set();
  const groups = [];
  const assignments = [];
  const excluded = [];

  for (const [groupIndex, source] of proposalDocument.proposals.entries()) {
    const standardGoodsCode = requiredText(source?.suggested, `proposals[${groupIndex}].suggested`);
    const modelNormalized = String(source?.suggestedModel ?? '').normalize('NFKC').trim() || null;
    const mappingStatus = requiredText(source?.mappingStatus, `proposals[${groupIndex}].mappingStatus`);
    const sourceAssignments = Array.isArray(source?.assignments) ? source.assignments : [];
    if (sourceAssignments.length === 0) {
      throw new TypeError(`Proposal ${standardGoodsCode} has no SKU assignments.`);
    }
    const normalizedAssignments = sourceAssignments.map((assignment, index) => (
      normalizeAssignment(assignment, `proposals[${groupIndex}].assignments[${index}]`)
    )).sort((left, right) => (
      left.storeCode.localeCompare(right.storeCode)
      || Number(left.fullSkuId) - Number(right.fullSkuId)
    ));

    if (mappingStatus !== 'OWNER_CONFIRMED') {
      excluded.push(...normalizedAssignments.map((assignment) => ({
        ...assignment,
        reason: mappingStatus,
      })));
      continue;
    }
    if (groupCodes.has(standardGoodsCode)) {
      throw new TypeError(`Standard goods code is duplicated: ${standardGoodsCode}`);
    }
    groupCodes.add(standardGoodsCode);
    const namingRule = modelNormalized ? 'MODEL_PLUS_SHEIN_LEAF' : 'PURE_CHINESE';
    const categories = requiredText(source?.categoryName, `${standardGoodsCode}.categoryName`)
      .split('、').map((value) => value.trim()).filter(Boolean).sort();
    const groupCore = {
      standardGoodsCode,
      displayName: standardGoodsCode,
      modelNormalized,
      namingRule,
      confidenceBand: confidenceBand(source?.confidence),
      categories,
      assignments: normalizedAssignments,
    };
    const groupFingerprint = sha256(groupCore);
    groups.push({
      standardGoodsCode,
      displayName: standardGoodsCode,
      modelNormalized,
      namingRule,
      confidenceBand: groupCore.confidenceBand,
      categories,
      groupFingerprint,
      assignmentCount: normalizedAssignments.length,
    });
    for (const assignment of normalizedAssignments) {
      const skuKey = `${assignment.storeCode}:${assignment.fullSkuId}`;
      if (assignmentSkus.has(skuKey)) {
        throw new TypeError(`SKU is assigned more than once: ${skuKey}`);
      }
      assignmentSkus.add(skuKey);
      assignments.push({
        ...assignment,
        standardGoodsCode,
        confidenceBand: groupCore.confidenceBand,
        groupFingerprint,
      });
    }
  }

  groups.sort((left, right) => left.standardGoodsCode.localeCompare(
    right.standardGoodsCode,
    'zh-CN',
    { numeric: true },
  ));
  assignments.sort((left, right) => (
    left.storeCode.localeCompare(right.storeCode)
    || Number(left.fullSkuId) - Number(right.fullSkuId)
  ));
  excluded.sort((left, right) => (
    left.storeCode.localeCompare(right.storeCode)
    || Number(left.fullSkuId) - Number(right.fullSkuId)
  ));

  const plan = {
    schemaVersion: 1,
    sourceGeneratedAt: sourceGeneratedAt.toISOString(),
    approvedAt: approvalTime.toISOString(),
    approvalActor: requiredText(approvalActor, 'approvalActor'),
    approvalText: requiredText(approvalText, 'approvalText'),
    namingPolicy: {
      modeled: '型号 + SHEIN商品发布页末级中文名',
      unmodeled: '纯中文品名；优先现有货号中文描述，无法识别时不归并',
      scope: 'BI_REPORTING_ONLY',
    },
    groups,
    assignments,
    excluded,
  };
  const planHash = sha256(plan);
  if (!HASH_PATTERN.test(planHash)) throw new Error('Unable to generate a valid plan hash.');
  return {
    ...plan,
    assignments: plan.assignments.map((assignment) => ({
      ...assignment,
      assignmentKey: sha256({
        namespace: 'full-managed-reporting-goods-v1',
        planHash,
        storeCode: assignment.storeCode,
        fullSkuId: assignment.fullSkuId,
      }),
    })),
    planHash,
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (['--proposal', '--output', '--approved-at'].includes(token)) {
      result[token.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!result.proposal || !result.output) {
    throw new Error('--proposal and --output are required.');
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const proposal = JSON.parse(await readFile(args.proposal, 'utf8'));
  const manifest = buildReportingGoodsManifest(proposal, {
    approvedAt: args['approved-at'] || new Date().toISOString(),
  });
  await writeFile(args.output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    output: args.output,
    planHash: manifest.planHash,
    groupCount: manifest.groups.length,
    assignmentCount: manifest.assignments.length,
    excludedSkuCount: manifest.excluded.length,
  }, null, 2)}\n`);
}

const executedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === executedPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message).slice(0, 400) })}\n`);
    process.exitCode = 1;
  });
}
