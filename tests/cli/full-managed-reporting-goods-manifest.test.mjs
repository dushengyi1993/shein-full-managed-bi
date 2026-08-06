import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReportingGoodsManifest,
} from '../../scripts/build_full_managed_reporting_goods_manifest.mjs';
import {
  normalizeReportingGoodsManifest,
  reportingGoodsPlanSummary,
} from '../../scripts/import_full_managed_reporting_goods.mjs';

function proposal() {
  return {
    approval: { status: 'OWNER_CONFIRMED' },
    summary: { sourceGeneratedAt: '2026-08-06T01:00:00.000Z' },
    proposals: [
      {
        suggested: 'SK-270空气炸锅',
        suggestedModel: 'SK-270',
        mappingStatus: 'OWNER_CONFIRMED',
        confidence: '高',
        categoryName: '空气炸锅',
        assignments: [
          {
            storeCode: 'DL5477',
            fullSkuId: '1',
            platformSkuId: 'SKU-1',
            platformSkcId: 'SKC-1',
            platformSpuId: 'SPU-1',
          },
        ],
      },
      {
        suggested: '保温杯',
        suggestedModel: '',
        mappingStatus: 'OWNER_CONFIRMED',
        confidence: '低',
        categoryName: '保温杯',
        assignments: [
          {
            storeCode: 'MZ2406',
            fullSkuId: '2',
            platformSkuId: 'SKU-2',
            platformSkcId: 'SKC-2',
            platformSpuId: 'SPU-2',
          },
        ],
      },
      {
        suggested: '待确认品类',
        suggestedModel: '',
        mappingStatus: 'EXCLUDED_INSUFFICIENT_IDENTITY',
        confidence: '低',
        categoryName: '待确认品类',
        assignments: [{ storeCode: 'DL5477', fullSkuId: '3' }],
      },
    ],
  };
}

test('owner-confirmed manifest keeps modeled labels and pure-Chinese no-model labels separate', () => {
  const manifest = buildReportingGoodsManifest(proposal(), {
    approvedAt: '2026-08-06T02:00:00.000Z',
  });
  const normalized = normalizeReportingGoodsManifest(manifest);

  assert.equal(normalized.groups.length, 2);
  assert.equal(normalized.assignments.length, 2);
  assert.equal(normalized.excluded.length, 1);
  assert.deepEqual(
    Object.fromEntries(normalized.groups.map(
      ({ standardGoodsCode, namingRule }) => [standardGoodsCode, namingRule],
    )),
    {
      'SK-270空气炸锅': 'MODEL_PLUS_SHEIN_LEAF',
      保温杯: 'PURE_CHINESE',
    },
  );
  assert.match(normalized.planHash, /^[0-9a-f]{64}$/);
  assert.match(normalized.assignments[0].assignmentKey, /^[0-9a-f]{64}$/);
});

test('manifest rejects a non-Chinese code for a no-model product and duplicate SKU ownership', () => {
  const manifest = buildReportingGoodsManifest(proposal(), {
    approvedAt: '2026-08-06T02:00:00.000Z',
  });
  const drifted = structuredClone(manifest);
  const pure = drifted.groups.find(({ namingRule }) => namingRule === 'PURE_CHINESE');
  pure.standardGoodsCode = 'THERMOS';
  assert.throws(
    () => normalizeReportingGoodsManifest(drifted),
    /Pure-Chinese standard goods code is invalid/,
  );

  const duplicated = proposal();
  duplicated.proposals[1].assignments[0] = {
    storeCode: 'DL5477',
    fullSkuId: '1',
  };
  assert.throws(
    () => buildReportingGoodsManifest(duplicated, {
      approvedAt: '2026-08-06T02:00:00.000Z',
    }),
    /SKU is assigned more than once/,
  );
});

test('dry-run summary distinguishes unchanged, changed and new assignments', () => {
  const manifest = normalizeReportingGoodsManifest(buildReportingGoodsManifest(proposal(), {
    approvedAt: '2026-08-06T02:00:00.000Z',
  }));
  const summary = reportingGoodsPlanSummary(manifest, [
    {
      full_sku_id: '1',
      store_code: 'DL5477',
      platform_sku_id: 'SKU-1',
      platform_skc_id: 'SKC-1',
      platform_spu_id: 'SPU-1',
      is_active: true,
      current_standard_goods_code: 'SK-270空气炸锅',
    },
    {
      full_sku_id: '2',
      store_code: 'MZ2406',
      platform_sku_id: 'SKU-2',
      platform_skc_id: 'SKC-2',
      platform_spu_id: 'SPU-2',
      is_active: true,
      current_standard_goods_code: '旧货号',
    },
  ]);

  assert.equal(summary.unchangedAssignmentCount, 1);
  assert.equal(summary.changedAssignmentCount, 1);
  assert.equal(summary.newAssignmentCount, 0);
  assert.match(summary.planHash, /^[0-9a-f]{64}$/);
});
