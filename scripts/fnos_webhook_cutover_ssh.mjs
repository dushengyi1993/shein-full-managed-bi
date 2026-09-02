#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve as resolvePath, relative as relativePath, sep as pathSeparator } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import pg from "pg";

import {
  CUTOVER_APPLICATION_NAME,
  PgEndpoint,
  WebhookCutoverError,
  createTimestampPreservingTypes,
  identityFingerprint,
  main as coreMain,
  parseArguments,
  runIdentityInspection,
} from "./fnos_webhook_cutover.mjs";

const { Pool } = pg;
const DATABASE_USER = "sheinfm";
const DATABASE_NAME = "shein_fm";
const DATABASE_HOST = "127.0.0.1";
const DATABASE_PORT = 5432;
const CONTAINER_NAME = "shein-fm-db";
const STDERR_LIMIT = 8192;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 7_200_000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const SIGNAL_PATTERN = /^SIG[A-Z0-9]{1,30}$/;
const SSH_TOPOLOGIES = Object.freeze(["cloud", "fnos"]);
const SSH_EXIT_KINDS = Object.freeze([
  "exit",
  "signal",
  "stdout_eof",
  "spawn_error",
  "stdout_error",
  "stdin_error",
  "timeout",
  "unknown",
]);
const SSH_TRANSPORT_DIAGNOSTIC_KEYS = Object.freeze([
  "topology",
  "generation",
  "exitKind",
  "exitCode",
  "signal",
  "stderrCapturedBytes",
  "stderrTotalBytes",
  "stderrTruncated",
  "stderrSha256",
]);

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function sanitizeSshTransportDiagnostics(value) {
  if (!hasExactKeys(value, SSH_TRANSPORT_DIAGNOSTIC_KEYS)) return null;
  const topology = String(value.topology);
  const generation = String(value.generation);
  const exitKind = String(value.exitKind);
  const { exitCode, signal } = value;
  if (!SSH_TOPOLOGIES.includes(topology) || generation.length > 16 || !POSITIVE_DECIMAL_PATTERN.test(generation) ||
      BigInt(generation) > BigInt(Number.MAX_SAFE_INTEGER) || !SSH_EXIT_KINDS.includes(exitKind)) {
    return null;
  }
  if (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) return null;
  if (signal !== null && (typeof signal !== "string" || !SIGNAL_PATTERN.test(signal))) return null;
  if (exitKind === "exit" && (exitCode === null || signal !== null)) return null;
  if (exitKind === "signal" && (exitCode !== null || signal === null)) return null;
  if (exitKind !== "exit" && exitKind !== "signal" && (exitCode !== null || signal !== null)) return null;
  if (!safeNonnegativeInteger(value.stderrCapturedBytes) || value.stderrCapturedBytes > STDERR_LIMIT ||
      !safeNonnegativeInteger(value.stderrTotalBytes) || value.stderrTotalBytes < value.stderrCapturedBytes ||
      typeof value.stderrTruncated !== "boolean" ||
      value.stderrTruncated !== (value.stderrTotalBytes > value.stderrCapturedBytes) ||
      typeof value.stderrSha256 !== "string" || !HASH_PATTERN.test(value.stderrSha256)) {
    return null;
  }
  return Object.freeze({
    topology,
    generation,
    exitKind,
    exitCode,
    signal,
    stderrCapturedBytes: value.stderrCapturedBytes,
    stderrTotalBytes: value.stderrTotalBytes,
    stderrTruncated: value.stderrTruncated,
    stderrSha256: value.stderrSha256,
  });
}

export class SshCutoverLauncherError extends Error {
  constructor(code, message, options = {}) {
    const errorOptions = options && typeof options === "object" && Object.hasOwn(options, "cause")
      ? { cause: options.cause }
      : undefined;
    super(message, errorOptions);
    this.name = "SshCutoverLauncherError";
    this.code = code;
    const transportDiagnostics = sanitizeSshTransportDiagnostics(options?.transportDiagnostics);
    if (transportDiagnostics) this.transportDiagnostics = transportDiagnostics;
  }
}

function fail(code, message, options = {}) {
  throw new SshCutoverLauncherError(code, message, options);
}

