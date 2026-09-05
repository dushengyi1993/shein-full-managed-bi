import assert from "node:assert/strict";
import test from "node:test";
import {
  PgEndpoint,
  MAX_INSERT_PARAMETERS,
  TABLES,
  applyPrepareBatch,
} from "../../scripts/fnos_webhook_cutover.mjs";

function sampleReceiptRow(index = 1, overrides = {}) {
  return {
    receipt_id: String(9007199254740991n + BigInt(index)),
    idempotency_key: "idem-" + index,
    app_key_hash: "a".repeat(64),
    open_key_hash: "b".repeat(64),
    event_code: "ORDER_CREATED",
    event_path: "/webhook/order",
    store_id: "888888888888888888",
    delivery_scope: "GLOBAL",
    platform_timestamp: "2026-09-06 12:34:56.123456+00",
    cipher_sha256: "c".repeat(64),
    ciphertext: "encrypted-payload-" + index,
    safe_projection: { order_id: 1000 + index, meta: { trace: "t-" + index } },
    duplicate_count: "0",
    last_duplicate_at: null,
    received_at: "2026-09-06 12:34:56.654321+00",
    created_at: "2026-09-06 12:34:56.789012+00",
    ...overrides,
  };
}

test("constructor: maxInsertParameters rejects 0, negative, NaN, Infinity, >60000, non-integers, and non-numbers", () => {
  const invalidValues = [
    0,
    -1,
    -100,
    NaN,
    Infinity,
    -Infinity,
    60001,
    100000,
    "60000",
    "32",
    "0",
    1.5,
    3.14,
    true,
    false,
    {},
    [],
  ];

  for (const invalid of invalidValues) {
    assert.throws(
      () => new PgEndpoint({}, "target", { maxInsertParameters: invalid }),
      { name: "WebhookCutoverError", code: "BATCH_SIZE_INVALID" },
      `must reject invalid maxInsertParameters: ${invalid}`
    );
  }

  // Valid values
  const defaultEp = new PgEndpoint({}, "target");
  assert.equal(defaultEp.maxInsertParameters, 60000);

  const customEp = new PgEndpoint({}, "target", { maxInsertParameters: 32 });
  assert.equal(customEp.maxInsertParameters, 32);

  const maxEp = new PgEndpoint({}, "target", { maxInsertParameters: 60000 });
  assert.equal(maxEp.maxInsertParameters, 60000);
});

test("applyInsertBatch: fails closed with zero queries when table column count exceeds maxInsertParameters", async () => {
  const queries = [];
  // receipt table has 16 columns; set maxInsertParameters to 15 (less than column count)
  const endpoint = new PgEndpoint({}, "target", { maxInsertParameters: 15 });
  endpoint.client = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      return { rowCount: 1 };
    },
  };

  const row = sampleReceiptRow(1);
  await assert.rejects(
    async () => endpoint.applyInsertBatch("receipt", [row]),
    { name: "WebhookCutoverError", code: "BATCH_SIZE_INVALID" }
  );

  // Assert ZERO database queries were attempted
  assert.equal(queries.length, 0, "must fail closed before executing any query when columns > capacity");
});

test("applyInsertBatch: empty rows array makes no database queries and returns cleanly", async () => {
  const queries = [];
  const endpoint = new PgEndpoint({}, "target", { batchSize: 250 });
  endpoint.client = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      return { rowCount: 0 };
    },
  };

  await endpoint.applyInsertBatch("receipt", []);
  assert.equal(queries.length, 0);
});

test("applyInsertBatch: single row inserts with parameterized values, ::jsonb cast, and OVERRIDING SYSTEM VALUE", async () => {
  const queries = [];
  const endpoint = new PgEndpoint({}, "target", { batchSize: 250 });
  endpoint.client = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      return { rowCount: 1 };
    },
  };

  const row = sampleReceiptRow(1);
  await endpoint.applyInsertBatch("receipt", [row]);

  assert.equal(queries.length, 1);
  const q = queries[0];
  assert.match(q.sql, /^INSERT INTO "raw"\."webhook_receipt" \(.*\) OVERRIDING SYSTEM VALUE VALUES \(/);
  assert.match(q.sql, /\$12::jsonb/);
  assert.equal(q.values.length, 16);
  assert.equal(q.values[0], row.receipt_id);
  assert.deepEqual(q.values[11], row.safe_projection);
});

test("applyInsertBatch: parameter-bound chunking when maxInsertParameters is smaller than batchSize * columns", async () => {
  const queries = [];
  // 16 columns per receipt row; maxInsertParameters = 32 allows exactly 2 rows per query
  const endpoint = new PgEndpoint({}, "target", { batchSize: 100, maxInsertParameters: 32 });
  endpoint.client = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      return { rowCount: values.length / 16 };
    },
  };

  const rows = [
    sampleReceiptRow(1),
    sampleReceiptRow(2),
    sampleReceiptRow(3),
    sampleReceiptRow(4),
    sampleReceiptRow(5),
  ];

  await endpoint.applyInsertBatch("receipt", rows);

  // 5 rows / 2 per chunk = 3 queries (chunks of 2, 2, 1)
  assert.equal(queries.length, 3);
  assert.equal(queries[0].values.length, 32);
  assert.equal(queries[1].values.length, 32);
  assert.equal(queries[2].values.length, 16);
  for (const q of queries) {
    assert.ok(q.values.length <= 32);
  }
});

