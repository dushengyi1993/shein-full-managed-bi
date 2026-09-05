import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  MANAGED_TRIGGERS,
  PgEndpoint,
  TABLES,
  identityFingerprint,
  runPrepareForward,
  snapshotEndpoint,
} from "../../scripts/fnos_webhook_cutover.mjs";
import {
  SshCutoverLauncherError,
  launcherConfiguration,
  runSshLauncher,
} from "../../scripts/fnos_webhook_cutover_ssh.mjs";

const { Pool } = pg;

function buildTestIdentity(systemId) {
  const objectNames = [
    ...TABLES.map((d) => d.relation),
    ...TABLES.filter((d) => d.sequence).map((d) => d.sequence),
  ];
  const objects = Object.fromEntries(objectNames.map((name, i) => [name, { oid: String(i + 1), owner: "sheinfm" }]));
  return {
    systemIdentifier: String(systemId),
    currentDatabase: "shein_fm",
    sessionUser: "sheinfm",
    currentUser: "sheinfm",
    roleSuperuser: true,
    roleBypassRls: true,
    serverAddress: "127.0.0.1/32",
    serverPort: "5432",
    serverVersionNum: "160014",
    applicationName: "shein_fm_fnos_webhook_cutover_v4",
    objects,
  };
}

test("PgEndpoint scanDigestEntries uses independent digestBatchSize while scanRows keeps batchSize", async () => {
  const recordedQueries = [];
  const fakeClient = {
    query: async (sql, values) => {
      recordedQueries.push({ sql, values });
      return { rows: [] };
    },
  };

  const endpoint = new PgEndpoint({}, "source", { batchSize: 200, digestBatchSize: 5000 });
  endpoint.client = fakeClient;

  assert.equal(endpoint.batchSize, 200);
  assert.equal(endpoint.digestBatchSize, 5000);

  for await (const _ of endpoint.scanDigestEntries("receipt")) {}
  const digestQuery = recordedQueries[recordedQueries.length - 1];
  assert.ok(digestQuery.sql.includes("LIMIT $"));
  assert.equal(digestQuery.values[digestQuery.values.length - 1], 5000);

  for await (const _ of endpoint.scanRows("receipt")) {}
  const rowsQuery = recordedQueries[recordedQueries.length - 1];
  assert.ok(rowsQuery.sql.includes("LIMIT $"));
  assert.equal(rowsQuery.values[rowsQuery.values.length - 1], 200);
});

test("PgEndpoint defaults digestBatchSize to batchSize when omitted", async () => {
  const recordedQueries = [];
  const fakeClient = {
    query: async (sql, values) => {
      recordedQueries.push({ sql, values });
      return { rows: [] };
    },
  };

  const endpoint = new PgEndpoint({}, "source", { batchSize: 350 });
  endpoint.client = fakeClient;

  assert.equal(endpoint.batchSize, 350);
  assert.equal(endpoint.digestBatchSize, 350);

  for await (const _ of endpoint.scanDigestEntries("heartbeat")) {}
  const digestQuery = recordedQueries[recordedQueries.length - 1];
  assert.equal(digestQuery.values[digestQuery.values.length - 1], 350);
});

test("PgEndpoint constructor rejects invalid or out-of-bound digestBatchSize", () => {
  assert.throws(
    () => new PgEndpoint({}, "source", { digestBatchSize: "0" }),
    (error) => error?.code === "BATCH_SIZE_INVALID",
  );
  assert.throws(
    () => new PgEndpoint({}, "source", { digestBatchSize: "10001" }),
    (error) => error?.code === "BATCH_SIZE_INVALID",
  );
  assert.throws(
    () => new PgEndpoint({}, "source", { digestBatchSize: "-5" }),
    (error) => error?.code === "BATCH_SIZE_INVALID",
  );
  assert.throws(
    () => new PgEndpoint({}, "source", { digestBatchSize: "abc" }),
    (error) => error?.code === "BATCH_SIZE_INVALID",
  );
});

