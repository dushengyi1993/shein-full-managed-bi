import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  ALLOWED_PROGRESS_COUNT_KEYS,
  CUTOVER_APPLICATION_NAME,
  MANAGED_TRIGGERS,
  PROGRESS_PHASES,
  TABLES,
  WebhookCutoverError,
  canonicalJson,
  createProgressEvent,
  identityFingerprint,
  main,
  parseArguments,
  primaryKeyToken,
  runPrepareForward,
  summarizePlanCounts,
} from "../../scripts/fnos_webhook_cutover.mjs";
import {
  ALLOWED_PROGRESS_COUNT_KEYS as SSH_ALLOWED_PROGRESS_COUNT_KEYS,
  PROGRESS_PHASES as SSH_PROGRESS_PHASES,
  createProgressEvent as sshCreateProgressEvent,
  runSshLauncher,
  summarizePlanCounts as sshSummarizePlanCounts,
} from "../../scripts/fnos_webhook_cutover_ssh.mjs";

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
  return {
    database,
    async end() {},
  };
}

function endpointFactory(fakePool, role, options) {
  return new FakeEndpoint(fakePool.database, role, options);
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

function addAuthoritativeDelta(state) {
  // modify receipt 1 mutable fields so it becomes an update
  const r1 = state.tables.receipt.find((r) => String(r.receipt_id) === "1");
  if (r1) {
    r1.duplicate_count = 5;
    r1.last_duplicate_at = timestamp(4, "123456");
  }
}

test("progress: createProgressEvent validates phase, integer durationMs, and strict allowlisted numeric counts", () => {
  assert.throws(() => createProgressEvent("bogus_phase", 100), (err) => {
    assert.equal(err.code, "INVALID_PROGRESS_PHASE");
    // Ensure error message does NOT echo the input bogus_phase
    assert.equal(err.message.includes("bogus_phase"), false);
    assert.equal(err.message, "unsupported progress phase");
    return true;
  });
  assert.throws(() => sshCreateProgressEvent("bogus_phase", 100), (err) => {
    assert.equal(err.code, "INVALID_PROGRESS_PHASE");
    assert.equal(err.message.includes("bogus_phase"), false);
    return true;
  });

  const valid = createProgressEvent("plan", 150, { inserts: 10, updates: 2, total: 12 });
  assert.equal(valid.phase, "plan");
  assert.equal(valid.durationMs, 150);
  assert.deepEqual(valid.counts, { inserts: 10, updates: 2, total: 12 });
  assert.deepEqual(PROGRESS_PHASES, SSH_PROGRESS_PHASES);

  // Sensitive sentinels: numeric password, secretKey, strings, SQL fragments, objects are strictly stripped
  const sanitized = createProgressEvent("apply", 42, {
    inserts: 5,
    updates: 1,
    total: 6,
    password: 123456,
    secretKey: 99999,
    token: "secret_token_abc",
    sql: "SELECT * FROM secrets",
    payload: { sensitive: true },
    rowKey: "user:123",
    negativeCount: -1,
  });
  assert.equal(sanitized.phase, "apply");
  assert.equal(sanitized.durationMs, 42);
  assert.deepEqual(sanitized.counts, { inserts: 5, updates: 1, total: 6 });
  assert.equal("password" in (sanitized.counts ?? {}), false);
  assert.equal("secretKey" in (sanitized.counts ?? {}), false);
  assert.equal("token" in (sanitized.counts ?? {}), false);
  assert.equal("sql" in (sanitized.counts ?? {}), false);
  assert.equal("payload" in (sanitized.counts ?? {}), false);
  assert.equal("rowKey" in (sanitized.counts ?? {}), false);
  assert.equal("negativeCount" in (sanitized.counts ?? {}), false);
});

test("progress: summarizePlanCounts sums BigInt counts across all tables into safe numbers", () => {
  const tableCounts = {
    receipt: { inserted: "41837", updated: "0" },
    job: { inserted: "0", updated: "15" },
    event: { inserted: "100", updated: "200" },
  };
  const summary = summarizePlanCounts(tableCounts);
  assert.equal(summary.inserts, 41937);
  assert.equal(summary.updates, 215);
  assert.equal(summary.total, 42152);
  assert.deepEqual(ALLOWED_PROGRESS_COUNT_KEYS, ["sourceTables", "targetTables", "inserts", "updates", "total"]);
});

test("progress: default execution is silent without onProgress callback or opt-in flags", async () => {
  const source = new FakeDatabase(baseState(2));
  const target = new FakeDatabase(baseState(1));
  const result = await prepareForward(source, target);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.state, "planned");
  assert.ok(result.planHash);
});