test("applyInsertBatch: multi-batch boundary chunking with maximum allowed batchSize=1000 and maxInsertParameters=60000", async () => {
  const queries = [];
  // Default maxInsertParameters = 60000; allowed batchSize up to MAX_BATCH_SIZE (1000)
  const endpoint = new PgEndpoint({}, "target", { batchSize: 1000 });
  endpoint.client = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      return { rowCount: values.length / 16 };
    },
  };

  // Generate 2500 receipt rows
  const rows = [];
  for (let i = 1; i <= 2500; i += 1) {
    rows.push(sampleReceiptRow(i));
  }

  await endpoint.applyInsertBatch("receipt", rows);

  // 2500 rows with batchSize 1000 chunks into: 1000, 1000, 500
  assert.equal(queries.length, 3);
  assert.equal(queries[0].values.length, 16000); // 1000 * 16 <= 60000
  assert.equal(queries[1].values.length, 16000); // 1000 * 16 <= 60000
  assert.equal(queries[2].values.length, 8000);  // 500 * 16 <= 60000

  for (const q of queries) {
    assert.ok(q.values.length <= 60000, "query parameter count must never exceed 60000");
  }
});

test("applyInsertBatch: fail-fast on batch 2 prevents batch 3 from executing (no further queries or retry)", async () => {
  const queries = [];
  // 3 batches of 1 row each (batchSize: 1, 3 rows)
  const endpoint = new PgEndpoint({}, "target", { batchSize: 1 });
  let callCount = 0;
  endpoint.client = {
    query: async (sql, values) => {
      callCount += 1;
      queries.push({ callCount, values });
      if (callCount === 2) {
        throw new Error("batch 2 database connection error");
      }
      return { rowCount: 1 };
    },
  };

  const rows = [sampleReceiptRow(1), sampleReceiptRow(2), sampleReceiptRow(3)];

  await assert.rejects(
    async () => endpoint.applyInsertBatch("receipt", rows),
    /batch 2 database connection error/
  );

  // Assert query 1 ran, query 2 failed, and query 3 was NEVER called!
  assert.equal(queries.length, 2, "must halt immediately when batch 2 fails; batch 3 must never be executed");
  assert.equal(callCount, 2);
});

test("applyInsertBatch: JSON casting and complex JSON objects preserved correctly", async () => {
  const queries = [];
  const endpoint = new PgEndpoint({}, "target");
  endpoint.client = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      return { rowCount: 1 };
    },
  };

  const complexJson = {
    nested: { array: [1, "two", { deep: true }], empty: null },
    unicode: "中文测试_🚀",
  };
  const row = sampleReceiptRow(42, { safe_projection: complexJson });
  await endpoint.applyInsertBatch("receipt", [row]);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].values[11], complexJson);
  assert.match(queries[0].sql, /\$12::jsonb/);
});

test("applyInsertBatch: large integer (bigint / 64-bit) values are preserved without truncation", async () => {
  const queries = [];
  const endpoint = new PgEndpoint({}, "target");
  endpoint.client = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      return { rowCount: 1 };
    },
  };

  const hugeReceiptId = "9223372036854775806";
  const hugeStoreId = "9223372036854775800";
  const row = sampleReceiptRow(99, {
    receipt_id: hugeReceiptId,
    store_id: hugeStoreId,
  });
  await endpoint.applyInsertBatch("receipt", [row]);

  assert.equal(queries[0].values[0], hugeReceiptId);
  assert.equal(queries[0].values[6], hugeStoreId);
});

test("applyInsertBatch: microseconds in ISO timestamps are preserved and Date objects are rejected", async () => {
  const queries = [];
  const endpoint = new PgEndpoint({}, "target");
  endpoint.client = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      return { rowCount: 1 };
    },
  };

  const microTimestamp = "2026-09-06 08:15:30.987654+00";
  const row = sampleReceiptRow(1, { platform_timestamp: microTimestamp });
  await endpoint.applyInsertBatch("receipt", [row]);
  assert.equal(queries[0].values[8], microTimestamp);

  const invalidRow = sampleReceiptRow(2, { received_at: new Date() });
  await assert.rejects(
    async () => endpoint.applyInsertBatch("receipt", [invalidRow]),
    { name: "WebhookCutoverError", code: "DATE_PRECISION_LOSS" }
  );
});

test("applyInsertBatch: rowCount mismatch fails closed with INSERT_CARDINALITY_MISMATCH", async () => {
  const endpoint = new PgEndpoint({}, "target");
  endpoint.client = {
    query: async () => ({ rowCount: 0 }),
  };

  const rows = [sampleReceiptRow(1), sampleReceiptRow(2)];
  await assert.rejects(
    async () => endpoint.applyInsertBatch("receipt", rows),
    { name: "WebhookCutoverError", code: "INSERT_CARDINALITY_MISMATCH" }
  );
});