test("identical fixtures produce identical snapshot digests and planHash across different digestBatchSize", async () => {
  function createDatabaseRows() {
    const rows = [];
    for (let i = 1; i <= 25; i += 1) {
      rows.push({
        receipt_id: String(i),
        idempotency_key: "idem-" + i,
        app_key_hash: "a".repeat(64),
        open_key_hash: "b".repeat(64),
        event_code: "100",
        event_path: "/test",
        store_id: "1",
        delivery_scope: "app",
        platform_timestamp: "2026-09-05 00:00:00+00",
        cipher_sha256: "c".repeat(64),
        ciphertext: "encrypted",
        safe_projection: "{}",
        duplicate_count: "0",
        last_duplicate_at: null,
        received_at: "2026-09-05 00:00:00+00",
        created_at: "2026-09-05 00:00:00+00",
      });
    }
    return rows;
  }

  const allRows = createDatabaseRows();
  const identity = buildTestIdentity(1);
  const sequences = Object.fromEntries(
    TABLES.filter((d) => d.sequence).map((d) => [d.key, {
      sequenceName: d.key + "_seq",
      lastValue: "100",
      startValue: "1",
      increment: "1",
      maxValue: "9223372036854775807",
      minValue: "1",
      isCycled: false,
      isCalled: true,
      logicalNext: "101",
    }])
  );
  const triggers = Object.fromEntries(MANAGED_TRIGGERS.map((t) => [t.relation + "." + t.name, "O"]));

  function makeClient(digestLimit) {
    return {
      query: async (sql, values) => {
        if (sql.includes("FROM \"raw\".\"webhook_receipt\"")) {
          const limit = values[values.length - 1];
          assert.equal(limit, digestLimit);
          let cursorId = 0n;
          if (values.length === 2) cursorId = BigInt(values[0]);
          const filtered = allRows.filter((r) => BigInt(r.receipt_id) > cursorId);
          const sliced = filtered.slice(0, limit);
          const rows = sliced.map((r) => ({
            receipt_id: r.receipt_id,
            __key_hash: "1".repeat(64),
            __full_hash: "2".repeat(64),
            __immutable_hash: "3".repeat(64),
            duplicate_count: r.duplicate_count,
            last_duplicate_at: r.last_duplicate_at,
          }));
          return { rows };
        }
        return { rows: [] };
      },
    };
  }

  const ep1 = new PgEndpoint({}, "source", { batchSize: 10, digestBatchSize: 3 });
  ep1.client = makeClient(3);
  ep1.readIdentity = async () => identity;
  ep1.readSession = async () => ({ backendPid: "1", backendStart: "2026-09-05 00:00:01+00", transportGeneration: "1" });
  ep1.readReadiness = async () => ({
    nonterminalJobs: "0", pendingDirectives: "0", retryDirectives: "0", runningDirectives: "0",
    ownedDirectiveLeases: "0", expiringDirectiveLeases: "0", nonterminalDirectives: "0",
    subscriptions: "0", gates: "0",
  });
  ep1.readSequence = async (k) => sequences[k];
  ep1.readTriggerStates = async () => triggers;

  const ep2 = new PgEndpoint({}, "source", { batchSize: 10, digestBatchSize: 11 });
  ep2.client = makeClient(11);
  ep2.readIdentity = async () => identity;
  ep2.readSession = async () => ({ backendPid: "1", backendStart: "2026-09-05 00:00:01+00", transportGeneration: "1" });
  ep2.readReadiness = async () => ({
    nonterminalJobs: "0", pendingDirectives: "0", retryDirectives: "0", runningDirectives: "0",
    ownedDirectiveLeases: "0", expiringDirectiveLeases: "0", nonterminalDirectives: "0",
    subscriptions: "0", gates: "0",
  });
  ep2.readSequence = async (k) => sequences[k];
  ep2.readTriggerStates = async () => triggers;

  const snap1 = await snapshotEndpoint(ep1);
  const snap2 = await snapshotEndpoint(ep2);

  assert.equal(snap1.tables.receipt.rowCount, "25");
  assert.equal(snap2.tables.receipt.rowCount, "25");
  assert.equal(snap1.tables.receipt.fullDigest, snap2.tables.receipt.fullDigest);
  assert.equal(snap1.tables.receipt.keyDigest, snap2.tables.receipt.keyDigest);
  assert.equal(snap1.tables.receipt.immutableDigest, snap2.tables.receipt.immutableDigest);
  assert.equal(snap1.tables.receipt.maxId, "25");
  assert.equal(snap2.tables.receipt.maxId, "25");
});

test("PgEndpoint scanDigestEntries rejects oversized batch returned by database", async () => {
  const endpoint = new PgEndpoint({}, "source", { digestBatchSize: 5 });
  endpoint.client = {
    query: async () => ({
      rows: Array.from({ length: 6 }, (_, i) => ({
        receipt_id: String(i + 1),
        __key_hash: "a".repeat(64),
        __full_hash: "b".repeat(64),
        __immutable_hash: "c".repeat(64),
        duplicate_count: "0",
        last_duplicate_at: null,
      })),
    }),
  };

  await assert.rejects(
    async () => {
      for await (const _ of endpoint.scanDigestEntries("receipt")) {}
    },
    (error) => error?.code === "BATCH_BOUND_EXCEEDED",
  );
});