function boundedInteger(value, { label, minimum, maximum, fallback }) {
  const text = String(value ?? "").trim();
  if (!text && fallback !== undefined) return fallback;
  if (!/^[0-9]+$/.test(text)) fail("SSH_CONFIG_INVALID", `${label} must be an integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail("SSH_CONFIG_INVALID", `${label} is outside the audited range`);
  }
  return parsed;
}

function safeSshPath(raw, label, sshRoot) {
  if (!raw) fail("SSH_CONFIG_REQUIRED", `${label} is required`);
  let resolved;
  try {
    resolved = realpathSync(resolvePath(raw));
    if (!statSync(resolved).isFile()) fail("SSH_CONFIG_INVALID", `${label} is not a file`);
  } catch (error) {
    if (error instanceof SshCutoverLauncherError) throw error;
    fail("SSH_CONFIG_INVALID", `${label} cannot be resolved`, { cause: error });
  }
  const relative = relativePath(sshRoot, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${pathSeparator}`) || resolvePath(relative) === relative) {
    fail("SSH_CONFIG_INVALID", `${label} must be a file under the operator .ssh directory`);
  }
  return resolved;
}

function endpointFromEnvironment(environment, topology, sshRoot, { requireFingerprint }) {
  const prefix = `FNOS_WEBHOOK_SSH_${topology.toUpperCase()}_`;
  const host = String(environment[`${prefix}HOST`] ?? "").trim();
  const user = String(environment[`${prefix}USER`] ?? "").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host)) {
    fail("SSH_CONFIG_INVALID", `${prefix}HOST is not an audited hostname or IPv4 address`);
  }
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) {
    fail("SSH_CONFIG_INVALID", `${prefix}USER is invalid`);
  }
  const port = boundedInteger(environment[`${prefix}PORT`], {
    label: `${prefix}PORT`, minimum: 1, maximum: 65535,
  });
  const identityFile = safeSshPath(environment[`${prefix}IDENTITY_FILE`], `${prefix}IDENTITY_FILE`, sshRoot);
  const knownHostsFile = safeSshPath(environment[`${prefix}KNOWN_HOSTS_FILE`], `${prefix}KNOWN_HOSTS_FILE`, sshRoot);
  const approvedIdentityFingerprint = String(environment[`${prefix}IDENTITY_SHA256`] ?? "").trim();
  if (requireFingerprint && !HASH_PATTERN.test(approvedIdentityFingerprint)) {
    fail("SSH_IDENTITY_APPROVAL_REQUIRED", `${prefix}IDENTITY_SHA256 must be an approved lowercase SHA-256 fingerprint`);
  }
  return Object.freeze({
    topology,
    host,
    user,
    port,
    identityFile,
    knownHostsFile,
    approvedIdentityFingerprint: approvedIdentityFingerprint || null,
  });
}

export function buildSshArguments(endpoint, connectTimeoutMs) {
  const connectTimeoutSeconds = Math.max(1, Math.ceil(connectTimeoutMs / 1000));
  return Object.freeze([
    "-F", "NUL",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "ChallengeResponseAuthentication=no",
    "-o", "PubkeyAuthentication=yes",
    "-o", "PreferredAuthentications=publickey",
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "ForwardX11Trusted=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "GatewayPorts=no",
    "-o", "PermitLocalCommand=no",
    "-o", "LocalCommand=none",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ControlPersist=no",
    "-o", "ProxyCommand=none",
    "-o", "ProxyJump=none",
    "-o", "RequestTTY=no",
    "-o", "EscapeChar=none",
    "-o", "ConnectionAttempts=1",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", `ConnectTimeout=${connectTimeoutSeconds}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-o", "TCPKeepAlive=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${endpoint.knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=NUL",
    "-o", "LogLevel=ERROR",
    "-p", String(endpoint.port),
    "-i", endpoint.identityFile,
    "-l", endpoint.user,
    endpoint.host,
    "sudo", "-n", "docker", "exec", "-i", CONTAINER_NAME,
    "nc", DATABASE_HOST, String(DATABASE_PORT),
  ]);
}

