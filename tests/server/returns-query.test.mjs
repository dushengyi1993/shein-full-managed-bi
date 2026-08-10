import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RETURNS_DOMAIN_IDS,
  ReturnsQueryError,
  queryReturnsDashboard,
} from '../../src/server/returns-query.mjs';
import {
  containsNumericPii,
  containsSensitiveText,
  isDeniedKeyName,
  validateOrderManagementRow,
} from '../../src/order-management/order-management-contract.mjs';
import { normalizeDashboardData } from '../../src/server/dashboard-data.mjs';

const DASHBOARD = Object.freeze({
  updatedAt: '2026-08-11T01:00:00.000Z',
  stores: Object.freeze([
    { code: 'DL5477', name: 'DL5477' },
    { code: 'MZ2406', name: 'MZ2406' },
    { code: 'JY8060', name: 'JY8060' },
  ]),
  owners: Object.freeze([
    { key: 'owner-a', storeCodes: Object.freeze(['DL5477', 'MZ2406']) },
    { key: 'owner-b', storeCodes: Object.freeze(['JY8060']) },
  ]),
});

function caseRow(overrides = {}) {
  return Object.freeze({
    id: 'CASE-1',
    storeCode: 'DL5477',
    statusCode: 'OPEN',
    statusName: '待处理',
    primary: 'RA-1001',
    secondary: '采购退供',
    tags: Object.freeze(['质检待办']),
    metrics: Object.freeze([]),
    facts: Object.freeze([{ name: 'returnReasonName', value: '商品缺货' }]),
    details: Object.freeze([]),
    createdAt: '2026-08-01T02:00:00.000Z',
    updatedAt: '2026-08-10T03:00:00.000Z',
    ...overrides,
  });
}

function orderManagement(overrides = {}) {
  return Object.freeze({
    schemaVersion: 1,
    updatedAt: '2026-08-11T01:00:00.000Z',
    coverage: {
      status: 'PARTIAL',
      expectedStoreCount: 3,
      completedStoreCount: 2,
      storeCodes: Object.freeze(['DL5477', 'MZ2406']),
    },
    pageCoverage: Object.freeze({
      'return-applications': {
        status: 'COMPLETE',
        expectedStoreCount: 3,
        completedStoreCount: 3,
        storeCodes: Object.freeze(['DL5477', 'MZ2406', 'JY8060']),
      },
      'return-orders': {
        status: 'PARTIAL',
        expectedStoreCount: 3,
        completedStoreCount: 1,
        storeCodes: Object.freeze(['DL5477']),
      },
      exceptions: {
        status: 'UNAVAILABLE',
        expectedStoreCount: 3,
        completedStoreCount: 0,
        storeCodes: Object.freeze([]),
      },
      'quality-reports': {
        status: 'COMPLETE',
        expectedStoreCount: 3,
        completedStoreCount: 3,
        storeCodes: Object.freeze(['DL5477', 'MZ2406', 'JY8060']),
      },
    }),
    pages: Object.freeze({
      'return-applications': {
        status: 'AVAILABLE',
        source: 'WEBAPI_RETURN_APPLICATION',
        latestSourceFetchedAt: '2026-08-11T00:55:00.000Z',
        reason: null,
        rows: Object.freeze([
          caseRow({ id: 'RA-1', primary: 'RA-1001', statusName: '待审核' }),
          caseRow({ id: 'RA-2', storeCode: 'MZ2406', primary: 'RA-2002', statusName: '已确认' }),
          caseRow({ id: 'RA-3', storeCode: 'JY8060', primary: 'RA-3003', statusName: '待审核' }),
        ]),
      },
      'return-orders': {
        status: 'PARTIAL',
        source: 'WEBAPI_RETURN_ORDER',
        latestSourceFetchedAt: '2026-08-11T00:54:00.000Z',
        reason: '一个窗口缺少统计日期',
        rows: Object.freeze([
          caseRow({ id: 'RO-1', primary: 'RO-7001', statusName: '运输中' }),
        ]),
      },
      exceptions: {
        status: 'UNAVAILABLE',
        source: null,
        latestSourceFetchedAt: null,
        reason: '该业务域尚无可用事实',
        rows: Object.freeze([]),
      },
      'quality-reports': {
        status: 'AVAILABLE',
        source: 'WEBAPI_QUALITY_REPORT',
        latestSourceFetchedAt: '2026-08-11T00:53:00.000Z',
        reason: null,
        rows: Object.freeze([
          caseRow({
            id: 'QR-1',
            primary: 'QC-9001',
            statusName: '有差异',
            facts: Object.freeze([{ name: 'inspectionResultName', value: '复检' }]),
          }),
          caseRow({ id: 'QR-2', storeCode: 'MZ2406', primary: 'QC-9002', statusName: '通过' }),
        ]),
      },
    }),
    ...overrides,
  });
}

