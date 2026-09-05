import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  DEFAULT_SAMPLE_CONFIG,
  ReadOnlySamplingEndpoint,
  main,
  parseReadCostArguments,
  runReadCostMeasurement,
  sampleReceiptFullRows,
  sampleTableDigestRows,
  sanitizeSampleProgress,
} from "../../scripts/measure_fnos_webhook_read_cost.mjs";

function fakeIdentity(systemIdentifier = "1000000000000000001") {
  return {
    systemIdentifier,
    currentDatabase: "shein_fm",
    sessionUser: "sheinfm",
    currentUser: "sheinfm",
    roleSuperuser: true,
    roleBypassRls: true,
    serverAddress: "127.0.0.1/32",
    serverPort: "5432",
    serverVersionNum: "160014",
    applicationName: "shein_fm_fnos_webhook_cutover_v4",
  };
}

class FakeQueryClient extends EventEmitter {
  constructor({ identity = fakeIdentity(), rowCount = 50000 } = {}) {
    super();
    this.identity = identity;
    this.rowCount = rowCount;
    this.executedQueries = [];
    this.released = false;
    this.destroyed = false;
  }

  async query(sql, values = []) {
    this.executedQueries.push({ sql: String(sql), values });
    const text = String(sql).trim();

    if (text.startsWith("BEGIN")) return { rows: [] };
    if (text.startsWith("SET LOCAL")) return { rows: [] };
    if (text.startsWith("ROLLBACK")) return { rows: [] };

    if (text.includes("pg_control_system()")) {
      return {
        rows: [{
          system_identifier: this.identity.systemIdentifier,
          current_database: this.identity.currentDatabase,
          session_user: this.identity.sessionUser,
          current_user: this.identity.currentUser,
          rolsuper: this.identity.roleSuperuser,
          rolbypassrls: this.identity.roleBypassRls,
          server_address: this.identity.serverAddress,
          server_port: this.identity.serverPort,
          server_version_num: this.identity.serverVersionNum,
          application_name: this.identity.applicationName,
        }],
      };
    }

    if (text.includes("pg_class AS object")) {
      const names = values[0] ?? [];
      return {
        rows: names.map((name) => ({
          name,
          oid: "123456",
          owner: "sheinfm",
        })),
      };
    }

    // Handle SELECT receipt_id ... ORDER BY receipt_id DESC LIMIT 1000
    if (text.includes("ORDER BY \"receipt_id\" DESC") || text.includes("ORDER BY receipt_id DESC")) {
      const limit = Math.min(1000, Number(values[0] ?? 1000));
      const rows = [];
      const startId = this.rowCount;
      const endId = Math.max(1, startId - limit + 1);
      for (let id = startId; id >= endId; id -= 1) {
        rows.push({ receipt_id: String(id) });
      }
      return { rows };
    }

    // Handle fetchRowsByKeys: predicate is snapshot_row.receipt_id = ANY($1::bigint[])
    // PostgreSQL returns rows in primaryKey ASC order
    if (text.includes("ANY($1::bigint[])")) {
      const requestedIds = (values[0] ?? []).map((id) => Number(id)).sort((a, b) => a - b);
      const rows = requestedIds.map((id) => ({
        receipt_id: String(id),
        idempotency_key: "k".repeat(64),
        app_key_hash: "a".repeat(64),
        open_key_hash: "o".repeat(64),
        event_code: "1234567",
        event_path: "/event/test",
        store_id: "1",
        delivery_scope: "STORE",
        platform_timestamp: "2026-09-03 12:34:56.789123+00",
        cipher_sha256: "c".repeat(64),
        ciphertext: Buffer.from("test-cipher").toString("base64"),
        safe_projection: { secret_sentinel_payload: "should_never_be_printed" },
        duplicate_count: 0,
        last_duplicate_at: null,
        received_at: "2026-09-03 12:34:56.789123+00",
        created_at: "2026-09-03 12:34:56.789123+00",
      }));
      return { rows };
    }

    // Handle scanDigestEntries
    if (text.includes("webhook_receipt") || text.includes("webhook_runtime_heartbeat")) {
      const limit = Number(values[values.length - 1] ?? 10000);
      const cursorVal = Number(values[0] ?? 0);
      const startId = cursorVal > 0 ? cursorVal + 1 : 1;
      const endId = Math.min(this.rowCount, startId + limit - 1);
      const rows = [];
      for (let id = startId; id <= endId; id += 1) {
        rows.push({
          receipt_id: String(id),
          webhook_runtime_heartbeat_id: String(id),
          __key_hash: "a".repeat(64),
          __full_hash: "b".repeat(64),
          __immutable_hash: "c".repeat(64),
          duplicate_count: 0,
          last_duplicate_at: null,
        });
      }
      return { rows };
    }

    return { rows: [] };
  }