function restrictedChildEnvironment(environment) {
  const allowed = ["SystemRoot", "WINDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "PROGRAMDATA"];
  return Object.fromEntries(allowed
    .filter((name) => typeof environment[name] === "string" && environment[name] !== "")
    .map((name) => [name, environment[name]]));
}

function isPostgresTerminateFrame(chunk) {
  return Buffer.isBuffer(chunk) && chunk.length === 5 && chunk[0] === 0x58 &&
    chunk[1] === 0 && chunk[2] === 0 && chunk[3] === 0 && chunk[4] === 4;
}

export class SshPgDuplex extends Duplex {
  constructor({
    sshExecutable,
    endpoint,
    generation,
    connectTimeoutMs,
    lifetimeTimeoutMs,
    spawnImpl = spawn,
    childEnvironment = process.env,
  }) {
    super({ allowHalfOpen: false, readableHighWaterMark: 64 * 1024, writableHighWaterMark: 64 * 1024 });
    const topology = String(endpoint?.topology ?? "");
    const generationText = String(generation);
    if (!SSH_TOPOLOGIES.includes(topology) || generationText.length > 16 || !POSITIVE_DECIMAL_PATTERN.test(generationText) ||
        BigInt(generationText) > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("SSH_STREAM_CONFIG_INVALID", "SSH PostgreSQL transport topology or generation is invalid");
    }
    this.sshExecutable = sshExecutable;
    this.endpoint = endpoint;
    this.topology = topology;
    this.fnosWebhookTransportGeneration = generationText;
    this.connectTimeoutMs = connectTimeoutMs;
    this.lifetimeTimeoutMs = lifetimeTimeoutMs;
    this.spawnImpl = spawnImpl;
    this.childEnvironment = restrictedChildEnvironment(childEnvironment);
    this.child = null;
    this.stdoutPaused = false;
    this.connected = false;
    this.stderrHash = createHash("sha256");
    this.stderrCapturedBytes = 0;
    this.stderrTotalBytes = 0;
    this.stderrTruncated = false;
    this.lifetimeTimer = null;
    this.gracefulTeardownRequested = false;
    this.stdoutEnded = false;
    this.readableEofSent = false;
    this.childExitCode = null;
    this.childSignal = null;
    this.childExited = false;
  }

  setNoDelay() {
    return this;
  }

  setKeepAlive() {
    return this;
  }

  connect(port, host) {
    if (this.child) fail("SSH_STREAM_STATE_INVALID", "SSH PostgreSQL stream was connected more than once");
    if (Number(port) !== DATABASE_PORT || String(host) !== DATABASE_HOST) {
      fail("SSH_DATABASE_ENDPOINT_INVALID", "PostgreSQL client attempted a non-loopback or non-5432 endpoint");
    }
    const args = buildSshArguments(this.endpoint, this.connectTimeoutMs);
    this.child = this.spawnImpl(this.sshExecutable, args, {
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.childEnvironment,
    });
    const child = this.child;
    if (!child.stdin || !child.stdout || !child.stderr) {
      this.destroy(new SshCutoverLauncherError("SSH_CHILD_STDIO_INVALID", "SSH child did not expose three pipes"));
      return this;
    }
    child.once("spawn", () => {
      if (this.destroyed) return;
      this.connected = true;
      this.lifetimeTimer = setTimeout(() => {
        const waitingForClose = (this.stdoutEnded || this.childExited) && !this.gracefulTeardownRequested;
        this.destroy(this.transportError(
          waitingForClose ? "SSH_CHILD_EXITED" : "SSH_CHILD_TIMEOUT",
          waitingForClose
            ? "SSH PostgreSQL child stdout ended while the transport was active"
            : "SSH PostgreSQL transport exceeded its audited lifetime",
          waitingForClose ? this.childExitMetadata() : { exitKind: "timeout", exitCode: null, signal: null },
        ));
      }, this.lifetimeTimeoutMs);
      this.lifetimeTimer.unref?.();
      this.emit("connect");
    });
    child.once("error", () => {
      this.destroy(this.transportError(
        "SSH_CHILD_SPAWN_FAILED",
        "SSH PostgreSQL child failed to start",
        { exitKind: "spawn_error", exitCode: null, signal: null },
      ));
    });
    child.stdout.on("data", (chunk) => {
      if (!this.push(chunk)) {
        child.stdout.pause();
        this.stdoutPaused = true;
      }
    });
    child.stdout.once("end", () => {
      this.stdoutEnded = true;
      // Active EOF waits for child close metadata; the existing lifetime timer bounds that wait.
      if (this.gracefulTeardownRequested) this.finishReadable();
    });
    child.stdout.once("error", () => {
      if (this.gracefulTeardownRequested) {
        this.finishReadable();
        return;
      }
      this.destroy(this.transportError(
        "SSH_CHILD_STDOUT_FAILED",
        "SSH PostgreSQL stdout failed",
        { exitKind: "stdout_error", exitCode: null, signal: null },
      ));
    });
    child.stdin.once("error", () => {
      if (!this.destroyed && !this.gracefulTeardownRequested) {
        this.destroy(this.transportError(
          "SSH_CHILD_STDIN_FAILED",
          "SSH PostgreSQL stdin failed",
          { exitKind: "stdin_error", exitCode: null, signal: null },
        ));
      }
    });
    child.stderr.on("data", (chunk) => this.captureStderr(chunk));
    child.once("exit", (code, signal) => this.recordChildExit(code, signal));
    child.once("close", (code, signal) => {
      this.recordChildExit(code, signal);
      this.clearLifetimeTimer();
      if (this.destroyed) return;
      if (this.gracefulTeardownRequested) {
        this.finishReadable();
        return;
      }
      this.destroy(this.transportError(
        "SSH_CHILD_EXITED",
        "SSH PostgreSQL child exited while the transport was active",
        this.childExitMetadata(),
      ));
    });
    return this;
  }

  clearLifetimeTimer() {
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    this.lifetimeTimer = null;
  }

  finishReadable() {
    if (this.readableEofSent || this.destroyed) return;
    this.readableEofSent = true;
    this.push(null);
  }

  recordChildExit(code, signal) {
    this.childExited = true;
    if (Number.isInteger(code) && code >= 0 && code <= 255) this.childExitCode = code;
    if (typeof signal === "string" && SIGNAL_PATTERN.test(signal)) this.childSignal = signal;
  }

  childExitMetadata() {
    if (this.childSignal !== null) {
      return { exitKind: "signal", exitCode: null, signal: this.childSignal };
    }
    if (this.childExitCode !== null) {
      return { exitKind: "exit", exitCode: this.childExitCode, signal: null };
    }
    return {
      exitKind: this.stdoutEnded ? "stdout_eof" : "unknown",
      exitCode: null,
      signal: null,
    };
  }

  captureStderr(chunk) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.stderrTotalBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stderrTotalBytes + value.length);
    const remaining = Math.max(0, STDERR_LIMIT - this.stderrCapturedBytes);
    if (remaining > 0) {
      const bounded = value.subarray(0, remaining);
      this.stderrHash.update(bounded);
      this.stderrCapturedBytes += bounded.length;
    }
    if (value.length > remaining) this.stderrTruncated = true;
  }

  transportDiagnostics({ exitKind = "unknown", exitCode = null, signal = null } = {}) {
    const copy = this.stderrHash.copy();
    const diagnostics = sanitizeSshTransportDiagnostics({
      topology: this.topology,
      generation: this.fnosWebhookTransportGeneration,
      exitKind,
      exitCode,
      signal,
      stderrCapturedBytes: this.stderrCapturedBytes,
      stderrTotalBytes: this.stderrTotalBytes,
      stderrTruncated: this.stderrTruncated,
      stderrSha256: copy.digest("hex"),
    });
    if (!diagnostics) fail("SSH_TRANSPORT_DIAGNOSTICS_INVALID", "SSH transport diagnostics could not be normalized");
    return diagnostics;
  }

  transportError(code, message, exitMetadata) {
    return new SshCutoverLauncherError(code, message, {
      transportDiagnostics: this.transportDiagnostics(exitMetadata),
    });
  }

  _read() {
    if (this.stdoutPaused && this.child?.stdout) {
      this.stdoutPaused = false;
      this.child.stdout.resume();
    }
  }

  _write(chunk, encoding, callback) {
    if (!this.connected || !this.child?.stdin || this.child.stdin.destroyed) {
      callback(new SshCutoverLauncherError("SSH_STREAM_NOT_CONNECTED", "SSH PostgreSQL stream is not writable"));
      return;
    }
    if (isPostgresTerminateFrame(chunk)) this.gracefulTeardownRequested = true;
    this.child.stdin.write(chunk, encoding, callback);
  }

  end(...args) {
    this.gracefulTeardownRequested = true;
    return super.end(...args);
  }

  _final(callback) {
    this.gracefulTeardownRequested = true;
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      this.finishReadable();
      callback();
      return;
    }
    this.child.stdin.end(callback);
  }

  _destroy(error, callback) {
    this.clearLifetimeTimer();
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    callback(error);
  }
}

