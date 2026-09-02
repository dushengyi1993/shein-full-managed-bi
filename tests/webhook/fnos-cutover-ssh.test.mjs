import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { CUTOVER_APPLICATION_NAME } from "../../scripts/fnos_webhook_cutover.mjs";
import {
  SshPgDuplex,
  SshTransportRegistry,
  buildPgPoolOptions,
  buildSshArguments,
  launcherConfiguration,
  mapCutoverTopology,
  sanitizeSshTransportDiagnostics,
} from "../../scripts/fnos_webhook_cutover_ssh.mjs";

const { Client, Pool } = pg;
const TRANSPORT_DIAGNOSTIC_KEYS = Object.freeze([
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

function endpoint(overrides = {}) {
  return {
    role: "source",
    topology: "cloud",
    host: "192.0.2.10",
    user: "sheinops",
    port: 443,
    identityFile: "C:\\Users\\operator\\.ssh\\cutover_ed25519",
    knownHostsFile: "C:\\Users\\operator\\.ssh\\known_hosts",
    approvedIdentityFingerprint: "a".repeat(64),
    ...overrides,
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.signalCode = "SIGTERM";
    return true;
  };
  return child;
}

function setChildExit(child, code, signal = null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
}

function postgresReadyFrames() {
  return Buffer.from([
    0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00,
    0x5a, 0x00, 0x00, 0x00, 0x05, 0x49,
  ]);
}

async function connectPgClientOverFakeChild({ child, topology = "cloud", generation }) {
  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint({ topology }),
    generation,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    childEnvironment: {},
    spawnImpl: () => child,
  });
  const client = new Client({
    user: "sheinfm",
    database: "shein_fm",
    host: "127.0.0.1",
    port: 5432,
    ssl: false,
    stream,
  });
  const clientErrors = [];
  client.on("error", (error) => clientErrors.push(error));
  child.stdin.resume();
  const connected = client.connect();
  child.emit("spawn");
  child.stdout.write(postgresReadyFrames());
  await connected;
  return { client, clientErrors, stream };
}

test("SSH argv is fixed, non-interactive, and contains only the audited remote command", () => {
  const args = buildSshArguments(endpoint(), 15_000);
  for (const option of [
    "BatchMode=yes",
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    "IdentityAgent=none",
    "ForwardAgent=no",
    "ForwardX11=no",
    "ClearAllForwardings=yes",
    "ControlMaster=no",
    "ControlPath=none",
    "ControlPersist=no",
    "ProxyCommand=none",
    "ProxyJump=none",
    "StrictHostKeyChecking=yes",
    "ConnectionAttempts=1",
  ]) {
    assert.ok(args.includes(option), `missing fixed SSH option ${option}`);
  }
  assert.equal(args.some((value) => ["-L", "-R", "-D", "-A", "-X", "-Y"].includes(value)), false);
  assert.deepEqual(args.slice(-10), [
    "192.0.2.10", "sudo", "-n", "docker", "exec", "-i", "shein-fm-db",
    "nc", "127.0.0.1", "5432",
  ]);
  assert.equal(args.includes("sh"), false);
  assert.equal(args.includes("-c"), false);
});

test("PostgreSQL pool is passwordless, fixed identity, single-use, and allocates fresh generations", () => {
  const registry = new SshTransportRegistry({
    sshExecutable: "ssh.exe",
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => fakeChild(),
    childEnvironment: {},
  });
  const options = buildPgPoolOptions(endpoint(), registry, 15_000);
  assert.equal(options.user, "sheinfm");
  assert.equal(options.database, "shein_fm");
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 5432);
  assert.equal(options.application_name, CUTOVER_APPLICATION_NAME);
  assert.equal(options.max, 1);
  assert.equal(options.min, 0);
  assert.equal(options.maxUses, 1);
  assert.equal(Object.hasOwn(options, "password"), false);
  const first = options.stream();
  const second = options.stream();
  assert.equal(first.fnosWebhookTransportGeneration, "1");
  assert.equal(second.fnosWebhookTransportGeneration, "2");
  first.destroy();
  second.destroy();
});

