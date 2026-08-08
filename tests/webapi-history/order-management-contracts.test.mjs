import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORDER_MANAGEMENT_ONCE_ONLY_PAGES,
  ORDER_MANAGEMENT_SESSION_PAGES,
  ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS,
  ORDER_MANAGEMENT_ENDPOINTS,
  ORDER_MANAGEMENT_RESEARCHED_ENDPOINTS,
  ORDER_MANAGEMENT_WEBAPI_ORIGIN,
  ORDER_MANAGEMENT_WINDOW_MAX_DAYS,
  assertOrderManagementTransportRequest,
  orderManagementEndpointUrl,
  orderManagementRequestBody,
  orderManagementWindow,
} from '../../src/webapi-history/order-management-contracts.mjs';
import {
  PAGE_FIELD_ALLOWLISTS,
  containsSensitiveText,
  fieldHash,
  isDeniedKeyName,
  pickFieldsByAllowlist,
  scrubPiiText,
  validateOrderManagementRow,
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
    () => orderManagementWindow({ startDate: '2026-07-01', endDate: '2026-07-31' }),
    /ORDER_MANAGEMENT_WINDOW_TOO_WIDE/,
  );
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
  assert.throws(
    () => orderManagementRequestBody('RETURN_APPLICATIONS_LIST'),
    /ORDER_MANAGEMENT_WINDOW_REQUIRED/,
  );
});

test('the transport seal rejects arbitrary filters and widened pagination', () => {
  const base = orderManagementRequestBody('RETURN_APPLICATIONS_LIST', {
    window: { startDate: '2026-07-01', endDate: '2026-07-30' },
  });
  assert.equal(assertOrderManagementTransportRequest('RETURN_APPLICATIONS_LIST', {
    ...base,
    page: 1,
    perPage: 50,
  }), true);
  assert.throws(
    () => assertOrderManagementTransportRequest('RETURN_APPLICATIONS_LIST', {
      ...base,
      page: 999,
      perPage: 999,
      unexpected: 'arbitrary',
    }),
    /ORDER_MANAGEMENT_REQUEST/,
  );
});