  release(destroy = false) {
    this.released = true;
    if (destroy) this.destroyed = true;
  }
}

class FakePool {
  constructor(client) {
    this.client = client;
    this.connectCallCount = 0;
    this.ended = false;
  }

  async connect() {
    this.connectCallCount += 1;
    return this.client;
  }

  async end() {
    this.ended = true;
  }
}

test("read-cost: default execution performs 0 network requests and outputs plan configuration", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutText = "";
  let stderrText = "";
  stdout.on("data", (chunk) => { stdoutText += chunk.toString("utf8"); });
  stderr.on("data", (chunk) => { stderrText += chunk.toString("utf8"); });

  let spawnCalled = false;
  const exitCode = await main({
    argv: [],
    environment: {},
    stdout,
    stderr,
    spawnImpl: () => { spawnCalled = true; throw new Error("network / spawn forbidden"); },
  });

  assert.equal(exitCode, 0);
  assert.equal(spawnCalled, false);
  assert.equal(stderrText, "");

  const parsed = JSON.parse(stdoutText);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mode, "plan-only");
  assert.equal(parsed.executeReadOnly, false);
  assert.equal(parsed.fullRowSample, false);
  assert.deepEqual(parsed.config, DEFAULT_SAMPLE_CONFIG);
  assert.ok(parsed.notice);
});

test("read-cost: parseReadCostArguments supports only --execute-read-only and --full-row-sample combination", () => {
  assert.deepEqual(parseReadCostArguments([]), { executeReadOnly: false, fullRowSample: false });
  assert.deepEqual(parseReadCostArguments(["--execute-read-only"]), { executeReadOnly: true, fullRowSample: false });
  assert.deepEqual(parseReadCostArguments(["--execute-read-only", "--full-row-sample"]), { executeReadOnly: true, fullRowSample: true });

  // Rejects duplicate flags
  assert.throws(() => parseReadCostArguments(["--execute-read-only", "--execute-read-only"]), {
    code: "DUPLICATE_ARGUMENT",
  });
  assert.throws(() => parseReadCostArguments(["--execute-read-only", "--full-row-sample", "--full-row-sample"]), {
    code: "DUPLICATE_ARGUMENT",
  });

  // Rejects --full-row-sample without --execute-read-only
  assert.throws(() => parseReadCostArguments(["--full-row-sample"]), {
    code: "INVALID_ARGUMENT",
  });

  // Rejects arbitrary flags or sql injection flags
  assert.throws(() => parseReadCostArguments(["--execute"]), { code: "INVALID_ARGUMENT" });
  assert.throws(() => parseReadCostArguments(["--table", "users"]), { code: "INVALID_ARGUMENT" });
  assert.throws(() => parseReadCostArguments(["--sql", "SELECT 1"]), { code: "INVALID_ARGUMENT" });
});