test("launcher topology fixes cloud as forward source and fnOS as reverse source", () => {
  const cloud = { topology: "cloud" };
  const fnos = { topology: "fnos" };
  const config = { cloud, fnos };
  for (const mode of ["inspect-identities", "prepare-forward", "forward"]) {
    assert.deepEqual(mapCutoverTopology(config, mode), { source: cloud, target: fnos });
  }
  assert.deepEqual(mapCutoverTopology(config, "reverse"), { source: fnos, target: cloud });
  assert.throws(() => mapCutoverTopology(config, "unsupported"), { code: "SSH_TOPOLOGY_INVALID" });
});

test("custom Duplex forwards bytes with backpressure and never exposes SSH stderr text", async () => {
  const child = fakeChild();
  let spawnCall = null;
  let spawnCount = 0;
  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 7,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    childEnvironment: {
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\operator",
      PROGRAMDATA: "C:\\ProgramData",
      PATH: "C:\\unsafe-bin",
      PGPASSWORD: "sensitive",
      DATABASE_URL: "postgresql://sensitive",
      token: "sensitive",
      TOKEN: "sensitive",
      SENTINEL: "sensitive",
      DATABASE_PASSWORD_SHOULD_NOT_REACH_CHILD: "sensitive",
    },
    spawnImpl: (executable, args, options) => {
      spawnCount += 1;
      spawnCall = { executable, args, options };
      return child;
    },
  });
  const connected = once(stream, "connect");
  stream.connect(5432, "127.0.0.1");
  child.emit("spawn");
  await connected;
  assert.equal(spawnCount, 1);
  assert.equal(spawnCall.options.shell, false);
  assert.equal(spawnCall.options.windowsHide, true);
  assert.equal(spawnCall.options.env.PROGRAMDATA, "C:\\ProgramData");
  assert.deepEqual(Object.keys(spawnCall.options.env).sort(), ["PROGRAMDATA", "SystemRoot", "USERPROFILE"]);
  for (const name of [
    "PATH", "PGPASSWORD", "DATABASE_URL", "token", "TOKEN", "SENTINEL",
    "DATABASE_PASSWORD_SHOULD_NOT_REACH_CHILD",
  ]) {
    assert.equal(Object.hasOwn(spawnCall.options.env, name), false, `${name} reached the SSH child`);
  }

  const written = once(child.stdin, "data");
  stream.write(Buffer.from("postgres-startup"));
  assert.equal((await written)[0].toString("utf8"), "postgres-startup");

  const received = once(stream, "data");
  child.stdout.write(Buffer.from("postgres-response"));
  assert.equal((await received)[0].toString("utf8"), "postgres-response");

  child.stderr.write(Buffer.alloc(20_000, 0x73));
  const diagnostics = stream.transportDiagnostics();
  assert.deepEqual(Object.keys(diagnostics), TRANSPORT_DIAGNOSTIC_KEYS);
  assert.equal(diagnostics.topology, "cloud");
  assert.equal(diagnostics.generation, "7");
  assert.equal(diagnostics.exitKind, "unknown");
  assert.equal(diagnostics.exitCode, null);
  assert.equal(diagnostics.signal, null);
  assert.equal(diagnostics.stderrCapturedBytes, 8192);
  assert.equal(diagnostics.stderrTotalBytes, 20_000);
  assert.equal(diagnostics.stderrTruncated, true);
  assert.match(diagnostics.stderrSha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.values(diagnostics).some((value) => String(value).includes("sensitive")), false);

  stream.destroy();
  assert.equal(child.killed, true);
});