test("progress: dry-run with non-zero inserts and updates emits exactly [begin, presnapshot, plan, finish] with matching counts", async () => {
  const source = new FakeDatabase(baseState(3));
  addAuthoritativeDelta(source.state);
  const target = new FakeDatabase(baseState(1));
  const events = [];
  const result = await prepareForward(source, target, {
    onProgress: (ev) => events.push(ev),
  });
  assert.equal(result.mode, "dry-run");
  assert.deepEqual(events.map((e) => e.phase), ["begin", "presnapshot", "plan", "finish"]);

  const planEvent = events.find((e) => e.phase === "plan");
  assert.ok(planEvent);
  assert.ok(planEvent.counts.inserts > 0);
  assert.ok(planEvent.counts.updates > 0);
  assert.equal(planEvent.counts.total, planEvent.counts.inserts + planEvent.counts.updates);

  const authoritativeSummary = summarizePlanCounts(result.counts);
  assert.deepEqual(planEvent.counts, authoritativeSummary);

  const finishEvent = events.find((e) => e.phase === "finish");
  assert.deepEqual(finishEvent.counts, authoritativeSummary);
});

test("progress: already-applied dry-run emits [begin, presnapshot, finish] in order", async () => {
  const source = new FakeDatabase(baseState(2));
  const target = new FakeDatabase(baseState(2));
  target.state = cloneState(source.state);
  const events = [];
  const result = await prepareForward(source, target, {
    onProgress: (ev) => events.push(ev),
  });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.state, "already_applied");
  assert.deepEqual(events.map((e) => e.phase), ["begin", "presnapshot", "finish"]);
});

test("progress: already-applied execute emits [begin, presnapshot, validatehash, freshreadback, finish] in order", async () => {
  const source = new FakeDatabase(baseState(2));
  const target = new FakeDatabase(baseState(2));
  target.state = cloneState(source.state);
  const dry = await prepareForward(source, target);
  const events = [];
  const result = await prepareForward(source, target, {
    execute: true,
    approvedPlanHash: dry.planHash,
    onProgress: (ev) => events.push(ev),
  });
  assert.equal(result.mode, "execute");
  assert.equal(result.state, "already_applied");
  assert.deepEqual(events.map((e) => e.phase), [
    "begin",
    "presnapshot",
    "validatehash",
    "freshreadback",
    "finish",
  ]);
});

test("progress: execute with non-zero inserts and updates emits all 9 phases in order with identical authoritative counts", async () => {
  const source = new FakeDatabase(baseState(3));
  addAuthoritativeDelta(source.state);
  const target = new FakeDatabase(baseState(1));
  const dry = await prepareForward(source, target);
  const approvedPlanHash = dry.planHash;

  const events = [];
  const result = await prepareForward(source, target, {
    execute: true,
    approvedPlanHash,
    onProgress: (ev) => events.push(ev),
  });
  assert.equal(result.mode, "execute");
  assert.equal(result.state, "applied");
  assert.deepEqual(events.map((e) => e.phase), [
    "begin",
    "presnapshot",
    "plan",
    "validatehash",
    "apply",
    "finalvalidation",
    "commit",
    "freshreadback",
    "finish",
  ]);
  assert.equal(result.planHash, approvedPlanHash);

  const authoritativeSummary = summarizePlanCounts(result.counts);
  assert.ok(authoritativeSummary.inserts > 0);
  assert.ok(authoritativeSummary.updates > 0);
  for (const phase of ["plan", "validatehash", "apply", "finish"]) {
    const ev = events.find((e) => e.phase === phase);
    assert.deepEqual(ev.counts, authoritativeSummary);
  }
});

test("progress: planHash is strictly identical whether onProgress is provided or omitted", async () => {
  const source1 = new FakeDatabase(baseState(2));
  const target1 = new FakeDatabase(baseState(1));
  const dryWithoutProgress = await prepareForward(source1, target1);

  const source2 = new FakeDatabase(baseState(2), source1.identity);
  const target2 = new FakeDatabase(baseState(1), target1.identity);
  const dryWithProgress = await prepareForward(source2, target2, {
    onProgress: () => {},
  });
  assert.equal(dryWithProgress.planHash, dryWithoutProgress.planHash);
  assert.deepEqual(dryWithProgress.counts, dryWithoutProgress.counts);
});

