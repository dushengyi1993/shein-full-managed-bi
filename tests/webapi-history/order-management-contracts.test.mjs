import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS,
  ORDER_MANAGEMENT_ENDPOINTS,
  ORDER_MANAGEMENT_RESEARCHED_ENDPOINTS,
  ORDER_MANAGEMENT_WEBAPI_ORIGIN,
  ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
  orderManagementEndpointUrl,
  orderManagementRequestBody,
  orderManagementWindow,
} from '../../src/webapi-history/order-management-contracts.mjs';
import {
  PAGE_FIELD_ALLOWLISTS,
  fieldHash,
  isDeniedKeyName,
  pickFieldsByAllowlist,
  validateOrderManagementIndex,
} from '../../src/order-management/order-management-contract.mjs';

test('callable endpoints are POST-only fixed sso.geiwohuo.com paths with verified totals', () => {
  for (const [code, endpoint] of Object.entries(ORDER_MANAGEMENT_ENDPOINTS)) {
    assert.equal(endpoint.method, 'POST', `${code} must be POST`);
    assert.ok(endpoint.path.startsWith('/'), `${code} path must be absolute`);
    assert.ok(
      orderManagementEndpointUrl(code).startsWith(ORDER_MANAGEMENT_WEBAPI_ORIGIN),
      `${code} must live on sso.geiwohuo.com`,
    );
    if (code !== 'WAYBILLS_STATISTICS') {
      assert.ok(Array.isArray(endpoint.totalPath), `${code} needs a total path`);
      assert.ok(Array.isArray(endpoint.rowsPath), `${code} needs a rows path`);
      assert.ok(endpoint.evidence, `${code} needs evidence`);
    }
  }
});

test('no callable endpoint is a write action (print/cancel/ship/prepare/confirm/sign/reconsider/export)', () => {
  const writePattern = /\b(print|cancel|ship|prepare|confirm|sign|reconsider|export|create|submit)\b/i;
  for (const endpoint of Object.values(ORDER_MANAGEMENT_ENDPOINTS)) {
    assert.ok(!writePattern.test(endpoint.path), `${endpoint.path} must not be a write action`);
  }
  for (const researched of Object.values(ORDER_MANAGEMENT_RESEARCHED_ENDPOINTS)) {
    assert.ok(researched.reason, 'researched endpoints must carry a reason');
  }
});

test('researched-but-unverified endpoints never guess paths', () => {
  for (const [code, endpoint] of Object.entries(ORDER_MANAGEMENT_RESEARCHED_ENDPOINTS)) {
    if (endpoint.path === null) {
      assert.equal(endpoint.method, null, `${code} must not guess a method`);
      assert.match(endpoint.reason, /DOM only|safely frozen/i);
    } else {
      assert.match(
        endpoint.reason,
        /total|never enter the index|safely frozen/i,
        `${code} reason must explain why it is not callable`,
      );
    }
  }
});

test('field allowlists are hash-pinned, PII-free and cover every callable endpoint field', () => {
  for (const [code, fields] of Object.entries(ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS)) {
    assert.ok(fields.length > 0, `${code} needs a verified allowlist`);
    for (const field of fields) {
      assert.equal(field.hash, fieldHash(field.name), `${code}/${field.name} hash mismatch`);
      assert.ok(!isDeniedKeyName(field.name), `${code}/${field.name} is a denied PII key`);
    }
  }
  const pageAllowlistNames = new Set(
    PAGE_FIELD_ALLOWLISTS['stock-records'].map((field) => field.name),
  );
  const emittedStockFields = [
    'supplierCode',
    'skc',
    'orderMode',
    'orderModeValue',
    'applyStatus',
    'stockType',
    'orderSign',
    'orderNo',
    'addTime',
    'timezone',
  ];
  for (const name of emittedStockFields) {
    assert.ok(pageAllowlistNames.has(name), `stock-records page allowlist misses ${name}`);
  }
  const waybillPageNames = new Set(PAGE_FIELD_ALLOWLISTS.waybills.map((field) => field.name));
  const emittedWaybillFields = [
    'trackingNumber',
    'logisticsCompanyName',
    'waybillTypeSellerName',
    'orderTypeName',
    'serviceModeCodeName',
    'addTime',
    'signTime',
    'pickupTime',
    'packQuantity',
    'sendGoodsQuantity',
    'actualWeight',
    'volumeWeight',
    'estimatedWeight',
    'finalSettlementWeight',
    'convertedFinalApportionment',
    'exemptionAmount',
    'actualDeductionAmount',
    'changedEstimatedApportionment',
    'differenceDeductedAmount',
    'supplierCurrencyName',
    'combineNumber',
    'collectBatchNo',
    'apportionmentState',
    'supplierTitle',
    'rightsResultTypeName',
    'syStatusName',
  ];
  for (const name of emittedWaybillFields) {
    assert.ok(waybillPageNames.has(name), `waybills page allowlist misses ${name}`);
  }
  assert.ok(
    !ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.WAYBILLS_PAGE
      .some((field) => /sender|receiver|province|city/i.test(field.name)),
    'waybill allowlist must exclude address-like sender/receiver fields',
  );
  assert.ok(
    !ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.STOCK_RECORDS_LIST
      .some((field) => /applyNotes|picUrl|imgPath|skuList|orderAccount/i.test(field.name)),
    'stock-record allowlist must exclude free-form notes, images and account names',
  );
});