test("read-cost: sanitizeSampleProgress strictly enforces role/table/number allowlist and drops unallowlisted fields", () => {
  assert.equal(sanitizeSampleProgress(null), null);
  assert.equal(sanitizeSampleProgress({ role: "invalid" }), null);
  assert.equal(sanitizeSampleProgress({ role: "cloud", table: "invalid_table", page: 1, rowCount: 10, durationMs: 100 }), null);

  // Digest progress event
  const validDigest = sanitizeSampleProgress({
    role: "cloud",
    table: "receipt",
    page: 1,
    rowCount: 10000,
    durationMs: 450,
    sql: "SELECT * FROM raw.webhook_receipt",
    connectionUrl: "postgresql://secret@host:5432/db",
    databaseName: "shein_fm",
    payload: { sensitive: "leak" },
    rows: [{ receipt_id: 1 }],
  });

  assert.deepEqual(validDigest, {
    role: "cloud",
    table: "receipt",
    page: 1,
    rowCount: 10000,
    durationMs: 450,
  });
  assert.equal("sql" in validDigest, false);
  assert.equal("connectionUrl" in validDigest, false);
  assert.equal("databaseName" in validDigest, false);
  assert.equal("payload" in validDigest, false);
  assert.equal("rows" in validDigest, false);

  // Full row sample progress event
  const validRowSample = sanitizeSampleProgress({
    role: "fnos",
    table: "rowSample receipt",
    rowCount: 1000,
    utf8JsonBytes: 456789,
    durationMs: 320,
    secretToken: "secret_sentinel",
    sql: "SELECT * FROM secrets",
    payload: { hidden: true },
  });

  assert.deepEqual(validRowSample, {
    role: "fnos",
    table: "rowSample receipt",
    rowCount: 1000,
    utf8JsonBytes: 456789,
    durationMs: 320,
  });
  assert.equal("secretToken" in validRowSample, false);
  assert.equal("sql" in validRowSample, false);
  assert.equal("payload" in validRowSample, false);
});

test("read-cost: exact read-only transaction executes strictly without table locks, advisory locks, DDL, or writes", async () => {
  const client = new FakeQueryClient();
  const pool = new FakePool(client);
  const endpoint = new ReadOnlySamplingEndpoint(pool, "source", {
    batchSize: 1000,
    digestBatchSize: 10000,
  });

  await endpoint.beginReadOnly();
  await endpoint.rollback();
  endpoint.release();

  const queries = client.executedQueries.map((q) => q.sql.trim());
  assert.equal(queries[0], "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(queries[1], "SET LOCAL lock_timeout TO '2s'");
  assert.equal(queries[2], "SET LOCAL statement_timeout TO '30s'");
  assert.equal(queries[3], "SET LOCAL TIME ZONE 'UTC'");
  assert.equal(queries[4], "SET LOCAL DateStyle TO 'ISO, YMD'");
  assert.equal(queries[5], "ROLLBACK");

  // Prove zero table lock, advisory lock, DDL, or writes
  for (const q of queries) {
    assert.equal(q.includes("LOCK TABLE"), false);
    assert.equal(q.includes("pg_advisory_xact_lock"), false);
    assert.equal(q.startsWith("INSERT"), false);
    assert.equal(q.startsWith("UPDATE"), false);
    assert.equal(q.startsWith("DELETE"), false);
    assert.equal(q.startsWith("ALTER"), false);
    assert.equal(q.startsWith("CREATE"), false);
    assert.equal(q.startsWith("DROP"), false);
  }
  assert.equal(client.released, true);
});

test("read-cost: sampleReceiptFullRows queries descending IDs with LIMIT 1000, sorts keys ascending, and fetches full rows cleanly", async () => {
  const client = new FakeQueryClient({ rowCount: 40000 });
  const pool = new FakePool(client);
  const endpoint = new ReadOnlySamplingEndpoint(pool, "source", {
    batchSize: 1000,
    digestBatchSize: 10000,
  });

  await endpoint.beginReadOnly();

  const events = [];
  const sample = await sampleReceiptFullRows({
    endpoint,
    role: "cloud",
    maxRows: 1000,
    onPage: (ev) => events.push(ev),
  });

  await endpoint.rollback();
  endpoint.release();

  // Verify result format
  assert.equal(sample.role, "cloud");
  assert.equal(sample.table, "rowSample receipt");
  assert.equal(sample.rowCount, 1000);
  assert.ok(Number.isSafeInteger(sample.utf8JsonBytes) && sample.utf8JsonBytes > 0);
  assert.ok(Number.isSafeInteger(sample.durationMs) && sample.durationMs >= 0);

  // Verify output never contains raw row keys or sentinel payloads
  assert.equal("safe_projection" in sample, false);
  assert.equal("secret_sentinel_payload" in sample, false);
  assert.equal("rows" in sample, false);
  assert.equal("sql" in sample, false);

  // Verify query execution details
  const descQuery = client.executedQueries.find((q) => q.sql.includes("ORDER BY \"receipt_id\" DESC") || q.sql.includes("ORDER BY receipt_id DESC"));
  assert.ok(descQuery);
  assert.equal(descQuery.values[0], 1000);

  const fetchQuery = client.executedQueries.find((q) => q.sql.includes("ANY($1::bigint[])"));
  assert.ok(fetchQuery);
  assert.equal(fetchQuery.values[0].length, 1000);
  // Verify fetchRowsByKeys received ascending keys so no order mismatch error occurred
  const passedKeys = fetchQuery.values[0];
  for (let i = 1; i < passedKeys.length; i += 1) {
    assert.ok(BigInt(passedKeys[i - 1]) < BigInt(passedKeys[i]));
  }
});

test("read-cost: limit of 30,000 rows never scans extra pages on a 50,000 row table", async () => {
  const client = new FakeQueryClient({ rowCount: 50000 });
  const pool = new FakePool(client);
  const endpoint = new ReadOnlySamplingEndpoint(pool, "source", {
    digestBatchSize: 10000,
  });
  await endpoint.beginReadOnly();

  const pages = [];
  const sample = await sampleTableDigestRows({
    endpoint,
    role: "cloud",
    tableKey: "receipt",
    maxRows: 30000,
    digestBatchSize: 10000,
    onPage: (ev) => pages.push(ev),
  });

  await endpoint.rollback();
  endpoint.release();

  assert.equal(sample.totalRows, 30000);
  assert.equal(sample.pages, 3);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((p) => p.page), [1, 2, 3]);
  assert.deepEqual(pages.map((p) => p.rowCount), [10000, 10000, 10000]);

  // Prove the query was executed exactly 3 times for 30000 rows, NOT 4 or 5 times
  const selectQueries = client.executedQueries.filter((q) => q.sql.includes("webhook_receipt"));
  assert.equal(selectQueries.length, 3);
});

