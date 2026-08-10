import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  V4CollectionError,
  createFullWebapiFactRepository,
  V4_REQUIRED_WORK_ITEM_CODES,
} from '../../src/warehouse/full-webapi-fact-repository.mjs';
import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

const DOMAIN = Object.freeze({
  entity: 'full-managed.v4.entity:',
  version: 'full-managed.v4.version:',
  payload: 'full-managed.v4.payload:',
  attempt: 'full-managed.v4.attempt:',
  page: 'full-managed.v4.page:',
});

function canonicalJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function entityHash(entity) {
  return sha256(`${DOMAIN.entity}${String(entity).trim()}`);
}

function attemptKey(runKey, storeCode, endpointCode, requestSchemaHash, start = null, end = null) {
  return sha256(
    `${DOMAIN.attempt}${[runKey, storeCode, endpointCode, requestSchemaHash, start ?? '', end ?? ''].join('\u001f')}`,
  );
}

function pageKey(attempt, pageNumber, fingerprint) {
  return sha256(`${DOMAIN.page}${[attempt, pageNumber, fingerprint].join('\u001f')}`);
}

const RUN_KEY = '1'.repeat(64);
const PLAN_HASH = 'a'.repeat(64);
const SCHEMA_HASH = 'b'.repeat(64);
const REQUEST_FINGERPRINT = 'c'.repeat(64);
const ATTEMPT_KEY = attemptKey(RUN_KEY, 'DL5477', 'STOCK_RECORDS_LIST', SCHEMA_HASH);
const PAGE_FINGERPRINT = 'd'.repeat(64);
const RESPONSE_SCHEMA_HASH = 'e'.repeat(64);
const PAGE_KEY = pageKey(ATTEMPT_KEY, 1, PAGE_FINGERPRINT);

test('the repository freezes the exact 13-item work-item manifest and canonical store roster', () => {
  assert.equal(FULL_MANAGED_STORE_CODES.length, 25);
  assert.equal(new Set(FULL_MANAGED_STORE_CODES).size, 25);
  assert.deepEqual(FULL_MANAGED_STORE_CODES, Object.freeze([
    'CX4412',
    'XL2801',
    'QY8886',
    'DX0571',
    'NM7397',
    'LQ7173',
    'TS8263',
    'DL5477',
    'FY4021',
    'GJ8989',
    'QH8028',
    'JY8060',
    'ZL3133',
    'MZ2406',
    'YJ8177',
    'RH0099',
    'WY9025',
    'RH2848',
    'CX2816',
    'YJ4042',
    'NM4977',
    'NM8787',
    'NM8831',
    'NM7418',
    'DX2420',
  ]));
  assert.equal(V4_REQUIRED_WORK_ITEM_CODES.length, 13);
  assert.equal(new Set(V4_REQUIRED_WORK_ITEM_CODES).size, 13);
  assert.deepEqual(V4_REQUIRED_WORK_ITEM_CODES, [
    'STOCK_RECORDS_LIST',
    'WAYBILLS_PAGE',
    'RETURN_APPLICATIONS_LIST',
    'RETURN_ORDERS_PAGE',
    'EXCEPTIONS_PAGE',
    'VALUE_ADDED_SERVICES_PAGE',
    'QUALITY_REPORTS_PAGE',
    'WAYBILLS_STATISTICS_1',
    'WAYBILLS_STATISTICS_2',
    'WAYBILLS_STATISTICS_3',
    'WAYBILLS_STATISTICS_4',
    'WAYBILLS_STATISTICS_5',
    'WAYBILLS_STATISTICS_6',
  ]);
});

/**
 * Scripted PostgreSQL double. Matchers run in order per query; rows may be a
 * function of (sql, params, calls) for stateful behavior.
 */
function fakePool(entries) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      for (const entry of entries) {
        if (entry.match.test(sql)) {
          const rows = typeof entry.rows === 'function'
            ? entry.rows(sql, params, calls)
            : entry.rows;
          return { rows: rows ?? [], rowCount: entry.rowCount ?? (rows?.length ?? 0) };
        }
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return {
    calls,
    pool: { async connect() { return client; } },
  };
}

function callMatching(calls, pattern) {
  return calls.find(({ sql }) => pattern.test(sql));
}

const runLookup = {
  match: /FROM ops\.v4_collection_run[\s\S]*WHERE run_key = \$1/,
  rows: [],
};

const attemptLookup = {
  match: /FROM ops\.v4_collection_attempt[\s\S]*WHERE attempt_key = \$1/,
  rows: [{
    collection_attempt_id: 10,
    collection_run_id: 1,
    store_code: 'DL5477',
    endpoint_code: 'STOCK_RECORDS_LIST',
    attempt_status: 'RUNNING',
  }],
};

const VAS_ATTEMPT_KEY = attemptKey(
  RUN_KEY,
  'DL5477',
  'VALUE_ADDED_SERVICES_PAGE',
  SCHEMA_HASH,
);

const vasAttemptLookup = {
  match: /FROM ops\.v4_collection_attempt[\s\S]*WHERE attempt_key = \$1/,
  rows: [{
    collection_attempt_id: 51,
    collection_run_id: 1,
    store_code: 'DL5477',
    endpoint_code: 'VALUE_ADDED_SERVICES_PAGE',
    attempt_status: 'RUNNING',
  }],
};

const VAS_TYPED_COLUMNS = Object.freeze([
  'order_no_hash',
  'sub_order_no_hash',
  'purchase_no_hash',
  'new_purchase_no_hash',
  'qc_inspection_no_hash',
  'return_no_hash',
  'delivery_no_hash',
  'service_site_id',
  'service_site_name',
  'skc',
  'multi_part_flag',
  'supplier_product_number',
  'skc_num',
  'total_flag',
  'total_flag_name',
  'order_state',
  'order_state_name',
  'low_value_flag',
  'value_added_result',
  'defective_quantity',
  'order_scene',
  'return_flag',
  'vendor_replenish_state',
  'vendor_replenish_state_name',
  'show_fee_tag',
  'supplier_source',
  'supplier_source_name',
]);

const VAS_INSERT_COLUMN_COUNT = 8 + VAS_TYPED_COLUMNS.length;

function vasStoredRows(params) {
  const rows = [];
  for (let index = 0; index < params.length; index += VAS_INSERT_COLUMN_COUNT) {
    const row = {
      entity_key_hash: params[index + 1],
      source_version_token: params[index + 2],
      payload_hash: params[index + 7],
    };
    VAS_TYPED_COLUMNS.forEach((column, offset) => {
      row[column] = params[index + 8 + offset];
    });
    rows.push(row);
  }
  return rows;
}