test("PgEndpoint scanDigestEntries rejects out-of-order primary keys across digest pages", async () => {
  let page = 0;
  const endpoint = new PgEndpoint({}, "source", { digestBatchSize: 2 });
  endpoint.client = {
    query: async () => {
      page += 1;
      if (page === 1) {
        return {
          rows: [
            { receipt_id: "5", __key_hash: "a".repeat(64), __full_hash: "b".repeat(64), __immutable_hash: "c".repeat(64), duplicate_count: "0", last_duplicate_at: null },
            { receipt_id: "10", __key_hash: "a".repeat(64), __full_hash: "b".repeat(64), __immutable_hash: "c".repeat(64), duplicate_count: "0", last_duplicate_at: null },
          ],
        };
      }
      return {
        rows: [
          { receipt_id: "8", __key_hash: "a".repeat(64), __full_hash: "b".repeat(64), __immutable_hash: "c".repeat(64), duplicate_count: "0", last_duplicate_at: null },
        ],
      };
    },
  };

  await assert.rejects(
    async () => {
      for await (const _ of endpoint.scanDigestEntries("receipt")) {}
    },
    (error) => error?.code === "PRIMARY_KEY_ORDER_INVALID",
  );
});

test("PgEndpoint scanDigestEntries rejects duplicate primary keys across digest pages", async () => {
  let page = 0;
  const endpoint = new PgEndpoint({}, "source", { digestBatchSize: 2 });
  endpoint.client = {
    query: async () => {
      page += 1;
      if (page === 1) {
        return {
          rows: [
            { receipt_id: "5", __key_hash: "a".repeat(64), __full_hash: "b".repeat(64), __immutable_hash: "c".repeat(64), duplicate_count: "0", last_duplicate_at: null },
            { receipt_id: "10", __key_hash: "a".repeat(64), __full_hash: "b".repeat(64), __immutable_hash: "c".repeat(64), duplicate_count: "0", last_duplicate_at: null },
          ],
        };
      }
      return {
        rows: [
          { receipt_id: "10", __key_hash: "a".repeat(64), __full_hash: "b".repeat(64), __immutable_hash: "c".repeat(64), duplicate_count: "0", last_duplicate_at: null },
        ],
      };
    },
  };

  await assert.rejects(
    async () => {
      for await (const _ of endpoint.scanDigestEntries("receipt")) {}
    },
    (error) => error?.code === "PRIMARY_KEY_ORDER_INVALID",
  );
});

test("authoritative readback endpoints inherit digestBatchSize from factory options", async () => {
  const objectNames = [
    ...TABLES.map((d) => d.relation),
    ...TABLES.filter((d) => d.sequence).map((d) => d.sequence),
  ];
  const objects = Object.fromEntries(objectNames.map((name, i) => [name, { oid: String(i + 1), owner: "sheinfm" }]));
  const sourceIdentity = buildTestIdentity(1);
  const targetIdentity = buildTestIdentity(2);
  const sourceFp = identityFingerprint(sourceIdentity);
  const targetFp = identityFingerprint(targetIdentity);

  const sequences = Object.fromEntries(
    TABLES.filter((d) => d.sequence).map((d) => [d.key, {
      sequenceName: d.key + "_seq",
      lastValue: "1",
      startValue: "1",
      increment: "1",
      maxValue: "9223372036854775807",
      minValue: "1",
      isCycled: false,
      isCalled: true,
      logicalNext: "2",
    }])
  );
  const triggers = Object.fromEntries(MANAGED_TRIGGERS.map((t) => [t.relation + "." + t.name, "O"]));

  const endpointDigestSizes = [];
  const customEndpointFactory = (pool, role, options) => {
    const ep = new PgEndpoint(pool, role, { ...options, digestBatchSize: 8000 });
    endpointDigestSizes.push({ role, batchSize: ep.batchSize, digestBatchSize: ep.digestBatchSize });
    ep.inTransaction = true;
    ep.beginFrozen = async () => {};
    ep.readIdentity = async () => role === "source" ? sourceIdentity : targetIdentity;
    ep.readSession = async () => ({ backendPid: "1", backendStart: "2026-09-05 00:00:01+00", transportGeneration: "1" });
    ep.readReadiness = async () => ({
      nonterminalJobs: "0", pendingDirectives: "0", retryDirectives: "0", runningDirectives: "0",
      ownedDirectiveLeases: "0", expiringDirectiveLeases: "0", nonterminalDirectives: "0",
      subscriptions: "0", gates: "0",
    });
    ep.readSequence = async (k) => sequences[k];
    ep.readTriggerStates = async () => triggers;
    ep.setControlledTriggers = async () => {};
    ep.scanRows = async function* () {};
    ep.scanDigestEntries = async function* () {};
    ep.countTableRows = async () => "0";
    ep.rollback = async () => {};
    ep.commit = async () => {};
    ep.release = () => {};
    return ep;
  };

  const dryRun = await runPrepareForward({
    sourcePool: {},
    targetPool: {},
    execute: false,
    approvedSourceIdentityFingerprint: sourceFp,
    approvedTargetIdentityFingerprint: targetFp,
    endpointFactory: customEndpointFactory,
  });

  assert.ok(dryRun.planHash);
  assert.ok(endpointDigestSizes.length >= 2);
  assert.ok(endpointDigestSizes.every((e) => e.digestBatchSize === 8000));
  assert.ok(endpointDigestSizes.every((e) => e.batchSize <= 1000));
});
