import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  atomicWriteJson,
  buildDashboardFromProjectionInput,
  readDashboardProjectionInput,
  splitDashboardArtifacts,
} from '../../src/warehouse/dashboard-materializer.mjs';
import {
  MIXED_STATISTICS_DATES_CODE,
  MIXED_STATISTICS_DATES_MESSAGE,
} from '../../src/warehouse/full-managed-sales-repository.mjs';

function projectionInput() {
  return {
    storePermissions: [
      { storeCode: 'DL', storeName: 'DL', permissionStatus: 'granted' },
      { storeCode: 'DX', storeName: 'DX', permissionStatus: 'pending' },
    ],
    snapshots: [{
      storeCode: 'DL', skuCode: 'SKU-1', salesToday: 0, salesYesterday: 2,
      sales7Days: 7, sales30Days: 30, statisticsDate: '2026-07-20', fetchedAt: '2026-07-20T04:00:00Z',
    }],
    skuNames: new Map([['DL\u001fSKU-1', 'Red']]),
    salesTrend: [
      { storeCode: 'DL', date: '2026-07-19', unitsSold: 2 },
      { storeCode: 'DL', date: '2026-07-20', unitsSold: 0 },
    ],
    storeHealth: [
      {
        storeCode: 'DL', permissionStatus: 'granted', hasFacts: true,
        businessDate: '2026-07-20', watermarkDate: '2026-07-20',
        dateAnchorStatus: 'ANCHORED', qualityStatus: 'VALID',
      },
      { storeCode: 'DX', permissionStatus: 'pending', hasFacts: false },
    ],
    owners: [{ key: 'owner-dl', name: '负责人A', storeCodes: ['DL'] }],
  };
}

test('builds a live dashboard with real readiness and preserves pending stores as null', () => {
  const dashboard = buildDashboardFromProjectionInput(projectionInput(), {
    storeCatalog: [
      { storeCode: 'DL', applicationStatus: 'approved', authorizationStatus: 'authorized' },
      { storeCode: 'DX', applicationStatus: 'approved', authorizationStatus: 'pending' },
    ],
  });
  assert.equal(dashboard.datasetStatus, 'live');
  assert.equal(dashboard.unitsSold.today, 0);
  assert.equal(dashboard.permission.status, 'partial');
  assert.equal(dashboard.storeRanking.find(({ code }) => code === 'DX').unitsSold.today, null);
  assert.equal(dashboard.skuRanking[0].name, 'Red');
  assert.deepEqual(
    dashboard.salesTrend.at(-1),
    { date: '2026-07-20', unitsSold: 0, coveredStores: 1 },
  );
  assert.equal(dashboard.businessDate, '2026-07-20');
  assert.equal(dashboard.storeSkuRanking[0].storeCode, 'DL');
  assert.equal(dashboard.productRanking[0].identityLevel, 'STORE_LOCAL_UNVERIFIED');
  assert.equal(dashboard.storeRanking.find(({ code }) => code === 'DL').ownerKey, 'owner-dl');
  assert.deepEqual(dashboard.owners, [
    { key: 'owner-dl', name: '负责人A', storeCodes: ['DL'] },
  ]);
  assert.equal(dashboard.readiness.find(({ key }) => key === 'fact_load').completed, 1);
});

test('product identity coverage uses the full active catalog instead of dated sales rows', () => {
  const input = projectionInput();
  input.productIdentityCatalog = [
    {
      storeCode: 'DL',
      skuCode: 'SKU-1',
      platformSpuId: 'SPU-1',
      canonicalAssignment: {
        canonicalProductId: '42',
        standardProductCode: 'GLOBAL-42',
      },
    },
    {
      storeCode: 'DL',
      skuCode: 'SKU-WITHOUT-SALES',
      platformSpuId: null,
      canonicalAssignment: null,
    },
    {
      storeCode: 'DX',
      skuCode: 'SKU-PENDING-STORE',
      platformSpuId: 'SPU-3',
      canonicalAssignment: null,
    },
  ];

  const dashboard = buildDashboardFromProjectionInput(input);

  assert.equal(dashboard.storeSkuRanking.length, 1);
  assert.equal(dashboard.productRanking.length, 1);
  assert.deepEqual(dashboard.productIdentityCoverage, {
    basis: 'active_catalog',
    confirmedSkus: 1,
    totalSkus: 3,
    unconfirmedSkus: 2,
    missingSpuSkus: 1,
    coverageRate: 0.3333,
    status: 'partial',
    note: '全量活跃商品目录 1/3 个SKU已确认；1 个缺少平台SPU；覆盖口径不依赖销量业务日',
  });
});

