import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CUTOVER_APPLICATION_NAME,
  MANAGED_TRIGGERS,
  PgEndpoint,
  TABLES,
  canonicalJson,
  createTimestampPreservingTypes,
  identityFingerprint,
  parseArguments,
  primaryKeyToken,
  runForward,
  runIdentityInspection,
  runPrepareForward,
  runReverse,
} from "../../scripts/fnos_webhook_cutover.mjs";

const TOUCH_TIME = "2099-12-31 23:59:59.999999+00";

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function timestamp(id, fraction = "789123") {
  return `2026-09-03 04:34:${String(id).padStart(2, "0")}.${fraction}+00`;
}

function compareKeys(definition, left, right) {
  for (let index = 0; index < definition.primaryKey.length; index += 1) {
    const column = definition.primaryKey[index];
    const type = definition.primaryKeyTypes[index];
    const a = type === "bigint" ? BigInt(left[column]) : String(left[column]);
    const b = type === "bigint" ? BigInt(right[column]) : String(right[column]);
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function triggerKey(item) {
  return `${item.relation}.${item.name}`;
}

function tableDefinition(key) {
  const definition = TABLES.find((item) => item.key === key);
  assert.ok(definition, `unknown fixture table ${key}`);
  return definition;
}

function projectedRow(definition, row, projection = "full") {
  const columns = projection === "receiptMutable"
    ? [...definition.primaryKey, ...definition.mutableColumns]
    : definition.columns;
  return Object.fromEntries(columns.map((column) => {
    assert.ok(Object.hasOwn(row, column), `${definition.key}.${column} missing from fixture`);
    return [column, structuredClone(row[column])];
  }));
}

function digestEntry(definition, row) {
  const full = projectedRow(definition, row);
  const key = Object.fromEntries(definition.primaryKey.map((column) => [column, row[column]]));
  let immutableHash = null;
  let mutable = null;
  if (definition.receipt) {
    const immutable = { ...full };
    delete immutable.duplicate_count;
    delete immutable.last_duplicate_at;
    immutableHash = digest(canonicalJson(immutable));
    mutable = projectedRow(definition, row, "receiptMutable");
  }
  return Object.freeze({
    key,
    keyHash: digest(canonicalJson(definition.primaryKey.map((column) => row[column]))),
    fullHash: digest(canonicalJson(full)),
    immutableHash,
    mutable,
  });
}

function receipt(id, overrides = {}) {
  return {
    receipt_id: String(id),
    idempotency_key: digest(`receipt-${id}`),
    app_key_hash: digest("app"),
    open_key_hash: digest("open"),
    event_code: "1234567",
    event_path: "/event/test",
    store_id: String(((id - 1) % 2) + 1),
    delivery_scope: "STORE",
    platform_timestamp: timestamp(id),
    cipher_sha256: digest(`cipher-${id}`),
    ciphertext: Buffer.from(`ciphertext-${id}`).toString("base64"),
    safe_projection: { fixture: id },
    duplicate_count: 0,
    last_duplicate_at: null,
    received_at: timestamp(id),
    created_at: timestamp(id),
    ...overrides,
  };
}

function job(id, overrides = {}) {
  return {
    job_id: String(id),
    receipt_id: String(id),
    status: "SUCCEEDED",
    attempt_count: 1,
    max_attempts: 8,
    available_at: timestamp(id),
    lease_owner: "",
    lease_expires_at: null,
    last_error_code: "",
    last_error_message: "",
    completed_at: timestamp(id),
    created_at: timestamp(id),
    updated_at: timestamp(id),
    ...overrides,
  };
}

function eventRow(id, overrides = {}) {
  return {
    operational_event_id: String(id),
    receipt_id: String(id),
    store_id: String(((id - 1) % 2) + 1),
    event_code: "1234567",
    event_path: "/event/test",
    event_family: "ORDER",
    business_type: "ORDER",
    business_key: `order-${id}`,
    occurred_at: timestamp(id),
    action: "UPDATED",
    platform_status: "DONE",
    severity: "P3",
    delivery_scope: "STORE",
    safe_projection: { order: id },
    created_at: timestamp(id),
    updated_at: timestamp(id),
    ...overrides,
  };
}

function directive(id, overrides = {}) {
  return {
    hydration_directive_id: String(id),
    operational_event_id: String(id),
    store_id: String(((id - 1) % 2) + 1),
    directive_type: "ORDER_LOOKUP",
    capability_code: "ORDER_READ",
    lookup_projection: { order: id },
    state: "SUCCEEDED",
    attempt_count: 1,
    available_at: timestamp(id),
    completed_at: timestamp(id),
    created_at: timestamp(id),
    updated_at: timestamp(id),
    lease_owner: "",
    lease_expires_at: null,
    last_error_code: "",
    last_error_message: "",
    ...overrides,
  };
}

function heartbeat(id, overrides = {}) {
  return {
    webhook_runtime_heartbeat_id: String(id),
    component_code: id % 2 === 0 ? "WORKER" : "RECEIVER",
    instance_id: `fixture-${id}`,
    status_code: "STOPPING",
    observed_at: timestamp(id),
    expires_at: timestamp(id, "889123"),
    event_fingerprint: digest(`heartbeat-${id}`),
    created_at: timestamp(id),
    ...overrides,
  };
}

function subscription(id, overrides = {}) {
  return {
    webhook_subscription_state_id: String(id),
    app_key_hash: digest("app"),
    event_code: String(7000000 + id),
    desired_state: "ACTIVE",
    observed_state: "ACTIVE",
    callback_validated: true,
    checked_at: timestamp(id),
    created_at: timestamp(id),
    updated_at: timestamp(id),
    ...overrides,
  };
}

function gate(storeId, probeId, overrides = {}) {
  return {
    store_id: String(storeId),
    gate_key: "AUTHORIZATION",
    state: "OPEN",
    reason_code: "RECOVERED",
    source_operational_event_id: "3",
    blocked_at: timestamp(1),
    reopened_at: timestamp(3),
    last_probe_id: String(probeId),
    recovery_requires_probe: false,
    created_at: timestamp(1),
    updated_at: timestamp(3),
    ...overrides,
  };
}

function baseState(count = 2) {
  const tables = Object.fromEntries(TABLES.map((definition) => [definition.key, []]));
  for (let id = 1; id <= count; id += 1) {
    tables.receipt.push(receipt(id));
    tables.heartbeat.push(heartbeat(id));
    tables.job.push(job(id));
    tables.event.push(eventRow(id));
    tables.directive.push(directive(id));
  }
  const sequences = Object.fromEntries(
    TABLES.filter((definition) => definition.sequence).map((definition) => [
      definition.key,
      { logicalNext: definition.key === "subscription" ? "1" : String(count + 1), increment: "1" },
    ])
  );
  return {
    tables,
    sequences,
    triggers: Object.fromEntries(MANAGED_TRIGGERS.map((item) => [triggerKey(item), "O"])),
    external: {
      stores: new Set(["1", "2"]),
      probes: new Set(["91", "92"]),
    },
  };
}

function cloneState(state) {
  return structuredClone(state);
}

class FakeDatabase {
  static nextSystemIdentifier = 1000000000000000000n;

  constructor(state = baseState(), identity = null) {
    this.state = cloneState(state);
    FakeDatabase.nextSystemIdentifier += 1n;
    const systemIdentifier = FakeDatabase.nextSystemIdentifier;
    const objectNames = [
      ...TABLES.map((definition) => definition.relation),
      ...TABLES.filter((definition) => definition.sequence).map((definition) => definition.sequence),
    ];
    this.identity = identity ?? {
      systemIdentifier: systemIdentifier.toString(),
      currentDatabase: "shein_fm",
      sessionUser: "sheinfm",
      currentUser: "sheinfm",
      roleSuperuser: true,
      roleBypassRls: true,
      serverAddress: "127.0.0.1/32",
      serverPort: "5432",
      serverVersionNum: "160014",
      applicationName: CUTOVER_APPLICATION_NAME,
      objects: Object.fromEntries(objectNames.map((name, index) => [
        name,
        { oid: (systemIdentifier + BigInt(index + 1)).toString(), owner: "sheinfm" },
      ])),
    };
    this.metrics = {
      begins: 0,
      maxScanBatch: 0,
      maxFetchBatch: 0,
      inserts: 0,
      updates: 0,
      sequenceRestarts: 0,
      commits: 0,
      rollbacks: 0,
    };
    this.commitMode = "success";
    this.failBeginAt = null;
    this.throwOnNextEnable = false;
    this.reuseBackendSession = false;
    this.trackTransportGeneration = false;
    this.reuseTransportGeneration = false;
  }
}

class FakeEndpoint {
  constructor(database, role, { batchSize }) {
    this.database = database;
    this.role = role;
    this.batchSize = batchSize;
    this.transaction = null;
    this.inTransaction = false;
  }

  async beginFrozen() {
    this.database.metrics.begins += 1;
    if (this.database.failBeginAt === this.database.metrics.begins) {
      throw new Error(`injected ${this.role} fresh-read failure`);
    }
    this.transaction = cloneState(this.database.state);
    this.inTransaction = true;
    const sessionNumber = this.database.reuseBackendSession ? 1 : this.database.metrics.begins;
    this.session = {
      backendPid: String(10_000 + sessionNumber),
      backendStart: `2026-09-03 00:00:${String(sessionNumber).padStart(2, "0")}.000001+00`,
      transportGeneration: this.database.trackTransportGeneration
        ? String(this.database.reuseTransportGeneration ? 1 : this.database.metrics.begins)
        : null,
    };
  }

  rows(tableKey) {
    assert.ok(this.inTransaction, "fake endpoint requires a transaction");
    return this.transaction.tables[tableKey];
  }

  filteredRows(definition, options = {}) {
    return [...this.rows(definition.key)]
      .filter((row) => {
        if (definition.identityColumn) {
          const id = BigInt(row[definition.identityColumn]);
          const lower = options.cursor?.[definition.identityColumn] ?? options.minExclusive;
          if (lower !== undefined && lower !== null && id <= BigInt(lower)) return false;
          if (options.maxInclusive !== undefined && options.maxInclusive !== null && id > BigInt(options.maxInclusive)) return false;
        } else if (options.cursor && compareKeys(definition, row, options.cursor) <= 0) {
          return false;
        }
        return true;
      })
      .sort((left, right) => compareKeys(definition, left, right));
  }

  async *scanDigestEntries(tableKey, options = {}) {
    const definition = tableDefinition(tableKey);
    const rows = this.filteredRows(definition, options);
    for (let offset = 0; offset < rows.length; offset += this.batchSize) {
      const batch = rows.slice(offset, offset + this.batchSize);
      this.database.metrics.maxScanBatch = Math.max(this.database.metrics.maxScanBatch, batch.length);
      for (const row of batch) yield digestEntry(definition, row);
    }
  }

  async *scanRows(tableKey, options = {}) {
    const definition = tableDefinition(tableKey);
    const rows = this.filteredRows(definition, options);
    for (let offset = 0; offset < rows.length; offset += this.batchSize) {
      const batch = rows.slice(offset, offset + this.batchSize);
      this.database.metrics.maxScanBatch = Math.max(this.database.metrics.maxScanBatch, batch.length);
      for (const row of batch) yield projectedRow(definition, row, options.projection);
    }
  }

  async fetchRowsByKeys(tableKey, keys) {
    const definition = tableDefinition(tableKey);
    assert.ok(keys.length > 0 && keys.length <= this.batchSize);
    this.database.metrics.maxFetchBatch = Math.max(this.database.metrics.maxFetchBatch, keys.length);
    const byKey = new Map(this.rows(tableKey).map((row) => [primaryKeyToken(tableKey, row), row]));
    const rows = keys.map((key) => byKey.get(primaryKeyToken(tableKey, key)));
    if (rows.some((row) => !row)) throw new Error("fake key fetch cardinality mismatch");
    return rows.map((row) => projectedRow(definition, row));
  }

  async fetchDigestEntriesByKeys(tableKey, keys) {
    const definition = tableDefinition(tableKey);
    assert.ok(keys.length > 0 && keys.length <= this.batchSize);
    this.database.metrics.maxFetchBatch = Math.max(this.database.metrics.maxFetchBatch, keys.length);
    const requested = new Set(keys.map((key) => primaryKeyToken(tableKey, key)));
    return this.rows(tableKey)
      .filter((row) => requested.has(primaryKeyToken(tableKey, row)))
      .sort((left, right) => compareKeys(definition, left, right))
      .map((row) => digestEntry(definition, row));
  }

  async readSequence(tableKey) {
    return structuredClone(this.transaction.sequences[tableKey]);
  }

  async readIdentity() {
    return structuredClone(this.database.identity);
  }

  async readSession() {
    return structuredClone(this.session);
  }

  async readReadiness() {
    const jobs = this.rows("job").filter((row) => ["QUEUED", "RUNNING", "RETRY"].includes(row.status)).length;
    const directiveRows = this.rows("directive");
    const countDirectives = (state) => directiveRows.filter((row) => row.state === state).length;
    const pendingDirectives = countDirectives("PENDING");
    const retryDirectives = countDirectives("RETRY");
    const runningDirectives = countDirectives("RUNNING");
    return {
      nonterminalJobs: String(jobs),
      pendingDirectives: String(pendingDirectives),
      retryDirectives: String(retryDirectives),
      runningDirectives: String(runningDirectives),
      ownedDirectiveLeases: String(directiveRows.filter((row) => row.lease_owner !== "").length),
      expiringDirectiveLeases: String(directiveRows.filter((row) => row.lease_expires_at !== null).length),
      nonterminalDirectives: String(pendingDirectives + retryDirectives + runningDirectives),
      subscriptions: String(this.rows("subscription").length),
      gates: String(this.rows("gate").length),
    };
  }

  async readTriggerStates() {
    return structuredClone(this.transaction.triggers);
  }

  async setControlledTriggers(enabled) {
    if (enabled && this.database.throwOnNextEnable) {
      this.database.throwOnNextEnable = false;
      throw new Error("injected trigger restore failure");
    }
    for (const item of MANAGED_TRIGGERS.filter((trigger) => trigger.controlled)) {
      this.transaction.triggers[triggerKey(item)] = enabled ? "O" : "D";
    }
  }

  async validateDependencyBatch({ storeIds, probeIds }) {
    if (storeIds.some((id) => !this.transaction.external.stores.has(String(id)))) {
      const error = new Error("missing store dependency");
      error.code = "EXTERNAL_STORE_DEPENDENCY_MISSING";
      throw error;
    }
    if (probeIds.some((id) => !this.transaction.external.probes.has(String(id)))) {
      const error = new Error("missing probe dependency");
      error.code = "EXTERNAL_PROBE_DEPENDENCY_MISSING";
      throw error;
    }
  }

  controlledTriggerEnabled(definition, kind) {
    const item = MANAGED_TRIGGERS.find((trigger) =>
      trigger.controlled && trigger.relation === definition.relation && trigger.name.includes(kind)
    );
    return item ? this.transaction.triggers[triggerKey(item)] === "O" : false;
  }

  assertInternalReferences(definition, row) {
    const has = (key, column, value) => this.rows(key).some((candidate) => String(candidate[column]) === String(value));
    if (definition.key === "job" && !has("receipt", "receipt_id", row.receipt_id)) throw new Error("missing receipt FK");
    if (definition.key === "event" && !has("receipt", "receipt_id", row.receipt_id)) throw new Error("missing receipt FK");
    if (definition.key === "directive" && !has("event", "operational_event_id", row.operational_event_id)) {
      throw new Error("missing event FK");
    }
    if (definition.key === "gate" && row.source_operational_event_id !== null &&
        !has("event", "operational_event_id", row.source_operational_event_id)) {
      throw new Error("missing source event FK");
    }
  }

  async applyOperation(operation) {
    const definition = tableDefinition(operation.table);
    const rows = this.rows(operation.table);
    const index = rows.findIndex((row) => compareKeys(definition, row, operation.row) === 0);
    if (operation.action === "insert") {
      if (index !== -1) throw new Error("duplicate fake insert");
      const next = projectedRow(definition, operation.row);
      this.assertInternalReferences(definition, next);
      if (definition.key === "gate" && next.state === "OPEN" && this.controlledTriggerEnabled(definition, "recovery")) {
        throw new Error("gate recovery trigger rejected direct OPEN insert");
      }
      rows.push(next);
      this.database.metrics.inserts += 1;
      return;
    }
    if (operation.action !== "update" || index === -1) throw new Error("fake update cardinality mismatch");
    if (definition.appendOnly) throw new Error("append-only trigger rejected update");
    let next;
    if (definition.receipt) {
      next = {
        ...rows[index],
        duplicate_count: operation.row.duplicate_count,
        last_duplicate_at: operation.row.last_duplicate_at,
      };
    } else {
      next = projectedRow(definition, operation.row);
      if (Object.hasOwn(next, "updated_at") && this.controlledTriggerEnabled(definition, "touch")) {
        next.updated_at = TOUCH_TIME;
      }
    }
    this.assertInternalReferences(definition, next);
    rows[index] = next;
    this.database.metrics.updates += 1;
  }

  async restartSequence(tableKey, logicalNext) {
    assert.match(String(logicalNext), /^-?[0-9]+$/);
    this.transaction.sequences[tableKey].logicalNext = String(logicalNext);
    this.database.metrics.sequenceRestarts += 1;
  }

  async commit() {
    this.database.metrics.commits += 1;
    if (this.database.commitMode === "throw-before") throw new Error("injected commit response before apply");
    this.database.state = cloneState(this.transaction);
    this.inTransaction = false;
    this.transaction = null;
    if (this.database.commitMode === "throw-after") throw new Error("injected commit response after apply");
  }

  async rollback() {
    if (!this.inTransaction) return;
    this.database.metrics.rollbacks += 1;
    this.inTransaction = false;
    this.transaction = null;
  }

  release() {
    this.inTransaction = false;
    this.transaction = null;
  }
}

function pool(database) {
  return { database };
}

function endpointFactory(fakePool, role, options) {
  return new FakeEndpoint(fakePool.database, role, options);
}

function endpointFactoryWithUnknownReadinessKey(fakePool, role, options) {
  const endpoint = new FakeEndpoint(fakePool.database, role, options);
  const readReadiness = endpoint.readReadiness.bind(endpoint);
  endpoint.readReadiness = async () => ({
    ...await readReadiness(),
    unexpectedDirectiveState: "0",
  });
  return endpoint;
}

async function forwardManifest(source, target) {
  return runForward({
    sourcePool: pool(source),
    targetPool: pool(target),
    endpointFactory,
    batchSize: 2,
  });
}

function prepareForward(source, target, options = {}) {
  return runPrepareForward({
    sourcePool: pool(source),
    targetPool: pool(target),
    approvedSourceIdentityFingerprint: identityFingerprint(source.identity),
    approvedTargetIdentityFingerprint: identityFingerprint(target.identity),
    endpointFactory,
    ...options,
  });
}

function findRow(state, tableKey, id) {
  const definition = tableDefinition(tableKey);
  return state.tables[tableKey].find((row) => String(row[definition.primaryKey[0]]) === String(id));
}

function addAuthoritativeDelta(state, { sideTables = false } = {}) {
  findRow(state, "receipt", 1).duplicate_count = 3;
  findRow(state, "receipt", 1).last_duplicate_at = timestamp(4, "123456");
  Object.assign(findRow(state, "job", 1), {
    last_error_code: "RECOVERED",
    last_error_message: "source truth",
    updated_at: timestamp(4, "223456"),
  });
  Object.assign(findRow(state, "event", 1), {
    action: "SOURCE_WINS",
    updated_at: timestamp(4, "323456"),
  });
  Object.assign(findRow(state, "directive", 1), {
    last_error_code: "RETRIED",
    last_error_message: "source truth",
    updated_at: timestamp(4, "423456"),
  });
  state.tables.receipt.push(receipt(3));
  state.tables.event.push(eventRow(3));
  state.tables.job.push(job(3));
  state.tables.directive.push(directive(3));
  state.tables.heartbeat.push(heartbeat(3));
  for (const key of ["receipt", "heartbeat", "job", "event", "directive"]) {
    state.sequences[key].logicalNext = "4";
  }
  if (sideTables) {
    state.tables.subscription.push(subscription(1));
    state.tables.gate.push(gate(2, 92), gate(1, 91));
    state.sequences.subscription.logicalNext = "2";
  }
}

function businessCore(state) {
  return canonicalJson({
    tables: Object.fromEntries(TABLES.map((definition) => [
      definition.key,
      [...state.tables[definition.key]].sort((left, right) => compareKeys(definition, left, right)),
    ])),
    sequences: state.sequences,
    triggers: state.triggers,
  });
}

async function expectCode(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, expectedCode);
    return true;
  });
}

