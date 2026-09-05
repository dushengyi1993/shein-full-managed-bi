#!/usr/bin/env node

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, realpathSync } from "node:fs";
import { chmod, mkdtemp, open, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool, TypeOverrides, types: pgTypes } = pg;

const MANIFEST_SCHEMA_VERSION = 4;
const PLAN_VERSION = "shein-fm-fnos-webhook-cutover-v4";
const SOURCE_URL_VARIABLE = "FNOS_WEBHOOK_SOURCE_DATABASE_URL";
const TARGET_URL_VARIABLE = "FNOS_WEBHOOK_TARGET_DATABASE_URL";
const BATCH_SIZE_VARIABLE = "FNOS_WEBHOOK_BATCH_SIZE";
const LOCK_TEXT = "shein-fm:fnos-webhook-cutover:v4";
const DEFAULT_BATCH_SIZE = 250;
const MAX_BATCH_SIZE = 1000;
const MAX_DIGEST_BATCH_SIZE = 10000;
export const MAX_INSERT_PARAMETERS = 60000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BIGINT_PATTERN = /^-?[0-9]+$/;
const READINESS_KEYS = Object.freeze([
  "nonterminalJobs",
  "pendingDirectives",
  "retryDirectives",
  "runningDirectives",
  "ownedDirectiveLeases",
  "expiringDirectiveLeases",
  "nonterminalDirectives",
  "subscriptions",
  "gates",
]);
export const PROGRESS_PHASES = Object.freeze([
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

export const ALLOWED_PROGRESS_COUNT_KEYS = Object.freeze([
  "sourceTables",
  "targetTables",
  "inserts",
  "updates",
  "total",
]);

function sanitizeProgressCounts(counts) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return undefined;
  const clean = {};
  for (const key of ALLOWED_PROGRESS_COUNT_KEYS) {
    if (!Object.hasOwn(counts, key)) continue;
    const val = counts[key];
    if (typeof val === "number" && Number.isSafeInteger(val) && val >= 0) {
      clean[key] = val;
    }
  }
  return Object.keys(clean).length > 0 ? Object.freeze(clean) : undefined;
}

export function summarizePlanCounts(planCounts) {
  let inserts = 0n;
  let updates = 0n;
  if (planCounts && typeof planCounts === "object") {
    for (const item of Object.values(planCounts)) {
      if (item && typeof item === "object") {
        if (item.inserted !== undefined && item.inserted !== null) {
          inserts += BigInt(item.inserted);
        }
        if (item.updated !== undefined && item.updated !== null) {
          updates += BigInt(item.updated);
        }
      }
    }
  }
  const total = inserts + updates;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("COUNT_OVERFLOW", "plan count exceeds safe integer range");
  }
  return Object.freeze({
    inserts: Number(inserts),
    updates: Number(updates),
    total: Number(total),
  });
}

export function createProgressEvent(phase, durationMs, counts = null) {
  if (!PROGRESS_PHASES.includes(phase)) {
    fail("INVALID_PROGRESS_PHASE", "unsupported progress phase");
  }
  const safeDuration = Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : 0;
  const sanitizedCounts = sanitizeProgressCounts(counts);
  const event = {
    phase,
    durationMs: safeDuration,
  };
  if (sanitizedCounts) {
    event.counts = sanitizedCounts;
  }
  return Object.freeze(event);
}

function emitProgress(onProgress, phase, durationMs, counts = null) {
  if (typeof onProgress !== "function") return;
  try {
    const event = createProgressEvent(phase, durationMs, counts);
    const maybePromise = onProgress(event);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch {
    // strictly isolate progress sink errors so telemetry never disrupts
    // transaction gates, commit, authoritative readback, or rollback outcome
  }
}

export const CUTOVER_APPLICATION_NAME = "shein_fm_fnos_webhook_cutover_v4";
const EXPECTED_DATABASE = "shein_fm";
const EXPECTED_ROLE = "sheinfm";
const EXPECTED_SERVER_ADDRESS = "127.0.0.1/32";
const EXPECTED_SERVER_PORT = "5432";
const EXPECTED_SERVER_VERSION = "160014";

function table(definition) {
  return Object.freeze({
    ...definition,
    columns: Object.freeze(definition.columns),
    primaryKey: Object.freeze(definition.primaryKey),
    primaryKeyTypes: Object.freeze(definition.primaryKeyTypes),
    jsonColumns: Object.freeze(definition.jsonColumns ?? []),
    mutableColumns: Object.freeze(definition.mutableColumns ?? []),
    externalReferences: Object.freeze(definition.externalReferences ?? []),
  });
}

export const TABLES = Object.freeze([
  table({
    key: "receipt",
    relation: "raw.webhook_receipt",
    columns: [
      "receipt_id", "idempotency_key", "app_key_hash", "open_key_hash",
      "event_code", "event_path", "store_id", "delivery_scope",
      "platform_timestamp", "cipher_sha256", "ciphertext", "safe_projection",
      "duplicate_count", "last_duplicate_at", "received_at", "created_at",
    ],
    primaryKey: ["receipt_id"],
    primaryKeyTypes: ["bigint"],
    identityColumn: "receipt_id",
    sequence: "raw.webhook_receipt_receipt_id_seq",
    mutableColumns: ["duplicate_count", "last_duplicate_at"],
    jsonColumns: ["safe_projection"],
    receipt: true,
    externalReferences: [{ column: "store_id", relation: "dim.store", targetColumn: "store_id" }],
  }),
  table({
    key: "heartbeat",
    relation: "ops.webhook_runtime_heartbeat",
    columns: [
      "webhook_runtime_heartbeat_id", "component_code", "instance_id",
      "status_code", "observed_at", "expires_at", "event_fingerprint", "created_at",
    ],
    primaryKey: ["webhook_runtime_heartbeat_id"],
    primaryKeyTypes: ["bigint"],
    identityColumn: "webhook_runtime_heartbeat_id",
    sequence: "ops.webhook_runtime_heartbeat_webhook_runtime_heartbeat_id_seq",
    appendOnly: true,
  }),
  table({
    key: "job",
    relation: "ops.webhook_job",
    columns: [
      "job_id", "receipt_id", "status", "attempt_count", "max_attempts",
      "available_at", "lease_owner", "lease_expires_at", "last_error_code",
      "last_error_message", "completed_at", "created_at", "updated_at",
    ],
    primaryKey: ["job_id"],
    primaryKeyTypes: ["bigint"],
    identityColumn: "job_id",
    sequence: "ops.webhook_job_job_id_seq",
  }),
  table({
    key: "event",
    relation: "ops.operational_event",
    columns: [
      "operational_event_id", "receipt_id", "store_id", "event_code",
      "event_path", "event_family", "business_type", "business_key",
      "occurred_at", "action", "platform_status", "severity", "delivery_scope",
      "safe_projection", "created_at", "updated_at",
    ],
    primaryKey: ["operational_event_id"],
    primaryKeyTypes: ["bigint"],
    identityColumn: "operational_event_id",
    sequence: "ops.operational_event_operational_event_id_seq",
    jsonColumns: ["safe_projection"],
    externalReferences: [{ column: "store_id", relation: "dim.store", targetColumn: "store_id" }],
  }),
  table({
    key: "directive",
    relation: "ops.webhook_hydration_directive",
    columns: [
      "hydration_directive_id", "operational_event_id", "store_id",
      "directive_type", "capability_code", "lookup_projection", "state",
      "attempt_count", "available_at", "completed_at", "created_at", "updated_at",
      "lease_owner", "lease_expires_at", "last_error_code", "last_error_message",
    ],
    primaryKey: ["hydration_directive_id"],
    primaryKeyTypes: ["bigint"],
    identityColumn: "hydration_directive_id",
    sequence: "ops.webhook_hydration_directive_hydration_directive_id_seq",
    jsonColumns: ["lookup_projection"],
    externalReferences: [{ column: "store_id", relation: "dim.store", targetColumn: "store_id" }],
  }),
  table({
    key: "subscription",
    relation: "ops.webhook_subscription_state",
    columns: [
      "webhook_subscription_state_id", "app_key_hash", "event_code",
      "desired_state", "observed_state", "callback_validated", "checked_at",
      "created_at", "updated_at",
    ],
    primaryKey: ["webhook_subscription_state_id"],
    primaryKeyTypes: ["bigint"],
    identityColumn: "webhook_subscription_state_id",
    sequence: "ops.webhook_subscription_state_webhook_subscription_state_id_seq",
  }),
  table({
    key: "gate",
    relation: "ops.webhook_store_gate",
    columns: [
      "store_id", "gate_key", "state", "reason_code",
      "source_operational_event_id", "blocked_at", "reopened_at", "last_probe_id",
      "recovery_requires_probe", "created_at", "updated_at",
    ],
    primaryKey: ["store_id", "gate_key"],
    primaryKeyTypes: ["bigint", "text"],
    identityColumn: null,
    sequence: null,
    externalReferences: [
      { column: "store_id", relation: "dim.store", targetColumn: "store_id" },
      { column: "last_probe_id", relation: "ops.permission_probe", targetColumn: "permission_probe_id" },
    ],
  }),
]);

const TABLE_BY_KEY = new Map(TABLES.map((definition) => [definition.key, definition]));
const APPLY_ORDER = Object.freeze(["receipt", "event", "job", "directive", "heartbeat", "subscription", "gate"]);
const SEQUENCE_TABLES = Object.freeze(TABLES.filter((definition) => definition.sequence));
const MANAGED_OBJECT_NAMES = Object.freeze([
  ...TABLES.map((definition) => definition.relation),
  ...SEQUENCE_TABLES.map((definition) => definition.sequence),
]);

function trigger(definition) {
  return Object.freeze(definition);
}

export const MANAGED_TRIGGERS = Object.freeze([
  trigger({ relation: "raw.webhook_receipt", name: "trg_raw_webhook_receipt_immutable", controlled: false }),
  trigger({ relation: "ops.webhook_runtime_heartbeat", name: "trg_ops_webhook_runtime_heartbeat_append_only", controlled: false }),
  trigger({ relation: "ops.webhook_job", name: "trg_ops_webhook_job_touch_updated_at", controlled: true }),
  trigger({ relation: "ops.operational_event", name: "trg_ops_operational_event_touch_updated_at", controlled: true }),
  trigger({ relation: "ops.webhook_hydration_directive", name: "trg_ops_webhook_hydration_touch_updated_at", controlled: true }),
  trigger({ relation: "ops.webhook_subscription_state", name: "trg_ops_webhook_subscription_touch_updated_at", controlled: true }),
  trigger({ relation: "ops.webhook_store_gate", name: "trg_ops_webhook_store_gate_recovery", controlled: true }),
  trigger({ relation: "ops.webhook_store_gate", name: "trg_ops_webhook_store_gate_touch_updated_at", controlled: true }),
]);

const CONTROLLED_TRIGGERS = Object.freeze(MANAGED_TRIGGERS.filter((item) => item.controlled));

export class WebhookCutoverError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "WebhookCutoverError";
    this.code = code;
  }
}

function fail(code, message, options = {}) {
  throw new WebhookCutoverError(code, message, options);
}

function quoteIdent(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    fail("INVALID_IDENTIFIER", "database identifier did not match the audited contract");
  }
  return "\"" + value + "\"";
}

function quotedRelation(value) {
  const parts = value.split(".");
  if (parts.length !== 2) fail("INVALID_RELATION", "qualified relation is required");
  return parts.map(quoteIdent).join(".");
}

function tableForKey(key) {
  const definition = TABLE_BY_KEY.get(key);
  if (!definition) fail("TABLE_CONTRACT_INVALID", "unknown table contract");
  return definition;
}

function strictBigInt(value, code = "BIGINT_INVALID") {
  const text = String(value);
  if (!BIGINT_PATTERN.test(text)) fail(code, "database bigint value is invalid");
  try {
    return BigInt(text);
  } catch (error) {
    fail(code, "database bigint value is outside the supported range", { cause: error });
  }
}

function bigintString(value, code) {
  return strictBigInt(value, code).toString();
}

function parseBatchSize(value) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_BATCH_SIZE;
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) fail("BATCH_SIZE_INVALID", "batch size must be an integer");
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
    fail("BATCH_SIZE_INVALID", "batch size must be between 1 and " + MAX_BATCH_SIZE);
  }
  return parsed;
}

function parseDigestBatchSize(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) fail("BATCH_SIZE_INVALID", "digest batch size must be an integer");
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_DIGEST_BATCH_SIZE) {
    fail("BATCH_SIZE_INVALID", "digest batch size must be between 1 and " + MAX_DIGEST_BATCH_SIZE);
  }
  return parsed;
}

function parseMaxInsertParameters(value) {
  if (value === undefined || value === null) return MAX_INSERT_PARAMETERS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_INSERT_PARAMETERS) {
    fail("BATCH_SIZE_INVALID", "max insert parameters must be a safe integer between 1 and " + MAX_INSERT_PARAMETERS);
  }
  return value;
}