test("child failure is terminal, sanitized, and never respawned", async () => {
  const child = fakeChild();
  let spawnCount = 0;
  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 1,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    childEnvironment: {},
    spawnImpl: () => {
      spawnCount += 1;
      return child;
    },
  });
  const connected = once(stream, "connect");
  stream.connect(5432, "127.0.0.1");
  child.emit("spawn");
  await connected;
  const sensitive = "password=should-never-escape private-host.example C:\\Users\\operator\\.ssh\\secret-key";
  child.stderr.write(sensitive);
  const failure = new Promise((resolve) => stream.once("error", resolve));
  setChildExit(child, 255);
  const error = await failure;
  assert.equal(error.code, "SSH_CHILD_EXITED");
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.deepEqual(Object.keys(error.transportDiagnostics), TRANSPORT_DIAGNOSTIC_KEYS);
  assert.deepEqual(error.transportDiagnostics, {
    topology: "cloud",
    generation: "1",
    exitKind: "exit",
    exitCode: 255,
    signal: null,
    stderrCapturedBytes: Buffer.byteLength(sensitive),
    stderrTotalBytes: Buffer.byteLength(sensitive),
    stderrTruncated: false,
    stderrSha256: error.transportDiagnostics.stderrSha256,
  });
  assert.match(error.transportDiagnostics.stderrSha256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(
    `${error.message}\n${JSON.stringify(error)}`,
    /password|private-host|secret-key|operator/,
  );
  assert.equal(spawnCount, 1);
});

test("stdout EOF before child close reaches an active pg query as a sanitized SSH error", async () => {
  const child = fakeChild();
  const { client, clientErrors, stream } = await connectPgClientOverFakeChild({
    child,
    generation: 41,
  });
  const queryWritten = once(child.stdin, "data");
  const query = client.query("SELECT 1");
  await queryWritten;
  const sensitive = "password=hidden private-host.example C:\\Users\\operator\\.ssh\\secret-key";
  child.stderr.write(sensitive);
  const stdoutEnded = once(child.stdout, "end");
  child.stdout.end();
  await stdoutEnded;
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(stream.destroyed, false, "active EOF must wait for child close metadata");
  setChildExit(child, 255);

  await assert.rejects(query, (error) => {
    assert.equal(error.code, "SSH_CHILD_EXITED");
    assert.deepEqual(error.transportDiagnostics, {
      topology: "cloud",
      generation: "41",
      exitKind: "exit",
      exitCode: 255,
      signal: null,
      stderrCapturedBytes: Buffer.byteLength(sensitive),
      stderrTotalBytes: Buffer.byteLength(sensitive),
      stderrTruncated: false,
      stderrSha256: error.transportDiagnostics.stderrSha256,
    });
    assert.doesNotMatch(
      `${error.message}\n${JSON.stringify(error)}`,
      /password|private-host|secret-key|operator/,
    );
    return true;
  });
  assert.equal(clientErrors.some((error) => error.code === "SSH_CHILD_EXITED"), true);
  await client.end().catch(() => {});
});

test("exit zero while the SSH PostgreSQL stream is active still fails closed", async () => {
  const child = fakeChild();
  const { client } = await connectPgClientOverFakeChild({
    child,
    topology: "fnos",
    generation: 42,
  });
  const queryWritten = once(child.stdin, "data");
  const query = client.query("SELECT 1");
  await queryWritten;
  const stdoutEnded = once(child.stdout, "end");
  child.stdout.end();
  await stdoutEnded;
  setChildExit(child, 0);
  await assert.rejects(query, (error) => {
    assert.equal(error.code, "SSH_CHILD_EXITED");
    assert.equal(error.transportDiagnostics.topology, "fnos");
    assert.equal(error.transportDiagnostics.exitKind, "exit");
    assert.equal(error.transportDiagnostics.exitCode, 0);
    return true;
  });
  await client.end().catch(() => {});
});

test("normal pg client teardown is graceful and does not report or hang", async () => {
  const child = fakeChild();
  const { client, clientErrors, stream } = await connectPgClientOverFakeChild({
    child,
    generation: 43,
  });
  const terminateWritten = once(child.stdin, "data");
  const ended = client.end();
  const [terminateFrame] = await terminateWritten;
  assert.deepEqual(terminateFrame, Buffer.from([0x58, 0x00, 0x00, 0x00, 0x04]));
  const stdoutEnded = once(child.stdout, "end");
  child.stdout.end();
  await stdoutEnded;
  setChildExit(child, 0);
  await ended;
  assert.deepEqual(clientErrors, []);
  assert.equal(stream.destroyed, true);
});