test('product identity coverage counts 38 null, blank and placeholder SPU identifiers', () => {
  const input = projectionInput();
  const missingValues = Array.from({ length: 38 }, (_, index) => {
    if (index === 0) return null;
    if (index === 1) return '';
    if (index === 2) return '   ';
    if (index === 3) return '---';
    return null;
  });
  input.productIdentityCatalog = [
    {
      storeCode: 'DL',
      skuCode: 'SKU-CONFIRMED',
      platformSpuId: 'DL-SPU-1',
      canonicalAssignment: { canonicalProductId: '42' },
    },
    ...missingValues.map((platformSpuId, index) => ({
      storeCode: 'DL',
      skuCode: `SKU-MISSING-${index}`,
      platformSpuId,
      canonicalAssignment: index === 0
        ? { canonicalProductId: 'legacy-assignment-without-spu' }
        : null,
    })),
  ];

  const coverage = buildDashboardFromProjectionInput(input)
    .productIdentityCoverage;

  assert.equal(coverage.totalSkus, 39);
  assert.equal(coverage.confirmedSkus, 1);
  assert.equal(coverage.unconfirmedSkus, 38);
  assert.equal(coverage.missingSpuSkus, 38);
  assert.match(coverage.note, /38 个缺少平台SPU/);
});

test('never merges the same bare SKU across stores and only totals one unified business date', () => {
  const input = {
    storePermissions: [
      { storeCode: 'AA', storeName: 'AA', permissionStatus: 'granted' },
      { storeCode: 'BB', storeName: 'BB', permissionStatus: 'granted' },
    ],
    snapshots: [
      {
        storeCode: 'AA', skuCode: 'SAME-SKU', productKey: 'SKC:SAME',
        salesToday: 1, salesYesterday: 1, sales7Days: 7, sales30Days: 30,
        statisticsDate: '2026-07-20', fetchedAt: '2026-07-20T04:00:00Z',
      },
      {
        storeCode: 'BB', skuCode: 'SAME-SKU', productKey: 'SKC:SAME',
        salesToday: 99, salesYesterday: 99, sales7Days: 99, sales30Days: 99,
        statisticsDate: '2026-07-19', fetchedAt: '2026-07-20T04:00:00Z',
      },
    ],
    skuNames: new Map(),
    salesTrend: [],
    storeHealth: [
      {
        storeCode: 'AA', permissionStatus: 'granted', hasFacts: true,
        watermarkDate: '2026-07-20', qualityStatus: 'VALID',
      },
      {
        storeCode: 'BB', permissionStatus: 'granted', hasFacts: true,
        watermarkDate: '2026-07-19', qualityStatus: 'VALID',
      },
    ],
  };

  const dashboard = buildDashboardFromProjectionInput(input);

  assert.equal(dashboard.businessDate, '2026-07-20');
  assert.equal(dashboard.unitsSold.today, 1);
  assert.equal(dashboard.storeSkuRanking.length, 1);
  assert.equal(dashboard.storeSkuRanking[0].storeCode, 'AA');
  assert.equal(dashboard.storeSkuRanking[0].mappingStatus, 'MISSING_SPU_ID');
  assert.equal(dashboard.productRanking[0].mappingStatus, 'MISSING_SPU_ID');
  assert.equal(dashboard.storeRanking.find(({ code }) => code === 'BB').unitsSold.today, null);
  assert.equal(dashboard.storeRanking.find(({ code }) => code === 'BB').qualityStatus, 'stale');
  assert.equal(dashboard.salesCoverage.status, 'partial');
});

test('trend rejects stores outside the current active full-managed catalog', () => {
  const input = projectionInput();
  input.salesTrend.push({
    storeCode: 'LEGACY',
    date: '2026-07-20',
    unitsSold: 999,
  });
  const dashboard = buildDashboardFromProjectionInput(input);
  assert.deepEqual(dashboard.salesTrend.at(-1), {
    date: '2026-07-20',
    unitsSold: 0,
    coveredStores: 1,
  });
  assert.equal(
    dashboard.salesTrendByStore.some(({ storeCode }) => storeCode === 'LEGACY'),
    false,
  );
});

test('represents a complete zero response without dt as live legal zero rather than an error', () => {
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: [{ storeCode: 'DL', storeName: 'DL', permissionStatus: 'granted' }],
    snapshots: [],
    skuNames: new Map(),
    salesTrend: [],
    storeHealth: [{
      storeCode: 'DL',
      permissionStatus: 'granted',
      hasFacts: false,
      runStatus: 'SUCCEEDED',
      qualityStatus: 'LEGAL_ZERO_UNANCHORED',
      dateAnchorStatus: 'UNANCHORED_ZERO',
      responseSkuCount: 12,
      unitsSold: { today: 0, yesterday: 0, last7Days: 0, last30Days: 0 },
      fetchedAt: '2026-07-20T04:00:00.000Z',
    }],
  });

  assert.equal(dashboard.datasetStatus, 'live');
  assert.equal(dashboard.businessDate, null);
  assert.deepEqual(dashboard.unitsSold, {
    today: 0, yesterday: 0, last7Days: 0, last30Days: 0,
  });
  assert.equal(dashboard.salesCoverage.status, 'legal_zero');
  assert.equal(dashboard.quality.status, 'legal_zero');
  assert.equal(dashboard.storeRanking[0].unitsSold.today, 0);
  assert.equal(dashboard.readiness.find(({ key }) => key === 'fact_load').completed, 1);
});

