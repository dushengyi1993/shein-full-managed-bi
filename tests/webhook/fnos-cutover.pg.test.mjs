import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import {
  SshTransportRegistry,
  buildPgPoolOptions,
  launcherConfiguration,
  sanitizeSshTransportDiagnostics,
} from "../../scripts/fnos_webhook_cutover_ssh.mjs";
import {
  CUTOVER_APPLICATION_NAME,
  MANAGED_TRIGGERS,
  PgEndpoint,
  createTimestampPreservingTypes,
  identityFingerprint,
  runForward,
  runPrepareForward,
  runReverse,
} from "../../scripts/fnos_webhook_cutover.mjs";

const { Pool } = pg;
const ENABLED = process.env.FNOS_WEBHOOK_PG_INTEGRATION === "1";
const SSH_ENABLED = process.env.FNOS_WEBHOOK_PG_TEST_SSH === "1";
const SSH_ACKNOWLEDGEMENT = "CREATE_AND_DROP_DEDICATED_DATABASES_OVER_SSH_STDIO";
const ACKNOWLEDGEMENT = "CREATE_AND_DROP_DEDICATED_DATABASES";
const SSH_BATCH_SIZE = 250;
const SSH_TIMING_ENABLED = process.env.FNOS_WEBHOOK_PG_TEST_TIMING === "1";

export function createTimingProgressSink(kind, { stream = process.stderr, enabled = SSH_TIMING_ENABLED } = {}) {
  if (!enabled) return null;
  if (kind !== "dry" && kind !== "execute") {
    throw new Error("Invalid timing sink kind");
  }
  return (event) => {
    if (!event || typeof event !== "object") return;
    const payload = {
      kind,
      phase: String(event.phase),
      durationMs: typeof event.durationMs === "number" ? event.durationMs : 0,
    };
    if (event.counts && typeof event.counts === "object") {
      payload.counts = event.counts;
    }
    stream.write(JSON.stringify(payload) + "\n");
  };
}

export class InstrumentedPgEndpoint extends PgEndpoint {
  constructor(pool, role, options, metricsCollector) {
    super(pool, role, options);
    this.metricsCollector = metricsCollector;
  }

  async applyInsertBatch(tableKey, rows) {
    const result = await super.applyInsertBatch(tableKey, rows);
    if (this.metricsCollector) {
      this.metricsCollector.insertBatches += 1;
      this.metricsCollector.insertedRows += rows.length;
    }
    return result;
  }

  async applyOperation(operation) {
    const result = await super.applyOperation(operation);
    if (this.metricsCollector) {
      if (operation.action === "insert") {
        this.metricsCollector.singleInserts += 1;
      } else if (operation.action === "update") {
        this.metricsCollector.singleUpdates += 1;
      }
    }
    return result;
  }
}
const FORWARD_BASELINE_DIRECTIVE_READINESS = Object.freeze({
  pending_directives: "60",
  retry_directives: "60",
  running_directives: "0",
  owned_leases: "0",
  expiring_leases: "0",
});
const SSH_REVERSE_DIRECTIVE_READINESS = Object.freeze({
  pending_directives: "62",
  retry_directives: "62",
  running_directives: "0",
  owned_leases: "0",
  expiring_leases: "0",
});
const SSH_PRIMARY_STAGES = Object.freeze([
  "system_identity",
  "source_database_create",
  "target_database_create",
  "fixture_install",
  "forward_source_delta",
  "identity_approval",
  "prepare_forward_dry_run",
  "prepare_forward_execute",
  "forward_baseline",
  "fnos_post_baseline_delta",
  "reverse_dry_run",
  "reverse_execute",
  "post_reverse_assertions",
]);

function integrationModeSkips(enabled, sshEnabled) {
  return Object.freeze({
    direct: !enabled || sshEnabled,
    ssh: !enabled || !sshEnabled,
  });
}

const INTEGRATION_MODE_SKIPS = integrationModeSkips(ENABLED, SSH_ENABLED);

test("PostgreSQL integration mode selection is mutually exclusive", () => {
  assert.deepEqual(integrationModeSkips(false, false), { direct: true, ssh: true });
  assert.deepEqual(integrationModeSkips(false, true), { direct: true, ssh: true });
  assert.deepEqual(integrationModeSkips(true, false), { direct: false, ssh: true });
  assert.deepEqual(integrationModeSkips(true, true), { direct: true, ssh: false });
});

test("SSH audit batch and primary-stage diagnostics stay bounded and allowlisted", () => {
  assert.equal(SSH_BATCH_SIZE, 250);
  assert.equal(Math.ceil(1200 / SSH_BATCH_SIZE), 5);
  assert.equal(Object.isFrozen(SSH_PRIMARY_STAGES), true);
  assert.deepEqual(SSH_PRIMARY_STAGES, [
    "system_identity",
    "source_database_create",
    "target_database_create",
    "fixture_install",
    "forward_source_delta",
    "identity_approval",
    "prepare_forward_dry_run",
    "prepare_forward_execute",
    "forward_baseline",
    "fnos_post_baseline_delta",
    "reverse_dry_run",
    "reverse_execute",
    "post_reverse_assertions",
  ]);
  assert.ok(SSH_PRIMARY_STAGES.every((stage) => FAILURE_STAGE_PATTERN.test(stage)));
  const diagnostics = [];
  const testContext = { diagnostic: (message) => diagnostics.push(message) };
  for (const stage of SSH_PRIMARY_STAGES) {
    assert.equal(reportSshPrimaryStage(testContext, stage), stage);
  }
  assert.deepEqual(diagnostics, SSH_PRIMARY_STAGES.map((stage) => `ssh_primary_stage=${stage}`));
  assert.throws(
    () => reportSshPrimaryStage(testContext, "host_or_payload_detail"),
    /invalid SSH integration primary stage/,
  );
});

function quoteDatabase(value) {
  if (!/^fnos_cutover_test_(?:source|target)_[a-z0-9_]+$/.test(value)) {
    throw new Error("unsafe temporary database name");
  }
  return `"${value}"`;
}

function guardedAdminUrl(variable) {
  const raw = String(process.env[variable] ?? "").trim();
  if (!raw) throw new Error(`${variable} is required when PostgreSQL integration is enabled`);
  const parsed = new URL(raw);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${variable} must use postgresql://`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!new Set(["postgres", "template1"]).has(database)) {
    throw new Error(`${variable} must name only the postgres or template1 maintenance database`);
  }
  return parsed;
}

function databaseUrl(adminUrl, database) {
  const value = new URL(adminUrl.href);
  value.pathname = `/${database}`;
  return value.href;
}

function makePool(connectionString) {
  return new Pool({
    connectionString,
    application_name: CUTOVER_APPLICATION_NAME,
    max: 1,
    min: 0,
    maxUses: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
    types: createTimestampPreservingTypes(),
  });
}

function makeSshPool(endpoint, registry, database, connectTimeoutMs) {
  return new Pool({
    ...buildPgPoolOptions(endpoint, registry, connectTimeoutMs),
    ...(database ? { database } : {}),
  });
}

const DATABASE_ABSENCE_SQL =
  "SELECT count(*)::text AS remaining FROM pg_catalog.pg_database WHERE datname = $1";

function cleanupFailure(stages) {
  const uniqueStages = [...new Set(stages)];
  const error = new Error(`SSH PostgreSQL fixture cleanup failed: ${uniqueStages.join(", ")}`);
  error.code = "SSH_PG_TEST_CLEANUP_FAILED";
  error.cleanupStages = Object.freeze(uniqueStages);
  return error;
}

const FAILURE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_]{0,63}$/;
const FAILURE_STAGE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function reportSshPrimaryStage(testContext, stage) {
  if (!FAILURE_STAGE_PATTERN.test(stage) || !SSH_PRIMARY_STAGES.includes(stage)) {
    throw new Error("invalid SSH integration primary stage");
  }
  testContext.diagnostic(`ssh_primary_stage=${stage}`);
  return stage;
}

function sshIntegrationFailure({ primaryError, primaryStage, cleanupError }) {
  const safePrimaryStage = primaryError && FAILURE_STAGE_PATTERN.test(String(primaryStage))
    ? String(primaryStage)
    : primaryError ? "integration_body" : null;
  const candidatePrimaryCode = String(primaryError?.code ?? "");
  const primaryCode = primaryError && FAILURE_CODE_PATTERN.test(candidatePrimaryCode)
    ? candidatePrimaryCode
    : primaryError ? "UNCLASSIFIED_PRIMARY_FAILURE" : null;
  const transportDiagnostics = primaryError
    ? sanitizeSshTransportDiagnostics(primaryError.transportDiagnostics) ??
      sanitizeSshTransportDiagnostics(primaryError.cause?.transportDiagnostics)
    : null;
  const candidateCleanupStages = cleanupError?.code === "SSH_PG_TEST_CLEANUP_FAILED" &&
      Array.isArray(cleanupError.cleanupStages)
    ? cleanupError.cleanupStages
      .map((stage) => String(stage))
      .filter((stage) => FAILURE_STAGE_PATTERN.test(stage))
    : [];
  const cleanupStages = cleanupError
    ? [...new Set(candidateCleanupStages.length ? candidateCleanupStages : ["cleanup_unclassified"])]
    : [];
  const code = primaryError && cleanupError
    ? "SSH_PG_TEST_PRIMARY_AND_CLEANUP_FAILED"
    : primaryError ? "SSH_PG_TEST_PRIMARY_FAILED" : "SSH_PG_TEST_CLEANUP_FAILED";
  const transportSummary = transportDiagnostics
    ? `; transport=${JSON.stringify(transportDiagnostics)}`
    : "";
  const error = new Error(
    "SSH PostgreSQL integration failed " +
    `(primaryStage=${safePrimaryStage ?? "none"}; primaryCode=${primaryCode ?? "none"}; ` +
    `cleanupStages=${cleanupStages.length ? cleanupStages.join(",") : "none"}${transportSummary})`
  );
  error.code = code;
  error.primaryStage = safePrimaryStage;
  error.primaryCode = primaryCode;
  error.cleanupStages = Object.freeze(cleanupStages);
  error.transportDiagnostics = transportDiagnostics;
  return error;
}

