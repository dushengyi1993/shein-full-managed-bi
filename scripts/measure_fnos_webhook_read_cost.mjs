#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import {
  PgEndpoint,
  WebhookCutoverError,
  identityFingerprint,
} from "./fnos_webhook_cutover.mjs";
import {
  SshCutoverLauncherError,
  SshTransportRegistry,
  bindPoolErrorSafety,
  buildPgPoolOptions,
  launcherConfiguration,
  mapCutoverTopology,
} from "./fnos_webhook_cutover_ssh.mjs";

const { Pool } = pg;

export const DEFAULT_SAMPLE_CONFIG = Object.freeze({
  batchSize: 1000,
  digestBatchSize: 10000,
  maxRowsPerTable: 30000,
  sampleTables: Object.freeze(["receipt", "heartbeat"]),
  fullRowSampleTable: "receipt",
  maxFullRowSample: 1000,
  statementTimeoutMs: 30000,
  lockTimeoutMs: 2000,
  overallTimeoutMs: 180000,
  isolationLevel: "REPEATABLE READ READ ONLY",
});

export class ReadCostMeasurementError extends WebhookCutoverError {
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.name = "ReadCostMeasurementError";
  }
}

function fail(code, message, options = {}) {
  throw new ReadCostMeasurementError(code, message, options);
}

export function sanitizeSampleProgress(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const role = String(event.role ?? "");
  const table = String(event.table ?? "");
  const rowCount = Number(event.rowCount);
  const durationMs = Number(event.durationMs);

  if (role !== "cloud" && role !== "fnos") return null;
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) return null;
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) return null;

  if (table === "rowSample receipt") {
    const utf8JsonBytes = Number(event.utf8JsonBytes);
    if (!Number.isSafeInteger(utf8JsonBytes) || utf8JsonBytes < 0) return null;
    return Object.freeze({
      role,
      table,
      rowCount,
      utf8JsonBytes,
      durationMs,
    });
  }

  if (!DEFAULT_SAMPLE_CONFIG.sampleTables.includes(table)) return null;
  const page = Number(event.page);
  if (!Number.isSafeInteger(page) || page < 1) return null;

  return Object.freeze({
    role,
    table,
    page,
    rowCount,
    durationMs,
  });
}

export class ReadOnlySamplingEndpoint extends PgEndpoint {
  constructor(pool, role, {
    batchSize = DEFAULT_SAMPLE_CONFIG.batchSize,
    digestBatchSize = DEFAULT_SAMPLE_CONFIG.digestBatchSize,
    approvedIdentityFingerprint = null,
  } = {}) {
    super(pool, role, { batchSize, digestBatchSize });
    this.approvedIdentityFingerprint = approvedIdentityFingerprint;
  }

  async beginReadOnly() {
    if (this.client) fail("ENDPOINT_STATE_INVALID", "endpoint already owns a connection");
    this.client = await this.pool.connect();
    const transportGeneration = this.client.connection?.stream?.fnosWebhookTransportGeneration;
    this.transportGeneration = transportGeneration === undefined || transportGeneration === null
      ? null
      : String(transportGeneration);
    try {
      await this.client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      this.inTransaction = true;
      await this.client.query("SET LOCAL lock_timeout TO '2s'");
      await this.client.query("SET LOCAL statement_timeout TO '30s'");
      await this.client.query("SET LOCAL TIME ZONE 'UTC'");
      await this.client.query("SET LOCAL DateStyle TO 'ISO, YMD'");
    } catch (error) {
      await this.rollback().catch(() => {});
      this.release({ destroy: true });
      throw error;
    }
  }

  async assertApprovedIdentity() {
    const identity = await this.readIdentity();
    const fp = identityFingerprint(identity);
    if (!this.approvedIdentityFingerprint || fp !== this.approvedIdentityFingerprint) {
      fail("SSH_ENDPOINT_IDENTITY_MISMATCH", "endpoint database identity does not match approved fingerprint");
    }
    return identity;
  }

  async rollback() {
    if (!this.inTransaction || !this.client) return;
    try {
      await this.client.query("ROLLBACK");
    } finally {
      this.inTransaction = false;
    }
  }

  release({ destroy = false } = {}) {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.inTransaction = false;
    try {
      client.release(destroy);
    } catch {}
  }
}

export function parseReadCostArguments(argv) {
  let executeReadOnly = false;
  let fullRowSample = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--execute-read-only") {
      if (executeReadOnly) fail("DUPLICATE_ARGUMENT", "--execute-read-only was repeated");
      executeReadOnly = true;
      continue;
    }
    if (token === "--full-row-sample") {
      if (fullRowSample) fail("DUPLICATE_ARGUMENT", "--full-row-sample was repeated");
      fullRowSample = true;
      continue;
    }
    fail("INVALID_ARGUMENT", "unsupported argument");
  }
  if (fullRowSample && !executeReadOnly) {
    fail("INVALID_ARGUMENT", "--full-row-sample requires --execute-read-only");
  }
  return Object.freeze({ executeReadOnly, fullRowSample });
}

