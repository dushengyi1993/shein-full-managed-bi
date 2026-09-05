import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import test from "node:test";

import {
  CUTOVER_APPLICATION_NAME,
  InsertSpool,
  MANAGED_TRIGGERS,
  PlanAccumulator,
  TABLES,
  canonicalJson,
  createTimestampPreservingTypes,
  identityFingerprint,
  primaryKeyToken,
  runPrepareForward,
  snapshotEndpoint,
  streamPrepareOperations,
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




// --- LEGACY TWO-PASS PREPARE ORACLE ---
async function legacyStreamPreparePass({
  sourceEndpoint,
  targetEndpoint,
  batchSize,
  definition,
  phase,
  emit,
}) {
  const key = definition.key;
  const sourceIterator = sourceEndpoint.scanDigestEntries(key)[Symbol.asyncIterator]();
  const targetIterator = targetEndpoint.scanDigestEntries(key)[Symbol.asyncIterator]();
  const pending = [];
  let sourceEntry = await nextValue(sourceIterator);
  let targetEntry = await nextValue(targetIterator);
  while (sourceEntry !== null || targetEntry !== null) {
    if (sourceEntry === null) {
      fail("PREPARE_TARGET_ONLY_KEY", "prepare-forward target contains a key absent from source in " + key);
    }
    if (targetEntry === null) {
      if (phase === "insert") {
        pending.push({ action: "insert", key: sourceEntry.key });
        if (pending.length >= batchSize) {
          await legacyFlushPreparedKeys(sourceEndpoint, definition, pending, emit);
        }
      }
      sourceEntry = await nextValue(sourceIterator);
      continue;
    }
    const comparison = compareKeys(definition, sourceEntry.key, targetEntry.key);
    if (comparison < 0) {
      if (phase === "insert") {
        pending.push({ action: "insert", key: sourceEntry.key });
        if (pending.length >= batchSize) {
          await legacyFlushPreparedKeys(sourceEndpoint, definition, pending, emit);
        }
      }
      sourceEntry = await nextValue(sourceIterator);
      continue;
    }
    if (comparison > 0) {
      fail("PREPARE_TARGET_ONLY_KEY", "prepare-forward target contains a key absent from source in " + key);
    }
    if (definition.appendOnly) {
      if (sourceEntry.fullHash !== targetEntry.fullHash) {
        fail("APPEND_ONLY_MUTATION", "prepare-forward heartbeat row differs at an existing key");
      }
    } else if (definition.receipt) {
      if (sourceEntry.immutableHash !== targetEntry.immutableHash) {
        fail("RECEIPT_IMMUTABLE_DRIFT", "prepare-forward receipt immutable fields differ");
      }
      if (phase === "update") {
        const sourceCount = BigInt(sourceEntry.mutable.duplicate_count);
        const targetCount = BigInt(targetEntry.mutable.duplicate_count);
        if (sourceCount < targetCount) fail("RECEIPT_DUPLICATE_COUNT_REGRESSION", "receipt duplicate count decreased on source");
        if (sourceCount !== targetCount || sourceEntry.mutable.last_duplicate_at !== targetEntry.mutable.last_duplicate_at) {
          await emit(Object.freeze({
            table: definition.key,
            action: "update",
            row: sourceEntry.mutable,
          }));
        }
      }
    } else if (phase === "update" && sourceEntry.fullHash !== targetEntry.fullHash) {
      pending.push({ action: "update", key: sourceEntry.key });
      if (pending.length >= batchSize) {
        await legacyFlushPreparedKeys(sourceEndpoint, definition, pending, emit);
      }
    }
    sourceEntry = await nextValue(sourceIterator);
    targetEntry = await nextValue(targetIterator);
  }
  await legacyFlushPreparedKeys(sourceEndpoint, definition, pending, emit);
}

async function legacyFlushPreparedKeys(sourceEndpoint, definition, pending, emit) {
  if (!pending.length) return;
  const rows = await sourceEndpoint.fetchRowsByKeys(
    definition.key,
    pending.map((item) => item.key)
  );
  for (let index = 0; index < rows.length; index += 1) {
    await emit(Object.freeze({
      table: definition.key,
      action: pending[index].action,
      row: rows[index],
    }));
  }
  pending.length = 0;
}

async function nextValue(iterator) {
  const result = await iterator.next();
  return result.done ? null : result.value;
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

const APPLY_ORDER = ["receipt", "event", "job", "directive", "heartbeat", "subscription", "gate"];

async function collectLegacyOperations(sourceEndpoint, targetEndpoint, batchSize) {
  const ops = [];
  for (const key of APPLY_ORDER) {
    const definition = tableDefinition(key);
    await legacyStreamPreparePass({
      sourceEndpoint,
      targetEndpoint,
      batchSize,
      definition,
      phase: "update",
      emit: async (op) => ops.push(op),
    });
    await legacyStreamPreparePass({
      sourceEndpoint,
      targetEndpoint,
      batchSize,
      definition,
      phase: "insert",
      emit: async (op) => ops.push(op),
    });
  }
  return ops;
}

// Construct a scenario with small primary keys as inserts and larger primary keys as updates.
// If an unbuffered/non-spooled single pass directly emitted inserts when discovered,
// the emitted order would be insert (id 1, 2) before update (id 10, 20).
// The contract requires all updates before all inserts: update (id 10, 20) before insert (id 1, 2).
function buildSmallKeyInsertLargeKeyUpdateScenario() {
  const fnosState = baseState(0);
  const cloudState = baseState(0);

  // In target (fnos): has ids 10 and 20
  fnosState.tables.receipt.push(receipt(10), receipt(20));
  fnosState.tables.job.push(job(10), job(20));
  fnosState.tables.event.push(eventRow(10), eventRow(20));
  fnosState.tables.directive.push(directive(10), directive(20));
  fnosState.tables.heartbeat.push(heartbeat(10), heartbeat(20));

  for (const k of ["receipt", "job", "event", "directive", "heartbeat"]) {
    fnosState.sequences[k].logicalNext = "25";
  }

  // In source (cloud):
  // 1. Small primary keys: id 1 and id 2 (absent on target -> MUST BE INSERTS)
  cloudState.tables.receipt.push(receipt(1), receipt(2));
  cloudState.tables.job.push(job(1), job(2));
  cloudState.tables.event.push(eventRow(1), eventRow(2));
  cloudState.tables.directive.push(directive(1), directive(2));
  cloudState.tables.heartbeat.push(heartbeat(1), heartbeat(2));

  // 2. Large primary keys: id 10 and id 20 (exist on target but modified on source -> MUST BE UPDATES)
  // Modify receipt: duplicate count update
  const r10 = receipt(10, { duplicate_count: 3, last_duplicate_at: timestamp(10, "999888") });
  const r20 = receipt(20, { duplicate_count: 5, last_duplicate_at: timestamp(20, "999888") });
  cloudState.tables.receipt.push(r10, r20);

  // Modify job
  cloudState.tables.job.push(job(10, { last_error_code: "UPD_10" }), job(20, { last_error_code: "UPD_20" }));

  // Modify event
  cloudState.tables.event.push(eventRow(10, { action: "UPD_10" }), eventRow(20, { action: "UPD_20" }));

  // Modify directive
  cloudState.tables.directive.push(directive(10, { last_error_code: "DIR_10" }), directive(20, { last_error_code: "DIR_20" }));

  // Heartbeat is append-only, so ids 10 and 20 must match target exactly
  cloudState.tables.heartbeat.push(heartbeat(10), heartbeat(20));

  for (const k of ["receipt", "job", "event", "directive", "heartbeat"]) {
    cloudState.sequences[k].logicalNext = "25";
  }

  // Sort rows by primary key in state
  for (const k of TABLES) {
    cloudState.tables[k.key].sort((a, b) => compareKeys(k, a, b));
    fnosState.tables[k.key].sort((a, b) => compareKeys(k, a, b));
  }

  const fnos = new FakeDatabase(fnosState);
  const cloud = new FakeDatabase(cloudState);
  return { fnos, cloud };
}

test("decisive planner oracle: small-key inserts encountered before large-key updates strictly produce all updates before all inserts, and planHash strictly matches", async () => {
  for (const batchSize of [1, 2, 5]) {
    const { fnos, cloud } = buildSmallKeyInsertLargeKeyUpdateScenario();

    // 1. Create frozen endpoints for snapshotting and streaming
    const sourceEp = new FakeEndpoint(cloud, "source", { batchSize });
    const targetEp = new FakeEndpoint(fnos, "target", { batchSize });
    await sourceEp.beginFrozen();
    await targetEp.beginFrozen();

    const sourceSnapshot = await snapshotEndpoint(sourceEp);
    const targetSnapshot = await snapshotEndpoint(targetEp);

    // 2. Run legacy oracle two-pass directly to gather legacy operations
    const legacyEpSource = new FakeEndpoint(cloud, "source", { batchSize });
    const legacyEpTarget = new FakeEndpoint(fnos, "target", { batchSize });
    await legacyEpSource.beginFrozen();
    await legacyEpTarget.beginFrozen();
    const legacyOps = await collectLegacyOperations(legacyEpSource, legacyEpTarget, batchSize);

    // Accumulate legacy operations into PlanAccumulator to compute legacy planHash
    const legacyAccumulator = new PlanAccumulator({
      mode: "prepare-forward",
      sourceSnapshot,
      targetSnapshot,
      targetState: "safe_subset",
    });
    for (const op of legacyOps) {
      legacyAccumulator.add(op);
    }
    const legacyPlan = legacyAccumulator.finish();

    // 3. Run new single-pass implementation directly via streamPrepareOperations
    const newEpSource = new FakeEndpoint(cloud, "source", { batchSize });
    const newEpTarget = new FakeEndpoint(fnos, "target", { batchSize });
    await newEpSource.beginFrozen();
    await newEpTarget.beginFrozen();

    const newOps = [];
    const newAccumulator = new PlanAccumulator({
      mode: "prepare-forward",
      sourceSnapshot,
      targetSnapshot,
      targetState: "safe_subset",
    });

    await streamPrepareOperations({
      sourceEndpoint: newEpSource,
      targetEndpoint: newEpTarget,
      batchSize,
      emit: async (op) => {
        newOps.push(op);
        newAccumulator.add(op);
      },
    });
    const newPlan = newAccumulator.finish();

    // 4. Run calculatePreparePlan via runPrepareForward dryRun
    const dry = await runPrepareForward({
      sourcePool: pool(cloud),
      targetPool: pool(fnos),
      approvedSourceIdentityFingerprint: identityFingerprint(cloud.identity),
      approvedTargetIdentityFingerprint: identityFingerprint(fnos.identity),
      endpointFactory,
      batchSize,
    });

    // 5. DECISIVE ASSERTIONS:
    // A. Operation counts must match exactly
    assert.equal(newOps.length, legacyOps.length, `batchSize ${batchSize}: total operation count mismatch`);
    assert.ok(newOps.length > 0, "operation count must be non-zero");

    // B. Operations stream must match item-by-item in exact order
    for (let i = 0; i < legacyOps.length; i += 1) {
      assert.equal(newOps[i].table, legacyOps[i].table, `op ${i} table mismatch`);
      assert.equal(newOps[i].action, legacyOps[i].action, `op ${i} action mismatch`);
      assert.equal(
        canonicalJson(newOps[i].row),
        canonicalJson(legacyOps[i].row),
        `op ${i} row content mismatch`
      );
    }

    // C. planHash comparison: legacy oracle hash === new stream hash === runPrepareForward dryRun hash
    assert.equal(
      newPlan.planHash,
      legacyPlan.planHash,
      `batchSize ${batchSize}: new planHash must match legacy oracle planHash`
    );
    assert.equal(
      dry.planHash,
      legacyPlan.planHash,
      `batchSize ${batchSize}: runPrepareForward planHash must match legacy oracle planHash`
    );

    // D. Invariant verification: within each table with mixed ops (receipt, job, event, directive),
    // updates (keys 10, 20) MUST precede inserts (keys 1, 2).
    // An incorrect single-pass that emits immediately would emit insert (1, 2) before update (10, 20).
    for (const key of ["receipt", "job", "event", "directive"]) {
      const ops = newOps.filter((o) => o.table === key);
      const actions = ops.map((o) => o.action);
      const firstInsertIndex = actions.indexOf("insert");
      const lastUpdateIndex = actions.lastIndexOf("update");
      assert.ok(firstInsertIndex !== -1, `table ${key} must have inserts`);
      assert.ok(lastUpdateIndex !== -1, `table ${key} must have updates`);
      assert.ok(
        lastUpdateIndex < firstInsertIndex,
        `table ${key}: all updates (last index ${lastUpdateIndex}) must precede all inserts (first index ${firstInsertIndex})`
      );
    }
  }
});

test("spool directory and file tracking: verified created, visible during execution, and cleanly deleted on success and on error", async () => {
  const { fnos, cloud } = buildSmallKeyInsertLargeKeyUpdateScenario();

  // Test Case A: Spool created on insert and deleted on success
  const dry = await prepareForward(cloud, fnos, { batchSize: 2 });
  assert.ok(dry.planHash);

  // Test Case B: Spool created on insert, then scan fails on same table -> spool cleaned up
  const fnosB = new FakeDatabase();
  const cloudB = new FakeDatabase(fnosB.state);
  cloudB.state.sequences.receipt.logicalNext = "4";
  cloudB.state.tables.receipt.push(receipt(3));

  let sawReceipt3 = false;
  const hookedScanFactory = (fakePool, role, options) => {
    const ep = new FakeEndpoint(fakePool.database, role, options);
    const origScan = ep.scanDigestEntries.bind(ep);
    ep.scanDigestEntries = async function* (tableKey, scanOptions) {
      for await (const item of origScan(tableKey, scanOptions)) {
        yield item;
        if (tableKey === "receipt" && item.key?.receipt_id === "3") {
          sawReceipt3 = true;
        }
      }
      if (sawReceipt3 && tableKey === "receipt" && role === "source") {
        fail("INJECTED_SCAN_FAILURE_AFTER_APPEND", "scan error after appending to spool");
      }
    };
    return ep;
  };

  await assert.rejects(
    async () => {
      await runPrepareForward({
        sourcePool: pool(cloudB),
        targetPool: pool(fnosB),
        approvedSourceIdentityFingerprint: identityFingerprint(cloudB.identity),
        approvedTargetIdentityFingerprint: identityFingerprint(fnosB.identity),
        endpointFactory: hookedScanFactory,
        batchSize: 2,
      });
    },
    (err) => err?.code === "INJECTED_SCAN_FAILURE_AFTER_APPEND"
  );
  assert.equal(sawReceipt3, true, "must have observed receipt 3 before failure");

  // Test Case C: Spool created on insert, then downstream fetchRows (emit) fails -> spool cleaned up
  const fnosC = new FakeDatabase();
  const cloudC = new FakeDatabase(fnosC.state);
  cloudC.state.sequences.receipt.logicalNext = "4";
  cloudC.state.tables.receipt.push(receipt(3));

  let fetchRowsCalledForInsert = false;
  const hookedFetchFactory = (fakePool, role, options) => {
    const ep = new FakeEndpoint(fakePool.database, role, options);
    const origFetch = ep.fetchRowsByKeys.bind(ep);
    ep.fetchRowsByKeys = async (tableKey, keys) => {
      if (tableKey === "receipt" && keys.some((k) => k.receipt_id === "3")) {
        fetchRowsCalledForInsert = true;
        throw new Error("injected fetch failure during insert flush");
      }
      return origFetch(tableKey, keys);
    };
    return ep;
  };

  await assert.rejects(
    async () => {
      await runPrepareForward({
        sourcePool: pool(cloudC),
        targetPool: pool(fnosC),
        approvedSourceIdentityFingerprint: identityFingerprint(cloudC.identity),
        approvedTargetIdentityFingerprint: identityFingerprint(fnosC.identity),
        endpointFactory: hookedFetchFactory,
        batchSize: 2,
      });
    },
    (err) => err?.message === "injected fetch failure during insert flush"
  );
  assert.equal(fetchRowsCalledForInsert, true, "fetchRows must be called for insert before failure");
});

test("bounded pending buffers: max pending update buffer and max fetch batch never exceed batchSize", async () => {
  const { fnos, cloud } = buildSmallKeyInsertLargeKeyUpdateScenario();
  const BATCH_SIZE = 2;

  let maxFetchBatchSeen = 0;
  const metricsFactory = (fakePool, role, options) => {
    const ep = new FakeEndpoint(fakePool.database, role, options);
    const origFetch = ep.fetchRowsByKeys.bind(ep);
    ep.fetchRowsByKeys = async (tableKey, keys) => {
      maxFetchBatchSeen = Math.max(maxFetchBatchSeen, keys.length);
      assert.ok(keys.length <= BATCH_SIZE, `fetchRowsByKeys batch ${keys.length} exceeded batchSize ${BATCH_SIZE}`);
      return origFetch(tableKey, keys);
    };
    return ep;
  };

  const dry = await runPrepareForward({
    sourcePool: pool(cloud),
    targetPool: pool(fnos),
    approvedSourceIdentityFingerprint: identityFingerprint(cloud.identity),
    approvedTargetIdentityFingerprint: identityFingerprint(fnos.identity),
    endpointFactory: metricsFactory,
    batchSize: BATCH_SIZE,
  });

  assert.ok(dry.planHash);
  assert.ok(maxFetchBatchSeen > 0 && maxFetchBatchSeen <= BATCH_SIZE);
});

test("single-pass prepare scan visits each table digest stream exactly once per endpoint during plan calculation", async () => {
  const fnos = new FakeDatabase();
  const cloud = new FakeDatabase(fnos.state);
  addAuthoritativeDelta(cloud.state);

  const sourceScanCounts = {};
  const targetScanCounts = {};
  for (const table of TABLES) {
    sourceScanCounts[table.key] = 0;
    targetScanCounts[table.key] = 0;
  }

  const wrappedFactory = (fakePool, role, options) => {
    const ep = new FakeEndpoint(fakePool.database, role, options);
    const origScan = ep.scanDigestEntries.bind(ep);
    ep.scanDigestEntries = async function* (tableKey, scanOptions) {
      if (role === "source") sourceScanCounts[tableKey] += 1;
      else targetScanCounts[tableKey] += 1;
      yield* origScan(tableKey, scanOptions);
    };
    return ep;
  };

  const dry = await runPrepareForward({
    sourcePool: pool(cloud),
    targetPool: pool(fnos),
    approvedSourceIdentityFingerprint: identityFingerprint(cloud.identity),
    approvedTargetIdentityFingerprint: identityFingerprint(fnos.identity),
    endpointFactory: wrappedFactory,
    batchSize: 2,
  });

  assert.equal(dry.mode, "dry-run");
  // Each table has: 1 scan during snapshotEndpoint, and exactly 1 scan during calculatePreparePlan.
  // With the single-pass optimization, it is exactly 2 total (vs 3 in legacy).
  for (const table of TABLES) {
    assert.equal(
      sourceScanCounts[table.key],
      2,
      `table ${table.key} source scan count should be exactly 2 (1 snapshot + 1 prepare pass), got ${sourceScanCounts[table.key]}`
    );
    assert.equal(
      targetScanCounts[table.key],
      2,
      `table ${table.key} target scan count should be exactly 2 (1 snapshot + 1 prepare pass), got ${targetScanCounts[table.key]}`
    );
  }
});

test("InsertSpool strict failure modes: corrupt JSON and count mismatch fail closed, files cleanly removed", async () => {
  // 1. Corrupt JSON in spool
  const spoolCorrupt = new InsertSpool("receipt");
  await spoolCorrupt.init();
  const dirC = spoolCorrupt.tempDir;
  const fileC = spoolCorrupt.filePath;
  assert.ok(existsSync(dirC));
  assert.ok(existsSync(fileC));

  await spoolCorrupt.append({ receipt_id: "1" });
  // Tamper file with invalid JSON line
  await spoolCorrupt.fileHandle.writeFile("this-is-not-json\n", "utf8");
  spoolCorrupt.count += 1;

  try {
    await assert.rejects(
      async () => {
        for await (const _ of spoolCorrupt.readBatches(10)) {}
      },
      (err) => err?.code === "SPOOL_CORRUPT"
    );
  } finally {
    await spoolCorrupt.cleanup();
  }
  assert.equal(existsSync(fileC), false, "corrupt spool file must be unlinked");
  assert.equal(existsSync(dirC), false, "corrupt spool directory must be rmdired");

  // 2. Count mismatch (truncated read)
  const spoolCount = new InsertSpool("receipt");
  await spoolCount.init();
  const dirCount = spoolCount.tempDir;
  const fileCount = spoolCount.filePath;
  await spoolCount.append({ receipt_id: "1" });
  await spoolCount.append({ receipt_id: "2" });
  // Spoof count expecting 3
  spoolCount.count = 3;

  try {
    await assert.rejects(
      async () => {
        for await (const _ of spoolCount.readBatches(10)) {}
      },
      (err) => err?.code === "SPOOL_COUNT_MISMATCH"
    );
  } finally {
    await spoolCount.cleanup();
  }
  assert.equal(existsSync(fileCount), false, "mismatched spool file must be unlinked");
  assert.equal(existsSync(dirCount), false, "mismatched spool directory must be rmdired");
});

test("InsertSpool permissions and handle safety: non-recursive rmdir and Windows mode observations", async () => {
  const spool = new InsertSpool("job");
  await spool.init();
  const dir = spool.tempDir;
  const file = spool.filePath;
  assert.ok(existsSync(dir));
  assert.ok(existsSync(file));

  // Append records
  await spool.append({ job_id: "1" });
  await spool.append({ job_id: "2" });
  assert.equal(spool.count, 2);

  // Read batches early break and test handle cleanup on downstream break
  for await (const batch of spool.readBatches(1)) {
    assert.equal(batch.length, 1);
    break; // Break early from reader
  }

  // cleanup using exact unlink and rmdir
  await spool.cleanup();
  assert.equal(existsSync(file), false, "spool file must be unlinked");
  assert.equal(existsSync(dir), false, "spool dir must be rmdired");

  // Verify double cleanup is idempotent
  await spool.cleanup();
  assert.equal(spool.tempDir, null);
  assert.equal(spool.filePath, null);
});