export function canonicalJson(value) {
  if (value instanceof Date) {
    fail("DATE_PRECISION_LOSS", "Date objects are forbidden because PostgreSQL microseconds would be lost");
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("NONFINITE_NUMBER", "non-finite numbers are forbidden");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map((entry) => JSON.stringify(entry[0]) + ":" + canonicalJson(entry[1]));
    return "{" + entries.join(",") + "}";
  }
  fail("CANONICAL_VALUE_INVALID", "unsupported value in canonical serialization");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashFrame(hash, value) {
  const body = typeof value === "string" ? value : canonicalJson(value);
  hash.update(String(Buffer.byteLength(body, "utf8")), "utf8");
  hash.update(":", "utf8");
  hash.update(body, "utf8");
}

function assertNoDate(value) {
  canonicalJson(value);
}

export function primaryKeyToken(tableKey, row) {
  const definition = tableForKey(tableKey);
  return canonicalJson(definition.primaryKey.map((column) => row[column]));
}

function compareScalar(left, right, type) {
  if (type === "bigint") {
    const a = strictBigInt(left);
    const b = strictBigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrimaryKeys(definition, left, right) {
  for (let index = 0; index < definition.primaryKey.length; index += 1) {
    const column = definition.primaryKey[index];
    const comparison = compareScalar(left[column], right[column], definition.primaryKeyTypes[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function cursorFor(definition, row) {
  return Object.fromEntries(definition.primaryKey.map((column) => [column, row[column]]));
}

function projectRow(definition, row, projection) {
  const columns = projection === "receiptMutable"
    ? [...definition.primaryKey, ...definition.mutableColumns]
    : definition.columns;
  const projected = {};
  for (const column of columns) {
    if (!Object.hasOwn(row, column)) fail("ROW_COLUMN_MISSING", "database row omitted a contracted column for " + definition.key);
    projected[column] = row[column];
  }
  assertNoDate(projected);
  return projected;
}

function triggerKey(item) {
  return item.relation + "." + item.name;
}

export function createTimestampPreservingTypes() {
  const overrides = new TypeOverrides();
  overrides.setTypeParser(pgTypes.builtins.TIMESTAMP, (value) => value);
  overrides.setTypeParser(pgTypes.builtins.TIMESTAMPTZ, (value) => value);
  return overrides;
}

function validateIdentity(identity) {
  assertExactKeys(
    identity,
    [
      "systemIdentifier", "currentDatabase", "sessionUser", "currentUser",
      "roleSuperuser", "roleBypassRls", "serverAddress", "serverPort",
      "serverVersionNum", "applicationName", "objects",
    ],
    "DATABASE_IDENTITY_INVALID",
    "database identity"
  );
  if (!/^[0-9]+$/.test(String(identity.systemIdentifier)) || BigInt(identity.systemIdentifier) <= 0n) {
    fail("DATABASE_IDENTITY_INVALID", "PostgreSQL system identifier is invalid");
  }
  if (!/^[0-9]+$/.test(String(identity.serverVersionNum)) || BigInt(identity.serverVersionNum) <= 0n) {
    fail("DATABASE_IDENTITY_INVALID", "PostgreSQL server version number is invalid");
  }
  for (const key of ["currentDatabase", "sessionUser", "currentUser", "serverAddress", "serverPort", "applicationName"]) {
    const value = String(identity[key]);
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
      fail("DATABASE_IDENTITY_INVALID", "PostgreSQL database or role identity is invalid");
    }
  }
  if (typeof identity.roleSuperuser !== "boolean" || typeof identity.roleBypassRls !== "boolean") {
    fail("DATABASE_IDENTITY_INVALID", "PostgreSQL role attributes are invalid");
  }
  assertExactKeys(identity.objects, MANAGED_OBJECT_NAMES, "DATABASE_OBJECT_SET_INVALID", "managed database objects");
  for (const name of MANAGED_OBJECT_NAMES) {
    const binding = identity.objects[name];
    assertExactKeys(binding, ["oid", "owner"], "DATABASE_OBJECT_BINDING_INVALID", "managed object binding");
    if (!/^[0-9]+$/.test(String(binding.oid)) || BigInt(binding.oid) <= 0n ||
        !String(binding.owner) || /[\u0000-\u001f\u007f]/.test(String(binding.owner))) {
      fail("DATABASE_OBJECT_BINDING_INVALID", "managed object OID or owner is invalid");
    }
  }
}

export function identityFingerprint(identity) {
  validateIdentity(identity);
  return sha256(canonicalJson(identity));
}

function defaultPoolFactory(_role, connectionString) {
  return new Pool({
    connectionString,
    user: EXPECTED_ROLE,
    database: EXPECTED_DATABASE,
    application_name: CUTOVER_APPLICATION_NAME,
    max: 1,
    min: 0,
    maxUses: 1,
    types: createTimestampPreservingTypes(),
  });
}

function expectedDatabaseName(role, testDatabaseNames) {
  if (testDatabaseNames === null || testDatabaseNames === undefined) return EXPECTED_DATABASE;
  const invalid = () => fail(
    "TEST_DATABASE_OVERRIDE_INVALID",
    "test database override must be one complete dedicated source/target fixture pair"
  );
  if (role !== "source" && role !== "target") invalid();
  if (!testDatabaseNames || typeof testDatabaseNames !== "object" || Array.isArray(testDatabaseNames)) invalid();
  let keys;
  let source;
  let target;
  try {
    keys = Reflect.ownKeys(testDatabaseNames);
    source = testDatabaseNames.source;
    target = testDatabaseNames.target;
  } catch {
    invalid();
  }
  if (keys.length !== 2 || !keys.includes("source") || !keys.includes("target") ||
      keys.some((key) => typeof key !== "string")) {
    invalid();
  }
  const pattern = /^fnos_cutover_test_(source|target)_[a-z0-9_]+$/;
  const sourceMatch = typeof source === "string" ? source.match(pattern) : null;
  const targetMatch = typeof target === "string" ? target.match(pattern) : null;
  if (!sourceMatch || !targetMatch || source === target || sourceMatch[1] === targetMatch[1]) {
    fail("TEST_DATABASE_OVERRIDE_INVALID", "test database override is not a dedicated cutover fixture");
  }
  return testDatabaseNames[role];
}

function assertOperationalIdentity(snapshot, role, testDatabaseNames) {
  const identity = snapshot.identity;
  const expectedDatabase = expectedDatabaseName(role, testDatabaseNames);
  if (identity.currentDatabase !== expectedDatabase ||
      identity.sessionUser !== EXPECTED_ROLE || identity.currentUser !== EXPECTED_ROLE ||
      identity.roleSuperuser !== true || identity.roleBypassRls !== true ||
      identity.serverAddress !== EXPECTED_SERVER_ADDRESS || identity.serverPort !== EXPECTED_SERVER_PORT ||
      identity.serverVersionNum !== EXPECTED_SERVER_VERSION ||
      identity.applicationName !== CUTOVER_APPLICATION_NAME) {
    fail("DATABASE_IDENTITY_MISMATCH", "database session does not match the audited cutover identity contract");
  }
  for (const name of MANAGED_OBJECT_NAMES) {
    if (identity.objects[name].owner !== EXPECTED_ROLE) {
      fail("DATABASE_OBJECT_OWNER_MISMATCH", "managed database object owner differs from the audited role");
    }
  }
}

function validateSessionEvidence(session) {
  assertExactKeys(
    session,
    ["backendPid", "backendStart", "transportGeneration"],
    "SESSION_EVIDENCE_INVALID",
    "database session evidence"
  );
  if (!/^[0-9]+$/.test(String(session.backendPid)) || BigInt(session.backendPid) <= 0n) {
    fail("SESSION_EVIDENCE_INVALID", "database backend PID is invalid");
  }
  timestampText(session.backendStart, "SESSION_EVIDENCE_INVALID");
  if (session.transportGeneration !== null &&
      (!/^[0-9]+$/.test(String(session.transportGeneration)) || BigInt(session.transportGeneration) <= 0n)) {
    fail("SESSION_EVIDENCE_INVALID", "SSH transport generation is invalid");
  }
}

function assertFreshSessionEvidence(fresh, previous) {
  if (fresh.backendPid === previous.backendPid && fresh.backendStart === previous.backendStart) {
    fail("FRESH_READBACK_REUSED_BACKEND", "authoritative readback reused the execution PostgreSQL backend");
  }
  if (previous.transportGeneration !== null) {
    if (fresh.transportGeneration === null || fresh.transportGeneration === previous.transportGeneration) {
      fail("FRESH_READBACK_REUSED_TRANSPORT", "authoritative readback did not use a fresh SSH child generation");
    }
  }
}

function buildRangeClause(definition, options, values) {
  const conditions = [];
  if (definition.identityColumn) {
    const lower = options.cursor?.[definition.identityColumn] ?? options.minExclusive ?? null;
    if (lower !== null) {
      values.push(bigintString(lower, "RANGE_BOUND_INVALID"));
      conditions.push("snapshot_row." + quoteIdent(definition.identityColumn) + " > $" + values.length + "::bigint");
    }
    if (options.maxInclusive !== undefined && options.maxInclusive !== null) {
      values.push(bigintString(options.maxInclusive, "RANGE_BOUND_INVALID"));
      conditions.push("snapshot_row." + quoteIdent(definition.identityColumn) + " <= $" + values.length + "::bigint");
    }
  } else if (options.cursor) {
    const placeholders = [];
    for (const column of definition.primaryKey) {
      values.push(options.cursor[column]);
      placeholders.push("$" + values.length);
    }
    const columns = definition.primaryKey.map((column) => "snapshot_row." + quoteIdent(column)).join(", ");
    conditions.push("(" + columns + ") > (" + placeholders.join(", ") + ")");
  }
  return conditions.length ? " WHERE " + conditions.join(" AND ") : "";
}

function keyJsonExpression(definition) {
  return "jsonb_build_array(" + definition.primaryKey.map((column) => "snapshot_row." + quoteIdent(column)).join(", ") + ")::text";
}

function fullJsonExpression(definition) {
  return "to_jsonb(snapshot_row)::text";
}

function immutableJsonExpression(definition) {
  if (!definition.receipt) return null;
  return "(to_jsonb(snapshot_row) - 'duplicate_count' - 'last_duplicate_at')::text";
}

export class PgEndpoint {
  constructor(pool, role, { batchSize = DEFAULT_BATCH_SIZE, digestBatchSize, maxInsertParameters = MAX_INSERT_PARAMETERS } = {}) {
    this.pool = pool;
    this.role = role;
    this.batchSize = parseBatchSize(batchSize);
    this.digestBatchSize = parseDigestBatchSize(digestBatchSize, this.batchSize);
    this.maxInsertParameters = parseMaxInsertParameters(maxInsertParameters);
    this.client = null;
    this.inTransaction = false;
    this.transportGeneration = null;
  }

  async beginFrozen() {
    if (this.client) fail("ENDPOINT_STATE_INVALID", "endpoint already owns a connection");
    this.client = await this.pool.connect();
    const transportGeneration = this.client.connection?.stream?.fnosWebhookTransportGeneration;
    this.transportGeneration = transportGeneration === undefined || transportGeneration === null
      ? null
      : String(transportGeneration);
    try {
      await this.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      this.inTransaction = true;
      await this.client.query("SET LOCAL lock_timeout TO '10s'");
      await this.client.query("SET LOCAL statement_timeout TO '30min'");
      await this.client.query("SET LOCAL TIME ZONE 'UTC'");
      await this.client.query("SET LOCAL DateStyle TO 'ISO, YMD'");
      await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [LOCK_TEXT]);
      await this.client.query(
        "LOCK TABLE " + TABLES.map((definition) => quotedRelation(definition.relation)).join(", ") +
        " IN ACCESS EXCLUSIVE MODE"
      );
      await this.validateContract();
    } catch (error) {
      await this.rollback().catch(() => {});
      this.release({ destroy: true });
      throw error;
    }
  }

  async validateContract() {
    for (const definition of TABLES) {
      const parts = definition.relation.split(".");
      const result = await this.client.query(
        "SELECT column_name, is_identity, identity_generation " +
        "FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 " +
        "ORDER BY ordinal_position",
        parts
      );
      const actualColumns = result.rows.map((row) => String(row.column_name));
      const expectedColumns = [...definition.columns];
      if (canonicalJson(actualColumns.sort()) !== canonicalJson(expectedColumns.sort())) {
        fail("SCHEMA_COLUMN_DRIFT", "column contract differs for " + definition.key);
      }
      if (definition.identityColumn) {
        const identity = result.rows.find((row) => row.column_name === definition.identityColumn);
        if (!identity || identity.is_identity !== "YES" || identity.identity_generation !== "ALWAYS") {
          fail("IDENTITY_CONTRACT_DRIFT", "identity contract differs for " + definition.key);
        }
        const sequenceResult = await this.client.query(
          "SELECT pg_get_serial_sequence($1, $2) AS sequence_name",
          [definition.relation, definition.identityColumn]
        );
        if (sequenceResult.rows[0]?.sequence_name !== definition.sequence) {
          fail("SEQUENCE_CONTRACT_DRIFT", "identity sequence differs for " + definition.key);
        }
      }
    }
  }

  async *scanDigestEntries(tableKey, options = {}) {
    const definition = tableForKey(tableKey);
    let cursor = options.cursor ?? null;
    let previous = null;
    while (true) {
      const values = [];
      const where = buildRangeClause(definition, { ...options, cursor }, values);
      const immutable = immutableJsonExpression(definition);
      const select = [
        ...definition.primaryKey.map((column) => "snapshot_row." + quoteIdent(column)),
        "encode(sha256(convert_to(" + keyJsonExpression(definition) + ", 'UTF8')), 'hex') AS __key_hash",
        "encode(sha256(convert_to(" + fullJsonExpression(definition) + ", 'UTF8')), 'hex') AS __full_hash",
      ];
      if (immutable) {
        select.push("encode(sha256(convert_to(" + immutable + ", 'UTF8')), 'hex') AS __immutable_hash");
        select.push("snapshot_row." + quoteIdent("duplicate_count"));
        select.push("snapshot_row." + quoteIdent("last_duplicate_at"));
      }
      values.push(this.digestBatchSize);
      const result = await this.client.query(
        "SELECT " + select.join(", ") + " FROM " + quotedRelation(definition.relation) + " AS snapshot_row" +
        where + " ORDER BY " + definition.primaryKey.map((column) => "snapshot_row." + quoteIdent(column)).join(", ") +
        " LIMIT $" + values.length,
        values
      );
      if (result.rows.length > this.digestBatchSize) fail("BATCH_BOUND_EXCEEDED", "database returned an oversized digest batch");
      for (const raw of result.rows) {
        const current = cursorFor(definition, raw);
        if (previous && comparePrimaryKeys(definition, previous, current) >= 0) {
          fail("PRIMARY_KEY_ORDER_INVALID", "digest scan was not strictly ordered for " + definition.key);
        }
        previous = current;
        const entry = {
          key: current,
          keyHash: String(raw.__key_hash),
          fullHash: String(raw.__full_hash),
          immutableHash: raw.__immutable_hash === undefined ? null : String(raw.__immutable_hash),
          mutable: definition.receipt
            ? projectRow(definition, raw, "receiptMutable")
            : null,
        };
        if (!HASH_PATTERN.test(entry.keyHash) || !HASH_PATTERN.test(entry.fullHash) ||
            (entry.immutableHash !== null && !HASH_PATTERN.test(entry.immutableHash))) {
          fail("ROW_HASH_INVALID", "database returned an invalid row hash for " + definition.key);
        }
        yield entry;
      }
      if (result.rows.length < this.digestBatchSize) break;
      cursor = cursorFor(definition, result.rows[result.rows.length - 1]);
    }
  }

  async *scanRows(tableKey, options = {}) {
    const definition = tableForKey(tableKey);
    const projection = options.projection ?? "full";
    const columns = projection === "receiptMutable"
      ? [...definition.primaryKey, ...definition.mutableColumns]
      : definition.columns;
    let cursor = options.cursor ?? null;
    let previous = null;
    while (true) {
      const values = [];
      const where = buildRangeClause(definition, { ...options, cursor }, values);
      values.push(this.batchSize);
      const result = await this.client.query(
        "SELECT " + columns.map((column) => "snapshot_row." + quoteIdent(column)).join(", ") +
        " FROM " + quotedRelation(definition.relation) + " AS snapshot_row" + where +
        " ORDER BY " + definition.primaryKey.map((column) => "snapshot_row." + quoteIdent(column)).join(", ") +
        " LIMIT $" + values.length,
        values
      );
      if (result.rows.length > this.batchSize) fail("BATCH_BOUND_EXCEEDED", "database returned an oversized data batch");
      for (const raw of result.rows) {
        const row = projectRow(definition, raw, projection);
        const current = cursorFor(definition, row);
        if (previous && comparePrimaryKeys(definition, previous, current) >= 0) {
          fail("PRIMARY_KEY_ORDER_INVALID", "data scan was not strictly ordered for " + definition.key);
        }
        previous = current;
        yield row;
      }
      if (result.rows.length < this.batchSize) break;
      cursor = cursorFor(definition, result.rows[result.rows.length - 1]);
    }
  }

  async fetchRowsByKeys(tableKey, keys) {
    const definition = tableForKey(tableKey);
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > this.batchSize) {
      fail("KEY_FETCH_BOUND_INVALID", "key fetch must contain one bounded batch");
    }
    const values = [];
    let predicate;
    if (definition.primaryKey.length === 1) {
      const column = definition.primaryKey[0];
      values.push(keys.map((key) => bigintString(key[column], "PRIMARY_KEY_INVALID")));
      predicate = "snapshot_row." + quoteIdent(column) + " = ANY($1::bigint[])";
    } else {
      const arrays = definition.primaryKey.map((column, index) => {
        const type = definition.primaryKeyTypes[index];
        const items = keys.map((key) => type === "bigint"
          ? bigintString(key[column], "PRIMARY_KEY_INVALID")
          : String(key[column]));
        values.push(items);
        return "$" + values.length + "::" + (type === "bigint" ? "bigint" : "text") + "[]";
      });
      const columns = definition.primaryKey.map((column) => quoteIdent(column)).join(", ");
      predicate = "(" + columns + ") IN (SELECT * FROM unnest(" + arrays.join(", ") + "))";
    }
    const result = await this.client.query(
      "SELECT " + definition.columns.map((column) => "snapshot_row." + quoteIdent(column)).join(", ") +
      " FROM " + quotedRelation(definition.relation) + " AS snapshot_row WHERE " + predicate +
      " ORDER BY " + definition.primaryKey.map((column) => "snapshot_row." + quoteIdent(column)).join(", "),
      values
    );
    if (result.rows.length !== keys.length || result.rows.length > this.batchSize) {
      fail("KEY_FETCH_CARDINALITY_MISMATCH", "bounded key fetch did not return the exact source rows");
    }
    const rows = result.rows.map((row) => projectRow(definition, row, "full"));
    for (let index = 0; index < rows.length; index += 1) {
      if (comparePrimaryKeys(definition, rows[index], keys[index]) !== 0) {
        fail("KEY_FETCH_ORDER_MISMATCH", "bounded key fetch returned unexpected primary keys");
      }
    }
    return rows;
  }

  async fetchDigestEntriesByKeys(tableKey, keys) {
    const definition = tableForKey(tableKey);
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > this.batchSize) {
      fail("KEY_FETCH_BOUND_INVALID", "digest key fetch must contain one bounded batch");
    }
    const values = [];
    let predicate;
    if (definition.primaryKey.length === 1) {
      const column = definition.primaryKey[0];
      values.push(keys.map((key) => bigintString(key[column], "PRIMARY_KEY_INVALID")));
      predicate = "snapshot_row." + quoteIdent(column) + " = ANY($1::bigint[])";
    } else {
      const arrays = definition.primaryKey.map((column, index) => {
        const type = definition.primaryKeyTypes[index];
        const items = keys.map((key) => type === "bigint"
          ? bigintString(key[column], "PRIMARY_KEY_INVALID")
          : String(key[column]));
        values.push(items);
        return "$" + values.length + "::" + (type === "bigint" ? "bigint" : "text") + "[]";
      });
      const columns = definition.primaryKey.map((column) => quoteIdent(column)).join(", ");
      predicate = "(" + columns + ") IN (SELECT * FROM unnest(" + arrays.join(", ") + "))";
    }
    const immutable = immutableJsonExpression(definition);
    const select = [
      ...definition.primaryKey.map((column) => "snapshot_row." + quoteIdent(column)),
      "encode(sha256(convert_to(" + keyJsonExpression(definition) + ", 'UTF8')), 'hex') AS __key_hash",
      "encode(sha256(convert_to(" + fullJsonExpression(definition) + ", 'UTF8')), 'hex') AS __full_hash",
    ];
    if (immutable) {
      select.push("encode(sha256(convert_to(" + immutable + ", 'UTF8')), 'hex') AS __immutable_hash");
      select.push("snapshot_row." + quoteIdent("duplicate_count"));
      select.push("snapshot_row." + quoteIdent("last_duplicate_at"));
    }
    const result = await this.client.query(
      "SELECT " + select.join(", ") + " FROM " + quotedRelation(definition.relation) +
      " AS snapshot_row WHERE " + predicate + " ORDER BY " +
      definition.primaryKey.map((column) => "snapshot_row." + quoteIdent(column)).join(", "),
      values
    );
    if (result.rows.length > keys.length || result.rows.length > this.batchSize) {
      fail("BATCH_BOUND_EXCEEDED", "digest key fetch returned an oversized batch");
    }
    return result.rows.map((raw) => {
      const entry = {
        key: cursorFor(definition, raw),
        keyHash: String(raw.__key_hash),
        fullHash: String(raw.__full_hash),
        immutableHash: raw.__immutable_hash === undefined ? null : String(raw.__immutable_hash),
        mutable: definition.receipt ? projectRow(definition, raw, "receiptMutable") : null,
      };
      if (!HASH_PATTERN.test(entry.keyHash) || !HASH_PATTERN.test(entry.fullHash) ||
          (entry.immutableHash !== null && !HASH_PATTERN.test(entry.immutableHash))) {
        fail("ROW_HASH_INVALID", "database returned an invalid fetched row hash");
      }
      return Object.freeze(entry);
    });
  }

  async readIdentity() {
    const result = await this.client.query(
      "SELECT control.system_identifier::text AS system_identifier, " +
      "current_database() AS current_database, session_user AS session_user, current_user AS current_user, " +
      "role.rolsuper, role.rolbypassrls, " +
      "host(inet_server_addr()) || '/32' AS server_address, inet_server_port()::text AS server_port, " +
      "current_setting('server_version_num') AS server_version_num, " +
      "current_setting('application_name') AS application_name " +
      "FROM pg_catalog.pg_control_system() AS control " +
      "JOIN pg_catalog.pg_roles AS role ON role.rolname = current_user"
    );
    const row = result.rows[0];
    if (!row) fail("DATABASE_IDENTITY_READ_FAILED", "database identity query returned no row");
    const objectResult = await this.client.query(
      "WITH requested(name, ordinal) AS (" +
      "SELECT name, ordinal FROM unnest($1::text[]) WITH ORDINALITY AS item(name, ordinal)) " +
      "SELECT requested.name, object.oid::text AS oid, pg_get_userbyid(object.relowner) AS owner " +
      "FROM requested LEFT JOIN pg_catalog.pg_class AS object ON object.oid = to_regclass(requested.name) " +
      "ORDER BY requested.ordinal",
      [MANAGED_OBJECT_NAMES]
    );
    const objects = {};
    for (const binding of objectResult.rows) {
      objects[String(binding.name)] = Object.freeze({
        oid: binding.oid === null ? "" : String(binding.oid),
        owner: binding.owner === null ? "" : String(binding.owner),
      });
    }
    const identity = Object.freeze({
      systemIdentifier: String(row.system_identifier),
      currentDatabase: String(row.current_database),
      sessionUser: String(row.session_user),
      currentUser: String(row.current_user),
      roleSuperuser: row.rolsuper,
      roleBypassRls: row.rolbypassrls,
      serverAddress: String(row.server_address),
      serverPort: String(row.server_port),
      serverVersionNum: String(row.server_version_num),
      applicationName: String(row.application_name),
      objects: Object.freeze(objects),
    });
    validateIdentity(identity);
    return identity;
  }

  async readSession() {
    const result = await this.client.query(
      "SELECT activity.pid::text AS backend_pid, activity.backend_start " +
      "FROM pg_catalog.pg_stat_activity AS activity WHERE activity.pid = pg_backend_pid()"
    );
    const row = result.rows[0];
    if (!row) fail("SESSION_EVIDENCE_READ_FAILED", "current PostgreSQL backend was not visible");
    const session = Object.freeze({
      backendPid: String(row.backend_pid),
      backendStart: String(row.backend_start),
      transportGeneration: this.transportGeneration,
    });
    validateSessionEvidence(session);
    return session;
  }

  async readSequence(tableKey) {
    const definition = tableForKey(tableKey);
    if (!definition.sequence) return null;
    const result = await this.client.query(
      "SELECT state.last_value::text AS last_value, state.is_called, " +
      "meta.seqincrement::text AS increment_by FROM " + quotedRelation(definition.sequence) +
      " AS state JOIN pg_catalog.pg_sequence AS meta ON meta.seqrelid = $1::regclass",
      [definition.sequence]
    );
    const row = result.rows[0];
    if (!row) fail("SEQUENCE_READ_FAILED", "sequence state is missing for " + definition.key);
    const lastValue = strictBigInt(row.last_value, "SEQUENCE_VALUE_INVALID");
    const increment = strictBigInt(row.increment_by, "SEQUENCE_INCREMENT_INVALID");
    if (increment !== 1n) fail("SEQUENCE_INCREMENT_INVALID", "identity sequence increment must be 1");
    const logicalNext = row.is_called === true ? lastValue + increment : lastValue;
    return Object.freeze({ logicalNext: logicalNext.toString(), increment: increment.toString() });
  }

  async readReadiness() {
    const result = await this.client.query(
      "SELECT " +
      "(SELECT count(*) FROM ops.webhook_job WHERE status IN ('QUEUED', 'RUNNING', 'RETRY'))::text AS nonterminal_jobs, " +
      "(SELECT count(*) FROM ops.webhook_hydration_directive WHERE state = 'PENDING')::text AS pending_directives, " +
      "(SELECT count(*) FROM ops.webhook_hydration_directive WHERE state = 'RETRY')::text AS retry_directives, " +
      "(SELECT count(*) FROM ops.webhook_hydration_directive WHERE state = 'RUNNING')::text AS running_directives, " +
      "(SELECT count(*) FROM ops.webhook_hydration_directive WHERE lease_owner <> '')::text AS owned_directive_leases, " +
      "(SELECT count(*) FROM ops.webhook_hydration_directive WHERE lease_expires_at IS NOT NULL)::text AS expiring_directive_leases, " +
      "(SELECT count(*) FROM ops.webhook_hydration_directive WHERE state IN ('PENDING', 'RUNNING', 'RETRY'))::text AS nonterminal_directives, " +
      "(SELECT count(*) FROM ops.webhook_subscription_state)::text AS subscriptions, " +
      "(SELECT count(*) FROM ops.webhook_store_gate)::text AS gates"
    );
    const row = result.rows[0];
    if (!row) fail("READINESS_READ_FAILED", "readiness query returned no row");
    return Object.freeze({
      nonterminalJobs: bigintString(row.nonterminal_jobs, "READINESS_INVALID"),
      pendingDirectives: bigintString(row.pending_directives, "READINESS_INVALID"),
      retryDirectives: bigintString(row.retry_directives, "READINESS_INVALID"),
      runningDirectives: bigintString(row.running_directives, "READINESS_INVALID"),
      ownedDirectiveLeases: bigintString(row.owned_directive_leases, "READINESS_INVALID"),
      expiringDirectiveLeases: bigintString(row.expiring_directive_leases, "READINESS_INVALID"),
      nonterminalDirectives: bigintString(row.nonterminal_directives, "READINESS_INVALID"),
      subscriptions: bigintString(row.subscriptions, "READINESS_INVALID"),
      gates: bigintString(row.gates, "READINESS_INVALID"),
    });
  }

  async readTriggerStates() {
    const values = [];
    const tuples = TABLES.map((definition) => {
      const parts = definition.relation.split(".");
      values.push(parts[0], parts[1]);
      return "($" + (values.length - 1) + ", $" + values.length + ")";
    });
    const result = await this.client.query(
      "SELECT ns.nspname AS schema_name, cls.relname AS table_name, trg.tgname AS trigger_name, trg.tgenabled " +
      "FROM pg_catalog.pg_trigger AS trg " +
      "JOIN pg_catalog.pg_class AS cls ON cls.oid = trg.tgrelid " +
      "JOIN pg_catalog.pg_namespace AS ns ON ns.oid = cls.relnamespace " +
      "WHERE NOT trg.tgisinternal AND (ns.nspname, cls.relname) IN (" + tuples.join(", ") + ") " +
      "ORDER BY ns.nspname, cls.relname, trg.tgname",
      values
    );
    const states = {};
    for (const row of result.rows) {
      const key = String(row.schema_name) + "." + String(row.table_name) + "." + String(row.trigger_name);
      if (Object.hasOwn(states, key)) fail("TRIGGER_DUPLICATE", "duplicate trigger state was returned");
      states[key] = String(row.tgenabled);
    }
    return Object.freeze(states);
  }

  async setControlledTriggers(enabled) {
    for (const item of CONTROLLED_TRIGGERS) {
      await this.client.query(
        "ALTER TABLE " + quotedRelation(item.relation) + " " + (enabled ? "ENABLE" : "DISABLE") +
        " TRIGGER " + quoteIdent(item.name)
      );
    }
  }

  async validateDependencyBatch({ storeIds, probeIds }) {
    if (storeIds.length) {
      const result = await this.client.query(
        "WITH requested(id) AS (SELECT DISTINCT unnest($1::bigint[])) " +
        "SELECT count(*)::text AS missing_count FROM requested " +
        "LEFT JOIN dim.store AS target ON target.store_id = requested.id " +
        "WHERE target.store_id IS NULL",
        [storeIds]
      );
      if (result.rows[0]?.missing_count !== "0") {
        fail("EXTERNAL_STORE_DEPENDENCY_MISSING", "target is missing a referenced dim.store row");
      }
    }
    if (probeIds.length) {
      const result = await this.client.query(
        "WITH requested(id) AS (SELECT DISTINCT unnest($1::bigint[])) " +
        "SELECT count(*)::text AS missing_count FROM requested " +
        "LEFT JOIN ops.permission_probe AS target ON target.permission_probe_id = requested.id " +
        "WHERE target.permission_probe_id IS NULL",
        [probeIds]
      );
      if (result.rows[0]?.missing_count !== "0") {
        fail("EXTERNAL_PROBE_DEPENDENCY_MISSING", "target is missing a referenced ops.permission_probe row");
      }
    }
  }

  async applyOperation(operation) {
    const definition = tableForKey(operation.table);
    const row = operation.row;
    assertNoDate(row);
    if (operation.action === "insert") {
      const columns = definition.columns;
      const values = columns.map((column) => row[column]);
      const placeholders = columns.map((column, index) => {
        return "$" + (index + 1) + (definition.jsonColumns.includes(column) ? "::jsonb" : "");
      });
      const result = await this.client.query(
        "INSERT INTO " + quotedRelation(definition.relation) +
        " (" + columns.map(quoteIdent).join(", ") + ")" +
        (definition.identityColumn ? " OVERRIDING SYSTEM VALUE" : "") +
        " VALUES (" + placeholders.join(", ") + ")",
        values
      );
      if (result.rowCount !== 1) fail("INSERT_CARDINALITY_MISMATCH", "insert did not affect exactly one row for " + definition.key);
      return;
    }
    if (operation.action !== "update") fail("OPERATION_ACTION_INVALID", "unsupported operation action");
    const updateColumns = definition.receipt
      ? definition.mutableColumns
      : definition.columns.filter((column) => !definition.primaryKey.includes(column));
    const values = [];
    const assignments = updateColumns.map((column) => {
      values.push(row[column]);
      return quoteIdent(column) + " = $" + values.length + (definition.jsonColumns.includes(column) ? "::jsonb" : "");
    });
    const predicates = definition.primaryKey.map((column) => {
      values.push(row[column]);
      return quoteIdent(column) + " = $" + values.length;
    });
    const result = await this.client.query(
      "UPDATE " + quotedRelation(definition.relation) + " SET " + assignments.join(", ") +
      " WHERE " + predicates.join(" AND "),
      values
    );
    if (result.rowCount !== 1) fail("UPDATE_CARDINALITY_MISMATCH", "update did not affect exactly one row for " + definition.key);
  }

  async applyInsertBatch(tableKey, rows) {
    const definition = tableForKey(tableKey);
    if (!Array.isArray(rows)) fail("INSERT_ROWS_INVALID", "rows must be an array");
    if (rows.length === 0) return;
    for (const row of rows) {
      assertNoDate(row);
    }
    const columns = definition.columns;
    const maxRowsByParams = Math.floor(this.maxInsertParameters / columns.length);
    if (maxRowsByParams < 1) {
      fail("BATCH_SIZE_INVALID", "table column count exceeds maximum insert parameter capacity");
    }
    const chunkLimit = Math.min(this.batchSize, maxRowsByParams);
    for (let offset = 0; offset < rows.length; offset += chunkLimit) {
      const chunk = rows.slice(offset, offset + chunkLimit);
      const values = [];
      const valueTuples = [];
      for (const row of chunk) {
        const itemPlaceholders = [];
        for (const column of columns) {
          values.push(row[column]);
          itemPlaceholders.push("$" + values.length + (definition.jsonColumns.includes(column) ? "::jsonb" : ""));
        }
        valueTuples.push("(" + itemPlaceholders.join(", ") + ")");
      }
      const sql = "INSERT INTO " + quotedRelation(definition.relation) +
        " (" + columns.map(quoteIdent).join(", ") + ")" +
        (definition.identityColumn ? " OVERRIDING SYSTEM VALUE" : "") +
        " VALUES " + valueTuples.join(", ");
      const result = await this.client.query(sql, values);
      if (result.rowCount !== chunk.length) {
        fail("INSERT_CARDINALITY_MISMATCH", "insert batch did not affect expected rows for " + definition.key);
      }
    }
  }

  async restartSequence(tableKey, logicalNext) {
    const definition = tableForKey(tableKey);
    if (!definition.sequence) fail("SEQUENCE_RESTART_INVALID", "table has no managed sequence");
    const restart = bigintString(logicalNext, "SEQUENCE_RESTART_INVALID");
    await this.client.query("ALTER SEQUENCE " + quotedRelation(definition.sequence) + " RESTART WITH " + restart);
  }

  async commit() {
    if (!this.inTransaction) return;
    await this.client.query("COMMIT");
    this.inTransaction = false;
  }

  async rollback() {
    if (!this.client || !this.inTransaction) return;
    await this.client.query("ROLLBACK");
    this.inTransaction = false;
  }

  release({ destroy = false } = {}) {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.inTransaction = false;
    this.transportGeneration = null;
    client.release(destroy ? new Error("discard uncertain cutover connection") : undefined);
  }
}

function defaultEndpointFactory(pool, role, options) {
  return new PgEndpoint(pool, role, options);
}

async function digestTable(endpoint, definition, range = {}) {
  const full = createHash("sha256");
  const keys = createHash("sha256");
  const immutable = definition.receipt ? createHash("sha256") : null;
  let rowCount = 0n;
  let maxId = null;
  for await (const entry of endpoint.scanDigestEntries(definition.key, range)) {
    hashFrame(full, entry.fullHash);
    hashFrame(keys, entry.keyHash);
    if (immutable) {
      if (!entry.immutableHash) fail("IMMUTABLE_HASH_MISSING", "receipt immutable hash is missing");
      hashFrame(immutable, entry.immutableHash);
    }
    rowCount += 1n;
    if (definition.identityColumn) {
      maxId = bigintString(entry.key[definition.identityColumn], "PRIMARY_KEY_INVALID");
    }
  }
  const result = {
    rowCount: rowCount.toString(),
    fullDigest: full.digest("hex"),
    keyDigest: keys.digest("hex"),
    maxId,
  };
  if (immutable) result.immutableDigest = immutable.digest("hex");
  return Object.freeze(result);
}

export async function snapshotEndpoint(endpoint, { testDatabaseNames = null } = {}) {
  const identity = await endpoint.readIdentity();
  const session = await endpoint.readSession();
  assertOperationalIdentity({ identity }, endpoint.role, testDatabaseNames);
  const tables = {};
  for (const definition of TABLES) {
    tables[definition.key] = await digestTable(endpoint, definition);
  }
  const sequences = {};
  for (const definition of SEQUENCE_TABLES) {
    sequences[definition.key] = await endpoint.readSequence(definition.key);
  }
  const snapshot = {
    identity,
    session,
    tables: Object.freeze(tables),
    sequences: Object.freeze(sequences),
    readiness: await endpoint.readReadiness(),
    triggers: await endpoint.readTriggerStates(),
  };
  validateSnapshot(snapshot);
  return Object.freeze(snapshot);
}

function validateDigestRecord(definition, record) {
  if (!record || typeof record !== "object") fail("SNAPSHOT_TABLE_INVALID", "table digest is missing for " + definition.key);
  const rowCount = strictBigInt(record.rowCount, "SNAPSHOT_COUNT_INVALID");
  if (rowCount < 0n) fail("SNAPSHOT_COUNT_INVALID", "table count cannot be negative");
  if (!HASH_PATTERN.test(String(record.fullDigest)) || !HASH_PATTERN.test(String(record.keyDigest))) {
    fail("SNAPSHOT_HASH_INVALID", "table digest is invalid for " + definition.key);
  }
  if (definition.receipt && !HASH_PATTERN.test(String(record.immutableDigest))) {
    fail("SNAPSHOT_HASH_INVALID", "receipt immutable digest is invalid");
  }
  if (definition.identityColumn) {
    if (rowCount === 0n && record.maxId !== null) fail("SNAPSHOT_MAX_ID_INVALID", "empty identity table has a max id");
    if (rowCount > 0n && record.maxId === null) fail("SNAPSHOT_MAX_ID_INVALID", "non-empty identity table lacks a max id");
    if (record.maxId !== null) strictBigInt(record.maxId, "SNAPSHOT_MAX_ID_INVALID");
  } else if (record.maxId !== null) {
    fail("SNAPSHOT_MAX_ID_INVALID", "non-identity table cannot have max id");
  }
}

function assertExactKeys(value, expected, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, label + " is missing");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) fail(code, label + " keys differ from the contract");
}

function validateReadinessCounts(readiness, code) {
  for (const key of READINESS_KEYS) {
    const value = strictBigInt(readiness[key], code);
    if (value < 0n) fail(code, "readiness count cannot be negative");
  }
  if (strictBigInt(readiness.nonterminalDirectives, code) !==
      strictBigInt(readiness.pendingDirectives, code) +
      strictBigInt(readiness.retryDirectives, code) +
      strictBigInt(readiness.runningDirectives, code)) {
    fail(code, "nonterminalDirectives must equal pending, retry, and running directive counts");
  }
}

function assertExpectedTriggers(states, { controlledEnabled = true } = {}) {
  const expectedKeys = MANAGED_TRIGGERS.map(triggerKey);
  assertExactKeys(states, expectedKeys, "TRIGGER_CONTRACT_DRIFT", "managed triggers");
  for (const item of MANAGED_TRIGGERS) {
    const expected = item.controlled && !controlledEnabled ? "D" : "O";
    if (states[triggerKey(item)] !== expected) {
      fail("TRIGGER_STATE_INVALID", "managed trigger is not in the expected state");
    }
  }
}

function validateSequenceAgainstTable(definition, sequence, tableDigest) {
  if (!sequence || typeof sequence !== "object") fail("SEQUENCE_STATE_INVALID", "sequence state is missing for " + definition.key);
  const logicalNext = strictBigInt(sequence.logicalNext, "SEQUENCE_LOGICAL_NEXT_INVALID");
  const increment = strictBigInt(sequence.increment, "SEQUENCE_INCREMENT_INVALID");
  if (increment !== 1n) fail("SEQUENCE_INCREMENT_INVALID", "identity sequence increment must be 1");
  if (tableDigest.maxId !== null && logicalNext <= strictBigInt(tableDigest.maxId, "SNAPSHOT_MAX_ID_INVALID")) {
    fail("SEQUENCE_COLLISION_RISK", "sequence logical next does not exceed table max id for " + definition.key);
  }
}

function validateSnapshot(snapshot) {
  validateIdentity(snapshot?.identity);
  validateSessionEvidence(snapshot?.session);
  assertExactKeys(snapshot?.tables, TABLES.map((item) => item.key), "SNAPSHOT_TABLE_SET_INVALID", "snapshot tables");
  assertExactKeys(snapshot?.sequences, SEQUENCE_TABLES.map((item) => item.key), "SNAPSHOT_SEQUENCE_SET_INVALID", "snapshot sequences");
  for (const definition of TABLES) validateDigestRecord(definition, snapshot.tables[definition.key]);
  for (const definition of SEQUENCE_TABLES) {
    validateSequenceAgainstTable(definition, snapshot.sequences[definition.key], snapshot.tables[definition.key]);
  }
  const readiness = snapshot.readiness;
  assertExactKeys(readiness, READINESS_KEYS, "READINESS_INVALID", "snapshot readiness");
  validateReadinessCounts(readiness, "READINESS_INVALID");
  assertExpectedTriggers(snapshot.triggers);
}

function snapshotCore(snapshot) {
  return {
    tables: snapshot.tables,
    sequences: snapshot.sequences,
    readiness: snapshot.readiness,
    triggers: snapshot.triggers,
  };
}

function snapshotIdentityEqual(left, right) {
  return canonicalJson(left.identity) === canonicalJson(right.identity);
}

function snapshotsEqual(left, right) {
  return canonicalJson(snapshotCore(left)) === canonicalJson(snapshotCore(right));
}

function assertSnapshotsEqual(left, right, code, message) {
  if (!snapshotsEqual(left, right)) fail(code, message);
}

function assertQuiescent(snapshot, phase) {
  const readiness = snapshot.readiness;
  if (readiness.nonterminalJobs !== "0" || readiness.runningDirectives !== "0" ||
      readiness.ownedDirectiveLeases !== "0" || readiness.expiringDirectiveLeases !== "0") {
    fail("NONTERMINAL_WEBHOOK_WORK", phase + " found nonterminal webhook work");
  }
}

function baselineCore(baseline) {
  return {
    schemaVersion: baseline.schemaVersion,
    kind: baseline.kind,
    planVersion: baseline.planVersion,
    sourceIdentity: baseline.sourceIdentity,
    targetIdentity: baseline.targetIdentity,
    tables: baseline.tables,
    sequences: baseline.sequences,
    readiness: baseline.readiness,
    triggers: baseline.triggers,
  };
}

function baselineFingerprint(baseline) {
  return sha256(canonicalJson(baselineCore(baseline)));
}

function snapshotFingerprint(snapshot) {
  return sha256(canonicalJson({ identity: snapshot.identity, data: snapshotCore(snapshot) }));
}

function validateBaseline(baseline) {
  if (!baseline || typeof baseline !== "object" ||
      baseline.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
      baseline.kind !== "fnos-webhook-cutover-forward" ||
      baseline.planVersion !== PLAN_VERSION) {
    fail("BASELINE_INVALID", "forward baseline kind, schema, or plan version is invalid");
  }
  validateIdentity(baseline.sourceIdentity);
  validateIdentity(baseline.targetIdentity);
  if (baseline.sourceIdentity.systemIdentifier === baseline.targetIdentity.systemIdentifier) {
    fail("BASELINE_ENDPOINT_COLLISION", "forward baseline source and target must be different PostgreSQL systems");
  }
  assertExactKeys(baseline.tables, TABLES.map((item) => item.key), "BASELINE_TABLE_SET_INVALID", "baseline tables");
  assertExactKeys(baseline.sequences, SEQUENCE_TABLES.map((item) => item.key), "BASELINE_SEQUENCE_SET_INVALID", "baseline sequences");
  for (const definition of TABLES) validateDigestRecord(definition, baseline.tables[definition.key]);
  for (const definition of SEQUENCE_TABLES) {
    validateSequenceAgainstTable(definition, baseline.sequences[definition.key], baseline.tables[definition.key]);
  }
  if (baseline.tables.subscription.rowCount !== "0" || baseline.tables.gate.rowCount !== "0") {
    fail("BASELINE_SIDE_TABLE_NOT_EMPTY", "forward baseline subscription and gate must both be empty");
  }
  const readiness = baseline.readiness;
  assertExactKeys(readiness, READINESS_KEYS, "BASELINE_READINESS_INVALID", "baseline readiness");
  validateReadinessCounts(readiness, "BASELINE_READINESS_INVALID");
  if (readiness.nonterminalJobs !== "0" ||
      readiness.runningDirectives !== "0" ||
      readiness.ownedDirectiveLeases !== "0" ||
      readiness.expiringDirectiveLeases !== "0" ||
      readiness.subscriptions !== "0" || readiness.gates !== "0") {
    fail("BASELINE_READINESS_INVALID", "forward baseline readiness is invalid");
  }
  assertExpectedTriggers(baseline.triggers);
  const expectedFingerprint = baselineFingerprint(baseline);
  if (baseline.baselineFingerprint !== expectedFingerprint) {
    fail("BASELINE_FINGERPRINT_INVALID", "forward baseline fingerprint does not match its contents");
  }
}

function snapshotMatchesBaseline(snapshot, baseline) {
  return canonicalJson(snapshot.tables) === canonicalJson(baseline.tables) &&
    canonicalJson(snapshot.sequences) === canonicalJson(baseline.sequences) &&
    canonicalJson(snapshot.readiness) === canonicalJson(baseline.readiness) &&
    canonicalJson(snapshot.triggers) === canonicalJson(baseline.triggers);
}

function buildForwardManifest(sourceSnapshot, targetSnapshot) {
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: "fnos-webhook-cutover-forward",
    planVersion: PLAN_VERSION,
    generatedAt: new Date().toISOString(),
    sourceIdentity: sourceSnapshot.identity,
    targetIdentity: targetSnapshot.identity,
    tables: sourceSnapshot.tables,
    sequences: sourceSnapshot.sequences,
    readiness: sourceSnapshot.readiness,
    triggers: sourceSnapshot.triggers,
  };
  manifest.baselineFingerprint = baselineFingerprint(manifest);
  return Object.freeze(manifest);
}