test("CLI exposes prepare-forward as dry-run by default and locks execute to an approved hash", () => {
  const sourceIdentity = "a".repeat(64);
  const targetIdentity = "b".repeat(64);
  assert.throws(() => parseArguments(["prepare-forward"]), { code: "DIRECTION_APPROVAL_REQUIRED" });
  assert.deepEqual(parseArguments([
    "prepare-forward",
    "--approved-source-identity", sourceIdentity,
    "--approved-target-identity", targetIdentity,
  ]), {
    mode: "prepare-forward",
    execute: false,
    baselinePath: null,
    approvedPlanHash: null,
    approvedSourceIdentityFingerprint: sourceIdentity,
    approvedTargetIdentityFingerprint: targetIdentity,
  });
  assert.throws(() => parseArguments([
    "prepare-forward", "--execute",
    "--approved-source-identity", sourceIdentity,
    "--approved-target-identity", targetIdentity,
  ]), { code: "PLAN_HASH_REQUIRED" });
  assert.throws(() => parseArguments([
    "prepare-forward", "--baseline", "x.json",
    "--approved-source-identity", sourceIdentity,
    "--approved-target-identity", targetIdentity,
  ]), { code: "PREPARE_ARGUMENT_INVALID" });
  assert.throws(() => parseArguments(["forward"]), { code: "FORWARD_EXECUTE_REQUIRED" });
});

