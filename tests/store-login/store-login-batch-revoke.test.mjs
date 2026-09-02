import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  installBatch,
  parseArguments as parseCreateArguments,
  sha256,
} from '../../scripts/create_full_managed_store_login_batch.mjs';
import {
  applyRevocation,
  parseArguments,
  planRevocation,
  validateBatchRecord,
} from '../../scripts/revoke_full_managed_store_login_batch.mjs';

const SCRIPT_PATH = fileURLToPath(
  new URL('../../scripts/revoke_full_managed_store_login_batch.mjs', import.meta.url),
);
const CREATE_SCRIPT_PATH = fileURLToPath(
  new URL('../../scripts/create_full_managed_store_login_batch.mjs', import.meta.url),
);
const VIRTUAL_DIR = path.resolve('virtual-store-login-fixture');
const BATCH_FILE = path.join(VIRTUAL_DIR, 'batch.json');
const PLAN_TIME = '2026-09-03T02:03:04.567Z';
const APPLY_TIME = '2026-09-03T03:04:05.678Z';
const CREATE_TIME = '2026-09-03T04:05:06.789Z';
const SECRET_MARKER = 'SECRET-BATCH-BODY-MUST-NOT-PRINT';

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function buildRecord(overrides = {}) {
  return {
    version: 1,
    tokenHash: 'a'.repeat(64),
    createdAt: '2026-07-31T03:45:42.540Z',
    expiresAt: '2026-08-14T03:45:42.540Z',
    revokedAt: null,
    ...overrides,
  };
}

function recordBytes(record = buildRecord()) {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function errorWithCode(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

class FakePosixFileSystem {
  constructor({
    bytes = recordBytes(),
    uid = 0,
    gid = 1904,
    mode = 0o640,
    type = 'file',
  } = {}) {
    this.constants = fsConstants;
    this.supportsDirectoryFsync = false;
    this.nodes = new Map();
    this.nextIno = 10;
    this.clock = 1_000;
    this.beforeRename = null;
    this.afterRename = null;
    this.afterReadFile = null;
    this.renameCount = 0;
    this.addNode(VIRTUAL_DIR, {
      uid: 0,
      gid,
      mode: 0o750,
      type: 'directory',
    });
    this.addNode(BATCH_FILE, { bytes, uid, gid, mode, type });
  }

  addNode(file, {
    bytes = Buffer.alloc(0),
    uid = 0,
    gid = 0,
    mode = 0o600,
    type = 'file',
  } = {}) {
    const tick = this.clock++;
    this.nodes.set(file, {
      bytes: Buffer.from(bytes),
      uid,
      gid,
      mode,
      type,
      dev: 1,
      ino: this.nextIno++,
      mtimeMs: tick,
      ctimeMs: tick,
    });
  }

  touch(node, { content = false } = {}) {
    const tick = this.clock++;
    if (content) node.mtimeMs = tick;
    node.ctimeMs = tick;
  }

  statFor(node) {
    return {
      uid: node.uid,
      gid: node.gid,
      mode: node.mode,
      dev: node.dev,
      ino: node.ino,
      size: node.bytes.length,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      isFile: () => node.type === 'file',
      isSymbolicLink: () => node.type === 'symlink',
      isDirectory: () => node.type === 'directory',
    };
  }

  async lstat(file) {
    const node = this.nodes.get(file);
    if (!node) throw errorWithCode('ENOENT');
    return this.statFor(node);
  }

  async open(file, flags, mode = 0o666) {
    const exclusiveCreate = flags === 'wx';
    let node = this.nodes.get(file);
    if (exclusiveCreate) {
      if (node) throw errorWithCode('EEXIST');
      this.addNode(file, { mode, uid: 0, gid: 0 });
      node = this.nodes.get(file);
    } else {
      if (!node) throw errorWithCode('ENOENT');
      if (
        node.type === 'symlink'
        && (Number(flags) & (this.constants.O_NOFOLLOW ?? 0)) !== 0
      ) {
        throw errorWithCode('ELOOP');
      }
      if ((Number(flags) & this.constants.O_TRUNC) !== 0) {
        node.bytes = Buffer.alloc(0);
        this.touch(node, { content: true });
      }
    }

    return {
      stat: async () => this.statFor(node),
      readFile: async () => Buffer.from(node.bytes),
      writeFile: async (bytes) => {
        node.bytes = Buffer.from(bytes);
        this.touch(node, { content: true });
      },
      chown: async (uid, gid) => {
        node.uid = uid;
        node.gid = gid;
        this.touch(node);
      },
      chmod: async (nextMode) => {
        node.mode = nextMode;
        this.touch(node);
      },
      sync: async () => {},
      close: async () => {},
    };
  }

  async readFile(file) {
    const node = this.nodes.get(file);
    if (!node) throw errorWithCode('ENOENT');
    const bytes = Buffer.from(node.bytes);
    if (this.afterReadFile) await this.afterReadFile(file, this);
    return bytes;
  }

  async rename(from, to) {
    this.renameCount += 1;
    if (this.beforeRename) await this.beforeRename(from, to, this);
    const node = this.nodes.get(from);
    if (!node) throw errorWithCode('ENOENT');
    this.nodes.delete(from);
    this.nodes.set(to, node);
    if (this.afterRename) await this.afterRename(from, to, this);
  }

  async rm(file) {
    this.nodes.delete(file);
  }

  replaceBytes(file, bytes) {
    const node = this.nodes.get(file);
    if (!node) throw new Error('missing fake node');
    node.bytes = Buffer.from(bytes);
    this.touch(node, { content: true });
  }

  snapshot() {
    return [...this.nodes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, node]) => ({
        file,
        body: node.bytes.toString('base64'),
        uid: node.uid,
        gid: node.gid,
        mode: node.mode,
        type: node.type,
        ino: node.ino,
        mtimeMs: node.mtimeMs,
        ctimeMs: node.ctimeMs,
      }));
  }

  artifacts(suffix) {
    return [...this.nodes.keys()].filter((file) => file.endsWith(suffix));
  }
}