test('returns query is a read-only four-domain surface with honest coverage', () => {
  const result = queryReturnsDashboard(DASHBOARD, orderManagement());

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.readOnly, true);
  assert.equal(result.updatedAt, '2026-08-11T01:00:00.000Z');
  assert.deepEqual(RETURNS_DOMAIN_IDS, [
    'return-applications',
    'return-orders',
    'exceptions',
    'quality-reports',
  ]);
  assert.deepEqual(Object.keys(result.domains), RETURNS_DOMAIN_IDS);
  assert.deepEqual(result.scope, {
    owner: 'ALL',
    store: 'ALL',
    query: '',
    storeCount: 3,
    storeCodes: Object.freeze(['DL5477', 'JY8060', 'MZ2406']),
  });
  assert.equal(result.summary.totalDomainCount, 4);
  assert.equal(result.summary.availableDomainCount, 3);
  assert.equal(result.summary.allDomainsKnown, false);
  assert.equal(result.summary.matchedMaterializedRows, 6);

  const applications = result.domains['return-applications'];
  assert.equal(applications.status, 'AVAILABLE');
  assert.deepEqual(applications.coverage, {
    status: 'COMPLETE',
    expectedStoreCount: 3,
    completedStoreCount: 3,
    completedStoreCodes: Object.freeze(['DL5477', 'JY8060', 'MZ2406']),
    missingStoreCodes: Object.freeze([]),
    reason: null,
  });
  assert.equal(applications.matchedRows, 3);
  assert.equal(applications.returnedRows, 3);
  assert.equal(applications.truncated, false);

  const exceptions = result.domains.exceptions;
  assert.equal(exceptions.status, 'UNAVAILABLE');
  assert.equal(exceptions.matchedRows, null);
  assert.equal(exceptions.returnedRows, 0);
  assert.deepEqual(exceptions.rows, []);
  assert.equal(exceptions.reason, '该业务域尚无可用事实');
  assert.equal(exceptions.coverage.status, 'UNAVAILABLE');
  assert.deepEqual(exceptions.coverage.missingStoreCodes, ['DL5477', 'JY8060', 'MZ2406']);
});

test('returns scope uses the normalized store ranking and owner roster', () => {
  const dashboard = normalizeDashboardData({
    updatedAt: '2026-08-11T01:00:00.000Z',
    storeRanking: [{ code: 'DL5477', name: 'DL5477' }],
    owners: [{ key: 'owner-a', storeCodes: ['DL5477'] }],
  });
  assert.equal(Object.hasOwn(dashboard, 'stores'), false);

  const result = queryReturnsDashboard(dashboard, orderManagement());
  assert.equal(result.scope.storeCount, 1);
  assert.deepEqual(result.scope.storeCodes, ['DL5477']);
  assert.equal(result.domains['return-applications'].matchedRows, 1);

  const scoped = queryReturnsDashboard(
    dashboard,
    orderManagement(),
    new URLSearchParams('store=DL5477'),
  );
  assert.equal(scoped.scope.storeCount, 1);
});