export async function sampleTableDigestRows({
  endpoint,
  role,
  tableKey,
  maxRows = DEFAULT_SAMPLE_CONFIG.maxRowsPerTable,
  digestBatchSize = DEFAULT_SAMPLE_CONFIG.digestBatchSize,
  onPage = null,
}) {
  let totalRows = 0;
  let pageIndex = 1;
  let pageRows = 0;
  let pageStart = Date.now();
  let totalDurationMs = 0;

  const iterator = endpoint.scanDigestEntries(tableKey)[Symbol.asyncIterator]();
  try {
    while (totalRows < maxRows) {
      const nextResult = await iterator.next();
      if (nextResult.done) break;
      pageRows += 1;
      totalRows += 1;

      if (pageRows === digestBatchSize || totalRows === maxRows) {
        const durationMs = Date.now() - pageStart;
        totalDurationMs += durationMs;
        const progressEvent = sanitizeSampleProgress({
          role,
          table: tableKey,
          page: pageIndex,
          rowCount: pageRows,
          durationMs,
        });
        if (progressEvent && typeof onPage === "function") {
          try {
            const maybePromise = onPage(progressEvent);
            if (maybePromise && typeof maybePromise.catch === "function") {
              maybePromise.catch(() => {});
            }
          } catch {}
        }
        pageIndex += 1;
        pageRows = 0;
        pageStart = Date.now();
      }
    }
  } finally {
    if (typeof iterator.return === "function") {
      await iterator.return().catch(() => {});
    }
  }

  if (pageRows > 0) {
    const durationMs = Date.now() - pageStart;
    totalDurationMs += durationMs;
    const progressEvent = sanitizeSampleProgress({
      role,
      table: tableKey,
      page: pageIndex,
      rowCount: pageRows,
      durationMs,
    });
    if (progressEvent && typeof onPage === "function") {
      try {
        const maybePromise = onPage(progressEvent);
        if (maybePromise && typeof maybePromise.catch === "function") {
          maybePromise.catch(() => {});
        }
      } catch {}
    }
  }

  return Object.freeze({
    role,
    table: tableKey,
    totalRows,
    pages: totalRows === 0 ? 0 : pageIndex - (pageRows === 0 ? 1 : 0),
    totalDurationMs,
  });
}

export async function sampleReceiptFullRows({
  endpoint,
  role,
  maxRows = DEFAULT_SAMPLE_CONFIG.maxFullRowSample,
  onPage = null,
}) {
  const boundedLimit = Math.min(DEFAULT_SAMPLE_CONFIG.maxFullRowSample, Math.max(1, Number(maxRows) || DEFAULT_SAMPLE_CONFIG.maxFullRowSample));
  const start = Date.now();

  const idResult = await endpoint.client.query(
    'SELECT "receipt_id" FROM "raw"."webhook_receipt" ORDER BY "receipt_id" DESC LIMIT $1',
    [boundedLimit]
  );

  if (!idResult.rows || idResult.rows.length === 0) {
    const durationMs = Date.now() - start;
    const emptyEvent = sanitizeSampleProgress({
      role,
      table: "rowSample receipt",
      rowCount: 0,
      utf8JsonBytes: 0,
      durationMs,
    });
    if (emptyEvent && typeof onPage === "function") {
      try { onPage(emptyEvent); } catch {}
    }
    return emptyEvent;
  }

  const sortedKeys = idResult.rows
    .map((r) => ({ receipt_id: String(r.receipt_id) }))
    .sort((a, b) => (BigInt(a.receipt_id) < BigInt(b.receipt_id) ? -1 : 1));

  const fullRows = await endpoint.fetchRowsByKeys("receipt", sortedKeys);
  const utf8JsonBytes = Buffer.byteLength(JSON.stringify(fullRows), "utf8");
  const durationMs = Date.now() - start;

  const progressEvent = sanitizeSampleProgress({
    role,
    table: "rowSample receipt",
    rowCount: fullRows.length,
    utf8JsonBytes,
    durationMs,
  });

  if (progressEvent && typeof onPage === "function") {
    try {
      const maybePromise = onPage(progressEvent);
      if (maybePromise && typeof maybePromise.catch === "function") {
        maybePromise.catch(() => {});
      }
    } catch {}
  }

  return progressEvent;
}