function sequence(values) {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    if (!value) throw new Error('random sequence exhausted');
    return value;
  };
}

async function revokePlan(fileSystem, plannedRevokedAt = PLAN_TIME) {
  return planRevocation({
    batchFile: BATCH_FILE,
    plannedRevokedAt,
    fileSystem,
  });
}

function revokeApplyOptions(fileSystem, plan, extra = {}) {
  return {
    batchFile: BATCH_FILE,
    plannedRevokedAt: plan.plannedRevokedAt,
    expectedInputSha256: plan.inputSha256,
    expectedPlannedSha256: plan.plannedSha256,
    currentUid: () => 0,
    now: () => new Date(APPLY_TIME),
    randomId: sequence(['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']),
    fileSystem,
    ...extra,
  };
}

function installOptions(fileSystem, extra = {}) {
  return {
    batchFile: BATCH_FILE,
    expiresHours: 24,
    now: () => new Date(CREATE_TIME),
    randomBytes: () => Buffer.alloc(32, 7),
    randomId: sequence(['dddddddddddd', 'eeeeeeeeeeee', 'ffffffffffff']),
    currentUid: () => 0,
    fileSystem,
    ...extra,
  };
}

test('revoke parser requires spaced values and rejects equals, duplicates, unknown and secret arguments', () => {
  const hash = 'b'.repeat(64);
  const parsed = parseArguments([
    '--apply',
    '--batch-file', BATCH_FILE,
    '--planned-revoked-at', PLAN_TIME,
    '--expected-input-sha256', hash,
    '--expected-planned-sha256', hash,
  ]);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.plannedRevokedAt, PLAN_TIME);
  assert.throws(
    () => parseArguments(['--apply=true']),
    (error) => error.message === 'ARGUMENT_EQUALS_FORBIDDEN',
  );
  assert.throws(
    () => parseArguments(['--batch-file', BATCH_FILE, '--batch-file', BATCH_FILE]),
    (error) => error.message === 'ARGUMENT_DUPLICATE',
  );
  assert.throws(
    () => parseArguments(['--token', 'do-not-accept']),
    (error) => error.message === 'UNKNOWN_ARGUMENT',
  );
  assert.throws(
    () => parseArguments(['--bogus', 'value']),
    (error) => error.message === 'UNKNOWN_ARGUMENT',
  );
});