test('createCollectionRun inserts the frozen plan and reads it back exactly', async () => {
  const { calls, pool } = fakePool([
    runLookup,
    {
      match: /INSERT INTO ops\.v4_collection_run/,
      rows: [{ collection_run_id: 1, run_status: 'PLANNED' }],
      rowCount: 1,
    },
    {
      match: /SELECT collection_run_id, run_key, plan_hash, run_status[\s\S]*FROM ops\.v4_collection_run\s+WHERE collection_run_id = \$1/,
      rows: [{
        collection_run_id: 1,
        run_key: RUN_KEY,
        plan_hash: PLAN_HASH,
        run_status: 'PLANNED',
        expected_store_count: 25,
        expected_endpoint_count: 13,
      }],
    },
  ]);
  const repository = createFullWebapiFactRepository({ pool });

  const result = await repository.createCollectionRun({
    planHash: PLAN_HASH,
    runKey: RUN_KEY,
    storeCodes: [...FULL_MANAGED_STORE_CODES],
    endpointCodes: [...V4_REQUIRED_WORK_ITEM_CODES],
  });

  assert.equal(result.collectionRunId, 1);
  assert.equal(result.runStatus, 'PLANNED');
  assert.equal(result.expectedStoreCount, 25);
  assert.equal(result.expectedEndpointCount, 13);
  assert.equal(result.replayed, false);
  assert.ok(calls.some(({ sql }) => /SET LOCAL ROLE sheinfm_webapi_loader/.test(sql)));
  const insert = callMatching(calls, /INSERT INTO ops\.v4_collection_run/);
  assert.deepEqual(insert.params, [
    1, RUN_KEY, PLAN_HASH, 'NONE', 25, 13,
    [...FULL_MANAGED_STORE_CODES], [...V4_REQUIRED_WORK_ITEM_CODES], null, null,
  ]);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('createCollectionRun refuses any run outside the canonical 25-store / 13-item roster', async () => {
  const cases = [
    ['single store', { storeCodes: ['DL5477'] }, 'V4_STORE_ROSTER_NOT_CANONICAL'],
    ['two stores', { storeCodes: ['DL5477', 'MZ2406'] }, 'V4_STORE_ROSTER_NOT_CANONICAL'],
    [
      'single endpoint',
      { storeCodes: [...FULL_MANAGED_STORE_CODES], endpointCodes: ['STOCK_RECORDS_LIST'] },
      'V4_ENDPOINT_ROSTER_NOT_CANONICAL',
    ],
    [
      'two endpoints',
      { storeCodes: [...FULL_MANAGED_STORE_CODES], endpointCodes: ['STOCK_RECORDS_LIST', 'WAYBILLS_PAGE'] },
      'V4_ENDPOINT_ROSTER_NOT_CANONICAL',
    ],
    [
      'reordered stores',
      { storeCodes: [...FULL_MANAGED_STORE_CODES].reverse(), endpointCodes: [...V4_REQUIRED_WORK_ITEM_CODES] },
      'V4_STORE_ROSTER_NOT_CANONICAL',
    ],
    [
      'reordered manifest',
      { storeCodes: [...FULL_MANAGED_STORE_CODES], endpointCodes: [...V4_REQUIRED_WORK_ITEM_CODES].reverse() },
      'V4_ENDPOINT_ROSTER_NOT_CANONICAL',
    ],
  ];
  for (const [label, input, code] of cases) {
    await assert.rejects(
      createFullWebapiFactRepository({ pool: fakePool([]).pool }).createCollectionRun({
        planHash: PLAN_HASH,
        runKey: RUN_KEY,
        ...input,
      }),
      (error) => error instanceof V4CollectionError && error.code === code,
      label,
    );
  }
});

test('createCollectionRun replay requires the byte-identical plan and rolls back on drift', async () => {
  const existingRow = {
    collection_run_id: 1,
    contract_version: 1,
    plan_hash: PLAN_HASH,
    run_status: 'PLANNED',
    expected_store_count: 25,
    expected_endpoint_count: 13,
    store_codes: [...FULL_MANAGED_STORE_CODES],
    endpoint_codes: [...V4_REQUIRED_WORK_ITEM_CODES],
    window_start: null,
    window_end: null,
    retry_policy: 'NONE',
  };
  const repository = createFullWebapiFactRepository({
    pool: fakePool([{ ...runLookup, rows: [existingRow] }]).pool,
  });
  const replayed = await repository.createCollectionRun({
    planHash: PLAN_HASH,
    runKey: RUN_KEY,
    storeCodes: [...FULL_MANAGED_STORE_CODES],
    endpointCodes: [...V4_REQUIRED_WORK_ITEM_CODES],
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.collectionRunId, 1);

  const drifting = fakePool([
    { ...runLookup, rows: [{ ...existingRow, plan_hash: 'f'.repeat(64) }] },
  ]);
  await assert.rejects(
    createFullWebapiFactRepository({ pool: drifting.pool }).createCollectionRun({
      planHash: PLAN_HASH,
      runKey: RUN_KEY,
      storeCodes: [...FULL_MANAGED_STORE_CODES],
      endpointCodes: [...V4_REQUIRED_WORK_ITEM_CODES],
    }),
    (error) => error instanceof V4CollectionError && error.code === 'V4_RUN_REPLAY_DRIFT',
  );
  assert.ok(drifting.calls.some(({ sql }) => sql === 'ROLLBACK'));
});

test('beginAttempt builds a deterministic replay key and supports terminal BLOCKED births', async () => {
  const { calls, pool } = fakePool([
    {
      match: /FROM ops\.v4_collection_run[\s\S]*WHERE run_key = \$1/,
      rows: [{ collection_run_id: 1, run_status: 'RUNNING' }],
    },
    {
      match: /SELECT collection_attempt_id, attempt_key, attempt_status[\s\S]*request_schema_hash[\s\S]*WHERE collection_run_id = \$1 AND store_code = \$2 AND endpoint_code = \$3/,
      rows: [],
    },
    {
      match: /INSERT INTO ops\.v4_collection_attempt/,
      rows: [{ collection_attempt_id: 10, attempt_status: 'PLANNED' }],
      rowCount: 1,
    },
    {
      match: /SELECT collection_attempt_id, attempt_key, attempt_status\s+FROM ops\.v4_collection_attempt\s+WHERE collection_attempt_id = \$1/,
      rows: [{ collection_attempt_id: 10, attempt_key: ATTEMPT_KEY, attempt_status: 'PLANNED' }],
    },
  ]);
  const repository = createFullWebapiFactRepository({ pool });

  const result = await repository.beginAttempt({
    runKey: RUN_KEY,
    storeCode: 'DL5477',
    endpointCode: 'STOCK_RECORDS_LIST',
    requestSchemaHash: SCHEMA_HASH,
    requestFingerprint: REQUEST_FINGERPRINT,
  });

  assert.equal(result.attemptKey, ATTEMPT_KEY);
  assert.equal(result.attemptStatus, 'PLANNED');
  assert.equal(result.replayed, false);
  const insert = callMatching(calls, /INSERT INTO ops\.v4_collection_attempt/);
  assert.equal(insert.params[3], ATTEMPT_KEY);
  assert.equal(insert.params[8], 'PLANNED');
  assert.equal(insert.params[9], null);
  assert.equal(insert.params[10], false);
  assert.equal(insert.params[11], null);

  const blockedPool = fakePool([
    {
      match: /FROM ops\.v4_collection_run[\s\S]*WHERE run_key = \$1/,
      rows: [{ collection_run_id: 1, run_status: 'PREFLIGHT_PASSED' }],
    },
    {
      match: /SELECT collection_attempt_id, attempt_key, attempt_status[\s\S]*request_schema_hash[\s\S]*WHERE collection_run_id = \$1 AND store_code = \$2 AND endpoint_code = \$3/,
      rows: [],
    },
    {
      match: /INSERT INTO ops\.v4_collection_attempt/,
      rows: [{ collection_attempt_id: 11, attempt_status: 'BLOCKED' }],
      rowCount: 1,
    },
    {
      match: /SELECT collection_attempt_id, attempt_key, attempt_status\s+FROM ops\.v4_collection_attempt\s+WHERE collection_attempt_id = \$1/,
      rows: [{
        collection_attempt_id: 11,
        attempt_key: attemptKey(RUN_KEY, 'MZ2406', 'EXCEPTIONS_PAGE', SCHEMA_HASH),
        attempt_status: 'BLOCKED',
      }],
    },
  ]);
  const blocked = await createFullWebapiFactRepository({
    pool: blockedPool.pool,
  }).beginAttempt({
    runKey: RUN_KEY,
    storeCode: 'MZ2406',
    endpointCode: 'EXCEPTIONS_PAGE',
    requestSchemaHash: SCHEMA_HASH,
    requestFingerprint: REQUEST_FINGERPRINT,
    initialStatus: 'BLOCKED',
    sanitizedErrorCode: 'CREDENTIAL_BLOCKED',
  });
  assert.equal(blocked.attemptStatus, 'BLOCKED');
  const blockedInsert = callMatching(blockedPool.calls, /INSERT INTO ops\.v4_collection_attempt/);
  assert.equal(blockedInsert.params[8], 'BLOCKED');
  assert.equal(blockedInsert.params[11], 'CREDENTIAL_BLOCKED');
  assert.equal(blockedInsert.params[10], true);
  assert.match(
    callMatching(blockedPool.calls, /INSERT INTO ops\.v4_collection_attempt/).sql,
    /clock_timestamp\(\)/,
  );
});

test('beginAttempt rejects replay drift on the frozen request contract', async () => {
  const pool = fakePool([
    {
      match: /FROM ops\.v4_collection_run[\s\S]*WHERE run_key = \$1/,
      rows: [{ collection_run_id: 1, run_status: 'RUNNING' }],
    },
    {
      match: /SELECT collection_attempt_id, attempt_key, attempt_status[\s\S]*request_schema_hash[\s\S]*WHERE collection_run_id = \$1 AND store_code = \$2 AND endpoint_code = \$3/,
      rows: [{
        collection_attempt_id: 10,
        attempt_key: ATTEMPT_KEY,
        attempt_status: 'RUNNING',
        request_schema_hash: 'f'.repeat(64),
        request_fingerprint: REQUEST_FINGERPRINT,
        window_start: null,
        window_end: null,
        expected_row_count: null,
      }],
    },
  ]);
  await assert.rejects(
    createFullWebapiFactRepository({ pool: pool.pool }).beginAttempt({
      runKey: RUN_KEY,
      storeCode: 'DL5477',
      endpointCode: 'STOCK_RECORDS_LIST',
      requestSchemaHash: SCHEMA_HASH,
      requestFingerprint: REQUEST_FINGERPRINT,
    }),
    (error) => error instanceof V4CollectionError && error.code === 'V4_ATTEMPT_REPLAY_DRIFT',
  );
});

test('attempt terminal transitions never fabricate zero counts for FAILED or UNKNOWN', async () => {
  const current = {
    collection_attempt_id: 10,
    attempt_status: 'RUNNING',
    started_at: '2026-08-10T00:00:00.000Z',
  };
  const baseEntries = [
    {
      match: /SELECT collection_attempt_id, attempt_status, started_at\s+FROM ops\.v4_collection_attempt\s+WHERE attempt_key = \$1/,
      rows: [current],
    },
    {
      match: /UPDATE ops\.v4_collection_attempt/,
      rows: [{ collection_attempt_id: 10, attempt_status: 'FAILED' }],
      rowCount: 1,
    },
  ];
  const failedPool = fakePool(baseEntries);
  const failed = await createFullWebapiFactRepository({
    pool: failedPool.pool,
  }).transitionAttempt({
    attemptKey: ATTEMPT_KEY,
    status: 'FAILED',
    sanitizedErrorCode: 'PAGE_FETCH_FAILED',
  });
  assert.equal(failed.attemptStatus, 'FAILED');
  const failedUpdate = callMatching(failedPool.calls, /UPDATE ops\.v4_collection_attempt/);
  assert.deepEqual(failedUpdate.params.slice(3, 6), [
    true,
    null,
    null,
  ]);
  assert.match(failedUpdate.sql, /clock_timestamp\(\)/);

  const unknownPool = fakePool([
    {
      match: /SELECT collection_attempt_id, attempt_status, started_at\s+FROM ops\.v4_collection_attempt\s+WHERE attempt_key = \$1/,
      rows: [{ ...current, attempt_status: 'PLANNED' }],
    },
    {
      match: /UPDATE ops\.v4_collection_attempt/,
      rows: [{ collection_attempt_id: 10, attempt_status: 'UNKNOWN' }],
      rowCount: 1,
    },
  ]);
  await createFullWebapiFactRepository({ pool: unknownPool.pool }).transitionAttempt({
    attemptKey: ATTEMPT_KEY,
    status: 'UNKNOWN',
  });
  const unknownUpdate = callMatching(unknownPool.calls, /UPDATE ops\.v4_collection_attempt/);
  assert.equal(unknownUpdate.params[2], false);
  assert.equal(unknownUpdate.params[4], null);
  assert.equal(unknownUpdate.params[5], null);
});

test('insertTypedFacts sanitizes, types, appends and reads back exact hashes', async () => {
  const { calls, pool } = fakePool([
    attemptLookup,
    {
      match: /FROM ops\.v4_page_evidence[\s\S]*WHERE page_key = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO ops\.v4_page_evidence/,
      rows: [{ page_evidence_id: 11 }],
      rowCount: 1,
    },
    {
      match: /payload_hash,[\s\S]*FROM fact\.full_webapi_stock_record_observation[\s\S]*WHERE source_attempt_id = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO fact\.full_webapi_stock_record_observation/,
      rows: [],
      rowCount: 2,
    },
    {
      match: /payload_hash\s+FROM fact\.full_webapi_stock_record_observation[\s\S]*ORDER BY/,
      rows(sql, params, allCalls) {
        const insert = callMatching(allCalls, /INSERT INTO fact\.full_webapi_stock_record_observation/);
        if (!insert) return [];
        const perRow = 18;
        const rows = [];
        for (let index = 0; index < insert.params.length; index += perRow) {
          rows.push({
            entity_key_hash: insert.params[index + 1],
            source_version_token: insert.params[index + 2],
            payload_hash: insert.params[index + 7],
          });
        }
        return rows;
      },
    },
  ]);
  const repository = createFullWebapiFactRepository({ pool });

  const result = await repository.insertTypedFacts({
    pageId: 'stock-records',
    storeCode: 'DL5477',
    endpointCode: 'STOCK_RECORDS_LIST',
    attemptKey: ATTEMPT_KEY,
    pageNumber: 1,
    pageSize: 100,
    pageRequestFingerprint: PAGE_FINGERPRINT,
    responseSchemaHash: RESPONSE_SCHEMA_HASH,
    sourcePayloadHash: 'f'.repeat(64),
    httpStatus: 200,
    observedAt: '2026-08-08T12:00:00.000Z',
    rows: [
      {
        id: '20260808123456789001',
        supplierCode: 'SUP-01',
        skc: 'SKC-A',
        orderMode: 1,
        orderModeValue: '普通',
        applyStatus: 2,
        stockType: 1,
        orderSign: 'NORMAL',
        addTime: '2026-08-08T10:00:00.000Z',
        timezone: 'GMT+8',
        orderNo: '20260808123456789002',
      },
      {
        id: 'SR-1002',
        supplierCode: 'SUP-02',
        skc: 'SKC-B',
        addTime: '2026-08-08T11:00:00.000Z',
      },
    ],
  });

  assert.equal(result.acceptedRowCount, 2);
  assert.equal(result.rejectedRowCount, 0);
  assert.equal(result.insertedRowCount, 2);
  assert.equal(result.replayedRowCount, 0);
  assert.equal(result.pageEvidenceId, 11);
  assert.equal(result.pageKey, PAGE_KEY);
  assert.match(result.payloadHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.readback, {
    rowCount: 2,
    payloadHashesMatch: true,
    expectedRowCount: 2,
  });
  assert.ok(calls.some(({ sql }) => /SET LOCAL ROLE sheinfm_webapi_loader/.test(sql)));
  assert.equal(calls.at(-1).sql, 'COMMIT');

  const pageInsert = callMatching(calls, /INSERT INTO ops\.v4_page_evidence/);
  assert.equal(pageInsert.params[0], 10);
  assert.equal(pageInsert.params[1], PAGE_KEY);
  assert.equal(pageInsert.params[2], 1);
  assert.equal(pageInsert.params[3], 100);
  assert.equal(pageInsert.params[6], 'f'.repeat(64));
  assert.equal(pageInsert.params[7], 2);
  assert.equal(pageInsert.params[8], 0);
  assert.equal(pageInsert.params[9], 200);
  assert.equal(pageInsert.params[10], 'SUCCEEDED');

  const factInsert = callMatching(calls, /INSERT INTO fact\.full_webapi_stock_record_observation/);
  assert.equal(factInsert.params[0], 'DL5477');
  assert.match(factInsert.params[1], /^[0-9a-f]{64}$/);
  assert.match(factInsert.params[2], /^[0-9a-f]{64}$/);
  assert.equal(factInsert.params[3], 10);
  assert.equal(factInsert.params[4], 11);
  assert.equal(factInsert.params[5], '2026-08-08T12:00:00.000Z');
  assert.match(factInsert.params[7], /^[0-9a-f]{64}$/);
  assert.match(factInsert.params[8], /^[0-9a-f]{64}$/);
  assert.equal(factInsert.params[9], 'SUP-01');
  assert.equal(factInsert.params[10], 'SKC-A');
  assert.equal(factInsert.params[11], 1);
  assert.equal(factInsert.params[12], '普通');
  assert.equal(factInsert.params[15], 'NORMAL');
  assert.equal(factInsert.params[16], '2026-08-08T10:00:00.000Z');
  assert.equal(factInsert.params[17], 'GMT+8');

  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /2026080812345678900[12]/);
  assert.doesNotMatch(serialized, /orderNo/);
});

test('insertTypedFacts hashes numeric value-added-service ids and never stores raw numbers or amounts', async () => {
  const { calls, pool } = fakePool([
    vasAttemptLookup,
    {
      match: /FROM ops\.v4_page_evidence[\s\S]*WHERE page_key = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO ops\.v4_page_evidence/,
      rows: [{ page_evidence_id: 52 }],
      rowCount: 1,
    },
    {
      match: /payload_hash,[\s\S]*FROM fact\.full_webapi_value_added_service_observation[\s\S]*WHERE source_attempt_id = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO fact\.full_webapi_value_added_service_observation/,
      rows: [],
      rowCount: 2,
    },
    {
      match: /payload_hash\s+FROM fact\.full_webapi_value_added_service_observation[\s\S]*ORDER BY/,
      rows(sql, params, allCalls) {
        const insert = callMatching(allCalls, /INSERT INTO fact\.full_webapi_value_added_service_observation/);
        if (!insert) return [];
        return vasStoredRows(insert.params);
      },
    },
  ]);
  const repository = createFullWebapiFactRepository({ pool });
  const rawRows = [
    {
      id: '7123456789012345678',
      orderNo: '20260808123456789001',
      subOrderNo: '20260808123456789002',
      serviceSiteId: 88,
      serviceSiteName: '广州增值仓',
      purchaseNo: 'PO-20260808-0001',
      newPurchaseNo: 'NPO-20260808-0001',
      skc: 'SKC-VAS-1',
      multiPartFlag: 1,
      supplierProductNumber: 'SPN-88-01',
      skcNum: 3,
      totalFlag: 0,
      totalFlagName: '否',
      orderState: 2,
      orderStateName: '待处理',
      actualTotalAmount: 123.45,
      lowValueFlag: 'false',
      valueAddedResult: 1,
      defectiveQuantity: 2,
      qcInspectionNo: 'QC-20260808-0001',
      orderScene: 1,
      returnFlag: true,
      returnNo: 'RT-20260808-0001',
      deliveryNo: 'DL-20260808-0001',
      vendorReplenishState: 3,
      vendorReplenishStateName: '待补货',
      estimateIncrementAmount: 6.78,
      showFeeTag: true,
      supplierSource: 4,
      supplierSourceName: '平台仓',
    },
    {
      id: '7123456789012345679',
      skc: 'SKC-VAS-2',
      skcNum: 1,
    },
  ];

  const result = await repository.insertTypedFacts({
    pageId: 'value-added-services',
    storeCode: 'DL5477',
    endpointCode: 'VALUE_ADDED_SERVICES_PAGE',
    attemptKey: VAS_ATTEMPT_KEY,
    pageNumber: 1,
    pageSize: 50,
    pageRequestFingerprint: PAGE_FINGERPRINT,
    responseSchemaHash: RESPONSE_SCHEMA_HASH,
    httpStatus: 200,
    observedAt: '2026-08-08T12:00:00.000Z',
    rows: rawRows,
  });

  assert.equal(result.acceptedRowCount, 2);
  assert.equal(result.rejectedRowCount, 0);
  assert.equal(result.insertedRowCount, 2);
  assert.equal(result.replayedRowCount, 0);
  assert.equal(result.pageEvidenceId, 52);
  assert.match(result.payloadHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.readback, {
    rowCount: 2,
    payloadHashesMatch: true,
    expectedRowCount: 2,
  });

  const pageInsert = callMatching(calls, /INSERT INTO ops\.v4_page_evidence/);
  assert.equal(pageInsert.params[0], 51);
  assert.equal(pageInsert.params[1], pageKey(VAS_ATTEMPT_KEY, 1, PAGE_FINGERPRINT));
  assert.equal(pageInsert.params[2], 1);
  assert.equal(pageInsert.params[3], 50);
  assert.equal(pageInsert.params[7], 2);
  assert.equal(pageInsert.params[8], 0);
  assert.equal(pageInsert.params[9], 200);
  assert.equal(pageInsert.params[10], 'SUCCEEDED');

  const factInsert = callMatching(calls, /INSERT INTO fact\.full_webapi_value_added_service_observation/);
  assert.equal(factInsert.params.length, VAS_INSERT_COLUMN_COUNT * 2);
  assert.equal(factInsert.params[0], 'DL5477');
  assert.match(factInsert.params[1], /^[0-9a-f]{64}$/);
  assert.match(factInsert.params[2], /^[0-9a-f]{64}$/);
  assert.equal(factInsert.params[3], 51);
  assert.equal(factInsert.params[4], 52);
  assert.equal(factInsert.params[5], '2026-08-08T12:00:00.000Z');
  assert.equal(factInsert.params[6], null);
  assert.match(factInsert.params[7], /^[0-9a-f]{64}$/);
  // The seven business numbers are irreversible hashes, never the raw values.
  for (const offset of [8, 9, 10, 11, 12, 13, 14]) {
    assert.match(factInsert.params[offset], /^[0-9a-f]{64}$/);
  }
  assert.notEqual(factInsert.params[8], '20260808123456789001');
  assert.notEqual(factInsert.params[9], '20260808123456789002');
  assert.notEqual(factInsert.params[10], 'PO-20260808-0001');
  assert.notEqual(factInsert.params[11], 'NPO-20260808-0001');
  assert.notEqual(factInsert.params[12], 'QC-20260808-0001');
  assert.notEqual(factInsert.params[13], 'RT-20260808-0001');
  assert.notEqual(factInsert.params[14], 'DL-20260808-0001');
  // Typed site/status/count/flag/source values survive exactly.
  assert.equal(factInsert.params[15], 88);
  assert.equal(factInsert.params[16], '广州增值仓');
  assert.equal(factInsert.params[17], 'SKC-VAS-1');
  assert.equal(factInsert.params[18], 1);
  assert.equal(factInsert.params[19], 'SPN-88-01');
  assert.equal(factInsert.params[20], 3);
  assert.equal(factInsert.params[21], 0);
  assert.equal(factInsert.params[22], '否');
  assert.equal(factInsert.params[23], 2);
  assert.equal(factInsert.params[24], '待处理');
  assert.equal(factInsert.params[25], 0);
  assert.equal(factInsert.params[26], 1);
  assert.equal(factInsert.params[27], 2);
  assert.equal(factInsert.params[28], 1);
  assert.equal(factInsert.params[29], 1);
  assert.equal(factInsert.params[30], 3);
  assert.equal(factInsert.params[31], '待补货');
  assert.equal(factInsert.params[32], 1);
  assert.equal(factInsert.params[33], 4);
  assert.equal(factInsert.params[34], '平台仓');

  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /7123456789012345678|7123456789012345679/);
  assert.doesNotMatch(serialized, /2026080812345678900[12]/);
  assert.doesNotMatch(serialized, /PO-20260808-0001|NPO-20260808-0001|QC-20260808-0001|RT-20260808-0001|DL-20260808-0001/);
  assert.doesNotMatch(serialized, /actualTotalAmount|estimateIncrementAmount|123\.45|6\.78/);

  // Exact replay of the same rows must reuse the same page evidence and rows.
  const replayPool = fakePool([
    vasAttemptLookup,
    {
      match: /FROM ops\.v4_page_evidence[\s\S]*WHERE page_key = \$1/,
      rows: [{
        page_evidence_id: 52,
        page_number: 1,
        page_size: 50,
        page_request_fingerprint: PAGE_FINGERPRINT,
        response_schema_hash: RESPONSE_SCHEMA_HASH,
        payload_hash: result.payloadHash,
        row_count: 2,
        rejected_row_count: 0,
        http_status: 200,
        fetch_status: 'SUCCEEDED',
      }],
    },
    {
      match: /payload_hash,[\s\S]*FROM fact\.full_webapi_value_added_service_observation[\s\S]*WHERE source_attempt_id = \$1/,
      rows: vasStoredRows(factInsert.params),
    },
    {
      match: /payload_hash\s+FROM fact\.full_webapi_value_added_service_observation[\s\S]*ORDER BY/,
      rows: vasStoredRows(factInsert.params),
    },
  ]);
  const replayed = await createFullWebapiFactRepository({
    pool: replayPool.pool,
  }).insertTypedFacts({
    pageId: 'value-added-services',
    storeCode: 'DL5477',
    endpointCode: 'VALUE_ADDED_SERVICES_PAGE',
    attemptKey: VAS_ATTEMPT_KEY,
    pageNumber: 1,
    pageSize: 50,
    pageRequestFingerprint: PAGE_FINGERPRINT,
    responseSchemaHash: RESPONSE_SCHEMA_HASH,
    httpStatus: 200,
    observedAt: '2026-08-08T12:00:00.000Z',
    rows: rawRows,
  });
  assert.equal(replayed.replayedRowCount, 2);
  assert.equal(replayed.insertedRowCount, 0);
  assert.equal(replayed.pageEvidenceId, 52);
  assert.deepEqual(replayed.readback, {
    rowCount: 2,
    payloadHashesMatch: true,
    expectedRowCount: 2,
  });
  assert.equal(
    callMatching(replayPool.calls, /INSERT INTO fact\.full_webapi_value_added_service_observation/),
    undefined,
  );
});

test('insertTypedFacts coerces booleans and exact true/false strings into 0/1 flags only', async () => {
  const { calls, pool } = fakePool([
    vasAttemptLookup,
    {
      match: /FROM ops\.v4_page_evidence[\s\S]*WHERE page_key = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO ops\.v4_page_evidence/,
      rows: [{ page_evidence_id: 53 }],
      rowCount: 1,
    },
    {
      match: /payload_hash,[\s\S]*FROM fact\.full_webapi_value_added_service_observation[\s\S]*WHERE source_attempt_id = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO fact\.full_webapi_value_added_service_observation/,
      rows: [],
      rowCount: 3,
    },
    {
      match: /payload_hash\s+FROM fact\.full_webapi_value_added_service_observation[\s\S]*ORDER BY/,
      rows(sql, params, allCalls) {
        const insert = callMatching(allCalls, /INSERT INTO fact\.full_webapi_value_added_service_observation/);
        if (!insert) return [];
        return vasStoredRows(insert.params);
      },
    },
  ]);
  const repository = createFullWebapiFactRepository({ pool });

  const result = await repository.insertTypedFacts({
    pageId: 'value-added-services',
    storeCode: 'DL5477',
    endpointCode: 'VALUE_ADDED_SERVICES_PAGE',
    attemptKey: VAS_ATTEMPT_KEY,
    pageNumber: 1,
    pageSize: 50,
    pageRequestFingerprint: PAGE_FINGERPRINT,
    responseSchemaHash: RESPONSE_SCHEMA_HASH,
    observedAt: '2026-08-08T12:00:00.000Z',
    rows: [
      { id: 'VAS-FLAG-1', skcNum: 1, showFeeTag: true, lowValueFlag: 'false', multiPartFlag: 'true' },
      { id: 'VAS-FLAG-2', skcNum: 2, totalFlag: false, returnFlag: 'TRUE' },
      { id: 'VAS-FLAG-3', skcNum: 3, showFeeTag: 'false', vendorReplenishState: 1 },
      { id: 'VAS-FLAG-4', skcNum: 4, showFeeTag: 'yes' },
    ],
  });

  assert.equal(result.acceptedRowCount, 3);
  assert.equal(result.rejectedRowCount, 1);
  assert.deepEqual(result.rejectedCodes, ['V4_TYPED_VALUE_INVALID']);
  const factInsert = callMatching(calls, /INSERT INTO fact\.full_webapi_value_added_service_observation/);
  assert.equal(factInsert.params.length, VAS_INSERT_COLUMN_COUNT * 3);
  // Row 1: boolean true -> 1, string false -> 0, string true -> 1.
  assert.equal(factInsert.params[18], 1);
  assert.equal(factInsert.params[25], 0);
  assert.equal(factInsert.params[32], 1);
  // Row 2: boolean false -> 0, case-insensitive TRUE -> 1.
  assert.equal(factInsert.params[VAS_INSERT_COLUMN_COUNT + 21], 0);
  assert.equal(factInsert.params[VAS_INSERT_COLUMN_COUNT + 29], 1);
  // Row 3: string false -> 0.
  assert.equal(factInsert.params[2 * VAS_INSERT_COLUMN_COUNT + 32], 0);
  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /'yes'|"yes"/);
});