async function safeRollback(endpoint) {
  if (!endpoint) return null;
  try {
    await endpoint.rollback();
    return null;
  } catch (error) {
    return error;
  }
}

function safeRelease(endpoint, destroy = false) {
  if (!endpoint) return;
  try {
    endpoint.release({ destroy });
  } catch {
    // Releasing a client is best effort; transaction outcome is handled separately.
  }
}

async function beginPair({ sourcePool, targetPool, endpointFactory, batchSize }) {
  const source = endpointFactory(sourcePool, "source", { batchSize });
  const target = endpointFactory(targetPool, "target", { batchSize });
  await source.beginFrozen();
  try {
    await target.beginFrozen();
  } catch (error) {
    await safeRollback(source);
    safeRelease(source, true);
    throw error;
  }
  return { source, target };
}

export async function runIdentityInspection({
  sourcePool,
  targetPool,
  endpointFactory = defaultEndpointFactory,
  batchSize = DEFAULT_BATCH_SIZE,
  testDatabaseNames = null,
}) {
  if (!sourcePool || !targetPool) fail("POOL_INVALID", "source and target pools are required");
  const size = parseBatchSize(batchSize);
  let pair;
  try {
    pair = await beginPair({ sourcePool, targetPool, endpointFactory, batchSize: size });
    const sourceIdentity = await pair.source.readIdentity();
    const targetIdentity = await pair.target.readIdentity();
    const sourceSession = await pair.source.readSession();
    const targetSession = await pair.target.readSession();
    assertOperationalIdentity({ identity: sourceIdentity }, "source", testDatabaseNames);
    assertOperationalIdentity({ identity: targetIdentity }, "target", testDatabaseNames);
    const source = { identity: sourceIdentity };
    const target = { identity: targetIdentity };
    assertDistinctDatabaseSystems(source, target, "identity inspection");
    const sourceRollback = await safeRollback(pair.source);
    const targetRollback = await safeRollback(pair.target);
    if (sourceRollback || targetRollback) fail("IDENTITY_INSPECTION_RELEASE_FAILED", "identity inspection could not release both snapshots");
    safeRelease(pair.source);
    safeRelease(pair.target);
    pair = null;
    return Object.freeze({
      ok: true,
      operation: "inspect-identities",
      source: Object.freeze({
        identity: sourceIdentity,
        identityFingerprint: identityFingerprint(sourceIdentity),
        session: sourceSession,
      }),
      target: Object.freeze({
        identity: targetIdentity,
        identityFingerprint: identityFingerprint(targetIdentity),
        session: targetSession,
      }),
    });
  } catch (error) {
    if (pair) {
      const sourceRollback = await safeRollback(pair.source);
      const targetRollback = await safeRollback(pair.target);
      safeRelease(pair.source, Boolean(sourceRollback));
      safeRelease(pair.target, Boolean(targetRollback));
    }
    throw error;
  }
}