test("timestamp parsers preserve PostgreSQL microseconds and canonical JSON rejects Date", () => {
  const overrides = createTimestampPreservingTypes();
  const timestampValue = "2026-09-03 12:34:56.789123";
  const timestamptzValue = "2026-09-03 04:34:56.789123+00";
  assert.equal(overrides.getTypeParser(1114)(timestampValue), timestampValue);
  assert.equal(overrides.getTypeParser(1184)(timestamptzValue), timestamptzValue);
  assert.throws(() => canonicalJson({ at: new Date("2026-09-03T04:34:56.789Z") }), {
    code: "DATE_PRECISION_LOSS",
  });
});

test("forward manifest contains all six direct sequence states and validates sequence drift", async () => {
  const source = new FakeDatabase();
  const target = new FakeDatabase();
  const manifest = await forwardManifest(source, target);
  assert.deepEqual(Object.keys(manifest.sequences).sort(), [
    "directive", "event", "heartbeat", "job", "receipt", "subscription",
  ]);
  assert.deepEqual(manifest.sourceIdentity, source.identity);
  assert.deepEqual(manifest.targetIdentity, target.identity);

  const missing = structuredClone(manifest);
  delete missing.sequences.subscription;
  await expectCode(runReverse({
    sourcePool: pool(source), targetPool: pool(target), baseline: missing, endpointFactory,
  }), "BASELINE_SEQUENCE_SET_INVALID");

  target.state.sequences.receipt.logicalNext = "4";
  await expectCode(runForward({
    sourcePool: pool(source), targetPool: pool(target), endpointFactory,
  }), "FORWARD_SNAPSHOT_MISMATCH");
});