test('PARTIAL pages with an empty window stay PARTIAL and are never a complete zero', () => {
  const orderManagementWithEmptyOrders = orderManagement({
    pageCoverage: Object.freeze({
      ...orderManagement().pageCoverage,
      exceptions: {
        status: 'COMPLETE',
        expectedStoreCount: 3,
        completedStoreCount: 3,
        storeCodes: Object.freeze(['DL5477', 'MZ2406', 'JY8060']),
      },
    }),
    pages: Object.freeze({
      ...orderManagement().pages,
      'return-orders': {
        status: 'PARTIAL',
        source: 'WEBAPI_RETURN_ORDER',
        latestSourceFetchedAt: '2026-08-11T00:54:00.000Z',
        reason: '一个窗口缺少统计日期',
        rows: Object.freeze([]),
      },
      exceptions: {
        status: 'AVAILABLE',
        source: 'WEBAPI_EXCEPTION',
        latestSourceFetchedAt: '2026-08-11T00:52:00.000Z',
        reason: null,
        rows: Object.freeze([
          caseRow({ id: 'EX-1', storeCode: 'JY8060', primary: 'EX-6001', statusName: '待处理' }),
        ]),
      },
    }),
  });

  const result = queryReturnsDashboard(DASHBOARD, orderManagementWithEmptyOrders);
  const orders = result.domains['return-orders'];

  // The page keeps its own PARTIAL status; an empty materialized window is
  // reported as zero matched rows, never promoted to a COMPLETE business zero.
  assert.equal(orders.status, 'PARTIAL');
  assert.equal(orders.coverage.status, 'PARTIAL');
  assert.equal(orders.coverage.expectedStoreCount, 3);
  assert.equal(orders.coverage.completedStoreCount, 1);
  assert.deepEqual(orders.coverage.missingStoreCodes, ['JY8060', 'MZ2406']);
  assert.equal(orders.matchedRows, 0);
  assert.equal(orders.returnedRows, 0);
  assert.equal(orders.truncated, false);
  assert.deepEqual(orders.rows, []);

  // The zero is still a known materialized window, not a missing domain.
  assert.equal(result.summary.totalDomainCount, 4);
  assert.equal(result.summary.availableDomainCount, 4);
  assert.equal(result.summary.allDomainsKnown, true);
  assert.equal(result.summary.matchedMaterializedRows, 6);

  // Each domain keeps its own coverage; empty orders do not affect the others.
  assert.equal(result.domains['return-applications'].coverage.status, 'COMPLETE');
  assert.equal(result.domains['quality-reports'].coverage.status, 'COMPLETE');
  assert.equal(result.domains.exceptions.coverage.status, 'COMPLETE');
});

test(
  'PARTIAL page with full store coverage must not report COMPLETE coverage with zero rows',
  () => {
    const dashboard = {
      stores: [{ code: 'DL5477' }],
      owners: [{ key: 'owner-a', storeCodes: ['DL5477'] }],
    };
    const index = orderManagement({
      coverage: {
        status: 'PARTIAL',
        expectedStoreCount: 1,
        completedStoreCount: 1,
        storeCodes: ['DL5477'],
      },
      pageCoverage: {
        'return-orders': {
          status: 'PARTIAL',
          expectedStoreCount: 1,
          completedStoreCount: 1,
          storeCodes: ['DL5477'],
        },
      },
      pages: {
        'return-orders': {
          status: 'PARTIAL',
          source: 'WEBAPI_RETURN_ORDER',
          latestSourceFetchedAt: '2026-08-11T00:54:00.000Z',
          reason: 'ROWS_REJECTED_PII:1',
          rows: [],
        },
      },
    });
    const result = queryReturnsDashboard(dashboard, index);
    const orders = result.domains['return-orders'];
    assert.equal(orders.status, 'PARTIAL');
    assert.notEqual(orders.coverage.status, 'COMPLETE');
    assert.equal(orders.matchedRows, 0);
  },
);