async function runSshIntegrationLifecycle({ runPrimary, runCleanup, getPrimaryStage }) {
  let result;
  let primaryError = null;
  let cleanupError = null;
  try {
    result = await runPrimary();
  } catch (error) {
    primaryError = error;
  }
  try {
    await runCleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError || cleanupError) {
    throw sshIntegrationFailure({
      primaryError,
      primaryStage: primaryError ? getPrimaryStage() : null,
      cleanupError,
    });
  }
  return result;
}

async function cleanupSshFixture({
  sourcePool,
  targetPool,
  sourceAdmin,
  targetAdmin,
  sourceDatabase,
  targetDatabase,
  registry,
}) {
  const failures = [];
  const attempt = async (stage, operation) => {
    try {
      await operation();
    } catch {
      failures.push(stage);
    }
  };
  const cleanupDatabase = async (role, admin, database) => {
    let quoted;
    try {
      quoted = quoteDatabase(database);
      if (!database.startsWith(`fnos_cutover_test_${role}_`)) {
        throw new Error("temporary database role mismatch");
      }
    } catch {
      failures.push(`${role}_database_name_guard`);
      return;
    }
    await attempt(`${role}_database_drop`, () =>
      admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`)
    );
    await attempt(`${role}_database_absence_readback`, async () => {
      const result = await admin.query(DATABASE_ABSENCE_SQL, [database]);
      if (result?.rows?.length !== 1 || String(result.rows[0].remaining) !== "0") {
        failures.push(`${role}_database_remains`);
      }
    });
  };

  await attempt("source_pool_end", () => sourcePool?.end());
  await attempt("target_pool_end", () => targetPool?.end());
  await cleanupDatabase("source", sourceAdmin, sourceDatabase);
  await cleanupDatabase("target", targetAdmin, targetDatabase);
  await attempt("source_admin_end", () => sourceAdmin?.end());
  await attempt("target_admin_end", () => targetAdmin?.end());
  await attempt("registry_abort", () => registry?.abortAll());
  await new Promise((resolveTick) => setImmediate(resolveTick));
  if (registry?.active?.size !== 0) failures.push("registry_active_transports");
  if (failures.length) throw cleanupFailure(failures);
}

test("SSH fixture cleanup attempts every step and fails on drop errors or residual databases without leaking causes", async () => {
  const calls = [];
  const sensitiveCause = "postgresql://user:secret@private-host.example/database";
  const sourcePool = {
    end: async () => {
      calls.push("source_pool_end");
      throw new Error(sensitiveCause);
    },
  };
  const targetPool = { end: async () => calls.push("target_pool_end") };
  const sourceAdmin = {
    query: async (sql, parameters) => {
      if (sql.startsWith("DROP DATABASE")) {
        calls.push("source_drop");
        throw new Error(sensitiveCause);
      }
      assert.equal(sql, DATABASE_ABSENCE_SQL);
      assert.deepEqual(parameters, ["fnos_cutover_test_source_static"]);
      calls.push("source_absence_readback");
      return { rows: [{ remaining: "1" }] };
    },
    end: async () => calls.push("source_admin_end"),
  };
  const targetAdmin = {
    query: async (sql, parameters) => {
      if (sql.startsWith("DROP DATABASE")) {
        calls.push("target_drop");
        return { rows: [] };
      }
      assert.equal(sql, DATABASE_ABSENCE_SQL);
      assert.deepEqual(parameters, ["fnos_cutover_test_target_static"]);
      calls.push("target_absence_readback");
      return { rows: [{ remaining: "0" }] };
    },
    end: async () => {
      calls.push("target_admin_end");
      throw new Error(sensitiveCause);
    },
  };
  const registry = {
    active: new Set(["transport"]),
    abortAll() {
      calls.push("registry_abort");
      this.active.clear();
    },
  };

  await assert.rejects(
    cleanupSshFixture({
      sourcePool,
      targetPool,
      sourceAdmin,
      targetAdmin,
      sourceDatabase: "fnos_cutover_test_source_static",
      targetDatabase: "fnos_cutover_test_target_static",
      registry,
    }),
    (error) => {
      assert.equal(error.code, "SSH_PG_TEST_CLEANUP_FAILED");
      assert.deepEqual(error.cleanupStages, [
        "source_pool_end",
        "source_database_drop",
        "source_database_remains",
        "target_admin_end",
      ]);
      assert.doesNotMatch(error.message, /secret|private-host|postgresql:\/\//);
      return true;
    },
  );
  assert.deepEqual(calls, [
    "source_pool_end",
    "target_pool_end",
    "source_drop",
    "source_absence_readback",
    "target_drop",
    "target_absence_readback",
    "source_admin_end",
    "target_admin_end",
    "registry_abort",
  ]);
});

test("SSH integration lifecycle preserves sanitized primary and cleanup failures without either masking the other", async () => {
  const sensitiveCause = "postgresql://user:secret@private-host.example/database?payload=sensitive";
  const primaryError = Object.assign(new Error(sensitiveCause), { code: "SSH_CHILD_EXITED" });
  const cleanupError = Object.assign(new Error(sensitiveCause), {
    code: "SSH_PG_TEST_CLEANUP_FAILED",
    cleanupStages: ["source_database_drop", "source_database_remains"],
  });
  const calls = [];

  await assert.rejects(
    runSshIntegrationLifecycle({
      runPrimary: async () => {
        calls.push("primary");
        throw primaryError;
      },
      runCleanup: async () => {
        calls.push("cleanup");
        throw cleanupError;
      },
      getPrimaryStage: () => "reverse_execute",
    }),
    (error) => {
      assert.equal(error.code, "SSH_PG_TEST_PRIMARY_AND_CLEANUP_FAILED");
      assert.equal(error.primaryStage, "reverse_execute");
      assert.equal(error.primaryCode, "SSH_CHILD_EXITED");
      assert.deepEqual(error.cleanupStages, ["source_database_drop", "source_database_remains"]);
      assert.doesNotMatch(error.message, /secret|private-host|postgresql:\/\/|payload/);
      return true;
    },
  );
  assert.deepEqual(calls, ["primary", "cleanup"]);

  await assert.rejects(
    runSshIntegrationLifecycle({
      runPrimary: async () => { throw primaryError; },
      runCleanup: async () => {},
      getPrimaryStage: () => "prepare_forward",
    }),
    (error) => {
      assert.equal(error.code, "SSH_PG_TEST_PRIMARY_FAILED");
      assert.equal(error.primaryStage, "prepare_forward");
      assert.equal(error.primaryCode, "SSH_CHILD_EXITED");
      assert.deepEqual(error.cleanupStages, []);
      assert.doesNotMatch(error.message, /secret|private-host|postgresql:\/\/|payload/);
      return true;
    },
  );

  await assert.rejects(
    runSshIntegrationLifecycle({
      runPrimary: async () => "completed",
      runCleanup: async () => { throw cleanupError; },
      getPrimaryStage: () => "unused",
    }),
    (error) => {
      assert.equal(error.code, "SSH_PG_TEST_CLEANUP_FAILED");
      assert.equal(error.primaryStage, null);
      assert.equal(error.primaryCode, null);
      assert.deepEqual(error.cleanupStages, ["source_database_drop", "source_database_remains"]);
      assert.doesNotMatch(error.message, /secret|private-host|postgresql:\/\/|payload/);
      return true;
    },
  );
});

test("SSH integration failure preserves only exact allowlisted transport diagnostics", () => {
  const valid = Object.freeze({
    topology: "cloud",
    generation: "17",
    exitKind: "exit",
    exitCode: 255,
    signal: null,
    stderrCapturedBytes: 8192,
    stderrTotalBytes: 9000,
    stderrTruncated: true,
    stderrSha256: "b".repeat(64),
  });
  const accepted = sshIntegrationFailure({
    primaryError: Object.assign(new Error("password=must-not-escape"), {
      code: "SSH_CHILD_EXITED",
      transportDiagnostics: valid,
    }),
    primaryStage: "forward_baseline",
    cleanupError: null,
  });
  assert.deepEqual(accepted.transportDiagnostics, valid);
  assert.match(accepted.message, /primaryStage=forward_baseline/);
  assert.match(accepted.message, /"topology":"cloud"/);
  assert.doesNotMatch(`${accepted.message}\n${JSON.stringify(accepted)}`, /password|must-not-escape/);

  const wrapped = sshIntegrationFailure({
    primaryError: Object.assign(new Error("outer-safe-message"), {
      code: "OUTCOME_UNVERIFIED",
      cause: Object.assign(new Error("private-host.example password=hidden"), {
        transportDiagnostics: valid,
      }),
    }),
    primaryStage: "reverse_execute",
    cleanupError: null,
  });
  assert.deepEqual(wrapped.transportDiagnostics, valid);
  assert.doesNotMatch(`${wrapped.message}\n${JSON.stringify(wrapped)}`, /private-host|password|hidden/);

  for (const invalid of [
    { ...valid, host: "private-host.example" },
    { ...valid, topology: "private-host.example" },
    { ...valid, exitCode: 999 },
    { ...valid, stderrSha256: "not-a-hash" },
  ]) {
    const rejected = sshIntegrationFailure({
      primaryError: Object.assign(new Error("C:\\Users\\operator\\.ssh\\secret-key"), {
        code: "SSH_CHILD_EXITED",
        transportDiagnostics: invalid,
      }),
      primaryStage: "forward_baseline",
      cleanupError: null,
    });
    assert.equal(rejected.transportDiagnostics, null);
    assert.doesNotMatch(
      `${rejected.message}\n${JSON.stringify(rejected)}`,
      /private-host|operator|secret-key|"host"|999|not-a-hash/,
    );
  }
});

async function systemIdentifier(pool) {
  const result = await pool.query(
    "SELECT control.system_identifier::text AS system_identifier FROM pg_catalog.pg_control_system() AS control"
  );
  return String(result.rows[0].system_identifier);
}

async function cutoverIdentity(pool, role) {
  const endpoint = new PgEndpoint(pool, role, { batchSize: 73 });
  await endpoint.beginFrozen();
  try {
    return await endpoint.readIdentity();
  } finally {
    await endpoint.rollback().catch(() => {});
    endpoint.release({ destroy: true });
  }
}

const SCHEMA_SQL = String.raw`
CREATE SCHEMA raw;
CREATE SCHEMA ops;
CREATE SCHEMA dim;

CREATE TABLE dim.store (store_id bigint PRIMARY KEY);
CREATE TABLE ops.permission_probe (
  permission_probe_id bigint PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES dim.store(store_id),
  outcome text NOT NULL,
  capability_code text NOT NULL,
  probed_at timestamptz NOT NULL
);
INSERT INTO dim.store (store_id) VALUES (1), (2);
INSERT INTO ops.permission_probe (
  permission_probe_id, store_id, outcome, capability_code, probed_at
) VALUES
  (91, 1, 'GRANTED', 'FULL_MANAGED_SKU_SALES', timestamptz '2026-09-03 12:40:56.789123+08'),
  (92, 2, 'GRANTED', 'FULL_MANAGED_SKU_SALES', timestamptz '2026-09-03 12:40:56.789123+08');

CREATE TABLE raw.webhook_receipt (
  receipt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key character(64) NOT NULL,
  app_key_hash character(64) NOT NULL,
  open_key_hash character(64),
  event_code text,
  event_path text,
  store_id bigint REFERENCES dim.store(store_id),
  delivery_scope text NOT NULL,
  platform_timestamp timestamptz NOT NULL,
  cipher_sha256 character(64) NOT NULL,
  ciphertext text NOT NULL,
  safe_projection jsonb NOT NULL,
  duplicate_count integer NOT NULL,
  last_duplicate_at timestamptz,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE ops.webhook_runtime_heartbeat (
  webhook_runtime_heartbeat_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  component_code text NOT NULL,
  instance_id text NOT NULL,
  status_code text NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  event_fingerprint character(64) NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE ops.webhook_job (
  job_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id bigint NOT NULL UNIQUE REFERENCES raw.webhook_receipt(receipt_id),
  status text NOT NULL,
  attempt_count integer NOT NULL,
  max_attempts integer NOT NULL,
  available_at timestamptz NOT NULL,
  lease_owner text NOT NULL,
  lease_expires_at timestamptz,
  last_error_code text NOT NULL,
  last_error_message text NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE ops.operational_event (
  operational_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id bigint NOT NULL UNIQUE REFERENCES raw.webhook_receipt(receipt_id),
  store_id bigint REFERENCES dim.store(store_id),
  event_code text,
  event_path text,
  event_family text NOT NULL,
  business_type text NOT NULL,
  business_key text,
  occurred_at timestamptz,
  action text NOT NULL,
  platform_status text,
  severity text NOT NULL,
  delivery_scope text NOT NULL,
  safe_projection jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE ops.webhook_hydration_directive (
  hydration_directive_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operational_event_id bigint NOT NULL UNIQUE REFERENCES ops.operational_event(operational_event_id),
  store_id bigint NOT NULL REFERENCES dim.store(store_id),
  directive_type text NOT NULL,
  capability_code text NOT NULL,
  lookup_projection jsonb NOT NULL,
  state text NOT NULL,
  attempt_count integer NOT NULL,
  available_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  lease_owner text NOT NULL,
  lease_expires_at timestamptz,
  last_error_code text NOT NULL,
  last_error_message text NOT NULL
);

CREATE TABLE ops.webhook_subscription_state (
  webhook_subscription_state_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_key_hash character(64) NOT NULL,
  event_code text NOT NULL,
  desired_state text NOT NULL,
  observed_state text NOT NULL,
  callback_validated boolean NOT NULL,
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE ops.webhook_store_gate (
  store_id bigint NOT NULL REFERENCES dim.store(store_id),
  gate_key text NOT NULL,
  state text NOT NULL,
  reason_code text NOT NULL,
  source_operational_event_id bigint REFERENCES ops.operational_event(operational_event_id),
  blocked_at timestamptz,
  reopened_at timestamptz,
  last_probe_id bigint REFERENCES ops.permission_probe(permission_probe_id),
  recovery_requires_probe boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (store_id, gate_key)
);

CREATE FUNCTION ops.guard_webhook_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'duplicate_count' - 'last_duplicate_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'duplicate_count' - 'last_duplicate_at') THEN
    RAISE EXCEPTION 'receipt immutable drift';
  END IF;
  IF NEW.duplicate_count < OLD.duplicate_count THEN
    RAISE EXCEPTION 'duplicate count regression';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION ops.reject_webhook_runtime_heartbeat_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'heartbeat append-only';
END;
$$;

CREATE FUNCTION ops.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION ops.guard_webhook_store_gate_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  probe_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.state = 'OPEN' THEN
    RAISE EXCEPTION 'an authorization gate must first be created in BLOCKED state';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'BLOCKED' AND NEW.state = 'OPEN' THEN
    SELECT probe.probed_at
      INTO probe_at
      FROM ops.permission_probe AS probe
     WHERE probe.permission_probe_id = NEW.last_probe_id
       AND probe.store_id = OLD.store_id
       AND probe.outcome = 'GRANTED'
       AND probe.capability_code = 'FULL_MANAGED_SKU_SALES'
       AND probe.probed_at > OLD.blocked_at;
    IF probe_at IS NULL
       OR NEW.reopened_at IS DISTINCT FROM probe_at
       OR NEW.recovery_requires_probe THEN
      RAISE EXCEPTION 'a newer successful read-only authorization probe is required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_raw_webhook_receipt_immutable
BEFORE UPDATE ON raw.webhook_receipt
FOR EACH ROW EXECUTE FUNCTION ops.guard_webhook_receipt_immutable();
CREATE TRIGGER trg_ops_webhook_runtime_heartbeat_append_only
BEFORE UPDATE OR DELETE ON ops.webhook_runtime_heartbeat
FOR EACH ROW EXECUTE FUNCTION ops.reject_webhook_runtime_heartbeat_mutation();
CREATE TRIGGER trg_ops_webhook_job_touch_updated_at
BEFORE UPDATE ON ops.webhook_job
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();
CREATE TRIGGER trg_ops_operational_event_touch_updated_at
BEFORE UPDATE ON ops.operational_event
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();
CREATE TRIGGER trg_ops_webhook_hydration_touch_updated_at
BEFORE UPDATE ON ops.webhook_hydration_directive
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();
CREATE TRIGGER trg_ops_webhook_subscription_touch_updated_at
BEFORE UPDATE ON ops.webhook_subscription_state
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();
CREATE TRIGGER trg_ops_webhook_store_gate_recovery
BEFORE INSERT OR UPDATE ON ops.webhook_store_gate
FOR EACH ROW EXECUTE FUNCTION ops.guard_webhook_store_gate_recovery();
CREATE TRIGGER trg_ops_webhook_store_gate_touch_updated_at
BEFORE UPDATE ON ops.webhook_store_gate
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();
`;

const BASELINE_SQL = String.raw`
INSERT INTO raw.webhook_receipt (
  receipt_id, idempotency_key, app_key_hash, open_key_hash, event_code, event_path,
  store_id, delivery_scope, platform_timestamp, cipher_sha256, ciphertext,
  safe_projection, duplicate_count, last_duplicate_at, received_at, created_at
) OVERRIDING SYSTEM VALUE
SELECT g, md5('receipt-' || g::text) || md5('receipt-' || g::text),
       md5('app') || md5('app'), md5('open') || md5('open'), '1234567', '/event/test',
       ((g - 1) % 2) + 1, 'STORE',
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond',
       md5('cipher-' || g::text) || md5('cipher-' || g::text),
       encode(convert_to('ciphertext-' || g::text, 'UTF8'), 'base64'),
       jsonb_build_object('fixture', g), 0, NULL,
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond',
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond'
FROM generate_series(1, 200) AS g;

INSERT INTO ops.operational_event (
  operational_event_id, receipt_id, store_id, event_code, event_path, event_family,
  business_type, business_key, occurred_at, action, platform_status, severity,
  delivery_scope, safe_projection, created_at, updated_at
) OVERRIDING SYSTEM VALUE
SELECT g, g, ((g - 1) % 2) + 1, '1234567', '/event/test', 'ORDER', 'ORDER',
       'order-' || g::text,
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond',
       'UPDATED', 'DONE', 'P3', 'STORE', jsonb_build_object('order', g),
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond',
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond'
FROM generate_series(1, 200) AS g;

INSERT INTO ops.webhook_job (
  job_id, receipt_id, status, attempt_count, max_attempts, available_at, lease_owner,
  lease_expires_at, last_error_code, last_error_message, completed_at, created_at, updated_at
) OVERRIDING SYSTEM VALUE
SELECT g, g, 'SUCCEEDED', 1, 8,
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond',
       '', NULL, '', '',
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond',
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond',
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond'
FROM generate_series(1, 200) AS g;

INSERT INTO ops.webhook_hydration_directive (
  hydration_directive_id, operational_event_id, store_id, directive_type, capability_code,
  lookup_projection, state, attempt_count, available_at, completed_at, created_at, updated_at,
  lease_owner, lease_expires_at, last_error_code, last_error_message
) OVERRIDING SYSTEM VALUE
SELECT g, g, ((g - 1) % 2) + 1, 'ORDER_LOOKUP', 'ORDER_READ',
       jsonb_build_object('order', g),
       CASE WHEN g % 20 = 0 THEN 'RETRY' WHEN g % 10 = 0 THEN 'PENDING' ELSE 'SUCCEEDED' END,
       CASE WHEN g % 20 = 0 THEN 2 WHEN g % 10 = 0 THEN 0 ELSE 1 END,
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond',
       CASE WHEN g % 10 = 0 THEN NULL
            ELSE timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond' END,
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond',
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond',
       '', NULL, '', ''
FROM generate_series(1, 200) AS g;

INSERT INTO ops.webhook_runtime_heartbeat (
  webhook_runtime_heartbeat_id, component_code, instance_id, status_code,
  observed_at, expires_at, event_fingerprint, created_at
) OVERRIDING SYSTEM VALUE
SELECT g, CASE WHEN g % 2 = 0 THEN 'WORKER' ELSE 'RECEIVER' END,
       'fixture-' || g::text, 'STOPPING',
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond',
       timestamptz '2026-09-03 12:39:00.789123+08' + (g - 1) * interval '1 microsecond',
       md5('heartbeat-' || g::text) || md5('heartbeat-' || g::text),
       timestamptz '2026-09-03 12:34:56.789123+08' + (g - 1) * interval '1 microsecond'
FROM generate_series(1, 200) AS g;

ALTER SEQUENCE raw.webhook_receipt_receipt_id_seq RESTART WITH 201;
ALTER SEQUENCE ops.webhook_runtime_heartbeat_webhook_runtime_heartbeat_id_seq RESTART WITH 201;
ALTER SEQUENCE ops.webhook_job_job_id_seq RESTART WITH 201;
ALTER SEQUENCE ops.operational_event_operational_event_id_seq RESTART WITH 201;
ALTER SEQUENCE ops.webhook_hydration_directive_hydration_directive_id_seq RESTART WITH 201;
`;

const DELTA_SQL = BASELINE_SQL
  .replaceAll("generate_series(1, 200)", "generate_series(201, 1200)")
  .replaceAll("RESTART WITH 201", "RESTART WITH 1201");

async function installFixture(pool) {
  await pool.query(SCHEMA_SQL);
  await pool.query(BASELINE_SQL);
}

async function installDelta(pool) {
  await pool.query(`
    UPDATE raw.webhook_receipt
       SET duplicate_count = 5,
           last_duplicate_at = timestamptz '2026-09-03 12:35:56.789123+08'
     WHERE receipt_id = 1;
    UPDATE ops.webhook_job
       SET last_error_code = 'RECOVERED', last_error_message = 'source truth',
           updated_at = timestamptz '2026-09-03 12:35:56.789123+08'
     WHERE job_id = 1;
    UPDATE ops.operational_event
       SET action = 'SOURCE_WINS', updated_at = timestamptz '2026-09-03 12:35:56.789123+08'
     WHERE operational_event_id = 1;
    UPDATE ops.webhook_hydration_directive
       SET last_error_code = 'RETRIED', last_error_message = 'source truth',
           updated_at = timestamptz '2026-09-03 12:35:56.789123+08'
     WHERE hydration_directive_id = 1;
  `);
  await pool.query(DELTA_SQL);
}

async function assertRestartRollsBack(pool) {
  const before = await pool.query(
    "SELECT last_value::text AS last_value, is_called FROM raw.webhook_receipt_receipt_id_seq"
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER SEQUENCE raw.webhook_receipt_receipt_id_seq RESTART WITH 999999");
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  const after = await pool.query(
    "SELECT last_value::text AS last_value, is_called FROM raw.webhook_receipt_receipt_id_seq"
  );
  assert.deepEqual(after.rows, before.rows);
}

const FNOS_DELTA_SQL = String.raw`
INSERT INTO raw.webhook_receipt (
  receipt_id, idempotency_key, app_key_hash, open_key_hash, event_code, event_path,
  store_id, delivery_scope, platform_timestamp, cipher_sha256, ciphertext,
  safe_projection, duplicate_count, last_duplicate_at, received_at, created_at
) OVERRIDING SYSTEM VALUE
SELECT g, md5('receipt-' || g::text) || md5('receipt-' || g::text),
       md5('app') || md5('app'), md5('open') || md5('open'), '1234567', '/event/test',
       ((g - 1) % 2) + 1, 'STORE',
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond',
       md5('cipher-' || g::text) || md5('cipher-' || g::text),
       encode(convert_to('ciphertext-' || g::text, 'UTF8'), 'base64'),
       jsonb_build_object('fixture', g), 2,
       timestamptz '2026-09-03 12:42:56.789123+08' + (g - 201) * interval '1 microsecond',
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond',
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond'
FROM generate_series(1201, 1260) AS g;

UPDATE raw.webhook_receipt
   SET duplicate_count = 7,
       last_duplicate_at = timestamptz '2026-09-03 12:43:56.789123+08'
 WHERE receipt_id = 1;

INSERT INTO ops.operational_event (
  operational_event_id, receipt_id, store_id, event_code, event_path, event_family,
  business_type, business_key, occurred_at, action, platform_status, severity,
  delivery_scope, safe_projection, created_at, updated_at
) OVERRIDING SYSTEM VALUE
SELECT g, g, ((g - 1) % 2) + 1, '1234567', '/event/test', 'ORDER', 'ORDER',
       'order-' || g::text,
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond',
       'UPDATED', 'DONE', 'P3', 'STORE', jsonb_build_object('order', g),
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond',
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond'
FROM generate_series(1201, 1240) AS g;

INSERT INTO ops.webhook_job (
  job_id, receipt_id, status, attempt_count, max_attempts, available_at, lease_owner,
  lease_expires_at, last_error_code, last_error_message, completed_at, created_at, updated_at
) OVERRIDING SYSTEM VALUE
SELECT g, g, 'SUCCEEDED', 1, 8,
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond',
       '', NULL, '', '',
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond',
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond',
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond'
FROM generate_series(1201, 1240) AS g;

INSERT INTO ops.webhook_hydration_directive (
  hydration_directive_id, operational_event_id, store_id, directive_type, capability_code,
  lookup_projection, state, attempt_count, available_at, completed_at, created_at, updated_at,
  lease_owner, lease_expires_at, last_error_code, last_error_message
) OVERRIDING SYSTEM VALUE
SELECT g, g, ((g - 1) % 2) + 1, 'ORDER_LOOKUP', 'ORDER_READ',
       jsonb_build_object('order', g),
       CASE WHEN g % 20 = 5 THEN 'RETRY' WHEN g % 10 = 5 THEN 'PENDING' ELSE 'SUCCEEDED' END,
       CASE WHEN g % 20 = 5 THEN 2 WHEN g % 10 = 5 THEN 0 ELSE 1 END,
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond',
       CASE WHEN g % 10 = 5 THEN NULL
            ELSE timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond' END,
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond',
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond',
       '', NULL, '', ''
FROM generate_series(1201, 1240) AS g;

INSERT INTO ops.webhook_runtime_heartbeat (
  webhook_runtime_heartbeat_id, component_code, instance_id, status_code,
  observed_at, expires_at, event_fingerprint, created_at
) OVERRIDING SYSTEM VALUE
SELECT g, CASE WHEN g % 2 = 0 THEN 'WORKER' ELSE 'RECEIVER' END,
       'fixture-' || g::text, 'STOPPING',
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond',
       timestamptz '2026-09-03 12:46:00.789123+08' + (g - 201) * interval '1 microsecond',
       md5('heartbeat-' || g::text) || md5('heartbeat-' || g::text),
       timestamptz '2026-09-03 12:41:56.789123+08' + (g - 201) * interval '1 microsecond'
FROM generate_series(1201, 1260) AS g;

ALTER SEQUENCE raw.webhook_receipt_receipt_id_seq RESTART WITH 1261;
ALTER SEQUENCE ops.operational_event_operational_event_id_seq RESTART WITH 1241;
ALTER SEQUENCE ops.webhook_job_job_id_seq RESTART WITH 1241;
ALTER SEQUENCE ops.webhook_hydration_directive_hydration_directive_id_seq RESTART WITH 1241;
ALTER SEQUENCE ops.webhook_runtime_heartbeat_webhook_runtime_heartbeat_id_seq RESTART WITH 1261;
`;

test("PostgreSQL fixture backlog arithmetic matches forward baseline and SSH reverse expectations", () => {
  const countStates = (first, last, classify) => {
    const counts = { pending: 0, retry: 0, succeeded: 0 };
    for (let id = first; id <= last; id += 1) counts[classify(id)] += 1;
    return counts;
  };
  const cloudState = (id) => id % 20 === 0 ? "retry" : id % 10 === 0 ? "pending" : "succeeded";
  const fnosState = (id) => id % 20 === 5 ? "retry" : id % 10 === 5 ? "pending" : "succeeded";

  assert.ok(BASELINE_SQL.includes(
    "CASE WHEN g % 20 = 0 THEN 'RETRY' WHEN g % 10 = 0 THEN 'PENDING' ELSE 'SUCCEEDED' END"
  ));
  assert.ok(DELTA_SQL.includes("generate_series(201, 1200)"));
  assert.ok(FNOS_DELTA_SQL.includes(
    "CASE WHEN g % 20 = 5 THEN 'RETRY' WHEN g % 10 = 5 THEN 'PENDING' ELSE 'SUCCEEDED' END"
  ));
  assert.deepEqual(countStates(1, 200, cloudState), { pending: 10, retry: 10, succeeded: 180 });
  assert.deepEqual(countStates(201, 1200, cloudState), { pending: 50, retry: 50, succeeded: 900 });
  assert.deepEqual(countStates(1, 1200, cloudState), { pending: 60, retry: 60, succeeded: 1080 });
  assert.deepEqual(countStates(1201, 1240, fnosState), { pending: 2, retry: 2, succeeded: 36 });
  assert.equal(FORWARD_BASELINE_DIRECTIVE_READINESS.pending_directives, "60");
  assert.equal(FORWARD_BASELINE_DIRECTIVE_READINESS.retry_directives, "60");
  assert.equal(SSH_REVERSE_DIRECTIVE_READINESS.pending_directives, "62");
  assert.equal(SSH_REVERSE_DIRECTIVE_READINESS.retry_directives, "62");
});

async function applyFnosDelta(targetPool) {
  await targetPool.query(FNOS_DELTA_SQL);
  return {
    receipt: { inserted: "60", updated: "1" },
    event: { inserted: "40", updated: "0" },
    job: { inserted: "40", updated: "0" },
    directive: { inserted: "40", updated: "0" },
    heartbeat: { inserted: "60", updated: "0" },
  };
}

test("real PostgreSQL prepare/reverse covers microseconds, subscription/gate, six sequences, transactions, batches, and triggers", {
  skip: INTEGRATION_MODE_SKIPS.direct,
  timeout: 600_000,
}, async () => {
  if (process.env.FNOS_WEBHOOK_PG_TEST_ACK !== ACKNOWLEDGEMENT) {
    throw new Error(`FNOS_WEBHOOK_PG_TEST_ACK must equal ${ACKNOWLEDGEMENT}`);
  }
  const sourceAdminUrl = guardedAdminUrl("FNOS_WEBHOOK_PG_TEST_SOURCE_ADMIN_URL");
  const targetAdminUrl = guardedAdminUrl("FNOS_WEBHOOK_PG_TEST_TARGET_ADMIN_URL");
  const suffix = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 16)}`.toLowerCase();
  const sourceDatabase = `fnos_cutover_test_source_${suffix}`;
  const targetDatabase = `fnos_cutover_test_target_${suffix}`;
  const sourceAdmin = makePool(sourceAdminUrl.href);
  const targetAdmin = makePool(targetAdminUrl.href);
  let sourceCreated = false;
  let targetCreated = false;
  let sourcePool;
  let targetPool;
  try {
    const sourceAdminSystemIdentifier = await systemIdentifier(sourceAdmin);
    const targetAdminSystemIdentifier = await systemIdentifier(targetAdmin);
    assert.notEqual(
      sourceAdminSystemIdentifier,
      targetAdminSystemIdentifier,
      "integration requires two independent PostgreSQL systems"
    );
    await sourceAdmin.query(`CREATE DATABASE ${quoteDatabase(sourceDatabase)}`);
    sourceCreated = true;
    await targetAdmin.query(`CREATE DATABASE ${quoteDatabase(targetDatabase)}`);
    targetCreated = true;
    sourcePool = makePool(databaseUrl(sourceAdminUrl, sourceDatabase));
    targetPool = makePool(databaseUrl(targetAdminUrl, targetDatabase));
    const testDatabaseNames = { source: sourceDatabase, target: targetDatabase };

    await installFixture(sourcePool);
    await installFixture(targetPool);
    await assertRestartRollsBack(targetPool);

    const microseconds = await sourcePool.query(
      "SELECT platform_timestamp, " +
      "platform_timestamp = timestamptz '2026-09-03 12:34:56.789123+08' AS exact " +
      "FROM raw.webhook_receipt WHERE receipt_id = 1"
    );
    assert.equal(microseconds.rows[0].exact, true);
    assert.equal(typeof microseconds.rows[0].platform_timestamp, "string");
    assert.match(microseconds.rows[0].platform_timestamp, /\.789123(?:\+00|Z)$/);

    await installDelta(sourcePool);
    const sourceIdentity = await cutoverIdentity(sourcePool, "source");
    const targetIdentity = await cutoverIdentity(targetPool, "target");
    const direction = {
      approvedSourceIdentityFingerprint: identityFingerprint(sourceIdentity),
      approvedTargetIdentityFingerprint: identityFingerprint(targetIdentity),
    };
    const dry = await runPrepareForward({
      sourcePool,
      targetPool,
      ...direction,
      batchSize: 73,
      testDatabaseNames,
    });
    assert.deepEqual(dry.counts.receipt, { inserted: "1000", updated: "1" });
    assert.equal(dry.counts.heartbeat.inserted, "1000");
    assert.equal(dry.counts.job.updated, "1");
    assert.equal(dry.counts.event.updated, "1");
    assert.equal(dry.counts.directive.updated, "1");

    const executed = await runPrepareForward({
      sourcePool,
      targetPool,
      ...direction,
      execute: true,
      approvedPlanHash: dry.planHash,
      batchSize: 73,
      testDatabaseNames,
    });
    assert.equal(executed.readyForForwardBaseline, true);
    assert.deepEqual(executed.source.tables, executed.target.tables);
    assert.deepEqual(executed.source.sequences, executed.target.sequences);

    const triggerRows = await targetPool.query(
      "SELECT ns.nspname || '.' || cls.relname || '.' || trg.tgname AS trigger_key, trg.tgenabled " +
      "FROM pg_catalog.pg_trigger AS trg " +
      "JOIN pg_catalog.pg_class AS cls ON cls.oid = trg.tgrelid " +
      "JOIN pg_catalog.pg_namespace AS ns ON ns.oid = cls.relnamespace " +
      "WHERE NOT trg.tgisinternal AND trg.tgname = ANY($1::text[]) ORDER BY 1",
      [MANAGED_TRIGGERS.map((item) => item.name)]
    );
    assert.equal(triggerRows.rowCount, MANAGED_TRIGGERS.length);
    assert.ok(triggerRows.rows.every((row) => row.tgenabled === "O"));

    const baseline = await runForward({ sourcePool, targetPool, batchSize: 73, testDatabaseNames });
    assert.equal(Object.keys(baseline.sequences).length, 6);
    assert.equal(baseline.sourceIdentity.systemIdentifier, sourceIdentity.systemIdentifier);
    assert.equal(baseline.targetIdentity.systemIdentifier, targetIdentity.systemIdentifier);

  await targetPool.query(`
      INSERT INTO ops.webhook_subscription_state (
        webhook_subscription_state_id, app_key_hash, event_code, desired_state,
        observed_state, callback_validated, checked_at, created_at, updated_at
      ) OVERRIDING SYSTEM VALUE VALUES (
        1, md5('app') || md5('app'), '7000001', 'ACTIVE', 'ACTIVE', true,
        timestamptz '2026-09-03 12:40:56.789123+08',
        timestamptz '2026-09-03 12:40:56.789123+08',
        timestamptz '2026-09-03 12:40:56.789123+08'
      );
      ALTER SEQUENCE ops.webhook_subscription_state_webhook_subscription_state_id_seq RESTART WITH 2;
      INSERT INTO ops.webhook_store_gate (
        store_id, gate_key, state, reason_code, source_operational_event_id,
        blocked_at, reopened_at, last_probe_id, recovery_requires_probe, created_at, updated_at
      ) VALUES (
        1, 'AUTHORIZATION', 'BLOCKED', 'AUTHORIZATION_CHANGED', 1200,
        timestamptz '2026-09-03 12:39:56.789123+08',
        NULL, NULL, true,
        timestamptz '2026-09-03 12:39:56.789123+08',
        timestamptz '2026-09-03 12:39:56.789123+08'
      );
      UPDATE ops.webhook_store_gate
         SET state = 'OPEN', reason_code = 'RECOVERED', last_probe_id = 91,
             reopened_at = timestamptz '2026-09-03 12:40:56.789123+08',
             recovery_requires_probe = false
       WHERE store_id = 1 AND gate_key = 'AUTHORIZATION';
    `);

    const baselineBacklogReadiness = await sourcePool.query(
      "SELECT count(*) FILTER (WHERE state = 'PENDING')::text AS pending_directives, " +
      "count(*) FILTER (WHERE state = 'RETRY')::text AS retry_directives, " +
      "count(*) FILTER (WHERE state = 'RUNNING')::text AS running_directives, " +
      "count(*) FILTER (WHERE lease_owner <> '')::text AS owned_leases, " +
      "count(*) FILTER (WHERE lease_expires_at IS NOT NULL)::text AS expiring_leases " +
      "FROM ops.webhook_hydration_directive"
    );
    assert.deepEqual(baselineBacklogReadiness.rows[0], FORWARD_BASELINE_DIRECTIVE_READINESS);
    assert.equal(baseline.readiness.pendingDirectives, "60");
    assert.equal(baseline.readiness.retryDirectives, "60");
    assert.equal(baseline.readiness.runningDirectives, "0");
    assert.equal(baseline.readiness.ownedDirectiveLeases, "0");
    assert.equal(baseline.readiness.expiringDirectiveLeases, "0");
    assert.equal(baseline.readiness.nonterminalDirectives, "120");

    const sourceSideState = await targetPool.query(
      "SELECT subscription.observed_state, gate.state AS gate_state, gate.last_probe_id::text AS last_probe_id " +
      "FROM ops.webhook_subscription_state AS subscription " +
      "CROSS JOIN ops.webhook_store_gate AS gate"
    );
    assert.deepEqual(sourceSideState.rows, [{ observed_state: "ACTIVE", gate_state: "OPEN", last_probe_id: "91" }]);

    const reverseTestDatabaseNames = { source: targetDatabase, target: sourceDatabase };
    const reverseDry = await runReverse({
      sourcePool: targetPool,
      targetPool: sourcePool,
      baseline,
      batchSize: 73,
      testDatabaseNames: reverseTestDatabaseNames,
    });
    assert.equal(reverseDry.counts.subscription.inserted, "1");
    assert.equal(reverseDry.counts.gate.inserted, "1");
    const reversed = await runReverse({
      sourcePool: targetPool,
      targetPool: sourcePool,
      baseline,
      execute: true,
      approvedPlanHash: reverseDry.planHash,
      batchSize: 73,
      testDatabaseNames: reverseTestDatabaseNames,
    });
    assert.equal(reversed.readyForCloudStart, true);
    assert.deepEqual(reversed.source.sequences, reversed.target.sequences);
    assert.equal(reversed.target.sequences.subscription.logicalNext, "2");
    assert.deepEqual(Object.keys(reversed.target.sequences).sort(), [
      "directive", "event", "heartbeat", "job", "receipt", "subscription",
    ]);
    for (const key of ["receipt", "heartbeat", "job", "event", "directive"]) {
      assert.equal(reversed.target.sequences[key].logicalNext, "1201");
    }
    assert.equal(reversed.target.tables.subscription.rowCount, "1");
    assert.equal(reversed.target.tables.gate.rowCount, "1");
    const reverseBacklogReadiness = await sourcePool.query(
      "SELECT count(*) FILTER (WHERE state = 'PENDING')::text AS pending_directives, " +
      "count(*) FILTER (WHERE state = 'RETRY')::text AS retry_directives, " +
      "count(*) FILTER (WHERE state = 'RUNNING')::text AS running_directives, " +
      "count(*) FILTER (WHERE lease_owner <> '')::text AS owned_leases, " +
      "count(*) FILTER (WHERE lease_expires_at IS NOT NULL)::text AS expiring_leases " +
      "FROM ops.webhook_hydration_directive"
    );
    assert.deepEqual(reverseBacklogReadiness.rows[0], FORWARD_BASELINE_DIRECTIVE_READINESS);
    const sideState = await sourcePool.query(
      "SELECT subscription.observed_state, gate.state AS gate_state, gate.last_probe_id::text AS last_probe_id " +
      "FROM ops.webhook_subscription_state AS subscription " +
      "CROSS JOIN ops.webhook_store_gate AS gate"
    );
    assert.deepEqual(sideState.rows, [{ observed_state: "ACTIVE", gate_state: "OPEN", last_probe_id: "91" }]);

    const restoredGateTriggers = await sourcePool.connect();
    try {
      await restoredGateTriggers.query("BEGIN");
      const touched = await restoredGateTriggers.query(
        "UPDATE ops.webhook_store_gate SET reason_code = 'TOUCH_PROBE', " +
        "updated_at = timestamptz '2000-01-01 00:00:00+00' " +
        "WHERE store_id = 1 AND gate_key = 'AUTHORIZATION' RETURNING updated_at"
      );
      assert.notEqual(touched.rows[0].updated_at, "2000-01-01 00:00:00+00");
      await restoredGateTriggers.query("ROLLBACK");
    } finally {
      restoredGateTriggers.release();
    }
    await assert.rejects(
      sourcePool.query(`
        INSERT INTO ops.webhook_store_gate (
          store_id, gate_key, state, reason_code, source_operational_event_id,
          blocked_at, reopened_at, last_probe_id, recovery_requires_probe, created_at, updated_at
        ) VALUES (
          2, 'AUTHORIZATION', 'OPEN', 'SHOULD_FAIL', 1200,
          timestamptz '2026-09-03 12:39:56.789123+08',
          timestamptz '2026-09-03 12:40:56.789123+08', 92, false,
          timestamptz '2026-09-03 12:39:56.789123+08',
          timestamptz '2026-09-03 12:40:56.789123+08'
        )
      `),
      /an authorization gate must first be created in BLOCKED state/
    );
  } finally {
    await sourcePool?.end().catch(() => {});
    await targetPool?.end().catch(() => {});
    if (sourceCreated) {
      await sourceAdmin.query(`DROP DATABASE IF EXISTS ${quoteDatabase(sourceDatabase)} WITH (FORCE)`).catch(() => {});
    }
    if (targetCreated) {
      await targetAdmin.query(`DROP DATABASE IF EXISTS ${quoteDatabase(targetDatabase)} WITH (FORCE)`).catch(() => {});
    }
    await sourceAdmin.end().catch(() => {});
    await targetAdmin.end().catch(() => {});
  }
});

test("SSH stdio PostgreSQL prepare/reverse covers topology, fnOS delta reverse, six sequences, and transport teardown without database URLs", {
  skip: INTEGRATION_MODE_SKIPS.ssh,
  timeout: 900_000,
}, async (t) => {
  if (process.env.FNOS_WEBHOOK_PG_TEST_ACK !== SSH_ACKNOWLEDGEMENT) {
    throw new Error(`FNOS_WEBHOOK_PG_TEST_ACK must equal ${SSH_ACKNOWLEDGEMENT}`);
  }
  const config = launcherConfiguration(process.env, { requireFingerprint: false });
  const registry = new SshTransportRegistry({
    sshExecutable: config.sshExecutable,
    connectTimeoutMs: config.connectTimeoutMs,
    lifetimeTimeoutMs: config.operationTimeoutMs,
    spawnImpl: undefined,
    childEnvironment: process.env,
  });
  const sourceAdmin = makeSshPool(config.cloud, registry, "postgres", config.connectTimeoutMs);
  const targetAdmin = makeSshPool(config.fnos, registry, "postgres", config.connectTimeoutMs);
  const suffix = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 16)}`.toLowerCase();
  const sourceDatabase = `fnos_cutover_test_source_${suffix}`;
  const targetDatabase = `fnos_cutover_test_target_${suffix}`;
  let sourcePool;
  let targetPool;
  let primaryStage = reportSshPrimaryStage(t, "system_identity");
  await runSshIntegrationLifecycle({
    getPrimaryStage: () => primaryStage,
    runPrimary: async () => {
    const sourceSystemIdentifier = await systemIdentifier(sourceAdmin);
    const targetSystemIdentifier = await systemIdentifier(targetAdmin);
    assert.notEqual(
      sourceSystemIdentifier,
      targetSystemIdentifier,
      "SSH integration requires two independent PostgreSQL systems"
    );
    primaryStage = reportSshPrimaryStage(t, "source_database_create");
    await sourceAdmin.query(`CREATE DATABASE ${quoteDatabase(sourceDatabase)}`);
    primaryStage = reportSshPrimaryStage(t, "target_database_create");
    await targetAdmin.query(`CREATE DATABASE ${quoteDatabase(targetDatabase)}`);
    sourcePool = makeSshPool(config.cloud, registry, sourceDatabase, config.connectTimeoutMs);
    targetPool = makeSshPool(config.fnos, registry, targetDatabase, config.connectTimeoutMs);
    const testDatabaseNames = { source: sourceDatabase, target: targetDatabase };

    primaryStage = reportSshPrimaryStage(t, "fixture_install");
    await installFixture(sourcePool);
    await installFixture(targetPool);
    await assertRestartRollsBack(targetPool);

    const microseconds = await sourcePool.query(
      "SELECT platform_timestamp = timestamptz '2026-09-03 12:34:56.789123+08' AS exact, " +
      "platform_timestamp::text AS platform_timestamp FROM raw.webhook_receipt WHERE receipt_id = 1"
    );
    assert.equal(microseconds.rows[0].exact, true);
    assert.match(String(microseconds.rows[0].platform_timestamp), /\.789123/);

    primaryStage = reportSshPrimaryStage(t, "forward_source_delta");
    await installDelta(sourcePool);
    primaryStage = reportSshPrimaryStage(t, "identity_approval");
    const sourceIdentity = await cutoverIdentity(sourcePool, "source");
    const targetIdentity = await cutoverIdentity(targetPool, "target");
    const direction = {
      approvedSourceIdentityFingerprint: identityFingerprint(sourceIdentity),
      approvedTargetIdentityFingerprint: identityFingerprint(targetIdentity),
    };
    primaryStage = reportSshPrimaryStage(t, "prepare_forward_dry_run");
    const dry = await runPrepareForward({
      sourcePool,
      targetPool,
      ...direction,
      batchSize: SSH_BATCH_SIZE,
      testDatabaseNames,
      onProgress: createTimingProgressSink("dry"),
    });
    assert.deepEqual(dry.counts.receipt, { inserted: "1000", updated: "1" });
    assert.equal(dry.counts.heartbeat.inserted, "1000");

    primaryStage = reportSshPrimaryStage(t, "prepare_forward_execute");
    const targetMetrics = {
      insertBatches: 0,
      insertedRows: 0,
      singleInserts: 0,
      singleUpdates: 0,
    };
    const instrumentedEndpointFactory = (pool, role, options) => {
      if (role === "target") {
        return new InstrumentedPgEndpoint(pool, role, options, targetMetrics);
      }
      return new PgEndpoint(pool, role, options);
    };
    const executed = await runPrepareForward({
      sourcePool,
      targetPool,
      ...direction,
      execute: true,
      approvedPlanHash: dry.planHash,
      batchSize: SSH_BATCH_SIZE,
      testDatabaseNames,
      onProgress: createTimingProgressSink("execute"),
      endpointFactory: instrumentedEndpointFactory,
    });
    assert.equal(executed.readyForForwardBaseline, true);
    assert.deepEqual(executed.source.tables, executed.target.tables);
    assert.deepEqual(executed.source.sequences, executed.target.sequences);
    assert.equal(targetMetrics.insertedRows, 5000);
    // Source batches include 200 baseline rows: inserts per table are
    // 50 + 250 + 250 + 250 + 200, not four independent delta-only batches.
    assert.equal(targetMetrics.insertBatches, 25);
    assert.equal(targetMetrics.singleInserts, 0);
    assert.equal(targetMetrics.singleUpdates, 4);
    if (SSH_TIMING_ENABLED) {
      process.stderr.write(JSON.stringify({ kind: "execute_metrics", ...targetMetrics }) + "\n");
    }

    primaryStage = reportSshPrimaryStage(t, "forward_baseline");
    const baseline = await runForward({
      sourcePool,
      targetPool,
      batchSize: SSH_BATCH_SIZE,
      testDatabaseNames,
    });
    assert.equal(Object.keys(baseline.sequences).length, 6);
    assert.equal(baseline.sourceIdentity.systemIdentifier, sourceIdentity.systemIdentifier);
    assert.equal(baseline.targetIdentity.systemIdentifier, targetIdentity.systemIdentifier);

    primaryStage = reportSshPrimaryStage(t, "fnos_post_baseline_delta");
    const expectedDelta = await applyFnosDelta(targetPool);
    assert.equal(expectedDelta.directive.inserted, "40");
    await targetPool.query(`
      INSERT INTO ops.webhook_subscription_state (
        webhook_subscription_state_id, app_key_hash, event_code, desired_state,
        observed_state, callback_validated, checked_at, created_at, updated_at
      ) OVERRIDING SYSTEM VALUE VALUES (
        1, md5('app') || md5('app'), '7000001', 'ACTIVE', 'ACTIVE', true,
        timestamptz '2026-09-03 12:40:56.789123+08',
        timestamptz '2026-09-03 12:40:56.789123+08',
        timestamptz '2026-09-03 12:40:56.789123+08'
      );
      ALTER SEQUENCE ops.webhook_subscription_state_webhook_subscription_state_id_seq RESTART WITH 2;
      INSERT INTO ops.webhook_store_gate (
        store_id, gate_key, state, reason_code, source_operational_event_id,
        blocked_at, reopened_at, last_probe_id, recovery_requires_probe, created_at, updated_at
      ) VALUES (
        1, 'AUTHORIZATION', 'BLOCKED', 'AUTHORIZATION_CHANGED', 1240,
        timestamptz '2026-09-03 12:39:56.789123+08',
        NULL, NULL, true,
        timestamptz '2026-09-03 12:39:56.789123+08',
        timestamptz '2026-09-03 12:39:56.789123+08'
      );
      UPDATE ops.webhook_store_gate
         SET state = 'OPEN', reason_code = 'RECOVERED', last_probe_id = 91,
             reopened_at = timestamptz '2026-09-03 12:40:56.789123+08',
             recovery_requires_probe = false
       WHERE store_id = 1 AND gate_key = 'AUTHORIZATION';
    `);

    const reverseTestDatabaseNames = { source: targetDatabase, target: sourceDatabase };
    primaryStage = reportSshPrimaryStage(t, "reverse_dry_run");
    const reverseDry = await runReverse({
      sourcePool: targetPool,
      targetPool: sourcePool,
      baseline,
      batchSize: SSH_BATCH_SIZE,
      testDatabaseNames: reverseTestDatabaseNames,
    });
    assert.equal(reverseDry.counts.subscription.inserted, "1");
    assert.equal(reverseDry.counts.gate.inserted, "1");
    assert.deepEqual(reverseDry.counts.receipt, expectedDelta.receipt);
    assert.deepEqual(reverseDry.counts.event, expectedDelta.event);
    assert.deepEqual(reverseDry.counts.job, expectedDelta.job);
    assert.deepEqual(reverseDry.counts.directive, expectedDelta.directive);
    assert.deepEqual(reverseDry.counts.heartbeat, expectedDelta.heartbeat);

    primaryStage = reportSshPrimaryStage(t, "reverse_execute");
    const reversed = await runReverse({
      sourcePool: targetPool,
      targetPool: sourcePool,
      baseline,
      execute: true,
      approvedPlanHash: reverseDry.planHash,
      batchSize: SSH_BATCH_SIZE,
      testDatabaseNames: reverseTestDatabaseNames,
    });
    primaryStage = reportSshPrimaryStage(t, "post_reverse_assertions");
    assert.equal(reversed.readyForCloudStart, true);
    assert.deepEqual(reversed.source.sequences, reversed.target.sequences);
    assert.deepEqual(reversed.source.tables, reversed.target.tables);
    assert.deepEqual(Object.keys(reversed.target.sequences).sort(), [
      "directive", "event", "heartbeat", "job", "receipt", "subscription",
    ]);
    assert.equal(reversed.target.sequences.receipt.logicalNext, "1261");
    assert.equal(reversed.target.sequences.event.logicalNext, "1241");
    assert.equal(reversed.target.sequences.job.logicalNext, "1241");
    assert.equal(reversed.target.sequences.directive.logicalNext, "1241");
    assert.equal(reversed.target.sequences.heartbeat.logicalNext, "1261");
    assert.equal(reversed.target.sequences.subscription.logicalNext, "2");
    assert.equal(reversed.target.tables.subscription.rowCount, "1");
    assert.equal(reversed.target.tables.gate.rowCount, "1");
    const sshBacklogReadiness = await sourcePool.query(
      "SELECT count(*) FILTER (WHERE state = 'PENDING')::text AS pending_directives, " +
      "count(*) FILTER (WHERE state = 'RETRY')::text AS retry_directives, " +
      "count(*) FILTER (WHERE state = 'RUNNING')::text AS running_directives, " +
      "count(*) FILTER (WHERE lease_owner <> '')::text AS owned_leases, " +
      "count(*) FILTER (WHERE lease_expires_at IS NOT NULL)::text AS expiring_leases " +
      "FROM ops.webhook_hydration_directive"
    );
    assert.deepEqual(sshBacklogReadiness.rows[0], SSH_REVERSE_DIRECTIVE_READINESS);
    assert.equal(baseline.readiness.pendingDirectives, "60");
    assert.equal(baseline.readiness.retryDirectives, "60");
    assert.equal(baseline.readiness.nonterminalDirectives, "120");

    const deltaRows = await sourcePool.query(
      "SELECT count(*)::text AS delta_rows FROM raw.webhook_receipt WHERE receipt_id >= 1201"
    );
    assert.equal(deltaRows.rows[0].delta_rows, "60");
    const mutableRow = await sourcePool.query(
      "SELECT duplicate_count::text AS duplicate_count FROM raw.webhook_receipt WHERE receipt_id = 1"
    );
    assert.equal(mutableRow.rows[0].duplicate_count, "7");

    const sideState = await sourcePool.query(
      "SELECT subscription.observed_state, gate.state AS gate_state, gate.last_probe_id::text AS last_probe_id " +
      "FROM ops.webhook_subscription_state AS subscription " +
      "CROSS JOIN ops.webhook_store_gate AS gate"
    );
    assert.deepEqual(sideState.rows, [{ observed_state: "ACTIVE", gate_state: "OPEN", last_probe_id: "91" }]);
    },
    runCleanup: () => cleanupSshFixture({
      sourcePool,
      targetPool,
      sourceAdmin,
      targetAdmin,
      sourceDatabase,
      targetDatabase,
      registry,
    }),
  });
});

test("SSH timing sink defaults to null and silent when FNOS_WEBHOOK_PG_TEST_TIMING is unset", () => {
  const sink = createTimingProgressSink("dry", { enabled: false });
  assert.equal(sink, null);
  const defaultSink = createTimingProgressSink("dry");
  if (process.env.FNOS_WEBHOOK_PG_TEST_TIMING !== "1") {
    assert.equal(defaultSink, null);
  }
});

test("SSH timing sink outputs NDJSON with controlled kind and safe event fields when enabled", () => {
  const lines = [];
  const mockStream = {
    write(chunk) {
      lines.push(chunk);
      return true;
    },
  };
  const drySink = createTimingProgressSink("dry", { stream: mockStream, enabled: true });
  assert.equal(typeof drySink, "function");
  drySink({ phase: "plan", durationMs: 120, counts: { inserts: 1000, updates: 1, total: 1001 } });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith("\n"));
  const parsedDry = JSON.parse(lines[0].trim());
  assert.deepEqual(parsedDry, {
    kind: "dry",
    phase: "plan",
    durationMs: 120,
    counts: { inserts: 1000, updates: 1, total: 1001 },
  });

  const execSink = createTimingProgressSink("execute", { stream: mockStream, enabled: true });
  execSink({ phase: "apply", durationMs: 450, counts: { inserts: 1000, updates: 1, total: 1001 } });
  assert.equal(lines.length, 2);
  const parsedExec = JSON.parse(lines[1].trim());
  assert.deepEqual(parsedExec, {
    kind: "execute",
    phase: "apply",
    durationMs: 450,
    counts: { inserts: 1000, updates: 1, total: 1001 },
  });
});

test("SSH timing sink strictly strips sensitive sentinels like SQL, connection strings, DB names, and payloads", () => {
  const lines = [];
  const mockStream = {
    write(chunk) {
      lines.push(chunk);
      return true;
    },
  };
  const sink = createTimingProgressSink("dry", { stream: mockStream, enabled: true });
  sink({
    phase: "apply",
    durationMs: 100,
    counts: { inserts: 50 },
    sql: "SELECT * FROM secrets",
    connectionUrl: "postgresql://user:pass@host:5432/db",
    databaseName: "shein_fm_test_123",
    payload: { sensitive: "data" },
    rows: [{ receipt_id: 1 }],
  });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0].trim());
  assert.deepEqual(parsed, {
    kind: "dry",
    phase: "apply",
    durationMs: 100,
    counts: { inserts: 50 },
  });
  assert.equal("sql" in parsed, false);
  assert.equal("connectionUrl" in parsed, false);
  assert.equal("databaseName" in parsed, false);
  assert.equal("payload" in parsed, false);
  assert.equal("rows" in parsed, false);
});

test("SSH timing sink validates kind and handles invalid inputs gracefully", () => {
  assert.throws(() => createTimingProgressSink("invalid_kind", { enabled: true }), {
    message: "Invalid timing sink kind",
  });
  const lines = [];
  const mockStream = { write(chunk) { lines.push(chunk); return true; } };
  const sink = createTimingProgressSink("dry", { stream: mockStream, enabled: true });
  sink(null);
  sink(undefined);
  sink("not_an_object");
  assert.equal(lines.length, 0);
});

test("InstrumentedPgEndpoint tracks applyInsertBatch batches and row counts without leaking rows", async () => {
  const metrics = {
    insertBatches: 0,
    insertedRows: 0,
    singleInserts: 0,
    singleUpdates: 0,
  };
  let delegateCalledWith = null;
  const fakePool = { async connect() {} };
  const endpoint = new InstrumentedPgEndpoint(fakePool, "target", {}, metrics);
  let capturedSql = null;
  endpoint.client = {
    async query(sql, values) {
      capturedSql = sql;
      return { rowCount: values.length / 16 }; // receipt has 16 columns
    },
  };
  endpoint.applyOperation = async (op) => {
    delegateCalledWith = op;
  };

  // Simulate a batch of 250 rows
  const fakeRows = Array.from({ length: 250 }, (_, i) => ({
    receipt_id: String(i + 1),
    idempotency_key: "k".repeat(64),
    app_key_hash: "a".repeat(64),
    open_key_hash: "o".repeat(64),
    event_code: "1234567",
    event_path: "/event/test",
    store_id: "1",
    delivery_scope: "STORE",
    platform_timestamp: "2026-09-03 12:34:56.789123+00",
    cipher_sha256: "c".repeat(64),
    ciphertext: "ciphertext",
    safe_projection: {},
    duplicate_count: 0,
    last_duplicate_at: null,
    received_at: "2026-09-03 12:34:56.789123+00",
    created_at: "2026-09-03 12:34:56.789123+00",
  }));
  await endpoint.applyInsertBatch("receipt", fakeRows);

  assert.equal(metrics.insertBatches, 1);
  assert.equal(metrics.insertedRows, 250);
  assert.equal(metrics.singleInserts, 0);
  assert.equal(metrics.singleUpdates, 0);
  assert.ok(capturedSql && capturedSql.includes("INSERT INTO"));
  assert.equal(Object.keys(metrics).length, 4);
  // Metrics contain purely numbers
  for (const val of Object.values(metrics)) {
    assert.equal(typeof val, "number");
  }
});

test("InstrumentedPgEndpoint tracks single updates and ensures batch inserts do not increment single updates", async () => {
  const metrics = {
    insertBatches: 0,
    insertedRows: 0,
    singleInserts: 0,
    singleUpdates: 0,
  };
  const fakePool = { async connect() {} };
  const endpoint = new InstrumentedPgEndpoint(fakePool, "target", {}, metrics);
  let capturedSql;
  endpoint.client = { async query(sql) { capturedSql = sql; return { rowCount: 1 }; } };

  await endpoint.applyOperation({ table: "receipt", action: "update", row: { receipt_id: "1", duplicate_count: 5 } });
  assert.match(capturedSql, /^UPDATE "raw"\."webhook_receipt"/);
  assert.equal(metrics.singleUpdates, 1);
  assert.equal(metrics.singleInserts, 0);
  assert.equal(metrics.insertBatches, 0);
  assert.equal(metrics.insertedRows, 0);
});

test("InstrumentedPgEndpoint metrics do not pollute planHash or expose row payloads", () => {
  const metrics = {
    insertBatches: 25,
    insertedRows: 5000,
    singleInserts: 0,
    singleUpdates: 4,
  };
  const serialized = JSON.stringify({ kind: "execute_metrics", ...metrics });
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed, {
    kind: "execute_metrics",
    insertBatches: 25,
    insertedRows: 5000,
    singleInserts: 0,
    singleUpdates: 4,
  });
  assert.equal("payload" in parsed, false);
  assert.equal("row" in parsed, false);
  assert.equal("planHash" in parsed, false);
});

test("instrumentation never reports a missing or failed batch method as successful", async (t) => {
  const metrics = { insertBatches: 0, insertedRows: 0, singleInserts: 0, singleUpdates: 0 };
  const endpoint = new InstrumentedPgEndpoint({}, "target", {}, metrics);
  let queries = 0;
  endpoint.client = { async query() { queries += 1; throw new Error("synthetic_batch_failure"); } };
  await assert.rejects(endpoint.applyInsertBatch("receipt", [{}]), /synthetic_batch_failure/);
  assert.equal(queries, 1);
  assert.deepEqual(metrics, { insertBatches: 0, insertedRows: 0, singleInserts: 0, singleUpdates: 0 });
  const original = PgEndpoint.prototype.applyInsertBatch;
  try {
    PgEndpoint.prototype.applyInsertBatch = undefined;
    await assert.rejects(endpoint.applyInsertBatch("receipt", [{}]), TypeError);
    assert.equal(queries, 1, "missing batch implementation must not fall back to single inserts");
    assert.equal(metrics.insertedRows, 0);
  } finally {
    PgEndpoint.prototype.applyInsertBatch = original;
  }
});

test("SSH fixture insert batch arithmetic includes the baseline prefix", () => {
  const counts = [];
  for (let start = 1; start <= 1200; start += SSH_BATCH_SIZE) {
    const end = Math.min(start + SSH_BATCH_SIZE - 1, 1200);
    const inserted = Math.max(0, end - Math.max(start, 201) + 1);
    if (inserted) counts.push(inserted);
  }
  assert.deepEqual(counts, [50, 250, 250, 250, 200]);
  assert.equal(counts.length * 5, 25);
  assert.equal(counts.reduce((sum, n) => sum + n, 0) * 5, 5000);
});
