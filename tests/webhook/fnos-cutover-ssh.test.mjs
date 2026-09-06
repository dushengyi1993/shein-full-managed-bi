import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import {
  CUTOVER_APPLICATION_NAME,
  MANAGED_TRIGGERS,
  TABLES,
  identityFingerprint,
  runPrepareForward,
} from "../../scripts/fnos_webhook_cutover.mjs";
import {
  SshCutoverLauncherError,
  SshPgDuplex,
  SshTransportRegistry,
  bindPoolErrorSafety,
  buildPgPoolOptions,
  buildSshArguments,
  launcherConfiguration,
  mapCutoverTopology,
  runSshLauncher,
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

test("launcherConfiguration builds the test-mode topology from SSH env without requiring database URLs", (t) => {
  const fixtureRoot = mkdtempSync(resolvePath(tmpdir(), "fnos-cutover-ssh-config-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const userProfile = resolvePath(fixtureRoot, "operator");
  const sshRoot = resolvePath(userProfile, ".ssh");
  const openSshRoot = resolvePath(fixtureRoot, "System32", "OpenSSH");
  const identityFile = resolvePath(sshRoot, "cutover_ed25519.test");
  const knownHostsFile = resolvePath(sshRoot, "known_hosts.test");
  mkdirSync(sshRoot, { recursive: true });
  mkdirSync(openSshRoot, { recursive: true });
  writeFileSync(identityFile, "non-secret test identity fixture\n", "utf8");
  writeFileSync(knownHostsFile, "non-secret test known-hosts fixture\n", "utf8");
  writeFileSync(resolvePath(openSshRoot, "ssh.exe"), "non-executable test fixture\n", "utf8");
  const environment = {
    USERPROFILE: userProfile,
    SystemRoot: fixtureRoot,
    FNOS_WEBHOOK_SSH_CLOUD_HOST: "cloud.example.test",
    FNOS_WEBHOOK_SSH_CLOUD_PORT: "22",
    FNOS_WEBHOOK_SSH_CLOUD_USER: "sheinops",
    FNOS_WEBHOOK_SSH_CLOUD_IDENTITY_FILE: identityFile,
    FNOS_WEBHOOK_SSH_CLOUD_KNOWN_HOSTS_FILE: knownHostsFile,
    FNOS_WEBHOOK_SSH_FNOS_HOST: "fnos.example.test",
    FNOS_WEBHOOK_SSH_FNOS_PORT: "22",
    FNOS_WEBHOOK_SSH_FNOS_USER: "sheinops",
    FNOS_WEBHOOK_SSH_FNOS_IDENTITY_FILE: identityFile,
    FNOS_WEBHOOK_SSH_FNOS_KNOWN_HOSTS_FILE: knownHostsFile,
    FNOS_WEBHOOK_SOURCE_DATABASE_URL: "postgresql://should-not-be-read",
    FNOS_WEBHOOK_TARGET_DATABASE_URL: "postgresql://should-not-be-read",
  };
  assert.throws(
    () => launcherConfiguration({ ...environment, USERPROFILE: "" }, { requireFingerprint: false }),
    (error) => error?.code === "SSH_CONFIG_REQUIRED",
  );
  const config = launcherConfiguration(environment, { requireFingerprint: false });
  assert.equal(config.cloud.topology, "cloud");
  assert.equal(config.fnos.topology, "fnos");
  assert.equal(config.cloud.host, "cloud.example.test");
  assert.equal(config.fnos.host, "fnos.example.test");
  const topology = mapCutoverTopology(config, "prepare-forward");
  assert.equal(topology.source.topology, "cloud");
  assert.equal(topology.target.topology, "fnos");
  assert.equal(config.digestBatchSize, undefined);

  const configWithDigest = launcherConfiguration({
    ...environment,
    FNOS_WEBHOOK_DIGEST_BATCH_SIZE: "5000",
  }, { requireFingerprint: false });
  assert.equal(configWithDigest.digestBatchSize, 5000);

  assert.throws(
    () => launcherConfiguration({
      ...environment,
      FNOS_WEBHOOK_DIGEST_BATCH_SIZE: "10001",
    }, { requireFingerprint: false }),
    (error) => error?.code === "SSH_CONFIG_INVALID",
  );

  assert.throws(
    () => launcherConfiguration({
      ...environment,
      FNOS_WEBHOOK_DIGEST_BATCH_SIZE: "0",
    }, { requireFingerprint: false }),
    (error) => error?.code === "SSH_CONFIG_INVALID",
  );

  assert.throws(
    () => launcherConfiguration({
      ...environment,
      FNOS_WEBHOOK_DIGEST_BATCH_SIZE: "not-a-number",
    }, { requireFingerprint: false }),
    (error) => error?.code === "SSH_CONFIG_INVALID",
  );
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

test("bindPoolErrorSafety captures checked-out Client error without uncaughtException", async () => {
  const child = fakeChild();
  const registry = new SshTransportRegistry({
    sshExecutable: "ssh.exe",
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => child,
    childEnvironment: {},
  });
  const capturedErrors = [];
  const pool = bindPoolErrorSafety(
    new Pool(buildPgPoolOptions(endpoint(), registry, 15_000)),
    (error) => capturedErrors.push(error),
  );
  child.stdin.resume();
  const connectPromise = pool.connect();
  child.emit("spawn");
  child.stdout.write(postgresReadyFrames());
  const client = await connectPromise;

  client.connection.stream.destroy(new SshCutoverLauncherError("SSH_CHECKED_OUT_ERROR", "checked out failure"));
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.ok(capturedErrors.length >= 1);
  assert.equal(capturedErrors[0].code, "SSH_CHECKED_OUT_ERROR");
  client.release(true);
  await pool.end().catch(() => {});
});

test("bindPoolErrorSafety captures idle Client error on pool without uncaughtException", async () => {
  const child = fakeChild();
  const registry = new SshTransportRegistry({
    sshExecutable: "ssh.exe",
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => child,
    childEnvironment: {},
  });
  const capturedErrors = [];
  const pool = bindPoolErrorSafety(
    new Pool({
      ...buildPgPoolOptions(endpoint(), registry, 15_000),
      maxUses: 5,
    }),
    (error) => capturedErrors.push(error),
  );
  child.stdin.resume();
  const connectPromise = pool.connect();
  child.emit("spawn");
  child.stdout.write(postgresReadyFrames());
  const client = await connectPromise;

  client.release();
  assert.equal(pool.idleCount, 1);
  client.connection.stream.destroy(new SshCutoverLauncherError("SSH_IDLE_POOL_ERROR", "idle failure"));
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(pool.idleCount, 0);
  assert.ok(capturedErrors.length >= 1);
  assert.equal(capturedErrors[0].code, "SSH_IDLE_POOL_ERROR");
  await pool.end().catch(() => {});
});

function fakeLauncherChild(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  // Real spawned children/pipes keep the loop alive until close; these in-memory
  // streams do not. Model that lifetime without changing production unref timers.
  const processHandle = setInterval(() => {}, 1000);
  child.once("close", () => clearInterval(processHandle));
  t.after(() => {
    clearInterval(processHandle);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.signalCode = "SIGTERM";
    process.nextTick(() => {
      child.stdout.end();
      child.emit("exit", null, "SIGTERM");
      child.emit("close", null, "SIGTERM");
    });
    return true;
  };
  return child;
}

test("runSshLauncher terminates with SSH_OPERATION_TIMEOUT and sanitized failure JSON on operation timeout", { timeout: 5000 }, async (t) => {
  const fixtureRoot = mkdtempSync(resolvePath(tmpdir(), "fnos-ot-test-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const userProfile = resolvePath(fixtureRoot, "operator");
  const sshRoot = resolvePath(userProfile, ".ssh");
  const openSshRoot = resolvePath(fixtureRoot, "System32", "OpenSSH");
  const identityFile = resolvePath(sshRoot, "cutover_ed25519.test");
  const knownHostsFile = resolvePath(sshRoot, "known_hosts.test");
  mkdirSync(sshRoot, { recursive: true });
  mkdirSync(openSshRoot, { recursive: true });
  writeFileSync(identityFile, "test identity\n", "utf8");
  writeFileSync(knownHostsFile, "test known-hosts\n", "utf8");
  writeFileSync(resolvePath(openSshRoot, "ssh.exe"), "test ssh\n", "utf8");

  const environment = {
    USERPROFILE: userProfile,
    SystemRoot: fixtureRoot,
    FNOS_WEBHOOK_SSH_CLOUD_HOST: "cloud.example.test",
    FNOS_WEBHOOK_SSH_CLOUD_PORT: "22",
    FNOS_WEBHOOK_SSH_CLOUD_USER: "sheinops",
    FNOS_WEBHOOK_SSH_CLOUD_IDENTITY_FILE: identityFile,
    FNOS_WEBHOOK_SSH_CLOUD_KNOWN_HOSTS_FILE: knownHostsFile,
    FNOS_WEBHOOK_SSH_CLOUD_FINGERPRINT: "a".repeat(64),
    FNOS_WEBHOOK_SSH_FNOS_HOST: "fnos.example.test",
    FNOS_WEBHOOK_SSH_FNOS_PORT: "22",
    FNOS_WEBHOOK_SSH_FNOS_USER: "sheinops",
    FNOS_WEBHOOK_SSH_FNOS_IDENTITY_FILE: identityFile,
    FNOS_WEBHOOK_SSH_FNOS_KNOWN_HOSTS_FILE: knownHostsFile,
    FNOS_WEBHOOK_SSH_FNOS_FINGERPRINT: "b".repeat(64),
    FNOS_WEBHOOK_SSH_CONNECT_TIMEOUT_MS: "1000",
    FNOS_WEBHOOK_SSH_OPERATION_TIMEOUT_MS: "60000",
  };

  let stderr = "";
  const children = [];
  const spawnImpl = () => {
    const child = fakeLauncherChild(t);
    children.push(child);
    process.nextTick(() => {
      child.emit("spawn");
      child.stdout.write(postgresReadyFrames());
    });
    return child;
  };

  const exitCode = await runSshLauncher({
    argv: ["inspect-identities"],
    environment,
    spawnImpl,
    setTimeoutImpl: (fn) => setTimeout(fn, 20),
    stderr: { write(chunk) { stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8"); return true; } },
  });

  assert.equal(exitCode, 1);
  const parsed = JSON.parse(stderr.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errorCode, "SSH_OPERATION_TIMEOUT");
  assert.equal(parsed.outcome, "failed_closed");
  assert.equal(parsed.readyForCloudStart, false);
  assert.equal(parsed.readyForForwardBaseline, false);
  assert.ok(children.length > 0);
  assert.ok(children.every((c) => c.killed));
});

test("runSshLauncher terminates with sanitized transport failure when idle client transport error occurs", { timeout: 5000 }, async (t) => {
  const fixtureRoot = mkdtempSync(resolvePath(tmpdir(), "fnos-idle-test-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const userProfile = resolvePath(fixtureRoot, "operator");
  const sshRoot = resolvePath(userProfile, ".ssh");
  const openSshRoot = resolvePath(fixtureRoot, "System32", "OpenSSH");
  const identityFile = resolvePath(sshRoot, "cutover_ed25519.test");
  const knownHostsFile = resolvePath(sshRoot, "known_hosts.test");
  mkdirSync(sshRoot, { recursive: true });
  mkdirSync(openSshRoot, { recursive: true });
  writeFileSync(identityFile, "test identity\n", "utf8");
  writeFileSync(knownHostsFile, "test known-hosts\n", "utf8");
  writeFileSync(resolvePath(openSshRoot, "ssh.exe"), "test ssh\n", "utf8");

  const environment = {
    USERPROFILE: userProfile,
    SystemRoot: fixtureRoot,
    FNOS_WEBHOOK_SSH_CLOUD_HOST: "cloud.example.test",
    FNOS_WEBHOOK_SSH_CLOUD_PORT: "22",
    FNOS_WEBHOOK_SSH_CLOUD_USER: "sheinops",
    FNOS_WEBHOOK_SSH_CLOUD_IDENTITY_FILE: identityFile,
    FNOS_WEBHOOK_SSH_CLOUD_KNOWN_HOSTS_FILE: knownHostsFile,
    FNOS_WEBHOOK_SSH_CLOUD_FINGERPRINT: "a".repeat(64),
    FNOS_WEBHOOK_SSH_FNOS_HOST: "fnos.example.test",
    FNOS_WEBHOOK_SSH_FNOS_PORT: "22",
    FNOS_WEBHOOK_SSH_FNOS_USER: "sheinops",
    FNOS_WEBHOOK_SSH_FNOS_IDENTITY_FILE: identityFile,
    FNOS_WEBHOOK_SSH_FNOS_KNOWN_HOSTS_FILE: knownHostsFile,
    FNOS_WEBHOOK_SSH_FNOS_FINGERPRINT: "b".repeat(64),
    FNOS_WEBHOOK_SSH_CONNECT_TIMEOUT_MS: "1000",
    FNOS_WEBHOOK_SSH_OPERATION_TIMEOUT_MS: "60000",
  };

  let stderr = "";
  const children = [];
  let firstChild = null;
  const spawnImpl = () => {
    const child = fakeLauncherChild(t);
    children.push(child);
    if (!firstChild) firstChild = child;
    process.nextTick(() => {
      child.emit("spawn");
      child.stdout.write(postgresReadyFrames());
    });
    return child;
  };

  setTimeout(() => {
    if (firstChild) {
      firstChild.exitCode = 255;
      firstChild.emit("exit", 255, null);
      firstChild.emit("close", 255, null);
    }
  }, 40);

  const exitCode = await runSshLauncher({
    argv: ["inspect-identities"],
    environment,
    spawnImpl,
    stderr: { write(chunk) { stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8"); return true; } },
  });

  assert.equal(exitCode, 1);
  const parsed = JSON.parse(stderr.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errorCode, "SSH_CHILD_EXITED");
  assert.equal(parsed.outcome, "failed_closed");
  assert.equal(parsed.readyForCloudStart, false);
  assert.equal(parsed.readyForForwardBaseline, false);
  assert.ok(parsed.transportDiagnostics);
  assert.equal(parsed.transportDiagnostics.exitKind, "exit");
  assert.equal(parsed.transportDiagnostics.exitCode, 255);
  assert.ok(children.every((c) => c.killed || c.exitCode !== null || c.signalCode !== null));
});

test("prepare-forward execute post-commit readback timeout preserves OUTCOME_UNVERIFIED without masking", async () => {
  const objectNames = [
    ...TABLES.map((d) => d.relation),
    ...TABLES.filter((d) => d.sequence).map((d) => d.sequence),
  ];
  const objects = Object.fromEntries(objectNames.map((name, i) => [name, { oid: String(i + 1), owner: "sheinfm" }]));

  const sourceIdentity = {
    systemIdentifier: "1",
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
  const targetIdentity = {
    ...sourceIdentity,
    systemIdentifier: "2",
  };

  const sourceFp = identityFingerprint(sourceIdentity);
  const targetFp = identityFingerprint(targetIdentity);

  const sequenceKeys = TABLES.filter((d) => d.sequence).map((d) => d.key);
  const sequences = Object.fromEntries(sequenceKeys.map((k) => [k, {
    sequenceName: k + "_seq",
    lastValue: "1",
    startValue: "1",
    increment: "1",
    maxValue: "9223372036854775807",
    minValue: "1",
    isCycled: false,
    isCalled: true,
    logicalNext: "2",
  }]));

  const triggers = Object.fromEntries(MANAGED_TRIGGERS.map((t) => [t.relation + "." + t.name, "O"]));

  let endpointCallCount = 0;
  const fakeEndpointFactory = (pool, role) => {
    endpointCallCount += 1;
    const currentCall = endpointCallCount;
    return {
      role,
      batchSize: 1,
      transportGeneration: String(currentCall),
      inTransaction: true,
      async beginFrozen() {
        if (currentCall > 2) {
          throw new SshCutoverLauncherError("SSH_OPERATION_TIMEOUT", "SSH operation timeout during post-commit readback");
        }
      },
      async readIdentity() { return role === "source" ? sourceIdentity : targetIdentity; },
      async readSession() {
        return {
          backendPid: String(currentCall),
          backendStart: "2026-09-05 00:00:0" + currentCall + ".000000+00",
          transportGeneration: String(currentCall),
        };
      },
      async readReadiness() {
        return {
          nonterminalJobs: "0",
          pendingDirectives: "0",
          retryDirectives: "0",
          runningDirectives: "0",
          ownedDirectiveLeases: "0",
          expiringDirectiveLeases: "0",
          nonterminalDirectives: "0",
          subscriptions: "0",
          gates: "0",
        };
      },
      async readSequence(key) { return sequences[key]; },
      async readTriggerStates() { return { ...triggers }; },
      async setControlledTriggers() {},
      async scanRows() { return []; },
      async *scanDigestEntries() {},
      async countTableRows() { return "0"; },
      async rollback() {},
      async commit() {},
      release() {},
    };
  };

  const dryRun = await runPrepareForward({
    sourcePool: {},
    targetPool: {},
    execute: false,
    approvedSourceIdentityFingerprint: sourceFp,
    approvedTargetIdentityFingerprint: targetFp,
    endpointFactory: fakeEndpointFactory,
  });

  endpointCallCount = 0;
  await assert.rejects(
    runPrepareForward({
      sourcePool: {},
      targetPool: {},
      execute: true,
      approvedPlanHash: dryRun.planHash,
      approvedSourceIdentityFingerprint: sourceFp,
      approvedTargetIdentityFingerprint: targetFp,
      endpointFactory: fakeEndpointFactory,
    }),
    (error) => {
      assert.equal(error.code, "OUTCOME_UNVERIFIED");
      return true;
    },
  );
});

test("SshPgDuplex _writev combines corked pg protocol chunks into a single child stdin write with exact byte order", async () => {
  const child = fakeChild();
  const stdinWrites = [];
  const origWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk, encoding, cb) => {
    stdinWrites.push(chunk);
    return origWrite(chunk, encoding, cb);
  };

  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 1,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => child,
  });

  child.stdin.resume();
  stream.connect(5432, "127.0.0.1");
  child.emit("spawn");
  child.stdout.write(postgresReadyFrames());
  await new Promise((r) => setImmediate(r));

  // Simulate pg cork/uncork during extended query: 5 frames (P, B, D, E, S)
  const frameP = Buffer.from([0x50, 0, 0, 0, 7, 1, 2, 3]);
  const frameB = Buffer.from([0x42, 0, 0, 0, 6, 4, 5]);
  const frameD = Buffer.from([0x44, 0, 0, 0, 5, 6]);
  const frameE = Buffer.from([0x45, 0, 0, 0, 8, 7, 8, 9, 10]);
  const frameS = Buffer.from([0x53, 0, 0, 0, 4]);

  stream.cork();
  stream.write(frameP);
  stream.write(frameB);
  stream.write(frameD);
  stream.write(frameE);
  stream.write(frameS);
  stream.uncork();

  await new Promise((r) => setImmediate(r));

  // Verify child.stdin received EXACTLY 1 combined write call
  assert.equal(stdinWrites.length, 1, "corked chunks must be combined into exactly 1 child stdin write");
  const expectedCombined = Buffer.concat([frameP, frameB, frameD, frameE, frameS]);
  assert.deepEqual(stdinWrites[0], expectedCombined, "combined buffer must match exact concatenated byte order");

  stream.destroy();
});

test("SshPgDuplex _writev handles backpressure and invokes callback exactly once", async () => {
  const child = fakeChild();
  let callbackCount = 0;
  let delayedCallback = null;

  child.stdin.write = (chunk, cb) => {
    delayedCallback = cb;
    return false; // Signal backpressure
  };

  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 1,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => child,
  });

  stream.connect(5432, "127.0.0.1");
  child.emit("spawn");
  await new Promise((r) => setImmediate(r));

  stream._writev(
    [{ chunk: Buffer.from("abc") }, { chunk: Buffer.from("def") }],
    (err) => {
      assert.equal(err, undefined);
      callbackCount += 1;
    }
  );

  assert.equal(callbackCount, 0, "callback must not be called before underlying write completes");
  assert.ok(delayedCallback);
  delayedCallback();
  assert.equal(callbackCount, 1, "callback must be called exactly once");

  stream.destroy();
});

test("SshPgDuplex _writev fails closed with SSH_STREAM_NOT_CONNECTED when stream is not connected or destroyed", async () => {
  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 1,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => fakeChild(),
  });

  let capturedError = null;
  stream._writev([{ chunk: Buffer.from("test") }], (err) => {
    capturedError = err;
  });

  assert.ok(capturedError);
  assert.equal(capturedError.code, "SSH_STREAM_NOT_CONNECTED");
});

test("SshPgDuplex _writev detects PostgreSQL terminate frame inside combined multi-frame buffer", async () => {
  const child = fakeChild();
  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 1,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => child,
  });

  child.stdin.resume();
  stream.connect(5432, "127.0.0.1");
  child.emit("spawn");
  await new Promise((r) => setImmediate(r));

  assert.equal(stream.gracefulTeardownRequested, false);

  // Send query followed by terminate frame in corked batch
  const queryFrame = Buffer.from([0x51, 0, 0, 0, 8, 1, 2, 3, 4]);
  const termFrame = Buffer.from([0x58, 0, 0, 0, 4]); // Terminate 'X'

  stream.cork();
  stream.write(queryFrame);
  stream.write(termFrame);
  stream.uncork();

  await new Promise((r) => setImmediate(r));
  assert.equal(stream.gracefulTeardownRequested, true, "graceful teardown must be requested upon seeing terminate frame in combined writev");

  stream.destroy();
});

test("SshPgDuplex _writev detects PostgreSQL terminate frame inside single concatenated buffer chunk without per-chunk loop", async () => {
  const child = fakeChild();
  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 1,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => child,
  });

  child.stdin.resume();
  stream.connect(5432, "127.0.0.1");
  child.emit("spawn");
  await new Promise((r) => setImmediate(r));

  assert.equal(stream.gracefulTeardownRequested, false);

  // Write a single pre-combined Buffer containing [queryFrame, termFrame]
  const queryFrame = Buffer.from([0x51, 0, 0, 0, 8, 1, 2, 3, 4]);
  const termFrame = Buffer.from([0x58, 0, 0, 0, 4]);
  const preCombinedBuffer = Buffer.concat([queryFrame, termFrame]);

  // Single write call, so _write / _writev receives this as a single chunk
  stream.write(preCombinedBuffer);
  await new Promise((r) => setImmediate(r));

  assert.equal(
    stream.gracefulTeardownRequested,
    true,
    "gracefulTeardownRequested must be true even when terminate frame is embedded inside a single chunk"
  );
  stream.destroy();
});

test("SshPgDuplex _writev does NOT misidentify embedded X00000004 inside Bind payload as terminate", async () => {
  const child = fakeChild();
  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 1,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => child,
  });

  child.stdin.resume();
  stream.connect(5432, "127.0.0.1");
  child.emit("spawn");
  await new Promise((r) => setImmediate(r));

  assert.equal(stream.gracefulTeardownRequested, false);

  // Construct a Bind message (0x42) where the payload data contains [0x58, 0, 0, 0, 4]
  // Payload: 3 leading bytes, 5 pseudo-terminate bytes, 2 trailing bytes = 10 payload bytes
  // Total message length field = 4 + 10 = 14 (0x0E)
  const bindPayloadWithX = Buffer.from([
    0x42, // 'B'
    0x00, 0x00, 0x00, 0x0E, // length = 14 (includes 4 length bytes + 10 payload bytes)
    0x01, 0x02, 0x03,
    0x58, 0x00, 0x00, 0x00, 0x04, // embedded pseudo-terminate inside Bind data
    0x08, 0x09,
  ]);
  const syncFrame = Buffer.from([0x53, 0, 0, 0, 4]); // 'S'

  stream.cork();
  stream.write(bindPayloadWithX);
  stream.write(syncFrame);
  stream.uncork();

  await new Promise((r) => setImmediate(r));

  assert.equal(
    stream.gracefulTeardownRequested,
    false,
    "gracefulTeardownRequested must NOT be set when X00000004 is payload inside Bind"
  );
  stream.destroy();
});

test("SshPgDuplex _writev propagates child.stdin callback error to every user write callback and emits stream error exactly once", async () => {
  const child = fakeChild();
  child.stdin.write = (chunk, cb) => {
    cb(new Error("injected child stdin write error"));
    return false;
  };

  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 1,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => child,
  });

  child.stdin.resume();
  stream.connect(5432, "127.0.0.1");
  child.emit("spawn");
  await new Promise((r) => setImmediate(r));

  const userCallbackErrors = [];
  const streamErrors = [];
  stream.on("error", (err) => {
    streamErrors.push(err);
  });

  stream.cork();
  stream.write(Buffer.from([0x50, 0, 0, 0, 4]), (err) => {
    userCallbackErrors.push({ write: 1, err });
  });
  stream.write(Buffer.from([0x42, 0, 0, 0, 4]), (err) => {
    userCallbackErrors.push({ write: 2, err });
  });
  stream.write(Buffer.from([0x53, 0, 0, 0, 4]), (err) => {
    userCallbackErrors.push({ write: 3, err });
  });
  stream.uncork();

  await new Promise((r) => setImmediate(r));

  // Verify every user callback was called exactly once with the error
  assert.equal(userCallbackErrors.length, 3, "every user write callback must be called exactly once");
  assert.ok(userCallbackErrors.every((e) => e.err?.message === "injected child stdin write error"));
  // Verify stream error was emitted exactly once
  assert.equal(streamErrors.length, 1, "stream error must be emitted exactly once without duplication");
  assert.equal(streamErrors[0]?.message, "injected child stdin write error");
  assert.equal(stream.destroyed, true, "stream must be destroyed upon write error");
});