test("progress: failure at presnapshot never emits finish", async () => {
  const source = new FakeDatabase(baseState(2));
  const target = new FakeDatabase(baseState(1));
  source.failBeginAt = 1; // causes fresh-read failure during presnapshot
  const events = [];
  await assert.rejects(async () => {
    await prepareForward(source, target, {
      onProgress: (ev) => events.push(ev),
    });
  });

  assert.deepEqual(events.map((e) => e.phase), ["begin"]);
  assert.ok(!events.some((e) => e.phase === "finish"));
});

test("progress: failure at validatehash (plan hash mismatch) never emits finish", async () => {
  const source = new FakeDatabase(baseState(2));
  const target = new FakeDatabase(baseState(1));
  const bogusHash = "f".repeat(64);
  const events = [];
  await assert.rejects(async () => {
    await prepareForward(source, target, {
      execute: true,
      approvedPlanHash: bogusHash,
      onProgress: (ev) => events.push(ev),
    });
  }, { code: "PLAN_HASH_MISMATCH" });

  assert.deepEqual(events.map((e) => e.phase), ["begin", "presnapshot", "plan"]);
  assert.ok(!events.some((e) => e.phase === "finish"));
});

test("progress: failure at apply never emits finish", async () => {
  const source = new FakeDatabase(baseState(2));
  const target = new FakeDatabase(baseState(1));
  const dry = await prepareForward(source, target);
  target.throwOnNextEnable = true;
  const events = [];
  await assert.rejects(async () => {
    await prepareForward(source, target, {
      execute: true,
      approvedPlanHash: dry.planHash,
      onProgress: (ev) => events.push(ev),
    });
  });
  assert.ok(events.length >= 3);
  assert.deepEqual(events.map((e) => e.phase), ["begin", "presnapshot", "plan", "validatehash"]);
  assert.ok(!events.some((e) => e.phase === "finish"));
});

test("progress: synchronous throw in onProgress during commit phase is isolated and authoritativeReadback succeeds", async () => {
  const source1 = new FakeDatabase(baseState(2));
  const target1 = new FakeDatabase(baseState(1));
  const dry = await prepareForward(source1, target1);

  // Baseline execute with safe callback
  const baselineResult = await prepareForward(source1, target1, {
    execute: true,
    approvedPlanHash: dry.planHash,
  });
  assert.equal(baselineResult.state, "applied");

  // Re-run with aggressive throw in onProgress during commit phase
  const source2 = new FakeDatabase(baseState(2), source1.identity);
  const target2 = new FakeDatabase(baseState(1), target1.identity);
  let commitThrowTriggered = false;
  const faultyProgress = (event) => {
    if (event.phase === "commit") {
      commitThrowTriggered = true;
      throw new Error("malicious or failing telemetry sink on commit");
    }
  };

  const isolatedResult = await prepareForward(source2, target2, {
    execute: true,
    approvedPlanHash: dry.planHash,
    onProgress: faultyProgress,
  });

  assert.equal(commitThrowTriggered, true);
  assert.equal(isolatedResult.state, "applied");
  assert.equal(isolatedResult.commitOutcome, "committed");
  assert.equal(isolatedResult.readyForForwardBaseline, true);
  assert.equal(isolatedResult.planHash, baselineResult.planHash);
  assert.deepEqual(isolatedResult.counts, baselineResult.counts);
});

test("progress: asynchronous Promise rejection in onProgress during commit phase is isolated without unhandled rejection", async () => {
  const source1 = new FakeDatabase(baseState(2));
  const target1 = new FakeDatabase(baseState(1));
  const dry = await prepareForward(source1, target1);

  const source2 = new FakeDatabase(baseState(2), source1.identity);
  const target2 = new FakeDatabase(baseState(1), target1.identity);
  let asyncRejectTriggered = false;
  const rejectingProgress = async (event) => {
    if (event.phase === "commit") {
      asyncRejectTriggered = true;
      throw new Error("async rejecting sink on commit");
    }
  };

  const isolatedResult = await prepareForward(source2, target2, {
    execute: true,
    approvedPlanHash: dry.planHash,
    onProgress: rejectingProgress,
  });

  assert.equal(asyncRejectTriggered, true);
  assert.equal(isolatedResult.state, "applied");
  assert.equal(isolatedResult.commitOutcome, "committed");
  assert.equal(isolatedResult.readyForForwardBaseline, true);
});