test("identity inspection emits stable pins without table rows or connection URLs", async () => {
  const cloud = new FakeDatabase();
  const fnos = new FakeDatabase(cloud.state);
  const result = await runIdentityInspection({
    sourcePool: pool(cloud), targetPool: pool(fnos), endpointFactory,
  });
  assert.equal(result.operation, "inspect-identities");
  assert.equal(result.source.identityFingerprint, identityFingerprint(cloud.identity));
  assert.equal(result.target.identityFingerprint, identityFingerprint(fnos.identity));
  assert.equal(Object.hasOwn(result.source, "tables"), false);
  assert.equal(JSON.stringify(result).includes("DATABASE_URL"), false);
});

test("test database overrides accept a complete forward pair and its complete swapped reverse mapping only", async () => {
  const sourceDatabase = "fnos_cutover_test_source_forward";
  const targetDatabase = "fnos_cutover_test_target_forward";
  const cloud = new FakeDatabase();
  cloud.identity.currentDatabase = sourceDatabase;
  const fnos = new FakeDatabase(cloud.state);
  fnos.identity.currentDatabase = targetDatabase;

  const baseline = await runForward({
    sourcePool: pool(cloud),
    targetPool: pool(fnos),
    endpointFactory,
    batchSize: 2,
    testDatabaseNames: { source: sourceDatabase, target: targetDatabase },
  });
  assert.equal(baseline.sourceIdentity.currentDatabase, sourceDatabase);
  assert.equal(baseline.targetIdentity.currentDatabase, targetDatabase);

  const reversed = await runReverse({
    sourcePool: pool(fnos),
    targetPool: pool(cloud),
    baseline,
    endpointFactory,
    batchSize: 2,
    testDatabaseNames: { source: targetDatabase, target: sourceDatabase },
  });
  assert.equal(reversed.operation, "reverse");
  assert.equal(reversed.readyForCloudStart, true);
  assert.equal(reversed.source.identity.currentDatabase, targetDatabase);
  assert.equal(reversed.target.identity.currentDatabase, sourceDatabase);

  const productionSource = new FakeDatabase();
  const productionTarget = new FakeDatabase(productionSource.state);
  const production = await runIdentityInspection({
    sourcePool: pool(productionSource),
    targetPool: pool(productionTarget),
    endpointFactory,
    testDatabaseNames: null,
  });
  assert.equal(production.source.identity.currentDatabase, "shein_fm");
  assert.equal(production.target.identity.currentDatabase, "shein_fm");

  const invalidMappings = [
    { target: targetDatabase },
    { source: sourceDatabase },
    { source: sourceDatabase, target: targetDatabase, extra: "forbidden" },
    { source: sourceDatabase, target: sourceDatabase },
    { source: sourceDatabase, target: "fnos_cutover_test_source_other" },
    { source: targetDatabase, target: "fnos_cutover_test_target_other" },
    { source: "fnos_cutover_test_source_nested/path", target: targetDatabase },
    { source: "fnos_cutover_test_source_\"quoted", target: targetDatabase },
    { source: "fnos_cutover_test_Source_uppercase", target: targetDatabase },
    Object.assign([], { source: sourceDatabase, target: targetDatabase }),
    "fnos_cutover_test_source_not_an_object",
  ];
  for (const testDatabaseNames of invalidMappings) {
    const invalidSource = new FakeDatabase();
    const invalidTarget = new FakeDatabase(invalidSource.state);
    if (testDatabaseNames && typeof testDatabaseNames === "object") {
      if (typeof testDatabaseNames.source === "string") {
        invalidSource.identity.currentDatabase = testDatabaseNames.source;
      }
      if (typeof testDatabaseNames.target === "string") {
        invalidTarget.identity.currentDatabase = testDatabaseNames.target;
      }
    }
    await expectCode(runIdentityInspection({
      sourcePool: pool(invalidSource),
      targetPool: pool(invalidTarget),
      endpointFactory,
      testDatabaseNames,
    }), "TEST_DATABASE_OVERRIDE_INVALID");
  }
});