test('a latest quality-blocked run cannot leak an older accepted watermark into the dashboard', () => {
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: [{ storeCode: 'DL', storeName: 'DL', permissionStatus: 'granted' }],
    snapshots: [{
      storeCode: 'DL',
      skuCode: 'SKU-OLD',
      salesToday: 9,
      salesYesterday: 8,
      sales7Days: 70,
      sales30Days: 300,
      statisticsDate: '2026-07-20',
      fetchedAt: '2026-07-20T04:00:00.000Z',
    }],
    skuNames: new Map([['DL\u001fSKU-OLD', 'Old accepted row']]),
    salesTrend: [{
      storeCode: 'DL',
      date: '2026-07-20',
      unitsSold: 9,
    }],
    storeHealth: [{
      storeCode: 'DL',
      permissionStatus: 'granted',
      hasFacts: true,
      runStatus: 'QUALITY_BLOCKED',
      qualityStatus: 'UNANCHORED_NONZERO',
      dateAnchorStatus: 'BLOCKED',
      watermarkDate: '2026-07-20',
      fetchedAt: '2026-07-20T05:00:00.000Z',
    }],
  });

  assert.equal(dashboard.datasetStatus, 'empty');
  assert.equal(dashboard.quality.status, 'error');
  assert.deepEqual(dashboard.unitsSold, {
    today: null,
    yesterday: null,
    last7Days: null,
    last30Days: null,
  });
  assert.equal(dashboard.storeRanking[0].qualityStatus, 'error');
  assert.equal(dashboard.storeRanking[0].unitsSold.today, null);
  assert.deepEqual(dashboard.storeSkuRanking, []);
  assert.deepEqual(dashboard.productRanking, []);
  assert.deepEqual(dashboard.salesTrendByStore, [{
    storeCode: 'DL',
    date: '2026-07-20',
    unitsSold: 9,
  }]);
  assert.deepEqual(dashboard.salesTrend, [{
    date: '2026-07-20',
    unitsSold: 9,
    coveredStores: 1,
  }]);
});

test('mixed-date quality keeps permission granted while excluding the stale watermark from home totals', () => {
  const currentStoreCodes = Array.from(
    { length: 21 },
    (_, index) => `CURRENT-${String(index + 1).padStart(2, '0')}`,
  );
  const rolloverStoreCodes = Array.from(
    { length: 4 },
    (_, index) => `ROLLOVER-${String(index + 1).padStart(2, '0')}`,
  );
  const storeCodes = [...currentStoreCodes, ...rolloverStoreCodes];
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: storeCodes.map((storeCode) => ({
      storeCode,
      storeName: storeCode,
      permissionStatus: 'granted',
    })),
    snapshots: storeCodes.map((storeCode) => {
      const rollover = rolloverStoreCodes.includes(storeCode);
      return {
        storeCode,
        skuCode: `SKU-${storeCode}`,
        salesToday: rollover ? 99 : 1,
        salesYesterday: rollover ? 98 : 2,
        sales7Days: rollover ? 700 : 7,
        sales30Days: rollover ? 3000 : 30,
        statisticsDate: rollover ? '2026-07-25' : '2026-07-26',
        fetchedAt: rollover
          ? '2026-07-27T02:18:00.000Z'
          : '2026-07-27T04:18:00.000Z',
      };
    }),
    skuNames: new Map(),
    salesTrend: [],
    storeHealth: storeCodes.map((storeCode) => {
      const rollover = rolloverStoreCodes.includes(storeCode);
      const quarantined = storeCode === currentStoreCodes[0];
      return {
        storeCode,
        permissionStatus: 'granted',
        hasFacts: true,
        runStatus: 'SUCCEEDED',
        qualityStatus: rollover || quarantined ? 'PARTIAL' : 'VALID',
        dateAnchorStatus: rollover || quarantined ? 'PARTIAL' : 'ANCHORED',
        quarantinedSkuCount: quarantined ? 19 : 0,
        watermarkDate: rollover ? '2026-07-25' : '2026-07-26',
        fetchedAt: rollover
          ? '2026-07-27T02:18:00.000Z'
          : '2026-07-27T04:18:00.000Z',
        probeAt: '2026-07-27T04:18:00.000Z',
        probeDataQualityReason: rollover ? MIXED_STATISTICS_DATES_CODE : null,
        probeStatisticsDateCount: rollover ? 2 : null,
      };
    }),
  });

  assert.equal(dashboard.permission.authorizedStores, 25);
  assert.equal(dashboard.permission.totalStores, 25);
  assert.equal(dashboard.businessDate, '2026-07-26');
  assert.deepEqual(dashboard.unitsSold, {
    today: 21,
    yesterday: 42,
    last7Days: 147,
    last30Days: 630,
  });
  assert.equal(dashboard.salesCoverage.status, 'partial');
  assert.equal(dashboard.salesCoverage.mixedStatisticsDateStores, 4);
  assert.match(dashboard.salesCoverage.reason, /沿用上一可信水位且未混算/);
  assert.match(dashboard.salesCoverage.reason, /19 个非零SKU因缺少统计日期已隔离/);
  assert.match(dashboard.quality.impact, /不进入当前销售卡片和排行榜/);
  assert.match(dashboard.quality.impact, /缺少统计日期的非零SKU也未计入/);
  assert.match(dashboard.quality.nextStep, /不要选择日期或跨日补零/);
  assert.match(dashboard.quality.nextStep, /检查被隔离SKU并等待有效dt/);

  const rollover = dashboard.storeRanking.find(
    ({ code }) => code === rolloverStoreCodes[0],
  );
  assert.equal(rollover.permissionStatus, 'granted');
  assert.equal(rollover.businessDate, '2026-07-25');
  assert.equal(rollover.qualityStatus, 'stale');
  assert.match(rollover.qualityReason, /检测到 2 个统计日/);
  assert.match(rollover.qualityReason, /未与首页业务日 2026-07-26 混算/);
  assert.deepEqual(rollover.unitsSold, {
    today: null,
    yesterday: null,
    last7Days: null,
    last30Days: null,
  });

  const readiness = new Map(dashboard.readiness.map((stage) => [stage.key, stage]));
  assert.deepEqual(
    {
      permission: readiness.get('sales_permission').completed,
      probe: readiness.get('sales_probe').completed,
      facts: readiness.get('fact_load').completed,
    },
    { permission: 25, probe: 25, facts: 21 },
  );
  assert.match(readiness.get('fact_load').note, /混合统计日期/);
});