test('owner and store scope are strict and reject cross-store or unknown targets', () => {
  const owner = queryReturnsDashboard(
    DASHBOARD,
    orderManagement(),
    new URLSearchParams('owner=owner-a'),
  );
  assert.deepEqual(owner.scope.storeCodes, ['DL5477', 'MZ2406']);
  assert.equal(owner.scope.storeCount, 2);
  for (const domain of Object.values(owner.domains)) {
    assert.equal(
      domain.rows.every((row) => ['DL5477', 'MZ2406'].includes(row.storeCode)),
      true,
    );
  }
  assert.equal(owner.domains['return-applications'].matchedRows, 2);
  assert.equal(owner.domains['return-orders'].matchedRows, 1);
  assert.equal(owner.domains['quality-reports'].matchedRows, 2);
  assert.equal(owner.summary.matchedMaterializedRows, 5);

  const store = queryReturnsDashboard(
    DASHBOARD,
    orderManagement(),
    new URLSearchParams('store=JY8060'),
  );
  assert.deepEqual(store.scope.storeCodes, ['JY8060']);
  assert.equal(store.domains['return-applications'].matchedRows, 1);
  assert.equal(store.domains['quality-reports'].matchedRows, 0);

  assert.throws(
    () => queryReturnsDashboard(
      DASHBOARD,
      orderManagement(),
      new URLSearchParams('owner=owner-a&store=JY8060'),
    ),
    (error) => error instanceof ReturnsQueryError && error.code === 'QUERY_SCOPE_CONFLICT',
  );
  assert.throws(
    () => queryReturnsDashboard(
      DASHBOARD,
      orderManagement(),
      new URLSearchParams('owner=missing'),
    ),
    (error) => error instanceof ReturnsQueryError && error.code === 'QUERY_OWNER_UNKNOWN',
  );
  assert.throws(
    () => queryReturnsDashboard(
      DASHBOARD,
      orderManagement(),
      new URLSearchParams('store=ZZZZ'),
    ),
    (error) => error instanceof ReturnsQueryError && error.code === 'QUERY_STORE_UNKNOWN',
  );
});

test('search matches the documented row surface and stays scoped', () => {
  const byId = queryReturnsDashboard(
    DASHBOARD,
    orderManagement(),
    new URLSearchParams('q=RA-1001'),
  );
  assert.equal(byId.domains['return-applications'].matchedRows, 1);
  assert.equal(byId.domains['return-applications'].rows[0].primary, 'RA-1001');
  assert.equal(byId.domains['return-orders'].matchedRows, 0);

  const byFact = queryReturnsDashboard(
    DASHBOARD,
    orderManagement(),
    new URLSearchParams('q=缺货'),
  );
  assert.equal(byFact.domains['return-applications'].matchedRows, 3);

  const byStore = queryReturnsDashboard(
    DASHBOARD,
    orderManagement(),
    new URLSearchParams('q=DL5477'),
  );
  assert.equal(byStore.domains['return-applications'].matchedRows, 1);
  assert.equal(byStore.domains['return-orders'].matchedRows, 1);
  assert.equal(byStore.domains['quality-reports'].matchedRows, 1);
});

test('returns query rejects unknown, duplicate, invalid and oversized parameters', () => {
  for (const params of [
    new URLSearchParams('unknown=1'),
    new URLSearchParams('owner=owner-a&owner=owner-b'),
    new URLSearchParams('store=DL5477&store=MZ2406'),
    new URLSearchParams(`q=${'x'.repeat(121)}`),
    new URLSearchParams(`owner=${'x'.repeat(65)}`),
    new URLSearchParams('owner=bad owner!'),
    new URLSearchParams('store=abc'),
    new URLSearchParams('store=TOOLONGSTORE1'),
  ]) {
    assert.throws(
      () => queryReturnsDashboard(DASHBOARD, orderManagement(), params),
      ReturnsQueryError,
    );
  }
});