test("database identity approvals prevent prepare and reverse endpoint swaps", async () => {
  const fnos = new FakeDatabase();
  const cloud = new FakeDatabase(fnos.state);
  addAuthoritativeDelta(cloud.state);
  await expectCode(prepareForward(cloud, fnos, {
    approvedSourceIdentityFingerprint: identityFingerprint(fnos.identity),
    approvedTargetIdentityFingerprint: identityFingerprint(cloud.identity),
  }), "PREPARE_DIRECTION_MISMATCH");
  assert.equal(fnos.metrics.inserts, 0);
  assert.equal(fnos.metrics.updates, 0);

  const baselineCloud = new FakeDatabase();
  const baselineFnos = new FakeDatabase(baselineCloud.state);
  const baseline = await forwardManifest(baselineCloud, baselineFnos);
  await expectCode(runReverse({
    sourcePool: pool(baselineCloud),
    targetPool: pool(baselineFnos),
    baseline,
    endpointFactory,
  }), "REVERSE_DIRECTION_MISMATCH");
});

test("role, object owner, and OID identity drift fail closed and affect planHash", async () => {
  const fnos = new FakeDatabase();
  const cloud = new FakeDatabase(fnos.state);
  addAuthoritativeDelta(cloud.state);
  const first = await prepareForward(cloud, fnos);
  const oldTargetFingerprint = identityFingerprint(fnos.identity);
  fnos.identity.objects["raw.webhook_receipt"].oid = (
    BigInt(fnos.identity.objects["raw.webhook_receipt"].oid) + 1000n
  ).toString();
  await expectCode(prepareForward(cloud, fnos, {
    approvedTargetIdentityFingerprint: oldTargetFingerprint,
  }), "PREPARE_DIRECTION_MISMATCH");
  const second = await prepareForward(cloud, fnos);
  assert.notEqual(second.planHash, first.planHash);

  fnos.identity.objects["raw.webhook_receipt"].owner = "unexpected_owner";
  await expectCode(prepareForward(cloud, fnos), "DATABASE_OBJECT_OWNER_MISMATCH");
  assert.equal(fnos.metrics.inserts, 0);
  assert.equal(fnos.metrics.updates, 0);

  const roleFnos = new FakeDatabase();
  const roleCloud = new FakeDatabase(roleFnos.state);
  addAuthoritativeDelta(roleCloud.state);
  roleFnos.identity.roleSuperuser = false;
  roleFnos.identity.roleBypassRls = false;
  await expectCode(prepareForward(roleCloud, roleFnos), "DATABASE_IDENTITY_MISMATCH");
  assert.equal(roleFnos.metrics.inserts, 0);
  assert.equal(roleFnos.metrics.updates, 0);
});

test("gate composite key includes store_id and produces deterministic full-PK order", async () => {
  const left = primaryKeyToken("gate", { store_id: "1", gate_key: "AUTHORIZATION" });
  const right = primaryKeyToken("gate", { store_id: "2", gate_key: "AUTHORIZATION" });
  assert.notEqual(left, right);

  const cloud = new FakeDatabase();
  const fnos = new FakeDatabase();
  const baseline = await forwardManifest(cloud, fnos);
  addAuthoritativeDelta(fnos.state, { sideTables: true });
  const first = await runReverse({
    sourcePool: pool(fnos), targetPool: pool(cloud), baseline, endpointFactory, batchSize: 1,
  });
  fnos.state.tables.gate.reverse();
  const second = await runReverse({
    sourcePool: pool(fnos), targetPool: pool(cloud), baseline, endpointFactory, batchSize: 1,
  });
  assert.equal(first.planHash, second.planHash);
  assert.equal(first.counts.gate.inserted, "2");
});

test("prepare-forward converges a stale safe subset with bounded scans and fresh readback", async () => {
  const fnos = new FakeDatabase();
  const cloud = new FakeDatabase(fnos.state);
  addAuthoritativeDelta(cloud.state);

  const dry = await prepareForward(cloud, fnos, { batchSize: 2 });
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.readyForForwardBaseline, false);
  assert.deepEqual(dry.counts.receipt, { inserted: "1", updated: "1" });
  assert.equal(dry.counts.job.updated, "1");
  assert.equal(dry.counts.event.updated, "1");
  assert.equal(dry.counts.directive.updated, "1");

  const executed = await prepareForward(cloud, fnos, {
    execute: true,
    approvedPlanHash: dry.planHash,
    batchSize: 2,
  });
  assert.equal(executed.readyForForwardBaseline, true);
  assert.equal(executed.commitOutcome, "committed");
  assert.equal(businessCore(fnos.state), businessCore(cloud.state));
  assert.ok(cloud.metrics.maxScanBatch <= 2);
  assert.ok(fnos.metrics.maxScanBatch <= 2);
  assert.ok(cloud.metrics.maxFetchBatch <= 2);
  assert.ok(fnos.metrics.maxFetchBatch <= 2);
  assert.ok(fnos.metrics.begins >= 3, "dry-run, execute, and post-commit readback use separate target connections");

  const recovered = await prepareForward(cloud, fnos, { batchSize: 2 });
  assert.equal(recovered.state, "already_applied");
  assert.equal(recovered.readyForForwardBaseline, true);
});

test("prepare-forward rejects target-only keys and append-only divergence", async () => {
  const fnos = new FakeDatabase();
  const cloud = new FakeDatabase(fnos.state);
  fnos.state.tables.receipt.push(receipt(99));
  fnos.state.sequences.receipt.logicalNext = "100";
  await expectCode(prepareForward(cloud, fnos), "PREPARE_TARGET_ONLY_KEY");

  const fnosHeartbeat = new FakeDatabase();
  const cloudHeartbeat = new FakeDatabase(fnosHeartbeat.state);
  findRow(cloudHeartbeat.state, "heartbeat", 1).status_code = "RUNNING";
  await expectCode(prepareForward(cloudHeartbeat, fnosHeartbeat), "APPEND_ONLY_MUTATION");
});