export class SshTransportRegistry {
  constructor(options) {
    this.options = options;
    this.generation = 0;
    this.active = new Set();
  }

  create(endpoint) {
    this.generation += 1;
    const stream = new SshPgDuplex({
      ...this.options,
      endpoint,
      generation: this.generation,
    });
    this.active.add(stream);
    stream.once("close", () => this.active.delete(stream));
    return stream;
  }

  abortAll(error = null) {
    for (const stream of this.active) stream.destroy(error ?? undefined);
  }
}

export function buildPgPoolOptions(endpoint, registry, connectTimeoutMs) {
  return Object.freeze({
    user: DATABASE_USER,
    database: DATABASE_NAME,
    host: DATABASE_HOST,
    port: DATABASE_PORT,
    application_name: CUTOVER_APPLICATION_NAME,
    ssl: false,
    max: 1,
    min: 0,
    maxUses: 1,
    connectionTimeoutMillis: connectTimeoutMs,
    idleTimeoutMillis: 1_000,
    types: createTimestampPreservingTypes(),
    stream: () => registry.create(endpoint),
  });
}

class IdentityPinnedEndpoint extends PgEndpoint {
  constructor(pool, role, options, approvals) {
    super(pool, role, options);
    this.approvedIdentityFingerprint = approvals[role];
  }