test('dry-run is zero-write and reports only the immutable plan plus input owner metadata', async () => {
  const fileSystem = new FakePosixFileSystem();
  const before = fileSystem.snapshot();
  const plan = await revokePlan(fileSystem);
  assert.deepEqual(fileSystem.snapshot(), before);
  assert.equal(plan.alreadyRevoked, false);
  assert.equal(plan.plannedRevokedAt, PLAN_TIME);
  assert.equal(plan.inputSha256, digest(recordBytes()));
  assert.equal(plan.plannedSha256, digest(plan.plannedBytes));
  assert.deepEqual(
    { uid: plan.metadata.uid, gid: plan.metadata.gid, mode: plan.metadata.mode },
    { uid: 0, gid: 1904, mode: 0o640 },
  );
});

test('exact revoke plan changes only revokedAt and preserves root group and 0640 mode', async () => {
  const originalRecord = buildRecord();
  const originalBytes = recordBytes(originalRecord);
  const fileSystem = new FakePosixFileSystem({ bytes: originalBytes, gid: 2468 });
  const plan = await revokePlan(fileSystem);
  const result = await applyRevocation(revokeApplyOptions(fileSystem, plan));

  const finalNode = fileSystem.nodes.get(BATCH_FILE);
  const finalRecord = JSON.parse(finalNode.bytes.toString('utf8'));
  assert.deepEqual(finalRecord, { ...originalRecord, revokedAt: PLAN_TIME });
  assert.deepEqual(
    { uid: finalNode.uid, gid: finalNode.gid, mode: finalNode.mode },
    { uid: 0, gid: 2468, mode: 0o640 },
  );
  assert.equal(digest(finalNode.bytes), plan.plannedSha256);
  assert.equal(path.basename(result.backupBasename), result.backupBasename);
  const backupNode = fileSystem.nodes.get(path.join(VIRTUAL_DIR, result.backupBasename));
  assert.deepEqual(backupNode.bytes, originalBytes);
  assert.deepEqual(
    { uid: backupNode.uid, gid: backupNode.gid, mode: backupNode.mode },
    { uid: 0, gid: 2468, mode: 0o600 },
  );
  assert.deepEqual(fileSystem.artifacts('.tmp'), []);
});

test('revoke rejects input and plan drift before creating artifacts', async () => {
  const inputDriftFs = new FakePosixFileSystem();
  const inputPlan = await revokePlan(inputDriftFs);
  inputDriftFs.replaceBytes(
    BATCH_FILE,
    recordBytes(buildRecord({ expiresAt: '2026-08-15T03:45:42.540Z' })),
  );
  const drifted = inputDriftFs.snapshot();
  await assert.rejects(
    applyRevocation(revokeApplyOptions(inputDriftFs, inputPlan)),
    (error) => error.message === 'BATCH_INPUT_DRIFT',
  );
  assert.deepEqual(inputDriftFs.snapshot(), drifted);

  const planDriftFs = new FakePosixFileSystem();
  const plan = await revokePlan(planDriftFs);
  const before = planDriftFs.snapshot();
  await assert.rejects(
    applyRevocation(revokeApplyOptions(planDriftFs, plan, {
      expectedPlannedSha256: 'c'.repeat(64),
    })),
    (error) => error.message === 'PLANNED_SHA256_MISMATCH',
  );
  assert.deepEqual(planDriftFs.snapshot(), before);
});

test('second pre-rename check catches live drift and cleans backup and temp', async () => {
  const fileSystem = new FakePosixFileSystem();
  const plan = await revokePlan(fileSystem);
  let injected = false;
  fileSystem.afterReadFile = async (file, fake) => {
    if (!injected && file.endsWith('.tmp')) {
      injected = true;
      fake.replaceBytes(
        BATCH_FILE,
        recordBytes(buildRecord({ expiresAt: '2026-08-16T03:45:42.540Z' })),
      );
    }
  };
  await assert.rejects(
    applyRevocation(revokeApplyOptions(fileSystem, plan)),
    (error) => error.message === 'BATCH_INPUT_DRIFT',
  );
  assert.equal(injected, true);
  assert.deepEqual(fileSystem.artifacts('.bak'), []);
  assert.deepEqual(fileSystem.artifacts('.tmp'), []);
  assert.equal(
    JSON.parse(fileSystem.nodes.get(BATCH_FILE).bytes.toString('utf8')).expiresAt,
    '2026-08-16T03:45:42.540Z',
  );
});