test('recordPageEvidence stores exact source hashes without materializing business rows', async () => {
  const evidenceAttemptKey = attemptKey(
    RUN_KEY,
    'DL5477',
    'VALUE_ADDED_SERVICES_PAGE',
    SCHEMA_HASH,
  );
  const sourcePayloadHash = '9'.repeat(64);
  const { calls, pool } = fakePool([
    {
      match: /FROM ops\.v4_collection_attempt[\s\S]*WHERE attempt_key = \$1/,
      rows: [{
        collection_attempt_id: 41,
        store_code: 'DL5477',
        endpoint_code: 'VALUE_ADDED_SERVICES_PAGE',
        attempt_status: 'RUNNING',
      }],
    },
    {
      match: /FROM ops\.v4_page_evidence[\s\S]*WHERE page_key = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO ops\.v4_page_evidence/,
      rows(sql, params) {
        return [{
          page_evidence_id: 42,
          page_key: params[1],
          payload_hash: params[6],
          row_count: params[7],
          rejected_row_count: params[8],
        }];
      },
      rowCount: 1,
    },
  ]);
  const repository = createFullWebapiFactRepository({ pool });

  const result = await repository.recordPageEvidence({
    storeCode: 'DL5477',
    endpointCode: 'VALUE_ADDED_SERVICES_PAGE',
    attemptKey: evidenceAttemptKey,
    pageNumber: 1,
    pageSize: 50,
    pageRequestFingerprint: PAGE_FINGERPRINT,
    responseSchemaHash: RESPONSE_SCHEMA_HASH,
    payloadHash: sourcePayloadHash,
    httpStatus: 200,
    observedAt: '2026-08-08T12:00:00.000Z',
    rowCount: 3,
  });

  assert.equal(result.pageEvidenceId, 42);
  assert.equal(result.payloadHash, sourcePayloadHash);
  assert.equal(result.rowCount, 3);
  assert.equal(result.rejectedRowCount, 0);
  assert.equal(result.replayed, false);
  assert.ok(!calls.some(({ sql }) => /INSERT INTO fact\./.test(sql)));
  const insert = callMatching(calls, /INSERT INTO ops\.v4_page_evidence/);
  assert.equal(insert.params[0], 41);
  assert.equal(insert.params[6], sourcePayloadHash);
  assert.equal(insert.params[7], 3);
  assert.equal(insert.params[10], 'SUCCEEDED');
});