export async function runForward({
  sourcePool,
  targetPool,
  endpointFactory = defaultEndpointFactory,
  batchSize = DEFAULT_BATCH_SIZE,
  testDatabaseNames = null,
  onProgress = null,
}) {
  if (!sourcePool || !targetPool) fail("POOL_INVALID", "source and target pools are required");
  const size = parseBatchSize(batchSize);
  let pair;
  try {
    pair = await beginPair({ sourcePool, targetPool, endpointFactory, batchSize: size });
    const sourceSnapshot = await snapshotEndpoint(pair.source, { testDatabaseNames });
    const targetSnapshot = await snapshotEndpoint(pair.target, { testDatabaseNames });
    assertQuiescent(sourceSnapshot, "forward source");
    assertQuiescent(targetSnapshot, "forward target");
    if (sourceSnapshot.readiness.subscriptions !== "0" || sourceSnapshot.readiness.gates !== "0") {
      fail("FORWARD_SIDE_TABLE_NOT_EMPTY", "source subscription and gate must both be empty before cutover");
    }
    if (sourceSnapshot.identity.systemIdentifier === targetSnapshot.identity.systemIdentifier) {
      fail("ENDPOINT_SYSTEM_COLLISION", "forward source and target resolve to the same PostgreSQL system");
    }
    assertSnapshotsEqual(
      sourceSnapshot,
      targetSnapshot,
      "FORWARD_SNAPSHOT_MISMATCH",
      "forward source and target tables, sequences, readiness, or triggers differ"
    );
    const manifest = buildForwardManifest(sourceSnapshot, targetSnapshot);
    const sourceRollback = await safeRollback(pair.source);
    const targetRollback = await safeRollback(pair.target);
    if (sourceRollback || targetRollback) fail("FORWARD_RELEASE_FAILED", "forward read transaction could not be released cleanly");
    safeRelease(pair.source);
    safeRelease(pair.target);
    pair = null;
    return manifest;
  } catch (error) {
    if (pair) {
      const sourceRollback = await safeRollback(pair.source);
      const targetRollback = await safeRollback(pair.target);
      safeRelease(pair.source, Boolean(sourceRollback));
      safeRelease(pair.target, Boolean(targetRollback));
    }
    throw error;
  }
}