test('symlink, non-regular file, malformed schema and extra fields fail closed', async () => {
  for (const [fileSystem, code] of [
    [new FakePosixFileSystem({ type: 'symlink' }), 'BATCH_FILE_SYMLINK'],
    [new FakePosixFileSystem({ type: 'directory' }), 'BATCH_FILE_NOT_REGULAR'],
    [new FakePosixFileSystem({ bytes: Buffer.from('{bad json') }), 'BATCH_SCHEMA_INVALID'],
    [new FakePosixFileSystem({ bytes: recordBytes(buildRecord({ extra: true })) }), 'BATCH_SCHEMA_INVALID'],
    [new FakePosixFileSystem({
      bytes: Buffer.from('{"version":1,"tokenHash":"' + 'a'.repeat(64)
        + '","createdAt":"2026-07-31T03:45:42.540Z",'
        + '"expiresAt":"2026-08-14T03:45:42.540Z","revokedAt":null,"revokedAt":null}'),
    }), 'BATCH_SCHEMA_INVALID'],
  ]) {
    const before = fileSystem.snapshot();
    await assert.rejects(
      planRevocation({ batchFile: BATCH_FILE, plannedRevokedAt: PLAN_TIME, fileSystem }),
      (error) => error.message === code,
    );
    assert.deepEqual(fileSystem.snapshot(), before);
  }
  assert.throws(
    () => validateBatchRecord(buildRecord({ tokenHash: 'A'.repeat(64) })),
    (error) => error.message === 'BATCH_SCHEMA_INVALID',
  );
});

test('dry-run records non-0640 metadata but apply requires root-owned exact 0640', async () => {
  const badModeFs = new FakePosixFileSystem({ mode: 0o600 });
  const plan = await revokePlan(badModeFs);
  assert.equal(plan.metadata.mode, 0o600);
  const before = badModeFs.snapshot();
  await assert.rejects(
    applyRevocation(revokeApplyOptions(badModeFs, plan)),
    (error) => error.message === 'BATCH_MODE_INVALID',
  );
  assert.deepEqual(badModeFs.snapshot(), before);

  const badOwnerFs = new FakePosixFileSystem({ uid: 1001 });
  const badOwnerPlan = await revokePlan(badOwnerFs);
  await assert.rejects(
    applyRevocation(revokeApplyOptions(badOwnerFs, badOwnerPlan)),
    (error) => error.message === 'BATCH_OWNER_INVALID',
  );
  const badDirectoryFs = new FakePosixFileSystem();
  badDirectoryFs.nodes.get(VIRTUAL_DIR).gid = 9999;
  const badDirectoryPlan = await revokePlan(badDirectoryFs);
  await assert.rejects(
    applyRevocation(revokeApplyOptions(badDirectoryFs, badDirectoryPlan)),
    (error) => error.message === 'BATCH_DIRECTORY_INVALID',
  );
  const nonRootFs = new FakePosixFileSystem();
  const nonRootPlan = await revokePlan(nonRootFs);
  await assert.rejects(
    applyRevocation(revokeApplyOptions(nonRootFs, nonRootPlan, {
      currentUid: () => 1000,
    })),
    (error) => error.message === 'ROOT_REQUIRED',
  );
});

test('an already revoked batch is a zero-write dry-run and apply is rejected', async () => {
  const revokedAt = '2026-08-15T03:45:42.540Z';
  const fileSystem = new FakePosixFileSystem({
    bytes: recordBytes(buildRecord({ revokedAt })),
  });
  const before = fileSystem.snapshot();
  const plan = await revokePlan(fileSystem);
  assert.equal(plan.alreadyRevoked, true);
  assert.equal(plan.plannedRevokedAt, revokedAt);
  assert.equal(plan.plannedSha256, plan.inputSha256);
  assert.deepEqual(fileSystem.snapshot(), before);
  await assert.rejects(
    applyRevocation(revokeApplyOptions(fileSystem, plan)),
    (error) => error.message === 'BATCH_ALREADY_REVOKED',
  );
  assert.deepEqual(fileSystem.snapshot(), before);
});