test("read-cost: identity mismatch stops immediately with 0 scan queries executed", async () => {
  const client = new FakeQueryClient({ identity: fakeIdentity("1111111111111111111") });
  const pool = new FakePool(client);
  const endpoint = new ReadOnlySamplingEndpoint(pool, "source", {
    approvedIdentityFingerprint: "e".repeat(64), // mismatched fingerprint
  });

  await endpoint.beginReadOnly();
  await assert.rejects(async () => {
    await endpoint.assertApprovedIdentity();
  }, { code: "SSH_ENDPOINT_IDENTITY_MISMATCH" });

  await endpoint.rollback();
  endpoint.release();

  // Verify 0 scan queries were executed
  const scanQueries = client.executedQueries.filter((q) =>
    q.sql.includes("webhook_receipt") || q.sql.includes("webhook_runtime_heartbeat")
  );
  assert.equal(scanQueries.length, 0);
});

test("read-cost: runReadCostMeasurement rolls back, releases endpoints, and respects fullRowSample flag", async () => {
  const cloudClient = new FakeQueryClient({ rowCount: 15000 });
  const fnosClient = new FakeQueryClient({ rowCount: 5000 });
  const cloudPool = new FakePool(cloudClient);
  const fnosPool = new FakePool(fnosClient);

  const cloudEndpoint = new ReadOnlySamplingEndpoint(cloudPool, "source", { digestBatchSize: 10000 });
  const fnosEndpoint = new ReadOnlySamplingEndpoint(fnosPool, "target", { digestBatchSize: 10000 });

  cloudEndpoint.assertApprovedIdentity = async () => cloudClient.identity;
  fnosEndpoint.assertApprovedIdentity = async () => fnosClient.identity;

  // 1. Without fullRowSample (default digest sampling only)
  const defaultResult = await runReadCostMeasurement({
    cloudEndpoint,
    fnosEndpoint,
    config: {
      ...DEFAULT_SAMPLE_CONFIG,
      maxRowsPerTable: 20000,
    },
    fullRowSample: false,
  });

  assert.equal(defaultResult.ok, true);
  assert.equal(defaultResult.mode, "sample-complete");
  assert.equal(defaultResult.executeReadOnly, true);
  assert.equal(defaultResult.fullRowSample, false);
  assert.equal(defaultResult.samples.length, 4); // [cloud receipt, cloud heartbeat, fnos receipt, fnos heartbeat]
  assert.ok(defaultResult.samples.every((s) => s.table === "receipt" || s.table === "heartbeat"));

  // 2. With fullRowSample (digest + tail 1000 full row sample in the same read-only session)
  const fullRowResult = await runReadCostMeasurement({
    cloudEndpoint,
    fnosEndpoint,
    config: {
      ...DEFAULT_SAMPLE_CONFIG,
      maxRowsPerTable: 20000,
    },
    fullRowSample: true,
  });

  assert.equal(fullRowResult.ok, true);
  assert.equal(fullRowResult.fullRowSample, true);
  assert.equal(fullRowResult.samples.length, 6); // [cloud receipt, cloud heartbeat, cloud rowSample, fnos receipt, fnos heartbeat, fnos rowSample]
  const rowSamples = fullRowResult.samples.filter((s) => s.table === "rowSample receipt");
  assert.equal(rowSamples.length, 2);
  assert.equal(rowSamples[0].role, "cloud");
  assert.equal(rowSamples[0].rowCount, 1000);
  assert.ok(rowSamples[0].utf8JsonBytes > 0);
  assert.equal(rowSamples[1].role, "fnos");
  assert.equal(rowSamples[1].rowCount, 1000);
  assert.ok(rowSamples[1].utf8JsonBytes > 0);

  // Summary must NOT claim full snapshot or produce cutover conclusions
  assert.equal("planHash" in fullRowResult, false);
  assert.equal("baselineFingerprint" in fullRowResult, false);
  assert.equal("readyForForwardBaseline" in fullRowResult, false);
  assert.equal("readyForCloudStart" in fullRowResult, false);

  assert.equal(cloudClient.released, true);
  assert.equal(fnosClient.released, true);

  // Verify both clients rolled back
  assert.ok(cloudClient.executedQueries.some((q) => q.sql.trim() === "ROLLBACK"));
  assert.ok(fnosClient.executedQueries.some((q) => q.sql.trim() === "ROLLBACK"));
});