test('dated rows remain visible as partial coverage when a small unanchored non-zero subset is quarantined', () => {
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: [{ storeCode: 'DL', storeName: 'DL', permissionStatus: 'granted' }],
    snapshots: [{
      storeCode: 'DL',
      skuCode: 'SKU-DATED',
      salesToday: 3,
      salesYesterday: 4,
      sales7Days: 14,
      sales30Days: 60,
      statisticsDate: '2026-07-20',
      fetchedAt: '2026-07-20T04:00:00.000Z',
    }],
    skuNames: new Map([['DL\u001fSKU-DATED', 'Accepted dated row']]),
    salesTrend: [{ storeCode: 'DL', date: '2026-07-20', unitsSold: 3 }],
    storeHealth: [{
      storeCode: 'DL',
      permissionStatus: 'granted',
      hasFacts: true,
      runStatus: 'SUCCEEDED',
      qualityStatus: 'PARTIAL',
      dateAnchorStatus: 'PARTIAL',
      businessDate: '2026-07-20',
      watermarkDate: '2026-07-20',
      requestedSkuCount: 2,
      responseSkuCount: 2,
      datedSkuCount: 1,
      unanchoredZeroSkuCount: 0,
      quarantinedSkuCount: 1,
      quarantinedSkuCodes: ['SKU-UNANCHORED'],
      fetchedAt: '2026-07-20T04:00:00.000Z',
    }],
  });

  assert.equal(dashboard.datasetStatus, 'live');
  assert.equal(dashboard.businessDate, '2026-07-20');
  assert.equal(dashboard.salesCoverage.status, 'partial');
  assert.equal(dashboard.salesCoverage.partialStores, 1);
  assert.equal(dashboard.salesCoverage.quarantinedRows, 1);
  assert.deepEqual(dashboard.unitsSold, {
    today: 3, yesterday: 4, last7Days: 14, last30Days: 60,
  });
  assert.equal(
    dashboard.quality.impact,
    '销售卡片、趋势和排行榜仅汇总有日期的SKU；隔离SKU未计入，当前数值不是完整总量',
  );
  assert.equal(
    dashboard.quality.nextStep,
    '检查隔离SKU并等待SHEIN返回有效dt后重跑',
  );
  assert.equal(dashboard.storeRanking[0].qualityStatus, 'partial');
  assert.equal(
    dashboard.storeRanking[0].qualityReason,
    '1 个非零SKU缺少统计日期，已隔离：SKU-UNANCHORED',
  );
});