test('insertTypedFacts rejects sensitive keys with sanitized codes and never echoes values', async () => {
  const { calls, pool } = fakePool([
    attemptLookup,
    {
      match: /FROM ops\.v4_page_evidence[\s\S]*WHERE page_key = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO ops\.v4_page_evidence/,
      rows: [{ page_evidence_id: 12 }],
      rowCount: 1,
    },
    {
      match: /payload_hash,[\s\S]*FROM fact\.full_webapi_stock_record_observation[\s\S]*WHERE source_attempt_id = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO fact\.full_webapi_stock_record_observation/,
      rows: [],
      rowCount: 1,
    },
    {
      match: /payload_hash\s+FROM fact\.full_webapi_stock_record_observation[\s\S]*ORDER BY/,
      rows(sql, params, allCalls) {
        const insert = callMatching(allCalls, /INSERT INTO fact\.full_webapi_stock_record_observation/);
        if (!insert) return [];
        const perRow = 18;
        const rows = [];
        for (let index = 0; index < insert.params.length; index += perRow) {
          rows.push({
            entity_key_hash: insert.params[index + 1],
            source_version_token: insert.params[index + 2],
            payload_hash: insert.params[index + 7],
          });
        }
        return rows;
      },
    },
  ]);
  const repository = createFullWebapiFactRepository({ pool });

  const result = await repository.insertTypedFacts({
    pageId: 'stock-records',
    storeCode: 'DL5477',
    endpointCode: 'STOCK_RECORDS_LIST',
    attemptKey: ATTEMPT_KEY,
    pageNumber: 1,
    pageSize: 100,
    pageRequestFingerprint: PAGE_FINGERPRINT,
    responseSchemaHash: RESPONSE_SCHEMA_HASH,
    observedAt: '2026-08-08T12:00:00.000Z',
    rows: [
      { id: 'SR-2001', supplierCode: 'SUP-01', apiKey: 'sk-live-12345' },
      { id: 'SR-2002', supplierCode: 'SUP-02', buyerName: '张三' },
      { id: 'SR-2003', supplierCode: 'SUP-03', receiverAddress: '某街道1号' },
      { id: 'SR-2004', supplierCode: 'SUP-04', skc: 'SKC-4' },
    ],
  });

  assert.equal(result.acceptedRowCount, 1);
  assert.equal(result.rejectedRowCount, 3);
  assert.deepEqual(result.rejectedCodes, ['V4_SENSITIVE_KEY_REJECTED']);
  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /sk-live-12345/);
  assert.doesNotMatch(serialized, /张三/);
  assert.doesNotMatch(serialized, /某街道1号/);
  assert.doesNotMatch(serialized, /apiKey|buyerName|receiverAddress/);
});

