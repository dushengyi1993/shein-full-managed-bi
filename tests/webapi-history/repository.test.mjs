import assert from 'node:assert/strict';
import test from 'node:test';

import { createFullHomeHistoryRepository } from '../../src/webapi-history/repository.mjs';

function fakePool() {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/RETURNING webapi_home_fetch_audit_id/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ webapi_home_fetch_audit_id: '12' }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {
      calls.push({ sql: 'RELEASE' });
    },
  };
  return {
    calls,
    pool: {
      async connect() {
        return client;
      },
    },
  };
}

test('store daily upsert selects the narrow WebAPI role and never null-coerces metrics', async () => {
  const runtime = fakePool();
  const repository = createFullHomeHistoryRepository({ pool: runtime.pool });
  await repository.upsertStoreDaily([{
    storeCode: 'DL5477',
    businessDate: '2026-07-28',
    dealAmount: null,
    salesQuantity: 4,
    exposureUsers: null,
    observedAt: '2026-07-29T00:00:00.000Z',
    sourceCode: 'WEBAPI_INDEX',
  }]);
  assert.equal(runtime.calls[0].sql, 'BEGIN');
  assert.equal(runtime.calls[1].sql, 'SET LOCAL ROLE sheinfm_webapi_loader');
  const upsert = runtime.calls.find((call) => /INSERT INTO fact\.full_home_store_daily/.test(call.sql));
  assert.ok(upsert);
  assert.equal(upsert.params[3], null);
  assert.equal(upsert.params[5], 4);
  assert.equal(upsert.params[8], null);
  assert.equal(upsert.params[9], 'UNAVAILABLE');
  assert.match(upsert.sql, /COALESCE\(EXCLUDED\.deal_amount/);
  assert.match(upsert.sql, /'WEBAPI_INDEX' = ANY\(EXCLUDED\.source_codes\)/);
  assert.match(
    upsert.sql,
    /ARRAY\['WEBAPI_INDEX', 'WEBAPI_REALTIME'\]::text\[\]/,
  );
  assert.match(upsert.sql, /'WEBAPI_TRADE' = ANY\(EXCLUDED\.source_codes\)/);
  assert.match(upsert.sql, /array_remove\([\s\S]*'WEBAPI_REALTIME'/);
  assert.match(upsert.sql, /A late realtime replay must not downgrade/);
  assert.equal(runtime.calls.at(-2).sql, 'COMMIT');
  assert.equal(runtime.calls.at(-1).sql, 'RELEASE');
});

test('ledger upsert persists every reviewed subtotal under the narrow WebAPI role', async () => {
  const runtime = fakePool();
  const repository = createFullHomeHistoryRepository({ pool: runtime.pool });
  await repository.upsertLedgerDaily([{
    storeCode: 'MZ2406',
    businessDate: '2026-08-01',
    beginBalanceCount: 5247,
    inboundCount: 521,
    outboundCount: 546,
    endBalanceCount: 5222,
    customerOutboundCount: 521,
    supplierOutboundCount: 25,
    beginBalanceAmount: 215645.94,
    inboundAmount: 16914.6,
    outboundAmount: 17533.47,
    endBalanceAmount: 212213.16,
    observedAt: '2026-08-02T10:00:00.000Z',
  }]);
  assert.equal(runtime.calls[1].sql, 'SET LOCAL ROLE sheinfm_webapi_loader');
  const insert = runtime.calls.find(
    ({ sql }) => /INSERT INTO fact\.full_home_ledger_daily/.test(sql),
  );
  assert.ok(insert);
  const payload = JSON.parse(insert.params[0]);
  assert.equal(payload[0].outbound_count, 546);
  assert.equal(payload[0].customer_outbound_count, 521);
  assert.equal(payload[0].quality_status, 'COMPLETE');
  assert.match(insert.sql, /ON CONFLICT \(store_code, business_date\) DO UPDATE/);
});

test('fetch audit stores bounded hashes and counts, never a response body', async () => {
  const runtime = fakePool();
  const repository = createFullHomeHistoryRepository({ pool: runtime.pool });
  const result = await repository.recordFetchAudit({
    storeCode: 'MZ2406',
    endpointCode: 'STORE_DAILY_HISTORY',
    requestedStartDate: '2026-07-28',
    requestedEndDate: '2026-07-28',
    request: { startDate: '2026-07-28', endDate: '2026-07-28' },
    responseSchemaSha256: 'a'.repeat(64),
    responseBodySha256: 'b'.repeat(64),
    httpStatus: 200,
    resultStatus: 'SUCCEEDED',
    acceptedRowCount: 1,
    rejectedRowCount: 0,
    observedAt: '2026-07-29T00:00:00.000Z',
    completedAt: '2026-07-29T00:00:01.000Z',
  });
  assert.deepEqual(result, {
    inserted: true,
    webapiHomeFetchAuditId: '12',
  });
  const insert = runtime.calls.find((call) => /INSERT INTO raw\.webapi_home_fetch_audit/.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.params.length, 15);
  assert.equal(insert.params[6], 'a'.repeat(64));
  assert.equal(insert.params[7], 'b'.repeat(64));
  assert.doesNotMatch(insert.sql, /response_body\b/);
});

test('successful daily dates read only completed same-day endpoint audits', async () => {
  const runtime = fakePool();
  runtime.pool.connect = async () => ({
    async query(sql, params) {
      runtime.calls.push({ sql: String(sql), params });
      if (/SELECT requested_start_date::text/.test(sql)) {
        return { rows: [{ business_date: '2026-07-28' }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {
      runtime.calls.push({ sql: 'RELEASE' });
    },
  });
  const repository = createFullHomeHistoryRepository({ pool: runtime.pool });
  const dates = await repository.successfulDailyDates({
    storeCode: 'DL5477',
    endpointCode: 'REGION_RANK',
    startDate: '2026-07-01',
    endDate: '2026-07-31',
  });
  assert.deepEqual([...dates], ['2026-07-28']);
  const select = runtime.calls.find((call) => /SELECT requested_start_date::text/.test(call.sql));
  assert.deepEqual(select.params, ['DL5477', 'REGION_RANK', '2026-07-01', '2026-07-31']);
  assert.match(select.sql, /result_status = 'SUCCEEDED'/);
  assert.match(select.sql, /requested_start_date = requested_end_date/);
});