test('one partial store keeps the 25-store home globally partial and exposes quarantine evidence', () => {
  const healthyCodes = Array.from(
    { length: 24 },
    (_, index) => `S${String(index + 1).padStart(2, '0')}`,
  );
  const storeCodes = [...healthyCodes, 'NM7397'];
  const snapshots = storeCodes.map((storeCode) => ({
    storeCode,
    skuCode: `${storeCode}-DATED`,
    salesToday: storeCode === 'NM7397' ? 3 : 1,
    salesYesterday: storeCode === 'NM7397' ? 4 : 1,
    sales7Days: storeCode === 'NM7397' ? 14 : 7,
    sales30Days: storeCode === 'NM7397' ? 60 : 30,
    statisticsDate: '2026-07-25',
    fetchedAt: '2026-07-26T17:00:00.000Z',
  }));
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: storeCodes.map((storeCode) => ({
      storeCode,
      storeName: storeCode,
      permissionStatus: 'granted',
    })),
    snapshots,
    skuNames: new Map(snapshots.map((row) => [
      `${row.storeCode}\u001f${row.skuCode}`,
      row.skuCode,
    ])),
    salesTrend: storeCodes.map((storeCode) => ({
      storeCode,
      date: '2026-07-25',
      unitsSold: storeCode === 'NM7397' ? 3 : 1,
    })),
    storeHealth: storeCodes.map((storeCode) => ({
      storeCode,
      permissionStatus: 'granted',
      hasFacts: true,
      runStatus: 'SUCCEEDED',
      qualityStatus: storeCode === 'NM7397' ? 'PARTIAL' : 'VALID',
      dateAnchorStatus: storeCode === 'NM7397' ? 'PARTIAL' : 'ANCHORED',
      businessDate: '2026-07-25',
      watermarkDate: '2026-07-25',
      requestedSkuCount: storeCode === 'NM7397' ? 548 : 1,
      responseSkuCount: storeCode === 'NM7397' ? 548 : 1,
      datedSkuCount: storeCode === 'NM7397' ? 83 : 1,
      unanchoredZeroSkuCount: storeCode === 'NM7397' ? 463 : 0,
      quarantinedSkuCount: storeCode === 'NM7397' ? 2 : 0,
      quarantinedSkuCodes: storeCode === 'NM7397'
        ? ['NM-SKU-0547', 'NM-SKU-0548']
        : [],
      fetchedAt: '2026-07-26T17:00:00.000Z',
    })),
  });

  assert.equal(dashboard.datasetStatus, 'live');
  assert.equal(dashboard.salesCoverage.status, 'partial');
  assert.equal(dashboard.salesCoverage.coveredStores, 25);
  assert.equal(dashboard.salesCoverage.totalStores, 25);
  assert.equal(dashboard.salesCoverage.partialStores, 1);
  assert.equal(dashboard.salesCoverage.quarantinedRows, 2);
  assert.match(dashboard.salesCoverage.reason, /2 个非零SKU/);
  assert.equal(dashboard.quality.status, 'partial');
  assert.match(dashboard.quality.impact, /当前数值不是完整总量/);
  assert.deepEqual(dashboard.unitsSold, {
    today: 27,
    yesterday: 28,
    last7Days: 182,
    last30Days: 780,
  });
  const nm = dashboard.storeRanking.find(({ code }) => code === 'NM7397');
  assert.equal(nm.qualityStatus, 'partial');
  assert.match(nm.qualityReason, /NM-SKU-0547、NM-SKU-0548/);
  assert.equal(dashboard.productRanking.length, 25);
});

test('legal zero never turns blocked or missing stores into a global zero', () => {
  const legalZeroHealth = {
    storeCode: 'AA',
    permissionStatus: 'granted',
    hasFacts: false,
    runStatus: 'SUCCEEDED',
    qualityStatus: 'LEGAL_ZERO_UNANCHORED',
    dateAnchorStatus: 'UNANCHORED_ZERO',
    unitsSold: { today: 0, yesterday: 0, last7Days: 0, last30Days: 0 },
  };
  const blocked = buildDashboardFromProjectionInput({
    storePermissions: [
      { storeCode: 'AA', storeName: 'AA', permissionStatus: 'granted' },
      { storeCode: 'BB', storeName: 'BB', permissionStatus: 'granted' },
    ],
    snapshots: [],
    salesTrend: [],
    skuNames: new Map(),
    storeHealth: [
      legalZeroHealth,
      {
        storeCode: 'BB',
        permissionStatus: 'granted',
        runStatus: 'QUALITY_BLOCKED',
        qualityStatus: 'UNANCHORED_NONZERO',
        dateAnchorStatus: 'BLOCKED',
      },
    ],
  });
  assert.equal(blocked.salesCoverage.status, 'blocked');
  assert.deepEqual(blocked.unitsSold, {
    today: null,
    yesterday: null,
    last7Days: null,
    last30Days: null,
  });

  const partial = buildDashboardFromProjectionInput({
    storePermissions: [
      { storeCode: 'AA', storeName: 'AA', permissionStatus: 'granted' },
      { storeCode: 'BB', storeName: 'BB', permissionStatus: 'pending' },
    ],
    snapshots: [],
    salesTrend: [],
    skuNames: new Map(),
    storeHealth: [legalZeroHealth],
  });
  assert.equal(partial.salesCoverage.status, 'partial');
  assert.deepEqual(partial.unitsSold, {
    today: null,
    yesterday: null,
    last7Days: null,
    last30Days: null,
  });
});