async function validateSourceBaselinePrefixes(sourceEndpoint, sourceSnapshot, baseline) {
  for (const definition of TABLES) {
    const expected = baseline.tables[definition.key];
    if (!definition.identityColumn) {
      if (expected.rowCount !== "0") fail("BASELINE_NONIDENTITY_UNSUPPORTED", "non-empty non-identity baseline is unsupported");
      continue;
    }
    if (expected.maxId === null) {
      if (expected.rowCount !== "0") fail("BASELINE_MAX_ID_INVALID", "baseline count and max id disagree");
      continue;
    }
    const prefix = await digestTable(sourceEndpoint, definition, { maxInclusive: expected.maxId });
    if (prefix.rowCount !== expected.rowCount || prefix.keyDigest !== expected.keyDigest) {
      fail("SOURCE_BASELINE_KEY_DRIFT", "source deleted, rekeyed, or inserted a low-key row in " + definition.key);
    }
    if (definition.receipt && prefix.immutableDigest !== expected.immutableDigest) {
      fail("RECEIPT_IMMUTABLE_DRIFT", "source receipt immutable baseline fields changed");
    }
    if (definition.appendOnly && prefix.fullDigest !== expected.fullDigest) {
      fail("APPEND_ONLY_MUTATION", "source heartbeat baseline prefix changed");
    }
    if (sourceSnapshot.tables[definition.key].maxId !== null &&
        strictBigInt(sourceSnapshot.tables[definition.key].maxId) < strictBigInt(expected.maxId)) {
      fail("SOURCE_MAX_ID_REGRESSION", "source max id regressed for " + definition.key);
    }
  }
}

function timestampText(value, code) {
  if (value === null) return null;
  if (value instanceof Date) fail("DATE_PRECISION_LOSS", "Date objects are forbidden for timestamp comparison");
  const text = String(value);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/.test(text)) {
    fail(code, "timestamp text is not in the fixed PostgreSQL format");
  }
  return text.replace("T", " ");
}

function receiptUpdateNeeded(sourceRow, targetRow) {
  const sourceCount = strictBigInt(sourceRow.duplicate_count, "RECEIPT_DUPLICATE_COUNT_INVALID");
  const targetCount = strictBigInt(targetRow.duplicate_count, "RECEIPT_DUPLICATE_COUNT_INVALID");
  if (sourceCount < targetCount) fail("RECEIPT_DUPLICATE_COUNT_REGRESSION", "receipt duplicate count decreased on source");
  const sourceTimestamp = timestampText(sourceRow.last_duplicate_at, "RECEIPT_DUPLICATE_TIMESTAMP_INVALID");
  const targetTimestamp = timestampText(targetRow.last_duplicate_at, "RECEIPT_DUPLICATE_TIMESTAMP_INVALID");
  if (targetTimestamp !== null && (sourceTimestamp === null || sourceTimestamp < targetTimestamp)) {
    fail("RECEIPT_DUPLICATE_TIMESTAMP_REGRESSION", "receipt duplicate timestamp regressed on source");
  }
  return sourceCount !== targetCount || sourceTimestamp !== targetTimestamp;
}

async function nextValue(iterator) {
  const result = await iterator.next();
  return result.done ? null : result.value;
}

async function streamBaselineUpdates(sourceEndpoint, targetEndpoint, definition, baselineTable, emit) {
  if (baselineTable.rowCount === "0") return;
  if (!definition.identityColumn || baselineTable.maxId === null) {
    fail("BASELINE_RANGE_INVALID", "baseline range is not representable for " + definition.key);
  }
  if (definition.appendOnly) return;
  const projection = definition.receipt ? "receiptMutable" : "full";
  const sourceIterator = sourceEndpoint.scanRows(definition.key, {
    maxInclusive: baselineTable.maxId,
    projection,
  })[Symbol.asyncIterator]();
  const targetIterator = targetEndpoint.scanRows(definition.key, {
    maxInclusive: baselineTable.maxId,
    projection,
  })[Symbol.asyncIterator]();
  let sourceRow = await nextValue(sourceIterator);
  let targetRow = await nextValue(targetIterator);
  while (sourceRow !== null || targetRow !== null) {
    if (sourceRow === null || targetRow === null) {
      fail("BASELINE_CARDINALITY_DRIFT", "baseline row count differs during merge for " + definition.key);
    }
    const comparison = comparePrimaryKeys(definition, sourceRow, targetRow);
    if (comparison !== 0) fail("BASELINE_KEY_DRIFT", "baseline primary keys differ during merge for " + definition.key);
    let changed;
    if (definition.receipt) changed = receiptUpdateNeeded(sourceRow, targetRow);
    else changed = canonicalJson(sourceRow) !== canonicalJson(targetRow);
    if (changed) await emit(Object.freeze({ table: definition.key, action: "update", row: sourceRow }));
    sourceRow = await nextValue(sourceIterator);
    targetRow = await nextValue(targetIterator);
  }
}

async function streamNewRows(sourceEndpoint, definition, baselineTable, emit) {
  const options = { projection: "full" };
  if (definition.identityColumn && baselineTable.maxId !== null) options.minExclusive = baselineTable.maxId;
  for await (const row of sourceEndpoint.scanRows(definition.key, options)) {
    await emit(Object.freeze({ table: definition.key, action: "insert", row }));
  }
}

async function streamOperations({ sourceEndpoint, targetEndpoint, baseline, emit }) {
  for (const key of APPLY_ORDER) {
    const definition = tableForKey(key);
    const baselineTable = baseline.tables[key];
    await streamBaselineUpdates(sourceEndpoint, targetEndpoint, definition, baselineTable, emit);
    await streamNewRows(sourceEndpoint, definition, baselineTable, emit);
  }
}

export class PlanAccumulator {
  constructor({ mode, baseline = null, sourceSnapshot, targetSnapshot, targetState }) {
    this.hash = createHash("sha256");
    this.counts = Object.fromEntries(TABLES.map((definition) => [definition.key, { inserted: 0n, updated: 0n }]));
    hashFrame(this.hash, {
      planVersion: PLAN_VERSION,
      mode,
      baselineFingerprint: baseline?.baselineFingerprint ?? null,
      sourceFingerprint: snapshotFingerprint(sourceSnapshot),
      targetFingerprint: snapshotFingerprint(targetSnapshot),
      targetState,
      applyOrder: APPLY_ORDER,
    });
  }

  add(operation) {
    const definition = tableForKey(operation.table);
    if (operation.action !== "insert" && operation.action !== "update") {
      fail("OPERATION_ACTION_INVALID", "unsupported plan action");
    }
    const row = projectRow(
      definition,
      operation.row,
      definition.receipt && operation.action === "update" ? "receiptMutable" : "full"
    );
    const key = definition.primaryKey.map((column) => row[column]);
    hashFrame(this.hash, {
      table: definition.key,
      action: operation.action,
      key,
      sourceRowFingerprint: sha256(canonicalJson(row)),
    });
    if (operation.action === "insert") this.counts[definition.key].inserted += 1n;
    else this.counts[definition.key].updated += 1n;
  }

  finish() {
    const counts = {};
    for (const definition of TABLES) {
      counts[definition.key] = Object.freeze({
        inserted: this.counts[definition.key].inserted.toString(),
        updated: this.counts[definition.key].updated.toString(),
      });
    }
    return Object.freeze({ planHash: this.hash.digest("hex"), counts: Object.freeze(counts) });
  }
}

class DependencyAccumulator {
  constructor(targetEndpoint, batchSize) {
    this.targetEndpoint = targetEndpoint;
    this.batchSize = batchSize;
    this.storeIds = new Set();
    this.probeIds = new Set();
  }