export async function runReadCostMeasurement({
  cloudEndpoint,
  fnosEndpoint,
  onPage = null,
  config = DEFAULT_SAMPLE_CONFIG,
  fullRowSample = false,
}) {
  const targets = [
    { role: "cloud", endpoint: cloudEndpoint },
    { role: "fnos", endpoint: fnosEndpoint },
  ];

  const samples = [];
  for (const target of targets) {
    await target.endpoint.beginReadOnly();
    try {
      await target.endpoint.assertApprovedIdentity();
      for (const tableKey of config.sampleTables) {
        const tableSample = await sampleTableDigestRows({
          endpoint: target.endpoint,
          role: target.role,
          tableKey,
          maxRows: config.maxRowsPerTable,
          digestBatchSize: config.digestBatchSize,
          onPage,
        });
        samples.push(tableSample);
      }
      if (fullRowSample) {
        const rowSample = await sampleReceiptFullRows({
          endpoint: target.endpoint,
          role: target.role,
          maxRows: config.maxFullRowSample,
          onPage,
        });
        if (rowSample) {
          samples.push(rowSample);
        }
      }
    } finally {
      await target.endpoint.rollback().catch(() => {});
      target.endpoint.release();
    }
  }

  return Object.freeze({
    ok: true,
    mode: "sample-complete",
    executeReadOnly: true,
    fullRowSample,
    config: Object.freeze({ ...config }),
    samples: Object.freeze(samples),
  });
}

export function isReadCostEntrypoint(entryPath = process.argv[1], moduleUrl = import.meta.url) {
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
  spawnImpl,
  PoolClass = Pool,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let cloudPool = null;
  let fnosPool = null;
  let registry = null;
  let overallTimer = null;

  try {
    const args = parseReadCostArguments(argv);
    if (!args.executeReadOnly) {
      stdout.write(JSON.stringify({
        ok: true,
        mode: "plan-only",
        executeReadOnly: false,
        fullRowSample: false,
        config: DEFAULT_SAMPLE_CONFIG,
        notice: "Pass --execute-read-only to run read-only sampling over configured SSH connections.",
      }, null, 2) + "\n");
      return 0;
    }

    const config = launcherConfiguration(environment, { requireFingerprint: true });
    registry = new SshTransportRegistry({
      sshExecutable: config.sshExecutable,
      connectTimeoutMs: config.connectTimeoutMs,
      lifetimeTimeoutMs: config.operationTimeoutMs,
      spawnImpl,
      childEnvironment: environment,
    });

    cloudPool = new PoolClass(buildPgPoolOptions(config.cloud, registry, config.connectTimeoutMs));
    fnosPool = new PoolClass(buildPgPoolOptions(config.fnos, registry, config.connectTimeoutMs));
    bindPoolErrorSafety(cloudPool, (error) => registry?.abortAll(error));
    bindPoolErrorSafety(fnosPool, (error) => registry?.abortAll(error));

    overallTimer = setTimeoutImpl(() => {
      registry?.abortAll(new ReadCostMeasurementError("READ_COST_TIMEOUT", "read-only sampling exceeded overall 180s budget"));
    }, DEFAULT_SAMPLE_CONFIG.overallTimeoutMs);
    overallTimer.unref?.();

    const cloudEndpoint = new ReadOnlySamplingEndpoint(cloudPool, "source", {
      batchSize: DEFAULT_SAMPLE_CONFIG.batchSize,
      digestBatchSize: DEFAULT_SAMPLE_CONFIG.digestBatchSize,
      approvedIdentityFingerprint: config.cloud.approvedIdentityFingerprint,
    });
    const fnosEndpoint = new ReadOnlySamplingEndpoint(fnosPool, "target", {
      batchSize: DEFAULT_SAMPLE_CONFIG.batchSize,
      digestBatchSize: DEFAULT_SAMPLE_CONFIG.digestBatchSize,
      approvedIdentityFingerprint: config.fnos.approvedIdentityFingerprint,
    });

    const onPage = (progressEvent) => {
      stderr.write(JSON.stringify(progressEvent) + "\n");
    };

    const result = await runReadCostMeasurement({
      cloudEndpoint,
      fnosEndpoint,
      onPage,
      config: DEFAULT_SAMPLE_CONFIG,
      fullRowSample: args.fullRowSample,
    });

    stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (error) {
    if (overallTimer) clearTimeoutImpl(overallTimer);
    registry?.abortAll();
    const code = error instanceof WebhookCutoverError ||
                 error instanceof SshCutoverLauncherError ||
                 error instanceof ReadCostMeasurementError
      ? error.code
      : "READ_COST_FAILED";
    stderr.write(JSON.stringify({
      ok: false,
      errorCode: code,
    }) + "\n");
    return 1;
  } finally {
    if (overallTimer) clearTimeoutImpl(overallTimer);
    registry?.abortAll();
    await cloudPool?.end().catch(() => {});
    await fnosPool?.end().catch(() => {});
  }
}

if (isReadCostEntrypoint()) {
  process.exitCode = await main();
}