test('a latest legal-zero observation keeps previously accepted dated trend history', () => {
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: [{ storeCode: 'DL', storeName: 'DL', permissionStatus: 'granted' }],
    snapshots: [{
      storeCode: 'DL',
      skuCode: 'SKU-HISTORY',
      statisticsDate: '2026-07-19',
      fetchedAt: '2026-07-19T04:00:00.000Z',
      salesToday: 7,
      salesYesterday: 6,
      sales7Days: 30,
      sales30Days: 90,
    }],
    salesTrend: [{
      storeCode: 'DL',
      date: '2026-07-19',
      unitsSold: 7,
    }],
    skuNames: new Map(),
    storeHealth: [{
      storeCode: 'DL',
      permissionStatus: 'granted',
      runStatus: 'SUCCEEDED',
      qualityStatus: 'LEGAL_ZERO_UNANCHORED',
      dateAnchorStatus: 'UNANCHORED_ZERO',
      watermarkDate: '2026-07-19',
      unitsSold: { today: 0, yesterday: 0, last7Days: 0, last30Days: 0 },
    }],
  });
  assert.equal(dashboard.salesCoverage.status, 'legal_zero');
  assert.equal(dashboard.unitsSold.today, 0);
  assert.deepEqual(dashboard.salesTrend, [{
    date: '2026-07-19',
    unitsSold: 7,
    coveredStores: 1,
  }]);
});

test('confirmed canonical assignments aggregate across stores with an RBAC-safe store breakdown', () => {
  const assignment = {
    canonicalProductId: '42',
    standardProductCode: 'STD-42',
    standardProductName: 'Standard kettle',
  };
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: [
      { storeCode: 'AA', storeName: 'AA', permissionStatus: 'granted' },
      { storeCode: 'BB', storeName: 'BB', permissionStatus: 'granted' },
    ],
    snapshots: ['AA', 'BB'].map((storeCode, index) => ({
      storeCode,
      skuCode: `SKU-${index}`,
      productKey: `SKC:${index}`,
      canonicalAssignment: assignment,
      salesToday: index + 1,
      salesYesterday: 0,
      sales7Days: index + 1,
      sales30Days: index + 1,
      statisticsDate: '2026-07-20',
      fetchedAt: '2026-07-20T04:00:00Z',
    })),
    skuNames: new Map(),
    salesTrend: [],
    storeHealth: ['AA', 'BB'].map((storeCode) => ({
      storeCode, permissionStatus: 'granted', hasFacts: true,
      watermarkDate: '2026-07-20', qualityStatus: 'VALID',
    })),
  });

  assert.equal(dashboard.productRanking.length, 1);
  assert.equal(dashboard.productRanking[0].identityLevel, 'CANONICAL_CONFIRMED');
  assert.equal(dashboard.productRanking[0].unitsSold.today, 3);
  assert.deepEqual(
    dashboard.productRanking[0].storeBreakdown.map(({ storeCode }) => storeCode),
    ['AA', 'BB'],
  );
});