test("prepare-forward rejects receipt immutable and mutable monotonic regressions", async () => {
  const immutableTarget = new FakeDatabase();
  const immutableSource = new FakeDatabase(immutableTarget.state);
  findRow(immutableSource.state, "receipt", 1).cipher_sha256 = digest("different");
  await expectCode(prepareForward(immutableSource, immutableTarget), "RECEIPT_IMMUTABLE_DRIFT");

  const countTarget = new FakeDatabase();
  findRow(countTarget.state, "receipt", 1).duplicate_count = 2;
  findRow(countTarget.state, "receipt", 1).last_duplicate_at = timestamp(4, "223456");
  const countSource = new FakeDatabase(countTarget.state);
  findRow(countSource.state, "receipt", 1).duplicate_count = 1;
  await expectCode(prepareForward(countSource, countTarget), "RECEIPT_DUPLICATE_COUNT_REGRESSION");

  const timeTarget = new FakeDatabase();
  findRow(timeTarget.state, "receipt", 1).duplicate_count = 2;
  findRow(timeTarget.state, "receipt", 1).last_duplicate_at = timestamp(4, "323456");
  const timeSource = new FakeDatabase(timeTarget.state);
  findRow(timeSource.state, "receipt", 1).last_duplicate_at = timestamp(4, "123456");
  await expectCode(prepareForward(timeSource, timeTarget), "RECEIPT_DUPLICATE_TIMESTAMP_REGRESSION");
});

test("prepare-forward recovers a commit-throw that actually committed and fails closed otherwise", async () => {
  const fnosCommitted = new FakeDatabase();
  const cloudCommitted = new FakeDatabase(fnosCommitted.state);
  addAuthoritativeDelta(cloudCommitted.state);
  const dryCommitted = await prepareForward(cloudCommitted, fnosCommitted);
  fnosCommitted.commitMode = "throw-after";
  const committed = await prepareForward(cloudCommitted, fnosCommitted, {
    execute: true, approvedPlanHash: dryCommitted.planHash,
  });
  assert.equal(committed.commitOutcome, "committed_after_uncertain_response");
  assert.equal(committed.readyForForwardBaseline, true);

  const fnosNotCommitted = new FakeDatabase();
  const cloudNotCommitted = new FakeDatabase(fnosNotCommitted.state);
  addAuthoritativeDelta(cloudNotCommitted.state);
  const dryNotCommitted = await prepareForward(cloudNotCommitted, fnosNotCommitted);
  fnosNotCommitted.commitMode = "throw-before";
  await expectCode(prepareForward(cloudNotCommitted, fnosNotCommitted, {
    execute: true, approvedPlanHash: dryNotCommitted.planHash,
  }), "COMMIT_NOT_APPLIED");
  assert.notEqual(businessCore(fnosNotCommitted.state), businessCore(cloudNotCommitted.state));
});

test("post-commit readback failure returns outcome_unverified even when target committed", async () => {
  const fnos = new FakeDatabase();
  const cloud = new FakeDatabase(fnos.state);
  addAuthoritativeDelta(cloud.state);
  const dry = await prepareForward(cloud, fnos);
  fnos.failBeginAt = fnos.metrics.begins + 2;
  await expectCode(prepareForward(cloud, fnos, {
    execute: true, approvedPlanHash: dry.planHash,
  }), "OUTCOME_UNVERIFIED");
  assert.equal(businessCore(fnos.state), businessCore(cloud.state));
});

test("post-commit readback must use a new PostgreSQL backend", async () => {
  const fnos = new FakeDatabase();
  const cloud = new FakeDatabase(fnos.state);
  addAuthoritativeDelta(cloud.state);
  const dry = await prepareForward(cloud, fnos);
  fnos.reuseBackendSession = true;
  await expectCode(prepareForward(cloud, fnos, {
    execute: true,
    approvedPlanHash: dry.planHash,
  }), "FRESH_READBACK_REUSED_BACKEND");
  assert.equal(businessCore(fnos.state), businessCore(cloud.state));
});

test("SSH-backed post-commit readback must use a fresh child generation", async () => {
  const fnos = new FakeDatabase();
  const cloud = new FakeDatabase(fnos.state);
  fnos.trackTransportGeneration = true;
  cloud.trackTransportGeneration = true;
  addAuthoritativeDelta(cloud.state);
  const dry = await prepareForward(cloud, fnos);
  fnos.reuseTransportGeneration = true;
  await expectCode(prepareForward(cloud, fnos, {
    execute: true,
    approvedPlanHash: dry.planHash,
  }), "FRESH_READBACK_REUSED_TRANSPORT");
  assert.equal(businessCore(fnos.state), businessCore(cloud.state));
});

test("transaction rollback restores sequence and trigger state after a post-restart fault", async () => {
  const fnos = new FakeDatabase();
  const cloud = new FakeDatabase(fnos.state);
  addAuthoritativeDelta(cloud.state);
  const before = businessCore(fnos.state);
  const dry = await prepareForward(cloud, fnos);
  fnos.throwOnNextEnable = true;
  await assert.rejects(prepareForward(cloud, fnos, {
    execute: true, approvedPlanHash: dry.planHash,
  }), /injected trigger restore failure/);
  assert.equal(businessCore(fnos.state), before);
  assert.equal(fnos.state.sequences.receipt.logicalNext, "3");
  assert.ok(Object.values(fnos.state.triggers).every((state) => state === "O"));
});

test("reverse merges ACKed delta, mutable baseline rows, side tables, and six sequences", async () => {
  const cloud = new FakeDatabase();
  const fnos = new FakeDatabase(cloud.state);
  const baseline = await forwardManifest(cloud, fnos);
  addAuthoritativeDelta(fnos.state, { sideTables: true });

  const dry = await runReverse({
    sourcePool: pool(fnos), targetPool: pool(cloud), baseline, endpointFactory, batchSize: 2,
  });
  assert.deepEqual(dry.counts.receipt, { inserted: "1", updated: "1" });
  assert.equal(dry.counts.subscription.inserted, "1");
  assert.equal(dry.counts.gate.inserted, "2");
  assert.equal(dry.readyForCloudStart, false);

  const executed = await runReverse({
    sourcePool: pool(fnos), targetPool: pool(cloud), baseline,
    execute: true, approvedPlanHash: dry.planHash, endpointFactory, batchSize: 2,
  });
  assert.equal(executed.readyForCloudStart, true);
  assert.equal(executed.commitOutcome, "committed");
  assert.equal(businessCore(cloud.state), businessCore(fnos.state));
  assert.deepEqual(Object.keys(cloud.state.sequences).sort(), [
    "directive", "event", "heartbeat", "job", "receipt", "subscription",
  ]);
  assert.ok(Object.values(cloud.state.triggers).every((state) => state === "O"));

  const recovered = await runReverse({
    sourcePool: pool(fnos), targetPool: pool(cloud), baseline, endpointFactory,
  });
  assert.equal(recovered.state, "already_applied");
  assert.equal(recovered.readyForCloudStart, true);
});