  async add(operation) {
    const definition = tableForKey(operation.table);
    for (const reference of definition.externalReferences) {
      const value = operation.row[reference.column];
      if (value === null || value === undefined) continue;
      const normalized = bigintString(value, "EXTERNAL_DEPENDENCY_ID_INVALID");
      if (reference.relation === "dim.store") this.storeIds.add(normalized);
      else if (reference.relation === "ops.permission_probe") this.probeIds.add(normalized);
    }
    if (this.storeIds.size + this.probeIds.size >= this.batchSize) await this.flush();
  }

  async flush() {
    if (!this.storeIds.size && !this.probeIds.size) return;
    await this.targetEndpoint.validateDependencyBatch({
      storeIds: [...this.storeIds],
      probeIds: [...this.probeIds],
    });
    this.storeIds.clear();
    this.probeIds.clear();
  }
}

async function calculatePlan({
  sourceEndpoint,
  targetEndpoint,
  baseline,
  sourceSnapshot,
  targetSnapshot,
  batchSize,
  targetState,
}) {
  const accumulator = new PlanAccumulator({
    mode: "reverse",
    baseline,
    sourceSnapshot,
    targetSnapshot,
    targetState,
  });
  const dependencies = new DependencyAccumulator(targetEndpoint, batchSize);
  await streamOperations({
    sourceEndpoint,
    targetEndpoint,
    baseline,
    emit: async (operation) => {
      accumulator.add(operation);
      await dependencies.add(operation);
    },
  });
  await dependencies.flush();
  return accumulator.finish();
}

async function applyPlan({
  sourceEndpoint,
  targetEndpoint,
  baseline,
  sourceSnapshot,
  targetSnapshot,
  targetState,
}) {
  const accumulator = new PlanAccumulator({
    mode: "reverse",
    baseline,
    sourceSnapshot,
    targetSnapshot,
    targetState,
  });
  await streamOperations({
    sourceEndpoint,
    targetEndpoint,
    baseline,
    emit: async (operation) => {
      accumulator.add(operation);
      await targetEndpoint.applyOperation(operation);
    },
  });
  return accumulator.finish();
}

async function flushPreparedKeys(sourceEndpoint, definition, pending, emit) {
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

export class InsertSpool {
  constructor(tableKey) {
    this.tableKey = tableKey;
    this.tempDir = null;
    this.filePath = null;
    this.fileHandle = null;
    this.count = 0;
  }

  async init() {
    this.tempDir = await mkdtemp(joinPath(tmpdir(), "cutover-spool-"), { mode: 0o700 });
    await chmod(this.tempDir, 0o700);
    this.filePath = joinPath(this.tempDir, `inserts_${this.tableKey}.jsonl`);
    this.fileHandle = await open(this.filePath, "w", 0o600);
    await chmod(this.filePath, 0o600);
  }

  async append(key) {
    if (!this.fileHandle) {
      await this.init();
    }
    await this.fileHandle.writeFile(canonicalJson(key) + "\n", "utf8");
    this.count += 1;
  }

  async closeWrite() {
    if (this.fileHandle) {
      await this.fileHandle.close();
      this.fileHandle = null;
    }
  }

  async *readBatches(batchSize) {
    await this.closeWrite();
    if (!this.filePath || this.count === 0) return;
    const fileStream = createReadStream(this.filePath, { encoding: "utf8" });
    const lineReader = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });
    let readCount = 0;
    let currentBatch = [];
    try {
      for await (const line of lineReader) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let key;
        try {
          key = JSON.parse(trimmed);
        } catch (err) {
          fail("SPOOL_CORRUPT", "corrupt JSON entry in spool file for " + this.tableKey, { cause: err });
        }
        currentBatch.push(key);
        readCount += 1;
        if (currentBatch.length >= batchSize) {
          yield currentBatch;
          currentBatch = [];
        }
      }
      if (currentBatch.length) {
        yield currentBatch;
      }
    } finally {
      lineReader.close();
      fileStream.destroy();
      if (!fileStream.closed) {
        try {
          await once(fileStream, "close");
        } catch {}
      }
    }
    if (readCount !== this.count) {
      fail("SPOOL_COUNT_MISMATCH", `spool readback count mismatch for ${this.tableKey}: expected ${this.count}, read ${readCount}`);
    }
  }

  async cleanup() {
    let firstError = null;
    if (this.fileHandle) {
      try {
        await this.fileHandle.close();
      } catch (err) {
        if (!firstError) firstError = err;
      }
      this.fileHandle = null;
    }
    if (this.filePath) {
      try {
        await unlink(this.filePath);
      } catch (err) {
        if (err.code !== "ENOENT" && !firstError) firstError = err;
      }
      this.filePath = null;
    }
    if (this.tempDir) {
      try {
        await rmdir(this.tempDir);
      } catch (err) {
        if (err.code !== "ENOENT" && !firstError) firstError = err;
      }
      this.tempDir = null;
    }
    if (firstError) {
      fail("SPOOL_CLEANUP_FAILED", "failed to clean up spool file/directory for " + this.tableKey, { cause: firstError });
    }
  }
}

async function streamPrepareSinglePass({
  sourceEndpoint,
  targetEndpoint,
  batchSize,
  definition,
  emit,
}) {
  const key = definition.key;
  const sourceIterator = sourceEndpoint.scanDigestEntries(key)[Symbol.asyncIterator]();
  const targetIterator = targetEndpoint.scanDigestEntries(key)[Symbol.asyncIterator]();
  const updatePending = [];
  const insertSpool = new InsertSpool(key);
  try {
    let sourceEntry = await nextValue(sourceIterator);
    let targetEntry = await nextValue(targetIterator);
    while (sourceEntry !== null || targetEntry !== null) {
      if (sourceEntry === null) {
        fail("PREPARE_TARGET_ONLY_KEY", "prepare-forward target contains a key absent from source in " + key);
      }
      if (targetEntry === null) {
        await insertSpool.append(sourceEntry.key);
        sourceEntry = await nextValue(sourceIterator);
        continue;
      }
      const comparison = comparePrimaryKeys(definition, sourceEntry.key, targetEntry.key);
      if (comparison < 0) {
        await insertSpool.append(sourceEntry.key);
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
        if (receiptUpdateNeeded(sourceEntry.mutable, targetEntry.mutable)) {
          await emit(Object.freeze({
            table: definition.key,
            action: "update",
            row: sourceEntry.mutable,
          }));
        }
      } else if (sourceEntry.fullHash !== targetEntry.fullHash) {
        updatePending.push({ action: "update", key: sourceEntry.key });
        if (updatePending.length >= batchSize) {
          await flushPreparedKeys(sourceEndpoint, definition, updatePending, emit);
        }
      }
      sourceEntry = await nextValue(sourceIterator);
      targetEntry = await nextValue(targetIterator);
    }
    await flushPreparedKeys(sourceEndpoint, definition, updatePending, emit);

    for await (const batchKeys of insertSpool.readBatches(batchSize)) {
      const pendingInserts = batchKeys.map((k) => ({ action: "insert", key: k }));
      await flushPreparedKeys(sourceEndpoint, definition, pendingInserts, emit);
    }
  } finally {
    await insertSpool.cleanup();
  }
}

export async function streamPrepareOperations({ sourceEndpoint, targetEndpoint, batchSize, emit }) {
  for (const key of APPLY_ORDER) {
    const definition = tableForKey(key);
    await streamPrepareSinglePass({
      sourceEndpoint,
      targetEndpoint,
      batchSize,
      definition,
      emit,
    });
  }
}

async function calculatePreparePlan({
  sourceEndpoint,
  targetEndpoint,
  sourceSnapshot,
  targetSnapshot,
  batchSize,
}) {
  const accumulator = new PlanAccumulator({
    mode: "prepare-forward",
    sourceSnapshot,
    targetSnapshot,
    targetState: "safe_subset",
  });
  const dependencies = new DependencyAccumulator(targetEndpoint, batchSize);
  await streamPrepareOperations({
    sourceEndpoint,
    targetEndpoint,
    batchSize,
    emit: async (operation) => {
      accumulator.add(operation);
      await dependencies.add(operation);
    },
  });
  await dependencies.flush();
  return accumulator.finish();
}

function classifyPrepareOperation(definition, sourceEntry, targetEntry) {
  if (!targetEntry) return "insert";
  if (definition.appendOnly) {
    if (sourceEntry.fullHash !== targetEntry.fullHash) {
      fail("APPEND_ONLY_MUTATION", "heartbeat changed between prepare planning and apply");
    }
    return null;
  }
  if (definition.receipt) {
    if (sourceEntry.immutableHash !== targetEntry.immutableHash) {
      fail("RECEIPT_IMMUTABLE_DRIFT", "receipt immutable fields changed during prepare apply");
    }
    return receiptUpdateNeeded(sourceEntry.mutable, targetEntry.mutable) ? "update" : null;
  }
  return sourceEntry.fullHash === targetEntry.fullHash ? null : "update";
}

export async function applyPrepareBatch({ sourceEndpoint, targetEndpoint, definition, sourceEntries }) {
  const keys = sourceEntries.map((entry) => entry.key);
  const targetEntries = await targetEndpoint.fetchDigestEntriesByKeys(definition.key, keys);
  const targetByKey = new Map(targetEntries.map((entry) => [primaryKeyToken(definition.key, entry.key), entry]));
  const descriptors = [];
  const fullRowKeys = [];
  for (const sourceEntry of sourceEntries) {
    const token = primaryKeyToken(definition.key, sourceEntry.key);
    const action = classifyPrepareOperation(definition, sourceEntry, targetByKey.get(token));
    if (!action) continue;
    const descriptor = { action, key: sourceEntry.key, row: null };
    if (definition.receipt && action === "update") descriptor.row = sourceEntry.mutable;
    else fullRowKeys.push(sourceEntry.key);
    descriptors.push(descriptor);
  }
  if (fullRowKeys.length) {
    const fullRows = await sourceEndpoint.fetchRowsByKeys(definition.key, fullRowKeys);
    const rowsByKey = new Map(fullRows.map((row) => [primaryKeyToken(definition.key, row), row]));
    for (const descriptor of descriptors) {
      if (!descriptor.row) descriptor.row = rowsByKey.get(primaryKeyToken(definition.key, descriptor.key));
      if (!descriptor.row) fail("SOURCE_ROW_MISSING_DURING_APPLY", "source row vanished during prepare apply");
    }
  }
  const flushInserts = async (insertRows) => {
    if (insertRows.length === 0) return;
    if (typeof targetEndpoint.applyInsertBatch === "function") {
      await targetEndpoint.applyInsertBatch(definition.key, insertRows);
    } else {
      for (const row of insertRows) {
        await targetEndpoint.applyOperation(Object.freeze({
          table: definition.key,
          action: "insert",
          row,
        }));
      }
    }
    insertRows.length = 0;
  };
  const pendingInserts = [];
  for (const descriptor of descriptors) {
    if (descriptor.action === "insert") {
      pendingInserts.push(descriptor.row);
    } else {
      await flushInserts(pendingInserts);
      await targetEndpoint.applyOperation(Object.freeze({
        table: definition.key,
        action: descriptor.action,
        row: descriptor.row,
      }));
    }
  }
  await flushInserts(pendingInserts);
}

async function applyPrepareConvergence({ sourceEndpoint, targetEndpoint, batchSize }) {
  for (const key of APPLY_ORDER) {
    const definition = tableForKey(key);
    let sourceEntries = [];
    for await (const entry of sourceEndpoint.scanDigestEntries(key)) {
      sourceEntries.push(entry);
      if (sourceEntries.length === batchSize) {
        await applyPrepareBatch({ sourceEndpoint, targetEndpoint, definition, sourceEntries });
        sourceEntries = [];
      }
    }
    if (sourceEntries.length) {
      await applyPrepareBatch({ sourceEndpoint, targetEndpoint, definition, sourceEntries });
    }
  }
}

function assertPlanMatches(left, right, code) {
  if (left.planHash !== right.planHash || canonicalJson(left.counts) !== canonicalJson(right.counts)) {
    fail(code, "operation stream changed between planning and apply passes");
  }
}

async function alignTargetSequences(targetEndpoint, sourceSnapshot) {
  for (const definition of SEQUENCE_TABLES) {
    await targetEndpoint.restartSequence(definition.key, sourceSnapshot.sequences[definition.key].logicalNext);
  }
}

async function verifyFrozenFinalState({
  sourceEndpoint,
  targetEndpoint,
  frozenSource,
  frozenTarget,
  testDatabaseNames,
}) {
  const finalSource = await snapshotEndpoint(sourceEndpoint, { testDatabaseNames });
  const finalTarget = await snapshotEndpoint(targetEndpoint, { testDatabaseNames });
  assertQuiescent(finalSource, "final source");
  assertQuiescent(finalTarget, "final target");
  if (!snapshotIdentityEqual(finalSource, frozenSource) || !snapshotIdentityEqual(finalTarget, frozenTarget)) {
    fail("DATABASE_IDENTITY_CHANGED", "database identity changed during the frozen execution");
  }
  assertSnapshotsEqual(
    finalSource,
    frozenSource,
    "SOURCE_CHANGED_DURING_EXECUTE",
    "source changed while the reverse transaction was frozen"
  );
  assertSnapshotsEqual(
    finalTarget,
    frozenSource,
    "REVERSE_FINAL_STATE_MISMATCH",
    "target does not exactly match the frozen source before commit"
  );
  return { finalSource, finalTarget };
}

async function authoritativeReadback({
  sourcePool,
  targetPool,
  endpointFactory,
  batchSize,
  frozenSource,
  preTargetSnapshot,
  commitUncertain,
  testDatabaseNames,
}) {
  let pair;
  let sourceSnapshot;
  let targetSnapshot;
  try {
    pair = await beginPair({ sourcePool, targetPool, endpointFactory, batchSize });
    sourceSnapshot = await snapshotEndpoint(pair.source, { testDatabaseNames });
    targetSnapshot = await snapshotEndpoint(pair.target, { testDatabaseNames });
    const sourceRollback = await safeRollback(pair.source);
    const targetRollback = await safeRollback(pair.target);
    if (sourceRollback || targetRollback) {
      fail("OUTCOME_UNVERIFIED", "authoritative readback transactions could not be released");
    }
    safeRelease(pair.source);
    safeRelease(pair.target);
    pair = null;
  } catch (error) {
    if (pair) {
      const sourceRollback = await safeRollback(pair.source);
      const targetRollback = await safeRollback(pair.target);
      safeRelease(pair.source, Boolean(sourceRollback));
      safeRelease(pair.target, Boolean(targetRollback));
    }
    if (error instanceof WebhookCutoverError && error.code === "OUTCOME_UNVERIFIED") throw error;
    fail("OUTCOME_UNVERIFIED", "fresh post-commit authoritative readback failed", { cause: error });
  }
  assertQuiescent(sourceSnapshot, "authoritative source readback");
  assertQuiescent(targetSnapshot, "authoritative target readback");
  if (!snapshotIdentityEqual(sourceSnapshot, frozenSource) ||
      !snapshotIdentityEqual(targetSnapshot, preTargetSnapshot)) {
    fail("OUTCOME_UNVERIFIED", "fresh readback resolved to an unexpected database identity");
  }
  assertFreshSessionEvidence(sourceSnapshot.session, frozenSource.session);
  assertFreshSessionEvidence(targetSnapshot.session, preTargetSnapshot.session);
  if (!snapshotsEqual(sourceSnapshot, frozenSource)) {
    fail("OUTCOME_UNVERIFIED", "source changed after the frozen execution snapshot");
  }
  if (snapshotsEqual(targetSnapshot, frozenSource)) {
    return Object.freeze({ source: sourceSnapshot, target: targetSnapshot });
  }
  if (commitUncertain && snapshotsEqual(targetSnapshot, preTargetSnapshot)) {
    fail("COMMIT_NOT_APPLIED", "target remained at its pre-commit state after an uncertain commit");
  }
  fail("POST_COMMIT_STATE_MISMATCH", "authoritative target readback is neither baseline nor the frozen source");
}