test('database materialization admits only active GLOBAL canonical assignments', async () => {
  let canonicalSql = '';
  const client = {
    async query(sql) {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes("to_regclass('dim.canonical_product')")) {
        return { rows: [{
          has_canonical_product: true,
          has_canonical_assignment: true,
          has_canonical_identity_scope: true,
          has_assignment_identity_scope: true,
          has_employee_principal: false,
          has_employee_assignment: false,
        }] };
      }
      if (sql.includes('FROM dim.full_sku_canonical_assignment assignment')) {
        canonicalSql = sql;
        return { rows: [{
          store_code: 'DL',
          platform_sku_id: 'SKU-1',
          canonical_product_id: '42',
          canonical_product_key: 'GLOBAL-42',
          display_name: 'Global kettle',
        }] };
      }
      if (sql.includes('HAVING count(DISTINCT')) {
        return { rows: [{
          store_code: 'DL',
          platform_sku_id: 'SKU-1',
          platform_skc_id: 'SKC-1',
          product_key: 'SPU:1',
          display_name: 'Kettle',
          business_date: '2026-07-20',
          fetched_at: new Date('2026-07-20T04:00:00Z'),
          sales_today: '1',
          sales_yesterday: '2',
          sales_7_days: '7',
          sales_30_days: '30',
        }] };
      }
      if (sql.includes('FROM dim.store s')) {
        return { rows: [{
          store_code: 'DL',
          store_name: 'DL',
          outcome: 'GRANTED',
          business_date: '2026-07-20',
          watermark_date: '2026-07-20',
          has_facts: true,
        }] };
      }
      if (sql.includes('FROM dim.full_sku sku')) {
        return { rows: [
          {
            store_code: 'DL',
            platform_sku_id: 'SKU-1',
            platform_spu_id: 'SPU-1',
            display_name: 'Kettle',
          },
          {
            store_code: 'DL',
            platform_sku_id: 'SKU-WITHOUT-SALES',
            platform_spu_id: null,
            display_name: 'No sales yet',
          },
          {
            store_code: 'DL',
            platform_sku_id: 'SKU-PLACEHOLDER-SPU',
            platform_spu_id: '---',
            display_name: 'Placeholder SPU',
          },
        ] };
      }
      if (sql.includes('daily_candidates')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
    release() {},
  };

  const input = await readDashboardProjectionInput({
    async connect() { return client; },
  });

  assert.equal(
    input.snapshots[0].canonicalAssignment.standardProductCode,
    'GLOBAL-42',
  );
  assert.deepEqual(input.productIdentityCatalog, [
    {
      storeCode: 'DL',
      skuCode: 'SKU-1',
      platformSpuId: 'SPU-1',
      canonicalAssignment: {
        canonicalProductId: '42',
        standardProductCode: 'GLOBAL-42',
        standardProductName: 'Global kettle',
      },
    },
    {
      storeCode: 'DL',
      skuCode: 'SKU-WITHOUT-SALES',
      platformSpuId: null,
      canonicalAssignment: null,
    },
    {
      storeCode: 'DL',
      skuCode: 'SKU-PLACEHOLDER-SPU',
      platformSpuId: null,
      canonicalAssignment: null,
    },
  ]);
  assert.equal(
    buildDashboardFromProjectionInput(input).productIdentityCoverage.missingSpuSkus,
    2,
  );
  assert.match(canonicalSql, /assignment\.identity_scope = 'GLOBAL'/);
  assert.match(canonicalSql, /cp\.identity_scope = 'GLOBAL'/);
  assert.match(canonicalSql, /cp\.status = 'ACTIVE'/);
  assert.match(canonicalSql, /assignment\.assignment_status = 'CONFIRMED'/);
  assert.match(canonicalSql, /assignment\.valid_to IS NULL/);
});

test('empty production database emits no sample or invented zero metrics', () => {
  const dashboard = buildDashboardFromProjectionInput({
    storePermissions: [], snapshots: [], skuNames: new Map(), salesTrend: [], storeHealth: [],
  }, {
    storeCatalog: [{ storeCode: 'DL', storeName: 'DL', applicationStatus: 'approved' }],
  });
  assert.equal(dashboard.datasetStatus, 'empty');
  assert.equal(dashboard.permission.status, 'pending');
  assert.equal(dashboard.updatedAt, null);
  assert.deepEqual(dashboard.unitsSold, {
    today: null, yesterday: null, last7Days: null, last30Days: null,
  });
  assert.deepEqual(dashboard.skuRanking, []);
  assert.equal(JSON.stringify(dashboard).includes('sample'), false);
});

test('legacy mixed-date probes are narrowly upgraded while other ERROR probes stay unknown', async () => {
  const readQueries = [];
  const storeRows = [
    {
      store_code: 'LEGACY-MIXED',
      store_name: 'Legacy mixed',
      outcome: 'ERROR',
      platform_error_code: 'SYNC_ERROR',
      platform_message: MIXED_STATISTICS_DATES_MESSAGE,
      evidence: {},
      probed_at: new Date('2026-07-27T04:18:00.000Z'),
      watermark_date: '2026-07-25',
      has_facts: true,
    },
    {
      store_code: 'WRONG-CODE',
      store_name: 'Wrong code',
      outcome: 'ERROR',
      platform_error_code: 'OTHER_ERROR',
      platform_message: MIXED_STATISTICS_DATES_MESSAGE,
      evidence: {},
      probed_at: new Date('2026-07-27T04:18:00.000Z'),
      has_facts: false,
    },
    {
      store_code: 'WRONG-MESSAGE',
      store_name: 'Wrong message',
      outcome: 'ERROR',
      platform_error_code: 'SYNC_ERROR',
      platform_message: `${MIXED_STATISTICS_DATES_MESSAGE} changed`,
      evidence: {},
      probed_at: new Date('2026-07-27T04:18:00.000Z'),
      has_facts: false,
    },
  ];
  const client = {
    async query(sql) {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      readQueries.push(sql);
      if (sql.includes('AS run_status')) return { rows: storeRows };
      if (sql.includes('HAVING count(DISTINCT')) return { rows: [] };
      if (sql.includes('daily_candidates')) return { rows: [] };
      if (sql.includes('SELECT s.store_code, sku.platform_sku_id, sku.platform_spu_id')) {
        return { rows: [] };
      }
      if (sql.includes("to_regclass('dim.canonical_product')")) {
        return { rows: [{
          has_canonical_product: false,
          has_canonical_assignment: false,
          has_canonical_identity_scope: false,
          has_assignment_identity_scope: false,
          has_employee_principal: false,
          has_employee_assignment: false,
        }] };
      }
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
    release() {},
  };

  const input = await readDashboardProjectionInput({
    async connect() { return client; },
  });

  assert.deepEqual(
    input.storePermissions.map(({ storeCode, permissionStatus }) => ({
      storeCode,
      permissionStatus,
    })),
    [
      { storeCode: 'LEGACY-MIXED', permissionStatus: 'granted' },
      { storeCode: 'WRONG-CODE', permissionStatus: 'unknown' },
      { storeCode: 'WRONG-MESSAGE', permissionStatus: 'unknown' },
    ],
  );
  assert.equal(
    input.storeHealth.find(({ storeCode }) => storeCode === 'LEGACY-MIXED')
      .probeDataQualityReason,
    MIXED_STATISTICS_DATES_CODE,
  );
  assert.equal(
    input.storeHealth.find(({ storeCode }) => storeCode === 'WRONG-CODE')
      .probeDataQualityReason,
    null,
  );
  assert.equal(
    input.storeHealth.find(({ storeCode }) => storeCode === 'WRONG-MESSAGE')
      .probeDataQualityReason,
    null,
  );

  const latestProbeQueries = readQueries.filter((sql) => sql.includes('WITH latest_probe AS'));
  assert.equal(latestProbeQueries.length, 3);
  for (const sql of latestProbeQueries) {
    assert.match(sql, /outcome = 'ERROR'/);
    assert.match(sql, /platform_error_code = 'SYNC_ERROR'/);
    assert.ok(sql.includes(`platform_message = '${MIXED_STATISTICS_DATES_MESSAGE}'`));
  }
});

test('reads only complete four-window snapshots and latest probe state from PostgreSQL rows', async () => {
  const transactionQueries = [];
  const readQueries = [];
  const client = {
    released: false,
    async query(sql) {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') {
        transactionQueries.push(sql);
        return { rows: [] };
      }
      readQueries.push(sql);
      if (sql.includes("HAVING count(DISTINCT")) return { rows: [{
        store_code: 'DL', platform_sku_id: 'SKU-1', fetched_at: new Date('2026-07-20T04:00:00Z'),
        business_date: '2026-07-20', display_name: 'Red', product_key: 'SKC:1',
        sales_today: '0', sales_yesterday: '2',
        sales_7_days: '7', sales_30_days: '30', window_count: '4',
      }] };
      if (sql.includes('FROM dim.store s')) return { rows: [{
        store_code: 'DL', store_name: 'DL', outcome: 'GRANTED', probed_at: new Date('2026-07-20T04:00:00Z'), has_facts: true,
      }] };
      if (sql.includes('display_name')) return { rows: [{
        store_code: 'DL', platform_sku_id: 'SKU-1', display_name: 'Red',
      }] };
      if (sql.includes('daily_candidates')) return { rows: [{
        store_code: 'DL', sales_date: '2026-07-20', units_sold: '0',
      }] };
      if (sql.includes("to_regclass('dim.canonical_product')")) return { rows: [{
        has_canonical_product: false, has_canonical_assignment: false,
      }] };
      throw new Error('Unexpected query');
    },
    release() { this.released = true; },
  };
  const input = await readDashboardProjectionInput({ async connect() { return client; } });
  assert.equal(input.snapshots[0].statisticsDate, '2026-07-20');
  assert.equal(input.snapshots[0].salesToday, 0);
  assert.equal(input.storePermissions[0].permissionStatus, 'granted');
  assert.equal(
    readQueries.some((sql) => sql.includes(
      "to_char(r.business_date, 'YYYY-MM-DD') AS business_date",
    )),
    true,
  );
  assert.equal(
    readQueries.some((sql) => sql.includes(
      "to_char(w.business_date, 'YYYY-MM-DD') AS watermark_date",
    )),
    true,
  );
  assert.equal(
    readQueries.some((sql) => sql.includes(
      "to_char(daily.sales_date, 'YYYY-MM-DD') AS sales_date",
    )),
    true,
  );
  assert.deepEqual(transactionQueries, [
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'COMMIT',
  ]);
  assert.equal(client.released, true);
});

test('rolls back the repeatable-read snapshot if dashboard projection fails', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') return { rows: [] };
      throw new Error('synthetic read failure');
    },
    release() { queries.push('RELEASE'); },
  };
  await assert.rejects(
    () => readDashboardProjectionInput({ async connect() { return client; } }),
    /synthetic read failure/,
  );
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.ok(queries.includes('ROLLBACK'));
  assert.equal(queries.at(-1), 'RELEASE');
});