test("SshPgDuplex _writev preserves large binary payloads without corruption or truncation", async () => {
  const child = fakeChild();
  const stdinWrites = [];
  child.stdin.write = (chunk, encoding, cb) => {
    stdinWrites.push(chunk);
    return true;
  };

  const stream = new SshPgDuplex({
    sshExecutable: "ssh.exe",
    endpoint: endpoint(),
    generation: 1,
    connectTimeoutMs: 15_000,
    lifetimeTimeoutMs: 60_000,
    spawnImpl: () => child,
  });

  child.stdin.resume();
  stream.connect(5432, "127.0.0.1");
  child.emit("spawn");
  await new Promise((r) => setImmediate(r));

  // Generate large random vectors: 3 chunks of 32KB each (total 96KB)
  const chunk1 = Buffer.alloc(32768, 0xaa);
  const chunk2 = Buffer.alloc(32768, 0xbb);
  const chunk3 = Buffer.alloc(32768, 0xcc);

  stream.cork();
  stream.write(chunk1);
  stream.write(chunk2);
  stream.write(chunk3);
  stream.uncork();

  await new Promise((r) => setImmediate(r));

  assert.equal(stdinWrites.length, 1);
  assert.equal(stdinWrites[0].length, 98304);
  assert.deepEqual(stdinWrites[0], Buffer.concat([chunk1, chunk2, chunk3]));

  stream.destroy();
});