test('insertTypedFacts rejects PII values and invalid typed values without echoing them', async () => {
  const { calls, pool } = fakePool([
    attemptLookup,
    {
      match: /FROM ops\.v4_page_evidence[\s\S]*WHERE page_key = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO ops\.v4_page_evidence/,
      rows: [{ page_evidence_id: 13 }],
      rowCount: 1,
    },
    {
      match: /payload_hash,[\s\S]*FROM fact\.full_webapi_stock_record_observation[\s\S]*WHERE source_attempt_id = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO fact\.full_webapi_stock_record_observation/,
      rows: [],
      rowCount: 0,
    },
    {
      match: /payload_hash\s+FROM fact\.full_webapi_stock_record_observation[\s\S]*ORDER BY/,
      rows(sql, params, allCalls) {
        const insert = callMatching(allCalls, /INSERT INTO fact\.full_webapi_stock_record_observation/);
        if (!insert) return [];
        const perRow = 18;
        const rows = [];
        for (let index = 0; index < insert.params.length; index += perRow) {
          rows.push({
            entity_key_hash: insert.params[index + 1],
            source_version_token: insert.params[index + 2],
            payload_hash: insert.params[index + 7],
          });
        }
        return rows;
      },
    },
  ]);
  const repository = createFullWebapiFactRepository({ pool });

  const result = await repository.insertTypedFacts({
    pageId: 'stock-records',
    storeCode: 'DL5477',
    endpointCode: 'STOCK_RECORDS_LIST',
    attemptKey: ATTEMPT_KEY,
    pageNumber: 1,
    pageSize: 100,
    pageRequestFingerprint: PAGE_FINGERPRINT,
    responseSchemaHash: RESPONSE_SCHEMA_HASH,
    observedAt: '2026-08-08T12:00:00.000Z',
    rows: [
      { id: 'SR-3001', supplierCode: '13800138000' },
      { id: 'SR-3002', supplierCode: 'contact@example.com' },
      { id: 'SR-3003', supplierCode: 'SUP-03', addTime: '联系人 张三' },
      { id: 'SR-3004', orderMode: 'not-an-int' },
      { id: 'SR-3005', supplierCode: 'X'.repeat(200) },
      { supplierCode: 'SUP-06' },
      { id: 'SR-3007', supplierCode: 'SUP-07', skc: 'SKC-7' },
    ],
  });

  assert.equal(result.acceptedRowCount, 1);
  assert.equal(result.rejectedRowCount, 6);
  assert.ok(result.rejectedCodes.includes('V4_PII_VALUE_REJECTED'));
  assert.ok(result.rejectedCodes.includes('V4_TYPED_VALUE_INVALID'));
  assert.ok(result.rejectedCodes.includes('V4_ENTITY_KEY_MISSING'));
  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /13800138000/);
  assert.doesNotMatch(serialized, /contact@example\.com/);
  assert.doesNotMatch(serialized, /联系人/);
  assert.doesNotMatch(serialized, /not-an-int/);
});