test("normal maxUses pool release retires its SSH child without an error or hang", async () => {
  const children = [];
  const registry = new SshTransportRegistry({
    sshExecutable: "ssh.exe",
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => {
      const child = fakeChild();
      child.stdin.resume();
      child.stdin.on("data", (chunk) => {
        if (chunk.equals(Buffer.from([0x58, 0x00, 0x00, 0x00, 0x04]))) {
          setImmediate(() => {
            child.stdout.end();
            setChildExit(child, 0);
          });
        }
      });
      children.push(child);
      setImmediate(() => {
        child.emit("spawn");
        child.stdout.write(postgresReadyFrames());
      });
      return child;
    },
    childEnvironment: {},
  });
  const pool = new Pool(buildPgPoolOptions(endpoint(), registry, 15_000));
  const poolErrors = [];
  pool.on("error", (error) => poolErrors.push(error));
  const client = await pool.connect();
  const removed = once(pool, "remove");
  client.release();
  await removed;
  await pool.end();
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(children.length, 1);
  assert.deepEqual(poolErrors, []);
  assert.equal(registry.active.size, 0);
});

test("closing an old graceful generation does not affect the next active generation", async () => {
  const children = [];
  const registry = new SshTransportRegistry({
    sshExecutable: "ssh.exe",
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    childEnvironment: {},
  });
  const first = registry.create(endpoint());
  const second = registry.create(endpoint());
  first.on("error", () => {});
  second.on("error", () => {});
  first.resume();
  second.resume();
  const firstConnected = once(first, "connect");
  first.connect(5432, "127.0.0.1");
  children[0].emit("spawn");
  await firstConnected;
  const secondConnected = once(second, "connect");
  second.connect(5432, "127.0.0.1");
  children[1].emit("spawn");
  await secondConnected;

  const firstClosed = once(first, "close");
  first.end();
  children[0].stdout.end();
  setChildExit(children[0], 0);
  await firstClosed;
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, false);
  assert.equal(second.fnosWebhookTransportGeneration, "2");
  const secondData = once(second, "data");
  children[1].stdout.write("still-active");
  assert.equal((await secondData)[0].toString("utf8"), "still-active");
  const secondClosed = once(second, "close");
  second.destroy();
  await secondClosed;
});

test("transport diagnostics sanitizer requires the exact safe field set", () => {
  const valid = {
    topology: "cloud",
    generation: "9",
    exitKind: "signal",
    exitCode: null,
    signal: "SIGTERM",
    stderrCapturedBytes: 12,
    stderrTotalBytes: 12,
    stderrTruncated: false,
    stderrSha256: "a".repeat(64),
  };
  assert.deepEqual(sanitizeSshTransportDiagnostics(valid), valid);
  assert.equal(sanitizeSshTransportDiagnostics({ ...valid, host: "private-host.example" }), null);
  assert.equal(sanitizeSshTransportDiagnostics({ ...valid, topology: "private-host.example" }), null);
  assert.equal(sanitizeSshTransportDiagnostics({ ...valid, generation: "09" }), null);
  assert.equal(sanitizeSshTransportDiagnostics({ ...valid, signal: "SIGTERM;secret" }), null);
  assert.equal(sanitizeSshTransportDiagnostics({ ...valid, stderrSha256: "A".repeat(64) }), null);
});

test("SSH stdout is paused when the PostgreSQL consumer applies backpressure", async () => {
  const child = fakeChild();
  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 1,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    childEnvironment: {},
    spawnImpl: () => child,
  });
  const connected = once(stream, "connect");
  stream.connect(5432, "127.0.0.1");
  child.emit("spawn");
  await connected;
  child.stdout.write(Buffer.alloc(256 * 1024));
  assert.equal(child.stdout.isPaused(), true);
  stream.destroy();
});

test("SSH child lifetime timeout is terminal", async () => {
  const child = fakeChild();
  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 1,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 10,
    childEnvironment: {},
    spawnImpl: () => child,
  });
  const connected = once(stream, "connect");
  stream.connect(5432, "127.0.0.1");
  child.emit("spawn");
  await connected;
  const keepAlive = setTimeout(() => {}, 50);
  const failure = new Promise((resolve) => stream.once("error", resolve));
  const error = await failure;
  clearTimeout(keepAlive);
  assert.equal(error.code, "SSH_CHILD_TIMEOUT");
  assert.equal(error.transportDiagnostics.exitKind, "timeout");
  assert.equal(child.killed, true);
});