test('pickFieldsByAllowlist copies only allowlisted keys and refuses tampered allowlists', () => {
  const record = {
    orderNo: 'PB2608',
    skc: 'sv1',
    applyNotes: 'free text with a phone 1381712206781',
    sendAddress: 'street',
  };
  const picked = pickFieldsByAllowlist(
    ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.STOCK_RECORDS_LIST,
    record,
  );
  assert.deepEqual(Object.keys(picked).sort(), ['orderNo', 'skc'].sort());
  assert.equal(picked.orderNo, 'PB2608');
  assert.ok(!Object.prototype.hasOwnProperty.call(picked, 'applyNotes'));
  assert.ok(!Object.prototype.hasOwnProperty.call(picked, 'sendAddress'));
  assert.throws(
    () => pickFieldsByAllowlist([{ name: 'orderNo', hash: 'not-a-hash' }], record),
    /ORDER_MANAGEMENT_ALLOWLIST_INVALID/,
  );
});

test('windows are bounded to the verified 30-day maximum', () => {
  assert.deepEqual(
    orderManagementWindow({ startDate: '2026-07-10', endDate: '2026-08-08' }),
    { startDate: '2026-07-10', endDate: '2026-08-08' },
  );
  assert.equal(ORDER_MANAGEMENT_WINDOW_MAX_DAYS, 30);
  assert.throws(
    () => orderManagementWindow({ startDate: '2026-01-01', endDate: '2026-08-08' }),
    /ORDER_MANAGEMENT_WINDOW_TOO_WIDE/,
  );
  assert.throws(
    () => orderManagementWindow({ startDate: '2026-08-08', endDate: '2026-08-01' }),
    /ORDER_MANAGEMENT_WINDOW_INVALID/,
  );
});

test('request bodies freeze the verified templates with bounded window fields', () => {
  const body = orderManagementRequestBody('STOCK_RECORDS_LIST', {
    window: orderManagementWindow({ startDate: '2026-07-10', endDate: '2026-08-08' }),
  });
  assert.equal(body.supplierCodes, '');
  assert.equal(body.orderModes.length, 0);
  assert.equal(body.addTimeBegin, '2026-07-10 00:00:00');
  assert.equal(body.addTimeEnd, '2026-08-08 23:59:59');
  assert.equal(Object.isFrozen(body), true);
  assert.throws(() => orderManagementRequestBody('UNKNOWN'), /ORDER_MANAGEMENT_ENDPOINT_NOT_ALLOWED/);
});

test('the index contract validates an empty skeleton and rejects missing pages', () => {
  const skeleton = {
    schemaVersion: 1,
    updatedAt: '2026-08-08T00:00:00.000Z',
    coverage: {
      status: 'UNAVAILABLE',
      expectedStoreCount: 25,
      completedStoreCount: 0,
      storeCodes: [],
      reason: 'no pages',
    },
    promotable: false,
    pages: Object.fromEntries([
      'delivery-notes',
      'delivery-desk',
      'stock-records',
      'waybills',
      'return-applications',
      'return-orders',
      'exceptions',
      'value-added-services',
      'quality-reports',
    ].map((pageId) => [pageId, {
      status: 'UNAVAILABLE',
      source: 'NONE',
      latestSourceFetchedAt: null,
      reason: 'test reason',
      rows: [],
    }])),
  };
  assert.equal(validateOrderManagementIndex(skeleton).ok, true);
  const missing = {
    ...skeleton,
    pages: { ...skeleton.pages },
  };
  delete missing.pages['delivery-notes'];
  const check = validateOrderManagementIndex(missing);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((error) => error.includes('pages.delivery-notes')));
});