function reverseResult({ mode, state, plan, sourceSnapshot, targetSnapshot, commitOutcome, readyForCloudStart }) {
  return Object.freeze({
    ok: true,
    operation: "reverse",
    mode,
    state,
    planVersion: PLAN_VERSION,
    planHash: plan.planHash,
    counts: plan.counts,
    source: Object.freeze({
      identity: sourceSnapshot.identity,
      identityFingerprint: identityFingerprint(sourceSnapshot.identity),
      session: sourceSnapshot.session,
      tables: sourceSnapshot.tables,
      sequences: sourceSnapshot.sequences,
      readiness: sourceSnapshot.readiness,
      triggers: sourceSnapshot.triggers,
    }),
    target: Object.freeze({
      identity: targetSnapshot.identity,
      identityFingerprint: identityFingerprint(targetSnapshot.identity),
      session: targetSnapshot.session,
      tables: targetSnapshot.tables,
      sequences: targetSnapshot.sequences,
      readiness: targetSnapshot.readiness,
      triggers: targetSnapshot.triggers,
    }),
    commitOutcome,
    alreadyApplied: state === "already_applied",
    readyForCloudStart,
  });
}

function assertSequenceConfigurationsCompatible(sourceSnapshot, targetSnapshot) {
  for (const definition of SEQUENCE_TABLES) {
    if (sourceSnapshot.sequences[definition.key].increment !==
        targetSnapshot.sequences[definition.key].increment) {
      fail("SEQUENCE_CONFIGURATION_DRIFT", "source and target sequence increments differ for " + definition.key);
    }
  }
}

function assertDistinctDatabaseSystems(sourceSnapshot, targetSnapshot, phase) {
  if (sourceSnapshot.identity.systemIdentifier === targetSnapshot.identity.systemIdentifier) {
    fail("ENDPOINT_SYSTEM_COLLISION", phase + " source and target resolve to the same PostgreSQL system");
  }
}

function assertApprovedPrepareDirection(
  sourceSnapshot,
  targetSnapshot,
  approvedSourceIdentityFingerprint,
  approvedTargetIdentityFingerprint
) {
  assertDistinctDatabaseSystems(sourceSnapshot, targetSnapshot, "prepare-forward");
  if (identityFingerprint(sourceSnapshot.identity) !== approvedSourceIdentityFingerprint ||
      identityFingerprint(targetSnapshot.identity) !== approvedTargetIdentityFingerprint) {
    fail("PREPARE_DIRECTION_MISMATCH", "prepare-forward endpoints do not match the operator-approved source/target direction");
  }
}

function assertReverseDirection(sourceSnapshot, targetSnapshot, baseline) {
  assertDistinctDatabaseSystems(sourceSnapshot, targetSnapshot, "reverse");
  if (canonicalJson(sourceSnapshot.identity) !== canonicalJson(baseline.targetIdentity) ||
      canonicalJson(targetSnapshot.identity) !== canonicalJson(baseline.sourceIdentity)) {
    fail("REVERSE_DIRECTION_MISMATCH", "reverse endpoints do not match the forward baseline in the required opposite direction");
  }
}

function prepareResult({
  mode,
  state,
  plan,
  sourceSnapshot,
  targetSnapshot,
  commitOutcome,
  readyForForwardBaseline,
}) {
  return Object.freeze({
    ok: true,
    operation: "prepare-forward",
    mode,
    state,
    planVersion: PLAN_VERSION,
    planHash: plan.planHash,
    counts: plan.counts,
    source: Object.freeze({
      identity: sourceSnapshot.identity,
      identityFingerprint: identityFingerprint(sourceSnapshot.identity),
      session: sourceSnapshot.session,
      tables: sourceSnapshot.tables,
      sequences: sourceSnapshot.sequences,
      readiness: sourceSnapshot.readiness,
      triggers: sourceSnapshot.triggers,
    }),
    target: Object.freeze({
      identity: targetSnapshot.identity,
      identityFingerprint: identityFingerprint(targetSnapshot.identity),
      session: targetSnapshot.session,
      tables: targetSnapshot.tables,
      sequences: targetSnapshot.sequences,
      readiness: targetSnapshot.readiness,
      triggers: targetSnapshot.triggers,
    }),
    commitOutcome,
    alreadyApplied: state === "already_applied",
    readyForForwardBaseline,
  });
}

export async function runPrepareForward({
  sourcePool,
  targetPool,
  execute = false,
  approvedPlanHash = null,
  approvedSourceIdentityFingerprint = null,
  approvedTargetIdentityFingerprint = null,
  endpointFactory = defaultEndpointFactory,
  batchSize = DEFAULT_BATCH_SIZE,
  testDatabaseNames = null,
  onProgress = null,
}) {
  if (!sourcePool || !targetPool) fail("POOL_INVALID", "source and target pools are required");
  const size = parseBatchSize(batchSize);
  if (execute && !HASH_PATTERN.test(String(approvedPlanHash))) {
    fail("PLAN_HASH_REQUIRED", "prepare-forward execute requires a lowercase SHA-256 approved plan hash");
  }
  if (!HASH_PATTERN.test(String(approvedSourceIdentityFingerprint)) ||
      !HASH_PATTERN.test(String(approvedTargetIdentityFingerprint))) {
    fail("DIRECTION_APPROVAL_REQUIRED", "prepare-forward requires approved source and target identity fingerprints");
  }
  let pair;
  let targetCommitAttempted = false;
  let targetCommitError = null;
  try {
    const t0 = Date.now();
    emitProgress(onProgress, "begin", 0);
    pair = await beginPair({ sourcePool, targetPool, endpointFactory, batchSize: size });
    const tPresnapshot = Date.now();
    const frozenSource = await snapshotEndpoint(pair.source, { testDatabaseNames });
    const frozenTarget = await snapshotEndpoint(pair.target, { testDatabaseNames });
    assertApprovedPrepareDirection(
      frozenSource,
      frozenTarget,
      approvedSourceIdentityFingerprint,
      approvedTargetIdentityFingerprint
    );
    assertQuiescent(frozenSource, "prepare-forward source");
    assertQuiescent(frozenTarget, "prepare-forward target");
    if (frozenSource.readiness.subscriptions !== "0" || frozenSource.readiness.gates !== "0") {
      fail("PREPARE_SIDE_TABLE_NOT_EMPTY", "authoritative source subscription and gate must be empty before forward preparation");
    }
    assertSequenceConfigurationsCompatible(frozenSource, frozenTarget);
    const presnapshotDuration = Date.now() - tPresnapshot;
    emitProgress(onProgress, "presnapshot", presnapshotDuration, {
      sourceTables: Object.keys(frozenSource.tables).length,
      targetTables: Object.keys(frozenTarget.tables).length,
    });

    const alreadyApplied = snapshotsEqual(frozenSource, frozenTarget);
    if (alreadyApplied) {
      const accumulator = new PlanAccumulator({
        mode: "prepare-forward",
        sourceSnapshot: frozenSource,
        targetSnapshot: frozenTarget,
        targetState: "already_applied",
      });
      const plan = accumulator.finish();
      if (execute && approvedPlanHash !== plan.planHash) {
        fail("PLAN_HASH_MISMATCH", "frozen prepare-forward plan differs from the approved plan hash");
      }
      if (execute) {
        emitProgress(onProgress, "validatehash", 0, { inserts: 0, updates: 0, total: 0 });
      }
      const sourceRollback = await safeRollback(pair.source);
      const targetRollback = await safeRollback(pair.target);
      if (sourceRollback || targetRollback) fail("OUTCOME_UNVERIFIED", "already-applied prepare snapshot release failed");
      safeRelease(pair.source);
      safeRelease(pair.target);
      pair = null;
      if (!execute) {
        emitProgress(onProgress, "finish", Date.now() - t0, { inserts: 0, updates: 0, total: 0 });
        return prepareResult({
          mode: "dry-run",
          state: "already_applied",
          plan,
          sourceSnapshot: frozenSource,
          targetSnapshot: frozenTarget,
          commitOutcome: "not_needed",
          readyForForwardBaseline: true,
        });
      }
      const tReadback = Date.now();
      const readback = await authoritativeReadback({
        sourcePool,
        targetPool,
        endpointFactory,
        batchSize: size,
        frozenSource,
        preTargetSnapshot: frozenTarget,
        commitUncertain: false,
        testDatabaseNames,
      });
      emitProgress(onProgress, "freshreadback", Date.now() - tReadback, {
        sourceTables: Object.keys(readback.source.tables).length,
        targetTables: Object.keys(readback.target.tables).length,
      });
      emitProgress(onProgress, "finish", Date.now() - t0, { inserts: 0, updates: 0, total: 0 });
      return prepareResult({
        mode: "execute",
        state: "already_applied",
        plan,
        sourceSnapshot: readback.source,
        targetSnapshot: readback.target,
        commitOutcome: "not_needed",
        readyForForwardBaseline: true,
      });
    }

    const planned = await calculatePreparePlan({
      sourceEndpoint: pair.source,
      targetEndpoint: pair.target,
      sourceSnapshot: frozenSource,
      targetSnapshot: frozenTarget,
      batchSize: size,
    });
    const planDuration = Date.now() - tPresnapshot - presnapshotDuration;
    const planCounts = summarizePlanCounts(planned.counts);
    emitProgress(onProgress, "plan", planDuration, planCounts);
    if (!execute) {
      const sourceRollback = await safeRollback(pair.source);
      const targetRollback = await safeRollback(pair.target);
      if (sourceRollback || targetRollback) fail("DRY_RUN_RELEASE_FAILED", "prepare-forward dry-run could not release snapshots");
      safeRelease(pair.source);
      safeRelease(pair.target);
      pair = null;
      emitProgress(onProgress, "finish", Date.now() - t0, planCounts);
      return prepareResult({
        mode: "dry-run",
        state: "planned",
        plan: planned,
        sourceSnapshot: frozenSource,
        targetSnapshot: frozenTarget,
        commitOutcome: "not_attempted",
        readyForForwardBaseline: false,
      });
    }
    const tValidate = Date.now();
    if (approvedPlanHash !== planned.planHash) {
      fail("PLAN_HASH_MISMATCH", "frozen prepare-forward plan differs from the approved plan hash");
    }

    const recalculated = await calculatePreparePlan({
      sourceEndpoint: pair.source,
      targetEndpoint: pair.target,
      sourceSnapshot: frozenSource,
      targetSnapshot: frozenTarget,
      batchSize: size,
    });
    assertPlanMatches(planned, recalculated, "PREPARE_PLAN_DRIFT");
    const validateDuration = Date.now() - tValidate;
    emitProgress(onProgress, "validatehash", validateDuration, planCounts);

    const tApply = Date.now();
    assertExpectedTriggers(await pair.target.readTriggerStates());
    await pair.target.setControlledTriggers(false);
    assertExpectedTriggers(await pair.target.readTriggerStates(), { controlledEnabled: false });
    await applyPrepareConvergence({
      sourceEndpoint: pair.source,
      targetEndpoint: pair.target,
      batchSize: size,
    });
    await alignTargetSequences(pair.target, frozenSource);
    await pair.target.setControlledTriggers(true);
    assertExpectedTriggers(await pair.target.readTriggerStates());
    const applyDuration = Date.now() - tApply;
    emitProgress(onProgress, "apply", applyDuration, planCounts);
    const tFinalValidation = Date.now();
    await verifyFrozenFinalState({
      sourceEndpoint: pair.source,
      targetEndpoint: pair.target,
      frozenSource,
      frozenTarget,
      testDatabaseNames,
    });

    const sourceRollback = await safeRollback(pair.source);
    if (sourceRollback) fail("SOURCE_RELEASE_FAILED", "prepare source frozen transaction could not be released");
    safeRelease(pair.source);
    pair.source = null;
    const finalValidationDuration = Date.now() - tFinalValidation;
    emitProgress(onProgress, "finalvalidation", finalValidationDuration);

    const tCommit = Date.now();
    targetCommitAttempted = true;
    try {
      await pair.target.commit();
    } catch (error) {
      targetCommitError = error;
    }
    safeRelease(pair.target, Boolean(targetCommitError));
    pair.target = null;
    const commitDuration = Date.now() - tCommit;
    emitProgress(onProgress, "commit", commitDuration);

    const tReadback = Date.now();
    const readback = await authoritativeReadback({
      sourcePool,
      targetPool,
      endpointFactory,
      batchSize: size,
      frozenSource,
      preTargetSnapshot: frozenTarget,
      commitUncertain: Boolean(targetCommitError),
      testDatabaseNames,
    });
    pair = null;
    const readbackDuration = Date.now() - tReadback;
    emitProgress(onProgress, "freshreadback", readbackDuration, {
      sourceTables: Object.keys(readback.source.tables).length,
      targetTables: Object.keys(readback.target.tables).length,
    });
    emitProgress(onProgress, "finish", Date.now() - t0, planCounts);
    return prepareResult({
      mode: "execute",
      state: "applied",
      plan: planned,
      sourceSnapshot: readback.source,
      targetSnapshot: readback.target,
      commitOutcome: targetCommitError ? "committed_after_uncertain_response" : "committed",
      readyForForwardBaseline: true,
    });
  } catch (error) {
    if (pair) {
      const sourceRollback = pair.source ? await safeRollback(pair.source) : null;
      const targetRollback = pair.target && !targetCommitAttempted ? await safeRollback(pair.target) : null;
      safeRelease(pair.source, Boolean(sourceRollback));
      safeRelease(pair.target, Boolean(targetRollback) || targetCommitAttempted);
      if ((sourceRollback || targetRollback) &&
          !(error instanceof WebhookCutoverError && error.code === "OUTCOME_UNVERIFIED")) {
        fail("ROLLBACK_UNVERIFIED", "prepare-forward failure could not be rolled back cleanly", { cause: error });
      }
    }
    throw error;
  }
}