test('free-text PII is scrubbed and cannot hide in status, secondary or tags', () => {
  assert.equal(containsSensitiveText('联系人张三，邮箱 test@example.com，电话 021-12345678'), true);
  assert.equal(scrubPiiText('联系人张三，邮箱 test@example.com，电话 021-12345678'), null);
  const baseRow = {
    id: 'WO-1',
    storeCode: 'CX4412',
    statusCode: '1',
    statusName: '联系人张三 13800138000',
    createdAt: null,
    updatedAt: '2026-08-08T06:00:00.000Z',
    primary: 'WO-1',
    secondary: 'test@example.com',
    tags: ['电话 021-12345678'],
    metrics: [],
    facts: [],
    details: [],
  };
  const verdict = validateOrderManagementRow(baseRow, { pageId: 'exceptions' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(' | '), /sensitive text/);
});

test('the five verified order-management pages fix their request windows and page keys', () => {
  const returnPlan = ORDER_MANAGEMENT_ENDPOINTS.RETURN_APPLICATIONS_LIST;
  assert.equal(returnPlan.path, '/pfmp/returnPlan/list');
  assert.deepEqual(returnPlan.windowFields, { start: 'returnTimeStart', end: 'returnTimeEnd' });
  assert.equal(returnPlan.pageKey, 'page');
  assert.equal(returnPlan.pageSizeKey, 'perPage');
  assert.equal(returnPlan.defaultPageSize, 50);
  assert.deepEqual(returnPlan.totalPath, ['info', 'meta', 'count']);
  assert.deepEqual(returnPlan.rowsPath, ['info', 'data']);

  const returnOrder = ORDER_MANAGEMENT_ENDPOINTS.RETURN_ORDERS_PAGE;
  assert.equal(returnOrder.path, '/pfmp/returnOrder/page');
  assert.deepEqual(returnOrder.windowFields, { start: 'addTimeStart', end: 'addTimeEnd' });
  assert.deepEqual(returnOrder.totalPath, ['info', 'meta', 'count']);
  assert.deepEqual(returnOrder.rowsPath, ['info', 'data']);

  const quality = ORDER_MANAGEMENT_ENDPOINTS.QUALITY_REPORTS_PAGE;
  assert.equal(quality.path, '/gmpj/quality/qcReportNew');
  assert.deepEqual(quality.windowFields, {
    start: 'inspectionTimeStart',
    end: 'inspectionTimeEnd',
  });
  assert.equal(quality.bodyTemplate.reportUrl, 1);
  assert.equal(quality.pageSizeValue, '50');
  assert.deepEqual(quality.totalPath, ['info', 'totalCount']);
  assert.deepEqual(quality.rowsPath, ['info', 'list']);

  const exceptions = ORDER_MANAGEMENT_ENDPOINTS.EXCEPTIONS_PAGE;
  assert.equal(exceptions.path, '/pfmp/exceptionWorkorder/order/page');
  assert.equal(exceptions.windowFields, null);
  assert.deepEqual(exceptions.totalPath, ['info', 'meta', 'count']);

  const vas = ORDER_MANAGEMENT_ENDPOINTS.VALUE_ADDED_SERVICES_PAGE;
  assert.equal(vas.path, '/vssv/order/page');
  assert.equal(vas.windowFields, null);
  assert.equal(vas.pageKey, 'pageNumber');
  assert.equal(vas.pageSizeKey, 'pageSize');
  assert.deepEqual(vas.totalPath, ['info', 'count']);
  assert.deepEqual(vas.rowsPath, ['info', 'list']);
});

test('no-date-filter endpoints are once-only and never carry window keys in a body', () => {
  assert.deepEqual(ORDER_MANAGEMENT_ONCE_ONLY_PAGES, ['exceptions', 'value-added-services']);
  assert.deepEqual(Object.keys(ORDER_MANAGEMENT_SESSION_PAGES).sort(), [
    'exceptions',
    'quality-reports',
    'return-applications',
    'return-orders',
    'stock-records',
    'value-added-services',
    'waybills',
  ]);
  for (const endpointCode of ['EXCEPTIONS_PAGE', 'VALUE_ADDED_SERVICES_PAGE']) {
    const body = orderManagementRequestBody(endpointCode, {
      window: { startDate: '2026-07-01', endDate: '2026-07-30' },
    });
    assert.ok(!Object.keys(body).some((key) => /Time|Date/.test(key)));
  }
  const returnPlanBody = orderManagementRequestBody('RETURN_APPLICATIONS_LIST', {
    window: { startDate: '2026-07-01', endDate: '2026-07-30' },
  });
  assert.equal(returnPlanBody.returnTimeStart, '2026-07-01 00:00:00');
  assert.equal(returnPlanBody.returnTimeEnd, '2026-07-30 23:59:59');
  const qualityBody = orderManagementRequestBody('QUALITY_REPORTS_PAGE', {
    window: { startDate: '2026-07-01', endDate: '2026-07-30' },
  });
  assert.equal(qualityBody.inspectionTimeStart, '2026-07-01 00:00:00');
  assert.equal(qualityBody.inspectionTimeEnd, '2026-07-30 23:59:59');
  assert.equal(qualityBody.reportUrl, 1);
});

test('the five verified page allowlists exclude every researched PII/free-text key', () => {
  const forbidden = [
    'sellerAddress', 'address', 'phone', 'contract', 'returnAddress',
    'driverName', 'thumb', 'url', 'img', 'reportUrl', 'sellerTitle',
    'creator', 'problemDesc', 'resultReply', 'attachmentUrlList',
    'goodsThumb', 'remark', 'user', 'serviceDesc', 'uid', 'merchant',
    'operatorShowName', 'instructions',
  ];
  for (const endpointCode of [
    'RETURN_APPLICATIONS_LIST',
    'RETURN_ORDERS_PAGE',
    'EXCEPTIONS_PAGE',
    'VALUE_ADDED_SERVICES_PAGE',
    'QUALITY_REPORTS_PAGE',
  ]) {
    const allowlist = ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS[endpointCode];
    const names = allowlist.map((field) => field.name);
    for (const name of forbidden) {
      assert.ok(!names.includes(name), `${endpointCode} must not allow ${name}`);
    }
    // Every forbidden name that the shared deny pattern covers must be denied
    // by the second line of defence as well.
    for (const name of forbidden) {
      if (/address|phone|tel|mobile|contact|receiver|sender|consignee|recipient|postcode|postal|zip/i.test(name)) {
        assert.ok(isDeniedKeyName(name), `${name} must be a denied key name`);
      }
    }
    assert.ok(allowlist.length > 0, `${endpointCode} needs a verified allowlist`);
    assert.ok(
      !allowlist.some((field) => /^(img|image|pic|url|thumb|attachment)/i.test(field.name)),
      `${endpointCode} must not allow image/URL keys`,
    );
  }
  assert.ok(
    !ORDER_MANAGEMENT_ENDPOINT_FIELD_ALLOWLISTS.QUALITY_REPORTS_PAGE
      .some((field) => field.name === 'id'),
    'quality-reports rows are keyed by qcInspectionNo, not a raw id',
  );
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