test('returns query truncates at the result limit and reports it honestly', () => {
  const rows = [];
  for (let index = 0; index < 101; index += 1) {
    const storeCode = index < 34 ? 'DL5477' : index < 68 ? 'MZ2406' : 'JY8060';
    rows.push(caseRow({
      id: `RA-BULK-${String(index).padStart(3, '0')}`,
      storeCode,
      primary: `RA-BULK-${String(index).padStart(3, '0')}`,
      updatedAt: `2026-08-10T${String(23 - Math.floor(index / 60)).padStart(2, '0')}:${String(59 - (index % 60)).padStart(2, '0')}:00.000Z`,
    }));
  }
  const result = queryReturnsDashboard(
    DASHBOARD,
    orderManagement({
      pages: Object.freeze({
        ...orderManagement().pages,
        'return-applications': {
          status: 'AVAILABLE',
          source: 'WEBAPI_RETURN_APPLICATION',
          latestSourceFetchedAt: '2026-08-11T00:55:00.000Z',
          reason: null,
          rows: Object.freeze(rows),
        },
      }),
    }),
  );
  const applications = result.domains['return-applications'];
  assert.equal(applications.matchedRows, 101);
  assert.equal(applications.returnedRows, 100);
  assert.equal(applications.truncated, true);
  assert.equal(applications.rows.length, 100);
  assert.equal(result.summary.matchedMaterializedRows, 104);
});

test('returns response exposes no credentials or PII keys or values', () => {
  const result = queryReturnsDashboard(DASHBOARD, orderManagement());
  const keys = [];
  const collectKeys = (value) => {
    if (Array.isArray(value)) {
      value.forEach(collectKeys);
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        keys.push(key);
        collectKeys(value[key]);
      }
    }
  };
  collectKeys(result);
  const sensitiveKey = /secret|token|password|cookie|authorization|apikey|accesskey|credential|address|phone|mobile|contact|recipient|收件|电话|手机|地址|联系人/i;
  assert.deepEqual(keys.filter((key) => sensitiveKey.test(key)), []);

  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /1[3-9]\d{9}/);
  assert.doesNotMatch(text, /\d{11,}/);
  assert.doesNotMatch(text, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
});

test('returns response projection drops unknown top-level and nested properties', () => {
  const tainted = caseRow({
    recipientPhone: 'synthetic-sensitive-value',
    facts: Object.freeze([{
      name: 'returnReasonName',
      value: '商品缺货',
      hiddenContact: 'synthetic-sensitive-value',
    }]),
  });
  const result = queryReturnsDashboard(DASHBOARD, orderManagement({
    pages: Object.freeze({
      ...orderManagement().pages,
      'return-applications': {
        ...orderManagement().pages['return-applications'],
        rows: Object.freeze([tainted]),
      },
    }),
  }));
  const row = result.domains['return-applications'].rows[0];
  assert.equal(Object.hasOwn(row, 'recipientPhone'), false);
  assert.deepEqual(Object.keys(row.facts[0]), ['name', 'value']);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive-value/);
});

test('the upstream order-management contract rejects PII before returns data is materialized', () => {
  assert.equal(isDeniedKeyName('recipientPhone'), true);
  assert.equal(isDeniedKeyName('returnReasonName'), false);
  assert.equal(containsNumericPii('13800138000'), true);
  assert.equal(containsSensitiveText('联系人：张三'), true);

  const clean = caseRow();
  assert.equal(validateOrderManagementRow(clean, { pageId: 'return-applications' }).ok, true);

  const withPiiDetail = caseRow({
    details: Object.freeze([{ name: 'recipientPhone', value: '13800138000' }]),
  });
  assert.equal(validateOrderManagementRow(withPiiDetail, { pageId: 'return-applications' }).ok, false);

  const withPiiText = caseRow({
    secondary: '收货人：张三，联系电话 0571-88888888',
  });
  assert.equal(validateOrderManagementRow(withPiiText, { pageId: 'return-applications' }).ok, false);
});

test('returns rows keep the documented values through a strict response projection', () => {
  const index = orderManagement();
  const result = queryReturnsDashboard(DASHBOARD, index);
  assert.deepEqual(
    result.domains['return-applications'].rows.map((row) => row.id),
    ['RA-1', 'RA-2', 'RA-3'],
  );
  assert.notEqual(result.domains['return-applications'].rows[0], index.pages['return-applications'].rows[0]);
  assert.deepEqual(
    result.domains['return-applications'].rows[0],
    index.pages['return-applications'].rows[0],
  );
});