test("active stdout EOF without child close uses the existing lifetime timer fallback", async () => {
  const child = fakeChild();
  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 44,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 10,
    childEnvironment: {},
    spawnImpl: () => child,
  });
  const connected = once(stream, "connect");
  stream.connect(5432, "127.0.0.1");
  child.emit("spawn");
  await connected;
  const keepAlive = setTimeout(() => {}, 50);
  const failure = once(stream, "error");
  child.stdout.end();
  const [error] = await failure;
  clearTimeout(keepAlive);
  assert.equal(error.code, "SSH_CHILD_EXITED");
  assert.equal(error.transportDiagnostics.exitKind, "stdout_eof");
  assert.equal(error.transportDiagnostics.exitCode, null);
  assert.equal(error.transportDiagnostics.signal, null);
});

test("custom stream rejects any PostgreSQL destination except container loopback 5432", () => {
  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 1,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    childEnvironment: {},
    spawnImpl: () => fakeChild(),
  });
  assert.throws(() => stream.connect(5433, "127.0.0.1"), { code: "SSH_DATABASE_ENDPOINT_INVALID" });
  assert.throws(() => stream.connect(5432, "0.0.0.0"), { code: "SSH_DATABASE_ENDPOINT_INVALID" });
});

test("PG integration relies on runReverse authoritative readback and has no unbound snapshot helper", () => {
  const pgTestSource = readFileSync(
    fileURLToPath(new URL("./fnos-cutover.pg.test.mjs", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(pgTestSource, /assertEndpointsSynced|snapshotEndpoint\s*\(/);
  assert.match(
    pgTestSource,
    /assert\.deepEqual\(reversed\.source\.tables,\s*reversed\.target\.tables\)/,
  );
  assert.match(
    pgTestSource,
    /assert\.deepEqual\(reversed\.source\.sequences,\s*reversed\.target\.sequences\)/,
  );
});

test("PG integration keeps direct batch 73 and uses the audited SSH batch and diagnostic stages everywhere", () => {
  const pgTestSource = readFileSync(
    fileURLToPath(new URL("./fnos-cutover.pg.test.mjs", import.meta.url)),
    "utf8",
  );
  const directStart = pgTestSource.indexOf("test(\"real PostgreSQL prepare/reverse");
  const sshStart = pgTestSource.indexOf("test(\"SSH stdio PostgreSQL prepare/reverse");
  assert.ok(directStart >= 0 && sshStart > directStart);
  const directBlock = pgTestSource.slice(directStart, sshStart);
  const sshBlock = pgTestSource.slice(sshStart);

  assert.match(pgTestSource, /const SSH_BATCH_SIZE = 250;/);
  assert.match(directBlock, /timeout:\s*600_000/);
  assert.equal((directBlock.match(/runPrepareForward\(\{/g) ?? []).length, 2);
  assert.equal((directBlock.match(/runForward\(\{/g) ?? []).length, 1);
  assert.equal((directBlock.match(/runReverse\(\{/g) ?? []).length, 2);
  assert.equal((directBlock.match(/batchSize:\s*73/g) ?? []).length, 5);
  assert.doesNotMatch(directBlock, /SSH_BATCH_SIZE/);

  assert.match(sshBlock, /timeout:\s*900_000/);
  assert.equal((sshBlock.match(/runPrepareForward\(\{/g) ?? []).length, 2);
  assert.equal((sshBlock.match(/runForward\(\{/g) ?? []).length, 1);
  assert.equal((sshBlock.match(/runReverse\(\{/g) ?? []).length, 2);
  assert.equal((sshBlock.match(/batchSize:\s*SSH_BATCH_SIZE/g) ?? []).length, 5);
  assert.doesNotMatch(sshBlock, /batchSize:\s*73/);
  const reportedStages = [...sshBlock.matchAll(/reportSshPrimaryStage\(t, "([a-z0-9_]+)"\)/g)]
    .map((match) => match[1]);
  assert.equal(reportedStages.length, 13);
  assert.ok(reportedStages.every((stage) => /^[a-z][a-z0-9_]{0,63}$/.test(stage)));
  assert.doesNotMatch(sshBlock, /primaryStage\s*=\s*"/);
});

test("launcherConfiguration builds the test-mode topology from SSH env without requiring database URLs", () => {
  const sshRoot = process.env.USERPROFILE + "\\.ssh";
  const sshFiles = readdirSync(sshRoot).filter((name) => {
    try { return statSync(resolvePath(sshRoot, name)).isFile(); } catch { return false; }
  });
  if (sshFiles.length < 2) return;
  const [firstFile, secondFile] = sshFiles;
  const environment = {
    USERPROFILE: process.env.USERPROFILE,
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    FNOS_WEBHOOK_SSH_CLOUD_HOST: "cloud.example.test",
    FNOS_WEBHOOK_SSH_CLOUD_PORT: "22",
    FNOS_WEBHOOK_SSH_CLOUD_USER: "sheinops",
    FNOS_WEBHOOK_SSH_CLOUD_IDENTITY_FILE: resolvePath(sshRoot, firstFile),
    FNOS_WEBHOOK_SSH_CLOUD_KNOWN_HOSTS_FILE: resolvePath(sshRoot, secondFile),
    FNOS_WEBHOOK_SSH_FNOS_HOST: "fnos.example.test",
    FNOS_WEBHOOK_SSH_FNOS_PORT: "22",
    FNOS_WEBHOOK_SSH_FNOS_USER: "sheinops",
    FNOS_WEBHOOK_SSH_FNOS_IDENTITY_FILE: resolvePath(sshRoot, firstFile),
    FNOS_WEBHOOK_SSH_FNOS_KNOWN_HOSTS_FILE: resolvePath(sshRoot, secondFile),
    FNOS_WEBHOOK_SOURCE_DATABASE_URL: "postgresql://should-not-be-read",
    FNOS_WEBHOOK_TARGET_DATABASE_URL: "postgresql://should-not-be-read",
  };
  const config = launcherConfiguration(environment, { requireFingerprint: false });
  assert.equal(config.cloud.topology, "cloud");
  assert.equal(config.fnos.topology, "fnos");
  assert.equal(config.cloud.host, "cloud.example.test");
  assert.equal(config.fnos.host, "fnos.example.test");
  const topology = mapCutoverTopology(config, "prepare-forward");
  assert.equal(topology.source.topology, "cloud");
  assert.equal(topology.target.topology, "fnos");
});

test("SSH test-mode pool options stay passwordless, single-use, and force the maintenance database override only", () => {
  const registry = new SshTransportRegistry({
    sshExecutable: "ssh.exe",
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => fakeChild(),
    childEnvironment: {},
  });
  const base = buildPgPoolOptions(endpoint(), registry, 15_000);
  const admin = { ...base, database: "postgres" };
  const testDb = { ...base, database: "fnos_cutover_test_source_x" };
  for (const options of [base, admin, testDb]) {
    assert.equal(options.user, "sheinfm");
    assert.equal(options.max, 1);
    assert.equal(options.min, 0);
    assert.equal(options.maxUses, 1);
    assert.equal(Object.hasOwn(options, "password"), false);
    assert.equal(Object.hasOwn(options, "connectionString"), false);
    assert.equal(options.host, "127.0.0.1");
    assert.equal(options.port, 5432);
  }
  assert.equal(admin.database, "postgres");
  assert.equal(testDb.database, "fnos_cutover_test_source_x");
});

test("registry teardown destroys every outstanding SSH child exactly once", async () => {
  const children = [];
  const registry = new SshTransportRegistry({
    sshExecutable: "ssh.exe",
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => {
      const child = fakeChild();
      child.killCalls = 0;
      const originalKill = child.kill.bind(child);
      child.kill = () => {
        child.killCalls += 1;
        return originalKill();
      };
      children.push(child);
      return child;
    },
    childEnvironment: {},
  });
  const endpointBase = endpoint();
  for (let index = 0; index < 3; index += 1) {
    const stream = registry.create({ ...endpointBase });
    stream.connect(5432, "127.0.0.1");
    stream.emit("spawn");
  }
  assert.equal(registry.active.size, 3);
  registry.abortAll();
  assert.equal(children.length, 3);
  assert.ok(children.every((item) => item.killCalls === 1));
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(registry.active.size, 0);
});