export async function runReverse({
  sourcePool,
  targetPool,
  baseline,
  execute = false,
  approvedPlanHash = null,
  endpointFactory = defaultEndpointFactory,
  batchSize = DEFAULT_BATCH_SIZE,
  testDatabaseNames = null,
}) {
  if (!sourcePool || !targetPool) fail("POOL_INVALID", "source and target pools are required");
  validateBaseline(baseline);
  const size = parseBatchSize(batchSize);
  if (execute && !HASH_PATTERN.test(String(approvedPlanHash))) {
    fail("PLAN_HASH_REQUIRED", "execute requires a lowercase SHA-256 approved plan hash");
  }
  let pair;
  let targetCommitAttempted = false;
  let targetCommitError = null;
  try {
    pair = await beginPair({ sourcePool, targetPool, endpointFactory, batchSize: size });
    const frozenSource = await snapshotEndpoint(pair.source, { testDatabaseNames });
    const frozenTarget = await snapshotEndpoint(pair.target, { testDatabaseNames });
    assertReverseDirection(frozenSource, frozenTarget, baseline);
    assertQuiescent(frozenSource, "reverse source");
    assertQuiescent(frozenTarget, "reverse target");
    assertSequenceConfigurationsCompatible(frozenSource, frozenTarget);

    const alreadyApplied = snapshotsEqual(frozenSource, frozenTarget);
    const targetAtBaseline = snapshotMatchesBaseline(frozenTarget, baseline);
    if (!alreadyApplied && !targetAtBaseline) {
      fail("TARGET_STATE_UNSAFE", "target is neither the exact forward baseline nor equal to the frozen source");
    }

    if (alreadyApplied) {
      const accumulator = new PlanAccumulator({
        mode: "reverse",
        baseline,
        sourceSnapshot: frozenSource,
        targetSnapshot: frozenTarget,
        targetState: "already_applied",
      });
      const plan = accumulator.finish();
      if (execute && approvedPlanHash !== plan.planHash) {
        fail("PLAN_HASH_MISMATCH", "frozen plan differs from the approved plan hash");
      }
      const sourceRollback = await safeRollback(pair.source);
      const targetRollback = await safeRollback(pair.target);
      if (sourceRollback || targetRollback) fail("OUTCOME_UNVERIFIED", "already-applied snapshot release failed");
      safeRelease(pair.source);
      safeRelease(pair.target);
      pair = null;
      if (!execute) {
        return reverseResult({
          mode: "dry-run",
          state: "already_applied",
          plan,
          sourceSnapshot: frozenSource,
          targetSnapshot: frozenTarget,
          commitOutcome: "not_needed",
          readyForCloudStart: true,
        });
      }
      const readback = await authoritativeReadback({
        sourcePool,
        targetPool,
        endpointFactory,
        batchSize: size,
        frozenSource,
        preTargetSnapshot: frozenTarget,
        commitUncertain: false,
        testDatabaseNames,
      });
      return reverseResult({
        mode: "execute",
        state: "already_applied",
        plan,
        sourceSnapshot: readback.source,
        targetSnapshot: readback.target,
        commitOutcome: "not_needed",
        readyForCloudStart: true,
      });
    }

    await validateSourceBaselinePrefixes(pair.source, frozenSource, baseline);
    const planned = await calculatePlan({
      sourceEndpoint: pair.source,
      targetEndpoint: pair.target,
      baseline,
      sourceSnapshot: frozenSource,
      targetSnapshot: frozenTarget,
      batchSize: size,
      targetState: "baseline",
    });

    if (!execute) {
      const sourceRollback = await safeRollback(pair.source);
      const targetRollback = await safeRollback(pair.target);
      if (sourceRollback || targetRollback) fail("DRY_RUN_RELEASE_FAILED", "dry-run read transactions could not be released");
      safeRelease(pair.source);
      safeRelease(pair.target);
      pair = null;
      return reverseResult({
        mode: "dry-run",
        state: "planned",
        plan: planned,
        sourceSnapshot: frozenSource,
        targetSnapshot: frozenTarget,
        commitOutcome: "not_attempted",
        readyForCloudStart: false,
      });
    }

    if (approvedPlanHash !== planned.planHash) {
      fail("PLAN_HASH_MISMATCH", "frozen plan differs from the approved plan hash");
    }

    assertExpectedTriggers(await pair.target.readTriggerStates());
    await pair.target.setControlledTriggers(false);
    assertExpectedTriggers(await pair.target.readTriggerStates(), { controlledEnabled: false });

    const applied = await applyPlan({
      sourceEndpoint: pair.source,
      targetEndpoint: pair.target,
      baseline,
      sourceSnapshot: frozenSource,
      targetSnapshot: frozenTarget,
      targetState: "baseline",
    });
    assertPlanMatches(planned, applied, "APPLY_PLAN_DRIFT");

    await alignTargetSequences(pair.target, frozenSource);
    await pair.target.setControlledTriggers(true);
    assertExpectedTriggers(await pair.target.readTriggerStates());
    await verifyFrozenFinalState({
      sourceEndpoint: pair.source,
      targetEndpoint: pair.target,
      frozenSource,
      frozenTarget,
      testDatabaseNames,
    });

    const sourceRollback = await safeRollback(pair.source);
    if (sourceRollback) fail("SOURCE_RELEASE_FAILED", "source frozen transaction could not be released");
    safeRelease(pair.source);
    pair.source = null;

    targetCommitAttempted = true;
    try {
      await pair.target.commit();
    } catch (error) {
      targetCommitError = error;
    }
    safeRelease(pair.target, Boolean(targetCommitError));
    pair.target = null;

    const readback = await authoritativeReadback({
      sourcePool,
      targetPool,
      endpointFactory,
      batchSize: size,
      frozenSource,
      preTargetSnapshot: frozenTarget,
      commitUncertain: Boolean(targetCommitError),
      testDatabaseNames,
    });
    pair = null;
    return reverseResult({
      mode: "execute",
      state: "applied",
      plan: planned,
      sourceSnapshot: readback.source,
      targetSnapshot: readback.target,
      commitOutcome: targetCommitError ? "committed_after_uncertain_response" : "committed",
      readyForCloudStart: true,
    });
  } catch (error) {
    if (pair) {
      const sourceRollback = pair.source ? await safeRollback(pair.source) : null;
      const targetRollback = pair.target && !targetCommitAttempted ? await safeRollback(pair.target) : null;
      safeRelease(pair.source, Boolean(sourceRollback));
      safeRelease(pair.target, Boolean(targetRollback) || targetCommitAttempted);
      if ((sourceRollback || targetRollback) &&
          !(error instanceof WebhookCutoverError && error.code === "OUTCOME_UNVERIFIED")) {
        fail("ROLLBACK_UNVERIFIED", "failed operation could not be rolled back cleanly", { cause: error });
      }
    }
    throw error;
  }
}

export function parseArguments(argv) {
  let mode = null;
  let execute = false;
  let baselinePath = null;
  let approvedPlanHash = null;
  let approvedSourceIdentityFingerprint = null;
  let approvedTargetIdentityFingerprint = null;
  let progress = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (mode === null && (token === "forward" || token === "prepare-forward" || token === "reverse")) {
      mode = token;
      continue;
    }
    if (token === "--execute") {
      if (execute) fail("DUPLICATE_ARGUMENT", "--execute was repeated");
      execute = true;
      continue;
    }
    if (token === "--progress") {
      if (progress) fail("DUPLICATE_ARGUMENT", "--progress was repeated");
      progress = true;
      continue;
    }
    if (token === "--baseline" || token === "--approved-plan-hash" ||
        token === "--approved-source-identity" || token === "--approved-target-identity") {
      const value = argv[index + 1];
      if (value === undefined) fail("MISSING_ARGUMENT_VALUE", token + " requires a value");
      if (token === "--baseline") baselinePath = value;
      else if (token === "--approved-plan-hash") approvedPlanHash = value;
      else if (token === "--approved-source-identity") approvedSourceIdentityFingerprint = value;
      else approvedTargetIdentityFingerprint = value;
      index += 1;
      continue;
    }
    fail("INVALID_ARGUMENT", "unsupported argument");
  }
  if (mode !== "forward" && mode !== "prepare-forward" && mode !== "reverse") {
    fail("MODE_REQUIRED", "usage: forward | prepare-forward | reverse");
  }
  if (mode === "forward") {
    if (!execute) fail("FORWARD_EXECUTE_REQUIRED", "forward requires --execute after external services are stopped");
    if (baselinePath !== null || approvedPlanHash !== null ||
        approvedSourceIdentityFingerprint !== null || approvedTargetIdentityFingerprint !== null) {
      fail("FORWARD_ARGUMENT_INVALID", "forward does not accept baseline, plan-hash, or direction arguments");
    }
  }
  if (mode === "prepare-forward" && baselinePath !== null) {
    fail("PREPARE_ARGUMENT_INVALID", "prepare-forward does not accept --baseline");
  }
  if (mode === "prepare-forward" && execute && approvedPlanHash === null) {
    fail("PLAN_HASH_REQUIRED", "prepare-forward execute requires --approved-plan-hash");
  }
  if (mode === "prepare-forward" &&
      (approvedSourceIdentityFingerprint === null || approvedTargetIdentityFingerprint === null)) {
    fail("DIRECTION_APPROVAL_REQUIRED", "prepare-forward requires approved source and target identity fingerprints");
  }
  if (mode === "reverse" && baselinePath === null) fail("BASELINE_REQUIRED", "reverse requires --baseline");
  if (mode === "reverse" && execute && approvedPlanHash === null) fail("PLAN_HASH_REQUIRED", "reverse execute requires --approved-plan-hash");
  if (mode === "reverse" &&
      (approvedSourceIdentityFingerprint !== null || approvedTargetIdentityFingerprint !== null)) {
    fail("REVERSE_ARGUMENT_INVALID", "reverse direction is bound by the forward baseline and does not accept identity overrides");
  }
  if (!execute && approvedPlanHash !== null) fail("PLAN_HASH_WITHOUT_EXECUTE", "approved plan hash requires --execute");
  if (approvedPlanHash !== null && !HASH_PATTERN.test(approvedPlanHash)) {
    fail("PLAN_HASH_INVALID", "approved plan hash must be lowercase SHA-256");
  }
  for (const fingerprint of [approvedSourceIdentityFingerprint, approvedTargetIdentityFingerprint]) {
    if (fingerprint !== null && !HASH_PATTERN.test(fingerprint)) {
      fail("IDENTITY_FINGERPRINT_INVALID", "approved identity fingerprints must be lowercase SHA-256");
    }
  }
  const result = {
    mode,
    execute,
    baselinePath,
    approvedPlanHash,
    approvedSourceIdentityFingerprint,
    approvedTargetIdentityFingerprint,
  };
  Object.defineProperty(result, "progress", {
    value: progress,
    enumerable: progress,
    writable: false,
    configurable: true,
  });
  return Object.freeze(result);
}

function databaseUrl(environment, role) {
  const variable = role === "source" ? SOURCE_URL_VARIABLE : TARGET_URL_VARIABLE;
  const value = String(environment[variable] ?? "").trim();
  if (!value) fail("DATABASE_URL_REQUIRED", variable + " is required");
  return value;
}

export function isCutoverEntrypoint(entryPath = process.argv[1], moduleUrl = import.meta.url) {
  if (!entryPath) return false;
  try {
    return realpathSync(resolvePath(entryPath)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  poolFactory = defaultPoolFactory,
  endpointFactory = defaultEndpointFactory,
  onProgress = null,
} = {}) {
  let sourcePool;
  let targetPool;
  try {
    const args = parseArguments(argv);
    const progressOptIn = Boolean(
      args.progress ||
      environment.FNOS_WEBHOOK_PROGRESS === "1" ||
      environment.FNOS_WEBHOOK_PROGRESS === "true"
    );
    const progressSink = onProgress ?? (progressOptIn ? (event) => {
      stderr.write(JSON.stringify(event) + "\n");
    } : null);
    const sourceUrl = databaseUrl(environment, "source");
    const targetUrl = databaseUrl(environment, "target");
    if (sourceUrl === targetUrl) fail("SAME_DATABASE", "source and target database URLs must differ");
    const batchSize = parseBatchSize(environment[BATCH_SIZE_VARIABLE]);
    sourcePool = poolFactory("source", sourceUrl);
    targetPool = poolFactory("target", targetUrl);
    let result;
    if (args.mode === "forward") {
      result = await runForward({ sourcePool, targetPool, endpointFactory, batchSize });
    } else if (args.mode === "prepare-forward") {
      result = await runPrepareForward({
        sourcePool,
        targetPool,
        execute: args.execute,
        approvedPlanHash: args.approvedPlanHash,
        approvedSourceIdentityFingerprint: args.approvedSourceIdentityFingerprint,
        approvedTargetIdentityFingerprint: args.approvedTargetIdentityFingerprint,
        endpointFactory,
        batchSize,
        onProgress: progressSink,
      });
    } else {
      let baseline;
      try {
        baseline = JSON.parse(await readFile(args.baselinePath, "utf8"));
      } catch (error) {
        fail("BASELINE_UNREADABLE", "baseline file is unreadable or invalid JSON", { cause: error });
      }
      result = await runReverse({
        sourcePool,
        targetPool,
        baseline,
        execute: args.execute,
        approvedPlanHash: args.approvedPlanHash,
        endpointFactory,
        batchSize,
      });
    }
    stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (error) {
    const code = error instanceof WebhookCutoverError ? error.code : "WEBHOOK_CUTOVER_FAILED";
    stderr.write(JSON.stringify({
      ok: false,
      errorCode: code,
      outcome: code === "OUTCOME_UNVERIFIED" ? "outcome_unverified" : "failed_closed",
      readyForCloudStart: false,
      readyForForwardBaseline: false,
    }) + "\n");
    return 1;
  } finally {
    await sourcePool?.end().catch(() => {});
    await targetPool?.end().catch(() => {});
  }
}

if (isCutoverEntrypoint()) {
  process.exitCode = await main();
}