test('backup creation is exclusive and never overwrites an existing backup', async () => {
  const fileSystem = new FakePosixFileSystem();
  const plan = await revokePlan(fileSystem);
  const backupBasename = 'batch.json.2026-09-03T03-04-05-678Z.aaaaaaaaaaaa.bak';
  const backupFile = path.join(VIRTUAL_DIR, backupBasename);
  const sentinel = Buffer.from('existing-backup');
  fileSystem.addNode(backupFile, { bytes: sentinel, uid: 0, gid: 1904, mode: 0o600 });
  const beforeBatch = Buffer.from(fileSystem.nodes.get(BATCH_FILE).bytes);
  await assert.rejects(
    applyRevocation(revokeApplyOptions(fileSystem, plan)),
    (error) => error.message === 'BACKUP_ALREADY_EXISTS',
  );
  assert.deepEqual(fileSystem.nodes.get(backupFile).bytes, sentinel);
  assert.deepEqual(fileSystem.nodes.get(BATCH_FILE).bytes, beforeBatch);
  assert.deepEqual(fileSystem.artifacts('.tmp'), []);
});

test('rename failure leaves the original exact and cleans all new artifacts', async () => {
  const fileSystem = new FakePosixFileSystem();
  const original = Buffer.from(fileSystem.nodes.get(BATCH_FILE).bytes);
  const plan = await revokePlan(fileSystem);
  fileSystem.beforeRename = async (_from, to) => {
    if (to === BATCH_FILE) throw errorWithCode('EIO');
  };
  await assert.rejects(
    applyRevocation(revokeApplyOptions(fileSystem, plan)),
    (error) => error.message === 'BATCH_ATOMIC_RENAME_FAILED',
  );
  assert.deepEqual(fileSystem.nodes.get(BATCH_FILE).bytes, original);
  assert.deepEqual(fileSystem.artifacts('.bak'), []);
  assert.deepEqual(fileSystem.artifacts('.tmp'), []);
});

test('post-write hash failure restores original bytes owner and mode', async () => {
  const fileSystem = new FakePosixFileSystem({ gid: 5678 });
  const original = Buffer.from(fileSystem.nodes.get(BATCH_FILE).bytes);
  const plan = await revokePlan(fileSystem);
  let corrupted = false;
  fileSystem.afterRename = async (_from, to, fake) => {
    if (to === BATCH_FILE && !corrupted) {
      corrupted = true;
      const value = JSON.parse(fake.nodes.get(BATCH_FILE).bytes.toString('utf8'));
      value.tokenHash = 'd'.repeat(64);
      fake.replaceBytes(BATCH_FILE, recordBytes(value));
    }
  };
  await assert.rejects(
    applyRevocation(revokeApplyOptions(fileSystem, plan)),
    (error) => error.message === 'POST_WRITE_HASH_MISMATCH_ROLLED_BACK',
  );
  const restored = fileSystem.nodes.get(BATCH_FILE);
  assert.deepEqual(restored.bytes, original);
  assert.deepEqual(
    { uid: restored.uid, gid: restored.gid, mode: restored.mode },
    { uid: 0, gid: 5678, mode: 0o640 },
  );
  assert.equal(fileSystem.artifacts('.bak').length, 1);
  assert.deepEqual(fileSystem.artifacts('.tmp'), []);
});