test('insertTypedFacts replays identical attempt rows exactly and rolls back on drift', async () => {
  const rawRow = {
    id: 'SR-5001',
    supplierCode: 'SUP-5',
    skc: 'SKC-5',
    addTime: '2026-08-08T10:00:00.000Z',
  };
  const picked = { addTime: rawRow.addTime, id: rawRow.id, skc: rawRow.skc, supplierCode: rawRow.supplierCode };
  const versionToken = sha256(`${DOMAIN.version}${canonicalJson(picked)}`);
  const entity = entityHash(rawRow.id);
  const typed = {
    add_time: rawRow.addTime,
    skc: rawRow.skc,
    supplier_code: rawRow.supplierCode,
  };
  const payload = sha256(
    `${DOMAIN.payload}${canonicalJson({ entityKeyHash: entity, sourceVersionToken: versionToken, typed })}`,
  );
  const storedRow = {
    entity_key_hash: entity,
    source_version_token: versionToken,
    payload_hash: payload,
    order_no_hash: null,
    supplier_code: 'SUP-5',
    skc: 'SKC-5',
    order_mode: null,
    order_mode_value: null,
    apply_status: null,
    stock_type: null,
    order_sign: null,
    add_time: '2026-08-08T10:00:00.000Z',
    timezone: null,
  };
  const pagePayloadHash = sha256(
    'full-managed.v4.page-payload:'
      + canonicalJson([
        canonicalJson({
          storeCode: 'DL5477',
          entityKeyHash: entity,
          sourceVersionToken: versionToken,
          sourceUpdatedAt: '2026-08-08T10:00:00.000Z',
          payloadHash: payload,
          typed: canonicalJson(typed),
        }),
      ]),
  );

  const replayPool = fakePool([
    attemptLookup,
    {
      match: /FROM ops\.v4_page_evidence[\s\S]*WHERE page_key = \$1/,
      rows: [{
        page_evidence_id: 21,
        page_number: 1,
        page_size: 100,
        page_request_fingerprint: PAGE_FINGERPRINT,
        response_schema_hash: RESPONSE_SCHEMA_HASH,
        payload_hash: pagePayloadHash,
        row_count: 1,
        rejected_row_count: 0,
        http_status: 200,
        fetch_status: 'SUCCEEDED',
      }],
    },
    {
      match: /payload_hash,[\s\S]*FROM fact\.full_webapi_stock_record_observation[\s\S]*WHERE source_attempt_id = \$1/,
      rows: [storedRow],
    },
    {
      match: /payload_hash\s+FROM fact\.full_webapi_stock_record_observation[\s\S]*ORDER BY/,
      rows: [storedRow],
    },
  ]);
  const repository = createFullWebapiFactRepository({ pool: replayPool.pool });
  const result = await repository.insertTypedFacts({
    pageId: 'stock-records',
    storeCode: 'DL5477',
    endpointCode: 'STOCK_RECORDS_LIST',
    attemptKey: ATTEMPT_KEY,
    pageNumber: 1,
    pageSize: 100,
    pageRequestFingerprint: PAGE_FINGERPRINT,
    responseSchemaHash: RESPONSE_SCHEMA_HASH,
    httpStatus: 200,
    observedAt: '2026-08-08T12:00:00.000Z',
    rows: [rawRow],
  });
  assert.equal(result.replayedRowCount, 1);
  assert.equal(result.insertedRowCount, 0);
  assert.equal(result.pageEvidenceId, 21);
  assert.deepEqual(result.readback, {
    rowCount: 1,
    payloadHashesMatch: true,
    expectedRowCount: 1,
  });
  assert.equal(
    callMatching(replayPool.calls, /INSERT INTO fact\.full_webapi_stock_record_observation/),
    undefined,
  );

  const driftPool = fakePool([
    attemptLookup,
    {
      match: /FROM ops\.v4_page_evidence[\s\S]*WHERE page_key = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO ops\.v4_page_evidence/,
      rows: [{ page_evidence_id: 22 }],
      rowCount: 1,
    },
    {
      match: /payload_hash,[\s\S]*FROM fact\.full_webapi_stock_record_observation[\s\S]*WHERE source_attempt_id = \$1/,
      rows: [{ ...storedRow, payload_hash: '0'.repeat(64) }],
    },
  ]);
  await assert.rejects(
    createFullWebapiFactRepository({ pool: driftPool.pool }).insertTypedFacts({
      pageId: 'stock-records',
      storeCode: 'DL5477',
      endpointCode: 'STOCK_RECORDS_LIST',
      attemptKey: ATTEMPT_KEY,
      pageNumber: 1,
      pageSize: 100,
      pageRequestFingerprint: PAGE_FINGERPRINT,
      responseSchemaHash: RESPONSE_SCHEMA_HASH,
      observedAt: '2026-08-08T12:00:00.000Z',
      rows: [rawRow],
    }),
    (error) => error instanceof V4CollectionError && error.code === 'V4_FACT_REPLAY_DRIFT',
  );
  assert.ok(driftPool.calls.some(({ sql }) => sql === 'ROLLBACK'));
});

test('insertTypedFacts refuses evidence for an already terminal attempt', async () => {
  const pool = fakePool([
    {
      ...attemptLookup,
      rows: [{
        collection_attempt_id: 10,
        collection_run_id: 1,
        store_code: 'DL5477',
        endpoint_code: 'STOCK_RECORDS_LIST',
        attempt_status: 'SUCCEEDED',
      }],
    },
    {
      match: /FROM ops\.v4_page_evidence[\s\S]*WHERE page_key = \$1/,
      rows: [],
    },
  ]);
  await assert.rejects(
    createFullWebapiFactRepository({ pool: pool.pool }).insertTypedFacts({
      pageId: 'stock-records',
      storeCode: 'DL5477',
      endpointCode: 'STOCK_RECORDS_LIST',
      attemptKey: ATTEMPT_KEY,
      pageNumber: 1,
      pageSize: 100,
      pageRequestFingerprint: PAGE_FINGERPRINT,
      responseSchemaHash: RESPONSE_SCHEMA_HASH,
      observedAt: '2026-08-08T12:00:00.000Z',
      rows: [{ id: 'SR-6001', supplierCode: 'SUP-6' }],
    }),
    (error) => error instanceof V4CollectionError && error.code === 'V4_ATTEMPT_TERMINAL',
  );
});

test('finalizeCoverage writes evidence-derived store counts and paging/dedupe flags', async () => {
  const { calls, pool } = fakePool([
    {
      match: /FROM ops\.v4_collection_run[\s\S]*WHERE run_key = \$1/,
      rows: [{
        collection_run_id: 1,
        run_status: 'SUCCEEDED',
        expected_store_count: 1,
        expected_endpoint_count: 1,
        store_codes: ['DL5477'],
      }],
    },
    {
      match: /SELECT coverage_id, completed_store_count[\s\S]*reason_code\s+FROM ops\.v4_collection_coverage/,
      rows: [],
    },
    {
      match: /SELECT coverage_id, completed_store_count[\s\S]*row_count\s+FROM ops\.v4_collection_coverage(?![\s\S]*reason_code)/,
      rows: [{
        coverage_id: 5,
        completed_store_count: 1,
        partial_store_count: 0,
        unknown_store_count: 0,
        row_count: '3',
      }],
    },
    {
      match: /SELECT store_code, attempt_status, count\(\*\)::integer AS attempt_count[\s\S]*GROUP BY store_code, attempt_status/,
      rows: [{ store_code: 'DL5477', attempt_status: 'SUCCEEDED', attempt_count: 1 }],
    },
    {
      match: /SELECT COALESCE\(sum\(page\.row_count\), 0\)::bigint AS row_count/,
      rows: [{ row_count: '3' }],
    },
    {
      match: /INSERT INTO ops\.v4_collection_coverage/,
      rows: [{ coverage_id: 5 }],
      rowCount: 1,
    },
  ]);
  const repository = createFullWebapiFactRepository({ pool });

  const result = await repository.finalizeCoverage({
    runKey: RUN_KEY,
    pagingVerified: true,
    dedupeVerified: true,
    asOf: '2026-08-08T12:00:00.000Z',
  });

  assert.deepEqual(result, {
    coverageId: 5,
    expectedStoreCount: 1,
    completedStoreCount: 1,
    partialStoreCount: 0,
    unknownStoreCount: 0,
    rowCount: 3,
    replayed: false,
  });
  const insert = callMatching(calls, /INSERT INTO ops\.v4_collection_coverage/);
  assert.deepEqual(insert.params, [
    1, 1, 1, 0, 0, 1, true, true, 3, null,
  ]);
  assert.match(insert.sql, /clock_timestamp\(\)/);
  assert.ok(calls.some(({ sql }) => /GROUP BY store_code, attempt_status/.test(sql)));
});

test('finalizeCoverage keeps blocked stores unknown and requires a reason for partial runs', async () => {
  const { calls, pool } = fakePool([
    {
      match: /FROM ops\.v4_collection_run[\s\S]*WHERE run_key = \$1/,
      rows: [{
        collection_run_id: 2,
        run_status: 'PARTIAL',
        expected_store_count: 1,
        expected_endpoint_count: 1,
        store_codes: ['MZ2406'],
      }],
    },
    {
      match: /SELECT coverage_id, completed_store_count[\s\S]*reason_code\s+FROM ops\.v4_collection_coverage/,
      rows: [],
    },
    {
      match: /SELECT coverage_id, completed_store_count[\s\S]*row_count\s+FROM ops\.v4_collection_coverage(?![\s\S]*reason_code)/,
      rows: [{
        coverage_id: 6,
        completed_store_count: 0,
        partial_store_count: 0,
        unknown_store_count: 1,
        row_count: '0',
      }],
    },
    {
      match: /SELECT store_code, attempt_status, count\(\*\)::integer AS attempt_count[\s\S]*GROUP BY store_code, attempt_status/,
      rows: [{ store_code: 'MZ2406', attempt_status: 'BLOCKED', attempt_count: 1 }],
    },
    {
      match: /SELECT COALESCE\(sum\(page\.row_count\), 0\)::bigint AS row_count/,
      rows: [{ row_count: '0' }],
    },
    {
      match: /INSERT INTO ops\.v4_collection_coverage/,
      rows: [{ coverage_id: 6 }],
      rowCount: 1,
    },
  ]);
  const repository = createFullWebapiFactRepository({ pool });

  const result = await repository.finalizeCoverage({
    runKey: RUN_KEY,
    pagingVerified: false,
    dedupeVerified: false,
    reasonCode: 'CREDENTIAL_BLOCKED',
    asOf: '2026-08-08T12:00:00.000Z',
  });

  assert.equal(result.completedStoreCount, 0);
  assert.equal(result.unknownStoreCount, 1);
  assert.equal(result.rowCount, 0);
  const insert = callMatching(calls, /INSERT INTO ops\.v4_collection_coverage/);
  assert.deepEqual(insert.params, [
    2, 1, 0, 0, 1, 1, false, false, 0, 'CREDENTIAL_BLOCKED',
  ]);
  assert.match(insert.sql, /clock_timestamp\(\)/);
});