test("reverse rejects unsafe target state, source prefix drift, and missing gate dependencies", async () => {
  const unsafeCloud = new FakeDatabase();
  const unsafeFnos = new FakeDatabase(unsafeCloud.state);
  const unsafeBaseline = await forwardManifest(unsafeCloud, unsafeFnos);
  addAuthoritativeDelta(unsafeFnos.state, { sideTables: true });
  findRow(unsafeCloud.state, "job", 1).last_error_code = "TARGET_DIVERGED";
  await expectCode(runReverse({
    sourcePool: pool(unsafeFnos), targetPool: pool(unsafeCloud), baseline: unsafeBaseline, endpointFactory,
  }), "TARGET_STATE_UNSAFE");

  const driftCloud = new FakeDatabase();
  const driftFnos = new FakeDatabase(driftCloud.state);
  const driftBaseline = await forwardManifest(driftCloud, driftFnos);
  findRow(driftFnos.state, "receipt", 1).ciphertext = Buffer.from("immutable-drift").toString("base64");
  await expectCode(runReverse({
    sourcePool: pool(driftFnos), targetPool: pool(driftCloud), baseline: driftBaseline, endpointFactory,
  }), "RECEIPT_IMMUTABLE_DRIFT");

  const dependencyCloud = new FakeDatabase();
  const dependencyFnos = new FakeDatabase(dependencyCloud.state);
  const dependencyBaseline = await forwardManifest(dependencyCloud, dependencyFnos);
  addAuthoritativeDelta(dependencyFnos.state, { sideTables: true });
  dependencyCloud.state.external.probes.delete("92");
  await expectCode(runReverse({
    sourcePool: pool(dependencyFnos), targetPool: pool(dependencyCloud), baseline: dependencyBaseline, endpointFactory,
  }), "EXTERNAL_PROBE_DEPENDENCY_MISSING");
});

test("initial managed-trigger drift fails closed before any write", async () => {
  const fnos = new FakeDatabase();
  const cloud = new FakeDatabase(fnos.state);
  addAuthoritativeDelta(cloud.state);
  const trigger = MANAGED_TRIGGERS.find((item) => item.controlled);
  fnos.state.triggers[triggerKey(trigger)] = "D";
  await expectCode(prepareForward(cloud, fnos), "TRIGGER_STATE_INVALID");
  assert.equal(fnos.metrics.inserts, 0);
  assert.equal(fnos.metrics.updates, 0);
});

test("sequence logicalNext must stay above each identity table max", async () => {
  const source = new FakeDatabase();
  const target = new FakeDatabase(source.state);
  source.state.sequences.receipt.logicalNext = "2";
  await expectCode(runForward({
    sourcePool: pool(source), targetPool: pool(target), endpointFactory,
  }), "SEQUENCE_COLLISION_RISK");
});

test("live sequence reads require increment exactly one", async () => {
  const endpointFor = (row) => {
    const endpoint = new PgEndpoint({}, "source");
    endpoint.client = { query: async () => ({ rows: [row] }) };
    return endpoint;
  };

  for (const increment of ["0", "-1", "2"]) {
    await expectCode(endpointFor({
      last_value: "3",
      is_called: true,
      increment_by: increment,
    }).readSequence("receipt"), "SEQUENCE_INCREMENT_INVALID");
  }

  const sequence = await endpointFor({
    last_value: "3",
    is_called: true,
    increment_by: "1",
  }).readSequence("receipt");
  assert.deepEqual(sequence, { logicalNext: "4", increment: "1" });
});

test("cutover snapshots and forward baselines reject sequence increment drift", async () => {
  for (const increment of ["0", "-1", "2"]) {
    const source = new FakeDatabase();
    const target = new FakeDatabase(source.state);
    source.state.sequences.receipt.increment = increment;
    await expectCode(runForward({
      sourcePool: pool(source), targetPool: pool(target), endpointFactory,
    }), "SEQUENCE_INCREMENT_INVALID");
  }

  const cloud = new FakeDatabase();
  const fnos = new FakeDatabase(cloud.state);
  const baseline = await forwardManifest(cloud, fnos);
  assert.ok(Object.values(baseline.sequences).every((item) => item.increment === "1"));
  for (const increment of ["0", "-1", "2"]) {
    const drifted = structuredClone(baseline);
    drifted.sequences.receipt.increment = increment;
    await expectCode(runReverse({
      sourcePool: pool(cloud), targetPool: pool(fnos), baseline: drifted, endpointFactory,
    }), "SEQUENCE_INCREMENT_INVALID");
  }
});

const V3_BACKLOG_BASELINE = Object.freeze({
  schemaVersion: 3,
  kind: "fnos-webhook-cutover-forward",
  planVersion: "shein-fm-fnos-webhook-cutover-v3",
});

test("idle PENDING and RETRY directives ride prepare-forward, forward baseline, and reverse merge", async () => {
  const cloud = new FakeDatabase();
  const fnos = new FakeDatabase(cloud.state);

  for (let id = 101; id <= 220; id += 1) {
    cloud.state.tables.receipt.push(receipt(id));
    cloud.state.tables.event.push(eventRow(id));
    cloud.state.tables.job.push(job(id));
    cloud.state.tables.heartbeat.push(heartbeat(id));
    const state = id % 3 === 0 ? "RETRY" : "PENDING";
    cloud.state.tables.directive.push(directive(id, {
      state,
      attempt_count: state === "RETRY" ? 2 : 0,
      completed_at: null,
      last_error_code: state === "RETRY" ? "CAPABILITY_UNAVAILABLE" : "",
      last_error_message: state === "RETRY" ? "consumer unavailable" : "",
    }));
  }
  for (const key of ["receipt", "heartbeat", "event", "job", "directive"]) {
    cloud.state.sequences[key].logicalNext = "301";
  }
  assert.equal(cloud.state.tables.directive.filter((row) => row.state === "PENDING").length, 80);
  assert.equal(cloud.state.tables.directive.filter((row) => row.state === "RETRY").length, 40);

  const dry = await prepareForward(cloud, fnos);
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.readyForForwardBaseline, false);
  assert.equal(dry.source.readiness.pendingDirectives, "80");
  assert.equal(dry.source.readiness.retryDirectives, "40");

  const prepared = await prepareForward(cloud, fnos, {
    execute: true,
    approvedPlanHash: dry.planHash,
  });
  assert.equal(prepared.state, "applied");
  assert.equal(prepared.readyForForwardBaseline, true);
  assert.equal(prepared.target.readiness.pendingDirectives, "80");
  assert.equal(prepared.target.readiness.retryDirectives, "40");
  assert.equal(prepared.target.readiness.nonterminalDirectives, "120");
  assert.equal(prepared.target.readiness.ownedDirectiveLeases, "0");
  assert.equal(prepared.target.readiness.expiringDirectiveLeases, "0");
  assert.equal(businessCore(cloud.state), businessCore(fnos.state));

  const baseline = await forwardManifest(cloud, fnos);
  assert.equal(baseline.readiness.pendingDirectives, "80");
  assert.equal(baseline.readiness.retryDirectives, "40");
  assert.equal(baseline.readiness.runningDirectives, "0");
  assert.equal(baseline.readiness.nonterminalDirectives, "120");

  const deltaState = cloneState(cloud.state);
  for (let id = 301; id <= 360; id += 1) {
    deltaState.tables.receipt.push(receipt(id));
    deltaState.tables.event.push(eventRow(id));
    deltaState.tables.job.push(job(id));
    deltaState.tables.heartbeat.push(heartbeat(id));
    deltaState.tables.directive.push(directive(id, { state: "PENDING", completed_at: null }));
  }
  for (const key of ["receipt", "heartbeat", "event", "job", "directive"]) {
    deltaState.sequences[key].logicalNext = "361";
  }
  findRow(deltaState, "directive", 104).state = "RETRY";
  fnos.state = deltaState;

  const reverseDry = await runReverse({
    sourcePool: pool(fnos),
    targetPool: pool(cloud),
    baseline,
    endpointFactory,
    batchSize: 7,
  });
  assert.equal(reverseDry.counts.directive.inserted, "60");
  assert.equal(reverseDry.counts.directive.updated, "1");
  assert.equal(reverseDry.counts.receipt.inserted, "60");
  assert.equal(reverseDry.counts.heartbeat.inserted, "60");
  assert.equal(reverseDry.readyForCloudStart, false);

  const reversed = await runReverse({
    sourcePool: pool(fnos),
    targetPool: pool(cloud),
    baseline,
    execute: true,
    approvedPlanHash: reverseDry.planHash,
    endpointFactory,
    batchSize: 7,
  });
  assert.equal(reversed.readyForCloudStart, true);
  assert.equal(businessCore(cloud.state), businessCore(deltaState));
  assert.equal(cloud.state.tables.directive.filter((row) => row.state === "PENDING").length, 139);
  assert.equal(cloud.state.tables.directive.filter((row) => row.state === "RETRY").length, 41);
  assert.equal(cloud.state.sequences.directive.logicalNext, "361");
});