test("progress: genuine database commit failure is NOT hidden by progress isolation", async () => {
  const source = new FakeDatabase(baseState(2));
  const target = new FakeDatabase(baseState(1));
  const dry = await prepareForward(source, target);
  target.commitMode = "throw-before";

  await assert.rejects(async () => {
    await prepareForward(source, target, {
      execute: true,
      approvedPlanHash: dry.planHash,
      onProgress: () => {},
    });
  });
});

test("progress: CLI --progress outputs progress JSON lines to stderr while stdout remains unchanged final result JSON", async () => {
  const source = new FakeDatabase(baseState(2));
  const target = new FakeDatabase(baseState(1));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutText = "";
  let stderrText = "";
  stdout.on("data", (chunk) => { stdoutText += chunk.toString("utf8"); });
  stderr.on("data", (chunk) => { stderrText += chunk.toString("utf8"); });

  const exitCode = await main({
    argv: [
      "prepare-forward",
      "--progress",
      "--approved-source-identity", identityFingerprint(source.identity),
      "--approved-target-identity", identityFingerprint(target.identity),
    ],
    environment: {
      FNOS_WEBHOOK_SOURCE_DATABASE_URL: "postgresql://source.invalid/shein_fm",
      FNOS_WEBHOOK_TARGET_DATABASE_URL: "postgresql://target.invalid/shein_fm",
    },
    stdout,
    stderr,
    poolFactory: (role) => (role === "source" ? pool(source) : pool(target)),
    endpointFactory,
  });

  assert.equal(exitCode, 0);
  const parsedStdout = JSON.parse(stdoutText);
  assert.equal(parsedStdout.mode, "dry-run");
  assert.equal(parsedStdout.state, "planned");

  const stderrLines = stderrText.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(stderrLines.length >= 4);
  assert.deepEqual(stderrLines.map((l) => l.phase), ["begin", "presnapshot", "plan", "finish"]);
});

test("progress: FNOS_WEBHOOK_PROGRESS=1 activates progress output without CLI flag", async () => {
  const source = new FakeDatabase(baseState(2));
  const target = new FakeDatabase(baseState(1));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutText = "";
  let stderrText = "";
  stdout.on("data", (chunk) => { stdoutText += chunk.toString("utf8"); });
  stderr.on("data", (chunk) => { stderrText += chunk.toString("utf8"); });

  const exitCode = await main({
    argv: [
      "prepare-forward",
      "--approved-source-identity", identityFingerprint(source.identity),
      "--approved-target-identity", identityFingerprint(target.identity),
    ],
    environment: {
      FNOS_WEBHOOK_PROGRESS: "1",
      FNOS_WEBHOOK_SOURCE_DATABASE_URL: "postgresql://source.invalid/shein_fm",
      FNOS_WEBHOOK_TARGET_DATABASE_URL: "postgresql://target.invalid/shein_fm",
    },
    stdout,
    stderr,
    poolFactory: (role) => (role === "source" ? pool(source) : pool(target)),
    endpointFactory,
  });

  assert.equal(exitCode, 0);
  const stderrLines = stderrText.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(stderrLines.length >= 4);
  assert.deepEqual(stderrLines.map((l) => l.phase), ["begin", "presnapshot", "plan", "finish"]);
});

test("progress: parseArguments with --progress returns progress: true and rejects duplicate --progress", () => {
  const sourceId = "a".repeat(64);
  const targetId = "b".repeat(64);
  const parsed = parseArguments([
    "prepare-forward",
    "--progress",
    "--approved-source-identity", sourceId,
    "--approved-target-identity", targetId,
  ]);
  assert.equal(parsed.progress, true);
  assert.throws(() => parseArguments([
    "prepare-forward",
    "--progress",
    "--progress",
    "--approved-source-identity", sourceId,
    "--approved-target-identity", targetId,
  ]), { code: "DUPLICATE_ARGUMENT" });
});