test('recordCapabilityObservation writes only business_materialized=false and replays exactly', async () => {
  const { calls, pool } = fakePool([
    {
      match: /FROM ops\.v4_collection_run[\s\S]*WHERE run_key = \$1/,
      rows: [{ collection_run_id: 1, run_status: 'RUNNING' }],
    },
    {
      match: /SELECT capability_observation_id, store_code, endpoint_code[\s\S]*FROM ops\.v4_capability_observation\s+WHERE observation_key = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO ops\.v4_capability_observation/,
      rows: [{ capability_observation_id: 9 }],
      rowCount: 1,
    },
  ]);
  const repository = createFullWebapiFactRepository({ pool });

  const result = await repository.recordCapabilityObservation({
    runKey: RUN_KEY,
    endpointCode: 'VALUE_ADDED_SERVICES_PAGE',
    capabilityCode: 'VALUE_ADDED_SERVICES',
    capabilityStatus: 'UNVERIFIED',
    payloadHash: '9'.repeat(64),
    observedAt: '2026-08-08T12:00:00.000Z',
  });

  assert.equal(result.businessMaterialized, false);
  assert.equal(result.capabilityObservationId, 9);
  const insert = callMatching(calls, /INSERT INTO ops\.v4_capability_observation/);
  assert.match(insert.params[0], /^[0-9a-f]{64}$/);
  assert.equal(insert.params[1], 1);
  assert.equal(insert.params[2], null);
  assert.equal(insert.params[3], 'VALUE_ADDED_SERVICES_PAGE');
  assert.equal(insert.params[4], 'VALUE_ADDED_SERVICES');
  assert.equal(insert.params[5], 'UNVERIFIED');
  assert.equal(insert.params[6], '9'.repeat(64));
  assert.match(insert.sql, /business_materialized[\s\S]*false/);

  const replayPool = fakePool([
    {
      match: /FROM ops\.v4_collection_run[\s\S]*WHERE run_key = \$1/,
      rows: [{ collection_run_id: 1, run_status: 'RUNNING' }],
    },
    {
      match: /SELECT capability_observation_id, store_code, endpoint_code[\s\S]*FROM ops\.v4_capability_observation\s+WHERE observation_key = \$1/,
      rows: [{
        capability_observation_id: 9,
        store_code: null,
        endpoint_code: 'VALUE_ADDED_SERVICES_PAGE',
        capability_code: 'VALUE_ADDED_SERVICES',
        capability_status: 'UNVERIFIED',
        payload_hash: '9'.repeat(64),
        observed_at: '2026-08-08T12:00:00.000Z',
        source_updated_at: null,
        sanitized_error_code: null,
      }],
    },
  ]);
  const replayed = await createFullWebapiFactRepository({
    pool: replayPool.pool,
  }).recordCapabilityObservation({
    runKey: RUN_KEY,
    endpointCode: 'VALUE_ADDED_SERVICES_PAGE',
    capabilityCode: 'VALUE_ADDED_SERVICES',
    capabilityStatus: 'UNVERIFIED',
    payloadHash: '9'.repeat(64),
    observedAt: '2026-08-08T12:00:00.000Z',
  });
  assert.equal(replayed.replayed, true);
  assert.equal(
    callMatching(replayPool.calls, /INSERT INTO ops\.v4_capability_observation/),
    undefined,
  );

  const terminalPool = fakePool([
    {
      match: /FROM ops\.v4_collection_run[\s\S]*WHERE run_key = \$1/,
      rows: [{ collection_run_id: 1, run_status: 'SUCCEEDED' }],
    },
  ]);
  await assert.rejects(
    createFullWebapiFactRepository({ pool: terminalPool.pool }).recordCapabilityObservation({
      runKey: RUN_KEY,
      endpointCode: 'VALUE_ADDED_SERVICES_PAGE',
      capabilityCode: 'VALUE_ADDED_SERVICES',
      capabilityStatus: 'UNVERIFIED',
      payloadHash: '9'.repeat(64),
      observedAt: '2026-08-08T12:00:00.000Z',
    }),
    (error) => error instanceof V4CollectionError && error.code === 'V4_RUN_TERMINAL',
  );
});

test('transitionRun walks the strict state machine with terminal timestamps', async () => {
  const current = {
    collection_run_id: 1,
    run_status: 'RUNNING',
    started_at: '2026-08-08T10:00:00.000Z',
  };
  const pool = fakePool([
    {
      match: /SELECT collection_run_id, run_status, started_at\s+FROM ops\.v4_collection_run\s+WHERE run_key = \$1/,
      rows: [current],
    },
    {
      match: /UPDATE ops\.v4_collection_run/,
      rows: [{ collection_run_id: 1, run_status: 'SUCCEEDED' }],
      rowCount: 1,
    },
  ]);
  const repository = createFullWebapiFactRepository({ pool: pool.pool });

  const result = await repository.transitionRun({
    runKey: RUN_KEY,
    status: 'SUCCEEDED',
  });
  assert.equal(result.runStatus, 'SUCCEEDED');
  const update = callMatching(pool.calls, /UPDATE ops\.v4_collection_run/);
  assert.equal(update.params[1], 'SUCCEEDED');
  assert.equal(update.params[2], false);
  assert.equal(update.params[3], true);
  assert.equal(update.params[4], null);
  assert.match(update.sql, /clock_timestamp\(\)/);
  assert.ok(!update.sql.includes('2026-08-'));

  const runningPool = fakePool([
    {
      match: /SELECT collection_run_id, run_status, started_at\s+FROM ops\.v4_collection_run\s+WHERE run_key = \$1/,
      rows: [{ collection_run_id: 1, run_status: 'PREFLIGHT_PASSED', started_at: null }],
    },
    {
      match: /UPDATE ops\.v4_collection_run/,
      rows: [{ collection_run_id: 1, run_status: 'RUNNING' }],
      rowCount: 1,
    },
  ]);
  await createFullWebapiFactRepository({ pool: runningPool.pool }).transitionRun({
    runKey: RUN_KEY,
    status: 'RUNNING',
  });
  const runningUpdate = callMatching(runningPool.calls, /UPDATE ops\.v4_collection_run/);
  assert.equal(runningUpdate.params[2], true);
  assert.equal(runningUpdate.params[3], false);
  assert.match(runningUpdate.sql, /clock_timestamp\(\)/);

  const failedPool = fakePool([
    {
      match: /SELECT collection_run_id, run_status, started_at\s+FROM ops\.v4_collection_run\s+WHERE run_key = \$1/,
      rows: [{ ...current, run_status: 'PLANNED', started_at: null }],
    },
    {
      match: /UPDATE ops\.v4_collection_run/,
      rows: [{ collection_run_id: 1, run_status: 'FAILED' }],
      rowCount: 1,
    },
  ]);
  await createFullWebapiFactRepository({ pool: failedPool.pool }).transitionRun({
    runKey: RUN_KEY,
    status: 'FAILED',
    sanitizedErrorCode: 'PREFLIGHT_FAILED',
  });
  const failedUpdate = callMatching(failedPool.calls, /UPDATE ops\.v4_collection_run/);
  assert.equal(failedUpdate.params[1], 'FAILED');
  assert.equal(failedUpdate.params[4], 'PREFLIGHT_FAILED');
  assert.match(failedUpdate.sql, /clock_timestamp\(\)/);
});