test("quiescence rejects RUNNING directives, owned leases, expiring leases, and nonterminal jobs", async () => {
  const phases = [
    {
      label: "RUNNING directive",
      mutate: (source) => {
        Object.assign(findRow(source, "directive", 1), {
          state: "RUNNING", completed_at: null, lease_owner: "hydration-worker-7",
          lease_expires_at: timestamp(9, "111111"),
        });
      },
      expectedCounts: { pending: 0, retry: 0, running: 1, owned: 1, expiring: 1 },
    },
    {
      label: "PENDING directive with owned lease",
      mutate: (source) => {
        Object.assign(findRow(source, "directive", 1), {
          lease_owner: "stale-worker", lease_expires_at: null,
        });
      },
      expectedCounts: { pending: 1, retry: 0, running: 0, owned: 1, expiring: 0 },
    },
    {
      label: "PENDING directive with expiring lease",
      mutate: (source) => {
        Object.assign(findRow(source, "directive", 1), {
          lease_owner: "", lease_expires_at: timestamp(9, "222222"),
        });
      },
      expectedCounts: { pending: 1, retry: 0, running: 0, owned: 0, expiring: 1 },
    },
    {
      label: "QUEUED job",
      mutate: (source) => {
        Object.assign(findRow(source, "job", 1), {
          status: "QUEUED", completed_at: null,
        });
      },
      expectedCounts: { pending: 0, retry: 0, running: 0, owned: 0, expiring: 0 },
    },
  ];
  for (const phase of phases) {
    const cloud = new FakeDatabase();
    const fnos = new FakeDatabase(cloud.state);
    phase.mutate(cloud.state);
    await expectCode(prepareForward(cloud, fnos), "NONTERMINAL_WEBHOOK_WORK");
    assert.equal(fnos.metrics.inserts + fnos.metrics.updates, 0, phase.label);
  }
});

test("snapshot readiness rejects an unknown key before prepare-forward writes", async () => {
  const fnos = new FakeDatabase();
  const cloud = new FakeDatabase(fnos.state);
  addAuthoritativeDelta(cloud.state);

  await expectCode(prepareForward(cloud, fnos, {
    endpointFactory: endpointFactoryWithUnknownReadinessKey,
  }), "READINESS_INVALID");

  assert.deepEqual({
    inserts: fnos.metrics.inserts,
    updates: fnos.metrics.updates,
    sequenceRestarts: fnos.metrics.sequenceRestarts,
    commits: fnos.metrics.commits,
  }, {
    inserts: 0,
    updates: 0,
    sequenceRestarts: 0,
    commits: 0,
  });
});

test("forward manifest readiness rejects an unknown key before reverse endpoint access", async () => {
  const cloud = new FakeDatabase();
  const fnos = new FakeDatabase(cloud.state);
  const baseline = structuredClone(await forwardManifest(cloud, fnos));
  const sourceMetrics = structuredClone(fnos.metrics);
  const targetMetrics = structuredClone(cloud.metrics);
  baseline.readiness.unexpectedDirectiveState = "0";

  await expectCode(runReverse({
    sourcePool: pool(fnos),
    targetPool: pool(cloud),
    baseline,
    endpointFactory,
  }), "BASELINE_READINESS_INVALID");

  assert.deepEqual(fnos.metrics, sourceMetrics);
  assert.deepEqual(cloud.metrics, targetMetrics);
});

test("v3 forward baselines are rejected and v4 readiness binds backlog into fingerprints", async () => {
  const cloud = new FakeDatabase();
  const fnos = new FakeDatabase(cloud.state);
  const baseline = await forwardManifest(cloud, fnos);
  assert.equal(baseline.schemaVersion, 4);
  assert.equal(baseline.planVersion, "shein-fm-fnos-webhook-cutover-v4");
  assert.equal(baseline.readiness.ownedDirectiveLeases, "0");
  assert.equal(baseline.readiness.expiringDirectiveLeases, "0");

  const staleV3 = Object.assign(structuredClone(baseline), structuredClone(V3_BACKLOG_BASELINE));
  await expectCode(runReverse({
    sourcePool: pool(fnos), targetPool: pool(cloud), baseline: staleV3, endpointFactory,
  }), "BASELINE_INVALID");

  const tampered = structuredClone(baseline);
  tampered.readiness.pendingDirectives = "1";
  tampered.readiness.retryDirectives = "0";
  tampered.readiness.runningDirectives = "0";
  tampered.readiness.ownedDirectiveLeases = "0";
  tampered.readiness.expiringDirectiveLeases = "0";
  tampered.readiness.nonterminalDirectives = "1";
  await expectCode(runReverse({
    sourcePool: pool(fnos), targetPool: pool(cloud), baseline: tampered, endpointFactory,
  }), "BASELINE_FINGERPRINT_INVALID");
  const tamperedFingerprint = tampered.baselineFingerprint;
  assert.ok(/^[0-9a-f]{64}$/.test(tamperedFingerprint));

  const inconsistent = structuredClone(tampered);
  inconsistent.readiness.nonterminalDirectives = "2";
  await expectCode(runReverse({
    sourcePool: pool(fnos), targetPool: pool(cloud), baseline: inconsistent, endpointFactory,
  }), "BASELINE_READINESS_INVALID");

  const negative = structuredClone(baseline);
  negative.readiness.pendingDirectives = "-1";
  await expectCode(runReverse({
    sourcePool: pool(fnos), targetPool: pool(cloud), baseline: negative, endpointFactory,
  }), "BASELINE_READINESS_INVALID");
});