  async readIdentity() {
    const identity = await super.readIdentity();
    if (identityFingerprint(identity) !== this.approvedIdentityFingerprint) {
      throw new WebhookCutoverError(
        "SSH_ENDPOINT_IDENTITY_MISMATCH",
        "SSH endpoint does not match its operator-approved stable database identity"
      );
    }
    return identity;
  }
}

export function launcherConfiguration(environment, { requireFingerprint }) {
  const userProfile = String(environment.USERPROFILE ?? "").trim();
  if (!userProfile) fail("SSH_CONFIG_REQUIRED", "USERPROFILE is required");
  let sshRoot;
  let sshExecutable;
  try {
    sshRoot = realpathSync(resolvePath(userProfile, ".ssh"));
    sshExecutable = realpathSync(resolvePath(String(environment.SystemRoot ?? "C:\\Windows"), "System32", "OpenSSH", "ssh.exe"));
  } catch (error) {
    fail("SSH_CONFIG_INVALID", "operator .ssh directory or Windows OpenSSH executable is unavailable", { cause: error });
  }
  const connectTimeoutMs = boundedInteger(environment.FNOS_WEBHOOK_SSH_CONNECT_TIMEOUT_MS, {
    label: "FNOS_WEBHOOK_SSH_CONNECT_TIMEOUT_MS",
    minimum: 1_000,
    maximum: 60_000,
    fallback: DEFAULT_CONNECT_TIMEOUT_MS,
  });
  const operationTimeoutMs = boundedInteger(environment.FNOS_WEBHOOK_SSH_OPERATION_TIMEOUT_MS, {
    label: "FNOS_WEBHOOK_SSH_OPERATION_TIMEOUT_MS",
    minimum: 60_000,
    maximum: 14_400_000,
    fallback: DEFAULT_OPERATION_TIMEOUT_MS,
  });
  const cloud = endpointFromEnvironment(environment, "cloud", sshRoot, { requireFingerprint });
  const fnos = endpointFromEnvironment(environment, "fnos", sshRoot, { requireFingerprint });
  if (cloud.host === fnos.host && cloud.port === fnos.port && cloud.user === fnos.user) {
    fail("SSH_ENDPOINT_COLLISION", "cloud and fnOS SSH endpoints are identical");
  }
  return Object.freeze({ sshExecutable, cloud, fnos, connectTimeoutMs, operationTimeoutMs });
}

export function mapCutoverTopology(config, mode) {
  if (!config?.cloud || !config?.fnos) {
    fail("SSH_TOPOLOGY_INVALID", "cloud and fnOS SSH endpoints are required");
  }
  if (mode === "reverse") {
    return Object.freeze({ source: config.fnos, target: config.cloud });
  }
  if (mode === "inspect-identities" || mode === "prepare-forward" || mode === "forward") {
    return Object.freeze({ source: config.cloud, target: config.fnos });
  }
  fail("SSH_TOPOLOGY_INVALID", "unsupported cutover topology mode");
}