test('atomically writes dashboard JSON with a trailing newline', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fm-dashboard-'));
  try {
    const file = path.join(directory, 'dashboard.json');
    await atomicWriteJson(file, { datasetStatus: 'empty' });
    assert.equal(await readFile(file, 'utf8'), '{\n  "datasetStatus": "empty"\n}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('splits the small dashboard core from the homepage history section', () => {
  const artifacts = splitDashboardArtifacts({
    datasetStatus: 'live',
    updatedAt: '2026-07-31T00:00:00.000Z',
    storeRanking: [{ code: 'DL5477' }],
    home: {
      status: 'available',
      coverage: {
        storeDailyRows: 1,
        latestObservedAt: '2026-08-01T08:00:00.000Z',
      },
      storeDaily: [{ storeCode: 'DL5477', date: '2026-07-31' }],
      productFinanceDaily: [{ productKey: 'SKC-1' }],
    },
  });
  assert.deepEqual(artifacts.core.home, {
    status: 'available',
    coverage: {
      storeDailyRows: 1,
      latestObservedAt: '2026-08-01T08:00:00.000Z',
    },
  });
  assert.equal('storeDaily' in artifacts.core.home, false);
  assert.equal(artifacts.home.home.storeDaily.length, 1);
  assert.equal(artifacts.home.updatedAt, '2026-08-01T08:00:00.000Z');
});