test('state-transition timestamps are server-side clock_timestamp(), never a client clock', async () => {
  // A stale host clock (here an impossible 2020 instant) must never reach the
  // ledger: run/attempt transitions and the coverage as-of are written by the
  // database itself, so the DB timeline can never regress below created_at.
  const staleClientInstant = '2020-01-01T00:00:00.000Z';

  const runPool = fakePool([
    {
      match: /SELECT collection_run_id, run_status, started_at\s+FROM ops\.v4_collection_run\s+WHERE run_key = \$1/,
      rows: [{ collection_run_id: 1, run_status: 'PREFLIGHT_PASSED', started_at: null }],
    },
    {
      match: /UPDATE ops\.v4_collection_run/,
      rows: [{ collection_run_id: 1, run_status: 'RUNNING' }],
      rowCount: 1,
    },
  ]);
  await createFullWebapiFactRepository({ pool: runPool.pool }).transitionRun({
    runKey: RUN_KEY,
    status: 'RUNNING',
  });
  const runUpdate = callMatching(runPool.calls, /UPDATE ops\.v4_collection_run/);
  assert.match(runUpdate.sql, /clock_timestamp\(\)/);
  assert.ok(!JSON.stringify(runUpdate.params).includes(staleClientInstant));
  assert.equal(runUpdate.params[2], true);
  assert.equal(runUpdate.params[3], false);

  const attemptPool = fakePool([
    {
      match: /SELECT collection_attempt_id, attempt_status, started_at\s+FROM ops\.v4_collection_attempt\s+WHERE attempt_key = \$1/,
      rows: [{ collection_attempt_id: 10, attempt_status: 'RUNNING', started_at: null }],
    },
    {
      match: /UPDATE ops\.v4_collection_attempt/,
      rows: [{ collection_attempt_id: 10, attempt_status: 'FAILED' }],
      rowCount: 1,
    },
  ]);
  await createFullWebapiFactRepository({ pool: attemptPool.pool }).transitionAttempt({
    attemptKey: ATTEMPT_KEY,
    status: 'FAILED',
    sanitizedErrorCode: 'PAGE_FETCH_FAILED',
  });
  const attemptUpdate = callMatching(attemptPool.calls, /UPDATE ops\.v4_collection_attempt/);
  assert.match(attemptUpdate.sql, /clock_timestamp\(\)/);
  assert.ok(!JSON.stringify(attemptUpdate.params).includes(staleClientInstant));
  assert.equal(attemptUpdate.params[2], false);
  assert.equal(attemptUpdate.params[3], true);

  const birthPool = fakePool([
    {
      match: /FROM ops\.v4_collection_run[\s\S]*WHERE run_key = \$1/,
      rows: [{ collection_run_id: 1, run_status: 'PREFLIGHT_PASSED' }],
    },
    {
      match: /SELECT collection_attempt_id, attempt_key, attempt_status[\s\S]*request_schema_hash[\s\S]*WHERE collection_run_id = \$1 AND store_code = \$2 AND endpoint_code = \$3/,
      rows: [],
    },
    {
      match: /INSERT INTO ops\.v4_collection_attempt/,
      rows: [{ collection_attempt_id: 12, attempt_status: 'BLOCKED' }],
      rowCount: 1,
    },
    {
      match: /SELECT collection_attempt_id, attempt_key, attempt_status\s+FROM ops\.v4_collection_attempt\s+WHERE collection_attempt_id = \$1/,
      rows: [{
        collection_attempt_id: 12,
        attempt_key: attemptKey(RUN_KEY, 'MZ2406', 'EXCEPTIONS_PAGE', SCHEMA_HASH),
        attempt_status: 'BLOCKED',
      }],
    },
  ]);
  await createFullWebapiFactRepository({ pool: birthPool.pool }).beginAttempt({
    runKey: RUN_KEY,
    storeCode: 'MZ2406',
    endpointCode: 'EXCEPTIONS_PAGE',
    requestSchemaHash: SCHEMA_HASH,
    requestFingerprint: REQUEST_FINGERPRINT,
    initialStatus: 'BLOCKED',
    sanitizedErrorCode: 'CREDENTIAL_BLOCKED',
  });
  const birthInsert = callMatching(birthPool.calls, /INSERT INTO ops\.v4_collection_attempt/);
  assert.match(birthInsert.sql, /clock_timestamp\(\)/);
  assert.ok(!JSON.stringify(birthInsert.params).includes(staleClientInstant));
  assert.equal(birthInsert.params[10], true);

  const coveragePool = fakePool([
    {
      match: /FROM ops\.v4_collection_run[\s\S]*WHERE run_key = \$1/,
      rows: [{
        collection_run_id: 1,
        run_status: 'FAILED',
        expected_store_count: 1,
        expected_endpoint_count: 1,
        store_codes: ['DL5477'],
      }],
    },
    {
      match: /SELECT coverage_id, completed_store_count[\s\S]*reason_code\s+FROM ops\.v4_collection_coverage/,
      rows: [],
    },
    {
      match: /SELECT coverage_id, completed_store_count[\s\S]*row_count\s+FROM ops\.v4_collection_coverage(?![\s\S]*reason_code)/,
      rows: [{
        coverage_id: 7,
        completed_store_count: 0,
        partial_store_count: 0,
        unknown_store_count: 1,
        row_count: '0',
      }],
    },
    {
      match: /SELECT store_code, attempt_status, count\(\*\)::integer AS attempt_count[\s\S]*GROUP BY store_code, attempt_status/,
      rows: [{ store_code: 'DL5477', attempt_status: 'FAILED', attempt_count: 1 }],
    },
    {
      match: /SELECT COALESCE\(sum\(page\.row_count\), 0\)::bigint AS row_count/,
      rows: [{ row_count: '0' }],
    },
    {
      match: /INSERT INTO ops\.v4_collection_coverage/,
      rows: [{ coverage_id: 7 }],
      rowCount: 1,
    },
  ]);
  await createFullWebapiFactRepository({ pool: coveragePool.pool }).finalizeCoverage({
    runKey: RUN_KEY,
    pagingVerified: false,
    dedupeVerified: false,
    reasonCode: 'V4_COLLECTION_PERSIST_FAILED',
  });
  const coverageInsert = callMatching(coveragePool.calls, /INSERT INTO ops\.v4_collection_coverage/);
  assert.match(coverageInsert.sql, /clock_timestamp\(\)/);
  assert.ok(!JSON.stringify(coverageInsert.params).includes(staleClientInstant));
  assert.equal(coverageInsert.params.length, 10);
});

test('insertTypedFacts fails closed when the exact readback cannot prove row count or hashes', async () => {
  const rows = [
    {
      id: '20260808123456789001',
      supplierCode: 'SUP-01',
      skc: 'SKC-A',
      addTime: '2026-08-08T10:00:00.000Z',
    },
    {
      id: 'SR-1002',
      supplierCode: 'SUP-02',
      skc: 'SKC-B',
      addTime: '2026-08-08T11:00:00.000Z',
    },
  ];
  const baseEntries = [
    attemptLookup,
    {
      match: /FROM ops\.v4_page_evidence[\s\S]*WHERE page_key = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO ops\.v4_page_evidence/,
      rows: [{ page_evidence_id: 31 }],
      rowCount: 1,
    },
    {
      match: /payload_hash,[\s\S]*FROM fact\.full_webapi_stock_record_observation[\s\S]*WHERE source_attempt_id = \$1/,
      rows: [],
    },
    {
      match: /INSERT INTO fact\.full_webapi_stock_record_observation/,
      rows: [],
      rowCount: 2,
    },
  ];
  const call = (pool) => createFullWebapiFactRepository({ pool: pool.pool }).insertTypedFacts({
    pageId: 'stock-records',
    storeCode: 'DL5477',
    endpointCode: 'STOCK_RECORDS_LIST',
    attemptKey: ATTEMPT_KEY,
    pageNumber: 1,
    pageSize: 100,
    pageRequestFingerprint: PAGE_FINGERPRINT,
    responseSchemaHash: RESPONSE_SCHEMA_HASH,
    observedAt: '2026-08-08T12:00:00.000Z',
    rows,
  });
  const expectMismatch = (error) => (
    error instanceof V4CollectionError && error.code === 'V4_COLLECTION_READBACK_MISMATCH'
  );

  // The readback returns only one of the two written rows: the expected row
  // count cannot be proven, so the whole page rolls back.
  const countPool = fakePool([
    ...baseEntries,
    {
      match: /payload_hash\s+FROM fact\.full_webapi_stock_record_observation[\s\S]*ORDER BY/,
      rows(sql, params, allCalls) {
        const insert = callMatching(allCalls, /INSERT INTO fact\.full_webapi_stock_record_observation/);
        if (!insert) return [];
        return [{
          entity_key_hash: insert.params[1],
          source_version_token: insert.params[2],
          payload_hash: insert.params[7],
        }];
      },
    },
  ]);
  await assert.rejects(call(countPool), expectMismatch);
  assert.ok(countPool.calls.some(({ sql }) => sql === 'ROLLBACK'));

  // The readback returns the right count but one drifted payload hash: the
  // exact hashes cannot be proven, so the whole page rolls back.
  const hashPool = fakePool([
    ...baseEntries,
    {
      match: /payload_hash\s+FROM fact\.full_webapi_stock_record_observation[\s\S]*ORDER BY/,
      rows(sql, params, allCalls) {
        const insert = callMatching(allCalls, /INSERT INTO fact\.full_webapi_stock_record_observation/);
        if (!insert) return [];
        const perRow = 18;
        const readbackRows = [];
        for (let index = 0; index < insert.params.length; index += perRow) {
          readbackRows.push({
            entity_key_hash: insert.params[index + 1],
            source_version_token: insert.params[index + 2],
            payload_hash: index === 0 ? '0'.repeat(64) : insert.params[index + 7],
          });
        }
        return readbackRows;
      },
    },
  ]);
  await assert.rejects(call(hashPool), expectMismatch);
  assert.ok(hashPool.calls.some(({ sql }) => sql === 'ROLLBACK'));
});