test('CLI dry-run leaks neither token hash, batch body nor absolute path', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'store-login-revoke-cli-'));
  const batchFile = path.join(directory, 'batch.json');
  try {
    const bytes = recordBytes();
    await fs.writeFile(batchFile, bytes);
    const beforeEntries = (await fs.readdir(directory)).sort();
    const beforeBytes = await fs.readFile(batchFile);
    const run = spawnSync(process.execPath, [
      SCRIPT_PATH,
      '--batch-file', batchFile,
      '--planned-revoked-at', PLAN_TIME,
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(payload).sort(), [
      'alreadyRevoked',
      'inputSha256',
      'mode',
      'ok',
      'owner',
      'plannedRevokedAt',
      'plannedSha256',
    ]);
    assert.equal(payload.mode, 'dry-run');
    assert.equal(payload.alreadyRevoked, false);
    assert.deepEqual((await fs.readdir(directory)).sort(), beforeEntries);
    assert.deepEqual(await fs.readFile(batchFile), beforeBytes);
    for (const output of [run.stdout, run.stderr]) {
      assert.equal(output.includes(buildRecord().tokenHash), false);
      assert.equal(output.includes(buildRecord().createdAt), false);
      assert.equal(output.includes(buildRecord().expiresAt), false);
      assert.equal(output.includes(batchFile), false);
      assert.equal(output.includes(directory), false);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('CLI failures expose only a controlled error code and never the body or path', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'store-login-revoke-bad-'));
  const batchFile = path.join(directory, 'batch.json');
  try {
    await fs.writeFile(batchFile, JSON.stringify({ secret: SECRET_MARKER }));
    const run = spawnSync(process.execPath, [
      SCRIPT_PATH,
      '--batch-file', batchFile,
      '--planned-revoked-at', PLAN_TIME,
    ], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.deepEqual(JSON.parse(run.stdout), {
      ok: false,
      errorCode: 'BATCH_SCHEMA_INVALID',
    });
    assert.equal(run.stderr, '');
    assert.equal(run.stdout.includes(SECRET_MARKER), false);
    assert.equal(run.stdout.includes(batchFile), false);

    const parserFailure = spawnSync(process.execPath, [
      SCRIPT_PATH,
      `--batch-file=${batchFile}`,
      '--token', SECRET_MARKER,
    ], { encoding: 'utf8' });
    assert.equal(parserFailure.status, 1);
    assert.equal(parserFailure.stdout.includes(SECRET_MARKER), false);
    assert.equal(parserFailure.stderr.includes(SECRET_MARKER), false);
    assert.equal(parserFailure.stdout.includes(batchFile), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('create requires an existing expired or revoked root-owned 0640 batch', async () => {
  const activeFs = new FakePosixFileSystem({
    bytes: recordBytes(buildRecord({ expiresAt: '2026-09-04T04:05:06.789Z' })),
  });
  const activeBefore = activeFs.snapshot();
  let generated = false;
  await assert.rejects(
    installBatch(installOptions(activeFs, {
      randomBytes: () => {
        generated = true;
        return Buffer.alloc(32, 1);
      },
    })),
    (error) => error.message === 'ACTIVE_BATCH_REPLACEMENT_FORBIDDEN',
  );
  assert.equal(generated, false);
  assert.deepEqual(activeFs.snapshot(), activeBefore);

  const missingFs = new FakePosixFileSystem();
  missingFs.nodes.delete(BATCH_FILE);
  await assert.rejects(
    installBatch(installOptions(missingFs)),
    (error) => error.message === 'BATCH_FILE_UNREADABLE',
  );
  const badModeFs = new FakePosixFileSystem({ mode: 0o600 });
  await assert.rejects(
    installBatch(installOptions(badModeFs)),
    (error) => error.message === 'BATCH_MODE_INVALID',
  );
  const symlinkFs = new FakePosixFileSystem({ type: 'symlink' });
  await assert.rejects(
    installBatch(installOptions(symlinkFs)),
    (error) => error.message === 'BATCH_FILE_SYMLINK',
  );

  const revokedFs = new FakePosixFileSystem({
    bytes: recordBytes(buildRecord({
      expiresAt: '2026-09-04T04:05:06.789Z',
      revokedAt: '2026-09-02T04:05:06.789Z',
    })),
  });
  const revokedResult = await installBatch(installOptions(revokedFs));
  assert.equal(
    JSON.parse(revokedFs.nodes.get(BATCH_FILE).bytes.toString('utf8')).revokedAt,
    null,
  );
  assert.equal(revokedFs.artifacts('.bak').length, 1);
  assert.equal(path.basename(revokedResult.backupBasename), revokedResult.backupBasename);
});

test('create atomically replaces an expired batch and preserves root group and 0640', async () => {
  const original = recordBytes();
  const fileSystem = new FakePosixFileSystem({ bytes: original, gid: 8642 });
  const result = await installBatch(installOptions(fileSystem));
  const finalNode = fileSystem.nodes.get(BATCH_FILE);
  const finalRecord = JSON.parse(finalNode.bytes.toString('utf8'));
  assert.equal(finalRecord.version, 1);
  assert.equal(finalRecord.tokenHash, sha256(result.token));
  assert.equal(finalRecord.createdAt, CREATE_TIME);
  assert.equal(finalRecord.expiresAt, '2026-09-04T04:05:06.789Z');
  assert.equal(finalRecord.revokedAt, null);
  assert.deepEqual(
    { uid: finalNode.uid, gid: finalNode.gid, mode: finalNode.mode },
    { uid: 0, gid: 8642, mode: 0o640 },
  );
  const backup = fileSystem.nodes.get(path.join(VIRTUAL_DIR, result.backupBasename));
  assert.deepEqual(backup.bytes, original);
  assert.equal(backup.mode, 0o600);
  assert.equal(backup.uid, 0);
  assert.equal(backup.gid, 8642);
});

test('create detects second-check drift and cleans its backup and temp', async () => {
  const fileSystem = new FakePosixFileSystem();
  let injected = false;
  fileSystem.afterReadFile = async (file, fake) => {
    if (!injected && file.endsWith('.tmp')) {
      injected = true;
      fake.replaceBytes(
        BATCH_FILE,
        recordBytes(buildRecord({ expiresAt: '2026-08-17T03:45:42.540Z' })),
      );
    }
  };
  await assert.rejects(
    installBatch(installOptions(fileSystem)),
    (error) => error.message === 'BATCH_INPUT_DRIFT',
  );
  assert.equal(injected, true);
  assert.deepEqual(fileSystem.artifacts('.bak'), []);
  assert.deepEqual(fileSystem.artifacts('.tmp'), []);
});

test('create rename failure is clean and final readback failure restores the old batch', async () => {
  const renameFailureFs = new FakePosixFileSystem();
  const renameOriginal = Buffer.from(renameFailureFs.nodes.get(BATCH_FILE).bytes);
  renameFailureFs.beforeRename = async (_from, to) => {
    if (to === BATCH_FILE) throw errorWithCode('EIO');
  };
  await assert.rejects(
    installBatch(installOptions(renameFailureFs)),
    (error) => error.message === 'BATCH_ATOMIC_RENAME_FAILED',
  );
  assert.deepEqual(renameFailureFs.nodes.get(BATCH_FILE).bytes, renameOriginal);
  assert.deepEqual(renameFailureFs.artifacts('.bak'), []);
  assert.deepEqual(renameFailureFs.artifacts('.tmp'), []);

  const readbackFailureFs = new FakePosixFileSystem({ gid: 9753 });
  const readbackOriginal = Buffer.from(readbackFailureFs.nodes.get(BATCH_FILE).bytes);
  let corrupted = false;
  readbackFailureFs.afterRename = async (_from, to, fake) => {
    if (to === BATCH_FILE && !corrupted) {
      corrupted = true;
      const value = JSON.parse(fake.nodes.get(BATCH_FILE).bytes.toString('utf8'));
      value.tokenHash = 'e'.repeat(64);
      fake.replaceBytes(BATCH_FILE, recordBytes(value));
    }
  };
  await assert.rejects(
    installBatch(installOptions(readbackFailureFs)),
    (error) => error.message === 'POST_WRITE_HASH_MISMATCH_ROLLED_BACK',
  );
  const restored = readbackFailureFs.nodes.get(BATCH_FILE);
  assert.deepEqual(restored.bytes, readbackOriginal);
  assert.deepEqual(
    { uid: restored.uid, gid: restored.gid, mode: restored.mode },
    { uid: 0, gid: 9753, mode: 0o640 },
  );
  assert.equal(readbackFailureFs.artifacts('.bak').length, 1);
  assert.deepEqual(readbackFailureFs.artifacts('.tmp'), []);
});

test('create parser keeps its documented equals-only syntax and rejects token arguments', () => {
  const parsed = parseCreateArguments(['--expires-hours=24'], {});
  assert.equal(parsed.expiresHours, 24);
  assert.throws(
    () => parseCreateArguments(['--expires-hours', '24'], {}),
    (error) => error.message === 'STORE_LOGIN_BATCH_ARGUMENT_INVALID',
  );
  assert.throws(
    () => parseCreateArguments(['--token=secret'], {}),
    (error) => error.message === 'STORE_LOGIN_BATCH_ARGUMENT_INVALID',
  );
});

test('real POSIX root flow preserves uid gid and 0640 across revoke and create', {
  skip: process.platform === 'win32' || process.getuid?.() !== 0,
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'store-login-posix-'));
  const batchFile = path.join(directory, 'batch.json');
  const preservedGid = Number(process.env.SUDO_GID || 1000);
  try {
    await fs.chown(directory, 0, preservedGid);
    await fs.chmod(directory, 0o750);
    await fs.writeFile(batchFile, recordBytes(), { mode: 0o640 });
    await fs.chown(batchFile, 0, preservedGid);
    await fs.chmod(batchFile, 0o640);

    const dryRun = spawnSync(process.execPath, [
      SCRIPT_PATH,
      '--batch-file', batchFile,
      '--planned-revoked-at', PLAN_TIME,
    ], { encoding: 'utf8' });
    assert.equal(dryRun.status, 0, dryRun.stderr || 'revoke dry-run failed');
    assert.equal(dryRun.stderr, '');
    const plan = JSON.parse(dryRun.stdout);
    assert.equal(plan.owner.uid, 0);
    assert.equal(plan.owner.gid, preservedGid);
    assert.equal(plan.owner.mode, '0640');
    const applyRun = spawnSync(process.execPath, [
      SCRIPT_PATH,
      '--apply',
      '--batch-file', batchFile,
      '--planned-revoked-at', plan.plannedRevokedAt,
      '--expected-input-sha256', plan.inputSha256,
      '--expected-planned-sha256', plan.plannedSha256,
    ], { encoding: 'utf8' });
    assert.equal(applyRun.status, 0, applyRun.stderr || 'revoke apply failed');
    assert.equal(applyRun.stderr, '');
    const revoked = JSON.parse(applyRun.stdout);
    assert.deepEqual(Object.keys(revoked).sort(), [
      'alreadyRevoked',
      'backupBasename',
      'inputSha256',
      'mode',
      'ok',
      'owner',
      'plannedRevokedAt',
      'plannedSha256',
    ]);
    assert.equal(revoked.mode, 'apply');
    assert.equal(revoked.plannedRevokedAt, plan.plannedRevokedAt);
    assert.equal(revoked.inputSha256, plan.inputSha256);
    assert.equal(revoked.plannedSha256, plan.plannedSha256);
    let stat = await fs.lstat(batchFile);
    assert.equal(stat.uid, 0);
    assert.equal(stat.gid, preservedGid);
    assert.equal(stat.mode & 0o777, 0o640);
    let backupStat = await fs.lstat(path.join(directory, revoked.backupBasename));
    assert.equal(backupStat.uid, 0);
    assert.equal(backupStat.gid, preservedGid);
    assert.equal(backupStat.mode & 0o777, 0o600);

    const createRun = spawnSync(process.execPath, [
      CREATE_SCRIPT_PATH,
      `--batch-file=${batchFile}`,
      '--expires-hours=24',
    ], { encoding: 'utf8' });
    assert.equal(createRun.status, 0, createRun.stderr || 'create failed');
    assert.equal(createRun.stderr, '');
    const createOutput = JSON.parse(createRun.stdout);
    assert.deepEqual(Object.keys(createOutput).sort(), [
      'backupBasename',
      'expiresAt',
      'ok',
      'owner',
      'url',
    ]);
    assert.equal(createOutput.ok, true);
    assert.equal(createOutput.owner.mode, '0640');
    assert.match(createOutput.url, /^https:\/\/fm\.dushengyi\.cc\/store-login#token=/);
    assert.equal(createOutput.url.includes('?token='), false);
    assert.equal(path.basename(createOutput.backupBasename), createOutput.backupBasename);
    stat = await fs.lstat(batchFile);
    assert.equal(stat.uid, 0);
    assert.equal(stat.gid, preservedGid);
    assert.equal(stat.mode & 0o777, 0o640);
    const installedRecord = JSON.parse(await fs.readFile(batchFile, 'utf8'));
    const installedToken = new URL(createOutput.url).hash.slice('#token='.length);
    assert.equal(installedRecord.tokenHash, sha256(decodeURIComponent(installedToken)));
    assert.equal(createRun.stdout.includes(installedRecord.tokenHash), false);
    assert.equal(createRun.stdout.includes(buildRecord().tokenHash), false);
    backupStat = await fs.lstat(path.join(directory, createOutput.backupBasename));
    assert.equal(backupStat.uid, 0);
    assert.equal(backupStat.gid, preservedGid);
    assert.equal(backupStat.mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