test("applyInsertBatch: database errors propagate directly without retry or fallback", async () => {
  const endpoint = new PgEndpoint({}, "target");
  let attempts = 0;
  endpoint.client = {
    query: async () => {
      attempts += 1;
      throw new Error("unique constraint violation: raw_webhook_receipt_pkey");
    },
  };

  const rows = [sampleReceiptRow(1), sampleReceiptRow(2)];
  await assert.rejects(
    async () => endpoint.applyInsertBatch("receipt", rows),
    /unique constraint violation/
  );
  assert.equal(attempts, 1, "failed batch must not be retried or fall back to single-row re-execution");
});

test("applyPrepareBatch: contiguous inserts are batched together and interleaved update order is strictly preserved", async () => {
  const opLog = [];
  const definition = TABLES.find((t) => t.key === "receipt");

  const targetEndpoint = {
    fetchDigestEntriesByKeys: async (key, keys) => {
      return [
        {
          key: { receipt_id: "2" },
          immutableHash: "h-imm-2",
          fullHash: "h-full-old",
          mutable: { duplicate_count: "0", last_duplicate_at: null },
        },
      ];
    },
    applyInsertBatch: async (key, rows) => {
      opLog.push({ type: "batch_insert", key, receipt_ids: rows.map((r) => r.receipt_id) });
    },
    applyOperation: async (op) => {
      opLog.push({ type: "single_op", action: op.action, duplicate_count: op.row?.duplicate_count });
    },
  };

  const sourceRows = {
    "1": sampleReceiptRow(1, { receipt_id: "1" }),
    "3": sampleReceiptRow(3, { receipt_id: "3" }),
    "4": sampleReceiptRow(4, { receipt_id: "4" }),
  };

  const sourceEndpoint = {
    fetchRowsByKeys: async (key, keys) => {
      return keys.map((k) => sourceRows[k.receipt_id]);
    },
  };

  const sourceEntries = [
    { key: { receipt_id: "1" }, immutableHash: "h-imm-1", fullHash: "h-full-1" },
    { key: { receipt_id: "2" }, immutableHash: "h-imm-2", fullHash: "h-full-new", mutable: { duplicate_count: "1", last_duplicate_at: "2026-09-06 12:00:00.000000+00" } },
    { key: { receipt_id: "3" }, immutableHash: "h-imm-3", fullHash: "h-full-3" },
    { key: { receipt_id: "4" }, immutableHash: "h-imm-4", fullHash: "h-full-4" },
  ];

  await applyPrepareBatch({
    sourceEndpoint,
    targetEndpoint,
    definition,
    sourceEntries,
  });

  assert.deepEqual(opLog, [
    { type: "batch_insert", key: "receipt", receipt_ids: ["1"] },
    { type: "single_op", action: "update", duplicate_count: "1" },
    { type: "batch_insert", key: "receipt", receipt_ids: ["3", "4"] },
  ]);
});

test("applyPrepareBatch: test endpoints without applyInsertBatch gracefully fall back to single-row applyOperation", async () => {
  const opLog = [];
  const definition = TABLES.find((t) => t.key === "receipt");

  const legacyTestEndpoint = {
    fetchDigestEntriesByKeys: async () => [],
    applyOperation: async (op) => {
      opLog.push({ type: "single_op", action: op.action, receipt_id: op.row.receipt_id });
    },
  };

  const sourceRows = {
    "1": sampleReceiptRow(1, { receipt_id: "1" }),
    "2": sampleReceiptRow(2, { receipt_id: "2" }),
  };

  const sourceEndpoint = {
    fetchRowsByKeys: async (key, keys) => {
      return keys.map((k) => sourceRows[k.receipt_id]);
    },
  };

  const sourceEntries = [
    { key: { receipt_id: "1" }, immutableHash: "h-imm-1", fullHash: "h-full-1" },
    { key: { receipt_id: "2" }, immutableHash: "h-imm-2", fullHash: "h-full-2" },
  ];

  await applyPrepareBatch({
    sourceEndpoint,
    targetEndpoint: legacyTestEndpoint,
    definition,
    sourceEntries,
  });

  assert.deepEqual(opLog, [
    { type: "single_op", action: "insert", receipt_id: "1" },
    { type: "single_op", action: "insert", receipt_id: "2" },
  ]);
});

test("evidence: PgEndpoint exposes applyInsertBatch and executes multi-row VALUES tuple in new code path", async () => {
  const endpoint = new PgEndpoint({}, "target", { batchSize: 250 });
  assert.equal(typeof endpoint.applyInsertBatch, "function");

  let executed = null;
  endpoint.client = {
    query: async (sql, values) => {
      executed = { sql, values };
      return { rowCount: 2 };
    },
  };

  await endpoint.applyInsertBatch("receipt", [sampleReceiptRow(1), sampleReceiptRow(2)]);
  assert.ok(executed);
  assert.equal(executed.values.length, 32);
  assert.match(executed.sql, /VALUES \(.*\), \(.*\)/);
});