test("read-cost: failure cleanup triggers rollback and never echoes sensitive errors", async () => {
  const stderr = new PassThrough();
  const stdout = new PassThrough();
  let stderrText = "";
  stderr.on("data", (chunk) => { stderrText += chunk.toString("utf8"); });

  const exitCode = await main({
    argv: ["--execute-read-only"],
    environment: {
      USERPROFILE: "",
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1);
  const failure = JSON.parse(stderrText.trim());
  assert.equal(failure.ok, false);
  assert.equal(typeof failure.errorCode, "string");
  // Sensitive error text or cause must not be echoed
  assert.equal("cause" in failure, false);
  assert.equal("sql" in failure, false);
  assert.equal("password" in failure, false);
  assert.equal("connectionUrl" in failure, false);
});

test("read-cost: environment FNOS_WEBHOOK_DIGEST_BATCH_SIZE override cannot alter fixed 10000 digestBatchSize or cause extra pages", async () => {
  const client = new FakeQueryClient({ rowCount: 50000 });
  const pool = new FakePool(client);
  const endpoint = new ReadOnlySamplingEndpoint(pool, "source", {
    batchSize: DEFAULT_SAMPLE_CONFIG.batchSize,
    digestBatchSize: DEFAULT_SAMPLE_CONFIG.digestBatchSize,
  });
  assert.equal(endpoint.digestBatchSize, 10000);

  await endpoint.beginReadOnly();
  const pages = [];
  const sample = await sampleTableDigestRows({
    endpoint,
    role: "cloud",
    tableKey: "receipt",
    maxRows: DEFAULT_SAMPLE_CONFIG.maxRowsPerTable,
    digestBatchSize: DEFAULT_SAMPLE_CONFIG.digestBatchSize,
    onPage: (ev) => pages.push(ev),
  });
  await endpoint.rollback();
  endpoint.release();

  assert.equal(sample.totalRows, 30000);
  assert.equal(sample.pages, 3);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((p) => p.rowCount), [10000, 10000, 10000]);

  const selectQueries = client.executedQueries.filter((q) => q.sql.includes("webhook_receipt"));
  assert.equal(selectQueries.length, 3);
  for (const q of selectQueries) {
    const limitVal = q.values[q.values.length - 1];
    assert.equal(limitVal, 10000);
  }
});