function writeFailure(stderr, error) {
  const code = error instanceof WebhookCutoverError || error instanceof SshCutoverLauncherError
    ? error.code
    : "SSH_CUTOVER_LAUNCHER_FAILED";
  const transportDiagnostics = sanitizeSshTransportDiagnostics(error?.transportDiagnostics) ??
    sanitizeSshTransportDiagnostics(error?.cause?.transportDiagnostics);
  const failure = {
    ok: false,
    errorCode: code,
    outcome: code === "OUTCOME_UNVERIFIED" ? "outcome_unverified" : "failed_closed",
    readyForCloudStart: false,
    readyForForwardBaseline: false,
  };
  if (transportDiagnostics) failure.transportDiagnostics = transportDiagnostics;
  stderr.write(JSON.stringify(failure) + "\n");
}

export async function runSshLauncher({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  spawnImpl = spawn,
  PoolClass = Pool,
} = {}) {
  const inspectOnly = argv.length === 1 && argv[0] === "inspect-identities";
  let sourcePool;
  let targetPool;
  let registry;
  let operationTimer;
  try {
    const parsed = inspectOnly ? null : parseArguments(argv);
    const config = launcherConfiguration(environment, { requireFingerprint: !inspectOnly });
    const topology = mapCutoverTopology(config, inspectOnly ? "inspect-identities" : parsed.mode);
    const sourceEndpoint = topology.source;
    const targetEndpoint = topology.target;
    registry = new SshTransportRegistry({
      sshExecutable: config.sshExecutable,
      connectTimeoutMs: config.connectTimeoutMs,
      lifetimeTimeoutMs: config.operationTimeoutMs,
      spawnImpl,
      childEnvironment: environment,
    });
    sourcePool = new PoolClass(buildPgPoolOptions(sourceEndpoint, registry, config.connectTimeoutMs));
    targetPool = new PoolClass(buildPgPoolOptions(targetEndpoint, registry, config.connectTimeoutMs));
    operationTimer = setTimeout(() => {
      registry.abortAll(new SshCutoverLauncherError("SSH_OPERATION_TIMEOUT", "SSH cutover operation exceeded its audited timeout"));
    }, config.operationTimeoutMs);
    operationTimer.unref?.();

    if (inspectOnly) {
      const result = await runIdentityInspection({ sourcePool, targetPool });
      stdout.write(JSON.stringify({
        ok: true,
        operation: result.operation,
        cloud: result.source,
        fnos: result.target,
      }, null, 2) + "\n");
      return 0;
    }

    const approvals = {
      source: sourceEndpoint.approvedIdentityFingerprint,
      target: targetEndpoint.approvedIdentityFingerprint,
    };
    if (parsed.mode === "prepare-forward" &&
        (parsed.approvedSourceIdentityFingerprint !== approvals.source ||
         parsed.approvedTargetIdentityFingerprint !== approvals.target)) {
      fail("SSH_DIRECTION_APPROVAL_MISMATCH", "prepare-forward CLI approvals differ from the pinned SSH endpoint identities");
    }
    const endpointFactory = (pool, role, options) => new IdentityPinnedEndpoint(pool, role, options, approvals);
    return await coreMain({
      argv,
      environment: {
        ...environment,
        FNOS_WEBHOOK_SOURCE_DATABASE_URL: "postgresql://sheinfm@source.invalid:5432/shein_fm",
        FNOS_WEBHOOK_TARGET_DATABASE_URL: "postgresql://sheinfm@target.invalid:5432/shein_fm",
      },
      stdout,
      stderr,
      poolFactory: (role) => role === "source" ? sourcePool : targetPool,
      endpointFactory,
    });
  } catch (error) {
    writeFailure(stderr, error);
    return 1;
  } finally {
    if (operationTimer) clearTimeout(operationTimer);
    registry?.abortAll();
    await sourcePool?.end().catch(() => {});
    await targetPool?.end().catch(() => {});
  }
}

function isEntrypoint(entryPath = process.argv[1]) {
  if (!entryPath) return false;
  try {
    return realpathSync(resolvePath(entryPath)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  process.exitCode = await runSshLauncher();
}
